import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, base, createExpense, detailFields, useApp } from "./helpers.ts";

const app = useApp();

function ids(res: { body: any }): string[] {
  return res.body.expenses.map((expense: { id: string }) => expense.id);
}

test("README Endpoints: GET /health returns ok", async () => {
  const res = await app().request("GET", "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
  assert.ok(res.contentType?.startsWith("application/json"), String(res.contentType));
});

test("README Expenses: POST /expenses returns the new expense", async () => {
  const input = {
    date: "2026-03-04",
    merchant: "Cafe Rio",
    category: "meals",
    amount: 1250,
    currency: "EUR",
    description: "Team lunch",
    receipt: true,
  };
  const res = await app().request("POST", "/expenses", input);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(typeof res.body.id, "string");
  assert.deepEqual(res.body, { ...input, id: res.body.id });
});

test("README Expenses: description and receipt have defaults", async () => {
  const res = await app().request("POST", "/expenses", base);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.description, "");
  assert.equal(res.body.receipt, false);
});

test("README Expenses: id and unknown fields are ignored", async () => {
  const a = await createExpense(app());
  const res = await app().request("POST", "/expenses", { ...base, merchant: "Second", id: a.id, colour: "red" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.notEqual(res.body.id, a.id);
  assert.equal("colour" in res.body, false);
  const got = await app().request("GET", `/expenses/${a.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, a);
  const all = await app().request("GET", "/expenses");
  assert.equal(all.status, 200);
  assert.deepEqual(ids(all), [a.id, res.body.id]);
});

test("README Expenses: missing required fields are each reported", async () => {
  const res = await app().request("POST", "/expenses", {});
  assertError(res, 400, "VALIDATION_ERROR");
  assert.deepEqual(detailFields(res), ["amount", "category", "currency", "date", "merchant"]);
});

test("README Expenses: invalid values are each reported", async () => {
  const res = await app().request("POST", "/expenses", {
    date: "2026-02-30",
    merchant: "   ",
    category: "food",
    amount: 0,
    currency: "JPY",
    description: 5,
    receipt: "yes",
  });
  assertError(res, 400, "VALIDATION_ERROR");
  assert.deepEqual(detailFields(res), ["amount", "category", "currency", "date", "description", "merchant", "receipt"]);
});

test("README Expenses: amount must be a whole number", async () => {
  for (const amount of [12.5, "1000"]) {
    const res = await app().request("POST", "/expenses", { ...base, amount });
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), ["amount"]);
  }
});

test("README Conventions: bad JSON returns INVALID_JSON", async () => {
  for (const raw of ["{bad", "[1,2]"]) {
    const res = await app().request("POST", "/expenses", raw, "application/json");
    assertError(res, 400, "INVALID_JSON");
    assert.deepEqual(res.body.error.details, []);
  }
});

test("README Endpoints: GET /expenses/:id returns the expense", async () => {
  const created = await createExpense(app());
  const res = await app().request("GET", `/expenses/${created.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, created);
});

test("README Conventions: an unknown id returns NOT_FOUND", async () => {
  const res = await app().request("GET", "/expenses/nope");
  assertError(res, 404, "NOT_FOUND");
  assert.deepEqual(res.body.error.details, []);
});

test("README Endpoints: GET /expenses lists in creation order", async () => {
  const a = await createExpense(app(), { date: "2026-03-09" });
  const b = await createExpense(app(), { date: "2026-03-01" });
  const c = await createExpense(app(), { date: "2026-03-05" });
  const res = await app().request("GET", "/expenses");
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res), [a.id, b.id, c.id]);
});

test("README Expenses: GET /expenses filters by category, from and to", async () => {
  const a = await createExpense(app(), { category: "meals", date: "2026-03-01" });
  const b = await createExpense(app(), { category: "travel", date: "2026-03-05" });
  const c = await createExpense(app(), { category: "meals", date: "2026-03-10" });
  const cases: [string, string[]][] = [
    ["?category=meals", [a.id, c.id]],
    ["?from=2026-03-05&to=2026-03-10", [b.id, c.id]],
    ["?category=meals&from=2026-03-02", [c.id]],
    ["?to=2026-03-05", [a.id, b.id]],
  ];
  for (const [query, expected] of cases) {
    const res = await app().request("GET", `/expenses${query}`);
    assert.equal(res.status, 200, query);
    assert.deepEqual(ids(res), expected, query);
  }
});

test("README Expenses: invalid filters return VALIDATION_ERROR", async () => {
  const cases: [string, string][] = [
    ["?category=food", "category"],
    ["?from=2026-13-01", "from"],
    ["?to=soon", "to"],
  ];
  for (const [query, field] of cases) {
    const res = await app().request("GET", `/expenses${query}`);
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), [field]);
  }
});

test("README Endpoints: PATCH changes only the fields sent", async () => {
  const created = await createExpense(app());
  const res = await app().request("PATCH", `/expenses/${created.id}`, { amount: 2000, id: "other" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ...created, amount: 2000 });
  const got = await app().request("GET", `/expenses/${created.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { ...created, amount: 2000 });
});

test("README Expenses: PATCH validates fields and 404s", async () => {
  const created = await createExpense(app());
  const invalid = await app().request("PATCH", `/expenses/${created.id}`, { currency: "JPY" });
  assertError(invalid, 400, "VALIDATION_ERROR");
  assert.deepEqual(detailFields(invalid), ["currency"]);
  assertError(await app().request("PATCH", "/expenses/nope", { amount: 5 }), 404, "NOT_FOUND");
});

test("README Endpoints: DELETE removes the expense", async () => {
  const created = await createExpense(app());
  const res = await app().request("DELETE", `/expenses/${created.id}`);
  assert.equal(res.status, 204);
  assert.equal(res.body, undefined);
  assertError(await app().request("GET", `/expenses/${created.id}`), 404, "NOT_FOUND");
  assertError(await app().request("DELETE", `/expenses/${created.id}`), 404, "NOT_FOUND");
});

test("README Conventions: an unknown route returns NOT_FOUND", async () => {
  assertError(await app().request("GET", "/nope"), 404, "NOT_FOUND");
});
