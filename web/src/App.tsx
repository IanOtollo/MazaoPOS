import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BarChart3, ChevronDown, Database, HardDriveDownload, LayoutDashboard, Briefcase, ShieldCheck, Truck, UserCog, LogOut, Menu, Package, PanelLeftClose, PanelLeftOpen, ReceiptText, Settings as SettingsIcon, ShoppingCart, Users, Wallet, Hammer, type LucideIcon } from "lucide-react";
import { AuthCtx, fmtTime, get, getToken, post, setToken, userCan, type User } from "./lib/api";
import type { Permission } from "../../shared/permissions";
import { useConfirm } from "./lib/toast";
import { brandOr, setBrand, useBrand } from "./lib/brand";
import { startLive, stopLive, useLive, useLiveConnected } from "./lib/live";
import Login from "./pages/Login";
import Pos from "./pages/Pos";
import Products from "./pages/Products";
import Sales from "./pages/Sales";
import Customers from "./pages/Customers";
import Reports from "./pages/Reports";
import Dashboard from "./pages/Dashboard";
import Shift from "./pages/Shift";
import Settings from "./pages/Settings";
import Suppliers from "./pages/Suppliers";

const COLLAPSE_KEY = "pos_sidebar_collapsed";
const CLOSED_KEY = "pos_nav_closed";
// first time: every section starts closed and the one you are in opens, so the menu is short; after that it remembers your choice
const ALL_CLOSED: Record<string, boolean> = { Overview: true, Selling: true, Stock: true, People: true, Money: true, Admin: true };
const readClosed = (): Record<string, boolean> => {
  try { const v = localStorage.getItem(CLOSED_KEY); return { ...ALL_CLOSED, ...(v ? JSON.parse(v) : {}) }; } catch { return ALL_CLOSED; }
};
// which section each screen belongs to, so the right one opens when you go there
const SECTION_OF: [string, string][] = [
  ["/dashboard", "Overview"], ["/reports", "Overview"], ["/sales", "Selling"], ["/inventory", "Stock"], ["/suppliers", "Stock"],
  ["/customers", "People"], ["/shift", "Money"], ["/settings", "Admin"],
];
const readCollapsed = () => {
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    return v === null ? window.innerWidth < 1100 : v === "1";
  } catch { return false; }
};

interface Status { shiftOpenedAt: string | null; lowStock: number; owing: number }

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) return setReady(true);
    get<User>("/api/me").then(setUser).catch(() => setToken("")).finally(() => setReady(true));
  }, []);

  useLive(["staff", "roles"], () => { if (getToken()) get<User>("/api/me").then(setUser).catch(() => {}); });

  if (!ready) return null;
  if (!user) return <Login onLogin={(u, t) => { setToken(t); setUser(u); }} />;
  return <Shell user={user} onLogout={() => setUser(null)} />;
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const can = (p: Permission) => userCan(user, p);
  const canReports = can("reports.view");
  const canAdmin = can("settings.manage") || can("users.manage") || can("roles.manage");
  const canSell = can("sales.create");
  // where each kind of user lands: sellers on the till, admins on the dashboard, everyone else on products
  const home = canSell ? "/" : canReports ? "/dashboard" : "/inventory";
  const confirm = useConfirm();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>(readClosed);
  const biz = useBrand();
  const [status, setStatus] = useState<Status>({ shiftOpenedAt: null, lowStock: 0, owing: 0 });
  const showShift = canSell || !!status.shiftOpenedAt;

  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1"); } catch { /* storage unavailable */ }
    return !c;
  });

  useEffect(() => { get<Record<string, string>>("/api/settings").then((s) => setBrand(s.business_name)).catch(() => {}); }, []);
  useLive(["settings"], () => { get<Record<string, string>>("/api/settings").then((s) => setBrand(s.business_name)).catch(() => {}); });

  // refresh the live badges whenever the user moves between screens
  const refresh = useCallback(async () => {
    const [shift, low, customers] = await Promise.all([
      get("/api/shifts/current").catch(() => null),
      canReports ? get<unknown[]>("/api/reports/low-stock").catch(() => []) : Promise.resolve([]),
      get<{ balance_cents: number }[]>("/api/customers").catch(() => []),
    ]);
    setStatus({
      shiftOpenedAt: shift?.opened_at ?? null,
      lowStock: low.length,
      owing: customers.filter((c) => c.balance_cents > 0).length,
    });
  }, [canReports]);
  useEffect(() => { refresh(); }, [refresh, loc.pathname]);
  useLive(["sales", "stock", "customers", "shifts"], refresh);

  // keep one live connection open while signed in, and tell the user plainly if it drops
  const connected = useLiveConnected();
  const [lost, setLost] = useState(false);
  useEffect(() => { startLive(); return () => stopLive(); }, []);
  useEffect(() => {
    if (connected) { setLost(false); return; }
    const t = setTimeout(() => setLost(true), 4000);
    return () => clearTimeout(t);
  }, [connected]);
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  const flip = (label: string) => setClosed((c) => {
    const n = { ...c, [label]: !c[label] };
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify(n)); } catch { /* storage unavailable */ }
    return n;
  });
  // going to a screen opens its section
  useEffect(() => {
    const sec = loc.pathname === "/" ? "Selling" : SECTION_OF.find(([p]) => loc.pathname.startsWith(p))?.[1];
    if (sec) setClosed((c) => (c[sec] ? { ...c, [sec]: false } : c));
  }, [loc.pathname]);

  const logout = async () => {
    if (status.shiftOpenedAt && !(await confirm({
      title: "Sign out with your shift still open?",
      body: "Your shift stays open. Close it from the Shift screen when you cash up.",
      confirmLabel: "Sign out",
    }))) return;
    await post("/api/auth/logout").catch(() => {});
    setToken("");
    onLogout();
  };

  // the Settings tabs all live at /settings, told apart by ?tab=
  const onSettings = (tab: string) => {
    if (loc.pathname !== "/settings") return false;
    const cur = new URLSearchParams(loc.search).get("tab") ?? "";
    return cur === tab || (tab === "" && !["staff", "roles", "backup"].includes(cur));
  };
  const renderSidebar = (collapsed: boolean, inDrawer = false) => {
  const item = (to: string, label: string, Icon: LucideIcon, badge?: ReactNode, end = false, active?: boolean) => (
    <NavLink key={to} to={to} end={end} title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-3 rounded-lg px-3 py-2 font-semibold text-sm transition-colors ${collapsed ? "justify-center" : ""} ${(active ?? isActive) ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}>
      {({ isActive }) => (
        <>
          {(active ?? isActive) && <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-slate-900" />}
          <Icon className="size-5 shrink-0" />
          {!collapsed && <span className="flex-1">{label}</span>}
          {badge && (collapsed
            ? <span className="absolute top-1 right-1.5 size-2.5 rounded-full bg-amber-400 ring-2 ring-white" />
            : badge)}
        </>
      )}
    </NavLink>
  );

  const pill = (n: number, tone: "amber" | "rose") =>
    n > 0 ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${tone === "amber" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-700"}`}>{n}</span> : undefined;

  const group = (label: string, children: ReactNode) => {
    const shut = !collapsed && closed[label];
    return (
      <div className="mt-2 first:mt-0 pt-2 first:pt-0 border-t border-slate-100 first:border-0">
        {!collapsed ? (
          <button onClick={() => flip(label)} aria-expanded={!shut}
            className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-50 hover:text-slate-900">
            {label}
            <ChevronDown className={`size-4 transition-transform ${shut ? "-rotate-90" : ""}`} />
          </button>
        ) : <div className="mx-3 mb-2 border-t border-slate-200" />}
        {!shut && <div className="space-y-0.5 mt-0.5">{children}</div>}
      </div>
    );
  };

    return (
      <>
          {/* brand */}
          <div className={`flex items-center gap-3 px-4 h-16 border-b border-slate-200 ${collapsed ? "justify-center px-0" : ""}`}>
            <span className="size-9 shrink-0 rounded-lg bg-slate-900 text-white flex items-center justify-center"><Hammer className="size-5" /></span>
            {!collapsed && <span className="font-bold text-slate-900 tracking-tight leading-tight truncate">{brandOr(biz)}</span>}
          </div>

          {/* shift status */}
          {showShift && <NavLink to="/shift" title={collapsed ? (status.shiftOpenedAt ? "Shift open" : "No open shift") : undefined}
            className={`mx-3 mt-4 rounded-lg border px-3 py-2.5 flex items-center gap-3 ${collapsed ? "justify-center px-0" : ""} ${"border-slate-200 bg-slate-50"}`}>
            <span className={`size-2.5 shrink-0 rounded-full ${status.shiftOpenedAt ? "bg-green-600" : "bg-amber-500"}`} />
            {!collapsed && (
              <span className="leading-tight min-w-0">
                <span className={`block text-sm font-semibold ${"text-slate-900"}`}>{status.shiftOpenedAt ? "Shift open" : "No open shift"}</span>
                <span className="block text-xs text-slate-500 truncate">{status.shiftOpenedAt ? `Since ${fmtTime(status.shiftOpenedAt)}` : "Open one on the Sell screen"}</span>
              </span>
            )}
          </NavLink>}

          {/* navigation */}
          <nav className="flex-1 overflow-y-auto px-3 py-5">
            {canReports && group("Overview", <>
              {item("/dashboard", "Dashboard", LayoutDashboard)}
              {item("/reports", "Reports", BarChart3)}
            </>)}
            {group("Selling", <>
              {canSell && item("/", "Sell", ShoppingCart, undefined, true)}
              {item("/sales", "Sales history", ReceiptText)}
            </>)}
            {group("Stock", <>
              {item("/inventory", "Inventory", Package, canReports ? pill(status.lowStock, "amber") : undefined)}
              {can("suppliers.manage") && item("/suppliers", "Suppliers", Truck)}
            </>)}
            {group("People", <>
              {item("/customers", "Customers", Users, pill(status.owing, "rose"))}
            </>)}
            {showShift && group("Money", item("/shift", "Shift & cash-up", Wallet))}
            {canAdmin && group("Admin", <>
              {can("settings.manage") && item("/settings", "Business", Briefcase, undefined, true, onSettings(""))}
              {can("users.manage") && item("/settings?tab=staff", "Staff", UserCog, undefined, false, onSettings("staff"))}
              {can("roles.manage") && item("/settings?tab=roles", "Roles & access", ShieldCheck, undefined, false, onSettings("roles"))}
              {can("settings.manage") && item("/settings?tab=backup", "Backup", HardDriveDownload, undefined, false, onSettings("backup"))}
            </>)}
          </nav>

          {/* user + collapse */}
          <div className="border-t border-slate-200 p-3 space-y-2">
            <div className={`flex items-center gap-3 rounded-lg px-2 py-2 ${collapsed ? "justify-center px-0" : ""}`}>
              <span className="size-9 shrink-0 rounded-full bg-slate-700 text-white font-bold flex items-center justify-center" title={collapsed ? `${user.name} (${user.role})` : undefined}>{user.name[0]?.toUpperCase()}</span>
              {!collapsed && (
                <>
                  <span className="leading-tight min-w-0 flex-1">
                    <span className="block font-semibold text-slate-900 truncate">{user.name}</span>
                    <span className="block text-xs text-slate-500 capitalize">{user.role}</span>
                  </span>
                  <button onClick={logout} title="Sign out" aria-label="Sign out" className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"><LogOut className="size-5" /></button>
                </>
              )}
            </div>
            {collapsed && <button onClick={logout} title="Sign out" aria-label="Sign out" className="w-full flex justify-center p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"><LogOut className="size-5" /></button>}
            {!inDrawer && <button onClick={toggle} title={collapsed ? "Expand menu" : "Collapse menu"} aria-label={collapsed ? "Expand menu" : "Collapse menu"}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900 ${collapsed ? "justify-center" : ""}`}>
              {collapsed ? <PanelLeftOpen className="size-5" /> : <><PanelLeftClose className="size-5" />Collapse</>}
            </button>}
          </div>
      </>
    );
  };

  return (
    <AuthCtx.Provider value={{ user, logout, can }}>
      <div className="h-full flex flex-col md:flex-row">
        {/* phone top bar */}
        <header className="md:hidden shrink-0 flex items-center gap-3 h-14 px-3 bg-white border-b border-slate-200 print:hidden">
          <button onClick={() => setDrawer(true)} aria-label="Open menu" className="size-10 -ml-1 rounded-lg flex items-center justify-center hover:bg-slate-100"><Menu className="size-6" /></button>
          <span className="font-bold tracking-tight truncate flex-1">{brandOr(biz)}</span>
          {showShift && <NavLink to="/shift" className="flex items-center gap-2 text-sm font-semibold rounded-lg border border-slate-200 px-3 py-1.5">
            <span className={`size-2.5 rounded-full ${status.shiftOpenedAt ? "bg-green-600" : "bg-amber-500"}`} />{status.shiftOpenedAt ? "Shift open" : "No shift"}
          </NavLink>}
        </header>

        {/* desktop / tablet sidebar */}
        <aside className={`${collapsed ? "w-[4.75rem]" : "w-64"} hidden md:flex shrink-0 bg-white border-r border-slate-200 flex-col transition-[width] duration-200 print:hidden`}>
          {renderSidebar(collapsed)}
        </aside>

        {/* phone menu drawer */}
        {drawer && (
          <div className="md:hidden fixed inset-0 z-50 flex print:hidden" onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setDrawer(false); }}>
            <div className="w-72 max-w-[85vw] bg-white flex flex-col shadow-pop">{renderSidebar(false, true)}</div>
            <button className="flex-1 bg-slate-900/50" onClick={() => setDrawer(false)} aria-label="Close menu" />
          </div>
        )}


        <main className="flex-1 min-h-0 min-w-0 overflow-auto">
          {lost && <div role="status" className="sticky top-0 z-20 bg-amber-100 text-amber-900 text-sm font-medium px-4 py-2 text-center print:hidden">Lost the connection to the shop computer. Retrying, and new activity will appear when it is back.</div>}
          <Routes>
            <Route path="/" element={canSell ? <Pos /> : <Navigate to={home} replace />} />
            <Route path="/dashboard" element={canReports ? <Dashboard /> : <Navigate to={home} replace />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/inventory" element={<Products />} />
            <Route path="/suppliers" element={can("suppliers.manage") ? <Suppliers /> : <Navigate to={home} replace />} />
            <Route path="/products" element={<Navigate to="/inventory" replace />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="/shift" element={<Shift />} />
            <Route path="/reports" element={canReports ? <Reports /> : <Navigate to={home} replace />} />
            <Route path="/settings" element={canAdmin ? <Settings /> : <Navigate to={home} replace />} />
            <Route path="*" element={<Navigate to={home} replace />} />
          </Routes>
        </main>
      </div>
    </AuthCtx.Provider>
  );
}
