import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { cleanupBatch, formatCleanup, RepoNotVisible, type CleanupDeps, type CleanupApp } from "../lib/batch/cleanup.ts";
import { openCleanupApp } from "../lib/batch/cleanup-io.ts";
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
  // A fake Git registry: the clone's .git/worktrees/<name>/gitdir files list its linked worktrees.
  const admin = join(repoDir, ".git/worktrees/branch");
  mkdirSync(admin, { recursive: true });
  writeFileSync(join(admin, "gitdir"), `${worktree}/.git\n`);
  writeFileSync(join(worktree, ".git"), `gitdir: ${admin}\n`);
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
      if (args[0] === "worktree") {
        const admins = join(String(opts?.cwd), ".git/worktrees");
        const linked = (existsSync(admins) ? readdirSync(admins) : []).filter(name => existsSync(join(admins, name, "gitdir")))
          .map(name => ({ admin: join(admins, name), path: dirname(readFileSync(join(admins, name, "gitdir"), "utf8").trim()) }));
        if (args[1] === "list") {
          const entry = (fields: string[]) => fields.map(field => `${field}\0`).join("") + "\0";
          return { code: 0, stdout: entry([`worktree ${opts?.cwd}`, `HEAD ${seed}`, "branch refs/heads/main"]) + linked.map(w =>
            entry([`worktree ${w.path}`, `HEAD ${seed}`, "detached", ...(existsSync(join(w.admin, "locked")) ? ["locked"] : [])])).join(""), stderr: "" };
        }
        const found = linked.find(w => args[1] === "remove" && w.path === args.at(-1));
        if (!found) return { code: 128, stdout: "", stderr: "not a working tree" };
        rmSync(found.path, { recursive: true });
        rmSync(found.admin, { recursive: true });
        effects.push(`git-worktree-remove ${found.path}`);
        return { code: 0, stdout: "", stderr: "" };
      }
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
  assert.ok(result.items.some(i => i.kind === "worktree" && i.target === outside && i.status === "blocked" && i.reason?.includes(outside) && /outside/.test(i.reason)), JSON.stringify(result));
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
  assert.ok(f.effects.includes(`git-worktree-remove ${f.worktree}`), "the clone's registry still finds the worktree");
  assert.equal(existsSync(f.worktree), false);
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
    rmSync(join(f.record.repoDir, ".git", "worktrees", "branch"), { recursive: true });
    if (bad === "existing gitdir") {
      mkdirSync(gitdir, { recursive: true });
      writeFileSync(join(gitdir, "gitdir"), `${join(f.home, "elsewhere")}/.git\n`);
    }
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
  rmSync(join(f.record.repoDir, ".git"), { recursive: true });
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
  rmSync(join(f.record.repoDir, ".git"), { recursive: true });
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
  assert.match(missing?.reason ?? "", /events.jsonl.gz of events.jsonl is missing. --yes archives the current log again/);
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
  rmSync(join(f.record.repoDir, ".git"), { recursive: true });
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

for (const extra of ["a LOST log", "a LOST log and a kept non-empty run folder"] as const) {
  test(`Next steps still asks for --yes when removals remain beside ${extra}`, async (t) => {
    const f = fixture(t);
    rmSync(join(f.config.stateDir, childSession), { recursive: true });
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    f.appState.project = false;
    f.appState.session = false;
    if (extra !== "a LOST log") writeFileSync(join(runFolder(f), "notes.txt"), "not a recorded worktree");
    const report = await cleanupBatch(f.config, f.state, {}, f.deps);
    assert.ok(report.items.some(i => i.kind === "clone" && i.status === "present"));
    if (extra === "a LOST log") assert.ok(report.items.some(i => i.kind === "worktree-parent" && i.status === "present" && !i.checklist));
    const steps = nextSteps(report);
    assert.match(steps, /LOST: session logs are gone/);
    assert.match(steps, /rerun this batch with --yes/);
  });
}

test("Next steps does not ask for --yes when only a kept folder and app details remain", async (t) => {
  const f = fixture(t);
  writeFileSync(join(runFolder(f), "notes.txt"), "not a recorded worktree");
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const steps = nextSteps(await cleanupBatch(f.config, f.state, {}, f.deps));
  assert.match(steps, /not empty/);
  assert.doesNotMatch(steps, /--yes/);
});

test("a corrupt archive is kept unchanged and --yes writes a new verified version beside it", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const dest = join(f.dir, "sessions", f.record.name, rootSession);
  const archive = join(dest, "events.jsonl.gz");
  const corrupt = readFileSync(archive).subarray(0, 10);
  writeFileSync(archive, corrupt);
  const original = readFileSync(join(f.config.stateDir, rootSession, "events.jsonl"));
  const versioned = join(dest, `events.jsonl.${createHash("sha256").update(original).digest("hex")}.gz`);
  const preview = await cleanupBatch(f.config, f.state, {}, f.deps);
  const item = preview.items.find(i => i.kind === "archive" && i.target.endsWith(rootSession));
  assert.equal(item?.status, "present", JSON.stringify(item));
  assert.ok(item?.reason?.includes(`${archive} of events.jsonl does not verify`), item?.reason);
  assert.ok(item?.reason?.includes(versioned), item?.reason);
  assert.match(nextSteps(preview), /KEEP project/);
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(result.items.find(i => i.kind === "archive" && i.target.endsWith(rootSession))?.status, "archived", JSON.stringify(result));
  assert.deepEqual(readFileSync(archive), corrupt);
  assert.deepEqual(gunzipSync(readFileSync(versioned)), original);
  const after = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(after.items.filter(i => i.kind === "archive").every(i => i.status === "archived"), JSON.stringify(after));
  assert.match(nextSteps(after), /remove or retry removing project/);
});

test("when every archive name is taken by a file that does not verify, the dry run and --yes both block with manual steps", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const dest = join(f.dir, "sessions", f.record.name, rootSession);
  const original = readFileSync(join(f.config.stateDir, rootSession, "events.jsonl"));
  const names = [join(dest, "events.jsonl.gz"), join(dest, `events.jsonl.${createHash("sha256").update(original).digest("hex")}.gz`)];
  for (const path of names) writeFileSync(path, "not gzip");
  for (const yes of [false, true]) {
    const report = await cleanupBatch(f.config, f.state, { yes }, f.deps);
    const item = report.items.find(i => i.kind === "archive" && i.target.endsWith(rootSession));
    assert.equal(item?.status, "blocked", JSON.stringify(item));
    for (const path of names) assert.ok(item?.reason?.includes(path), item?.reason);
    assert.doesNotMatch(item?.reason ?? "", /--yes/);
    assert.match(nextSteps(report), /KEEP project/);
  }
  for (const path of names) assert.equal(readFileSync(path, "utf8"), "not gzip");
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
});

// Round 2: critical review of 737a5ff.
const sessionDir = (f: ReturnType<typeof fixture>, id = rootSession) => join(f.config.stateDir, id);
const archiveDir = (f: ReturnType<typeof fixture>, id = rootSession) => join(f.dir, "sessions", f.record.name, id);
const rewriteJournal = (f: ReturnType<typeof fixture>, change: (e: Record<string, unknown>) => Record<string, unknown>) =>
  writeFileSync(join(f.dir, "cleanup.jsonl"), journalOf(f).map(e => JSON.stringify(change(e)) + "\n").join(""));
const assertKeep = (report: Awaited<ReturnType<typeof cleanupBatch>>) => {
  assert.match(nextSteps(report), /KEEP project/);
  assert.doesNotMatch(nextSteps(report), /remove or retry/);
};

for (const change of ["changed", "unarchived"] as const) {
  test(`M1: a dry run keeps the project when events.jsonl is gone but workspace.yaml is ${change}`, async (t) => {
    const f = fixture(t);
    if (change === "changed") writeFileSync(join(sessionDir(f), "workspace.yaml"), "id: root\n");
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    rmSync(join(sessionDir(f), "events.jsonl"));
    appendFileSync(join(sessionDir(f), "workspace.yaml"), "new: unarchived\n");
    const report = await cleanupBatch(f.config, f.state, {}, f.deps);
    assert.notEqual(report.items.find(i => i.kind === "archive" && i.target === sessionDir(f))?.status, "archived", JSON.stringify(report));
    assertKeep(report);
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    const copies = readdirSync(archiveDir(f)).filter(name => name.startsWith("workspace.yaml"));
    assert.ok(copies.some(name => gunzipSync(readFileSync(join(archiveDir(f), name))).toString().includes("new: unarchived")), copies.join());
    const after = await cleanupBatch(f.config, f.state, {}, f.deps);
    assert.match(nextSteps(after), /remove or retry removing project/);
  });
}

test("S1: a dry run keeps the project and says to stop a running session", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.deps.app.sessionRunning = id => id === childSession;
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assertKeep(report);
  assert.match(nextSteps(report), new RegExp(`${childSession}.*still running.*stop.*--yes`, "i"));
});

test("S1: a dry run keeps the project when a log changes during the check", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const projectsForPath = f.deps.app.projectsForPath;
  let written = false;
  f.deps.app.projectsForPath = path => {
    if (!written) { written = true; appendFileSync(join(sessionDir(f), "events.jsonl"), '{"late":true}\n'); }
    return projectsForPath(path);
  };
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(written);
  assertKeep(report);
  assert.match(nextSteps(report), /changed during this check.*--yes/);
});

test("S1: the remove instruction says later writes need another --yes", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.match(nextSteps(await cleanupBatch(f.config, f.state, {}, f.deps)), /remove or retry removing project.*runs again.*--yes/);
});

async function recordedRealWorktree(f: ReturnType<typeof fixture>) {
  f.state.provisioned = [];
  rmSync(join(f.record.repoDir, ".git"), { recursive: true });
  rmSync(f.worktree, { recursive: true });
  const git = (args: string[], cwd = f.record.repoDir) => run("git", args, { cwd });
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
    ["add", "."], ["commit", "-qm", "Seed v1"], ["remote", "add", "origin", `https://github.com/${f.record.repo}.git`],
  ]) assert.equal((await git(args)).code, 0);
  f.record.seedSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  assert.equal((await git(["worktree", "add", "-q", "--detach", f.worktree])).code, 0);
  const calls: string[] = [];
  f.deps.exec = (cmd, args, opts) => { calls.push(`${opts?.cwd}: ${args.join(" ")}`); return run(cmd, args, opts); };
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(journalOf(f).some(e => e.action === "inventory" && e.inventory.worktrees.includes(f.worktree)));
  f.appState.project = false;
  f.appState.session = false;
  return { git, calls };
}

test("M3: a valid recorded worktree is removed through git, not a recursive delete", async (t) => {
  const f = fixture(t);
  const { calls } = await recordedRealWorktree(f);
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "worktree" && i.target === f.worktree && i.status === "removed"), JSON.stringify(result));
  assert.ok(calls.includes(`${f.record.repoDir}: worktree remove --force ${f.worktree}`), calls.join("\n"));
  assert.ok(f.effects.includes("delete-repo"));
});

for (const scenario of ["locked", "referenced by an app workspace", "a worktree of another clone"] as const) {
  test(`M3: a recorded worktree that is ${scenario} blocks the clone and the repo, even with --force`, async (t) => {
    const f = fixture(t);
    const { git } = await recordedRealWorktree(f);
    if (scenario === "locked") assert.equal((await git(["worktree", "lock", f.worktree])).code, 0);
    if (scenario === "referenced by an app workspace") f.deps.app.workspacesForPath = path => path === f.worktree ? ["workspace-9"] : [];
    if (scenario === "a worktree of another clone") {
      const other = join(f.home, "other-clone");
      assert.equal((await git(["worktree", "remove", "--force", f.worktree])).code, 0);
      assert.equal((await git(["clone", "-q", f.record.repoDir, other], f.home)).code, 0);
      assert.equal((await git(["remote", "set-url", "origin", `https://github.com/${f.record.repo}.git`], other)).code, 0);
      assert.equal((await git(["worktree", "add", "-q", "--detach", f.worktree], other)).code, 0);
    }
    writeFileSync(join(f.worktree, "evidence.txt"), "keep");
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.target === f.worktree && i.status === "blocked" && i.reason?.includes(f.worktree)), JSON.stringify(result));
    assert.ok(result.items.some(i => i.kind === "clone" && i.status === "blocked"));
    assert.ok(result.items.some(i => i.kind === "repo" && i.status === "blocked"));
    assert.ok(existsSync(join(f.worktree, "evidence.txt")));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
    assert.ok(!journalOf(f).some(e => e.action === "removing" && ["worktree", "clone", "repo"].includes(e.kind)));
  });
}

test("S2: a worktree created after the registry was read blocks the clone and the repo", async (t) => {
  const f = fixture(t);
  const { git } = await realClone(f);
  const late = join(runFolder(f), "late-worktree");
  let listed = false;
  let created = false;
  f.deps.exec = async (cmd, args, opts) => {
    if (args[0] === "worktree" && args[1] === "list") listed = true;
    if (listed && !created && opts?.cwd === f.record.repoDir && args.includes("--show-toplevel")) {
      created = true;
      assert.equal((await git(["worktree", "add", "-q", "--detach", late])).code, 0);
    }
    return run(cmd, args, opts);
  };
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(created);
  assert.ok(result.items.some(i => i.kind === "clone" && i.status === "blocked" && i.reason?.includes(late)), JSON.stringify(result));
  assert.ok(result.items.some(i => i.kind === "repo" && i.status === "blocked"));
  assert.ok(existsSync(late));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(!f.effects.includes("delete-repo"));
  assert.ok(!journalOf(f).some(e => ["removing", "removed"].includes(e.action) && ["clone", "repo"].includes(e.kind)));
});

for (const column of ["workspaces.source_path", "workspace_checkout_bindings.checkout_path", "worktrees.path"] as const) {
  test(`M2: an app reference in ${column} that spells the worktree in another case protects it`, async (t) => {
    const f = fixture(t);
    const { git } = await realClone(f);
    const linked = join(runFolder(f), "MixedCase");
    assert.equal((await git(["worktree", "add", "-q", "--detach", linked])).code, 0);
    const alias = join(runFolder(f), "mixedcase");
    if (!existsSync(alias)) { t.skip("case-sensitive filesystem"); return; }
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(f.home, "app.db");
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE projects(id TEXT, main_repo_path TEXT, name TEXT);
      CREATE TABLE project_checkouts(project_id TEXT, host_id TEXT, root_resource_uri TEXT);
      CREATE TABLE worktrees(id TEXT, project_id TEXT, path TEXT);
      CREATE TABLE reusable_worktree_pool(id TEXT, project_id TEXT, path TEXT);
      CREATE TABLE workspaces(id TEXT, source_path TEXT);
      CREATE TABLE workspace_checkout_bindings(workspace_id TEXT, checkout_path TEXT);
    `);
    const [table, field] = column.split(".");
    db.prepare(table === "worktrees" ? `INSERT INTO worktrees VALUES('w', 'other-project', ?)` :
      `INSERT INTO ${table}(${table === "workspaces" ? "id" : "workspace_id"}, ${field}) VALUES('workspace-9', ?)`).run(alias);
    db.close();
    const app = openCleanupApp(path);
    f.deps.app.projectsForPath = p => app.projectsForPath(p);
    f.deps.app.workspacesForPath = p => app.workspacesForPath(p);
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.target === linked && i.status === "blocked"), JSON.stringify(result));
    assert.ok(existsSync(linked));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

// S3: one test per guard, so removing any single guard fails a test.
test("S3: an archive record of another run identity does not verify the current logs", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  rewriteJournal(f, e => e.action === "archived" ? { ...e, identity: "another-run" } : e);
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(report.items.filter(i => i.kind === "archive").every(i => i.status !== "archived"), JSON.stringify(report));
  assertKeep(report);
});

test("S3: an archive record whose file is outside the session archive folder does not verify", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const outside = join(f.dir, "elsewhere.gz");
  writeFileSync(outside, readFileSync(join(archiveDir(f), "events.jsonl.gz")));
  rewriteJournal(f, e => e.action === "archived" && e.source === join(sessionDir(f), "events.jsonl") ? { ...e, target: outside } : e);
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.notEqual(report.items.find(i => i.kind === "archive" && i.target === sessionDir(f))?.status, "archived");
  assertKeep(report);
});

test("S3: a valid gzip of other content does not verify the current logs", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  writeFileSync(join(archiveDir(f), "events.jsonl.gz"), gzipSync("other content\n"));
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.notEqual(report.items.find(i => i.kind === "archive" && i.target === sessionDir(f))?.status, "archived");
  assertKeep(report);
});

test("S3: a symlinked archive file does not verify the current logs", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const copy = join(f.home, "copy.gz");
  writeFileSync(copy, readFileSync(join(archiveDir(f), "events.jsonl.gz")));
  rmSync(join(archiveDir(f), "events.jsonl.gz"));
  symlinkSync(copy, join(archiveDir(f), "events.jsonl.gz"));
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.notEqual(report.items.find(i => i.kind === "archive" && i.target === sessionDir(f))?.status, "archived");
  assertKeep(report);
});

test("S3: a dry run keeps the project when the app lists a session that --yes has not saved", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const later = "33333333-3333-4333-8333-333333333333";
  const inventory = f.deps.app.inventory;
  f.deps.app.inventory = record => { const live = inventory(record); return { ...live, sessions: [...live.sessions, later] }; };
  assertKeep(await cleanupBatch(f.config, f.state, {}, f.deps));
});

for (const [name, output] of [
  // Valid output with a failing exit code, so only the exit-code check can catch it.
  ["a failed git worktree list", (f: ReturnType<typeof fixture>) => ({ code: 1, stdout: `worktree ${f.record.repoDir}\0HEAD x\0\0worktree ${f.worktree}\0HEAD x\0\0`, stderr: "fatal" })],
  ["a registry whose first entry is another folder", (f: ReturnType<typeof fixture>) => ({ code: 0, stdout: `worktree /elsewhere\0HEAD x\0\0worktree ${f.worktree}\0HEAD x\0\0`, stderr: "" })],
] as const) {
  test(`S3: ${name} blocks the run before anything on disk is deleted`, async (t) => {
    const f = fixture(t);
    await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    f.appState.project = false;
    f.appState.session = false;
    const exec = f.deps.exec;
    f.deps.exec = async (cmd, args, opts) => args[0] === "worktree" && args[1] === "list" ? output(f) : exec(cmd, args, opts);
    const result = await cleanupBatch(f.config, f.state, { yes: true, force: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "clone" && i.status === "blocked" && /linked worktrees/.test(i.reason ?? "")), JSON.stringify(result));
    assert.ok(existsSync(f.worktree));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

for (const scenario of ["an existing admin folder of another clone", "a missing admin folder in this clone", "an invalid clone"] as const) {
  test(`S3: a linked worktree with ${scenario} is not removed`, async (t) => {
    const f = fixture(t);
    const { git, calls } = await realClone(f);
    const linked = join(runFolder(f), "copilot-prewarm-x");
    assert.equal((await git(["worktree", "add", "-q", "--detach", linked])).code, 0);
    if (scenario === "an existing admin folder of another clone") {
      const foreign = join(f.home, "other/.git/worktrees/x");
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(linked, ".git"), `gitdir: ${foreign}\n`);
    }
    if (scenario === "a missing admin folder in this clone") writeFileSync(join(linked, ".git"), `gitdir: ${join(f.record.repoDir, ".git/worktrees/missing")}\n`);
    if (scenario === "an invalid clone") assert.equal((await git(["remote", "set-url", "origin", "https://github.com/ncksol/other.git"])).code, 0);
    const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.target === linked && i.status === "blocked"), JSON.stringify(result));
    assert.ok(existsSync(linked));
    assert.ok(!calls.some(call => call.includes("worktree remove")));
  });
}

for (const [name, fake] of [
  ["fails after removing the folder", "remove-then-fail"],
  ["reports success but leaves the folder", "succeed-without-removing"],
] as const) {
  test(`S3: git worktree remove that ${name} blocks the clone`, async (t) => {
    const f = fixture(t);
    const { git } = await realClone(f);
    const linked = join(runFolder(f), "copilot-prewarm-x");
    assert.equal((await git(["worktree", "add", "-q", "--detach", linked])).code, 0);
    f.deps.exec = async (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        if (fake === "remove-then-fail") await run(cmd, args, opts);
        return { code: fake === "remove-then-fail" ? 1 : 0, stdout: "", stderr: "" };
      }
      return run(cmd, args, opts);
    };
    const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
    assert.ok(result.items.some(i => i.kind === "worktree" && i.target === linked && i.status === "blocked" && /git could not remove/.test(i.reason ?? "")), JSON.stringify(result));
    assert.ok(existsSync(f.record.repoDir));
    assert.ok(!f.effects.includes("delete-repo"));
  });
}

test("S3: a file that appears in the run folder after the emptiness check is never deleted", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  const io = await import("node:fs");
  const late = join(runFolder(f), "late.txt");
  f.deps.fs = { ...io, readdirSync: ((path: string, ...rest: unknown[]) => {
    const names = (io.readdirSync as (...a: unknown[]) => string[])(path, ...rest);
    if (path === runFolder(f) && names.length === 0) writeFileSync(late, "arrived late");
    return names;
  }) as typeof io.readdirSync };
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(readFileSync(late, "utf8"), "arrived late");
  assert.ok(result.items.some(i => i.kind === "worktree-parent" && i.status === "blocked"), JSON.stringify(result));
});

// Opus panel nits and the batch 20261022-2041 repo 404 case.
test("N1: the KEEP line names worktrees or sessions that the app lists but --yes has not saved", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const inventory = f.deps.app.inventory;
  f.deps.app.inventory = record => { const live = inventory(record); return { ...live, worktrees: [...live.worktrees, join(runFolder(f), "copilot-prewarm-b")] }; };
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(report.items.filter(i => i.kind === "archive").every(i => i.status === "archived"));
  assert.match(nextSteps(report), /KEEP project .*: the app now lists worktrees or sessions that --yes has not saved; run --yes again before removing it/);
});

test("N3: an already empty run folder says --yes removes it; a non-empty one says what to do", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  f.appState.project = false;
  f.appState.session = false;
  const pending = (await cleanupBatch(f.config, f.state, {}, f.deps)).items.find(i => i.kind === "worktree-parent");
  assert.match(pending?.reason ?? "", /^Empty once this run's worktrees are removed/);
  rmSync(f.worktree, { recursive: true });
  rmSync(join(f.record.repoDir, ".git/worktrees/branch"), { recursive: true });
  const empty = (await cleanupBatch(f.config, f.state, {}, f.deps)).items.find(i => i.kind === "worktree-parent");
  assert.match(empty?.reason ?? "", /^Empty; --yes removes this folder \(not recursive\)/);
  writeFileSync(join(runFolder(f), "notes.txt"), "x");
  const kept = (await cleanupBatch(f.config, f.state, {}, f.deps)).items.find(i => i.kind === "worktree-parent");
  assert.match(kept?.reason ?? "", /inspect it, delete it by hand if you don't need it, then rerun cleanup/);
});

test("N4: a project that is safe to remove is labelled ACTION, and the exit status still counts it", async (t) => {
  const f = fixture(t);
  await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  const report = await cleanupBatch(f.config, f.state, {}, f.deps);
  const output = formatCleanup(report);
  assert.match(output, /^ACTION app-project project-5: Available logs archived and verified/m);
  assert.doesNotMatch(output, /^BLOCKED app-project/m);
  assert.equal(report.items.find(i => i.kind === "app-project")?.status, "blocked");
  const keep = formatCleanup(await cleanupBatch(f.config, f.state, {}, { ...f.deps, app: { ...f.deps.app, sessionRunning: () => true } }));
  assert.match(keep, /^BLOCKED app-project project-5: KEEP/m);
});

test("a repo the current gh login cannot see does not block a dry run, and --yes with the owner's login finishes", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  f.deps.repo = async () => { throw new RepoNotVisible(); };
  const preview = await cleanupBatch(f.config, f.state, {}, f.deps);
  assert.ok(!preview.items.some(i => i.status === "blocked"), JSON.stringify(preview.items.filter(i => i.status === "blocked")));
  for (const kind of ["clone", "kickoff"]) assert.ok(preview.items.some(i => i.kind === kind && i.status === "present"), kind);
  const repo = preview.items.find(i => i.kind === "repo");
  assert.equal(repo?.status, "present");
  assert.match(repo?.reason ?? "", /not visible to the current gh login; --yes rechecks with the owner's login/i);
  assert.match(nextSteps(preview), /rerun this batch with --yes/);
  // --yes: under the verified owner's login with repo scope, a 404 is absence.
  f.deps.repo = async () => null;
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.equal(existsSync(f.record.repoDir), false);
  assert.equal(existsSync(`${f.record.repoDir}.kickoff.md`), false);
  assert.equal(result.items.find(i => i.kind === "repo")?.status, "already gone");
});

test("a repo the owner's login cannot see still blocks --yes", async (t) => {
  const f = fixture(t);
  f.appState.project = false;
  f.appState.session = false;
  f.deps.repo = async () => { throw new RepoNotVisible(); };
  const result = await cleanupBatch(f.config, f.state, { yes: true }, f.deps);
  assert.ok(result.items.some(i => i.kind === "repo" && i.status === "blocked" && /not found or not visible/.test(i.reason ?? "")));
  assert.ok(existsSync(f.record.repoDir));
  assert.ok(existsSync(`${f.record.repoDir}.kickoff.md`));
});
