/*
 * A tiny channel so any part of the app can raise a pop-up error without importing the toast provider
 * (which would be a circular import: the provider uses the shared UI pieces).
 */
type Listener = (msg: string) => void;
const listeners = new Set<Listener>();

export function notifyError(msg: string) {
  listeners.forEach((l) => l(msg));
}

export function onNotifyError(l: Listener) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
