/** Saves a table as a CSV file that opens cleanly in Excel (UTF-8 with a byte-order mark, one row per line). */
const quote = (v: string | number | null): string => {
  const t = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const body = [header, ...rows].map((r) => r.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Money for a spreadsheet: plain KES with two decimals, no thousands separators, so Excel reads it as a number. */
export const csvKes = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
