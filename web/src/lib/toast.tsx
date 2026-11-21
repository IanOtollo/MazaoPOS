import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
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
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), []);

  const answer = (v: boolean) => { ask?.resolve(v); setAsk(null); };

  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 print:hidden" aria-live="polite">
          {items.map((t) => {
            const Icon = t.kind === "err" ? AlertTriangle : t.kind === "info" ? Info : CheckCircle2;
            const tone = t.kind === "err" ? "text-red-400" : t.kind === "info" ? "text-sky-400" : "text-emerald-400";
            return (
              <div key={t.id} className="toast-in flex items-center gap-3 rounded-lg bg-slate-900 text-white pl-4 pr-2 py-2.5 shadow-pop min-w-64 max-w-[90vw]">
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
