import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fmtKES, fmtQty } from "../../../../shared/money";
import { get } from "../../lib/api";
import { Card } from "../../lib/charts";
import { useLive } from "../../lib/live";
import { Select, td, th } from "../../lib/ui";

interface Fast { id: number; sku: string; name: string; unit: string; sold_milli: number; revenue_cents: number; orders: number; on_hand_milli: number; profit_cents: number | null; cover_days: number | null }
interface Slow { id: number; sku: string; name: string; unit: string; sold_milli: number; revenue_cents: number; on_hand_milli: number; value_cost_cents: number | null; value_selling_cents: number; last_sold_at: string | null; days_since_sold: number | null }
interface Data { days: number; fast: Fast[]; slow: Slow[]; totals: { items_sold: number; items_in_stock: number; in_stock_unsold: number } }

const PERIODS = [{ value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }, { value: "180", label: "Last 6 months" }, { value: "365", label: "Last year" }];

/** What sells fast and what sits on the shelf, for the Reports page. */
export default function Movers() {
  const [days, setDays] = useState("30");
  const [d, setD] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    get<Data>(`/api/reports/movers?days=${days}&limit=15`).then((r) => { setD(r); setFailed(false); }).catch(() => setFailed(true));
  }, [days]);
  useEffect(() => { load(); }, [load]);
  useLive(["sales", "stock", "products"], load);

  const showCost = d?.slow.some((r) => r.value_cost_cents !== null) ?? false;

  return (
    <div className="mt-8" id="movers">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Fast and slow movers</h2>
          <p className="text-sm text-slate-500">Fast movers are ranked by sales value. Slow movers are items in stock that sold the least.</p>
        </div>
        <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Period">{PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
      </div>

      {failed && !d && <p className="text-slate-500">The movers could not be loaded. Try again in a moment.</p>}
      {!d && !failed && <div className="grid 2xl:grid-cols-2 gap-6">{[0, 1].map((i) => <div key={i} className="h-64 rounded-xl bg-slate-200/70 animate-pulse" />)}</div>}

      {d && (
        <>
          <p className="text-sm text-slate-600 mb-3">
            {d.totals.items_sold.toLocaleString("en-KE")} items sold in this period. {d.totals.in_stock_unsold.toLocaleString("en-KE")} of {d.totals.items_in_stock.toLocaleString("en-KE")} items in stock did not sell at all.
          </p>
          <div className="grid 2xl:grid-cols-2 gap-6">
            <Card title="Fast movers" sub="Top items by sales value">
              {!d.fast.length ? <p className="text-slate-500 py-4">Nothing has sold in this period.</p> : (
                <div className="overflow-auto -mx-2">
                  <table className="w-full">
                    <thead><tr><th className={th}>Item</th><th className={`${th} text-right`}>Sold</th><th className={`${th} text-right`}>Sales</th><th className={`${th} text-right hidden sm:table-cell`}>In stock</th><th className={`${th} text-right hidden md:table-cell`}>Lasts</th></tr></thead>
                    <tbody>
                      {d.fast.map((r) => (
                        <tr key={r.id}>
                          <td className={td}><Link to={`/inventory/${r.id}`} className="font-semibold hover:underline">{r.name}</Link><div className="text-xs text-slate-500">{r.sku}</div></td>
                          <td className={`${td} num`}>{fmtQty(r.sold_milli)} {r.unit}</td>
                          <td className={`${td} num`}>{fmtKES(r.revenue_cents)}</td>
                          <td className={`${td} num hidden sm:table-cell ${r.on_hand_milli <= 0 ? "text-danger font-semibold" : ""}`}>{fmtQty(r.on_hand_milli)}</td>
                          <td className={`${td} num hidden md:table-cell text-slate-600`}>{r.cover_days === null ? "Out" : r.cover_days > 365 ? "A year +" : `${r.cover_days} days`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Slow movers" sub="In stock, selling least. Money tied up on the shelf.">
              {!d.slow.length ? <p className="text-slate-500 py-4">There is no stock on hand.</p> : (
                <div className="overflow-auto -mx-2">
                  <table className="w-full">
                    <thead><tr><th className={th}>Item</th><th className={`${th} text-right`}>Sold</th><th className={`${th} text-right`}>In stock</th><th className={`${th} text-right`}>{showCost ? "Value at cost" : "Value"}</th><th className={`${th} hidden md:table-cell`}>Last sold</th></tr></thead>
                    <tbody>
                      {d.slow.map((r) => (
                        <tr key={r.id}>
                          <td className={td}><Link to={`/inventory/${r.id}`} className="font-semibold hover:underline">{r.name}</Link><div className="text-xs text-slate-500">{r.sku}</div></td>
                          <td className={`${td} num`}>{r.sold_milli > 0 ? `${fmtQty(r.sold_milli)} ${r.unit}` : "None"}</td>
                          <td className={`${td} num`}>{fmtQty(r.on_hand_milli)} {r.unit}</td>
                          <td className={`${td} num`}>{fmtKES(r.value_cost_cents ?? r.value_selling_cents)}</td>
                          <td className={`${td} hidden md:table-cell text-slate-600`}>{r.days_since_sold === null ? "Never" : r.days_since_sold === 0 ? "Today" : `${r.days_since_sold} days ago`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
