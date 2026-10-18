import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, detailFields, EXPENSE_FIELDS, pick, useApp, type Res } from "./helpers.ts";

const app = useApp();

const ALL_COLUMNS = "date,merchant,category,amount,currency,description,receipt";
const REQUIRED_COLUMNS = "date,merchant,category,amount,currency";

const fields = (expense: unknown) => pick(expense, EXPENSE_FIELDS);

function importCsv(text: string, type = "text/csv"): Promise<Res> {
  return app().request("POST", "/expenses/import", text, type);
}

async function list(): Promise<any[]> {
  const res = await app().request("GET", "/expenses");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.expenses;
}

function assertImported(res: Res): { created: string[]; errors: any[] } {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.created), JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.errors), JSON.stringify(res.body));
  return res.body;
}

function rowErrors(res: Res): { line: number; fields: string[] }[] {
  return res.body.errors.map((e: any) => ({ line: e.line, fields: e.details.map((d: any) => d.field).sort() }));
}

test("I3 I9 I10 imports valid rows", async () => {
  const csv = [
    ALL_COLUMNS,
    "2026-03-04,Cafe Rio,meals,12.50,GBP,Lunch,true",
    "2026-03-05,Rail Co,travel,40,EUR,,false",
    "",
  ].join("\n");
  const body = assertImported(await importCsv(csv));
  assert.equal(body.created.length, 2);
  assert.deepEqual(body.errors, []);
  assert.deepEqual((await list()).map(fields), [
    {
      id: body.created[0],
      date: "2026-03-04",
      merchant: "Cafe Rio",
      category: "meals",
      amount: 1250,
      currency: "GBP",
      description: "Lunch",
      receipt: true,
    },
    {
      id: body.created[1],
      date: "2026-03-05",
      merchant: "Rail Co",
      category: "travel",
      amount: 4000,
      currency: "EUR",
      description: "",
      receipt: false,
    },
  ]);
});

test("I3 columns in any order, unknown columns ignored, optional columns absent", async () => {
  const csv = ["currency,amount,notes,category,merchant,date", "USD,9.99,ignore me,other,Shop,2026-03-06"].join("\n");
  const body = assertImported(await importCsv(csv));
  assert.equal(body.created.length, 1);
  assert.deepEqual(body.errors, []);
  assert.deepEqual((await list()).map(fields), [
    {
      id: body.created[0],
      date: "2026-03-06",
      merchant: "Shop",
      category: "other",
      amount: 999,
      currency: "USD",
      description: "",
      receipt: false,
    },
  ]);
});

test("I5 amount formats", async () => {
  const amounts = ["12", "12.5", "0.01", "12.345", "0", "0.00", "-5", "abc", "1."];
  const csv = [REQUIRED_COLUMNS, ...amounts.map((amount) => `2026-03-04,Cafe,meals,${amount},GBP`)].join("\n");
  const res = await importCsv(csv);
  const body = assertImported(res);
  assert.equal(body.created.length, 3);
  const expenses = await list();
  assert.deepEqual(expenses.map((e) => e.id), body.created);
  assert.deepEqual(expenses.map((e) => e.amount), [1200, 1250, 1]);
  assert.deepEqual(
    rowErrors(res),
    [5, 6, 7, 8, 9, 10].map((line) => ({ line, fields: ["amount"] })),
  );
});

test("I2 quoted fields keep commas, quotes and line breaks", async () => {
  const csv = [
    "date,merchant,category,amount,currency,description",
    '2026-03-04,"Smith, Jones & Co",other,10,GBP,"He said ""hi"""',
    '2026-03-04,Cafe,meals,5,GBP,"Line one',
    'Line two"',
  ].join("\n");
  const body = assertImported(await importCsv(csv));
  assert.equal(body.created.length, 2);
  assert.deepEqual(body.errors, []);
  const [first, second] = await list();
  assert.equal(first.merchant, "Smith, Jones & Co");
  assert.equal(first.description, 'He said "hi"');
  assert.equal(second.description, "Line one\nLine two");
});

test("I7 I8 line numbers count empty lines and multi-line rows", async () => {
  const csv = [
    "date,merchant,category,amount,currency,description",
    '2026-03-04,Cafe,meals,5,GBP,"two',
    'lines"',
    "",
    "2026-03-04,Cafe,food,5,GBP,x",
    '2026-03-04,Cafe,meals,5,JPY,"a',
    'b"',
    "2026-02-30,Cafe,meals,5,GBP,y",
  ].join("\n");
  const res = await importCsv(csv);
  const body = assertImported(res);
  assert.equal(body.created.length, 1);
  assert.deepEqual(rowErrors(res), [
    { line: 5, fields: ["category"] },
    { line: 6, fields: ["currency"] },
    { line: 8, fields: ["date"] },
  ]);
});

test("I5 I9 I10 bad rows are reported and good rows still created", async () => {
  const csv = [
    "date,merchant,category,amount,currency,receipt",
    "2026-03-04,Cafe,meals,5,GBP,true",
    "bad-date, ,food,0,JPY,yes",
    "2026-03-05,Taxi,travel,15,EUR,",
  ].join("\n");
  const res = await importCsv(csv);
  const body = assertImported(res);
  assert.equal(body.created.length, 2);
  const expenses = await list();
  assert.deepEqual(expenses.map((e) => e.id), body.created);
  assert.deepEqual(expenses.map((e) => e.receipt), [true, false]);
  assert.deepEqual(rowErrors(res), [
    { line: 3, fields: ["amount", "category", "currency", "date", "merchant", "receipt"] },
  ]);
});

test("I6 a row with the wrong number of fields", async () => {
  const csv = [
    REQUIRED_COLUMNS,
    "2026-03-04,Cafe,meals,5",
    "2026-03-04,Cafe,meals,5,GBP,extra",
    "2026-03-04,Cafe,meals,5,GBP",
  ].join("\n");
  const res = await importCsv(csv);
  const body = assertImported(res);
  assert.equal(body.created.length, 1);
  assert.deepEqual(rowErrors(res), [
    { line: 2, fields: ["row"] },
    { line: 3, fields: ["row"] },
  ]);
});

test("I4 a missing required column imports nothing", async () => {
  const missingTwo = await importCsv(["date,merchant,amount", "2026-03-04,Cafe,5"].join("\n"));
  assertError(missingTwo, 400, "INVALID_CSV");
  assert.deepEqual(detailFields(missingTwo), ["category", "currency"]);
  const wrongCase = await importCsv(["Date,merchant,category,amount,currency", "2026-03-04,Cafe,meals,5,GBP"].join("\n"));
  assertError(wrongCase, 400, "INVALID_CSV");
  assert.deepEqual(detailFields(wrongCase), ["date"]);
  assert.deepEqual(await list(), []);
});

test("I4 an empty body is a file with no columns", async () => {
  const res = await importCsv("");
  assertError(res, 400, "INVALID_CSV");
  assert.deepEqual(detailFields(res), ["amount", "category", "currency", "date", "merchant"]);
});

test("I1 the content type must be text/csv", async () => {
  const csv = [REQUIRED_COLUMNS, "2026-03-04,Cafe,meals,5,GBP"].join("\n");
  assertError(await importCsv(csv, "application/json"), 415, "UNSUPPORTED_MEDIA_TYPE");
  assertError(await importCsv(csv, "text/plain"), 415, "UNSUPPORTED_MEDIA_TYPE");
  const body = assertImported(await importCsv(csv, "text/csv; charset=utf-8"));
  assert.equal(body.created.length, 1);
});

test("I2 CRLF line endings and no final line break", async () => {
  const csv = [
    "date,merchant,category,amount,currency,description",
    "2026-03-04,Cafe,meals,5,GBP,first",
    "2026-03-05,Cafe,meals,6,GBP,end",
  ].join("\r\n");
  const body = assertImported(await importCsv(csv));
  assert.equal(body.created.length, 2);
  assert.deepEqual(body.errors, []);
  assert.deepEqual((await list()).map((e) => e.description), ["first", "end"]);
});

test("I10 a header-only file creates nothing", async () => {
  const res = await importCsv(`${REQUIRED_COLUMNS}\n`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(pick(res.body, ["created", "errors"]), { created: [], errors: [] });
});
