import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, getSetting, setSetting, stockOnHand, tx } from "../db.ts";
import { HttpError, can, requireLogin, requirePerm, resolveApprover } from "../auth.ts";
import { eatDayRange, parse, todayEAT } from "../util.ts";
import { lineTotal, vatOfGross, type VatCode } from "../../shared/money.ts";

interface ProductRow {
  id: number; name: string; unit: string; allow_fraction: number; vat_code: VatCode; cost_cents: number;
  price_retail_cents: number; price_contractor_cents: number | null; price_wholesale_cents: number | null; active: number;
}
interface CustomerRow { id: number; tier: "retail" | "contractor" | "wholesale"; credit_limit_cents: number; active: number }

const customerBalance = (id: number) =>
  (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS b FROM customer_ledger WHERE customer_id=?").get(id) as { b: number }).b;

function nextReceiptNo(): string {
  const seq = Number(getSetting("receipt_seq", "0")) + 1;
  setSetting("receipt_seq", String(seq));
  return `${getSetting("receipt_prefix", "R")}${String(seq).padStart(6, "0")}`;
}

function priceFor(p: ProductRow, tier: CustomerRow["tier"]): number {
  if (tier === "wholesale" && p.price_wholesale_cents != null) return p.price_wholesale_cents;
  if ((tier === "contractor" || tier === "wholesale") && p.price_contractor_cents != null) return p.price_contractor_cents;
  return p.price_retail_cents;
}

/** Spread `total` over weights using largest-remainder so the parts always sum exactly. */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f);
  for (let k = 0; rest > 0; k++, rest--) out[order[k % order.length].i]++;
  return out;
}

function openShiftFor(userId: number) {
  return db.prepare("SELECT * FROM shifts WHERE user_id=? AND closed_at IS NULL").get(userId) as
    | { id: number; opening_float_cents: number }
    | undefined;
}

function loadSale(id: number) {
  const sale = db
    .prepare(
      `SELECT s.*, u.name AS cashier, c.name AS customer_name, c.kra_pin AS customer_pin
       FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`,
    )
    .get(id);
  if (!sale) throw new HttpError(404, "Sale not found");
  const items = db.prepare("SELECT * FROM sale_items WHERE sale_id=? ORDER BY id").all(id);
  const payments = db.prepare("SELECT * FROM payments WHERE sale_id=? ORDER BY id").all(id);
  return { ...sale, items, payments };
}

export function salesRoutes(app: FastifyInstance) {
  // ---------------- shifts ----------------
  app.get("/api/shifts/current", { preHandler: requireLogin() }, async (req) => {
    const s = openShiftFor(req.user!.id);
    if (!s) return null;
    return { ...s, ...shiftTotals(s.id, s.opening_float_cents) };
  });

  function shiftTotals(shiftId: number, openingFloat: number) {
    const rows = db
      .prepare(
        `SELECT p.method, SUM(p.amount_cents) AS amt FROM payments p JOIN sales s ON s.id=p.sale_id
         WHERE s.shift_id=? GROUP BY p.method`,
      )
      .all(shiftId) as { method: string; amt: number }[];
    const by: Record<string, number> = {};
    rows.forEach((r) => (by[r.method] = r.amt));
    const cashSales = by.cash ?? 0;
    return { byMethod: by, expectedCashCents: openingFloat + cashSales };
  }

  app.post("/api/shifts/open", { preHandler: requirePerm("sales.create") }, async (req) => {
    const { floatCents } = parse(z.object({ floatCents: z.number().int().min(0) }), req.body);
    if (openShiftFor(req.user!.id)) throw new HttpError(409, "You already have an open shift");
    const r = db.prepare("INSERT INTO shifts (user_id, opening_float_cents) VALUES (?,?)").run(req.user!.id, floatCents);
    audit(req.user!.id, "shift_open", { floatCents });
    return { id: Number(r.lastInsertRowid) };
  });

  app.post("/api/shifts/close", { preHandler: requireLogin() }, async (req) => {
    const b = parse(z.object({ countedCashCents: z.number().int().min(0), note: z.string().optional() }), req.body);
    const s = openShiftFor(req.user!.id);
    if (!s) throw new HttpError(400, "No open shift");
    const t = shiftTotals(s.id, s.opening_float_cents);
    db.prepare(
      "UPDATE shifts SET closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), counted_cash_cents=?, expected_cash_cents=?, note=? WHERE id=?",
    ).run(b.countedCashCents, t.expectedCashCents, b.note ?? null, s.id);
    audit(req.user!.id, "shift_close", { shiftId: s.id, expected: t.expectedCashCents, counted: b.countedCashCents });
    return { shiftId: s.id, ...t, countedCashCents: b.countedCashCents, varianceCents: b.countedCashCents - t.expectedCashCents };
  });

  app.get("/api/shifts", { preHandler: requirePerm("shifts.view_all") }, async () =>
    db
      .prepare(
        `SELECT sh.*, u.name AS cashier FROM shifts sh JOIN users u ON u.id=sh.user_id ORDER BY sh.id DESC LIMIT 60`,
      )
      .all(),
  );

  // ---------------- checkout ----------------
  const checkoutSchema = z.object({
    items: z.array(z.object({ productId: z.number().int(), qtyMilli: z.number().int().positive() })).min(1),
    customerId: z.number().int().nullish(),
    discountCents: z.number().int().min(0).default(0),
    locationId: z.number().int().default(1),
    approvalPin: z.string().optional(),
    note: z.string().optional(),
    payments: z
      .array(
        z.object({
          method: z.enum(["cash", "mpesa", "card", "bank", "credit"]),
          amountCents: z.number().int().positive(),
          reference: z.string().optional(),
        }),
      )
      .min(1),
  });

  app.post("/api/sales", { preHandler: requirePerm("sales.create") }, async (req) => {
    const b = parse(checkoutSchema, req.body);
    const user = req.user!;
    const shift = openShiftFor(user.id);
    if (!shift) throw new HttpError(400, "Open a shift before selling");

    const saleId = tx(() => {
      const customer = b.customerId
        ? (db.prepare("SELECT * FROM customers WHERE id=? AND active=1").get(b.customerId) as CustomerRow | undefined)
        : undefined;
      if (b.customerId && !customer) throw new HttpError(400, "Customer not found");
      const tier = customer?.tier ?? "retail";

      // merge duplicate lines, load authoritative product data
      const merged = new Map<number, number>();
      for (const it of b.items) merged.set(it.productId, (merged.get(it.productId) ?? 0) + it.qtyMilli);
      const lines = [...merged].map(([productId, qtyMilli]) => {
        const p = db.prepare("SELECT * FROM products WHERE id=?").get(productId) as ProductRow | undefined;
        if (!p || !p.active) throw new HttpError(400, "A product in the cart is no longer available");
        if (!p.allow_fraction && qtyMilli % 1000 !== 0) throw new HttpError(400, `${p.name} cannot be sold in fractions`);
        if (getSetting("allow_negative_stock") !== "1" && stockOnHand(p.id, b.locationId) < qtyMilli)
          throw new HttpError(409, `Not enough stock for ${p.name}`);
        const unit = priceFor(p, tier);
        return { p, qtyMilli, unit, gross: lineTotal(unit, qtyMilli) };
      });

      const subtotal = lines.reduce((a, l) => a + l.gross, 0);
      if (b.discountCents > subtotal) throw new HttpError(400, "Discount exceeds the sale total");
      let approver = null as { id: number } | null;
      if (b.discountCents > 0) approver = resolveApprover(user, "sales.discount", b.approvalPin);

      const shares = allocate(b.discountCents, lines.map((l) => l.gross));
      const total = subtotal - b.discountCents;

      // payments: cash may be tendered over the total; everything else must be exact
      const paid = b.payments.reduce((a, p) => a + p.amountCents, 0);
      const cashIn = b.payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountCents, 0);
      const change = paid - total;
      if (paid < total) throw new HttpError(400, "Payment is less than the total");
      if (change > cashIn) throw new HttpError(400, "Overpayment is only allowed in cash");
      const creditAmt = b.payments.filter((p) => p.method === "credit").reduce((a, p) => a + p.amountCents, 0);
      if (creditAmt > 0) {
        if (!customer) throw new HttpError(400, "Select a customer for credit sales");
        if (customerBalance(customer.id) + creditAmt > customer.credit_limit_cents)
          throw new HttpError(409, "Credit limit exceeded");
      }

      const vatTotal = lines.reduce((a, l, i) => a + vatOfGross(l.gross - shares[i], l.p.vat_code), 0);
      const receiptNo = nextReceiptNo();
      const sale = db
        .prepare(
          `INSERT INTO sales (receipt_no,shift_id,user_id,customer_id,location_id,kind,subtotal_cents,discount_cents,
             total_cents,vat_cents,note,approved_by) VALUES (?,?,?,?,?,'sale',?,?,?,?,?,?)`,
        )
        .run(receiptNo, shift.id, user.id, customer?.id ?? null, b.locationId, subtotal, b.discountCents, total, vatTotal, b.note ?? null, approver?.id ?? null);
      const id = Number(sale.lastInsertRowid);

      const insItem = db.prepare(
        `INSERT INTO sale_items (sale_id,product_id,name,unit,qty_milli,unit_price_cents,cost_cents,vat_code,line_total_cents,vat_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      const insMove = db.prepare(
        `INSERT INTO stock_movements (product_id,location_id,qty_milli,type,ref_type,ref_id,unit_cost_cents,user_id)
         VALUES (?,?,?,'sale','sale',?,?,?)`,
      );
      lines.forEach((l, i) => {
        const net = l.gross - shares[i];
        insItem.run(id, l.p.id, l.p.name, l.p.unit, l.qtyMilli, l.unit, l.p.cost_cents, l.p.vat_code, net, vatOfGross(net, l.p.vat_code));
        insMove.run(l.p.id, b.locationId, -l.qtyMilli, id, l.p.cost_cents, user.id);
      });

      // record cash net of change so the drawer reconciles
      let changeLeft = change;
      for (const p of b.payments) {
        let amt = p.amountCents;
        if (p.method === "cash" && changeLeft > 0) {
          const take = Math.min(changeLeft, amt);
          amt -= take;
          changeLeft -= take;
        }
        if (amt > 0) db.prepare("INSERT INTO payments (sale_id,method,amount_cents,reference) VALUES (?,?,?,?)").run(id, p.method, amt, p.reference ?? null);
      }
      if (creditAmt > 0)
        db.prepare("INSERT INTO customer_ledger (customer_id,amount_cents,type,ref_type,ref_id,user_id) VALUES (?,?,?,?,?,?)").run(
          customer!.id, creditAmt, "credit_sale", "sale", id, user.id,
        );
      audit(user.id, "sale", { id, receiptNo, total, discount: b.discountCents });
      return id;
    });
    const sale = loadSale(saleId) as Record<string, unknown>;
    return { ...sale, changeCents: Math.max(0, b.payments.reduce((a, p) => a + p.amountCents, 0) - (sale.total_cents as number)) };
  });

  // ---------------- refunds ----------------
  app.post("/api/sales/:id/refund", { preHandler: requirePerm("sales.create") }, async (req) => {
    const origId = Number((req.params as { id: string }).id);
    const b = parse(
      z.object({
        items: z.array(z.object({ saleItemId: z.number().int(), qtyMilli: z.number().int().positive() })).min(1),
        method: z.enum(["cash", "mpesa", "card", "bank", "credit"]),
        reason: z.string().min(1, "A reason is required"),
        approvalPin: z.string().optional(),
        restock: z.boolean().default(true),
      }),
      req.body,
    );
    const user = req.user!;
    const approver = resolveApprover(user, "sales.refund", b.approvalPin);
    const shift = openShiftFor(user.id);
    if (!shift) throw new HttpError(400, "Open a shift before processing a refund");

    const refundId = tx(() => {
      const orig = db.prepare("SELECT * FROM sales WHERE id=? AND kind='sale'").get(origId) as
        | { id: number; customer_id: number | null; location_id: number; subtotal_cents: number; discount_cents: number }
        | undefined;
      if (!orig) throw new HttpError(404, "Original sale not found");
      if (b.method === "credit" && !orig.customer_id) throw new HttpError(400, "Credit refunds need a customer on the sale");

      let total = 0, vat = 0;
      const rows = b.items.map((it) => {
        const si = db.prepare("SELECT * FROM sale_items WHERE id=? AND sale_id=?").get(it.saleItemId, origId) as
          | { id: number; product_id: number; name: string; unit: string; qty_milli: number; unit_price_cents: number; cost_cents: number; vat_code: VatCode; line_total_cents: number }
          | undefined;
        if (!si) throw new HttpError(400, "Item does not belong to this sale");
        const already = (
          db
            .prepare(
              `SELECT COALESCE(SUM(ri.qty_milli),0) AS q FROM sale_items ri JOIN sales r ON r.id=ri.sale_id
               WHERE r.refund_of=? AND ri.product_id=?`,
            )
            .get(origId, si.product_id) as { q: number }
        ).q;
        if (-already + it.qtyMilli > si.qty_milli) throw new HttpError(400, `${si.name}: refund exceeds quantity sold`);
        // refund at the amount actually charged (after any discount share)
        const gross = Math.round((si.line_total_cents * it.qtyMilli) / si.qty_milli);
        const v = vatOfGross(gross, si.vat_code);
        total += gross; vat += v;
        return { si, qty: it.qtyMilli, gross, v };
      });

      const receiptNo = nextReceiptNo();
      const r = db
        .prepare(
          `INSERT INTO sales (receipt_no,shift_id,user_id,customer_id,location_id,kind,refund_of,subtotal_cents,discount_cents,
             total_cents,vat_cents,note,approved_by) VALUES (?,?,?,?,?,'refund',?,?,0,?,?,?,?)`,
        )
        .run(receiptNo, shift.id, user.id, orig.customer_id, orig.location_id, origId, -total, -total, -vat, b.reason, approver.id);
      const id = Number(r.lastInsertRowid);
      for (const x of rows) {
        db.prepare(
          `INSERT INTO sale_items (sale_id,product_id,name,unit,qty_milli,unit_price_cents,cost_cents,vat_code,line_total_cents,vat_cents)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(id, x.si.product_id, x.si.name, x.si.unit, -x.qty, x.si.unit_price_cents, x.si.cost_cents, x.si.vat_code, -x.gross, -x.v);
        if (b.restock)
          db.prepare(
            `INSERT INTO stock_movements (product_id,location_id,qty_milli,type,ref_type,ref_id,unit_cost_cents,user_id)
             VALUES (?,?,?,'sale_return','sale',?,?,?)`,
          ).run(x.si.product_id, orig.location_id, x.qty, id, x.si.cost_cents, user.id);
      }
      db.prepare("INSERT INTO payments (sale_id,method,amount_cents) VALUES (?,?,?)").run(id, b.method, -total);
      if (b.method === "credit")
        db.prepare("INSERT INTO customer_ledger (customer_id,amount_cents,type,ref_type,ref_id,user_id) VALUES (?,?,?,?,?,?)").run(
          orig.customer_id, -total, "return", "sale", id, user.id,
        );
      audit(user.id, "refund", { id, origId, total, approver: approver.id, reason: b.reason });
      return id;
    });
    return loadSale(refundId);
  });

  // ---------------- sale history ----------------
  app.get("/api/sales", { preHandler: requireLogin() }, async (req) => {
    const { date, q } = req.query as { date?: string; q?: string };
    const { from, to } = eatDayRange(date ?? todayEAT());
    const mine = !can(req.user!, "sales.view_all");
    const where = ["s.created_at >= ? AND s.created_at < ?"];
    const params: (string | number)[] = [from, to];
    if (mine) { where.push("s.user_id=?"); params.push(req.user!.id); }
    if (q) { where.push("s.receipt_no LIKE ?"); params.push(`%${q}%`); }
    return db
      .prepare(
        `SELECT s.id, s.receipt_no, s.kind, s.total_cents, s.created_at, u.name AS cashier, c.name AS customer_name,
           (SELECT GROUP_CONCAT(DISTINCT method) FROM payments WHERE sale_id=s.id) AS methods
         FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id
         WHERE ${where.join(" AND ")} ORDER BY s.id DESC LIMIT 300`,
      )
      .all(...params);
  });

  app.get("/api/sales/:id", { preHandler: requireLogin() }, async (req) => {
    const s = loadSale(Number((req.params as { id: string }).id)) as Record<string, unknown>;
    if (!can(req.user!, "sales.view_all") && s.user_id !== req.user!.id) throw new HttpError(403, "Not allowed");
    const refunds = db
      .prepare("SELECT id, receipt_no, total_cents FROM sales WHERE refund_of=?")
      .all(s.id as number);
    return { ...s, refunds };
  });

  // ---------------- customers ----------------
  app.get("/api/customers", { preHandler: requireLogin() }, async (req) => {
    const { q } = req.query as { q?: string };
    return db
      .prepare(
        `SELECT c.*, COALESCE((SELECT SUM(amount_cents) FROM customer_ledger WHERE customer_id=c.id),0) AS balance_cents
         FROM customers c WHERE c.active=1 ${q ? "AND (c.name LIKE ? OR c.phone LIKE ?)" : ""} ORDER BY c.name LIMIT 200`,
      )
      .all(...(q ? [`%${q}%`, `%${q}%`] : []));
  });

  const customerSchema = z.object({
    name: z.string().min(1),
    phone: z.string().nullish(),
    kraPin: z.string().nullish(),
    tier: z.enum(["retail", "contractor", "wholesale"]).default("retail"),
    creditLimitCents: z.number().int().min(0).default(0),
  });

  app.post("/api/customers", { preHandler: requirePerm("customers.create") }, async (req) => {
    const b = parse(customerSchema, req.body);
    // only managers may grant credit or special price tiers
    if ((b.creditLimitCents > 0 || b.tier !== "retail") && !can(req.user!, "customers.manage"))
      throw new HttpError(403, "Your role cannot set a price tier or credit limit");
    const r = db
      .prepare("INSERT INTO customers (name,phone,kra_pin,tier,credit_limit_cents) VALUES (?,?,?,?,?)")
      .run(b.name, b.phone ?? null, b.kraPin ?? null, b.tier, b.creditLimitCents);
    audit(req.user!.id, "customer_create", { name: b.name });
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch("/api/customers/:id", { preHandler: requirePerm("customers.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(customerSchema.partial().extend({ active: z.boolean().optional() }), req.body);
    const cur = db.prepare("SELECT * FROM customers WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!cur) throw new HttpError(404, "Customer not found");
    db.prepare("UPDATE customers SET name=?,phone=?,kra_pin=?,tier=?,credit_limit_cents=?,active=? WHERE id=?").run(
      b.name ?? (cur.name as string),
      (b.phone === undefined ? cur.phone : b.phone) as string | null,
      (b.kraPin === undefined ? cur.kra_pin : b.kraPin) as string | null,
      b.tier ?? (cur.tier as string),
      b.creditLimitCents ?? (cur.credit_limit_cents as number),
      b.active === undefined ? (cur.active as number) : b.active ? 1 : 0,
      id,
    );
    audit(req.user!.id, "customer_update", { id, ...b });
    return { ok: true };
  });

  app.get("/api/customers/:id", { preHandler: requireLogin() }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const c = db.prepare("SELECT * FROM customers WHERE id=?").get(id);
    if (!c) throw new HttpError(404, "Customer not found");
    const ledger = db.prepare("SELECT * FROM customer_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 200").all(id);
    return { ...c, balance_cents: customerBalance(id), ledger };
  });

  // customer pays down their account
  app.post("/api/customers/:id/payment", { preHandler: requirePerm("customers.payment") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(
      z.object({
        amountCents: z.number().int().positive(),
        method: z.enum(["cash", "mpesa", "card", "bank"]),
        reference: z.string().optional(),
      }),
      req.body,
    );
    const bal = customerBalance(id);
    if (b.amountCents > bal) throw new HttpError(400, "Payment is more than the balance owed");
    db.prepare(
      "INSERT INTO customer_ledger (customer_id,amount_cents,type,method,note,user_id) VALUES (?,?,?,?,?,?)",
    ).run(id, -b.amountCents, "payment", b.method, b.reference ?? null, req.user!.id);
    audit(req.user!.id, "customer_payment", { id, ...b });
    return { balance_cents: customerBalance(id) };
  });
}
