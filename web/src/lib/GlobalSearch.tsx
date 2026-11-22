import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { fmtKES } from "../../../shared/money";
import { get } from "./api";

export interface SearchPage { label: string; to: string; also?: string }
interface Item { id: number; name: string; sku: string; price_retail_cents: number }
interface Hit { key: string; kind: "page" | "item"; label: string; sub?: string; right?: string; to: string }

const WIDTH = 352;

/**
 * Search for a page or a product from anywhere. Press / to jump here, use the arrow keys and Enter, Esc to close.
 * Pages are limited to the ones this person's role can open.
 */
export function GlobalSearch({ pages, onExpand = () => {}, collapsed = false, tone = "light" }: { pages: SearchPage[]; onExpand?: () => void; collapsed?: boolean; tone?: "light" | "dark" }) {
  const nav = useNavigate();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [at, setAt] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const term = q.trim().toLowerCase();
  const pageHits: Hit[] = useMemo(() => {
    if (!term) return [];
    const words = term.split(/\s+/);
    return pages
      .filter((p) => words.every((w) => `${p.label} ${p.also ?? ""}`.toLowerCase().includes(w)))
      .slice(0, 5)
      .map((p) => ({ key: `p:${p.to}`, kind: "page", label: p.label, to: p.to }));
  }, [pages, term]);

  // products: wait for a pause in typing, and ignore answers that arrive late
  const seq = useRef(0);
  useEffect(() => {
    if (!term) { setItems([]); setTotal(0); return; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      get<{ items: Item[]; total: number }>(`/api/products/page?q=${encodeURIComponent(q.trim())}&limit=6`)
        .then((r) => { if (mine === seq.current) { setItems(r.items); setTotal(r.total); } })
        .catch(() => { if (mine === seq.current) { setItems([]); setTotal(0); } });
    }, 180);
    return () => clearTimeout(t);
  }, [q, term]);

  const itemHits: Hit[] = items.map((p) => ({ key: `i:${p.id}`, kind: "item", label: p.name, sub: p.sku, right: fmtKES(p.price_retail_cents), to: `/inventory/${p.id}` }));
  const hits = [...pageHits, ...itemHits];
  useEffect(() => { setAt(0); }, [q, items.length]);

  const place = () => {
    const r = input.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.min(WIDTH, window.innerWidth - 16) - 8)), top: r.bottom + 6 });
  };
  const go = (h: Hit | undefined) => {
    if (!h) return;
    nav(h.to);
    setQ(""); setOpen(false); input.current?.blur();
  };

  // "/" or Ctrl+K from anywhere (outside a text box)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const wantsSearch = ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) && !document.querySelector('[aria-modal="true"]');
      if (!wantsSearch) return;
      e.preventDefault();
      if (collapsed) { onExpand(); return; }
      input.current?.focus();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [collapsed, onExpand]);

  if (collapsed) {
    return (
      <button onClick={onExpand} data-tip="Search items and pages" aria-label="Search items and pages"
        className="mx-auto size-10 rounded-lg flex items-center justify-center text-slate-300 hover:bg-white/10 hover:text-white">
        <Search className="size-5" aria-hidden />
      </button>
    );
  }

  const showPanel = open && term.length > 0 && pos;
  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-400 pointer-events-none" aria-hidden />
      <input
        ref={input} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); place(); }}
        onFocus={() => { setOpen(true); place(); }} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setAt((n) => Math.min(hits.length - 1, n + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setAt((n) => Math.max(0, n - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); go(hits[at]); }
          else if (e.key === "Escape") { setQ(""); setOpen(false); input.current?.blur(); }
        }}
        role="combobox" aria-expanded={!!showPanel} aria-controls={listId} aria-autocomplete="list" aria-label="Search items and pages"
        placeholder="Search items or pages" autoComplete="off"
        className={`w-full rounded-lg border pl-9 pr-8 py-2 text-sm ${tone === "dark" ? "border-white/15 bg-white/10 text-white placeholder:text-slate-400 focus:bg-white/15 focus:border-white/40" : "border-slate-300 bg-slate-50 text-ink placeholder:text-slate-500 focus:bg-white"}`}
      />
      <kbd className={`absolute right-2 top-1/2 -translate-y-1/2 rounded border px-1.5 text-[10px] font-semibold pointer-events-none ${tone === "dark" ? "border-white/20 text-slate-400" : "border-slate-300 text-slate-500"}`}>/</kbd>

      {showPanel && (
        <div id={listId} role="listbox" style={{ position: "fixed", left: pos.left, top: pos.top, width: Math.min(WIDTH, window.innerWidth - 16) }}
          className="z-[60] max-h-[70vh] overflow-auto rounded-xl border border-slate-200 bg-white text-ink shadow-pop p-1.5">
          {!hits.length && <p className="px-3 py-4 text-sm text-slate-500 text-center">Nothing matches "{q.trim()}".</p>}
          {(["page", "item"] as const).map((kind) => {
            const group = hits.filter((h) => h.kind === kind);
            if (!group.length) return null;
            return (
              <div key={kind}>
                <div className="px-3 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">{kind === "page" ? "Pages" : "Items"}</div>
                {group.map((h) => {
                  const i = hits.indexOf(h);
                  return (
                    <div key={h.key} role="option" aria-selected={i === at} onMouseDown={(e) => { e.preventDefault(); go(h); }} onMouseEnter={() => setAt(i)}
                      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 cursor-pointer ${i === at ? "bg-blue-50" : ""}`}>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold truncate">{h.label}</span>
                        {h.sub && <span className="block text-xs text-slate-500 truncate">{h.sub}</span>}
                      </span>
                      {h.right && <span className="shrink-0 text-sm font-semibold tabular-nums text-slate-700">{h.right}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {total > items.length && <p className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100 mt-1">Showing {items.length} of {total.toLocaleString("en-KE")} items. Keep typing to narrow it down.</p>}
        </div>
      )}
    </div>
  );
}
