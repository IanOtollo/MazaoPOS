import type { FastifyInstance } from "fastify";
import { db } from "../db.ts";
import { requirePerm } from "../auth.ts";
import { eatDayRange, todayEAT } from "../util.ts";

export function reportRoutes(app: FastifyInstance) {
  // Sales summary for a date range (EAT days, inclusive). Refunds are negative rows, so sums net out.
  app.get("/api/reports/summary", { preHandler: requirePerm("reports.view") }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const fromDay = q.from ?? todayEAT();
    const toDay = q.to ?? fromDay;
    const from = eatDayRange(fromDay).from;
    const to = eatDayRange(toDay).to;

    const totals = db
      .prepare(
        `SELECT COUNT(CASE WHEN kind='sale' THEN 1 END) AS sales,
                COUNT(CASE WHEN kind='refund' THEN 1 END) AS refunds,
                COALESCE(SUM(total_cents),0) AS gross_cents,
                COALESCE(SUM(vat_cents),0) AS vat_cents,
                COALESCE(SUM(discount_cents),0) AS discount_cents
         FROM sales WHERE created_at >= ? AND created_at < ?`,
      )
      .get(from, to);

    const cogs = (
      db
        .prepare(
          `SELECT COALESCE(SUM(CAST(si.cost_cents * si.qty_milli / 1000.0 AS INTEGER)),0) AS c
           FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at >= ? AND s.created_at < ?`,
        )
        .get(from, to) as { c: number }
    ).c;

    const byMethod = db
      .prepare(
        `SELECT p.method, SUM(p.amount_cents) AS amount_cents FROM payments p JOIN sales s ON s.id=p.sale_id
         WHERE s.created_at >= ? AND s.created_at < ? GROUP BY p.method`,
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
         GROUP BY si.product_id ORDER BY gross_cents DESC LIMIT 10`,
      )
      .all(from, to);

    const t = totals as { gross_cents: number; vat_cents: number };
    return {
      from: fromDay, to: toDay, ...t,
      // margin on ex-VAT revenue
      cogs_cents: cogs,
      margin_cents: t.gross_cents - t.vat_cents - cogs,
      byMethod, byVat, topItems,
    };
  });

  app.get("/api/reports/low-stock", { preHandler: requirePerm("reports.view") }, async () =>
    db
      .prepare(
        `SELECT * FROM (
           SELECT p.id, p.sku, p.name, p.unit, p.reorder_level_milli,
             COALESCE((SELECT SUM(qty_milli) FROM stock_movements WHERE product_id=p.id),0) AS stock_milli
           FROM products p WHERE p.active=1
         ) WHERE stock_milli <= reorder_level_milli ORDER BY stock_milli`,
      )
      .all(),
  );

  app.get("/api/reports/stock-value", { preHandler: requirePerm("reports.view") }, async () =>
    db
      .prepare(
        `SELECT COALESCE(SUM(CAST(p.cost_cents * s.q / 1000.0 AS INTEGER)),0) AS cost_value_cents,
                COALESCE(SUM(CAST(p.price_retail_cents * s.q / 1000.0 AS INTEGER)),0) AS retail_value_cents
         FROM products p JOIN (SELECT product_id, SUM(qty_milli) AS q FROM stock_movements GROUP BY product_id) s
           ON s.product_id=p.id WHERE s.q > 0`,
      )
      .get(),
  );

  app.get("/api/audit", { preHandler: requirePerm("audit.view") }, async () =>
    db
      .prepare(
        `SELECT a.*, u.name AS user FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`,
      )
      .all(),
  );
}
