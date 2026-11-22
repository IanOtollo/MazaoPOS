import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { fmtKES } from "../../../shared/money";
import { fmtTime } from "../lib/api";
import { BarChart, Card, Kpi, List, PaymentMix, kes0 } from "../lib/charts";
import { fmtDay, kpiSeries, useRange } from "../lib/range";
import { PageHead } from "../lib/ui";

/** The at-a-glance screen: a few numbers, one trend, and anything that needs attention. Detail lives in Reports. */
export default function Dashboard() {
  const { data: d, err, vs, picker } = useRange();
  const sp = d ? kpiSeries(d) : null;

  return (
    <div className="p-4 sm:p-6">
      <PageHead title="Dashboard">{picker}</PageHead>
      {d && <p className="text-sm text-slate-500 -mt-2 mb-4">{d.days === 1 ? fmtDay(d.to) : `${fmtDay(d.from)} to ${fmtDay(d.to)}`}</p>}
      {err && <p className="text-danger font-medium mb-4" role="alert">{err}</p>}
      {!d && !err && <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-28 rounded-xl bg-slate-200/70 animate-pulse" />)}</div>}

      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Kpi label="Net sales" value={kes0(d.current.net_cents)} unit="KES" now={d.current.net_cents} before={d.previous.net_cents} vs={vs} spark={sp?.net} />
            <Kpi label="Sales made" value={String(d.current.sales)} now={d.current.sales} before={d.previous.sales} vs={vs} spark={sp?.sales} />
            {d.current.profit_cents !== null
              ? <Kpi label="Gross profit" value={kes0(d.current.profit_cents)} unit="KES" now={d.current.profit_cents} before={d.previous.profit_cents ?? 0} vs={vs} spark={sp?.profit} />
              : <Kpi label="VAT collected" value={kes0(d.current.vat_cents)} unit="KES" now={d.current.vat_cents} before={d.previous.vat_cents} vs={vs} spark={sp?.vat} />}
            <Kpi label="Owed by customers" value={kes0(d.owing.total_cents)} unit="KES" note={`${d.owing.count} ${d.owing.count === 1 ? "customer" : "customers"}`} tone={d.owing.total_cents > 0 ? "warn" : undefined} />
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
            <Card title="How customers paid">
              <PaymentMix methods={d.methods} />
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card title="Needs attention">
              {d.lowStock.count + d.owing.count + d.openShifts.length === 0
                ? <p className="text-slate-500 py-6 text-center">Nothing needs attention right now.</p>
                : (
                  <ul className="divide-y divide-slate-100 -my-2">
                    {d.lowStock.count > 0 && <Attention to="/inventory" title={`${d.lowStock.count} ${d.lowStock.count === 1 ? "item is" : "items are"} low on stock`} sub={d.lowStock.items.slice(0, 2).map((i) => i.name).join(", ")} />}
                    {d.owing.count > 0 && <Attention to="/customers" title={`${d.owing.count} ${d.owing.count === 1 ? "customer owes" : "customers owe"} you KES ${kes0(d.owing.total_cents)}`} sub={d.owing.top[0] ? `Largest: ${d.owing.top[0].name}` : undefined} />}
                    {d.openShifts.length > 0 && <Attention to="/shift" title={`${d.openShifts.length} ${d.openShifts.length === 1 ? "till is" : "tills are"} open`} sub={d.openShifts.map((s) => `${s.cashier} since ${fmtTime(s.opened_at)}`).join(", ")} />}
                  </ul>
                )}
            </Card>
            <Card title="Recent sales" action={<Link to="/sales" className="text-sm font-semibold text-accent hover:underline">All sales</Link>}>
              <List empty="No sales yet." rows={d.recent.slice(0, 5).map((s) => ({
                key: s.id, left: `${s.receipt_no}${s.kind === "refund" ? "  (refund)" : ""}`, sub: `${fmtTime(s.created_at)} · ${s.cashier}`,
                right: `KES ${fmtKES(s.total_cents)}`, bad: s.total_cents < 0,
              }))} />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function Attention({ to, title, sub }: { to: string; title: string; sub?: string }) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between gap-3 py-3 hover:bg-slate-50 -mx-2 px-2 rounded-lg">
        <span className="min-w-0"><span className="block font-medium">{title}</span>{sub && <span className="block text-xs text-slate-500 truncate">{sub}</span>}</span>
        <ChevronRight className="size-5 text-slate-400 shrink-0" />
      </Link>
    </li>
  );
}
