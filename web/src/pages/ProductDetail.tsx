import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Ban, CircleCheck, ClipboardCheck, ArrowLeftRight, PackagePlus, Pencil } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { fmtKES, fmtQty, VAT_LABEL } from "../../../shared/money";
import { ApiError, fmtTime, get, patch, useAuth, type Product } from "../lib/api";
import { Button, td, th } from "../lib/ui";
import { useToast } from "../lib/toast";
import { useLive } from "../lib/live";
import { fmtDay } from "../lib/range";
import { ProductForm, StockForm } from "./inventory/forms";
import { SignedQty, StatusBadge, kes, moveLabel, type StockStatus } from "./inventory/shared";

/** Shared look of the action buttons: a small icon before the label. */
const ACT = "inline-flex items-center gap-2";

interface Detail {
  product: Product;
  stock: { location_id: number; location: string; qty_milli: number }[];
  margin_percent: number | null;
  status: StockStatus;
  sales: { sold_30_milli: number; sold_90_milli: number; sold_all_milli: number; revenue_90_cents: number; orders_90: number; last_sold_at: string | null; avg_price_cents_90: number | null };
  purchases: { id: number; received_on: string; supplier: string | null; invoice_no: string | null; qty_milli: number; unit_cost_cents: number | null }[];
  lpos_open: { id: number; number: string; supplier: string; status: string; ordered_milli: number; received_milli: number; expected_on: string | null }[];
  movements: { id: number; created_at: string; location: string; type: string; qty_milli: number; unit_cost_cents: number | null; note: string | null; user: string | null; ref_type: string | null; ref_id: number | null }[];
}

const LPO_STATUS: Record<string, string> = { draft: "Draft", sent: "Sent", partial: "Partly received", received: "Received", cancelled: "Cancelled" };

/** Everything about one product: stock by location, what it earns, how it sells, what was bought and every movement. */
export default function ProductDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const canManage = can("products.manage");
  const canStock = can("stock.manage");
  const canCost = can("products.view_cost");
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState(false);
  const [stock, setStock] = useState<"receive" | "count" | "transfer" | null>(null);

  const load = useCallback(() => get<Detail>(`/api/products/${id}`).then((r) => { setD(r); setMissing(false); setErr(""); }).catch((e) => {
    if ((e as ApiError).status === 404) setMissing(true); else setErr((e as Error).message);
  }), [id]);
  useEffect(() => { setD(null); setMissing(false); load(); }, [load]);
  useLive(["stock", "products", "sales"], load);

  if (missing) {
    return (
      <div className="p-4 max-w-md mx-auto text-center py-20">
        <p className="text-sm font-semibold text-slate-500 tracking-wide">ERROR 404</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Product not found</h1>
        <p className="mt-2 text-slate-600">It may have been removed, or the address is mistyped.</p>
        <Link to="/inventory" className="inline-block mt-4"><Button variant="primary">Back to Inventory</Button></Link>
      </div>
    );
  }
  if (!d) return <div className="p-4 text-slate-500" role="status">{err ? <span className="text-danger font-medium" role="alert">{err}</span> : "Loading"}</div>;

  const p = d.product;
  const qtyAt = (loc: number) => d.stock.find((s) => s.location_id === loc)?.qty_milli ?? 0;
  const forForms: Product = { ...p, stock_shop: qtyAt(1), stock_store: qtyAt(2) };
  const onHand = d.stock.reduce((a, s) => a + s.qty_milli, 0);
  const atCost = Math.round((p.cost_cents * Math.max(0, onHand)) / 1000);
  const atPrice = Math.round((p.price_retail_cents * Math.max(0, onHand)) / 1000);
  const after = () => { toast({ msg: "Saved" }); setEdit(false); setStock(null); load(); };

  const setActive = async (active: boolean) => {
    try { await patch(`/api/products/${p.id}`, { active }); toast({ msg: active ? "Product is active again" : "Product deactivated. It no longer shows at the till." }); load(); }
    catch (e) { toast({ msg: (e as Error).message, kind: "err" }); }
  };

  return (
    <div className="p-4 max-w-6xl">
      <nav className="text-sm text-slate-500 mb-2" aria-label="Breadcrumb"><Link to="/inventory" className="hover:underline">Inventory</Link> <span aria-hidden>/</span> <span className="text-slate-700">{p.name}</span></nav>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{p.name}</h1>
            <StatusBadge status={d.status} />
            {!p.active && <span className="text-[11px] uppercase tracking-wide font-semibold text-slate-500 border border-slate-300 rounded px-1.5 py-0.5">Inactive</span>}
          </div>
          <p className="text-slate-500 mt-0.5">{[p.sku, p.barcode, p.category].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canStock && <Button onClick={() => setStock("receive")} className={ACT}><PackagePlus className="size-4" aria-hidden />Receive stock</Button>}
          {canStock && <Button onClick={() => setStock("count")} className={ACT}><ClipboardCheck className="size-4" aria-hidden />Count stock</Button>}
          {canStock && <Button onClick={() => setStock("transfer")} className={ACT}><ArrowLeftRight className="size-4" aria-hidden />Move stock</Button>}
          {canManage && <Button variant="primary" onClick={() => setEdit(true)} className={ACT}><Pencil className="size-4" aria-hidden />Edit product</Button>}
          {canManage && (p.active ? <Button onClick={() => setActive(false)} className={ACT}><Ban className="size-4" aria-hidden />Deactivate</Button> : <Button onClick={() => setActive(true)} className={ACT}><CircleCheck className="size-4" aria-hidden />Activate</Button>)}
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-px bg-line border border-line rounded-xl overflow-hidden shadow-card mb-6">
        <Cell label="On hand" value={`${fmtQty(onHand)} ${p.unit}`} warn={d.status === "low" || d.status === "out"} />
        <Cell label="Shop" value={fmtQty(qtyAt(1))} />
        <Cell label="Store" value={fmtQty(qtyAt(2))} />
        {canCost && <Cell label="Stock value at cost" value={kes(atCost)} />}
        <Cell label="Stock value at price" value={kes(atPrice)} />
        {canCost && <Cell label="Margin" value={d.margin_percent == null ? "—" : `${d.margin_percent.toFixed(1)}%`} />}
        <Cell label="Sold, last 30 days" value={`${fmtQty(d.sales.sold_30_milli)} ${p.unit}`} />
        <Cell label="Sold, last 90 days" value={`${fmtQty(d.sales.sold_90_milli)} ${p.unit}`} sub={d.sales.orders_90 ? `${d.sales.orders_90.toLocaleString("en-KE")} sales, ${kes(d.sales.revenue_90_cents)}` : undefined} />
        <Cell label="Sold, all time" value={`${fmtQty(d.sales.sold_all_milli)} ${p.unit}`} />
        <Cell label="Last sold" value={d.sales.last_sold_at ? fmtTime(d.sales.last_sold_at) : "Never"} />
      </dl>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <Section title="Details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4">
            <Row k="Sold by" v={`${p.unit}${p.allow_fraction ? " (fractions allowed)" : ""}`} />
            <Row k="VAT" v={VAT_LABEL[p.vat_code]} />
            <Row k="Barcode" v={p.barcode ?? "—"} />
            <Row k="Reorder level" v={p.reorder_level_milli > 0 ? `${fmtQty(p.reorder_level_milli)} ${p.unit}` : "Not set"} />
            <Row k="Retail price" v={fmtKES(p.price_retail_cents)} />
            <Row k="Contractor price" v={p.price_contractor_cents == null ? "Same as retail" : fmtKES(p.price_contractor_cents)} />
            <Row k="Wholesale price" v={p.price_wholesale_cents == null ? "Same as contractor or retail" : fmtKES(p.price_wholesale_cents)} />
            {canCost && <Row k="Cost price" v={fmtKES(p.cost_cents)} />}
            {d.sales.avg_price_cents_90 != null && <Row k="Average sale price, 90 days" v={fmtKES(d.sales.avg_price_cents_90)} />}
            <Row k="Pack sizes" v={p.units.length
              ? <ul className="space-y-0.5">{p.units.map((u) => <li key={u.id}>{u.name}: {fmtQty(u.factor_milli)} {p.unit}{u.price_cents != null ? `, ${fmtKES(u.price_cents)}` : ""}</li>)}</ul>
              : "None"} />
          </dl>
        </Section>

        <Section title="Stock by location">
          <table className="w-full">
            <thead><tr><th className={th}>Location</th><th className={`${th} text-right`}>Quantity</th>{canCost && <th className={`${th} text-right`}>Value at cost</th>}</tr></thead>
            <tbody>
              {d.stock.map((s) => (
                <tr key={s.location_id}><td className={td}>{s.location}</td><td className={`${td} num`}>{fmtQty(s.qty_milli)} {p.unit}</td>
                  {canCost && <td className={`${td} num`}>{kes(Math.round((p.cost_cents * Math.max(0, s.qty_milli)) / 1000))}</td>}</tr>
              ))}
              <tr className="font-semibold"><td className={td}>Total</td><td className={`${td} num`}>{fmtQty(onHand)} {p.unit}</td>{canCost && <td className={`${td} num`}>{kes(atCost)}</td>}</tr>
            </tbody>
          </table>
        </Section>
      </div>

      {d.lpos_open.length > 0 && (
        <Section title="Open orders" className="mb-6">
          <table className="w-full">
            <thead><tr><th className={th}>Order</th><th className={`${th} hidden sm:table-cell`}>Supplier</th><th className={th}>Status</th><th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Still due</th><th className={`${th} hidden md:table-cell`}>Expected</th></tr></thead>
            <tbody>
              {d.lpos_open.map((o) => (
                <tr key={o.id}>
                  <td className={td}>{can("suppliers.manage") ? <Link to="/suppliers" className="font-medium hover:underline">{o.number}</Link> : o.number}</td>
                  <td className={`${td} hidden sm:table-cell`}>{o.supplier}</td><td className={td}>{LPO_STATUS[o.status] ?? o.status}</td>
                  <td className={`${td} num`}>{fmtQty(o.ordered_milli)}</td><td className={`${td} num`}>{fmtQty(Math.max(0, o.ordered_milli - o.received_milli))}</td>
                  <td className={`${td} hidden md:table-cell`}>{o.expected_on ? fmtDay(o.expected_on) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section title="Recent deliveries" className="mb-6">
        <table className="w-full">
          <thead><tr><th className={th}>Date</th><th className={`${th} hidden sm:table-cell`}>Supplier</th><th className={`${th} hidden md:table-cell`}>Invoice</th><th className={`${th} text-right`}>Quantity</th>{canCost && <th className={`${th} text-right`}>Cost each</th>}</tr></thead>
          <tbody>
            {d.purchases.map((x) => (
              <tr key={x.id}><td className={td}>{fmtDay(x.received_on)}</td><td className={`${td} hidden sm:table-cell`}>{x.supplier ?? "—"}</td><td className={`${td} hidden md:table-cell`}>{x.invoice_no ?? "—"}</td>
                <td className={`${td} num`}>{fmtQty(x.qty_milli)}</td>{canCost && <td className={`${td} num`}>{x.unit_cost_cents == null ? "—" : fmtKES(x.unit_cost_cents)}</td>}</tr>
            ))}
            {!d.purchases.length && <tr><td colSpan={5} className={`${td} text-center text-slate-500 py-8`}>No deliveries recorded for this item.</td></tr>}
          </tbody>
        </table>
      </Section>

      <Section title="Stock movements" aside={canStock ? <Link to={`/inventory?tab=movements&product=${p.id}`} className="text-sm font-semibold underline underline-offset-2 hover:text-slate-900">See all movements</Link> : undefined}>
        <table className="w-full">
          <thead>
            <tr><th className={th}>When</th><th className={`${th} hidden sm:table-cell`}>Location</th><th className={th}>Type</th><th className={`${th} text-right`}>Quantity</th>
              {canCost && <th className={`${th} text-right hidden md:table-cell`}>Cost</th>}<th className={`${th} hidden md:table-cell`}>By</th><th className={`${th} hidden lg:table-cell`}>Note</th></tr>
          </thead>
          <tbody>
            {d.movements.map((m) => (
              <tr key={m.id}>
                <td className={`${td} whitespace-nowrap text-slate-600`}>{fmtTime(m.created_at)}</td><td className={`${td} hidden sm:table-cell`}>{m.location}</td><td className={td}>{moveLabel(m.type)}</td>
                <td className={`${td} num`}><SignedQty milli={m.qty_milli} fmt={fmtQty} /></td>
                {canCost && <td className={`${td} num hidden md:table-cell`}>{m.unit_cost_cents == null ? "—" : fmtKES(m.unit_cost_cents)}</td>}
                <td className={`${td} hidden md:table-cell text-slate-600`}>{m.user ?? "—"}</td><td className={`${td} hidden lg:table-cell text-slate-600`}>{m.note ?? ""}</td>
              </tr>
            ))}
            {!d.movements.length && <tr><td colSpan={7} className={`${td} text-center text-slate-500 py-8`}>No stock movements yet.</td></tr>}
          </tbody>
        </table>
      </Section>

      {edit && <ProductForm product={forForms} onClose={() => setEdit(false)} onSaved={after} />}
      {stock && <StockForm p={forForms} mode={stock} onClose={() => setStock(null)} onSaved={after} />}
    </div>
  );
}

function Cell({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="bg-white p-3 min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className={`font-bold tracking-tight truncate ${warn ? "text-amber-700" : ""}`}>{value}</dd>
      {sub && <dd className="text-xs text-slate-500 truncate">{sub}</dd>}
    </div>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (<><dt className="text-slate-500">{k}</dt><dd className="font-medium">{v}</dd></>);
}

function Section({ title, children, aside, className = "" }: { title: string; children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between mb-2"><h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>{aside}</div>
      <div className="bg-white border border-line rounded-xl shadow-card overflow-auto">{children}</div>
    </section>
  );
}
