import { Button } from "../../lib/ui";

export const kes = (cents: number) => `KES ${(cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "x to y of N" with First / Previous / Next / Last. Renders nothing when everything fits on one page. */
export function Pager({ page, total, size, noun, onPage }: { page: number; total: number; size: number; noun: string; onPage: (p: number) => void }) {
  if (total <= size) return null;
  const last = Math.max(0, Math.ceil(total / size) - 1);
  const n = (v: number) => v.toLocaleString("en-KE");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-3 text-sm text-slate-600" role="navigation" aria-label={`Pages of ${noun}`}>
      <span>{n(page * size + 1)} to {n(Math.min((page + 1) * size, total))} of {n(total)} {noun}</span>
      <div className="flex items-center gap-2">
        <Button onClick={() => onPage(0)} disabled={page === 0} className="!px-3">First</Button>
        <Button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} className="!px-3">Previous</Button>
        <span className="px-1 tabular-nums">Page {page + 1} of {last + 1}</span>
        <Button onClick={() => onPage(Math.min(last, page + 1))} disabled={page >= last} className="!px-3">Next</Button>
        <Button onClick={() => onPage(last)} disabled={page >= last} className="!px-3">Last</Button>
      </div>
    </div>
  );
}

export type StockStatus = "ok" | "low" | "out" | "dead";
const BADGE: Record<StockStatus, [string, string]> = {
  ok: ["In stock", "border-slate-300 text-slate-600"],
  low: ["Low", "border-amber-300 bg-amber-50 text-amber-800"],
  out: ["Out of stock", "border-red-300 bg-red-50 text-red-700"],
  dead: ["No recent sales", "border-slate-400 bg-slate-100 text-slate-700"],
};
/** A small text badge, not a coloured pill, so a long table stays calm. */
export function StatusBadge({ status }: { status: StockStatus }) {
  const [label, cls] = BADGE[status];
  return <span className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${cls}`}>{label}</span>;
}

/** Status of a row from what the list already knows. "Dead" needs sales history, so only the product page can tell. */
export function rowStatus(onHandMilli: number, reorderMilli: number): StockStatus {
  if (onHandMilli <= 0) return "out";
  if (reorderMilli > 0 && onHandMilli <= reorderMilli) return "low";
  return "ok";
}

/** The type written on each stock movement, in plain words. */
export const MOVE_LABEL: Record<string, string> = {
  purchase: "Delivery", sale: "Sale", sale_return: "Sale return", transfer_in: "Moved in", transfer_out: "Moved out",
  opening: "Opening stock", adjustment: "Stock count", damage: "Damage or loss",
};
export const moveLabel = (t: string) => MOVE_LABEL[t] ?? t;

export function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-white border border-line rounded-xl shadow-card p-4 min-w-0">
      <div className="text-sm text-slate-500">{label}</div>
      <div className={`text-xl font-bold tracking-tight mt-1 truncate ${warn ? "text-amber-700" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

/** A signed quantity: deliveries and returns show +, sales and losses show a minus in red. */
export function SignedQty({ milli, fmt }: { milli: number; fmt: (m: number) => string }) {
  return <span className={milli < 0 ? "text-danger" : ""}>{milli > 0 ? "+" : milli < 0 ? "−" : ""}{fmt(Math.abs(milli))}</span>;
}
