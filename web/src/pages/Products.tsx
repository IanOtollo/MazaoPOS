import { useCallback, useEffect, useState } from "react";
import { fmtKES, fmtQty, toCents, toMilli } from "../../../shared/money";
import { get, patch, post, useAuth, type Product } from "../lib/api";
import { ArrowLeftRight, ClipboardCheck, Package, PackagePlus, Pencil, Plus, SearchX } from "lucide-react";
import { Button, EmptyState, ErrorLine, Field, IconButton, Input, Modal, NumInput, PageHead, inputCls, td, th } from "../lib/ui";
import { useToast } from "../lib/toast";
import { useLive } from "../lib/live";
import { ImportProducts } from "./ImportProducts";

interface Cat { id: number; name: string }
const UNITS = ["pc", "kg", "m", "bag", "box", "ltr", "roll", "pkt", "set", "pair", "sheet", "tin"];

export default function Products() {
  const { can } = useAuth();
  const canManage = can("products.manage");
  const canStock = can("stock.manage");
  const canCost = can("products.view_cost");
  const toast = useToast();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Product[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState<Product | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [stock, setStock] = useState<{ p: Product; mode: "receive" | "count" | "transfer" } | null>(null);

  const load = useCallback(
    () => get<Product[]>(`/api/products?q=${encodeURIComponent(q)}${showInactive ? "&all=1" : ""}`).then(setRows),
    [q, showInactive],
  );
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  useLive(["products", "stock"], load);

  return (
    <div className="p-4">
      <PageHead title="Inventory">
        <Input placeholder="Search name, code, barcode" value={q} onChange={(e) => setQ(e.target.value)} className="!w-64" />
        {canManage && <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>}
        {canManage && <Button onClick={() => setImporting(true)}>Import</Button>}
        {canManage && <Button variant="primary" onClick={() => setEdit("new")}>Add product</Button>}
      </PageHead>
      {!q && !showInactive && rows.length > 0 && (() => {
        const low = rows.filter((p) => p.reorder_level_milli > 0 && p.stock_shop + p.stock_store <= p.reorder_level_milli).length;
        const atCost = rows.reduce((a, p) => a + Math.round((p.cost_cents * Math.max(0, p.stock_shop + p.stock_store)) / 1000), 0);
        const atPrice = rows.reduce((a, p) => a + Math.round((p.price_retail_cents * Math.max(0, p.stock_shop + p.stock_store)) / 1000), 0);
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="Items" value={String(rows.length)} />
            <Stat label="Stock value at selling price" value={`KES ${Math.round(atPrice / 100).toLocaleString("en-KE")}`} />
            {canCost && <Stat label="Stock value at cost" value={`KES ${Math.round(atCost / 100).toLocaleString("en-KE")}`} />}
            <Stat label="Low on stock" value={String(low)} warn={low > 0} />
          </div>
        );
      })()}
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Name</th><th className={`${th} hidden md:table-cell`}>Code</th><th className={`${th} hidden sm:table-cell`}>Unit</th>
              <th className={`${th} text-right`}>Retail</th>{canCost && <th className={`${th} text-right hidden md:table-cell`}>Cost</th>}
              <th className={`${th} text-right`}>Shop</th><th className={`${th} text-right hidden md:table-cell`}>Store</th>
              {(canManage || canStock) && <th className={th}></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const low = p.reorder_level_milli > 0 && p.stock_shop + p.stock_store <= p.reorder_level_milli;
              return (
                <tr key={p.id} className={p.active ? "" : "text-gray-400"}>
                  <td className={td}>{p.name}{p.category && <span className="text-xs text-gray-500"> - {p.category}</span>}</td>
                  <td className={`${td} hidden md:table-cell`}>{p.sku}</td><td className={`${td} hidden sm:table-cell`}>{p.unit}</td>
                  <td className={`${td} num`}>{fmtKES(p.price_retail_cents)}</td>
                  {canCost && <td className={`${td} num hidden md:table-cell`}>{fmtKES(p.cost_cents)}</td>}
                  <td className={`${td} num ${low ? "text-danger font-semibold" : ""}`}>{fmtQty(p.stock_shop)}</td>
                  <td className={`${td} num hidden md:table-cell`}>{fmtQty(p.stock_store)}</td>
                  {(canManage || canStock) && (
                    <td className={`${td} whitespace-nowrap`}>
                      <div className="flex justify-end gap-1.5">
                        {canStock && <IconButton label="Receive stock" onClick={() => setStock({ p, mode: "receive" })}><PackagePlus className="size-[18px]" /></IconButton>}
                        {canStock && <IconButton label="Count stock" onClick={() => setStock({ p, mode: "count" })}><ClipboardCheck className="size-[18px]" /></IconButton>}
                        {canStock && <IconButton label="Move between shop and store" onClick={() => setStock({ p, mode: "transfer" })}><ArrowLeftRight className="size-[18px]" /></IconButton>}
                        {canManage && <IconButton label="Edit product" onClick={() => setEdit(p)}><Pencil className="size-[18px]" /></IconButton>}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={8}>
                {q ? (
                  <EmptyState icon={<SearchX className="size-8" />} title="No products match your search" hint={`Nothing found for "${q}". Check the spelling or try the item code.`} />
                ) : (
                  <EmptyState icon={<Package className="size-8" />} title="Your catalogue is empty" hint="Add your first product to start selling. You can set different prices for retail, contractor and wholesale customers.">
                    {canManage && <Button variant="primary" onClick={() => setEdit("new")} className="flex items-center gap-2"><Plus className="size-4" />Add your first product</Button>}
                  </EmptyState>
                )}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      {importing && <ImportProducts onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); toast({ msg: `${n} product${n === 1 ? "" : "s"} imported` }); load(); }} />}
      {edit && <ProductForm product={edit === "new" ? null : edit} onClose={() => setEdit(null)}
        onSaved={() => { toast({ msg: edit === "new" ? "Product added" : "Product updated" }); setEdit(null); load(); }} />}
      {stock && <StockForm {...stock} onClose={() => setStock(null)}
        onSaved={() => { toast({ msg: { receive: "Stock received", count: "Stock count saved", transfer: "Stock moved" }[stock.mode] }); setStock(null); load(); }} />}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="bg-white border border-line rounded-xl shadow-card p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={`text-2xl font-bold tracking-tight mt-1 ${warn ? "text-amber-700" : ""}`}>{value}</div>
    </div>
  );
}

function ProductForm({ product, onClose, onSaved }: { product: Product | null; onClose: () => void; onSaved: () => void }) {
  const [cats, setCats] = useState<Cat[]>([]);
  const [f, setF] = useState({
    name: product?.name ?? "", sku: product?.sku ?? "", barcode: product?.barcode ?? "",
    categoryId: product?.category_id ?? null as number | null, newCat: "",
    unit: product?.unit ?? "pc", allowFraction: !!product?.allow_fraction, vatCode: product?.vat_code ?? "A",
    cost: product ? product.cost_cents / 100 : (null as number | null),
    retail: product ? product.price_retail_cents / 100 : (null as number | null),
    contractor: product?.price_contractor_cents != null ? product.price_contractor_cents / 100 : (null as number | null),
    wholesale: product?.price_wholesale_cents != null ? product.price_wholesale_cents / 100 : (null as number | null),
    reorder: product ? product.reorder_level_milli / 1000 : (null as number | null),
    active: product ? !!product.active : true,
  });
  const [err, setErr] = useState("");
  useEffect(() => { get<Cat[]>("/api/categories").then(setCats); }, []);
  const s = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    if (!f.name.trim() || !f.sku.trim()) return setErr("Name and code are required");
    if (f.retail == null) return setErr("Retail price is required");
    try {
      let categoryId = f.categoryId;
      if (f.newCat.trim()) {
        // INSERT OR IGNORE returns no reliable id for an existing name, so look it up by name
        await post("/api/categories", { name: f.newCat });
        categoryId = (await get<Cat[]>("/api/categories")).find((c) => c.name === f.newCat.trim())?.id ?? null;
      }
      const body = {
        name: f.name.trim(), sku: f.sku.trim(), barcode: f.barcode.trim() || null, categoryId, unit: f.unit,
        allowFraction: f.allowFraction, vatCode: f.vatCode, costCents: toCents(f.cost ?? 0), priceRetailCents: toCents(f.retail),
        priceContractorCents: f.contractor == null ? null : toCents(f.contractor),
        priceWholesaleCents: f.wholesale == null ? null : toCents(f.wholesale),
        reorderLevelMilli: toMilli(f.reorder ?? 0),
      };
      if (product) await patch(`/api/products/${product.id}`, { ...body, active: f.active });
      else await post("/api/products", body);
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Modal wide title={product ? "Edit product" : "Add product"} onClose={onClose}>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2"><Field label="Name"><Input value={f.name} onChange={(e) => s("name", e.target.value)} autoFocus /></Field></div>
        <Field label="Code (SKU)"><Input value={f.sku} onChange={(e) => s("sku", e.target.value)} /></Field>
        <Field label="Barcode (optional)"><Input value={f.barcode} onChange={(e) => s("barcode", e.target.value)} /></Field>
        <Field label="Category">
          <select className={inputCls} value={f.categoryId ?? ""} onChange={(e) => s("categoryId", e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="...or new category"><Input value={f.newCat} onChange={(e) => s("newCat", e.target.value)} /></Field>
        <Field label="Sold by (unit)">
          <select className={inputCls} value={f.unit} onChange={(e) => s("unit", e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
        </Field>
        <Field label="VAT">
          <select className={inputCls} value={f.vatCode} onChange={(e) => s("vatCode", e.target.value as "A" | "B" | "E")}>
            <option value="A">16% standard</option><option value="B">0% zero-rated</option><option value="E">Exempt</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={f.allowFraction} onChange={(e) => s("allowFraction", e.target.checked)} /> Can be sold in fractions (e.g. 2.5 m, 0.5 kg)</label>
        <Field label="Cost price (KES)"><NumInput value={f.cost} onChange={(n) => s("cost", n)} /></Field>
        <Field label="Retail price (KES, VAT inclusive)"><NumInput value={f.retail} onChange={(n) => s("retail", n)} /></Field>
        <Field label="Contractor price" hint="Leave blank to use retail"><NumInput value={f.contractor} onChange={(n) => s("contractor", n)} /></Field>
        <Field label="Wholesale price" hint="Leave blank to use contractor/retail"><NumInput value={f.wholesale} onChange={(n) => s("wholesale", n)} /></Field>
        <Field label="Reorder level" hint="Flag as low when stock is at or below this"><NumInput value={f.reorder} onChange={(n) => s("reorder", n)} /></Field>
        {product && <label className="flex items-center gap-2 self-end"><input type="checkbox" checked={f.active} onChange={(e) => s("active", e.target.checked)} /> Active (sellable)</label>}
      </div>
      <div className="mt-3"><ErrorLine msg={err} /></div>
      <div className="flex justify-end gap-2 mt-3"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
    </Modal>
  );
}

function StockForm({ p, mode, onClose, onSaved }: { p: Product; mode: "receive" | "count" | "transfer"; onClose: () => void; onSaved: () => void }) {
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
          <select className={inputCls} value={loc} onChange={(e) => setLoc(Number(e.target.value))}><option value={1}>Shop</option><option value={2}>Store</option></select>
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
