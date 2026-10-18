# Orchestrator Speed-Eval Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the expense-claims speed eval for orchestrator agents: a small v1 seed app, its v2 spec, a hidden black-box acceptance suite, a reference v2 implementation that passes it, and two scripts (`new-run`, `score`) plus a runbook, all under `evals/orchestrator/expense-claims/`.

**Architecture:** Everything is TypeScript run directly by Node 24 (type stripping) with `node:test` and no npm dependencies. `seed/` is the only content that ever goes into a run repo. `acceptance/` starts the app under test as a child process per test and checks it over HTTP. `reference/` is the seed plus the four v2 features, used only to prove the suite is correct and passable. `scripts/` holds the suite runner, `new-run` (builds a private run repo from the seed) and `score` (times a run from the orchestrator session's `events.jsonl`, gates it on the suite, appends to `results.csv`).

**Tech Stack:** Node.js 24 (local v24.19.0) built-ins only: `node:test`, `node:http`, `node:child_process`, `node:fs`, `node:util` `parseArgs`; `git` and the `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-18-orchestrator-eval-design.md` (approved by the user in full). Executors read it, and the contract documents below, before starting.

## Contract documents (already committed; read, don't change)

These were written with the plan and are inputs to every task. Changing one needs a ruling from the controller.

| File | What it fixes |
|---|---|
| `evals/orchestrator/expense-claims/seed/README.md` | The v1 contract: endpoints, field rules, error format and codes, money rule, file layout, conventions. |
| `evals/orchestrator/expense-claims/seed/docs/spec-v2.md` | The v2 task, with numbered rules G1–G5, P1–P10, R1–R13, I1–I10, S1–S5. Feature sections start with `## Feature: Policy`, `## Feature: Reports`, `## Feature: CSV import`, `## Feature: Summary`, in that order, and Summary is last. |
| `evals/orchestrator/expense-claims/kickoff.md` | The exact kickoff prompt: instructions, a `---` line, then `seed/docs/spec-v2.md` verbatim. |
| `evals/orchestrator/expense-claims/answers.md` | The answer sheet. |

## Global Constraints

- Kit root: `evals/orchestrator/expense-claims/`. Change only files under it, plus `.github/copilot-instructions.md` (Task 7 only).
- Node 24 (local v24.19.0). TypeScript runs through Node's type stripping, with no flags and no build step. Tests use the built-in `node:test` runner. No npm dependencies: no `dependencies` or `devDependencies` in any `package.json`.
- Erasable TypeScript only: no `enum`, `namespace`, parameter properties, `import x = require()` or `export =`. Use JavaScript `#private` fields, not the `private` keyword.
- Relative imports include the `.ts` extension. Type-only imports use `import type { X }` or an inline `type` modifier (`import { a, type B }`); a plain import of a type-only export fails at runtime.
- Every `package.json` in the kit has `"private": true` and `"type": "module"`.
- Only `seed/` content goes into a run repo. `acceptance/`, `reference/`, `results.csv`, `kickoff.md`, `answers.md` and `scripts/` never do. Nothing in `seed/` mentions the acceptance suite or the reference implementation.
- Never create a GitHub repo or any other external resource. `new-run` is run for real only by the user; during the build it runs with `--dry-run` or with a fake `gh` in tests.
- Never start an orchestrator run, as a child session or in any other way. Runs are top-level sessions the user starts.
- Files under `~/.copilot/session-state/` are read-only: never write, move or delete them. Never copy message contents from them into the repo. Test fixtures are synthetic.
- Every acceptance-suite assertion maps to a statement in `seed/docs/spec-v2.md` or `seed/README.md`. Each suite test's name starts with the rule id (`P1`, `R9`, `I8`, …) or `README <section>` it checks.
- Feature names, in this order everywhere: `policy`, `reports`, `import`, `summary`. A feature set is written as the names joined by `+`, for example `policy+reports+import+summary`.
- Conventional commit messages (`feat(evals): …`, `test(evals): …`, `docs(evals): …`). No `Co-authored-by` trailer or other AI attribution.

## File structure

```text
evals/orchestrator/expense-claims/
  README.md                 runbook (Task 7)
  kickoff.md                contract document
  answers.md                contract document
  results.csv               header row only (Task 7)
  package.json              kit scripts: test, acceptance, new-run, score, check (Tasks 2, 5, 6, 7)
  seed/                     v1 app (Task 1); README.md and docs/spec-v2.md are contract documents
    package.json  .gitignore  .github/workflows/ci.yml
    src/app.ts server.ts routes.ts router.ts http.ts store.ts money.ts expenses.ts
    test/helpers.ts money.test.ts router.test.ts expenses.test.ts
  reference/                seed + v2 (Tasks 3, 4)
    src/… + policy.ts reports.ts csv.ts import.ts summary.ts
    test/… + policy.test.ts reports.test.ts csv.test.ts import.test.ts summary.test.ts
  acceptance/               hidden suite (Task 2)
    helpers.ts v1.test.ts policy.test.ts reports.test.ts import.test.ts summary.test.ts
  scripts/
    acceptance.ts new-run.ts score.ts check-kit.ts
    lib/features.ts suite.ts new-run.ts events.ts results.ts proc.ts
    test/*.test.ts  test/fixtures/…
```

Dependencies between tasks: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Run them in order, one at a time.

---

### Task 1: Seed v1 app

**Files:**
- Create: `seed/package.json`, `seed/.gitignore`, `seed/.github/workflows/ci.yml`
- Create: `seed/src/money.ts`, `seed/src/http.ts`, `seed/src/router.ts`, `seed/src/store.ts`, `seed/src/expenses.ts`, `seed/src/routes.ts`, `seed/src/app.ts`, `seed/src/server.ts`
- Create: `seed/test/helpers.ts`, `seed/test/money.test.ts`, `seed/test/router.test.ts`, `seed/test/expenses.test.ts`
- Read only: `seed/README.md` (the contract this task implements)

All paths in this task are relative to `evals/orchestrator/expense-claims/`.

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks and every eval run rely on these names):
  - `src/money.ts`: `CURRENCIES`, `type Currency`, `RATES`, `isCurrency(value: unknown): value is Currency`, `convert(amountMinor: number, from: Currency, to: Currency): number`.
  - `src/http.ts`: `interface ErrorDetail { field: string; message: string }`, `class HttpError(status, code, message, details = [])`, `validationError(details: ErrorDetail[]): HttpError`, `notFound(what: string): HttpError`, `readBody`, `parseJsonObject(raw: string): Record<string, unknown>`, `sendJson`, `errorBody`.
  - `src/router.ts`: `interface Ctx { method; path; params; query: URLSearchParams; headers; rawBody: string; store: Store }`, `interface Result { status: number; body?: unknown }`, `type Handler`, `interface Route { method; path; handler }`, `matchRoute(routes, method, path)`.
  - `src/store.ts`: `class Store { expenses: Map<string, Expense>; nextId(prefix: string): string }`.
  - `src/expenses.ts`: `CATEGORIES`, `type Category`, `interface Expense`, `type ExpenseFields = Omit<Expense, "id">`, `isValidDate(value: unknown): value is string`, `checkField(name: string, value: unknown): string | null`, `validateFields(input, partial)`, `addExpense(store, fields: ExpenseFields): Expense`, `findExpense(store, id): Expense`, and the handlers `createExpense`, `listExpenses`, `getExpense`, `updateExpense`, `deleteExpense`.
  - `src/app.ts`: `createApp(): http.Server` (each app has its own new `Store`).
  - `test/helpers.ts`: `startTestApp(): Promise<TestApp>`.

- [ ] **Step 1: Write the package, CI and ignore files**

`seed/package.json`:

```json
{
  "name": "expense-claims",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/server.ts",
    "test": "node --test \"test/**/*.test.ts\""
  }
}
```

`seed/.gitignore`:

```text
node_modules/
.DS_Store
```

`seed/.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm test
```

- [ ] **Step 2: Write the failing money and router tests**

`seed/test/money.test.ts` must contain these tests (all values exact):

| Test | Assertion |
|---|---|
| `convert keeps the amount when the currencies match` | `convert(1234, "GBP", "GBP") === 1234` and `convert(1, "USD", "USD") === 1` |
| `convert uses the fixed rates` | `convert(100, "EUR", "GBP") === 85`, `convert(100, "USD", "GBP") === 80`, `convert(80, "USD", "EUR") === 75` |
| `convert rounds half up` | `convert(10, "EUR", "GBP") === 9` (8.5), `convert(100, "GBP", "EUR") === 118` (117.6…), `convert(3125, "USD", "GBP") === 2500`, `convert(3126, "USD", "GBP") === 2501` |
| `isCurrency accepts only GBP, EUR and USD` | true for the three; false for `"JPY"`, `"gbp"`, `1`, `undefined` |

`seed/test/router.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRoute, type Route } from "../src/router.ts";

const ok = () => ({ status: 200 });
const routes: Route[] = [
  { method: "GET", path: "/expenses", handler: ok },
  { method: "GET", path: "/expenses/:id", handler: ok },
  { method: "POST", path: "/expenses", handler: ok },
];

test("matchRoute matches a static path and method", () => {
  const match = matchRoute(routes, "POST", "/expenses");
  assert.equal(match?.route, routes[2]);
  assert.deepEqual(match?.params, {});
});

test("matchRoute extracts :param segments", () => {
  const match = matchRoute(routes, "GET", "/expenses/exp_7");
  assert.equal(match?.route, routes[1]);
  assert.deepEqual(match?.params, { id: "exp_7" });
});

test("matchRoute returns null when nothing matches", () => {
  assert.equal(matchRoute(routes, "DELETE", "/expenses"), null);
  assert.equal(matchRoute(routes, "GET", "/expenses/exp_7/extra"), null);
  assert.equal(matchRoute(routes, "GET", "/nope"), null);
});
```

Run: `cd evals/orchestrator/expense-claims/seed && npm test`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `src/money.ts`, `src/http.ts`, `src/router.ts`, `src/store.ts`**

`seed/src/money.ts`:

```ts
export const CURRENCIES = ["GBP", "EUR", "USD"] as const;
export type Currency = (typeof CURRENCIES)[number];

// The value of one unit in GBP, times 10 000.
export const RATES: Record<Currency, number> = { GBP: 10000, EUR: 8500, USD: 8000 };

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

// amountMinor × rate(from) ÷ rate(to), rounded half up to a whole minor unit.
export function convert(amountMinor: number, from: Currency, to: Currency): number {
  const numerator = amountMinor * RATES[from];
  const denominator = RATES[to];
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}
```

`seed/src/http.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

export interface ErrorDetail {
  field: string;
  message: string;
}

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown[];

  constructor(status: number, code: string, message: string, details: unknown[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validationError(details: ErrorDetail[]): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", "Some fields are invalid", details);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, "NOT_FOUND", `${what} not found`);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_JSON", "The request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function errorBody(err: HttpError): unknown {
  return { error: { code: err.code, message: err.message, details: err.details } };
}
```

`seed/src/router.ts`:

```ts
import type { IncomingHttpHeaders } from "node:http";
import type { Store } from "./store.ts";

export interface Ctx {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  rawBody: string;
  store: Store;
}

export interface Result {
  status: number;
  body?: unknown;
}

export type Handler = (ctx: Ctx) => Result | Promise<Result>;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

export function matchRoute(routes: Route[], method: string, path: string): Match | null {
  const parts = segments(path);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = segments(route.path);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const matched = pattern.every((segment, i) => {
      if (segment.startsWith(":")) {
        params[segment.slice(1)] = decodeSegment(parts[i]);
        return true;
      }
      return segment === parts[i];
    });
    if (matched) return { route, params };
  }
  return null;
}

function segments(path: string): string[] {
  return path.split("/").filter((part) => part !== "");
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
```

`seed/src/store.ts`:

```ts
import type { Expense } from "./expenses.ts";

export class Store {
  expenses = new Map<string, Expense>();
  #seq = 0;

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq}`;
  }
}
```

Run: `npm test` (from `seed/`). Expected: money and router tests PASS; nothing else exists yet.

- [ ] **Step 4: Write the failing API tests and the test helper**

`seed/test/helpers.ts`:

```ts
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";

export interface TestResponse {
  status: number;
  body: any;
  headers: Headers;
}

export interface TestApp {
  url: string;
  request(method: string, path: string, body?: unknown): Promise<TestResponse>;
  close(): Promise<void>;
}

// Starts the app on a random port. A string body is sent as is; any other body is sent as JSON.
export async function startTestApp(): Promise<TestApp> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    async request(method, path, body) {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      const res = await fetch(url + path, init);
      const text = await res.text();
      return { status: res.status, body: text === "" ? undefined : JSON.parse(text), headers: res.headers };
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
```

`seed/test/expenses.test.ts` starts one app per file (`before`/`after`) and contains these tests. Use `const valid = { date: "2026-03-04", merchant: "Cafe Rio", category: "meals", amount: 1250, currency: "GBP" }` as the base expense.

| Test | Request | Expected |
|---|---|---|
| `GET /health returns ok` | GET `/health` | 200, `{ status: "ok" }`, `content-type` starts with `application/json` |
| `POST /expenses creates an expense with defaults` | POST `valid` | 201; body is `valid` plus `id` (non-empty string), `description: ""`, `receipt: false` |
| `POST /expenses keeps optional fields` | POST `{ ...valid, description: "Team lunch", receipt: true }` | 201; `description` and `receipt` as sent |
| `POST /expenses ignores id and unknown fields` | POST `{ ...valid, id: "mine", colour: "red" }` | 201; `id !== "mine"`; no `colour` key |
| `POST /expenses reports every missing field` | POST `{}` | 400 `VALIDATION_ERROR`; `details` fields (as a set) = `date, merchant, category, amount, currency` |
| `POST /expenses rejects invalid values` | POST `{ date: "2026-02-30", merchant: "  ", category: "food", amount: 0, currency: "JPY", description: 5, receipt: "yes" }` | 400; `details` fields = all seven fields |
| `POST /expenses needs a whole-number amount` | POST `{ ...valid, amount: 12.5 }`, then `{ ...valid, amount: "1250" }` | 400 each, `details` fields = `["amount"]` |
| `POST /expenses rejects bad JSON` | POST raw `"{bad"`, then raw `"[1,2]"` | 400 `INVALID_JSON`, `details` `[]` each |
| `GET /expenses/:id returns the expense` | create, then GET by id | 200, same body as the create response |
| `GET /expenses/:id returns 404 for an unknown id` | GET `/expenses/nope` | 404; body `error.code` `NOT_FOUND`, `error.message` a string, `error.details` `[]` |
| `GET /expenses lists in creation order` | create dates `2026-03-09`, `2026-03-01`, `2026-03-05` | 200; `body.expenses` ids in creation order |
| `GET /expenses filters by category, from and to` | (fresh data in a nested app or unique dates) create A meals `2026-04-01`, B travel `2026-04-05`, C meals `2026-04-10`; query `?category=meals&from=2026-04-01&to=2026-04-30`, `?from=2026-04-05&to=2026-04-10`, `?category=travel&to=2026-04-05` | `[A, C]`, `[B, C]`, `[B]` (filter results to ids you created) |
| `GET /expenses rejects invalid filters` | `?category=food`, `?from=2026-13-01`, `?to=soon` | 400 each, `details[0].field` = `category`, `from`, `to` |
| `PATCH /expenses/:id changes only the fields sent` | create, PATCH `{ amount: 2000, id: "x" }` | 200; `amount` 2000, `id` unchanged, other fields unchanged; GET shows the same |
| `PATCH /expenses/:id validates and 404s` | PATCH `{ currency: "JPY" }` → 400 field `currency`; PATCH `/expenses/nope` `{}` → 404 | as stated |
| `DELETE /expenses/:id deletes` | create, DELETE → 204 and empty body; GET → 404; DELETE again → 404 | as stated |
| `an unknown route returns 404` | GET `/nope` | 404 `NOT_FOUND` |

Because the app is shared within the file, the filter test must only assert on ids it created (for example `body.expenses.map(e => e.id).filter(id => mine.includes(id))`), or use dates no other test uses (`2026-04-…` above).

Run: `npm test`. Expected: FAIL (`src/app.ts` missing).

- [ ] **Step 5: Write `src/expenses.ts`, `src/routes.ts`, `src/app.ts`, `src/server.ts`**

`seed/src/expenses.ts`:

```ts
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
```

`seed/src/routes.ts`:

```ts
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
```

`seed/src/app.ts`:

```ts
import { createServer, type Server } from "node:http";
import { HttpError, errorBody, readBody, sendJson } from "./http.ts";
import { matchRoute, type Ctx } from "./router.ts";
import { routes } from "./routes.ts";
import { Store } from "./store.ts";

export function createApp(): Server {
  const store = new Store();
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const match = matchRoute(routes, method, url.pathname);
      if (!match) throw new HttpError(404, "NOT_FOUND", `No route for ${method} ${url.pathname}`);
      const ctx: Ctx = {
        method,
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        headers: req.headers,
        rawBody: await readBody(req),
        store,
      };
      const result = await match.route.handler(ctx);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, errorBody(err));
      } else {
        console.error(err);
        sendJson(res, 500, errorBody(new HttpError(500, "INTERNAL", "Internal error")));
      }
    }
  });
}
```

`seed/src/server.ts`:

```ts
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, () => {
  console.log(`Expense claims API listening on http://localhost:${port}`);
});
```

- [ ] **Step 6: Run the tests and the server**

Run: `cd evals/orchestrator/expense-claims/seed && npm test`
Expected: PASS, about 25 tests, 0 failures, no warnings.

Run: `PORT=3917 node src/server.ts & sleep 1; curl -s localhost:3917/health; kill %1`
Expected: `{"status":"ok"}`.

- [ ] **Step 7: Commit**

```bash
git add evals/orchestrator/expense-claims/seed
git commit -m "feat(evals): add expense-claims v1 seed app"
```

---
### Task 2: Hidden acceptance suite and its runner

**Files:**
- Create: `package.json` (kit root), `acceptance/helpers.ts`, `acceptance/v1.test.ts`, `acceptance/policy.test.ts`, `acceptance/reports.test.ts`, `acceptance/import.test.ts`, `acceptance/summary.test.ts`
- Create: `scripts/lib/features.ts`, `scripts/lib/proc.ts`, `scripts/lib/suite.ts`, `scripts/acceptance.ts`, `scripts/test/suite.test.ts`
- Read only: `seed/README.md`, `seed/docs/spec-v2.md`

**Interfaces:**
- Consumes: the seed app from Task 1 (`npm start` = `node src/server.ts`, reads `PORT`; `GET /health`).
- Produces:
  - `scripts/lib/features.ts`: `FEATURES = ["policy", "reports", "import", "summary"] as const`, `type Feature`, `ALL_FEATURES: Feature[]`, `parseFeatures(value: string): Feature[]`, `featureSetName(features: readonly Feature[]): string`.
  - `scripts/lib/proc.ts`: `interface ProcResult { code: number; stdout: string; stderr: string }`, `run(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<ProcResult>` (never throws on a non-zero exit; rejects only if the command cannot start).
  - `scripts/lib/suite.ts`: `KIT_DIR` (absolute kit root), `suiteFiles(features: readonly Feature[]): string[]`, `suiteFile(name: "v1" | Feature): string`, `parseTap(output: string): TapSummary`, `runSuite(appDir: string, files: string[]): Promise<SuiteResult>`.
  - `scripts/acceptance.ts` CLI: `node scripts/acceptance.ts --app <dir> [--features <list>] [--only <v1|policy|reports|import|summary>] [--verbose]`. Exit 0 when every test passes.
  - The suite reads the app directory from the `EXPENSE_APP_DIR` environment variable.

- [ ] **Step 1: Write the kit `package.json` and the process helper**

`package.json` (kit root):

```json
{
  "name": "orchestrator-eval-expense-claims",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test \"scripts/test/*.test.ts\"",
    "acceptance": "node scripts/acceptance.ts"
  }
}
```

`scripts/lib/proc.ts`:

```ts
import { spawn } from "node:child_process";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
```

- [ ] **Step 2: Write `scripts/lib/features.ts` and the runner library, test-first**

`scripts/test/suite.test.ts` covers:

| Test | Assertion |
|---|---|
| `parseFeatures keeps canonical order and drops duplicates` | `parseFeatures("summary, policy,policy")` → `["policy", "summary"]` |
| `parseFeatures accepts an empty list` | `parseFeatures("")` → `[]` |
| `parseFeatures rejects unknown names` | `parseFeatures("policy,billing")` throws an error naming `billing` |
| `parseFeatures needs policy for reports` | `parseFeatures("reports")` throws |
| `featureSetName joins with +` | `featureSetName(ALL_FEATURES)` → `"policy+reports+import+summary"`; `featureSetName([])` → `"v1"` |
| `suiteFiles lists v1 then the features` | `suiteFiles(["policy", "summary"])` ends with `acceptance/v1.test.ts`, `acceptance/policy.test.ts`, `acceptance/summary.test.ts` (absolute paths) |
| `parseTap reads the summary and failures` | given the TAP text below → `{ total: 3, passed: 2, failed: 1, failures: ["P1 receipt over 2500"] }` |

TAP sample for the test:

```text
TAP version 13
# Subtest: README Endpoints: GET /health returns ok
ok 1 - README Endpoints: GET /health returns ok
  ---
  duration_ms: 12.5
  ...
# Subtest: P1 receipt over 2500
not ok 2 - P1 receipt over 2500
  ---
  duration_ms: 20.1
  ...
# Subtest: P3 weekend
ok 3 - P3 weekend
1..3
# tests 3
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 300.5
```

`scripts/lib/features.ts`:

```ts
export const FEATURES = ["policy", "reports", "import", "summary"] as const;
export type Feature = (typeof FEATURES)[number];
export const ALL_FEATURES: Feature[] = [...FEATURES];

export function parseFeatures(value: string): Feature[] {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "");
  for (const name of names) {
    if (!(FEATURES as readonly string[]).includes(name)) {
      throw new Error(`Unknown feature "${name}". Known features: ${FEATURES.join(", ")}`);
    }
  }
  const features = FEATURES.filter((feature) => names.includes(feature));
  if (features.includes("reports") && !features.includes("policy")) {
    throw new Error("The reports feature needs the policy feature");
  }
  return features;
}

export function featureSetName(features: readonly Feature[]): string {
  return features.length === 0 ? "v1" : features.join("+");
}
```

`scripts/lib/suite.ts`:

```ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature } from "./features.ts";
import { run } from "./proc.ts";

export const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TapSummary {
  total: number;
  passed: number;
  failed: number;
  failures: string[];
}

export interface SuiteResult extends TapSummary {
  ok: boolean;
  exitCode: number;
  output: string;
}

export function suiteFile(name: "v1" | Feature): string {
  return join(KIT_DIR, "acceptance", `${name}.test.ts`);
}

export function suiteFiles(features: readonly Feature[]): string[] {
  return [suiteFile("v1"), ...features.map((feature) => suiteFile(feature))];
}

function count(output: string, label: string): number {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

export function parseTap(output: string): TapSummary {
  const failures = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1].trim());
  return {
    total: count(output, "tests"),
    passed: count(output, "pass"),
    failed: count(output, "fail") + count(output, "cancelled"),
    failures,
  };
}

export async function runSuite(appDir: string, files: string[]): Promise<SuiteResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, EXPENSE_APP_DIR: resolve(appDir) };
  // Set by a parent `node --test`; a nested runner would then report to it instead of printing TAP.
  delete env.NODE_TEST_CONTEXT;
  const result = await run(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: KIT_DIR, env });
  const summary = parseTap(result.stdout);
  return {
    ...summary,
    ok: result.code === 0 && summary.total > 0 && summary.passed === summary.total,
    exitCode: result.code,
    output: result.stdout + result.stderr,
  };
}
```

Run: `cd evals/orchestrator/expense-claims && npm test`
Expected: PASS for every `suite.test.ts` test.

- [ ] **Step 3: Write `acceptance/helpers.ts`**

Each test gets a fresh app process, so tests never share data.

```ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach } from "node:test";

export interface Res {
  status: number;
  body: any;
  contentType: string | null;
}

export interface Api {
  url: string;
  request(method: string, path: string, body?: unknown, contentType?: string): Promise<Res>;
  stop(): Promise<void>;
}

function appDir(): string {
  const dir = process.env.EXPENSE_APP_DIR;
  if (!dir) throw new Error("Set EXPENSE_APP_DIR to the directory of the app under test");
  return resolve(dir);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

// Starts `node src/server.ts` (what `npm start` runs) with PORT set, and waits for GET /health.
export async function startApp(): Promise<Api> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["src/server.ts"], {
    cwd: appDir(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The app exited with code ${child.exitCode}: ${stderr}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`The app did not answer GET /health within 10 s: ${stderr}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return {
    url,
    async request(method, path, body, contentType) {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers = { "content-type": contentType ?? "application/json" };
      }
      const res = await fetch(url + path, init);
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, body: parsed, contentType: res.headers.get("content-type") };
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

// Registers beforeEach/afterEach hooks for the calling file and returns a getter for the current app.
export function useApp(): () => Api {
  let api: Api | undefined;
  beforeEach(async () => {
    api = await startApp();
  });
  afterEach(async () => {
    await api?.stop();
    api = undefined;
  });
  return () => {
    if (!api) throw new Error("No app running");
    return api;
  };
}

export const base = { date: "2026-03-04", merchant: "Cafe Rio", category: "meals", amount: 1000, currency: "GBP" };

// Creates an expense through the v1 API and returns it.
export async function createExpense(api: Api, fields: Record<string, unknown> = {}): Promise<any> {
  const res = await api.request("POST", "/expenses", { ...base, ...fields });
  assert.equal(res.status, 201, `POST /expenses failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export function assertError(res: Res, status: number, code: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.error?.code, code, JSON.stringify(res.body));
  assert.equal(typeof res.body.error.message, "string");
  assert.ok(Array.isArray(res.body.error.details));
}

export function detailFields(res: Res): string[] {
  return res.body.error.details.map((detail: { field: string }) => detail.field).sort();
}
```

- [ ] **Step 4: Write the five suite files**

Every file starts with `const app = useApp();` and calls `app()` inside each test. Test names start with the rule id or `README <section>`; put the name exactly as in the tables (they are what reviewers map to the spec). Dates used: `2026-03-02` Mon, `2026-03-04` Wed, `2026-03-05` Thu, `2026-03-06` Fri, `2026-03-07` Sat, `2026-03-08` Sun. Unless a row says otherwise, an expense is `base` (`2026-03-04`, meals, 1000 GBP, no receipt). "Error X/Y" means `assertError(res, X, "Y")`.

`acceptance/v1.test.ts` (17 tests, README; the last one is below the table):

| Name | Steps | Expected |
|---|---|---|
| `README Endpoints: GET /health returns ok` | GET `/health` | 200, body `{ status: "ok" }`, content type starts with `application/json` |
| `README Expenses: POST /expenses returns the new expense` | POST `{ date: "2026-03-04", merchant: "Cafe Rio", category: "meals", amount: 1250, currency: "EUR", description: "Team lunch", receipt: true }` | 201; body deep-equals the input plus `id`, a non-empty string |
| `README Expenses: description and receipt have defaults` | POST `base` | 201; `description` `""`, `receipt` `false` |
| `README Expenses: id and unknown fields are ignored` | POST `{ ...base, id: "mine", colour: "red" }` | 201; `id` is not `"mine"`; body has no `colour` key |
| `README Expenses: missing required fields are each reported` | POST `{}` | Error 400/VALIDATION_ERROR; `detailFields` = `amount, category, currency, date, merchant` |
| `README Expenses: invalid values are each reported` | POST `{ date: "2026-02-30", merchant: "   ", category: "food", amount: 0, currency: "JPY", description: 5, receipt: "yes" }` | Error 400/VALIDATION_ERROR; `detailFields` = all seven field names |
| `README Expenses: amount must be a whole number` | POST `{ ...base, amount: 12.5 }`; POST `{ ...base, amount: "1000" }` | both Error 400/VALIDATION_ERROR with `detailFields` = `["amount"]` |
| `README Conventions: bad JSON returns INVALID_JSON` | POST raw `{bad`; POST raw `[1,2]` (content type `application/json`) | both Error 400/INVALID_JSON with `details` `[]` |
| `README Endpoints: GET /expenses/:id returns the expense` | create; GET `/expenses/<id>` | 200, deep-equals the created expense |
| `README Conventions: an unknown id returns NOT_FOUND` | GET `/expenses/nope` | Error 404/NOT_FOUND; `details` `[]` |
| `README Endpoints: GET /expenses lists in creation order` | create with dates `2026-03-09`, `2026-03-01`, `2026-03-05` | 200; `body.expenses` ids in creation order |
| `README Expenses: GET /expenses filters by category, from and to` | create A meals `2026-03-01`, B travel `2026-03-05`, C meals `2026-03-10`; GET `?category=meals`, `?from=2026-03-05&to=2026-03-10`, `?category=meals&from=2026-03-02`, `?to=2026-03-05` | ids `[A, C]`, `[B, C]`, `[C]`, `[A, B]` |
| `README Expenses: invalid filters return VALIDATION_ERROR` | GET `?category=food`; `?from=2026-13-01`; `?to=soon` | each Error 400/VALIDATION_ERROR with `detailFields` = `["category"]`, `["from"]`, `["to"]` |
| `README Endpoints: PATCH changes only the fields sent` | create; PATCH `{ amount: 2000, id: "other" }` | 200; body = created expense with `amount` 2000 (same id); GET returns the same |
| `README Expenses: PATCH validates fields and 404s` | create; PATCH `{ currency: "JPY" }`; PATCH `/expenses/nope` with `{ amount: 5 }` | Error 400/VALIDATION_ERROR with `detailFields` `["currency"]`; Error 404/NOT_FOUND |
| `README Endpoints: DELETE removes the expense` | create; DELETE; GET; DELETE again | 204 with no body; Error 404/NOT_FOUND; Error 404/NOT_FOUND |

Add one more: `README Conventions: an unknown route returns NOT_FOUND` — GET `/nope` → Error 404/NOT_FOUND. (17 tests in total.)

`acceptance/policy.test.ts` (13 tests: 11 in the first table, 2 in the second). `check(ids)` = POST `/policy/check` `{ expenseIds: ids }`. For each returned violation also assert `typeof message === "string" && message.length > 0` (P5).

| Name | Expenses (in input order) | Expected `violations` (code, severity, expenseIds) |
|---|---|---|
| `P1 RECEIPT_REQUIRED above 2500 without a receipt` | a: travel 2501 GBP | `[RECEIPT_REQUIRED, error, [a]]` |
| `P1 exactly 2500 needs no receipt` | a: travel 2500 GBP | `[]` |
| `P1 a receipt clears the rule` | a: travel 9000 GBP, receipt true | `[]` |
| `P1 compares GBP equivalents from convert()` | a: travel 2941 EUR; b: travel 2942 EUR; c: travel 3126 USD; d: travel 3125 USD | `[RECEIPT_REQUIRED, error, [b]]`, `[RECEIPT_REQUIRED, error, [c]]` |
| `P2 MEALS_DAILY_CAP above 5000 on one date` | a: meals 3000 Wed receipt true; b: meals 2001 Wed | `[MEALS_DAILY_CAP, error, [a, b]]` |
| `P2 exactly 5000 is allowed` | a: meals 3000 Wed receipt true; b: meals 2000 Wed | `[]` |
| `P2 converts each expense before adding` | a: meals 4983 GBP Wed receipt true; b: meals 10 EUR Wed; c: meals 10 EUR Wed (4983 + 9 + 9 = 5001) | `[MEALS_DAILY_CAP, error, [a, b, c]]` |
| `P2 counts only meals on the same date` | a: meals 3000 Wed receipt true; b: travel 3000 Wed receipt true; c: meals 3000 Thu receipt true | `[]` |
| `P3 WEEKEND warns on Saturday and Sunday` | a: Fri; b: Sat; c: Sun; d: Mon (all 1000 GBP meals) | `[WEEKEND, warning, [b]]`, `[WEEKEND, warning, [c]]` |
| `P4 violations come in rule order, meals caps by date` | a: travel 3000 Sat (no receipt); b: meals 3000 Thu receipt true; c: meals 2500 Thu; d: meals 5001 Wed (no receipt) | `[RECEIPT_REQUIRED, error, [a]]`, `[RECEIPT_REQUIRED, error, [d]]`, `[MEALS_DAILY_CAP, error, [d]]`, `[MEALS_DAILY_CAP, error, [b, c]]`, `[WEEKEND, warning, [a]]` |
| `P6 P7 an empty list gives no violations` | `check([])` | 200, `{ violations: [] }` |

And two error tests (13 tests in total):

| Name | Steps | Expected |
|---|---|---|
| `P9 expenseIds must be an array of strings` | POST `{}`; `{ expenseIds: "exp_1" }`; `{ expenseIds: [1] }` | each Error 400/VALIDATION_ERROR with `detailFields` `["expenseIds"]` |
| `P10 an unknown expense id returns NOT_FOUND` | create a; `check([a, "nope"])` | Error 404/NOT_FOUND |

For the violation tables assert the whole array: `assert.deepEqual(res.body.violations.map(v => [v.code, v.severity, v.expenseIds]), expected)` and `res.status === 200`.

`acceptance/reports.test.ts` (17 tests). Helpers in the file: `newReport(title = "March trip")` → POST `/reports`, assert 201, return body; `attach(r, e)` → POST `/reports/<r>/expenses` `{ expenseId: e }`; `submit(r)`, `approve(r)`, `reject(r, body)` → POST to the matching path.

| Name | Steps | Expected |
|---|---|---|
| `R1 POST /reports creates a draft that GET returns` | POST `{ title: "March trip" }`; GET `/reports/<id>` | 201, body `{ id: <non-empty string>, title: "March trip", status: "draft", expenseIds: [], rejectionReason: null }` (deepEqual with the id); GET 200 deep-equals it |
| `R1 R2 bad titles and unknown reports` | POST `{}`; `{ title: "  " }`; `{ title: 5 }`; GET `/reports/nope` | three Error 400/VALIDATION_ERROR with `detailFields` `["title"]`; Error 404/NOT_FOUND |
| `R3 attach keeps order and detach removes` | e1, e2; attach e1, attach e2; DELETE `/reports/<r>/expenses/<e1>` | 200 with `expenseIds` `[e1]`, then `[e1, e2]`; then 200 with `[e2]` |
| `R3 attach errors` | report r, e1; attach body `{}`; `{ expenseId: 7 }`; `{ expenseId: "nope" }`; POST `/reports/nope/expenses` `{ expenseId: e1 }` | Error 400/VALIDATION_ERROR (`["expenseId"]`) twice; Error 404/NOT_FOUND; Error 404/NOT_FOUND |
| `R5 an expense is in at most one active report` | reports A, B; e1; attach e1 to A; attach e1 to B; attach e1 to A | 200; Error 409/EXPENSE_IN_REPORT; Error 409/EXPENSE_IN_REPORT |
| `R6 detaching an expense that is not attached` | report r, e1 (not attached); DELETE `/reports/<r>/expenses/<e1>`; DELETE `/reports/<r>/expenses/nope` | Error 404/NOT_FOUND twice |
| `R8 submitting an empty report` | report r; submit | Error 409/REPORT_EMPTY; GET r → `status` `draft` |
| `R9 warnings do not block a submit` | e1 Sat 1000 GBP; attach; submit | 200, `status` `submitted`, `expenseIds` `[e1]` |
| `R9 policy errors refuse a submit` | e1 travel 3000 GBP Wed (no receipt); e2 Sat 1000 GBP; attach e1, e2; submit | Error 409/POLICY_VIOLATION; `error.details` mapped to `[code, severity, expenseIds]` = `[["RECEIPT_REQUIRED", "error", [e1]]]`; each detail has a non-empty `message`; GET r → `status` `draft` |
| `R7 approve moves submitted to approved, then it is final` | e1; attach; submit; approve; approve; submit; reject `{ reason: "Late" }` | approve 200 `status` `approved`; then three Error 409/INVALID_STATE |
| `R7 a draft cannot be approved or rejected` | e1; attach; approve; reject `{ reason: "No" }` | Error 409/INVALID_STATE twice |
| `R10 reject needs a reason and stores it` | e1; attach; submit; reject `{}`; reject `{ reason: " " }`; reject `{ reason: "Missing itinerary" }`; reject `{ reason: "Again" }`; submit | Error 400/VALIDATION_ERROR (`["reason"]`) twice; 200 with `status` `rejected`, `rejectionReason` `"Missing itinerary"`, `expenseIds` `[e1]`; Error 409/INVALID_STATE twice |
| `R4 attach and detach need a draft report` | e1, e2; attach e1; submit; attach e2; DELETE `/reports/<r>/expenses/<e1>`; attach e1 | Error 409/INVALID_STATE three times (the last one shows R4 wins over R5) |
| `R11 expenses in submitted and approved reports are locked` | e1; attach; submit; PATCH e1 `{ merchant: "X" }`; DELETE e1; approve; PATCH e1 `{ merchant: "X" }`; DELETE e1 | Error 409/EXPENSE_LOCKED four times (approve returns 200) |
| `R11 R12 draft expenses can change, and deleting detaches them` | e1, e2; attach both; PATCH e1 `{ merchant: "Changed" }`; DELETE e1; GET r | 200 with `merchant` `"Changed"`; 204; `expenseIds` `[e2]` |
| `R13 a rejected report unlocks its expenses` | e1; report A; attach; submit; reject `{ reason: "No" }`; PATCH e1 `{ amount: 900 }`; report B; attach e1 to B; GET A | 200 `amount` 900; 200 with B `expenseIds` `[e1]`; A still has `expenseIds` `[e1]` and `status` `rejected` |
| `G4 body errors come before state errors` | e1; report r (draft, e1 attached); reject `{}`; submit; PATCH e1 `{ amount: 0 }` | Error 400/VALIDATION_ERROR (`["reason"]`), not 409; submit 200; Error 400/VALIDATION_ERROR (`["amount"]`), not 409 |

`acceptance/import.test.ts` (12 tests). `importCsv(text, type = "text/csv")` → POST `/expenses/import` with the raw text and that content type. `list()` → GET `/expenses` and return `body.expenses`. Write CSV bodies as joined arrays of lines so blank lines and quotes are exact, for example `["h", "r1"].join("\n")`.

| Name | Body (lines; `⏎` marks a line break inside a quoted field) | Expected |
|---|---|---|
| `I3 I9 I10 imports valid rows` | `date,merchant,category,amount,currency,description,receipt` / `2026-03-04,Cafe Rio,meals,12.50,GBP,Lunch,true` / `2026-03-05,Rail Co,travel,40,EUR,,false` + final `\n` | 200; `created` has 2 ids, `errors` `[]`; `list()` returns them in that order with `{ date, merchant, category, amount: 1250, currency: "GBP", description: "Lunch", receipt: true }` and `{ …, amount: 4000, currency: "EUR", description: "", receipt: false }` |
| `I3 columns in any order, unknown columns ignored, optional columns absent` | `currency,amount,notes,category,merchant,date` / `USD,9.99,ignore me,other,Shop,2026-03-06` | 200, 1 created; the expense is `{ date: "2026-03-06", merchant: "Shop", category: "other", amount: 999, currency: "USD", description: "", receipt: false }` plus `id`, and has no `notes` key |
| `I5 amount formats` | header `date,merchant,category,amount,currency`, then rows `2026-03-04,Cafe,meals,<amount>,GBP` for amounts `12`, `12.5`, `0.01`, `12.345`, `0`, `0.00`, `-5`, `abc`, `1.` (lines 2–10) | `created` has 3 ids, whose amounts are `1200`, `1250`, `1`; `errors` lines `[5, 6, 7, 8, 9, 10]`, each with `details` fields `["amount"]` |
| `I2 quoted fields keep commas, quotes and line breaks` | `date,merchant,category,amount,currency,description` / `2026-03-04,"Smith, Jones & Co",other,10,GBP,"He said ""hi"""` / `2026-03-04,Cafe,meals,5,GBP,"Line one⏎Line two"` | 2 created; merchant `Smith, Jones & Co` and description `He said "hi"`; second description `"Line one\nLine two"` |
| `I7 I8 line numbers count empty lines and multi-line rows` | line 1 `date,merchant,category,amount,currency,description`; 2–3 `2026-03-04,Cafe,meals,5,GBP,"two⏎lines"`; 4 empty; 5 `2026-03-04,Cafe,food,5,GBP,x`; 6–7 `2026-03-04,Cafe,meals,5,JPY,"a⏎b"`; 8 `2026-02-30,Cafe,meals,5,GBP,y` | 1 created; `errors` = `[{ line: 5, fields ["category"] }, { line: 6, fields ["currency"] }, { line: 8, fields ["date"] }]` |
| `I5 I9 I10 bad rows are reported and good rows still created` | `date,merchant,category,amount,currency,receipt` / `2026-03-04,Cafe,meals,5,GBP,true` / `bad-date, ,food,0,JPY,yes` / `2026-03-05,Taxi,travel,15,EUR,` | 2 created (receipts `true`, `false`); `errors` = one entry, line 3, `details` fields (sorted) `amount, category, currency, date, merchant, receipt` |
| `I6 a row with the wrong number of fields` | `date,merchant,category,amount,currency` / `2026-03-04,Cafe,meals,5` / `2026-03-04,Cafe,meals,5,GBP,extra` / `2026-03-04,Cafe,meals,5,GBP` | 1 created; `errors` = `[{ line: 2, details fields ["row"] }, { line: 3, details fields ["row"] }]` |
| `I4 a missing required column imports nothing` | `date,merchant,amount` / `2026-03-04,Cafe,5`; then `Date,merchant,category,amount,currency` / `2026-03-04,Cafe,meals,5,GBP` | Error 400/INVALID_CSV with `detailFields` `["category", "currency"]`; Error 400/INVALID_CSV with `["date"]`; `list()` is `[]` |
| `I4 an empty body is a file with no columns` | `""` | Error 400/INVALID_CSV with `detailFields` = `amount, category, currency, date, merchant` |
| `I1 the content type must be text/csv` | valid one-row file sent as `application/json`, as `text/plain`, then as `text/csv; charset=utf-8` | Error 415/UNSUPPORTED_MEDIA_TYPE twice; then 200 with 1 created |
| `I2 CRLF line endings and no final line break` | `["date,merchant,category,amount,currency,description", "2026-03-04,Cafe,meals,5,GBP,first", "2026-03-05,Cafe,meals,6,GBP,end"].join("\r\n")` | 2 created; descriptions `first` and `end` (no `\r`) |
| `I10 a header-only file creates nothing` | `date,merchant,category,amount,currency\n` | 200, `{ created: [], errors: [] }` |

For `errors`, compare `res.body.errors.map(e => ({ line: e.line, fields: e.details.map(d => d.field).sort() }))`.

`acceptance/summary.test.ts` (6 tests). `summary(query)` → GET `/summary?<query>`.

| Name | Expenses | Request | Expected |
|---|---|---|---|
| `S2 S4 totals per category for the month` | meals 1200 GBP `2026-03-01`; travel 3000 GBP `2026-03-15`; travel 50 GBP `2026-03-31`; meals 999 GBP `2026-02-28`; other 777 GBP `2026-04-01` | `month=2026-03&currency=GBP` | 200, deepEqual `{ month: "2026-03", currency: "GBP", count: 3, total: 4250, categories: { meals: 1200, travel: 3050, lodging: 0, other: 0 } }` |
| `S3 each expense is converted, then added` | meals 10 EUR `2026-05-04`; meals 10 EUR `2026-05-05` | `month=2026-05&currency=GBP` | `categories.meals` 18, `total` 18, `count` 2 |
| `S3 converts into the requested currency` | lodging 100 GBP `2026-06-10`; lodging 100 EUR `2026-06-11` | `month=2026-06&currency=EUR` | `categories.lodging` 218, `total` 218, `currency` `"EUR"` |
| `S4 a month with no expenses` | none | `month=2026-07&currency=USD` | deepEqual `{ month: "2026-07", currency: "USD", count: 0, total: 0, categories: { meals: 0, travel: 0, lodging: 0, other: 0 } }` |
| `S1 month and currency are required` | none | (no query) | Error 400/VALIDATION_ERROR with `detailFields` `["currency", "month"]` |
| `S1 invalid month or currency` | none | `month=2026-13&currency=GBP`; `month=2026-3&currency=GBP`; `month=2026-00&currency=GBP`; `month=2026-03&currency=JPY` | Error 400/VALIDATION_ERROR with `detailFields` `["month"]`, `["month"]`, `["month"]`, `["currency"]` |

- [ ] **Step 5: Write `scripts/acceptance.ts`**

```ts
import { parseArgs } from "node:util";
import { ALL_FEATURES, FEATURES, parseFeatures, type Feature } from "./lib/features.ts";
import { runSuite, suiteFile, suiteFiles } from "./lib/suite.ts";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    features: { type: "string" },
    only: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

if (!values.app) {
  console.error("Usage: node scripts/acceptance.ts --app <dir> [--features <list>] [--only <v1|feature>] [--verbose]");
  process.exit(2);
}

let files: string[];
if (values.only) {
  // --only runs one file on its own, so it does not apply the reports-needs-policy rule.
  if (!(["v1", ...FEATURES] as string[]).includes(values.only)) {
    console.error(`Unknown suite file "${values.only}". Use v1 or one of: ${FEATURES.join(", ")}`);
    process.exit(2);
  }
  files = [suiteFile(values.only as "v1" | Feature)];
} else {
  files = suiteFiles(values.features === undefined ? ALL_FEATURES : parseFeatures(values.features));
}

const result = await runSuite(values.app, files);
if (values.verbose) console.log(result.output);
for (const name of result.failures) console.log(`FAIL ${name}`);
console.log(`${result.passed}/${result.total} acceptance tests passed`);
process.exit(result.ok ? 0 : 1);
```

- [ ] **Step 6: Run the suite against the seed**

Run (from the kit root):

```bash
node scripts/acceptance.ts --app seed --only v1
for f in policy reports import summary; do node scripts/acceptance.ts --app seed --only $f; done
```

Expected: v1 prints `17/17 acceptance tests passed`. Each feature file prints `0/<n> acceptance tests passed` (every v2 test fails on the seed). If a v2 test passes on the seed, it is not testing v2 behaviour: fix the test.

Run: `npm test` (kit root). Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add evals/orchestrator/expense-claims/package.json evals/orchestrator/expense-claims/acceptance evals/orchestrator/expense-claims/scripts
git commit -m "test(evals): add hidden acceptance suite and runner"
```

---
### Task 3: Reference implementation — Policy and Reports

The reference shows the suite is correct and passable. Build it the way a careful engineer would build the v2 PRs in a run repo: follow the seed's conventions and `README.md`, and implement `docs/spec-v2.md` exactly.

**Files:**
- Create: `reference/` as a copy of `seed/` (`cp -R seed reference`, then remove any `node_modules` or `.DS_Store`)
- Create: `reference/src/policy.ts`, `reference/src/reports.ts`, `reference/test/policy.test.ts`, `reference/test/reports.test.ts`
- Modify: `reference/src/store.ts`, `reference/src/expenses.ts` (`updateExpense`, `deleteExpense`), `reference/src/routes.ts`, `reference/README.md` (endpoint table rows only)
- Never modify: `reference/docs/spec-v2.md` (must stay identical to `seed/docs/spec-v2.md`), `reference/src/money.ts`

**Interfaces:**
- Consumes: everything Task 1 produces; the suite runner from Task 2.
- Produces:
  - `src/policy.ts`: exactly the signature in spec-v2 "Feature: Policy" (`PolicyCode`, `Violation`, `evaluatePolicy(expenses: Expense[]): Violation[]`), plus the handler `checkPolicy(ctx: Ctx): Result`.
  - `src/reports.ts`: `type ReportStatus = "draft" | "submitted" | "approved" | "rejected"`, `interface Report { id; title; status: ReportStatus; expenseIds: string[]; rejectionReason: string | null }`, `assertExpenseUnlocked(store: Store, expenseId: string): void` (throws 409 `EXPENSE_LOCKED`), `removeExpenseFromReports(store: Store, expenseId: string): void`, and handlers `createReport`, `getReport`, `attachExpense`, `detachExpense`, `submitReport`, `approveReport`, `rejectReport`.
  - `src/store.ts`: `Store` gains `reports = new Map<string, Report>()`. Report ids come from `store.nextId("rep")`.

Design notes:
- Policy: compute `gbp = convert(e.amount, e.currency, "GBP")` per expense. P1 in input order; P2 groups `meals` by date (keep the input order of ids inside a date), emits dates sorted ascending (string compare on `YYYY-MM-DD` works); P3 uses `new Date(`${date}T00:00:00Z`).getUTCDay()` (0 Sunday, 6 Saturday). Concatenate the three lists (P4).
- `POST /policy/check`: parse the body with `parseJsonObject`; P9 check (`Array.isArray(v) && v.every(x => typeof x === "string")`); then `findExpense` for each id (404, P10); then `evaluatePolicy`.
- Reports: follow G4 and the order stated in R4–R9 for every handler: report 404 → body 400 → expense-in-body 404 → state 409 → rule-specific 409. Detach: report 404 → not-in-report 404 (R6) → 409 `INVALID_STATE` (R4). Attach: report 404 → 400 → expense 404 → 409 `INVALID_STATE` → 409 `EXPENSE_IN_REPORT`. Submit: 404 → `INVALID_STATE` → `REPORT_EMPTY` → `POLICY_VIOLATION` (with `new HttpError(409, "POLICY_VIOLATION", …, errors)` where `errors` are the error-severity violations).
- "Active report" for R5 = a report whose status is not `rejected` that lists the expense. "Locked" for R11 = listed by a `submitted` or `approved` report.
- In `expenses.ts`: `updateExpense` runs `findExpense` → body validation → `assertExpenseUnlocked` → apply (G4: 400 before 409). `deleteExpense` runs `findExpense` → `assertExpenseUnlocked` → delete → `removeExpenseFromReports` (R12).
- Import cycles: `expenses.ts` imports functions from `reports.ts`, and `reports.ts` imports `findExpense` from `expenses.ts`. That is fine in ESM because both are used only inside functions.
- Add routes to `src/routes.ts`, after the v1 routes: `POST /policy/check`, `POST /reports`, `GET /reports/:id`, `POST /reports/:id/expenses`, `DELETE /reports/:id/expenses/:expenseId`, `POST /reports/:id/submit`, `POST /reports/:id/approve`, `POST /reports/:id/reject`. Add matching rows to the README endpoint table.

- [ ] **Step 1: Copy the seed and confirm the starting point**

Run (kit root): `cp -R seed reference && cd reference && npm test`
Expected: PASS (the seed's tests).

- [ ] **Step 2: Write failing reference tests**

`reference/test/policy.test.ts`: unit tests of `evaluatePolicy` on plain `Expense` objects (no server) for P1 boundary (2500 vs 2501 GBP; 2941 vs 2942 EUR), P2 boundary (5000 vs 5001; per-expense rounding with 4983 GBP + 10 EUR + 10 EUR), P3 (Sat/Sun vs Fri), P4 order (the four-expense case from the suite: travel 3000 Sat no receipt; meals 3000 Thu receipt; meals 2500 Thu; meals 5001 Wed), P6; and endpoint tests through `startTestApp()` for P8, P9 and P10.

`reference/test/reports.test.ts`: through `startTestApp()`: create and get (R1, R2); attach and detach order (R3, R6); R5 across two reports; submit empty (R8), with warnings only, with a policy error (R9, check `error.details` holds only error-severity violations); approve and reject paths (R7, R10); locking (R11) and its precedence (G4: PATCH with `{ amount: 0 }` on a locked expense is 400); delete detaches (R12); rejected unlocks (R13).

Run: `npm test` (from `reference/`). Expected: FAIL (modules missing).

- [ ] **Step 3: Implement Policy, Reports, the store change, locking, routes and README rows**

Per the design notes above.

- [ ] **Step 4: Run the reference tests and the suite**

Run: `cd reference && npm test`
Expected: PASS, 0 failures.

Run (kit root): `node scripts/acceptance.ts --app reference --features policy,reports`
Expected: `47/47 acceptance tests passed` (17 v1 + 13 policy + 17 reports).

Run: `cmp seed/docs/spec-v2.md reference/docs/spec-v2.md && cmp seed/src/money.ts reference/src/money.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/reference
git commit -m "feat(evals): add reference v2 policy and reports"
```

---

### Task 4: Reference implementation — CSV import and Summary

**Files:**
- Create: `reference/src/csv.ts`, `reference/src/import.ts`, `reference/src/summary.ts`, `reference/test/csv.test.ts`, `reference/test/import.test.ts`, `reference/test/summary.test.ts`
- Modify: `reference/src/routes.ts`, `reference/README.md` (endpoint table rows only)

**Interfaces:**
- Consumes: `addExpense`, `checkField`, `type ExpenseFields` from `src/expenses.ts`; `convert`, `isCurrency`, `CURRENCIES` from `src/money.ts`; `CATEGORIES`; `HttpError`, `validationError` from `src/http.ts`.
- Produces: `src/csv.ts` `interface CsvRow { line: number; fields: string[] }`, `parseCsv(text: string): CsvRow[]`; handlers `importExpenses` (`src/import.ts`) and `getSummary` (`src/summary.ts`); routes `POST /expenses/import` and `GET /summary`.

`reference/src/csv.ts`:

```ts
export interface CsvRow {
  line: number; // the line of the file on which the row starts (1-based)
  fields: string[];
}

// RFC 4180: comma-separated fields, rows ending in \n or \r\n, double-quoted fields that may
// contain commas, line breaks and "" for one quote. Completely empty lines are skipped.
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let hasContent = false;
  let line = 1;
  let rowStart = 1;

  const endRow = () => {
    if (hasContent) {
      fields.push(field);
      rows.push({ line: rowStart, fields });
    }
    fields = [];
    field = "";
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      hasContent = true;
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      endRow();
      line++;
      rowStart = line;
    } else {
      field += ch;
      hasContent = true;
    }
  }
  endRow();
  return rows;
}
```

Design notes:
- `importExpenses`: content type check first (I1): `String(ctx.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "text/csv"`, else 415 `UNSUPPORTED_MEDIA_TYPE`. Parse; header = first row (none → no columns). Missing required columns → 400 `INVALID_CSV`, one detail per missing column in the order `date, merchant, category, amount, currency` (I4). For each later row: field-count mismatch → `[{ field: "row", … }]` (I6); else build values by column name and check `date`, `merchant`, `category`, `currency` with `checkField`; `amount` with `/^\d+(\.\d{1,2})?$/`, converted to minor units with integer arithmetic (`whole * 100 + Number(fraction.padEnd(2, "0"))`) and > 0; `description` any string (default `""`); `receipt` `"true"` / `"false"` / `""` (default `false`). Valid rows → `addExpense`. Response 200 `{ created, errors }`.
- `getSummary`: S1 checks `month` with `/^\d{4}-(0[1-9]|1[0-2])$/` and `currency` with `isCurrency`, one detail per invalid parameter (missing counts as invalid). Filter `e.date.startsWith(month + "-")`, then `convert` each to `currency` and add per category; `categories` starts with all four at 0; `total` = sum; `count` = number of expenses.

- [ ] **Step 1: Write failing tests**

`reference/test/csv.test.ts`: `parseCsv` on: simple rows (lines 1, 2); CRLF; quoted comma; doubled quotes; a quoted line break (row starts on line 2, next row on line 4); an empty line in the middle (skipped, later line numbers still count it); no trailing newline; empty input → `[]`.

`reference/test/import.test.ts` and `reference/test/summary.test.ts`: endpoint tests through `startTestApp()` covering I1, I4, I5 (amount formats), I6, I8 and I10; S1, S3 (per-expense rounding: two 10 EUR meals → 18 GBP) and S4 (all four categories, empty month). The test helper sends string bodies with `content-type: application/json`; for CSV, use `fetch(app.url + "/expenses/import", { method: "POST", headers: { "content-type": "text/csv" }, body })` directly.

Run: `cd reference && npm test`. Expected: FAIL.

- [ ] **Step 2: Implement `csv.ts`, `import.ts`, `summary.ts`, routes and README rows**

Add `{ method: "POST", path: "/expenses/import", handler: importExpenses }` and `{ method: "GET", path: "/summary", handler: getSummary }` after the Task 3 routes, and the two README rows.

- [ ] **Step 3: Run everything**

Run: `cd reference && npm test`
Expected: PASS, 0 failures.

Run (kit root): `node scripts/acceptance.ts --app reference`
Expected: `65/65 acceptance tests passed`.

Run: `node scripts/acceptance.ts --app reference --features policy,reports,import`
Expected: `59/59 acceptance tests passed`.

- [ ] **Step 4: Commit**

```bash
git add evals/orchestrator/expense-claims/reference
git commit -m "feat(evals): add reference v2 CSV import and summary"
```

---
### Task 5: `new-run`

**Files:**
- Modify: `scripts/lib/features.ts` (add the spec functions), `package.json` (add the `new-run` script)
- Create: `scripts/lib/new-run.ts`, `scripts/new-run.ts`, `scripts/test/features.test.ts`, `scripts/test/new-run.test.ts`

**Interfaces:**
- Consumes: `FEATURES`, `ALL_FEATURES`, `parseFeatures`, `featureSetName` (Task 2); `run` from `scripts/lib/proc.ts`; `KIT_DIR` from `scripts/lib/suite.ts`.
- Produces:
  - `scripts/lib/features.ts`: `FEATURE_HEADINGS: Record<Feature, string>`, `stripFeatures(markdown: string, keep: readonly Feature[]): string`, `detectFeatures(specMarkdown: string): Feature[]`.
  - `scripts/lib/new-run.ts`: `RUN_NAME_PATTERN = /^orch-eval-(.+)-(\d+)$/`, `runName(variant: string, n: number): string`, `parseRunName(name: string): { variant: string; n: number } | null`, `nextRunNumber(runsDir: string, variant: string): number`, `listSeedFiles(seedDir: string): string[]`, `newRun(opts: NewRunOptions, deps: NewRunDeps): Promise<NewRunResult>`.
  - CLI: `node scripts/new-run.ts --variant <name> [--n <k>] [--features <list>] [--owner <login>] [--runs-dir <dir>] [--dry-run]`. Defaults: features all four, owner `ncksol`, runs dir `~/orch-evals`.

- [ ] **Step 1: Write the failing feature tests**

`scripts/test/features.test.ts`:

| Test | Assertion |
|---|---|
| `detectFeatures finds every feature in the spec` | `detectFeatures(read("seed/docs/spec-v2.md"))` → `ALL_FEATURES` |
| `stripFeatures keeps everything when all features are kept` | `stripFeatures(spec, ALL_FEATURES) === spec` |
| `stripFeatures drops the Summary section` | result of `stripFeatures(spec, ["policy", "reports", "import"])`: no `## Feature: Summary`, no `S1.`; still has `## Feature: CSV import` and `I10.`; ends with exactly one `\n`; `detectFeatures(result)` → `["policy", "reports", "import"]` |
| `stripFeatures ignores headings inside code fences` | a synthetic markdown with a fenced block containing `## Feature: Summary` keeps the block |
| `kickoff.md embeds the spec verbatim` | `read("kickoff.md").endsWith("\n---\n\n" + spec)` |
| `the kickoff without Summary embeds the spec without Summary` | `stripFeatures(kickoff, keep).endsWith(stripFeatures(spec, keep))` for `keep = ["policy", "reports", "import"]` |
| `nothing in the seed mentions the hidden suite or the reference` | for every file in `listSeedFiles(seed)`, its text does not match `/acceptance|reference implementation|hidden/i` |

Run: `npm test` (kit root). Expected: FAIL (`stripFeatures` missing).

- [ ] **Step 2: Add the spec functions to `scripts/lib/features.ts`**

```ts
export const FEATURE_HEADINGS: Record<Feature, string> = {
  policy: "## Feature: Policy",
  reports: "## Feature: Reports",
  import: "## Feature: CSV import",
  summary: "## Feature: Summary",
};

// Removes each "## Feature: …" section whose feature is not in `keep`, from its heading up to the
// next level-2 heading (or the end). Headings inside fenced code blocks are ignored.
export function stripFeatures(markdown: string, keep: readonly Feature[]): string {
  const drop = new Set(FEATURES.filter((feature) => !keep.includes(feature)).map((f) => FEATURE_HEADINGS[f]));
  if (drop.size === 0) return markdown;
  const out: string[] = [];
  let inFence = false;
  let skipping = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) skipping = drop.has(line.trim());
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

export function detectFeatures(specMarkdown: string): Feature[] {
  const lines = new Set(specMarkdown.split("\n").map((line) => line.trim()));
  return FEATURES.filter((feature) => lines.has(FEATURE_HEADINGS[feature]));
}
```

The fence toggle runs before the heading check on the same line, so a ```` ``` ```` line is never a heading. Note that `skipping` starts at a dropped heading and ends at the next kept `## ` heading.

Run: `npm test`. Expected: the feature tests PASS except `listSeedFiles` (next step).

- [ ] **Step 3: Write the failing `new-run` tests**

`scripts/test/new-run.test.ts` uses a temp runs dir (`mkdtempSync(join(tmpdir(), "orch-eval-test-"))`, removed in `after`) and a fake `gh`:

```ts
function fakeGh(responses: Record<string, ProcResult>) {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<ProcResult> => {
    calls.push(args);
    return responses[args.slice(0, 2).join(" ")] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { gh, calls };
}
```

| Test | Assertion |
|---|---|
| `runName and parseRunName round-trip` | `runName("session-orchestrator", 2)` → `"orch-eval-session-orchestrator-2"`; `parseRunName` of that → `{ variant: "session-orchestrator", n: 2 }`; `parseRunName("other")` → `null` |
| `nextRunNumber counts existing run folders` | empty dir → 1; after creating folders `orch-eval-a-1`, `orch-eval-a-3`, `orch-eval-b-7` → `nextRunNumber(dir, "a") === 4` |
| `listSeedFiles lists the seed without junk` | includes `README.md`, `docs/spec-v2.md`, `.github/workflows/ci.yml`, `src/routes.ts`; no entry contains `node_modules` or `.DS_Store` |
| `dry run builds a seed-only repo and never calls gh` | `newRun({ variant: "t", features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: true }, deps)` → repo dir `runsDir/orch-eval-t-1`; `git ls-files` (sorted) equals `listSeedFiles(seed)` (sorted); `git log --format=%s` is exactly `Seed v1`; branch is `main`; `docs/spec-v2.md` equals the seed's; kickoff file `runsDir/orch-eval-t-1.kickoff.md` equals `kickoff.md`; `calls.length === 0` |
| `dry run without Summary strips the spec and the kickoff` | features `["policy", "reports", "import"]` → the repo's `docs/spec-v2.md` has no `## Feature: Summary`; the kickoff file has none either |
| `a real run stops when the gh account is not the owner` | dryRun false, fake `gh api` returns `{ code: 0, stdout: "someone-else\n" }` → rejects with a message naming both accounts; the repo dir was not created; no `repo create` call |
| `a real run stops when the repo already exists` | fake `gh api` → `ncksol`; fake `gh repo` (view) → code 0 → rejects; no `repo create` call |
| `a real run creates a private repo and pushes` | fake `gh api` → `ncksol`; `gh repo view` → code 1; result: the last call is `["repo", "create", "ncksol/orch-eval-t-<n>", "--private", "--source", <repoDir>, "--remote", "origin", "--push"]` |
| `an existing run folder is never overwritten` | create `runsDir/orch-eval-t-9` first; `newRun({ …, n: 9, dryRun: true })` rejects |

Run: `npm test`. Expected: FAIL.

- [ ] **Step 4: Write `scripts/lib/new-run.ts`**

```ts
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ALL_FEATURES, stripFeatures, type Feature } from "./features.ts";
import { run, type ProcResult } from "./proc.ts";
import { KIT_DIR } from "./suite.ts";

export const RUN_NAME_PATTERN = /^orch-eval-(.+)-(\d+)$/;
const SKIP = new Set(["node_modules", ".DS_Store"]);

export interface NewRunOptions {
  variant: string;
  n?: number;
  features: Feature[];
  owner: string;
  runsDir: string;
  dryRun: boolean;
}

export interface NewRunDeps {
  gh: (args: string[]) => Promise<ProcResult>;
  log: (line: string) => void;
}

export interface NewRunResult {
  name: string;
  repoDir: string;
  kickoffPath: string;
  files: string[];
}

export function runName(variant: string, n: number): string {
  return `orch-eval-${variant}-${n}`;
}

export function parseRunName(name: string): { variant: string; n: number } | null {
  const match = RUN_NAME_PATTERN.exec(name);
  return match ? { variant: match[1], n: Number(match[2]) } : null;
}

export function nextRunNumber(runsDir: string, variant: string): number {
  if (!existsSync(runsDir)) return 1;
  let max = 0;
  for (const entry of readdirSync(runsDir)) {
    const parsed = parseRunName(entry);
    if (parsed && parsed.variant === variant) max = Math.max(max, parsed.n);
  }
  return max + 1;
}

export function listSeedFiles(seedDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(seedDir, path));
    }
  };
  walk(seedDir);
  return files.sort();
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd: repoDir });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function newRun(opts: NewRunOptions, deps: NewRunDeps): Promise<NewRunResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.variant)) throw new Error(`Variant "${opts.variant}" must be lowercase letters, digits and hyphens`);
  const n = opts.n ?? nextRunNumber(opts.runsDir, opts.variant);
  const name = runName(opts.variant, n);
  const slug = `${opts.owner}/${name}`;
  const repoDir = join(opts.runsDir, name);
  const kickoffPath = join(opts.runsDir, `${name}.kickoff.md`);
  if (existsSync(repoDir)) throw new Error(`${repoDir} already exists`);

  if (opts.dryRun) {
    deps.log(`Dry run: skipping the gh account check and repo creation for ${slug}`);
  } else {
    const who = await deps.gh(["api", "user", "--jq", ".login"]);
    const login = who.stdout.trim();
    if (who.code !== 0 || login.toLowerCase() !== opts.owner.toLowerCase()) {
      throw new Error(`The active gh account is "${login || "unknown"}", not "${opts.owner}". Switch with gh auth switch, or check GH_TOKEN.`);
    }
    const view = await deps.gh(["repo", "view", slug, "--json", "name"]);
    if (view.code === 0) throw new Error(`${slug} already exists on GitHub`);
  }

  const seedDir = join(KIT_DIR, "seed");
  cpSync(seedDir, repoDir, { recursive: true, filter: (src) => !SKIP.has(src.split(/[\\/]/).pop() ?? "") });
  if (opts.features.length !== ALL_FEATURES.length) {
    const specPath = join(repoDir, "docs", "spec-v2.md");
    writeFileSync(specPath, stripFeatures(readFileSync(specPath, "utf8"), opts.features));
  }
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Seed v1"]);

  const files = (await git(repoDir, ["ls-files"])).split("\n").filter(Boolean).sort();
  const expected = listSeedFiles(seedDir);
  if (files.join("\n") !== expected.join("\n")) {
    throw new Error(`The run repo's files differ from the seed's:\n${files.join("\n")}`);
  }

  writeFileSync(kickoffPath, stripFeatures(readFileSync(join(KIT_DIR, "kickoff.md"), "utf8"), opts.features));

  if (opts.dryRun) {
    deps.log(`Dry run: would run gh repo create ${slug} --private --source ${repoDir} --remote origin --push`);
  } else {
    const created = await deps.gh(["repo", "create", slug, "--private", "--source", repoDir, "--remote", "origin", "--push"]);
    if (created.code !== 0) throw new Error(`gh repo create failed: ${created.stderr.trim()}`);
  }
  return { name, repoDir, kickoffPath, files };
}
```

`stripFeatures(kickoff, ALL_FEATURES)` returns the kickoff unchanged, so the four-feature kickoff file is a byte-for-byte copy of `kickoff.md`.

- [ ] **Step 5: Write `scripts/new-run.ts` and the package script**

```ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ALL_FEATURES, featureSetName, parseFeatures } from "./lib/features.ts";
import { newRun } from "./lib/new-run.ts";
import { run } from "./lib/proc.ts";
import { KIT_DIR } from "./lib/suite.ts";

const { values } = parseArgs({
  options: {
    variant: { type: "string" },
    n: { type: "string" },
    features: { type: "string" },
    owner: { type: "string", default: "ncksol" },
    "runs-dir": { type: "string", default: join(homedir(), "orch-evals") },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.variant) {
  console.error("Usage: npm run new-run -- --variant <agent-name> [--n <k>] [--features <list>] [--owner <login>] [--runs-dir <dir>] [--dry-run]");
  process.exit(2);
}

const features = values.features === undefined ? ALL_FEATURES : parseFeatures(values.features);
const result = await newRun(
  {
    variant: values.variant,
    n: values.n === undefined ? undefined : Number(values.n),
    features,
    owner: values.owner,
    runsDir: resolve(values["runs-dir"]),
    dryRun: values["dry-run"],
  },
  { gh: (args) => run("gh", args), log: (line) => console.log(line) },
);

console.log(`
Run repo ready: ${result.repoDir} (${result.files.length} files, features ${featureSetName(features)})

Next steps:
1. In the Copilot app, add ${result.repoDir} as a project.
2. Start a new top-level session in that project with the agent "${values.variant}" and the held-constant model and effort.
   Never start the run from another session: the orchestrator always runs as a top-level session.
3. Paste the whole of ${result.kickoffPath} as the first message.
4. Answer any question straight away, word for word, from ${join(KIT_DIR, "answers.md")}. Send nothing else.
5. After the final report, before sending anything else, run from ${KIT_DIR}:
   npm run score -- --repo-dir ${result.repoDir}
`);
```

Add `"new-run": "node scripts/new-run.ts"` to the kit `package.json` scripts.

- [ ] **Step 6: Run the tests and a dry run**

Run: `npm test` (kit root). Expected: PASS.

Run: `npm run new-run -- --variant check --runs-dir "$(mktemp -d)" --dry-run`
Expected: prints the dry-run lines and the next steps; `git -C <repoDir> ls-files` lists only seed files. Delete the temp dir afterwards.

- [ ] **Step 7: Commit**

```bash
git add evals/orchestrator/expense-claims/package.json evals/orchestrator/expense-claims/scripts
git commit -m "feat(evals): add new-run script"
```

---
### Task 6: `score`

**Files:**
- Create: `scripts/lib/events.ts`, `scripts/lib/results.ts`, `scripts/score.ts`
- Create: `scripts/test/events.test.ts`, `scripts/test/results.test.ts`, `scripts/test/score.test.ts`, `scripts/test/fixtures/` (synthetic only)
- Modify: `package.json` (add the `score` script)

**Interfaces:**
- Consumes: `runSuite`, `suiteFiles`, `KIT_DIR` (Task 2); `detectFeatures`, `parseFeatures`, `featureSetName`, `ALL_FEATURES` (Tasks 2, 5); `parseRunName` (Task 5); `run` (Task 2).
- Produces:
  - `scripts/lib/events.ts`: `interface LogEvent`, `class EventLogError`, `readEventLog(path): { events: LogEvent[]; warnings: string[] }`, `computeTiming(events: LogEvent[]): Timing`, `yamlScalar(text, key): string | null`, `findRunSessions(stateDir, repository): SessionInfo[]` (oldest first).
  - `scripts/lib/results.ts`: `RESULT_COLUMNS`, `type ResultRow`, `toCsvLine(values: string[]): string`, `parseCsvText(text: string): string[][]`, `readResults(path): ResultRow[]`, `appendResult(path, row): void`, `median(values: number[]): number | null`, `summarize(rows): Summary`, `formatSummary(summary): string`.
  - CLI: see Step 5.

Timing rule (spec "Scoring", design calls; the log format is in the spec's "Facts checked" item 2):
- The session's own events are those with no `agentId`. Everything below uses only them.
- Start: the first `user.message` with no `data.source` (the kickoff).
- End: the last `assistant.message` after the kickoff.
- Blocked time, counted between start and end:
  - every `tool.execution_start` with `data.toolName === "ask_user"`: until the `tool.execution_complete` with the same `data.toolCallId` (capped at the end); with no complete, until the end, plus a warning;
  - every later human `user.message` (no `data.source`): the gap since the previous `assistant.turn_end`, but only when the latest `assistant.turn_start`/`assistant.turn_end` before the message is a `turn_end` (the orchestrator was idle). A message that arrives while a turn is running (steering or queued) adds no blocked time.
- Questions = `ask_user` calls + later human messages.
- Model and effort: `session.start` `data.selectedModel` and `data.reasoningEffort`, replaced by any `session.model_change` (`data.newModel`, `data.reasoningEffort`) before the kickoff; a `session.model_change` after the kickoff adds a warning.
- Agent: the last `subagent.selected` `data.agentName` at or before the kickoff. Copilot version: `session.start` `data.copilotVersion`.
- Never read or copy any `content`, `transformedContent`, `arguments` or `result` field.

- [ ] **Step 1: Write the failing event-log tests**

`scripts/test/events.test.ts` builds events in code with a helper `ev(type, minute, data = {}, agentId?)` whose timestamp is `2026-01-01T10:00:00.000Z` plus `minute` minutes. Base log `basic`: `session.start` (m 0, `{ selectedModel: "claude-opus-5.5", reasoningEffort: "max", copilotVersion: "1.0.99-2" }`), `subagent.selected` (m 0, `{ agentName: "orchestrator" }`), `user.message` (m 1, `{}`), `assistant.turn_start` (m 1), `assistant.message` (m 2), `assistant.turn_end` (m 2), `user.message` (m 10, `{ source: "agent-workspace-1" }`), `assistant.turn_start` (m 10), `assistant.message` (m 21), `assistant.turn_end` (m 21).

| Test | Log | Expected |
|---|---|---|
| `wall time runs from the kickoff to the last assistant message` | `basic` | `wallMs` 20 min, `blockedMs` 0, `scoredMs` 20 min, `questions` 0, `model` `claude-opus-5.5`, `effort` `max`, `copilotVersion` `1.0.99-2`, `agent` `orchestrator`, `start` and `end` are the two timestamps |
| `ask_user time is blocked time` | `basic` + `tool.execution_start` (m 3, `{ toolName: "ask_user", toolCallId: "q1" }`) + `tool.execution_complete` (m 5, `{ toolCallId: "q1" }`), inserted in time order | `blockedMs` 2 min, `askUserCalls` 1, `questions` 1, `scoredMs` 18 min |
| `an answer to a plain-text question subtracts the idle gap` | `basic` + human `user.message` (m 13, `{}`) between the m 10 report and a turn that starts at m 13; make the m 10 turn end at m 11 | `blockedMs` 2 min (m 11 → m 13), `humanMessages` 1, `questions` 1 |
| `a message sent while a turn runs adds no blocked time` | `basic` + human `user.message` (m 15, `{ delivery: "steering" }`) inside the m 10–21 turn | `blockedMs` 0, `questions` 1 |
| `sub-agent events are ignored` | `basic` + events with `agentId: "a1"`: `assistant.message` (m 30), `tool.execution_start` ask_user (m 4) and its complete (m 9), `user.message` (m 4, `{}`) | same result as `basic` |
| `a model change before the kickoff is the held model; after it, a warning` | `basic` + `session.model_change` (m 0.5, `{ newModel: "gpt-6-astra", reasoningEffort: "high" }`) + another at m 12 | `model` `gpt-6-astra`, `effort` `high`, one warning mentioning the model |
| `an unanswered ask_user counts until the end, with a warning` | `basic` + ask_user start at m 20 with no complete | `blockedMs` 1 min, one warning |
| `no kickoff is an error` | `basic` without the m 1 `user.message` | throws `EventLogError` |
| `no assistant message after the kickoff is an error` | `session.start`, `user.message` only | throws `EventLogError` |
| `readEventLog tolerates a torn last line` | temp file: two valid JSON lines + `{"type":"assistant.mess` | 2 events, 1 warning |
| `readEventLog rejects a bad line in the middle` | temp file: valid, `not json`, valid | throws `EventLogError` naming line 2 |
| `readEventLog reports a missing file` | a path that does not exist | throws `EventLogError` |
| `findRunSessions picks sessions by repository, oldest first` | temp state dir with `s1/workspace.yaml` (`repository: ncksol/orch-eval-x-1`, `created_at: 2026-01-01T10:05:00Z`), `s2` (same repo, `10:00`), `s3` (`ncksol/ai_tools`), `s4` (no workspace.yaml) | ids `["s2", "s1"]` |
| `yamlScalar reads plain and quoted values` | `"a: 1\nrepository: 'o/r'\nname: \"x y\"\n"` | `repository` → `o/r`, `name` → `x y`, `missing` → `null` |

Put the `readEventLog` temp files in `mkdtempSync(join(tmpdir(), "orch-eval-test-"))`.

Run: `npm test`. Expected: FAIL.

- [ ] **Step 2: Write `scripts/lib/events.ts`**

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LogEvent {
  type: string;
  timestamp: string;
  agentId?: string;
  data?: Record<string, unknown>;
}

export interface Timing {
  start: string;
  end: string;
  wallMs: number;
  blockedMs: number;
  scoredMs: number;
  askUserCalls: number;
  humanMessages: number;
  questions: number;
  model: string | null;
  effort: string | null;
  copilotVersion: string | null;
  agent: string | null;
  warnings: string[];
}

export interface SessionInfo {
  id: string;
  dir: string;
  repository: string;
  createdAt: string | null;
}

export class EventLogError extends Error {}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const at = (event: LogEvent): number => Date.parse(event.timestamp);
const isHuman = (event: LogEvent): boolean => event.type === "user.message" && !event.data?.source;

export function readEventLog(path: string): { events: LogEvent[]; warnings: string[] } {
  if (!existsSync(path)) throw new EventLogError(`No event log at ${path}`);
  const lines = readFileSync(path, "utf8").split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  const events: LogEvent[] = [];
  const warnings: string[] = [];
  for (let i = 0; i <= last; i++) {
    if (lines[i].trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      if (i === last) {
        warnings.push(`Ignored an incomplete last line (line ${i + 1})`);
        continue;
      }
      throw new EventLogError(`Line ${i + 1} of ${path} is not valid JSON`);
    }
    const event = parsed as LogEvent;
    if (typeof event?.type !== "string" || Number.isNaN(Date.parse(event?.timestamp))) {
      throw new EventLogError(`Line ${i + 1} of ${path} has no type or no valid timestamp`);
    }
    events.push(event);
  }
  return { events, warnings };
}

export function computeTiming(events: LogEvent[]): Timing {
  const own = events.filter((event) => !event.agentId);
  const kickoff = own.findIndex(isHuman);
  if (kickoff < 0) throw new EventLogError("No kickoff: the session has no user.message without data.source");
  let last = -1;
  for (let i = own.length - 1; i > kickoff; i--) {
    if (own[i].type === "assistant.message") {
      last = i;
      break;
    }
  }
  if (last < 0) throw new EventLogError("No assistant.message after the kickoff");

  const start = at(own[kickoff]);
  const end = at(own[last]);
  const warnings: string[] = [];
  const completes = new Map<string, LogEvent>();
  for (const event of own) {
    const id = str(event.data?.toolCallId);
    if (event.type === "tool.execution_complete" && id) completes.set(id, event);
  }

  let blockedMs = 0;
  let askUserCalls = 0;
  let humanMessages = 0;
  let lastTurn: LogEvent | null = null;
  for (const event of own.slice(kickoff + 1, last + 1)) {
    if (event.type === "assistant.turn_start" || event.type === "assistant.turn_end") {
      lastTurn = event;
    } else if (event.type === "tool.execution_start" && event.data?.toolName === "ask_user") {
      askUserCalls++;
      const done = completes.get(str(event.data?.toolCallId) ?? "");
      if (done) {
        blockedMs += Math.min(at(done), end) - at(event);
      } else {
        blockedMs += end - at(event);
        warnings.push("An ask_user call has no completion; it counts as blocked until the end");
      }
    } else if (isHuman(event)) {
      humanMessages++;
      if (lastTurn?.type === "assistant.turn_end") blockedMs += at(event) - at(lastTurn);
    }
  }

  const session = own.find((event) => event.type === "session.start");
  let model = str(session?.data?.selectedModel);
  let effort = str(session?.data?.reasoningEffort);
  let agent: string | null = null;
  own.forEach((event, i) => {
    if (event.type === "session.model_change") {
      if (i < kickoff) {
        model = str(event.data?.newModel) ?? model;
        effort = str(event.data?.reasoningEffort) ?? effort;
      } else if (i <= last) {
        warnings.push("The session's model changed during the run");
      }
    }
    if (event.type === "subagent.selected" && i <= kickoff) agent = str(event.data?.agentName) ?? agent;
  });

  const wallMs = end - start;
  return {
    start: own[kickoff].timestamp,
    end: own[last].timestamp,
    wallMs,
    blockedMs,
    scoredMs: wallMs - blockedMs,
    askUserCalls,
    humanMessages,
    questions: askUserCalls + humanMessages,
    model,
    effort,
    copilotVersion: str(session?.data?.copilotVersion),
    agent,
    warnings,
  };
}

export function yamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  if (!match) return null;
  return str(match[1].trim().replace(/^(['"])(.*)\1$/, "$2"));
}

export function findRunSessions(stateDir: string, repository: string): SessionInfo[] {
  const found: SessionInfo[] = [];
  for (const id of readdirSync(stateDir)) {
    let text: string;
    try {
      text = readFileSync(join(stateDir, id, "workspace.yaml"), "utf8");
    } catch {
      continue;
    }
    const repo = yamlScalar(text, "repository");
    if (!repo || repo.toLowerCase() !== repository.toLowerCase()) continue;
    found.push({ id, dir: join(stateDir, id), repository: repo, createdAt: yamlScalar(text, "created_at") });
  }
  return found.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}
```

Run: `npm test`. Expected: the events tests PASS.

- [ ] **Step 3: Write the failing results tests, then `scripts/lib/results.ts`**

`RESULT_COLUMNS`, in this order: `date, variant, run, repo, session, agent, features, calibration, outcome, minutes, wall_minutes, blocked_minutes, questions, suite_passed, suite_total, prs_merged, main_ci, model, effort, copilot_version, note`. `outcome` is one of `passed`, `gate-failed`, `timeout`, `stalled`; `calibration` is `yes` or `no`; minutes have one decimal.

`scripts/test/results.test.ts`:

| Test | Assertion |
|---|---|
| `CSV lines quote only when needed and round-trip` | `toCsvLine(["a", "b,c", "say \"hi\"", "x\ny", ""])` → `a,"b,c","say ""hi""","x\ny",` (with a real line break); `parseCsvText(line + "\n")` returns the five values |
| `appendResult writes the header once` | temp path; append two rows; the file has 3 lines and the first is `RESULT_COLUMNS.join(",")`; `readResults` returns both rows |
| `readResults rejects a different header` | file with header `a,b` → throws |
| `median handles odd, even and empty lists` | `[3, 1, 2]` → 2; `[4, 1, 3, 2]` → 2.5; `[]` → `null` |
| `the calibration batch counts when its median is 30 minutes or less` | rows: variant A calibration yes passed 25 min (full set); B calibration yes passed 28; A calibration no passed 20; B calibration no gate-failed 15 → `calibration.median` 26.5, `counted` true; A: runs 2, passed 2, median 22.5; B: runs 2, passed 1, pass rate 0.5, median 28 |
| `a slow calibration batch is left out and says to drop Summary` | A calibration yes passed 35; B calibration yes timeout 90 (counts as infinity); C calibration yes stalled (left out of the median) → `calibration.median` `Infinity` is not shown; `counted` false; the formatted text contains `drop Summary` and `--features policy,reports,import`; A has 0 scored runs |
| `runs are grouped by feature set` | full-set and three-feature rows for one variant → two groups, keyed by `features` |

`scripts/lib/results.ts`:

```ts
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ALL_FEATURES, featureSetName } from "./features.ts";

export const RESULT_COLUMNS = [
  "date", "variant", "run", "repo", "session", "agent", "features", "calibration", "outcome",
  "minutes", "wall_minutes", "blocked_minutes", "questions", "suite_passed", "suite_total",
  "prs_merged", "main_ci", "model", "effort", "copilot_version", "note",
] as const;
export type ResultRow = Record<(typeof RESULT_COLUMNS)[number], string>;

export const CALIBRATION_LIMIT_MINUTES = 30;
const FULL_SET = featureSetName(ALL_FEATURES);

export function toCsvLine(values: string[]): string {
  return values.map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)).join(",");
}

export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readResults(path: string): ResultRow[] {
  if (!existsSync(path)) return [];
  const [header, ...rows] = parseCsvText(readFileSync(path, "utf8"));
  if (!header || header.join(",") !== RESULT_COLUMNS.join(",")) {
    throw new Error(`${path} does not start with the expected header: ${RESULT_COLUMNS.join(",")}`);
  }
  return rows.map((values) => Object.fromEntries(RESULT_COLUMNS.map((column, i) => [column, values[i] ?? ""])) as ResultRow);
}

export function appendResult(path: string, row: ResultRow): void {
  if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") writeFileSync(path, RESULT_COLUMNS.join(",") + "\n");
  appendFileSync(path, toCsvLine(RESULT_COLUMNS.map((column) => row[column])) + "\n");
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface VariantSummary {
  features: string;
  variant: string;
  runs: number;
  passed: number;
  passRate: number;
  medianMinutes: number | null;
}

export interface Summary {
  calibration: { runs: number; median: number | null; counted: boolean };
  groups: VariantSummary[];
}

// Spec "Sizing": the first run of each variant (calibration = yes) forms the calibration batch.
// Passed runs count with their minutes, timeouts count as longer than any limit, other outcomes
// are left out. If the batch median is 30 minutes or less, calibration runs count as scored runs.
export function summarize(rows: ResultRow[]): Summary {
  const batch = rows.filter((row) => row.calibration === "yes" && row.features === FULL_SET);
  const times = batch.flatMap((row) =>
    row.outcome === "passed" ? [Number(row.minutes)] : row.outcome === "timeout" ? [Infinity] : [],
  );
  const batchMedian = median(times);
  const counted = batchMedian !== null && batchMedian <= CALIBRATION_LIMIT_MINUTES;
  const scored = rows.filter((row) => row.calibration !== "yes" || counted);
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = `${row.features}\u0000${row.variant}`;
    if (!groups.has(key)) groups.set(key, []);
  }
  for (const row of scored) groups.get(`${row.features}\u0000${row.variant}`)!.push(row);
  return {
    calibration: { runs: batch.length, median: batchMedian, counted },
    groups: [...groups.entries()].map(([key, group]) => {
      const [features, variant] = key.split("\u0000");
      const passed = group.filter((row) => row.outcome === "passed");
      return {
        features,
        variant,
        runs: group.length,
        passed: passed.length,
        passRate: group.length === 0 ? 0 : passed.length / group.length,
        medianMinutes: median(passed.map((row) => Number(row.minutes))),
      };
    }),
  };
}

export function formatSummary(summary: Summary): string {
  const lines: string[] = [];
  const { calibration } = summary;
  if (calibration.runs === 0) {
    lines.push("Calibration: no calibration runs yet.");
  } else {
    const shown = calibration.median === null ? "n/a" : Number.isFinite(calibration.median) ? `${calibration.median.toFixed(1)} min` : `over ${CALIBRATION_LIMIT_MINUTES} min (timeouts count as longest)`;
    lines.push(`Calibration: ${calibration.runs} run(s), median ${shown}.`);
    if (calibration.counted) lines.push("Calibration runs count as scored runs.");
    else if (calibration.median !== null) {
      lines.push(`The median is over ${CALIBRATION_LIMIT_MINUTES} minutes: drop Summary. Start every scored run with --features policy,reports,import.`);
    }
  }
  for (const features of new Set(summary.groups.map((group) => group.features))) {
    lines.push("", `Feature set ${features}:`, "variant                      runs  passed  pass rate  median min (passed)");
    for (const group of summary.groups.filter((g) => g.features === features)) {
      const medianText = group.medianMinutes === null ? "-" : group.medianMinutes.toFixed(1);
      lines.push(
        `${group.variant.padEnd(28)} ${String(group.runs).padStart(4)}  ${String(group.passed).padStart(6)}  ${`${Math.round(group.passRate * 100)}%`.padStart(9)}  ${medianText.padStart(19)}`,
      );
    }
  }
  return lines.join("\n");
}
```

Run: `npm test`. Expected: the results tests PASS.

- [ ] **Step 4: Write the failing end-to-end `score` test**

`scripts/test/score.test.ts` (one test, about 15 s because it runs the suite):

1. Make a temp dir. Copy `reference/` into `<tmp>/orch-eval-e2e-1`, then `git init -q -b main`, `git add -A`, `git commit -q -m "Reference"` there.
2. Make `<tmp>/state/s1/workspace.yaml` with `repository: local/orch-eval-e2e-1` and `created_at: 2026-01-01T10:00:00Z`, and `<tmp>/state/s1/events.jsonl` with the synthetic `basic` log from Step 1 plus one ask_user pair of 2 minutes (one JSON object per line). Write this fixture from the test, not from a real log.
3. Run `node scripts/score.ts --repo-dir <tmp>/orch-eval-e2e-1 --session s1 --state-dir <tmp>/state --no-github --results <tmp>/results.csv` with `cwd` = kit root.
4. Expect exit code 0 and one row in `<tmp>/results.csv` with: `variant` `e2e`, `run` `1`, `session` `s1`, `agent` `orchestrator`, `features` `policy+reports+import+summary`, `calibration` `yes`, `outcome` `passed`, `minutes` `18.0`, `wall_minutes` `20.0`, `blocked_minutes` `2.0`, `questions` `1`, `suite_passed` = `suite_total` = `65`, `prs_merged` `n/a`, `main_ci` `n/a`, `model` `claude-opus-5.5`, `effort` `max`, `copilot_version` `1.0.99-2`.
5. Run the same command with `--session missing`: expect exit code 2 and a stderr line that mentions `--start` (the manual fallback).

- [ ] **Step 5: Write `scripts/score.ts` and the package script**

CLI:

```text
npm run score -- --repo-dir <run clone> [options]
npm run score -- --summary [--results <csv>]

--repo-dir <dir>       local clone of the run repo (its folder name is orch-eval-<variant>-<n>)
--session <id>         orchestrator session id (default: the oldest session whose workspace.yaml
                       repository is the run repo)
--state-dir <dir>      default ~/.copilot/session-state
--variant <name>, --n <k>   default: parsed from the repo folder name
--features <list>      default: read from docs/spec-v2.md on main
--outcome <timeout|stalled> record a run that never finished
--calibration <yes|no> default: yes when results.csv has no earlier row for this variant
--results <csv>        default: results.csv in the kit
--no-github            skip gh: clone from the local repo, record prs_merged and main_ci as n/a
--start <iso> --end <iso> [--blocked-min <m>] [--questions <n>]   manual timing, skips the log
--note <text>
```

Flow of `main()`:
1. `--summary`: print `formatSummary(summarize(readResults(results)))` and exit 0.
2. Resolve `repoDir`; `parseRunName(basename(repoDir))` for variant and n unless given (error if neither).
3. `origin` = `git -C repoDir remote get-url origin` (may fail). `slug` = `owner/name` parsed from a `github.com[:/]owner/name(.git)` origin, else `null`.
4. Timing. Manual mode when `--start` is given: needs `--end`; `wallMs` = end − start, `blockedMs` = `--blocked-min` × 60 000 (default 0), `questions` = `--questions` (default 0), session `manual`, model/effort/agent/version empty. Otherwise: session id = `--session`, or `findRunSessions(stateDir, slug ?? "local/" + basename(repoDir))[0]` (none → error); `readEventLog(join(stateDir, id, "events.jsonl"))` and `computeTiming`. Print the chosen session id, its agent and the count of candidate sessions. On `EventLogError` (or no session), print to stderr: `Could not time the run from the session log: <reason>. Time it by hand (README "Manual timing") and rerun with --start, --end, --blocked-min and --questions.` and exit 2. Print every warning.
5. Fresh clone of `main` into a temp dir: with `slug` and without `--no-github`: `gh repo clone <slug> <tmp> -- --branch main --depth 1`; otherwise `git clone -q --branch main <repoDir> <tmp>` and print that the local repo was used. Delete the temp dir at the end (also on failure).
6. Features = `--features` or `detectFeatures(<tmp>/docs/spec-v2.md)`. Run `runSuite(tmp, suiteFiles(features))`; print `passed/total` and the failing names.
7. With GitHub: `prs_merged` = `gh pr list -R <slug> --state merged --limit 200 --json number --jq length`; `main_ci` = the `conclusion` (or `status` if not completed) of the `gh run list -R <slug> --branch main --limit 20 --json headSha,status,conclusion` entry whose `headSha` equals `git -C <tmp> rev-parse HEAD`, else `none`. Without GitHub: both `n/a`.
8. Outcome: `--outcome` if given; else `timeout` when `wallMs` > 90 min; else `passed` when the suite is `ok`, otherwise `gate-failed`.
9. Calibration: `--calibration`, else `yes` when `readResults(results)` has no row with this variant.
10. Build the row (`date` = `new Date().toISOString()`, `repo` = `slug ?? basename(repoDir)`, minutes as `(ms / 60000).toFixed(1)`, `note` = `--note` or the warnings joined with `; `), `appendResult`, print the row as `column: value` lines, then `formatSummary(summarize(readResults(results)))`.
11. Print the memory-hygiene reminder: `Now check for user-level memories saved during this run (README "Memory hygiene") and remove eval-related ones.`
12. Exit 0, also when the gate failed (the row records it).

Add `"score": "node scripts/score.ts"` to the kit `package.json` scripts. The `parseArgs` options use `type: "boolean"` for `no-github` and `summary`.

Run: `npm test` (kit root). Expected: PASS, including the end-to-end test.

- [ ] **Step 6: Commit**

```bash
git add evals/orchestrator/expense-claims/package.json evals/orchestrator/expense-claims/scripts
git commit -m "feat(evals): add score script"
```

---
### Task 7: Runbook, results file, kit check and repo instructions

**Files:**
- Create: `README.md` (kit runbook), `results.csv`, `scripts/check-kit.ts`
- Modify: `package.json` (add the `check` script), `.github/copilot-instructions.md` (repository root)

**Interfaces:**
- Consumes: every script and library from Tasks 2, 5 and 6.
- Produces: `npm run check` (all local kit acceptance checks; exit 0 only when all pass), `node scripts/check-kit.ts --session <id>` (also times a real session log against a local reference checkout).

- [ ] **Step 1: Write `results.csv`**

One line, the header, ending with a line break:

```text
date,variant,run,repo,session,agent,features,calibration,outcome,minutes,wall_minutes,blocked_minutes,questions,suite_passed,suite_total,prs_merged,main_ci,model,effort,copilot_version,note
```

- [ ] **Step 2: Write `scripts/check-kit.ts`**

Runs the spec's "Kit acceptance checks" that can run locally and prints one `PASS`/`FAIL` line per check with its evidence (counts, paths). Each check runs even if an earlier one failed. Exit 1 if any failed.

| Check | How |
|---|---|
| `seed npm test` | `run("npm", ["test"], { cwd: seed })`: exit 0; report the `# pass` and `# fail` counts from its output |
| `reference npm test` | the same in `reference/` |
| `suite passes 100% on the reference` | `runSuite(reference, suiteFiles(ALL_FEATURES))`: `ok`; report `passed/total` |
| `suite passes on the reference without Summary` | `runSuite(reference, suiteFiles(["policy", "reports", "import"]))`: `ok` |
| `v1 regressions pass on the seed` | `runSuite(seed, [suiteFile("v1")])`: `ok` |
| `every v2 test fails on the seed` | for each feature, `runSuite(seed, [suiteFile(feature)])`: `passed === 0 && total > 0`; report the totals |
| `spec copies match` | `reference/docs/spec-v2.md` equals `seed/docs/spec-v2.md`; `kickoff.md` ends with `"\n---\n\n" + spec` |
| `new-run --dry-run gives a seed-only repo` | in a temp runs dir, `run(process.execPath, ["scripts/new-run.ts", "--variant", "check", "--runs-dir", tmp, "--dry-run"])`: exit 0; `git ls-files` equals `listSeedFiles(seed)`; no path starts with `acceptance/` or `reference/` and none is `results.csv`, `kickoff.md` or `answers.md`; one commit `Seed v1` |
| `new-run --dry-run without Summary` | the same with `--features policy,reports,import` and `--variant check-3`: the repo's spec and the kickoff file have no `## Feature: Summary` |
| `score against a local reference checkout` | only with `--session <id>`: copy `reference/` to `<tmp>/orch-eval-check-1`, `git init`/commit on `main`, then `run(process.execPath, ["scripts/score.ts", "--repo-dir", …, "--session", id, "--no-github", "--results", <tmp>/results.csv])`: exit 0 and a row with `suite_passed` = `suite_total` = 65; report the row's `wall_minutes`, `blocked_minutes`, `minutes` and `questions`. Without `--session`, print `SKIP` with the reason. |
| `kit tests` | `run("npm", ["test"], { cwd: KIT_DIR })`: exit 0; report the counts |

Delete every temp dir at the end. Add `"check": "node scripts/check-kit.ts"` to the kit `package.json` scripts.

Run: `npm run check` (kit root). Expected: every line `PASS`, the score line `SKIP`, exit 0.

- [ ] **Step 3: Write the kit `README.md` (runbook)**

Plain English, B2 level, short sentences. Sections, in this order, each with the content listed:

1. **What this is** — compares orchestrator agents (`ghcp/agents/orchestrator.agent.md`, `ghcp/agents/session-orchestrator.agent.md`, later versions) on one fixed task: v2 of a small expense-claims API (four features: Policy, Reports, CSV import, Summary) from a working v1. Speed is the score; a hidden acceptance suite is a pass/fail gate. Link the design: `../../../docs/superpowers/specs/2026-10-18-orchestrator-eval-design.md`.
2. **What's in the kit** — the layout table (README, kickoff.md, answers.md, results.csv, seed/, reference/, acceptance/, scripts/, package.json) with one line each. State that only `seed/` goes into a run repo, and that `acceptance/` and `reference/` must never be copied into a run repo, pasted into a session or mentioned in the kickoff.
3. **Before the first run** — Node 24; `gh` logged in as the repo owner with the `repo` scope (`new-run` checks the active account, because several accounts may be logged in); the Copilot app. Choose the held-constant model and effort for the orchestrator session (for example Claude Opus 5.5 at max) and use it for every run; `score` records it.
4. **Run it** — the six steps from the spec's "Steps per run", with the exact commands: `npm run new-run -- --variant <agent-name>` (repo `ncksol/orch-eval-<variant>-<n>`, clone in `~/orch-evals/`, kickoff file `~/orch-evals/<name>.kickoff.md`); add the clone as a project; start a **new top-level session** with the agent under test — in bold: an orchestrator run is always a top-level session that you start; never start one as a child of another session, and never ask an agent to start one; paste the kickoff file; answer only from `answers.md`; after the final report, before sending anything else, `npm run score -- --repo-dir ~/orch-evals/<name>`.
5. **When a run doesn't finish** — timeout: no final report 90 minutes after the kickoff; stalled: the orchestrator and all its child sessions idle for 15 minutes with the work not done. Never nudge a run. Record it with `npm run score -- --repo-dir … --outcome timeout` (or `stalled`).
6. **Scoring** — the score is wall-clock minutes from the kickoff to the final report minus blocked time; the blocked-time rule in plain words (ask_user durations; the idle gap before each answer to a plain-text question); the gate is 100% of the suite on a fresh clone of `main`; outcomes `passed`, `gate-failed`, `timeout`, `stalled`; only passed runs enter the time comparison; compare medians per variant within one feature set; `npm run score -- --summary` prints them. Describe each `results.csv` column in a table. Commit `results.csv` after each run.
7. **Calibration** — the first run of each variant is its calibration run (`score` marks it). When every variant has one: if their median is 30 minutes or less they count as scored runs; if it is over 30, drop Summary once, before any scored run: start every later run with `npm run new-run -- --variant <v> --features policy,reports,import` (this removes Summary from the run repo's spec and from the kickoff file); `score` reads the feature set from the run repo's spec, and the suite runs without the Summary tests. Calibration rows stay in `results.csv`. `--summary` prints the calibration state.
8. **Manual timing** — if `score` can't read the event log (the format is internal to Copilot and may change): find the kickoff time and the final report time in the session, add up the minutes spent waiting for your answers, and run `npm run score -- --repo-dir … --start <iso> --end <iso> --blocked-min <m> --questions <n>`. Explain how `score` finds the session (the oldest session in `~/.copilot/session-state/` whose `workspace.yaml` names the run repo) and that `--session <id>` overrides it; the id is the session folder name.
9. **Memory hygiene** — after each run, check user-level Copilot memories for anything saved during the run (orchestrator or eval related) and remove it, because user memories carry into later runs. Repo memories don't carry over, because every run uses a new repo.
10. **Cleaning up** — run repos stay until you delete them. Deleting needs a token with the `delete_repo` scope (the usual `GH_TOKEN` doesn't have it, and `gh auth refresh` can't add a scope to an environment token) or the GitHub web UI. Local clones are in `~/orch-evals/`.
11. **Known limits** — runs vary, so three runs per variant may still be noisy; GitHub Actions queue time adds noise; an agent that searches the disk could find this kit in a local checkout of this repo; merge conflicts in `src/routes.ts` and the README are deliberate.
12. **Changing the kit** — run `npm test` and `npm run check` from this folder after any change. If you change `seed/docs/spec-v2.md`, copy it to `reference/docs/spec-v2.md`, update the spec part of `kickoff.md` (the kit tests check both), and update the suite and the reference so every suite assertion still maps to a statement in the spec or the seed README. Old `results.csv` rows are then not comparable with new ones; say so in their `note`.

- [ ] **Step 4: Update `.github/copilot-instructions.md`**

Make exactly these edits:

1. In "Repository purpose", replace `Individual plugins may vendor their own Node.js scripts and tests; those are the only things in the repo that are executed.` with `Individual plugins may vendor their own Node.js scripts and tests, and eval kits under evals/ have their own scripts and tests; those are the only things in the repo that are executed.`
2. In "Layout", after the marketplace manifest bullet, add: `` - Evals: `evals/<area>/<eval-name>/` (a self-contained eval kit with its own `package.json`, scripts, tests and runbook) ``
3. After the "**Plugins:**" list (before "When adding a new skill"), add:

   ```markdown
   **Evals:**

   - `orchestrator/expense-claims` — speed eval for the orchestrator agents. A run gives an orchestrator a fixed task (v2 of a small expense-claims API) in a fresh private repo, times it from the session's event log, and gates it on a hidden acceptance suite. Holds the v1 seed app, the v2 spec, the kickoff prompt and answer sheet, the hidden suite, a reference v2 implementation, `new-run` and `score` scripts, and `results.csv`. Only `seed/` ever goes into a run repo. Runbook: `evals/orchestrator/expense-claims/README.md`.
   ```

4. In "Working in this repo", after the swarm-dashboard bullet, add:
   - `` - Eval kits have tests. After touching anything under `evals/orchestrator/expense-claims/`, run `npm test && npm run check` from that directory. `npm run check` runs the kit's local acceptance checks. ``
   - `- Orchestrator eval runs are top-level sessions that the user starts. Never start one as a child session, and never create a run repo (\`new-run\` without \`--dry-run\`) without the user's approval.`

Write the second bullet with real backticks around `new-run` and `--dry-run` (the escaping above is only for this plan).

- [ ] **Step 5: Verify and commit**

Run (kit root): `npm test && npm run check`
Expected: all PASS (score check SKIP).

Check the README links: `../../../docs/superpowers/specs/2026-10-18-orchestrator-eval-design.md` resolves from `evals/orchestrator/expense-claims/`.

```bash
git add evals/orchestrator/expense-claims .github/copilot-instructions.md
git commit -m "docs(evals): add expense-claims runbook, results file and kit check"
```

---

### Task 8: Final verification (controller)

Run by the controller, not an implementer. Keep the evidence (commands, outcomes, counts, commit) for the report.

- [ ] **Step 1:** `cd evals/orchestrator/expense-claims && npm test && npm run check` — all PASS.
- [ ] **Step 2:** Pick a real top-level session log for the real-log check, for example the coordinating orchestrator session `8cc04079-926e-4cd1-ad88-10c3a9975670`. Run `node scripts/check-kit.ts --session <id>` — the score line PASS with `suite 65/65`. Cross-check the computed wall and blocked minutes with an independent one-off computation over the same `events.jsonl` (timestamps and types only; print nothing else). Never copy message contents into the repo.
- [ ] **Step 3:** Confirm no GitHub repo was created: `gh repo list ncksol --limit 1000 --json name --jq '.[].name' | grep '^orch-eval-' || echo none` → `none`.
- [ ] **Step 4:** Confirm the branch changes only allowed paths: `git diff --name-only main...HEAD` lists only `evals/orchestrator/expense-claims/**`, the spec, this plan and `.github/copilot-instructions.md`.
- [ ] **Step 5:** Max-tier review, on a different vendor from the suite's author, mapping every acceptance-suite assertion to a statement in `seed/docs/spec-v2.md` or `seed/README.md`. Fix any unmapped assertion (in the suite, or in the spec with a ruling) and re-run Steps 1–2.
- [ ] **Step 6:** Push the branch and report the evidence with the pushed commit.
