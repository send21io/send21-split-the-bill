import { fiatDecimals } from "./currencies.js";

/**
 * Split an integer amount of minor units (cents, or whole yen) into `count`
 * shares that differ by at most one unit and always add up to the total.
 * The remainder goes to the first shares: 100.00 / 3 → 33.34, 33.33, 33.33.
 */
export function splitMinor(totalMinor: number, count: number): number[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0) throw new RangeError("total must be a non-negative integer");
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError("count must be a positive integer");
  const base = Math.floor(totalMinor / count);
  const rest = totalMinor - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < rest ? 1 : 0));
}

/** Same in the currency's own unit: splitAmount(100, "EUR", 3) → [33.34, 33.33, 33.33]. */
export function splitAmount(total: number, fiat: string, count: number): number[] {
  const scale = 10 ** fiatDecimals(fiat);
  return splitMinor(Math.round(total * scale), count).map((m) => m / scale);
}
