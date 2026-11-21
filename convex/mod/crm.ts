import type { Doc } from "../_generated/dataModel";
import { audit, authenticate, can, fail, nextId, postCustomer, requirePerm, todayEAT, type Ctx, type Handler } from "../lib";
import { ageingFor } from "../receivablesLib";

/*
 * Customers (people who buy on credit), their account statements, follow-up notes and the list of who owes.
 * Same addresses and JSON as the old server; field names stay snake_case like the old rows.
 */
const TIERS = ["retail", "contractor", "wholesale"] as const;
type Tier = (typeof TIERS)[number];
const iso = (ms: number) => new Date(ms).toISOString();

const customerById = (ctx: Ctx, id: number) => ctx.db.query("customers").withIndex("by_numId", (q) => q.eq("id", id)).unique();

/** A customer as the screens expect it (the old SQLite row). */
const row = (c: Doc<"customers">) => ({
  id: c.id, name: c.name, phone: c.phone ?? null, kra_pin: null as string | null, tier: c.tier,
  credit_limit_cents: c.creditLimitCents, credit_days: c.creditDays, credit_stopped: c.creditStopped ? 1 : 0,
  active: c.active ? 1 : 0, created_at: iso(c.createdAt),
});

const userNames = async (ctx: Ctx) => new Map((await ctx.db.query("users").collect()).map((u) => [u.id, u.name]));

// ---- small validators (messages follow the old "field: message" style)
const optText = (x: unknown, what: string): string | null | undefined => {
  if (x === undefined) return undefined;
  if (x === null) return null;
  if (typeof x !== "string") return fail(400, `${what}: Invalid input`);
  return x;
};
const optInt = (x: unknown, what: string, min: number, max?: number): number | undefined => {
  if (x === undefined) return undefined;
  if (typeof x !== "number" || !Number.isInteger(x)) return fail(400, `${what}: Invalid input: expected int`);
  if (x < min) return fail(400, `${what}: Too small: expected number to be >=${min}`);
  if (max !== undefined && x > max) return fail(400, `${what}: Too big: expected number to be <=${max}`);
  return x;
};
const optBool = (x: unknown, what: string): boolean | undefined => {
  if (x === undefined) return undefined;
  if (typeof x !== "boolean") return fail(400, `${what}: Invalid input: expected boolean`);
  return x;
};
const optTier = (x: unknown): Tier | undefined => {
  if (x === undefined) return undefined;
  if (!TIERS.includes(x as Tier)) return fail(400, "tier: Invalid option: expected one of \"retail\"|\"contractor\"|\"wholesale\"");
  return x as Tier;
};

const customerId = (p: Record<string, string>) => Number(p.id);

export const routes: Record<string, Handler> = {
  // ---------------- customers ----------------
  "GET /api/customers": async (ctx, { token, query }) => {
    const user = await authenticate(ctx, token);
    const q = (query.q ?? "").toLowerCase();
    let rows = (await ctx.db.query("customers").collect()).filter((c) => c.active);
    if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q) || (c.phone ?? "").toLowerCase().includes(q));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const mgr = can(user, "customers.manage");
    return rows.map((c) => ({
      ...row(c),
      credit_available_cents: Math.max(0, c.creditLimitCents - Math.max(0, c.balanceCents)),
      balance_cents: mgr ? c.balanceCents : 0, // a cashier does not see who owes what
    }));
  },

  "POST /api/customers": async (ctx, { token, body }) => {
    const actor = await requirePerm(ctx, token, "customers.create");
    const b = body ?? {};
    if (typeof b.name !== "string" || b.name.trim().length < 1) return fail(400, "name: Too small: expected string to have >=1 characters");
    const phone = optText(b.phone, "phone");
    optText(b.kraPin, "kraPin"); // no longer kept: the shop does not record KRA PINs on customers
    const tier = optTier(b.tier) ?? "retail";
    const creditLimitCents = optInt(b.creditLimitCents, "creditLimitCents", 0) ?? 0;
    const creditDays = optInt(b.creditDays, "creditDays", 0, 365) ?? 30;
    const creditStopped = optBool(b.creditStopped, "creditStopped") ?? false;
    // only managers may grant credit or special price tiers
    if ((creditLimitCents > 0 || tier !== "retail") && !can(actor, "customers.manage")) return fail(403, "Your role cannot set a price tier or credit limit");
    const id = await nextId(ctx, "customers");
    await ctx.db.insert("customers", {
      id, name: b.name.trim(), ...(phone ? { phone } : {}), tier, creditLimitCents, creditDays, creditStopped,
      active: true, balanceCents: 0, createdAt: Date.now(),
    });
    await audit(ctx, actor.id, "customer_create", { name: b.name });
    return { id };
  },

  "PATCH /api/customers/:id": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "customers.manage");
    const id = customerId(params);
    const b = body ?? {};
    // a field that is not sent is left exactly as it was
    let name: string | undefined;
    if (b.name !== undefined) {
      if (typeof b.name !== "string" || b.name.trim().length < 1) return fail(400, "name: Too small: expected string to have >=1 characters");
      name = b.name.trim();
    }
    const phone = optText(b.phone, "phone");
    optText(b.kraPin, "kraPin");
    const tier = optTier(b.tier);
    const creditLimitCents = optInt(b.creditLimitCents, "creditLimitCents", 0);
    const creditDays = optInt(b.creditDays, "creditDays", 0, 365);
    const creditStopped = optBool(b.creditStopped, "creditStopped");
    const active = optBool(b.active, "active");
    const cur = await customerById(ctx, id);
    if (!cur) return fail(404, "Customer not found");
    const patch: Partial<Doc<"customers">> = {};
    if (name !== undefined) patch.name = name;
    if (phone !== undefined) patch.phone = phone ? phone : undefined; // null or empty clears the number
    if (tier !== undefined) patch.tier = tier;
    if (creditLimitCents !== undefined) patch.creditLimitCents = creditLimitCents;
    if (creditDays !== undefined) patch.creditDays = creditDays;
    if (creditStopped !== undefined) patch.creditStopped = creditStopped;
    if (active !== undefined) patch.active = active;
    await ctx.db.patch(cur._id, patch);
    await audit(ctx, actor.id, "customer_update", { id, name, phone, tier, creditLimitCents, creditDays, creditStopped, active });
    return { ok: true };
  },

  "GET /api/customers/:id": async (ctx, { token, params }) => {
    await requirePerm(ctx, token, "customers.manage");
    const id = customerId(params);
    const c = await customerById(ctx, id);
    if (!c) return fail(404, "Customer not found");
    const all = await ctx.db.query("customerLedger").withIndex("by_customer", (q) => q.eq("customerId", id)).collect();
    all.sort((a, b) => b.id - a.id);
    const ledger = all.slice(0, 1000).map((l) => ({
      id: l.id, customer_id: l.customerId, amount_cents: l.amountCents, type: l.type, ref_type: l.refType ?? null, ref_id: l.refId ?? null,
      method: l.method ?? null, note: l.note ?? null, user_id: l.userId ?? null, created_at: iso(l.createdAt),
    }));
    return { ...row(c), balance_cents: c.balanceCents, ledger };
  },

  // customer pays down their account
  "POST /api/customers/:id/payment": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "customers.payment");
    const id = customerId(params);
    const b = body ?? {};
    if (typeof b.amountCents !== "number" || !Number.isInteger(b.amountCents) || b.amountCents <= 0) return fail(400, "amountCents: Too small: expected number to be >0");
    if (!["cash", "mpesa", "card", "bank"].includes(b.method)) return fail(400, "method: Invalid option: expected one of \"cash\"|\"mpesa\"|\"card\"|\"bank\"");
    const reference = optText(b.reference, "reference");
    const c = await customerById(ctx, id);
    if (!c) return fail(404, "Customer not found");
    if (b.amountCents > c.balanceCents) return fail(400, "Payment is more than the balance owed");
    const balance = await postCustomer(ctx, {
      customerId: id, amountCents: -b.amountCents, type: "payment", method: b.method, ...(reference ? { note: reference } : {}), userId: actor.id,
    });
    await audit(ctx, actor.id, "customer_payment", { id, amountCents: b.amountCents, method: b.method, reference });
    return { balance_cents: balance };
  },

  // ---------------- who owes ----------------
  // Everyone who owes money, oldest debts first. Powers the Owing / Overdue views of the Customers screen.
  "GET /api/receivables": async (ctx, { token }) => {
    await requirePerm(ctx, token, "customers.manage");
    const owing = (await ctx.db.query("customers").collect()).filter((c) => c.active && c.balanceCents > 0);

    const totals = { owed_cents: 0, overdue_cents: 0, customers: 0, overdue_customers: 0, buckets: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 } };
    const today = todayEAT();
    const rows = [];
    for (const c of owing) {
      const a = await ageingFor(ctx, c.id, c.creditDays);
      const ledger = await ctx.db.query("customerLedger").withIndex("by_customer", (q) => q.eq("customerId", c.id)).collect();
      ledger.sort((x, y) => x.id - y.id);
      const payments = ledger.filter((l) => l.type === "payment");
      const lastPay = payments[payments.length - 1];
      const notes = await ctx.db.query("customerNotes").withIndex("by_customer", (q) => q.eq("customerId", c.id)).collect();
      notes.sort((x, y) => x.id - y.id);
      const withPromise = notes.filter((n) => n.promiseDate !== undefined);
      const promise = withPromise[withPromise.length - 1];
      let promiseBroken = false;
      if (promise && promise.promiseDate! < today) {
        const paidSince = payments.filter((l) => l.createdAt >= promise.createdAt).reduce((s, l) => s - l.amountCents, 0);
        promiseBroken = paidSince < (promise.promiseCents ?? 1);
      }
      totals.owed_cents += a.balance_cents;
      totals.overdue_cents += a.overdue_cents;
      totals.customers += 1;
      if (a.overdue_cents > 0) totals.overdue_customers += 1;
      for (const k of Object.keys(totals.buckets) as (keyof typeof totals.buckets)[]) totals.buckets[k] += a.buckets[k];
      rows.push({
        id: c.id, name: c.name, phone: c.phone ?? null, tier: c.tier,
        credit_limit_cents: c.creditLimitCents, credit_days: c.creditDays, credit_stopped: c.creditStopped ? 1 : 0,
        balance_cents: a.balance_cents, overdue_cents: a.overdue_cents, max_days_overdue: a.max_days_overdue,
        last_payment_at: lastPay ? iso(lastPay.createdAt) : null,
        next_promise: promise && promise.promiseDate! >= today ? { date: promise.promiseDate!, cents: promise.promiseCents ?? null } : null,
        promise_broken: promiseBroken,
      });
    }
    // the longest-overdue first, then the biggest balance
    rows.sort((x, y) => y.max_days_overdue - x.max_days_overdue || y.balance_cents - x.balance_cents);
    return { totals, customers: rows };
  },

  // One customer's full account: ageing, statement with a running balance, and the follow-up log.
  "GET /api/customers/:id/account": async (ctx, { token, params }) => {
    await requirePerm(ctx, token, "customers.manage");
    const id = customerId(params);
    const c = await customerById(ctx, id);
    if (!c) return fail(404, "Customer not found");
    const names = await userNames(ctx);

    const ledger = await ctx.db.query("customerLedger").withIndex("by_customer", (q) => q.eq("customerId", id)).collect();
    ledger.sort((a, b) => a.id - b.id);
    let run = 0;
    const asc = [];
    for (const l of ledger) {
      let receipt: string | null = null, cashier: string | null = null, approver: string | null = null;
      if (l.refType === "sale" && l.refId !== undefined) {
        const s = await ctx.db.query("sales").withIndex("by_numId", (q) => q.eq("id", l.refId!)).unique();
        if (s) {
          receipt = s.receiptNo;
          cashier = names.get(s.userId) ?? null;
          approver = s.approvedBy !== undefined ? (names.get(s.approvedBy) ?? null) : null;
        }
      }
      asc.push({
        id: l.id, amount_cents: l.amountCents, type: l.type, method: l.method ?? null, note: l.note ?? null, created_at: iso(l.createdAt),
        receipt_no: receipt, cashier, approver, balance_cents: (run += l.amountCents),
      });
    }
    const statement = asc.reverse();

    const allNotes = await ctx.db.query("customerNotes").withIndex("by_customer", (q) => q.eq("customerId", id)).collect();
    allNotes.sort((a, b) => b.id - a.id);
    const notes = allNotes.slice(0, 100).map((n) => ({
      id: n.id, kind: n.kind, body: n.body, promise_date: n.promiseDate ?? null, promise_cents: n.promiseCents ?? null,
      created_at: iso(n.createdAt), user: n.userId !== undefined ? (names.get(n.userId) ?? null) : null,
    }));

    return { customer: row(c), balance_cents: c.balanceCents, ageing: await ageingFor(ctx, id, c.creditDays), statement, notes };
  },

  // Log a call, a visit, a note, or a promise to pay.
  "POST /api/customers/:id/notes": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "customers.manage");
    const id = customerId(params);
    if (!(await customerById(ctx, id))) return fail(404, "Customer not found");
    const b = body ?? {};
    if (!["note", "call", "visit", "promise"].includes(b.kind)) return fail(400, "kind: Invalid option: expected one of \"note\"|\"call\"|\"visit\"|\"promise\"");
    let text = "";
    if (b.body !== undefined) {
      if (typeof b.body !== "string") return fail(400, "body: Invalid input: expected string");
      text = b.body.trim();
      if (text.length > 500) return fail(400, "body: Too big: expected string to have <=500 characters");
    }
    let promiseDate: string | undefined;
    if (b.promiseDate !== undefined) {
      if (typeof b.promiseDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.promiseDate)) return fail(400, "promiseDate: Choose the date they promised to pay");
      promiseDate = b.promiseDate;
    }
    let promiseCents: number | undefined;
    if (b.promiseCents !== undefined) {
      if (typeof b.promiseCents !== "number" || !Number.isInteger(b.promiseCents) || b.promiseCents <= 0) return fail(400, "promiseCents: Too small: expected number to be >0");
      promiseCents = b.promiseCents;
    }
    if (b.kind === "promise" && !promiseDate) return fail(400, "Choose the date they promised to pay");
    if (b.kind !== "promise" && !text) return fail(400, "Write a short note");
    const noteId = await nextId(ctx, "customerNotes");
    await ctx.db.insert("customerNotes", {
      id: noteId, customerId: id, userId: actor.id, kind: b.kind, body: text,
      ...(b.kind === "promise" ? { promiseDate: promiseDate!, ...(promiseCents !== undefined ? { promiseCents } : {}) } : {}),
      createdAt: Date.now(),
    });
    await audit(ctx, actor.id, "customer_note", { id, kind: b.kind });
    return { id: noteId };
  },
};
