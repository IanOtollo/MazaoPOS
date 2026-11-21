import { useEffect, useState, type ButtonHTMLAttributes, type ComponentProps, type InputHTMLAttributes, type ReactNode } from "react";

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

export function ErrorLine({ msg }: { msg: string }) {
  return msg ? <p className="text-danger text-sm font-medium" role="alert">{msg}</p> : null;
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
