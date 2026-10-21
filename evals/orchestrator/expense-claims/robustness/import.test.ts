import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, EXPENSE_FIELDS, pick, useApp, type Res } from "../acceptance/helpers.ts";

// Edge cases of spec I2 (CSV as defined by RFC 4180) that the acceptance gate does not cover. Run
// after scoring; never a gate. RFC 4180 allows a double quote only around a whole field (doubled
// inside it), and a CR only inside a quoted field; I2 says rows end with \n or \r\n, so a lone \r is
// not a line break. A malformed data row is an invalid row (I9, I10). A malformed header is not a
// valid header, so nothing is imported and the file is rejected as 400 INVALID_CSV, the spec's only
// error for a bad header (I4, I10). Only status, error code, line numbers and the created expenses
// are checked: the spec does not fix the `details` of a syntax error.

const app = useApp();

const HEADER = "date,merchant,category,amount,currency,description";

const fields = (expense: unknown) => pick(expense, EXPENSE_FIELDS);

function importCsv(text: string): Promise<Res> {
  return app().request("POST", "/expenses/import", text, "text/csv");
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
  for (const error of res.body.errors) {
    assert.ok(Array.isArray(error.details) && error.details.length > 0, JSON.stringify(error));
  }
  return res.body;
}

// Imports `csv`, then checks the created expenses' descriptions and the error lines, in file order.
async function expectRows(csv: string, descriptions: string[], lines: number[]): Promise<Res> {
  const res = await importCsv(csv);
  const body = assertImported(res);
  const expenses = await list();
  assert.deepEqual(expenses.map((e) => e.id), body.created, JSON.stringify(res.body));
  assert.deepEqual(expenses.map((e) => e.description), descriptions, JSON.stringify(res.body));
  assert.deepEqual(body.errors.map((e) => e.line), lines, JSON.stringify(res.body));
  return res;
}

test("I2 a lone CR in an unquoted field makes its row invalid", async () => {
  const csv = [
    HEADER,
    "2026-03-04,Cafe,meals,5,GBP,before",
    "2026-03-04,Cafe,meals,6,GBP,a\rb",
    "2026-03-05,Taxi,travel,7,EUR,after",
    "2026-02-30,Cafe,meals,8,GBP,bad date",
  ].join("\n");
  const res = await expectRows(csv, ["before", "after"], [3, 5]);
  assert.deepEqual(res.body.errors[1].details.map((d: any) => d.field), ["date"]);
});

test("I2 a lone CR in an unquoted field of a CRLF file makes its row invalid", async () => {
  const csv = [HEADER, "2026-03-04,Cafe,meals,6,GBP,a\rb", "2026-03-05,Taxi,travel,7,EUR,after", ""].join("\r\n");
  await expectRows(csv, ["after"], [2]);
});

test("I2 a double quote inside an unquoted field makes its row invalid", async () => {
  const csv = [
    HEADER,
    '2026-03-04,Bob"s Cafe,meals,5,GBP,x',
    "2026-03-05,Taxi,travel,7,EUR,after",
    "2026-02-30,Cafe,meals,8,GBP,bad date",
  ].join("\n");
  await expectRows(csv, ["after"], [2, 4]);
});

test("I2 text after a closing quote makes its row invalid", async () => {
  const csv = [
    HEADER,
    '2026-03-04,"Cafe"x,meals,5,GBP,x',
    "2026-03-05,Taxi,travel,7,EUR,after",
    "2026-02-30,Cafe,meals,8,GBP,bad date",
  ].join("\n");
  await expectRows(csv, ["after"], [2, 4]);
});

test("I2 an unclosed quote runs to the end of the file and its row is invalid", async () => {
  const csv = [
    HEADER,
    "2026-03-04,Cafe,meals,5,GBP,before",
    '2026-03-04,Cafe,meals,6,GBP,"never closed',
    "2026-03-05,Taxi,travel,7,EUR,inside the open quote",
    "",
  ].join("\n");
  await expectRows(csv, ["before"], [3]);
});

const BAD_HEADERS: [string, string][] = [
  ["a quote opening inside a name", 'da"te",merchant,category,amount,currency'],
  ["text after a closing quote", '"dat"e,merchant,category,amount,currency'],
  ["an unclosed quote", 'date,merchant,category,amount,currency,"notes'],
  ["a lone CR in a name", "date,merchant,category,amount,currency,no\rtes"],
];

for (const [name, header] of BAD_HEADERS) {
  test(`I2 I4 a header with ${name} imports nothing`, async () => {
    const res = await importCsv([header, "2026-03-04,Cafe,meals,5,GBP,x", ""].join("\n"));
    assertError(res, 400, "INVALID_CSV");
    assert.deepEqual(await list(), []);
  });
}

test("I2 a header and fields that are all quoted are valid", async () => {
  const csv = [
    '"date","merchant","category","amount","currency","description","receipt"',
    '"2026-03-04","Cafe, Rio","meals","5.50","GBP","",""',
  ].join("\r\n");
  const body = assertImported(await importCsv(csv));
  assert.deepEqual(body.errors, []);
  assert.deepEqual((await list()).map(fields), [
    {
      id: body.created[0],
      date: "2026-03-04",
      merchant: "Cafe, Rio",
      category: "meals",
      amount: 550,
      currency: "GBP",
      description: "",
      receipt: false,
    },
  ]);
});

test("I2 I8 quoted CRLF, CR and quotes are kept, and quoted line breaks are counted", async () => {
  const csv = [
    HEADER,
    '2026-03-04,Cafe,meals,5,GBP,"a\r\nb"',
    '2026-03-04,Cafe,meals,5,GBP,""""',
    '2026-03-04,Cafe,meals,5,GBP,""',
    '2026-02-30,Cafe,meals,5,GBP,"bad date"',
    '2026-03-04,Cafe,meals,5,GBP,"c\rd"',
  ].join("\r\n");
  // The first row spans lines 2 and 3; the bad date is on line 6.
  await expectRows(csv, ["a\r\nb", '"', "", "c\rd"], [6]);
});

test('I6 I7 a line holding only "" is a row with one field, not an empty line', async () => {
  const csv = [HEADER, "", '""', "2026-03-05,Taxi,travel,7,EUR,after"].join("\n");
  const res = await expectRows(csv, ["after"], [3]);
  assert.deepEqual(res.body.errors[0].details.map((d: any) => d.field), ["row"]);
});
