import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { LucideIcon } from "lucide-react";

export interface NavPage { to: string; label: string; Icon: LucideIcon; active: boolean; badge?: number; tone?: "amber" | "rose" }
export interface NavGroup { label: string; Icon: LucideIcon; pages: NavPage[] }

/** Bar height: taller and navy on phones, slimmer and white from md up. index.css defines --bar-h; the page footer reserves the same space. */
const menuWidth = () => (window.innerWidth < 768 ? 256 : 224);

const badgeCls = (tone?: "amber" | "rose") => (tone === "rose" ? "bg-rose-600 text-white" : "bg-amber-500 text-white");

/**
 * The main navigation: a bar along the bottom of the screen with one tab per section.
 * A section with one page goes straight there; a section with several opens a small menu above the bar.
 * `hidden` (scrolling down) slides the bar away; it stays up while a menu is open or the keyboard is inside it.
 * `onVisible` reports whether the bar is really showing, so the page footer can move with it.
 */
export function BottomBar({ groups, hidden, onVisible }: { groups: NavGroup[]; hidden: boolean; onVisible: (v: boolean) => void }) {
  const loc = useLocation();
  const [open, setOpen] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<{ left: number; width: number } | null>(null);
  const root = useRef<HTMLElement>(null);

  const visible = !hidden || open !== null || focused;
  useEffect(() => { onVisible(visible); }, [visible, onVisible]);

  // a menu closes when you go somewhere, click away, press Escape or scroll
  useEffect(() => { setOpen(null); }, [loc.pathname, loc.search]);
  useEffect(() => {
    if (open === null) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    const close = () => setOpen(null);
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // the tab is a big touch target; the pill inside it carries the colours
  const tab = "flex-1 md:flex-none min-w-12 md:min-w-24 h-16 md:h-14 flex items-center justify-center px-0.5 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2";
  const pill = (active: boolean) =>
    `relative flex flex-col items-center justify-center gap-0.5 min-w-14 md:min-w-0 w-full max-w-24 md:max-w-none h-14 md:h-12 rounded-2xl md:rounded-xl px-2 text-[11px] font-semibold transition-colors ${
      active ? "bg-accent text-white md:bg-blue-50 md:text-accent-dark" : "text-slate-300 hover:text-white md:text-slate-600 md:hover:text-slate-900 md:hover:bg-slate-100"
    }`;

  const shown = groups.filter((g) => g.pages.length > 0);
  const openGroup = shown.find((g) => g.label === open);

  return (
    <nav ref={root} aria-label="Main"
      onFocus={() => setFocused(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false); }}
      className={`side fixed inset-x-0 bottom-0 z-40 bg-side md:bg-white border-t border-white/10 shadow-[0_-8px_24px_rgba(15,23,42,0.28)] pb-[env(safe-area-inset-bottom)] md:inset-x-auto md:left-1/2 md:-translate-x-1/2 md:bottom-4 md:w-max md:max-w-[calc(100vw-2rem)] md:rounded-2xl md:border md:border-slate-200 md:shadow-[0_14px_36px_rgba(15,23,42,0.20)] md:pb-0 print:hidden transition-[transform,opacity] duration-300 ease-out ${visible ? "" : "translate-y-full opacity-0 pointer-events-none"}`}>
      <div className="mx-auto flex max-w-3xl md:px-1.5">
        {shown.map((g) => {
          const active = g.pages.some((p) => p.active);
          const badge = g.pages.reduce((n, p) => n + (p.badge ?? 0), 0);
          const tone = g.pages.find((p) => (p.badge ?? 0) > 0)?.tone;
          const inner = (
            <>
              
              <span className="relative">
                <g.Icon className="size-6 md:size-5" aria-hidden />
                {badge > 0 && <span className={`absolute -top-1.5 -right-3 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 text-center font-bold ring-2 ring-side md:ring-white ${badgeCls(tone)}`}>{badge > 99 ? "99+" : badge}</span>}
              </span>
              <span className="truncate max-w-full">{g.label}</span>
            </>
          );
          if (g.pages.length === 1) {
            return <NavLink key={g.label} to={g.pages[0].to} aria-current={active ? "page" : undefined} className={tab}><span className={pill(active)}>{inner}</span></NavLink>;
          }
          return (
            <button key={g.label} type="button" aria-haspopup="menu" aria-expanded={open === g.label} className={tab}
              onClick={(e) => {
                if (open === g.label) return setOpen(null);
                const r = e.currentTarget.getBoundingClientRect();
                const width = menuWidth();
                setPos({ width, left: Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8)) });
                setOpen(g.label);
              }}>
              <span className={pill(active || open === g.label)}>{inner}</span>
            </button>
          );
        })}
      </div>

      {openGroup && pos && (
        <div role="menu" aria-label={openGroup.label} style={{ left: pos.left, width: pos.width, bottom: "calc(var(--bar-h) + env(safe-area-inset-bottom) + 0.5rem)" }}
          className="modal-in fixed z-50 rounded-2xl md:rounded-xl border border-slate-200 bg-white p-1.5 shadow-pop">
          <div className="px-3 pt-1.5 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">{openGroup.label}</div>
          {openGroup.pages.map((p) => (
            <NavLink key={p.to} to={p.to} role="menuitem" aria-current={p.active ? "page" : undefined}
              className={`flex items-center gap-3 h-12 md:h-auto rounded-lg px-3 md:py-2.5 text-sm font-semibold transition-colors ${p.active ? "bg-blue-50 text-accent-dark" : "text-slate-800 hover:bg-slate-50"}`}>
              <p.Icon className="size-5 shrink-0" aria-hidden />
              <span className="flex-1">{p.label}</span>
              {(p.badge ?? 0) > 0 && <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${p.tone === "rose" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>{p.badge}</span>}
            </NavLink>
          ))}
        </div>
      )}
    </nav>
  );
}
