import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtKES, fmtQty, toMilli } from "../../../shared/money";
import { fmtTime, get, post, todayEAT } from "../lib/api";
import { useAuth } from "../lib/api";
import { Button, ErrorLine, Field, Input, Modal, NumInput, PageHead, inputCls, td, th, Select, PinInput } from "../lib/ui";
import { Receipt, type SaleDoc } from "../lib/Receipt";
import { useLive } from "../lib/live";
import { RangePicker } from "../lib/range";

interface Row { id: number; receipt_no: string; kind: string; total_cents: number; created_at: string; cashier: string; customer_name: string | null; methods: string | null }

export default function Sales() {
  const SHOW = 500; // rows shown; one more is asked for so the page can say when there are others
  const [days, setDays] = useState(1); // opens on Today
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const span = useMemo(() => {
    if (custom) return custom;
    const to = todayEAT();
    return { from: new Date(new Date(to + "T00:00:00Z").getTime() - (days - 1) * 86400000).toISOString().slice(0, 10), to };
  }, [days, custom]);
  const load = useCallback(() => {
    // while a custom range is half-typed or backwards, keep showing the last good list
    if (!span.from || !span.to || span.from > span.to) return Promise.resolve();
    return get<Row[]>(`/api/sales?from=${span.from}&to=${span.to}&limit=${SHOW + 1}&q=${encodeURIComponent(q)}`).then(setRows);
  }, [span, q]);
  useEffect(() => { load(); }, [load]);
  useLive(["sales"], load);
  const more = rows.length > SHOW;
  const shown = more ? rows.slice(0, SHOW) : rows;
  const sum = shown.reduce((a, r) => a + r.total_cents, 0);

  return (
    <div className="p-4">
      <PageHead title="Sales">
        <RangePicker days={days} custom={custom} setDays={setDays} setCustom={setCustom} />
        <Input placeholder="Receipt no." value={q} onChange={(e) => setQ(e.target.value)} className="!w-40" />
      </PageHead>
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">
        <table className="w-full min-w-[40rem]">
          <thead><tr><th className={th}>Receipt</th><th className={th}>Time</th><th className={th}>Cashier</th><th className={th}>Customer</th><th className={th}>Paid by</th><th className={`${th} text-right`}>Total</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} onClick={() => setOpen(r.id)} className="cursor-pointer hover:bg-blue-50">
                <td className={td}>{r.receipt_no}{r.kind === "refund" && <span className="text-danger text-xs font-semibold"> REFUND</span>}</td>
                <td className={td}>{fmtTime(r.created_at)}</td><td className={td}>{r.cashier}</td>
                <td className={td}>{r.customer_name ?? "Walk-in"}</td><td className={`${td} capitalize`}>{r.methods?.replaceAll(",", ", ")}</td>
                <td className={`${td} num ${r.total_cents < 0 ? "text-danger" : ""}`}>{fmtKES(r.total_cents)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td className={`${td} text-gray-500`} colSpan={6}>No sales in this period.</td></tr>}
          </tbody>
          {!!shown.length && <tfoot><tr><td className={`${td} font-semibold`} colSpan={5}>Net total</td><td className={`${td} num font-semibold`}>{fmtKES(sum)}</td></tr></tfoot>}
        </table>
      </div>
      {more && <p className="text-sm text-slate-600 mt-2">Showing the latest {SHOW} sales in this period. Choose fewer days to see the others.</p>}
      {open && <SaleView id={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function SaleView({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [sale, setSale] = useState<(SaleDoc & { id: number; kind: string; refunds: { id: number; receipt_no: string; total_cents: number }[] }) | null>(null);
  const [biz, setBiz] = useState<Record<string, string>>({});
  const [refunding, setRefunding] = useState(false);
  const reload = useCallback(() => get(`/api/sales/${id}`).then(setSale), [id]);
  useEffect(() => { reload(); get("/api/settings").then(setBiz); }, [reload]);
  if (!sale) return null;
  return (
    <Modal title={`Receipt ${sale.receipt_no}`} onClose={onClose}>
      <div className="flex justify-center border border-line rounded-md p-3 overflow-auto"><Receipt sale={sale} biz={biz} /></div>
      {sale.refunds.length > 0 && <p className="text-sm text-danger mt-2">Refunded on: {sale.refunds.map((r) => r.receipt_no).join(", ")}</p>}
      <div className="flex gap-2 mt-3 print:hidden">
        <Button className="flex-1" onClick={() => window.print()}>Reprint</Button>
        {sale.kind === "sale" && <Button variant="danger" className="flex-1" onClick={() => setRefunding(true)}>Refund items</Button>}
      </div>
      {refunding && <RefundForm sale={sale} isManager={can("sales.refund")} onClose={() => setRefunding(false)} onDone={() => { setRefunding(false); reload(); onChanged(); }} />}
    </Modal>
  );
}

function RefundForm({ sale, isManager, onClose, onDone }: { sale: SaleDoc & { id: number }; isManager: boolean; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<number, number | null>>({});
  const [method, setMethod] = useState("cash");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [restock, setRestock] = useState(true);
  const [err, setErr] = useState("");
  const submit = async () => {
    const items = sale.items.filter((i) => (qty[i.id] ?? 0) > 0).map((i) => ({ saleItemId: i.id, qtyMilli: toMilli(qty[i.id]!) }));
    if (!items.length) return setErr("Enter a quantity for at least one item");
    if (!reason.trim()) return setErr("A reason is required");
    try { await post(`/api/sales/${sale.id}/refund`, { items, method, reason, restock, approvalPin: pin || undefined }); onDone(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal title="Refund items" onClose={onClose}>
      <div className="space-y-2">
        {sale.items.map((i) => (
          <div key={i.id} className="flex items-center gap-2">
            <div className="flex-1"><div>{i.name}</div><div className="text-xs text-gray-500">sold {fmtQty(i.qty_milli)} {i.unit}</div></div>
            <div className="w-28"><NumInput value={qty[i.id] ?? null} onChange={(n) => setQty((x) => ({ ...x, [i.id]: n }))} placeholder="Qty back" className="num" /></div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 mt-3">
        <Field label="Refund as"><Select className={inputCls} value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="credit">Customer account</option></Select></Field>
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Return items to stock (untick if damaged)</label>
        {!isManager && <Field label="Manager PIN"><PinInput value={pin} onChange={(e) => setPin(e.target.value)} /></Field>}
      </div>
      <div className="mt-2"><ErrorLine msg={err} /></div>
      <div className="flex justify-end gap-2 mt-3"><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={submit}>Process refund</Button></div>
    </Modal>
  );
}
