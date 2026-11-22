import { useEffect, useState } from "react";

/**
 * One instant name bubble for anything marked with data-tip (the collapsed sidebar's icons, the buttons at its top and bottom).
 * It shows on hover and on keyboard focus, sits to the right of the icon, and never blocks the mouse.
 */
export function SideTips() {
  const [tip, setTip] = useState<{ text: string; top: number; left: number } | null>(null);

  useEffect(() => {
    const show = (target: EventTarget | null) => {
      const el = (target as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;
      const text = el?.getAttribute("data-tip");
      if (!el || !text) return setTip(null);
      const r = el.getBoundingClientRect();
      setTip({ text, top: r.top + r.height / 2, left: r.right + 10 });
    };
    const hide = () => setTip(null);
    const over = (e: MouseEvent) => show(e.target);
    const focus = (e: FocusEvent) => show(e.target);
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("mouseleave", hide);
    document.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("keydown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("mouseleave", hide);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", hide);
    };
  }, []);

  if (!tip) return null;
  return (
    <span role="tooltip" style={{ position: "fixed", top: tip.top, left: tip.left, transform: "translateY(-50%)" }}
      className="z-[80] pointer-events-none whitespace-nowrap rounded-md bg-slate-900 px-2.5 py-1.5 text-sm font-semibold text-white shadow-pop print:hidden">
      {tip.text}
    </span>
  );
}
