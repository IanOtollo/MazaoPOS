import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authenticate, bump, fail, type Handler } from "./lib";
import { routes as auth } from "./mod/auth";
import { routes as catalog } from "./mod/catalog";
import { routes as sales } from "./mod/sales";
import { routes as crm } from "./mod/crm";
import { routes as suppliers } from "./mod/suppliers";
import { routes as reports } from "./mod/reports";
import { routes as misc } from "./mod/misc";

/*
 * Every request from the screens arrives here as one call. Each module owns a table of routes keyed like
 * "GET /api/users/:id", with the same addresses and JSON as the old server, so the screens do not change.
 */
const table: Record<string, Handler> = { ...auth, ...catalog, ...sales, ...crm, ...suppliers, ...reports, ...misc };
const compiled = Object.entries(table).map(([key, fn]) => {
  const [method, path] = key.split(" ");
  return { method, parts: path.split("/").filter(Boolean), fn };
});

function match(method: string, pathname: string) {
  const parts = pathname.split("/").filter(Boolean);
  for (const r of compiled) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (r.parts.every((seg, i) => (seg.startsWith(":") ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) return { fn: r.fn, params };
  }
  return null;
}

// What kind of data a successful change touches, so open screens re-read only what they show.
const TOPICS: [RegExp, string[]][] = [
  [/^\/api\/sales/, ["sales", "stock", "customers", "dashboard"]],
  [/^\/api\/shifts/, ["shifts", "dashboard"]],
  [/^\/api\/products/, ["products", "stock", "dashboard"]],
  [/^\/api\/categories/, ["products"]],
  [/^\/api\/stock/, ["stock", "products", "dashboard"]],
  [/^\/api\/customers/, ["customers", "dashboard"]],
  [/^\/api\/settings/, ["settings"]],
  [/^\/api\/users/, ["staff", "roles"]],
  [/^\/api\/roles/, ["roles", "staff"]],
  [/^\/api\/logo/, ["settings"]],
  [/^\/api\/(suppliers|purchases)/, ["suppliers", "stock", "products", "dashboard"]],
  [/^\/api\/import/, ["products", "stock", "dashboard"]],
];

export const handle = internalMutation({
  args: { method: v.string(), path: v.string(), token: v.optional(v.string()), ip: v.string(), query: v.any(), body: v.any() },
  handler: async (ctx, a) => {
    if (a.method === "GET" && a.path === "/api/live") {
      await authenticate(ctx, a.token);
      const rows = await ctx.db.query("topics").collect();
      return Object.fromEntries(rows.map((r) => [r.name, r.version]));
    }
    const m = match(a.method, a.path);
    if (!m) return { __status: 404, error: "Not found" };
    const out = await m.fn(ctx, { token: a.token, ip: a.ip, params: m.params, query: a.query ?? {}, body: a.body });
    if (a.method !== "GET" && !(out && typeof out === "object" && "__status" in (out as object))) {
      const hit = TOPICS.find(([re]) => re.test(a.path));
      if (hit) await bump(ctx, hit[1]);
    }
    return out;
  },
});
void fail;
