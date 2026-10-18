import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Expense } from "../src/expenses.ts";
import { evaluatePolicy, type Violation } from "../src/policy.ts";
import { startTestApp, type TestApp } from "./helpers.ts";

const WED = "2026-03-04";
const THU = "2026-03-05";
const FRI = "2026-03-06";
const SAT = "2026-03-07";
const SUN = "2026-03-08";

let seq = 0;
function expense(fields: Partial<Expense>): Expense {
  seq += 1;
  return {
    id: `e${seq}`,
    date: WED,
    merchant: "Shop",
    category: "other",
    amount: 100,
    currency: "GBP",
    description: "",
    receipt: false,
    ...fields,
  };
}

const summary = (violations: Violation[]) => violations.map((v) => [v.code, v.severity, v.expenseIds]);

test("P1 RECEIPT_REQUIRED above 2500 GBP, not at 2500", () => {
  const a = expense({ amount: 2500 });
  const b = expense({ amount: 2501 });
  assert.deepEqual(summary(evaluatePolicy([a, b])), [["RECEIPT_REQUIRED", "error", [b.id]]]);
});

test("P1 compares the GBP equivalent", () => {
  const a = expense({ amount: 2941, currency: "EUR" });
  const b = expense({ amount: 2942, currency: "EUR" });
  assert.deepEqual(summary(evaluatePolicy([a, b])), [["RECEIPT_REQUIRED", "error", [b.id]]]);
});

test("P1 a receipt clears the rule", () => {
  assert.deepEqual(evaluatePolicy([expense({ amount: 9000, receipt: true })]), []);
});

test("P2 MEALS_DAILY_CAP above 5000 on a date, not at 5000", () => {
  const a = expense({ category: "meals", amount: 3000, receipt: true, date: WED });
  const b = expense({ category: "meals", amount: 2000, date: WED });
  assert.deepEqual(evaluatePolicy([a, b]), []);
  const c = expense({ category: "meals", amount: 3000, receipt: true, date: THU });
  const d = expense({ category: "meals", amount: 2001, date: THU });
  assert.deepEqual(summary(evaluatePolicy([c, d])), [["MEALS_DAILY_CAP", "error", [c.id, d.id]]]);
});

test("P2 converts each expense before adding", () => {
  const a = expense({ category: "meals", amount: 4983, receipt: true });
  const b = expense({ category: "meals", amount: 10, currency: "EUR" });
  const c = expense({ category: "meals", amount: 10, currency: "EUR" });
  assert.deepEqual(summary(evaluatePolicy([a, b, c])), [["MEALS_DAILY_CAP", "error", [a.id, b.id, c.id]]]);
});

test("P2 counts only meals", () => {
  const a = expense({ category: "meals", amount: 3000, receipt: true });
  const b = expense({ category: "travel", amount: 3000, receipt: true });
  assert.deepEqual(evaluatePolicy([a, b]), []);
});

test("P3 WEEKEND warns on Saturday and Sunday", () => {
  const fri = expense({ date: FRI });
  const sat = expense({ date: SAT });
  const sun = expense({ date: SUN });
  assert.deepEqual(summary(evaluatePolicy([fri, sat, sun])), [
    ["WEEKEND", "warning", [sat.id]],
    ["WEEKEND", "warning", [sun.id]],
  ]);
});

test("P4 P5 rule order, meals caps by date", () => {
  const a = expense({ category: "travel", amount: 3000, date: SAT });
  const b = expense({ category: "meals", amount: 3000, date: THU, receipt: true });
  const c = expense({ category: "meals", amount: 2500, date: THU });
  const d = expense({ category: "meals", amount: 5001, date: WED });
  const violations = evaluatePolicy([a, b, c, d]);
  assert.deepEqual(summary(violations), [
    ["RECEIPT_REQUIRED", "error", [a.id]],
    ["RECEIPT_REQUIRED", "error", [d.id]],
    ["MEALS_DAILY_CAP", "error", [d.id]],
    ["MEALS_DAILY_CAP", "error", [b.id, c.id]],
    ["WEEKEND", "warning", [a.id]],
  ]);
  for (const v of violations) assert.ok(v.message.trim().length > 0);
});

test("P6 no violations gives an empty array", () => {
  assert.deepEqual(evaluatePolicy([]), []);
  assert.deepEqual(evaluatePolicy([expense({})]), []);
});

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(async () => {
  await app.close();
});

async function create(fields: Record<string, unknown>): Promise<string> {
  const res = await app.request("POST", "/expenses", {
    date: WED,
    merchant: "Shop",
    category: "other",
    amount: 100,
    currency: "GBP",
    ...fields,
  });
  assert.equal(res.status, 201);
  return res.body.id;
}

test("P7 P8 POST /policy/check returns the violations in request order", async () => {
  const b = await create({ amount: 3000 });
  const a = await create({ amount: 2600 });
  await create({ amount: 9999, date: SAT });
  const res = await app.request("POST", "/policy/check", { expenseIds: [a, b] });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.violations.map((v: any) => [v.code, v.severity, v.expenseIds]),
    [
      ["RECEIPT_REQUIRED", "error", [a]],
      ["RECEIPT_REQUIRED", "error", [b]],
    ],
  );
  const empty = await app.request("POST", "/policy/check", { expenseIds: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { violations: [] });
});

test("P9 expenseIds must be an array of strings", async () => {
  for (const body of [{}, { expenseIds: "exp_1" }, { expenseIds: [1] }, { expenseIds: null }]) {
    const res = await app.request("POST", "/policy/check", body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(res.body.error.details.map((d: any) => d.field), ["expenseIds"]);
  }
  const bad = await app.request("POST", "/policy/check", "{bad");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "INVALID_JSON");
});

test("P10 an unknown expense id returns NOT_FOUND", async () => {
  const a = await create({});
  const res = await app.request("POST", "/policy/check", { expenseIds: [a, "nope"] });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "NOT_FOUND");
});
