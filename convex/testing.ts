import { internalMutation } from "./_generated/server";
import { seed } from "./lib";

declare const process: { env: Record<string, string | undefined> };

const TABLES = [
  "counters", "settings", "topics", "files", "roles", "users", "sessions", "loginAttempts", "auditLog",
  "locations", "categories", "products", "stock", "stockMovements", "shifts", "sales",
  "customers", "customerLedger", "customerNotes", "suppliers", "purchases", "lpos", "supplierLedger",
] as const;

/**
 * Wipes every table and re-creates the first-run data, for the automated tests only.
 * Refuses unless the deployment has TEST_RESET_ALLOWED=1, so it can never run against the real shop.
 */
export const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.TEST_RESET_ALLOWED !== "1") throw new Error("Reset is not allowed on this deployment");
    for (const t of TABLES) for (const d of await ctx.db.query(t).collect()) await ctx.db.delete(d._id);
    await seed(ctx);
    return "reset";
  },
});

import { v } from "convex/values";
import { fail, nextId } from "./lib";

/** Test only: a debt dated some days ago, to check ageing (same guard as reset). */
export const addDebt = internalMutation({
  args: { who: v.union(v.literal("customer"), v.literal("supplier")), id: v.number(), amountCents: v.number(), daysAgo: v.number() },
  handler: async (ctx, a) => {
    if (process.env.TEST_RESET_ALLOWED !== "1") throw new Error("Not allowed on this deployment");
    const at = Date.now() - a.daysAgo * 86400000;
    if (a.who === "customer") {
      const c = await ctx.db.query("customers").withIndex("by_numId", (q) => q.eq("id", a.id)).unique();
      if (!c) return fail(404, "no customer");
      await ctx.db.insert("customerLedger", { id: await nextId(ctx, "customerLedger"), customerId: a.id, amountCents: a.amountCents, type: "credit_sale", createdAt: at });
      await ctx.db.patch(c._id, { balanceCents: c.balanceCents + a.amountCents });
    } else {
      const s = await ctx.db.query("suppliers").withIndex("by_numId", (q) => q.eq("id", a.id)).unique();
      if (!s) return fail(404, "no supplier");
      await ctx.db.insert("supplierLedger", { id: await nextId(ctx, "supplierLedger"), supplierId: a.id, amountCents: a.amountCents, type: "purchase", createdAt: at });
      await ctx.db.patch(s._id, { balanceCents: s.balanceCents + a.amountCents });
    }
    return "ok";
  },
});
