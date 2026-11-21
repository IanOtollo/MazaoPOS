import { useCallback, useEffect, useState } from "react";
import { fmtKES, fmtQty, toCents, toMilli } from "../../../shared/money";
import { fetchAllProducts, get, patch, post, put, useAuth, type Product } from "../lib/api";
import { ArrowLeftRight, ClipboardCheck, Download, Package, PackagePlus, Pencil, Plus, SearchX, X } from "lucide-react";
import { Button, EmptyState, ErrorLine, Field, IconButton, Input, Modal, NumInput, PageHead, inputCls, td, th, Select } from "../lib/ui";
import { useToast } from "../lib/toast";
import { useLive } from "../lib/live";
import { ImportProducts } from "./ImportProducts";

interface Cat { id: number; name: string }
const UNITS = ["pc", "kg", "m", "bag", "box", "ltr", "roll", "pkt", "set", "pair", "sheet", "tin"];

const PAGE = 50; // products per page

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

  const [exporting, setExporting] = useState(false);

  /** Every product (also inactive ones) as a CSV that the Import button can read back. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = await fetchAllProducts("&all=1");
      const esc = (v: string | number | null | undefined) => { const t = String(v ?? ""); return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const money = (c: number | null) => (c == null ? "" : (c / 100).toString());
      const qty = (m: number) => (m / 1000).toString();
      const vat = (c: string) => (c === "E" ? "Exempt" : c === "B" ? "0" : "16");
      const head = ["name", "code", "barcode", "category", "unit", "vat", ...(canCost ? ["cost"] : []), "price", "contractor", "wholesale", "reorder", "shop stock", "store stock"];
      const lines = all.map((p) => [p.name, p.sku, p.barcode, p.category, p.unit, vat(p.vat_code), ...(canCost ? [money(p.cost_cents)] : []), money(p.price_retail_cents), money(p.price_contractor_cents), money(p.price_wholesale_cents), qty(p.reorder_level_milli), qty(p.stock_shop), qty(p.stock_store)].map(esc).join(","));
      const blob = new Blob(["﻿" + [head.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast({ msg: `${all.length} product${all.length === 1 ? "" : "s"} exported` });
    } catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
    setExporting(false);
  };

  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<{ items: number; low: number; at_price_cents: number; at_cost_cents: number | null } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [vals, setVals] = useState<{ items: number; selling_value_cents: number; cost_value_cents: number; store_cost_value_cents: number; store_items: number; dead_cost_value_cents: number; dead_items: number; dead_days: number } | null>(null);
  useEffect(() => { if (canCost) get<NonNullable<typeof vals>>("/api/reports/inventory-values").then(setVals).catch(() => setVals(null)); }, [canCost, total]);
  useLive(["sales", "stock", "products"], () => { if (canCost) get<NonNullable<typeof vals>>("/api/reports/inventory-values").then(setVals).catch(() => {}); });
  const lastPage = Math.max(0, Math.ceil(total / PAGE) - 1);

  const load = useCallback(
    () => get<{ items: Product[]; total: number; summary: typeof summary }>(`/api/products/page?limit=${PAGE}&offset=${page * PAGE}&q=${encodeURIComponent(q)}${showInactive ? "&all=1" : ""}`).then((r) => {
      setRows(r.items); setTotal(r.total); setSummary(r.summary); setLoaded(true);
      // the list shrank (a product was removed or filtered away) and this page no longer exists: step back
      if (!r.items.length && r.total > 0 && page > 0) setPage(Math.max(0, Math.ceil(r.total / PAGE) - 1));
    }),
    [q, showInactive, page],
  );
  // a new search or filter starts again from the first page
  useEffect(() => { setPage(0); }, [q, showInactive]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  useLive(["products", "stock"], load);

  return (
    <div className="p-4">
      <PageHead title="Inventory">
        <Input placeholder="Search name, code, barcode" value={q} onChange={(e) => setQ(e.target.value)} className="!w-64" />
        {canManage && <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>}
        {canManage && <Button onClick={() => setImporting(true)}>Import</Button>}
        <Button onClick={exportCsv} disabled={exporting} className="flex items-center gap-1.5"><Download className="size-4" />{exporting ? "Exporting" : "Export"}</Button>
        {canManage && <Button variant="primary" onClick={() => setEdit("new")}>Add product</Button>}
      </PageHead>
      {!q && !showInactive && summary && summary.items > 0 && (() => {
        const low = summary.low;
        const atCost = summary.at_cost_cents ?? 0;
        const atPrice = summary.at_price_cents;
        return (
          <div className={`grid grid-cols-2 gap-3 mb-4 ${canCost ? "md:grid-cols-3 xl:grid-cols-5" : "md:grid-cols-3"}`}>
            <Stat label="Stock at selling price" value={kes(vals?.selling_value_cents ?? atPrice)} sub={`${summary.items.toLocaleString("en-KE")} items`} />
            {canCost && <Stat label="Stock at cost" value={kes(vals?.cost_value_cents ?? atCost)} sub={`${summary.items.toLocaleString("en-KE")} items`} />}
            {canCost && vals && <Stat label="Store stock at cost" value={kes(vals.store_cost_value_cents)} sub={vals.store_items ? `${vals.store_items.toLocaleString("en-KE")} items` : "Nothing in the store"} />}
            {canCost && vals && <Stat label={`Dead stock at cost`} value={kes(vals.dead_cost_value_cents)} sub={`${vals.dead_items.toLocaleString("en-KE")} of ${vals.items.toLocaleString("en-KE")} items, no sale in ${vals.dead_days} days`} warn={vals.dead_items > 0} />}
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
            {loaded && !rows.length && (
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
      {total > PAGE && (
        <div className="flex items-center justify-between gap-3 mt-3 text-sm text-slate-600" role="navigation" aria-label="Pages of products">
          <span>{(page * PAGE + 1).toLocaleString("en-KE")} to {Math.min((page + 1) * PAGE, total).toLocaleString("en-KE")} of {total.toLocaleString("en-KE")} products</span>
          <div className="flex items-center gap-2">
            <Button onClick={() => setPage(0)} disabled={page === 0} className="!px-3">First</Button>
            <Button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="!px-3">Previous</Button>
            <span className="px-1 tabular-nums">Page {page + 1} of {lastPage + 1}</span>
            <Button onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage} className="!px-3">Next</Button>
            <Button onClick={() => setPage(lastPage)} disabled={page >= lastPage} className="!px-3">Last</Button>
          </div>
        </div>
      )}
      {importing && <ImportProducts onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); toast({ msg: `${n} product${n === 1 ? "" : "s"} imported` }); load(); }} />}
      {edit && <ProductForm product={edit === "new" ? null : edit} onClose={() => setEdit(null)}
        onSaved={() => { toast({ msg: edit === "new" ? "Product added" : "Product updated" }); setEdit(null); load(); }} />}
      {stock && <StockForm {...stock} onClose={() => setStock(null)}
        onSaved={() => { toast({ msg: { receive: "Stock received", count: "Stock count saved", transfer: "Stock moved" }[stock.mode] }); setStock(null); load(); }} />}
    </div>
  );
}

const kes = (cents: number) => `KES ${(cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-white border border-line rounded-xl shadow-card p-4 min-w-0">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={`text-xl font-bold tracking-tight mt-1 truncate ${warn ? "text-amber-700" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
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
    itemClass: product?.item_class_code ?? "", qtyUnit: product?.qty_unit_code ?? "", packUnit: product?.pack_unit_code ?? "", origin: product?.origin_country ?? "KE",
  });
  // other ways to sell the same product: a roll, a dozen, a box...
  const [units, setUnits] = useState<{ name: string; factor: number | null; price: number | null; barcode: string }[]>(
    (product?.units ?? []).map((u) => ({ name: u.name, factor: u.factor_milli / 1000, price: u.price_cents == null ? null : u.price_cents / 100, barcode: u.barcode ?? "" })),
  );
  const setUnit = (i: number, patchIt: Partial<(typeof units)[number]>) => setUnits((x) => x.map((u, k) => (k === i ? { ...u, ...patchIt } : u)));
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
        itemClassCode: f.itemClass.trim() || null, qtyUnitCode: f.qtyUnit.trim() || null, packUnitCode: f.packUnit.trim() || null, originCountry: f.origin.trim() || "KE",
      };
      const filled = units.filter((u) => u.name.trim());
      if (filled.some((u) => !u.factor || u.factor <= 0)) return setErr("Say how many " + f.unit + " each pack contains");
      let pid = product?.id;
      if (product) await patch(`/api/products/${product.id}`, { ...body, active: f.active });
      else pid = (await post<{ id: number }>("/api/products", body)).id;
      await put(`/api/products/${pid}/units`, { units: filled.map((u) => ({ name: u.name.trim(), factor: u.factor!, priceCents: u.price == null ? null : toCents(u.price), barcode: u.barcode.trim() || null })) });
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
          <Select className={inputCls} value={f.categoryId ?? ""} onChange={(e) => s("categoryId", e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="...or new category"><Input value={f.newCat} onChange={(e) => s("newCat", e.target.value)} /></Field>
        <Field label="Sold by (unit)">
          <Select className={inputCls} value={f.unit} onChange={(e) => s("unit", e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>
        </Field>
        <Field label="VAT">
          <Select className={inputCls} value={f.vatCode} onChange={(e) => s("vatCode", e.target.value as "A" | "B" | "E")}>
            <option value="A">16% standard</option><option value="B">0% zero-rated</option><option value="E">Exempt</option>
          </Select>
        </Field>
        <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={f.allowFraction} onChange={(e) => s("allowFraction", e.target.checked)} /> Can be sold in fractions (e.g. 2.5 m, 0.5 kg)</label>
        <Field label="Cost price (KES)"><NumInput value={f.cost} onChange={(n) => s("cost", n)} /></Field>
        <Field label="Retail price (KES, VAT inclusive)"><NumInput value={f.retail} onChange={(n) => s("retail", n)} /></Field>
        <Field label="Contractor price" hint="Leave blank to use retail"><NumInput value={f.contractor} onChange={(n) => s("contractor", n)} /></Field>
        <Field label="Wholesale price" hint="Leave blank to use contractor/retail"><NumInput value={f.wholesale} onChange={(n) => s("wholesale", n)} /></Field>
        <Field label="Reorder level" hint="Flag as low when stock is at or below this"><NumInput value={f.reorder} onChange={(n) => s("reorder", n)} /></Field>
        <div className="sm:col-span-2 border-t border-slate-200 pt-4 mt-1">
          <div className="font-semibold">Also sold as</div>
          <p className="text-sm text-slate-500 mb-3">For packs such as a roll, a dozen or a box. Stock is always counted in {f.unit}: selling one roll of 50 takes 50 {f.unit} out of stock. Leave the price empty to use the {f.unit} price times the pack size.</p>
          {units.map((u, i) => (
            <div key={i} className="grid grid-cols-[1fr_6rem_1fr_1fr_auto] gap-2 mb-2 items-end">
              <Field label={i === 0 ? "Name" : ""}><Input value={u.name} onChange={(e) => setUnit(i, { name: e.target.value })} placeholder="e.g. Roll" /></Field>
              <Field label={i === 0 ? `Contains (${f.unit})` : ""}><NumInput value={u.factor} onChange={(n) => setUnit(i, { factor: n })} /></Field>
              <Field label={i === 0 ? "Price (optional)" : ""}><NumInput value={u.price} onChange={(n) => setUnit(i, { price: n })} /></Field>
              <Field label={i === 0 ? "Barcode (optional)" : ""}><Input value={u.barcode} onChange={(e) => setUnit(i, { barcode: e.target.value })} /></Field>
              <button onClick={() => setUnits((x) => x.filter((_, k) => k !== i))} aria-label="Remove this pack" className="h-11 w-9 text-slate-400 hover:text-danger flex items-center justify-center"><X className="size-5" /></button>
            </div>
          ))}
          <Button onClick={() => setUnits((x) => [...x, { name: "", factor: null, price: null, barcode: "" }])} className="flex items-center gap-1.5"><Plus className="size-4" />Add a pack size</Button>
        </div>
        <details className="sm:col-span-2 border-t border-slate-200 pt-3">
          <summary className="cursor-pointer font-semibold">Tax authority details (for eTIMS)</summary>
          <div className="grid sm:grid-cols-4 gap-3 mt-3">
            <Field label="Item class code"><Input value={f.itemClass} onChange={(e) => s("itemClass", e.target.value)} /></Field>
            <Field label="Quantity unit code"><Input value={f.qtyUnit} onChange={(e) => s("qtyUnit", e.target.value.toUpperCase())} /></Field>
            <Field label="Packaging unit code"><Input value={f.packUnit} onChange={(e) => s("packUnit", e.target.value.toUpperCase())} /></Field>
            <Field label="Country of origin"><Input value={f.origin} onChange={(e) => s("origin", e.target.value.toUpperCase())} /></Field>
          </div>
        </details>
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
