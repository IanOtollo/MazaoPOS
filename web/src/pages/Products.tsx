import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { fmtKES, fmtQty } from "../../../shared/money";
import { fetchAllProducts, get, useAuth, type Product } from "../lib/api";
import { Button, Input, PageHead, Select, td, th } from "../lib/ui";
import { useToast } from "../lib/toast";
import { useLive } from "../lib/live";
import { ImportProducts } from "./ImportProducts";
import { ProductForm } from "./inventory/forms";
import { Movements } from "./inventory/Movements";
import { Categories } from "./inventory/Categories";
import { Pager, Stat, StatusBadge, kes, rowStatus } from "./inventory/shared";
import { LowStockCard } from "./inventory/LowStockCard";

const PAGE = 50; // products per page

type Row = Product & { on_hand_milli?: number; value_cost_cents?: number | null; value_selling_cents?: number };
interface Cat { id: number; name: string; product_count?: number }
interface Summary { items: number; low: number; at_price_cents: number; at_cost_cents: number | null }
interface Vals { items: number; selling_value_cents: number; cost_value_cents: number; store_cost_value_cents: number; store_items: number; dead_cost_value_cents: number; dead_items: number; dead_days: number }

type Tab = "items" | "movements" | "categories";

/** The Inventory manager: the catalogue with its stock, the stock ledger, and categories. One product has its own page. */
export default function Products() {
  const { can } = useAuth();
  const canManage = can("products.manage");
  const canStock = can("stock.manage");
  const canCost = can("products.view_cost");
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const wanted = params.get("tab");
  const tab: Tab = wanted === "movements" && canStock ? "movements" : wanted === "categories" ? "categories" : "items";
  const productParam = Number(params.get("product")) || null;
  const setTab = (t: Tab) => setParams(t === "items" ? {} : { tab: t }, { replace: true });

  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

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

  const tabs: [Tab, string][] = [["items", "Items"], ...(canStock ? [["movements", "Stock movements"] as [Tab, string]] : []), ["categories", "Categories"]];

  return (
    <div className="p-4">
      <PageHead title="Inventory">
        {canManage && <Button onClick={() => setImporting(true)}>Import</Button>}
        <Button onClick={exportCsv} disabled={exporting}>{exporting ? "Exporting" : "Export"}</Button>
        {canManage && <Button variant="primary" onClick={() => setAdding(true)}>Add product</Button>}
      </PageHead>

      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 mb-4" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors ${tab === id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
        ))}
      </div>

      {tab === "items" && <Items reloadKey={reloadKey} onAdd={() => setAdding(true)} />}
      {tab === "movements" && <Movements initialProductId={productParam} />}
      {tab === "categories" && <Categories />}

      {importing && <ImportProducts onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); toast({ msg: `${n} product${n === 1 ? "" : "s"} imported` }); setReloadKey((k) => k + 1); }} />}
      {adding && <ProductForm product={null} onClose={() => setAdding(false)} onSaved={() => { toast({ msg: "Product added" }); setAdding(false); setReloadKey((k) => k + 1); }} />}
    </div>
  );
}

const STATUS_OPTIONS: [string, string][] = [["all", "All items"], ["in", "In stock"], ["low", "Low stock"], ["out", "Out of stock"], ["dead", "Dead stock"]];

function Items({ reloadKey, onAdd }: { reloadKey: number; onAdd: () => void }) {
  const { can } = useAuth();
  const canManage = can("products.manage");
  const canCost = can("products.view_cost");
  const nav = useNavigate();

  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [showInactive, setShowInactive] = useState(false);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [cats, setCats] = useState<Cat[]>([]);
  const [vals, setVals] = useState<Vals | null>(null);

  useEffect(() => { get<Cat[]>("/api/categories").then(setCats).catch(() => {}); }, [reloadKey]);
  const loadVals = useCallback(() => { if (canCost) get<Vals>("/api/reports/inventory-values").then(setVals).catch(() => setVals(null)); }, [canCost]);
  useEffect(() => { loadVals(); }, [loadVals, reloadKey, total]);
  useLive(["sales", "stock", "products"], loadVals);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE), q, status, sort, dir });
    if (showInactive) p.set("all", "1");
    if (categoryId) p.set("categoryId", categoryId);
    return get<{ items: Row[]; total: number; summary: Summary }>(`/api/products/page?${p}`).then((r) => {
      setRows(r.items); setTotal(r.total); setSummary(r.summary); setLoaded(true); setErr("");
      // the list shrank (a product was removed or filtered away) and this page no longer exists: step back
      if (!r.items.length && r.total > 0 && page > 0) setPage(Math.max(0, Math.ceil(r.total / PAGE) - 1));
    }).catch((e) => { setErr((e as Error).message); setLoaded(true); });
  }, [q, categoryId, status, sort, dir, showInactive, page]);
  // any new search, filter or sort starts again from the first page
  useEffect(() => { setPage(0); }, [q, categoryId, status, sort, dir, showInactive]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load, reloadKey]);
  useLive(["products", "stock"], load);

  const filtered = !!(q || categoryId || status !== "all" || showInactive);
  const sortOptions: [string, string][] = [["name", "Name"], ["stock", "Stock"], ["value", "Stock value"], ["price", "Price"], ...(canCost ? [["cost", "Cost"] as [string, string]] : [])];
  const dirLabel = sort === "name" ? (dir === "asc" ? "A to Z" : "Z to A") : dir === "asc" ? "Low to high" : "High to low";

  return (
    <div>
      {!filtered && summary && summary.items > 0 && (
        <div className={`grid grid-cols-2 gap-3 mb-4 ${canCost ? "md:grid-cols-3 xl:grid-cols-5" : "md:grid-cols-3"}`}>
          <Stat label="Stock at selling price" value={kes(vals?.selling_value_cents ?? summary.at_price_cents)} sub={`${summary.items.toLocaleString("en-KE")} items`} />
          {canCost && <Stat label="Stock at cost" value={kes(vals?.cost_value_cents ?? summary.at_cost_cents ?? 0)} sub={`${summary.items.toLocaleString("en-KE")} items`} />}
          {canCost && vals && <Stat label="Store stock at cost" value={kes(vals.store_cost_value_cents)} sub={vals.store_items ? `${vals.store_items.toLocaleString("en-KE")} items` : "Nothing in the store"} />}
          {canCost && vals && <Stat label="Dead stock at cost" value={kes(vals.dead_cost_value_cents)} sub={`${vals.dead_items.toLocaleString("en-KE")} of ${vals.items.toLocaleString("en-KE")} items, no sale in ${vals.dead_days} days`} warn={vals.dead_items > 0} />}
          <LowStockCard count={summary.low} onShowAll={() => setStatus("low")} />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="w-full sm:w-64"><span className="block text-xs font-medium text-slate-500 mb-1">Search</span>
          <Input placeholder="Name, code or barcode" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" /></div>
        <div className="w-44"><span className="block text-xs font-medium text-slate-500 mb-1">Category</span>
          <Select aria-label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">All categories</option>{cats.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </Select></div>
        <div className="w-40"><span className="block text-xs font-medium text-slate-500 mb-1">Stock level</span>
          <Select aria-label="Stock level" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
        <div className="w-40"><span className="block text-xs font-medium text-slate-500 mb-1">Sort by</span>
          <Select aria-label="Sort by" value={sort} onChange={(e) => { setSort(e.target.value); setDir(e.target.value === "name" ? "asc" : "desc"); }}>{sortOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
        <Button onClick={() => setDir((d) => (d === "asc" ? "desc" : "asc"))} aria-label={`Sort order: ${dirLabel}. Press to reverse.`}>{dirLabel}</Button>
        {canManage && <label className="text-sm flex items-center gap-1.5 pb-3"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive</label>}
      </div>

      {err && <p role="alert" className="text-sm font-medium text-danger mb-3">{err}</p>}
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>Item</th><th className={`${th} hidden sm:table-cell`}>Unit</th>
              <th className={`${th} text-right`}>Price</th>{canCost && <th className={`${th} text-right hidden lg:table-cell`}>Cost</th>}
              <th className={`${th} text-right hidden md:table-cell`}>Shop</th><th className={`${th} text-right hidden md:table-cell`}>Store</th>
              <th className={`${th} text-right`}>Total</th><th className={`${th} text-right hidden lg:table-cell`}>{canCost ? "Value at cost" : "Value"}</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const onHand = p.on_hand_milli ?? p.stock_shop + p.stock_store;
              const value = canCost ? p.value_cost_cents ?? null : p.value_selling_cents ?? null;
              const st = status === "dead" ? "dead" : rowStatus(onHand, p.reorder_level_milli);
              return (
                <tr key={p.id} onClick={() => nav(`/inventory/${p.id}`)} className={`cursor-pointer hover:bg-slate-50 ${p.active ? "" : "text-slate-400"}`}>
                  <td className={td}>
                    <Link to={`/inventory/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold hover:underline">{p.name}</Link>
                    {!p.active && <span className="ml-2 text-[11px] uppercase tracking-wide text-slate-500">Inactive</span>}
                    <span className="block text-xs text-slate-500">{p.sku}{p.category ? ` · ${p.category}` : ""}</span>
                  </td>
                  <td className={`${td} hidden sm:table-cell`}>{p.unit}</td>
                  <td className={`${td} num`}>{fmtKES(p.price_retail_cents)}</td>
                  {canCost && <td className={`${td} num hidden lg:table-cell`}>{fmtKES(p.cost_cents)}</td>}
                  <td className={`${td} num hidden md:table-cell`}>{fmtQty(p.stock_shop)}</td>
                  <td className={`${td} num hidden md:table-cell`}>{fmtQty(p.stock_store)}</td>
                  <td className={`${td} num font-semibold`}>{fmtQty(onHand)}</td>
                  <td className={`${td} num hidden lg:table-cell`}>{value == null ? "—" : fmtKES(value)}</td>
                  <td className={td}><StatusBadge status={st} /></td>
                </tr>
              );
            })}
            {loaded && !rows.length && !err && (
              <tr><td colSpan={9} className={`${td} text-center py-12`}>
                {filtered ? (
                  <p className="text-slate-500">No items match. Try clearing a filter or checking the spelling.</p>
                ) : (
                  <div>
                    <p className="font-semibold text-slate-700">Your catalogue is empty</p>
                    <p className="text-sm text-slate-500 mt-1">Add your first product, or import your price list from a spreadsheet.</p>
                    {canManage && <Button variant="primary" onClick={onAdd} className="mt-3">Add your first product</Button>}
                  </div>
                )}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={total} size={PAGE} noun="products" onPage={setPage} />
    </div>
  );
}
