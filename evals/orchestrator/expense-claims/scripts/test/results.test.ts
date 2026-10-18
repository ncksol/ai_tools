import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  appendResult,
  defaultCalibration,
  formatSummary,
  median,
  parseCsvText,
  readResults,
  replaceResult,
  RESULT_COLUMNS,
  summarize,
  toCsvLine,
  type ResultRow,
} from "../lib/results.ts";

const FULL = "policy+reports+import+summary";
const THREE = "policy+reports+import";

function row(values: Partial<ResultRow>): ResultRow {
  const base = Object.fromEntries(RESULT_COLUMNS.map((column) => [column, ""])) as ResultRow;
  return { ...base, features: FULL, calibration: "no", outcome: "passed", ...values };
}

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("CSV lines quote only when needed and round-trip", () => {
  const values = ["a", "b,c", 'say "hi"', "x\ny", ""];
  const line = toCsvLine(values);
  assert.equal(line, 'a,"b,c","say ""hi""","x\ny",');
  assert.deepEqual(parseCsvText(line + "\n"), [values]);
});

test("appendResult writes the header once", () => {
  const path = join(dir, "append.csv");
  const first = row({ variant: "a", run: "1", minutes: "12.5", note: "one, two" });
  const second = row({ variant: "b", run: "1", minutes: "20.0" });
  appendResult(path, first);
  appendResult(path, second);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], RESULT_COLUMNS.join(","));
  assert.deepEqual(readResults(path), [first, second]);
});

test("replaceResult drops the rows for one repo and run, keeps the rest in order and adds the new row last", () => {
  const path = join(dir, "replace.csv");
  const a = row({ variant: "a", run: "1", repo: "o/orch-eval-a-1", minutes: "10.0" });
  const old = row({ variant: "b", run: "1", repo: "o/orch-eval-b-1", minutes: "30.0", note: "first, try" });
  const c = row({ variant: "c", run: "1", repo: "o/orch-eval-c-1", minutes: "12.0" });
  const otherRun = row({ variant: "b", run: "2", repo: "o/orch-eval-b-1", minutes: "14.0" });
  for (const r of [a, old, c, otherRun]) appendResult(path, r);
  const fresh = row({ variant: "b", run: "1", repo: "o/orch-eval-b-1", minutes: "25.0" });
  replaceResult(path, "o/orch-eval-b-1", "1", fresh);
  assert.deepEqual(readResults(path), [a, c, otherRun, fresh]);
  assert.equal(readFileSync(path, "utf8").split("\n")[0], RESULT_COLUMNS.join(","));
});

test("defaultCalibration is yes only for a variant's first row with the full feature set", () => {
  const earlier = [row({ variant: "A" })];
  assert.equal(defaultCalibration(earlier, "B", FULL), "yes");
  assert.equal(defaultCalibration(earlier, "A", FULL), "no");
  assert.equal(defaultCalibration(earlier, "B", THREE), "no");
  assert.equal(defaultCalibration([], "B", THREE), "no");
});

test("readResults rejects a different header", () => {
  const path = join(dir, "other.csv");
  writeFileSync(path, "a,b\n1,2\n");
  assert.throws(() => readResults(path));
});

test("median handles odd, even and empty lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("the calibration batch counts when its median is 30 minutes or less", () => {
  const summary = summarize([
    row({ variant: "A", calibration: "yes", minutes: "25.0" }),
    row({ variant: "B", calibration: "yes", minutes: "28.0" }),
    row({ variant: "A", minutes: "20.0" }),
    row({ variant: "B", outcome: "gate-failed", minutes: "15.0" }),
  ]);
  assert.equal(summary.calibration.median, 26.5);
  assert.equal(summary.calibration.counted, true);
  const a = summary.groups.find((group) => group.variant === "A")!;
  const b = summary.groups.find((group) => group.variant === "B")!;
  assert.deepEqual([a.runs, a.passed, a.medianMinutes], [2, 2, 22.5]);
  assert.deepEqual([b.runs, b.passed, b.passRate, b.medianMinutes], [2, 1, 0.5, 28]);
});

test("a slow calibration batch is left out and says to drop Summary", () => {
  const summary = summarize([
    row({ variant: "A", calibration: "yes", minutes: "35.0" }),
    row({ variant: "B", calibration: "yes", outcome: "timeout", minutes: "90.0" }),
    row({ variant: "C", calibration: "yes", outcome: "stalled", minutes: "40.0" }),
  ]);
  assert.equal(summary.calibration.median, Infinity);
  assert.equal(summary.calibration.counted, false);
  const text = formatSummary(summary);
  assert.doesNotMatch(text, /Infinity/);
  assert.match(text, /drop Summary/);
  assert.match(text, /--features policy,reports,import/);
  assert.equal(summary.groups.find((group) => group.variant === "A")!.runs, 0);
});

test("gate-failed and stalled first runs count in the calibration median", () => {
  const failed = summarize([
    row({ variant: "A", calibration: "yes", minutes: "20.0" }),
    row({ variant: "B", calibration: "yes", outcome: "gate-failed", minutes: "45.0" }),
    row({ variant: "C", calibration: "yes", outcome: "gate-failed", minutes: "50.0" }),
  ]);
  assert.equal(failed.calibration.median, 45);
  assert.equal(failed.calibration.counted, false);
  const stalled = summarize([
    row({ variant: "A", calibration: "yes", minutes: "20.0" }),
    row({ variant: "B", calibration: "yes", minutes: "22.0" }),
    row({ variant: "C", calibration: "yes", outcome: "stalled", minutes: "5.0" }),
  ]);
  assert.equal(stalled.calibration.median, 22);
  assert.equal(stalled.calibration.counted, true);
});

test("runs are grouped by feature set", () => {
  const summary = summarize([
    row({ variant: "A", minutes: "25.0" }),
    row({ variant: "A", features: THREE, minutes: "18.0" }),
    row({ variant: "A", features: THREE, minutes: "16.0" }),
  ]);
  assert.equal(summary.groups.length, 2);
  assert.deepEqual(summary.groups.map((group) => [group.features, group.runs]).sort(), [
    [FULL, 1],
    [THREE, 2],
  ]);
});

test("a slow batch leaves out only full-set calibration rows; a later three-feature row still counts", () => {
  const summary = summarize([
    row({ variant: "A", calibration: "yes", minutes: "40.0" }),
    row({ variant: "B", calibration: "yes", minutes: "45.0" }),
    row({ variant: "C", features: THREE, calibration: "yes", minutes: "20.0" }),
    row({ variant: "C", features: THREE, minutes: "24.0" }),
  ]);
  assert.equal(summary.calibration.runs, 2);
  assert.equal(summary.calibration.counted, false);
  const c = summary.groups.find((group) => group.variant === "C" && group.features === THREE)!;
  assert.deepEqual([c.runs, c.passed, c.medianMinutes], [2, 2, 22]);
  assert.equal(summary.groups.find((group) => group.variant === "A")!.runs, 0);
});
