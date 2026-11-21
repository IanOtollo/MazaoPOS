import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Banknote, Minus, Percent, Plus, ScanBarcode, Search, ShoppingCart, Trash2, UserRound, X } from "lucide-react";
import { fmtKES, fmtQty, lineTotal, toCents, vatOfGross } from "../../../shared/money";
import { fetchAllProducts, get, post, priceFor, useAuth, type Customer, type Product, type Unit } from "../lib/api";
import { Button, ErrorLine, Field, Input, Modal, NumInput, td, th, PinInput } from "../lib/ui";
import { Receipt, type SaleDoc } from "../lib/Receipt";
import { PayModal } from "./PayModal";
import { OpenShift } from "./OpenShift";
import { useConfirm, useToast } from "../lib/toast";
import { useLive } from "../lib/live";

interface Line { product: Product; qty: number; unit: Unit | null }
type Method = "cash" | "mpesa" | "card" | "bank" | "credit";
interface Pay { method: Method; amount: number | null; reference: string }

export default function Pos() {
  const { can } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [shift, setShift] = useState<any | undefined>(undefined);
  const [q, setQ] = useState("");
  const [cart, setCart] = useState<Line[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [discount, setDiscount] = useState(0); // cents
  const [msg, setMsg] = useState("");
  const [modal, setModal] = useState<"pay" | "customer" | "discount" | null>(null);
  const [done, setDone] = useState<SaleDoc | null>(null);
  const [cartOpen, setCartOpen] = useState(false); // phone only: the cart is a full-screen sheet
  const [biz, setBiz] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  const loadShift = useCallback(() => get("/api/shifts/current").then(setShift), []);
  useEffect(() => { loadShift(); get("/api/settings").then(setBiz); }, [loadShift]);
  useLive(["shifts"], loadShift);

  const [cats, setCats] = useState<{ id: number; name: string }[]>([]);
  const [cat, setCat] = useState<number | null>(null);
  useEffect(() => { get<{ id: number; name: string }[]>("/api/categories").then(setCats); }, []);

  // The whole catalogue lives in memory: search/filter is instant and needs no network.
  const [catalog, setCatalog] = useState<Product[]>([]);
  const reloadCatalog = useCallback(
    () => fetchAllProducts().then(setCatalog).catch((e) => setMsg(e.message)),
    [],
  );
  useEffect(() => { reloadCatalog(); }, [reloadCatalog]);
  // another till sold something or a manager changed a price: refresh stock and prices on this screen too
  useLive(["products", "stock"], reloadCatalog);

  // pre-lowercased search text per product, rebuilt only when the catalogue changes
  const indexed = useMemo(
    () => catalog.map((p) => ({ p, hay: `${p.name} ${p.sku} ${p.barcode ?? ""} ${(p.units ?? []).map((u) => u.barcode ?? "").join(" ")}`.toLowerCase() })),
    [catalog],
  );
  const deferredQ = useDeferredValue(q);
  const results = useMemo(() => {
    const words = deferredQ.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const needle = deferredQ.trim().toLowerCase();
    return indexed
      .filter(({ p, hay }) => (!cat || p.category_id === cat) && words.every((w) => hay.includes(w)))
      .map(({ p }) => p)
      .sort((a, b) => Number(b.barcode === needle || b.sku.toLowerCase() === needle) - Number(a.barcode === needle || a.sku.toLowerCase() === needle));
  }, [indexed, deferredQ, cat]);

  const tier = customer?.tier ?? "retail";

  // brief highlight on the cart line that just changed (two alternating keyframes restart the animation)
  const [flash, setFlash] = useState<{ id: number; n: number } | null>(null);

  const add = (p: Product, unit: Unit | null = null) => {
    setMsg("");
    setFlash((f) => ({ id: p.id, n: (f?.n ?? 0) + 1 }));
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id && (l.unit?.id ?? 0) === (unit?.id ?? 0));
      if (i >= 0) return c.map((l, k) => (k === i ? { ...l, qty: l.qty + 1 } : l));
      return [...c, { product: p, qty: 1, unit }];
    });
    setQ("");
    searchRef.current?.focus();
  };

  // scanner: Enter with an exact barcode/SKU match adds straight away
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || !q.trim()) return;
    const packHit = results.find((p) => p.units?.some((u) => u.barcode === q.trim()));
    if (packHit) return add(packHit, packHit.units.find((u) => u.barcode === q.trim()) ?? null);
    const exact = results.find((p) => p.barcode === q.trim() || p.sku.toLowerCase() === q.trim().toLowerCase());
    if (exact) add(exact);
    else if (results.length === 1) add(results[0]);
    else setMsg("No exact match - pick an item from the list");
  };

  const lines = useMemo(
    () => cart.map((l) => { const unit = priceFor(l.product, tier, l.unit); return { ...l, unitPrice: unit, gross: lineTotal(unit, Math.round(l.qty * 1000)) }; }),
    [cart, tier],
  );
  const subtotal = lines.reduce((a, l) => a + l.gross, 0);
  const total = Math.max(0, subtotal - discount);
  // VAT shown is an estimate; the server's figure is on the receipt
  const vat = lines.reduce((a, l) => a + vatOfGross(l.gross, l.product.vat_code), 0);

  const setQty = (i: number, qty: number | null) => setCart((c) => c.map((l, k) => (k === i ? { ...l, qty: qty ?? 0 } : l)));
  const reset = () => { setCartOpen(false); setCart([]); setCustomer(null); setDiscount(0); approvalRef.current = ""; setMsg(""); searchRef.current?.focus(); };
  // user-initiated clear asks first; the post-sale reset does not
  const clear = async () => {
    if (!cart.length) return;
    const n = cart.length;
    if (await confirm({ title: "Clear this sale?", body: `This removes ${n === 1 ? "the item" : `all ${n} items`} from the cart.`, confirmLabel: "Clear sale", danger: true })) reset();
  };

  // remove a line, with a one-tap undo that puts it back in the same position
  const removeLine = (i: number) => {
    const line = cart[i];
    if (!line) return;
    setCart((c) => c.filter((_, k) => k !== i));
    toast({
      msg: `Removed ${line.product.name}`, kind: "info",
      action: { label: "Undo", run: () => setCart((c) => {
        if (c.some((l) => l.product.id === line.product.id)) return c;
        const n = [...c]; n.splice(Math.min(i, n.length), 0, line); return n;
      }) },
    });
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === "F9" && cart.length && !modal && !done) { e.preventDefault(); setModal("pay"); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [cart.length, modal, done]);

  if (shift === undefined) return null;
  if (shift === null) return <OpenShift onOpened={loadShift} />;

  const invalid = cart.some((l) => l.qty <= 0 || ((l.unit || !l.product.allow_fraction) && !Number.isInteger(l.qty)));

  return (
    <div className="h-full grid grid-cols-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-[1fr_28rem]">
      {/* LEFT: find items */}
      <section className="flex flex-col min-h-0 bg-slate-100">
        <div className="p-3 pb-2">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-slate-400 pointer-events-none" />
            <ScanBarcode className="absolute right-4 top-1/2 -translate-y-1/2 size-5 text-slate-300 pointer-events-none" />
            <Input ref={searchRef} autoFocus value={q} onChange={(e) => { setQ(e.target.value); setMsg(""); }}
              onKeyDown={onSearchKey} placeholder="Scan or search items" className="!text-lg !py-3.5 !pl-12 !pr-12 !rounded-xl shadow-card" />
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {[{ id: null, name: "All items" }, ...cats].map((c) => (
              <button key={c.id ?? "all"} onClick={() => setCat(c.id)}
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold border ${cat === c.id ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300 text-slate-700 hover:bg-slate-50"}`}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="h-5"><ErrorLine msg={msg} /></div>
        </div>
        <div className="flex-1 overflow-auto px-3 pb-24 lg:pb-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
            {results.map((p) => {
              const out = p.stock_shop <= 0;
              const inCart = cart.find((l) => l.product.id === p.id);
              return (
                <button key={p.id} onClick={() => add(p)}
                  className={`relative overflow-hidden text-left rounded-xl border bg-white p-3.5 pt-4 shadow-card active:scale-[0.97] transition hover:shadow-md hover:border-accent flex flex-col min-h-32 ${inCart ? "border-accent ring-2 ring-accent/20" : "border-slate-200"}`}>
                  {inCart && <span className="absolute top-3 right-3 bg-accent text-white text-xs font-bold rounded-full min-w-6 h-6 px-1.5 flex items-center justify-center">{inCart.qty}</span>}
                  <span className="font-semibold leading-snug text-slate-900 pr-7">{p.name}</span>
                  {p.category && <span className="text-xs text-slate-500 mt-0.5">{p.category}</span>}
                  <span className="mt-auto pt-2 flex items-end justify-between gap-2">
                    <span className="text-lg font-bold text-slate-900 num !text-left">{fmtKES(priceFor(p, tier))}</span>
                    <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${out ? "bg-red-50 text-danger" : p.stock_shop <= p.reorder_level_milli ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"}`}>{out ? "Out of stock" : `${fmtQty(p.stock_shop)} ${p.unit}`}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {!results.length && <p className="text-slate-500 p-4">No products found.</p>}
        </div>
      </section>

      {/* RIGHT: the sale */}
      <section className={`${cartOpen ? "fixed inset-0 z-40 flex" : "hidden lg:flex"} flex-col min-h-0 bg-white lg:static lg:border-l border-slate-200 lg:shadow-xl`}>
        <div className="px-3 py-2 border-b border-line flex items-center justify-between gap-2">
          <button onClick={() => setCartOpen(false)} aria-label="Back to items" className="lg:hidden size-10 shrink-0 rounded-lg flex items-center justify-center hover:bg-slate-100"><ArrowLeft className="size-5" /></button>
          <button onClick={() => setModal("customer")} className="flex items-center gap-3 text-left rounded-lg px-2 py-1.5 hover:bg-slate-50">
            <span className="size-10 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center"><UserRound className="size-5" /></span>
            <span><span className="text-xs text-slate-500 block">Customer</span>
            <span className="font-semibold">{customer ? `${customer.name} · ${customer.tier}` : "Walk-in customer"}</span></span>
          </button>
          <Button variant="danger" onClick={clear} disabled={!cart.length} className="flex items-center gap-1.5 !px-3"><Trash2 className="size-4" />Clear</Button>
        </div>

        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <tbody>
              {lines.map((l, i) => (
                <tr key={`${l.product.id}-${l.unit?.id ?? 0}`} className={flash?.id === l.product.id ? (flash.n % 2 ? "flash-a" : "flash-b") : ""}>
                  <td className={td}>
                    <div className="font-medium leading-tight">{l.product.name}</div>
                    <div className="text-xs text-gray-500">{fmtKES(l.unitPrice)} per {l.unit?.name ?? l.product.unit}{l.product.stock_shop < Math.round(l.qty * (l.unit?.factor_milli ?? 1000)) ? " - low stock" : ""}</div>
                    {l.product.units?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {[{ id: 0, name: l.product.unit, factor_milli: 1000, price_cents: null, barcode: null } as Unit, ...l.product.units].map((u) => (
                          <button key={u.id} onClick={() => setCart((c) => c.map((x, k) => (k === i ? { ...x, unit: u.id === 0 ? null : u, qty: u.id === 0 ? x.qty : Math.max(1, Math.round(x.qty)) } : x)))}
                            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold border ${(l.unit?.id ?? 0) === u.id ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-300 text-slate-600 hover:bg-slate-50"}`}>{u.name}</button>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={`${td} w-36 sm:w-40 !px-2 sm:!px-4`}>
                    <div className="flex items-center gap-1">
                      <button onClick={() => l.qty <= 1 ? removeLine(i) : setQty(i, Math.max(0, l.qty - 1))}
                        className="h-9 w-9 shrink-0 rounded-lg border border-slate-300 bg-white flex items-center justify-center hover:bg-slate-50" aria-label="Decrease"><Minus className="size-4" /></button>
                      <NumInput value={l.qty || null} onChange={(n) => setQty(i, n)} className="num !py-1.5 !px-1 text-center !text-base font-semibold" aria-label="Quantity" />
                      <button onClick={() => setQty(i, l.qty + 1)}
                        className="h-9 w-9 shrink-0 rounded-lg border border-slate-300 bg-white flex items-center justify-center hover:bg-slate-50" aria-label="Increase"><Plus className="size-4" /></button>
                    </div>
                  </td>
                  <td className={`${td} num w-20 sm:w-24 !px-2 sm:!px-4`}>{fmtKES(l.gross)}</td>
                  <td className={`${td} w-8 text-center`}>
                    <button onClick={() => removeLine(i)} className="text-slate-400 hover:text-danger p-1" aria-label="Remove"><X className="size-5" /></button>
                  </td>
                </tr>
              ))}
</tbody>
          </table>
          {!cart.length && (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 p-8 gap-3">
              <span className="size-16 rounded-full bg-slate-100 flex items-center justify-center"><ShoppingCart className="size-8" /></span>
              <p className="font-semibold text-slate-600">Cart is empty</p>
              <p className="text-sm">Scan a barcode or tap an item to start a sale.</p>
            </div>
          )}
        </div>

        <div className="border-t border-line p-3 space-y-1 bg-panel">
          <div className="flex justify-between"><span>Subtotal</span><span className="num">{fmtKES(subtotal)}</span></div>
          <div className="flex justify-between items-center">
            <button className="flex items-center gap-1.5 font-semibold text-accent hover:underline disabled:opacity-40" onClick={() => setModal("discount")} disabled={!cart.length}><Percent className="size-4" />Add discount</button>
            <span className="num">{discount ? `-${fmtKES(discount)}` : "0.00"}</span>
          </div>
          <div className="flex justify-between text-sm text-gray-600"><span>VAT included</span><span className="num">{fmtKES(Math.max(0, vat - (subtotal ? Math.round((vat * discount) / subtotal) : 0)))}</span></div>
          <div className="flex justify-between items-baseline pt-2"><span className="text-lg font-semibold">Total</span><span className="num text-3xl sm:text-4xl font-bold">KES {fmtKES(total)}</span></div>
          <Button variant="primary" className="w-full !py-5 !text-xl !rounded-lg mt-3" disabled={!cart.length || invalid} onClick={() => setModal("pay")}>
            <span className="flex items-center justify-center gap-3"><Banknote className="size-6" />Charge  KES {fmtKES(total)}<span className="opacity-70 text-sm font-normal">F9</span></span>
          </Button>
          {invalid && <ErrorLine msg="Fix quantities (whole numbers only for items sold by the piece)" />}
        </div>
      </section>

      {cart.length > 0 && !cartOpen && (
        <div className="lg:hidden fixed inset-x-0 bottom-0 z-30 bg-white border-t border-slate-200 shadow-pop p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button onClick={() => setCartOpen(true)} className="w-full h-14 rounded-lg bg-slate-900 text-white font-semibold flex items-center justify-between px-4 active:bg-slate-700">
            <span className="flex items-center gap-2"><ShoppingCart className="size-5" />{cart.length} {cart.length === 1 ? "item" : "items"}</span>
            <span className="num">KES {fmtKES(total)}</span>
          </button>
        </div>
      )}

      {modal === "customer" && <CustomerPicker onClose={() => setModal(null)} onPick={(c) => { setCustomer(c); setModal(null); }} />}
      {modal === "discount" && (
        <DiscountModal subtotal={subtotal} isManager={can("sales.discount")} onClose={() => setModal(null)}
          onApply={(cents, pin) => { setDiscount(cents); approvalRef.current = cents > 0 ? pin : ""; setModal(null); }} />
      )}
      {modal === "pay" && (
        <PayModal total={total} customer={customer} onClose={() => setModal(null)}
          items={cart.map((l) => ({ productId: l.product.id, qtyMilli: Math.round(l.qty * 1000), unitId: l.unit?.id ?? null }))}
          discount={discount} approvalPin={approvalRef.current}
          onDone={(s) => { setModal(null); setDone(s); reloadCatalog(); }} />
      )}
      {done && (
        <Modal title={`Sale ${done.receipt_no} complete`} onClose={() => { setDone(null); reset(); }}>
          <div className="flex justify-center border border-line rounded-md p-3 bg-white overflow-auto"><Receipt sale={done} biz={biz} /></div>
          {!!done.changeCents && <p className="text-2xl font-semibold text-center mt-3">Change: KES {fmtKES(done.changeCents)}</p>}
          <div className="flex gap-2 mt-4 print:hidden">
            <Button onClick={() => window.print()} className="flex-1">Print receipt</Button>
            <Button variant="primary" onClick={() => { setDone(null); reset(); }} className="flex-1" autoFocus>New sale</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// manager PIN captured with a discount, replayed when the sale is submitted
const approvalRef = { current: "" };

function CustomerPicker({ onClose, onPick }: { onClose: () => void; onPick: (c: Customer | null) => void }) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Customer[]>([]);
  useEffect(() => { get<Customer[]>(`/api/customers?q=${encodeURIComponent(q)}`).then(setList); }, [q]);
  return (
    <Modal title="Registered customer" onClose={onClose}>
      <Button className="w-full mb-3" onClick={() => onPick(null)}>No account, ordinary sale</Button>
      <Input autoFocus placeholder="Search a registered customer" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 max-h-64 overflow-auto border border-line rounded-lg">
        {list.map((c) => {
          const avail = c.credit_available_cents ?? 0;
          return (
            <button key={c.id} onClick={() => onPick(c)} className="w-full text-left px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50">
              <span className="font-medium">{c.name}</span> <span className="text-sm text-slate-500">{c.phone} · {c.tier}</span>
              {c.credit_stopped ? <span className="block text-sm font-medium text-danger">Credit stopped</span>
                : c.credit_limit_cents > 0 ? <span className={`block text-sm ${avail > 0 ? "text-slate-500" : "text-danger"}`}>{avail > 0 ? `KES ${fmtKES(avail)} credit available` : "Credit limit reached"}</span> : null}
            </button>
          );
        })}
        {!list.length && <p className="p-3 text-slate-500">No registered customers match.</p>}
      </div>
      <p className="text-sm text-slate-500 mt-3">Only people who buy on credit or get special prices are registered. Walk-in customers need no record. A manager registers new borrowers, and selling on credit needs a manager's PIN.</p>
    </Modal>
  );
}

function DiscountModal({ subtotal, isManager, onClose, onApply }: { subtotal: number; isManager: boolean; onClose: () => void; onApply: (cents: number, pin: string) => void }) {
  const [amt, setAmt] = useState<number | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const cents = toCents(amt ?? 0);
  return (
    <Modal title="Discount" onClose={onClose}>
      <Field label="Discount amount (KES, off the total)"><NumInput value={amt} onChange={setAmt} autoFocus /></Field>
      {!isManager && <div className="mt-3"><Field label="Manager PIN" hint="A manager must approve every discount."><PinInput value={pin} onChange={(e) => setPin(e.target.value)} /></Field></div>}
      <div className="mt-3"><ErrorLine msg={err} /></div>
      <div className="flex gap-2 mt-3">
        <Button onClick={() => onApply(0, "")}>Remove discount</Button>
        <Button variant="primary" className="flex-1" onClick={() => {
          if (cents > subtotal) return setErr("Discount is more than the sale");
          if (cents > 0 && !isManager && pin.length < 4) return setErr("Enter a manager PIN");
          onApply(cents, pin);
        }}>Apply</Button>
      </div>
    </Modal>
  );
}
