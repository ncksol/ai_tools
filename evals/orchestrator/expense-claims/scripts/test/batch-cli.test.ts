import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { run } from "../lib/proc.ts";
import { RESULT_COLUMNS } from "../lib/results.ts";
import { KIT_DIR } from "../lib/suite.ts";

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

function batch(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return run(process.execPath, ["scripts/batch.ts", ...args], { cwd: KIT_DIR, env });
}

test("init refuses a self-test agent that is an orchestrator", async () => {
  const result = await batch(["init", "--dry-run", "--memory-off", "--variants", "variant-a", "--self-test-agent", "session-orchestrator", ...common]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /must not use the agent "session-orchestrator"/);
});

test("init without the Memory confirmation fails the preflight and creates nothing", async () => {
  const result = await batch(["init", "--dry-run", "--variants", "variant-a", "--id", "no-memory", ...common]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL Copilot Memory is off/);
  assert.match(result.stdout, /Turn Copilot Memory off at https:\/\/github\.com\/settings\/copilot\/features/);
  assert.match(result.stdout, /no batch was created/);
});

test("init, next, record and status work from the command line", async () => {
  const init = await batch(["init", "--dry-run", "--memory-off", "--variants", "variant-a", "--runs", "1", "--id", "cli", ...common]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  assert.match(init.stdout, /DRY RUN: for tests only/);
  const config = JSON.parse(readFileSync(join(dir, "batches", "cli", "config.json"), "utf8"));
  assert.equal(config.timeoutMin, 90);
  assert.equal(config.stallMin, 15);
  assert.equal(config.keepAwake, false, "a dry run never holds caffeinate");

  const next = await batch(["next", "--batch", "cli", "--max-wait", "0", ...common]);
  assert.equal(next.code, 0, next.stderr);
  const action = JSON.parse(next.stdout);
  assert.equal(action.action, "create_project");
  assert.equal(action.dryRun, true);
  assert.match(action.tool.args.path, /selftest-1\/eval-runner-selftest-/);

  const recorded = await batch(["record", "--batch", join(dir, "batches", "cli"), "--action", action.id, "--project-id", "p-1"]);
  assert.equal(recorded.stdout.trim(), "project p-1 recorded");
  const session = JSON.parse((await batch(["next", "--batch", "latest", "--max-wait", "0", ...common])).stdout);
  assert.equal(session.action, "create_session");
  assert.deepEqual(Object.keys(session.tool.args).sort(), ["coordinate_with_creator", "detached", "kickoff", "project_id", "workspace_type"]);
  assert.equal(session.tool.args.detached, true);
  assert.equal(session.tool.args.coordinate_with_creator, false);
  assert.equal(session.tool.args.kickoff.agent, undefined, "the self-test uses the default agent");
  assert.equal(session.tool.args.kickoff.mode, "interactive");

  const status = await batch(["status", "--batch", "cli", ...common]);
  assert.match(status.stdout, /Batch cli: phase selftest/);
  assert.match(status.stdout, /Pending action: a2 create_session/);
  const stop = await batch(["stop", "--batch", "cli", ...common]);
  assert.match(stop.stdout, /stops after the current run/);
});
