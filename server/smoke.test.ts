// End-to-end API check. Run with: npm run test  (starts its own server on a temp DB)
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import assert from "node:assert/strict";

const PORT = 4100;
const DB = "data/test.db";
for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
rmSync("data/test-backups", { recursive: true, force: true });

const srv = spawn("npx", ["tsx", "server/index.ts"], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, BACKUP_DIR: "data/test-backups" },
  shell: true,
  stdio: "inherit",
});

const base = `http://localhost:${PORT}`;
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
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

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
  r = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 10_000 }], customerId: cust.body.id, payments: [{ method: "credit", amountCents: 130000 }] }, cashierTok);
  assert.equal(r.status, 200, JSON.stringify(r.body)); // contractor price 130/kg*10 = 1300.00
  assert.equal(r.body.total_cents, 130000);
  let c = await api("GET", `/api/customers/${cust.body.id}`);
  assert.equal(c.body.balance_cents, 130000);
  r = await api("POST", "/api/sales", { items: [{ productId: cement.body.id, qtyMilli: 10_000 }], customerId: cust.body.id, payments: [{ method: "credit", amountCents: 800000 }] }, cashierTok);
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
  assert.ok((await api("GET", "/api/products?q=nails")).body[0].cost_cents > 0, "owner sees cost");

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

  // Owner role is locked; the owner cannot lock themselves out
  assert.equal((await api("PUT", `/api/roles/${roleId("Owner")}`, { name: "Owner", description: "", permissions: [] })).status, 400, "owner role locked");
  assert.equal((await api("PATCH", "/api/users/1", { roleId: roleId("Cashier") })).status, 400, "cannot demote the last role manager");
  assert.equal((await api("PATCH", "/api/users/1", { active: false })).status, 400, "cannot disable yourself");
  // a manager cannot reset the Owner's PIN (privilege escalation)
  await api("PUT", `/api/roles/${roleId("Manager")}`, { name: "Manager", description: "", permissions: ["users.manage", "sales.create"] }); // owner grants users.manage
  assert.equal((await api("PATCH", "/api/users/1", { pin: "9999" }, mgrTok)).status, 403, "cannot reset a more powerful user's PIN");
  assert.equal((await api("POST", "/api/users", { name: "Boss2", pin: "1357", roleId: roleId("Owner") }, mgrTok)).status, 403, "cannot assign a role above your own");

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

  // =================== backups ===================
  assert.equal((await api("POST", "/api/backups", {}, cashierTok)).status, 403, "cashier cannot back up");
  const bk = await api("POST", "/api/backups", {});
  assert.equal(bk.status, 200, JSON.stringify(bk.body));
  const list = await api("GET", "/api/backups");
  assert.ok(list.body.backups.some((b: any) => b.name === bk.body.name), "backup listed");
  const dl = await fetch(base + "/api/backups/" + bk.body.name, { headers: { authorization: "Bearer " + token } });
  const head = Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString();
  assert.equal(head, "SQLite format 3", "download is a real SQLite file");
  assert.equal((await api("GET", "/api/backups/..%2F..%2Fpos.db")).status, 404, "no path traversal");
  assert.equal((await api("GET", "/api/backups/anything.db")).status, 404, "only backup names are served");


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
  assert.ok(dash.body.stockValue.cost_cents > 0, "owner sees stock value");
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
  assert.ok(!me.body.permissions.includes("sales.create"), "owner has no till permission");
  assert.ok(me.body.permissions.includes("roles.manage") && me.body.permissions.includes("sales.approve"), "owner keeps every back-office permission");
  const ownerSale = await api("POST", "/api/sales", { items: [{ productId: nail.body.id, qtyMilli: 1000 }], payments: [{ method: "cash", amountCents: 15000 }] });
  assert.equal(ownerSale.status, 403, "owner cannot sell");
  assert.equal((await api("POST", "/api/shifts/open", { floatCents: 0 })).status, 403, "owner cannot open a till shift");
  assert.equal((await api("POST", "/api/sales/1/refund", { items: [{ saleItemId: 1, qtyMilli: 1000 }], method: "cash", reason: "x" })).status, 403, "owner cannot process refunds at a till");
  // ...but the owner can still approve a cashier's discount with their PIN (done earlier with PIN 1234)
  const ownerRole = (await api("GET", "/api/roles")).body.find((x: any) => x.name === "Owner");
  assert.ok(!ownerRole.permissions.includes("sales.create"), "Owner role lists no till permission");
  assert.equal(ownerRole.permissions.length, 16, "Owner holds the 16 back-office permissions");
  // managers (small shops) and cashiers can still sell
  assert.equal((await api("POST", "/api/shifts/open", { floatCents: 0 }, mgrTok)).status, 200, "manager can open a till shift");
  // reports detail used by the Reports screen
  const detail = await api("GET", "/api/dashboard?days=7");
  assert.ok(Array.isArray(detail.body.byVat) && detail.body.byVat.length > 0, "VAT breakdown present");

  console.log("\nALL CHECKS PASSED");
} catch (e) {
  console.error("\nFAILED:", e);
  process.exitCode = 1;
} finally {
  // kill the whole tree (npx -> tsx -> node) and wait for it, so no server is left on the port
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(srv.pid), "/T", "/F"], { stdio: "ignore" });
  else srv.kill();
}
