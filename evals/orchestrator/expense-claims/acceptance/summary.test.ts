import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, createExpense, detailFields, pick, useApp, type Res } from "./helpers.ts";

const app = useApp();

function summary(query: string): Promise<Res> {
  return app().request("GET", `/summary?${query}`);
}

// The documented properties of a summary, including the four categories.
function documented(body: any): Record<string, unknown> {
  return { ...pick(body, ["month", "currency", "count", "total"]), categories: pick(body?.categories, ["meals", "travel", "lodging", "other"]) };
}

test("S2 S4 totals per category for the month", async () => {
  await createExpense(app(), { category: "meals", amount: 1200, currency: "GBP", date: "2026-03-01" });
  await createExpense(app(), { category: "travel", amount: 3000, currency: "GBP", date: "2026-03-15" });
  await createExpense(app(), { category: "travel", amount: 50, currency: "GBP", date: "2026-03-31" });
  await createExpense(app(), { category: "meals", amount: 999, currency: "GBP", date: "2026-02-28" });
  await createExpense(app(), { category: "other", amount: 777, currency: "GBP", date: "2026-04-01" });
  const res = await summary("month=2026-03&currency=GBP");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(documented(res.body), {
    month: "2026-03",
    currency: "GBP",
    count: 3,
    total: 4250,
    categories: { meals: 1200, travel: 3050, lodging: 0, other: 0 },
  });
});

test("S3 each expense is converted, then added", async () => {
  // convert(10, EUR, GBP) is 9 for each expense; converting the sum (20) would give 17.
  await createExpense(app(), { category: "meals", amount: 10, currency: "EUR", date: "2026-05-04" });
  await createExpense(app(), { category: "meals", amount: 10, currency: "EUR", date: "2026-05-05" });
  const res = await summary("month=2026-05&currency=GBP");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.categories.meals, 18);
  assert.equal(res.body.total, 18);
  assert.equal(res.body.count, 2);
});

test("S3 converts into the requested currency", async () => {
  // convert(100, GBP, EUR) is 118; 100 EUR stays 100.
  await createExpense(app(), { category: "lodging", amount: 100, currency: "GBP", date: "2026-06-10" });
  await createExpense(app(), { category: "lodging", amount: 100, currency: "EUR", date: "2026-06-11" });
  const res = await summary("month=2026-06&currency=EUR");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.categories.lodging, 218);
  assert.equal(res.body.total, 218);
  assert.equal(res.body.currency, "EUR");
});

test("S4 a month with no expenses", async () => {
  const res = await summary("month=2026-07&currency=USD");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(documented(res.body), {
    month: "2026-07",
    currency: "USD",
    count: 0,
    total: 0,
    categories: { meals: 0, travel: 0, lodging: 0, other: 0 },
  });
});

test("S1 month and currency are required", async () => {
  const res = await app().request("GET", "/summary");
  assertError(res, 400, "VALIDATION_ERROR");
  assert.deepEqual(detailFields(res), ["currency", "month"]);
});

test("S1 invalid month or currency", async () => {
  const cases: [string, string][] = [
    ["month=2026-13&currency=GBP", "month"],
    ["month=2026-3&currency=GBP", "month"],
    ["month=2026-00&currency=GBP", "month"],
    ["month=2026-03&currency=JPY", "currency"],
  ];
  for (const [query, field] of cases) {
    const res = await summary(query);
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), [field], query);
  }
});
