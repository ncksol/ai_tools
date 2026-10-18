import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp, type TestApp } from "./helpers.ts";

const HEADER = "date,merchant,category,amount,currency";

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(async () => {
  await app.close();
});

async function importCsv(body: string, contentType = "text/csv"): Promise<{ status: number; body: any }> {
  const res = await fetch(app.url + "/expenses/import", { method: "POST", headers: { "content-type": contentType }, body });
  return { status: res.status, body: await res.json() };
}

async function getExpense(id: string): Promise<any> {
  const res = await app.request("GET", `/expenses/${id}`);
  assert.equal(res.status, 200);
  return res.body;
}

test("I1 a content type other than text/csv returns 415", async () => {
  const res = await importCsv(`${HEADER}\n`, "application/json");
  assert.equal(res.status, 415);
  assert.equal(res.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.deepEqual(res.body.error.details, []);
});

test("I1 text/csv may have parameters and any case", async () => {
  const res = await importCsv(`${HEADER}\n`, "Text/CSV; charset=utf-8");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { created: [], errors: [] });
});

test("I4 missing required columns return 400 INVALID_CSV, one detail per column", async () => {
  const before = (await app.request("GET", "/expenses")).body.expenses.length;
  const res = await importCsv("merchant,currency,Date\nShop,GBP,2026-03-04\n");
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "INVALID_CSV");
  assert.deepEqual(res.body.error.details.map((d: any) => d.field), ["date", "category", "amount"]);
  assert.equal((await app.request("GET", "/expenses")).body.expenses.length, before);
});

test("I4 an empty body has no columns", async () => {
  const res = await importCsv("");
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, "INVALID_CSV");
  assert.deepEqual(res.body.error.details.map((d: any) => d.field), ["date", "merchant", "category", "amount", "currency"]);
});

test("I5 amount formats are converted to minor units", async () => {
  const body = [
    HEADER,
    "2026-03-04,Shop,other,12,GBP",
    "2026-03-04,Shop,other,12.5,GBP",
    "2026-03-04,Shop,other,12.50,GBP",
    "2026-03-04,Shop,other,0.07,GBP",
  ].join("\n");
  const res = await importCsv(body);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.errors, []);
  const amounts = await Promise.all(res.body.created.map(async (id: string) => (await getExpense(id)).amount));
  assert.deepEqual(amounts, [1200, 1250, 1250, 7]);
});

test("I5 invalid amounts are row errors", async () => {
  const bad = ["0", "0.00", "12.505", "-1", "1e3", " 12", "12.", ".5", ""];
  const body = [HEADER, ...bad.map((a) => `2026-03-04,Shop,other,"${a}",GBP`)].join("\n");
  const res = await importCsv(body);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.created, []);
  assert.deepEqual(
    res.body.errors.map((e: any) => [e.line, e.details.map((d: any) => d.field)]),
    bad.map((_, i) => [i + 2, ["amount"]]),
  );
});

test("I5 an amount too large for a whole number is a row error", async () => {
  const before = (await app.request("GET", "/expenses")).body.expenses.length;
  const res = await importCsv(`${HEADER}\n2026-03-04,Shop,other,${"9".repeat(309)},GBP\n`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.created, []);
  assert.deepEqual(res.body.errors.map((e: any) => [e.line, e.details.map((d: any) => d.field)]), [[2, ["amount"]]]);
  assert.equal((await app.request("GET", "/expenses")).body.expenses.length, before);
});

test("I5 optional columns, defaults and receipt values", async () => {
  const body = [
    "receipt,currency,amount,category,merchant,date,description,extra",
    "true,EUR,5,meals,Cafe,2026-03-04,Lunch,x",
    ",GBP,5,meals,Cafe,2026-03-04,,y",
    "yes,GBP,5,meals,Cafe,2026-03-04,,z",
  ].join("\r\n");
  const res = await importCsv(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.created.length, 2);
  const [a, b] = await Promise.all(res.body.created.map(getExpense));
  assert.deepEqual(
    { ...a, id: undefined },
    { id: undefined, date: "2026-03-04", merchant: "Cafe", category: "meals", amount: 500, currency: "EUR", description: "Lunch", receipt: true },
  );
  assert.equal(b.description, "");
  assert.equal(b.receipt, false);
  assert.deepEqual(res.body.errors.map((e: any) => [e.line, e.details.map((d: any) => d.field)]), [[4, ["receipt"]]]);
});

test("I5 values are not trimmed and follow POST /expenses rules", async () => {
  const body = [HEADER, " 2026-03-04, ,Meals,5,gbp", "2026-02-30,Shop,other,5,GBP"].join("\n");
  const res = await importCsv(body);
  assert.deepEqual(res.body.created, []);
  assert.deepEqual(res.body.errors.map((e: any) => [e.line, e.details.map((d: any) => d.field)]), [
    [2, ["date", "merchant", "category", "currency"]],
    [3, ["date"]],
  ]);
});

test("I6 a row with a different number of fields has one row error", async () => {
  const body = [HEADER, "2026-03-04,Shop,other,5", "2026-03-04,Shop,other,5,GBP,extra"].join("\n");
  const res = await importCsv(body);
  assert.deepEqual(res.body.created, []);
  assert.deepEqual(res.body.errors.map((e: any) => [e.line, e.details.map((d: any) => d.field)]), [
    [2, ["row"]],
    [3, ["row"]],
  ]);
});

test("I8 line numbers count empty lines and quoted line breaks", async () => {
  const body = `${HEADER},description\n\n2026-03-04,Shop,other,0,GBP,"two\nlines"\n2026-03-04,Shop,other,0,GBP,x\n`;
  const res = await importCsv(body);
  assert.deepEqual(res.body.errors.map((e: any) => e.line), [3, 5]);
});

test("I9 I10 valid rows are created in file order alongside errors", async () => {
  const body = [HEADER, "2026-03-04,A,other,1,GBP", "2026-03-04,B,other,0,GBP", "2026-03-05,C,travel,2.5,USD"].join("\n");
  const res = await importCsv(body);
  assert.equal(res.status, 200);
  assert.equal(res.body.created.length, 2);
  const merchants = await Promise.all(res.body.created.map(async (id: string) => (await getExpense(id)).merchant));
  assert.deepEqual(merchants, ["A", "C"]);
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].line, 3);
  assert.equal(res.body.errors[0].details[0].field, "amount");
  assert.equal(typeof res.body.errors[0].details[0].message, "string");
});
