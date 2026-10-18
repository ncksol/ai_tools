import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startTestApp, type TestApp, type TestResponse } from "./helpers.ts";

const WED = "2026-03-04";
const SAT = "2026-03-07";

let app: TestApp;
before(async () => {
  app = await startTestApp();
});
after(async () => {
  await app.close();
});

function assertError(res: TestResponse, status: number, code: string, fields?: string[]): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.error.code, code);
  if (fields) assert.deepEqual(res.body.error.details.map((d: any) => d.field), fields);
}

async function expense(fields: Record<string, unknown> = {}): Promise<string> {
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

async function report(title = "March"): Promise<string> {
  const res = await app.request("POST", "/reports", { title });
  assert.equal(res.status, 201);
  return res.body.id;
}

const attach = (reportId: string, expenseId: unknown) =>
  app.request("POST", `/reports/${reportId}/expenses`, { expenseId });
const detach = (reportId: string, expenseId: string) =>
  app.request("DELETE", `/reports/${reportId}/expenses/${expenseId}`);
const submit = (reportId: string) => app.request("POST", `/reports/${reportId}/submit`);
const approve = (reportId: string) => app.request("POST", `/reports/${reportId}/approve`);
const reject = (reportId: string, reason: unknown = "Missing details") =>
  app.request("POST", `/reports/${reportId}/reject`, { reason });

async function submitted(...expenseIds: string[]): Promise<string> {
  const r = await report();
  for (const id of expenseIds) assert.equal((await attach(r, id)).status, 200);
  assert.equal((await submit(r)).status, 200);
  return r;
}

test("R1 R2 create and get a report", async () => {
  const res = await app.request("POST", "/reports", { title: "Trip to Paris" });
  assert.equal(res.status, 201);
  assert.equal(typeof res.body.id, "string");
  assert.deepEqual({ ...res.body, id: undefined }, {
    id: undefined,
    title: "Trip to Paris",
    status: "draft",
    expenseIds: [],
    rejectionReason: null,
  });
  const got = await app.request("GET", `/reports/${res.body.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, res.body);
  assertError(await app.request("GET", "/reports/nope"), 404, "NOT_FOUND");
});

test("R2 title must be a non-blank string", async () => {
  for (const body of [{}, { title: 5 }, { title: "   " }]) {
    assertError(await app.request("POST", "/reports", body), 400, "VALIDATION_ERROR", ["title"]);
  }
  assertError(await app.request("POST", "/reports", "[]"), 400, "INVALID_JSON");
});

test("R3 R6 attach in order and detach", async () => {
  const r = await report();
  const a = await expense();
  const b = await expense();
  assert.deepEqual((await attach(r, b)).body.expenseIds, [b]);
  const res = await attach(r, a);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.expenseIds, [b, a]);
  const out = await detach(r, b);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.expenseIds, [a]);
  assertError(await detach(r, b), 404, "NOT_FOUND");
});

test("R3 attach validates expenseId", async () => {
  const r = await report();
  assertError(await app.request("POST", `/reports/${r}/expenses`, {}), 400, "VALIDATION_ERROR", ["expenseId"]);
  assertError(await attach(r, 5), 400, "VALIDATION_ERROR", ["expenseId"]);
  assertError(await attach(r, "nope"), 404, "NOT_FOUND");
  assertError(await attach("nope", "nope"), 404, "NOT_FOUND");
});

test("R4 attach and detach need a draft report, R6 404 comes first", async () => {
  const a = await expense();
  const b = await expense();
  const r = await submitted(a);
  assertError(await attach(r, b), 409, "INVALID_STATE");
  assertError(await detach(r, a), 409, "INVALID_STATE");
  assertError(await detach(r, b), 404, "NOT_FOUND");
  // G4: a body error comes before the state error.
  assertError(await attach(r, 5), 400, "VALIDATION_ERROR", ["expenseId"]);
  assertError(await attach(r, "nope"), 404, "NOT_FOUND");
});

test("R5 an expense is in at most one active report", async () => {
  const a = await expense();
  const r1 = await report();
  const r2 = await report();
  assert.equal((await attach(r1, a)).status, 200);
  assertError(await attach(r1, a), 409, "EXPENSE_IN_REPORT");
  assertError(await attach(r2, a), 409, "EXPENSE_IN_REPORT");
  assert.equal((await submit(r1)).status, 200);
  // R4 wins over R5.
  assertError(await attach(r1, a), 409, "INVALID_STATE");
  assertError(await attach(r2, a), 409, "EXPENSE_IN_REPORT");
});

test("R8 submitting an empty report returns REPORT_EMPTY", async () => {
  const r = await report();
  assertError(await submit(r), 409, "REPORT_EMPTY");
  assertError(await submit("nope"), 404, "NOT_FOUND");
});

test("R9 warnings do not block a submit", async () => {
  const r = await report();
  await attach(r, await expense({ date: SAT }));
  const res = await submit(r);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "submitted");
});

test("R9 policy errors block a submit and the report stays draft", async () => {
  const r = await report();
  const a = await expense({ amount: 3000, date: SAT });
  const b = await expense({ amount: 50 });
  await attach(r, a);
  await attach(r, b);
  const res = await submit(r);
  assertError(res, 409, "POLICY_VIOLATION");
  assert.deepEqual(
    res.body.error.details.map((v: any) => [v.code, v.severity, v.expenseIds]),
    [["RECEIPT_REQUIRED", "error", [a]]],
  );
  assert.ok(res.body.error.details[0].message.length > 0);
  assert.equal((await app.request("GET", `/reports/${r}`)).body.status, "draft");
});

test("R7 R10 approve and reject", async () => {
  const r1 = await report();
  assertError(await approve(r1), 409, "INVALID_STATE");
  assertError(await reject(r1), 409, "INVALID_STATE");
  await attach(r1, await expense());
  assert.equal((await submit(r1)).status, 200);
  assertError(await submit(r1), 409, "INVALID_STATE");
  const ok = await approve(r1);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "approved");
  assert.equal(ok.body.rejectionReason, null);
  assertError(await approve(r1), 409, "INVALID_STATE");
  assertError(await reject(r1), 409, "INVALID_STATE");

  const r2 = await submitted(await expense());
  for (const body of [{}, { reason: 5 }, { reason: "  " }]) {
    assertError(await app.request("POST", `/reports/${r2}/reject`, body), 400, "VALIDATION_ERROR", ["reason"]);
  }
  const no = await reject(r2, "Wrong project");
  assert.equal(no.status, 200);
  assert.equal(no.body.status, "rejected");
  assert.equal(no.body.rejectionReason, "Wrong project");
  assertError(await approve(r2), 409, "INVALID_STATE");
  assertError(await submit(r2), 409, "INVALID_STATE");
  assertError(await reject(r2), 409, "INVALID_STATE");
});

test("R11 expenses in submitted and approved reports are locked", async () => {
  const a = await expense();
  const r = await submitted(a);
  assertError(await app.request("PATCH", `/expenses/${a}`, { amount: 200 }), 409, "EXPENSE_LOCKED");
  assertError(await app.request("DELETE", `/expenses/${a}`), 409, "EXPENSE_LOCKED");
  // G4: a body error comes before the lock.
  assertError(await app.request("PATCH", `/expenses/${a}`, { amount: 0 }), 400, "VALIDATION_ERROR", ["amount"]);
  assert.equal((await approve(r)).status, 200);
  assertError(await app.request("PATCH", `/expenses/${a}`, { amount: 200 }), 409, "EXPENSE_LOCKED");
  assertError(await app.request("DELETE", `/expenses/${a}`), 409, "EXPENSE_LOCKED");
  assert.equal((await app.request("GET", `/expenses/${a}`)).body.amount, 100);
});

test("R11 expenses in a draft report can change", async () => {
  const a = await expense();
  const r = await report();
  await attach(r, a);
  const res = await app.request("PATCH", `/expenses/${a}`, { amount: 200 });
  assert.equal(res.status, 200);
  assert.equal(res.body.amount, 200);
});

test("R12 deleting an expense detaches it from every report", async () => {
  const a = await expense();
  const b = await expense();
  const rejected = await submitted(a);
  assert.equal((await reject(rejected)).status, 200);
  const draft = await report();
  await attach(draft, b);
  await attach(draft, a);
  assert.equal((await app.request("DELETE", `/expenses/${a}`)).status, 204);
  assert.deepEqual((await app.request("GET", `/reports/${rejected}`)).body.expenseIds, []);
  assert.deepEqual((await app.request("GET", `/reports/${draft}`)).body.expenseIds, [b]);
});

test("R13 a rejected report keeps its expenses and unlocks them", async () => {
  const a = await expense();
  const r = await submitted(a);
  assert.equal((await reject(r)).status, 200);
  assert.deepEqual((await app.request("GET", `/reports/${r}`)).body.expenseIds, [a]);
  assert.equal((await app.request("PATCH", `/expenses/${a}`, { amount: 300 })).status, 200);
  const other = await report();
  const res = await attach(other, a);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.expenseIds, [a]);
});
