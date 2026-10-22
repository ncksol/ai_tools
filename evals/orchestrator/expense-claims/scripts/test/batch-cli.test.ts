import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { run } from "../lib/proc.ts";
import { RESULT_COLUMNS } from "../lib/results.ts";
import { KIT_DIR } from "../lib/suite.ts";
import { loadState } from "../lib/batch/state.ts";

let dir: string;
let common: string[];
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-cli-"));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", "variant-a.agent.md"), "a");
  writeFileSync(join(checkout, "results.csv"), RESULT_COLUMNS.join(",") + "\n");
  for (const args of [["init", "-q", "-b", "driver"], ["config", "user.name", "T"], ["config", "user.email", "t@example.invalid"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) {
    await run("git", args, { cwd: checkout });
  }
  common = ["--batches-dir", join(dir, "batches"), "--runs-dir", join(dir, "runs"), "--state-dir", join(dir, "state"), "--agents-dir", join(dir, "agents"), "--results", join(checkout, "results.csv"), "--ntfy-url-file", join(dir, "none")];
});
after(() => rmSync(dir, { recursive: true, force: true }));

function batch(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return run(process.execPath, ["scripts/batch.ts", ...args], { cwd: KIT_DIR, env });
}

test("init refuses a self-test agent that is an orchestrator", async () => {
  for (const agent of ["session-orchestrator", "wintermute:session-orchestrator", "wintermute:hands-on-orchestrator"]) {
    const result = await batch(["init", "--dry-run", "--memory-off", "--variants", "variant-a", "--self-test-agent", agent, ...common]);
    assert.equal(result.code, 2);
    assert.ok(result.stderr.includes(`must not use the agent "${agent}"`), result.stderr);
  }
});

test("init selects all pinned aliases and refuses ambiguous selection or a variant self-test", async () => {
  const variants = Object.fromEntries(["a", "b", "c"].map((label) => {
    const agent = `orchestrator-review-${label}`;
    const text = `---\nname: ${agent}\nuser-invocable: false\n---\nPolicy ${label}.\n`;
    writeFileSync(join(dir, "agents", `${agent}.agent.md`), text);
    return [agent, { agent, revision: "a".repeat(40), file: `agents/${agent}.agent.md`,
      sha256: createHash("sha256").update(text).digest("hex") }];
  }));
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ id: "review-policy", calibration: "all-variants-then-drop-summary", variants, workers: {} }));
  const args = ["init", "--dry-run", "--memory-off", "--variants-file", manifest, "--id", "pinned", ...common];
  const result = await batch(args);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const config = JSON.parse(readFileSync(join(dir, "batches", "pinned", "config.json"), "utf8"));
  assert.deepEqual(config.variants, ["orchestrator-review-a", "orchestrator-review-b", "orchestrator-review-c"]);
  assert.equal(config.variantSet.variants["orchestrator-review-a"].agent, "orchestrator-review-a");
  assert.match(result.stdout, /PASS variant snapshot hashes/);
  for (const extra of [["--variants", "variant-a"], ["--self-test-only"]]) {
    const rejected = await batch([...args, ...extra]);
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, /cannot be combined/);
  }
  const selftest = await batch([...args.map((arg) => arg === "pinned" ? "pinned-selftest" : arg), "--self-test-agent", "orchestrator-review-a"]);
  assert.equal(selftest.code, 2);
  assert.match(selftest.stderr, /must not use the agent "orchestrator-review-a"/);
});

test("init without the Memory confirmation fails the preflight and creates nothing", async () => {
  const result = await batch(["init", "--dry-run", "--variants", "variant-a", "--id", "no-memory", ...common]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL Copilot Memory is off/);
  assert.match(result.stdout, /Turn Copilot Memory off at https:\/\/github\.com\/settings\/copilot\/features/);
  assert.match(result.stdout, /no batch was created/);
});

test("init runs the four orchestrators in parallel by default and refuses more runs at once than variants", async () => {
  const four = ["orchestrator", "session-orchestrator", "hands-on-orchestrator", "hands-on-session-orchestrator"];
  for (const agent of four) writeFileSync(join(dir, "agents", `${agent}.agent.md`), `${agent}\n`);
  const init = await batch(["init", "--dry-run", "--memory-off", "--id", "four", ...common]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const config = JSON.parse(readFileSync(join(dir, "batches", "four", "config.json"), "utf8"));
  assert.deepEqual(config.variants, four);
  assert.equal(config.parallel, 4);
  assert.match(init.stdout, /up to 4 runs at a time/);
  for (const [parallel, error] of [["2", /--parallel can't be more than the number of variants/], ["two", /--parallel must be a positive integer/]] as const) {
    const rejected = await batch(["init", "--dry-run", "--memory-off", "--variants", "variant-a", "--parallel", parallel, "--id", "over", ...common]);
    assert.equal(rejected.code, 2);
    assert.match(rejected.stderr, error);
  }
});

test("prefixed live selection keeps historical labels and rejects duplicate spellings", async () => {
  writeFileSync(join(dir, "agents", "orchestrator.agent.md"), "live\n");
  const init = await batch(["init", "--dry-run", "--memory-off", "--variants", "wintermute:orchestrator", "--id", "prefixed", ...common]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const config = JSON.parse(readFileSync(join(dir, "batches", "prefixed", "config.json"), "utf8"));
  const state = loadState(join(dir, "batches", "prefixed"));
  assert.deepEqual(config.variants, ["orchestrator"]);
  assert.ok(state.pins.agents["wintermute:orchestrator"]);
  const duplicate = await batch(["init", "--dry-run", "--memory-off", "--variants", "orchestrator,wintermute:orchestrator", "--id", "duplicate", ...common]);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /listed twice/);
});

test("live defaults read installed plugin files while manifest defaults read user-registered aliases", async () => {
  const home = join(dir, "home");
  const plugin = join(home, ".copilot", "installed-plugins", "ai-tools", "wintermute", "com.github.copilot", "agents");
  const aliases = join(home, ".copilot", "agents");
  mkdirSync(plugin, { recursive: true });
  mkdirSync(aliases);
  writeFileSync(join(plugin, "orchestrator.agent.md"), 'Use wintermute:orchestrator-worker.\n');
  writeFileSync(join(plugin, "orchestrator-worker.agent.md"), "worker\n");
  const noAgentsOverride = common.filter((arg, i) => arg !== "--agents-dir" && common[i - 1] !== "--agents-dir");
  const live = await batch(["init", "--dry-run", "--memory-off", "--variants", "orchestrator", "--id", "default-live", ...noAgentsOverride], { HOME: home });
  assert.equal(live.code, 0, live.stdout + live.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "batches", "default-live", "config.json"), "utf8")).agentsDir, plugin);
  const manifest = join(KIT_DIR, "variants", "review-policy.json");
  for (const agent of ["orchestrator-review-a", "orchestrator-review-b", "orchestrator-review-c", "orchestrator-worker"]) {
    cpSync(join(KIT_DIR, "variants", `${agent}.agent.md`), join(aliases, `${agent}.agent.md`));
  }
  const pinned = await batch(["init", "--dry-run", "--memory-off", "--variants-file", manifest, "--id", "default-pinned", ...noAgentsOverride], { HOME: home });
  assert.equal(pinned.code, 0, pinned.stdout + pinned.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "batches", "default-pinned", "config.json"), "utf8")).agentsDir, aliases);
  assert.match(pinned.stdout, /PASS variant snapshot hashes/);
});

test("init, next, record and status work from the command line", async () => {
  const init = await batch(["init", "--dry-run", "--memory-off", "--variants", "variant-a", "--runs", "1", "--id", "cli", ...common]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /DRY RUN: for tests only/);
  const config = JSON.parse(readFileSync(join(dir, "batches", "cli", "config.json"), "utf8"));
  assert.equal(config.parallel, 1);
  assert.equal(config.timeoutMin, 90);
  assert.equal(config.stallMin, 15);
  assert.equal(config.keepAwake, false, "a dry run never holds caffeinate");

  const next = await batch(["next", "--batch", "cli", "--max-wait", "0", ...common]);
  assert.equal(next.code, 0, next.stderr);
  const action = JSON.parse(next.stdout);
  assert.equal(action.action, "create_project");
  assert.equal(action.dryRun, true);
  assert.equal(action.tool.args.path, join(dir, "runs", "eval-runner-selftest"));

  const recorded = await batch(["record", "--batch", join(dir, "batches", "cli"), "--action", action.id, "--project-id", "p-1"]);
  assert.equal(recorded.stdout.trim(), "project p-1 recorded");
  const project = JSON.parse((await batch(["next", "--batch", "latest", "--max-wait", "0", ...common])).stdout);
  assert.equal(project.action, "create_project", "all run projects are provisioned before the self-test starts");
  assert.match(project.tool.args.path, /orch-eval-variant-a-\d+$/);

  const status = await batch(["status", "--batch", "cli", ...common]);
  assert.match(status.stdout, /Batch cli: phase provisioning/);
  assert.match(status.stdout, /Pending action: a2 create_project/);
  const stop = await batch(["stop", "--batch", "cli", ...common]);
  assert.match(stop.stdout, /stops after the runs in progress finish/);
  const released = await batch(["take-over", "--batch", "cli", ...common]);
  assert.match(released.stdout, /^Released batch cli from driver \S+; the next driver to run next owns it\.$/m);
  assert.ok(existsSync(join(dir, "batches", "active-batch")), "a dry run keeps its guard beside its batches");
});
