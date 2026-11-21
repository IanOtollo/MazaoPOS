import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Printer, Truck, X } from "lucide-react";
import { fmtKES, fmtQty, toCents, toMilli } from "../../../shared/money";
import { fmtTime, get, patch, post, type Product } from "../lib/api";
import { useLive } from "../lib/live";
import { fmtDay } from "../lib/range";
import { useToast } from "../lib/toast";
import { Button, EmptyState, ErrorLine, Field, Input, Modal, NumInput, PageHead, inputCls, td, th, Select } from "../lib/ui";
import { AgeingBar, type Buckets } from "./Customers";

interface Sup { id: number; name: string; phone: string | null; email: string | null; kra_pin: string | null; credit_days: number; owed_cents: number; overdue_cents: number; max_days_overdue: number; last_delivery: string | null }
interface Detail {
  supplier: Sup; owed_cents: number;
  ageing: { balance_cents: number; buckets: Buckets; overdue_cents: number; max_days_overdue: number };
  statement: { id: number; amount_cents: number; type: string; method: string | null; note: string | null; created_at: string; invoice_no: string | null; balance_cents: number }[];
  deliveries: { id: number; invoice_no: string | null; received_on: string; total_cents: number; location: string; lines: number }[];
}
interface Reorder { id: number; sku: string; name: string; unit: string; stock_milli: number; reorder_level_milli: number; suggested_milli: number; last_supplier: string | null; last_supply: string | null }

export default function Suppliers() {
  const [tab, setTab] = useState<"suppliers" | "reorder">("suppliers");
  const [data, setData] = useState<{ totals: { owed_cents: number; overdue_cents: number }; suppliers: Sup[] } | null>(null);
  const [reorder, setReorder] = useState<Reorder[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [form, setForm] = useState<Sup | "new" | null>(null);
  const [receive, setReceive] = useState<number | "any" | null>(null);

  const load = useCallback(() => {
    get<typeof data>("/api/suppliers").then(setData);
    get<Reorder[]>("/api/reorder").then(setReorder);
  }, []);
  useEffect(() => { load(); }, [load]);
  useLive(["suppliers", "stock"], load);

  return (
    <div className="p-4 sm:p-6 max-w-6xl">
      <PageHead title="Suppliers">
        <Button onClick={() => setForm("new")} className="flex items-center gap-1.5"><Plus className="size-4" />Add supplier</Button>
        <Button variant="primary" onClick={() => setReceive("any")} className="flex items-center gap-1.5"><Truck className="size-4" />Receive goods</Button>
      </PageHead>

      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5 mb-4" role="tablist">
        {([["suppliers", "Suppliers"], ["reorder", `To reorder${reorder.length ? ` (${reorder.length})` : ""}`]] as ["suppliers" | "reorder", string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`px-3.5 py-1.5 rounded-md text-sm font-semibold transition-colors ${tab === id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
        ))}
      </div>

      {tab === "suppliers" ? (
        <>
          {data && data.totals.owed_cents > 0 && (
            <div className="flex flex-wrap gap-x-8 gap-y-2 bg-white border border-line rounded-xl shadow-card p-4 mb-4">
              <div><div className="text-sm text-slate-500">You owe suppliers</div><div className="text-2xl font-bold">KES {fmtKES(data.totals.owed_cents)}</div></div>
              <div><div className="text-sm text-slate-500">Already due</div><div className={`text-2xl font-bold ${data.totals.overdue_cents > 0 ? "text-danger" : ""}`}>KES {fmtKES(data.totals.overdue_cents)}</div></div>
            </div>
          )}
          <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
            <table className="w-full">
              <thead><tr><th className={th}>Supplier</th><th className={`${th} text-right`}>You owe</th><th className={th}>Status</th><th className={`${th} hidden md:table-cell`}>Last delivery</th></tr></thead>
              <tbody>
                {data?.suppliers.map((s) => (
                  <tr key={s.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(s.id)}>
                    <td className={td}><div className="font-medium">{s.name}</div><div className="text-xs text-slate-500">{s.phone}</div></td>
                    <td className={`${td} num ${s.owed_cents > 0 ? "font-semibold" : "text-slate-400"}`}>{s.owed_cents > 0 ? fmtKES(s.owed_cents) : "-"}</td>
                    <td className={td}>
                      {s.owed_cents <= 0 ? <span className="text-slate-400">Settled</span>
                        : s.max_days_overdue > 0 ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${s.max_days_overdue > 30 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}>{s.max_days_overdue} days overdue</span>
                        : <span className="rounded-full px-2 py-0.5 text-xs font-bold bg-slate-100 text-slate-600">Not due yet</span>}
                    </td>
                    <td className={`${td} text-slate-500 hidden md:table-cell`}>{s.last_delivery ? fmtDay(s.last_delivery) : "none yet"}</td>
                  </tr>
                ))}
                {data && !data.suppliers.length && <tr><td colSpan={4}><EmptyState icon={<Truck className="size-8" />} title="No suppliers yet" hint="Add the people you buy from, then record each delivery. The system works out what you owe them and when it is due.">
                  <Button variant="primary" onClick={() => setForm("new")}>Add your first supplier</Button></EmptyState></td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <ReorderList rows={reorder} />
      )}

      {form && <SupplierForm s={form === "new" ? null : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); load(); }} />}
      {open && <SupplierView id={open} onClose={() => setOpen(null)} onEdit={(s) => { setOpen(null); setForm(s); }} onReceive={(id) => { setOpen(null); setReceive(id); }} onChanged={load} />}
      {receive && <ReceiveGoods supplierId={receive === "any" ? null : receive} suppliers={data?.suppliers ?? []} onClose={() => setReceive(null)} onDone={() => { setReceive(null); load(); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- what to buy
function ReorderList({ rows }: { rows: Reorder[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, Reorder[]>();
    for (const r of rows) m.set(r.last_supplier ?? "No supplier on record yet", [...(m.get(r.last_supplier ?? "No supplier on record yet") ?? []), r]);
    return [...m];
  }, [rows]);
  if (!rows.length) return <div className="bg-white border border-line rounded-xl shadow-card"><EmptyState icon={<Truck className="size-8" />} title="Nothing to reorder" hint="Items appear here when stock falls to the reorder level you set on the item." /></div>;
  return (
    <div className="print-area">
      <div className="flex justify-between items-center mb-3 print:hidden">
        <p className="text-slate-600">Grouped by the supplier you last bought each item from. Suggested quantities bring stock back to twice the reorder level.</p>
        <Button onClick={() => window.print()} className="flex items-center gap-1.5 shrink-0"><Printer className="size-4" />Print</Button>
      </div>
      <h2 className="hidden print:block text-xl font-bold mb-3">Items to reorder</h2>
      <div className="space-y-5">
        {groups.map(([supplier, items]) => (
          <section key={supplier} className="bg-white border border-line rounded-xl shadow-card overflow-auto print:shadow-none">
            <h3 className="font-semibold px-4 py-3 border-b border-line bg-slate-50">{supplier}</h3>
            <table className="w-full">
              <thead><tr><th className={th}>Item</th><th className={`${th} text-right`}>In stock</th><th className={`${th} text-right hidden sm:table-cell`}>Reorder at</th><th className={`${th} text-right`}>Order</th><th className={`${th} hidden md:table-cell`}>Last supplied</th></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className={td}>{r.name}</td>
                    <td className={`${td} num ${r.stock_milli <= 0 ? "text-danger font-semibold" : ""}`}>{fmtQty(r.stock_milli)}</td>
                    <td className={`${td} num hidden sm:table-cell`}>{fmtQty(r.reorder_level_milli)}</td>
                    <td className={`${td} num font-semibold`}>{fmtQty(r.suggested_milli)} {r.unit}</td>
                    <td className={`${td} text-slate-500 hidden md:table-cell`}>{r.last_supply ? fmtDay(r.last_supply) : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- add / edit
function SupplierForm({ s, onClose, onSaved }: { s: Sup | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: s?.name ?? "", phone: s?.phone ?? "", email: s?.email ?? "", kra: s?.kra_pin ?? "", days: s?.credit_days ?? 30 });
  const [err, setErr] = useState("");
  const save = async () => {
    if (!f.name.trim()) return setErr("Give the supplier a name");
    const body = { name: f.name.trim(), phone: f.phone || null, email: f.email || null, kraPin: f.kra || null, creditDays: f.days };
    try { if (s) await patch(`/api/suppliers/${s.id}`, body); else await post("/api/suppliers", body); toast({ msg: s ? "Supplier updated" : "Supplier added" }); onSaved(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title={s ? "Edit supplier" : "Add supplier"} onClose={onClose}>
      <div className="space-y-4">
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label="Days to pay" hint="How long they give you"><NumInput value={f.days} onChange={(n) => setF({ ...f, days: Math.min(365, Math.round(n ?? 0)) })} /></Field>
        </div>
        <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="KRA PIN"><Input value={f.kra} onChange={(e) => setF({ ...f, kra: e.target.value.toUpperCase() })} /></Field>
        <ErrorLine msg={err} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- one supplier
function SupplierView({ id, onClose, onEdit, onReceive, onChanged }: { id: number; onClose: () => void; onEdit: (s: Sup) => void; onReceive: (id: number) => void; onChanged: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<"deliveries" | "statement">("deliveries");
  const [pay, setPay] = useState(false);
  const load = useCallback(() => get<Detail>(`/api/suppliers/${id}`).then(setD), [id]);
  useEffect(() => { load(); }, [load]);
  useLive(["suppliers"], load);
  if (!d) return null;
  const s = d.supplier;

  return (
    <Modal wide title={s.name} onClose={onClose}>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <div className="text-sm text-slate-500">{[s.phone, `${s.credit_days} days to pay`].filter(Boolean).join("  ·  ")}</div>
          <div className="text-3xl font-bold tracking-tight mt-1">KES {fmtKES(Math.max(0, d.owed_cents))}<span className="text-base font-medium text-slate-500"> you owe</span></div>
          {d.ageing.overdue_cents > 0 && <div className="text-sm text-danger font-medium">KES {fmtKES(d.ageing.overdue_cents)} is already due</div>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onReceive(id)}>Receive goods</Button>
          {d.owed_cents > 0 && <Button onClick={() => setPay((p) => !p)}>Pay supplier</Button>}
          <Button onClick={() => onEdit(s)}>Edit</Button>
        </div>
      </div>
      {d.owed_cents > 0 && <div className="mb-4"><AgeingBar b={d.ageing.buckets} /></div>}
      {pay && <PaySupplier id={id} max={d.owed_cents} onDone={() => { setPay(false); toast({ msg: "Payment recorded" }); load(); onChanged(); }} />}

      <div className="flex gap-1 border-b border-slate-200 mb-3" role="tablist">
        {([["deliveries", "Deliveries"], ["statement", "Statement"]] as ["deliveries" | "statement", string][]).map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-4 py-2 font-semibold -mb-px border-b-2 ${tab === t ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500 hover:text-slate-900"}`}>{label}</button>
        ))}
      </div>

      {tab === "deliveries" ? (
        d.deliveries.length === 0 ? <p className="text-slate-500 py-6 text-center">No deliveries recorded yet.</p> : (
          <div className="max-h-72 overflow-auto border border-line rounded-lg">
            <table className="w-full">
              <thead><tr><th className={th}>Date</th><th className={th}>Invoice</th><th className={`${th} hidden sm:table-cell`}>Received at</th><th className={`${th} text-right`}>Total</th></tr></thead>
              <tbody>{d.deliveries.map((x) => <tr key={x.id}><td className={td}>{fmtDay(x.received_on)}</td><td className={td}>{x.invoice_no ?? "-"}</td><td className={`${td} hidden sm:table-cell`}>{x.location}, {x.lines} {x.lines === 1 ? "item" : "items"}</td><td className={`${td} num`}>{fmtKES(x.total_cents)}</td></tr>)}</tbody>
            </table>
          </div>
        )
      ) : (
        <div className="max-h-72 overflow-auto border border-line rounded-lg">
          <table className="w-full">
            <thead><tr><th className={th}>Date</th><th className={th}>Details</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>You owe</th></tr></thead>
            <tbody>
              {d.statement.map((l) => (
                <tr key={l.id}>
                  <td className={`${td} whitespace-nowrap`}>{fmtTime(l.created_at)}</td>
                  <td className={td}>{l.type === "purchase" ? `Delivery${l.invoice_no ? ` ${l.invoice_no}` : ""}` : l.type === "credit_note" ? "Credit note" : `Payment${l.method ? ` (${l.method})` : ""}${l.note ? ` ${l.note}` : ""}`}</td>
                  <td className={`${td} num ${l.amount_cents < 0 ? "text-ok" : ""}`}>{fmtKES(l.amount_cents)}</td>
                  <td className={`${td} num font-medium`}>{fmtKES(l.balance_cents)}</td>
                </tr>
              ))}
              {!d.statement.length && <tr><td className={`${td} text-slate-500`} colSpan={4}>Nothing yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function PaySupplier({ id, max, onDone }: { id: number; max: number; onDone: () => void }) {
  const [amt, setAmt] = useState<number | null>(null);
  const [method, setMethod] = useState("bank");
  const [ref, setRef] = useState("");
  const [err, setErr] = useState("");
  const go = async () => {
    if (!amt) return setErr("Enter the amount");
    try { await post(`/api/suppliers/${id}/payment`, { amountCents: toCents(amt), method, reference: ref || undefined }); onDone(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="border border-line rounded-lg p-3 mb-4 bg-slate-50">
      <div className="grid sm:grid-cols-[1fr_10rem_1fr_auto] gap-3 items-end">
        <Field label="Amount (KES)"><NumInput value={amt} onChange={setAmt} autoFocus placeholder={fmtKES(max)} /></Field>
        <Field label="Paid by"><Select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}><option value="bank">Bank</option><option value="mpesa">M-Pesa</option><option value="cash">Cash</option><option value="card">Card</option><option value="credit_note">Credit note</option></Select></Field>
        <Field label="Reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="optional" /></Field>
        <Button variant="primary" onClick={go}>Save</Button>
      </div>
      <div className="mt-2"><ErrorLine msg={err} /></div>
    </div>
  );
}

// ---------------------------------------------------------------- receive a delivery
interface Line { product: Product; qty: number | null; cost: number | null }

function ReceiveGoods({ supplierId, suppliers, onClose, onDone }: { supplierId: number | null; suppliers: Sup[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [sup, setSup] = useState<number | "">(supplierId ?? "");
  const [invoice, setInvoice] = useState("");
  const [loc, setLoc] = useState(1);
  const [date, setDate] = useState(new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Product[]>([]);
  const [paid, setPaid] = useState<number | null>(null);
  const [method, setMethod] = useState("cash");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.trim()) return setFound([]);
    const t = setTimeout(() => get<Product[]>(`/api/products?q=${encodeURIComponent(q)}&limit=8`).then(setFound), 150);
    return () => clearTimeout(t);
  }, [q]);

  const total = lines.reduce((a, l) => a + Math.round(((l.cost ?? 0) * 100 * toMilli(l.qty ?? 0)) / 1000), 0);
  const add = (p: Product) => {
    setLines((x) => (x.some((l) => l.product.id === p.id) ? x : [...x, { product: p, qty: 1, cost: p.cost_cents / 100 }]));
    setQ(""); setFound([]);
  };
  const set = (i: number, patch: Partial<Line>) => setLines((x) => x.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  const save = async () => {
    if (sup === "") return setErr("Choose the supplier");
    if (!lines.length) return setErr("Add the items that were delivered");
    if (lines.some((l) => !l.qty || l.qty <= 0)) return setErr("Every item needs a quantity");
    setBusy(true);
    try {
      await post("/api/purchases", {
        supplierId: sup, invoiceNo: invoice || undefined, locationId: loc, receivedOn: date,
        paidCents: paid ? toCents(paid) : 0, payMethod: method,
        lines: lines.map((l) => ({ productId: l.product.id, qtyMilli: toMilli(l.qty ?? 0), unitCostCents: toCents(l.cost ?? 0) })),
      });
      toast({ msg: "Goods received. Stock and cost prices are updated." });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal wide title="Receive goods" onClose={onClose}>
      <div className="grid sm:grid-cols-4 gap-3 mb-4">
        <div className="sm:col-span-2"><Field label="Supplier">
          <Select className={inputCls} value={sup} onChange={(e) => setSup(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Choose supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select></Field></div>
        <Field label="Their invoice no."><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
        <Field label="Received at"><Select className={inputCls} value={loc} onChange={(e) => setLoc(Number(e.target.value))}><option value={1}>Shop</option><option value={2}>Store</option></Select></Field>
      </div>

      <div className="relative mb-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an item to add (name, code or barcode)" />
        {found.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-line rounded-lg shadow-pop max-h-60 overflow-auto">
            {found.map((p) => <li key={p.id}><button onClick={() => add(p)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex justify-between gap-3"><span>{p.name}</span><span className="text-slate-500 text-sm">{p.sku}</span></button></li>)}
          </ul>
        )}
      </div>

      {lines.length > 0 && (
        <div className="border border-line rounded-lg overflow-auto mb-3">
          <table className="w-full">
            <thead><tr><th className={th}>Item</th><th className={`${th} w-28`}>Quantity</th><th className={`${th} w-32`}>Cost each</th><th className={`${th} text-right w-28`}>Total</th><th className={`${th} w-10`}></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.product.id}>
                  <td className={td}>{l.product.name}<span className="text-slate-500 text-xs"> per {l.product.unit}</span></td>
                  <td className={td}><NumInput value={l.qty} onChange={(n) => set(i, { qty: n })} className="num !py-1.5" aria-label="Quantity" /></td>
                  <td className={td}><NumInput value={l.cost} onChange={(n) => set(i, { cost: n })} className="num !py-1.5" aria-label="Cost each" /></td>
                  <td className={`${td} num`}>{fmtKES(Math.round(((l.cost ?? 0) * 100 * toMilli(l.qty ?? 0)) / 1000))}</td>
                  <td className={td}><button onClick={() => setLines((x) => x.filter((_, k) => k !== i))} aria-label="Remove" className="text-slate-400 hover:text-danger"><X className="size-5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid sm:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end border-t border-line pt-3">
        <div><div className="text-sm text-slate-500">Delivery total</div><div className="text-2xl font-bold">KES {fmtKES(total)}</div></div>
        <Field label="Paid now (KES)" hint="Leave empty to owe it"><NumInput value={paid} onChange={setPaid} /></Field>
        <Field label="Paid by"><Select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="card">Card</option></Select></Field>
        <Field label="Date"><Input type="date" value={date} max={new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="mt-2"><ErrorLine msg={err} /></div>
      <Button variant="primary" className="w-full !py-3 mt-3" onClick={save} disabled={busy}>{busy ? "Saving" : "Save delivery"}</Button>
    </Modal>
  );
}
