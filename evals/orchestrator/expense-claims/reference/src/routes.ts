import { createExpense, deleteExpense, getExpense, listExpenses, updateExpense } from "./expenses.ts";
import { checkPolicy } from "./policy.ts";
import {
  approveReport,
  attachExpense,
  createReport,
  detachExpense,
  getReport,
  rejectReport,
  submitReport,
} from "./reports.ts";
import type { Route } from "./router.ts";

export const routes: Route[] = [
  { method: "GET", path: "/health", handler: () => ({ status: 200, body: { status: "ok" } }) },
  { method: "POST", path: "/expenses", handler: createExpense },
  { method: "GET", path: "/expenses", handler: listExpenses },
  { method: "GET", path: "/expenses/:id", handler: getExpense },
  { method: "PATCH", path: "/expenses/:id", handler: updateExpense },
  { method: "DELETE", path: "/expenses/:id", handler: deleteExpense },
  { method: "POST", path: "/policy/check", handler: checkPolicy },
  { method: "POST", path: "/reports", handler: createReport },
  { method: "GET", path: "/reports/:id", handler: getReport },
  { method: "POST", path: "/reports/:id/expenses", handler: attachExpense },
  { method: "DELETE", path: "/reports/:id/expenses/:expenseId", handler: detachExpense },
  { method: "POST", path: "/reports/:id/submit", handler: submitReport },
  { method: "POST", path: "/reports/:id/approve", handler: approveReport },
  { method: "POST", path: "/reports/:id/reject", handler: rejectReport },
];
