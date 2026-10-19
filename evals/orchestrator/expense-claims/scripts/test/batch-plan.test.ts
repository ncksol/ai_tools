import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ALL_FEATURES } from "../lib/features.ts";
import { calibrationDecision, nextRunNumber, planNext, scoredCount, WITHOUT_SUMMARY } from "../lib/batch/plan.ts";
import type { RunState } from "../lib/batch/state.ts";
import { readResults, RESULT_COLUMNS, type ResultRow } from "../lib/results.ts";
import { KIT_DIR } from "../lib/suite.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-plan-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const FULL = "policy+reports+import+summary";
const THREE = "policy+reports+import";

function row(variant: string, run: number, features: string, calibration: "yes" | "no", outcome: string, minutes: number): ResultRow {
  const r = Object.fromEntries(RESULT_COLUMNS.map((c) => [c, ""])) as ResultRow;
  return { ...r, variant, run: String(run), repo: `ncksol/orch-eval-${variant}-${run}`, features, calibration, outcome, minutes: minutes.toFixed(1) };
}

function run(variant: string, n: number): RunState {
  return { key: `${variant}#${n}`, variant, n, features: ALL_FEATURES, calibration: false, name: `orch-eval-${variant}-${n}`, repoDir: "", repo: `ncksol/orch-eval-${variant}-${n}`, status: "done", createdAt: "", judged: [], answers: [], askAttempts: {}, flags: [] };
}

test("today's results.csv: run 1 at 65.7 minutes forces dropping Summary for two variants, with no calibration run", () => {
  const rows = readResults(join(KIT_DIR, "results.csv"));
  const decision = calibrationDecision(rows, ["orchestrator", "session-orchestrator"]);
  assert.equal(decision.state, "drop");
  assert.deepEqual(decision.features, WITHOUT_SUMMARY);
  assert.deepEqual(decision.pending, []);
  assert.equal(decision.best, 65.7 / 2);
  const { next } = planNext([], rows, ["orchestrator", "session-orchestrator"], 3);
  assert.deepEqual(next, { variant: "orchestrator", features: WITHOUT_SUMMARY, calibration: false });
});

test("with no history, both variants run calibration first", () => {
  const decision = calibrationDecision([], ["a", "b"]);
  assert.equal(decision.state, "undecided");
  assert.deepEqual(decision.pending, ["a", "b"]);
  assert.deepEqual(planNext([], [], ["a", "b"], 3).next, { variant: "a", features: ALL_FEATURES, calibration: true });
});

test("a calibration run that can't change the decision is skipped", () => {
  // 20 and 40 so far: c's run decides it (median 20 if it is fast, 40 if it never finishes).
  const open = calibrationDecision([row("a", 1, FULL, "yes", "passed", 20), row("b", 1, FULL, "yes", "gate-failed", 40)], ["a", "b", "c"]);
  assert.equal(open.state, "undecided");
  assert.deepEqual(open.pending, ["c"]);
  // Two fast finished runs: even a never-ending third run leaves the median at 25.
  assert.equal(calibrationDecision([row("a", 1, FULL, "yes", "passed", 20), row("b", 1, FULL, "yes", "gate-failed", 25)], ["a", "b", "c"]).state, "full");
  // With a third, older variant at 10, the median is at most 30 whatever c does.
  assert.equal(calibrationDecision([row("a", 1, FULL, "yes", "passed", 20), row("b", 1, FULL, "yes", "gate-failed", 40), row("x", 1, FULL, "yes", "passed", 10)], ["a", "b", "c"]).state, "full");
  // Two slow ones: even a 0-minute third run leaves the median over 30.
  const slow = calibrationDecision([row("a", 1, FULL, "yes", "passed", 40), row("b", 1, FULL, "yes", "timeout", 90)], ["a", "b", "c"]);
  assert.equal(slow.state, "drop");
  assert.deepEqual(slow.pending, []);
});

test("unfinished calibration runs count as longer than any finished run", () => {
  const rows = [row("a", 1, FULL, "yes", "stalled", 12), row("b", 1, FULL, "yes", "passed", 10)];
  assert.equal(calibrationDecision(rows, ["a", "b"]).state, "drop");
});

test("after the calibration runs, the decision is made and calibration runs count only if the full set stays", () => {
  const kept = [row("a", 1, FULL, "yes", "passed", 20), row("b", 1, FULL, "yes", "passed", 22)];
  const runs = [run("a", 1), run("b", 1)];
  assert.equal(scoredCount(runs, kept, "a", ALL_FEATURES), 1);
  assert.deepEqual(planNext(runs, kept, ["a", "b"], 2).next, { variant: "a", features: ALL_FEATURES, calibration: false });

  const dropped = [row("a", 1, FULL, "yes", "passed", 45), row("b", 1, FULL, "yes", "passed", 50)];
  assert.equal(scoredCount(runs, dropped, "a", WITHOUT_SUMMARY), 0);
  assert.deepEqual(planNext(runs, dropped, ["a", "b"], 2).next, { variant: "a", features: WITHOUT_SUMMARY, calibration: false });
});

test("variants alternate A1, B1, A2, B2 and a run without a row doesn't count", () => {
  const rows = readResults(join(KIT_DIR, "results.csv"));
  const variants = ["orchestrator", "session-orchestrator"];
  const runs: RunState[] = [];
  const order: string[] = [];
  const all = [...rows];
  for (let i = 0; i < 6; i++) {
    const { next } = planNext(runs, all, variants, 3);
    assert.ok(next);
    const n = nextRunNumber(next.variant, all, join(dir, "none"), runs);
    order.push(`${next.variant}#${n}`);
    const r = run(next.variant, n);
    runs.push(r);
    if (i !== 2) all.push(row(next.variant, n, THREE, "no", "passed", 30));
  }
  // The third run (orchestrator #3) wrote no row, so orchestrator goes again.
  assert.deepEqual(order, ["orchestrator#2", "session-orchestrator#1", "orchestrator#3", "orchestrator#4", "session-orchestrator#2", "orchestrator#5"]);
  runs.push(run("session-orchestrator", 3));
  all.push(row("session-orchestrator", 3, THREE, "no", "passed", 30));
  assert.equal(planNext(runs, all, variants, 3).next, null);
});

test("run numbers follow results.csv, the runs folder and the batch", () => {
  const runsDir = join(dir, "runs");
  mkdirSync(join(runsDir, "orch-eval-a-4"), { recursive: true });
  writeFileSync(join(runsDir, "orch-eval-a-6.kickoff.md"), "");
  mkdirSync(join(runsDir, "orch-eval-ab-9"), { recursive: true });
  assert.equal(nextRunNumber("a", [], runsDir, []), 7);
  assert.equal(nextRunNumber("a", [row("a", 8, THREE, "no", "passed", 1)], runsDir, []), 9);
  assert.equal(nextRunNumber("a", [], runsDir, [run("a", 11)]), 12);
  assert.equal(nextRunNumber("b", [], runsDir, []), 1);
});
