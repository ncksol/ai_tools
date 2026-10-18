import assert from "node:assert/strict";
import { test } from "node:test";
import { assertError, createExpense, detailFields, useApp, type Res } from "./helpers.ts";

const app = useApp();

const WED = "2026-03-04";
const SAT = "2026-03-07";

async function newReport(title = "March trip"): Promise<any> {
  const res = await app().request("POST", "/reports", { title });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function id(fields: Record<string, unknown> = {}): Promise<string> {
  return (await createExpense(app(), fields)).id;
}

function attach(r: string, e: unknown): Promise<Res> {
  return app().request("POST", `/reports/${r}/expenses`, { expenseId: e });
}

function detach(r: string, e: string): Promise<Res> {
  return app().request("DELETE", `/reports/${r}/expenses/${e}`);
}

function submit(r: string): Promise<Res> {
  return app().request("POST", `/reports/${r}/submit`);
}

function approve(r: string): Promise<Res> {
  return app().request("POST", `/reports/${r}/approve`);
}

function reject(r: string, body: unknown): Promise<Res> {
  return app().request("POST", `/reports/${r}/reject`, body);
}

function getReport(r: string): Promise<Res> {
  return app().request("GET", `/reports/${r}`);
}

function assertOk(res: Res): any {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

test("R1 POST /reports creates a draft that GET returns", async () => {
  const res = await app().request("POST", "/reports", { title: "March trip" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(typeof res.body.id, "string");
  assert.deepEqual(res.body, {
    id: res.body.id,
    title: "March trip",
    status: "draft",
    expenseIds: [],
    rejectionReason: null,
  });
  assert.deepEqual(assertOk(await getReport(res.body.id)), res.body);
});

test("R1 R2 bad titles and unknown reports", async () => {
  for (const body of [{}, { title: "  " }, { title: 5 }]) {
    const res = await app().request("POST", "/reports", body);
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), ["title"]);
  }
  assertError(await getReport("nope"), 404, "NOT_FOUND");
});

test("R3 attach keeps order and detach removes", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  const e2 = await id();
  assert.deepEqual(assertOk(await attach(r, e1)).expenseIds, [e1]);
  assert.deepEqual(assertOk(await attach(r, e2)).expenseIds, [e1, e2]);
  assert.deepEqual(assertOk(await detach(r, e1)).expenseIds, [e2]);
});

test("R3 attach errors", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  for (const body of [{}, { expenseId: 7 }]) {
    const res = await app().request("POST", `/reports/${r}/expenses`, body);
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), ["expenseId"]);
  }
  assertError(await attach(r, "nope"), 404, "NOT_FOUND");
  assertError(await attach("nope", e1), 404, "NOT_FOUND");
});

test("R5 an expense is in at most one active report", async () => {
  const a = (await newReport("A")).id;
  const b = (await newReport("B")).id;
  const e1 = await id();
  assertOk(await attach(a, e1));
  assertError(await attach(b, e1), 409, "EXPENSE_IN_REPORT");
  assertError(await attach(a, e1), 409, "EXPENSE_IN_REPORT");
});

test("R6 detaching an expense that is not attached", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  assertError(await detach(r, e1), 404, "NOT_FOUND");
  assertError(await detach(r, "nope"), 404, "NOT_FOUND");
});

test("R8 submitting an empty report", async () => {
  const r = (await newReport()).id;
  assertError(await submit(r), 409, "REPORT_EMPTY");
  assert.equal(assertOk(await getReport(r)).status, "draft");
});

test("R9 warnings do not block a submit", async () => {
  const r = (await newReport()).id;
  const e1 = await id({ date: SAT, amount: 1000, currency: "GBP" });
  assertOk(await attach(r, e1));
  const report = assertOk(await submit(r));
  assert.equal(report.status, "submitted");
  assert.deepEqual(report.expenseIds, [e1]);
});

test("R9 policy errors refuse a submit", async () => {
  const r = (await newReport()).id;
  const e1 = await id({ category: "travel", amount: 3000, currency: "GBP", date: WED });
  const e2 = await id({ date: SAT, amount: 1000, currency: "GBP" });
  assertOk(await attach(r, e1));
  assertOk(await attach(r, e2));
  const res = await submit(r);
  assertError(res, 409, "POLICY_VIOLATION");
  assert.deepEqual(
    res.body.error.details.map((v: any) => [v.code, v.severity, v.expenseIds]),
    [["RECEIPT_REQUIRED", "error", [e1]]],
  );
  for (const v of res.body.error.details) {
    assert.ok(typeof v.message === "string" && v.message.length > 0, JSON.stringify(v));
  }
  assert.equal(assertOk(await getReport(r)).status, "draft");
});

test("R7 approve moves submitted to approved, then it is final", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  assertOk(await attach(r, e1));
  assertOk(await submit(r));
  assert.equal(assertOk(await approve(r)).status, "approved");
  assertError(await approve(r), 409, "INVALID_STATE");
  assertError(await submit(r), 409, "INVALID_STATE");
  assertError(await reject(r, { reason: "Late" }), 409, "INVALID_STATE");
});

test("R7 a draft cannot be approved or rejected", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  assertOk(await attach(r, e1));
  assertError(await approve(r), 409, "INVALID_STATE");
  assertError(await reject(r, { reason: "No" }), 409, "INVALID_STATE");
});

test("R10 reject needs a reason and stores it", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  assertOk(await attach(r, e1));
  assertOk(await submit(r));
  for (const body of [{}, { reason: " " }]) {
    const res = await reject(r, body);
    assertError(res, 400, "VALIDATION_ERROR");
    assert.deepEqual(detailFields(res), ["reason"]);
  }
  const report = assertOk(await reject(r, { reason: "Missing itinerary" }));
  assert.equal(report.status, "rejected");
  assert.equal(report.rejectionReason, "Missing itinerary");
  assert.deepEqual(report.expenseIds, [e1]);
  assertError(await reject(r, { reason: "Again" }), 409, "INVALID_STATE");
  assertError(await submit(r), 409, "INVALID_STATE");
});

test("R4 attach and detach need a draft report", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  const e2 = await id();
  assertOk(await attach(r, e1));
  assertOk(await submit(r));
  assertError(await attach(r, e2), 409, "INVALID_STATE");
  assertError(await detach(r, e1), 409, "INVALID_STATE");
  // e1 is already in this active report, so R5 also applies; R4 wins.
  assertError(await attach(r, e1), 409, "INVALID_STATE");
});

test("R11 expenses in submitted and approved reports are locked", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  assertOk(await attach(r, e1));
  assertOk(await submit(r));
  assertError(await app().request("PATCH", `/expenses/${e1}`, { merchant: "X" }), 409, "EXPENSE_LOCKED");
  assertError(await app().request("DELETE", `/expenses/${e1}`), 409, "EXPENSE_LOCKED");
  assertOk(await approve(r));
  assertError(await app().request("PATCH", `/expenses/${e1}`, { merchant: "X" }), 409, "EXPENSE_LOCKED");
  assertError(await app().request("DELETE", `/expenses/${e1}`), 409, "EXPENSE_LOCKED");
});

test("R11 R12 draft expenses can change, and deleting detaches them", async () => {
  const r = (await newReport()).id;
  const e1 = await id();
  const e2 = await id();
  assertOk(await attach(r, e1));
  assertOk(await attach(r, e2));
  const patched = assertOk(await app().request("PATCH", `/expenses/${e1}`, { merchant: "Changed" }));
  assert.equal(patched.merchant, "Changed");
  assert.equal((await app().request("DELETE", `/expenses/${e1}`)).status, 204);
  assert.deepEqual(assertOk(await getReport(r)).expenseIds, [e2]);
});

test("R13 a rejected report unlocks its expenses", async () => {
  const e1 = await id();
  const a = (await newReport("A")).id;
  assertOk(await attach(a, e1));
  assertOk(await submit(a));
  assertOk(await reject(a, { reason: "No" }));
  const patched = assertOk(await app().request("PATCH", `/expenses/${e1}`, { amount: 900 }));
  assert.equal(patched.amount, 900);
  const b = (await newReport("B")).id;
  assert.deepEqual(assertOk(await attach(b, e1)).expenseIds, [e1]);
  const reportA = assertOk(await getReport(a));
  assert.deepEqual(reportA.expenseIds, [e1]);
  assert.equal(reportA.status, "rejected");
});

test("G4 body errors come before state errors", async () => {
  const e1 = await id();
  const r = (await newReport()).id;
  assertOk(await attach(r, e1));
  const rejected = await reject(r, {});
  assertError(rejected, 400, "VALIDATION_ERROR");
  assert.deepEqual(detailFields(rejected), ["reason"]);
  assertOk(await submit(r));
  const patched = await app().request("PATCH", `/expenses/${e1}`, { amount: 0 });
  assertError(patched, 400, "VALIDATION_ERROR");
  assert.deepEqual(detailFields(patched), ["amount"]);
});
