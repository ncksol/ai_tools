import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { cleanupBatch, formatCleanup, type CleanupDeps, type CleanupApp } from "../lib/batch/cleanup.ts";
import { openAppDb } from "../lib/batch/appdb.ts";
import { buildReport } from "../lib/batch/report.ts";
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
    workspacesForPath: () => [],
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
      if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: `worktree ${opts?.cwd}\0HEAD ${seed}\0branch refs/heads/main\0\0`, stderr: "" };
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

test("Next steps requires archival before project removal and changes only after verification", async (t) => {
  const f = fixture(t);
  const dryRun = formatCleanup(await cleanupBatch(f.config, f.state, {}, f.deps)).split("Next steps:\n")[1];
  assert.match(dryRun, /KEEP project.*--yes has archived and verified/);
  assert.doesNotMatch(dryRun, /remove it in the app first|remove or retry removing project/);
  const archived = formatCleanup(await cleanupBatch(f.config, f.state, { yes: true }, f.deps)).split("Next steps:\n")[1];
  assert.match(archived, /Available logs archived and verified; remove or retry removing project/);
  assert.doesNotMatch(archived, /KEEP project/);
});

const gates: [string, (f: ReturnType<typeof fixture>) => void, RegExp][] = [
  ["unfinished", (f) => { f.state.phase = "runs"; }, /finished/],
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

for (const state of ["missing", "changed"]) {
  test(`force preserves a ${state} results row with no app or session guard masking it`, async (t) => {
    const f = fixture(t);
    f.appState.project = false;
    f.appState.session = false;
    const reason = `recorded row ${state} on origin`;
    f.deps.results = async () => reason;
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "results" && i.target === f.record.name && i.status === "blocked" && i.reason === reason));
    for (const path of [f.record.repoDir, f.worktree, `${f.record.repoDir}.kickoff.md`,
      join(f.config.stateDir, rootSession), join(f.config.stateDir, childSession)]) assert.ok(existsSync(path), path);
    assert.deepEqual(f.effects, []);
    assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
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
  assert.ok(result.items.some(i => i.kind === "clone" && i.reason === "folder origin does not match the recorded repo"));
  assert.ok(existsSync(join(f.config.stateDir, rootSession)));
  assert.ok(!f.effects.includes("delete-repo"));
});

for (const [name, change, reason] of [
  ["active action", (f: ReturnType<typeof fixture>) => { f.state.active = [0]; }, "batch has not finished (or still has an active/pending action)"],
  ["pending action", (f: ReturnType<typeof fixture>) => { f.state.pending = { id: "pending", kind: "archive_trust_session", target: "batch", issuedAt: "2026-10-23T00:00:00Z", payload: {} }; }, "batch has not finished (or still has an active/pending action)"],
  ["rehearsal", (f: ReturnType<typeof fixture>) => { f.config.dryRun = true; }, "rehearsal batches are not real cleanup targets"],
  ["home roots", (f: ReturnType<typeof fixture>) => { f.config.runsDir = f.home; }, "configured paths differ from the allowed home roots"],
  ["batch folder", (f: ReturnType<typeof fixture>) => { f.config.dir = f.config.runsDir; }, "batch folder is not the recorded batch under ~/orch-evals/batches"],
] as const) {
  test(`independent guard: ${name}`, async (t) => {
    const f = fixture(t);
    change(f);
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "batch" && i.status === "blocked" && i.reason === reason));
    assert.ok(existsSync(f.record.repoDir));
    assert.deepEqual(f.effects, []);
  });
}

for (const [name, command, stdout, code, reason] of [
  ["exact Git top level", "--show-toplevel", "/not-this-worktree", 0, "folder is not its own Git worktree"],
  ["local origin", "remote", "https://github.com/ncksol/unrelated.git", 0, "folder origin does not match the recorded repo"],
  ["local seed ancestry", "merge-base", "", 1, "folder history does not contain the recorded seed"],
] as const) {
  test(`independent guard: ${name}`, async (t) => {
    const f = fixture(t);
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    f.appState.project = false;
    f.appState.session = false;
    const exec = f.deps.exec;
    f.deps.exec = async (cmd, args, opts) => args.includes(command) ? { code, stdout, stderr: "" } : exec(cmd, args, opts);
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.target === f.worktree && i.status === "blocked" && i.reason === reason));
    assert.ok(existsSync(f.worktree));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

test("independent guard: worktree root containment", async (t) => {
  const f = fixture(t);
  const outside = join(f.home, "_src_", "copilot-worktrees", "another-project", "branch");
  mkdirSync(outside, { recursive: true });
  f.appState.project = false;
  f.appState.session = false;
  f.deps.app.inventory = () => ({ projects: [], sessions: [], workspaces: [], worktrees: [outside] });
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "worktree" && i.target === outside && i.reason === "folder is outside this run's allowed root"));
  assert.ok(existsSync(outside));
  assert.ok(!f.effects.includes("delete-repo"));
});

for (const field of ["id", "path"] as const) {
  test(`independent guard: app project ${field} identity`, async (t) => {
    const f = fixture(t);
    f.appState.session = false;
    f.deps.app.inventory = () => ({
      projects: [{ id: "project-5", path: f.record.repoDir, name: f.record.name, [field]: "different" }],
      sessions: [], workspaces: [], worktrees: [],
    });
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "repo" && i.reason === "app project identity/path mismatch"));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

test("independent guard: another project using the clone", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  f.deps.app.projectsForPath = path => path === f.record.repoDir ? ["different-project"] : [];
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "repo" && i.reason === "another app project uses this clone; identity mismatch"));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("independent guard: kickoff identity without remote or clone receipt", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  f.deps.repo = async () => null;
  rmSync(f.record.repoDir, { recursive: true });
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "kickoff" && i.reason === "cannot establish kickoff identity without repo or clone removal receipt"));
  assert.ok(existsSync(`${f.record.repoDir}.kickoff.md`));
});

test("independent guard: live inuse PID lock", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  writeFileSync(join(f.config.stateDir, rootSession, `inuse.${process.pid}.lock`), "");
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "session-state" && i.target.endsWith(rootSession) && i.reason === "session is still running"));
  assert.ok(existsSync(join(f.config.stateDir, rootSession)));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("independent guard: repo deletion rechecks app membership after disk removal", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  const io = await import("node:fs");
  f.deps.fs = { ...io, rmSync: (path, options) => {
    io.rmSync(path, options);
    if (path === `${f.record.repoDir}.kickoff.md`) f.appState.project = true;
  } };
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "repo" && i.reason === "app project reappeared"));
  assert.equal(existsSync(f.record.repoDir), false);
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

test("a partial failed archive update never truncates a previously verified result", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const archive = join(f.dir, "sessions", f.record.name, rootSession, "events.jsonl.gz");
  const original = readFileSync(archive);
  appendFileSync(join(f.config.stateDir, rootSession, "events.jsonl"), '{"later":true}\n');
  const io = await import("node:fs");
  f.deps.fs = { ...io, writeFileSync: (path, data, options) => {
    io.writeFileSync(path, Buffer.from(data as Uint8Array).subarray(0, 10), options);
    throw new Error("ENOSPC");
  } };
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "archive" && /ENOSPC/.test(i.reason ?? "")));
  assert.deepEqual(readFileSync(archive), original);
  assert.equal(gunzipSync(readFileSync(archive)).toString(), `{"id":"${rootSession}"}\n`);
});

test("changed logs create a new verified version and remain usable after app removal", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const original = join(f.dir, "sessions", f.record.name, rootSession, "events.jsonl.gz");
  const before = readFileSync(original);
  appendFileSync(join(f.config.stateDir, rootSession, "events.jsonl"), '{"later":true}\n');
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const entries = readFileSync(join(f.dir, "cleanup.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const latest = entries.findLast(e => e.action === "archived" && e.source === join(f.config.stateDir, rootSession, "events.jsonl"));
  assert.notEqual(latest.target, original);
  assert.match(gunzipSync(readFileSync(latest.target)).toString(), /"later":true/);
  assert.deepEqual(readFileSync(original), before);
  rmSync(join(f.config.stateDir, rootSession), { recursive: true });
  f.appState.project = false;
  f.appState.session = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(result.items.filter(i => i.status === "blocked").length, 0, JSON.stringify(result));
  assert.ok(f.effects.includes("delete-repo"));
});

for (const bad of ["foreign gitdir", "existing gitdir", "invalid clone", "app reference", "no saved inventory"]) {
  test(`dangling-worktree exception refuses ${bad}`, async (t) => {
    const f = fixture(t);
    if (bad !== "no saved inventory") await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    f.appState.project = false;
    f.appState.session = false;
    f.deps.app.inventory = () => ({ projects: [], sessions: [], workspaces: [], worktrees: [f.worktree] });
    const gitdir = bad === "foreign gitdir" ? join(f.home, "other-clone", ".git", "worktrees", "branch") :
      join(f.record.repoDir, ".git", "worktrees", "branch");
    if (bad === "existing gitdir") mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(f.worktree, ".git"), `gitdir: ${gitdir}\n`);
    if (bad === "app reference") f.deps.app.projectsForPath = path => path === f.worktree ? ["project-5"] : [];
    const exec = f.deps.exec;
    f.deps.exec = async (cmd, args, opts) => {
      if (opts?.cwd === f.worktree && args.includes("--show-toplevel")) return { code: 128, stdout: "", stderr: "missing gitdir" };
      if (bad === "invalid clone" && opts?.cwd === f.record.repoDir && args.includes("remote")) return { code: 0, stdout: "https://github.com/ncksol/other.git", stderr: "" };
      return exec(cmd, args, opts);
    };
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.status === "blocked"));
    assert.ok(existsSync(f.worktree));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

test("a recorded dangling prewarm worktree is removed only after validating its clone", async (t) => {
  const f = fixture(t);
  f.state.provisioned = [];
  const git = (args: string[]) => run("git", args, { cwd: f.record.repoDir });
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
    ["add", "."], ["commit", "-qm", "Seed v1"], ["remote", "add", "origin", `https://github.com/${f.record.repo}.git`],
  ]) assert.equal((await git(args)).code, 0);
  f.record.seedSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  rmSync(f.worktree, { recursive: true });
  assert.equal((await git(["worktree", "add", "-qb", "prewarm", f.worktree])).code, 0);
  f.deps.exec = run;
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const gitdir = readFileSync(join(f.worktree, ".git"), "utf8").trim().slice("gitdir: ".length);
  assert.ok(gitdir.startsWith(`${f.record.repoDir}/.git/worktrees/`));
  rmSync(gitdir, { recursive: true });
  f.appState.project = false;
  f.appState.session = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "worktree" && i.status === "removed"), JSON.stringify(result));
  assert.equal(existsSync(f.worktree), false);
  assert.ok(f.effects.includes("delete-repo"));
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

test("a missing result blocks its own run, not another run's archives", async (t) => {
  const f = fixture(t);
  const second = { ...f.record, n: 6, name: "orch-eval-orchestrator-6", repo: "ncksol/orch-eval-orchestrator-6",
    repoDir: join(f.config.runsDir, "orch-eval-orchestrator-6"), projectId: "project-6", sessionId: childSession };
  mkdirSync(second.repoDir);
  writeFileSync(`${second.repoDir}.kickoff.md`, "Implement v2.");
  f.state.runs.push(second);
  f.state.provisioned = [];
  f.deps.app.inventory = record => {
    const r = record.projectId === f.record.projectId ? f.record : second;
    return { projects: [{ id: r.projectId!, path: r.repoDir, name: r.name }], sessions: [r.sessionId!], workspaces: [], worktrees: [] };
  };
  f.deps.app.projectsForPath = path => f.state.runs.filter(r => r.repoDir === path).map(r => r.projectId!);
  f.deps.results = async (_config, _state, record) => record?.name === second.name ? null : "recorded row missing on origin";
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "archive" && i.target.endsWith(childSession) && i.status === "archived"));
  assert.equal(existsSync(join(f.dir, "sessions", f.record.name, rootSession, "events.jsonl.gz")), false);
  assert.ok(existsSync(f.record.repoDir));
});

test("an exact per-run deliberate-drop confirmation is journaled and survives a rerun", async (t) => {
  const f = fixture(t);
  f.record.row = { repo: f.record.repo, run: "5", outcome: "passed", note: `batch=${f.config.id}` };
  f.deps.results = async () => "recorded row missing on origin";
  const accepted = await cleanupBatch(f.config, f.state, { yes: true, dropped: [f.record.name] }, f.deps);
  assert.ok(accepted.items.some(i => i.kind === "archive" && i.status === "archived"));
  assert.ok(readFileSync(join(f.dir, "cleanup.jsonl"), "utf8").split("\n").filter(Boolean)
    .map(line => JSON.parse(line)).some(e => e.action === "dropped" && e.target === f.record.name));
  f.appState.project = false;
  f.appState.session = false;
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(f.effects.includes("delete-repo"));
});

test("unknown deliberate-drop names cannot authorize cleanup", async (t) => {
  const f = fixture(t);
  const result = await cleanupBatch(f.config, f.state, { yes: true, dropped: ["orch-eval-other-5"] }, f.deps);
  assert.ok(result.items.some(i => i.kind === "batch" && /unknown --dropped/.test(i.reason ?? "")));
  assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
});

test("an unscored deliberate-drop name is rejected before any write", async (t) => {
  const f = fixture(t);
  const result = await cleanupBatch(f.config, f.state, { yes: true, dropped: [f.record.name] }, f.deps);
  assert.ok(result.items.some(i => i.kind === "batch" && i.reason === `--dropped run has no recorded result: ${f.record.name}`));
  assert.deepEqual(f.effects, []);
  assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
});

test("a deliberate-drop receipt never covers a different run identity with the same name and row", async (t) => {
  const f = fixture(t);
  f.state.provisioned = [];
  f.record.row = { outcome: "passed" };
  f.deps.results = async () => "recorded row missing on origin";
  await cleanupBatch(f.config, f.state, { yes: true, dropped: [f.record.name] }, f.deps);
  const journal = readFileSync(join(f.dir, "cleanup.jsonl"));
  f.record.seedSha = "b".repeat(40);
  f.appState.project = false;
  f.appState.session = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "results" && i.reason === "recorded row missing on origin"));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
  assert.deepEqual(readFileSync(join(f.dir, "cleanup.jsonl")), journal);
});

test("a repo lookup failure still shows the project KEEP action and archive inventory", async (t) => {
  const f = fixture(t);
  f.deps.repo = async () => { throw new Error("repo not found or not visible"); };
  const result = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.match(formatCleanup(result).split("Next steps:\n")[1], /KEEP project/);
  assert.equal(result.items.filter(i => i.kind === "archive").length, 2);
  assert.ok(result.items.some(i => i.kind === "repo" && i.status === "blocked"));
  assert.deepEqual(f.effects, []);
});

test("a deliberate-drop receipt never covers an edited recorded row", async (t) => {
  const f = fixture(t);
  f.record.row = { outcome: "passed" };
  f.deps.results = async () => "recorded row missing on origin";
  await cleanupBatch(f.config, f.state, { yes: true, dropped: [f.record.name] }, f.deps);
  f.record.row.outcome = "stalled";
  f.appState.project = false;
  f.appState.session = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "results" && i.status === "blocked"));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
});

test("Next steps groups blockers and prints an unverifiable run only once", async (t) => {
  const f = fixture(t);
  delete f.record.seedSha;
  f.state.provisioned = [];
  const result = await cleanupBatch(f.config, f.state, {}, f.deps);
  const output = formatCleanup(result);
  assert.match(output, /Next steps:\n/);
  assert.match(output, /cannot be verified; nothing touched/);
  assert.equal(output.split(f.record.name).length - 1, 1);
  const grouped = formatCleanup({ batch: "test", dryRun: false, items: [
    { kind: "clone", target: "/one", status: "blocked", reason: "example block" },
    { kind: "repo", target: "owner/one", status: "blocked", reason: "example block" },
    { kind: "archive", target: "lost-session", status: "already gone", reason: "LOST: no logs" },
  ] }).split("Next steps:\n")[1];
  assert.match(grouped, /example block \(2 items/);
  assert.match(grouped, /LOST: no logs/);
});

for (const status of ["live", "archived", "gone"]) {
  test(`self-test checklist checks current app state: ${status}`, async (t) => {
    const f = fixture(t);
    f.state.runs = [];
    f.state.provisioned = [];
    f.state.selftests = [{ nonce: "selftest", repoDir: join(f.config.runsDir, "eval-runner-selftest"),
      prompt: "selftest", status: "passed", createdAt: "2026-10-23T00:00:00Z", projectId: "selftest-project",
      appSessionId: "selftest-workspace", sessionId: rootSession, askAttempts: 0, judged: [], checks: [] }];
    f.deps.app.inventory = () => ({ projects: [], sessions: [], worktrees: [],
      workspaces: status === "gone" ? [] : [{ id: "selftest-workspace", sessionId: rootSession, archived: status === "archived" }] });
    const result = await cleanupBatch(f.config, f.state, {}, f.deps);
    assert.equal(result.items.filter(i => i.checklist).length, status === "live" ? 1 : 0);
    assert.deepEqual(f.effects, []);
  });
}

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

function isolatedCli(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  const oldDir = f.dir;
  f.config.id = "19990101-0000";
  f.config.dir = join(f.config.runsDir, "batches", f.config.id);
  renameSync(oldDir, f.config.dir);
  f.state.runs = [];
  f.state.provisioned = [];
  saveConfig(f.config);
  saveState(f.config.dir, f.state);
  const bin = join(f.home, "bin");
  const calls = join(f.home, "gh-calls");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf "called\\n" >> "$GH_CALLS"\nprintf "gh: Not Found (HTTP 404)\\n" >&2\nexit 99\n');
  chmodSync(join(bin, "gh"), 0o700);
  return {
    f, calls,
    args: ["scripts/batch.ts", "cleanup", "--batch", f.config.id, "--batches-dir", join(f.config.runsDir, "batches")],
    options: { cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, HOME: f.home, PATH: `${bin}:${process.env.PATH}`, GH_CALLS: calls, GH_TOKEN: undefined, GITHUB_TOKEN: undefined } },
  };
}

for (const dropped of [false, true]) test(`a completed cleanup dry run uses removal receipts, shows verified archives and exits zero (dropped=${dropped})`, async (t) => {
  const { f, calls, args, options } = isolatedCli(t);
  f.state.runs = [f.record];
  if (dropped) {
    f.record.row = { outcome: "passed" };
    f.deps.results = async () => "recorded row missing on origin";
  }
  await cleanupBatch(f.config, f.state, { yes: true, dropped: dropped ? [f.record.name] : [] }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  saveState(f.config.dir, f.state);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(f.config.appDb);
  db.exec(`
    CREATE TABLE projects (id TEXT, main_repo_path TEXT, name TEXT);
    CREATE TABLE workspaces (id TEXT, project_id TEXT, session_id TEXT, archived_at TEXT, creator_session_id TEXT, coordinating_creator_session_id TEXT);
    CREATE TABLE worktrees (project_id TEXT, path TEXT);
    CREATE TABLE reusable_worktree_pool (project_id TEXT, path TEXT);
    CREATE TABLE workspace_session_aliases (workspace_id TEXT, session_id TEXT);
    CREATE TABLE project_checkouts (project_id TEXT, host_id TEXT, root_resource_uri TEXT);
  `);
  db.close();
  const journal = readFileSync(join(f.config.dir, "cleanup.jsonl"));
  const out = await run(process.execPath, args, options);
  assert.equal(out.code, 0, out.stderr + out.stdout);
  assert.match(out.stdout, /ARCHIVED archive/);
  assert.match(out.stdout, /repo .*removed earlier/i);
  assert.doesNotMatch(out.stdout, /BLOCKED|--yes when ready/);
  assert.equal(existsSync(calls), false);
  assert.deepEqual(readFileSync(join(f.config.dir, "cleanup.jsonl")), journal);
});

for (const scenario of ["different identity", "yes recheck"]) {
  test(`repo removal receipts do not bypass verification for ${scenario}`, async (t) => {
    const f = fixture(t);
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    f.appState.project = false;
    f.appState.session = false;
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    f.state.provisioned = [];
    if (scenario === "different identity") f.record.seedSha = "b".repeat(40);
    let reads = 0;
    f.deps.repo = async () => { reads++; throw new Error("repo not found or not visible"); };
    const result = await cleanupBatch(f.config, f.state, { yes: scenario === "yes recheck" }, f.deps);
    assert.equal(reads, 1);
    assert.ok(result.items.some(i => i.kind === "repo" && i.status === "blocked" && i.reason === "repo not found or not visible"));
  });
}

test("the morning checklist numbers the cleanup and macOS steps once each", (t) => {
  const f = fixture(t);
  f.state.runs = [];
  f.state.provisioned = [];
  f.config.variants = [];
  f.config.resultsPath = join(f.home, "results.csv");
  const report = buildReport(f.config, f.state, openAppDb(f.config.appDb), { branch: null, commits: [], pushed: null });
  const checklist = report.split("## Morning checklist\n")[1];
  assert.deepEqual([...checklist.matchAll(/^(\d+)\. /gm)].map(match => Number(match[1])), [1, 2, 3, 4, 5, 6]);
});

test("cleanup CLI defaults to dry run for a finished empty batch", async (t) => {
  const { f, calls, args, options } = isolatedCli(t);
  const out = await run(process.execPath, args, options);
  assert.equal(out.code, 0, out.stderr + out.stdout);
  assert.match(out.stdout, /DRY RUN/);
  assert.doesNotMatch(out.stdout, /BLOCKED/);
  assert.match(out.stdout, /No cleanup actions remain/);
  assert.equal(existsSync(join(f.config.dir, "cleanup.jsonl")), false);
  assert.equal(existsSync(calls), false);
});

test("explicit dry-run and yes cannot accidentally enable deletion", async (t) => {
  const { f, calls, args, options } = isolatedCli(t);
  const out = await run(process.execPath, [...args, "--yes", "--dry-run"], options);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /--yes.*--dry-run/);
  assert.equal(existsSync(join(f.config.dir, "cleanup.jsonl")), false);
  assert.equal(existsSync(calls), false);
});

const nextSteps = (report: Awaited<ReturnType<typeof cleanupBatch>>) => formatCleanup(report).split("Next steps:\n")[1];
const journalOf = (f: ReturnType<typeof fixture>) => readFileSync(join(f.dir, "cleanup.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const runFolder = (f: ReturnType<typeof fixture>) => join(f.home, "_src_/copilot-worktrees", f.record.name);

test("a dry run after --yes archived every log reports verified archives and the remove instruction", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const journal = readFileSync(join(f.dir, "cleanup.jsonl"));
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  const archives = report.items.filter(i => i.kind === "archive");
  assert.equal(archives.length, 2);
  assert.ok(archives.every(i => i.status === "archived"), JSON.stringify(archives));
  assert.doesNotMatch(formatCleanup(report), /PRESENT archive/);
  assert.match(nextSteps(report), /Available logs archived and verified; remove or retry removing project/);
  assert.doesNotMatch(nextSteps(report), /KEEP project/);
  assert.deepEqual(readFileSync(join(f.dir, "cleanup.jsonl")), journal);
  assert.deepEqual(f.effects, ["authorize"]);
});

test("a dry run reports an archive of changed logs as out of date and keeps the project", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  appendFileSync(join(f.config.stateDir, rootSession, "events.jsonl"), '{"later":true}\n');
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  const changed = report.items.find(i => i.kind === "archive" && i.target.endsWith(rootSession));
  assert.notEqual(changed?.status, "archived");
  assert.match(changed?.reason ?? "", /out of date/);
  assert.match(changed?.reason ?? "", /--yes/);
  assert.ok(report.items.some(i => i.kind === "archive" && i.target.endsWith(childSession) && i.status === "archived"));
  assert.match(nextSteps(report), /KEEP project/);
  assert.doesNotMatch(nextSteps(report), /remove or retry/);
});

test("a dry run keeps the project when a session's verified archive is missing", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  rmSync(join(f.dir, "sessions", f.record.name, childSession, "events.jsonl.gz"));
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  const missing = report.items.find(i => i.kind === "archive" && i.target.endsWith(childSession));
  assert.notEqual(missing?.status, "archived");
  assert.match(missing?.reason ?? "", /missing or does not verify.*--yes/);
  assert.match(nextSteps(report), /KEEP project/);
  assert.doesNotMatch(nextSteps(report), /remove or retry/);
});

test("a dry run keeps the project while its live inventory has items --yes has not saved", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const inventory = f.deps.app.inventory;
  f.deps.app.inventory = record => {
    const live = inventory(record);
    return { ...live, worktrees: [...live.worktrees, join(runFolder(f), "new-child")] };
  };
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.match(nextSteps(report), /KEEP project/);
  assert.doesNotMatch(nextSteps(report), /remove or retry/);
});

async function realClone(f: ReturnType<typeof fixture>) {
  f.state.provisioned = [];
  const git = (args: string[]) => run("git", args, { cwd: f.record.repoDir });
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
    ["add", "."], ["commit", "-qm", "Seed v1"], ["remote", "add", "origin", `https://github.com/${f.record.repo}.git`],
  ]) assert.equal((await git(args)).code, 0);
  f.record.seedSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  const calls: string[] = [];
  f.deps.exec = (cmd, args, opts) => { calls.push(`${opts?.cwd}: ${args.join(" ")}`); return run(cmd, args, opts); };
  // The app removed the project before cleanup's first inventory, as for the -8 runs of batch 20261022-2121.
  rmSync(f.worktree, { recursive: true });
  f.appState.project = false;
  f.appState.session = false;
  return { git, calls };
}

test("an unrecorded linked worktree under the run folder is removed through git before the clone", async (t) => {
  const f = fixture(t);
  const { git, calls } = await realClone(f);
  const prewarm = join(runFolder(f), "copilot-prewarm-curly-potato");
  assert.equal((await git(["worktree", "add", "-q", "--detach", prewarm])).code, 0);
  const preview = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(preview.items.some(i => i.kind === "worktree" && i.target === prewarm && i.status === "present" && /linked worktree/i.test(i.reason ?? "")), JSON.stringify(preview));
  assert.equal(existsSync(join(f.dir, "cleanup.jsonl")), false);
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "worktree" && i.target === prewarm && i.status === "removed"), JSON.stringify(result));
  assert.ok(calls.includes(`${f.record.repoDir}: worktree remove --force ${prewarm}`), calls.join("\n"));
  assert.equal(existsSync(prewarm), false);
  assert.equal(existsSync(f.record.repoDir), false);
  assert.ok(f.effects.includes("delete-repo"));
  const journal = journalOf(f);
  const worktreeRemoved = journal.findIndex(e => e.action === "removed" && e.kind === "worktree" && e.target === prewarm);
  const cloneRemoving = journal.findIndex(e => e.action === "removing" && e.kind === "clone");
  assert.ok(worktreeRemoved >= 0 && worktreeRemoved < cloneRemoving, JSON.stringify(journal));
});

for (const scenario of ["outside the run folder", "an app project reference", "an app session reference", "a .git file outside the clone", "a lock"] as const) {
  test(`a linked worktree with ${scenario} blocks the clone and the repo`, async (t) => {
    const f = fixture(t);
    const { git } = await realClone(f);
    const linked = scenario === "outside the run folder"
      ? join(f.home, "_src_/copilot-worktrees/another-run/copilot-prewarm-x") : join(runFolder(f), "copilot-prewarm-x");
    assert.equal((await git(["worktree", "add", "-q", "--detach", linked])).code, 0);
    if (scenario === "an app project reference") f.deps.app.projectsForPath = path => path === linked ? ["project-5"] : [];
    if (scenario === "an app session reference") f.deps.app.workspacesForPath = path => path === linked ? ["workspace-9"] : [];
    if (scenario === "a .git file outside the clone") writeFileSync(join(linked, ".git"), `gitdir: ${join(f.home, "other/.git/worktrees/x")}\n`);
    if (scenario === "a lock") assert.equal((await git(["worktree", "lock", linked])).code, 0);
    const preview = await cleanupBatch(f.config, f.state, {}, f.deps);
    assert.ok(preview.items.some(i => i.kind === "worktree" && i.target === linked && i.status === "blocked" && i.reason?.includes(linked)), JSON.stringify(preview));
    const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.target === linked && i.status === "blocked" && i.reason?.includes(linked)), JSON.stringify(result));
    assert.ok(result.items.some(i => i.kind === "clone" && i.status === "blocked"));
    assert.ok(result.items.some(i => i.kind === "repo" && i.status === "blocked"));
    assert.ok(existsSync(join(linked, "keep-until-authorized")));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(existsSync(`${f.record.repoDir}.kickoff.md`));
    assert.ok(!f.effects.includes("delete-repo"));
    assert.ok(!journalOf(f).some(e => e.action === "removing" && ["worktree", "clone", "kickoff", "repo"].includes(e.kind)));
  });
}

test("an empty app worktree folder is removed once the run's worktrees are gone", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  const preview = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(preview.items.some(i => i.kind === "worktree-parent" && i.target === runFolder(f) && i.status === "present"), JSON.stringify(preview));
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "worktree-parent" && i.target === runFolder(f) && i.status === "removed"), JSON.stringify(result));
  assert.equal(existsSync(runFolder(f)), false);
  assert.ok(existsSync(join(f.home, "_src_/copilot-worktrees")));
  assert.ok(journalOf(f).some(e => e.action === "removed" && e.kind === "worktree-parent" && e.target === runFolder(f)));
});

test("a non-empty app worktree folder is kept and named", async (t) => {
  const f = fixture(t);
  writeFileSync(join(runFolder(f), "notes.txt"), "not a recorded worktree");
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(existsSync(f.worktree), false);
  assert.ok(existsSync(join(runFolder(f), "notes.txt")));
  assert.ok(result.items.some(i => i.kind === "worktree-parent" && i.target === runFolder(f) && i.status === "present" && /not empty/.test(i.reason ?? "")), JSON.stringify(result));
  assert.match(nextSteps(result), new RegExp(`${runFolder(f)}: .*not empty`));
});
