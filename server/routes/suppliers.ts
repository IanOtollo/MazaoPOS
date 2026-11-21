import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, tx } from "../db.ts";
import { HttpError, requirePerm } from "../auth.ts";
import { supplierAgeing } from "../receivables.ts";
import { parse, todayEAT } from "../util.ts";

interface SupplierRow { id: number; name: string; phone: string | null; email: string | null; kra_pin: string | null; credit_days: number; active: number }

const owedTo = (id: number) =>
  (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS b FROM supplier_ledger WHERE supplier_id=?").get(id) as { b: number }).b;

const supplierBody = z.object({
  name: z.string().trim().min(1, "Give the supplier a name"),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  kraPin: z.string().nullish(),
  creditDays: z.number().int().min(0).max(365).default(30),
});

export function supplierRoutes(app: FastifyInstance) {
  const guard = { preHandler: requirePerm("suppliers.manage") };

  // all suppliers, with what we owe each and how much of it is already past its due date
  app.get("/api/suppliers", guard, async () => {
    const rows = db.prepare("SELECT * FROM suppliers WHERE active=1 ORDER BY name").all() as unknown as SupplierRow[];
    const list = rows.map((s) => {
      const a = supplierAgeing(s.id, s.credit_days);
      const last = db.prepare("SELECT received_on FROM purchases WHERE supplier_id=? ORDER BY id DESC LIMIT 1").get(s.id) as { received_on: string } | undefined;
      return { ...s, owed_cents: Math.max(0, a.balance_cents), overdue_cents: a.overdue_cents, max_days_overdue: a.max_days_overdue, last_delivery: last?.received_on ?? null };
    });
    return { totals: { owed_cents: list.reduce((x, s) => x + s.owed_cents, 0), overdue_cents: list.reduce((x, s) => x + s.overdue_cents, 0) }, suppliers: list };
  });

  app.post("/api/suppliers", guard, async (req) => {
    const b = parse(supplierBody, req.body);
    const r = db.prepare("INSERT INTO suppliers (name,phone,email,kra_pin,credit_days) VALUES (?,?,?,?,?)").run(b.name, b.phone ?? null, b.email ?? null, b.kraPin ?? null, b.creditDays);
    audit(req.user!.id, "supplier_create", { name: b.name });
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch("/api/suppliers/:id", guard, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(supplierBody.partial().extend({ active: z.boolean().optional() }), req.body);
    const cur = db.prepare("SELECT * FROM suppliers WHERE id=?").get(id) as unknown as SupplierRow | undefined;
    if (!cur) throw new HttpError(404, "Supplier not found");
    db.prepare("UPDATE suppliers SET name=?,phone=?,email=?,kra_pin=?,credit_days=?,active=? WHERE id=?").run(
      b.name ?? cur.name,
      b.phone === undefined ? cur.phone : b.phone,
      b.email === undefined ? cur.email : b.email,
      b.kraPin === undefined ? cur.kra_pin : b.kraPin,
      b.creditDays ?? cur.credit_days,
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      id,
    );
    audit(req.user!.id, "supplier_update", { id });
    return { ok: true };
  });

  // one supplier: what we owe, the statement, and what they have delivered
  app.get("/api/suppliers/:id", guard, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const s = db.prepare("SELECT * FROM suppliers WHERE id=?").get(id) as unknown as SupplierRow | undefined;
    if (!s) throw new HttpError(404, "Supplier not found");
    const asc = db
      .prepare(
        `SELECT l.id, l.amount_cents, l.type, l.method, l.note, l.created_at, p.invoice_no
         FROM supplier_ledger l LEFT JOIN purchases p ON l.type='purchase' AND p.id=l.ref_id WHERE l.supplier_id=? ORDER BY l.id`,
      )
      .all(id) as unknown as { id: number; amount_cents: number; type: string; method: string | null; note: string | null; created_at: string; invoice_no: string | null }[];
    let run = 0;
    const statement = asc.map((r) => ({ ...r, balance_cents: (run += r.amount_cents) })).reverse();
    const deliveries = db
      .prepare(
        `SELECT p.id, p.invoice_no, p.received_on, p.total_cents, l.name AS location,
           (SELECT COUNT(*) FROM purchase_items WHERE purchase_id=p.id) AS lines
         FROM purchases p JOIN locations l ON l.id=p.location_id WHERE p.supplier_id=? ORDER BY p.id DESC LIMIT 50`,
      )
      .all(id);
    return { supplier: s, owed_cents: owedTo(id), ageing: supplierAgeing(id, s.credit_days), statement, deliveries };
  });

  // goods received from a supplier: stock goes up, the buying price is updated, and the supplier is owed the total
  app.post("/api/purchases", guard, async (req) => {
    const b = parse(
      z.object({
        supplierId: z.number().int(),
        invoiceNo: z.string().trim().max(60).optional(),
        locationId: z.number().int().default(1),
        receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        note: z.string().max(300).optional(),
        paidCents: z.number().int().min(0).default(0),
        payMethod: z.enum(["cash", "mpesa", "bank", "card"]).default("cash"),
        lines: z
          .array(z.object({ productId: z.number().int(), qtyMilli: z.number().int().positive(), unitCostCents: z.number().int().min(0) }))
          .min(1, "Add at least one item"),
      }),
      req.body,
    );
    const user = req.user!;
    const id = tx(() => {
      const sup = db.prepare("SELECT id, active FROM suppliers WHERE id=?").get(b.supplierId) as { id: number; active: number } | undefined;
      if (!sup || !sup.active) throw new HttpError(400, "Choose a supplier");
      if (!db.prepare("SELECT 1 FROM locations WHERE id=?").get(b.locationId)) throw new HttpError(400, "Choose where the goods were received");

      const lines = b.lines.map((l) => {
        const p = db.prepare("SELECT id, name FROM products WHERE id=?").get(l.productId) as { id: number; name: string } | undefined;
        if (!p) throw new HttpError(400, "An item on this delivery no longer exists");
        return { ...l, name: p.name, total: Math.round((l.unitCostCents * l.qtyMilli) / 1000) };
      });
      const total = lines.reduce((a, l) => a + l.total, 0);
      if (b.paidCents > total) throw new HttpError(400, "You cannot pay more than the delivery total");

      const pid = Number(
        db
          .prepare("INSERT INTO purchases (supplier_id,invoice_no,location_id,total_cents,note,user_id,received_on) VALUES (?,?,?,?,?,?,?)")
          .run(b.supplierId, b.invoiceNo || null, b.locationId, total, b.note ?? null, user.id, b.receivedOn ?? todayEAT()).lastInsertRowid,
      );
      const insLine = db.prepare("INSERT INTO purchase_items (purchase_id,product_id,name,qty_milli,unit_cost_cents) VALUES (?,?,?,?,?)");
      const insMove = db.prepare(
        "INSERT INTO stock_movements (product_id,location_id,qty_milli,type,ref_type,ref_id,unit_cost_cents,user_id) VALUES (?,?,?,'purchase','purchase',?,?,?)",
      );
      const setCost = db.prepare("UPDATE products SET cost_cents=? WHERE id=?");
      for (const l of lines) {
        insLine.run(pid, l.productId, l.name, l.qtyMilli, l.unitCostCents);
        insMove.run(l.productId, b.locationId, l.qtyMilli, pid, l.unitCostCents, user.id);
        setCost.run(l.unitCostCents, l.productId); // the latest buying price becomes the cost price
      }
      const ledger = db.prepare("INSERT INTO supplier_ledger (supplier_id,amount_cents,type,ref_id,method,note,user_id) VALUES (?,?,?,?,?,?,?)");
      ledger.run(b.supplierId, total, "purchase", pid, null, null, user.id);
      if (b.paidCents > 0) ledger.run(b.supplierId, -b.paidCents, "payment", pid, b.payMethod, "Paid on delivery", user.id);
      audit(user.id, "purchase", { id: pid, supplierId: b.supplierId, total, paid: b.paidCents });
      return pid;
    });
    return { id };
  });

  // paying a supplier (or recording a credit note from them)
  app.post("/api/suppliers/:id/payment", guard, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(
      z.object({ amountCents: z.number().int().positive(), method: z.enum(["cash", "mpesa", "bank", "card", "credit_note"]), reference: z.string().max(80).optional() }),
      req.body,
    );
    if (!db.prepare("SELECT 1 FROM suppliers WHERE id=?").get(id)) throw new HttpError(404, "Supplier not found");
    if (b.amountCents > owedTo(id)) throw new HttpError(400, "That is more than you owe this supplier");
    const isNote = b.method === "credit_note";
    db.prepare("INSERT INTO supplier_ledger (supplier_id,amount_cents,type,method,note,user_id) VALUES (?,?,?,?,?,?)").run(
      id, -b.amountCents, isNote ? "credit_note" : "payment", isNote ? null : b.method, b.reference ?? null, req.user!.id,
    );
    audit(req.user!.id, "supplier_payment", { id, ...b });
    return { owed_cents: owedTo(id) };
  });

  // what to buy: everything at or below its reorder level, with the last supplier and a suggested quantity
  app.get("/api/reorder", guard, async () => {
    const rows = db
      .prepare(
        `SELECT * FROM (
           SELECT p.id, p.sku, p.name, p.unit, p.cost_cents, p.reorder_level_milli,
             COALESCE((SELECT SUM(qty_milli) FROM stock_movements WHERE product_id=p.id),0) AS stock_milli,
             (SELECT s.id FROM purchase_items pi JOIN purchases pu ON pu.id=pi.purchase_id JOIN suppliers s ON s.id=pu.supplier_id
                WHERE pi.product_id=p.id ORDER BY pu.id DESC LIMIT 1) AS last_supplier_id,
             (SELECT s.name FROM purchase_items pi JOIN purchases pu ON pu.id=pi.purchase_id JOIN suppliers s ON s.id=pu.supplier_id
                WHERE pi.product_id=p.id ORDER BY pu.id DESC LIMIT 1) AS last_supplier,
             (SELECT pu.received_on FROM purchase_items pi JOIN purchases pu ON pu.id=pi.purchase_id
                WHERE pi.product_id=p.id ORDER BY pu.id DESC LIMIT 1) AS last_supply
           FROM products p WHERE p.active=1
         ) WHERE reorder_level_milli > 0 AND stock_milli <= reorder_level_milli
         ORDER BY last_supplier IS NULL, last_supplier, name`,
      )
      .all() as unknown as { stock_milli: number; reorder_level_milli: number }[];
    // suggest enough to get back to twice the reorder level
    return rows.map((r) => ({ ...r, suggested_milli: Math.max(r.reorder_level_milli * 2 - r.stock_milli, r.reorder_level_milli - r.stock_milli + 1000) }));
  });
}
