import { CATEGORIES, type Category } from "./expenses.ts";
import { validationError, type ErrorDetail } from "./http.ts";
import { convert, isCurrency } from "./money.ts";
import type { Ctx, Result } from "./router.ts";

export function getSummary(ctx: Ctx): Result {
  const month = ctx.query.get("month");
  const currency = ctx.query.get("currency");
  const validMonth = month !== null && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  const errors: ErrorDetail[] = [];
  if (!validMonth) errors.push({ field: "month", message: "Must be a month written as YYYY-MM" });
  if (!isCurrency(currency)) errors.push({ field: "currency", message: "Must be one of GBP, EUR, USD" });
  if (!validMonth || !isCurrency(currency)) throw validationError(errors);

  const categories = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  let count = 0;
  for (const e of ctx.store.expenses.values()) {
    if (!e.date.startsWith(month + "-")) continue;
    categories[e.category] += convert(e.amount, e.currency, currency);
    count += 1;
  }
  const total = CATEGORIES.reduce((sum, c) => sum + categories[c], 0);
  return { status: 200, body: { month, currency, count, total, categories } };
}
