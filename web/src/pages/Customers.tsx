import { useCallback, useEffect, useState } from "react";
import { fmtKES, toCents } from "../../../shared/money";
import { fmtTime, get, patch, post, useAuth, type Customer } from "../lib/api";
import { Button, ErrorLine, Field, Input, Modal, NumInput, PageHead, inputCls, td, th } from "../lib/ui";

export default function Customers() {
  const { can } = useAuth();
  const mgr = can("customers.manage");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Customer[]>([]);
  const [edit, setEdit] = useState<Customer | "new" | null>(null);
  const [view, setView] = useState<number | null>(null);
  const load = useCallback(() => get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}`).then(setRows), [q]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);
  const owed = rows.reduce((a, r) => a + Math.max(0, r.balance_cents), 0);

  return (
    <div className="p-4">
      <PageHead title="Customers">
        <Input placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} className="!w-64" />
        {can("customers.create") && <Button variant="primary" onClick={() => setEdit("new")}>Add customer</Button>}
      </PageHead>
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full min-w-[40rem]">
          <thead><tr><th className={th}>Name</th><th className={th}>Phone</th><th className={th}>Price tier</th><th className={`${th} text-right`}>Credit limit</th><th className={`${th} text-right`}>Owes</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="cursor-pointer hover:bg-blue-50" onClick={() => setView(c.id)}>
                <td className={td}>{c.name}</td><td className={td}>{c.phone}</td><td className={`${td} capitalize`}>{c.tier}</td>
                <td className={`${td} num`}>{c.credit_limit_cents ? fmtKES(c.credit_limit_cents) : "-"}</td>
                <td className={`${td} num ${c.balance_cents > 0 ? "text-danger font-semibold" : ""}`}>{fmtKES(c.balance_cents)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td className={`${td} text-gray-500`} colSpan={5}>No customers yet.</td></tr>}
          </tbody>
          {!!rows.length && <tfoot><tr><td className={`${td} font-semibold`} colSpan={4}>Total owed to you</td><td className={`${td} num font-semibold`}>{fmtKES(owed)}</td></tr></tfoot>}
        </table>
      </div>
      {edit && <CustomerForm c={edit === "new" ? null : edit} mgr={mgr} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {view && <Account id={view} mgr={mgr} canPay={can("customers.payment")} onClose={() => setView(null)} onChanged={load} onEdit={(c) => { setView(null); setEdit(c); }} />}
    </div>
  );
}

function CustomerForm({ c, mgr, onClose, onSaved }: { c: Customer | null; mgr: boolean; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: c?.name ?? "", phone: c?.phone ?? "", kra: c?.kra_pin ?? "", tier: c?.tier ?? "retail", limit: c ? c.credit_limit_cents / 100 : (null as number | null) });
  const [err, setErr] = useState("");
  const save = async () => {
    if (!f.name.trim()) return setErr("Name is required");
    const body = { name: f.name.trim(), phone: f.phone || null, kraPin: f.kra || null, tier: f.tier, creditLimitCents: toCents(f.limit ?? 0) };
    try { if (c) await patch(`/api/customers/${c.id}`, body); else await post("/api/customers", body); onSaved(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={c ? "Edit customer" : "Add customer"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="KRA PIN (for tax invoices)"><Input value={f.kra} onChange={(e) => setF({ ...f, kra: e.target.value.toUpperCase() })} /></Field>
        {mgr && (
          <>
            <Field label="Price tier"><select className={inputCls} value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value as Customer["tier"] })}><option value="retail">Retail</option><option value="contractor">Contractor</option><option value="wholesale">Wholesale</option></select></Field>
            <Field label="Credit limit (KES)" hint="0 = no credit allowed"><NumInput value={f.limit} onChange={(n) => setF({ ...f, limit: n })} /></Field>
          </>
        )}
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}

function Account({ id, mgr, canPay, onClose, onChanged, onEdit }: { id: number; mgr: boolean; canPay: boolean; onClose: () => void; onChanged: () => void; onEdit: (c: Customer) => void }) {
  const [c, setC] = useState<(Customer & { ledger: { id: number; created_at: string; type: string; amount_cents: number; method: string | null; note: string | null }[] }) | null>(null);
  const [amt, setAmt] = useState<number | null>(null);
  const [method, setMethod] = useState("cash");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => get(`/api/customers/${id}`).then(setC), [id]);
  useEffect(() => { load(); }, [load]);
  if (!c) return null;
  const pay = async () => {
    if (!amt) return setErr("Enter an amount");
    try { await post(`/api/customers/${id}/payment`, { amountCents: toCents(amt), method, reference: ref || undefined }); setAmt(null); setRef(""); setErr(""); load(); onChanged(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal wide title={c.name} onClose={onClose}>
      <div className="flex flex-wrap justify-between gap-3 mb-3">
        <div><div className="text-sm text-gray-600">Balance owed</div><div className="text-2xl font-semibold">KES {fmtKES(c.balance_cents)}</div>
          <div className="text-sm text-gray-600">Limit {fmtKES(c.credit_limit_cents)} - {c.tier}</div></div>
        {mgr && <Button onClick={() => onEdit(c)}>Edit</Button>}
      </div>
      {canPay && c.balance_cents > 0 && (
        <div className="grid sm:grid-cols-[1fr_8rem_1fr_auto] gap-2 items-end border border-line rounded-lg p-3 mb-3">
          <Field label="Payment received (KES)"><NumInput value={amt} onChange={setAmt} /></Field>
          <Field label="Method"><select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="card">Card</option></select></Field>
          <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} /></Field>
          <Button variant="primary" onClick={pay}>Record</Button>
        </div>
      )}
      <ErrorLine msg={err} />
      <table className="w-full mt-2">
        <thead><tr><th className={th}>Date</th><th className={th}>Entry</th><th className={`${th} text-right`}>Amount</th></tr></thead>
        <tbody>
          {c.ledger.map((l) => (
            <tr key={l.id}><td className={td}>{fmtTime(l.created_at)}</td>
              <td className={`${td} capitalize`}>{l.type.replace("_", " ")}{l.method ? ` (${l.method})` : ""}{l.note ? ` - ${l.note}` : ""}</td>
              <td className={`${td} num ${l.amount_cents < 0 ? "text-ok" : ""}`}>{fmtKES(l.amount_cents)}</td></tr>
          ))}
          {!c.ledger.length && <tr><td className={`${td} text-gray-500`} colSpan={3}>No account activity.</td></tr>}
        </tbody>
      </table>
    </Modal>
  );
}
