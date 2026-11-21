import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageCircle, Phone, Plus, Printer } from "lucide-react";
import { fmtKES, toCents } from "../../../shared/money";
import { apiUrl, fmtTime, get, patch, post, useAuth, type Customer } from "../lib/api";
import { fmtDay } from "../lib/range";
import { useToast } from "../lib/toast";
import { useLive } from "../lib/live";
import { Button, EmptyState, ErrorLine, Field, Input, Modal, NumInput, PageHead, inputCls, td, th, Select } from "../lib/ui";

export type Buckets = { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
interface RecRow {
  id: number; name: string; phone: string | null; tier: string; credit_limit_cents: number; credit_days: number;
  balance_cents: number; overdue_cents: number; max_days_overdue: number; last_payment_at: string | null; credit_stopped: number;
  next_promise: { date: string; cents: number | null } | null; promise_broken: boolean;
}
interface Rec { totals: { owed_cents: number; overdue_cents: number; customers: number; overdue_customers: number; buckets: Buckets }; customers: RecRow[] }
interface Account {
  customer: { id: number; name: string; phone: string | null; kra_pin: string | null; tier: string; credit_limit_cents: number; credit_days: number; credit_stopped: number };
  balance_cents: number;
  ageing: { balance_cents: number; items: { ledger_id: number; date: string; due: string; amount_cents: number; receipt_no: string | null; days_overdue: number }[]; buckets: Buckets; overdue_cents: number; max_days_overdue: number };
  statement: { id: number; amount_cents: number; type: string; method: string | null; note: string | null; created_at: string; receipt_no: string | null; cashier: string | null; approver: string | null; balance_cents: number }[];
  notes: { id: number; kind: string; body: string; promise_date: string | null; promise_cents: number | null; created_at: string; user: string | null }[];
}

type View = "all" | "owing" | "overdue";

export default function Customers() {
  const { can } = useAuth();
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [all, setAll] = useState<Customer[]>([]);
  const [rec, setRec] = useState<Rec | null>(null);
  const [edit, setEdit] = useState<Customer | "new" | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(() => {
    get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}`).then(setAll);
    get<Rec>("/api/receivables").then(setRec);
  }, [q]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  useLive(["customers", "sales"], load);

  const needle = q.trim().toLowerCase();
  const owingRows = useMemo(
    () => (rec?.customers ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle) || (c.phone ?? "").includes(needle)),
    [rec, needle],
  );
  const shown = view === "overdue" ? owingRows.filter((c) => c.overdue_cents > 0) : owingRows;

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <PageHead title="Customers">
        <Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} className="!w-56 sm:!w-64" />
        {can("customers.create") && <Button variant="primary" onClick={() => setEdit("new")} className="flex items-center gap-1.5"><Plus className="size-4" />Register customer</Button>}
      </PageHead>

      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 mb-4" role="tablist" aria-label="Show">
        {([["all", "All"], ["owing", `Owing${rec?.totals.customers ? ` (${rec.totals.customers})` : ""}`], ["overdue", `Defaulters${rec?.totals.overdue_customers ? ` (${rec.totals.overdue_customers})` : ""}`]] as [View, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={view === id} onClick={() => setView(id)}
            className={`px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors ${view === id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
        ))}
      </div>

      {view !== "all" && rec && rec.totals.customers > 0 && (
        <div className="bg-white border border-line rounded-xl shadow-card p-4 mb-4">
          <div className="flex flex-wrap gap-x-8 gap-y-2 mb-3">
            <div><div className="text-sm text-slate-500">Owed to you</div><div className="text-2xl font-bold">KES {fmtKES(rec.totals.owed_cents)}</div></div>
            <div><div className="text-sm text-slate-500">Past due date</div><div className={`text-2xl font-bold ${rec.totals.overdue_cents > 0 ? "text-danger" : ""}`}>KES {fmtKES(rec.totals.overdue_cents)}</div></div>
          </div>
          <AgeingBar b={rec.totals.buckets} />
        </div>
      )}

      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        {view === "all" ? (
          <table className="w-full">
            <thead><tr><th className={th}>Customer</th><th className={`${th} hidden sm:table-cell`}>Price tier</th><th className={`${th} text-right hidden md:table-cell`}>Credit limit</th><th className={`${th} text-right`}>Owes</th></tr></thead>
            <tbody>
              {all.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(c.id)}>
                  <td className={td}><div className="font-medium">{c.name}{!!c.credit_stopped && <span className="ml-2 rounded-full px-2 py-0.5 text-xs font-bold bg-slate-800 text-white">Credit stopped</span>}</div><div className="text-xs text-slate-500">{c.phone}</div></td>
                  <td className={`${td} capitalize hidden sm:table-cell`}>{c.tier}</td>
                  <td className={`${td} num hidden md:table-cell`}>{c.credit_limit_cents ? fmtKES(c.credit_limit_cents) : "-"}</td>
                  <td className={`${td} num ${c.balance_cents > 0 ? "font-semibold" : "text-slate-400"}`}>{c.balance_cents > 0 ? fmtKES(c.balance_cents) : "-"}</td>
                </tr>
              ))}
              {!all.length && <tr><td colSpan={4}><EmptyState icon={<Phone className="size-8" />} title={q ? "No customers match" : "No customers registered yet"} hint={q ? undefined : "Only people who buy on credit or get special prices are registered here. Walk-in customers need no record. Set how much someone may borrow and how long they have to pay, and the system tracks what they owe."} /></td></tr>}
            </tbody>
          </table>
        ) : (
          <table className="w-full">
            <thead><tr><th className={th}>Customer</th><th className={`${th} text-right`}>Owes</th><th className={th}>Status</th><th className={`${th} hidden md:table-cell`}>Last payment</th></tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(c.id)}>
                  <td className={td}><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.phone}</div></td>
                  <td className={`${td} num font-semibold`}>{fmtKES(c.balance_cents)}</td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1.5">
                      {c.max_days_overdue > 0
                        ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${c.max_days_overdue > 30 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{c.max_days_overdue} days late</span>
                        : <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-slate-100 text-slate-600">Not due yet</span>}
                      {c.promise_broken && <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-red-100 text-red-700">Promise missed</span>}
                      {!!c.credit_stopped && <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-slate-800 text-white">Credit stopped</span>}
                      {c.next_promise && <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-blue-50 text-blue-700">Promised {fmtDay(c.next_promise.date)}</span>}
                    </div>
                  </td>
                  <td className={`${td} text-slate-500 hidden md:table-cell`}>{c.last_payment_at ? fmtTime(c.last_payment_at) : "never"}</td>
                </tr>
              ))}
              {!shown.length && <tr><td colSpan={4}><EmptyState icon={<Phone className="size-8" />} title={view === "overdue" ? "No defaulters" : "Nobody owes you anything"} hint="Customers appear here when they take goods on credit." /></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {edit && <CustomerForm c={edit === "new" ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {open && <AccountView id={open} onClose={() => setOpen(null)} onChanged={load} onEdit={(c) => { setOpen(null); setEdit(c); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- ageing bar
const SEG: { key: keyof Buckets; label: string; cls: string }[] = [
  { key: "current", label: "Not due", cls: "bg-slate-300" },
  { key: "d1_30", label: "1-30 days late", cls: "bg-amber-300" },
  { key: "d31_60", label: "31-60", cls: "bg-amber-500" },
  { key: "d61_90", label: "61-90", cls: "bg-orange-600" },
  { key: "d90plus", label: "Over 90", cls: "bg-red-600" },
];
export function AgeingBar({ b }: { b: Buckets }) {
  const total = SEG.reduce((a, s) => a + b[s.key], 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100" role="img" aria-label="How late the debts are">
        {SEG.map((s) => b[s.key] > 0 && <div key={s.key} className={s.cls} style={{ width: `${(b[s.key] / total) * 100}%` }} />)}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-sm">
        {SEG.map((s) => b[s.key] > 0 && (
          <li key={s.key} className="flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${s.cls}`} /><span className="text-slate-600">{s.label}</span><span className="font-semibold num">{fmtKES(b[s.key])}</span></li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- add / edit
function CustomerForm({ c, onClose, onSaved }: { c: Customer | null; onClose: () => void; onSaved: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const mgr = can("customers.manage");
  const [f, setF] = useState({
    name: c?.name ?? "", phone: c?.phone ?? "", tier: c?.tier ?? "retail", stopped: !!c?.credit_stopped,
    limit: c ? c.credit_limit_cents / 100 : (null as number | null), days: c?.credit_days ?? 30,
  });
  const [err, setErr] = useState("");
  const save = async () => {
    if (!f.name.trim()) return setErr("Name is required");
    const body = { name: f.name.trim(), phone: f.phone || null, tier: f.tier, creditLimitCents: toCents(f.limit ?? 0), creditDays: f.days, ...(mgr ? { creditStopped: f.stopped } : {}) };
    try { if (c) await patch(`/api/customers/${c.id}`, body); else await post("/api/customers", body); toast({ msg: c ? "Customer updated" : "Customer added" }); onSaved(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={c ? "Edit customer" : "Register customer"} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        {mgr && (
          <>
            <Field label="Price tier"><Select className={inputCls} value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value as Customer["tier"] })}><option value="retail">Retail</option><option value="contractor">Contractor</option><option value="wholesale">Wholesale</option></Select></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Credit limit (KES)" hint="0 means no credit"><NumInput value={f.limit} onChange={(n) => setF({ ...f, limit: n })} /></Field>
              <Field label="Days to pay" hint="Debts are late after this"><NumInput value={f.days} onChange={(n) => setF({ ...f, days: Math.min(365, Math.round(n ?? 0)) })} /></Field>
            </div>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.stopped} onChange={(e) => setF({ ...f, stopped: e.target.checked })} /><span><span className="font-medium">Stop giving this person credit</span><span className="block text-sm text-slate-500">They can still pay cash and pay off what they owe.</span></span></label>
          </>
        )}
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- one customer's account
const KIND: Record<string, string> = { note: "Note", call: "Phone call", visit: "Visit", promise: "Promise to pay" };

function AccountView({ id, onClose, onChanged, onEdit }: { id: number; onClose: () => void; onChanged: () => void; onEdit: (c: Customer) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const [a, setA] = useState<Account | null>(null);
  const [biz, setBiz] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<"statement" | "followups">("statement");
  const [pay, setPay] = useState(false);
  const load = useCallback(() => get<Account>(`/api/customers/${id}/account`).then(setA), [id]);
  useEffect(() => { load(); get("/api/settings").then(setBiz); }, [load]);
  useLive(["customers", "sales"], load);
  if (!a) return null;

  const c = a.customer;
  const used = c.credit_limit_cents > 0 ? Math.min(100, (Math.max(0, a.balance_cents) / c.credit_limit_cents) * 100) : 0;
  const changed = () => { load(); onChanged(); };

  // a friendly reminder the user can send on WhatsApp (nothing is sent until they press Send there)
  const wa = (() => {
    if (!c.phone || a.balance_cents <= 0) return null;
    let n = c.phone.replace(/\D/g, "");
    if (n.startsWith("0")) n = "254" + n.slice(1);
    const late = a.ageing.overdue_cents > 0 ? ` KES ${fmtKES(a.ageing.overdue_cents)} of it is past its due date.` : "";
    const text = `Hello ${c.name}, this is a friendly reminder from ${biz.business_name || "us"}. Your account balance is KES ${fmtKES(a.balance_cents)}.${late} Please arrange payment when you can. Thank you.`;
    return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
  })();

  return (
    <Modal wide title={c.name} onClose={onClose}>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <div className="text-sm text-slate-500">{[c.phone, `${c.tier} prices`, `pays within ${c.credit_days} days`].filter(Boolean).join("  ·  ")}</div>
          <div className="text-3xl font-bold tracking-tight mt-1">KES {fmtKES(Math.max(0, a.balance_cents))}<span className="text-base font-medium text-slate-500"> owed</span></div>
          {a.balance_cents < 0 && <div className="text-sm text-ok font-medium">Customer is in credit by KES {fmtKES(-a.balance_cents)}</div>}
          {c.credit_limit_cents > 0 && (
            <div className="mt-2 w-60 max-w-full">
              <div className="h-1.5 rounded-full bg-slate-100"><div className={`h-full rounded-full ${used > 90 ? "bg-red-600" : used > 70 ? "bg-amber-500" : "bg-slate-700"}`} style={{ width: `${used}%` }} /></div>
              <div className="text-xs text-slate-500 mt-1">{used.toFixed(0)}% of the KES {fmtKES(c.credit_limit_cents)} limit used</div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {can("customers.payment") && a.balance_cents > 0 && <Button variant="primary" onClick={() => setPay((p) => !p)}>Record payment</Button>}
          {wa && <a href={wa} target="_blank" rel="noreferrer" className="border px-4 py-2.5 rounded-lg font-semibold bg-white border-slate-300 hover:bg-slate-50 shadow-card flex items-center gap-1.5"><MessageCircle className="size-4" />Remind</a>}
          <Button onClick={() => window.print()} className="flex items-center gap-1.5"><Printer className="size-4" />Statement</Button>
          {can("customers.manage") && <Button onClick={() => onEdit({ ...c, balance_cents: a.balance_cents } as Customer)}>Edit</Button>}
        </div>
      </div>

      {a.balance_cents > 0 && <div className="mb-4"><AgeingBar b={a.ageing.buckets} /></div>}
      {pay && <PayForm id={id} max={a.balance_cents} onDone={() => { setPay(false); toast({ msg: "Payment recorded" }); changed(); }} />}

      <div className="flex gap-1 border-b border-slate-200 mb-3" role="tablist">
        {([["statement", "Statement"], ["followups", `Follow-ups${a.notes.length ? ` (${a.notes.length})` : ""}`]] as ["statement" | "followups", string][]).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-4 py-2 font-semibold -mb-px border-b-2 ${tab === t ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-900"}`}>{label}</button>
        ))}
      </div>

      {tab === "statement" ? (
        <StatementTable lines={a.statement} />
      ) : (
        <FollowUps id={id} notes={a.notes} canLog={can("customers.manage")} onLogged={() => { toast({ msg: "Follow-up saved" }); changed(); }} />
      )}

      {/* printed version, shown only when printing */}
      <div className="print-area hidden print:block text-[12px] text-black">
        {biz.logo_version && <img src={apiUrl(`/api/logo?v=${biz.logo_version}`)} alt="" style={{ maxHeight: 56, marginBottom: 6 }} />}
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>{biz.business_name}</h1>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginTop: 14 }}>Statement of account</h2>
        <div>{c.name}{c.phone ? `  ·  ${c.phone}` : ""}</div>
        <div>Printed {fmtDay(new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10))}</div>
        <div style={{ marginTop: 10, fontSize: 15 }}><strong>Balance due: KES {fmtKES(Math.max(0, a.balance_cents))}</strong>{a.ageing.overdue_cents > 0 && `  (KES ${fmtKES(a.ageing.overdue_cents)} past due)`}</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
          <thead><tr style={{ borderBottom: "1px solid #000", textAlign: "left" }}><th>Date</th><th>Details</th><th style={{ textAlign: "right" }}>Amount</th><th style={{ textAlign: "right" }}>Balance</th></tr></thead>
          <tbody>
            {a.statement.map((l) => (
              <tr key={l.id} style={{ borderBottom: "1px solid #ddd" }}>
                <td>{new Date(l.created_at).toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", year: "numeric" })}</td>
                <td>{describe(l)}</td>
                <td style={{ textAlign: "right" }}>{fmtKES(l.amount_cents)}</td>
                <td style={{ textAlign: "right" }}>{fmtKES(l.balance_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

function describe(l: Account["statement"][number]) {
  if (l.type === "credit_sale") return `Credit sale${l.receipt_no ? ` ${l.receipt_no}` : ""}`;
  if (l.type === "payment") return `Payment${l.method ? ` (${l.method})` : ""}${l.note ? ` ${l.note}` : ""}`;
  if (l.type === "return") return "Refund to account";
  return "Adjustment";
}

function StatementTable({ lines }: { lines: Account["statement"] }) {
  if (!lines.length) return <p className="text-slate-500 py-6 text-center">Nothing on this account yet.</p>;
  return (
    <div className="max-h-80 overflow-auto border border-line rounded-lg">
      <table className="w-full">
        <thead><tr><th className={th}>Date</th><th className={th}>Details</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>Balance</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td className={`${td} whitespace-nowrap`}>{fmtTime(l.created_at)}</td>
              <td className={td}>{describe(l)}{l.type === "credit_sale" && (l.cashier || l.approver) && <div className="text-xs text-slate-500">{[l.cashier && `served by ${l.cashier}`, l.approver && `approved by ${l.approver}`].filter(Boolean).join(", ")}</div>}</td>
              <td className={`${td} num ${l.amount_cents < 0 ? "text-ok" : ""}`}>{fmtKES(l.amount_cents)}</td>
              <td className={`${td} num font-medium`}>{fmtKES(l.balance_cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PayForm({ id, max, onDone }: { id: number; max: number; onDone: () => void }) {
  const [amt, setAmt] = useState<number | null>(null);
  const [method, setMethod] = useState("cash");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    if (!amt) return setErr("Enter the amount received");
    try { await post(`/api/customers/${id}/payment`, { amountCents: toCents(amt), method, reference: ref || undefined }); onDone(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="border border-line rounded-lg p-3 mb-4 bg-slate-50">
      <div className="grid sm:grid-cols-[1fr_9rem_1fr_auto] gap-3 items-end">
        <Field label="Amount received (KES)"><NumInput value={amt} onChange={setAmt} autoFocus placeholder={fmtKES(max)} /></Field>
        <Field label="Paid by"><Select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="card">Card</option></Select></Field>
        <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} placeholder={method === "mpesa" ? "M-Pesa code" : "optional"} /></Field>
        <Button variant="primary" onClick={go}>Save</Button>
      </div>
      <div className="mt-2"><ErrorLine msg={err} /></div>
    </div>
  );
}

function FollowUps({ id, notes, canLog, onLogged }: { id: number; notes: Account["notes"]; canLog: boolean; onLogged: () => void }) {
  const [kind, setKind] = useState("call");
  const [body, setBody] = useState("");
  const [date, setDate] = useState("");
  const [amt, setAmt] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const save = async () => {
    try {
      await post(`/api/customers/${id}/notes`, { kind, body, ...(kind === "promise" ? { promiseDate: date || undefined, promiseCents: amt ? toCents(amt) : undefined } : {}) });
      setBody(""); setDate(""); setAmt(null); setErr(""); onLogged();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div>
      {canLog && (
        <div className="border border-line rounded-lg p-3 mb-4 bg-slate-50 space-y-3">
          <div className="grid sm:grid-cols-[10rem_1fr] gap-3">
            <Field label="Type"><Select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value)}><option value="call">Phone call</option><option value="visit">Visit</option><option value="note">Note</option><option value="promise">Promise to pay</option></Select></Field>
            <Field label={kind === "promise" ? "What they said (optional)" : "What happened"}><Input value={body} onChange={(e) => setBody(e.target.value)} placeholder={kind === "call" ? "e.g. Phoned, will pay on Friday" : ""} /></Field>
          </div>
          {kind === "promise" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Will pay on"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label="Amount (KES)"><NumInput value={amt} onChange={setAmt} /></Field>
            </div>
          )}
          <ErrorLine msg={err} />
          <Button variant="primary" onClick={save}>Save follow-up</Button>
        </div>
      )}
      {!notes.length ? <p className="text-slate-500 py-4 text-center">No follow-ups yet.</p> : (
        <ul className="divide-y divide-slate-100">
          {notes.map((n) => (
            <li key={n.id} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">{KIND[n.kind] ?? n.kind}{n.promise_date && <span className="font-normal text-slate-600"> for {fmtDay(n.promise_date)}{n.promise_cents ? `, KES ${fmtKES(n.promise_cents)}` : ""}</span>}</span>
                <span className="text-xs text-slate-500 shrink-0">{fmtTime(n.created_at)}{n.user ? ` · ${n.user}` : ""}</span>
              </div>
              {n.body && <p className="text-slate-600 mt-0.5">{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
