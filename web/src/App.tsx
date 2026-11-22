import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BarChart3, HardDriveDownload, LayoutDashboard, Briefcase, ShieldCheck, Truck, UserCog, LogOut, Package, ReceiptText, Settings as SettingsIcon, ShoppingCart, Users, Wallet } from "lucide-react";
import { AuthCtx, get, getToken, post, setToken, userCan, type User } from "./lib/api";
import type { Permission } from "../../shared/permissions";
import { useConfirm } from "./lib/toast";
import { brandOr, setBrand, setLogo, useBrand, useLogoUrl } from "./lib/brand";
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
import { SiteFooter } from "./lib/Footer";
import { HelpButton } from "./lib/Help";
import { GlobalSearch, type SearchPage } from "./lib/GlobalSearch";
import { BottomBar, type NavGroup, type NavPage } from "./lib/BottomBar";
import NotFound from "./pages/NotFound";
import ProductDetail from "./pages/ProductDetail";

interface Status { shiftOpenedAt: string | null; lowStock: number; owing: number }

/**
 * True while the bottom bar should be tucked away: the person has scrolled DOWN the page by a fair bit.
 * It comes back the moment they scroll up, when they are near the top, or when the page is too short to scroll.
 * `off` keeps it always showing (the till scrolls inside its own panels).
 */
function useScrollHide(ref: RefObject<HTMLElement | null>, off: boolean, resetKey: string) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = ref.current;
    setHidden(false);
    if (!el || off) return;
    let last = el.scrollTop;
    let anchor = last; // where the current direction of travel began
    let dir = 0;
    const onScroll = () => {
      const top = el.scrollTop;
      const scrollable = el.scrollHeight - el.clientHeight > 40;
      if (!scrollable || top <= 80) { setHidden(false); last = top; anchor = top; dir = 0; return; }
      const d = top - last;
      if (d === 0) return;
      const now = d > 0 ? 1 : -1;
      if (now !== dir) { dir = now; anchor = last; }
      if (now > 0 && top - anchor > 24) setHidden(true);
      else if (now < 0 && anchor - top >= 8) setHidden(false);
      last = top;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref, off, resetKey]);
  return hidden;
}

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
  const biz = useBrand();
  const logo = useLogoUrl();
  const [status, setStatus] = useState<Status>({ shiftOpenedAt: null, lowStock: 0, owing: 0 });
  const showShift = canSell || !!status.shiftOpenedAt;

  // the bottom bar slides away while scrolling down; the footer follows it so nothing jumps
  const mainRef = useRef<HTMLElement>(null);
  const scrollHidden = useScrollHide(mainRef, loc.pathname === "/", loc.pathname);
  const [barVisible, setBarVisible] = useState(true);

  useEffect(() => { get<Record<string, string>>("/api/settings").then((s) => { setBrand(s.business_name); setLogo(s.logo_version); }).catch(() => {}); }, []);
  useLive(["settings"], () => { get<Record<string, string>>("/api/settings").then((s) => { setBrand(s.business_name); setLogo(s.logo_version); }).catch(() => {}); });

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

  // is this page the one on screen? (the Settings tabs all live at /settings, told apart by ?tab=)
  const at = (to: string, end = false) => (end ? loc.pathname === to : loc.pathname === to || loc.pathname.startsWith(`${to}/`));
  const onSettings = (tab: string) => {
    if (loc.pathname !== "/settings") return false;
    const cur = new URLSearchParams(loc.search).get("tab") ?? "";
    return cur === tab || (tab === "" && !["staff", "roles", "backup"].includes(cur));
  };

  const searchPages = [
    canReports && { label: "Dashboard", to: "/dashboard", also: "overview today" },
    canReports && { label: "Reports", to: "/reports", also: "fast slow movers vat profit sales" },
    canSell && { label: "Sell", to: "/", also: "till pos checkout" },
    { label: "Sales history", to: "/sales", also: "refund receipt invoice" },
    { label: "Inventory", to: "/inventory", also: "products items stock" },
    { label: "Stock movements", to: "/inventory?tab=movements", also: "ledger history" },
    { label: "Categories", to: "/inventory?tab=categories", also: "groups" },
    can("suppliers.manage") && { label: "Suppliers", to: "/suppliers", also: "lpo orders purchase reorder deliveries" },
    can("customers.manage") && { label: "Customers", to: "/customers", also: "debtors borrowers credit owe" },
    showShift && { label: "Shift and cash-up", to: "/shift", also: "close shift drawer" },
    can("settings.manage") && { label: "Business settings", to: "/settings", also: "name logo receipt address" },
    can("users.manage") && { label: "Staff", to: "/settings?tab=staff", also: "users pin add delete" },
    can("roles.manage") && { label: "Roles and access", to: "/settings?tab=roles", also: "permissions" },
  ].filter(Boolean) as SearchPage[];

  // the sections of the bottom bar, with the same visibility rules the old sidebar had
  const some = (...p: (NavPage | false)[]) => p.filter(Boolean) as NavPage[];
  const groups: NavGroup[] = [
    canReports && {
      label: "Overview", Icon: LayoutDashboard,
      pages: some({ to: "/dashboard", label: "Dashboard", Icon: LayoutDashboard, active: at("/dashboard") }, { to: "/reports", label: "Reports", Icon: BarChart3, active: at("/reports") }),
    },
    {
      label: "Selling", Icon: ShoppingCart,
      pages: some(canSell && { to: "/", label: "Sell", Icon: ShoppingCart, active: at("/", true) }, { to: "/sales", label: "Sales history", Icon: ReceiptText, active: at("/sales") }),
    },
    {
      label: "Stock", Icon: Package,
      pages: some(
        { to: "/inventory", label: "Inventory", Icon: Package, active: at("/inventory"), badge: canReports ? status.lowStock : 0, tone: "amber" },
        can("suppliers.manage") && { to: "/suppliers", label: "Suppliers", Icon: Truck, active: at("/suppliers") },
      ),
    },
    can("customers.manage") && {
      label: "People", Icon: Users,
      pages: some({ to: "/customers", label: "Customers", Icon: Users, active: at("/customers"), badge: status.owing, tone: "rose" }),
    },
    showShift && { label: "Money", Icon: Wallet, pages: some({ to: "/shift", label: "Shift and cash-up", Icon: Wallet, active: at("/shift") }) },
    canAdmin && {
      label: "Admin", Icon: SettingsIcon,
      pages: some(
        can("settings.manage") && { to: "/settings", label: "Business", Icon: Briefcase, active: onSettings("") },
        can("users.manage") && { to: "/settings?tab=staff", label: "Staff", Icon: UserCog, active: onSettings("staff") },
        can("roles.manage") && { to: "/settings?tab=roles", label: "Roles and access", Icon: ShieldCheck, active: onSettings("roles") },
        can("settings.manage") && { to: "/settings?tab=backup", label: "Backup", Icon: HardDriveDownload, active: onSettings("backup") },
      ),
    },
  ].filter(Boolean) as NavGroup[];

  return (
    <AuthCtx.Provider value={{ user, logout, can }}>
      <div className="h-full flex flex-col">
        {/* top bar: the shop, search, then shift, help and who is signed in */}
        <header className="shrink-0 bg-white border-b border-slate-200 px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3 print:hidden">
          <div className="flex items-center gap-2 shrink-0 min-w-0">
            {logo
              ? <img src={logo} alt="" className="size-8 shrink-0 rounded-lg object-contain" />
              : <span className="sm:hidden size-8 shrink-0 rounded-lg bg-accent text-white font-bold flex items-center justify-center" aria-hidden>{brandOr(biz)[0]?.toUpperCase()}</span>}
            <span className="hidden sm:block font-bold tracking-tight truncate max-w-[11rem]">{brandOr(biz)}</span>
          </div>
          <div className="flex-1 min-w-0 max-w-xl"><GlobalSearch pages={searchPages} /></div>
          <div className="flex items-center gap-1.5 sm:gap-2 ml-auto shrink-0">
            {showShift && (
              <NavLink to="/shift" aria-label={status.shiftOpenedAt ? "Shift open" : "No open shift"} className="flex items-center gap-2 text-sm font-semibold rounded-lg border border-slate-300 px-2.5 sm:px-3 py-1.5 hover:bg-slate-50">
                <span className={`size-2.5 rounded-full ${status.shiftOpenedAt ? "bg-green-600" : "bg-amber-500"}`} />
                <span className="hidden sm:inline">{status.shiftOpenedAt ? "Shift open" : "No open shift"}</span>
              </NavLink>
            )}
            <HelpButton variant="icon" />
            <div className="flex items-center gap-2 sm:pl-3 sm:ml-1 sm:border-l border-slate-200">
              <span className="hidden sm:flex size-8 shrink-0 rounded-full bg-accent text-white text-sm font-bold items-center justify-center" aria-hidden>{user.name[0]?.toUpperCase()}</span>
              <span className="leading-tight hidden lg:block">
                <span className="block text-sm font-semibold">{user.name}</span>
                {user.role.toLowerCase() !== user.name.toLowerCase() && <span className="block text-xs text-slate-500 capitalize">{user.role}</span>}
              </span>
              <button onClick={logout} aria-label="Sign out" title="Sign out" className="size-9 rounded-lg flex items-center justify-center text-slate-500 hover:bg-slate-100 hover:text-slate-900"><LogOut className="size-5" /></button>
            </div>
          </div>
        </header>

        <main ref={mainRef} className="flex-1 min-h-0 min-w-0 overflow-auto">
          {lost && <div role="status" className="sticky top-0 z-20 bg-amber-100 text-amber-900 text-sm font-medium px-4 py-2 text-center print:hidden">Lost the connection to the shop computer. Retrying, and new activity will appear when it is back.</div>}
          <Routes>
            <Route path="/" element={canSell ? <Pos /> : <Navigate to={home} replace />} />
            <Route path="/dashboard" element={canReports ? <Dashboard /> : <Navigate to={home} replace />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/inventory" element={<Products />} />
            <Route path="/inventory/:id" element={<ProductDetail />} />
            <Route path="/suppliers" element={can("suppliers.manage") ? <Suppliers /> : <Navigate to={home} replace />} />
            <Route path="/products" element={<Navigate to="/inventory" replace />} />
            <Route path="/customers" element={can("customers.manage") ? <Customers /> : <Navigate to={home} replace />} />
            <Route path="/shift" element={<Shift />} />
            <Route path="/reports" element={canReports ? <Reports /> : <Navigate to={home} replace />} />
            <Route path="/settings" element={canAdmin ? <Settings /> : <Navigate to={home} replace />} />
            <Route path="*" element={<NotFound home={home} />} />
          </Routes>
        </main>

        {/* the footer keeps constant room for the bar, and slides down into it when the bar tucks away */}
        <div className="relative shrink-0 bg-white pb-[calc(var(--bar-h)+env(safe-area-inset-bottom))] overflow-hidden print:hidden">
          <div className={`transition-transform duration-300 ease-out ${barVisible ? "" : "translate-y-[calc(var(--bar-h)+env(safe-area-inset-bottom))]"}`}>
            <SiteFooter />
          </div>
        </div>

        <BottomBar groups={groups} hidden={scrollHidden} onVisible={setBarVisible} />
      </div>
    </AuthCtx.Provider>
  );
}
