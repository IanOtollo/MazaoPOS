import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtKES, fmtQty } from "../../../../shared/money";
import { get, useAuth } from "../../lib/api";
import { Button, Input, Select, td, th } from "../../lib/ui";
import { useLive } from "../../lib/live";
import { fmtTime } from "../../lib/api";
import { Pager, SignedQty, moveLabel } from "./shared";

const PAGE = 50;

interface Move {
  id: number; created_at: string; product_id: number; product: string; sku: string; location: string; type: string;
  qty_milli: number; unit_cost_cents: number | null; note: string | null; user: string | null; ref_type: string | null; ref_id: number | null;
}
interface Found { id: number; name: string; sku: string }

const TYPES: [string, string][] = [
  ["", "All types"], ["purchase", "Deliveries"], ["sale", "Sales"], ["sale_return", "Sale returns"], ["adjustment", "Stock counts"],
  ["damage", "Damage or loss"], ["transfer_in", "Moved in"], ["transfer_out", "Moved out"], ["opening", "Opening stock"],
];

/** The full stock ledger: every change to every quantity, who made it and why. */
export function Movements({ initialProductId }: { initialProductId: number | null }) {
  const { can } = useAuth();
  const canCost = can("products.view_cost");
  const [product, setProduct] = useState<{ id: number; name: string } | null>(null);
  const [pq, setPq] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [foundTotal, setFoundTotal] = useState(0);
  const [locs, setLocs] = useState<{ id: number; name: string }[]>([]);
  const [loc, setLoc] = useState("");
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Move[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { get<{ id: number; name: string }[]>("/api/locations").then(setLocs).catch(() => {}); }, []);
  // arriving from a product page: start filtered to that product
  useEffect(() => {
    if (!initialProductId) return;
    get<{ product: { id: number; name: string } }>(`/api/products/${initialProductId}`).then((d) => setProduct({ id: d.product.id, name: d.product.name })).catch(() => {});
  }, [initialProductId]);
  useEffect(() => {
    if (!pq.trim()) { setFound([]); return; }
    const t = setTimeout(() => get<{ items: Found[]; total: number }>(`/api/products/page?q=${encodeURIComponent(pq)}&limit=8&all=1`).then((r) => { setFound(r.items); setFoundTotal(r.total); }).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [pq]);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
    if (product) p.set("productId", String(product.id));
    if (loc) p.set("locationId", loc);
    if (type) p.set("type", type);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return get<{ items: Move[]; total: number }>(`/api/stock/ledger?${p}`).then((r) => {
      setRows(r.items); setTotal(r.total); setLoaded(true); setErr("");
      if (!r.items.length && r.total > 0 && page > 0) setPage(Math.max(0, Math.ceil(r.total / PAGE) - 1));
    }).catch((e) => { setErr((e as Error).message); setLoaded(true); });
  }, [product, loc, type, from, to, page]);
  useEffect(() => { setPage(0); }, [product, loc, type, from, to]);
  useEffect(() => { load(); }, [load]);
  useLive(["stock"], load);

  const filtered = !!(product || loc || type || from || to);
  const clear = () => { setProduct(null); setPq(""); setLoc(""); setType(""); setFrom(""); setTo(""); };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="relative w-64">
          <span className="block text-xs font-medium text-slate-500 mb-1">Item</span>
          {product ? (
            <div className="flex items-center justify-between gap-2 border border-slate-300 rounded-lg bg-white px-3.5 py-2.5">
              <span className="truncate font-medium">{product.name}</span>
              <button onClick={() => setProduct(null)} className="text-sm text-slate-500 hover:text-slate-900 underline underline-offset-2">Clear</button>
            </div>
          ) : (
            <>
              <Input placeholder="Search name or code" value={pq} onChange={(e) => setPq(e.target.value)} />
              {found.length > 0 && (
                <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-pop max-h-64 overflow-auto">
                  {found.map((f) => (
                    <li key={f.id}>
                      <button onClick={() => { setProduct({ id: f.id, name: f.name }); setPq(""); setFound([]); }} className="w-full text-left px-3.5 py-2 hover:bg-slate-50">
                        <span className="block font-medium">{f.name}</span><span className="block text-xs text-slate-500">{f.sku}</span>
                      </button>
                    </li>
                  ))}
                {foundTotal > found.length && <li className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">Showing {found.length} of {foundTotal.toLocaleString("en-KE")} matches. Type more to narrow the list.</li>}
          </ul>
              )}
            </>
          )}
        </div>
        <div className="w-40"><span className="block text-xs font-medium text-slate-500 mb-1">Location</span>
          <Select aria-label="Location" value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">All locations</option>{locs.map((l) => <option key={l.id} value={String(l.id)}>{l.name}</option>)}
          </Select>
        </div>
        <div className="w-44"><span className="block text-xs font-medium text-slate-500 mb-1">Type</span>
          <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        </div>
        <div className="w-40"><span className="block text-xs font-medium text-slate-500 mb-1">From</span><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /></div>
        <div className="w-40"><span className="block text-xs font-medium text-slate-500 mb-1">To</span><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></div>
        {filtered && <Button onClick={clear}>Clear filters</Button>}
      </div>

      {err && <p role="alert" className="text-sm font-medium text-danger mb-3">{err}</p>}
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className={th}>When</th><th className={th}>Item</th><th className={`${th} hidden sm:table-cell`}>Location</th><th className={th}>Type</th>
              <th className={`${th} text-right`}>Quantity</th>{canCost && <th className={`${th} text-right hidden md:table-cell`}>Cost</th>}
              <th className={`${th} hidden md:table-cell`}>By</th><th className={`${th} hidden lg:table-cell`}>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className={`${td} whitespace-nowrap text-slate-600`}>{fmtTime(m.created_at)}</td>
                <td className={td}><Link to={`/inventory/${m.product_id}`} className="font-medium hover:underline">{m.product}</Link><span className="block text-xs text-slate-500">{m.sku}</span></td>
                <td className={`${td} hidden sm:table-cell`}>{m.location}</td>
                <td className={td}>{moveLabel(m.type)}</td>
                <td className={`${td} num`}><SignedQty milli={m.qty_milli} fmt={fmtQty} /></td>
                {canCost && <td className={`${td} num hidden md:table-cell`}>{m.unit_cost_cents == null ? "—" : fmtKES(m.unit_cost_cents)}</td>}
                <td className={`${td} hidden md:table-cell text-slate-600`}>{m.user ?? "—"}</td>
                <td className={`${td} hidden lg:table-cell text-slate-600`}>{m.note ?? ""}</td>
              </tr>
            ))}
            {loaded && !rows.length && !err && (
              <tr><td colSpan={8} className={`${td} text-center text-slate-500 py-10`}>{filtered ? "No movements match these filters." : "No stock movements yet."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={total} size={PAGE} noun="movements" onPage={setPage} />
    </div>
  );
}
