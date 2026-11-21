import { VAT_LABEL, fmtKES, fmtQty } from "../../../shared/money";
import { fmtTime } from "../lib/api";
import { Bars, BarChart, Card, Kpi, List, PaymentMix, kes0 } from "../lib/charts";
import { fmtDay, kpiSeries, useRange } from "../lib/range";
import { PageHead, td, th } from "../lib/ui";

/** The detailed view: everything the Dashboard summarises, for any period. */
export default function Reports() {
  const { data: d, err, vs, picker } = useRange();
  const sp = d ? kpiSeries(d) : null;

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <PageHead title="Reports">{picker}</PageHead>
      {d && <p className="text-sm text-slate-500 -mt-2 mb-4">{d.days === 1 ? fmtDay(d.to) : `${fmtDay(d.from)} to ${fmtDay(d.to)}`}</p>}
      {err && <p className="text-danger font-medium mb-4" role="alert">{err}</p>}
      {!d && !err && <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-28 rounded-xl bg-slate-200/70 animate-pulse" />)}</div>}

      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
            <Kpi label="Net sales (VAT included)" value={kes0(d.current.net_cents)} unit="KES" now={d.current.net_cents} before={d.previous.net_cents} vs={vs} spark={sp?.net} />
            <Kpi label="Sales made" value={String(d.current.sales)} now={d.current.sales} before={d.previous.sales} vs={vs} spark={sp?.sales} />
            <Kpi label="Average sale" value={kes0(d.current.sales ? Math.round(d.current.sales_cents / d.current.sales) : 0)} unit="KES"
              now={d.current.sales ? d.current.sales_cents / d.current.sales : 0} before={d.previous.sales ? d.previous.sales_cents / d.previous.sales : 0} vs={vs} spark={sp?.avg} />
            {d.current.profit_cents !== null && (
              <Kpi label="Gross profit (VAT excluded)" value={kes0(d.current.profit_cents)} unit="KES" now={d.current.profit_cents} before={d.previous.profit_cents ?? 0} vs={vs} spark={sp?.profit}
                note={d.current.net_cents - d.current.vat_cents > 0 ? `${((d.current.profit_cents / (d.current.net_cents - d.current.vat_cents)) * 100).toFixed(1)}% margin` : undefined} />
            )}
            <Kpi label="VAT collected" value={kes0(d.current.vat_cents)} unit="KES" now={d.current.vat_cents} before={d.previous.vat_cents} vs={vs} spark={sp?.vat} />
            <Kpi label="Refunds and discounts" value={kes0(d.current.refund_cents + d.current.discount_cents)} unit="KES" now={d.current.refund_cents + d.current.discount_cents} before={d.previous.refund_cents + d.previous.discount_cents} vs={vs} invert
              note={`refunds ${kes0(d.current.refund_cents)}, discounts ${kes0(d.current.discount_cents)}`} />
          </div>

          <div className="grid xl:grid-cols-[2fr_1fr] gap-6">
            <Card title={d.days === 1 ? "Sales by hour" : "Net sales per day"} sub={d.days === 1 ? "Number of sales" : "KES, VAT included"}>
              {d.days === 1
                ? <BarChart data={d.hours.filter((h) => h.hour >= 6 && h.hour <= 21).map((h) => ({ label: String(h.hour).padStart(2, "0"), value: h.sales, tip: `${String(h.hour).padStart(2, "0")}:00  ${h.sales} sale${h.sales === 1 ? "" : "s"}` }))} fmt={(v) => String(Math.round(v))} />
                : <BarChart data={d.series.map((s) => ({
                    label: d.days > 62 ? new Date(s.date + "T00:00:00Z").toLocaleDateString("en-KE", { day: "numeric", month: "short", timeZone: "UTC" }) : d.days > 14 ? s.date.slice(8) : new Date(s.date + "T00:00:00Z").toLocaleDateString("en-KE", { weekday: "short", day: "numeric", timeZone: "UTC" }),
                    value: s.net_cents / 100,
                    tip: `${new Date(s.date + "T00:00:00Z").toLocaleDateString("en-KE", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" })}  KES ${fmtKES(s.net_cents)}  (${s.sales} sale${s.sales === 1 ? "" : "s"})`,
                  }))} fmt={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v)))} />}
            </Card>
            <Card title="How customers paid"><PaymentMix methods={d.methods} /></Card>
          </div>

          <div className="grid lg:grid-cols-2 xl:grid-cols-3 gap-6">
            <Card title="Best sellers" sub="By value">
              <Bars rows={d.topItems.map((t) => ({ label: t.name, right: `KES ${kes0(t.gross_cents)}`, sub: `${fmtQty(t.qty_milli)} ${t.unit}`, value: t.gross_cents }))} empty="No sales in this period." />
            </Card>
            <Card title="Staff" sub="Net sales per person">
              <Bars rows={d.cashiers.map((c) => ({ label: c.name, right: `KES ${kes0(c.net_cents)}`, sub: `${c.sales} sale${c.sales === 1 ? "" : "s"}`, value: c.net_cents }))} empty="No sales in this period." />
            </Card>
            {d.days > 1 && (
              <Card title="Busiest hours" sub="Sales by time of day">
                <BarChart small data={d.hours.filter((h) => h.hour >= 6 && h.hour <= 21).map((h) => ({ label: String(h.hour).padStart(2, "0"), value: h.sales, tip: `${String(h.hour).padStart(2, "0")}:00  ${h.sales} sale${h.sales === 1 ? "" : "s"}` }))} fmt={(v) => String(Math.round(v))} />
              </Card>
            )}
          </div>

          <div className="grid lg:grid-cols-2 xl:grid-cols-3 gap-6">
            <Card title="VAT" sub="By tax rate">
              {d.byVat.length === 0 ? <p className="text-slate-500 py-6 text-center">No sales in this period.</p> : (
                <table className="w-full">
                  <thead><tr><th className={th}>Rate</th><th className={`${th} text-right`}>Sales</th><th className={`${th} text-right`}>VAT</th></tr></thead>
                  <tbody>{d.byVat.map((v) => <tr key={v.vat_code}><td className={td}>{VAT_LABEL[v.vat_code]}</td><td className={`${td} num`}>{fmtKES(v.gross_cents)}</td><td className={`${td} num`}>{fmtKES(v.vat_cents)}</td></tr>)}</tbody>
                </table>
              )}
            </Card>
            {d.stockValue && (
              <Card title="Stock on hand" sub="Shop and store together">
                <div className="space-y-3">
                  <div><div className="text-sm text-slate-500">At cost</div><div className="text-2xl font-bold num !text-left">KES {kes0(d.stockValue.cost_cents)}</div></div>
                  <div><div className="text-sm text-slate-500">At selling price</div><div className="text-2xl font-bold num !text-left">KES {kes0(d.stockValue.retail_cents)}</div></div>
                </div>
              </Card>
            )}
            <Card title="Cash-ups" sub="Counted against expected cash">
              <List empty="No shifts have been closed yet." rows={d.closedShifts.map((s) => ({
                key: s.id, left: s.cashier, sub: fmtTime(s.closed_at),
                right: s.variance_cents === 0 ? "Balanced" : `${s.variance_cents > 0 ? "Over" : "Short"} KES ${fmtKES(Math.abs(s.variance_cents))}`,
                bad: s.variance_cents < 0, warn: s.variance_cents > 0,
              }))} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
