import type { FastifyInstance } from "fastify";
import { db } from "../db.ts";
import { HttpError, can, requirePerm } from "../auth.ts";
import { eatDayRange, todayEAT } from "../util.ts";

const DAY = 24 * 3600 * 1000;
const addDays = (ymd: string, n: number) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const EAT = "datetime(created_at,'+3 hours')";

function totals(from: string, to: string) {
  const t = db
    .prepare(
      `SELECT COUNT(CASE WHEN kind='sale' THEN 1 END) AS sales,
              COALESCE(SUM(CASE WHEN kind='sale' THEN total_cents END),0) AS sales_cents,
              COALESCE(SUM(total_cents),0) AS net_cents,
              COALESCE(SUM(vat_cents),0) AS vat_cents,
              COALESCE(SUM(discount_cents),0) AS discount_cents,
              COALESCE(SUM(CASE WHEN kind='refund' THEN -total_cents END),0) AS refund_cents
       FROM sales WHERE created_at >= ? AND created_at < ?`,
    )
    .get(from, to) as { sales: number; sales_cents: number; net_cents: number; vat_cents: number; discount_cents: number; refund_cents: number };
  const cogs = (
    db
      .prepare(
        `SELECT COALESCE(SUM(CAST(si.cost_cents * si.qty_milli / 1000.0 AS INTEGER)),0) AS c
         FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at >= ? AND s.created_at < ?`,
      )
      .get(from, to) as { c: number }
  ).c;
  return { ...t, cogs_cents: cogs, profit_cents: t.net_cents - t.vat_cents - cogs };
}

export function dashboardRoutes(app: FastifyInstance) {
  app.get("/api/dashboard", { preHandler: requirePerm("reports.view") }, async (req) => {
    const seeCost = can(req.user!, "products.view_cost");
    // either a preset length (?days=7) or an exact range (?from=YYYY-MM-DD&to=YYYY-MM-DD)
    const q = req.query as { days?: string; from?: string; to?: string };
    const today = todayEAT();
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    let firstDay: string;
    let lastDay: string;
    if (q.from || q.to) {
      if (!q.from || !q.to || !ymd.test(q.from) || !ymd.test(q.to)) throw new HttpError(400, "Choose both a start date and an end date");
      if (q.from > q.to) throw new HttpError(400, "The start date must not be after the end date");
      if (q.to > today) throw new HttpError(400, "The end date cannot be in the future");
      firstDay = q.from;
      lastDay = q.to;
    } else {
      const n = Math.min(Math.max(Number(q.days) || 7, 1), 90);
      lastDay = today;
      firstDay = addDays(today, -(n - 1));
    }
    const days = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / DAY) + 1;
    if (days > 366) throw new HttpError(400, "Choose a period of one year or less");
    const from = eatDayRange(firstDay).from;
    const to = eatDayRange(lastDay).to;
    const prevFrom = eatDayRange(addDays(firstDay, -days)).from;

    const cur = totals(from, to);
    const prev = totals(prevFrom, from);

    // one point per day, including days with no sales
    const rows = db
      .prepare(
        `SELECT date(${EAT}) AS d, COALESCE(SUM(total_cents),0) AS net_cents, COALESCE(SUM(vat_cents),0) AS vat_cents,
                COUNT(CASE WHEN kind='sale' THEN 1 END) AS sales
         FROM sales WHERE created_at >= ? AND created_at < ? GROUP BY d`,
      )
      .all(from, to) as { d: string; net_cents: number; vat_cents: number; sales: number }[];
    const costByDay = new Map(
      (
        db
          .prepare(
            `SELECT date(datetime(s.created_at,'+3 hours')) AS d, COALESCE(SUM(CAST(si.cost_cents * si.qty_milli / 1000.0 AS INTEGER)),0) AS c
             FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at >= ? AND s.created_at < ? GROUP BY d`,
          )
          .all(from, to) as { d: string; c: number }[]
      ).map((r) => [r.d, r.c]),
    );
    const byDay = new Map(rows.map((r) => [r.d, r]));
    const series = Array.from({ length: days }, (_, i) => {
      const d = addDays(firstDay, i);
      const r = byDay.get(d);
      const net = r?.net_cents ?? 0;
      const vat = r?.vat_cents ?? 0;
      return { date: d, net_cents: net, vat_cents: vat, sales: r?.sales ?? 0, profit_cents: seeCost ? net - vat - (costByDay.get(d) ?? 0) : null };
    });

    const hourly = db
      .prepare(
        `SELECT CAST(strftime('%H', ${EAT}) AS INTEGER) AS h, COUNT(*) AS sales, COALESCE(SUM(total_cents),0) AS net_cents
         FROM sales WHERE kind='sale' AND created_at >= ? AND created_at < ? GROUP BY h`,
      )
      .all(from, to) as { h: number; sales: number; net_cents: number }[];
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, sales: hourly.find((x) => x.h === h)?.sales ?? 0, net_cents: hourly.find((x) => x.h === h)?.net_cents ?? 0 }));

    const methods = db
      .prepare(
        `SELECT p.method, SUM(p.amount_cents) AS amount_cents FROM payments p JOIN sales s ON s.id=p.sale_id
         WHERE s.created_at >= ? AND s.created_at < ? GROUP BY p.method ORDER BY amount_cents DESC`,
      )
      .all(from, to);

    const byVat = db
      .prepare(
        `SELECT si.vat_code, SUM(si.line_total_cents) AS gross_cents, SUM(si.vat_cents) AS vat_cents
         FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at >= ? AND s.created_at < ? GROUP BY si.vat_code`,
      )
      .all(from, to);

    const topItems = db
      .prepare(
        `SELECT si.name, si.unit, SUM(si.qty_milli) AS qty_milli, SUM(si.line_total_cents) AS gross_cents
         FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at >= ? AND s.created_at < ?
         GROUP BY si.product_id ORDER BY gross_cents DESC LIMIT 8`,
      )
      .all(from, to);

    const cashiers = db
      .prepare(
        `SELECT u.name, COUNT(CASE WHEN s.kind='sale' THEN 1 END) AS sales, COALESCE(SUM(s.total_cents),0) AS net_cents
         FROM sales s JOIN users u ON u.id=s.user_id WHERE s.created_at >= ? AND s.created_at < ?
         GROUP BY u.id ORDER BY net_cents DESC`,
      )
      .all(from, to);

    const lowSql = `SELECT * FROM (
        SELECT p.id, p.sku, p.name, p.unit, p.reorder_level_milli,
          COALESCE((SELECT SUM(qty_milli) FROM stock_movements WHERE product_id=p.id),0) AS stock_milli
        FROM products p WHERE p.active=1) WHERE reorder_level_milli > 0 AND stock_milli <= reorder_level_milli ORDER BY stock_milli`;
    const lowAll = db.prepare(lowSql).all() as { id: number }[];

    const owing = db
      .prepare(
        `SELECT c.id, c.name, c.phone, SUM(l.amount_cents) AS balance_cents FROM customers c
         JOIN customer_ledger l ON l.customer_id=c.id GROUP BY c.id HAVING balance_cents > 0 ORDER BY balance_cents DESC`,
      )
      .all() as { balance_cents: number }[];

    const stockValue = seeCost
      ? (db
          .prepare(
            `SELECT COALESCE(SUM(CAST(p.cost_cents * s.q / 1000.0 AS INTEGER)),0) AS cost_cents,
                    COALESCE(SUM(CAST(p.price_retail_cents * s.q / 1000.0 AS INTEGER)),0) AS retail_cents
             FROM products p JOIN (SELECT product_id, SUM(qty_milli) AS q FROM stock_movements GROUP BY product_id) s
               ON s.product_id=p.id WHERE s.q > 0`,
          )
          .get() as { cost_cents: number; retail_cents: number })
      : null;

    const openShifts = db
      .prepare(
        `SELECT sh.id, u.name AS cashier, sh.opened_at, sh.opening_float_cents,
           sh.opening_float_cents + (SELECT COALESCE(SUM(p.amount_cents),0) FROM payments p JOIN sales s ON s.id=p.sale_id
                                     WHERE s.shift_id=sh.id AND p.method='cash') AS expected_cash_cents
         FROM shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.closed_at IS NULL ORDER BY sh.opened_at`,
      )
      .all();

    const closedShifts = db
      .prepare(
        `SELECT sh.id, u.name AS cashier, sh.closed_at, sh.expected_cash_cents, sh.counted_cash_cents,
                sh.counted_cash_cents - sh.expected_cash_cents AS variance_cents
         FROM shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.closed_at IS NOT NULL ORDER BY sh.closed_at DESC LIMIT 6`,
      )
      .all();

    const recent = db
      .prepare(
        `SELECT s.id, s.receipt_no, s.kind, s.total_cents, s.created_at, u.name AS cashier, c.name AS customer_name
         FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT 8`,
      )
      .all();

    const hide = <T extends { profit_cents: number; cogs_cents: number }>(t: T) => (seeCost ? t : { ...t, profit_cents: null, cogs_cents: null });

    return {
      days, from: firstDay, to: lastDay,
      current: hide(cur), previous: hide(prev),
      series, hours, methods, byVat, topItems, cashiers,
      lowStock: { count: lowAll.length, items: (db.prepare(lowSql + " LIMIT 8").all()) },
      owing: { count: owing.length, total_cents: owing.reduce((a, o) => a + o.balance_cents, 0), top: owing.slice(0, 6) },
      stockValue, openShifts, closedShifts, recent,
    };
  });
}
