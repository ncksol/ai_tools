import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp, type TestApp } from "./helpers.ts";

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(async () => {
  await app.close();
});

async function expense(fields: Record<string, unknown>): Promise<void> {
  const res = await app.request("POST", "/expenses", { merchant: "Shop", currency: "GBP", ...fields });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

function fields(res: { body: any }): string[] {
  return res.body.error.details.map((d: any) => d.field);
}

test("S1 month and currency are required and checked", async () => {
  const missing = await app.request("GET", "/summary");
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(fields(missing), ["month", "currency"]);
  for (const month of ["2026-13", "2026-00", "2026-3", "26-03", "2026-03-01"]) {
    const res = await app.request("GET", `/summary?month=${month}&currency=GBP`);
    assert.equal(res.status, 400, month);
    assert.deepEqual(fields(res), ["month"]);
  }
  const currency = await app.request("GET", "/summary?month=2026-03&currency=gbp");
  assert.equal(currency.status, 400);
  assert.deepEqual(fields(currency), ["currency"]);
});

test("S4 an empty month has all four categories at 0", async () => {
  const res = await app.request("GET", "/summary?month=1999-01&currency=EUR");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    month: "1999-01",
    currency: "EUR",
    count: 0,
    total: 0,
    categories: { meals: 0, travel: 0, lodging: 0, other: 0 },
  });
});

test("S2 S3 S4 converts each expense, then adds, for the month only", async () => {
  await expense({ date: "2026-04-01", category: "meals", amount: 10, currency: "EUR" });
  await expense({ date: "2026-04-30", category: "meals", amount: 10, currency: "EUR" });
  await expense({ date: "2026-04-15", category: "travel", amount: 1000, currency: "USD" });
  await expense({ date: "2026-03-31", category: "travel", amount: 5000 });
  await expense({ date: "2026-05-01", category: "other", amount: 5000 });
  const res = await app.request("GET", "/summary?month=2026-04&currency=GBP");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    month: "2026-04",
    currency: "GBP",
    count: 3,
    total: 818,
    categories: { meals: 18, travel: 800, lodging: 0, other: 0 },
  });
});
