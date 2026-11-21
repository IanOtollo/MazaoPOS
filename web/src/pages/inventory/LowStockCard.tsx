import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fmtQty } from "../../../../shared/money";
import { get } from "../../lib/api";
import { useLive } from "../../lib/live";

interface Row { id: number; name: string; sku: string; unit: string; on_hand_milli: number; reorder_level_milli: number }

const WIDTH = 320;

/**
 * The "Low on stock" figure. Hover over it (or focus it with the keyboard, or tap it) to see which items are low.
 * The list loads when it is first opened and refreshes when stock changes.
 */
export function LowStockCard({ count, onShowAll }: { count: number; onShowAll: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    get<{ items: Row[] }>("/api/products/page?status=low&sort=stock&dir=asc&limit=8").then((r) => setRows(r.items)).catch(() => setRows([]));
  }, []);
  useEffect(() => { if (open) load(); }, [open, load]);
  useLive(["stock", "products"], () => { if (open) load(); });

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8)), top: r.bottom + 4 });
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const close = () => setOpen(false);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("keydown", esc); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open]);

  const warn = count > 0;
  return (
    <div ref={box} className="relative min-w-0" onMouseEnter={show} onMouseLeave={() => setOpen(false)}
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button ref={btn} type="button" aria-expanded={open} aria-controls="low-stock-list" onFocus={show} onClick={() => (open ? setOpen(false) : show())}
        className="w-full text-left bg-white border border-line rounded-xl shadow-card p-4 min-w-0 hover:border-slate-400 transition-colors">
        <div className="text-sm text-slate-500">Low on stock</div>
        <div className={`text-xl font-bold tracking-tight mt-1 ${warn ? "text-amber-700" : ""}`}>{count.toLocaleString("en-KE")}</div>
        <div className="text-xs text-slate-500 mt-0.5">{warn ? "Hover to see which items" : "Nothing is running low"}</div>
      </button>

      {open && pos && (
        <div id="low-stock-list" role="region" aria-label="Items low on stock" style={{ position: "fixed", left: pos.left, top: pos.top, width: WIDTH }}
          className="z-40 rounded-xl border border-slate-200 bg-white shadow-pop p-3">
          {rows === null && <p className="text-sm text-slate-500 py-2">Loading</p>}
          {rows && !rows.length && <p className="text-sm text-slate-500 py-2">No items are at or below their reorder level.</p>}
          {rows && rows.length > 0 && (
            <>
              <ul className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <li key={r.id}>
                    <Link to={`/inventory/${r.id}`} className="flex items-center justify-between gap-3 py-2 hover:bg-slate-50 rounded px-1">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold truncate">{r.name}</span>
                        <span className="block text-xs text-slate-500">Reorder at {fmtQty(r.reorder_level_milli)} {r.unit}</span>
                      </span>
                      <span className={`shrink-0 text-sm font-semibold tabular-nums ${r.on_hand_milli <= 0 ? "text-danger" : "text-amber-700"}`}>
                        {r.on_hand_milli <= 0 ? "Out" : `${fmtQty(r.on_hand_milli)} ${r.unit}`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {count > rows.length && <p className="text-xs text-slate-500 px-1 pt-2">and {(count - rows.length).toLocaleString("en-KE")} more</p>}
              <button type="button" onClick={() => { onShowAll(); setOpen(false); }} className="mt-2 w-full rounded-lg border border-slate-300 py-1.5 text-sm font-semibold hover:bg-slate-50">Show all low stock items</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
