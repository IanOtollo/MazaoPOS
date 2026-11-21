import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { onNotifyError } from "./notify";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { Button, Modal } from "./ui";

interface ToastOpts { msg: string; kind?: "ok" | "err" | "info"; action?: { label: string; run: () => void } }
interface ToastItem extends ToastOpts { id: number }
interface ConfirmOpts { title: string; body?: string; confirmLabel?: string; danger?: boolean }

const ToastCtx = createContext<(t: ToastOpts) => void>(() => {});
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useToast = () => useContext(ToastCtx);
export const useConfirm = () => useContext(ConfirmCtx);

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [ask, setAsk] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []);
  const toast = useCallback((t: ToastOpts) => {
    const id = ++seq.current;
    setItems((x) => [...x.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.action ? 6000 : t.kind === "err" ? 6000 : 3200);
  }, [dismiss]);
  // errors raised by forms (ErrorLine) and the sign-in screen pop up here too
  useEffect(() => onNotifyError((msg) => toast({ msg, kind: "err" })), [toast]);
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), []);

  const answer = (v: boolean) => { ask?.resolve(v); setAsk(null); };

  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <div className="fixed top-4 right-4 left-4 sm:left-auto z-[70] flex flex-col items-end gap-2 print:hidden pointer-events-none" aria-live="polite">
          {items.map((t) => {
            const Icon = t.kind === "err" ? AlertTriangle : t.kind === "info" ? Info : CheckCircle2;
            const tone = t.kind === "err" ? "text-red-400" : t.kind === "info" ? "text-sky-400" : "text-emerald-400";
            return (
              <div key={t.id} className="toast-in pointer-events-auto flex items-center gap-3 rounded-lg bg-slate-900 text-white pl-4 pr-2 py-2.5 shadow-pop w-full sm:w-auto sm:min-w-72 sm:max-w-md">
                <Icon className={`size-5 shrink-0 ${tone}`} />
                <span className="font-medium flex-1">{t.msg}</span>
                {t.action && (
                  <button onClick={() => { t.action!.run(); dismiss(t.id); }} className="rounded-lg px-3 py-1.5 text-sm font-bold text-blue-300 hover:bg-slate-800">
                    {t.action.label}
                  </button>
                )}
                <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-800"><X className="size-4" /></button>
              </div>
            );
          })}
        </div>
        {ask && (
          <Modal title={ask.title} onClose={() => answer(false)}>
            {ask.body && <p className="text-slate-600 mb-5">{ask.body}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => answer(false)}>Cancel</Button>
              <Button variant={ask.danger ? "danger" : "primary"} onClick={() => answer(true)} autoFocus>{ask.confirmLabel ?? "Confirm"}</Button>
            </div>
          </Modal>
        )}
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}
