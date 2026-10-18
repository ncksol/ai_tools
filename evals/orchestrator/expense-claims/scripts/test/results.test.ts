import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  appendResult,
  formatSummary,
  median,
  parseCsvText,
  readResults,
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
  assert.equal(summary.calibration.counted, false);
  const text = formatSummary(summary);
  assert.doesNotMatch(text, /Infinity/);
  assert.match(text, /drop Summary/);
  assert.match(text, /--features policy,reports,import/);
  assert.equal(summary.groups.find((group) => group.variant === "A")!.runs, 0);
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
