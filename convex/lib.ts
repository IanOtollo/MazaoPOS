import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLES, type Permission } from "../shared/permissions";

/** An error the screens understand: a status code and a plain-words message. */
export const fail = (status: number, message: string): never => {
  throw new ConvexError({ status, message });
};

export interface AuthUser {
  id: number;
  name: string;
  role: string;
  roleId: number;
  permissions: Permission[];
}

export const can = (u: AuthUser, p: Permission) => u.permissions.includes(p);

/** Whole-number ids that count up per table, so the screens can keep using ids like "product 12". */
export async function nextId(ctx: MutationCtx, name: string): Promise<number> {
  const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
  if (!row) {
    await ctx.db.insert("counters", { name, value: 1 });
    return 1;
  }
  await ctx.db.patch(row._id, { value: row.value + 1 });
  return row.value + 1;
}

export async function audit(ctx: MutationCtx, userId: number | null, action: string, detail?: unknown) {
  await ctx.db.insert("auditLog", {
    userId: userId ?? undefined,
    action,
    detail: detail === undefined ? undefined : JSON.stringify(detail),
    createdAt: Date.now(),
  });
}

// ---------- settings ----------
export async function getSetting(ctx: MutationCtx, key: string, fallback = ""): Promise<string> {
  const r = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", key)).unique();
  return r?.value ?? fallback;
}
export async function setSetting(ctx: MutationCtx, key: string, value: string) {
  const r = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (r) await ctx.db.patch(r._id, { value });
  else await ctx.db.insert("settings", { key, value });
}

// ---------- PIN hashing (Web Crypto: SHA-256, per-person salt, repeated) ----------
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function stretch(pin: string, salt: string) {
  let h = `${salt}:${pin}`;
  for (let i = 0; i < 3000; i++) h = await sha(h);
  return h;
}
export function randomHex(bytes: number) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function hashPin(pin: string) {
  const salt = randomHex(16);
  return `${salt}:${await stretch(pin, salt)}`;
}
export async function verifyPin(pin: string, stored: string) {
  const [salt, h] = stored.split(":");
  return (await stretch(pin, salt)) === h;
}

// ---------- people ----------
export async function loadUser(ctx: MutationCtx, userId: number): Promise<AuthUser | undefined> {
  const u = await ctx.db.query("users").withIndex("by_numId", (q) => q.eq("id", userId)).unique();
  if (!u || !u.active) return undefined;
  const r = await ctx.db.query("roles").withIndex("by_numId", (q) => q.eq("id", u.roleId)).unique();
  if (!r) return undefined;
  return { id: u.id, name: u.name, roleId: u.roleId, role: r.name, permissions: r.permissions as Permission[] };
}

/** Who is calling: the bearer token must belong to a live session of an active user. */
export async function authenticate(ctx: MutationCtx, token: string | undefined): Promise<AuthUser> {
  if (!token) return fail(401, "Not signed in");
  const s = await ctx.db.query("sessions").withIndex("by_token", (q) => q.eq("token", token)).unique();
  const user = s ? await loadUser(ctx, s.userId) : undefined;
  if (!user) return fail(401, "Session expired");
  return user;
}

export async function requirePerm(ctx: MutationCtx, token: string | undefined, perm: Permission): Promise<AuthUser> {
  const user = await authenticate(ctx, token);
  if (!can(user, perm)) fail(403, "Your role does not allow this");
  return user;
}

/** The active user whose PIN this is, if any. PINs are unique, which is what makes PIN-only sign-in possible. */
export async function pinOwner(ctx: MutationCtx, pin: string, exceptUserId?: number): Promise<number | undefined> {
  const users = await ctx.db.query("users").collect();
  for (const u of users) {
    if (!u.active || u.id === exceptUserId) continue;
    if (await verifyPin(pin, u.pinHash)) return u.id;
  }
  return undefined;
}

/** First run: the three standard roles, the Admin account (PIN 1234), the shop and store, and the shop details. */
export async function seed(ctx: MutationCtx) {
  const roles = await ctx.db.query("roles").first();
  if (!roles) {
    for (const r of DEFAULT_ROLES) {
      await ctx.db.insert("roles", { id: await nextId(ctx, "roles"), name: r.name, description: r.description, isSystem: r.isSystem, permissions: [...r.permissions] });
    }
  }
  const anyone = await ctx.db.query("users").first();
  if (!anyone) {
    const admin = await ctx.db.query("roles").withIndex("by_name", (q) => q.eq("name", "Admin")).unique();
    await ctx.db.insert("users", { id: await nextId(ctx, "users"), name: "Admin", pinHash: await hashPin("1234"), roleId: admin!.id, active: true, createdAt: Date.now() });
  }
  if (!(await ctx.db.query("locations").first())) {
    await ctx.db.insert("locations", { id: await nextId(ctx, "locations"), name: "Shop" });
    await ctx.db.insert("locations", { id: await nextId(ctx, "locations"), name: "Store" });
  }
  if (!(await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "business_name")).unique())) {
    await setSetting(ctx, "business_name", "Mazao LTD");
    await setSetting(ctx, "kra_pin", "");
    await setSetting(ctx, "address", "");
    await setSetting(ctx, "phone", "");
    await setSetting(ctx, "receipt_footer", "Goods once sold are not returnable without a receipt.");
    await setSetting(ctx, "receipt_prefix", "R");
  }
}

export { ALL_PERMISSIONS };

// ---------- shared types for route modules ----------
export type Ctx = MutationCtx;
/** One request: bearer token, caller address, :params from the path, ?query values, and the parsed JSON body (null if none). */
export type Req = { token?: string; ip: string; params: Record<string, string>; query: Record<string, string>; body: any };
/** A route handler returns the JSON to send. Throw with fail(status, message) for errors. */
export type Handler = (ctx: Ctx, req: Req) => Promise<unknown>;

// ---------- live updates ----------
/** Tell every open screen that this kind of data changed (screens poll the topic counters). */
export async function bump(ctx: MutationCtx, names: string[]) {
  for (const name of names) {
    const r = await ctx.db.query("topics").withIndex("by_name", (q) => q.eq("name", name)).unique();
    if (r) await ctx.db.patch(r._id, { version: r.version + 1 });
    else await ctx.db.insert("topics", { name, version: 1 });
  }
}

// ---------- stock ----------
export async function stockOnHand(ctx: MutationCtx, productId: number, locationId: number): Promise<number> {
  const r = await ctx.db.query("stock").withIndex("by_product_location", (q) => q.eq("productId", productId).eq("locationId", locationId)).unique();
  return r?.qtyMilli ?? 0;
}

/**
 * The only way stock changes: writes an append-only movement AND moves the running balance in one step.
 * qtyMilli is signed (sales negative, deliveries positive). Returns the new quantity on hand.
 */
export async function moveStock(
  ctx: MutationCtx,
  m: { productId: number; locationId: number; qtyMilli: number; type: string; refType?: string; refId?: number; unitCostCents?: number; note?: string; userId?: number },
): Promise<number> {
  await ctx.db.insert("stockMovements", { id: await nextId(ctx, "stockMovements"), ...m, createdAt: Date.now() });
  const row = await ctx.db.query("stock").withIndex("by_product_location", (q) => q.eq("productId", m.productId).eq("locationId", m.locationId)).unique();
  if (row) {
    await ctx.db.patch(row._id, { qtyMilli: row.qtyMilli + m.qtyMilli });
    return row.qtyMilli + m.qtyMilli;
  }
  await ctx.db.insert("stock", { productId: m.productId, locationId: m.locationId, qtyMilli: m.qtyMilli });
  return m.qtyMilli;
}

// ---------- customer and supplier accounts ----------
/** Customer ledger: positive = customer owes more (credit sale), negative = they paid or returned goods. Keeps customers.balanceCents in step. */
export async function postCustomer(
  ctx: MutationCtx,
  e: { customerId: number; amountCents: number; type: string; refType?: string; refId?: number; method?: string; note?: string; userId?: number },
): Promise<number> {
  await ctx.db.insert("customerLedger", { id: await nextId(ctx, "customerLedger"), ...e, createdAt: Date.now() });
  const c = await ctx.db.query("customers").withIndex("by_numId", (q) => q.eq("id", e.customerId)).unique();
  if (!c) return fail(404, "Customer not found");
  await ctx.db.patch(c._id, { balanceCents: c.balanceCents + e.amountCents });
  return c.balanceCents + e.amountCents;
}

/** Supplier ledger: positive = we owe more (goods received), negative = we paid or got a credit note. Keeps suppliers.balanceCents in step. */
export async function postSupplier(
  ctx: MutationCtx,
  e: { supplierId: number; amountCents: number; type: string; refId?: number; method?: string; note?: string; userId?: number },
): Promise<number> {
  await ctx.db.insert("supplierLedger", { id: await nextId(ctx, "supplierLedger"), ...e, createdAt: Date.now() });
  const s = await ctx.db.query("suppliers").withIndex("by_numId", (q) => q.eq("id", e.supplierId)).unique();
  if (!s) return fail(404, "Supplier not found");
  await ctx.db.patch(s._id, { balanceCents: s.balanceCents + e.amountCents });
  return s.balanceCents + e.amountCents;
}

export type { Doc };

// ---------- dates (Kenya is UTC+3, no daylight saving; times are stored as milliseconds) ----------
/** Start (inclusive) and end (exclusive) of a local Kenya day, in ms. date is YYYY-MM-DD. Rejects impossible dates. */
export function eatDayRangeMs(date: string): { from: number; to: number } {
  const utc = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== date) return fail(400, "That is not a valid date");
  const from = new Date(`${date}T00:00:00+03:00`).getTime();
  return { from, to: from + 24 * 3600 * 1000 };
}
export const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
/** The Kenya calendar day (YYYY-MM-DD) a time in ms falls on. */
export const eatDayOf = (ms: number) => new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
