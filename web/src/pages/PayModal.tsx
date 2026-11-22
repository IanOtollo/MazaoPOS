import { useState } from "react";
import { Banknote, BookUser, CreditCard, Landmark, Plus, Smartphone, X, type LucideIcon } from "lucide-react";
import { fmtKES, toCents } from "../../../shared/money";
import { post, useAuth, type Customer } from "../lib/api";
import { Button, ErrorLine, Field, Input, Modal, NumInput, Select, PinInput } from "../lib/ui";
import type { SaleDoc } from "../lib/Receipt";

type Method = "cash" | "mpesa" | "card" | "bank" | "credit";
interface Pay { method: Method; amount: number | null; reference: string }

const METHODS: { id: Method; label: string; Icon: LucideIcon }[] = [
  { id: "cash", label: "Cash", Icon: Banknote },
  { id: "mpesa", label: "M-Pesa", Icon: Smartphone },
  { id: "card", label: "Card", Icon: CreditCard },
  { id: "bank", label: "Bank", Icon: Landmark },
  { id: "credit", label: "Credit (pay later)", Icon: BookUser },
];

/** Round-up cash suggestions: exact, then the next 50/100/500/1000 notes above the amount. */
function quickCash(totalCents: number): number[] {
  const t = totalCents / 100;
  const set = new Set<number>([t]);
  for (const step of [50, 100, 500, 1000]) set.add(Math.ceil(t / step) * step);
  return [...set].filter((v) => v >= t).sort((a, b) => a - b).slice(0, 4);
}

export function PayModal({ total, customer, items, discount, approvalPin, onClose, onDone }: {
  total: number; customer: Customer | null; items: { productId: number; qtyMilli: number }[]; discount: number;
  approvalPin: string; onClose: () => void; onDone: (s: SaleDoc) => void;
}) {
  const { can } = useAuth();
  const [pin, setPin] = useState("");
  const [pays, setPays] = useState<Pay[]>([{ method: "cash", amount: total / 100, reference: "" }]);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const paid = pays.reduce((a, p) => a + toCents(p.amount ?? 0), 0);
  const remaining = total - paid;
  const cash = pays.filter((p) => p.method === "cash").reduce((a, p) => a + toCents(p.amount ?? 0), 0);
  const change = paid > total ? paid - total : 0;
  const canCredit = !!customer && customer.credit_limit_cents > 0 && !customer.credit_stopped && (customer.credit_available_cents ?? 0) > 0;
  const cur = pays[active];
  // handing over goods on loan needs a manager's say-so unless this role may do it alone
  const needsApproval = pays.some((p) => p.method === "credit" && toCents(p.amount ?? 0) > 0) && !can("sales.credit") && !approvalPin;

  const patch = (i: number, p: Partial<Pay>) => setPays((x) => x.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const needsRef = cur.method === "mpesa" || cur.method === "card" || cur.method === "bank";

  const submit = async () => {
    if (busy) return;
    setErr("");
    if (remaining > 0) return setErr(`KES ${fmtKES(remaining)} still to pay`);
    if (change > cash) return setErr("Only cash can be over-tendered");
    if (needsApproval && pin.length < 4) return setErr("Selling on account needs a manager's PIN");
    setBusy(true);
    try {
      const sale = await post<SaleDoc>("/api/sales", {
        items, customerId: customer?.id ?? null, discountCents: discount, approvalPin: pin || approvalPin || undefined,
        payments: pays.filter((p) => toCents(p.amount ?? 0) > 0)
          .map((p) => ({ method: p.method, amountCents: toCents(p.amount ?? 0), reference: p.reference || undefined })),
      });
      onDone(sale);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal wide title="Take payment" onClose={onClose}>
      <div className="grid md:grid-cols-[1fr_16rem] gap-6">
        <div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {METHODS.filter((m) => m.id !== "credit" || canCredit).map(({ id, label, Icon }) => (
              <button key={id} onClick={() => patch(active, { method: id })}
                className={`flex flex-col items-center gap-1.5 rounded-lg border-2 py-3 text-sm font-semibold transition-colors ${cur.method === id ? "border-accent bg-blue-50 text-accent" : "border-slate-200 text-slate-600 hover:border-slate-300"}`}>
                <Icon className="size-6" />{label}
              </button>
            ))}
          </div>

          <label className="block mt-4">
            <span className="text-sm font-medium text-slate-600">Amount received (KES)</span>
            <NumInput value={cur.amount} onChange={(n) => patch(active, { amount: n })} autoFocus className="num !text-3xl !font-bold !py-3 mt-1" />
          </label>

          {cur.method === "cash" && (
            <div className="flex flex-wrap gap-2 mt-3">
              {quickCash(Math.max(remaining + toCents(cur.amount ?? 0), 0) || total).map((v, i) => (
                <button key={v} onClick={() => patch(active, { amount: v })}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 font-semibold hover:bg-slate-50 num">
                  {i === 0 ? "Exact" : v.toLocaleString("en-KE")}
                </button>
              ))}
            </div>
          )}

          {needsRef && (
            <div className="mt-3">
              <Input placeholder={cur.method === "mpesa" ? "M-Pesa confirmation code, e.g. SHK4X9Y2AB" : "Reference / slip number"}
                value={cur.reference} onChange={(e) => patch(active, { reference: e.target.value.toUpperCase() })} />
            </div>
          )}
        </div>

        <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 flex flex-col">
          <div className="text-sm text-slate-500">Amount due</div>
          <div className="text-3xl font-bold tracking-tight">KES {fmtKES(total)}</div>

          <div className="mt-3 space-y-1.5">
            {pays.map((p, i) => (
              <div key={i} onClick={() => setActive(i)}
                className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm cursor-pointer ${i === active ? "bg-white border border-accent" : "border border-transparent hover:bg-white"}`}>
                <span className="font-medium capitalize">{p.method === "credit" ? "Credit (pay later)" : p.method}</span>
                <span className="flex items-center gap-2 num font-semibold">{fmtKES(toCents(p.amount ?? 0))}
                  {pays.length > 1 && (
                    <button onClick={(e) => { e.stopPropagation(); setPays((x) => x.filter((_, k) => k !== i)); setActive(0); }} aria-label="Remove payment" className="text-slate-400 hover:text-danger"><X className="size-4" /></button>
                  )}
                </span>
              </div>
            ))}
          </div>
          {remaining > 0 && (
            <button onClick={() => { setPays((x) => [...x, { method: "mpesa", amount: remaining / 100, reference: "" }]); setActive(pays.length); }}
              className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"><Plus className="size-4" />Split payment</button>
          )}

          <div className="mt-auto pt-4 border-t border-slate-200 mt-4">
            {remaining > 0 ? (
              <><div className="text-sm text-slate-500">Still to pay</div><div className="text-2xl font-bold text-danger num !text-left">KES {fmtKES(remaining)}</div></>
            ) : (
              <><div className="text-sm text-slate-500">{change > 0 ? "Change to give" : "Fully paid"}</div>
                <div className="text-3xl font-bold text-ok num !text-left">{change > 0 ? `KES ${fmtKES(change)}` : "✓"}</div></>
            )}
          </div>
        </div>
      </div>

      {needsApproval && (
        <div className="mt-3 border border-amber-200 bg-amber-50 rounded-lg p-3">
          <Field label="Manager PIN to approve credit" hint="Goods on account are only given with a manager's approval."><PinInput autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
        </div>
      )}
      <div className="mt-3"><ErrorLine msg={err} /></div>
      <Button variant="primary" onClick={submit} disabled={busy || remaining > 0}
        className="w-full !py-4 !text-lg !rounded-lg mt-3">
        {busy ? "Saving..." : "Complete sale"}
      </Button>
    </Modal>
  );
}
