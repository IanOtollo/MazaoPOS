import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, db, getSetting, hashPin, setSetting, stockOnHand, tx, verifyPin } from "../db.ts";
import { HttpError, can, createSession, loadUser, requireLogin, requirePerm, type AuthUser } from "../auth.ts";
import { ALL_PERMISSIONS, OWNER_EXCLUDED, PERMISSIONS, type Permission } from "../../shared/permissions.ts";
import { parse } from "../util.ts";

// naive in-memory brute-force guard for the PIN pad
const fails = new Map<string, { n: number; until: number }>();

/** The active user whose PIN this is, if any. PINs are unique, which is what makes PIN-only sign-in possible. */
function pinOwner(pin: string, exceptUserId?: number): { id: number } | undefined {
  const rows = db.prepare("SELECT id, pin_hash FROM users WHERE active=1").all() as unknown as { id: number; pin_hash: string }[];
  return rows.find((u) => u.id !== exceptUserId && verifyPin(pin, u.pin_hash));
}
const PIN_TAKEN = "That PIN is already used by another staff member. Choose a different one.";

export function catalogRoutes(app: FastifyInstance) {
  // ---------------- auth ----------------
  // public: only the shop's display name, so the sign-in screen can show it
  app.get("/api/auth/info", async () => ({ business_name: getSetting("business_name", "Hardware POS") }));

    app.post("/api/auth/login", async (req) => {
    const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, "Enter your 4 to 8 digit PIN") }), req.body);
    const key = req.ip;
    const f = fails.get(key);
    if (f && f.until > Date.now()) throw new HttpError(429, "Too many wrong attempts. Wait 30 seconds and try again.");
    const hit = pinOwner(pin);
    if (!hit) {
      const n = (f?.n ?? 0) + 1;
      fails.set(key, { n, until: n >= 5 ? Date.now() + 30_000 : 0 });
      audit(null, "login_failed");
      throw new HttpError(401, "That PIN is not recognised");
    }
    fails.delete(key);
    audit(hit.id, "login");
    return { token: createSession(hit.id), user: loadUser(hit.id) };
  });

  app.post("/api/auth/logout", { preHandler: requireLogin() }, async (req) => {
    const token = (req.headers.authorization ?? "").slice(7);
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return { ok: true };
  });

  app.get("/api/me", { preHandler: requireLogin() }, async (req) => req.user);

    // ---------------- users & roles ----------------
  const rolePerms = (roleId: number) =>
    (db.prepare("SELECT permission FROM role_permissions WHERE role_id=?").all(roleId) as { permission: Permission }[]).map((p) => p.permission);

  /** True if `actor` holds every permission that `roleId` grants (so they may hand it out or manage its holders). */
  const coversRole = (actor: AuthUser, roleId: number) => rolePerms(roleId).every((p) => can(actor, p) || OWNER_EXCLUDED.includes(p));

  /** Active users who could still manage roles if the given user were removed / changed. */
  const otherRoleManagers = (exceptUserId: number) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM users u JOIN role_permissions rp ON rp.role_id=u.role_id AND rp.permission='roles.manage'
           WHERE u.active=1 AND u.id<>?`,
        )
        .get(exceptUserId) as { c: number }
    ).c;

  app.get("/api/users", { preHandler: requirePerm("users.manage") }, async () =>
    db
      .prepare(
        `SELECT u.id, u.name, u.active, u.role_id, r.name AS role FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.name`,
      )
      .all(),
  );

  app.post("/api/users", { preHandler: requirePerm("users.manage") }, async (req) => {
    const b = parse(z.object({ name: z.string().min(1), pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4 to 8 digits"), roleId: z.number().int() }), req.body);
    if (!db.prepare("SELECT 1 FROM roles WHERE id=?").get(b.roleId)) throw new HttpError(400, "Choose a role");
    if (!coversRole(req.user!, b.roleId)) throw new HttpError(403, "You cannot assign a role with more access than your own");
    if (pinOwner(b.pin)) throw new HttpError(409, PIN_TAKEN);
    const r = db.prepare("INSERT INTO users (name,pin_hash,role_id) VALUES (?,?,?)").run(b.name.trim(), hashPin(b.pin), b.roleId);
    audit(req.user!.id, "user_create", { name: b.name, roleId: b.roleId });
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch("/api/users/:id", { preHandler: requirePerm("users.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(
      z.object({ pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4 to 8 digits").optional(), roleId: z.number().int().optional(), active: z.boolean().optional() }),
      req.body,
    );
    const target = db.prepare("SELECT id, role_id, active FROM users WHERE id=?").get(id) as { id: number; role_id: number; active: number } | undefined;
    if (!target) throw new HttpError(404, "User not found");
    const actor = req.user!;
    // you cannot touch an account that has more access than you do (e.g. reset the Owner's PIN)
    if (!coversRole(actor, target.role_id)) throw new HttpError(403, "You cannot change an account with more access than your own");
    if (b.roleId !== undefined) {
      if (!db.prepare("SELECT 1 FROM roles WHERE id=?").get(b.roleId)) throw new HttpError(400, "Choose a role");
      if (!coversRole(actor, b.roleId)) throw new HttpError(403, "You cannot assign a role with more access than your own");
    }
    if (id === actor.id && b.active === false) throw new HttpError(400, "You cannot disable your own account");
    // never leave the business without anyone who can manage roles
    const newRole = b.roleId ?? target.role_id;
    const keepsRoleMgmt = (b.active ?? !!target.active) && rolePerms(newRole).includes("roles.manage");
    if (!keepsRoleMgmt && otherRoleManagers(id) === 0) throw new HttpError(400, "This would leave nobody able to manage roles. Assign the Owner role to someone else first.");

    if (b.pin) {
      if (pinOwner(b.pin, id)) throw new HttpError(409, PIN_TAKEN);
      db.prepare("UPDATE users SET pin_hash=? WHERE id=?").run(hashPin(b.pin), id);
    }
    if (b.roleId !== undefined) db.prepare("UPDATE users SET role_id=? WHERE id=?").run(b.roleId, id);
    if (b.active !== undefined) {
      db.prepare("UPDATE users SET active=? WHERE id=?").run(b.active ? 1 : 0, id);
      if (!b.active) db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    }
    audit(actor.id, "user_update", { id, roleId: b.roleId, active: b.active, pinChanged: !!b.pin });
    return { ok: true };
  });

  app.get("/api/permissions", { preHandler: requireLogin() }, async () => PERMISSIONS);

  const rolesWithPerms = () => {
    const roles = db
      .prepare(
        `SELECT r.id, r.name, r.description, r.is_system, (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id AND u.active=1) AS user_count
         FROM roles r ORDER BY r.is_system DESC, r.name`,
      )
      .all() as { id: number }[];
    return roles.map((r) => ({ ...r, permissions: rolePerms(r.id) }));
  };

  app.get("/api/roles", { preHandler: requireLogin() }, async () => rolesWithPerms());

  const roleBody = z.object({
    name: z.string().trim().min(1, "Give the role a name").max(40),
    description: z.string().max(200).default(""),
    permissions: z.array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]])),
  });

  app.post("/api/roles", { preHandler: requirePerm("roles.manage") }, async (req) => {
    const b = parse(roleBody, req.body);
    const actor = req.user!;
    const missing = b.permissions.filter((p) => !can(actor, p) && !OWNER_EXCLUDED.includes(p));
    if (missing.length) throw new HttpError(403, "You can only grant permissions that you hold yourself");
    try {
      const id = tx(() => {
        const rid = Number(db.prepare("INSERT INTO roles (name,description) VALUES (?,?)").run(b.name, b.description).lastInsertRowid);
        for (const p of new Set(b.permissions)) db.prepare("INSERT INTO role_permissions (role_id,permission) VALUES (?,?)").run(rid, p);
        return rid;
      });
      audit(actor.id, "role_create", { name: b.name, permissions: b.permissions });
      return { id };
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "A role with that name already exists");
      throw e;
    }
  });

  app.put("/api/roles/:id", { preHandler: requirePerm("roles.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(roleBody, req.body);
    const actor = req.user!;
    const role = db.prepare("SELECT id, is_system FROM roles WHERE id=?").get(id) as { id: number; is_system: number } | undefined;
    if (!role) throw new HttpError(404, "Role not found");
    if (role.is_system) throw new HttpError(400, "The Owner role cannot be edited");
    const before = new Set(rolePerms(id));
    const added = b.permissions.filter((p) => !before.has(p));
    if (added.some((p) => !can(actor, p) && !OWNER_EXCLUDED.includes(p))) throw new HttpError(403, "You can only grant permissions that you hold yourself");
    // removing roles.manage from your own role would lock you out of this screen
    if (id === actor.roleId && !b.permissions.includes("roles.manage")) throw new HttpError(400, "You cannot remove role management from your own role");
    try {
      tx(() => {
        db.prepare("UPDATE roles SET name=?, description=? WHERE id=?").run(b.name, b.description, id);
        db.prepare("DELETE FROM role_permissions WHERE role_id=?").run(id);
        for (const p of new Set(b.permissions)) db.prepare("INSERT INTO role_permissions (role_id,permission) VALUES (?,?)").run(id, p);
      });
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "A role with that name already exists");
      throw e;
    }
    audit(actor.id, "role_update", { id, name: b.name, permissions: b.permissions });
    return { ok: true };
  });

  app.delete("/api/roles/:id", { preHandler: requirePerm("roles.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const role = db.prepare("SELECT id, name, is_system FROM roles WHERE id=?").get(id) as { id: number; name: string; is_system: number } | undefined;
    if (!role) throw new HttpError(404, "Role not found");
    if (role.is_system) throw new HttpError(400, "The Owner role cannot be removed");
    const n = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE role_id=?").get(id) as { c: number }).c;
    if (n > 0) throw new HttpError(409, `${n} staff member${n === 1 ? " has" : "s have"} this role. Move them to another role first.`);
    db.prepare("DELETE FROM roles WHERE id=?").run(id);
    audit(req.user!.id, "role_delete", { name: role.name });
    return { ok: true };
  });

// ---------------- settings ----------------
  app.get("/api/settings", { preHandler: requireLogin() }, async () => {
    const rows = db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.put("/api/settings", { preHandler: requirePerm("settings.manage") }, async (req) => {
    const b = parse(z.record(z.string(), z.string()), req.body);
    const allowed = ["business_name", "kra_pin", "address", "phone", "receipt_footer", "receipt_prefix", "allow_negative_stock"];
    for (const [k, v] of Object.entries(b)) if (allowed.includes(k)) setSetting(k, v);
    audit(req.user!.id, "settings_update", Object.keys(b));
    return { ok: true };
  });

  // ---------------- locations & categories ----------------
  app.get("/api/locations", { preHandler: requireLogin() }, async () => db.prepare("SELECT * FROM locations").all());

  app.get("/api/categories", { preHandler: requireLogin() }, async () =>
    db.prepare("SELECT * FROM categories ORDER BY name").all(),
  );
  app.post("/api/categories", { preHandler: requirePerm("products.manage") }, async (req) => {
    const { name } = parse(z.object({ name: z.string().min(1) }), req.body);
    const r = db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(name.trim());
    return { id: Number(r.lastInsertRowid) };
  });

  // ---------------- products ----------------
  const productSchema = z.object({
    sku: z.string().min(1),
    barcode: z.string().nullish(),
    name: z.string().min(1),
    categoryId: z.number().int().nullish(),
    unit: z.string().min(1).default("pc"),
    allowFraction: z.boolean().default(false),
    vatCode: z.enum(["A", "B", "E"]).default("A"),
    costCents: z.number().int().min(0).default(0),
    priceRetailCents: z.number().int().min(0),
    priceContractorCents: z.number().int().min(0).nullish(),
    priceWholesaleCents: z.number().int().min(0).nullish(),
    reorderLevelMilli: z.number().int().min(0).default(0),
  });

  const productSelect = `
    SELECT p.*, c.name AS category,
      COALESCE((SELECT SUM(qty_milli) FROM stock_movements WHERE product_id=p.id AND location_id=1),0) AS stock_shop,
      COALESCE((SELECT SUM(qty_milli) FROM stock_movements WHERE product_id=p.id AND location_id=2),0) AS stock_store
    FROM products p LEFT JOIN categories c ON c.id=p.category_id`;

  app.get("/api/products", { preHandler: requireLogin() }, async (req) => {
    const { q, all, categoryId, limit } = req.query as { q?: string; all?: string; categoryId?: string; limit?: string };
    const max = Math.min(Math.max(Number(limit) || 200, 1), 10000);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (!all) where.push("p.active=1");
    if (categoryId) { where.push("p.category_id=?"); params.push(Number(categoryId)); }
    if (q && q.trim()) {
      // exact barcode/sku hit sorts first; otherwise every word must appear in the name
      const words = q.trim().split(/\s+/);
      for (const w of words) {
        where.push("(p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)");
        params.push(`%${w}%`, `%${w}%`, `%${w}%`);
      }
    }
    const sql = `${productSelect} ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY (p.barcode = ? OR p.sku = ?) DESC, p.name LIMIT ${max}`;
    const rows = db.prepare(sql).all(...params, q ?? "", q ?? "") as unknown as Record<string, unknown>[];
    return can(req.user!, "products.view_cost") ? rows : rows.map((r) => ({ ...r, cost_cents: 0 }));
  });

  app.post("/api/products", { preHandler: requirePerm("products.manage") }, async (req) => {
    const b = parse(productSchema, req.body);
    try {
      const r = db
        .prepare(
          `INSERT INTO products (sku,barcode,name,category_id,unit,allow_fraction,vat_code,cost_cents,
             price_retail_cents,price_contractor_cents,price_wholesale_cents,reorder_level_milli)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          b.sku, b.barcode || null, b.name, b.categoryId ?? null, b.unit, b.allowFraction ? 1 : 0, b.vatCode,
          b.costCents, b.priceRetailCents, b.priceContractorCents ?? null, b.priceWholesaleCents ?? null, b.reorderLevelMilli,
        );
      audit(req.user!.id, "product_create", { sku: b.sku });
      return { id: Number(r.lastInsertRowid) };
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "SKU or barcode already exists");
      throw e;
    }
  });

  app.patch("/api/products/:id", { preHandler: requirePerm("products.manage") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = parse(productSchema.partial().extend({ active: z.boolean().optional() }), req.body);
    const map: Record<string, [string, unknown]> = {
      sku: ["sku", b.sku], barcode: ["barcode", b.barcode || null], name: ["name", b.name],
      categoryId: ["category_id", b.categoryId], unit: ["unit", b.unit],
      allowFraction: ["allow_fraction", b.allowFraction ? 1 : 0], vatCode: ["vat_code", b.vatCode],
      costCents: ["cost_cents", b.costCents], priceRetailCents: ["price_retail_cents", b.priceRetailCents],
      priceContractorCents: ["price_contractor_cents", b.priceContractorCents ?? null],
      priceWholesaleCents: ["price_wholesale_cents", b.priceWholesaleCents ?? null],
      reorderLevelMilli: ["reorder_level_milli", b.reorderLevelMilli], active: ["active", b.active ? 1 : 0],
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const key of Object.keys(req.body as object)) {
      const m = map[key];
      if (m) { sets.push(`${m[0]}=?`); vals.push(m[1]); }
    }
    if (!sets.length) return { ok: true };
    try {
      db.prepare(`UPDATE products SET ${sets.join(",")} WHERE id=?`).run(...(vals as never[]), id);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new HttpError(409, "SKU or barcode already exists");
      throw e;
    }
    audit(req.user!.id, "product_update", { id, fields: Object.keys(req.body as object) });
    return { ok: true };
  });

  // ---------------- stock ----------------
  app.get("/api/stock/movements", { preHandler: requirePerm("stock.manage") }, async (req) => {
    const { productId } = req.query as { productId?: string };
    return db
      .prepare(
        `SELECT m.*, p.name AS product, u.name AS user FROM stock_movements m
         JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id
         ${productId ? "WHERE m.product_id=?" : ""} ORDER BY m.id DESC LIMIT 200`,
      )
      .all(...(productId ? [Number(productId)] : []));
  });

  const stockIn = z.object({
    productId: z.number().int(),
    locationId: z.number().int(),
    qtyMilli: z.number().int().positive(),
    unitCostCents: z.number().int().min(0).optional(),
    note: z.string().optional(),
  });

  // goods received from a supplier (also updates the product's last cost)
  app.post("/api/stock/receive", { preHandler: requirePerm("stock.manage") }, async (req) => {
    const b = parse(stockIn, req.body);
    tx(() => {
      db.prepare(
        `INSERT INTO stock_movements (product_id,location_id,qty_milli,type,unit_cost_cents,note,user_id)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(b.productId, b.locationId, b.qtyMilli, "purchase", b.unitCostCents ?? null, b.note ?? null, req.user!.id);
      if (b.unitCostCents !== undefined)
        db.prepare("UPDATE products SET cost_cents=? WHERE id=?").run(b.unitCostCents, b.productId);
      audit(req.user!.id, "stock_receive", b);
    });
    return { ok: true };
  });

  // set counted quantity (stock take) or apply damage/loss
  app.post("/api/stock/adjust", { preHandler: requirePerm("stock.manage") }, async (req) => {
    const b = parse(
      z.object({
        productId: z.number().int(),
        locationId: z.number().int(),
        // either a delta, or the counted quantity (system computes the delta)
        deltaMilli: z.number().int().optional(),
        countedMilli: z.number().int().min(0).optional(),
        type: z.enum(["adjustment", "damage", "opening"]).default("adjustment"),
        note: z.string().min(1, "A reason is required"),
      }),
      req.body,
    );
    const delta =
      b.countedMilli !== undefined ? b.countedMilli - stockOnHand(b.productId, b.locationId) : (b.deltaMilli ?? 0);
    if (delta === 0) return { ok: true, delta: 0 };
    db.prepare(
      `INSERT INTO stock_movements (product_id,location_id,qty_milli,type,note,user_id) VALUES (?,?,?,?,?,?)`,
    ).run(b.productId, b.locationId, delta, b.type, b.note, req.user!.id);
    audit(req.user!.id, "stock_adjust", { ...b, delta });
    return { ok: true, delta };
  });

  app.post("/api/stock/transfer", { preHandler: requirePerm("stock.manage") }, async (req) => {
    const b = parse(
      z.object({
        productId: z.number().int(),
        fromLocationId: z.number().int(),
        toLocationId: z.number().int(),
        qtyMilli: z.number().int().positive(),
      }),
      req.body,
    );
    if (b.fromLocationId === b.toLocationId) throw new HttpError(400, "Choose two different locations");
    tx(() => {
      if (getSetting("allow_negative_stock") !== "1" && stockOnHand(b.productId, b.fromLocationId) < b.qtyMilli)
        throw new HttpError(400, "Not enough stock at the source location");
      const ins = db.prepare(
        "INSERT INTO stock_movements (product_id,location_id,qty_milli,type,user_id) VALUES (?,?,?,?,?)",
      );
      ins.run(b.productId, b.fromLocationId, -b.qtyMilli, "transfer_out", req.user!.id);
      ins.run(b.productId, b.toLocationId, b.qtyMilli, "transfer_in", req.user!.id);
      audit(req.user!.id, "stock_transfer", b);
    });
    return { ok: true };
  });
}
