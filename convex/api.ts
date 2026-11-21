import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {
  ALL_PERMISSIONS, ADMIN_EXCLUDED, PERMISSIONS, type Permission,
} from "../shared/permissions";
import {
  audit, authenticate, can, fail, getSetting, hashPin, loadUser, nextId, pinOwner, randomHex, requirePerm, seed, setSetting, verifyPin,
  type AuthUser,
} from "./lib";

/*
 * Every request from the screens arrives here as one call: { route, token, ip, params, body }.
 * Each route keeps the same address and the same JSON as the old server, so the screens do not change.
 */
const PIN_TAKEN = "That PIN is already used by another staff member. Choose a different one.";
const PIN_RE = /^\d{4,8}$/;

type Req = { token?: string; ip: string; params: Record<string, string>; body: any };
type Ctx = Parameters<Parameters<typeof internalMutation>[0]["handler"]>[0];
type Handler = (ctx: Ctx, req: Req) => Promise<unknown>;

const rolePerms = async (ctx: Ctx, roleId: number): Promise<Permission[]> => {
  const r = await ctx.db.query("roles").withIndex("by_numId", (q) => q.eq("id", roleId)).unique();
  return (r?.permissions ?? []) as Permission[];
};
/** True if `actor` holds every permission that `roleId` grants (so they may hand it out or manage its holders). */
const coversRole = async (ctx: Ctx, actor: AuthUser, roleId: number) =>
  (await rolePerms(ctx, roleId)).every((p) => can(actor, p) || ADMIN_EXCLUDED.includes(p));

const otherRoleManagers = async (ctx: Ctx, exceptUserId: number) => {
  let n = 0;
  for (const u of await ctx.db.query("users").collect()) {
    if (u.active && u.id !== exceptUserId && (await rolePerms(ctx, u.roleId)).includes("roles.manage")) n++;
  }
  return n;
};

const str = (x: unknown, what: string, min = 1) => {
  if (typeof x !== "string" || x.trim().length < min) return fail(400, `${what}: required`);
  return (x as string).trim();
};

const rolesWithPerms = async (ctx: Ctx) => {
  const roles = await ctx.db.query("roles").collect();
  const users = await ctx.db.query("users").collect();
  roles.sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.name.localeCompare(b.name));
  return roles.map((r) => ({
    id: r.id, name: r.name, description: r.description, is_system: r.isSystem ? 1 : 0,
    user_count: users.filter((u) => u.roleId === r.id && u.active).length, permissions: r.permissions,
  }));
};

function parseRole(b: any) {
  const name = str(b?.name, "name");
  if (name.length > 40) fail(400, "name: too long");
  const description = typeof b?.description === "string" ? b.description.slice(0, 200) : "";
  const perms: unknown = b?.permissions;
  if (!Array.isArray(perms) || perms.some((p) => !ALL_PERMISSIONS.includes(p as Permission))) fail(400, "permissions: invalid");
  return { name, description, permissions: [...new Set(perms as Permission[])] };
}

const SETTING_KEYS = ["business_name", "kra_pin", "address", "phone", "receipt_footer", "receipt_prefix", "allow_negative_stock", "block_credit_overdue_days"];

export const routes: Record<string, Handler> = {
  // ---------------- sign in ----------------
  "GET /api/auth/info": async (ctx) => {
    await seed(ctx);
    return { business_name: await getSetting(ctx, "business_name", "Mazao LTD"), logo_version: await getSetting(ctx, "logo_version", "") };
  },

  "POST /api/auth/login": async (ctx, { body, ip }) => {
    await seed(ctx);
    const pin = body?.pin;
    if (typeof pin !== "string" || !PIN_RE.test(pin)) return fail(400, "pin: Enter your 4 to 8 digit PIN");
    const tries = await ctx.db.query("loginAttempts").withIndex("by_key", (q) => q.eq("key", ip)).unique();
    if (tries && tries.until > Date.now()) return fail(429, "Too many wrong attempts. Wait 30 seconds and try again.");
    const hit = await pinOwner(ctx, pin);
    if (hit === undefined) {
      const n = (tries?.count ?? 0) + 1;
      const until = n >= 5 ? Date.now() + 30_000 : 0;
      if (tries) await ctx.db.patch(tries._id, { count: n, until });
      else await ctx.db.insert("loginAttempts", { key: ip, count: n, until });
      await audit(ctx, null, "login_failed");
      // this response must still be saved, so report the wrong PIN as a normal reply the router turns into 401
      return { __status: 401, error: "That PIN is not recognised" };
    }
    if (tries) await ctx.db.delete(tries._id);
    const token = randomHex(32);
    await ctx.db.insert("sessions", { token, userId: hit, createdAt: Date.now() });
    await audit(ctx, hit, "login");
    return { token, user: await loadUser(ctx, hit) };
  },

  "POST /api/auth/logout": async (ctx, { token }) => {
    await authenticate(ctx, token);
    const s = await ctx.db.query("sessions").withIndex("by_token", (q) => q.eq("token", token!)).unique();
    if (s) await ctx.db.delete(s._id);
    return { ok: true };
  },

  "GET /api/me": async (ctx, { token }) => authenticate(ctx, token),

  // ---------------- staff ----------------
  "GET /api/users": async (ctx, { token }) => {
    await requirePerm(ctx, token, "users.manage");
    const users = await ctx.db.query("users").collect();
    const roles = new Map((await ctx.db.query("roles").collect()).map((r) => [r.id, r.name]));
    return users
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => ({ id: u.id, name: u.name, active: u.active ? 1 : 0, role_id: u.roleId, role: roles.get(u.roleId) ?? "" }));
  },

  "POST /api/users": async (ctx, { token, body }) => {
    const actor = await requirePerm(ctx, token, "users.manage");
    const name = str(body?.name, "name");
    if (typeof body?.pin !== "string" || !PIN_RE.test(body.pin)) return fail(400, "pin: PIN must be 4 to 8 digits");
    const roleId = Number(body?.roleId);
    if (!Number.isInteger(roleId)) return fail(400, "roleId: Choose a role");
    if (!(await ctx.db.query("roles").withIndex("by_numId", (q) => q.eq("id", roleId)).unique())) return fail(400, "Choose a role");
    if (!(await coversRole(ctx, actor, roleId))) return fail(403, "You cannot assign a role with more access than your own");
    if ((await pinOwner(ctx, body.pin)) !== undefined) return fail(409, PIN_TAKEN);
    const id = await nextId(ctx, "users");
    await ctx.db.insert("users", { id, name, pinHash: await hashPin(body.pin), roleId, active: true, createdAt: Date.now() });
    await audit(ctx, actor.id, "user_create", { name, roleId });
    return { id };
  },

  "PATCH /api/users/:id": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "users.manage");
    const id = Number(params.id);
    const pin = body?.pin as string | undefined;
    if (pin !== undefined && !PIN_RE.test(pin)) return fail(400, "pin: PIN must be 4 to 8 digits");
    const roleId = body?.roleId === undefined ? undefined : Number(body.roleId);
    const active = body?.active as boolean | undefined;
    const target = await ctx.db.query("users").withIndex("by_numId", (q) => q.eq("id", id)).unique();
    if (!target) return fail(404, "User not found");
    if (!(await coversRole(ctx, actor, target.roleId))) return fail(403, "You cannot change an account with more access than your own");
    if (roleId !== undefined) {
      if (!(await ctx.db.query("roles").withIndex("by_numId", (q) => q.eq("id", roleId)).unique())) return fail(400, "Choose a role");
      if (!(await coversRole(ctx, actor, roleId))) return fail(403, "You cannot assign a role with more access than your own");
    }
    if (id === actor.id && active === false) return fail(400, "You cannot disable your own account");
    const newRole = roleId ?? target.roleId;
    const keeps = (active ?? target.active) && (await rolePerms(ctx, newRole)).includes("roles.manage");
    if (!keeps && (await otherRoleManagers(ctx, id)) === 0) return fail(400, "This would leave nobody able to manage roles. Assign the Admin role to someone else first.");
    const patch: Record<string, unknown> = {};
    if (pin) {
      if ((await pinOwner(ctx, pin, id)) !== undefined) return fail(409, PIN_TAKEN);
      patch.pinHash = await hashPin(pin);
    }
    if (roleId !== undefined) patch.roleId = roleId;
    if (active !== undefined) patch.active = active;
    await ctx.db.patch(target._id, patch);
    if (active === false) for (const s of await ctx.db.query("sessions").withIndex("by_user", (q) => q.eq("userId", id)).collect()) await ctx.db.delete(s._id);
    await audit(ctx, actor.id, "user_update", { id, roleId, active, pinChanged: !!pin });
    return { ok: true };
  },

  // ---------------- roles ----------------
  "GET /api/permissions": async (ctx, { token }) => {
    await authenticate(ctx, token);
    return PERMISSIONS;
  },
  "GET /api/roles": async (ctx, { token }) => {
    await authenticate(ctx, token);
    return rolesWithPerms(ctx);
  },

  "POST /api/roles": async (ctx, { token, body }) => {
    const actor = await requirePerm(ctx, token, "roles.manage");
    const b = parseRole(body);
    if (b.permissions.some((p) => !can(actor, p) && !ADMIN_EXCLUDED.includes(p))) return fail(403, "You can only grant permissions that you hold yourself");
    if (await ctx.db.query("roles").withIndex("by_name", (q) => q.eq("name", b.name)).unique()) return fail(409, "A role with that name already exists");
    const id = await nextId(ctx, "roles");
    await ctx.db.insert("roles", { id, name: b.name, description: b.description, isSystem: false, permissions: b.permissions });
    await audit(ctx, actor.id, "role_create", { name: b.name, permissions: b.permissions });
    return { id };
  },

  "PUT /api/roles/:id": async (ctx, { token, body, params }) => {
    const actor = await requirePerm(ctx, token, "roles.manage");
    const id = Number(params.id);
    const b = parseRole(body);
    const role = await ctx.db.query("roles").withIndex("by_numId", (q) => q.eq("id", id)).unique();
    if (!role) return fail(404, "Role not found");
    if (role.isSystem) return fail(400, "The Admin role cannot be edited");
    const before = new Set(role.permissions);
    if (b.permissions.filter((p) => !before.has(p)).some((p) => !can(actor, p) && !ADMIN_EXCLUDED.includes(p))) return fail(403, "You can only grant permissions that you hold yourself");
    if (id === actor.roleId && !b.permissions.includes("roles.manage")) return fail(400, "You cannot remove role management from your own role");
    const clash = await ctx.db.query("roles").withIndex("by_name", (q) => q.eq("name", b.name)).unique();
    if (clash && clash.id !== id) return fail(409, "A role with that name already exists");
    await ctx.db.patch(role._id, { name: b.name, description: b.description, permissions: b.permissions });
    await audit(ctx, actor.id, "role_update", { id, name: b.name, permissions: b.permissions });
    return { ok: true };
  },

  "DELETE /api/roles/:id": async (ctx, { token, params }) => {
    const actor = await requirePerm(ctx, token, "roles.manage");
    const id = Number(params.id);
    const role = await ctx.db.query("roles").withIndex("by_numId", (q) => q.eq("id", id)).unique();
    if (!role) return fail(404, "Role not found");
    if (role.isSystem) return fail(400, "The Admin role cannot be removed");
    const n = (await ctx.db.query("users").collect()).filter((u) => u.roleId === id).length;
    if (n > 0) return fail(409, `${n} staff member${n === 1 ? " has" : "s have"} this role. Move them to another role first.`);
    await ctx.db.delete(role._id);
    await audit(ctx, actor.id, "role_delete", { name: role.name });
    return { ok: true };
  },

  // ---------------- settings ----------------
  "GET /api/settings": async (ctx, { token }) => {
    await authenticate(ctx, token);
    return Object.fromEntries((await ctx.db.query("settings").collect()).map((r) => [r.key, r.value]));
  },
  "PUT /api/settings": async (ctx, { token, body }) => {
    const actor = await requirePerm(ctx, token, "settings.manage");
    if (!body || typeof body !== "object" || Object.values(body).some((x) => typeof x !== "string")) return fail(400, "input: expected text values");
    for (const [k, val] of Object.entries(body as Record<string, string>)) if (SETTING_KEYS.includes(k)) await setSetting(ctx, k, val);
    await audit(ctx, actor.id, "settings_update", Object.keys(body));
    return { ok: true };
  },
};

/** Run one route. Wrong-PIN counting has to be saved, so it comes back as data instead of throwing. */
export const handle = internalMutation({
  args: { route: v.string(), token: v.optional(v.string()), ip: v.string(), params: v.any(), body: v.any() },
  handler: async (ctx, a) => {
    const fn = routes[a.route];
    if (!fn) return { __status: 404, error: "Not found" };
    return await fn(ctx, { token: a.token, ip: a.ip, params: a.params ?? {}, body: a.body });
  },
});
