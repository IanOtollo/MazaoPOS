import { useMemo, useState, type ReactNode } from "react";

export const kes0 = (c: number) => Math.round(c / 100).toLocaleString("en-KE");
export const METHOD: Record<string, string> = { cash: "Cash", mpesa: "M-Pesa", card: "Card", bank: "Bank", credit: "On account" };
const METHOD_SHADE = ["bg-slate-900", "bg-slate-600", "bg-slate-400", "bg-slate-300", "bg-slate-200"];

export function Card({ title, sub, badge, action, children }: { title: string; sub?: string; badge?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white border border-line rounded-xl shadow-card p-5">
      <header className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-semibold text-base flex items-center gap-2">{title}{badge !== undefined && badge > 0 && <span className="rounded-full bg-amber-100 text-amber-800 text-xs font-bold px-2 py-0.5">{badge}</span>}</h2>
          {sub && <p className="text-sm text-slate-500">{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Kpi({ label, value, unit, now, before, vs, note, invert, tone, spark }: { label: string; value: string; unit?: string; now?: number; before?: number; vs?: string; note?: string; invert?: boolean; tone?: "warn"; spark?: number[] | null }) {
  const pct = now !== undefined && before !== undefined && before > 0 ? ((now - before) / before) * 100 : null;
  const up = pct !== null && pct >= 0;
  const good = pct === null ? null : invert ? !up : up;
  return (
    <div className="relative bg-white border border-line rounded-xl shadow-card p-4">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-1.5">
        {unit && <span className="text-sm font-semibold text-slate-500">{unit}</span>}
        <span className={`text-2xl font-bold tracking-tight ${tone === "warn" ? "text-amber-700" : ""}`}>{value}</span>
      </div>
      <div className="mt-1 text-xs min-h-4">
        {pct !== null && Math.abs(pct) >= 0.1
          ? <span className={good ? "text-ok font-semibold" : "text-danger font-semibold"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}%<span className="text-slate-500 font-normal"> vs {vs}</span></span>
          : <span className="text-slate-500">{note ?? (pct === null && before === 0 && now ? `nothing in ${vs}` : "")}</span>}
        {pct !== null && Math.abs(pct) >= 0.1 && note && <span className="text-slate-500"> · {note}</span>}
      </div>
      {spark && spark.length > 1 && <div className="absolute top-3 right-3 w-20 h-8 hidden sm:block" aria-hidden><Sparkline values={spark} /></div>}
    </div>
  );
}

/** A tiny trend line with a soft fill, for the inside of a card. */
export function Sparkline({ values }: { values: number[] }) {
  const W = 120, H = 36, P = 2;
  const max = Math.max(...values), min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i: number) => P + (i * (W - 2 * P)) / (values.length - 1);
  const y = (v: number) => H - P - ((v - min) / span) * (H - 2 * P);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const flat = max === min;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full" preserveAspectRatio="none" aria-hidden>
      {!flat && <polygon points={`${x(0)},${H - P} ${pts} ${x(values.length - 1)},${H - P}`} fill="#e2e8f0" />}
      <polyline points={pts} fill="none" stroke={flat ? "#cbd5e1" : "#334155"} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function BarChart({ data, fmt, small }: { data: { label: string; value: number; tip: string }[]; fmt: (v: number) => string; small?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => Math.max(...data.map((x) => x.value), 1), [data]);
  const top = useMemo(() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; }, [max]);
  const W = 640, H = small ? 150 : 220, L = 36, B = 22, T = 8;
  const bw = (W - L) / data.length;
  const total = data.reduce((a, x) => a + x.value, 0);

  if (total === 0) return <p className="text-slate-500 py-10 text-center">No sales in this period yet.</p>;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Bar chart">
        {[0, 0.5, 1].map((f) => {
          const y = T + (H - T - B) * (1 - f);
          return <g key={f}><line x1={L} x2={W} y1={y} y2={y} stroke="#e2e8f0" /><text x={L - 6} y={y + 4} textAnchor="end" fontSize="11" fill="#64748b">{fmt(top * f)}</text></g>;
        })}
        {data.map((x, i) => {
          const h = (H - T - B) * (x.value / top);
          const showLabel = data.length <= 16 || i % Math.ceil(data.length / 12) === 0;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={L + i * bw} y={T} width={bw} height={H - T - B} fill="transparent" />
              <rect x={L + i * bw + bw * 0.18} y={H - B - h} width={bw * 0.64} height={Math.max(h, x.value > 0 ? 2 : 0)} rx="3" fill={hover === i ? "#0f172a" : "#334155"} />
              {showLabel && <text x={L + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="#64748b">{x.label}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-1 right-0 rounded-lg bg-slate-900 text-white text-xs font-medium px-3 py-1.5 shadow-pop">{data[hover].tip}</div>
      )}
    </div>
  );
}

export function PaymentMix({ methods }: { methods: { method: string; amount_cents: number }[] }) {
  const rows = methods.filter((m) => m.amount_cents > 0);
  const total = rows.reduce((a, m) => a + m.amount_cents, 0);
  if (!total) return <p className="text-slate-500 py-10 text-center">No payments in this period yet.</p>;
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-slate-100 mb-4" role="img" aria-label="Payment methods">
        {rows.map((m, i) => <div key={m.method} className={METHOD_SHADE[i % METHOD_SHADE.length]} style={{ width: `${(m.amount_cents / total) * 100}%` }} />)}
      </div>
      <ul className="space-y-2.5">
        {rows.map((m, i) => (
          <li key={m.method} className="flex items-center gap-3">
            <span className={`size-3 rounded-sm ${METHOD_SHADE[i % METHOD_SHADE.length]}`} />
            <span className="flex-1 font-medium">{METHOD[m.method] ?? m.method}</span>
            <span className="text-slate-500 text-sm w-12 text-right">{((m.amount_cents / total) * 100).toFixed(0)}%</span>
            <span className="num font-semibold w-28">KES {kes0(m.amount_cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Bars({ rows, empty }: { rows: { label: string; right: string; sub?: string; value: number }[]; empty: string }) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  if (!rows.length) return <p className="text-slate-500 py-6 text-center">{empty}</p>;
  return (
    <ul className="space-y-3.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium truncate">{r.label}</span>
            <span className="num font-semibold shrink-0">{r.right}</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 mt-1.5"><div className="h-full rounded-full bg-slate-700" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></div>
          {r.sub && <div className="text-xs text-slate-500 mt-1">{r.sub}</div>}
        </li>
      ))}
    </ul>
  );
}

export function List({ rows, empty }: { rows: { key: number | string; left: string; right?: string; sub?: string; bad?: boolean; warn?: boolean }[]; empty: string }) {
  if (!rows.length) return <p className="text-slate-500 py-6 text-center">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100 -my-2">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0"><div className="font-medium truncate">{r.left}</div>{r.sub && <div className="text-xs text-slate-500 truncate">{r.sub}</div>}</div>
          {r.right && <div className={`num font-semibold shrink-0 ${r.bad ? "text-danger" : r.warn ? "text-amber-700" : ""}`}>{r.right}</div>}
        </li>
      ))}
    </ul>
  );
}
