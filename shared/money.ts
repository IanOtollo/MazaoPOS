// Money is stored as integer cents (KES x 100). Quantity is stored as integer
// milli-units (1 piece = 1000) so metres / kg / partial bags are exact.

export type VatCode = "A" | "B" | "E"; // A = 16%, B = zero-rated, E = exempt
export const VAT_RATES: Record<VatCode, number> = { A: 0.16, B: 0, E: 0 };
export const VAT_LABEL: Record<VatCode, string> = { A: "16%", B: "0%", E: "Exempt" };

/** Prices are VAT-inclusive. Returns the VAT portion of a gross amount. */
export function vatOfGross(grossCents: number, code: VatCode): number {
  const r = VAT_RATES[code];
  if (!r) return 0;
  return Math.round((grossCents * r) / (1 + r));
}

/** line total in cents = unit price (cents per 1 unit) * qty (milli) / 1000 */
export function lineTotal(unitPriceCents: number, qtyMilli: number): number {
  return Math.round((unitPriceCents * qtyMilli) / 1000);
}

export const fmtKES = (cents: number) =>
  (cents / 100).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtQty = (milli: number) => {
  const v = milli / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

export const toCents = (s: string | number) => Math.round(Number(s) * 100);
export const toMilli = (s: string | number) => Math.round(Number(s) * 1000);
