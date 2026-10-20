import { parseCsv } from "./csv.ts";
import { addExpense, checkField, type ExpenseFields } from "./expenses.ts";
import { HttpError, type ErrorDetail } from "./http.ts";
import type { Ctx, Result } from "./router.ts";

const REQUIRED = ["date", "merchant", "category", "amount", "currency"] as const;
const CHECKED = ["date", "merchant", "category", "currency"] as const;

interface RowError {
  line: number;
  details: ErrorDetail[];
}

// Major units with up to two decimals, as integer minor units; null when the format is wrong.
function parseAmount(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function importExpenses(ctx: Ctx): Result {
  const mediaType = String(ctx.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "text/csv") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "The request body must be text/csv");
  }

  const [header, ...rows] = parseCsv(ctx.rawBody);
  if (header?.error) {
    throw new HttpError(400, "INVALID_CSV", "The CSV header is not valid CSV", [
      { field: "row", message: `Line ${header.line}: ${header.error}` },
    ]);
  }
  const columns = header?.fields ?? [];
  const missing = REQUIRED.filter((name) => !columns.includes(name));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      "INVALID_CSV",
      "The CSV header is missing required columns",
      missing.map((name) => ({ field: name, message: "Required column is missing" })),
    );
  }

  const created: string[] = [];
  const errors: RowError[] = [];
  for (const row of rows) {
    if (row.error) {
      errors.push({ line: row.line, details: [{ field: "row", message: row.error }] });
      continue;
    }
    if (row.fields.length !== columns.length) {
      errors.push({ line: row.line, details: [{ field: "row", message: `Must have ${columns.length} fields` }] });
      continue;
    }
    const value = (name: string): string | undefined => {
      const index = columns.indexOf(name);
      return index === -1 ? undefined : row.fields[index];
    };

    const details: ErrorDetail[] = [];
    for (const name of CHECKED) {
      const message = checkField(name, value(name));
      if (message) details.push({ field: name, message });
    }
    const amount = parseAmount(value("amount")!);
    const amountError =
      amount === null ? "Must be digits, optionally with a . and one or two digits" : checkField("amount", amount);
    if (amountError) details.push({ field: "amount", message: amountError });
    const receipt = value("receipt") ?? "";
    if (receipt !== "true" && receipt !== "false" && receipt !== "") {
      details.push({ field: "receipt", message: "Must be true or false" });
    }
    if (details.length > 0) {
      errors.push({ line: row.line, details });
      continue;
    }

    const fields = {
      date: value("date"),
      merchant: value("merchant"),
      category: value("category"),
      amount,
      currency: value("currency"),
      description: value("description") ?? "",
      receipt: receipt === "true",
    } as ExpenseFields;
    created.push(addExpense(ctx.store, fields).id);
  }

  return { status: 200, body: { created, errors } };
}
