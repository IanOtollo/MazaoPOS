import {
  audit, authenticate, can, fail, getSetting, moveStock, nextId, postCustomer, requirePerm, setSetting, stockOnHand, todayEAT, eatDayRangeMs, verifyPin,
  type AuthUser, type Ctx, type Doc, type Handler,
} from "../lib";
import type { Permission } from "../../shared/permissions";
import { lineTotal, vatOfGross, type VatCode } from "../../shared/money";
import { ageingFor } from "../receivablesLib";

/*
 * Shifts, checkout, refunds and sale history. Same addresses and JSON as the old server (snake_case field names,
 * ISO times), stored in the Convex model: a sale document embeds its items and payments.
 */
type Tier = "retail" | "contractor" | "wholesale";
const METHODS = ["cash", "mpesa", "card", "bank", "credit"] as const;
type Method = (typeof METHODS)[number];

const iso = (ms: number) => new Date(ms).toISOString();
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const bad = (field: string, msg: string): never => fail(400, `${field}: ${msg}`);

// ---------- approvals ----------
/**
 * Authorisation for a sensitive action (discount, refund, credit).
 * If the current user already holds `perm` they proceed. Otherwise someone whose role holds
 * `sales.approve` must type their PIN, and that person is recorded as the approver.
 */
export async function resolveApprover(ctx: Ctx, user: AuthUser, perm: Permission, approvalPin?: string): Promise<{ id: number; name: string }> {
  if (can(user, perm)) return { id: user.id, name: user.name };
  if (!approvalPin) return fail(403, "Manager approval required");
  const roles = new Map((await ctx.db.query("roles").collect()).map((r) => [r.id, r.permissions]));
  for (const u of await ctx.db.query("users").collect()) {
    if (!u.active || !(roles.get(u.roleId) ?? []).includes("sales.approve")) continue;
    if (await verifyPin(approvalPin, u.pinHash)) return { id: u.id, name: u.name };
  }
  return fail(403, "Invalid approval PIN");
}

// ---------- helpers ----------
async function nextReceiptNo(ctx: Ctx): Promise<string> {
  const seq = Number(await getSetting(ctx, "receipt_seq", "0")) + 1;
  await setSetting(ctx, "receipt_seq", String(seq));
  return `${await getSetting(ctx, "receipt_prefix", "R")}${String(seq).padStart(6, "0")}`;
}

function priceFor(p: Doc<"products">, tier: Tier): number {
  if (tier === "wholesale" && p.priceWholesaleCents != null) return p.priceWholesaleCents;
  if ((tier === "contractor" || tier === "wholesale") && p.priceContractorCents != null) return p.priceContractorCents;
  return p.priceRetailCents;
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

const openShiftFor = (ctx: Ctx, userId: number) =>
  ctx.db.query("shifts").withIndex("by_user", (q) => q.eq("userId", userId).eq("closedAt", undefined)).first();

/** The shift as the screens expect it: snake_case, ISO times, null where empty. */
const shiftRow = (s: Doc<"shifts">) => ({
  id: s.id, user_id: s.userId, opened_at: iso(s.openedAt), closed_at: s.closedAt != null ? iso(s.closedAt) : null,
  opening_float_cents: s.openingFloatCents, counted_cash_cents: s.countedCashCents ?? null, expected_cash_cents: s.expectedCashCents ?? null, note: s.note ?? null,
});

async function shiftTotals(ctx: Ctx, shiftId: number, openingFloat: number) {
  const sales = await ctx.db.query("sales").withIndex("by_shift", (q) => q.eq("shiftId", shiftId)).collect();
  const by: Record<string, number> = {};
  for (const s of sales) for (const p of s.payments) by[p.method] = (by[p.method] ?? 0) + p.amountCents;
  return { byMethod: by, expectedCashCents: openingFloat + (by.cash ?? 0) };
}

async function loadSale(ctx: Ctx, id: number) {
  const s = await ctx.db.query("sales").withIndex("by_numId", (q) => q.eq("id", id)).unique();
  if (!s) return fail(404, "Sale not found");
  const cashier = await ctx.db.query("users").withIndex("by_numId", (q) => q.eq("id", s.userId)).unique();
  const cust = s.customerId != null ? await ctx.db.query("customers").withIndex("by_numId", (q) => q.eq("id", s.customerId!)).unique() : null;
  return {
    id: s.id, receipt_no: s.receiptNo, shift_id: s.shiftId ?? null, user_id: s.userId, customer_id: s.customerId ?? null, location_id: s.locationId,
    kind: s.kind, refund_of: s.refundOf ?? null, subtotal_cents: s.subtotalCents, discount_cents: s.discountCents, total_cents: s.totalCents,
    vat_cents: s.vatCents, note: s.note ?? null, approved_by: s.approvedBy ?? null, etims_status: s.etimsStatus, etims_invoice_no: null, etims_qr: null,
    created_at: iso(s.createdAt), cashier: cashier?.name ?? "", customer_name: cust?.name ?? null, customer_pin: null,
    items: s.items.map((i) => ({
      id: i.id, sale_id: s.id, product_id: i.productId, name: i.name, unit: i.unit, qty_milli: i.qtyMilli, unit_price_cents: i.unitPriceCents,
      cost_cents: i.costCents, vat_code: i.vatCode, line_total_cents: i.lineTotalCents, vat_cents: i.vatCents, base_qty_milli: i.baseQtyMilli,
    })),
    payments: s.payments.map((p) => ({ sale_id: s.id, method: p.method, amount_cents: p.amountCents, reference: p.reference ?? null })),
  };
}

// ---------- request checks ----------
function parseCheckout(b: any) {
  if (!b || typeof b !== "object") return bad("input", "expected an object");
  if (!Array.isArray(b.items) || b.items.length < 1) return bad("items", "Too small: expected array to have >=1 items");
  const items: { productId: number; qtyMilli: number; unitId: number | null }[] = b.items.map((it: any, i: number) => {
    if (!isInt(it?.productId)) bad(`items.${i}.productId`, "expected an integer");
    if (!isInt(it?.qtyMilli) || it.qtyMilli <= 0) bad(`items.${i}.qtyMilli`, "must be a positive whole number");
    if (it.unitId != null && !isInt(it.unitId)) bad(`items.${i}.unitId`, "expected an integer");
    return { productId: it.productId as number, qtyMilli: it.qtyMilli as number, unitId: (it.unitId ?? null) as number | null };
  });
  if (b.customerId != null && !isInt(b.customerId)) bad("customerId", "expected an integer");
  const discountCents = b.discountCents ?? 0;
  if (!isInt(discountCents) || discountCents < 0) bad("discountCents", "must be zero or more");
  const locationId = b.locationId ?? 1;
  if (!isInt(locationId)) bad("locationId", "expected an integer");
  if (b.approvalPin != null && typeof b.approvalPin !== "string") bad("approvalPin", "expected text");
  if (b.note != null && typeof b.note !== "string") bad("note", "expected text");
  if (!Array.isArray(b.payments) || b.payments.length < 1) return bad("payments", "Too small: expected array to have >=1 items");
  const payments: { method: Method; amountCents: number; reference?: string }[] = b.payments.map((p: any, i: number) => {
    if (!METHODS.includes(p?.method)) bad(`payments.${i}.method`, "Invalid option");
    if (!isInt(p?.amountCents) || p.amountCents <= 0) bad(`payments.${i}.amountCents`, "must be a positive whole number");
    if (p.reference != null && typeof p.reference !== "string") bad(`payments.${i}.reference`, "expected text");
    return { method: p.method as Method, amountCents: p.amountCents as number, reference: (p.reference || undefined) as string | undefined };
  });
  return {
    items, customerId: (b.customerId ?? null) as number | null, discountCents: discountCents as number, locationId: locationId as number,
    approvalPin: b.approvalPin as string | undefined, note: b.note as string | undefined, payments,
  };
}

export const routes: Record<string, Handler> = {
  // ---------------- shifts ----------------
  "GET /api/shifts/current": async (ctx, { token }) => {
    const user = await authenticate(ctx, token);
    const s = await openShiftFor(ctx, user.id);
    if (!s) return null;
    return { ...shiftRow(s), ...(await shiftTotals(ctx, s.id, s.openingFloatCents)) };
  },

  "POST /api/shifts/open": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "sales.create");
    const floatCents = body?.floatCents;
    if (!isInt(floatCents) || floatCents < 0) return bad("floatCents", "must be zero or more");
    if (await openShiftFor(ctx, user.id)) return fail(409, "You already have an open shift");
    const id = await nextId(ctx, "shifts");
    await ctx.db.insert("shifts", { id, userId: user.id, openedAt: Date.now(), openingFloatCents: floatCents });
    await audit(ctx, user.id, "shift_open", { floatCents });
    return { id };
  },

  "POST /api/shifts/close": async (ctx, { token, body }) => {
    const user = await authenticate(ctx, token);
    const counted = body?.countedCashCents;
    if (!isInt(counted) || counted < 0) return bad("countedCashCents", "must be zero or more");
    if (body?.note != null && typeof body.note !== "string") return bad("note", "expected text");
    const s = await openShiftFor(ctx, user.id);
    if (!s) return fail(400, "No open shift");
    const t = await shiftTotals(ctx, s.id, s.openingFloatCents);
    await ctx.db.patch(s._id, {
      closedAt: Date.now(), countedCashCents: counted, expectedCashCents: t.expectedCashCents,
      ...(body?.note ? { note: body.note as string } : {}),
    });
    await audit(ctx, user.id, "shift_close", { shiftId: s.id, expected: t.expectedCashCents, counted });
    return { shiftId: s.id, ...t, countedCashCents: counted, varianceCents: counted - t.expectedCashCents };
  },

  "GET /api/shifts": async (ctx, { token }) => {
    await requirePerm(ctx, token, "shifts.view_all");
    const shifts = await ctx.db.query("shifts").order("desc").take(60);
    const users = new Map((await ctx.db.query("users").collect()).map((u) => [u.id, u.name]));
    return shifts.sort((a, b) => b.id - a.id).map((s) => ({ ...shiftRow(s), cashier: users.get(s.userId) ?? "" }));
  },

  // ---------------- checkout ----------------
  "POST /api/sales": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "sales.create");
    const b = parseCheckout(body);
    const shift = await openShiftFor(ctx, user.id);
    if (!shift) return fail(400, "Open a shift before selling");

    const customer = b.customerId != null ? await ctx.db.query("customers").withIndex("by_numId", (q) => q.eq("id", b.customerId!)).unique() : null;
    if (b.customerId != null && (!customer || !customer.active)) return fail(400, "Customer not found");
    const tier: Tier = customer?.tier ?? "retail";

    // merge duplicate lines (same product in the same unit), load authoritative product data
    const merged = new Map<string, { productId: number; unitId: number | null; qtyMilli: number }>();
    for (const it of b.items) {
      const key = `${it.productId}:${it.unitId ?? 0}`;
      const cur = merged.get(key);
      if (cur) cur.qtyMilli += it.qtyMilli;
      else merged.set(key, { productId: it.productId, unitId: it.unitId, qtyMilli: it.qtyMilli });
    }
    const lines: { p: Doc<"products">; u?: Doc<"products">["units"][number]; qtyMilli: number; baseQty: number; unit: number; unitCost: number; gross: number }[] = [];
    for (const { productId, unitId, qtyMilli } of merged.values()) {
      const p = await ctx.db.query("products").withIndex("by_numId", (q) => q.eq("id", productId)).unique();
      if (!p || !p.active) return fail(400, "A product in the cart is no longer available");
      const u = unitId ? p.units.find((x) => x.id === unitId) : undefined;
      if (unitId && !u) return fail(400, `${p.name}: that unit is no longer available`);
      // a pack (roll, dozen, box) is sold whole; only the product's own unit may be fractional
      if ((u || !p.allowFraction) && qtyMilli % 1000 !== 0) return fail(400, `${p.name} cannot be sold in fractions`);
      const factor = u?.factorMilli ?? 1000;
      const baseQty = Math.round((qtyMilli * factor) / 1000); // what leaves stock, in the product's own unit
      const basePrice = priceFor(p, tier);
      // a price set on the unit applies to retail customers; other tiers get their own price scaled to the pack
      const unitPrice = u ? (u.priceCents != null && tier === "retail" ? u.priceCents : Math.round((basePrice * factor) / 1000)) : basePrice;
      lines.push({ p, u, qtyMilli, baseQty, unit: unitPrice, unitCost: Math.round((p.costCents * factor) / 1000), gross: lineTotal(unitPrice, qtyMilli) });
    }
    // stock is checked per product across all its lines, so selling a roll and loose metres together cannot oversell
    if ((await getSetting(ctx, "allow_negative_stock")) !== "1") {
      const want = new Map<number, number>();
      for (const l of lines) want.set(l.p.id, (want.get(l.p.id) ?? 0) + l.baseQty);
      for (const [pid, qty] of want) {
        if ((await stockOnHand(ctx, pid, b.locationId)) < qty) return fail(409, `Not enough stock for ${lines.find((l) => l.p.id === pid)!.p.name}`);
      }
    }

    const subtotal = lines.reduce((a, l) => a + l.gross, 0);
    if (b.discountCents > subtotal) return fail(400, "Discount exceeds the sale total");
    let approver: { id: number } | null = null;
    let creditApprover: { id: number } | null = null;
    if (b.discountCents > 0) approver = await resolveApprover(ctx, user, "sales.discount", b.approvalPin);

    const shares = allocate(b.discountCents, lines.map((l) => l.gross));
    const total = subtotal - b.discountCents;

    // payments: cash may be tendered over the total; everything else must be exact
    const paid = b.payments.reduce((a, p) => a + p.amountCents, 0);
    const cashIn = b.payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountCents, 0);
    const change = paid - total;
    if (paid < total) return fail(400, "Payment is less than the total");
    if (change > cashIn) return fail(400, "Overpayment is only allowed in cash");
    const creditAmt = b.payments.filter((p) => p.method === "credit").reduce((a, p) => a + p.amountCents, 0);
    if (creditAmt > 0) {
      if (!customer) return fail(400, "Select a customer for credit sales");
      // giving goods on loan is the costly mistake: staff need a manager's PIN unless their role allows it
      creditApprover = await resolveApprover(ctx, user, "sales.credit", b.approvalPin);
      if (customer.creditStopped) return fail(409, "Credit has been stopped for this customer. They need to pay what they owe first.");
      if (customer.balanceCents + creditAmt > customer.creditLimitCents) return fail(409, "Credit limit exceeded");
      // optional rule: no more credit for customers who are badly overdue
      const stopAfter = Number(await getSetting(ctx, "block_credit_overdue_days", "0"));
      if (stopAfter > 0) {
        const late = (await ageingFor(ctx, customer.id, customer.creditDays)).max_days_overdue;
        if (late > stopAfter) return fail(409, `This customer is ${late} days overdue. Take a payment before giving more credit.`);
      }
    }

    const vatTotal = lines.reduce((a, l, i) => a + vatOfGross(l.gross - shares[i], l.p.vatCode as VatCode), 0);
    const receiptNo = await nextReceiptNo(ctx);
    const id = await nextId(ctx, "sales");

    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const net = l.gross - shares[i];
      items.push({
        id: await nextId(ctx, "saleItems"), productId: l.p.id, name: l.p.name, unit: l.u?.name ?? l.p.unit, qtyMilli: l.qtyMilli,
        unitPriceCents: l.unit, costCents: l.unitCost, vatCode: l.p.vatCode, lineTotalCents: net, vatCents: vatOfGross(net, l.p.vatCode as VatCode), baseQtyMilli: l.baseQty,
      });
      await moveStock(ctx, { productId: l.p.id, locationId: b.locationId, qtyMilli: -l.baseQty, type: "sale", refType: "sale", refId: id, unitCostCents: l.p.costCents, userId: user.id });
    }

    // record cash net of change so the drawer reconciles
    const payments: { method: Method; amountCents: number; reference?: string }[] = [];
    let changeLeft = change;
    for (const p of b.payments) {
      let amt = p.amountCents;
      if (p.method === "cash" && changeLeft > 0) {
        const take = Math.min(changeLeft, amt);
        amt -= take;
        changeLeft -= take;
      }
      if (amt > 0) payments.push({ method: p.method, amountCents: amt, ...(p.reference ? { reference: p.reference } : {}) });
    }

    const approvedBy = (creditApprover ?? approver)?.id;
    await ctx.db.insert("sales", {
      id, receiptNo, shiftId: shift.id, userId: user.id, ...(customer ? { customerId: customer.id } : {}), locationId: b.locationId, kind: "sale",
      subtotalCents: subtotal, discountCents: b.discountCents, totalCents: total, vatCents: vatTotal,
      ...(b.note ? { note: b.note } : {}), ...(approvedBy != null ? { approvedBy } : {}), etimsStatus: "pending", createdAt: Date.now(), items, payments,
    });
    if (creditAmt > 0) await postCustomer(ctx, { customerId: customer!.id, amountCents: creditAmt, type: "credit_sale", refType: "sale", refId: id, userId: user.id });
    await audit(ctx, user.id, "sale", { id, receiptNo, total, discount: b.discountCents });

    const sale = await loadSale(ctx, id);
    return { ...sale, changeCents: Math.max(0, paid - sale.total_cents) };
  },

  // ---------------- refunds ----------------
  "POST /api/sales/:id/refund": async (ctx, { token, body, params }) => {
    const user = await requirePerm(ctx, token, "sales.create");
    const origId = Number(params.id);
    if (!body || !Array.isArray(body.items) || body.items.length < 1) return bad("items", "Too small: expected array to have >=1 items");
    const reqItems = body.items.map((it: any, i: number) => {
      if (!isInt(it?.saleItemId)) bad(`items.${i}.saleItemId`, "expected an integer");
      if (!isInt(it?.qtyMilli) || it.qtyMilli <= 0) bad(`items.${i}.qtyMilli`, "must be a positive whole number");
      return { saleItemId: it.saleItemId as number, qtyMilli: it.qtyMilli as number };
    });
    if (!METHODS.includes(body.method)) return bad("method", "Invalid option");
    const method = body.method as Method;
    if (typeof body.reason !== "string" || body.reason.length < 1) return bad("reason", "A reason is required");
    if (body.approvalPin != null && typeof body.approvalPin !== "string") return bad("approvalPin", "expected text");
    const restock = body.restock === undefined ? true : body.restock;
    if (typeof restock !== "boolean") return bad("restock", "expected true or false");

    const approver = await resolveApprover(ctx, user, "sales.refund", body.approvalPin);
    const shift = await openShiftFor(ctx, user.id);
    if (!shift) return fail(400, "Open a shift before processing a refund");

    const orig = await ctx.db.query("sales").withIndex("by_numId", (q) => q.eq("id", origId)).unique();
    if (!orig || orig.kind !== "sale") return fail(404, "Original sale not found");
    if (method === "credit" && orig.customerId == null) return fail(400, "Credit refunds need a customer on the sale");

    const earlier = await ctx.db.query("sales").withIndex("by_refund_of", (q) => q.eq("refundOf", origId)).collect();
    let total = 0, vat = 0;
    const rows = reqItems.map((it: { saleItemId: number; qtyMilli: number }) => {
      const si = orig.items.find((x) => x.id === it.saleItemId);
      if (!si) return fail(400, "Item does not belong to this sale");
      let already = 0; // negative: quantities already refunded for this product and unit
      for (const r of earlier) for (const ri of r.items) if (ri.productId === si.productId && ri.unit === si.unit) already += ri.qtyMilli;
      if (-already + it.qtyMilli > si.qtyMilli) return fail(400, `${si.name}: refund exceeds quantity sold`);
      // refund at the amount actually charged (after any discount share)
      const gross = Math.round((si.lineTotalCents * it.qtyMilli) / si.qtyMilli);
      const v = vatOfGross(gross, si.vatCode as VatCode);
      total += gross; vat += v;
      // what goes back on the shelf, in the product's own unit (a returned roll is 50 metres)
      const base = Math.round((si.baseQtyMilli * it.qtyMilli) / si.qtyMilli);
      return { si, qty: it.qtyMilli, gross, v, base };
    });

    const receiptNo = await nextReceiptNo(ctx);
    const id = await nextId(ctx, "sales");
    const items = [];
    for (const x of rows) {
      items.push({
        id: await nextId(ctx, "saleItems"), productId: x.si.productId, name: x.si.name, unit: x.si.unit, qtyMilli: -x.qty, unitPriceCents: x.si.unitPriceCents,
        costCents: x.si.costCents, vatCode: x.si.vatCode, lineTotalCents: -x.gross, vatCents: -x.v, baseQtyMilli: -x.base,
      });
      if (restock) {
        await moveStock(ctx, {
          productId: x.si.productId, locationId: orig.locationId, qtyMilli: x.base, type: "sale_return", refType: "sale", refId: id,
          unitCostCents: Math.round((x.si.costCents * x.si.qtyMilli) / x.si.baseQtyMilli), userId: user.id,
        });
      }
    }
    await ctx.db.insert("sales", {
      id, receiptNo, shiftId: shift.id, userId: user.id, ...(orig.customerId != null ? { customerId: orig.customerId } : {}), locationId: orig.locationId,
      kind: "refund", refundOf: origId, subtotalCents: -total, discountCents: 0, totalCents: -total, vatCents: -vat, note: body.reason as string,
      approvedBy: approver.id, etimsStatus: "pending", createdAt: Date.now(), items, payments: [{ method, amountCents: -total }],
    });
    if (method === "credit") await postCustomer(ctx, { customerId: orig.customerId!, amountCents: -total, type: "return", refType: "sale", refId: id, userId: user.id });
    await audit(ctx, user.id, "refund", { id, origId, total, approver: approver.id, reason: body.reason });
    return await loadSale(ctx, id);
  },

  // ---------------- sale history ----------------
  "GET /api/sales": async (ctx, { token, query }) => {
    const user = await authenticate(ctx, token);
    // one day (?date=) as before, or a range (?from=&to=)
    let from: number;
    let to: number;
    if (query.from || query.to) {
      if (!query.from || !query.to) return fail(400, "Choose both a start date and an end date");
      if (query.from > query.to) return fail(400, "The start date must not be after the end date");
      const a = eatDayRangeMs(query.from);
      const z = eatDayRangeMs(query.to);
      if ((z.to - a.from) / 86400000 > 366) return fail(400, "Choose a period of one year or less");
      from = a.from;
      to = z.to;
    } else {
      ({ from, to } = eatDayRangeMs(query.date || todayEAT()));
    }
    const limit = Math.min(Math.max(Math.floor(Number(query.limit)) || 0, 0), 5000);
    const mine = !can(user, "sales.view_all");
    const needle = (query.q ?? "").toLowerCase();
    const day = await ctx.db.query("sales").withIndex("by_created", (q) => q.gte("createdAt", from).lt("createdAt", to)).order("desc").collect();
    const rows = day.filter((s) => (!mine || s.userId === user.id) && (!needle || s.receiptNo.toLowerCase().includes(needle))).sort((a, b) => b.id - a.id);
    const users = new Map((await ctx.db.query("users").collect()).map((u) => [u.id, u.name]));
    const customers = new Map((await ctx.db.query("customers").collect()).map((c) => [c.id, c.name]));
    return (limit ? rows.slice(0, limit) : rows).map((s) => {
      const methods = [...new Set(s.payments.map((p) => p.method))];
      return {
        id: s.id, receipt_no: s.receiptNo, kind: s.kind, total_cents: s.totalCents, created_at: iso(s.createdAt),
        cashier: users.get(s.userId) ?? "", customer_name: s.customerId != null ? customers.get(s.customerId) ?? null : null,
        methods: methods.length ? methods.join(",") : null,
      };
    });
  },

  "GET /api/sales/:id": async (ctx, { token, params }) => {
    const user = await authenticate(ctx, token);
    const s = await loadSale(ctx, Number(params.id));
    if (!can(user, "sales.view_all") && s.user_id !== user.id) return fail(403, "Not allowed");
    const refunds = await ctx.db.query("sales").withIndex("by_refund_of", (q) => q.eq("refundOf", s.id)).collect();
    return { ...s, refunds: refunds.map((r) => ({ id: r.id, receipt_no: r.receiptNo, total_cents: r.totalCents })) };
  },
};
