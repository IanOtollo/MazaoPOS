import { useSyncExternalStore } from "react";

// The shop's display name is set by the admin (Settings > Business). Every screen reads it from here,
// so a change shows up everywhere at once, including the browser tab title.
const FALLBACK = "Hardware POS";
let name = "";
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

export const brandOr = (n: string) => n || FALLBACK;
