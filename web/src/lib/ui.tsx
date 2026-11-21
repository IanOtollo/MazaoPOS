import { Children, isValidElement, useEffect, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { notifyError } from "./notify";

export function Button({ variant = "default", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" }) {
  const v = {
    default: "bg-white border-slate-300 text-ink hover:bg-slate-50 shadow-card",
    primary: "bg-slate-900 border-slate-900 text-white hover:bg-slate-700 shadow-card",
    danger: "bg-white border-red-300 text-danger hover:bg-red-50",
  }[variant];
  return <button {...p} className={`border px-4 py-2.5 rounded-lg font-semibold transition-colors active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none ${v} ${className}`} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-gray-500 mt-1">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full border border-slate-300 rounded-lg px-3.5 py-2.5 bg-white transition-shadow";
export function Input(p: ComponentProps<"input">) {
  return <input {...p} className={`${inputCls} ${p.className ?? ""}`} />;
}

/** Decimal input that keeps the typed text and reports a number (or null). */
export function NumInput({ value, onChange, ...p }: { value: number | null; onChange: (n: number | null) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => {
    if ((text === "" ? null : Number(text)) !== value) setText(value == null ? "" : String(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input
      {...p}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const t = e.target.value;
        if (!/^\d*\.?\d*$/.test(t)) return;
        setText(t);
        onChange(t === "" || t === "." ? null : Number(t));
      }}
    />
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-start justify-center overflow-auto p-4">
      <div className={`modal-in bg-white rounded-xl shadow-pop w-full ${wide ? "max-w-3xl" : "max-w-lg"} mt-10`}>
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="font-bold text-xl tracking-tight">{title}</h2>
          <button onClick={onClose} className="h-8 w-8 rounded-lg text-xl leading-none text-slate-500 hover:bg-slate-100 hover:text-ink" aria-label="Close">×</button>
        </div>
        <div className="px-6 pb-6">{children}</div>
      </div>
    </div>
  );
}

/** Square icon-only button with a tooltip, for table row actions. */
export function IconButton({ label, children, danger, ...p }: { label: string; danger?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...p} title={label} aria-label={label}
      className={`size-9 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition-colors ${danger ? "hover:bg-red-50 hover:text-danger hover:border-red-200" : "hover:bg-blue-50 hover:text-accent hover:border-blue-200"}`}>
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-2 py-14 px-6">
      <span className="size-16 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center">{icon}</span>
      <p className="font-semibold text-slate-700 text-lg mt-1">{title}</p>
      {hint && <p className="text-sm text-slate-500 max-w-sm">{hint}</p>}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

interface Opt { value: string; label: ReactNode; disabled?: boolean }
function collectOptions(children: ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>;
    if (el.type === "option") out.push({ value: String(el.props.value ?? el.props.children ?? ""), label: el.props.children, disabled: el.props.disabled });
    else if (el.props.children) collectOptions(el.props.children, out);
  });
  return out;
}

/**
 * A styled dropdown. It is used exactly like a native <select> (same <option> children, same e.target.value),
 * but looks the same everywhere, works with the keyboard, and never opens the operating system's own menu.
 */
export function Select({ value, onChange, children, disabled, placeholder, "aria-label": ariaLabel }: {
  value: string | number; onChange: (e: { target: { value: string } }) => void; children: ReactNode;
  disabled?: boolean; placeholder?: string; "aria-label"?: string;
  className?: string; // accepted so a native <select> can be swapped in unchanged; the dropdown styles itself
}) {
  const options = collectOptions(children);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === String(value));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const pick = (o: Opt) => { if (o.disabled) return; onChange({ target: { value: o.value } }); setOpen(false); };
  const openList = () => { setActive(Math.max(0, options.findIndex((o) => o.value === String(value)))); setOpen(true); };

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); openList(); } return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (options[active]) pick(options[active]); }
    else if (e.key === "Tab") setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <button type="button" disabled={disabled} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKey}
        className="w-full flex items-center justify-between gap-2 border border-slate-300 rounded-lg px-3.5 py-2.5 bg-white text-left transition-shadow disabled:opacity-50 disabled:bg-slate-50">
        <span className={`truncate ${cur ? "" : "text-slate-400"}`}>{cur ? cur.label : placeholder ?? "Choose"}</span>
        <ChevronDown className={`size-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul role="listbox" className="absolute z-50 left-0 right-0 mt-1 max-h-64 overflow-auto bg-white border border-line rounded-lg shadow-pop py-1">
          {options.map((o, i) => (
            <li key={o.value + i} role="option" aria-selected={o.value === String(value)} aria-disabled={o.disabled}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)}
              className={`flex items-center justify-between gap-3 px-3.5 py-2 cursor-pointer ${i === active ? "bg-slate-100" : ""} ${o.disabled ? "opacity-40 cursor-not-allowed" : ""}`}>
              <span className="truncate">{o.label}</span>
              {o.value === String(value) && <Check className="size-4 shrink-0 text-slate-900" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shows an error as a pop-up at the top right instead of text inside the form. Draws nothing itself. */
export function ErrorLine({ msg }: { msg: string }) {
  useEffect(() => { if (msg) notifyError(msg); }, [msg]);
  return null;
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export const th = "text-left text-[11px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3 border-b border-line bg-slate-50";
export const td = "px-4 py-3 border-b border-slate-100";
