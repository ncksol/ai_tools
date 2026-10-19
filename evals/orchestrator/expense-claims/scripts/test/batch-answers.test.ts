import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseAnswerSheet, questionTag, readAnswerSheet, replyFor, rowForQuestion, settleRow } from "../lib/batch/answers.ts";
import { KIT_DIR } from "../lib/suite.ts";

const sheet = readAnswerSheet(join(KIT_DIR, "answers.md"));

test("the answer sheet has its four rows, word for word", () => {
  assert.deepEqual(
    sheet.map((row) => [row.row, row.type, row.reply]),
    [
      [1, "Plan approval", "Approved. Go ahead."],
      [2, "Opening, publishing or merging a PR", "Approved. Squash-merge when CI is green."],
      [3, "A question about the spec", "Follow docs/spec-v2.md. Where it is silent, make a reasonable call and note it in the PR description."],
      [4, "Anything else", "Your call. Don't wait for me."],
    ],
  );
});

test("a sheet without four rows is rejected", () => {
  assert.throws(() => parseAnswerSheet("| Question type | Reply |\n|---|---|\n| Plan approval | Approved. |\n"), /4 rows/);
});

test("question tags are read from the start of the question", () => {
  assert.deepEqual(questionTag("[unit=* need=plan] Approve this split?"), { unit: "*", need: "plan" });
  assert.deepEqual(questionTag("  [unit=api need=pr] Open a draft PR?"), { unit: "api", need: "pr" });
  assert.deepEqual(questionTag("[unit=api,web] The units disagree."), { unit: "api,web", need: null });
  assert.equal(questionTag("Should I go ahead? [unit=api need=pr]"), null);
});

test("need=plan is row 1, need=pr is row 2, anything else is the driver's call between 3 and 4", () => {
  assert.deepEqual(rowForQuestion("[unit=* need=plan] Approve?").row, 1);
  assert.deepEqual(rowForQuestion("[unit=api need=pr] Merge it?").row, 2);
  for (const question of ["[unit=api need=question] Which date format?", "[unit=api] Which date format?", "Which date format?"]) {
    const result = rowForQuestion(question);
    assert.equal(result.row, null, question);
    assert.deepEqual(result.candidates, [3, 4]);
  }
});

test("settleRow lets the tag decide and checks the driver's row", () => {
  assert.equal(settleRow("[unit=* need=plan] Approve?", undefined), 1);
  assert.equal(settleRow("[unit=* need=plan] Approve?", 1), 1);
  assert.throws(() => settleRow("[unit=* need=plan] Approve?", 4), /fixes row 1/);
  assert.throws(() => settleRow("Which format?", undefined), /--row 3 or 4/);
  assert.throws(() => settleRow("Which format?", 1), /3 or 4/);
  assert.equal(settleRow("Which format?", 3), 3);
  assert.equal(replyFor(sheet, settleRow("Anything?", 4)), "Your call. Don't wait for me.");
});
