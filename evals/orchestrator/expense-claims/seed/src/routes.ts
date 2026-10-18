import { createExpense, deleteExpense, getExpense, listExpenses, updateExpense } from "./expenses.ts";
import type { Route } from "./router.ts";

export const routes: Route[] = [
  { method: "GET", path: "/health", handler: () => ({ status: 200, body: { status: "ok" } }) },
  { method: "POST", path: "/expenses", handler: createExpense },
  { method: "GET", path: "/expenses", handler: listExpenses },
  { method: "GET", path: "/expenses/:id", handler: getExpense },
  { method: "PATCH", path: "/expenses/:id", handler: updateExpense },
  { method: "DELETE", path: "/expenses/:id", handler: deleteExpense },
];
