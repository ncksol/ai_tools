import { notFound, parseJsonObject, validationError, type ErrorDetail } from "./http.ts";
import { isCurrency, type Currency } from "./money.ts";
import type { Ctx, Result } from "./router.ts";
import type { Store } from "./store.ts";

export const CATEGORIES = ["meals", "travel", "lodging", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Expense {
  id: string;
  date: string;
  merchant: string;
  category: Category;
  amount: number;
  currency: Currency;
  description: string;
  receipt: boolean;
}

export type ExpenseFields = Omit<Expense, "id">;

const FIELDS = ["date", "merchant", "category", "amount", "currency", "description", "receipt"] as const;
const REQUIRED: readonly string[] = ["date", "merchant", "category", "amount", "currency"];

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// Returns an error message when the value breaks the field's rule, or null when it is valid.
export function checkField(name: string, value: unknown): string | null {
  switch (name) {
    case "date":
      return isValidDate(value) ? null : "Must be a real date written as YYYY-MM-DD";
    case "merchant":
      return typeof value === "string" && value.trim() !== "" ? null : "Must not be blank";
    case "category":
      return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value)
        ? null
        : `Must be one of ${CATEGORIES.join(", ")}`;
    case "amount":
      return Number.isInteger(value) && (value as number) > 0 ? null : "Must be a whole number greater than 0";
    case "currency":
      return isCurrency(value) ? null : "Must be one of GBP, EUR, USD";
    case "description":
      return typeof value === "string" ? null : "Must be a string";
    case "receipt":
      return typeof value === "boolean" ? null : "Must be true or false";
    default:
      return null;
  }
}

export function validateFields(
  input: Record<string, unknown>,
  partial: boolean,
): { fields: Partial<ExpenseFields>; errors: ErrorDetail[] } {
  const fields: Record<string, unknown> = {};
  const errors: ErrorDetail[] = [];
  for (const name of FIELDS) {
    const value = input[name];
    if (value === undefined) {
      if (!partial && REQUIRED.includes(name)) errors.push({ field: name, message: "Required" });
      continue;
    }
    const message = checkField(name, value);
    if (message) errors.push({ field: name, message });
    else fields[name] = value;
  }
  return { fields: fields as Partial<ExpenseFields>, errors };
}

export function addExpense(store: Store, fields: ExpenseFields): Expense {
  const expense: Expense = { id: store.nextId("exp"), ...fields };
  store.expenses.set(expense.id, expense);
  return expense;
}

export function findExpense(store: Store, id: string): Expense {
  const expense = store.expenses.get(id);
  if (!expense) throw notFound("Expense");
  return expense;
}

export function createExpense(ctx: Ctx): Result {
  const { fields, errors } = validateFields(parseJsonObject(ctx.rawBody), false);
  if (errors.length > 0) throw validationError(errors);
  const expense = addExpense(ctx.store, { description: "", receipt: false, ...fields } as ExpenseFields);
  return { status: 201, body: expense };
}

export function listExpenses(ctx: Ctx): Result {
  const category = ctx.query.get("category");
  const from = ctx.query.get("from");
  const to = ctx.query.get("to");
  const errors: ErrorDetail[] = [];
  if (category !== null && checkField("category", category)) errors.push({ field: "category", message: "Unknown category" });
  if (from !== null && !isValidDate(from)) errors.push({ field: "from", message: "Must be a date written as YYYY-MM-DD" });
  if (to !== null && !isValidDate(to)) errors.push({ field: "to", message: "Must be a date written as YYYY-MM-DD" });
  if (errors.length > 0) throw validationError(errors);
  const expenses = [...ctx.store.expenses.values()].filter(
    (e) => (category === null || e.category === category) && (from === null || e.date >= from) && (to === null || e.date <= to),
  );
  return { status: 200, body: { expenses } };
}

export function getExpense(ctx: Ctx): Result {
  return { status: 200, body: findExpense(ctx.store, ctx.params.id) };
}

export function updateExpense(ctx: Ctx): Result {
  const expense = findExpense(ctx.store, ctx.params.id);
  const { fields, errors } = validateFields(parseJsonObject(ctx.rawBody), true);
  if (errors.length > 0) throw validationError(errors);
  Object.assign(expense, fields);
  return { status: 200, body: expense };
}

export function deleteExpense(ctx: Ctx): Result {
  findExpense(ctx.store, ctx.params.id);
  ctx.store.expenses.delete(ctx.params.id);
  return { status: 204 };
}
