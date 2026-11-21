import { useEffect, useRef, useSyncExternalStore } from "react";
import { apiUrl, getToken } from "./api";

/*
 * Client side of the live channel (see server/events.ts).
 *
 * A browser allows only 6 simultaneous connections to one address, and a live stream never ends. If every
 * open tab held its own stream, a handful of tabs would use up all 6 and every normal request (loading a
 * screen, saving a sale) would wait forever. So only ONE tab holds the stream (the "leader", chosen with the
 * Web Locks API) and it shares what it hears with the other tabs through a BroadcastChannel. If the leader
 * tab closes, another tab takes over automatically.
 */
type Listener = (topics: string[]) => void;
const listeners = new Set<Listener>();
const statusSubs = new Set<() => void>();
let connected = true; // assume fine until the leader says otherwise, so a follower never shows a false warning
let started = false;
let gen = 0; // bumped on every start/stop so a stale loop can never keep running
let everConnected = false;
let abort: AbortController | null = null;
let lockAbort: AbortController | null = null;

const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("pos-live") : null;

const setConnected = (v: boolean) => { if (connected !== v) { connected = v; statusSubs.forEach((f) => f()); } };
const emit = (topics: string[]) => listeners.forEach((l) => l(topics));
const emitAll = (topics: string[]) => { emit(topics); channel?.postMessage({ topics }); };
const announce = (v: boolean) => { setConnected(v); channel?.postMessage({ connected: v }); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only the leader tab runs this. */
async function leaderLoop(my: number) {
  while (started && my === gen) {
    abort = new AbortController();
    try {
      const res = await fetch(apiUrl("/api/events"), { headers: { authorization: `Bearer ${getToken()}`, accept: "text/event-stream" }, signal: abort.signal });
      if (res.status === 401) { stopLive(); return; } // signed out elsewhere
      if (!res.ok || !res.body) throw new Error("no stream");
      announce(true);
      // after a drop, re-read everything once so nothing that happened while we were away is missed
      if (everConnected) emitAll(["*"]);
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
          try { emitAll((JSON.parse(data!.slice(5)) as { topics: string[] }).topics); } catch { /* ignore a malformed block */ }
        }
      }
    } catch {
      /* dropped or aborted: fall through and reconnect */
    }
    if (my !== gen) return;
    announce(false);
    await sleep(2000 + Math.random() * 1000);
  }
}

const retryNow = () => { if (started && !connected) abort?.abort(); };
const onVisible = () => { if (document.visibilityState === "visible") retryNow(); };

export function startLive() {
  if (started) return;
  started = true;
  const my = ++gen;
  window.addEventListener("online", retryNow);
  document.addEventListener("visibilitychange", onVisible);

  // what the leader tab hears reaches this tab through the channel
  if (channel) {
    channel.onmessage = (e: MessageEvent<{ topics?: string[]; connected?: boolean }>) => {
      if (e.data.topics) emit(e.data.topics);
      if (typeof e.data.connected === "boolean") setConnected(e.data.connected);
    };
  }

  const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: { signal: AbortSignal }, cb: () => Promise<void>) => Promise<void> } }).locks;
  if (locks?.request) {
    lockAbort = new AbortController();
    const asked = Date.now();
    locks
      .request("pos-live-leader", { signal: lockAbort.signal }, async () => {
        if (my !== gen) return;
        if (Date.now() - asked > 300) emit(["*"]); // we took over from another tab: catch up on anything missed
        await leaderLoop(my);
      })
      .catch(() => { /* AbortError when this tab signs out */ });
  } else {
    void leaderLoop(my); // very old browser: every tab connects on its own
  }
}

export function stopLive() {
  started = false;
  gen++;
  everConnected = false;
  abort?.abort();
  lockAbort?.abort();
  if (channel) channel.onmessage = null;
  window.removeEventListener("online", retryNow);
  document.removeEventListener("visibilitychange", onVisible);
  setConnected(true);
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
