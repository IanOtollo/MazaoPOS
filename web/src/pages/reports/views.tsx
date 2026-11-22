import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { VAT_LABEL, fmtKES, fmtQty } from "../../../../shared/money";
import { get, fmtTime } from "../../lib/api";
import { METHOD } from "../../lib/charts";
import { csvKes } from "../../lib/csv";
import { useLive } from "../../lib/live";
import { fmtDay, type DashData } from "../../lib/range";
import { ErrorLine, Input, td, th } from "../../lib/ui";
import { Pager } from "../inventory/shared";
import Movers from "./Movers";
import { Empty, Frame, Summary, Table, totalRow } from "./kit";

interface P { d: DashData; period: string }
const slug = (name: string, d: DashData) => `${name}-${d.from}-to-${d.to}`;
const day = (ymd: string) => fmtDay(ymd);

// ---------------------------------------------------------------- 1. Sales summary
export function SalesSummary({ d, period }: P) {
  const rows = [...d.series].reverse(); // newest day first
  const profit = d.current.profit_cents !== null;
  const csv = {
    name: slug("sales-summary", d),
    header: ["Date", "Sales", "Net sales (VAT included)", "VAT", ...(profit ? ["Profit"] : [])],
    rows: [
      ...rows.map((r) => [r.date, r.sales, csvKes(r.net_cents), csvKes(r.vat_cents), ...(profit ? [csvKes(r.profit_cents)] : [])]),
      ["Total", d.current.sales, csvKes(d.current.net_cents), csvKes(d.current.vat_cents), ...(profit ? [csvKes(d.current.profit_cents)] : [])],
    ],
  };
  return (
    <Frame title="Sales summary" desc="Every day in the period: how many sales, how much came in, and the VAT in it." period={period} csv={csv}>
      {!d.current.sales ? <Empty>No sales in this period.</Empty> : (
        <>
          <Summary>{d.current.sales.toLocaleString("en-KE")} sales, net KES {fmtKES(d.current.net_cents)} (VAT included).</Summary>
          <Table>
            <thead><tr><th className={th}>Date</th><th className={`${th} text-right`}>Sales</th><th className={`${th} text-right`}>Net sales</th><th className={`${th} text-right`}>VAT</th>{profit && <th className={`${th} text-right`}>Profit</th>}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.date}>
                  <td className={td}>{day(r.date)}</td><td className={`${td} num`}>{r.sales}</td><td className={`${td} num`}>{fmtKES(r.net_cents)}</td><td className={`${td} num`}>{fmtKES(r.vat_cents)}</td>
                  {profit && <td className={`${td} num`}>{fmtKES(r.profit_cents ?? 0)}</td>}
                </tr>
              ))}
              <tr className={totalRow}>
                <td className={td}>Total</td><td className={`${td} num`}>{d.current.sales}</td><td className={`${td} num`}>{fmtKES(d.current.net_cents)}</td><td className={`${td} num`}>{fmtKES(d.current.vat_cents)}</td>
                {profit && <td className={`${td} num`}>{fmtKES(d.current.profit_cents ?? 0)}</td>}
              </tr>
            </tbody>
          </Table>
        </>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- 2. Items sold
interface ItemRow { id: number; sku: string; name: string; unit: string; qty_milli: number; revenue_cents: number; profit_cents: number | null; orders: number }
interface ItemsResp { from: string; to: string; items: ItemRow[]; totals: { revenue_cents: number; profit_cents: number | null; items: number } }
const PAGE = 50;

export function ItemsSold({ d, period }: P) {
  const [data, setData] = useState<ItemsResp | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);

  const load = useCallback(
    () => get<ItemsResp>(`/api/reports/items-sold?from=${d.from}&to=${d.to}`).then((r) => { setData(r); setErr(""); }).catch((e) => setErr((e as Error).message)),
    [d.from, d.to],
  );
  useEffect(() => { setData(null); load(); }, [load]);
  useLive(["sales"], load);
  useEffect(() => { setPage(0); }, [q, d.from, d.to]);

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = (data?.items ?? []).filter((i) => words.every((w) => `${i.name} ${i.sku}`.toLowerCase().includes(w)));
  const profit = data?.totals.profit_cents != null;
  const csv = data && {
    name: slug("items-sold", d),
    header: ["Item", "Code", "Unit", "Quantity sold", "Sales", ...(profit ? ["Profit"] : []), "Orders"],
    rows: rows.map((i) => [i.name, i.sku, i.unit, fmtQty(i.qty_milli), csvKes(i.revenue_cents), ...(profit ? [csvKes(i.profit_cents)] : []), i.orders]),
  };
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);

  return (
    <Frame title="Items sold" desc="Every item that sold in the period, best first by sales value." period={period} csv={csv ?? null}>
      <ErrorLine msg={err} />
      {!data && !err && <div className="h-40 rounded-lg bg-slate-200/70 animate-pulse" />}
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3 print:hidden">
            <Summary>{data.totals.items.toLocaleString("en-KE")} items sold for KES {fmtKES(data.totals.revenue_cents)}{profit ? `, profit KES ${fmtKES(data.totals.profit_cents ?? 0)}` : ""}.</Summary>
            <Input placeholder="Search name or code" value={q} onChange={(e) => setQ(e.target.value)} className="!w-56" aria-label="Search the items sold" />
          </div>
          {!shown.length ? <Empty>{q ? `No sold item matches "${q}".` : "Nothing sold in this period."}</Empty> : (
            <Table>
              <thead><tr><th className={th}>Item</th><th className={`${th} text-right`}>Sold</th><th className={`${th} text-right`}>Sales</th>{profit && <th className={`${th} text-right hidden sm:table-cell`}>Profit</th>}<th className={`${th} text-right hidden md:table-cell`}>Orders</th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id}>
                    <td className={td}><Link to={`/inventory/${i.id}`} className="font-semibold hover:underline">{i.name}</Link><div className="text-xs text-slate-500">{i.sku}</div></td>
                    <td className={`${td} num`}>{fmtQty(i.qty_milli)} {i.unit}</td>
                    <td className={`${td} num`}>{fmtKES(i.revenue_cents)}</td>
                    {profit && <td className={`${td} num hidden sm:table-cell`}>{fmtKES(i.profit_cents ?? 0)}</td>}
                    <td className={`${td} num hidden md:table-cell`}>{i.orders}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="print:hidden"><Pager page={page} total={rows.length} size={PAGE} noun="items" onPage={setPage} /></div>
        </>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- 3. How customers paid
export function Payments({ d, period }: P) {
  const total = d.methods.reduce((a, m) => a + m.amount_cents, 0);
  const share = (n: number) => (total ? (n / total) * 100 : 0);
  const csv = {
    name: slug("payments", d), header: ["Method", "Amount", "Share %"],
    rows: [...d.methods.map((m) => [METHOD[m.method] ?? m.method, csvKes(m.amount_cents), share(m.amount_cents).toFixed(1)]), ["Total", csvKes(total), total ? "100.0" : "0.0"]],
  };
  return (
    <Frame title="How customers paid" desc="What was received by each way of paying, and what was put on credit." period={period} csv={csv}>
      {!total ? <Empty>No payments in this period.</Empty> : (
        <>
          <Summary>On credit (unpaid) is money still owed, not money received.</Summary>
          <Table>
            <thead><tr><th className={th}>Method</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>Share</th></tr></thead>
            <tbody>
              {d.methods.map((m) => (
                <tr key={m.method}><td className={td}>{METHOD[m.method] ?? m.method}</td><td className={`${td} num`}>{fmtKES(m.amount_cents)}</td><td className={`${td} num`}>{share(m.amount_cents).toFixed(0)}%</td></tr>
              ))}
              <tr className={totalRow}><td className={td}>Total</td><td className={`${td} num`}>{fmtKES(total)}</td><td className={`${td} num`}>100%</td></tr>
            </tbody>
          </Table>
        </>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- 4. VAT
export function Vat({ d, period }: P) {
  const gross = d.byVat.reduce((a, r) => a + r.gross_cents, 0);
  const vat = d.byVat.reduce((a, r) => a + r.vat_cents, 0);
  const csv = {
    name: slug("vat", d), header: ["VAT class", "Gross sales", "VAT", "Net of VAT"],
    rows: [...d.byVat.map((r) => [VAT_LABEL[r.vat_code], csvKes(r.gross_cents), csvKes(r.vat_cents), csvKes(r.gross_cents - r.vat_cents)]), ["Total", csvKes(gross), csvKes(vat), csvKes(gross - vat)]],
  };
  return (
    <Frame title="VAT" desc="Sales split by tax rate, with the VAT collected on each." period={period} csv={csv}>
      {!d.byVat.length ? <Empty>No sales in this period.</Empty> : (
        <Table>
          <thead><tr><th className={th}>VAT class</th><th className={`${th} text-right`}>Gross sales</th><th className={`${th} text-right`}>VAT</th><th className={`${th} text-right`}>Net of VAT</th></tr></thead>
          <tbody>
            {d.byVat.map((r) => (
              <tr key={r.vat_code}><td className={td}>{VAT_LABEL[r.vat_code]}</td><td className={`${td} num`}>{fmtKES(r.gross_cents)}</td><td className={`${td} num`}>{fmtKES(r.vat_cents)}</td><td className={`${td} num`}>{fmtKES(r.gross_cents - r.vat_cents)}</td></tr>
            ))}
            <tr className={totalRow}><td className={td}>Total</td><td className={`${td} num`}>{fmtKES(gross)}</td><td className={`${td} num`}>{fmtKES(vat)}</td><td className={`${td} num`}>{fmtKES(gross - vat)}</td></tr>
          </tbody>
        </Table>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- 5. Sales by person
export function Staff({ d, period }: P) {
  const sales = d.cashiers.reduce((a, c) => a + c.sales, 0);
  const net = d.cashiers.reduce((a, c) => a + c.net_cents, 0);
  const avg = (n: number, s: number) => (s ? Math.round(n / s) : 0);
  const csv = {
    name: slug("sales-by-person", d), header: ["Name", "Sales", "Net sales", "Average sale"],
    rows: [...d.cashiers.map((c) => [c.name, c.sales, csvKes(c.net_cents), csvKes(avg(c.net_cents, c.sales))]), ["Total", sales, csvKes(net), csvKes(avg(net, sales))]],
  };
  return (
    <Frame title="Sales by person" desc="What each person at the till sold in the period." period={period} csv={csv}>
      {!d.cashiers.length ? <Empty>No sales in this period.</Empty> : (
        <Table>
          <thead><tr><th className={th}>Name</th><th className={`${th} text-right`}>Sales</th><th className={`${th} text-right`}>Net sales</th><th className={`${th} text-right hidden sm:table-cell`}>Average sale</th></tr></thead>
          <tbody>
            {d.cashiers.map((c) => (
              <tr key={c.name}><td className={td}>{c.name}</td><td className={`${td} num`}>{c.sales}</td><td className={`${td} num`}>{fmtKES(c.net_cents)}</td><td className={`${td} num hidden sm:table-cell`}>{fmtKES(avg(c.net_cents, c.sales))}</td></tr>
            ))}
            <tr className={totalRow}><td className={td}>Total</td><td className={`${td} num`}>{sales}</td><td className={`${td} num`}>{fmtKES(net)}</td><td className={`${td} num hidden sm:table-cell`}>{fmtKES(avg(net, sales))}</td></tr>
          </tbody>
        </Table>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- 6. Cash-ups
const diffWords = (c: number) => (c === 0 ? "Balanced" : `${c > 0 ? "Over" : "Short"} KES ${fmtKES(Math.abs(c))}`);

export function CashUps({ d, period }: P) {
  const csv = {
    name: slug("cash-ups", d), header: ["Cashier", "Closed", "Expected cash", "Counted cash", "Difference"],
    rows: d.closedShifts.map((s) => [s.cashier, fmtTime(s.closed_at), csvKes(s.expected_cash_cents), csvKes(s.counted_cash_cents), csvKes(s.variance_cents)]),
  };
  return (
    <Frame title="Cash-ups" desc="Cash counted at the end of each shift, against what the system expected." period={period} csv={csv}>
      {d.openShifts.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Still open</h3>
          <Table>
            <thead><tr><th className={th}>Cashier</th><th className={th}>Opened</th><th className={`${th} text-right`}>Expected so far</th></tr></thead>
            <tbody>{d.openShifts.map((s) => <tr key={s.id}><td className={td}>{s.cashier}</td><td className={td}>{fmtTime(s.opened_at)}</td><td className={`${td} num`}>{fmtKES(s.expected_cash_cents)}</td></tr>)}</tbody>
          </Table>
        </div>
      )}
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Closed</h3>
      {!d.closedShifts.length ? <Empty>No shifts were closed in this period.</Empty> : (
        <Table>
          <thead><tr><th className={th}>Cashier</th><th className={th}>Closed</th><th className={`${th} text-right hidden sm:table-cell`}>Expected</th><th className={`${th} text-right hidden sm:table-cell`}>Counted</th><th className={`${th} text-right`}>Difference</th></tr></thead>
          <tbody>
            {d.closedShifts.map((s) => (
              <tr key={s.id}>
                <td className={td}>{s.cashier}</td><td className={td}>{fmtTime(s.closed_at)}</td>
                <td className={`${td} num hidden sm:table-cell`}>{fmtKES(s.expected_cash_cents)}</td><td className={`${td} num hidden sm:table-cell`}>{fmtKES(s.counted_cash_cents)}</td>
                <td className={`${td} num ${s.variance_cents < 0 ? "text-danger font-semibold" : ""}`}>{diffWords(s.variance_cents)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- 7. Money owed by customers
interface OwedRow { id: number; name: string; phone: string | null; balance_cents: number; overdue_cents: number; max_days_overdue: number }
interface OwedResp { totals: { owed_cents: number; overdue_cents: number; customers: number; overdue_customers: number }; customers: OwedRow[] }

export function Owed() {
  const [data, setData] = useState<OwedResp | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => get<OwedResp>("/api/receivables").then((r) => { setData(r); setErr(""); }).catch((e) => setErr((e as Error).message)), []);
  useEffect(() => { load(); }, [load]);
  useLive(["customers", "sales"], load);

  const rows = [...(data?.customers ?? [])].sort((a, b) => b.balance_cents - a.balance_cents);
  const csv = data && {
    name: `money-owed-${new Date().toISOString().slice(0, 10)}`,
    header: ["Customer", "Phone", "Owed", "Overdue", "Days overdue"],
    rows: [...rows.map((r) => [r.name, r.phone ?? "", csvKes(r.balance_cents), csvKes(r.overdue_cents), r.max_days_overdue]), ["Total", "", csvKes(data.totals.owed_cents), csvKes(data.totals.overdue_cents), ""]],
  };
  return (
    <Frame title="Money owed by customers" desc="Everyone who owes you, biggest balance first. This does not depend on the period." period="As of today" csv={csv ?? null}>
      <ErrorLine msg={err} />
      {!data && !err && <div className="h-40 rounded-lg bg-slate-200/70 animate-pulse" />}
      {err && !data && <Empty>This report needs access to the Customers screen.</Empty>}
      {data && (!rows.length ? <Empty>Nobody owes you anything.</Empty> : (
        <>
          <Summary>{data.totals.customers} {data.totals.customers === 1 ? "customer owes" : "customers owe"} KES {fmtKES(data.totals.owed_cents)}; KES {fmtKES(data.totals.overdue_cents)} of it is past its terms. <Link to="/customers" className="text-accent font-semibold hover:underline print:hidden">Open Customers</Link></Summary>
          <Table>
            <thead><tr><th className={th}>Customer</th><th className={`${th} hidden sm:table-cell`}>Phone</th><th className={`${th} text-right`}>Owed</th><th className={`${th} text-right hidden sm:table-cell`}>Overdue</th><th className={`${th} text-right`}>Days overdue</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className={td}>{r.name}</td><td className={`${td} hidden sm:table-cell text-slate-600`}>{r.phone ?? "-"}</td>
                  <td className={`${td} num`}>{fmtKES(r.balance_cents)}</td><td className={`${td} num hidden sm:table-cell ${r.overdue_cents > 0 ? "text-danger font-semibold" : ""}`}>{fmtKES(r.overdue_cents)}</td>
                  <td className={`${td} num`}>{r.max_days_overdue > 0 ? r.max_days_overdue : "Not overdue"}</td>
                </tr>
              ))}
              <tr className={totalRow}><td className={td}>Total</td><td className={`${td} hidden sm:table-cell`} /><td className={`${td} num`}>{fmtKES(data.totals.owed_cents)}</td><td className={`${td} num hidden sm:table-cell`}>{fmtKES(data.totals.overdue_cents)}</td><td className={td} /></tr>
            </tbody>
          </Table>
        </>
      ))}
    </Frame>
  );
}

// ---------------------------------------------------------------- 8. Stock and movers
interface Values { items: number; selling_value_cents: number; cost_value_cents: number; store_cost_value_cents: number; store_items: number; dead_cost_value_cents: number; dead_items: number; dead_days: number }

export function Stock() {
  const [v, setV] = useState<Values | null>(null);
  const [hidden, setHidden] = useState(false);
  const load = useCallback(() => get<Values>("/api/reports/inventory-values").then((r) => { setV(r); setHidden(false); }).catch(() => setHidden(true)), []);
  useEffect(() => { load(); }, [load]);
  useLive(["stock", "products", "sales"], load);

  const tile = (label: string, value: string, sub?: string) => (
    <div className="rounded-lg border border-slate-200 p-3 min-w-0">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="text-lg font-bold tracking-tight truncate">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return (
    <Frame title="Stock and movers" desc="What the stock on hand is worth, and which items sell fast or sit on the shelf." period="As of today">
      {hidden && <p className="text-sm text-slate-500 mb-4">Stock values are only shown to people who can see cost prices.</p>}
      {v && (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-2">
          {tile("Stock at selling price", `KES ${fmtKES(v.selling_value_cents)}`, `${v.items.toLocaleString("en-KE")} items`)}
          {tile("Stock at cost", `KES ${fmtKES(v.cost_value_cents)}`)}
          {tile("Store stock at cost", `KES ${fmtKES(v.store_cost_value_cents)}`, v.store_items ? `${v.store_items.toLocaleString("en-KE")} items` : "Nothing in the store")}
          {tile("Dead stock at cost", `KES ${fmtKES(v.dead_cost_value_cents)}`, `${v.dead_items.toLocaleString("en-KE")} items, no sale in ${v.dead_days} days`)}
        </div>
      )}
      <Movers />
    </Frame>
  );
}
