import { findExpense, type Expense } from "./expenses.ts";
import { parseJsonObject, validationError } from "./http.ts";
import { convert } from "./money.ts";
import type { Ctx, Result } from "./router.ts";

export type PolicyCode = "RECEIPT_REQUIRED" | "MEALS_DAILY_CAP" | "WEEKEND";

export interface Violation {
  code: PolicyCode;
  severity: "error" | "warning";
  expenseIds: string[];
  message: string;
}

const RECEIPT_THRESHOLD = 2500;
const MEALS_DAILY_CAP = 5000;

export function evaluatePolicy(expenses: Expense[]): Violation[] {
  const gbp = (e: Expense) => convert(e.amount, e.currency, "GBP");

  const receipts: Violation[] = expenses
    .filter((e) => !e.receipt && gbp(e) > RECEIPT_THRESHOLD)
    .map((e): Violation => ({
      code: "RECEIPT_REQUIRED",
      severity: "error",
      expenseIds: [e.id],
      message: `Expense ${e.id} is over £25.00 and needs a receipt.`,
    }));

  const meals = new Map<string, { ids: string[]; total: number }>();
  for (const e of expenses) {
    if (e.category !== "meals") continue;
    const day = meals.get(e.date) ?? { ids: [], total: 0 };
    day.ids.push(e.id);
    day.total += gbp(e);
    meals.set(e.date, day);
  }
  const caps: Violation[] = [...meals.entries()]
    .filter(([, day]) => day.total > MEALS_DAILY_CAP)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, day]): Violation => ({
      code: "MEALS_DAILY_CAP",
      severity: "error",
      expenseIds: day.ids,
      message: `Meals on ${date} add up to more than £50.00.`,
    }));

  const weekends: Violation[] = expenses
    .filter((e) => {
      const day = new Date(`${e.date}T00:00:00Z`).getUTCDay();
      return day === 0 || day === 6;
    })
    .map((e): Violation => ({
      code: "WEEKEND",
      severity: "warning",
      expenseIds: [e.id],
      message: `Expense ${e.id} is dated on a weekend.`,
    }));

  return [...receipts, ...caps, ...weekends];
}

export function checkPolicy(ctx: Ctx): Result {
  const { expenseIds } = parseJsonObject(ctx.rawBody);
  if (!Array.isArray(expenseIds) || !expenseIds.every((x) => typeof x === "string")) {
    throw validationError([{ field: "expenseIds", message: "Must be an array of strings" }]);
  }
  const expenses = expenseIds.map((id: string) => findExpense(ctx.store, id));
  return { status: 200, body: { violations: evaluatePolicy(expenses) } };
}
