// The single source of truth for what a user can be allowed to do.
// The server enforces these; the UI uses them to hide what a user cannot use.

export const PERMISSIONS = [
  // Selling
  { key: "sales.create", group: "Selling", label: "Make sales", hint: "Ring up sales, take payments, and open and close their own shift." },
  { key: "sales.view_all", group: "Selling", label: "View everyone's sales", hint: "Without this, a user only sees the sales they made themselves." },
  { key: "sales.discount", group: "Selling", label: "Give discounts without approval", hint: "Without this, a manager PIN is needed for every discount." },
  { key: "sales.refund", group: "Selling", label: "Process refunds without approval", hint: "Without this, a manager PIN is needed for every refund." },
  { key: "sales.credit", group: "Selling", label: "Sell on credit without approval", hint: "Without this, a manager PIN is needed every time goods are given on account." },
  { key: "sales.approve", group: "Selling", label: "Approve discounts and refunds for others", hint: "Lets this user's PIN authorise a discount or refund at someone else's till." },
  // Products and stock
  { key: "products.view_cost", group: "Products & stock", label: "See cost prices and profit", hint: "Buying prices and margins are hidden from users without this." },
  { key: "products.manage", group: "Products & stock", label: "Add and edit products and prices", hint: "Create products, change prices, VAT codes and categories." },
  { key: "suppliers.manage", group: "Products & stock", label: "Manage suppliers and buying", hint: "Suppliers, goods received, what you owe them, and paying them." },
  { key: "stock.manage", group: "Products & stock", label: "Receive, count and move stock", hint: "Record deliveries, stock-takes, damage and transfers between shop and store." },
  // Customers
  { key: "customers.create", group: "Customers", label: "Add customers", hint: "Create customer records with name and phone." },
  { key: "customers.manage", group: "Customers", label: "Edit customers, price tier and credit limit", hint: "Decide who gets contractor prices and how much credit." },
  { key: "customers.payment", group: "Customers", label: "Record customer account payments", hint: "Take payments against money a customer owes." },
  // Money
  { key: "shifts.view_all", group: "Money", label: "See all shifts and cash differences", hint: "Review every cashier's cash-up and any shortages." },
  { key: "reports.view", group: "Money", label: "View reports", hint: "Sales totals, VAT, profit, top items and stock value." },
  // Administration
  { key: "users.manage", group: "Administration", label: "Manage staff accounts", hint: "Add staff, assign roles, reset PINs and disable accounts." },
  { key: "roles.manage", group: "Administration", label: "Manage roles and permissions", hint: "Create roles and change what each role may do." },
  { key: "settings.manage", group: "Administration", label: "Change business settings", hint: "Business name, KRA PIN, receipt text and stock rules." },
  { key: "audit.view", group: "Administration", label: "View the audit log", hint: "See a record of who did what and when." },
] as const;

export type Permission = (typeof PERMISSIONS)[number]["key"];
export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);
export const PERMISSION_GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))];

const NOT_FOR_MANAGERS: Permission[] = ["users.manage", "roles.manage", "settings.manage", "audit.view"];
/** The admin runs the business from the back office. Selling is for cashiers and managers. */
export const ADMIN_EXCLUDED: Permission[] = ["sales.create"];

export const DEFAULT_ROLES: { name: string; description: string; isSystem: boolean; permissions: Permission[] }[] = [
  { name: "Admin", description: "Runs the whole business from the back office: staff, roles, products, reports and settings. Does not use the till. This role cannot be edited or removed.", isSystem: true, permissions: ALL_PERMISSIONS.filter((p) => !ADMIN_EXCLUDED.includes(p)) },
  {
    name: "Manager",
    description: "Runs the shop day to day: products, stock, approvals and reports.",
    isSystem: false,
    permissions: ALL_PERMISSIONS.filter((p) => !NOT_FOR_MANAGERS.includes(p)),
  },
  {
    name: "Cashier",
    description: "Serves customers at the till.",
    isSystem: false,
    permissions: ["sales.create"],
  },
];
