import type { Ctx } from "./lib";
import { todayEAT } from "./lib";

/*
 * How old is what someone owes (or what we owe a supplier)? Same maths as the old server: payments and
 * credit notes are applied to the OLDEST charges first (first in, first out) and whatever is left on each
 * charge is aged from its due date.
 */
const DAY = 86400000;
const eatDate = (ms: number) => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
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

interface Row { id: number; amount_cents: number; created_at: number; receipt_no: string | null }

export async function ageingFor(ctx: Ctx, customerId: number, creditDays: number): Promise<Ageing> {
  const ledger = await ctx.db.query("customerLedger").withIndex("by_customer", (q) => q.eq("customerId", customerId)).collect();
  ledger.sort((a, b) => a.id - b.id);
  const rows: Row[] = [];
  for (const l of ledger) {
    let receipt: string | null = null;
    if (l.refType === "sale" && l.refId !== undefined) {
      const s = await ctx.db.query("sales").withIndex("by_numId", (q) => q.eq("id", l.refId!)).unique();
      receipt = s?.receiptNo ?? null;
    }
    rows.push({ id: l.id, amount_cents: l.amountCents, created_at: l.createdAt, receipt_no: receipt });
  }
  return ageRows(rows, creditDays);
}

/** The same ageing for what WE owe a supplier. */
export async function supplierAgeing(ctx: Ctx, supplierId: number, creditDays: number): Promise<Ageing> {
  const ledger = await ctx.db.query("supplierLedger").withIndex("by_supplier", (q) => q.eq("supplierId", supplierId)).collect();
  ledger.sort((a, b) => a.id - b.id);
  const rows: Row[] = [];
  for (const l of ledger) {
    let invoice: string | null = null;
    if (l.type === "purchase" && l.refId !== undefined) {
      const p = await ctx.db.query("purchases").withIndex("by_numId", (q) => q.eq("id", l.refId!)).unique();
      invoice = p?.invoiceNo ?? null;
    }
    rows.push({ id: l.id, amount_cents: l.amountCents, created_at: l.createdAt, receipt_no: invoice });
  }
  return ageRows(rows, creditDays);
}

function ageRows(rows: Row[], creditDays: number): Ageing {
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
