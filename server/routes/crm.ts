import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db } from "../db.ts";
import { HttpError, requireLogin, requirePerm } from "../auth.ts";
import { ageingFor } from "../receivables.ts";
import { parse, todayEAT } from "../util.ts";

interface CustomerRow {
  id: number; name: string; phone: string | null; kra_pin: string | null; tier: string;
  credit_limit_cents: number; credit_days: number; active: number;
}

const balanceOf = (id: number) =>
  (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS b FROM customer_ledger WHERE customer_id=?").get(id) as { b: number }).b;

export function crmRoutes(app: FastifyInstance) {
  // Everyone who owes money, oldest debts first. Powers the Owing / Overdue views of the Customers screen.
  app.get("/api/receivables", { preHandler: requirePerm("customers.manage") }, async () => {
    const owing = db
      .prepare(
        `SELECT c.* FROM customers c WHERE c.active=1
         AND (SELECT COALESCE(SUM(amount_cents),0) FROM customer_ledger WHERE customer_id=c.id) > 0`,
      )
      .all() as unknown as CustomerRow[];

    const totals = { owed_cents: 0, overdue_cents: 0, customers: 0, overdue_customers: 0, buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 } };
    const today = todayEAT();
    const rows = owing.map((c) => {
      const a = ageingFor(c.id, c.credit_days);
      const lastPay = db
        .prepare("SELECT created_at FROM customer_ledger WHERE customer_id=? AND type='payment' ORDER BY id DESC LIMIT 1")
        .get(c.id) as { created_at: string } | undefined;
      const promise = db
        .prepare("SELECT promise_date, promise_cents, created_at FROM customer_notes WHERE customer_id=? AND promise_date IS NOT NULL ORDER BY id DESC LIMIT 1")
        .get(c.id) as { promise_date: string; promise_cents: number | null; created_at: string } | undefined;
      let promiseBroken = false;
      if (promise && promise.promise_date < today) {
        const paidSince = (
          db
            .prepare("SELECT COALESCE(-SUM(amount_cents),0) AS p FROM customer_ledger WHERE customer_id=? AND type='payment' AND created_at >= ?")
            .get(c.id, promise.created_at) as { p: number }
        ).p;
        promiseBroken = paidSince < (promise.promise_cents ?? 1);
      }
      totals.owed_cents += a.balance_cents;
      totals.overdue_cents += a.overdue_cents;
      totals.customers += 1;
      if (a.overdue_cents > 0) totals.overdue_customers += 1;
      for (const k of Object.keys(totals.buckets) as (keyof typeof totals.buckets)[]) totals.buckets[k] += a.buckets[k];
      return {
        id: c.id, name: c.name, phone: c.phone, tier: c.tier,
        credit_limit_cents: c.credit_limit_cents, credit_days: c.credit_days,
        balance_cents: a.balance_cents, overdue_cents: a.overdue_cents, max_days_overdue: a.max_days_overdue,
        last_payment_at: lastPay?.created_at ?? null,
        next_promise: promise && promise.promise_date >= today ? { date: promise.promise_date, cents: promise.promise_cents } : null,
        promise_broken: promiseBroken,
      };
    });
    // the longest-overdue first, then the biggest balance
    rows.sort((x, y) => y.max_days_overdue - x.max_days_overdue || y.balance_cents - x.balance_cents);
    return { totals, customers: rows };
  });

  // One customer's full account: ageing, statement with a running balance, and the follow-up log.
  app.get("/api/customers/:id/account", { preHandler: requirePerm("customers.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const c = db.prepare("SELECT * FROM customers WHERE id=?").get(id) as unknown as CustomerRow | undefined;
    if (!c) throw new HttpError(404, "Customer not found");

    const asc = db
      .prepare(
        `SELECT l.id, l.amount_cents, l.type, l.method, l.note, l.created_at, s.receipt_no, cu.name AS cashier, au.name AS approver
         FROM customer_ledger l LEFT JOIN sales s ON l.ref_type='sale' AND s.id=l.ref_id
         LEFT JOIN users cu ON cu.id=s.user_id LEFT JOIN users au ON au.id=s.approved_by
         WHERE l.customer_id=? ORDER BY l.id`,
      )
      .all(id) as unknown as { id: number; amount_cents: number; type: string; method: string | null; note: string | null; created_at: string; receipt_no: string | null; cashier: string | null; approver: string | null }[];
    let run = 0;
    const statement = asc.map((r) => ({ ...r, balance_cents: (run += r.amount_cents) })).reverse();

    const notes = db
      .prepare(
        `SELECT n.id, n.kind, n.body, n.promise_date, n.promise_cents, n.created_at, u.name AS user
         FROM customer_notes n LEFT JOIN users u ON u.id=n.user_id WHERE n.customer_id=? ORDER BY n.id DESC LIMIT 100`,
      )
      .all(id);

    return { customer: c, balance_cents: balanceOf(id), ageing: ageingFor(id, c.credit_days), statement, notes };
  });

  // Log a call, a visit, a note, or a promise to pay.
  app.post("/api/customers/:id/notes", { preHandler: requirePerm("customers.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!db.prepare("SELECT 1 FROM customers WHERE id=?").get(id)) throw new HttpError(404, "Customer not found");
    const b = parse(
      z.object({
        kind: z.enum(["note", "call", "visit", "promise"]),
        body: z.string().trim().max(500).default(""),
        promiseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose the date they promised to pay").optional(),
        promiseCents: z.number().int().positive().optional(),
      }),
      req.body,
    );
    if (b.kind === "promise" && !b.promiseDate) throw new HttpError(400, "Choose the date they promised to pay");
    if (b.kind !== "promise" && !b.body) throw new HttpError(400, "Write a short note");
    const r = db
      .prepare("INSERT INTO customer_notes (customer_id,user_id,kind,body,promise_date,promise_cents) VALUES (?,?,?,?,?,?)")
      .run(id, req.user!.id, b.kind, b.body, b.kind === "promise" ? b.promiseDate! : null, b.kind === "promise" ? (b.promiseCents ?? null) : null);
    audit(req.user!.id, "customer_note", { id, kind: b.kind });
    return { id: Number(r.lastInsertRowid) };
  });
}
