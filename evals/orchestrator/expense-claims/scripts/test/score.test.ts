import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { ALL_FEATURES, stripFeatures } from "../lib/features.ts";
import { run } from "../lib/proc.ts";
import { readResults } from "../lib/results.ts";
import { KIT_DIR, robustnessFiles, robustnessSha256 } from "../lib/suite.ts";
import { basic, childLog, ev, withEvents, writeSession } from "./fixtures/events.ts";
import { PERMISSIVE_CSV } from "./fixtures/permissive-csv.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await run("git", ["-c", "user.name=Eval Test", "-c", "user.email=eval-test@example.invalid", ...args], { cwd });
  assert.equal(result.code, 0, result.stderr);
}

// Every synthetic score run reads a scratch app DB and session folder that don't exist, unless the
// test passes its own; never the user's ~/.copilot.
function scoreArgs(args: string[]): string[] {
  const scratch = [];
  if (!args.includes("--app-db")) scratch.push("--app-db", join(dir, "no-app.db"));
  if (!args.includes("--state-dir")) scratch.push("--state-dir", join(dir, "no-state"));
  return [...args, ...scratch];
}

function score(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return run(process.execPath, ["scripts/score.ts", ...scoreArgs(args)], { cwd: KIT_DIR, env });
}

test("synthetic score runs never default to the real app DB or session folder", () => {
  for (const args of [[], ["--repo-dir", "x"]]) {
    const full = scoreArgs(args);
    for (const flag of ["--app-db", "--state-dir"]) {
      const path = full[full.indexOf(flag) + 1];
      assert.ok(path.startsWith(dir), `${flag} ${path}`);
      assert.equal(existsSync(path), false, path);
    }
  }
  const own = scoreArgs(["--app-db", "/scratch/a.db", "--state-dir", "/scratch/state"]);
  assert.deepEqual(own, ["--app-db", "/scratch/a.db", "--state-dir", "/scratch/state"]);
});

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
    ev("session.task_complete", 21.1),
    ev("assistant.message", 40),
    ev("tool.execution_start", 2, { toolName: "create_session", toolCallId: "child1" }),
    ev("tool.execution_complete", 2.1, { toolCallId: "child1", success: true, result: { content: "Created session 'one' (id: c1) in project 'test'." } }),
    ev("tool.execution_start", 2.2, { toolName: "create_session", toolCallId: "child2" }),
    ev("tool.execution_complete", 2.3, { toolCallId: "child2", success: true, result: { content: "Created session 'two' (id: c2) in project 'test'." } }),
    ev("session.usage_record", 3, { usage: { model: "claude-opus-5.5", inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, interactionType: "conversation-agent" } }),
    ev("session.usage_record", 7, { usage: { model: "claude-sonnet-5.5", inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, interactionType: "conversation-subagent" } }, "subagent"),
  ]);
  writeSession(stateDir, "s0", repository, "2026-01-01T09:00:00Z", null);
  writeSession(stateDir, "s1", repository, "2026-01-01T10:00:00Z", events);
  const child = [...childLog(), ev("session.usage_record", 22.1, { usage: { model: "claude-opus-5.5", inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, interactionType: "conversation-agent" } })];
  writeSession(stateDir, "c1", repository, "2026-01-01T10:20:00Z", child);
  writeSession(stateDir, "c2", repository, "2026-01-01T10:20:01Z", child);
  writeSession(stateDir, "old-root", repository, "2026-01-01T09:00:00Z", [
    ev("session.usage_record", 4, { usage: { model: "claude-opus-5.5", inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, interactionType: "conversation-agent" } }),
  ]);
  const appDb = join(dir, "aliases.db");
  const fixtureDb = new DatabaseSync(appDb);
  fixtureDb.exec("CREATE TABLE workspaces (id TEXT, session_id TEXT, creator_session_id TEXT, coordinating_creator_session_id TEXT);");
  fixtureDb.exec("CREATE TABLE workspace_session_aliases (session_id TEXT, workspace_id TEXT);");
  fixtureDb.exec("INSERT INTO workspaces (id,session_id) VALUES ('root-workspace','s1');");
  fixtureDb.exec("INSERT INTO workspace_session_aliases VALUES ('old-root','root-workspace');");
  fixtureDb.close();
  const originalDb = readFileSync(appDb);

  const results = join(dir, "results.csv");
  const common = ["--repo-dir", repoDir, "--state-dir", stateDir, "--app-db", appDb, "--no-github", "--results", results];

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
    robustness_status: "passed",
    robustness_passed: "12",
    robustness_total: "12",
    cost_status: "complete",
    cost_usd: "0.027000000",
    cost_sessions: "4",
    usage_records: "5",
    input_tokens_all_models: "5000",
    cache_read_tokens_all_models: "0",
    cache_write_tokens_all_models: "0",
    output_tokens_all_models: "500",
  };
  for (const [column, value] of Object.entries(expected)) assert.equal(rows[0][column as keyof typeof expected], value, column);
  assert.deepEqual(readFileSync(appDb), originalDb, "scoring must not write the alias database");
  const suiteHash = robustnessSha256(robustnessFiles(ALL_FEATURES));
  assert.match(suiteHash, /^[a-f0-9]{64}$/);
  assert.equal(rows[0].robustness_sha256, suiteHash);
  assert.ok(ok.stdout.includes(`Robustness suite sha256: ${suiteHash}\n`), ok.stdout);
  assert.match(rows[0].main_sha, /^[a-f0-9]{40}$/);
  assert.match(rows[0].pricing_version, /^2026-10-20:[a-f0-9]{64}$/);
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
  for (const outcome of ["timeout", "stalled"]) {
    const before = Date.now();
    const result = await score([
      ...common, "--session", "s1", "--outcome", outcome, "--end-at", "2026-01-01T10:21:00Z", "--replace",
    ]);
    assert.match(result.stdout, /Session s1 \(from --session\)/);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const replaced = readResults(results);
    assert.equal(replaced.length, 1);
    const unfinished = replaced[0];
    assert.equal(unfinished.outcome, outcome);
    // The replaced row is not an earlier run of this variant, so this is still its calibration run.
    assert.equal(unfinished.calibration, "yes");
    const minimumWall = (before - Date.parse("2026-01-01T10:01:00.000Z")) / 60_000;
    assert.ok(Number(unfinished.wall_minutes) >= Math.floor(minimumWall), unfinished.wall_minutes);
  }
});

test("score attributes driver answers and caps a completed log at the observed report", { timeout: 180_000 }, async () => {
  const repoDir = join(dir, "orch-eval-driver-1");
  cpSync(join(KIT_DIR, "reference"), repoDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.DS_Store)$/.test(src) });
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Reference"]);
  const stateDir = join(dir, "driver-state");
  writeSession(stateDir, "driver-run", "local/orch-eval-driver-1", "2026-01-01T10:00:00Z", [
    ...basic().slice(0, 2),
    ev("user.message", 0.5, { content: "<cross_session_message>synthetic kickoff</cross_session_message>" }),
    ...basic().slice(2, 8),
    ev("session.task_complete", 10.5),
    ev("assistant.message", 11),
    ev("assistant.turn_end", 11),
    ev("user.message", 13, {
      source: "agent-driver",
      transformedContent: "<cross_session_message>\nsynthetic answer\n</cross_session_message>",
    }),
    ev("assistant.turn_start", 13),
    ev("user.message", 14, { content: "<cross_session_message>\nsynthetic child report\n</cross_session_message>" }),
    ev("assistant.message", 21),
    ev("session.task_complete", 21.1),
    ev("assistant.turn_end", 21.2),
    ev("user.message", 25, { source: "agent-child" }),
    ev("assistant.turn_start", 25),
    ev("assistant.message", 30),
    ev("session.task_complete", 31),
  ]);
  const results = join(dir, "driver-results.csv");
  const result = await score([
    "--repo-dir", repoDir, "--state-dir", stateDir, "--no-github", "--results", results,
    "--session", "driver-run", "--answer-source", "agent-driver", "--end-at", "2026-01-01T11:22:00+01:00", "--note", "driver-run",
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const [row] = readResults(results);
  assert.equal(row.wall_minutes, "20.0");
  assert.equal(row.blocked_minutes, "2.0");
  assert.equal(row.minutes, "18.0");
  assert.equal(row.questions, "1");
  assert.equal(row.outcome, "passed");
  assert.equal(row.suite_passed, "65");
  assert.equal(row.suite_total, "65");
  assert.match(row.note, /^driver-run; .*2 .*session\.task_complete.*last/);
  assert.match(row.note, /another session.*later human kickoff/);
});

test("score rejects invalid log timing options before scoring", async () => {
  const common = [
    "--repo-dir", dir, "--variant", "invalid", "--n", "1", "--no-github", "--results", join(dir, "invalid.csv"), "--state-dir", dir,
  ];
  const cases: [string[], RegExp][] = [
    [["--end-at", "not-a-time"], /--end-at .* is not an ISO 8601/],
    [["--end-at", "2026-01-01T10:20:00"], /--end-at.*Z.*UTC offset/],
    [["--end-at", "2026-01-01"], /--end-at.*Z.*UTC offset/],
    [["--end-at", "2026-01-01T10:20:00+0100"], /--end-at.*Z.*UTC offset/],
    [["--answer-source", ""], /--answer-source must not be empty/],
    [["--start", "2026-01-01T10:00:00Z", "--end", "2026-01-01T10:20:00Z", "--end-at", "2026-01-01T10:20:00Z"], /--end-at.*manual timing/],
    [["--start", "2026-01-01T10:00:00Z", "--end", "2026-01-01T10:20:00Z", "--answer-source", "agent-driver"], /--answer-source.*manual timing/],
  ];
  for (const [args, message] of cases) {
    const result = await score([...common, ...args]);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stdout, /acceptance suite/);
  }
});

test("score rejects an end-at before the log kickoff explicitly", async () => {
  const stateDir = join(dir, "before-kickoff-state");
  writeSession(stateDir, "s1", "local/invalid", "2026-01-01T10:00:00Z", basic());
  const result = await score([
    "--repo-dir", dir, "--variant", "invalid", "--n", "1", "--no-github", "--results", join(dir, "before-kickoff.csv"),
    "--state-dir", stateDir, "--session", "s1", "--end-at", "2026-01-01T10:00:00Z",
  ]);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /--end-at is before the kickoff/);
  assert.doesNotMatch(result.stdout, /acceptance suite/);
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

test("robustness failures do not change a passing gate outcome or the timed score", { timeout: 180_000 }, async () => {
  const repoDir = join(dir, "orch-eval-permissive-1");
  cpSync(join(KIT_DIR, "reference"), repoDir, { recursive: true });
  writeFileSync(join(repoDir, "src", "csv.ts"), PERMISSIVE_CSV);
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Permissive reference"]);
  const results = join(dir, "permissive-results.csv");
  const result = await score([
    "--repo-dir", repoDir, "--no-github", "--results", results,
    "--start", "2026-01-01T10:00:00Z", "--end", "2026-01-01T10:20:00Z",
  ]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const [row] = readResults(results);
  assert.equal(row.outcome, "passed");
  assert.equal(row.minutes, "20.0");
  assert.equal(row.suite_passed, "65");
  assert.equal(row.suite_total, "65");
  assert.equal(row.robustness_status, "failed");
  assert.equal(row.robustness_passed, "3");
  assert.equal(row.robustness_total, "12");
  assert.equal(row.cost_status, "unavailable");
  assert.equal(row.cost_usd, "");
});

// The reference's parser, wrapped so that an import body with a lone CR (only the robustness suite
// sends one) blocks the app for good. While blocked it ignores SIGTERM, so only SIGKILL stops it,
// and it records its pid in $HANG_PID_DIR so the test can check that it was stopped.
function hangingCsv(strict: string): string {
  return [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    strict.replace("export function parseCsv(", "function strictParseCsv("),
    "export function parseCsv(text: string): CsvRow[] {",
    "  if (/\\r(?!\\n)/.test(text)) {",
    '    process.on("SIGTERM", () => {});',
    "    const dir = process.env.HANG_PID_DIR;",
    "    if (dir) {",
    "      mkdirSync(dir, { recursive: true });",
    '      writeFileSync(join(dir, String(process.pid)), "");',
    "    }",
    "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "  }",
    "  return strictParseCsv(text);",
    "}",
    "",
  ].join("\n");
}

test("a hung robustness suite is stopped at its budget and leaves the gate row intact", { timeout: 180_000 }, async () => {
  const repoDir = join(dir, "orch-eval-hang-1");
  cpSync(join(KIT_DIR, "reference"), repoDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.DS_Store)$/.test(src) });
  const csvPath = join(repoDir, "src", "csv.ts");
  writeFileSync(csvPath, hangingCsv(readFileSync(csvPath, "utf8")));
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Hangs on a lone CR"]);
  const pidDir = join(dir, "hang-pids");
  const results = join(dir, "hang-results.csv");
  const started = Date.now();
  const completion = score(
    ["--repo-dir", repoDir, "--no-github", "--results", results, "--start", "2026-01-01T10:00:00Z", "--end", "2026-01-01T10:20:00Z"],
    { ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS: "3000", HANG_PID_DIR: pidDir },
  );
  while (!existsSync(pidDir) && Date.now() - started < 60_000) await new Promise((done) => setTimeout(done, 50));
  const savedBeforeRobustnessEnded = existsSync(results) ? readResults(results)[0] : null;
  const result = await completion;
  const elapsed = Date.now() - started;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(savedBeforeRobustnessEnded?.outcome, "passed", "persist the gate before diagnostics can hit the outer score deadline");
  assert.equal(savedBeforeRobustnessEnded?.robustness_status, "error");
  assert.match(savedBeforeRobustnessEnded!.note, /robustness has not completed/);
  // Without the budget, each hung request would wait out the harness's 30 s request limit.
  assert.ok(elapsed < 90_000, `score took ${elapsed} ms`);

  const [row] = readResults(results);
  assert.equal(row.outcome, "passed");
  assert.equal(row.minutes, "20.0");
  assert.equal(row.wall_minutes, "20.0");
  assert.equal(row.suite_passed, "65");
  assert.equal(row.suite_total, "65");
  assert.equal(row.robustness_status, "error");
  assert.equal(row.robustness_passed, "");
  assert.equal(row.robustness_total, "");
  assert.equal(row.robustness_sha256, robustnessSha256(robustnessFiles(ALL_FEATURES), { timeoutMs: 3000 }));
  assert.notEqual(row.robustness_sha256, robustnessSha256(robustnessFiles(ALL_FEATURES)));
  assert.match(row.note, /robustness error: stopped after its 3 s budget/);

  const pids = readdirSync(pidDir).map(Number);
  assert.ok(pids.length > 0, "the app never hung");
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `app ${pid} is still running`);
});

test("score rejects a bad robustness budget before scoring", async () => {
  for (const budget of ["soon", "0", "120001"]) {
    const result = await score(
      ["--repo-dir", dir, "--variant", "invalid", "--n", "1", "--no-github", "--results", join(dir, "budget.csv")],
      { ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS: budget },
    );
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS/);
    assert.doesNotMatch(result.stdout, /acceptance suite/);
  }
});
