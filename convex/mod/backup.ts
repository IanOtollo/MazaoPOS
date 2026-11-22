import { fail, requirePerm, type Handler } from "../lib";

/*
 * Backup and export: lets the owner download their own data, one dataset at a time, page by page.
 * Nothing secret leaves here: PIN hashes, sign-in sessions, lockout counters and uploaded files are never offered.
 */
export interface Dataset { key: string; table: string; label: string; group: string; about: string }

export const DATASETS: Dataset[] = [
  { key: "products", table: "products", group: "Stock", label: "Products", about: "Every product with its prices, units and reorder level." },
  { key: "categories", table: "categories", group: "Stock", label: "Categories", about: "The groups your products belong to." },
  { key: "stock", table: "stock", group: "Stock", label: "Stock on hand", about: "How much of each product is in the shop and the store." },
  { key: "stockMovements", table: "stockMovements", group: "Stock", label: "Stock movements", about: "Every delivery, sale, count and transfer, with who did it." },
  { key: "sales", table: "sales", group: "Selling", label: "Sales", about: "Every sale and refund with its items and payments." },
  { key: "shifts", table: "shifts", group: "Selling", label: "Shifts", about: "Each cashier's shifts and cash-ups." },
  { key: "customers", table: "customers", group: "Customers", label: "Customers", about: "Registered customers, credit limits and what they owe." },
  { key: "customerLedger", table: "customerLedger", group: "Customers", label: "Customer accounts", about: "Every credit sale, payment and return on a customer's account." },
  { key: "customerNotes", table: "customerNotes", group: "Customers", label: "Follow-up notes", about: "Notes and promised payment dates for customers who owe." },
  { key: "suppliers", table: "suppliers", group: "Suppliers and buying", label: "Suppliers", about: "Your suppliers and what you owe each of them." },
  { key: "supplierLedger", table: "supplierLedger", group: "Suppliers and buying", label: "Supplier accounts", about: "Every delivery, payment and credit note on a supplier's account." },
  { key: "purchases", table: "purchases", group: "Suppliers and buying", label: "Deliveries", about: "Goods received from suppliers, with items and costs." },
  { key: "lpos", table: "lpos", group: "Suppliers and buying", label: "Purchase orders", about: "Local purchase orders sent to suppliers." },
  { key: "users", table: "users", group: "Business", label: "Staff", about: "Names, roles and whether they can sign in. PINs are never included." },
  { key: "roles", table: "roles", group: "Business", label: "Roles", about: "Each role and what it is allowed to do." },
  { key: "locations", table: "locations", group: "Business", label: "Shop and store", about: "Your stock locations." },
  { key: "settings", table: "settings", group: "Business", label: "Business settings", about: "Business name, receipt wording and selling rules." },
  { key: "auditLog", table: "auditLog", group: "Business", label: "Activity log", about: "A record of who did what and when." },
];

const PAGE = 400;
// Convex lets one function read about 16,000 documents, so counts stop there and say "or more"
const COUNT_CAP = 16000;

const find = (key: string) => DATASETS.find((d) => d.key === key);

/** Plain JSON for a row: Convex's own fields removed, and the staff table cut down to what is safe to share. */
function clean(key: string, row: Record<string, unknown>) {
  const { _id, _creationTime, ...rest } = row;
  void _id; void _creationTime;
  if (key === "users") {
    const { pinHash, ...safe } = rest;
    void pinHash;
    return safe;
  }
  return rest;
}

export const routes: Record<string, Handler> = {
  // the structure of the page: which datasets exist, their names, groups and one-line descriptions
  "GET /api/backup/summary": async (ctx, { token }) => {
    await requirePerm(ctx, token, "settings.manage");
    return { datasets: DATASETS.map(({ key, label, group, about }) => ({ key, label, group, about })) };
  },

  // how many rows a dataset holds (separate call per dataset, to stay inside Convex's per-function read limit)
  "GET /api/backup/:dataset/count": async (ctx, { token, params }) => {
    await requirePerm(ctx, token, "settings.manage");
    const d = find(params.dataset);
    if (!d) return fail(404, "Unknown data set");
    const rows = await (ctx.db.query(d.table as never) as any).take(COUNT_CAP + 1);
    return { dataset: d.key, rows: Math.min(rows.length, COUNT_CAP), capped: rows.length > COUNT_CAP };
  },

  // one page of rows; keep asking with the returned cursor until done is true
  "GET /api/backup/:dataset": async (ctx, { token, params, query }) => {
    await requirePerm(ctx, token, "settings.manage");
    const d = find(params.dataset);
    if (!d) return fail(404, "Unknown data set");
    const page = await (ctx.db.query(d.table as never) as any).paginate({ numItems: PAGE, cursor: query.cursor || null });
    return { dataset: d.key, rows: (page.page as Record<string, unknown>[]).map((r) => clean(d.key, r)), cursor: page.continueCursor as string, done: page.isDone as boolean };
  },
};
