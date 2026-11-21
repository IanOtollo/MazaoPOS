import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Pencil, Printer, X } from "lucide-react";
import { fmtKES, fmtQty, toCents, toMilli } from "../../../shared/money";
import { apiUrl, get, patch, post, put, type Product } from "../lib/api";
import { useLive } from "../lib/live";
import { fmtDay } from "../lib/range";
import { useToast } from "../lib/toast";
import { Button, EmptyState, ErrorLine, Field, Input, Modal, NumInput, inputCls, td, th, Select } from "../lib/ui";

// ---------------------------------------------------------------- types
export interface LpoRow {
  id: number; number: string; supplier_id: number; supplier: string; status: Status; total_cents: number; lines: number; open_lines: number;
  expected_on: string | null; created_at: string; sent_at: string | null;
}
interface LpoItem { product_id: number; name: string; unit: string; qty_milli: number; unit_cost_cents: number; received_milli: number; line_total_cents: number }
interface LpoDetail extends LpoRow { note: string | null; supplier_phone: string | null; supplier_email: string | null; items: LpoItem[]; purchase_ids: number[] }
type Status = "draft" | "sent" | "partial" | "received" | "cancelled";
export interface PrefillLine { productId: number; name: string; unit: string; qty: number; cost: number }
interface SupplierOpt { id: number; name: string }

const STATUS: Record<Status, [string, string]> = {
  draft: ["Draft", "bg-slate-100 text-slate-600"],
  sent: ["Sent", "bg-blue-100 text-blue-800"],
  partial: ["Partly received", "bg-amber-100 text-amber-800"],
  received: ["Received", "bg-green-100 text-green-800"],
  cancelled: ["Cancelled", "bg-slate-100 text-slate-400"],
};
const Badge = ({ s }: { s: Status }) => <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold whitespace-nowrap ${STATUS[s][1]}`}>{STATUS[s][0]}</span>;

/** The Kenya calendar day of a stored time, in the format fmtDay reads. */
const dayOf = (iso: string) => fmtDay(new Date(new Date(iso).getTime() + 3 * 3600000).toISOString().slice(0, 10));
const lineSum = (qty: number | null, cost: number | null) => Math.round(((cost ?? 0) * 100 * toMilli(qty ?? 0)) / 1000);

// ---------------------------------------------------------------- list of orders
const FILTERS: [string, string][] = [["", "All"], ["open", "Open"], ["received", "Received"], ["cancelled", "Cancelled"]];

export function OrdersTab({ suppliers, onNew }: { suppliers: SupplierOpt[]; onNew: () => void }) {
  const [filter, setFilter] = useState("open");
  const [rows, setRows] = useState<LpoRow[] | null>(null);
  const [view, setView] = useState<number | null>(null);
  const [edit, setEdit] = useState<LpoDetail | null>(null);

  const load = useCallback(() => get<LpoRow[]>(`/api/lpos${filter ? `?status=${filter}` : ""}`).then(setRows), [filter]);
  useEffect(() => { load(); }, [load]);
  useLive(["suppliers"], load);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist" aria-label="Filter orders">
          {FILTERS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}
              className={`px-3 py-1 rounded-md text-sm font-semibold transition-colors ${filter === id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</button>
          ))}
        </div>
        <p className="text-sm text-slate-500 hidden sm:block">Orders you send to suppliers before the goods arrive.</p>
      </div>
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full">
          <thead><tr>
            <th className={th}>Order</th><th className={th}>Supplier</th><th className={`${th} hidden sm:table-cell`}>Date</th>
            <th className={`${th} hidden md:table-cell`}>Expected</th><th className={`${th} text-right`}>Total</th><th className={th}>Status</th>
          </tr></thead>
          <tbody>
            {rows?.map((o) => (
              <tr key={o.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setView(o.id)}>
                <td className={`${td} font-medium whitespace-nowrap`}>{o.number}</td>
                <td className={td}>{o.supplier}<div className="text-xs text-slate-500">{o.lines} {o.lines === 1 ? "item" : "items"}</div></td>
                <td className={`${td} text-slate-500 hidden sm:table-cell`}>{dayOf(o.created_at)}</td>
                <td className={`${td} text-slate-500 hidden md:table-cell`}>{o.expected_on ? fmtDay(o.expected_on) : "-"}</td>
                <td className={`${td} num`}>{fmtKES(o.total_cents)}</td>
                <td className={td}><Badge s={o.status} /></td>
              </tr>
            ))}
            {rows && !rows.length && (
              <tr><td colSpan={6}>
                <EmptyState icon={<ClipboardList className="size-8" />} title={filter === "open" ? "No open orders" : "No orders here"}
                  hint="Make an order for a supplier, send it, then receive the goods against it when they arrive. Stock and what you owe update by themselves.">
                  <Button variant="primary" onClick={onNew}>New order</Button>
                </EmptyState>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {view !== null && !edit && <OrderView id={view} onClose={() => setView(null)} onEdit={(d) => setEdit(d)} />}
      {edit && <OrderForm suppliers={suppliers} order={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

// ---------------------------------------------------------------- make or edit an order
interface FormLine { productId: number; name: string; unit: string; qty: number | null; cost: number | null }

export function OrderForm({ suppliers, order, prefill, onClose, onSaved }: {
  suppliers: SupplierOpt[]; order?: LpoDetail; prefill?: { supplierId?: number; lines?: PrefillLine[] };
  onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [sup, setSup] = useState<number | "">(order?.supplier_id ?? prefill?.supplierId ?? "");
  const [expected, setExpected] = useState(order?.expected_on ?? "");
  const [note, setNote] = useState(order?.note ?? "");
  const [lines, setLines] = useState<FormLine[]>(
    order ? order.items.map((i) => ({ productId: i.product_id, name: i.name, unit: i.unit, qty: i.qty_milli / 1000, cost: i.unit_cost_cents / 100 }))
      : (prefill?.lines ?? []).map((l) => ({ productId: l.productId, name: l.name, unit: l.unit, qty: l.qty, cost: l.cost })),
  );
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Product[]>([]);
  const [foundTotal, setFoundTotal] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!q.trim()) return setFound([]);
    const t = setTimeout(() => get<{ items: Product[]; total: number }>(`/api/products/page?q=${encodeURIComponent(q)}&limit=8`).then((r) => { setFound(r.items); setFoundTotal(r.total); }), 150);
    return () => clearTimeout(t);
  }, [q]);

  const total = lines.reduce((a, l) => a + lineSum(l.qty, l.cost), 0);
  const add = (p: Product) => {
    setLines((x) => (x.some((l) => l.productId === p.id) ? x : [...x, { productId: p.id, name: p.name, unit: p.unit, qty: 1, cost: p.cost_cents / 100 }]));
    setQ(""); setFound([]);
  };
  const set = (i: number, p: Partial<FormLine>) => setLines((x) => x.map((l, k) => (k === i ? { ...l, ...p } : l)));

  const save = async (send: boolean) => {
    if (sup === "") return setErr("Choose the supplier");
    if (!lines.length) return setErr("Add the items you want to order");
    if (lines.some((l) => !l.qty || l.qty <= 0)) return setErr("Every item needs a quantity");
    const body = {
      expectedOn: expected || undefined, note: note.trim() || undefined,
      lines: lines.map((l) => ({ productId: l.productId, qtyMilli: toMilli(l.qty ?? 0), unitCostCents: toCents(l.cost ?? 0) })),
    };
    setBusy(true);
    try {
      if (order) {
        await put(`/api/lpos/${order.id}`, body);
        if (send) await patch(`/api/lpos/${order.id}`, { status: "sent" });
      } else {
        await post("/api/lpos", { ...body, supplierId: sup, send });
      }
      toast({ msg: send ? "Order saved and marked as sent" : "Order saved as a draft" });
      onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal wide title={order ? `Edit ${order.number}` : "New order"} onClose={onClose}>
      <div className="grid sm:grid-cols-3 gap-3 mb-4">
        <div className="sm:col-span-2"><Field label="Supplier">
          <Select className={inputCls} value={sup} disabled={!!order} onChange={(e) => setSup(e.target.value ? Number(e.target.value) : "")} placeholder="Choose supplier">
            <option value="">Choose supplier</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select></Field></div>
        <Field label="Expected on" hint="Optional"><Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
      </div>

      <div className="relative mb-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search an item to add (name, code or barcode)" />
        {found.length > 0 && (
          <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-line rounded-lg shadow-pop max-h-60 overflow-auto">
            {found.map((p) => <li key={p.id}><button onClick={() => add(p)} className="w-full text-left px-3 py-2 hover:bg-slate-50 flex justify-between gap-3"><span>{p.name}</span><span className="text-slate-500 text-sm">{p.sku}</span></button></li>)}
          {foundTotal > found.length && <li className="px-3 py-2 text-xs text-slate-500 border-t border-slate-100">Showing {found.length} of {foundTotal.toLocaleString("en-KE")} matches. Type more to narrow the list.</li>}
          </ul>
        )}
      </div>

      {lines.length > 0 ? (
        <div className="border border-line rounded-lg overflow-auto mb-3">
          <table className="w-full">
            <thead><tr><th className={th}>Item</th><th className={`${th} w-28`}>Quantity</th><th className={`${th} w-32`}>Price each</th><th className={`${th} text-right w-28 hidden sm:table-cell`}>Total</th><th className={`${th} w-10`}></th></tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.productId}>
                  <td className={td}>{l.name}<span className="text-slate-500 text-xs"> per {l.unit}</span></td>
                  <td className={td}><NumInput value={l.qty} onChange={(n) => set(i, { qty: n })} className="num !py-1.5" aria-label="Quantity" /></td>
                  <td className={td}><NumInput value={l.cost} onChange={(n) => set(i, { cost: n })} className="num !py-1.5" aria-label="Price each" /></td>
                  <td className={`${td} num hidden sm:table-cell`}>{fmtKES(lineSum(l.qty, l.cost))}</td>
                  <td className={td}><button onClick={() => setLines((x) => x.filter((_, k) => k !== i))} aria-label={`Remove ${l.name}`} className="text-slate-400 hover:text-danger"><X className="size-5" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-sm text-slate-500 mb-3">Search above to add the items you want to order.</p>}

      <Field label="Note to the supplier" hint="Optional, printed on the order"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      <div className="flex items-end justify-between gap-3 border-t border-line pt-3 mt-4">
        <div><div className="text-sm text-slate-500">Order total</div><div className="text-2xl font-bold">KES {fmtKES(total)}</div></div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => save(false)} disabled={busy}>Save draft</Button>
          <Button variant="primary" onClick={() => save(true)} disabled={busy}>{busy ? "Saving" : "Save and mark as sent"}</Button>
        </div>
      </div>
      <div className="mt-2"><ErrorLine msg={err} /></div>
    </Modal>
  );
}

// ---------------------------------------------------------------- one order
function OrderView({ id, onClose, onEdit }: { id: number; onClose: () => void; onEdit: (d: LpoDetail) => void }) {
  const toast = useToast();
  const [d, setD] = useState<LpoDetail | null>(null);
  const [biz, setBiz] = useState<Record<string, string>>({});
  const [receiving, setReceiving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(() => get<LpoDetail>(`/api/lpos/${id}`).then(setD), [id]);
  useEffect(() => { load(); get<Record<string, string>>("/api/settings").then(setBiz).catch(() => {}); }, [load]);
  useLive(["suppliers"], load);
  if (!d) return null;

  const setStatus = async (status: "sent" | "cancelled" | "received", msg: string) => {
    setErr("");
    try { await patch(`/api/lpos/${d.id}`, { status }); toast({ msg }); setConfirmCancel(false); await load(); }
    catch (e) { setErr((e as Error).message); }
  };

  if (receiving) return <ReceiveAgainst order={d} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); load(); }} />;

  const canReceive = d.status === "sent" || d.status === "partial";
  return (
    <Modal wide title={d.number} onClose={onClose}>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2"><span className="text-lg font-semibold">{d.supplier}</span><Badge s={d.status} /></div>
          <div className="text-sm text-slate-500 mt-0.5">
            {[`Made ${dayOf(d.created_at)}`, d.expected_on ? `expected ${fmtDay(d.expected_on)}` : null, d.supplier_phone].filter(Boolean).join("  ·  ")}
          </div>
          <div className="text-3xl font-bold tracking-tight mt-1">KES {fmtKES(d.total_cents)}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReceive && <Button variant="primary" onClick={() => setReceiving(true)}>Receive goods</Button>}
          {d.status === "draft" && <Button variant="primary" onClick={() => setStatus("sent", "Order marked as sent")}>Mark as sent</Button>}
          {d.status === "draft" && <Button onClick={() => onEdit(d)} className="flex items-center gap-1.5"><Pencil className="size-4" />Edit</Button>}
          {d.status === "partial" && <Button onClick={() => setStatus("received", "Order closed as received")}>Close as received</Button>}
          <Button onClick={() => window.print()} className="flex items-center gap-1.5"><Printer className="size-4" />Print</Button>
        </div>
      </div>

      <div className="border border-line rounded-lg overflow-auto mb-3">
        <table className="w-full">
          <thead><tr>
            <th className={th}>Item</th><th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Received</th>
            <th className={`${th} text-right hidden sm:table-cell`}>Still due</th><th className={`${th} text-right hidden md:table-cell`}>Price</th><th className={`${th} text-right`}>Total</th>
          </tr></thead>
          <tbody>
            {d.items.map((i) => (
              <tr key={i.product_id}>
                <td className={td}>{i.name}<span className="text-slate-500 text-xs"> per {i.unit}</span></td>
                <td className={`${td} num`}>{fmtQty(i.qty_milli)}</td>
                <td className={`${td} num`}>{fmtQty(i.received_milli)}</td>
                <td className={`${td} num hidden sm:table-cell ${i.received_milli < i.qty_milli && d.status !== "cancelled" ? "font-semibold" : "text-slate-400"}`}>{fmtQty(Math.max(0, i.qty_milli - i.received_milli))}</td>
                <td className={`${td} num hidden md:table-cell`}>{fmtKES(i.unit_cost_cents)}</td>
                <td className={`${td} num`}>{fmtKES(i.line_total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.note && <p className="text-sm text-slate-600 mb-3"><span className="font-medium">Note:</span> {d.note}</p>}
      <ErrorLine msg={err} />

      {(d.status === "draft" || d.status === "sent") && (
        <div className="border-t border-line pt-3 mt-3">
          {confirmCancel ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Cancel {d.number}? It cannot be undone.</span>
              <Button variant="danger" onClick={() => setStatus("cancelled", "Order cancelled")} className="!py-1.5">Yes, cancel it</Button>
              <Button onClick={() => setConfirmCancel(false)} className="!py-1.5">Keep it</Button>
            </div>
          ) : <button onClick={() => setConfirmCancel(true)} className="text-sm font-medium text-danger hover:underline">Cancel this order</button>}
        </div>
      )}

      <PrintSheet d={d} biz={biz} />
    </Modal>
  );
}

/** What comes out of the printer: only this block is visible when printing (see .print-area in index.css). */
function PrintSheet({ d, biz }: { d: LpoDetail; biz: Record<string, string> }) {
  return (
    <div className="print-area hidden print:block text-[12px] text-black">
      <div className="flex items-start justify-between gap-6 mb-4">
        <div>
          {biz.logo_version && <img src={apiUrl(`/api/logo?v=${biz.logo_version}`)} alt="" style={{ maxHeight: 56, marginBottom: 6 }} />}
          <div className="text-base font-bold">{biz.business_name}</div>
          {biz.address && <div>{biz.address}</div>}
          {biz.phone && <div>Tel {biz.phone}</div>}
        </div>
        <div className="text-right">
          <div className="text-xl font-bold tracking-wide">LOCAL PURCHASE ORDER</div>
          <div className="mt-1 text-sm font-semibold">{d.number}</div>
          <div>Date: {dayOf(d.created_at)}</div>
          {d.expected_on && <div>Expected delivery: {fmtDay(d.expected_on)}</div>}
        </div>
      </div>
      <div className="mb-4">
        <div className="text-[11px] uppercase tracking-wider text-slate-600">Supplier</div>
        <div className="font-semibold">{d.supplier}</div>
        {d.supplier_phone && <div>Tel {d.supplier_phone}</div>}
        {d.supplier_email && <div>{d.supplier_email}</div>}
      </div>
      <table className="w-full border-collapse">
        <thead><tr>
          {["No.", "Description", "Unit", "Qty", "Unit price", "Total"].map((h, i) => (
            <th key={h} className={`border-b border-black py-1.5 text-[11px] uppercase ${i > 2 ? "text-right" : "text-left"}`}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {d.items.map((i, n) => (
            <tr key={i.product_id}>
              <td className="py-1.5 border-b border-slate-300">{n + 1}</td>
              <td className="py-1.5 border-b border-slate-300">{i.name}</td>
              <td className="py-1.5 border-b border-slate-300">{i.unit}</td>
              <td className="py-1.5 border-b border-slate-300 text-right">{fmtQty(i.qty_milli)}</td>
              <td className="py-1.5 border-b border-slate-300 text-right">{fmtKES(i.unit_cost_cents)}</td>
              <td className="py-1.5 border-b border-slate-300 text-right">{fmtKES(i.line_total_cents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={5} className="pt-2 text-right font-bold">Total (KES)</td><td className="pt-2 text-right font-bold">{fmtKES(d.total_cents)}</td></tr></tfoot>
      </table>
      {d.note && <p className="mt-4"><strong>Note:</strong> {d.note}</p>}
      <div className="grid grid-cols-2 gap-10 mt-14">
        <div className="border-t border-black pt-1">Authorised by</div>
        <div className="border-t border-black pt-1">Supplier signature and date</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- goods arrived against an order
function ReceiveAgainst({ order, onClose, onDone }: { order: LpoDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const open = order.items.filter((i) => i.received_milli < i.qty_milli);
  const [qty, setQty] = useState<Record<number, number | null>>(Object.fromEntries(open.map((i) => [i.product_id, (i.qty_milli - i.received_milli) / 1000])));
  const [invoice, setInvoice] = useState("");
  const [loc, setLoc] = useState(1);
  const [locs, setLocs] = useState<{ id: number; name: string }[]>([]);
  const [paid, setPaid] = useState<number | null>(null);
  const [method, setMethod] = useState("cash");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<{ id: number; name: string }[]>("/api/locations").then(setLocs).catch(() => {}); }, []);

  const total = open.reduce((a, i) => a + Math.round((i.unit_cost_cents * toMilli(qty[i.product_id] ?? 0)) / 1000), 0);

  const save = async () => {
    const lines = open.filter((i) => (qty[i.product_id] ?? 0) > 0).map((i) => ({ productId: i.product_id, qtyMilli: toMilli(qty[i.product_id] ?? 0) }));
    if (!lines.length) return setErr("Enter how much arrived");
    if (open.some((i) => toMilli(qty[i.product_id] ?? 0) > i.qty_milli - i.received_milli)) return setErr("You cannot receive more than is still due on the order");
    if (paid && toCents(paid) > total) return setErr("You cannot pay more than this delivery is worth");
    setBusy(true);
    try {
      const r = await post<{ status: string }>(`/api/lpos/${order.id}/receive`, {
        lines, invoiceNo: invoice.trim() || undefined, locationId: loc, paidCents: paid ? toCents(paid) : 0, payMethod: method,
      });
      toast({ msg: r.status === "received" ? "Order fully received. Stock and cost prices are updated." : "Goods received. The rest of the order is still open." });
      onDone();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <Modal wide title={`Receive goods for ${order.number}`} onClose={onClose}>
      <p className="text-slate-600 mb-3">{order.supplier}. Enter what actually arrived. Leave the rest, it stays on the order.</p>
      <div className="border border-line rounded-lg overflow-auto mb-3">
        <table className="w-full">
          <thead><tr><th className={th}>Item</th><th className={`${th} text-right hidden sm:table-cell`}>Still due</th><th className={`${th} w-32`}>Arrived now</th><th className={`${th} text-right hidden md:table-cell`}>Price</th></tr></thead>
          <tbody>
            {open.map((i) => (
              <tr key={i.product_id}>
                <td className={td}>{i.name}<span className="text-slate-500 text-xs"> per {i.unit}</span></td>
                <td className={`${td} num hidden sm:table-cell`}>{fmtQty(i.qty_milli - i.received_milli)}</td>
                <td className={td}><NumInput value={qty[i.product_id] ?? null} onChange={(n) => setQty((x) => ({ ...x, [i.product_id]: n }))} className="num !py-1.5" aria-label={`Arrived: ${i.name}`} /></td>
                <td className={`${td} num hidden md:table-cell`}>{fmtKES(i.unit_cost_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid sm:grid-cols-4 gap-3 items-end">
        <Field label="Their invoice no."><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></Field>
        <Field label="Received at">
          <Select className={inputCls} value={loc} onChange={(e) => setLoc(Number(e.target.value))}>
            {(locs.length ? locs : [{ id: 1, name: "Shop" }, { id: 2, name: "Store" }]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
        <Field label="Paid now (KES)" hint="Leave empty to owe it"><NumInput value={paid} onChange={setPaid} /></Field>
        <Field label="Paid by"><Select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="card">Card</option></Select></Field>
      </div>
      <div className="flex items-end justify-between gap-3 border-t border-line pt-3 mt-4">
        <div><div className="text-sm text-slate-500">Delivery total</div><div className="text-2xl font-bold">KES {fmtKES(total)}</div></div>
        <div className="flex gap-2"><Button onClick={onClose}>Back</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving" : "Save delivery"}</Button></div>
      </div>
      <div className="mt-2"><ErrorLine msg={err} /></div>
    </Modal>
  );
}
