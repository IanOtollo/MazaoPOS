import { fmtKES, fmtQty } from "../../../shared/money";
import { fmtTime } from "./api";

export interface SaleDoc {
  receipt_no: string; kind: string; created_at: string; cashier: string; customer_name: string | null; customer_pin: string | null;
  subtotal_cents: number; discount_cents: number; total_cents: number; vat_cents: number; note: string | null;
  etims_status: string; etims_invoice_no: string | null;
  items: { id: number; name: string; unit: string; qty_milli: number; unit_price_cents: number; line_total_cents: number; vat_code: string }[];
  payments: { method: string; amount_cents: number; reference: string | null }[];
  changeCents?: number;
}

export function Receipt({ sale, biz }: { sale: SaleDoc; biz: Record<string, string> }) {
  const refund = sale.kind === "refund";
  return (
    <div className="receipt">
      <div style={{ textAlign: "center" }}>
        <strong style={{ fontSize: 14 }}>{biz.business_name}</strong>
        {biz.address && <div>{biz.address}</div>}
        {biz.phone && <div>Tel {biz.phone}</div>}
        {biz.kra_pin && <div>PIN {biz.kra_pin}</div>}
      </div>
      <hr />
      <div style={{ textAlign: "center" }}><strong>{refund ? "REFUND / CREDIT NOTE" : "SALES RECEIPT"}</strong></div>
      <div className="row"><span>No.</span><span>{sale.receipt_no}</span></div>
      <div className="row"><span>Date</span><span>{fmtTime(sale.created_at)}</span></div>
      <div className="row"><span>Served by</span><span>{sale.cashier}</span></div>
      {sale.customer_name && <div className="row"><span>Customer</span><span>{sale.customer_name}</span></div>}
      {sale.customer_pin && <div className="row"><span>Cust. PIN</span><span>{sale.customer_pin}</span></div>}
      <hr />
      {sale.items.map((i) => (
        <div key={i.id} style={{ marginBottom: 3 }}>
          <div>{i.name}</div>
          <div className="row">
            <span>{fmtQty(i.qty_milli)} {i.unit} x {fmtKES(i.unit_price_cents)} {i.vat_code}</span>
            <span>{fmtKES(i.line_total_cents)}</span>
          </div>
        </div>
      ))}
      <hr />
      {sale.discount_cents > 0 && <div className="row"><span>Subtotal</span><span>{fmtKES(sale.subtotal_cents)}</span></div>}
      {sale.discount_cents > 0 && <div className="row"><span>Discount</span><span>-{fmtKES(sale.discount_cents)}</span></div>}
      <div className="row" style={{ fontSize: 14 }}><strong>TOTAL KES</strong><strong>{fmtKES(sale.total_cents)}</strong></div>
      <div className="row"><span>VAT included</span><span>{fmtKES(sale.vat_cents)}</span></div>
      <hr />
      {sale.payments.map((p, i) => (
        <div key={i} className="row">
          <span style={{ textTransform: "capitalize" }}>{p.method}{p.reference ? ` (${p.reference})` : ""}</span>
          <span>{fmtKES(p.amount_cents)}</span>
        </div>
      ))}
      {!!sale.changeCents && <div className="row"><span>Change</span><span>{fmtKES(sale.changeCents)}</span></div>}
      <hr />
      {sale.etims_invoice_no ? (
        <div>KRA CU Invoice No: {sale.etims_invoice_no}</div>
      ) : (
        <div style={{ textAlign: "center" }}>Fiscal invoice (eTIMS): {sale.etims_status}</div>
      )}
      {biz.receipt_footer && <div style={{ textAlign: "center", marginTop: 6 }}>{biz.receipt_footer}</div>}
    </div>
  );
}
