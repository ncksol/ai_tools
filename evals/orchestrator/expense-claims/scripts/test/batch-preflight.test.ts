import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { noAppDb } from "../lib/batch/appdb.ts";
import { claimActive } from "../lib/batch/lock.ts";
import { compareVersions, runPreflight, scoreSupportsRunner, type Host } from "../lib/batch/preflight.ts";
import type { BatchConfig } from "../lib/batch/state.ts";
import type { ProcResult } from "../lib/proc.ts";
import { KIT_DIR } from "../lib/suite.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-preflight-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", "orchestrator.agent.md"), "Starts orchestrator-worker sub-agents.");
  writeFileSync(join(dir, "agents", "session-orchestrator.agent.md"), "Children run as session-worker.");
  for (const name of ["orchestrator-worker", "session-worker"]) writeFileSync(join(dir, "agents", `${name}.agent.md`), name);
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.1.30</string>");
  writeFileSync(join(dir, "old.plist"), "<key>CFBundleShortVersionString</key><string>1.1.29</string>");
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

test("a healthy machine passes every check", async () => {
  const checks = await runPreflight(config(), host());
  assert.deepEqual(failing(checks), [], JSON.stringify(checks, null, 1));
  assert.ok(checks.some((c) => c.name === "agents under test installed" && /orchestrator-worker/.test(c.detail)));
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
  const checks = await runPreflight(config({ dryRun: true, keepAwake: false }), host({ "pmset -g batt": ok("Battery Power") }));
  assert.deepEqual(checks.filter((c) => c.status === "SKIP").map((c) => c.name), ["AC power", "gh account", "gh token scopes", "GitHub API rate limits", "Copilot app version", "app database"]);
  assert.deepEqual(failing(checks), []);
});

test("another live batch on the machine and a changed app database fail the preflight", async () => {
  const other = join(dir, "other-batch");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "config.json"), "{}");
  writeFileSync(join(other, "state.json"), JSON.stringify({ phase: "runs" }));
  await claimActive(join(dir, "active-batch"), "other", other, "2026-10-19T21:00:00Z");
  const checks = await runPreflight(config(), host({}, ["column sessions.was_interrupted is missing"]));
  assert.deepEqual(failing(checks).sort(), ["app database", "no other batch active"]);
  assert.match(checks.find((c) => c.name === "app database")!.detail, /was_interrupted is missing/);
  // A finished batch no longer blocks.
  writeFileSync(join(other, "state.json"), JSON.stringify({ phase: "done" }));
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
