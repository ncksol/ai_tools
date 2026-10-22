import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { openAppDb } from "../lib/batch/appdb.ts";
import { FULL_SET } from "../lib/batch/plan.ts";
import { currentPins, makeCtx, next, requestStop } from "../lib/batch/runner.ts";
import { initialState, saveState } from "../lib/batch/state.ts";
import { run as runProc } from "../lib/proc.ts";
import { RESULT_COLUMNS } from "../lib/results.ts";
import { harness, type Harness } from "./fixtures/batch.ts";

const made: Harness[] = [];
async function make(opts: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(opts);
  made.push(h);
  return h;
}
after(() => { for (const h of made) rmSync(h.dir, { recursive: true, force: true }); });

async function provision(h: Harness) {
  return h.until((action) => !["create_project", "create_trust_session"].includes(action.action), 100);
}

test("idle trust sessions are nested with no kickoff and archived before the first run starts", async () => {
  const h = await make({ scenarios: ["silent"] });
  const create = await h.until((a) => a.action !== "create_project");
  assert.equal(create.action, "create_trust_session");
  assert.deepEqual(create.tool!.args, {
    project_id: h.state().provisioned![0].projectId,
    name: "Trust orch-eval-variant-a-1",
    workspace_type: "branch",
    coordinate_with_creator: true,
  });
  await h.drive(create);
  const trust = await provision(h);
  assert.equal(trust.action, "trust_projects");
  assert.ok((trust.details!.projects as { sessionId: string }[]).every((p) => p.sessionId));
  await h.drive(trust);
  const archives: string[] = [];
  const start = await h.until((a) => {
    if (a.action === "archive_trust_session") archives.push(String(a.tool!.args.id));
    return a.action === "create_session";
  });
  assert.equal(start.action, "create_session");
  assert.equal(archives.length, 2);
  assert.ok(h.state().trustSessions!.every((s) => s.archived));
  assert.equal(h.app.sessions.size, 0);
});

test("all potential runs and the permanent self-test are provisioned before any session starts", async () => {
  const h = await make({ scenarios: [], variants: ["a", "b"], runsPerVariant: 3, selfTest: true });
  const action = await provision(h);
  assert.equal(action.action, "trust_projects");
  assert.equal(h.app.projects.size, 9, "two calibrations, six scored runs, one permanent self-test");
  assert.equal(h.app.sessions.size, 0);
  assert.equal(h.state().runs.length, 0);
  assert.equal(h.state().selftests[0].repoDir, join(h.config.runsDir, "eval-runner-selftest"));
  assert.equal((action.details?.projects as unknown[]).length, 9);
  assert.ok(h.notices.some((n) => n.title === "Eval projects need trust" && n.body.includes("eval-runner-selftest")));
});

test("trust polling reads only local accepted rows, survives restart, and never writes the database", async () => {
  const h = await make({ scenarios: ["silent"] });
  const path = join(h.dir, "trust.db");
  const fixture = new DatabaseSync(path);
  fixture.exec("CREATE TABLE project_host_trust (project_id TEXT, host_id TEXT, trusted_config_sha256 TEXT, trusted_config_accepted_at TEXT, PRIMARY KEY(project_id,host_id))");
  const reader = openAppDb(path);
  h.app.projectTrusted = (id) => reader.projectTrusted(id) === true;
  h.app.takeErrors = reader.takeErrors;
  const action = await provision(h);
  assert.equal(action.action, "trust_projects");
  await h.record({ action: action.id!, listed: true });
  const ids = [...h.app.projects.keys()];
  const insert = fixture.prepare("INSERT OR REPLACE INTO project_host_trust VALUES (?, ?, ?, ?)");
  for (const id of ids) insert.run(id, "remote", "hash", "accepted");
  assert.equal((await h.next(0)).action, "wait", "remote trust is not local trust");
  insert.run(ids[0], "local", "hash", "accepted");
  assert.equal((await h.next(0)).action, "wait", "every project is required");
  for (const id of ids) insert.run(id, "local", "hash", "accepted");
  fixture.close();
  const before = createHash("sha256").update(readFileSync(path)).digest("hex");
  const restarted = makeCtx(h.config, h.ctx.deps);
  let start = await next(restarted, { maxWaitMs: 0 });
  while (start.action === "archive_trust_session") {
    await h.drive(start);
    start = await next(restarted, { maxWaitMs: 0 });
  }
  assert.equal(start.action, "create_session");
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), before);
  assert.equal(h.app.sessions.size, 0, "the runner only offers the action");
});

test("trust wait times out before starting a session and reports unused projects", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  const action = await provision(h);
  assert.equal(action.action, "trust_projects");
  await h.record({ action: action.id!, listed: true });
  h.clock.now += 30 * 60_000;
  const done = await h.next(0);
  assert.equal(done.action, "done");
  assert.equal(h.state().phase, "stopped");
  assert.match(h.state().stopReason!, /trust.*30 minutes/i);
  assert.equal(h.app.sessions.size, 0);
  const report = readFileSync(h.state().reportPath!, "utf8");
  assert.match(report, /Unused provisioned projects/);
  for (const id of h.app.projects.keys()) assert.ok(report.includes(id));
});

test("a stop during provisioning creates no additional project and starts no session", async () => {
  const h = await make({ scenarios: [], variants: ["a", "b"] });
  const action = await h.next();
  assert.equal(action.action, "create_project");
  await h.drive(action);
  await requestStop(h.ctx);
  assert.equal((await h.next()).action, "done");
  assert.equal(h.app.projects.size, 1);
  assert.equal(h.app.sessions.size, 0);
});

test("void attempts exhaust finite trusted capacity instead of provisioning during runs", async () => {
  const h = await make({ scenarios: [], runsPerVariant: 1 });
  let action = await h.until((a) => a.action === "create_session");
  const count = h.app.projects.size;
  for (let i = 0; i < 2; i++) {
    if (i > 0) action = await h.next();
    assert.equal(action.action, "create_session");
    await h.record({ action: action.id!, failed: "failed to start" });
    // Isolate the capacity limit from the existing two-consecutive-start-failures safety net.
    saveState(h.config.dir, { ...h.state(), startFailures: 0 });
  }
  assert.equal((await h.next()).action, "done");
  assert.match(h.state().stopReason!, /out of trusted projects/);
  assert.equal(h.app.projects.size, count);
});

test("calibration fixes the spec and kickoff at run start, not at provisioning", async () => {
  const h = await make({ scenarios: ["ask-final", "silent"], minutes: () => 45 });
  const trust = await provision(h);
  assert.equal(trust.action, "trust_projects");
  const slots = h.state().provisioned!;
  assert.equal(slots.length, 2);
  assert.match(readFileSync(join(slots[1].repoDir, "docs/spec-v2.md"), "utf8"), /## Feature: Summary/);
  await h.drive(trust);
  const start = await h.until((a, s) => a.action === "create_session" && s.runs.length === 2);
  const run = h.state().runs[1];
  assert.deepEqual(run.features, ["policy", "reports", "import"]);
  assert.doesNotMatch(readFileSync(join(run.repoDir, "docs/spec-v2.md"), "utf8"), /## Feature: Summary/);
  assert.equal((start.tool!.args.kickoff as { prompt: string }).prompt, readFileSync(join(h.config.kitDir, "kickoff.md"), "utf8").trimEnd());
  const status = await runProc("git", ["status", "--porcelain"], { cwd: run.repoDir });
  assert.equal(status.stdout, "");
  const history = await runProc("git", ["log", "--format=%s"], { cwd: run.repoDir });
  assert.equal(history.stdout.trim(), "Seed v1", "no preparation commit is visible to the orchestrator");
  const parent = await runProc("git", ["rev-list", "--count", "HEAD"], { cwd: run.repoDir });
  assert.equal(parent.stdout.trim(), "1");
  const original = await runProc(process.execPath, [h.config.newRunScript, "--variant", "comparison", "--n", "1", "--features", "policy,reports,import", "--runs-dir", join(h.dir, "comparison"), "--dry-run"]);
  assert.equal(original.code, 0, original.stderr);
  const expectedTree = await runProc("git", ["rev-parse", "HEAD^{tree}"], { cwd: join(h.dir, "comparison/orch-eval-comparison-1") });
  const actualTree = await runProc("git", ["rev-parse", "HEAD^{tree}"], { cwd: run.repoDir });
  assert.equal(actualTree.stdout, expectedTree.stdout, "the entire tracked tree equals the old new-run flow");
});

async function remoteSeed() {
  const prior: Record<string, string> = {
    variant: "variant-a", run: "1", repo: "previous-run", features: FULL_SET, calibration: "yes", outcome: "passed", minutes: "45",
  };
  const results = `${RESULT_COLUMNS.join(",")}\n${RESULT_COLUMNS.map((column) => prior[column] ?? "").join(",")}\n`;
  const h = await make({ scenarios: [], results });
  const trust = await provision(h);
  assert.equal(trust.action, "trust_projects");
  const slot = h.state().provisioned![0];
  const remote = join(h.dir, "seed.git");
  const git = async (args: string[], cwd = slot.repoDir) => {
    const result = await runProc("git", cwd === remote ? ["--git-dir", remote, ...args] : args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git(["init", "-q", "--bare", "-b", "main", remote]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "-q", "origin", "main"]);
  const author = await git(["log", "-1", "--format=%an <%ae>%n%aI"]);
  await h.drive(trust);
  // Only the already-provisioned seed's local bare remote is used beyond this point.
  h.config.dryRun = false;
  return { h, slot, remote, git, author };
}

test("launch preparation replaces only the unused remote seed and preserves its author and single commit", async () => {
  const { h, slot, remote, git, author } = await remoteSeed();
  assert.equal((await h.until((a) => a.action === "create_session")).action, "create_session");
  assert.notEqual(await git(["rev-parse", "HEAD"]), slot.seedSha);
  assert.equal(await git(["rev-parse", "HEAD"], remote), await git(["rev-parse", "HEAD"]));
  assert.equal(await git(["rev-list", "--count", "HEAD"], remote), "1");
  assert.equal(await git(["log", "--format=%s"], remote), "Seed v1");
  assert.equal(await git(["log", "-1", "--format=%an <%ae>%n%aI"], remote), author);
  assert.equal(h.app.sessions.size, 0);
});

test("a restart after the seed push resumes without another rewrite or push", async () => {
  const { h, git } = await remoteSeed();
  await h.drive(await h.until((a) => a.action === "archive_trust_session"));
  const exec = h.ctx.deps.exec;
  let pushes = 0;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    const result = await exec(cmd, args, opts);
    if (cmd === "git" && args[0] === "push" && args.some((arg) => arg.startsWith("--force-with-lease="))) {
      pushes++;
      assert.equal(result.code, 0, result.stderr);
      throw new Error("simulated interruption after seed push");
    }
    return result;
  };
  await assert.rejects(h.next(), /simulated interruption/);
  const pushed = await git(["rev-parse", "HEAD"]);
  assert.equal((await h.next()).action, "create_session");
  assert.equal(pushes, 1);
  assert.equal(await git(["rev-parse", "HEAD"]), pushed);
});

test("the exact seed lease rejects a concurrent remote main change without overwriting it", async () => {
  const { h, slot, remote, git } = await remoteSeed();
  const other = join(h.dir, "other-clone");
  await git(["clone", "-q", remote, other]);
  await git(["-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "-q", "--allow-empty", "-m", "Other work"], other);
  const external = await git(["rev-parse", "HEAD"], other);
  const exec = h.ctx.deps.exec;
  let raced = false;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    if (cmd === "git" && args[0] === "push" && args.includes(`--force-with-lease=refs/heads/main:${slot.seedSha}`)) {
      raced = true;
      await git(["push", "-q", "origin", "main"], other);
    }
    return exec(cmd, args, opts);
  };
  const done = await h.until((a) => a.action === "create_session");
  assert.equal(done.action, "done");
  assert.equal(raced, true);
  assert.match(h.state().stopReason!, /pushing run features failed/);
  assert.equal(await git(["rev-parse", "HEAD"], remote), external);
  assert.equal(h.app.sessions.size, 0);
});

test("a later batch reuses the self-test repository without replacing its commit or project", async () => {
  const h = await make({ scenarios: ["selftest"], selfTest: true });
  h.config.selfTest.only = true;
  const trust = await provision(h);
  assert.equal(trust.action, "trust_projects");
  const testRepo = h.state().selftests[0].repoDir;
  const before = await runProc("git", ["rev-parse", "HEAD"], { cwd: testRepo });
  const id = h.state().selftests[0].projectId;
  await h.drive(trust);
  await h.until(() => false);
  saveState(h.config.dir, { ...initialState(currentPins(h.config), true, new Date(h.clock.now).toISOString()), revision: h.state().revision });
  const actions: string[] = [];
  const start = await h.until((a) => { actions.push(a.action); return a.action === "create_session"; });
  assert.ok(!actions.includes("create_project"), "look up the existing path instead of calling create_project again");
  assert.equal(start.action, "create_session");
  assert.equal(h.state().selftests[0].projectId, id);
  assert.equal(h.app.projects.size, 1);
  assert.equal((await runProc("git", ["rev-parse", "HEAD"], { cwd: testRepo })).stdout, before.stdout);
});

test("a lost create_project result is adopted by clone path instead of creating a duplicate", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  const first = await h.next();
  assert.equal(first.action, "create_project");
  const id = h.app.createProject(String(first.tool!.args.path));
  const following = await h.next();
  assert.notEqual(following.id, first.id);
  assert.equal(h.state().selftests[0].projectId, id);
  assert.equal(h.app.projects.size, 1);
});

test("recorded trust sessions are excluded from permission, activity and memory scans even with fresh logs", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const start = await h.until((a) => a.action === "create_session");
  const trust = h.state().trustSessions![0];
  const directory = join(h.config.stateDir, trust.sessionId!);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "workspace.yaml"), `id: ${trust.sessionId}\nrepository: ${h.state().runs[0].repo}\ncreated_at: ${new Date(h.clock.now).toISOString()}\n`);
  const events = [
    { type: "session.start", data: {} },
    { type: "user.message", data: { content: "trust view" } },
    { type: "system.message", data: { content: "<memories>\n## User memories for @test\nold memory\n</memories>" } },
    { type: "assistant.turn_start", data: {} },
    { type: "permission.requested", data: { requestId: "trust-prompt", permissionMode: "manual", permissionRequest: { kind: "shell", fullCommandText: "echo trust" } } },
  ].map((event) => ({ ...event, timestamp: new Date(h.clock.now).toISOString() }));
  writeFileSync(join(directory, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  await h.drive(start);
  await h.until(() => false);
  assert.equal(h.state().phase, "done", h.state().stopReason);
  assert.deepEqual(h.state().runs[0].flags, []);
  assert.equal(h.scoreCalls.length, 1);
});

test("a trust-session creation result is reconciled without creating a second idle session", async () => {
  const h = await make({ scenarios: [] });
  const create = await h.until((a) => a.action === "create_trust_session");
  const id = h.app.createTrustSession(create.tool!.args);
  const action = await h.next(0);
  assert.notEqual(action.id, create.id);
  assert.equal(h.state().trustSessions![0].appSessionId, id);
  assert.equal(h.app.trustSessions.size, 1);
});

test("an archive failure stops before any self-test or eval session starts", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  const archive = await h.until((a) => a.action === "archive_trust_session");
  await h.record({ action: archive.id!, failed: "archive unavailable" });
  assert.equal((await h.next()).action, "done");
  assert.equal(h.state().phase, "stopped");
  assert.equal(h.app.sessions.size, 0);
  assert.match(readFileSync(h.state().reportPath!, "utf8"), /Idle trust session Trust/);
});

test("revoked trust prevents a run create_session from being reissued", async () => {
  const h = await make({ scenarios: [] });
  await h.until((a) => a.action === "create_session");
  h.app.trustedProjects.clear();
  h.clock.now += 6 * 60_000;
  assert.equal((await h.next()).action, "done");
  assert.match(h.state().stopReason!, /not trusted on local/);
  assert.equal(h.app.sessions.size, 0);
});

test("revoked trust prevents a self-test create_session from being reissued", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  const start = await h.until((a) => a.action === "create_session");
  assert.equal(start.target, "self-test");
  h.app.trustedProjects.clear();
  h.clock.now += 6 * 60_000;
  assert.equal((await h.next()).action, "done");
  assert.match(h.state().stopReason!, /not trusted on local/);
  assert.equal(h.state().selftests[0].status, "failed");
  assert.equal(h.app.sessions.size, 0);
});
