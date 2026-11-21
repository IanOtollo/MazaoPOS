import { createContext, useContext } from "react";
import type { Permission } from "../../../shared/permissions";

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
    res = await fetch(path, {
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

export interface Product {
  id: number; sku: string; barcode: string | null; name: string; category: string | null; category_id: number | null;
  unit: string; allow_fraction: number; vat_code: "A" | "B" | "E"; cost_cents: number;
  price_retail_cents: number; price_contractor_cents: number | null; price_wholesale_cents: number | null;
  reorder_level_milli: number; active: number; stock_shop: number; stock_store: number;
}
export interface Customer {
  id: number; name: string; phone: string | null; kra_pin: string | null;
  tier: "retail" | "contractor" | "wholesale"; credit_limit_cents: number; balance_cents: number;
}

export function priceFor(p: Product, tier: Customer["tier"]): number {
  if (tier === "wholesale" && p.price_wholesale_cents != null) return p.price_wholesale_cents;
  if ((tier === "contractor" || tier === "wholesale") && p.price_contractor_cents != null) return p.price_contractor_cents;
  return p.price_retail_cents;
}

export const AuthCtx = createContext<{ user: User; logout: () => void; can: (p: Permission) => boolean }>(null as never);
export const useAuth = () => useContext(AuthCtx);

export const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
