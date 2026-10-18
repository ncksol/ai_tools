import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp, type TestApp } from "./helpers.ts";

const valid = { date: "2026-03-04", merchant: "Cafe Rio", category: "meals", amount: 1250, currency: "GBP" };

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(async () => {
  await app.close();
});

const fieldsOf = (body: any): string[] => body.error.details.map((d: any) => d.field);

test("GET /health returns ok", async () => {
  const res = await app.request("GET", "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
  assert.ok(res.headers.get("content-type")?.startsWith("application/json"));
});

test("POST /expenses creates an expense with defaults", async () => {
  const res = await app.request("POST", "/expenses", valid);
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.id, "string");
  assert.ok(res.body.id.length > 0);
  assert.deepEqual({ ...res.body, id: undefined }, { ...valid, id: undefined, description: "", receipt: false });
});

test("POST /expenses keeps optional fields", async () => {
  const res = await app.request("POST", "/expenses", { ...valid, description: "Team lunch", receipt: true });
  assert.equal(res.status, 201);
  assert.equal(res.body.description, "Team lunch");
  assert.equal(res.body.receipt, true);
});

test("POST /expenses ignores id and unknown fields", async () => {
  const res = await app.request("POST", "/expenses", { ...valid, id: "mine", colour: "red" });
  assert.equal(res.status, 201);
  assert.notEqual(res.body.id, "mine");
  assert.equal("colour" in res.body, false);
});

test("POST /expenses reports every missing field", async () => {
  const res = await app.request("POST", "/expenses", {});
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(new Set(fieldsOf(res.body)), new Set(["date", "merchant", "category", "amount", "currency"]));
});

test("POST /expenses rejects invalid values", async () => {
  const res = await app.request("POST", "/expenses", {
    date: "2026-02-30",
    merchant: "  ",
    category: "food",
    amount: 0,
    currency: "JPY",
    description: 5,
    receipt: "yes",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(
    new Set(fieldsOf(res.body)),
    new Set(["date", "merchant", "category", "amount", "currency", "description", "receipt"]),
  );
});

test("POST /expenses needs a whole-number amount", async () => {
  for (const amount of [12.5, "1250"]) {
    const res = await app.request("POST", "/expenses", { ...valid, amount });
    assert.equal(res.status, 400);
    assert.deepEqual(fieldsOf(res.body), ["amount"]);
  }
});

test("POST /expenses rejects bad JSON", async () => {
  for (const raw of ["{bad", "[1,2]"]) {
    const res = await app.request("POST", "/expenses", raw);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_JSON");
    assert.deepEqual(res.body.error.details, []);
  }
});

test("GET /expenses/:id returns the expense", async () => {
  const created = await app.request("POST", "/expenses", valid);
  const res = await app.request("GET", `/expenses/${created.body.id}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, created.body);
});

test("GET /expenses/:id returns 404 for an unknown id", async () => {
  const res = await app.request("GET", "/expenses/nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "NOT_FOUND");
  assert.equal(typeof res.body.error.message, "string");
  assert.deepEqual(res.body.error.details, []);
});

test("GET /expenses lists in creation order", async () => {
  const mine: string[] = [];
  for (const date of ["2026-03-09", "2026-03-01", "2026-03-05"]) {
    mine.push((await app.request("POST", "/expenses", { ...valid, date })).body.id);
  }
  const res = await app.request("GET", "/expenses");
  assert.equal(res.status, 200);
  const ids = res.body.expenses.map((e: any) => e.id).filter((id: string) => mine.includes(id));
  assert.deepEqual(ids, mine);
});

test("GET /expenses filters by category, from and to", async () => {
  const a = (await app.request("POST", "/expenses", { ...valid, category: "meals", date: "2026-04-01" })).body.id;
  const b = (await app.request("POST", "/expenses", { ...valid, category: "travel", date: "2026-04-05" })).body.id;
  const c = (await app.request("POST", "/expenses", { ...valid, category: "meals", date: "2026-04-10" })).body.id;
  const mine = [a, b, c];
  const query = async (q: string) =>
    (await app.request("GET", `/expenses?${q}`)).body.expenses.map((e: any) => e.id).filter((id: string) => mine.includes(id));
  assert.deepEqual(await query("category=meals&from=2026-04-01&to=2026-04-30"), [a, c]);
  assert.deepEqual(await query("from=2026-04-05&to=2026-04-10"), [b, c]);
  assert.deepEqual(await query("category=travel&to=2026-04-05"), [b]);
});

test("GET /expenses rejects invalid filters", async () => {
  const cases: [string, string][] = [
    ["category=food", "category"],
    ["from=2026-13-01", "from"],
    ["to=soon", "to"],
  ];
  for (const [q, field] of cases) {
    const res = await app.request("GET", `/expenses?${q}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].field, field);
  }
});

test("PATCH /expenses/:id changes only the fields sent", async () => {
  const created = await app.request("POST", "/expenses", valid);
  const id = created.body.id;
  const res = await app.request("PATCH", `/expenses/${id}`, { amount: 2000, id: "x" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...created.body, amount: 2000 });
  assert.deepEqual((await app.request("GET", `/expenses/${id}`)).body, res.body);
});

test("PATCH /expenses/:id validates and 404s", async () => {
  const created = await app.request("POST", "/expenses", valid);
  const bad = await app.request("PATCH", `/expenses/${created.body.id}`, { currency: "JPY" });
  assert.equal(bad.status, 400);
  assert.deepEqual(fieldsOf(bad.body), ["currency"]);
  const missing = await app.request("PATCH", "/expenses/nope", {});
  assert.equal(missing.status, 404);
});

test("DELETE /expenses/:id deletes", async () => {
  const created = await app.request("POST", "/expenses", valid);
  const path = `/expenses/${created.body.id}`;
  const res = await app.request("DELETE", path);
  assert.equal(res.status, 204);
  assert.equal(res.body, undefined);
  assert.equal((await app.request("GET", path)).status, 404);
  assert.equal((await app.request("DELETE", path)).status, 404);
});

test("an unknown route returns 404", async () => {
  const res = await app.request("GET", "/nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "NOT_FOUND");
});
