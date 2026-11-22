import { useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { fmtQty, toCents, toMilli } from "../../../../shared/money";
import { get, patch, post, put, useAuth, type Product } from "../../lib/api";
import { Button, ErrorLine, Field, Input, Modal, NumInput, inputCls, Select } from "../../lib/ui";

// The add/edit product form and the receive / count / move stock form, shared by the Inventory list and the product page.
interface Cat { id: number; name: string }
const UNITS = ["pc", "kg", "m", "bag", "box", "ltr", "roll", "pkt", "set", "pair", "sheet", "tin"];

export function ProductForm({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const canStock = can("stock.manage");
  const [cats, setCats] = useState<Cat[]>([]);
  const [f, setF] = useState({
    name: product?.name ?? "", sku: product?.sku ?? "", barcode: product?.barcode ?? "",
    categoryId: product?.category_id ?? null as number | null, newCat: "", addingCat: false,
    unit: product?.unit ?? "pc", allowFraction: !!product?.allow_fraction, vatCode: product?.vat_code ?? "A",
    cost: product ? product.cost_cents / 100 : (null as number | null),
    retail: product ? product.price_retail_cents / 100 : (null as number | null),
    contractor: product?.price_contractor_cents != null ? product.price_contractor_cents / 100 : (null as number | null),
    wholesale: product?.price_wholesale_cents != null ? product.price_wholesale_cents / 100 : (null as number | null),
    reorder: product ? product.reorder_level_milli / 1000 : (null as number | null),
    openShop: null as number | null, openStore: null as number | null,
    active: product ? !!product.active : true,
    itemClass: product?.item_class_code ?? "", qtyUnit: product?.qty_unit_code ?? "", packUnit: product?.pack_unit_code ?? "", origin: product?.origin_country ?? "KE",
  });
  // other ways to sell the same product: a roll, a dozen, a box...
  const [units, setUnits] = useState<{ name: string; factor: number | null; price: number | null; barcode: string }[]>(
    (product?.units ?? []).map((u) => ({ name: u.name, factor: u.factor_milli / 1000, price: u.price_cents == null ? null : u.price_cents / 100, barcode: u.barcode ?? "" })),
  );
  const setUnit = (i: number, patchIt: Partial<(typeof units)[number]>) => setUnits((x) => x.map((u, k) => (k === i ? { ...u, ...patchIt } : u)));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<Cat[]>("/api/categories").then(setCats); }, []);
  const s = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  // profit on one unit, before VAT, so the owner sees what the price really earns
  const rate = f.vatCode === "A" ? 0.16 : 0;
  const net = f.retail != null && f.retail > 0 ? f.retail / (1 + rate) : null;
  const profit = net != null && f.cost != null && f.cost > 0 ? net - f.cost : null;
  const margin = profit != null && net ? (profit / net) * 100 : null;

  const save = async () => {
    if (busy) return;
    if (!f.name.trim()) return setErr("Enter the product name");
    if (!f.sku.trim()) return setErr("Enter a code for the product");
    if (f.retail == null || f.retail <= 0) return setErr("Enter the retail price");
    if (f.addingCat && !f.newCat.trim()) return setErr("Type the new category name, or pick an existing one");
    const filled = units.filter((u) => u.name.trim());
    if (filled.some((u) => !u.factor || u.factor <= 0)) return setErr("Say how many " + f.unit + " each pack contains");
    setBusy(true);
    try {
      let categoryId = f.categoryId;
      if (f.addingCat && f.newCat.trim()) {
        // an existing name returns the existing category, so this is safe to repeat
        categoryId = (await post<{ id: number }>("/api/categories", { name: f.newCat.trim() })).id;
      }
      const body = {
        name: f.name.trim(), sku: f.sku.trim(), barcode: f.barcode.trim() || null, categoryId, unit: f.unit,
        allowFraction: f.allowFraction, vatCode: f.vatCode, costCents: toCents(f.cost ?? 0), priceRetailCents: toCents(f.retail),
        priceContractorCents: f.contractor == null ? null : toCents(f.contractor),
        priceWholesaleCents: f.wholesale == null ? null : toCents(f.wholesale),
        reorderLevelMilli: toMilli(f.reorder ?? 0),
        itemClassCode: f.itemClass.trim() || null, qtyUnitCode: f.qtyUnit.trim() || null, packUnitCode: f.packUnit.trim() || null, originCountry: f.origin.trim() || "KE",
      };
      let pid = product?.id;
      if (product) await patch(`/api/products/${product.id}`, { ...body, active: f.active });
      else pid = (await post<{ id: number }>("/api/products", body)).id;
      await put(`/api/products/${pid}/units`, { units: filled.map((u) => ({ name: u.name.trim(), factor: u.factor!, priceCents: u.price == null ? null : toCents(u.price), barcode: u.barcode.trim() || null })) });
      // opening stock for a new product, counted in at the cost price
      if (!product && canStock) {
        for (const [loc, qty] of [[1, f.openShop], [2, f.openStore]] as [number, number | null][]) {
          if (qty != null && qty > 0) await post("/api/stock/receive", { productId: pid, locationId: loc, qtyMilli: toMilli(qty), unitCostCents: f.cost == null ? undefined : toCents(f.cost), note: "Opening stock" });
        }
      }
      onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal wide title={product ? "Edit product" : "Add product"} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <Section title="Basics">
          <div className="sm:col-span-2"><Field label="Product name"><Input value={f.name} onChange={(e) => s("name", e.target.value)} autoFocus placeholder="e.g. Nails 3 inch" /></Field></div>
          <Field label="Code (SKU)"><Input value={f.sku} onChange={(e) => s("sku", e.target.value)} placeholder="e.g. NL-3" /></Field>
          <Field label="Barcode" hint="Optional. Scan it here to fill it in."><Input value={f.barcode} onChange={(e) => s("barcode", e.target.value)} /></Field>
          <Field label="Category">
            <Select className={inputCls} value={f.addingCat ? "new" : f.categoryId ?? ""} onChange={(e) => {
              const v = e.target.value;
              if (v === "new") setF((x) => ({ ...x, addingCat: true }));
              else setF((x) => ({ ...x, addingCat: false, categoryId: v ? Number(v) : null }));
            }}>
              <option value="">No category</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="new">Add a new category</option>
            </Select>
          </Field>
          {f.addingCat && <Field label="New category name"><Input value={f.newCat} onChange={(e) => s("newCat", e.target.value)} autoFocus /></Field>}
        </Section>

        <Section title="How it is sold">
          <Field label="Sold by">
            <Select className={inputCls} value={f.unit} onChange={(e) => s("unit", e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>
          </Field>
          <Field label="VAT">
            <Select className={inputCls} value={f.vatCode} onChange={(e) => s("vatCode", e.target.value as "A" | "B" | "E")}>
              <option value="A">16% standard</option><option value="B">0% zero-rated</option><option value="E">Exempt</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={f.allowFraction} onChange={(e) => s("allowFraction", e.target.checked)} /> Can be sold in fractions, for example 2.5 m or 0.5 kg</label>
          <div className="sm:col-span-2">
            <div className="text-sm font-medium">Also sold as</div>
            <p className="text-sm text-slate-500 mb-2">For packs such as a roll, a dozen or a box. Stock is always counted in {f.unit}: selling one roll of 50 takes 50 {f.unit} out of stock.</p>
            {units.map((u, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-[1fr_6rem_1fr_1fr_auto] gap-2 mb-2 items-end">
                <Field label={i === 0 ? "Pack name" : ""}><Input value={u.name} onChange={(e) => setUnit(i, { name: e.target.value })} placeholder="e.g. Roll" /></Field>
                <Field label={i === 0 ? `Holds (${f.unit})` : ""}><NumInput value={u.factor} onChange={(n) => setUnit(i, { factor: n })} /></Field>
                <Field label={i === 0 ? "Price" : ""}><NumInput value={u.price} onChange={(n) => setUnit(i, { price: n })} placeholder="Auto" /></Field>
                <Field label={i === 0 ? "Barcode" : ""}><Input value={u.barcode} onChange={(e) => setUnit(i, { barcode: e.target.value })} /></Field>
                <button type="button" onClick={() => setUnits((x) => x.filter((_, k) => k !== i))} aria-label="Remove this pack" className="h-11 w-9 text-slate-400 hover:text-danger flex items-center justify-center"><X className="size-5" /></button>
              </div>
            ))}
            <Button type="button" onClick={() => setUnits((x) => [...x, { name: "", factor: null, price: null, barcode: "" }])} className="flex items-center gap-1.5"><Plus className="size-4" />Add a pack size</Button>
          </div>
        </Section>

        <Section title="Prices (KES)">
          <Field label="Cost price" hint="What you pay for one unit"><NumInput value={f.cost} onChange={(n) => s("cost", n)} /></Field>
          <Field label="Retail price" hint="What the customer pays, VAT included"><NumInput value={f.retail} onChange={(n) => s("retail", n)} /></Field>
          <div className="sm:col-span-2 -mt-1 text-sm" aria-live="polite">
            {profit != null && margin != null ? (
              <span className={profit < 0 ? "text-danger font-semibold" : "text-slate-600"}>
                {profit < 0 ? "Selling below cost: " : "Profit: "}KES {Math.abs(profit).toLocaleString("en-KE", { maximumFractionDigits: 2 })} per {f.unit} ({margin.toFixed(0)}% margin{rate ? ", VAT taken out" : ""})
              </span>
            ) : <span className="text-slate-400">Enter the cost and retail price to see the profit.</span>}
          </div>
          <Field label="Contractor price" hint="Blank means the retail price"><NumInput value={f.contractor} onChange={(n) => s("contractor", n)} /></Field>
          <Field label="Wholesale price" hint="Blank means the contractor or retail price"><NumInput value={f.wholesale} onChange={(n) => s("wholesale", n)} /></Field>
        </Section>

        <Section title="Stock">
          <Field label="Reorder level" hint={`Marked low when stock falls to this many ${f.unit}`}><NumInput value={f.reorder} onChange={(n) => s("reorder", n)} /></Field>
          <div className="hidden sm:block" />
          {!product && canStock && (
            <>
              <Field label="Opening stock in the shop" hint="What is on the shelf today"><NumInput value={f.openShop} onChange={(n) => s("openShop", n)} /></Field>
              <Field label="Opening stock in the store"><NumInput value={f.openStore} onChange={(n) => s("openStore", n)} /></Field>
            </>
          )}
          {product && <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={f.active} onChange={(e) => s("active", e.target.checked)} /> Active (can be sold)</label>}
        </Section>

        <details className="border-t border-slate-200 pt-3">
          <summary className="cursor-pointer font-semibold">Tax authority details (for eTIMS)</summary>
          <div className="grid sm:grid-cols-4 gap-3 mt-3">
            <Field label="Item class code"><Input value={f.itemClass} onChange={(e) => s("itemClass", e.target.value)} /></Field>
            <Field label="Quantity unit code"><Input value={f.qtyUnit} onChange={(e) => s("qtyUnit", e.target.value.toUpperCase())} /></Field>
            <Field label="Packaging unit code"><Input value={f.packUnit} onChange={(e) => s("packUnit", e.target.value.toUpperCase())} /></Field>
            <Field label="Country of origin"><Input value={f.origin} onChange={(e) => s("origin", e.target.value.toUpperCase())} /></Field>
          </div>
        </details>

        <ErrorLine msg={err} />
        <div className="sticky bottom-0 -mx-6 -mb-6 mt-4 flex justify-end gap-2 border-t border-slate-200 bg-white px-6 py-3 rounded-b-xl">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving" : product ? "Save changes" : "Add product"}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** A titled block of fields inside the product form. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pb-4 mb-4 border-b border-slate-200">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">{title}</h3>
      <div className="grid sm:grid-cols-2 gap-3">{children}</div>
    </section>
  );
}

export function StockForm({ p, mode, onClose, onSaved }: { p: Product; mode: "receive" | "count" | "transfer"; onClose: () => void; onSaved: () => void }) {
  const [loc, setLoc] = useState(1);
  const [qty, setQty] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(p.cost_cents / 100);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const onHand = loc === 1 ? p.stock_shop : p.stock_store;

  const save = async () => {
    if (qty == null || (mode !== "count" && qty <= 0)) return setErr("Enter a quantity");
    try {
      if (mode === "receive") await post("/api/stock/receive", { productId: p.id, locationId: loc, qtyMilli: toMilli(qty), unitCostCents: cost == null ? undefined : toCents(cost), note: note || undefined });
      else if (mode === "count") { if (!note.trim()) return setErr("Give a reason for the change (e.g. stock take)"); await post("/api/stock/adjust", { productId: p.id, locationId: loc, countedMilli: toMilli(qty), note }); }
      else await post("/api/stock/transfer", { productId: p.id, fromLocationId: loc, toLocationId: loc === 1 ? 2 : 1, qtyMilli: toMilli(qty) });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };

  const title = { receive: "Receive stock", count: "Stock count", transfer: "Move stock" }[mode];
  return (
    <Modal title={`${title}: ${p.name}`} onClose={onClose}>
      <div className="space-y-3">
        <Field label={mode === "transfer" ? "From" : "Location"}>
          <Select className={inputCls} value={loc} onChange={(e) => setLoc(Number(e.target.value))}><option value={1}>Shop</option><option value={2}>Store</option></Select>
        </Field>
        {mode !== "receive" && <p className="text-sm text-gray-600">System shows {fmtQty(onHand)} {p.unit} here.</p>}
        <Field label={mode === "count" ? `Counted quantity (${p.unit})` : mode === "transfer" ? `Quantity to move to ${loc === 1 ? "Store" : "Shop"}` : `Quantity received (${p.unit})`}>
          <NumInput value={qty} onChange={setQty} autoFocus />
        </Field>
        {mode === "receive" && <Field label="Buying price per unit (KES)" hint="Updates the product's cost price"><NumInput value={cost} onChange={setCost} /></Field>}
        {mode !== "transfer" && <Field label={mode === "count" ? "Reason" : "Supplier / invoice no. (optional)"}><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>}
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}
