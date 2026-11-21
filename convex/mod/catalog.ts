import type { Doc } from "../_generated/dataModel";
import {
  audit, authenticate, can, fail, getSetting, moveStock, nextId, requirePerm, stockOnHand,
  type Ctx, type Handler, type Req,
} from "../lib";

/*
 * Locations, categories, products (with their other selling units), stock movements and the bulk import.
 * Same addresses and JSON as the old server: product rows are snake_case, 0/1 flags stay numbers, times are ISO text.
 */
const iso = (ms: number) => new Date(ms).toISOString();
const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const SHOP = 1;
const STORE = 2;

// ---------- small validators (messages read like the old "field: message") ----------
const typeOf = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x);
function obj(body: unknown): Record<string, any> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, `input: Invalid input: expected object, received ${typeOf(body)}`);
  return body as Record<string, any>;
}
function int(v: unknown, field: string, min?: number, minMsg?: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) return fail(400, `${field}: Invalid input: expected int, received ${typeOf(v)}`);
  if (min !== undefined && v < min) return fail(400, `${field}: ${minMsg ?? `Too small: expected number to be >=${min}`}`);
  return v;
}
function text(v: unknown, field: string, o: { min?: number; max?: number; trim?: boolean; minMsg?: string } = {}): string {
  if (typeof v !== "string") return fail(400, `${field}: Invalid input: expected string, received ${typeOf(v)}`);
  const s = o.trim ? v.trim() : v;
  if (o.min !== undefined && s.length < o.min) return fail(400, `${field}: ${o.minMsg ?? `Too small: expected string to have >=${o.min} characters`}`);
  if (o.max !== undefined && s.length > o.max) return fail(400, `${field}: Too big: expected string to have <=${o.max} characters`);
  return s;
}
const nullish = (v: unknown) => v === null || v === undefined;

// ---------- products ----------
type Fields = {
  sku: string; barcode: string | null; name: string; categoryId: number | null; unit: string; allowFraction: boolean; vatCode: "A" | "B" | "E";
  costCents: number; priceRetailCents: number; priceContractorCents: number | null; priceWholesaleCents: number | null; reorderLevelMilli: number;
  itemClassCode: string | null; qtyUnitCode: string | null; packUnitCode: string | null; originCountry: string | null; active: boolean;
};

/** Validate the keys that are present. On create, missing keys take the same defaults as the old server. */
function parseProduct(body: unknown, create: boolean): Partial<Fields> {
  const b = obj(body);
  const out: Partial<Fields> = {};
  const has = (k: string) => b[k] !== undefined;
  const optText = (k: keyof Fields, o: Parameters<typeof text>[2]) => {
    if (has(k)) (out as any)[k] = nullish(b[k]) ? null : text(b[k], k, o);
  };
  const optCents = (k: keyof Fields) => {
    if (has(k)) (out as any)[k] = nullish(b[k]) ? null : int(b[k], k, 0);
  };
  if (has("sku") || create) out.sku = text(b.sku, "sku", { min: 1 });
  optText("barcode", {});
  if (has("name") || create) out.name = text(b.name, "name", { min: 1 });
  if (has("categoryId")) out.categoryId = nullish(b.categoryId) ? null : int(b.categoryId, "categoryId");
  if (has("unit")) out.unit = text(b.unit, "unit", { min: 1 });
  else if (create) out.unit = "pc";
  if (has("allowFraction")) {
    if (typeof b.allowFraction !== "boolean") return fail(400, `allowFraction: Invalid input: expected boolean, received ${typeOf(b.allowFraction)}`);
    out.allowFraction = b.allowFraction;
  } else if (create) out.allowFraction = false;
  if (has("vatCode")) {
    if (!["A", "B", "E"].includes(b.vatCode)) return fail(400, "vatCode: Invalid option: expected one of \"A\"|\"B\"|\"E\"");
    out.vatCode = b.vatCode;
  } else if (create) out.vatCode = "A";
  if (has("costCents")) out.costCents = int(b.costCents, "costCents", 0);
  else if (create) out.costCents = 0;
  if (has("priceRetailCents") || create) out.priceRetailCents = int(b.priceRetailCents, "priceRetailCents", 0);
  optCents("priceContractorCents");
  optCents("priceWholesaleCents");
  if (has("reorderLevelMilli")) out.reorderLevelMilli = int(b.reorderLevelMilli, "reorderLevelMilli", 0);
  else if (create) out.reorderLevelMilli = 0;
  optText("itemClassCode", { trim: true, max: 40 });
  optText("qtyUnitCode", { trim: true, max: 10 });
  optText("packUnitCode", { trim: true, max: 10 });
  optText("originCountry", { trim: true, max: 3 });
  if (!create && has("active")) {
    if (typeof b.active !== "boolean") return fail(400, `active: Invalid input: expected boolean, received ${typeOf(b.active)}`);
    out.active = b.active;
  }
  return out;
}

type ProductDoc = Doc<"products">;

/** The row the screens read: snake_case, with stock per location and the category name. */
function productRow(p: ProductDoc, category: string | null, shop: number, store: number, hideCost: boolean) {
  return {
    id: p.id, sku: p.sku, barcode: p.barcode ?? null, name: p.name, category_id: p.categoryId ?? null, unit: p.unit,
    allow_fraction: p.allowFraction ? 1 : 0, vat_code: p.vatCode, cost_cents: hideCost ? 0 : p.costCents,
    price_retail_cents: p.priceRetailCents, price_contractor_cents: p.priceContractorCents ?? null, price_wholesale_cents: p.priceWholesaleCents ?? null,
    reorder_level_milli: p.reorderLevelMilli, active: p.active ? 1 : 0, created_at: iso(p.createdAt),
    item_class_code: p.itemClassCode ?? null, qty_unit_code: p.qtyUnitCode ?? null, pack_unit_code: p.packUnitCode ?? null, origin_country: p.originCountry ?? null,
    category, stock_shop: shop, stock_store: store,
    units: [...p.units].sort((a, b) => a.factorMilli - b.factorMilli).map((u) => ({
      id: u.id, product_id: p.id, name: u.name, factor_milli: u.factorMilli, price_cents: u.priceCents ?? null, barcode: u.barcode ?? null,
    })),
  };
}

async function productById(ctx: Ctx, id: number) {
  return ctx.db.query("products").withIndex("by_numId", (q) => q.eq("id", id)).unique();
}

/** SKU and barcode must be unique across products. Returns true if another product already uses either. */
async function skuOrBarcodeTaken(ctx: Ctx, sku: string | undefined, barcode: string | null | undefined, exceptId?: number) {
  if (sku !== undefined) {
    const hit = await ctx.db.query("products").withIndex("by_sku", (q) => q.eq("sku", sku)).first();
    if (hit && hit.id !== exceptId) return true;
  }
  if (barcode) {
    const hit = await ctx.db.query("products").withIndex("by_barcode", (q) => q.eq("barcode", barcode)).first();
    if (hit && hit.id !== exceptId) return true;
  }
  return false;
}

/** Hand out `n` consecutive ids with one counter update (used by the bulk import). Returns the first id. */
async function reserveIds(ctx: Ctx, name: string, n: number): Promise<number> {
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
  if (!row) {
    await ctx.db.insert("counters", { name, value: n });
    return 1;
  }
  await ctx.db.patch(row._id, { value: row.value + n });
  return row.value + 1;
}

// ---------- bulk import helpers ----------
/** "1,250.50" or 1250.5 -> number; blank -> undefined; garbage -> NaN */
function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const t = String(v).replace(/[\s,]/g, "");
  if (t === "") return undefined;
  return Number(t);
}
function vatCode(v: unknown): "A" | "B" | "E" | null {
  const t = String(v ?? "").trim().toLowerCase().replace("%", "");
  if (t === "" || t === "16" || t === "a" || t === "standard") return "A";
  if (t === "0" || t === "b" || t === "zero" || t === "zero-rated") return "B";
  if (t === "e" || t === "exempt") return "E";
  return null;
}
interface Checked {
  row: number; error?: string;
  value?: { sku: string; name: string; barcode: string | null; category: string | null; unit: string; vat: "A" | "B" | "E"; cost: number; retail: number; contractor: number | null; wholesale: number | null; reorderMilli: number; shopMilli: number; storeMilli: number };
}
/** Real imports write several records per product, which one Convex transaction can only hold so many of. */
const MAX_IMPORT_ROWS = 1500;
const FRACTIONAL = new Set(["m", "kg", "ltr", "l", "g", "ft", "yd", "sqm"]);
const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));

/** One page of the filtered, sorted product list, plus how many products match in all. */
async function listProducts(ctx: Ctx, req: Req, offset: number, limit: number) {
  const { token, query } = req;
  const user = await authenticate(ctx, token);
  const q = query.q ?? "";
  const categoryId = query.categoryId ? Number(query.categoryId) : undefined;

  let products = await ctx.db.query("products").collect();
  if (!query.all) products = products.filter((p) => p.active);
  if (categoryId !== undefined) products = products.filter((p) => p.categoryId === categoryId);
  if (q.trim()) {
    // every word must appear in the name, code or a barcode (case-insensitive, like SQL LIKE)
    const words = q.trim().toLowerCase().split(/\s+/);
    products = products.filter((p) =>
      words.every((w) =>
        p.name.toLowerCase().includes(w) || p.sku.toLowerCase().includes(w) || (p.barcode ?? "").toLowerCase().includes(w) ||
        p.units.some((u) => (u.barcode ?? "").toLowerCase().includes(w)),
      ),
    );
  }
  // an exact barcode or code hit sorts first, then by name
  const exact = (p: ProductDoc) => (q !== "" && (p.barcode === q || p.sku === q || p.units.some((u) => u.barcode === q)) ? 1 : 0);
  products.sort((a, b) => exact(b) - exact(a) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const cats = new Map((await ctx.db.query("categories").collect()).map((c) => [c.id, c.name]));
  const qty = new Map<number, { shop: number; store: number }>();
  for (const s of await ctx.db.query("stock").collect()) {
    const e = qty.get(s.productId) ?? { shop: 0, store: 0 };
    if (s.locationId === SHOP) e.shop += s.qtyMilli;
    else if (s.locationId === STORE) e.store += s.qtyMilli;
    qty.set(s.productId, e);
  }
  const hide = !can(user, "products.view_cost");
  // totals over every matching product (not just this page), so the summary cards stay right
  const total = products.length;
  let low = 0, atCost = 0, atPrice = 0;
  for (const p of products) {
    const e = qty.get(p.id);
    const on = (e?.shop ?? 0) + (e?.store ?? 0);
    if (p.reorderLevelMilli > 0 && on <= p.reorderLevelMilli) low++;
    atCost += Math.round((p.costCents * Math.max(0, on)) / 1000);
    atPrice += Math.round((p.priceRetailCents * Math.max(0, on)) / 1000);
  }
  products = products.slice(offset, offset + limit);
  const items = products.map((p) => productRow(p, p.categoryId !== undefined ? cats.get(p.categoryId) ?? null : null, qty.get(p.id)?.shop ?? 0, qty.get(p.id)?.store ?? 0, hide));
  return { total, items, summary: { items: total, low, at_price_cents: atPrice, at_cost_cents: hide ? null : atCost } };
}

export const routes: Record<string, Handler> = {
  // ---------------- locations & categories ----------------
  "GET /api/locations": async (ctx, { token }) => {
    await authenticate(ctx, token);
    return (await ctx.db.query("locations").collect()).sort((a, b) => a.id - b.id).map((l) => ({ id: l.id, name: l.name }));
  },

  "GET /api/categories": async (ctx, { token }) => {
    await authenticate(ctx, token);
    return (await ctx.db.query("categories").collect()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((c) => ({ id: c.id, name: c.name }));
  },

  "POST /api/categories": async (ctx, { token, body }) => {
    await requirePerm(ctx, token, "products.manage");
    const name = text(obj(body).name, "name", { min: 1 }).trim();
    // adding a name that exists is harmless: hand back the existing one
    const existing = await ctx.db.query("categories").withIndex("by_name", (q) => q.eq("name", name)).first();
    if (existing) return { id: existing.id };
    const id = await nextId(ctx, "categories");
    await ctx.db.insert("categories", { id, name });
    return { id };
  },

  // ---------------- products ----------------
  "GET /api/products": async (ctx, req) => (await listProducts(ctx, req, 0, Math.min(Math.max(Number(req.query.limit) || 200, 1), 10000))).items,

  // the Inventory list and the export read this one page at a time, so a big catalogue never gets cut off
  "GET /api/products/page": async (ctx, req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return listProducts(ctx, req, offset, limit);
  },

  "POST /api/products": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "products.manage");
    const b = parseProduct(body, true) as Fields;
    if (b.categoryId !== null && b.categoryId !== undefined && !(await ctx.db.query("categories").withIndex("by_numId", (q) => q.eq("id", b.categoryId!)).unique())) return fail(400, "Choose a valid category");
    const barcode = b.barcode || undefined;
    if (await skuOrBarcodeTaken(ctx, b.sku, barcode)) return fail(409, "SKU or barcode already exists");
    const id = await nextId(ctx, "products");
    await ctx.db.insert("products", clean({
      id, sku: b.sku, barcode, name: b.name, categoryId: b.categoryId ?? undefined, unit: b.unit, allowFraction: b.allowFraction, vatCode: b.vatCode,
      costCents: b.costCents, priceRetailCents: b.priceRetailCents, priceContractorCents: b.priceContractorCents ?? undefined,
      priceWholesaleCents: b.priceWholesaleCents ?? undefined, reorderLevelMilli: b.reorderLevelMilli, active: true,
      itemClassCode: b.itemClassCode || undefined, qtyUnitCode: b.qtyUnitCode || undefined, packUnitCode: b.packUnitCode || undefined,
      originCountry: b.originCountry || "KE", units: [], createdAt: Date.now(),
    }));
    await audit(ctx, user.id, "product_create", { sku: b.sku });
    return { id };
  },

  "PATCH /api/products/:id": async (ctx, { token, body, params }) => {
    const user = await requirePerm(ctx, token, "products.manage");
    const id = Number(params.id);
    const raw = obj(body);
    const b = parseProduct(body, false);
    const keys = Object.keys(raw).filter((k) => k in b);
    if (!keys.length) return { ok: true };
    const p = await productById(ctx, id);
    if (!p) return fail(404, "Product not found");
    if (b.categoryId !== undefined && b.categoryId !== null && !(await ctx.db.query("categories").withIndex("by_numId", (q) => q.eq("id", b.categoryId!)).unique())) return fail(400, "Choose a valid category");
    const barcode = b.barcode === undefined ? undefined : b.barcode || null;
    if (await skuOrBarcodeTaken(ctx, b.sku, barcode, id)) return fail(409, "SKU or barcode already exists");
    // undefined removes a field in a patch, which is how null clears an optional value
    const patch: Record<string, unknown> = {};
    const set = (k: string, present: boolean, v: unknown) => { if (present) patch[k] = v === null ? undefined : v; };
    const has = (k: string) => k in b && (b as any)[k] !== undefined;
    set("sku", has("sku"), b.sku);
    set("barcode", barcode !== undefined, barcode);
    set("name", has("name"), b.name);
    set("categoryId", "categoryId" in b, b.categoryId);
    set("unit", has("unit"), b.unit);
    set("allowFraction", has("allowFraction"), b.allowFraction);
    set("vatCode", has("vatCode"), b.vatCode);
    set("costCents", has("costCents"), b.costCents);
    set("priceRetailCents", has("priceRetailCents"), b.priceRetailCents);
    set("priceContractorCents", "priceContractorCents" in b, b.priceContractorCents);
    set("priceWholesaleCents", "priceWholesaleCents" in b, b.priceWholesaleCents);
    set("reorderLevelMilli", has("reorderLevelMilli"), b.reorderLevelMilli);
    set("active", has("active"), b.active);
    set("itemClassCode", "itemClassCode" in b, b.itemClassCode || null);
    set("qtyUnitCode", "qtyUnitCode" in b, b.qtyUnitCode || null);
    set("packUnitCode", "packUnitCode" in b, b.packUnitCode || null);
    set("originCountry", "originCountry" in b, b.originCountry || "KE");
    await ctx.db.patch(p._id, patch);
    await audit(ctx, user.id, "product_update", { id, fields: Object.keys(raw) });
    return { ok: true };
  },

  // ---------------- selling units (a roll, a dozen, a box...) ----------------
  "PUT /api/products/:id/units": async (ctx, { token, body, params }) => {
    const user = await requirePerm(ctx, token, "products.manage");
    const id = Number(params.id);
    const list = obj(body).units;
    if (!Array.isArray(list)) return fail(400, `units: Invalid input: expected array, received ${typeOf(list)}`);
    if (list.length > 10) return fail(400, "units: Too big: expected array to have <=10 items");
    const units = list.map((u, i) => {
      const o = obj(u);
      const name = text(o.name, `units.${i}.name`, { trim: true, min: 1, max: 30, minMsg: "Give each unit a name" });
      if (typeof o.factor !== "number" || !Number.isFinite(o.factor)) return fail(400, `units.${i}.factor: Invalid input: expected number, received ${typeOf(o.factor)}`);
      if (o.factor <= 0) return fail(400, `units.${i}.factor: Say how many it contains`);
      if (o.factor > 100000) return fail(400, `units.${i}.factor: Too big: expected number to be <=100000`);
      const priceCents = nullish(o.priceCents) ? undefined : int(o.priceCents, `units.${i}.priceCents`, 0);
      const barcode = nullish(o.barcode) ? undefined : text(o.barcode, `units.${i}.barcode`, { trim: true, max: 60 }) || undefined;
      return { name, factorMilli: Math.round(o.factor * 1000), priceCents, barcode };
    });
    const p = await productById(ctx, id);
    if (!p) return fail(404, "Product not found");
    const names = units.map((u) => u.name.toLowerCase());
    if (new Set(names).size !== names.length) return fail(400, "Two units have the same name");
    // a unit barcode is unique across every product's units
    const barcodes = units.map((u) => u.barcode).filter((x): x is string => !!x);
    let clash = new Set(barcodes).size !== barcodes.length;
    if (!clash && barcodes.length) {
      for (const other of await ctx.db.query("products").collect()) {
        if (other.id !== id && other.units.some((u) => u.barcode && barcodes.includes(u.barcode))) { clash = true; break; }
      }
    }
    if (clash) return fail(409, "That barcode is already used by another unit");
    const stored = [];
    for (const u of units) stored.push(clean({ id: await nextId(ctx, "productUnits"), name: u.name, factorMilli: u.factorMilli, priceCents: u.priceCents, barcode: u.barcode }));
    await ctx.db.patch(p._id, { units: stored });
    await audit(ctx, user.id, "product_units", { id, units: units.map((u) => u.name) });
    return { ok: true };
  },

  // ---------------- stock ----------------
  "GET /api/stock/movements": async (ctx, { token, query }) => {
    await requirePerm(ctx, token, "stock.manage");
    const productId = query.productId ? Number(query.productId) : undefined;
    const rows = productId !== undefined
      ? await ctx.db.query("stockMovements").withIndex("by_product", (q) => q.eq("productId", productId)).order("desc").take(200)
      : await ctx.db.query("stockMovements").order("desc").take(200);
    rows.sort((a, b) => b.id - a.id);
    const products = new Map<number, string>();
    const users = new Map<number, string>();
    const out = [];
    for (const m of rows) {
      if (!products.has(m.productId)) products.set(m.productId, (await productById(ctx, m.productId))?.name ?? "");
      if (m.userId !== undefined && !users.has(m.userId)) {
        users.set(m.userId, (await ctx.db.query("users").withIndex("by_numId", (q) => q.eq("id", m.userId!)).unique())?.name ?? "");
      }
      out.push({
        id: m.id, product_id: m.productId, location_id: m.locationId, qty_milli: m.qtyMilli, type: m.type,
        ref_type: m.refType ?? null, ref_id: m.refId ?? null, unit_cost_cents: m.unitCostCents ?? null, note: m.note ?? null,
        user_id: m.userId ?? null, created_at: iso(m.createdAt), product: products.get(m.productId) ?? "", user: m.userId !== undefined ? users.get(m.userId) ?? null : null,
      });
    }
    return out;
  },

  // goods received from a supplier (also updates the product's last cost)
  "POST /api/stock/receive": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "stock.manage");
    const o = obj(body);
    const b = {
      productId: int(o.productId, "productId"),
      locationId: int(o.locationId, "locationId"),
      qtyMilli: int(o.qtyMilli, "qtyMilli", 1, "Too small: expected number to be >0"),
      unitCostCents: o.unitCostCents === undefined ? undefined : int(o.unitCostCents, "unitCostCents", 0),
      note: o.note === undefined ? undefined : text(o.note, "note"),
    };
    const p = await productById(ctx, b.productId);
    if (!p) return fail(404, "Product not found");
    if (!(await ctx.db.query("locations").withIndex("by_numId", (q) => q.eq("id", b.locationId)).unique())) return fail(404, "Location not found");
    await moveStock(ctx, clean({ productId: b.productId, locationId: b.locationId, qtyMilli: b.qtyMilli, type: "purchase", unitCostCents: b.unitCostCents, note: b.note, userId: user.id }));
    if (b.unitCostCents !== undefined) await ctx.db.patch(p._id, { costCents: b.unitCostCents });
    await audit(ctx, user.id, "stock_receive", b);
    return { ok: true };
  },

  // set counted quantity (stock take) or apply damage/loss
  "POST /api/stock/adjust": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "stock.manage");
    const o = obj(body);
    const type = o.type === undefined ? "adjustment" : o.type;
    if (!["adjustment", "damage", "opening"].includes(type)) return fail(400, "type: Invalid option: expected one of \"adjustment\"|\"damage\"|\"opening\"");
    const b = {
      productId: int(o.productId, "productId"),
      locationId: int(o.locationId, "locationId"),
      deltaMilli: o.deltaMilli === undefined ? undefined : int(o.deltaMilli, "deltaMilli"),
      countedMilli: o.countedMilli === undefined ? undefined : int(o.countedMilli, "countedMilli", 0),
      type: type as string,
      note: text(o.note, "note", { min: 1, minMsg: "A reason is required" }),
    };
    if (!(await productById(ctx, b.productId))) return fail(404, "Product not found");
    if (!(await ctx.db.query("locations").withIndex("by_numId", (q) => q.eq("id", b.locationId)).unique())) return fail(404, "Location not found");
    const delta = b.countedMilli !== undefined ? b.countedMilli - (await stockOnHand(ctx, b.productId, b.locationId)) : b.deltaMilli ?? 0;
    if (delta === 0) return { ok: true, delta: 0 };
    await moveStock(ctx, { productId: b.productId, locationId: b.locationId, qtyMilli: delta, type: b.type, note: b.note, userId: user.id });
    await audit(ctx, user.id, "stock_adjust", { ...b, delta });
    return { ok: true, delta };
  },

  "POST /api/stock/transfer": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "stock.manage");
    const o = obj(body);
    const b = {
      productId: int(o.productId, "productId"),
      fromLocationId: int(o.fromLocationId, "fromLocationId"),
      toLocationId: int(o.toLocationId, "toLocationId"),
      qtyMilli: int(o.qtyMilli, "qtyMilli", 1, "Too small: expected number to be >0"),
    };
    if (b.fromLocationId === b.toLocationId) return fail(400, "Choose two different locations");
    if (!(await productById(ctx, b.productId))) return fail(404, "Product not found");
    for (const lid of [b.fromLocationId, b.toLocationId]) {
      if (!(await ctx.db.query("locations").withIndex("by_numId", (q) => q.eq("id", lid)).unique())) return fail(404, "Location not found");
    }
    if ((await getSetting(ctx, "allow_negative_stock")) !== "1" && (await stockOnHand(ctx, b.productId, b.fromLocationId)) < b.qtyMilli) return fail(400, "Not enough stock at the source location");
    await moveStock(ctx, { productId: b.productId, locationId: b.fromLocationId, qtyMilli: -b.qtyMilli, type: "transfer_out", userId: user.id });
    await moveStock(ctx, { productId: b.productId, locationId: b.toLocationId, qtyMilli: b.qtyMilli, type: "transfer_in", userId: user.id });
    await audit(ctx, user.id, "stock_transfer", b);
    return { ok: true };
  },

  // ---------------- bulk import ----------------
  "POST /api/products/import": async (ctx, { token, body }) => {
    const user = await requirePerm(ctx, token, "products.manage");
    const o = obj(body);
    if (!Array.isArray(o.rows)) return fail(400, `rows: Invalid input: expected array, received ${typeOf(o.rows)}`);
    if (o.rows.length < 1) return fail(400, "rows: The file has no products");
    if (o.rows.length > MAX_IMPORT_ROWS) return fail(400, `rows: Import at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows at a time`);
    const dryRun = o.dryRun === undefined ? true : o.dryRun;
    if (typeof dryRun !== "boolean") return fail(400, `dryRun: Invalid input: expected boolean, received ${typeOf(dryRun)}`);
    const rows = o.rows as Record<string, unknown>[];

    const existing = await ctx.db.query("products").collect();
    const takenSku = new Set(existing.map((p) => p.sku.toLowerCase()));
    const takenBarcode = new Set(existing.filter((p) => p.barcode).map((p) => p.barcode!));
    const seenSku = new Set<string>();
    const seenBarcode = new Set<string>();

    const checked: Checked[] = rows.map((r, i): Checked => {
      const row = i + 2; // spreadsheet row number (row 1 is the header)
      const bad = (error: string): Checked => ({ row, error });
      const g = (k: string) => (r && typeof r === "object" ? (r as any)[k] : undefined);
      const sku = (str(g("sku")) ?? "").trim();
      const name = (str(g("name")) ?? "").trim();
      if (!name) return bad("Name is missing");
      if (!sku) return bad("Code (SKU) is missing");
      if (takenSku.has(sku.toLowerCase())) return bad(`Code "${sku}" already exists in your catalogue`);
      if (seenSku.has(sku.toLowerCase())) return bad(`Code "${sku}" appears more than once in this file`);
      const barcode = str(g("barcode"))?.trim() || null;
      if (barcode && (takenBarcode.has(barcode) || seenBarcode.has(barcode))) return bad(`Barcode "${barcode}" is already used`);
      const retail = toNumber(g("retail"));
      if (retail === undefined || Number.isNaN(retail) || retail < 0) return bad("Selling price is missing or not a number");
      const cost = toNumber(g("cost")) ?? 0;
      const contractor = toNumber(g("contractor"));
      const wholesale = toNumber(g("wholesale"));
      const reorder = toNumber(g("reorder")) ?? 0;
      const shop = toNumber(g("shopStock")) ?? 0;
      const store = toNumber(g("storeStock")) ?? 0;
      for (const [label, v] of [["Cost", cost], ["Contractor price", contractor], ["Wholesale price", wholesale], ["Reorder level", reorder], ["Shop stock", shop], ["Store stock", store]] as const)
        if (v !== undefined && (Number.isNaN(v) || v < 0)) return bad(`${label} is not a valid number`);
      const vat = vatCode(g("vat"));
      if (!vat) return bad(`VAT "${g("vat")}" is not recognised. Use 16, 0 or Exempt`);
      seenSku.add(sku.toLowerCase());
      if (barcode) seenBarcode.add(barcode);
      return {
        row,
        value: {
          sku, name, barcode, category: str(g("category"))?.trim() || null, unit: (str(g("unit"))?.trim() || "pc").toLowerCase(), vat,
          cost: Math.round(cost * 100), retail: Math.round(retail * 100),
          contractor: contractor === undefined ? null : Math.round(contractor * 100),
          wholesale: wholesale === undefined ? null : Math.round(wholesale * 100),
          reorderMilli: Math.round(reorder * 1000), shopMilli: Math.round(shop * 1000), storeMilli: Math.round(store * 1000),
        },
      };
    });

    const valid = checked.filter((c) => c.value);
    const errors = checked.filter((c) => c.error).map((c) => ({ row: c.row, message: c.error! }));
    const hasStock = valid.some((c) => c.value!.shopMilli > 0 || c.value!.storeMilli > 0);
    if (hasStock && !can(user, "stock.manage")) return fail(403, "Your role cannot add opening stock. Remove the stock columns or ask a manager to import.");

    const preview = { total: rows.length, valid: valid.length, invalid: errors.length, errors: errors.slice(0, 200), sample: valid.slice(0, 5).map((c) => c.value!.name) };
    if (dryRun) return { dryRun: true, ...preview };

    // categories: reuse by name (case-insensitive), create the rest
    const cats = new Map<string, number>();
    for (const c of await ctx.db.query("categories").collect()) cats.set(c.name.toLowerCase(), c.id);
    // ids for every new product and every opening-stock movement are reserved once, then inserted directly
    const withStock = valid.reduce((n, c) => n + (c.value!.shopMilli > 0 ? 1 : 0) + (c.value!.storeMilli > 0 ? 1 : 0), 0);
    let nextProduct = valid.length ? await reserveIds(ctx, "products", valid.length) : 0;
    let nextMove = withStock ? await reserveIds(ctx, "stockMovements", withStock) : 0;
    const now = Date.now();
    const opening = async (productId: number, locationId: number, qtyMilli: number, cost: number) => {
      await ctx.db.insert("stockMovements", { id: nextMove++, productId, locationId, qtyMilli, type: "opening", unitCostCents: cost, note: "Imported opening stock", userId: user.id, createdAt: now });
      await ctx.db.insert("stock", { productId, locationId, qtyMilli });
    };
    for (const { value: v } of valid) {
      let categoryId: number | undefined;
      if (v!.category) {
        categoryId = cats.get(v!.category.toLowerCase());
        if (categoryId === undefined) {
          categoryId = await nextId(ctx, "categories");
          await ctx.db.insert("categories", { id: categoryId, name: v!.category });
          cats.set(v!.category.toLowerCase(), categoryId);
        }
      }
      const pid = nextProduct++;
      // anything sold by length/weight/volume may be sold in fractions
      await ctx.db.insert("products", clean({
        id: pid, sku: v!.sku, barcode: v!.barcode ?? undefined, name: v!.name, categoryId, unit: v!.unit, allowFraction: FRACTIONAL.has(v!.unit), vatCode: v!.vat,
        costCents: v!.cost, priceRetailCents: v!.retail, priceContractorCents: v!.contractor ?? undefined, priceWholesaleCents: v!.wholesale ?? undefined,
        reorderLevelMilli: v!.reorderMilli, active: true, originCountry: "KE", units: [], createdAt: now,
      }));
      if (v!.shopMilli > 0) await opening(pid, SHOP, v!.shopMilli, v!.cost);
      if (v!.storeMilli > 0) await opening(pid, STORE, v!.storeMilli, v!.cost);
    }
    await audit(ctx, user.id, "products_import", { imported: valid.length, skipped: errors.length });
    return { dryRun: false, imported: valid.length, ...preview };
  },
};
