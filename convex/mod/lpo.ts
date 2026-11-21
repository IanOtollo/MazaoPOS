import { audit, fail, nextId, requirePerm, type Ctx, type Handler } from "../lib";
import type { Doc } from "../_generated/dataModel";
import { routes as supplierRoutes } from "./suppliers";

/*
 * Local purchase orders (LPOs): the order sent to a supplier before the goods arrive.
 * draft -> sent -> partial -> received, or cancelled. Receiving goes through the normal goods-received
 * route, so stock, cost prices and what we owe the supplier stay consistent.
 */
const iso = (ms: number) => new Date(ms).toISOString();
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
const lineTotal = (qtyMilli: number, unitCostCents: number) => Math.round((unitCostCents * qtyMilli) / 1000);
const lpoById = async (ctx: Ctx, id: number) => ctx.db.query("lpos").withIndex("by_numId", (q) => q.eq("id", id)).unique();
const supplierName = async (ctx: Ctx, id: number) => (await ctx.db.query("suppliers").withIndex("by_numId", (q) => q.eq("id", id)).unique())?.name ?? "";
const totalOf = (o: Doc<"lpos">) => o.items.reduce((a, l) => a + lineTotal(l.qtyMilli, l.unitCostCents), 0);

async function parseLines(ctx: Ctx, lines: unknown) {
  if (!Array.isArray(lines) || lines.length < 1) return fail(400, "lines: Add at least one item");
  const out: Doc<"lpos">["items"] = [];
  const seen = new Set<number>();
  for (const l of lines) {
    if (!isInt(l?.productId)) return fail(400, "lines: Each item needs a product");
    if (!isInt(l?.qtyMilli) || l.qtyMilli <= 0) return fail(400, "lines: Quantity must be more than zero");
    if (!isInt(l?.unitCostCents) || l.unitCostCents < 0) return fail(400, "lines: Enter a valid buying price");
    if (seen.has(l.productId)) return fail(400, "lines: The same item is listed twice. Combine the quantities.");
    seen.add(l.productId);
    const p = await ctx.db.query("products").withIndex("by_numId", (q) => q.eq("id", l.productId)).unique();
    if (!p) return fail(400, "An item on this order no longer exists");
    out.push({ productId: p.id, name: p.name, unit: p.unit, qtyMilli: l.qtyMilli, unitCostCents: l.unitCostCents, receivedMilli: 0 });
  }
  return out;
}

function parseHeader(body: any) {
  if (body?.note !== undefined && (typeof body.note !== "string" || body.note.length > 300)) return fail(400, "note: Too long");
  if (body?.expectedOn !== undefined && body.expectedOn !== "" && (typeof body.expectedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedOn))) return fail(400, "expectedOn: Invalid date");
  return { note: (body?.note as string | undefined)?.trim() || undefined, expectedOn: (body?.expectedOn as string | undefined) || undefined };
}

const row = async (ctx: Ctx, o: Doc<"lpos">) => ({
  id: o.id, number: o.number, supplier_id: o.supplierId, supplier: await supplierName(ctx, o.supplierId), status: o.status,
  total_cents: totalOf(o), lines: o.items.length, open_lines: o.items.filter((l) => l.receivedMilli < l.qtyMilli).length,
  expected_on: o.expectedOn ?? null, created_at: iso(o.createdAt), sent_at: o.sentAt ? iso(o.sentAt) : null,
});

export const routes: Record<string, Handler> = {
  "GET /api/lpos": async (ctx, { token, query }) => {
    await requirePerm(ctx, token, "suppliers.manage");
    let all = await ctx.db.query("lpos").collect();
    if (query.status) all = all.filter((o) => (query.status === "open" ? o.status === "draft" || o.status === "sent" || o.status === "partial" : o.status === query.status));
    if (query.supplierId) all = all.filter((o) => o.supplierId === Number(query.supplierId));
    all.sort((a, b) => b.id - a.id);
    return Promise.all(all.map((o) => row(ctx, o)));
  },

  "GET /api/lpos/:id": async (ctx, { token, params }) => {
    await requirePerm(ctx, token, "suppliers.manage");
    const o = await lpoById(ctx, Number(params.id));
    if (!o) return fail(404, "Order not found");
    const sup = await ctx.db.query("suppliers").withIndex("by_numId", (q) => q.eq("id", o.supplierId)).unique();
    return {
      ...(await row(ctx, o)), note: o.note ?? null,
      supplier_phone: sup?.phone ?? null, supplier_email: sup?.email ?? null,
      items: o.items.map((l) => ({
        product_id: l.productId, name: l.name, unit: l.unit, qty_milli: l.qtyMilli, unit_cost_cents: l.unitCostCents,
        received_milli: l.receivedMilli, line_total_cents: lineTotal(l.qtyMilli, l.unitCostCents),
      })),
      purchase_ids: o.purchaseIds,
    };
  },

  "POST /api/lpos": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "suppliers.manage");
    if (!isInt(body?.supplierId)) return fail(400, "supplierId: Choose a supplier");
    const sup = await ctx.db.query("suppliers").withIndex("by_numId", (q) => q.eq("id", body.supplierId)).unique();
    if (!sup || !sup.active) return fail(400, "Choose a supplier");
    const h = parseHeader(body);
    const items = await parseLines(ctx, body.lines);
    const send = body.send === true;
    const n = await nextId(ctx, "lpo");
    const id = await nextId(ctx, "lpos");
    await ctx.db.insert("lpos", {
      id, number: `LPO-${String(n).padStart(4, "0")}`, supplierId: sup.id, status: send ? "sent" : "draft", userId: user.id, createdAt: Date.now(),
      ...(send ? { sentAt: Date.now() } : {}), ...(h.note ? { note: h.note } : {}), ...(h.expectedOn ? { expectedOn: h.expectedOn } : {}),
      items, purchaseIds: [],
    });
    await audit(ctx, user.id, "lpo_create", { id, supplierId: sup.id, send });
    return { id };
  },

  // edit a draft: the supplier stays, the items, note and expected date can change
  "PUT /api/lpos/:id": async (ctx, { token, body, params }) => {
    const user = await requirePerm(ctx, token, "suppliers.manage");
    const o = await lpoById(ctx, Number(params.id));
    if (!o) return fail(404, "Order not found");
    if (o.status !== "draft") return fail(409, "Only a draft order can be edited. Cancel it and make a new one if it has been sent.");
    const h = parseHeader(body);
    const items = await parseLines(ctx, body?.lines);
    await ctx.db.patch(o._id, { items, note: h.note, expectedOn: h.expectedOn });
    await audit(ctx, user.id, "lpo_update", { id: o.id });
    return { ok: true };
  },

  // draft -> sent, an unreceived order -> cancelled, a partly delivered order -> received (closed short)
  "PATCH /api/lpos/:id": async (ctx, { token, body, params }) => {
    const user = await requirePerm(ctx, token, "suppliers.manage");
    const o = await lpoById(ctx, Number(params.id));
    if (!o) return fail(404, "Order not found");
    const to = body?.status;
    if (to === "sent") {
      if (o.status !== "draft") return fail(409, "Only a draft order can be marked as sent");
      await ctx.db.patch(o._id, { status: "sent", sentAt: Date.now() });
    } else if (to === "cancelled") {
      if (o.status === "received" || o.status === "cancelled") return fail(409, `This order is already ${o.status}`);
      if (o.status === "partial") return fail(409, "Some goods have already arrived. Close the order as received instead.");
      await ctx.db.patch(o._id, { status: "cancelled" });
    } else if (to === "received") {
      if (o.status !== "partial") return fail(409, "Only a partly delivered order can be closed");
      await ctx.db.patch(o._id, { status: "received" });
    } else return fail(400, "status: Choose sent, cancelled or received");
    await audit(ctx, user.id, "lpo_status", { id: o.id, status: to });
    return { ok: true };
  },

  // goods arrived against this order: lines = [{ productId, qtyMilli }], optional unitCostCents, invoiceNo, paidCents...
  "POST /api/lpos/:id/receive": async (ctx, req) => {
    const { token, body, params } = req;
    const user = await requirePerm(ctx, token, "suppliers.manage");
    const o = await lpoById(ctx, Number(params.id));
    if (!o) return fail(404, "Order not found");
    if (o.status !== "sent" && o.status !== "partial") return fail(409, o.status === "draft" ? "Mark the order as sent before receiving goods" : `This order is ${o.status}`);
    if (!Array.isArray(body?.lines) || body.lines.length < 1) return fail(400, "lines: Enter what arrived");
    const lines: { productId: number; qtyMilli: number; unitCostCents: number }[] = [];
    const items = o.items.map((l) => ({ ...l }));
    for (const l of body.lines) {
      if (!isInt(l?.productId) || !isInt(l?.qtyMilli) || l.qtyMilli < 0) return fail(400, "lines: Enter a valid quantity");
      if (l.qtyMilli === 0) continue;
      const it = items.find((x) => x.productId === l.productId);
      if (!it) return fail(400, "lines: That item is not on this order");
      if (l.qtyMilli > it.qtyMilli - it.receivedMilli) return fail(400, `${it.name}: more than is still outstanding on this order`);
      const cost = l.unitCostCents === undefined ? it.unitCostCents : l.unitCostCents;
      if (!isInt(cost) || cost < 0) return fail(400, "lines: Enter a valid buying price");
      it.receivedMilli += l.qtyMilli;
      lines.push({ productId: it.productId, qtyMilli: l.qtyMilli, unitCostCents: cost });
    }
    if (!lines.length) return fail(400, "lines: Enter what arrived");
    // the normal goods-received step: stock, cost price, supplier balance and the optional part payment
    const made = (await supplierRoutes["POST /api/purchases"](ctx, {
      ...req, params: {}, query: {},
      body: {
        supplierId: o.supplierId, lines, locationId: body.locationId, invoiceNo: body.invoiceNo, receivedOn: body.receivedOn,
        paidCents: body.paidCents, payMethod: body.payMethod, note: body.note ?? `Against ${o.number}`,
      },
    })) as { id: number };
    const done = items.every((l) => l.receivedMilli >= l.qtyMilli);
    await ctx.db.patch(o._id, { items, status: done ? "received" : "partial", purchaseIds: [...o.purchaseIds, made.id] });
    await audit(ctx, user.id, "lpo_receive", { id: o.id, purchaseId: made.id, complete: done });
    return { purchase_id: made.id, status: done ? "received" : "partial" };
  },
};
