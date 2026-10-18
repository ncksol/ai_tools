import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { stripFeatures } from "../lib/features.ts";
import { run } from "../lib/proc.ts";
import { readResults } from "../lib/results.ts";
import { KIT_DIR } from "../lib/suite.ts";
import { basic, childLog, ev, withEvents, writeSession } from "./fixtures/events.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await run("git", ["-c", "user.name=Eval Test", "-c", "user.email=eval-test@example.invalid", ...args], { cwd });
  assert.equal(result.code, 0, result.stderr);
}

function score(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return run(process.execPath, ["scripts/score.ts", ...args], { cwd: KIT_DIR, env });
}

test("score times a synthetic session, runs the seed's suite on a fresh clone and appends or replaces a row", { timeout: 300_000 }, async () => {
  const repoDir = join(dir, "orch-eval-e2e-1");
  cpSync(join(KIT_DIR, "reference"), repoDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.DS_Store)$/.test(src) });
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Reference"]);
  // The evaluated main drops Summary from its own spec; the gate must still use the first commit's spec.
  const specPath = join(repoDir, "docs", "spec-v2.md");
  writeFileSync(specPath, stripFeatures(readFileSync(specPath, "utf8"), ["policy", "reports", "import"]));
  await git(repoDir, ["commit", "-q", "-am", "Drop Summary"]);

  // The run's shape: a stray session that never ran, the orchestrator session, and its child sessions.
  const stateDir = join(dir, "state");
  const repository = "local/orch-eval-e2e-1";
  const events = withEvents(basic(), [
    ev("tool.execution_start", 3, { toolName: "ask_user", toolCallId: "q1" }),
    ev("tool.execution_complete", 5, { toolCallId: "q1", success: true }),
  ]);
  writeSession(stateDir, "s0", repository, "2026-01-01T09:00:00Z", null);
  writeSession(stateDir, "s1", repository, "2026-01-01T10:00:00Z", events);
  writeSession(stateDir, "c1", repository, "2026-01-01T10:20:00Z", childLog());
  writeSession(stateDir, "c2", repository, "2026-01-01T10:20:01Z", childLog());

  const results = join(dir, "results.csv");
  const common = ["--repo-dir", repoDir, "--state-dir", stateDir, "--no-github", "--results", results];

  const ok = await score(common);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Session s1 \(the only session for local\/orch-eval-e2e-1 that you started\)/);
  const rows = readResults(results);
  assert.equal(rows.length, 1);
  const expected = {
    variant: "e2e",
    run: "1",
    session: "s1",
    agent: "orchestrator",
    features: "policy+reports+import+summary",
    calibration: "yes",
    outcome: "passed",
    minutes: "18.0",
    wall_minutes: "20.0",
    blocked_minutes: "2.0",
    questions: "1",
    suite_passed: "65",
    suite_total: "65",
    prs_merged: "n/a",
    main_ci: "n/a",
    model: "claude-opus-5.5",
    effort: "max",
    copilot_version: "1.0.99-2",
  };
  for (const [column, value] of Object.entries(expected)) assert.equal(rows[0][column as keyof typeof expected], value, column);
  assert.match(rows[0].note, /spec on main lists policy\+reports\+import; scored against the seed's policy\+reports\+import\+summary/);
  const firstFile = readFileSync(results, "utf8");

  const missing = await score([...common, "--session", "missing", "--replace"]);
  assert.equal(missing.code, 2, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /--start/);
  assert.equal(readFileSync(results, "utf8"), firstFile);

  const again = await score([...common, "--session", "s1"]);
  assert.equal(again.code, 2, again.stdout + again.stderr);
  assert.match(again.stderr, /--replace/);
  assert.ok(again.stderr.includes(rows[0].date), again.stderr);
  assert.doesNotMatch(again.stdout, /acceptance suite/);
  assert.equal(readFileSync(results, "utf8"), firstFile);

  // A second session the user started makes discovery ambiguous: score stops and asks for --session.
  writeSession(stateDir, "s2", repository, "2026-01-01T11:00:00Z", basic());
  const ambiguous = await score([...common, "--replace"]);
  assert.equal(ambiguous.code, 2, ambiguous.stdout + ambiguous.stderr);
  assert.match(ambiguous.stderr, /2 sessions for local\/orch-eval-e2e-1 were started by you, and none of them used agent e2e/);
  for (const id of ["s0", "s1", "s2", "c1", "c2"]) assert.match(ambiguous.stderr, new RegExp(`^  ${id}  created `, "m"));
  assert.match(ambiguous.stderr, /Rerun with --session <id>\./);
  assert.doesNotMatch(ambiguous.stderr, /Time it by hand/);
  assert.equal(readFileSync(results, "utf8"), firstFile);

  // --session overrides discovery.
  const before = Date.now();
  const stalled = await score([...common, "--session", "s1", "--outcome", "stalled", "--replace"]);
  assert.match(stalled.stdout, /Session s1 \(from --session\)/);
  assert.equal(stalled.code, 0, stalled.stdout + stalled.stderr);
  const replaced = readResults(results);
  assert.equal(replaced.length, 1);
  const unfinished = replaced[0];
  assert.equal(unfinished.outcome, "stalled");
  // The replaced row is not an earlier run of this variant, so this is still its calibration run.
  assert.equal(unfinished.calibration, "yes");
  const minimumWall = (before - Date.parse("2026-01-01T10:01:00.000Z")) / 60_000;
  assert.ok(Number(unfinished.wall_minutes) >= Math.floor(minimumWall), unfinished.wall_minutes);
});

test("a new variant's first run with fewer features is not a calibration run", { timeout: 180_000 }, async () => {
  const repoDir = join(dir, "orch-eval-three-1");
  cpSync(join(KIT_DIR, "reference"), repoDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.DS_Store)$/.test(src) });
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Reference"]);
  const results = join(dir, "results-three.csv");
  const res = await score([
    "--repo-dir", repoDir, "--no-github", "--results", results, "--features", "policy,reports,import",
    "--start", "2026-01-01T10:00:00Z", "--end", "2026-01-01T10:20:00Z",
  ]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const [only] = readResults(results);
  assert.equal(only.variant, "three");
  assert.equal(only.features, "policy+reports+import");
  assert.equal(only.calibration, "no");
  assert.equal(only.outcome, "passed");
});
