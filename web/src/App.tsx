import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BarChart3, LayoutDashboard, LogOut, Menu, Package, PanelLeftClose, PanelLeftOpen, ReceiptText, Settings as SettingsIcon, ShoppingCart, Users, Wallet, Hammer, type LucideIcon } from "lucide-react";
import { AuthCtx, fmtTime, get, getToken, post, setToken, userCan, type User } from "./lib/api";
import type { Permission } from "../../shared/permissions";
import { useConfirm } from "./lib/toast";
import Login from "./pages/Login";
import Pos from "./pages/Pos";
import Products from "./pages/Products";
import Sales from "./pages/Sales";
import Customers from "./pages/Customers";
import Reports from "./pages/Reports";
import Dashboard from "./pages/Dashboard";
import Shift from "./pages/Shift";
import Settings from "./pages/Settings";

const COLLAPSE_KEY = "pos_sidebar_collapsed";
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
  const home = canSell ? "/" : canReports ? "/dashboard" : "/products";
  const confirm = useConfirm();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [biz, setBiz] = useState("");
  const [status, setStatus] = useState<Status>({ shiftOpenedAt: null, lowStock: 0, owing: 0 });
  const showShift = canSell || !!status.shiftOpenedAt;

  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1"); } catch { /* storage unavailable */ }
    return !c;
  });

  useEffect(() => { get<Record<string, string>>("/api/settings").then((s) => setBiz(s.business_name ?? "")).catch(() => {}); }, []);

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
  useEffect(() => { setDrawer(false); }, [loc.pathname]);

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

  const renderSidebar = (collapsed: boolean, inDrawer = false) => {
  const item = (to: string, label: string, Icon: LucideIcon, badge?: ReactNode, end = false) => (
    <NavLink key={to} to={to} end={end} title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `relative flex items-center gap-3 rounded-lg px-3 py-2.5 font-semibold text-sm transition-colors ${collapsed ? "justify-center" : ""} ${isActive ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}>
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-slate-900" />}
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

  const group = (label: string, children: ReactNode) => (
    <div className="mt-5 first:mt-0">
      {!collapsed && <div className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</div>}
      {collapsed && <div className="mx-3 mb-2 border-t border-slate-200" />}
      <div className="space-y-0.5">{children}</div>
    </div>
  );

    return (
      <>
          {/* brand */}
          <div className={`flex items-center gap-3 px-4 h-16 border-b border-slate-200 ${collapsed ? "justify-center px-0" : ""}`}>
            <span className="size-9 shrink-0 rounded-lg bg-slate-900 text-white flex items-center justify-center"><Hammer className="size-5" /></span>
            {!collapsed && <span className="font-bold text-slate-900 tracking-tight leading-tight truncate">{biz || "Hardware POS"}</span>}
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
              {item("/products", "Products", Package, canReports ? pill(status.lowStock, "amber") : undefined)}
            </>)}
            {group("People", <>
              {item("/customers", "Customers", Users, pill(status.owing, "rose"))}
            </>)}
            {showShift && group("Money", item("/shift", "Shift & cash-up", Wallet))}
            {canAdmin && group("Admin", item("/settings", "Settings", SettingsIcon))}
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
          <span className="font-bold tracking-tight truncate flex-1">{biz || "Hardware POS"}</span>
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
          <Routes>
            <Route path="/" element={canSell ? <Pos /> : <Navigate to={home} replace />} />
            <Route path="/dashboard" element={canReports ? <Dashboard /> : <Navigate to={home} replace />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/products" element={<Products />} />
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
