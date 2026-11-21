import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { ALL_PERMISSIONS, DEFAULT_ROLES, OWNER_EXCLUDED } from "../shared/permissions.ts";

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
  const count = (db.prepare("SELECT COUNT(*) AS c FROM roles").get() as { c: number }).c;
  if (count === 0) {
    for (const r of DEFAULT_ROLES) {
      const id = Number(
        db.prepare("INSERT INTO roles (name,description,is_system) VALUES (?,?,?)").run(r.name, r.description, r.isSystem ? 1 : 0).lastInsertRowid,
      );
      for (const p of r.permissions) db.prepare("INSERT INTO role_permissions (role_id,permission) VALUES (?,?)").run(id, p);
    }
  }
  // the Owner role holds every back-office permission (including ones added later) but never the till
  const owner = db.prepare("SELECT id FROM roles WHERE is_system=1 AND name='Owner'").get() as { id: number } | undefined;
  if (owner) {
    for (const p of ALL_PERMISSIONS) {
      if (OWNER_EXCLUDED.includes(p)) continue;
      db.prepare("INSERT OR IGNORE INTO role_permissions (role_id,permission) VALUES (?,?)").run(owner.id, p);
    }
    for (const p of OWNER_EXCLUDED) db.prepare("DELETE FROM role_permissions WHERE role_id=? AND permission=?").run(owner.id, p);
    db.prepare("UPDATE roles SET description=? WHERE id=?").run(DEFAULT_ROLES[0].description, owner.id);
  }
}
seedRoles();

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
      SELECT u.id, u.name, u.pin_hash, (SELECT id FROM roles WHERE lower(name)=u.role), u.active, u.created_at FROM users u`);
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
  const users = db.prepare("SELECT COUNT(*) AS c FROM users").get() as { c: number };
  if (users.c === 0) {
    const ownerRole = db.prepare("SELECT id FROM roles WHERE is_system=1 AND name='Owner'").get() as { id: number };
    db.prepare("INSERT INTO users (name,pin_hash,role_id) VALUES (?,?,?)").run("Owner", hashPin("1234"), ownerRole.id);
    console.log("Created default owner. PIN 1234 - change it in Settings immediately.");
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
