import { useSyncExternalStore } from "react";

// The shop's display name is set by the admin (Settings > Business). Every screen reads it from here,
// so a change shows up everywhere at once, including the browser tab title.
const FALLBACK = "Hardware POS";
let name = "";
let logoVersion = "";
const subs = new Set<() => void>();

export function setBrand(n: string | undefined | null) {
  name = (n ?? "").trim();
  document.title = name || FALLBACK;
  subs.forEach((f) => f());
}

export function useBrand(): string {
  return useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => name,
  );
}

export function setLogo(version: string | undefined | null) {
  logoVersion = version ?? "";
  subs.forEach((f) => f());
}

/** URL of the shop's logo, or null when none has been uploaded. The version makes a new upload show immediately. */
export function useLogoUrl(): string | null {
  const v = useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => logoVersion,
  );
  return v ? `/api/logo?v=${v}` : null;
}

export const brandOr = (n: string) => n || FALLBACK;
