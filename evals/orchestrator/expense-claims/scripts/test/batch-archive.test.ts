import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { saveState } from "../lib/batch/state.ts";
import { harness } from "./fixtures/batch.ts";

test("scoring preserves swarm logs before sending stop or running cleanup", async (t) => {
  const h = await harness({ scenarios: ["timeout-runaway"] });
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const action = await h.until(a => a.action === "send_message");
  assert.equal(action.action, "send_message");
  const run = h.state().runs[0];
  assert.ok(run.scoredAt);
  const sessions = [run.sessionId!, ...h.app.childSessions(run.sessionId!)];
  assert.ok(sessions.length > 1, "the fixture includes descendants");
  for (const session of sessions) {
    for (const name of ["events.jsonl", "workspace.yaml"]) {
      const source = readFileSync(join(h.config.stateDir, session, name));
      const dest = join(h.config.dir, "sessions", run.name, session, `${name}.gz`);
      assert.ok(existsSync(dest), `missing ${session}/${name} archive`);
      assert.deepEqual(gunzipSync(readFileSync(dest)), source);
    }
  }
});

test("an archive failure is recorded without stopping the unattended batch", async (t) => {
  const h = await harness({ scenarios: ["ask-final"] });
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  writeFileSync(join(h.config.dir, "sessions"), "not a directory");
  const done = await h.until(() => false);
  assert.equal(done.action, "done");
  const state = h.state();
  assert.equal(state.phase, "done");
  assert.ok(state.runs[0].row);
  assert.ok(state.runs[0].flags.some(f => f.code === "archive-failed"));
  assert.match(readFileSync(state.reportPath!, "utf8"), /archive-failed/);
});

test("scoring archives cross-project descendants and aliases from the read-only app inventory", async (t) => {
  const h = await harness({ scenarios: ["ask-final"] });
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const judge = await h.until(a => a.action === "judge_idle" && a.target === "run");
  const run = h.state().runs[0];
  const db = new DatabaseSync(h.config.appDb);
  try {
    db.exec(`
      CREATE TABLE projects (id TEXT, main_repo_path TEXT, name TEXT);
      CREATE TABLE worktrees (project_id TEXT, path TEXT);
      CREATE TABLE reusable_worktree_pool (project_id TEXT, path TEXT);
      CREATE TABLE workspaces (id TEXT, project_id TEXT, session_id TEXT, name TEXT, archived_at TEXT, creator_session_id TEXT, coordinating_creator_session_id TEXT);
      CREATE TABLE workspace_session_aliases (workspace_id TEXT, session_id TEXT);
    `);
    db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(run.projectId!, run.repoDir, run.name);
    db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, 'root', NULL, NULL, NULL)").run(run.appSessionId!, run.projectId!, run.sessionId!);
    db.prepare("INSERT INTO workspaces VALUES ('child-ws', 'other-project', 'child-cli', 'child', NULL, ?, NULL)").run(run.appSessionId!);
    db.exec(`
      INSERT INTO workspace_session_aliases VALUES ('child-ws', 'child-alias');
      INSERT INTO workspaces VALUES ('grandchild-ws', 'other-project', 'grandchild-cli', 'grandchild', NULL, NULL, 'child-alias');
      INSERT INTO workspaces VALUES ('never-started-ws', 'other-project', NULL, 'never started', NULL, 'child-ws', NULL);
    `);
  } finally { db.close(); }
  const before = readFileSync(h.config.appDb);
  for (const id of ["child-cli", "child-alias", "grandchild-cli"]) {
    mkdirSync(join(h.config.stateDir, id));
    writeFileSync(join(h.config.stateDir, id, "events.jsonl"), `{"evidence":"${id}"}\n`);
    writeFileSync(join(h.config.stateDir, id, "workspace.yaml"), `id: ${id}\n`);
  }
  delete h.ctx.deps.archiveInventory;
  await h.drive(judge);
  await h.until(() => false);
  for (const id of ["child-cli", "child-alias", "grandchild-cli"]) {
    assert.equal(gunzipSync(readFileSync(join(h.config.dir, "sessions", run.name, id, "events.jsonl.gz"))).toString(), `{"evidence":"${id}"}\n`);
  }
  assert.deepEqual(readFileSync(h.config.appDb), before);
  assert.ok(!h.state().runs[0].flags.some(f => f.code === "archive-failed"));
  assert.equal(existsSync(join(h.config.dir, "sessions", run.name, "never-started-ws")), false);
});

test("a row adopted after a runner restart is archived without being scored again", async (t) => {
  const h = await harness({ scenarios: ["stall"] });
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const judge = await h.until(a => a.action === "judge_idle" && a.target === "run");
  await h.drive(judge);
  const state = h.state();
  const run = state.runs[0];
  Object.assign(run, { status: "scoring", endReason: "stalled" });
  saveState(h.config.dir, state);
  await h.ctx.deps.exec(process.execPath, [h.config.scoreScript, "--repo-dir", run.repoDir, "--session", run.sessionId!, "--outcome", "stalled"]);
  const stop = await h.until(a => a.action === "send_message");
  assert.equal(stop.action, "send_message");
  assert.equal(h.scoreCalls.length, 1);
  assert.ok(existsSync(join(h.config.dir, "sessions", run.name, run.sessionId!, "events.jsonl.gz")));
});

test("failed discovery still copies known logs and marks the snapshot incomplete", async (t) => {
  const h = await harness({ scenarios: ["ask-final"] });
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  h.ctx.deps.archiveInventory = () => { throw new Error("missing DB column"); };
  await h.until(() => false);
  const run = h.state().runs[0];
  assert.ok(existsSync(join(h.config.dir, "sessions", run.name, run.sessionId!, "events.jsonl.gz")));
  assert.ok(run.flags.some(f => f.code === "archive-failed" && /missing DB column/.test(f.detail)));
  const receipts = readFileSync(join(h.config.dir, "sessions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(!receipts.some(e => e.action === "inventory"), "failed discovery must not masquerade as a saved swarm inventory");
});
