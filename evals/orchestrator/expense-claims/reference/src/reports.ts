import { findExpense } from "./expenses.ts";
import { HttpError, notFound, parseJsonObject, validationError } from "./http.ts";
import { evaluatePolicy } from "./policy.ts";
import type { Ctx, Result } from "./router.ts";
import type { Store } from "./store.ts";

export type ReportStatus = "draft" | "submitted" | "approved" | "rejected";

export interface Report {
  id: string;
  title: string;
  status: ReportStatus;
  expenseIds: string[];
  rejectionReason: string | null;
}

function findReport(store: Store, id: string): Report {
  const report = store.reports.get(id);
  if (!report) throw notFound("Report");
  return report;
}

function invalidState(report: Report, action: string): HttpError {
  return new HttpError(409, "INVALID_STATE", `Cannot ${action} a ${report.status} report`);
}

function nonBlank(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError([{ field, message: "Must not be blank" }]);
  }
  return value;
}

function reportsListing(store: Store, expenseId: string, statuses: readonly ReportStatus[]): Report[] {
  return [...store.reports.values()].filter((r) => statuses.includes(r.status) && r.expenseIds.includes(expenseId));
}

export function assertExpenseUnlocked(store: Store, expenseId: string): void {
  if (reportsListing(store, expenseId, ["submitted", "approved"]).length > 0) {
    throw new HttpError(409, "EXPENSE_LOCKED", "The expense is in a submitted or approved report");
  }
}

export function removeExpenseFromReports(store: Store, expenseId: string): void {
  for (const report of store.reports.values()) {
    report.expenseIds = report.expenseIds.filter((id) => id !== expenseId);
  }
}

export function createReport(ctx: Ctx): Result {
  const title = nonBlank(parseJsonObject(ctx.rawBody), "title");
  const report: Report = { id: ctx.store.nextId("rep"), title, status: "draft", expenseIds: [], rejectionReason: null };
  ctx.store.reports.set(report.id, report);
  return { status: 201, body: report };
}

export function getReport(ctx: Ctx): Result {
  return { status: 200, body: findReport(ctx.store, ctx.params.id) };
}

export function attachExpense(ctx: Ctx): Result {
  const report = findReport(ctx.store, ctx.params.id);
  const { expenseId } = parseJsonObject(ctx.rawBody);
  if (typeof expenseId !== "string") throw validationError([{ field: "expenseId", message: "Must be a string" }]);
  findExpense(ctx.store, expenseId);
  if (report.status !== "draft") throw invalidState(report, "attach expenses to");
  if (reportsListing(ctx.store, expenseId, ["draft", "submitted", "approved"]).length > 0) {
    throw new HttpError(409, "EXPENSE_IN_REPORT", "The expense is already in a report");
  }
  report.expenseIds.push(expenseId);
  return { status: 200, body: report };
}

export function detachExpense(ctx: Ctx): Result {
  const report = findReport(ctx.store, ctx.params.id);
  const { expenseId } = ctx.params;
  if (!report.expenseIds.includes(expenseId)) throw notFound("Expense in report");
  if (report.status !== "draft") throw invalidState(report, "detach expenses from");
  report.expenseIds = report.expenseIds.filter((id) => id !== expenseId);
  return { status: 200, body: report };
}

export function submitReport(ctx: Ctx): Result {
  const report = findReport(ctx.store, ctx.params.id);
  if (report.status !== "draft") throw invalidState(report, "submit");
  if (report.expenseIds.length === 0) throw new HttpError(409, "REPORT_EMPTY", "The report has no expenses");
  const expenses = report.expenseIds.map((id) => findExpense(ctx.store, id));
  const errors = evaluatePolicy(expenses).filter((v) => v.severity === "error");
  if (errors.length > 0) {
    throw new HttpError(409, "POLICY_VIOLATION", "The report breaks the expense policy", errors);
  }
  report.status = "submitted";
  return { status: 200, body: report };
}

export function approveReport(ctx: Ctx): Result {
  const report = findReport(ctx.store, ctx.params.id);
  if (report.status !== "submitted") throw invalidState(report, "approve");
  report.status = "approved";
  return { status: 200, body: report };
}

export function rejectReport(ctx: Ctx): Result {
  const report = findReport(ctx.store, ctx.params.id);
  const reason = nonBlank(parseJsonObject(ctx.rawBody), "reason");
  if (report.status !== "submitted") throw invalidState(report, "reject");
  report.status = "rejected";
  report.rejectionReason = reason;
  return { status: 200, body: report };
}
