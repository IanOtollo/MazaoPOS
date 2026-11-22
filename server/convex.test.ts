// End-to-end API check against the Convex backend.
// Run: npm run test:convex   (wipes the DEV deployment first; refuses on any deployment without TEST_RESET_ALLOWED=1)
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const base = (process.env.BASE_URL ?? "https://agreeable-mastiff-137.convex.site").replace(/\/+$/, "");
const convexRun = (fn: string, args: object = {}) => {
  const r = spawnSync("npx", ["convex", "run", fn, JSON.stringify(JSON.stringify(args))], { shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error("convex run " + fn + " failed: " + r.stdout + r.stderr);
};
convexRun("testing:reset");
let token = "";
async function api(method: string, path: string, body?: unknown, tok = token) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j as any };
}

try {
  // --- login
  const bad = await api("POST", "/api/auth/login", { pin: "9999" });
  assert.equal(bad.status, 401);
  const ok = await api("POST", "/api/auth/login", { pin: "1234" });
  assert.equal(ok.status, 200);
  token = ok.body.token;

  // --- cashier + products
  const roles = (await api("GET", "/api/roles")).body as { id: number; name: string }[];
  const roleId = (n: string) => roles.find((r) => r.name === n)!.id;
  const cashier = await api("POST", "/api/users", { name: "Wanjiru", pin: "5678", roleId: roleId("Cashier") });
  assert.equal(cashier.status, 200, JSON.stringify(cashier.body));
  const cashierLogin = await api("POST", "/api/auth/login", { pin: "5678" }, "");
  assert.equal(cashierLogin.body.user.name, "Wanjiru", "PIN alone identifies the user");
  const cashierTok = cashierLogin.body.token as string;

  const nail = await api("POST", "/api/products", {
    sku: "NAIL-3", name: "Nails 3 inch (kg)", unit: "kg", allowFraction: true, vatCode: "A",
    costCents: 10000, priceRetailCents: 15000, priceContractorCents: 13000,
  });
  const pipe = await api("POST", "/api/products", {
    sku: "PVC-1", name: "PVC pipe 1 inch", unit: "m", allowFraction: true, vatCode: "A",
    costCents: 20000, priceRetailCents: 29000,
  });
  const cement = await api("POST", "/api/products", {
    sku: "CEM-50", name: "Cement 50kg", unit: "bag", vatCode: "E", costCents: 70000, priceRetailCents: 80000,
  });
  assert.equal(nail.status, 200);
  for (const p of [nail, pipe, cement])
    await api("POST", "/api/stock/receive", { productId: p.body.id, locationId: 1, qtyMilli: 100_000, unitCostCents: undefined });

  // --- cashier cannot sell without a shift
  let r = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 1000 }], payments: [{ method: "cash", amountCents: 15000 }] }, cashierTok);
  assert.equal(r.status, 400, "needs shift");
  await api("POST", "/api/shifts/open", { floatCents: 100000 }, cashierTok);

  // --- fractional sale: 2.5 kg nails @150 = 375.00 ; 3 m pipe @290 = 870.00 ; total 1245.00 ; pay 1300 cash
  r = await api(
    "POST", "/api/sales",
    { items: [{ productId: nail.body.id, qtyMilli: 2500 }, { productId: pipe.body.id, qtyMilli: 3000 }], payments: [{ method: "cash", amountCents: 130000 }] },
    cashierTok,
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total_cents, 124500);
  assert.equal(r.body.changeCents, 5500);
  assert.equal(r.body.vat_cents, Math.round((124500 * 0.16) / 1.16));
  assert.equal(r.body.payments[0].amount_cents, 124500, "cash recorded net of change");
  const saleId = r.body.id;

  // --- stock deducted exactly
  const prods = await api("GET", "/api/products?q=nails");
  assert.equal(prods.body[0].stock_shop, 100_000 - 2500);

  // --- fractions rejected for whole-unit items
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 1500 }], payments: [{ method: "cash", amountCents: 200000 }] }, cashierTok);
  assert.equal(r.status, 400);

  // --- insufficient stock
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 999_000 }], payments: [{ method: "cash", amountCents: 1 }] }, cashierTok);
  assert.equal(r.status, 409);

  // --- short payment & discount needing approval
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 1000 }], payments: [{ method: "cash", amountCents: 100 }] }, cashierTok);
  assert.equal(r.status, 400);
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 1000 }], discountCents: 5000, payments: [{ method: "cash", amountCents: 75000 }] }, cashierTok);
  assert.equal(r.status, 403, "cashier discount needs manager");
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 1000 }], discountCents: 5000, approvalPin: "1234", payments: [{ method: "cash", amountCents: 75000 }] }, cashierTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total_cents, 75000);
  assert.equal(r.body.vat_cents, 0, "cement is VAT exempt");

  // --- contractor tier price + credit sale + limit
  const cust = await api("POST", "/api/customers", { name: "Kamau Builders", tier: "contractor", creditLimitCents: 500000 });
  r = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 10_000 }], customerId: cust.body.id, approvalPin: "1234", payments: [{ method: "credit", amountCents: 130000 }] }, cashierTok);
  assert.equal(r.status, 200, JSON.stringify(r.body)); // contractor price 130/kg*10 = 1300.00
  assert.equal(r.body.total_cents, 130000);
  let c = await api("GET", `/api/customers/${cust.body.id}`);
  assert.equal(c.body.balance_cents, 130000);
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 10_000 }], customerId: cust.body.id, approvalPin: "1234", payments: [{ method: "credit", amountCents: 800000 }] }, cashierTok);
  assert.equal(r.status, 409, "credit limit");
  await api("POST", `/api/customers/${cust.body.id}/payment`, { amountCents: 30000, method: "cash" });
  c = await api("GET", `/api/customers/${cust.body.id}`);
  assert.equal(c.body.balance_cents, 100000);

  // --- refund: cashier needs approval; over-refund blocked
  const sale = await api("GET", `/api/sales/${saleId}`, undefined, cashierTok);
  const item = sale.body.items[1]; // pipe 3 m
  r = await api("POST", `/api/sales/${saleId}/refund`, { items: [{ saleItemId: item.id, qtyMilli: 1000 }], method: "cash", reason: "wrong size" }, cashierTok);
  assert.equal(r.status, 403);
  r = await api("POST", `/api/sales/${saleId}/refund`, { items: [{ saleItemId: item.id, qtyMilli: 1000 }], method: "cash", reason: "wrong size", approvalPin: "1234" }, cashierTok);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total_cents, -29000);
  r = await api("POST", `/api/sales/${saleId}/refund`, { items: [{ saleItemId: item.id, qtyMilli: 2500 }], method: "cash", reason: "x", approvalPin: "1234" }, cashierTok);
  assert.equal(r.status, 400, "cannot refund more than sold");
  const after = await api("GET", "/api/products?q=PVC");
  assert.equal(after.body[0].stock_shop, 100_000 - 3000 + 1000, "restocked");

  // --- shift close reconciles: float 1000 + cash(1245 + 750 - 290) = 2705.00
  const close = await api("POST", "/api/shifts/close", { countedCashCents: 270500 }, cashierTok);
  assert.equal(close.body.expectedCashCents, 100000 + 124500 + 75000 - 29000);
  assert.equal(close.body.varianceCents, 0);

  // --- report agrees with the ledger
  const rep = await api("GET", "/api/reports/summary");
  assert.equal(rep.body.gross_cents, 124500 + 75000 + 130000 - 29000);


  // =================== RBAC ===================
  // duplicate PINs are refused (PIN-only sign-in needs them unique)
  const dup = await api("POST", "/api/users", { name: "Copycat", pin: "5678", roleId: roleId("Cashier") });
  assert.equal(dup.status, 409, "duplicate PIN");

  // the staff list is no longer public
  assert.equal((await api("GET", "/api/auth/users", undefined, "")).status, 404, "no public staff list");

  // cashier: blocked from every back-office area
  for (const [m, p, b] of [
    ["GET", "/api/users"], ["GET", "/api/reports/summary"], ["GET", "/api/audit"], ["GET", "/api/shifts"],
    ["POST", "/api/products", { sku: "X", name: "X", priceRetailCents: 100 }], ["POST", "/api/stock/receive", { productId: nail.body.id, locationId: 1, qtyMilli: 1000 }],
    ["PUT", "/api/settings", { business_name: "Hacked" }], ["POST", "/api/roles", { name: "Evil", permissions: [] }],
  ] as [string, string, unknown?][]) {
    const x = await api(m, p, b, cashierTok);
    assert.equal(x.status, 403, `cashier must not ${m} ${p} (got ${x.status})`);
  }
  // ...and cannot see buying prices
  const seen = await api("GET", "/api/products?q=nails", undefined, cashierTok);
  assert.equal(seen.body[0].cost_cents, 0, "cost hidden from cashier");
  assert.ok((await api("GET", "/api/products?q=nails")).body[0].cost_cents > 0, "admin sees cost");

  // manager: can approve a cashier's discount with their PIN, but cannot manage roles or staff
  const mgr = await api("POST", "/api/users", { name: "Otieno", pin: "4321", roleId: roleId("Manager") });
  const mgrTok = (await api("POST", "/api/auth/login", { pin: "4321" }, "")).body.token as string;
  assert.equal((await api("POST", "/api/roles", { name: "Evil", permissions: [] }, mgrTok)).status, 403, "manager cannot manage roles");
  assert.equal((await api("GET", "/api/users", undefined, mgrTok)).status, 403, "manager cannot manage staff");
  assert.equal((await api("GET", "/api/reports/summary", undefined, mgrTok)).status, 200, "manager sees reports");
  await api("POST", "/api/shifts/open", { floatCents: 0 }, cashierTok);
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 1000 }], discountCents: 1000, approvalPin: "4321", payments: [{ method: "cash", amountCents: 79000 }] }, cashierTok);
  assert.equal(r.status, 200, "manager PIN approves discount: " + JSON.stringify(r.body));
  assert.equal(r.body.approved_by, mgr.body.id, "approver recorded");
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 1000 }], discountCents: 1000, approvalPin: "5678", payments: [{ method: "cash", amountCents: 79000 }] }, cashierTok);
  assert.equal(r.status, 403, "a cashier's own PIN cannot approve");

  // custom role: stock clerk can receive stock and see cost, but cannot sell
  const role = await api("POST", "/api/roles", { name: "Stock clerk", description: "Receives goods", permissions: ["stock.manage", "products.view_cost"] });
  assert.equal(role.status, 200, JSON.stringify(role.body));
  await api("POST", "/api/users", { name: "Achieng", pin: "2468", roleId: role.body.id });
  const clerkTok = (await api("POST", "/api/auth/login", { pin: "2468" }, "")).body.token as string;
  assert.equal((await api("POST", "/api/stock/receive", { productId: nail.body.id, locationId: 1, qtyMilli: 1000 }, clerkTok)).status, 200, "clerk can receive");
  assert.equal((await api("POST", "/api/shifts/open", { floatCents: 0 }, clerkTok)).status, 403, "clerk cannot open a till shift");
  assert.ok((await api("GET", "/api/products?q=nails", undefined, clerkTok)).body[0].cost_cents > 0, "clerk sees cost");

  // a role in use cannot be deleted; changing a role takes effect immediately
  assert.equal((await api("DELETE", `/api/roles/${role.body.id}`)).status, 409, "role in use");
  await api("PUT", `/api/roles/${role.body.id}`, { name: "Stock clerk", description: "", permissions: ["products.view_cost"] });
  assert.equal((await api("POST", "/api/stock/receive", { productId: nail.body.id, locationId: 1, qtyMilli: 1000 }, clerkTok)).status, 403, "permission removed instantly");

  // Admin role is locked; the admin cannot lock themselves out
  assert.equal((await api("PUT", `/api/roles/${roleId("Admin")}`, { name: "Admin", description: "", permissions: [] })).status, 400, "admin role locked");
  assert.equal((await api("PATCH", "/api/users/1", { roleId: roleId("Cashier") })).status, 400, "cannot demote the last role manager");
  assert.equal((await api("PATCH", "/api/users/1", { active: false })).status, 400, "cannot disable yourself");
  // a manager cannot reset the Admin's PIN (privilege escalation)
  await api("PUT", `/api/roles/${roleId("Manager")}`, { name: "Manager", description: "", permissions: ["users.manage", "sales.create"] }); // admin grants users.manage
  assert.equal((await api("PATCH", "/api/users/1", { pin: "9999" }, mgrTok)).status, 403, "cannot reset a more powerful user's PIN");
  assert.equal((await api("POST", "/api/users", { name: "Boss2", pin: "1357", roleId: roleId("Admin") }, mgrTok)).status, 403, "cannot assign a role above your own");

  // =================== deleting staff ===================
  {
    const me = (await api("GET", "/api/me")).body.id as number;
    assert.equal((await api("PATCH", `/api/users/${me}`, { name: "Ian" })).status, 200, "the admin can rename themselves");
    assert.equal((await api("GET", "/api/me")).body.name, "Ian", "the new name shows as who is signed in");
    assert.equal((await api("PATCH", `/api/users/${me}`, { name: "   " })).status, 400, "a name cannot be blank");
    assert.equal((await api("PATCH", `/api/users/${me}`, { name: "Admin" })).status, 200, "and it can be changed back");
    const temp = await api("POST", "/api/users", { name: "Temp Hand", pin: "8642", roleId: roleId("Cashier") });
    assert.equal(temp.status, 200, JSON.stringify(temp.body));
    const tempTok = (await api("POST", "/api/auth/login", { pin: "8642" }, "")).body.token as string;
    assert.equal((await api("GET", "/api/me", undefined, tempTok)).status, 200, "the new person is signed in");
    assert.equal((await api("DELETE", `/api/users/${temp.body.id}`, undefined, cashierTok)).status, 403, "a cashier cannot delete staff");
    assert.equal((await api("DELETE", `/api/users/${me}`)).status, 400, "you cannot delete yourself");
    assert.equal((await api("DELETE", "/api/users/999999")).status, 404, "unknown person");
    assert.equal((await api("DELETE", `/api/users/${temp.body.id}`)).status, 200, "the admin can delete them");
    assert.equal((await api("GET", "/api/me", undefined, tempTok)).status, 401, "their session ends at once");
    assert.equal((await api("POST", "/api/auth/login", { pin: "8642" }, "")).status, 401, "their PIN no longer signs in");
    const staff = (await api("GET", "/api/users")).body as { id: number }[];
    assert.ok(!staff.some((u) => u.id === temp.body.id), "they are gone from the staff list");
    assert.equal((await api("DELETE", `/api/users/${temp.body.id}`)).status, 404, "deleting twice is a plain not-found");
    const again = await api("POST", "/api/users", { name: "Someone New", pin: "8642", roleId: roleId("Cashier") });
    assert.equal(again.status, 200, "the freed PIN can be given to someone else");
    // a role is no longer held up by people who were deleted
    const tmpRole = await api("POST", "/api/roles", { name: "Temp role", description: "", permissions: ["sales.view_all"] });
    const holder = await api("POST", "/api/users", { name: "Holder", pin: "1357", roleId: tmpRole.body.id });
    assert.equal((await api("DELETE", `/api/roles/${tmpRole.body.id}`)).status, 409, "a role in use cannot be deleted");
    assert.equal((await api("DELETE", `/api/users/${holder.body.id}`)).status, 200);
    assert.equal((await api("DELETE", `/api/roles/${tmpRole.body.id}`)).status, 200, "once its only holder is deleted the role can go");
  }

  // =================== product import ===================
  const rowsIn = [
    { name: "Hammer 16oz", sku: "HAM-16", category: "Tools", unit: "pc", vat: "16", cost: "380", retail: "600", shopStock: "10", storeStock: "5" },
    { name: "Copper wire", sku: "CU-1", category: "Electrical", unit: "m", vat: "16", cost: "1,000", retail: "1,500.50", shopStock: "100" },
    { name: "Cement 32.5", sku: "CEM-32", category: "Tools", unit: "bag", vat: "Exempt", cost: "600", retail: "700" },
    { name: "", sku: "BAD-1", retail: "100" },
    { name: "No price", sku: "BAD-2" },
    { name: "Dupe of earlier", sku: "ham-16", retail: "50" },
    { name: "Existing code", sku: "NAIL-3", retail: "50" },
    { name: "Bad VAT", sku: "BAD-3", retail: "10", vat: "banana" },
  ];
  let imp = await api("POST", "/api/products/import", { rows: rowsIn, dryRun: true });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.valid, 3, "3 valid rows");
  assert.equal(imp.body.invalid, 5, "5 invalid rows");
  assert.ok(imp.body.errors.some((e: any) => e.row === 5 && /Name/.test(e.message)), "row numbers match the spreadsheet");
  assert.equal((await api("GET", "/api/products?q=HAM-16")).body.length, 0, "dry run saves nothing");

  assert.equal((await api("POST", "/api/products/import", { rows: rowsIn, dryRun: false }, cashierTok)).status, 403, "cashier cannot import");
  imp = await api("POST", "/api/products/import", { rows: rowsIn, dryRun: false });
  assert.equal(imp.body.imported, 3);
  const ham = (await api("GET", "/api/products?q=HAM-16")).body[0];
  assert.equal(ham.stock_shop, 10_000, "opening stock in shop");
  assert.equal(ham.stock_store, 5_000, "opening stock in store");
  assert.equal(ham.category, "Tools");
  const cu = (await api("GET", "/api/products?q=CU-1")).body[0];
  assert.equal(cu.price_retail_cents, 150050, "1,500.50 parsed");
  assert.equal(cu.cost_cents, 100000, "1,000 parsed");
  assert.equal(cu.allow_fraction, 1, "metres can be sold in fractions");
  assert.equal((await api("GET", "/api/products?q=CEM-32")).body[0].vat_code, "E", "Exempt recognised");
  imp = await api("POST", "/api/products/import", { rows: [rowsIn[0]], dryRun: true });
  assert.equal(imp.body.invalid, 1, "re-importing the same file is refused, not duplicated");

  // =================== big catalogues: nothing is cut off ===================
  {
    const totalNow = async () => (await api("GET", "/api/products/page?limit=1")).body.total as number;
    const base0 = await totalNow();
    for (let part = 0; part < 2; part++) {
      const rows = Array.from({ length: 550 }, (_, i) => ({ name: `Bulk item ${part * 550 + i}`, sku: `BULK-${part * 550 + i}`, unit: "pc", vat: "16", cost: "10", retail: "20", shopStock: "5" }));
      const r = await api("POST", "/api/products/import", { rows, dryRun: false });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.imported, 550);
    }
    assert.equal(await totalNow(), base0 + 1100, "all 1,100 are counted");
    const seen = new Set<number>();
    let pages = 0;
    for (let offset = 0; ; offset += 500) {
      const pg = await api("GET", `/api/products/page?limit=500&offset=${offset}&all=1`);
      assert.equal(pg.status, 200);
      for (const p of pg.body.items) { assert.ok(!seen.has(p.id), "no product appears on two pages"); seen.add(p.id); }
      pages++;
      if (!pg.body.items.length || seen.size >= pg.body.total) break;
    }
    assert.equal(seen.size, base0 + 1100, "reading every page returns every product");
    assert.ok(pages >= 3, "it really was split into pages");
    const last = await api("GET", `/api/products/page?limit=50&offset=${base0 + 1100 - 10}`);
    assert.equal(last.body.items.length, 10, "the last page holds the remainder");
    const found = await api("GET", "/api/products/page?q=BULK-1099");
    assert.equal(found.body.total, 1, "search reaches products far down the list");
    const sm = (await api("GET", "/api/products/page?limit=1")).body.summary;
    assert.equal(sm.items, base0 + 1100, "the summary covers the whole catalogue, not one page");
  }

  // =================== inventory values: selling, cost, store, dead stock ===================
  {
    assert.equal((await api("GET", "/api/reports/inventory-values", undefined, cashierTok)).status, 403, "cashier cannot see stock values");
    const v = await api("GET", "/api/reports/inventory-values?days=90");
    assert.equal(v.status, 200, JSON.stringify(v.body));
    assert.ok(v.body.selling_value_cents >= v.body.cost_value_cents, "stock is worth at least its cost");
    assert.ok(v.body.store_cost_value_cents > 0 && v.body.store_items >= 1, "stock in the store is valued separately");
    assert.ok(v.body.dead_items >= 1 && v.body.dead_cost_value_cents > 0, "stock that has not sold counts as dead stock");
    assert.ok(v.body.dead_cost_value_cents <= v.body.cost_value_cents, "dead stock is part of the stock at cost");
  }

  // =================== dashboard ===================
  assert.equal((await api("GET", "/api/dashboard", undefined, cashierTok)).status, 403, "cashier cannot open the dashboard");
  const dash = await api("GET", "/api/dashboard?days=7");
  assert.equal(dash.status, 200, JSON.stringify(dash.body));
  const repToday = (await api("GET", "/api/reports/summary")).body;
  assert.equal(dash.body.series.length, 7, "one point per day, empty days included");
  assert.equal(dash.body.current.net_cents, repToday.gross_cents, "dashboard net sales agree with the report");
  assert.equal(dash.body.series[6].net_cents, repToday.gross_cents, "today is the last day of the series");
  assert.equal(dash.body.current.profit_cents, repToday.margin_cents, "profit agrees with the report");
  assert.ok(dash.body.owing.total_cents > 0 && dash.body.owing.top[0].name === "Kamau Builders", "customers owing listed");
  assert.equal(dash.body.hours.length, 24);
  assert.ok(dash.body.topItems.length > 0 && dash.body.cashiers.length > 0);
  assert.ok(dash.body.stockValue.cost_cents > 0, "admin sees stock value");
  assert.equal((await api("GET", "/api/dashboard?days=1")).body.series.length, 1, "today view");
  // reports permission without cost permission: no profit and no stock cost
  const analyst = await api("POST", "/api/roles", { name: "Analyst", description: "", permissions: ["reports.view"] });
  await api("POST", "/api/users", { name: "Auditor", pin: "1122", roleId: analyst.body.id });
  const analystTok = (await api("POST", "/api/auth/login", { pin: "1122" }, "")).body.token as string;
  const blind = await api("GET", "/api/dashboard?days=7", undefined, analystTok);
  assert.equal(blind.status, 200);
  assert.equal(blind.body.current.profit_cents, null, "profit hidden without products.view_cost");
  assert.equal(blind.body.stockValue, null, "stock cost hidden without products.view_cost");
  assert.ok(blind.body.current.net_cents > 0, "but sales figures are visible");

  // every figure on the cards has a series behind its sparkline
  assert.equal(dash.body.series[6].profit_cents, repToday.margin_cents, "the day's profit matches the report");
  assert.equal(dash.body.series[6].vat_cents, repToday.vat_cents, "the day's VAT matches the report");
  assert.ok(dash.body.hours.every((h: any) => typeof h.net_cents === "number"), "hourly takings are present for the Today view");
  assert.ok(blind.body.series.every((x: any) => x.profit_cents === null), "no profit series without products.view_cost");

  // custom date range
  const todayStr = dash.body.to as string;
  const one = await api("GET", `/api/dashboard?from=${todayStr}&to=${todayStr}`);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.days, 1, "single-day custom range");
  assert.equal(one.body.series.length, 1);
  assert.equal(one.body.current.net_cents, repToday.gross_cents, "custom range for today equals today's report");
  const wide = await api("GET", `/api/dashboard?from=2020-01-01&to=${todayStr}`);
  assert.equal(wide.status, 400, "more than a year is refused");
  assert.equal((await api("GET", `/api/dashboard?from=${todayStr}&to=2020-01-01`)).status, 400, "start after end is refused");
  assert.equal((await api("GET", `/api/dashboard?from=${todayStr}&to=2099-01-01`)).status, 400, "future end is refused");
  assert.equal((await api("GET", `/api/dashboard?from=${todayStr}`)).status, 400, "both dates are required");
  assert.equal((await api("GET", `/api/dashboard?from=2026-02-30&to=2026-03-01`)).status, 400, "impossible dates are refused");
  const past = await api("GET", "/api/dashboard?from=2020-01-01&to=2020-01-31");
  assert.equal(past.status, 200);
  assert.equal(past.body.current.net_cents, 0, "a quiet period reports zero, not an error");
  assert.equal(past.body.series.length, 31);


  // =================== the admin does not use the till ===================
  const me = await api("GET", "/api/me");
  assert.ok(!me.body.permissions.includes("sales.create"), "admin has no till permission");
  assert.ok(me.body.permissions.includes("roles.manage") && me.body.permissions.includes("sales.approve"), "admin keeps every back-office permission");
  const adminSale = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 1000 }], payments: [{ method: "cash", amountCents: 15000 }] });
  assert.equal(adminSale.status, 403, "admin cannot sell");
  assert.equal((await api("POST", "/api/shifts/open", { floatCents: 0 })).status, 403, "admin cannot open a till shift");
  assert.equal((await api("POST", "/api/sales/1/refund", { items: [{ saleItemId: 1, qtyMilli: 1000 }], method: "cash", reason: "x" })).status, 403, "admin cannot process refunds at a till");
  // ...but the admin can still approve a cashier's discount with their PIN (done earlier with PIN 1234)
  const adminRole = (await api("GET", "/api/roles")).body.find((x: any) => x.name === "Admin");
  assert.ok(!adminRole.permissions.includes("sales.create"), "Admin role lists no till permission");
  assert.equal(adminRole.permissions.length, 18, "Admin holds the 18 back-office permissions");
  // managers (small shops) and cashiers can still sell
  assert.equal((await api("POST", "/api/shifts/open", { floatCents: 0 }, mgrTok)).status, 200, "manager can open a till shift");
  // reports detail used by the Reports screen
  const detail = await api("GET", "/api/dashboard?days=7");
  assert.ok(Array.isArray(detail.body.byVat) && detail.body.byVat.length > 0, "VAT breakdown present");


  // =================== customers who owe: ageing, follow-ups, credit control ===================
  const lp = await api("POST", "/api/customers", { name: "Late Payer", phone: "0700 111 222", tier: "retail", creditLimitCents: 500000, creditDays: 30 });
  assert.equal(lp.status, 200, JSON.stringify(lp.body));
  const lpId = lp.body.id as number;
  convexRun("testing:addDebt", { who: "customer", id: lpId, amountCents: 100000, daysAgo: 45 });
  convexRun("testing:addDebt", { who: "customer", id: lpId, amountCents: 50000, daysAgo: 10 });
  // a part payment settles the OLDEST debt first
  assert.equal((await api("POST", `/api/customers/${lpId}/payment`, { amountCents: 30000, method: "cash" })).status, 200);
  let acct = await api("GET", `/api/customers/${lpId}/account`);
  assert.equal(acct.status, 200);
  assert.equal(acct.body.balance_cents, 120000, "1,500 owed minus 300 paid");
  assert.equal(acct.body.ageing.balance_cents, 120000);
  assert.equal(acct.body.ageing.buckets.d1_30, 70000, "the old debt is 15 days past its 30-day terms, with the payment taken off it");
  assert.equal(acct.body.ageing.buckets.current, 50000, "the newer debt is not yet due");
  assert.equal(acct.body.ageing.overdue_cents, 70000);
  assert.equal(acct.body.ageing.max_days_overdue, 15);
  assert.equal(acct.body.statement[0].balance_cents, 120000, "statement shows a running balance, newest first");
  assert.equal(acct.body.statement.at(-1).balance_cents, 100000, "oldest line first in the running balance");

  // the owing list
  let rec = await api("GET", "/api/receivables");
  const row = rec.body.customers.find((c: any) => c.id === lpId);
  assert.ok(row, "Late Payer is on the owing list");
  assert.equal(row.overdue_cents, 70000);
  assert.equal(row.max_days_overdue, 15);
  assert.ok(rec.body.totals.overdue_cents >= 70000 && rec.body.totals.owed_cents >= 120000);
  assert.equal(rec.body.customers.some((c: any) => c.balance_cents <= 0), false, "only people who owe appear");

  // follow-ups: cashiers cannot log them; a missed promise is detected, a kept one is not
  assert.equal((await api("POST", `/api/customers/${lpId}/notes`, { kind: "call", body: "x" }, cashierTok)).status, 403, "cashier cannot log follow-ups");
  assert.equal((await api("POST", `/api/customers/${lpId}/notes`, { kind: "call", body: "" })).status, 400, "an empty note is refused");
  assert.equal((await api("POST", `/api/customers/${lpId}/notes`, { kind: "promise", body: "" })).status, 400, "a promise needs a date");
  assert.equal((await api("POST", `/api/customers/${lpId}/notes`, { kind: "call", body: "Phoned, says cheque on Friday" })).status, 200);
  const yesterday = new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
  assert.equal((await api("POST", `/api/customers/${lpId}/notes`, { kind: "promise", promiseDate: yesterday, promiseCents: 70000 })).status, 200);
  rec = await api("GET", "/api/receivables");
  assert.equal(rec.body.customers.find((c: any) => c.id === lpId).promise_broken, true, "promised yesterday, paid nothing since");
  await api("POST", `/api/customers/${lpId}/payment`, { amountCents: 70000, method: "mpesa", reference: "SHK123" });
  rec = await api("GET", "/api/receivables");
  assert.equal(rec.body.customers.find((c: any) => c.id === lpId).promise_broken, false, "promise kept once the money arrived");
  acct = await api("GET", `/api/customers/${lpId}/account`);
  assert.equal(acct.body.notes.length, 2, "both follow-ups are on file");
  assert.equal(acct.body.ageing.overdue_cents, 0, "the overdue debt is now fully paid");
  assert.equal(acct.body.balance_cents, 50000);

  // credit control: optionally refuse more credit to badly overdue customers
  convexRun("testing:addDebt", { who: "customer", id: lpId, amountCents: 80000, daysAgo: 60 });
  const creditSale = () => api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 1000 }], customerId: lpId, approvalPin: "1234", payments: [{ method: "credit", amountCents: 15000 }] }, cashierTok);
  assert.equal((await creditSale()).status, 200, "with the rule off, credit is still given");
  assert.equal((await api("PUT", "/api/settings", { block_credit_overdue_days: "10" })).status, 200);
  const blocked = await creditSale();
  assert.equal(blocked.status, 409, "overdue customer is refused credit");
  assert.match(blocked.body.error, /overdue/i);
  assert.equal((await api("PUT", "/api/settings", { block_credit_overdue_days: "0" })).status, 200);

  // updating ONE field must leave the others alone (stopping credit used to reset the limit and tier)
  {
    const before = (await api("GET", `/api/customers/${lpId}/account`)).body.customer;
    assert.equal(before.credit_limit_cents, 500000, "the credit limit set at registration is intact");
    await api("PATCH", `/api/customers/${lpId}`, { creditStopped: true });
    await api("PATCH", `/api/customers/${lpId}`, { creditStopped: false });
    await api("PATCH", `/api/customers/${lpId}`, { phone: "0799 000 000" });
    const after = (await api("GET", `/api/customers/${lpId}/account`)).body.customer;
    assert.equal(after.credit_limit_cents, 500000, "credit limit survives partial updates");
    assert.equal(after.tier, "retail");
    assert.equal(after.credit_days, before.credit_days, "days to pay survive partial updates");
    assert.equal(after.phone, "0799 000 000", "the field that was sent did change");
  }

  // credit terms are editable and validated
  assert.equal((await api("PATCH", `/api/customers/${lpId}`, { creditDays: 14 })).status, 200);
  assert.equal((await api("GET", `/api/customers/${lpId}/account`)).body.customer.credit_days, 14);
  assert.equal((await api("PATCH", `/api/customers/${lpId}`, { creditDays: 999 })).status, 400, "terms are capped at a year");


  // =================== live updates ===================
  assert.equal((await fetch(base + "/api/live")).status, 401, "the live channel needs a sign-in");
  {
    const topics = async () => (await api("GET", "/api/live")).body as Record<string, number>;
    const t0 = await topics();
    await api("PUT", "/api/settings", { receipt_footer: "Thank you" });
    const t1 = await topics();
    assert.ok((t1.settings ?? 0) > (t0.settings ?? 0), "a settings change bumps its topic");
    const bad = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 1000 }], payments: [{ method: "cash", amountCents: 1 }] }, cashierTok);
    assert.equal(bad.status, 400);
    const t2 = await topics();
    assert.equal(t2.sales ?? 0, t1.sales ?? 0, "a failed request must not announce a change");
    const ok = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 1000 }], payments: [{ method: "cash", amountCents: 15000 }] }, cashierTok);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const t3 = await topics();
    for (const k of ["sales", "stock", "dashboard"]) assert.ok((t3[k] ?? 0) > (t2[k] ?? 0), "a sale bumps " + k);
    await api("GET", "/api/products?q=x");
    const t4 = await topics();
    assert.deepEqual(t4, t3, "reading data announces nothing");
  }


  // =================== suppliers and buying ===================
  assert.equal((await api("GET", "/api/suppliers", undefined, cashierTok)).status, 403, "cashier cannot see suppliers");
  assert.equal((await api("GET", "/api/suppliers", undefined, analystTok)).status, 403, "reports permission does not include suppliers");
  const sup = await api("POST", "/api/suppliers", { name: "AquaBase Ltd", phone: "0711 000 111", creditDays: 30 });
  assert.equal(sup.status, 200, JSON.stringify(sup.body));
  const supId = sup.body.id as number;
  assert.equal((await api("POST", "/api/suppliers", { name: "" })).status, 400, "a supplier needs a name");

  // a delivery: 10 m of pipe at 200.00 and 20 kg of nails at 110.00 = 4,200.00; 1,000.00 paid on the spot
  const pipeBefore = (await api("GET", "/api/products?q=PVC-1")).body[0];
  const po = await api("POST", "/api/purchases", {
    supplierId: supId, invoiceNo: "INV-77", locationId: 1, paidCents: 100000, payMethod: "cash",
    lines: [{ productId: pipe.body.id, qtyMilli: 10000, unitCostCents: 20000 }, { productId: nail.body.id, qtyMilli: 20000, unitCostCents: 11000 }],
  });
  assert.equal(po.status, 200, JSON.stringify(po.body));
  const pipeAfter = (await api("GET", "/api/products?q=PVC-1")).body[0];
  assert.equal(pipeAfter.stock_shop, pipeBefore.stock_shop + 10000, "stock rose by the delivered quantity");
  assert.equal((await api("GET", "/api/products?q=NAIL-3")).body[0].cost_cents, 11000, "the new buying price became the cost price");
  let sd = await api("GET", `/api/suppliers/${supId}`);
  assert.equal(sd.body.owed_cents, 320000, "4,200 delivered minus 1,000 paid");
  assert.equal(sd.body.statement[0].balance_cents, 320000);
  assert.equal(sd.body.deliveries[0].invoice_no, "INV-77");
  assert.equal(sd.body.deliveries[0].total_cents, 420000);

  // validation
  assert.equal((await api("POST", "/api/purchases", { supplierId: supId, lines: [] })).status, 400, "a delivery needs items");
  assert.equal((await api("POST", "/api/purchases", { supplierId: 99999, lines: [{ productId: pipe.body.id, qtyMilli: 1000, unitCostCents: 100 }] })).status, 400, "unknown supplier");
  assert.equal((await api("POST", "/api/purchases", { supplierId: supId, paidCents: 999999, lines: [{ productId: pipe.body.id, qtyMilli: 1000, unitCostCents: 100 }] })).status, 400, "cannot pay more than the delivery");

  // paying: not more than owed; a credit note reduces it too
  assert.equal((await api("POST", `/api/suppliers/${supId}/payment`, { amountCents: 400000, method: "bank" })).status, 400, "cannot overpay");
  assert.equal((await api("POST", `/api/suppliers/${supId}/payment`, { amountCents: 120000, method: "bank", reference: "TRX1" })).body.owed_cents, 200000);
  assert.equal((await api("POST", `/api/suppliers/${supId}/payment`, { amountCents: 50000, method: "credit_note" })).body.owed_cents, 150000, "credit note applied");

  // ageing of what we owe: KES 1,000 delivered 45 days ago and KES 500 delivered 10 days ago, 30 days to pay
  const old = await api("POST", "/api/suppliers", { name: "Old Debt Co", creditDays: 30 });
  convexRun("testing:addDebt", { who: "supplier", id: old.body.id, amountCents: 100000, daysAgo: 45 });
  convexRun("testing:addDebt", { who: "supplier", id: old.body.id, amountCents: 50000, daysAgo: 10 });
  await api("POST", `/api/suppliers/${old.body.id}/payment`, { amountCents: 30000, method: "cash" });
  const od = await api("GET", `/api/suppliers/${old.body.id}`);
  assert.equal(od.body.ageing.buckets.d1_30, 70000, "payment settles the oldest delivery first");
  assert.equal(od.body.ageing.buckets.current, 50000);
  assert.equal(od.body.ageing.overdue_cents, 70000);
  const supList = await api("GET", "/api/suppliers");
  const oldRow = supList.body.suppliers.find((x: any) => x.id === old.body.id);
  assert.equal(oldRow.overdue_cents, 70000);
  assert.equal(oldRow.max_days_overdue, 15);
  assert.ok(supList.body.totals.owed_cents >= 150000 + 120000, "totals add up across suppliers");

  // a supplier update changes only what it names
  await api("PATCH", `/api/suppliers/${supId}`, { creditDays: 21 });
  await api("PATCH", `/api/suppliers/${supId}`, { phone: "0712 999 999" });
  const supAfter = (await api("GET", `/api/suppliers/${supId}`)).body.supplier;
  assert.equal(supAfter.credit_days, 21, "days to pay were not reset by the phone update");
  assert.equal(supAfter.phone, "0712 999 999");

  // reorder list: only items WITH a reorder level, grouped by the last supplier
  assert.equal((await api("GET", "/api/reorder")).body.some((r: any) => r.id === cement.body.id), false, "no reorder level, not listed");
  await api("PATCH", `/api/products/${pipe.body.id}`, { reorderLevelMilli: 500000 });
  const ro = (await api("GET", "/api/reorder")).body.find((r: any) => r.id === pipe.body.id);
  assert.ok(ro, "pipe is below its reorder level");
  assert.equal(ro.last_supplier, "AquaBase Ltd", "the last supplier is remembered");
  assert.equal(ro.suggested_milli, 1000000 - ro.stock_milli, "suggest enough to reach twice the reorder level");
  await api("PATCH", `/api/products/${pipe.body.id}`, { reorderLevelMilli: 0 });


  // =================== inventory manager: filters, sorting, product detail, ledger, categories ===================
  {
    const cat = await api("POST", "/api/categories", { name: "InvTest" });
    const catId = cat.body.id as number;
    const mk = async (sku: string, name: string, cost: number, retail: number, reorder: number) => {
      const r = await api("POST", "/api/products", { sku, name, unit: "pc", vatCode: "E", costCents: cost, priceRetailCents: retail, reorderLevelMilli: reorder, categoryId: catId });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.id as number;
    };
    const A = await mk("INV-A", "Inv Alpha", 10000, 15000, 5000);
    const B = await mk("INV-B", "Inv Bravo", 20000, 30000, 10000);
    const C = await mk("INV-C", "Inv Charlie", 5000, 8000, 0);
    const D = await mk("INV-D", "Inv Delta", 40000, 50000, 0);

    // Alpha arrives through a delivery (20 pcs, invoice INV-T1) from its own supplier; Bravo 10, Delta 3 in the shop and 2 in the store; Charlie none
    const isup = await api("POST", "/api/suppliers", { name: "Inv Test Supply", creditDays: 30 });
    const del = await api("POST", "/api/purchases", { supplierId: isup.body.id, locationId: 1, invoiceNo: "INV-T1", lines: [{ productId: A, qtyMilli: 20000, unitCostCents: 10000 }] });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    await api("POST", "/api/stock/receive", { productId: B, locationId: 1, qtyMilli: 10000 });
    await api("POST", "/api/stock/receive", { productId: D, locationId: 1, qtyMilli: 3000 });
    await api("POST", "/api/stock/receive", { productId: D, locationId: 2, qtyMilli: 2000 });
    // the cashier sells 2 Alpha for 300.00
    const sold = await api("POST", "/api/sales", { items: [{ productId: A, qtyMilli: 2000 }], payments: [{ method: "cash", amountCents: 30000 }] }, cashierTok);
    assert.equal(sold.status, 200, JSON.stringify(sold.body));

    const page = async (qs: string, tok = token) => (await api("GET", `/api/products/page?categoryId=${catId}&limit=50&${qs}`, undefined, tok)).body as { total: number; items: any[]; summary: any };
    const ids = (r: { items: any[] }) => r.items.map((p) => p.id);

    // ---- status filters
    assert.equal((await page("")).total, 4, "all four are in the category");
    assert.deepEqual(ids(await page("status=in")).sort(), [A, B, D].sort(), "in stock = Alpha, Bravo, Delta");
    assert.deepEqual(ids(await page("status=out")), [C], "out of stock = Charlie");
    assert.deepEqual(ids(await page("status=low")), [B], "low = Bravo, which is at its reorder level");
    assert.deepEqual(ids(await page("status=dead")).sort(), [B, D].sort(), "dead = in stock with no sale in 90 days (Alpha sold today)");
    assert.equal((await api("GET", "/api/products/page?status=bogus")).status, 400, "an unknown status is refused");
    assert.equal((await api("GET", "/api/products/page?sort=bogus")).status, 400, "an unknown sort is refused");
    assert.equal((await page("status=low")).summary.items, 1, "the summary follows the filter");

    // ---- every row carries on-hand and its worth
    const all = await page("");
    const rowA = all.items.find((p) => p.id === A);
    assert.equal(rowA.on_hand_milli, 18000);
    assert.equal(rowA.value_selling_cents, 270000, "18 x 150.00");
    assert.equal(rowA.value_cost_cents, 180000, "18 x 100.00");
    assert.equal(all.items.find((p) => p.id === D).on_hand_milli, 5000, "shop plus store");

    // ---- sorting, both ways
    assert.deepEqual(ids(await page("sort=value&dir=desc")), [B, A, D, C], "value, largest first");
    assert.deepEqual(ids(await page("sort=value&dir=asc")), [C, D, A, B], "value, smallest first");
    assert.deepEqual(ids(await page("sort=stock&dir=desc")), [A, B, D, C], "stock, most first");
    assert.deepEqual(ids(await page("sort=stock&dir=asc")), [C, D, B, A], "stock, least first");
    assert.deepEqual(ids(await page("sort=price&dir=asc")), [C, A, B, D], "price, lowest first");
    assert.deepEqual(ids(await page("sort=price&dir=desc")), [D, B, A, C], "price, highest first");
    assert.deepEqual(ids(await page("sort=cost&dir=asc")), [C, A, B, D], "cost, lowest first");
    assert.deepEqual(ids(await page("sort=name&dir=desc")), [D, C, B, A], "name, Z to A");
    assert.deepEqual(ids(await page("sort=name")), [A, B, C, D], "name, A to Z by default");
    // a user who cannot see costs gets no cost figures and no cost ordering
    const blindList = await page("sort=cost&dir=desc", cashierTok);
    assert.deepEqual(ids(blindList), [D, C, B, A], "cost order is not revealed: falls back to name");
    assert.equal(blindList.items[0].value_cost_cents, null, "no cost value without products.view_cost");
    assert.equal(blindList.items[0].cost_cents, 0);

    // ---- one product in full
    const dA = (await api("GET", `/api/products/${A}`)).body;
    assert.equal(dA.product.name, "Inv Alpha");
    assert.equal(dA.stock.reduce((a: number, x: any) => a + x.qty_milli, 0), dA.product.on_hand_milli, "stock by place adds up to on-hand");
    assert.deepEqual(dA.stock.map((x: any) => [x.location, x.qty_milli]), [["Shop", 18000], ["Store", 0]], "every location is listed");
    assert.equal(dA.margin_percent, 33.3, "(150 - 100) / 150");
    assert.equal(dA.status, "ok");
    assert.equal(dA.sales.sold_30_milli, 2000);
    assert.equal(dA.sales.sold_90_milli, 2000);
    assert.equal(dA.sales.sold_all_milli, 2000);
    assert.equal(dA.sales.revenue_90_cents, 30000);
    assert.equal(dA.sales.orders_90, 1);
    assert.equal(dA.sales.avg_price_cents_90, 15000);
    assert.ok(dA.sales.last_sold_at, "last sold is known");
    assert.equal(dA.purchases.length, 1);
    assert.equal(dA.purchases[0].invoice_no, "INV-T1");
    assert.equal(dA.purchases[0].supplier, "Inv Test Supply");
    assert.equal(dA.purchases[0].qty_milli, 20000);
    assert.equal(dA.purchases[0].unit_cost_cents, 10000);
    assert.deepEqual(dA.lpos_open, [], "nothing on order");
    assert.deepEqual(dA.movements.map((m: any) => [m.type, m.qty_milli]), [["sale", -2000], ["purchase", 20000]], "newest first");
    assert.equal(dA.movements[0].ref_type, "sale");
    assert.equal((await api("GET", `/api/products/${B}`)).body.status, "low");
    assert.equal((await api("GET", `/api/products/${C}`)).body.status, "out");
    assert.equal((await api("GET", `/api/products/${D}`)).body.status, "dead");
    assert.equal((await api("GET", "/api/products/999999")).status, 404, "unknown product");
    assert.equal((await api("GET", `/api/products/${A}`, undefined, "")).status, 401, "needs a sign-in");
    // users without cost access: no margin, no cost values anywhere
    const blindA = (await api("GET", `/api/products/${A}`, undefined, cashierTok)).body;
    assert.equal(blindA.margin_percent, null, "no margin without products.view_cost");
    assert.equal(blindA.product.value_cost_cents, null);
    assert.equal(blindA.purchases[0].unit_cost_cents, null);
    assert.equal(blindA.movements[1].unit_cost_cents, null);

    // ---- the stock ledger
    const ledger = async (qs: string, tok = token) => (await api("GET", `/api/stock/ledger?${qs}`, undefined, tok));
    assert.equal((await ledger(`productId=${A}`, cashierTok)).status, 403, "the ledger needs stock.manage");
    const lA = (await ledger(`productId=${A}`)).body;
    assert.equal(lA.total, 2);
    assert.deepEqual(lA.items.map((m: any) => m.type), ["sale", "purchase"], "newest first");
    assert.equal(lA.items[0].product, "Inv Alpha");
    assert.equal(lA.items[0].sku, "INV-A");
    assert.equal(lA.items[0].location, "Shop");
    assert.equal(lA.items[1].unit_cost_cents, 10000);
    assert.equal((await ledger(`productId=${A}&type=sale`)).body.total, 1, "filter by type");
    assert.equal((await ledger(`productId=${D}&locationId=2`)).body.total, 1, "filter by place: Delta has one receipt in the store");
    assert.equal((await ledger(`productId=${A}&locationId=2`)).body.total, 0);
    const p2 = (await ledger(`productId=${A}&limit=1&offset=1`)).body;
    assert.equal(p2.items.length, 1);
    assert.equal(p2.total, 2, "the total ignores paging");
    assert.equal(p2.items[0].type, "purchase", "page two holds the older entry");
    const today = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    assert.equal((await ledger(`productId=${A}&from=${today}&to=${today}`)).body.total, 2, "today's entries");
    assert.equal((await ledger(`productId=${A}&from=2000-01-01&to=2000-01-02`)).body.total, 0, "nothing back in 2000");
    assert.equal((await ledger("from=2026-02-30")).status, 400, "an impossible date is refused");
    assert.ok((await ledger("limit=5000")).body.items.length <= 200, "a page never holds more than 200");
    // a stock clerk without cost access sees no costs in the ledger
    const stockRole = await api("POST", "/api/roles", { name: "Ledger clerk", description: "Counts stock", permissions: ["stock.manage"] });
    assert.equal(stockRole.status, 200, JSON.stringify(stockRole.body));
    assert.equal((await api("POST", "/api/users", { name: "Stan", pin: "3344", roleId: stockRole.body.id })).status, 200);
    const stanTok = (await api("POST", "/api/auth/login", { pin: "3344" }, "")).body.token as string;
    const blindLedger = (await ledger(`productId=${A}`, stanTok)).body;
    assert.equal(blindLedger.total, 2);
    assert.equal(blindLedger.items[1].unit_cost_cents, null, "no purchase cost without products.view_cost");

    // ---- categories: counts, rename, delete
    const cats = (await api("GET", "/api/categories")).body as { id: number; name: string; product_count: number }[];
    assert.equal(cats.find((c) => c.id === catId)!.product_count, 4, "each category knows how many products it holds");
    assert.equal((await api("PATCH", `/api/categories/${catId}`, { name: "InvTest Renamed" }, cashierTok)).status, 403, "cashier cannot rename");
    assert.equal((await api("PATCH", `/api/categories/${catId}`, { name: "   " })).status, 400, "a name is required");
    assert.equal((await api("PATCH", `/api/categories/${catId}`, { name: "Tools" })).status, 409, "that name is taken");
    assert.equal((await api("PATCH", "/api/categories/999999", { name: "Ghost" })).status, 404);
    assert.equal((await api("PATCH", `/api/categories/${catId}`, { name: "InvTest Renamed" })).status, 200);
    assert.equal((await api("PATCH", `/api/categories/${catId}`, { name: "InvTest Renamed" })).status, 200, "keeping its own name is fine");
    assert.equal((await api("GET", `/api/products/${A}`)).body.product.category, "InvTest Renamed", "products show the new name");
    const del409 = await api("DELETE", `/api/categories/${catId}`);
    assert.equal(del409.status, 409);
    assert.match(del409.body.error, /4 products use this category\. Move them first\./);
    assert.equal((await api("DELETE", `/api/categories/${catId}`, undefined, cashierTok)).status, 403);
    const empty = await api("POST", "/api/categories", { name: "Empty Cat" });
    assert.equal((await api("DELETE", `/api/categories/${empty.body.id}`)).status, 200, "an empty category can go");
    assert.equal((await api("DELETE", `/api/categories/${empty.body.id}`)).status, 404, "and it is gone");
    assert.ok(!((await api("GET", "/api/categories")).body as any[]).some((c) => c.name === "Empty Cat"));
  }

  // =================== items sold report ===================
  {
    assert.equal((await api("GET", "/api/reports/items-sold", undefined, cashierTok)).status, 403, "cashier cannot open reports");
    const r = await api("GET", "/api/reports/items-sold");
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(r.body.items.length >= 1, "something sold");
    assert.ok(r.body.items.some((x: any) => x.id === nail.body.id), "the nails sold earlier are listed");
    const rev = r.body.items.map((x: any) => x.revenue_cents);
    assert.deepEqual(rev, [...rev].sort((a: number, b: number) => b - a), "ranked by sales value");
    assert.equal(r.body.totals.revenue_cents, rev.reduce((a: number, b: number) => a + b, 0), "totals add up");
    assert.equal(r.body.totals.items, r.body.items.length);
    assert.equal((await api("GET", "/api/reports/items-sold?from=2026-02-30&to=2026-03-01")).status, 400, "an impossible date is refused");
    assert.equal((await api("GET", "/api/reports/items-sold?from=2026-03-05&to=2026-03-01")).status, 400, "start after end is refused");
    const none = await api("GET", "/api/reports/items-sold?from=2000-01-01&to=2000-01-31");
    assert.equal(none.status, 200);
    assert.equal(none.body.items.length, 0, "nothing sold back in 2000");
  }

  // =================== fast and slow movers ===================
  {
    assert.equal((await api("GET", "/api/reports/movers", undefined, cashierTok)).status, 403, "cashier cannot open reports");
    const m = await api("GET", "/api/reports/movers?days=30");
    assert.equal(m.status, 200, JSON.stringify(m.body).slice(0, 200));
    assert.equal(m.body.days, 30);
    assert.ok(m.body.fast.length >= 1, "something has sold");
    assert.ok(m.body.fast.some((x: any) => x.id === nail.body.id), "the nails sold earlier are a fast mover");
    const rev = m.body.fast.map((x: any) => x.revenue_cents);
    assert.deepEqual(rev, [...rev].sort((a: number, b: number) => b - a), "fast movers are ranked by sales value");
    assert.ok(m.body.fast.every((x: any) => x.sold_milli > 0), "only items that sold are fast movers");
    assert.ok(m.body.slow.every((x: any) => x.on_hand_milli > 0), "slow movers are items that are in stock");
    const srev = m.body.slow.map((x: any) => x.revenue_cents);
    assert.deepEqual(srev, [...srev].sort((a: number, b: number) => a - b), "slow movers are ranked from least sold");
    assert.ok(m.body.totals.items_in_stock >= m.body.totals.in_stock_unsold, "totals are consistent");
    assert.equal((await api("GET", "/api/reports/movers?days=99999")).body.days, 730, "the period is capped");
  }

  // =================== local purchase orders (LPO) ===================
  {
    const lpoSup = (await api("POST", "/api/suppliers", { name: "LPO Supplies", creditDays: 14 })).body.id as number;
    const prod = async (sku: string) => (await api("GET", `/api/products/page?q=${sku}`)).body.items[0];
    const owed = async () => (await api("GET", `/api/suppliers/${lpoSup}`)).body.owed_cents as number;
    const lines = [
      { productId: pipe.body.id, qtyMilli: 10000, unitCostCents: 21000 },
      { productId: nail.body.id, qtyMilli: 5000, unitCostCents: 12000 },
    ];

    assert.equal((await api("GET", "/api/lpos", undefined, cashierTok)).status, 403, "cashier cannot see orders");
    assert.equal((await api("POST", "/api/lpos", { supplierId: lpoSup, lines }, cashierTok)).status, 403, "cashier cannot make an order");
    assert.equal((await api("POST", "/api/lpos", { supplierId: lpoSup, lines: [] })).status, 400, "an order needs items");
    assert.equal((await api("POST", "/api/lpos", { supplierId: lpoSup, lines: [lines[0], lines[0]] })).status, 400, "the same item twice is refused");
    assert.equal((await api("POST", "/api/lpos", { supplierId: 999999, lines })).status, 400, "unknown supplier is refused");
    assert.equal((await api("POST", "/api/lpos", { supplierId: lpoSup, lines, expectedOn: "next week" })).status, 400, "bad expected date is refused");

    // a draft: made, read back, edited
    const a = await api("POST", "/api/lpos", { supplierId: lpoSup, lines, note: "Deliver to the store" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    let det = await api("GET", `/api/lpos/${a.body.id}`);
    assert.equal(det.body.number, "LPO-0001", "numbers count up from LPO-0001");
    assert.equal(det.body.status, "draft");
    assert.equal(det.body.total_cents, 270000, "10 x 210.00 + 5 x 120.00");
    assert.equal(det.body.supplier, "LPO Supplies");
    const edited = await api("PUT", `/api/lpos/${a.body.id}`, {
      lines: [lines[0], { productId: nail.body.id, qtyMilli: 8000, unitCostCents: 12000 }], expectedOn: "2030-01-31",
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    det = await api("GET", `/api/lpos/${a.body.id}`);
    assert.equal(det.body.total_cents, 306000, "10 x 210.00 + 8 x 120.00 after the edit");
    assert.equal(det.body.expected_on, "2030-01-31");
    assert.equal((await api("PUT", `/api/lpos/${a.body.id}`, { lines: [] })).status, 400, "an edit cannot empty the order");

    // a draft cannot receive goods; once sent it is locked for editing
    const rcv = (id: number, body: object) => api("POST", `/api/lpos/${id}/receive`, body);
    assert.equal((await rcv(a.body.id, { lines: [{ productId: pipe.body.id, qtyMilli: 1000 }] })).status, 409, "a draft cannot receive goods");
    assert.equal((await api("PATCH", `/api/lpos/${a.body.id}`, { status: "sent" })).status, 200);
    assert.equal((await api("PATCH", `/api/lpos/${a.body.id}`, { status: "sent" })).status, 409, "already sent");
    assert.equal((await api("PUT", `/api/lpos/${a.body.id}`, { lines })).status, 409, "a sent order cannot be edited");
    assert.equal((await api("PATCH", `/api/lpos/${a.body.id}`, { status: "received" })).status, 409, "only a partly received order can be closed");
    assert.equal((await rcv(a.body.id, { lines: [{ productId: cement.body.id, qtyMilli: 1000 }] })).status, 400, "an item that is not on the order is refused");

    // part delivery: 4 of the 10 m of pipe, 200.00 paid on the spot
    const pipeBefore = (await prod("PVC-1")).stock_shop as number;
    const part = await rcv(a.body.id, { lines: [{ productId: pipe.body.id, qtyMilli: 4000 }], invoiceNo: "SUP-9", paidCents: 20000, payMethod: "cash" });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    assert.equal(part.body.status, "partial");
    assert.equal((await prod("PVC-1")).stock_shop, pipeBefore + 4000, "stock rose by exactly what arrived");
    assert.equal((await prod("PVC-1")).cost_cents, 21000, "the order price became the cost price");
    assert.equal(await owed(), 84000 - 20000, "4 x 210.00 delivered minus 200.00 paid");
    det = await api("GET", `/api/lpos/${a.body.id}`);
    assert.equal(det.body.status, "partial");
    assert.equal(det.body.items.find((i: any) => i.product_id === pipe.body.id).received_milli, 4000);
    assert.equal(det.body.purchase_ids.length, 1, "the delivery is linked to the order");
    assert.equal((await rcv(a.body.id, { lines: [{ productId: pipe.body.id, qtyMilli: 7000 }] })).status, 400, "more than is still due is refused");
    assert.equal((await api("PATCH", `/api/lpos/${a.body.id}`, { status: "cancelled" })).status, 409, "a partly delivered order cannot be cancelled");

    // the rest arrives: the order completes
    const nailBefore = (await prod("NAIL-3")).stock_shop as number;
    const rest = await rcv(a.body.id, { lines: [{ productId: pipe.body.id, qtyMilli: 6000 }, { productId: nail.body.id, qtyMilli: 8000 }] });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.equal(rest.body.status, "received");
    assert.equal((await prod("NAIL-3")).stock_shop, nailBefore + 8000);
    assert.equal(await owed(), 64000 + 126000 + 96000, "everything delivered is now owed, less the 200.00 paid");
    assert.equal((await api("PATCH", `/api/lpos/${a.body.id}`, { status: "cancelled" })).status, 409, "a received order cannot be cancelled");
    assert.equal((await rcv(a.body.id, { lines: [{ productId: pipe.body.id, qtyMilli: 1000 }] })).status, 409, "a received order takes no more goods");

    // a second order, sent and then cancelled before anything arrived
    const b = await api("POST", "/api/lpos", { supplierId: lpoSup, lines: [lines[0]], send: true });
    assert.equal(b.status, 200, JSON.stringify(b.body));
    det = await api("GET", `/api/lpos/${b.body.id}`);
    assert.equal(det.body.number, "LPO-0002");
    assert.equal(det.body.status, "sent");
    assert.equal((await api("PATCH", `/api/lpos/${b.body.id}`, { status: "cancelled" })).status, 200);
    assert.equal((await api("GET", `/api/lpos/${b.body.id}`)).body.status, "cancelled");
    assert.equal((await rcv(b.body.id, { lines: [{ productId: pipe.body.id, qtyMilli: 1000 }] })).status, 409, "a cancelled order takes no goods");

    // a third stays a draft, a fourth is closed short after a part delivery
    const c = await api("POST", "/api/lpos", { supplierId: lpoSup, lines: [lines[1]] });
    assert.equal((await api("GET", `/api/lpos/${c.body.id}`)).body.number, "LPO-0003");
    const d = await api("POST", "/api/lpos", { supplierId: lpoSup, lines: [{ productId: nail.body.id, qtyMilli: 3000, unitCostCents: 12000 }], send: true });
    assert.equal((await rcv(d.body.id, { lines: [{ productId: nail.body.id, qtyMilli: 1000 }] })).body.status, "partial");
    assert.equal((await api("PATCH", `/api/lpos/${d.body.id}`, { status: "received" })).status, 200, "a short delivery can be closed");
    assert.equal((await api("GET", `/api/lpos/${d.body.id}`)).body.status, "received");

    // the lists
    const open = await api("GET", "/api/lpos?status=open");
    assert.deepEqual(open.body.map((o: any) => o.number), ["LPO-0003"], "only the untouched draft is still open");
    assert.ok(open.body.every((o: any) => ["draft", "sent", "partial"].includes(o.status)));
    assert.deepEqual((await api("GET", "/api/lpos?status=cancelled")).body.map((o: any) => o.number), ["LPO-0002"]);
    assert.deepEqual((await api("GET", "/api/lpos?status=received")).body.map((o: any) => o.number), ["LPO-0004", "LPO-0001"], "newest first");
    assert.equal((await api("GET", "/api/lpos")).body.length, 4, "all four orders");
    assert.equal((await api("GET", "/api/lpos/999999")).status, 404, "unknown order");
  }

  // =================== selling in several units ===================
  // copper wire is priced per metre (90.00, cost 60.00); it is also sold by the roll (50 m, special price 4,200.00) and half roll (25 m)
  const wire = await api("POST", "/api/products", { sku: "CU-WIRE", name: "Copper wire 2.5mm", unit: "m", allowFraction: true, vatCode: "A", costCents: 6000, priceRetailCents: 9000, itemClassCode: "5010001500", qtyUnitCode: "MTR", packUnitCode: "RL" });
  assert.equal(wire.status, 200, JSON.stringify(wire.body));
  await api("POST", "/api/stock/receive", { productId: wire.body.id, locationId: 1, qtyMilli: 200000 });
  const units = await api("PUT", `/api/products/${wire.body.id}/units`, { units: [
    { name: "Roll", factor: 50, priceCents: 420000, barcode: "ROLLBC1" },
    { name: "Half roll", factor: 25 },
  ] });
  assert.equal(units.status, 200, JSON.stringify(units.body));
  const wireRow = (await api("GET", "/api/products?q=CU-WIRE")).body[0];
  assert.equal(wireRow.units.length, 2, "the product lists its units");
  assert.equal(wireRow.units[0].name, "Half roll", "smallest pack first");
  assert.equal(wireRow.item_class_code, "5010001500", "tax details are stored");
  assert.equal(wireRow.qty_unit_code, "MTR");
  const rollId = wireRow.units.find((u: any) => u.name === "Roll").id as number;
  const halfId = wireRow.units.find((u: any) => u.name === "Half roll").id as number;

  // unit barcodes are found by search and cannot be reused
  assert.equal((await api("GET", "/api/products?q=ROLLBC1")).body[0]?.sku, "CU-WIRE", "a pack barcode finds its product");
  assert.equal((await api("PUT", `/api/products/${nail.body.id}/units`, { units: [{ name: "Box", factor: 10, barcode: "ROLLBC1" }] })).status, 409, "a barcode cannot belong to two units");
  assert.equal((await api("PUT", `/api/products/${nail.body.id}/units`, { units: [{ name: "Box", factor: 10 }, { name: "box", factor: 5 }] })).status, 400, "unit names must differ");
  assert.equal((await api("PUT", `/api/products/${nail.body.id}/units`, { units: [{ name: "Box", factor: 0 }] })).status, 400, "a unit must contain something");
  assert.equal((await api("PUT", "/api/products/" + wire.body.id + "/units", { units: [] }, cashierTok)).status, 403, "cashier cannot change units");
  await api("PUT", `/api/products/${nail.body.id}/units`, { units: [] });

  const wireStock = async () => (await api("GET", "/api/products?q=CU-WIRE")).body[0].stock_shop as number;
  const sellWire = (items: any[], extra: any = {}, cash = 5000000) => api("POST", "/api/sales", { items, payments: [{ method: "cash", amountCents: cash }], ...extra }, cashierTok);

  // 2 rolls at the roll price = 8,400.00, and 100 m leaves stock
  let ws = await sellWire([{ productId: wire.body.id, qtyMilli: 2000, unitId: rollId }]);
  assert.equal(ws.status, 200, JSON.stringify(ws.body));
  assert.equal(ws.body.total_cents, 840000, "two rolls at the roll price");
  assert.equal(await wireStock(), 100000, "100 m left stock");
  assert.equal(ws.body.items[0].unit, "Roll");
  assert.equal(ws.body.items[0].unit_price_cents, 420000);
  assert.equal(ws.body.items[0].base_qty_milli, 100000);
  assert.equal(ws.body.items[0].cost_cents, 300000, "cost is per roll (50 x 60.00) so margins stay right");
  const rollSaleId = ws.body.id as number;
  const rollItemId = ws.body.items[0].id as number;

  // a pack with no price of its own is the metre price times the pack size: half roll = 25 x 90.00
  ws = await sellWire([{ productId: wire.body.id, qtyMilli: 1000, unitId: halfId }]);
  assert.equal(ws.body.total_cents, 225000, "half roll priced from the metre price");
  assert.equal(await wireStock(), 75000);

  // loose metres still work, fractions included
  ws = await sellWire([{ productId: wire.body.id, qtyMilli: 2500 }]);
  assert.equal(ws.body.total_cents, 22500, "2.5 m at 90.00");
  assert.equal(await wireStock(), 72500);

  // packs are sold whole
  assert.equal((await sellWire([{ productId: wire.body.id, qtyMilli: 1500, unitId: rollId }])).status, 400, "no 1.5 rolls");
  // the unit has to belong to the product
  assert.equal((await sellWire([{ productId: pipe.body.id, qtyMilli: 1000, unitId: rollId }])).status, 400, "unit of another product is refused");

  // stock is checked across lines (72.5 m left): a roll plus 30 m loose is 80 m, so it must be refused and change nothing
  assert.equal((await sellWire([{ productId: wire.body.id, qtyMilli: 1000, unitId: rollId }, { productId: wire.body.id, qtyMilli: 30000 }])).status, 409, "a roll plus loose metres is checked together");
  assert.equal((await sellWire([{ productId: wire.body.id, qtyMilli: 1000, unitId: rollId }, { productId: wire.body.id, qtyMilli: 25000 }, { productId: wire.body.id, qtyMilli: 1000, unitId: halfId }])).status, 409, "three mixed lines are checked together");
  assert.equal(await wireStock(), 72500, "refused sales take nothing from stock");

  // a contractor (no special wire price) gets the metre price scaled to the roll, not the retail roll override
  ws = await sellWire([{ productId: wire.body.id, qtyMilli: 1000, unitId: rollId }], { customerId: cust.body.id }, 500000);
  assert.equal(ws.status, 200, JSON.stringify(ws.body));
  assert.equal(ws.body.total_cents, 450000, "contractor: 50 m x 90.00, the retail roll price is for retail customers");
  assert.equal(await wireStock(), 22500);

  // refund one of the two rolls: money back at the roll price, 50 m back on the shelf
  const stockBeforeRefund = await wireStock();
  const rf = await api("POST", `/api/sales/${rollSaleId}/refund`, { items: [{ saleItemId: rollItemId, qtyMilli: 1000 }], method: "cash", reason: "wrong gauge", approvalPin: "1234" }, cashierTok);
  assert.equal(rf.status, 200, JSON.stringify(rf.body));
  assert.equal(rf.body.total_cents, -420000, "refund at the roll price");
  assert.equal(await wireStock(), stockBeforeRefund + 50000, "a returned roll puts 50 m back");
  // and not more than was sold
  assert.equal((await api("POST", `/api/sales/${rollSaleId}/refund`, { items: [{ saleItemId: rollItemId, qtyMilli: 2000 }], method: "cash", reason: "x", approvalPin: "1234" }, cashierTok)).status, 400, "cannot refund more rolls than were sold");
  assert.equal((await api("POST", `/api/sales/${rollSaleId}/refund`, { items: [{ saleItemId: rollItemId, qtyMilli: 1000 }], method: "cash", reason: "second roll", approvalPin: "1234" }, cashierTok)).status, 200, "the second roll can still come back");


  // =================== loans: approval, accountability, and who may see the debts ===================
  const anon = { items: [{ productId: nail.body.id, qtyMilli: 1000 }], payments: [{ method: "credit", amountCents: 15000 }] };
  assert.equal((await api("POST", "/api/sales", anon, cashierTok)).status, 400, "credit needs a registered customer");
  const noPin = await api("POST", "/api/sales", { ...anon, customerId: lpId }, cashierTok);
  assert.equal(noPin.status, 403, "a cashier cannot give credit alone");
  assert.match(noPin.body.error, /approval/i);
  assert.equal((await api("POST", "/api/sales", { ...anon, customerId: lpId, approvalPin: "5678" }, cashierTok)).status, 403, "a cashier's own PIN is not an approval");
  const loan = await api("POST", "/api/sales", { ...anon, customerId: lpId, approvalPin: "1234" }, cashierTok);
  assert.equal(loan.status, 200, "an approver PIN is accepted: " + JSON.stringify(loan.body));
  assert.equal(loan.body.approved_by, 1, "the person who approved it is recorded");
  const trail = (await api("GET", `/api/customers/${lpId}/account`)).body.statement.find((l: any) => l.receipt_no === loan.body.receipt_no);
  assert.equal(trail.cashier, "Wanjiru", "the statement shows who served");
  assert.equal(trail.approver, "Admin", "and who approved the loan");

  // the till sees credit available, never the debts; only managers and admins see who owes what
  const forCashier = (await api("GET", "/api/customers", undefined, cashierTok)).body.find((c: any) => c.id === lpId);
  assert.equal(forCashier.balance_cents, 0, "a cashier does not see balances");
  assert.ok(forCashier.credit_available_cents >= 0 && typeof forCashier.credit_available_cents === "number", "but sees credit available");
  assert.ok((await api("GET", "/api/customers")).body.find((c: any) => c.id === lpId).balance_cents > 0, "the admin sees the balance");
  assert.equal((await api("GET", "/api/receivables", undefined, cashierTok)).status, 403, "debtors list is not for cashiers");
  assert.equal((await api("GET", `/api/customers/${lpId}/account`, undefined, cashierTok)).status, 403, "an account statement is not for cashiers");
  assert.equal((await api("GET", `/api/customers/${lpId}`, undefined, cashierTok)).status, 403);
  assert.equal((await api("POST", "/api/customers", { name: "Walk-in Wanjala" }, cashierTok)).status, 403, "a cashier does not register customers");
  assert.equal((await api("POST", `/api/customers/${lpId}/payment`, { amountCents: 100, method: "cash" }, cashierTok)).status, 403, "a cashier does not record repayments");

  // stopping credit for a defaulter: refused even with a manager PIN, cash still welcome
  assert.equal((await api("PATCH", `/api/customers/${lpId}`, { creditStopped: true })).status, 200);
  const stopped = await api("POST", "/api/sales", { ...anon, customerId: lpId, approvalPin: "1234" }, cashierTok);
  assert.equal(stopped.status, 409, "credit stopped");
  assert.match(stopped.body.error, /stopped/i);
  assert.equal((await api("POST", "/api/sales", { items: anon.items, customerId: lpId, payments: [{ method: "cash", amountCents: 15000 }] }, cashierTok)).status, 200, "a cash sale to the same person is fine");
  assert.equal((await api("PATCH", `/api/customers/${lpId}`, { creditStopped: false })).status, 200);
  assert.equal((await api("POST", "/api/sales", { ...anon, customerId: lpId, approvalPin: "1234" }, cashierTok)).status, 200, "credit is back once lifted");

  // =================== logo ===================
  assert.equal((await fetch(base + "/api/logo")).status, 404, "no logo yet");
  assert.equal((await (await fetch(base + "/api/auth/info")).json() as any).logo_version, "", "the sign-in screen knows there is no logo");
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const asData = (mime: string, b64: string) => ({ dataUrl: `data:${mime};base64,${b64}` });
  assert.equal((await api("PUT", "/api/logo", asData("image/png", PNG), cashierTok)).status, 403, "cashier cannot change the logo");
  assert.equal((await api("PUT", "/api/logo", { dataUrl: "hello" })).status, 400, "not a data URL");
  assert.equal((await api("PUT", "/api/logo", asData("image/svg+xml", PNG))).status, 400, "SVG is refused (it can carry scripts)");
  assert.equal((await api("PUT", "/api/logo", asData("image/png", Buffer.from("<script>alert(1)</script>").toString("base64")))).status, 400, "text labelled as an image is refused");
  assert.equal((await api("PUT", "/api/logo", asData("image/png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(450 * 1024)]).toString("base64")))).status, 400, "too large is refused");
  const up = await api("PUT", "/api/logo", asData("image/png", PNG));
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const got = await fetch(base + "/api/logo");
  assert.equal(got.status, 200, "the logo is public so the sign-in screen can show it");
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), Buffer.from(PNG, "base64"), "the same bytes come back");
  assert.equal((await fetch(base + "/api/logo", { headers: { "if-none-match": got.headers.get("etag")! } })).status, 304, "unchanged logos are not re-sent");
  assert.equal(((await (await fetch(base + "/api/auth/info")).json()) as any).logo_version, up.body.version, "sign-in screen sees the new version");
  assert.equal((await api("GET", "/api/settings")).body.logo_version, up.body.version);
  assert.equal((await api("PUT", "/api/settings", { logo_version: "hacked" })).status, 200);
  assert.equal((await api("GET", "/api/settings")).body.logo_version, up.body.version, "the version cannot be set through the settings form");
  assert.equal((await api("DELETE", "/api/logo", undefined, cashierTok)).status, 403);
  assert.equal((await api("DELETE", "/api/logo")).status, 200);
  assert.equal((await fetch(base + "/api/logo")).status, 404, "gone after removal");
  assert.equal((await api("GET", "/api/settings")).body.logo_version, "");

  // =================== screens hosted on another address (e.g. Vercel) ===================
  {
    const site = "https://mazaopos.vercel.app";
    const pre = await fetch(base + "/api/sales", { method: "OPTIONS", headers: { origin: site, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    assert.ok(pre.status === 204 || pre.status === 200, "the browser pre-flight check is answered: " + pre.status);
    assert.ok(["*", site].includes(pre.headers.get("access-control-allow-origin") ?? ""), "the hosted screens are allowed to call the API");
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /authorization/i, "the sign-in header is allowed");
  }

  console.log("ALL CHECKS PASSED");
} catch (e) {
  console.error("FAILED:", e);
  process.exitCode = 1;
}
