import { db } from "./db.ts";
import { todayEAT } from "./util.ts";

const DAY = 86400000;
const eatDate = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export interface OpenItem {
  ledger_id: number;
  date: string; // day the customer took the goods
  due: string; // date + the customer's credit days
  amount_cents: number; // still unpaid on this charge
  receipt_no: string | null;
  days_overdue: number;
}
export interface Ageing {
  balance_cents: number;
  items: OpenItem[];
  buckets: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
  overdue_cents: number;
  max_days_overdue: number;
}

/**
 * How old is what this customer owes? Payments and credit notes are applied to the OLDEST charges first
 * (first in, first out), and whatever is left on each charge is aged from its due date.
 * A customer who has overpaid simply has nothing open.
 */
export function ageingFor(customerId: number, creditDays: number): Ageing {
  const rows = db
    .prepare(
      `SELECT l.id, l.amount_cents, l.created_at, s.receipt_no FROM customer_ledger l
       LEFT JOIN sales s ON l.ref_type='sale' AND s.id=l.ref_id WHERE l.customer_id=? ORDER BY l.id`,
    )
    .all(customerId) as unknown as { id: number; amount_cents: number; created_at: string; receipt_no: string | null }[];
  return ageRows(rows, creditDays);
}

/** The same ageing for what WE owe a supplier. */
export function supplierAgeing(supplierId: number, creditDays: number): Ageing {
  const rows = db
    .prepare(
      `SELECT l.id, l.amount_cents, l.created_at, p.invoice_no AS receipt_no FROM supplier_ledger l
       LEFT JOIN purchases p ON l.type='purchase' AND p.id=l.ref_id WHERE l.supplier_id=? ORDER BY l.id`,
    )
    .all(supplierId) as unknown as { id: number; amount_cents: number; created_at: string; receipt_no: string | null }[];
  return ageRows(rows, creditDays);
}

function ageRows(rows: { id: number; amount_cents: number; created_at: string; receipt_no: string | null }[], creditDays: number): Ageing {
  let credit = rows.filter((r) => r.amount_cents < 0).reduce((a, r) => a - r.amount_cents, 0);
  const today = todayEAT();
  const items: OpenItem[] = [];
  for (const r of rows) {
    if (r.amount_cents <= 0) continue;
    const used = Math.min(credit, r.amount_cents);
    credit -= used;
    const left = r.amount_cents - used;
    if (left <= 0) continue;
    const date = eatDate(r.created_at);
    const due = addDays(date, creditDays);
    items.push({ ledger_id: r.id, date, due, amount_cents: left, receipt_no: r.receipt_no, days_overdue: Math.max(0, daysBetween(due, today)) });
  }

  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const it of items) {
    const d = it.days_overdue;
    if (d === 0) buckets.current += it.amount_cents;
    else if (d <= 30) buckets.d1_30 += it.amount_cents;
    else if (d <= 60) buckets.d31_60 += it.amount_cents;
    else if (d <= 90) buckets.d61_90 += it.amount_cents;
    else buckets.d90plus += it.amount_cents;
  }
  const balance = items.reduce((a, i) => a + i.amount_cents, 0);
  return {
    balance_cents: balance,
    items,
    buckets,
    overdue_cents: balance - buckets.current,
    max_days_overdue: items.reduce((m, i) => Math.max(m, i.days_overdue), 0),
  };
}
