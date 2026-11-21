import { HttpError } from "./auth.ts";
import type { ZodType } from "zod";

export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, `${i.path.join(".") || "input"}: ${i.message}`);
  }
  return r.data;
}

/** Kenya is UTC+3 with no DST. Convert a local date (YYYY-MM-DD) to a UTC ISO range. */
export function eatDayRange(date: string): { from: string; to: string } {
  // reject impossible dates such as 2026-02-30, which Date would silently roll over to 2 March
  const utc = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== date) throw new HttpError(400, "That is not a valid date");
  const start = new Date(`${date}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

export const todayEAT = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
