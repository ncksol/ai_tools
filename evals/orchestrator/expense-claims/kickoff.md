Implement v2 of the expense claims API in this repository.

The v2 spec is below. It is also in the repository at `docs/spec-v2.md`. Build every feature in it. `README.md` describes the v1 code and its conventions; follow them.

Approvals, given now:

- Your plan is approved. You don't need to wait for me to review it.
- You may open pull requests, mark them ready for review, and squash-merge each one into `main` once its CI is green.

You are done when every feature in the spec is merged into `main` through pull requests and CI on `main` is green. Then send me a final report that says the work is done.

---

# Expense claims API: v2 spec

This release adds the features below to the v1 API described in `README.md`. Each feature has its own section. Everything in `README.md` (endpoints, field rules, error format and conventions) still applies, unless a rule here says otherwise.

## General rules

- G1. Every new endpoint is an entry in the route table in `src/routes.ts` and a row in the endpoint table in `README.md`.
- G2. Errors use the v1 error format. Each section lists the new error codes it uses.
- G3. Money amounts are whole numbers in minor units. Every currency conversion uses `convert()` from `src/money.ts`, which rounds each converted amount half up.
- G4. When a request has more than one problem, the response reports the first of these that applies:
  1. 404 for a resource named in the path;
  2. 415 or 400 for the request body or query string;
  3. 404 for an expense named in the request body;
  4. 409 for the state of a report or expense.
- G5. Dates are calendar dates. The day of the week is that of the calendar date; Saturday and Sunday are weekend days.

## Feature: Policy

Policy checks expenses against the company's spending rules.

`src/policy.ts` exports `evaluatePolicy`. Reports also uses it, so keep this signature exactly. `Expense` is the expense type exported by `src/expenses.ts`.

```ts
export type PolicyCode = "RECEIPT_REQUIRED" | "MEALS_DAILY_CAP" | "WEEKEND";

export interface Violation {
  code: PolicyCode;
  severity: "error" | "warning";
  expenseIds: string[];
  message: string;
}

export function evaluatePolicy(expenses: Expense[]): Violation[];
```

The rules compare GBP equivalents: an expense's GBP equivalent is `convert(amount, currency, "GBP")`.

- P1. `RECEIPT_REQUIRED`, severity `error`: an expense whose GBP equivalent is more than 2500 (£25.00) and whose `receipt` is `false`. One violation per expense, with that expense's id in `expenseIds`. An expense of exactly 2500 does not need a receipt.
- P2. `MEALS_DAILY_CAP`, severity `error`: a date on which the `meals` expenses add up to more than 5000 (£50.00). Each expense is converted to GBP first, and the GBP equivalents are then added. One violation per date, with the ids of all the `meals` expenses on that date in `expenseIds`, in input order. A total of exactly 5000 is allowed. Only `meals` expenses count.
- P3. `WEEKEND`, severity `warning`: an expense dated on a Saturday or Sunday. One violation per expense, with that expense's id in `expenseIds`.
- P4. Order of the result: all `RECEIPT_REQUIRED` violations in input order, then all `MEALS_DAILY_CAP` violations by date, earliest first, then all `WEEKEND` violations in input order.
- P5. `message` is a non-empty sentence for people to read. Its wording is free.
- P6. When no rule applies, the result is an empty array.

### POST /policy/check

- P7. The body is `{ "expenseIds": string[] }`. The array may be empty. The input order is the order of `expenseIds`.
- P8. The response is 200 with `{ "violations": Violation[] }`: the result of `evaluatePolicy` for those expenses.
- P9. If `expenseIds` is missing or is not an array of strings, the response is 400 `VALIDATION_ERROR` with field `expenseIds`.
- P10. If an id in `expenseIds` matches no expense, the response is 404 `NOT_FOUND`.

## Feature: Reports

A report groups expenses so that they can be approved together.

Report object:

| Field | Type | Notes |
|---|---|---|
| `id` | string | Set by the server. |
| `title` | string | Must contain at least one character that is not a space. |
| `status` | string | `draft`, `submitted`, `approved` or `rejected`. |
| `expenseIds` | string[] | In the order the expenses were attached. |
| `rejectionReason` | string or null | `null` unless the report was rejected. |

Endpoints:

| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/reports` | `{ "title": string }` | 201 and the new report: status `draft`, no expenses |
| GET | `/reports/:id` | | 200 and the report |
| POST | `/reports/:id/expenses` | `{ "expenseId": string }` | 200 and the report, with the expense attached at the end |
| DELETE | `/reports/:id/expenses/:expenseId` | | 200 and the report, with the expense detached |
| POST | `/reports/:id/submit` | | 200 and the report, status `submitted` |
| POST | `/reports/:id/approve` | | 200 and the report, status `approved` |
| POST | `/reports/:id/reject` | `{ "reason": string }` | 200 and the report, status `rejected` |

Rules:

- R1. A report id that matches no report returns 404 `NOT_FOUND`.
- R2. Creating a report with `title` missing, not a string or blank returns 400 `VALIDATION_ERROR` with field `title`.
- R3. Attaching with `expenseId` missing or not a string returns 400 `VALIDATION_ERROR` with field `expenseId`. An `expenseId` that matches no expense returns 404 `NOT_FOUND`.
- R4. Expenses can be attached and detached only while the report is `draft`. Otherwise the response is 409 `INVALID_STATE`.
- R5. An expense can be in at most one report that is not `rejected`. Attaching an expense that is already in such a report, this one or another, returns 409 `EXPENSE_IN_REPORT`. When both R4 and R5 apply, R4 wins.
- R6. Detaching an expense that is not in the report returns 404 `NOT_FOUND`. This 404 comes before the 409 of R4.
- R7. Status changes: submit moves `draft` to `submitted`; approve moves `submitted` to `approved`; reject moves `submitted` to `rejected`. Any other change returns 409 `INVALID_STATE`. `approved` and `rejected` are final.
- R8. Submitting a `draft` report that has no expenses returns 409 `REPORT_EMPTY`.
- R9. Submit runs `evaluatePolicy` on the report's expenses, in `expenseIds` order. If any violation has severity `error`, the submit is refused: 409 `POLICY_VIOLATION`, and `error.details` holds the error-severity violations, as `Violation` objects in policy order, instead of field entries. Warnings never block a submit. A refused report stays `draft`.
- R10. Rejecting with `reason` missing, not a string or blank returns 400 `VALIDATION_ERROR` with field `reason`. A rejected report keeps the reason in `rejectionReason`.
- R11. While an expense is in a `submitted` or `approved` report, `PATCH /expenses/:id` and `DELETE /expenses/:id` for it return 409 `EXPENSE_LOCKED`. Expenses in `draft` or `rejected` reports can be changed and deleted.
- R12. Deleting an expense also removes its id from every report that lists it.
- R13. A rejected report keeps its `expenseIds` (apart from expenses deleted later, see R12). Its expenses are no longer locked and can be attached to another report.

## Feature: CSV import

### POST /expenses/import

Creates expenses from a CSV file sent as the request body.

- I1. The request's `Content-Type` must be `text/csv`. Parameters are allowed, for example `text/csv; charset=utf-8`. Any other content type returns 415 `UNSUPPORTED_MEDIA_TYPE`.
- I2. The body is CSV as defined by RFC 4180. Fields are separated by commas. Rows end with `\n` or `\r\n`, and the last row may or may not end with one. A field may be wrapped in double quotes. A quoted field may contain commas, line breaks and doubled double quotes (`""` stands for one `"`).
- I3. The first row is the header. Required columns: `date`, `merchant`, `category`, `amount`, `currency`. Optional columns: `description`, `receipt`. Columns can come in any order. Header names must match exactly: lowercase, with no spaces around them. Columns with other names are ignored.
- I4. If any required column is missing, nothing is imported: the response is 400 `INVALID_CSV`, with one `details` entry per missing column, whose `field` is the column name. An empty body counts as a file with no columns.
- I5. Each row after the header describes one expense. Values are used exactly as written, without trimming spaces:
  - `date`, `merchant`, `category` and `currency` follow the same rules as in `POST /expenses`.
  - `amount` is written in major units: digits, then optionally a `.` and one or two digits (for example `12`, `12.5` or `12.50`). It is stored in minor units, so `12.5` becomes `1250`. It must be greater than 0.
  - `description` is any text. An empty value, or no `description` column, gives `""`.
  - `receipt` is `true` or `false`. An empty value, or no `receipt` column, gives `false`. Any other value is invalid.
- I6. A row with a different number of fields from the header is invalid, with a single error whose `field` is `row`.
- I7. A completely empty line is skipped. It is not an error, but it still counts when lines are numbered.
- I8. A row's line number is the line of the file on which the row starts. The header is line 1. A quoted field that contains line breaks makes its row span several lines, and the next row's number counts all of them.
- I9. Valid rows are created even when other rows are invalid. They are created in file order.
- I10. When the header is valid, the response is 200 with:

  ```json
  {
    "created": ["<id>", "<id>"],
    "errors": [{ "line": 4, "details": [{ "field": "amount", "message": "Must be greater than 0" }] }]
  }
  ```

  `created` holds the new expenses' ids, in file order. `errors` has one entry per invalid row, in file order, with one `details` entry per invalid field. Both arrays may be empty.

## Feature: Summary

### GET /summary

Returns the month's spending per category in one currency: `GET /summary?month=YYYY-MM&currency=GBP`.

- S1. `month` is required and must be written as `YYYY-MM`, with a month from `01` to `12`. `currency` is required and must be `GBP`, `EUR` or `USD`. Otherwise the response is 400 `VALIDATION_ERROR`, with one `details` entry per invalid parameter, whose `field` is `month` or `currency`.
- S2. The summary covers the expenses whose `date` is in that month.
- S3. Each expense is first converted to `currency` with `convert()`, which rounds it, and the converted amounts are then added.
- S4. The response is 200 with:

  ```json
  {
    "month": "2026-03",
    "currency": "GBP",
    "count": 3,
    "total": 4250,
    "categories": { "meals": 1200, "travel": 3050, "lodging": 0, "other": 0 }
  }
  ```

  `categories` always has all four categories, with 0 for a category that has no expenses. `count` is the number of expenses covered. `total` is the sum of the four category amounts.
- S5. Summary ignores reports: expenses count whatever the state of any report they are in.
