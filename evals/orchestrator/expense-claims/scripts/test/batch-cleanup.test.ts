import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { cleanupBatch, formatCleanup, type CleanupDeps, type CleanupApp } from "../lib/batch/cleanup.ts";
import { initialState, saveConfig, saveState, type BatchConfig, type RunState } from "../lib/batch/state.ts";
import { run } from "../lib/proc.ts";

const seed = "a".repeat(40);
const rootSession = "11111111-1111-4111-8111-111111111111";
const childSession = "22222222-2222-4222-8222-222222222222";

function fixture(t: { after(fn: () => void): void }) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, "orch-evals/batches/20261022-2121");
  const repoDir = join(home, "orch-evals/orch-eval-orchestrator-5");
  const worktree = join(home, "_src_/copilot-worktrees/orch-eval-orchestrator-5/branch");
  for (const path of [dir, repoDir, worktree, join(home, ".copilot/session-state", rootSession), join(home, ".copilot/session-state", childSession)]) mkdirSync(path, { recursive: true });
  writeFileSync(join(repoDir, "keep-until-authorized"), "clone");
  writeFileSync(`${repoDir}.kickoff.md`, "Implement v2.");
  for (const id of [rootSession, childSession]) writeFileSync(join(home, ".copilot/session-state", id, "events.jsonl"), `{"id":"${id}"}\n`);
  const config = {
    id: "20261022-2121", dir, owner: "ncksol", runsDir: join(home, "orch-evals"),
    stateDir: join(home, ".copilot/session-state"), appDb: join(home, ".copilot/data.db"),
    activeGuard: join(home, "orch-evals/active-batch"), dryRun: false,
  } as BatchConfig;
  const record: RunState = {
    key: "orchestrator#5", variant: "orchestrator", n: 5, name: "orch-eval-orchestrator-5",
    repo: "ncksol/orch-eval-orchestrator-5", repoDir, projectId: "project-5", seedSha: seed,
    sessionId: rootSession, appSessionId: "workspace-5", status: "done", createdAt: "2026-10-22T20:00:00Z",
    features: [], calibration: false, judged: [], answers: [], askAttempts: {}, requestIds: {}, flags: [],
  };
  const state = initialState({ agents: {}, files: {}, appVersion: null, cliVersion: null }, false, "2026-10-22T20:00:00Z");
  state.phase = "done";
  state.finishedAt = "2026-10-23T01:00:00Z";
  state.runs = [record];
  state.provisioned = [{ ...record, sessionId: undefined, appSessionId: undefined, status: "project" }];
  const effects: string[] = [];
  const appState = { project: true, session: true };
  const app: CleanupApp = {
    inventory: () => ({
      projects: appState.project ? [{ id: "project-5", path: repoDir, name: record.name }] : [],
      worktrees: appState.project ? [worktree] : [],
      sessions: [rootSession, childSession],
      workspaces: [{ id: "workspace-5", sessionId: rootSession, archived: true }, { id: "never-started", sessionId: null, archived: false }],
    }),
    projectsForPath: () => appState.project ? ["project-5"] : [],
    sessionExists: () => appState.session,
    sessionRunning: () => false,
  };
  let remote = true;
  const deps: CleanupDeps = {
    home, app, now: () => "2026-10-23T10:00:00Z",
    results: async () => null,
    authorize: async () => { effects.push("authorize"); },
    repo: async () => remote ? { id: 50, seedPresent: true } : null,
    deleteRepo: async () => { effects.push("delete-repo"); remote = false; },
    exec: async (_cmd, args, opts) => {
      if (args.includes("remote")) return { code: 0, stdout: `https://github.com/${record.repo}.git\n`, stderr: "" };
      if (args.includes("--show-toplevel")) return { code: 0, stdout: `${opts?.cwd}\n`, stderr: "" };
      if (args.includes("merge-base")) return { code: 0, stdout: "", stderr: "" };
      throw new Error(`Unexpected command ${args.join(" ")}`);
    },
  };
  const save = () => { saveConfig(config); saveState(dir, state); };
  save();
  return { home, dir, config, state, record, worktree, appState, deps, effects, save };
}

test("dry run inventories deduplicated slots, app children and archives without writing anything", async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.dir, "state.json"));
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.equal(report.items.filter(i => i.kind === "repo").length, 1);
  assert.equal(report.items.filter(i => i.kind === "worktree").length, 1);
  assert.equal(report.items.filter(i => i.kind === "session-state").length, 2);
  assert.ok(report.items.some(i => i.kind === "app-session" && i.target === "never-started"));
  assert.ok(report.items.some(i => i.kind === "clone" && i.status === "blocked"));
  assert.deepEqual(f.effects, []);
  assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
  assert.equal(existsSync(join(f.dir, "sessions")), false);
  assert.deepEqual(readFileSync(join(f.dir, "state.json")), before);
  assert.match(formatCleanup(report), /KEEP project/);
  assert.doesNotMatch(formatCleanup(report), /remove or retry/);
  assert.match(formatCleanup(report), /PRESENT app-session never-started/);
});

test("yes archives logs before checklist; persisted discovery survives removal of app project", async (t) => {
  const f = fixture(t);
  let result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "app-project" && i.status === "blocked"));
  assert.doesNotMatch(formatCleanup(result), /PRESENT app-session/, "run sessions are inventory, not separate manual actions");
  assert.equal(gunzipSync(readFileSync(join(f.dir, "sessions", f.record.name, childSession, "events.jsonl.gz"))).toString(), `{"id":"${childSession}"}\n`);
  assert.ok(existsSync(f.worktree));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
  f.appState.project = false;
  f.appState.session = false;
  result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(result.items.filter(i => i.status === "blocked").length, 0, JSON.stringify(result));
  assert.equal(existsSync(f.worktree), false);
  assert.equal(existsSync(f.record.repoDir), false);
  assert.equal(existsSync(`${f.record.repoDir}.kickoff.md`), false);
  assert.ok(f.effects.includes("delete-repo"));
  assert.ok(existsSync(join(f.dir, "state.json")));
  const deleted = f.effects.filter(i => i === "delete-repo").length;
  result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(f.effects.filter(i => i === "delete-repo").length, deleted);
  assert.ok(result.items.some(i => i.kind === "repo" && i.status === "already gone"));
});

const gates: [string, (f: ReturnType<typeof fixture>) => void, RegExp][] = [
  ["unfinished", (f) => { f.state.phase = "runs"; }, /finished/],
  ["unpushed results", (f) => { f.deps.results = async () => "results rows are not on origin"; }, /origin/],
  ["missing seed", (f) => { delete f.record.seedSha; f.state.provisioned = []; }, /identity|seed/i],
  ["owner mismatch", (f) => { f.record.repo = "other/orch-eval-orchestrator-5"; f.state.provisioned = []; }, /owner|identity/i],
  ["name mismatch", (f) => { f.record.name = "unrelated"; f.state.provisioned = []; }, /name|identity/i],
  ["seed mismatch", (f) => { f.deps.repo = async () => ({ id: 50, seedPresent: false }); }, /seed|history/i],
  ["app lookup failure", (f) => { f.deps.app.inventory = () => { throw new Error("missing DB column"); }; }, /DB/],
];
for (const [name, change, reason] of gates) {
  test(`${name} prevents deletion even with force`, async (t) => {
    const f = fixture(t);
    change(f);
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.status === "blocked" && reason.test(i.reason ?? "")), JSON.stringify(result));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

test("missing delete scope stops before archives or any deletion", async (t) => {
  const f = fixture(t);
  f.deps.authorize = async () => { throw new Error("owner token lacks delete_repo"); };
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => /delete_repo/.test(i.reason ?? "")));
  assert.equal(existsSync(join(f.dir, "sessions")), false);
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("symlinked clone or ancestor is never deleted", async (t) => {
  const f = fixture(t);
  const moved = join(f.home, "outside");
  mkdirSync(moved);
  rmSync(f.record.repoDir, { recursive: true });
  symlinkSync(moved, f.record.repoDir);
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "clone" && i.status === "blocked" && /symlink/.test(i.reason ?? "")));
  assert.ok(existsSync(moved));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("force only bypasses project presence, not session existence or origin mismatch", async (t) => {
  const f = fixture(t);
  const exec = f.deps.exec;
  f.deps.exec = async (cmd, args, opts) => args.includes("remote")
    ? { code: 0, stdout: "https://github.com/ncksol/unrelated.git\n", stderr: "" } : exec(cmd, args, opts);
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => /origin/.test(i.reason ?? "")));
  assert.ok(existsSync(join(f.config.stateDir, rootSession)));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("premature project removal reports lost discovery and cleans only still-known items", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => /LOST.*discovery/.test(i.reason ?? "")));
  assert.ok(existsSync(f.worktree));
  assert.equal(existsSync(f.record.repoDir), false);
  assert.ok(f.effects.includes("delete-repo"));
});

test("another project referencing a worktree blocks its removal even with force", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  f.deps.app.projectsForPath = path => path === f.worktree ? ["unrelated-project"] : [];
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "worktree" && i.status === "blocked"));
  assert.ok(existsSync(f.worktree));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("active guard, outside paths and conflicting identities cannot be forced", async (t) => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      mkdirSync(f.config.activeGuard);
      writeFileSync(join(f.config.activeGuard, "000000001.json"), JSON.stringify({ active: { id: "other", dir: "/other" } }));
    },
    (f: ReturnType<typeof fixture>) => { f.record.repoDir = f.home; f.state.provisioned = []; },
    (f: ReturnType<typeof fixture>) => { f.state.provisioned![0].seedSha = "b".repeat(40); },
  ]) {
    const f = fixture(t);
    change(f);
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.status === "blocked"));
    assert.ok(!f.effects.includes("delete-repo"));
  }
});

test("archive write failure prevents all destructive steps", async (t) => {
  const f = fixture(t);
  const io = await import("node:fs");
  f.deps.fs = { ...io, writeFileSync: () => { throw new Error("disk full"); } };
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "archive" && /disk full/.test(i.reason ?? "")));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
  assert.ok(result.items.filter(i => i.kind === "app-project").every(i => !/Remove project|remove or retry/.test(i.reason ?? "")));
});

test("a live session can be backed up before app removal but cannot be deleted with force", async (t) => {
  const f = fixture(t);
  f.deps.app.sessionRunning = () => true;
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => /still running/.test(i.reason ?? "")));
  assert.ok(result.items.some(i => i.kind === "archive" && i.status === "archived"));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("the amended prepared seed is the run identity, not the provisioned predecessor", async (t) => {
  const f = fixture(t);
  f.record.preparedSha = "b".repeat(40);
  let inspected: string | undefined;
  f.deps.repo = async (_repo, seed) => { inspected = seed; return { id: 50, seedPresent: true }; };
  await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.equal(inspected, "b".repeat(40));
});

test("logs changed after archival are not deleted", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  f.deps.app.sessionExists = id => {
    writeFileSync(join(f.config.stateDir, id, "events.jsonl"), "new evidence after archival\n");
    return false;
  };
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "session-state" && i.status === "blocked"));
  assert.ok(existsSync(join(f.config.stateDir, rootSession)));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("app removal may erase session originals; verified archives allow cleanup to finish", async (t) => {
  const f = fixture(t);
  const first = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(first.items.some(i => i.kind === "app-project" && /verified.*remove or retry/i.test(i.reason ?? "")));
  f.appState.project = false;
  f.appState.session = false;
  rmSync(join(f.config.stateDir, rootSession), { recursive: true });
  rmSync(join(f.config.stateDir, childSession), { recursive: true });
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.filter(i => i.kind === "archive").every(i => i.status === "archived"));
  assert.ok(f.effects.includes("delete-repo"));
});

test("missing originals with no archive are reported lost without preventing known-item cleanup", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  rmSync(join(f.config.stateDir, rootSession), { recursive: true });
  rmSync(join(f.config.stateDir, childSession), { recursive: true });
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "archive" && /LOST:/.test(i.reason ?? "")));
  assert.ok(f.effects.includes("delete-repo"));
});

test("real Git folder verification allows exact recorded history and origin before deletion", async (t) => {
  const f = fixture(t);
  f.state.provisioned = [];
  f.deps.app.inventory = () => ({
    projects: f.appState.project ? [{ id: "project-5", path: f.record.repoDir, name: f.record.name }] : [],
    sessions: [], workspaces: [], worktrees: [],
  });
  delete f.record.sessionId;
  delete f.record.appSessionId;
  const git = (args: string[]) => run("git", args, { cwd: f.record.repoDir });
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
    ["add", "."], ["commit", "-qm", "Seed v1"], ["remote", "add", "origin", `https://github.com/${f.record.repo}.git`],
  ]) assert.equal((await git(args)).code, 0);
  f.record.seedSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  f.deps.exec = run;
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(existsSync(f.record.repoDir));
  f.appState.project = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "clone" && i.status === "removed"), JSON.stringify(result));
  assert.equal(existsSync(f.record.repoDir), false);
});

test("cleanup CLI defaults to dry run for a finished empty batch", async (t) => {
  const f = fixture(t);
  f.state.runs = [];
  f.state.provisioned = [];
  f.save();
  const out = await run(process.execPath, ["scripts/batch.ts", "cleanup", "--batch", f.dir], { cwd: new URL("../..", import.meta.url).pathname });
  assert.match(out.stdout, /DRY RUN/);
  assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
});

test("explicit dry-run and yes cannot accidentally enable deletion", async (t) => {
  const f = fixture(t);
  const out = await run(process.execPath, ["scripts/batch.ts", "cleanup", "--batch", f.dir, "--yes", "--dry-run"],
    { cwd: new URL("../..", import.meta.url).pathname });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /--yes.*--dry-run/);
  assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
});
