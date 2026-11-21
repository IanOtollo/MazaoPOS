import { can, eatDayOf, eatDayRangeMs, fail, requirePerm, todayEAT, type Ctx, type Doc, type Handler } from "../lib";

/*
 * Dashboard and reports. Refunds are stored as sales with kind "refund" and negative totals, lines and
 * payments, so plain sums net out exactly like the old server. Times go out as ISO strings, as before.
 */
const DAY = 24 * 3600 * 1000;
const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const iso = (ms: number) => new Date(ms).toISOString();
const YMD = /^\d{4}-\d{2}-\d{2}$/;

type Sale = Doc<"sales">;
type Line = Sale["items"][number];

/** cost of goods = cost x quantity, cut to whole cents (as the old SQL CAST did) */
const lineCogs = (l: Line) => Math.trunc((l.costCents * l.qtyMilli) / 1000);

const salesBetween = (ctx: Ctx, from: number, to: number) =>
  ctx.db.query("sales").withIndex("by_created", (q) => q.gte("createdAt", from).lt("createdAt", to)).collect();

function totals(sales: Sale[]) {
  let salesN = 0, salesCents = 0, net = 0, vat = 0, discount = 0, refund = 0, cogs = 0;
  for (const s of sales) {
    if (s.kind === "sale") { salesN++; salesCents += s.totalCents; }
    else refund -= s.totalCents;
    net += s.totalCents;
    vat += s.vatCents;
    discount += s.discountCents;
    for (const l of s.items) cogs += lineCogs(l);
  }
  return { sales: salesN, sales_cents: salesCents, net_cents: net, vat_cents: vat, discount_cents: discount, refund_cents: refund, cogs_cents: cogs, profit_cents: net - vat - cogs };
}

function byMethod(sales: Sale[]) {
  const m = new Map<string, number>();
  for (const s of sales) for (const p of s.payments) m.set(p.method, (m.get(p.method) ?? 0) + p.amountCents);
  return [...m].map(([method, amount_cents]) => ({ method, amount_cents })).sort((a, b) => b.amount_cents - a.amount_cents);
}

function byVat(sales: Sale[]) {
  const m = new Map<string, { vat_code: string; gross_cents: number; vat_cents: number }>();
  for (const s of sales) for (const l of s.items) {
    const r = m.get(l.vatCode) ?? { vat_code: l.vatCode, gross_cents: 0, vat_cents: 0 };
    r.gross_cents += l.lineTotalCents;
    r.vat_cents += l.vatCents;
    m.set(l.vatCode, r);
  }
  return [...m.values()];
}

function topItems(sales: Sale[], limit: number) {
  const m = new Map<number, { name: string; unit: string; qty_milli: number; gross_cents: number }>();
  for (const s of sales) for (const l of s.items) {
    const r = m.get(l.productId) ?? { name: l.name, unit: l.unit, qty_milli: 0, gross_cents: 0 };
    r.qty_milli += l.qtyMilli;
    r.gross_cents += l.lineTotalCents;
    m.set(l.productId, r);
  }
  return [...m.values()].sort((a, b) => b.gross_cents - a.gross_cents).slice(0, limit);
}

/** Stock on hand per product, added up across the shop and the store. */
async function stockByProduct(ctx: Ctx) {
  const m = new Map<number, number>();
  for (const r of await ctx.db.query("stock").collect()) m.set(r.productId, (m.get(r.productId) ?? 0) + r.qtyMilli);
  return m;
}

async function lowStock(ctx: Ctx) {
  const stock = await stockByProduct(ctx);
  const rows = [];
  for (const p of await ctx.db.query("products").collect()) {
    if (!p.active || p.reorderLevelMilli <= 0) continue;
    const q = stock.get(p.id) ?? 0;
    if (q <= p.reorderLevelMilli) rows.push({ id: p.id, sku: p.sku, name: p.name, unit: p.unit, reorder_level_milli: p.reorderLevelMilli, stock_milli: q });
  }
  return rows.sort((a, b) => a.stock_milli - b.stock_milli);
}

async function stockValue(ctx: Ctx) {
  const stock = await stockByProduct(ctx);
  let cost = 0, retail = 0;
  for (const p of await ctx.db.query("products").collect()) {
    const q = stock.get(p.id) ?? 0;
    if (q <= 0) continue;
    cost += Math.trunc((p.costCents * q) / 1000);
    retail += Math.trunc((p.priceRetailCents * q) / 1000);
  }
  return { cost, retail };
}

export const routes: Record<string, Handler> = {
  "GET /api/dashboard": async (ctx, { token, query }) => {
    const user = await requirePerm(ctx, token, "reports.view");
    const seeCost = can(user, "products.view_cost");
    // either a preset length (?days=7) or an exact range (?from=YYYY-MM-DD&to=YYYY-MM-DD)
    const today = todayEAT();
    let firstDay: string;
    let lastDay: string;
    if (query.from || query.to) {
      if (!query.from || !query.to || !YMD.test(query.from) || !YMD.test(query.to)) return fail(400, "Choose both a start date and an end date");
      if (query.from > query.to) return fail(400, "The start date must not be after the end date");
      if (query.to > today) return fail(400, "The end date cannot be in the future");
      firstDay = query.from;
      lastDay = query.to;
    } else {
      const n = Math.min(Math.max(Number(query.days) || 7, 1), 90);
      lastDay = today;
      firstDay = addDays(today, -(n - 1));
    }
    const days = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / DAY) + 1;
    if (days > 366) return fail(400, "Choose a period of one year or less");
    const from = eatDayRangeMs(firstDay).from;
    const to = eatDayRangeMs(lastDay).to;
    const prevFrom = eatDayRangeMs(addDays(firstDay, -days)).from;

    // one read covers this period and the one before it
    const all = await salesBetween(ctx, prevFrom, to);
    const cur = all.filter((s) => s.createdAt >= from);
    const prev = all.filter((s) => s.createdAt < from);
    const curT = totals(cur);
    const prevT = totals(prev);

    // one point per day, including days with no sales
    const perDay = new Map<string, { net: number; vat: number; sales: number; cogs: number }>();
    for (const s of cur) {
      const d = eatDayOf(s.createdAt);
      const r = perDay.get(d) ?? { net: 0, vat: 0, sales: 0, cogs: 0 };
      r.net += s.totalCents;
      r.vat += s.vatCents;
      if (s.kind === "sale") r.sales++;
      for (const l of s.items) r.cogs += lineCogs(l);
      perDay.set(d, r);
    }
    const series = Array.from({ length: days }, (_, i) => {
      const d = addDays(firstDay, i);
      const r = perDay.get(d);
      const net = r?.net ?? 0;
      const vat = r?.vat ?? 0;
      return { date: d, net_cents: net, vat_cents: vat, sales: r?.sales ?? 0, profit_cents: seeCost ? net - vat - (r?.cogs ?? 0) : null };
    });

    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: 0, net_cents: 0 }));
    for (const s of cur) {
      if (s.kind !== "sale") continue;
      const h = new Date(s.createdAt + 3 * 3600 * 1000).getUTCHours();
      hourly[h].sales++;
      hourly[h].net_cents += s.totalCents;
    }

    const users = new Map((await ctx.db.query("users").collect()).map((u) => [u.id, u.name]));
    const cashierMap = new Map<number, { name: string; sales: number; net_cents: number }>();
    for (const s of cur) {
      const r = cashierMap.get(s.userId) ?? { name: users.get(s.userId) ?? "", sales: 0, net_cents: 0 };
      if (s.kind === "sale") r.sales++;
      r.net_cents += s.totalCents;
      cashierMap.set(s.userId, r);
    }
    const cashiers = [...cashierMap.values()].sort((a, b) => b.net_cents - a.net_cents);

    const lowAll = await lowStock(ctx);

    const allCustomers = await ctx.db.query("customers").collect();
    const owing = allCustomers
      .filter((c) => c.balanceCents > 0)
      .sort((a, b) => b.balanceCents - a.balanceCents)
      .map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null, balance_cents: c.balanceCents }));

    let stockVal: { cost_cents: number; retail_cents: number } | null = null;
    if (seeCost) {
      const v = await stockValue(ctx);
      stockVal = { cost_cents: v.cost, retail_cents: v.retail };
    }

    const shifts = await ctx.db.query("shifts").collect();
    const openShifts = [];
    for (const sh of shifts.filter((x) => x.closedAt === undefined).sort((a, b) => a.openedAt - b.openedAt)) {
      const its = await ctx.db.query("sales").withIndex("by_shift", (q) => q.eq("shiftId", sh.id)).collect();
      let cash = 0;
      for (const s of its) for (const p of s.payments) if (p.method === "cash") cash += p.amountCents;
      openShifts.push({ id: sh.id, cashier: users.get(sh.userId) ?? "", opened_at: iso(sh.openedAt), opening_float_cents: sh.openingFloatCents, expected_cash_cents: sh.openingFloatCents + cash });
    }
    const closedShifts = shifts
      .filter((x) => x.closedAt !== undefined)
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
      .slice(0, 6)
      .map((sh) => ({
        id: sh.id, cashier: users.get(sh.userId) ?? "", closed_at: iso(sh.closedAt!),
        expected_cash_cents: sh.expectedCashCents ?? 0, counted_cash_cents: sh.countedCashCents ?? 0,
        variance_cents: (sh.countedCashCents ?? 0) - (sh.expectedCashCents ?? 0),
      }));

    const customerNames = new Map(allCustomers.map((c) => [c.id, c.name]));
    const recent = (await ctx.db.query("sales").withIndex("by_numId").order("desc").take(8)).map((s) => ({
      id: s.id, receipt_no: s.receiptNo, kind: s.kind, total_cents: s.totalCents, created_at: iso(s.createdAt),
      cashier: users.get(s.userId) ?? "", customer_name: s.customerId === undefined ? null : customerNames.get(s.customerId) ?? null,
    }));

    const hide = <T extends { profit_cents: number; cogs_cents: number }>(t: T) => (seeCost ? t : { ...t, profit_cents: null, cogs_cents: null });

    return {
      days, from: firstDay, to: lastDay,
      current: hide(curT), previous: hide(prevT),
      series, hours: hourly, methods: byMethod(cur), byVat: byVat(cur), topItems: topItems(cur, 8), cashiers,
      lowStock: { count: lowAll.length, items: lowAll.slice(0, 8) },
      owing: { count: owing.length, total_cents: owing.reduce((a, o) => a + o.balance_cents, 0), top: owing.slice(0, 6) },
      stockValue: stockVal, openShifts, closedShifts, recent,
    };
  },

  // Sales summary for a date range (Kenya days, inclusive). Refunds are negative rows, so sums net out.
  "GET /api/reports/summary": async (ctx, { token, query }) => {
    await requirePerm(ctx, token, "reports.view");
    const fromDay = query.from ?? todayEAT();
    const toDay = query.to ?? fromDay;
    const sales = await salesBetween(ctx, eatDayRangeMs(fromDay).from, eatDayRangeMs(toDay).to);
    let salesN = 0, refunds = 0, gross = 0, vat = 0, discount = 0, cogs = 0;
    for (const s of sales) {
      if (s.kind === "sale") salesN++; else refunds++;
      gross += s.totalCents;
      vat += s.vatCents;
      discount += s.discountCents;
      for (const l of s.items) cogs += lineCogs(l);
    }
    return {
      from: fromDay, to: toDay, sales: salesN, refunds, gross_cents: gross, vat_cents: vat, discount_cents: discount,
      // margin on ex-VAT revenue
      cogs_cents: cogs, margin_cents: gross - vat - cogs,
      byMethod: byMethod(sales), byVat: byVat(sales), topItems: topItems(sales, 10),
    };
  },

  "GET /api/reports/low-stock": async (ctx, { token }) => {
    await requirePerm(ctx, token, "reports.view");
    return lowStock(ctx);
  },

  "GET /api/reports/stock-value": async (ctx, { token }) => {
    await requirePerm(ctx, token, "reports.view");
    const v = await stockValue(ctx);
    return { cost_value_cents: v.cost, retail_value_cents: v.retail };
  },

  // the figures an owner checks on the stock: what it is worth, what sits in the store, and what has not moved
  "GET /api/reports/inventory-values": async (ctx, { token, query }) => {
    await requirePerm(ctx, token, "products.view_cost");
    const days = Math.min(Math.max(Math.floor(Number(query.days)) || 90, 1), 3650);
    const products = (await ctx.db.query("products").collect()).filter((p) => p.active);
    const onHand = new Map<number, { all: number; store: number }>();
    for (const s of await ctx.db.query("stock").collect()) {
      const e = onHand.get(s.productId) ?? { all: 0, store: 0 };
      e.all += s.qtyMilli;
      if (s.locationId === 2) e.store += s.qtyMilli; // location 2 is the Store
      onHand.set(s.productId, e);
    }
    const since = Date.now() - days * 86400000;
    const sold = new Set<number>();
    for (const sale of await ctx.db.query("sales").withIndex("by_created", (q) => q.gte("createdAt", since)).collect()) {
      if (sale.kind === "sale") for (const it of sale.items) sold.add(it.productId);
    }
    let selling = 0, cost = 0, storeCost = 0, storeItems = 0, deadCost = 0, deadItems = 0;
    for (const p of products) {
      const e = onHand.get(p.id) ?? { all: 0, store: 0 };
      const all = Math.max(0, e.all), store = Math.max(0, e.store);
      selling += Math.round((p.priceRetailCents * all) / 1000);
      cost += Math.round((p.costCents * all) / 1000);
      if (store > 0) { storeCost += Math.round((p.costCents * store) / 1000); storeItems++; }
      if (all > 0 && !sold.has(p.id)) { deadCost += Math.round((p.costCents * all) / 1000); deadItems++; }
    }
    return {
      items: products.length,
      selling_value_cents: selling, cost_value_cents: cost,
      store_cost_value_cents: storeCost, store_items: storeItems,
      dead_cost_value_cents: deadCost, dead_items: deadItems, dead_days: days,
    };
  },

  "GET /api/audit": async (ctx, { token }) => {
    await requirePerm(ctx, token, "audit.view");
    const rows = await ctx.db.query("auditLog").withIndex("by_time").order("desc").take(300);
    const users = new Map((await ctx.db.query("users").collect()).map((u) => [u.id, u.name]));
    return rows.map((r) => ({
      id: r._creationTime, user_id: r.userId ?? null, action: r.action, detail: r.detail ?? null,
      created_at: iso(r.createdAt), user: r.userId === undefined ? null : users.get(r.userId) ?? null,
    }));
  },
};
