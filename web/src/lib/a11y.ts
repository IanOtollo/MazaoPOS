import { useSyncExternalStore } from "react";

/*
 * Accessibility choices. They are saved on this device only (each till or phone keeps its own),
 * and applied as attributes on <html>, which index.css reacts to.
 */
export type TextSize = "normal" | "large" | "xlarge";
export interface A11y { text: TextSize; contrast: boolean; calm: boolean; focus: boolean }

const KEY = "pos_a11y";
export const DEFAULTS: A11y = { text: "normal", contrast: false, calm: false, focus: false };

function read(): A11y {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<A11y>;
    return {
      text: p.text === "large" || p.text === "xlarge" ? p.text : "normal",
      contrast: p.contrast === true, calm: p.calm === true, focus: p.focus === true,
    };
  } catch {
    return DEFAULTS; // storage blocked or damaged: use the defaults
  }
}

let state: A11y = read();
const subs = new Set<() => void>();

function apply(a: A11y) {
  const r = document.documentElement;
  r.dataset.text = a.text;
  r.dataset.contrast = a.contrast ? "high" : "normal";
  r.dataset.motion = a.calm ? "reduce" : "normal";
  r.dataset.focus = a.focus ? "strong" : "normal";
}

/** Call once at start-up so the saved choices apply before the first screen is drawn. */
export function initA11y() { apply(state); }

export function setA11y(patch: Partial<A11y>) {
  state = { ...state, ...patch };
  apply(state);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* the choice still applies until the page closes */ }
  subs.forEach((f) => f());
}

export function resetA11y() { setA11y(DEFAULTS); }

export function useA11y(): A11y {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
}
