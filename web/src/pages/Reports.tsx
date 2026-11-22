import { useSearchParams } from "react-router-dom";
import { fmtDay, useRange } from "../lib/range";
import { ErrorLine, PageHead, Select } from "../lib/ui";
import { CashUps, ItemsSold, Owed, Payments, SalesSummary, Staff, Stock, Vat } from "./reports/views";

/*
 * Reports: pick a report, pick a period, read a clean table, export it or print it.
 * (The Dashboard is the at-a-glance page; this is where the detail and the paperwork live.)
 */
const REPORTS = [
  { id: "sales", label: "Sales summary", byPeriod: true },
  { id: "items", label: "Items sold", byPeriod: true },
  { id: "payments", label: "How customers paid", byPeriod: true },
  { id: "vat", label: "VAT", byPeriod: true },
  { id: "staff", label: "Sales by person", byPeriod: true },
  { id: "cashups", label: "Cash-ups", byPeriod: true },
  { id: "owed", label: "Money owed", byPeriod: false },
  { id: "stock", label: "Stock and movers", byPeriod: false },
] as const;
type Id = (typeof REPORTS)[number]["id"];

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const { data: d, err, picker } = useRange(30); // opens on the last 30 days
  const asked = params.get("r");
  const current = REPORTS.find((r) => r.id === asked) ?? REPORTS[0];
  const choose = (id: Id) => setParams({ r: id }, { replace: true });

  const period = d ? (d.days === 1 ? fmtDay(d.to) : `${fmtDay(d.from)} to ${fmtDay(d.to)}`) : "";
  const waiting = current.byPeriod && !d;

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <PageHead title="Reports">
        <span className="print:hidden contents">{current.byPeriod ? picker : <span className="text-sm text-slate-500">As of today</span>}</span>
      </PageHead>
      <ErrorLine msg={err} />

      <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-6 items-start">
        {/* the list of reports: a column on larger screens, a dropdown on a phone */}
        <nav aria-label="Reports" className="print:hidden md:sticky md:top-4">
          <div className="md:hidden mb-4">
            <Select aria-label="Choose a report" value={current.id} onChange={(e) => choose(e.target.value as Id)}>
              {REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </Select>
          </div>
          <ul className="hidden md:block space-y-0.5">
            {REPORTS.map((r) => (
              <li key={r.id}>
                <button onClick={() => choose(r.id)} aria-current={r.id === current.id ? "page" : undefined}
                  className={`w-full text-left rounded-lg px-3 py-2 text-sm transition-colors ${r.id === current.id ? "bg-blue-50 text-accent-dark font-semibold" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}>
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          {waiting && !err && <div className="h-64 rounded-xl bg-slate-200/70 animate-pulse" />}
          {waiting && err && <p className="text-slate-500">This report could not be loaded. Try again in a moment.</p>}
          {d && current.id === "sales" && <SalesSummary d={d} period={period} />}
          {d && current.id === "items" && <ItemsSold d={d} period={period} />}
          {d && current.id === "payments" && <Payments d={d} period={period} />}
          {d && current.id === "vat" && <Vat d={d} period={period} />}
          {d && current.id === "staff" && <Staff d={d} period={period} />}
          {d && current.id === "cashups" && <CashUps d={d} period={period} />}
          {current.id === "owed" && <Owed />}
          {current.id === "stock" && <Stock />}
        </div>
      </div>
    </div>
  );
}
