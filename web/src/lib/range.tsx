import { useEffect, useState } from "react";
import { get, todayEAT } from "./api";
import { useLive } from "./live";

export interface Totals { sales: number; sales_cents: number; net_cents: number; vat_cents: number; discount_cents: number; refund_cents: number; cogs_cents: number | null; profit_cents: number | null }
export interface DashData {
  days: number; from: string; to: string; current: Totals; previous: Totals;
  series: { date: string; net_cents: number; sales: number }[];
  hours: { hour: number; sales: number }[];
  methods: { method: string; amount_cents: number }[];
  byVat: { vat_code: "A" | "B" | "E"; gross_cents: number; vat_cents: number }[];
  topItems: { name: string; unit: string; qty_milli: number; gross_cents: number }[];
  cashiers: { name: string; sales: number; net_cents: number }[];
  lowStock: { count: number; items: { id: number; name: string; unit: string; reorder_level_milli: number; stock_milli: number }[] };
  owing: { count: number; total_cents: number; top: { id: number; name: string; phone: string | null; balance_cents: number }[] };
  stockValue: { cost_cents: number; retail_cents: number } | null;
  openShifts: { id: number; cashier: string; opened_at: string; expected_cash_cents: number }[];
  closedShifts: { id: number; cashier: string; closed_at: string; expected_cash_cents: number; counted_cash_cents: number; variance_cents: number }[];
  recent: { id: number; receipt_no: string; kind: string; total_cents: number; created_at: string; cashier: string; customer_name: string | null }[];
}

const PRESETS = [{ days: 1, label: "Today" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }];
const dateInput = "border border-slate-300 rounded-lg px-3 py-1.5 bg-white text-sm font-medium";

/** Period selection shared by the Dashboard and Reports screens: presets or an exact date range. */
export function useRange() {
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [data, setData] = useState<DashData | null>(null);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  useLive(["sales", "stock", "customers", "shifts", "dashboard"], () => setTick((t) => t + 1));

  useEffect(() => {
    // while a custom range is half-typed or inverted, keep showing the last good result
    if (custom && (!custom.from || !custom.to || custom.from > custom.to)) return;
    let live = true;
    setErr("");
    const url = custom ? `/api/dashboard?from=${custom.from}&to=${custom.to}` : `/api/dashboard?days=${days}`;
    get<DashData>(url).then((r) => live && setData(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [days, custom, tick]);

  const span = data?.days ?? days;
  return {
    data, err, days, custom,
    vs: span === 1 ? "the day before" : `the previous ${span} days`,
    picker: <RangePicker days={days} custom={custom} setDays={setDays} setCustom={setCustom} />,
  };
}

export const fmtDay = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function RangePicker({ days, custom, setDays, setCustom }: { days: number; custom: { from: string; to: string } | null; setDays: (n: number) => void; setCustom: (c: { from: string; to: string } | null) => void }) {
  const pickCustom = () => {
    const to = todayEAT();
    const from = new Date(new Date(to + "T00:00:00Z").getTime() - 6 * 86400000).toISOString().slice(0, 10);
    setCustom({ from, to });
  };
  return (
    <>
      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist" aria-label="Period">
        {PRESETS.map((r) => (
          <button key={r.days} role="tab" aria-selected={!custom && days === r.days} onClick={() => { setCustom(null); setDays(r.days); }}
            className={`px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors ${!custom && days === r.days ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{r.label}</button>
        ))}
        <button role="tab" aria-selected={!!custom} onClick={() => (custom ? undefined : pickCustom())}
          className={`px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors ${custom ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>Custom</button>
      </div>
      {custom && (
        <div className="flex items-center gap-2">
          <input type="date" aria-label="From date" className={dateInput} value={custom.from} max={custom.to || todayEAT()} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <span className="text-slate-500">to</span>
          <input type="date" aria-label="To date" className={dateInput} value={custom.to} min={custom.from} max={todayEAT()} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
    </>
  );
}
