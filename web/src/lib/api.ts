import { createContext, useContext } from "react";
import type { Permission } from "../../../shared/permissions";

// Where the server lives. Empty means "the same address as this page" (the shop computer, or the dev proxy).
// When the screens are hosted separately (for example on Vercel) VITE_API_URL points at the server instead.
// VITE_API_URL wins. Otherwise use the Convex address the deploy step provides (its HTTP address ends .convex.site).
const fromConvex = ((import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "").replace(".convex.cloud", ".convex.site");
export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) || fromConvex).replace(/\/+$/, "");
export const apiUrl = (path: string) => `${API_BASE}${path}`;

const TOKEN_KEY = "pos_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? "";
export const setToken = (t: string) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Cannot reach the POS server. Check the network cable / Wi-Fi.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && getToken()) {
    setToken("");
    location.reload();
  }
  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504)
      throw new ApiError(res.status, "The POS server is not responding. Make sure it is running, then try again.");
    throw new ApiError(res.status, data.error ?? `Something went wrong (error ${res.status})`);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);

export interface User { id: number; name: string; role: string; roleId?: number; permissions: Permission[] }
export const userCan = (u: Pick<User, "permissions">, p: Permission) => u.permissions.includes(p);

export interface Unit { id: number; name: string; factor_milli: number; price_cents: number | null; barcode: string | null }
export interface Product {
  units: Unit[]; item_class_code?: string | null; qty_unit_code?: string | null; pack_unit_code?: string | null; origin_country?: string | null;
  id: number; sku: string; barcode: string | null; name: string; category: string | null; category_id: number | null;
  unit: string; allow_fraction: number; vat_code: "A" | "B" | "E"; cost_cents: number;
  price_retail_cents: number; price_contractor_cents: number | null; price_wholesale_cents: number | null;
  reorder_level_milli: number; active: number; stock_shop: number; stock_store: number;
}
/** Every product, fetched a page at a time so a big catalogue is never cut off. extra is a query string such as "&all=1". */
export async function fetchAllProducts(extra = ""): Promise<Product[]> {
  const out: Product[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await get<{ items: Product[]; total: number }>(`/api/products/page?limit=500&offset=${offset}${extra}`);
    out.push(...r.items);
    if (!r.items.length || out.length >= r.total) return out;
  }
}

export interface Customer {
  id: number; name: string; phone: string | null; kra_pin: string | null;
  tier: "retail" | "contractor" | "wholesale"; credit_limit_cents: number; credit_days?: number; credit_stopped?: number; credit_available_cents?: number; balance_cents: number;
}

/** Price of ONE of the chosen unit (or of the product's own unit when none is chosen). Mirrors the server. */
export function priceFor(p: Product, tier: Customer["tier"], unit?: Unit | null): number {
  const base = basePriceFor(p, tier);
  if (!unit) return base;
  if (unit.price_cents != null && tier === "retail") return unit.price_cents;
  return Math.round((base * unit.factor_milli) / 1000);
}

function basePriceFor(p: Product, tier: Customer["tier"]): number {
  if (tier === "wholesale" && p.price_wholesale_cents != null) return p.price_wholesale_cents;
  if ((tier === "contractor" || tier === "wholesale") && p.price_contractor_cents != null) return p.price_contractor_cents;
  return p.price_retail_cents;
}

export const AuthCtx = createContext<{ user: User; logout: () => void; can: (p: Permission) => boolean }>(null as never);
export const useAuth = () => useContext(AuthCtx);

export const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
