import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { after, test } from "node:test";
import { rehearse, REHEARSAL_VARIANTS, type RehearsalResult } from "../lib/batch/rehearsal.ts";
import { run as runProc } from "../lib/proc.ts";
import { readResults } from "../lib/results.ts";

// The whole batch, stubbed only where the app and the driver agent would act: real new-run
// --dry-run, real score with its acceptance suite, real git commits, real curl to a local stub.
let result: RehearsalResult | undefined;
after(() => {
  if (result) rmSync(result.dir, { recursive: true, force: true });
});

test("a rehearsal of a whole batch runs the self-test and four runs, scores each, and reports", { timeout: 600_000 }, async () => {
  result = await rehearse();
  const { config, transcript, notifications, final, app } = result;
  assert.equal(final.details?.phase, "done");

  const rows = readResults(config.resultsPath).filter((row) => REHEARSAL_VARIANTS.includes(row.variant));
  assert.deepEqual(
    rows.map((row) => [row.variant, row.run, row.outcome, row.calibration, row.questions]),
    [
      ["variant-a", "1", "gate-failed", "yes", "1"],
      ["variant-b", "1", "gate-failed", "yes", "1"],
      ["variant-a", "2", "stalled", "no", "0"],
      ["variant-b", "2", "timeout", "no", "0"],
    ],
  );
  // The plain-text answer counted as a question with blocked time, through --answer-source.
  assert.ok(Number(rows[1].blocked_minutes) > 0);
  // Real score saw the driver's runs as started by the user (no kickoff warning).
  assert.ok(rows.every((row) => !/another session/i.test(row.note)), rows.map((r) => r.note).join(" | "));
  assert.ok(rows.every((row) => row.cost_status === "incomplete" && row.cost_usd === "" && /no-data\.db not found/.test(row.note)), rows.map((r) => r.note).join(" | "));
  assert.ok(Number(rows[0].cost_sessions) > 1, "the synthetic child contributes usage");
  assert.ok(rows.every((row) => row.robustness_status === "failed" && row.robustness_total === "12"));

  const created = transcript.filter((line) => line.includes("create_session ("));
  assert.deepEqual(
    created.map((line) => line.match(/agent (\S+)\)/)![1]),
    ["default", "variant-a", "variant-b", "variant-a", "variant-b"],
  );
  assert.equal(transcript.filter((line) => /send_session_message "This run is over/.test(line)).length, 2, "stop messages only after the stalled and timed-out runs");

  assert.deepEqual(
    notifications.map((n) => n.title),
    ["Eval batch started", "Eval self-test passed", "Eval run 1/4: gate-failed", "Eval run 2/4: gate-failed", "Eval run 3/4: stalled", "Eval run 4/4: timeout", "Eval batch done"],
  );
  assert.match(notifications[0].body, /^Batch rehearsal started\. Plan: self-test, then calibration runs first \(variant-a, variant-b\), then variant-a x2, variant-b x2\. No new run starts after \d\d:\d\d\.$/);
  assert.deepEqual(result.awake, { started: 1, stopped: 1 });

  const log = await runProc("git", ["log", "--format=%s"], { cwd: config.resultsPath.replace(/\/results\.csv$/, "") });
  assert.equal(log.stdout.split("\n").filter((line) => line.startsWith("chore(evals): record")).length, 4);

  const report = readFileSync(String(final.details?.report), "utf8");
  for (const heading of ["## Runs", "## Flags", "## Self-test", "## Summary of results.csv", "## Sessions to archive", "## Repos and folders created", "## Land the results", "## Morning checklist"]) {
    assert.ok(report.includes(heading), heading);
  }
  assert.match(report, /Turn Copilot Memory back on/);
  assert.equal(app.sessions.size, 5);
});
