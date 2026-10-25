import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { noAppDb } from "../lib/batch/appdb.ts";
import { claimActive } from "../lib/batch/lock.ts";
import { compareVersions, runPreflight, scoreSupportsRunner, type Host } from "../lib/batch/preflight.ts";
import { initialState, saveConfig, saveState, type BatchConfig, type RunState } from "../lib/batch/state.ts";
import type { ProcResult } from "../lib/proc.ts";
import { appendResult, RESULT_COLUMNS, type ResultRow } from "../lib/results.ts";
import { KIT_DIR } from "../lib/suite.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-preflight-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", "orchestrator.agent.md"), "Starts wintermute:orchestrator-worker sub-agents.");
  writeFileSync(join(dir, "agents", "session-orchestrator.agent.md"), "Children run as wintermute:session-worker.");
  for (const name of ["orchestrator-worker", "session-worker"]) writeFileSync(join(dir, "agents", `${name}.agent.md`), name);
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.1.31</string>");
  writeFileSync(join(dir, "old.plist"), "<key>CFBundleShortVersionString</key><string>1.1.30</string>");
  writeFileSync(join(dir, "cli.d.ts"), 'COPILOT_CLI_VERSION = "1.0.99-2"');
  writeFileSync(join(dir, "old-score.ts"), 'options: { "outcome": {} }');
  writeFileSync(join(dir, "ntfy-url"), "https://ntfy.example/topic\n");
  writeFileSync(join(dir, "data.db"), "");
});
after(() => rmSync(dir, { recursive: true, force: true }));

function config(overrides: Partial<BatchConfig> = {}): BatchConfig {
  return {
    id: "t",
    createdAt: "",
    dir: join(dir, "batch"),
    variants: ["orchestrator", "session-orchestrator"],
    runsPerVariant: 3,
    model: "claude-opus-5.5",
    effort: "max",
    contextTier: "long_context",
    owner: "ncksol",
    runsDir: join(dir, "runs"),
    stateDir: join(dir, "state"),
    agentsDir: join(dir, "agents"),
    appDb: join(dir, "data.db"),
    appPlist: join(dir, "Info.plist"),
    cliVersionFile: join(dir, "cli.d.ts"),
    resultsPath: join(dir, "results.csv"),
    kitDir: KIT_DIR,
    scoreScript: join(KIT_DIR, "scripts", "score.ts"),
    newRunScript: "",
    timeoutMin: 90,
    stallMin: 15,
    idleSettleSec: 20,
    swarmSettleSec: 60,
    quietWaitMin: 5,
    drainMaxMin: 20,
    sessionAppearMin: 10,
    pollSec: 10,
    minFreeGiB: 20,
    selfTest: { enabled: true, only: false, model: "claude-sonnet-5.5", effort: "low", agent: null },
    notify: { urlFile: join(dir, "ntfy-url"), envVar: "ORCH_EVAL_TEST_NO_ENV" },
    activeGuard: join(dir, "active-batch"),
    keepAwake: true,
    push: true,
    dryRun: false,
    memoryOffConfirmed: true,
    ...overrides,
  };
}

const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: "" });
const healthy: Record<string, ProcResult> = {
  "pmset -g batt": ok("Now drawing from 'AC Power'\n -InternalBattery-0 100%; charged"),
  "df -k": ok("Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 970000000 800000000 141557760 85% /System/Volumes/Data"),
  "gh api user --jq .login": ok("ncksol\n"),
  "gh api -i user": ok("HTTP/2.0 200 OK\nX-Oauth-Scopes: gist, read:org, repo, workflow\n\n{}"),
  "gh api rate_limit": ok("14761\t10000\n"),
  "git rev-parse --abbrev-ref HEAD": ok("ncksol-overnight\n"),
  "git status --porcelain": ok(""),
  "git config user.name": ok("Nick\n"),
  "git config user.email": ok("nick@example.invalid\n"),
  "sh -c command -v flock": ok("/usr/bin/flock\n"),
};

function host(overrides: Record<string, ProcResult> = {}, probe: string[] = [], account: string | null = "ncksol"): Host {
  const table = { ...healthy, ...overrides };
  return {
    nodeVersion: "v24.19.0",
    appDb: { ...noAppDb, probe: () => [...probe], takeErrors: () => [], defaultAccount: () => account },
    exec: async (cmd, args) => {
      const key = Object.keys(table).find((k) => `${cmd} ${args.join(" ")}`.startsWith(k));
      return key ? table[key] : { code: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
    },
  };
}

const failing = (checks: { name: string; status: string }[]) => checks.filter((c) => c.status === "FAIL").map((c) => c.name);

function historyConfig(): BatchConfig {
  const root = mkdtempSync(join(dir, "history-"));
  return config({ dir: join(root, "batches", "next"), resultsPath: join(root, "results.csv") });
}

function historyRun(n: number, calibration = false): RunState {
  const repo = `ncksol/orch-eval-orchestrator-${n}`;
  const row = Object.fromEntries(RESULT_COLUMNS.map((column) => [column, ""])) as ResultRow;
  Object.assign(row, { repo, run: String(n), variant: "orchestrator", calibration: calibration ? "yes" : "no", minutes: "50" });
  return {
    key: `orchestrator-${n}`, variant: "orchestrator", n, features: ["policy", "reports", "import"],
    calibration, name: `orch-eval-orchestrator-${n}`, repo, repoDir: join(dir, `run-${n}`),
    status: "done", createdAt: "", judged: [], answers: [], askAttempts: {}, requestIds: {}, flags: [], row,
  };
}

function saveHistory(current: BatchConfig, id: string, runs: RunState[], overrides: Partial<BatchConfig> = {}): string {
  const previous = { ...current, id, dir: join(current.dir, "..", id), ...overrides };
  saveConfig(previous);
  const state = initialState({ agents: {}, files: {}, appVersion: null, cliVersion: null }, true, "");
  state.phase = "done";
  state.runs = runs;
  saveState(previous.dir, state);
  writeFileSync(join(previous.dir, "report.md"), `results.csv rows are committed on branch \`driver-${id}\` of the ai_tools checkout.\n`);
  return previous.dir;
}

test("preflight stops on missing calibration and scored rows until both run identities are landed", async () => {
  const current = historyConfig();
  const calibration = historyRun(1, true);
  const scored = historyRun(2);
  saveHistory(current, "earlier", [calibration, scored]);
  appendResult(current.resultsPath, { ...calibration.row, repo: "someone/other-repo" } as ResultRow);
  const missing = (await runPreflight(current, host())).find((c) => c.name === "earlier batch results landed");
  assert.equal(missing?.status, "FAIL");
  assert.match(missing.detail, /earlier.*driver-earlier/);
  assert.match(missing.detail, /orch-eval-orchestrator-1/);
  assert.match(missing.detail, /orch-eval-orchestrator-2/);
  assert.match(missing.detail, /[Ll]and.*results.csv/);

  appendResult(current.resultsPath, { ...calibration.row, minutes: "49" } as ResultRow);
  appendResult(current.resultsPath, scored.row as ResultRow);
  const landed = await runPreflight(current, host());
  assert.deepEqual(failing(landed), []);
  assert.equal(landed.find((c) => c.name === "earlier batch results landed")?.status, "PASS");
});

test("history uses the latest saved state rather than a stale state.json copy", async () => {
  const current = historyConfig();
  const previous = saveHistory(current, "revisions", [historyRun(3)]);
  writeFileSync(join(previous, "state.json"), JSON.stringify({ runs: [] }));
  assert.ok(failing(await runPreflight(current, host())).includes("earlier batch results landed"));
});

test("history excludes rehearsals, other batch roots, the current batch and runs without rows", async () => {
  const current = historyConfig();
  saveHistory(current, "rehearsal", [historyRun(4)], { dryRun: true });
  const voidRun = historyRun(5);
  delete voidRun.row;
  voidRun.status = "void";
  saveHistory(current, "unscored", [voidRun]);
  saveHistory(current, "next", [historyRun(6)]);
  saveHistory(historyConfig(), "other-root", [historyRun(7)]);
  assert.deepEqual(failing(await runPreflight(current, host())), []);
});

test("only the latest earlier batch with rows must be landed; empty later batches cannot hide it", async () => {
  const current = historyConfig();
  saveHistory(current, "old-unlanded", [historyRun(11)], { createdAt: "2026-10-21T12:00:00Z" });
  const latest = historyRun(12);
  saveHistory(current, "latest-scored", [latest], { createdAt: "2026-10-22T12:00:00Z" });
  saveHistory(current, "latest-empty", [], { createdAt: "2026-10-23T12:00:00Z" });
  const beforeLanding = (await runPreflight(current, host())).find((c) => c.name === "earlier batch results landed");
  assert.equal(beforeLanding?.status, "FAIL");
  assert.match(beforeLanding.detail, /latest-scored/);
  assert.doesNotMatch(beforeLanding.detail, /old-unlanded/);
  appendResult(current.resultsPath, latest.row as ResultRow);
  assert.deepEqual(failing(await runPreflight(current, host())), []);
});

test("a named history override warns and cannot hide another batch's missing rows", async () => {
  const current = historyConfig();
  current.ignoredResultsBatches = ["abandoned"];
  saveHistory(current, "abandoned", [historyRun(8)]);
  const overridden = (await runPreflight(current, host())).find((c) => c.name === "earlier batch results landed");
  assert.equal(overridden?.status, "WARN");
  assert.match(overridden.detail, /abandoned.*orch-eval-orchestrator-8/);
  saveHistory(current, "unlanded", [historyRun(9)]);
  const blocked = (await runPreflight(current, host())).find((c) => c.name === "earlier batch results landed");
  assert.equal(blocked?.status, "FAIL");
  assert.match(blocked.detail, /unlanded.*orch-eval-orchestrator-9/);
});

test("unreadable batch history fails explicitly instead of looking like landed results", async () => {
  const current = historyConfig();
  const previous = saveHistory(current, "broken", []);
  writeFileSync(join(previous, "config.json"), "{broken");
  const check = (await runPreflight(current, host())).find((c) => c.name === "earlier batch results landed");
  assert.equal(check?.status, "FAIL");
  assert.match(check.detail, /broken/);
});

test("a healthy machine passes every check", async () => {
  const checks = await runPreflight(config(), host());
  assert.deepEqual(failing(checks), [], JSON.stringify(checks, null, 1));
  assert.ok(checks.some((c) => c.name === "agents under test installed" && /orchestrator-worker/.test(c.detail)));
});

test("live preflight resolves installed plugin workers and rejects a missing prefixed dependency", async () => {
  const plugin = join(dir, "plugin-agents");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "orchestrator.agent.md"), 'Use agent_type: "wintermute:orchestrator-worker".\n');
  const missing = await runPreflight(config({ agentsDir: plugin, variants: ["orchestrator"] }), host());
  const failed = missing.find((check) => check.name === "agents under test installed")!;
  assert.equal(failed.status, "FAIL");
  assert.match(failed.detail, /wintermute:orchestrator-worker/);
  writeFileSync(join(plugin, "orchestrator-worker.agent.md"), "worker\n");
  const ready = await runPreflight(config({ agentsDir: plugin, variants: ["orchestrator"] }), host());
  assert.deepEqual(failing(ready), []);
  assert.match(ready.find((check) => check.name === "agents under test installed")!.detail, /wintermute:orchestrator-worker/);
});

test("each problem fails its own check", async () => {
  const checks = await runPreflight(
    config({ memoryOffConfirmed: false, appPlist: join(dir, "old.plist"), scoreScript: join(dir, "old-score.ts"), variants: ["orchestrator", "missing-variant"] }),
    {
      ...host({
        "pmset -g batt": ok("Now drawing from 'Battery Power'"),
        "df -k": ok("Filesystem 1024-blocks Used Available\n/dev/x 100 90 1048576 90% /"),
        "gh api user --jq .login": ok("someone-else\n"),
        "gh api -i user": ok("X-Oauth-Scopes: repo\n"),
        "gh api rate_limit": ok("120\t10000\n"),
        "git rev-parse --abbrev-ref HEAD": ok("main\n"),
        "git status --porcelain": ok(" M results.csv\n"),
      }),
      nodeVersion: "v22.1.0",
    },
  );
  assert.deepEqual(failing(checks).sort(), [
    "AC power",
    "Copilot Memory is off",
    "Copilot app version",
    "GitHub API rate limits",
    "Node 24 or later",
    "agents under test installed",
    "free disk space",
    "gh account",
    "gh token scopes",
    "results branch",
    "results.csv committed",
    "score supports the runner",
  ]);
});

test("the app's default account must be the owner, because new projects run as it", async () => {
  for (const account of ["nicksologoub_microsoft", null]) {
    const check = (await runPreflight(config(), host({}, [], account))).find((c) => c.name === "app default account")!;
    assert.equal(check.status, "FAIL");
    assert.equal(check.detail, `default account ${account ?? "unreadable"}, owner ncksol; make ncksol the default account in the Copilot app`);
  }
  const ok = (await runPreflight(config(), host({}, [], "NCKSOL"))).find((c) => c.name === "app default account")!;
  assert.equal(ok.status, "PASS");
});

test("a dry run skips the checks that touch GitHub, power and the app", async () => {
  const current = historyConfig();
  saveHistory(current, "not-landed", [historyRun(10)]);
  const checks = await runPreflight({ ...current, dryRun: true, keepAwake: false }, host({ "pmset -g batt": ok("Battery Power") }));
  assert.deepEqual(checks.filter((c) => c.status === "SKIP").map((c) => c.name), ["AC power", "gh account", "gh token scopes", "GitHub API rate limits", "Copilot app version", "earlier batch results landed", "app database"]);
  assert.deepEqual(failing(checks), []);
  const selftest = await runPreflight({ ...current, selfTest: { ...current.selfTest, only: true } }, host());
  assert.equal(selftest.find((c) => c.name === "earlier batch results landed")?.status, "SKIP");
  assert.deepEqual(failing(selftest), []);
});

test("another live batch on the machine and a changed app database fail the preflight", async () => {
  const other = join(dir, "other-batch");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "config.json"), JSON.stringify(config({ id: "other", dir: other })));
  writeFileSync(join(other, "state.json"), JSON.stringify({ phase: "runs", runs: [] }));
  await claimActive(join(dir, "active-batch"), "other", other, "2026-10-19T21:00:00Z");
  const checks = await runPreflight(config(), host({}, ["column sessions.was_interrupted is missing"]));
  assert.deepEqual(failing(checks).sort(), ["app database", "no other batch active"]);
  assert.match(checks.find((c) => c.name === "app database")!.detail, /was_interrupted is missing/);
  // A finished batch no longer blocks.
  writeFileSync(join(other, "state.json"), JSON.stringify({ phase: "done", runs: [] }));
  assert.deepEqual(failing(await runPreflight(config(), host())), []);
  rmSync(join(dir, "active-batch"), { recursive: true });
});

test("helpers", () => {
  assert.ok(compareVersions("1.1.30", "1.1.30") === 0);
  assert.ok(compareVersions("1.1.31", "1.1.30") > 0);
  assert.ok(compareVersions("1.2.0", "1.1.30") > 0);
  assert.ok(compareVersions("1.1.4", "1.1.30") < 0);
  assert.equal(scoreSupportsRunner(join(KIT_DIR, "scripts", "score.ts")), true);
  assert.equal(scoreSupportsRunner(join(dir, "old-score.ts")), false);
});
