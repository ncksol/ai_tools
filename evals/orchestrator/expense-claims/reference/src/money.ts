export const CURRENCIES = ["GBP", "EUR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

// The value of one unit in GBP, times 10 000.
export const RATES: Record<Currency, number> = { GBP: 10000, EUR: 8500, USD: 8000 };

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

// amountMinor × rate(from) ÷ rate(to), rounded half up to a whole minor unit.
export function convert(amountMinor: number, from: Currency, to: Currency): number {
  const numerator = BigInt(amountMinor) * BigInt(RATES[from]);
  const denominator = BigInt(RATES[to]);
  return Number((2n * numerator + denominator) / (2n * denominator));
}
