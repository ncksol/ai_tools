import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, createExpense, detailFields, pick, unknownId, useApp, type Res } from "./helpers.ts";

const app = useApp();

const MON = "2026-03-02";
const WED = "2026-03-04";
const THU = "2026-03-05";
const FRI = "2026-03-06";
const SAT = "2026-03-07";
const SUN = "2026-03-08";

function check(ids: unknown[]): Promise<Res> {
  return app().request("POST", "/policy/check", { expenseIds: ids });
}

async function id(fields: Record<string, unknown>): Promise<string> {
  return (await createExpense(app(), fields)).id;
}

function assertViolations(res: Res, expected: [string, string, string[]][]): void {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const violations = res.body.violations;
  assert.deepEqual(
    violations.map((v: any) => [v.code, v.severity, v.expenseIds]),
    expected,
  );
  for (const v of violations) assert.ok(typeof v.message === "string" && v.message.length > 0, JSON.stringify(v));
}

test("P1 RECEIPT_REQUIRED above 2500 without a receipt", async () => {
  // P7/P8: an expense left out of the request is not checked.
  await id({ category: "travel", amount: 9999, date: SAT });
  const a = await id({ category: "travel", amount: 2501 });
  assertViolations(await check([a]), [["RECEIPT_REQUIRED", "error", [a]]]);
});

test("P1 exactly 2500 needs no receipt", async () => {
  const a = await id({ category: "travel", amount: 2500 });
  assertViolations(await check([a]), []);
});

test("P1 a receipt clears the rule", async () => {
  const a = await id({ category: "travel", amount: 9000, receipt: true });
  assertViolations(await check([a]), []);
});

test("P1 compares GBP equivalents from convert()", async () => {
  const a = await id({ category: "travel", amount: 2941, currency: "EUR" });
  const b = await id({ category: "travel", amount: 2942, currency: "EUR" });
  const c = await id({ category: "travel", amount: 3126, currency: "USD" });
  const d = await id({ category: "travel", amount: 3125, currency: "USD" });
  assertViolations(await check([a, b, c, d]), [
    ["RECEIPT_REQUIRED", "error", [b]],
    ["RECEIPT_REQUIRED", "error", [c]],
  ]);
});

test("P2 MEALS_DAILY_CAP above 5000 on one date", async () => {
  const a = await id({ category: "meals", amount: 3000, date: WED, receipt: true });
  const b = await id({ category: "meals", amount: 2001, date: WED });
  assertViolations(await check([a, b]), [["MEALS_DAILY_CAP", "error", [a, b]]]);
});

test("P2 exactly 5000 is allowed", async () => {
  const a = await id({ category: "meals", amount: 3000, date: WED, receipt: true });
  const b = await id({ category: "meals", amount: 2000, date: WED });
  assertViolations(await check([a, b]), []);
});

test("P2 converts each expense before adding", async () => {
  // 4983 + convert(10, EUR, GBP) + convert(10, EUR, GBP) = 4983 + 9 + 9 = 5001
  const a = await id({ category: "meals", amount: 4983, currency: "GBP", date: WED, receipt: true });
  const b = await id({ category: "meals", amount: 10, currency: "EUR", date: WED });
  const c = await id({ category: "meals", amount: 10, currency: "EUR", date: WED });
  assertViolations(await check([a, b, c]), [["MEALS_DAILY_CAP", "error", [a, b, c]]]);
});

test("P2 counts only meals on the same date", async () => {
  const a = await id({ category: "meals", amount: 3000, date: WED, receipt: true });
  const b = await id({ category: "travel", amount: 3000, date: WED, receipt: true });
  const c = await id({ category: "meals", amount: 3000, date: THU, receipt: true });
  assertViolations(await check([a, b, c]), []);
});

test("P3 WEEKEND warns on Saturday and Sunday", async () => {
  const a = await id({ date: FRI });
  const b = await id({ date: SAT });
  const c = await id({ date: SUN });
  const d = await id({ date: MON });
  assertViolations(await check([a, b, c, d]), [
    ["WEEKEND", "warning", [b]],
    ["WEEKEND", "warning", [c]],
  ]);
});

test("P4 violations come in rule order, meals caps by date", async () => {
  // P7: created in the order d, c, b, a; the input order is the request order a, b, c, d.
  const d = await id({ category: "meals", amount: 5001, date: WED });
  const c = await id({ category: "meals", amount: 2500, date: THU });
  const b = await id({ category: "meals", amount: 3000, date: THU, receipt: true });
  const a = await id({ category: "travel", amount: 3000, date: SAT });
  assertViolations(await check([a, b, c, d]), [
    ["RECEIPT_REQUIRED", "error", [a]],
    ["RECEIPT_REQUIRED", "error", [d]],
    ["MEALS_DAILY_CAP", "error", [d]],
    ["MEALS_DAILY_CAP", "error", [b, c]],
    ["WEEKEND", "warning", [a]],
  ]);
});

test("P6 P7 an empty list gives no violations", async () => {
  await id({ category: "travel", amount: 9999, date: SAT });
  const res = await check([]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(pick(res.body, ["violations"]), { violations: [] });
});

test("P9 expenseIds must be an array of strings", async () => {
  for (const body of [{}, { expenseIds: "exp_1" }, { expenseIds: [1] }]) {
    const res = await app().request("POST", "/policy/check", body);
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), ["expenseIds"]);
  }
});

test("P10 an unknown expense id returns NOT_FOUND", async () => {
  const a = await id({});
  // P8: the known id alone is checked, so the 404 below comes from the unknown id, not a missing route.
  assertViolations(await check([a]), []);
  assertError(await check([a, unknownId(a)]), 404, "NOT_FOUND");
});
