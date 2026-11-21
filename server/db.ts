import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ALL_PERMISSIONS, DEFAULT_ROLES, ADMIN_EXCLUDED } from "../shared/permissions.ts";

const DB_PATH = process.env.DB_PATH ?? "data/pos.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  is_system INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  unit TEXT NOT NULL DEFAULT 'pc',
  allow_fraction INTEGER NOT NULL DEFAULT 0,
  vat_code TEXT NOT NULL DEFAULT 'A' CHECK (vat_code IN ('A','B','E')),
  cost_cents INTEGER NOT NULL DEFAULT 0,
  price_retail_cents INTEGER NOT NULL,
  price_contractor_cents INTEGER,
  price_wholesale_cents INTEGER,
  reorder_level_milli INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);

-- Append-only. Stock on hand = SUM(qty_milli). Never UPDATE or DELETE rows.
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty_milli INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('opening','purchase','sale','sale_return','adjustment','transfer_in','transfer_out','damage')),
  ref_type TEXT, ref_id INTEGER,
  unit_cost_cents INTEGER,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_sm_product ON stock_movements(product_id, location_id);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  kra_pin TEXT,
  tier TEXT NOT NULL DEFAULT 'retail' CHECK (tier IN ('retail','contractor','wholesale')),
  credit_limit_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

-- Append-only account ledger. Balance owed = SUM(amount_cents).
-- positive = customer owes more (credit sale); negative = payment / credit note.
CREATE TABLE IF NOT EXISTS customer_ledger (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount_cents INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('credit_sale','payment','adjustment','return')),
  ref_type TEXT, ref_id INTEGER,
  method TEXT, note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

-- Collections follow-up: calls, visits, notes and promises to pay. Append-only.
CREATE TABLE IF NOT EXISTS customer_notes (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('note','call','visit','promise')),
  body TEXT NOT NULL DEFAULT '',
  promise_date TEXT,
  promise_cents INTEGER,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_notes_customer ON customer_notes(customer_id);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT, email TEXT, kra_pin TEXT,
  credit_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

-- Goods received from a supplier. Append-only.
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_no TEXT,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  total_cents INTEGER NOT NULL,
  note TEXT,
  user_id INTEGER REFERENCES users(id),
  received_on TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pi_product ON purchase_items(product_id);

-- What we owe a supplier. + = we owe more (goods received), - = we paid / credit note. Append-only.
CREATE TABLE IF NOT EXISTS supplier_ledger (
  id INTEGER PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  amount_cents INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('purchase','payment','credit_note')),
  ref_id INTEGER,
  method TEXT, note TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_sl_supplier ON supplier_ledger(supplier_id);

-- Other ways to sell the same product (a 50 m roll of an item priced per metre, a dozen of an item priced per piece).
-- Stock is always kept in the product's own unit; factor_milli says how many of those one of this unit contains (x1000).
CREATE TABLE IF NOT EXISTS product_units (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  factor_milli INTEGER NOT NULL CHECK (factor_milli > 0),
  price_cents INTEGER,
  barcode TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_pu_product ON product_units(product_id);

-- small files kept with the shop's data (the logo)
CREATE TABLE IF NOT EXISTS files (
  name TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (${NOW}),
  closed_at TEXT,
  opening_float_cents INTEGER NOT NULL DEFAULT 0,
  counted_cash_cents INTEGER,
  expected_cash_cents INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  shift_id INTEGER REFERENCES shifts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  kind TEXT NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','refund')),
  refund_of INTEGER REFERENCES sales(id),
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  note TEXT,
  approved_by INTEGER REFERENCES users(id),
  etims_status TEXT NOT NULL DEFAULT 'pending',
  etims_invoice_no TEXT, etims_qr TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);

CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, unit TEXT NOT NULL,
  qty_milli INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  vat_code TEXT NOT NULL,
  line_total_cents INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL CHECK (method IN ('cash','mpesa','card','bank','credit')),
  amount_cents INTEGER NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER, action TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW})
);
`);

// ---------- roles: seed + migrate databases created before RBAC ----------
function seedRoles() {
  db.prepare("UPDATE roles SET name='Admin' WHERE is_system=1 AND name='Owner'").run();
  const count = (db.prepare("SELECT COUNT(*) AS c FROM roles").get() as { c: number }).c;
  if (count === 0) {
    for (const r of DEFAULT_ROLES) {
      const id = Number(
        db.prepare("INSERT INTO roles (name,description,is_system) VALUES (?,?,?)").run(r.name, r.description, r.isSystem ? 1 : 0).lastInsertRowid,
      );
      for (const p of r.permissions) db.prepare("INSERT INTO role_permissions (role_id,permission) VALUES (?,?)").run(id, p);
    }
  }
  // the Admin role holds every back-office permission (including ones added later) but never the till
  const admin = db.prepare("SELECT id FROM roles WHERE is_system=1").get() as { id: number } | undefined;
  if (admin) {
    for (const p of ALL_PERMISSIONS) {
      if (ADMIN_EXCLUDED.includes(p)) continue;
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id,permission) VALUES (?,?)").run(admin.id, p);
    }
    for (const p of ADMIN_EXCLUDED) db.prepare("DELETE FROM role_permissions WHERE role_id=? AND permission=?").run(admin.id, p);
    db.prepare("UPDATE roles SET description=? WHERE id=?").run(DEFAULT_ROLES[0].description, admin.id);
  }
}
seedRoles();
{
  {
    const key = "topdown_cashier_customers_v2";
    if (!db.prepare("SELECT 1 FROM settings WHERE key=?").get(key)) {
      const cashier = db.prepare("SELECT id FROM roles WHERE is_system=0 AND name='Cashier'").get() as { id: number } | undefined;
      if (cashier) db.prepare("DELETE FROM role_permissions WHERE role_id=? AND permission IN ('customers.create','customers.payment')").run(cashier.id);
      db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(key, "1");
    }
  }
  const NEW_FOR_MANAGER = ["suppliers.manage", "sales.credit"];
  for (const p of NEW_FOR_MANAGER) {
    const key = "topup_" + p;
    if (db.prepare("SELECT 1 FROM settings WHERE key=?").get(key)) continue;
    const mgr = db.prepare("SELECT id FROM roles WHERE is_system=0 AND name='Manager'").get() as { id: number } | undefined;
    if (mgr) db.prepare("INSERT OR IGNORE INTO role_permissions (role_id,permission) VALUES (?,?)").run(mgr.id, p);
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(key, "1");
  }
}

const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userCols.some((c) => c.name === "role_id")) {
  // old schema stored a fixed role name (owner/manager/cashier) with a CHECK constraint; rebuild the table
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, pin_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL REFERENCES roles(id), active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (${NOW}))`);
    db.exec(`INSERT INTO users_new (id,name,pin_hash,role_id,active,created_at)
      SELECT u.id, u.name, u.pin_hash, (SELECT id FROM roles WHERE lower(name)=CASE u.role WHEN 'owner' THEN 'admin' ELSE u.role END), u.active, u.created_at FROM users u`);
    db.exec("DROP TABLE users");
    db.exec("ALTER TABLE users_new RENAME TO users");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// credit terms: how many days a customer has to pay (added after the first release)
const customerCols = db.prepare("PRAGMA table_info(customers)").all() as { name: string }[];
if (!customerCols.some((c) => c.name === "credit_days")) db.exec("ALTER TABLE customers ADD COLUMN credit_days INTEGER NOT NULL DEFAULT 30");
if (!customerCols.some((c) => c.name === "credit_stopped")) db.exec("ALTER TABLE customers ADD COLUMN credit_stopped INTEGER NOT NULL DEFAULT 0");
// ID number, location and guarantor turned out not to be needed; remove them if an earlier version added them
for (const col of ["id_number", "address", "guarantor"]) {
  if (customerCols.some((c) => c.name === col)) {
    try { db.exec(`ALTER TABLE customers DROP COLUMN ${col}`); } catch { /* harmless if it cannot be dropped */ }
  }
}

// columns added after the first release
{
  const has = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
  if (!has("sale_items", "base_qty_milli")) {
    db.exec("ALTER TABLE sale_items ADD COLUMN base_qty_milli INTEGER");
    db.exec("UPDATE sale_items SET base_qty_milli = qty_milli WHERE base_qty_milli IS NULL");
  }
  // tax-authority item details (kept per item so eTIMS can be switched on later without touching the catalogue)
  for (const [col, ddl] of [["item_class_code", "TEXT"], ["qty_unit_code", "TEXT"], ["pack_unit_code", "TEXT"], ["origin_country", "TEXT DEFAULT 'KE'"]] as const)
    if (!has("products", col)) db.exec(`ALTER TABLE products ADD COLUMN ${col} ${ddl}`);
}

// ---------- helpers ----------
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function audit(userId: number | null, action: string, detail?: unknown) {
  db.prepare("INSERT INTO audit_log (user_id, action, detail) VALUES (?,?,?)").run(
    userId,
    action,
    detail === undefined ? null : JSON.stringify(detail),
  );
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  return salt.toString("hex") + ":" + scryptSync(pin, salt, 32).toString("hex");
}
export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  const h = scryptSync(pin, Buffer.from(saltHex, "hex"), 32);
  return timingSafeEqual(h, Buffer.from(hashHex, "hex"));
}

export const getSetting = (key: string, fallback = ""): string =>
  (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value ?? fallback;
export const setSetting = (key: string, value: string) =>
  db
    .prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, value);

export function stockOnHand(productId: number, locationId: number): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(qty_milli),0) AS q FROM stock_movements WHERE product_id=? AND location_id=?")
    .get(productId, locationId) as { q: number };
  return r.q;
}

// ---------- first-run seed ----------
export function seed() {
  db.prepare("UPDATE users SET name='Admin' WHERE name='Owner' AND role_id IN (SELECT id FROM roles WHERE is_system=1)").run();
  const users = db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  if (users.c === 0) {
    const adminRole = db.prepare("SELECT id FROM roles WHERE is_system=1").get() as { id: number };
    db.prepare("INSERT INTO users (name,pin_hash,role_id) VALUES (?,?,?)").run("Admin", hashPin("1234"), adminRole.id);
    console.log("Created default admin. PIN 1234 - change it in Settings immediately.");
  }
  if ((db.prepare("SELECT COUNT(*) AS c FROM locations").get() as { c: number }).c === 0) {
    db.prepare("INSERT INTO locations (name) VALUES ('Shop')").run();
    db.prepare("INSERT INTO locations (name) VALUES ('Store')").run();
  }
  if (!getSetting("business_name")) {
    setSetting("business_name", "My Hardware");
    setSetting("kra_pin", "");
    setSetting("address", "");
    setSetting("phone", "");
    setSetting("receipt_footer", "Goods once sold are not returnable without a receipt.");
    setSetting("receipt_prefix", "R");
  }
}
