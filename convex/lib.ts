import { ConvexError } from "convex/values";
import type { MutationCtx } from "./_generated/server";
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
