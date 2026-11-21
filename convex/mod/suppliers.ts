import { audit, fail, moveStock, nextId, postSupplier, requirePerm, todayEAT, type Ctx, type Handler } from "../lib";
import { supplierAgeing } from "../receivablesLib";
import type { Doc } from "../_generated/dataModel";

/*
 * Suppliers, goods received, paying suppliers, and the reorder list.
 * Same addresses and JSON as the old server (snake_case, 0/1 for booleans, ISO strings for times).
 */
const iso = (ms: number) => new Date(ms).toISOString();
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);

/** What the screens read for a supplier. (KRA PIN is no longer kept; the field stays null for older screens.) */
const supplierRow = (s: Doc<"suppliers">) => ({
  id: s.id, name: s.name, phone: s.phone ?? null, email: s.email ?? null, kra_pin: null as string | null,
  credit_days: s.creditDays, active: s.active ? 1 : 0,
});

const supplierById = async (ctx: Ctx, id: number) => ctx.db.query("suppliers").withIndex("by_numId", (q) => q.eq("id", id)).unique();

/** Text field that may be absent, null (clear it) or a string. Returns undefined when not supplied. */
function optText(b: any, key: string): string | null | undefined {
  const v = b?.[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return fail(400, `${key}: Expected text`);
  return v;
}
function creditDaysOf(v: unknown, fallback: number | undefined): number | undefined {
  if (v === undefined) return fallback;
  if (!isInt(v) || v < 0 || v > 365) return fail(400, "creditDays: Enter a whole number of days between 0 and 365");
  return v;
}

const METHODS = ["cash", "mpesa", "bank", "card"] as const;

export const routes: Record<string, Handler> = {
  // all suppliers, with what we owe each and how much of it is already past its due date
  "GET /api/suppliers": async (ctx, { token }) => {
    await requirePerm(ctx, token, "suppliers.manage");
    const rows = (await ctx.db.query("suppliers").collect()).filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name));
    const purchases = await ctx.db.query("purchases").collect();
    const lastBySupplier = new Map<number, Doc<"purchases">>();
    for (const p of purchases) {
      const cur = lastBySupplier.get(p.supplierId);
      if (!cur || p.id > cur.id) lastBySupplier.set(p.supplierId, p);
    }
    const list = [];
    for (const s of rows) {
      const a = await supplierAgeing(ctx, s.id, s.creditDays);
      list.push({
        ...supplierRow(s),
        owed_cents: Math.max(0, a.balance_cents),
        overdue_cents: a.overdue_cents,
        max_days_overdue: a.max_days_overdue,
        last_delivery: lastBySupplier.get(s.id)?.receivedOn ?? null,
      });
    }
    return {
      totals: { owed_cents: list.reduce((x, s) => x + s.owed_cents, 0), overdue_cents: list.reduce((x, s) => x + s.overdue_cents, 0) },
      suppliers: list,
    };
  },

  "POST /api/suppliers": async (ctx, { token, body }) => {
    const actor = await requirePerm(ctx, token, "suppliers.manage");
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return fail(400, "name: Give the supplier a name");
    const phone = optText(body, "phone");
    const email = optText(body, "email");
    optText(body, "kraPin"); // accepted and ignored: the business no longer records KRA PINs
    const creditDays = creditDaysOf(body?.creditDays, 30)!;
    const id = await nextId(ctx, "suppliers");
    await ctx.db.insert("suppliers", {
      id, name, creditDays, active: true, balanceCents: 0, createdAt: Date.now(),
      ...(phone ? { phone } : {}), ...(email ? { email } : {}),
    });
    await audit(ctx, actor.id, "supplier_create", { name });
    return { id };
  },

  "PATCH /api/suppliers/:id": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "suppliers.manage");
    const id = Number(params.id);
    let name: string | undefined;
    if (body?.name !== undefined) {
      name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return fail(400, "name: Give the supplier a name");
    }
    const phone = optText(body, "phone");
    const email = optText(body, "email");
    optText(body, "kraPin");
    const creditDays = creditDaysOf(body?.creditDays, undefined);
    if (body?.active !== undefined && typeof body.active !== "boolean") return fail(400, "active: Expected true or false");
    const cur = await supplierById(ctx, id);
    if (!cur) return fail(404, "Supplier not found");
    const patch: Record<string, unknown> = {};
    if (name !== undefined) patch.name = name;
    if (phone !== undefined) patch.phone = phone || undefined; // undefined removes the field
    if (email !== undefined) patch.email = email || undefined;
    if (creditDays !== undefined) patch.creditDays = creditDays;
    if (body?.active !== undefined) patch.active = body.active;
    await ctx.db.patch(cur._id, patch);
    await audit(ctx, actor.id, "supplier_update", { id });
    return { ok: true };
  },

  // one supplier: what we owe, the statement, and what they have delivered
  "GET /api/suppliers/:id": async (ctx, { token, params }) => {
    await requirePerm(ctx, token, "suppliers.manage");
    const id = Number(params.id);
    const s = await supplierById(ctx, id);
    if (!s) return fail(404, "Supplier not found");

    const ledger = (await ctx.db.query("supplierLedger").withIndex("by_supplier", (q) => q.eq("supplierId", id)).collect()).sort((a, b) => a.id - b.id);
    const purchases = (await ctx.db.query("purchases").withIndex("by_supplier", (q) => q.eq("supplierId", id)).collect()).sort((a, b) => b.id - a.id);
    const invoiceOf = new Map(purchases.map((p) => [p.id, p.invoiceNo ?? null]));
    let run = 0;
    const statement = ledger
      .map((l) => ({
        id: l.id, amount_cents: l.amountCents, type: l.type, method: l.method ?? null, note: l.note ?? null, created_at: iso(l.createdAt),
        invoice_no: l.type === "purchase" && l.refId !== undefined ? invoiceOf.get(l.refId) ?? null : null,
        balance_cents: (run += l.amountCents),
      }))
      .reverse();

    const locations = new Map((await ctx.db.query("locations").collect()).map((l) => [l.id, l.name]));
    const deliveries = purchases.slice(0, 50).map((p) => ({
      id: p.id, invoice_no: p.invoiceNo ?? null, received_on: p.receivedOn, total_cents: p.totalCents,
      location: locations.get(p.locationId) ?? "", lines: p.items.length,
    }));
    return { supplier: supplierRow(s), owed_cents: s.balanceCents, ageing: await supplierAgeing(ctx, id, s.creditDays), statement, deliveries };
  },

  // goods received from a supplier: stock goes up, the buying price is updated, and the supplier is owed the total
  "POST /api/purchases": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "suppliers.manage");
    if (!isInt(body?.supplierId)) return fail(400, "supplierId: Choose a supplier");
    const supplierId: number = body.supplierId;
    let invoiceNo: string | undefined;
    if (body.invoiceNo !== undefined) {
      if (typeof body.invoiceNo !== "string") return fail(400, "invoiceNo: Expected text");
      const trimmed: string = body.invoiceNo.trim();
      invoiceNo = trimmed;
      if (trimmed.length > 60) return fail(400, "invoiceNo: Too long");
    }
    const locationId = body.locationId === undefined ? 1 : body.locationId;
    if (!isInt(locationId)) return fail(400, "locationId: Choose where the goods were received");
    if (body.receivedOn !== undefined && (typeof body.receivedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.receivedOn))) return fail(400, "receivedOn: Invalid date");
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 300)) return fail(400, "note: Too long");
    const paidCents = body.paidCents === undefined ? 0 : body.paidCents;
    if (!isInt(paidCents) || paidCents < 0) return fail(400, "paidCents: Enter a valid amount");
    const payMethod = body.payMethod === undefined ? "cash" : body.payMethod;
    if (!METHODS.includes(payMethod)) return fail(400, "payMethod: Choose how it was paid");
    if (!Array.isArray(body.lines) || body.lines.length < 1) return fail(400, "lines: Add at least one item");
    for (const l of body.lines) {
      if (!isInt(l?.productId)) return fail(400, "lines: Each item needs a product");
      if (!isInt(l?.qtyMilli) || l.qtyMilli <= 0) return fail(400, "lines: Quantity must be more than zero");
      if (!isInt(l?.unitCostCents) || l.unitCostCents < 0) return fail(400, "lines: Enter a valid buying price");
    }

    const sup = await supplierById(ctx, supplierId);
    if (!sup || !sup.active) return fail(400, "Choose a supplier");
    if (!(await ctx.db.query("locations").withIndex("by_numId", (q) => q.eq("id", locationId)).unique())) return fail(400, "Choose where the goods were received");

    const lines: { productId: number; name: string; qtyMilli: number; unitCostCents: number; total: number; doc: Doc<"products"> }[] = [];
    for (const l of body.lines as { productId: number; qtyMilli: number; unitCostCents: number }[]) {
      const p = await ctx.db.query("products").withIndex("by_numId", (q) => q.eq("id", l.productId)).unique();
      if (!p) return fail(400, "An item on this delivery no longer exists");
      lines.push({ productId: l.productId, name: p.name, qtyMilli: l.qtyMilli, unitCostCents: l.unitCostCents, total: Math.round((l.unitCostCents * l.qtyMilli) / 1000), doc: p });
    }
    const total = lines.reduce((a, l) => a + l.total, 0);
    if (paidCents > total) return fail(400, "You cannot pay more than the delivery total");

    const pid = await nextId(ctx, "purchases");
    await ctx.db.insert("purchases", {
      id: pid, supplierId, locationId, totalCents: total, userId: user.id, receivedOn: body.receivedOn ?? todayEAT(), createdAt: Date.now(),
      ...(invoiceNo ? { invoiceNo } : {}), ...(body.note ? { note: body.note } : {}),
      items: lines.map((l) => ({ productId: l.productId, name: l.name, qtyMilli: l.qtyMilli, unitCostCents: l.unitCostCents })),
    });
    for (const l of lines) {
      await moveStock(ctx, { productId: l.productId, locationId, qtyMilli: l.qtyMilli, type: "purchase", refType: "purchase", refId: pid, unitCostCents: l.unitCostCents, userId: user.id });
      await ctx.db.patch(l.doc._id, { costCents: l.unitCostCents }); // the latest buying price becomes the cost price
    }
    await postSupplier(ctx, { supplierId, amountCents: total, type: "purchase", refId: pid, userId: user.id });
    if (paidCents > 0) await postSupplier(ctx, { supplierId, amountCents: -paidCents, type: "payment", refId: pid, method: payMethod, note: "Paid on delivery", userId: user.id });
    await audit(ctx, user.id, "purchase", { id: pid, supplierId, total, paid: paidCents });
    return { id: pid };
  },

  // paying a supplier (or recording a credit note from them)
  "POST /api/suppliers/:id/payment": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "suppliers.manage");
    const id = Number(params.id);
    if (!isInt(body?.amountCents) || body.amountCents <= 0) return fail(400, "amountCents: Enter an amount more than zero");
    const method = body?.method;
    if (![...METHODS, "credit_note"].includes(method)) return fail(400, "method: Choose how it was paid");
    if (body.reference !== undefined && (typeof body.reference !== "string" || body.reference.length > 80)) return fail(400, "reference: Too long");
    const sup = await supplierById(ctx, id);
    if (!sup) return fail(404, "Supplier not found");
    if (body.amountCents > sup.balanceCents) return fail(400, "That is more than you owe this supplier");
    const isNote = method === "credit_note";
    const owed = await postSupplier(ctx, {
      supplierId: id, amountCents: -body.amountCents, type: isNote ? "credit_note" : "payment", userId: actor.id,
      ...(isNote ? {} : { method }), ...(body.reference ? { note: body.reference } : {}),
    });
    await audit(ctx, actor.id, "supplier_payment", { id, amountCents: body.amountCents, method, reference: body.reference });
    return { owed_cents: owed };
  },

  // what to buy: everything at or below its reorder level, with the last supplier and a suggested quantity
  "GET /api/reorder": async (ctx, { token }) => {
    await requirePerm(ctx, token, "suppliers.manage");
    const products = (await ctx.db.query("products").collect()).filter((p) => p.active && p.reorderLevelMilli > 0);
    const onHand = new Map<number, number>();
    for (const s of await ctx.db.query("stock").collect()) onHand.set(s.productId, (onHand.get(s.productId) ?? 0) + s.qtyMilli);
    const low = products.filter((p) => (onHand.get(p.id) ?? 0) <= p.reorderLevelMilli);
    if (low.length === 0) return [];

    // the latest delivery that included each product
    const lastFor = new Map<number, { supplierId: number; receivedOn: string }>();
    const purchases = (await ctx.db.query("purchases").collect()).sort((a, b) => b.id - a.id);
    const want = new Set(low.map((p) => p.id));
    for (const pu of purchases) {
      for (const it of pu.items) {
        if (want.has(it.productId) && !lastFor.has(it.productId)) lastFor.set(it.productId, { supplierId: pu.supplierId, receivedOn: pu.receivedOn });
      }
    }
    const names = new Map((await ctx.db.query("suppliers").collect()).map((s) => [s.id, s.name]));

    const rows = low.map((p) => {
      const last = lastFor.get(p.id);
      const stock = onHand.get(p.id) ?? 0;
      return {
        id: p.id, sku: p.sku, name: p.name, unit: p.unit, cost_cents: p.costCents, reorder_level_milli: p.reorderLevelMilli, stock_milli: stock,
        last_supplier_id: last?.supplierId ?? null, last_supplier: last ? names.get(last.supplierId) ?? null : null, last_supply: last?.receivedOn ?? null,
        // suggest enough to get back to twice the reorder level
        suggested_milli: Math.max(p.reorderLevelMilli * 2 - stock, p.reorderLevelMilli - stock + 1000),
      };
    });
    rows.sort((a, b) => {
      if ((a.last_supplier === null) !== (b.last_supplier === null)) return a.last_supplier === null ? 1 : -1;
      return (a.last_supplier ?? "").localeCompare(b.last_supplier ?? "") || a.name.localeCompare(b.name);
    });
    return rows;
  },
};
