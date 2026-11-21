import { useEffect, useRef, useSyncExternalStore } from "react";
import { getToken } from "./api";

// Client side of the live channel (see server/events.ts). One connection per browser tab, shared by every screen.
type Listener = (topics: string[]) => void;
const listeners = new Set<Listener>();
const statusSubs = new Set<() => void>();
let connected = false;
let started = false;
let everConnected = false;
let abort: AbortController | null = null;

const setConnected = (v: boolean) => { if (connected !== v) { connected = v; statusSubs.forEach((f) => f()); } };
const emit = (topics: string[]) => listeners.forEach((l) => l(topics));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  while (started) {
    abort = new AbortController();
    try {
      const res = await fetch("/api/events", { headers: { authorization: `Bearer ${getToken()}`, accept: "text/event-stream" }, signal: abort.signal });
      if (res.status === 401) { stopLive(); return; } // signed out elsewhere
      if (!res.ok || !res.body) throw new Error("no stream");
      setConnected(true);
      // after a drop, re-read everything once so nothing that happened while we were away is missed
      if (everConnected) emit(["*"]);
      everConnected = true;

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!block.includes("event: change")) continue;
          const data = block.split("\n").find((l) => l.startsWith("data:"));
          try { emit((JSON.parse(data!.slice(5)) as { topics: string[] }).topics); } catch { /* ignore a malformed block */ }
        }
      }
    } catch {
      /* dropped or aborted: fall through and reconnect */
    }
    setConnected(false);
    if (!started) return;
    await sleep(2000 + Math.random() * 1000);
  }
}

const retryNow = () => { if (started && !connected) abort?.abort(); };

export function startLive() {
  if (started) return;
  started = true;
  window.addEventListener("online", retryNow);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") retryNow(); });
  void run();
}

export function stopLive() {
  started = false;
  everConnected = false;
  abort?.abort();
  setConnected(false);
  window.removeEventListener("online", retryNow);
}

/** Run `onChange` (debounced) when any of `topics` changes anywhere in the shop. */
export function useLive(topics: string[], onChange: () => void) {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = topics.join(",");
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const l: Listener = (got) => {
      if (got.includes("*") || got.some((x) => key.split(",").includes(x))) {
        clearTimeout(t);
        t = setTimeout(() => cb.current(), 250);
      }
    };
    listeners.add(l);
    return () => { listeners.delete(l); clearTimeout(t); };
  }, [key]);
}

export function useLiveConnected(): boolean {
  return useSyncExternalStore((f) => { statusSubs.add(f); return () => { statusSubs.delete(f); }; }, () => connected);
}
