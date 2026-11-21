import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, tx } from "../db.ts";
import { HttpError, can, requirePerm } from "../auth.ts";
import { parse } from "../util.ts";

const num = z.union([z.number(), z.string()]).nullish();

const rowSchema = z.object({
  sku: z.string().default(""),
  name: z.string().default(""),
  barcode: z.string().nullish(),
  category: z.string().nullish(),
  unit: z.string().nullish(),
  vat: z.union([z.string(), z.number()]).nullish(),
  cost: num,
  retail: num,
  contractor: num,
  wholesale: num,
  reorder: num,
  shopStock: num,
  storeStock: num,
});

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

interface Checked { row: number; error?: string; value?: {
  sku: string; name: string; barcode: string | null; category: string | null; unit: string; vat: "A" | "B" | "E";
  cost: number; retail: number; contractor: number | null; wholesale: number | null; reorderMilli: number; shopMilli: number; storeMilli: number;
} }

export function importRoutes(app: FastifyInstance) {
  app.post("/api/products/import", { preHandler: requirePerm("products.manage") }, async (req) => {
    const body = parse(z.object({ rows: z.array(rowSchema).min(1, "The file has no products").max(5000, "Import at most 5,000 rows at a time"), dryRun: z.boolean().default(true) }), req.body);
    const user = req.user!;

    const seenSku = new Set<string>();
    const seenBarcode = new Set<string>();
    const takenSku = new Set((db.prepare("SELECT lower(sku) AS s FROM products").all() as { s: string }[]).map((r) => r.s));
    const takenBarcode = new Set((db.prepare("SELECT barcode AS b FROM products WHERE barcode IS NOT NULL").all() as { b: string }[]).map((r) => r.b));

    const checked: Checked[] = body.rows.map((r, i): Checked => {
      const row = i + 2; // spreadsheet row number (row 1 is the header)
      const fail = (error: string): Checked => ({ row, error });
      const sku = r.sku.trim();
      const name = r.name.trim();
      if (!name) return fail("Name is missing");
      if (!sku) return fail("Code (SKU) is missing");
      if (takenSku.has(sku.toLowerCase())) return fail(`Code "${sku}" already exists in your catalogue`);
      if (seenSku.has(sku.toLowerCase())) return fail(`Code "${sku}" appears more than once in this file`);
      const barcode = r.barcode?.toString().trim() || null;
      if (barcode && (takenBarcode.has(barcode) || seenBarcode.has(barcode))) return fail(`Barcode "${barcode}" is already used`);
      const retail = toNumber(r.retail);
      if (retail === undefined || Number.isNaN(retail) || retail < 0) return fail("Selling price is missing or not a number");
      const cost = toNumber(r.cost) ?? 0;
      const contractor = toNumber(r.contractor);
      const wholesale = toNumber(r.wholesale);
      const reorder = toNumber(r.reorder) ?? 0;
      const shop = toNumber(r.shopStock) ?? 0;
      const store = toNumber(r.storeStock) ?? 0;
      for (const [label, v] of [["Cost", cost], ["Contractor price", contractor], ["Wholesale price", wholesale], ["Reorder level", reorder], ["Shop stock", shop], ["Store stock", store]] as const)
        if (v !== undefined && (Number.isNaN(v) || v < 0)) return fail(`${label} is not a valid number`);
      const vat = vatCode(r.vat);
      if (!vat) return fail(`VAT "${r.vat}" is not recognised. Use 16, 0 or Exempt`);
      seenSku.add(sku.toLowerCase());
      if (barcode) seenBarcode.add(barcode);
      return {
        row,
        value: {
          sku, name, barcode, category: r.category?.toString().trim() || null, unit: (r.unit?.toString().trim() || "pc").toLowerCase(), vat,
          cost: Math.round(cost * 100), retail: Math.round(retail * 100),
          contractor: contractor === undefined ? null : Math.round(contractor * 100),
          wholesale: wholesale === undefined ? null : Math.round(wholesale * 100),
          reorderMilli: Math.round((reorder ?? 0) * 1000), shopMilli: Math.round((shop ?? 0) * 1000), storeMilli: Math.round((store ?? 0) * 1000),
        },
      };
    });

    const valid = checked.filter((c) => c.value);
    const errors = checked.filter((c) => c.error).map((c) => ({ row: c.row, message: c.error! }));
    const hasStock = valid.some((c) => c.value!.shopMilli > 0 || c.value!.storeMilli > 0);
    if (hasStock && !can(user, "stock.manage")) throw new HttpError(403, "Your role cannot add opening stock. Remove the stock columns or ask a manager to import.");

    const preview = { total: body.rows.length, valid: valid.length, invalid: errors.length, errors: errors.slice(0, 200), sample: valid.slice(0, 5).map((c) => c.value!.name) };
    if (body.dryRun) return { dryRun: true, ...preview };

    tx(() => {
      const cats = new Map<string, number>();
      for (const c of db.prepare("SELECT id, name FROM categories").all() as { id: number; name: string }[]) cats.set(c.name.toLowerCase(), c.id);
      const insProduct = db.prepare(
        `INSERT INTO products (sku,barcode,name,category_id,unit,allow_fraction,vat_code,cost_cents,price_retail_cents,price_contractor_cents,price_wholesale_cents,reorder_level_milli)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const insMove = db.prepare(
        "INSERT INTO stock_movements (product_id,location_id,qty_milli,type,unit_cost_cents,note,user_id) VALUES (?,?,?,'opening',?,'Imported opening stock',?)",
      );
      const FRACTIONAL = new Set(["m", "kg", "ltr", "l", "g", "ft", "yd", "sqm"]);
      for (const { value: v } of valid) {
        let catId: number | null = null;
        if (v!.category) {
          catId = cats.get(v!.category.toLowerCase()) ?? null;
          if (catId === null) {
            catId = Number(db.prepare("INSERT INTO categories (name) VALUES (?)").run(v!.category).lastInsertRowid);
            cats.set(v!.category.toLowerCase(), catId);
          }
        }
        // anything sold by length/weight/volume may be sold in fractions
        const pid = Number(
          insProduct.run(v!.sku, v!.barcode, v!.name, catId, v!.unit, FRACTIONAL.has(v!.unit) ? 1 : 0, v!.vat, v!.cost, v!.retail, v!.contractor, v!.wholesale, v!.reorderMilli).lastInsertRowid,
        );
        if (v!.shopMilli > 0) insMove.run(pid, 1, v!.shopMilli, v!.cost, user.id);
        if (v!.storeMilli > 0) insMove.run(pid, 2, v!.storeMilli, v!.cost, user.id);
      }
      audit(user.id, "products_import", { imported: valid.length, skipped: errors.length });
    });
    return { dryRun: false, imported: valid.length, ...preview };
  });
}
