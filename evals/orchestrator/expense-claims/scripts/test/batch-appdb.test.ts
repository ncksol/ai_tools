import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { APP_DB_COLUMNS, openAppDb } from "../lib/batch/appdb.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-appdb-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

// A synthetic database with the app's tables, minus any columns named in `drop`.
function makeDb(name: string, drop: string[] = []): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  const extra: Record<string, string[]> = { sessions: ["title", "model"], workspaces: ["branch"], projects: ["name"] };
  for (const [table, columns] of Object.entries(APP_DB_COLUMNS)) {
    const keep = [...new Set([...columns, ...extra[table]])].filter((column) => !drop.includes(`${table}.${column}`));
    const type = (column: string) => (["auto_approve", "was_interrupted"].includes(column) ? "INTEGER" : "TEXT");
    db.exec(`CREATE TABLE ${table} (${keep.map((column) => `${column} ${type(column)}`).join(", ")})`);
  }
  const insert = (table: string, values: Record<string, string | number>) => {
    const have = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);
    const cols = Object.keys(values).filter((column) => have.includes(column));
    db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...cols.map((column) => values[column]));
  };
  insert("projects", { id: "p1", auto_approve: 1, name: "orch-eval-a-1" });
  insert("workspaces", { id: "w1", session_id: "s1", project_id: "p1", name: "run", archived_at: "", created_by: "agent", created_at: "2026-10-19T22:00:00.000Z", creator_session_id: "", coordinating_creator_session_id: "" });
  insert("sessions", { id: "s1", was_interrupted: 1, interruption_reason: "shutdown", title: "x", model: "m" });
  db.close();
  return path;
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("every lookup the runner uses works on the full schema, and the file is never written", () => {
  const path = makeDb("full.db");
  const before = sha(path);
  const db = openAppDb(path);
  assert.deepEqual(db.probe(), []);
  assert.equal(db.sessionForWorkspace("w1"), "s1");
  assert.equal(db.workspaceForSession("s1"), "w1");
  assert.equal(db.projectAutoApprove("p1"), 1);
  assert.deepEqual(db.interruption("s1"), { wasInterrupted: true, reason: "shutdown" });
  assert.deepEqual(db.workspaces("p1"), [{ id: "w1", sessionId: "s1", name: "run", archivedAt: null, createdBy: "agent", createdAt: "2026-10-19T22:00:00.000Z" }]);
  assert.deepEqual(db.creatorLinks("w1"), { creator: null, coordinator: null, createdBy: "agent" });
  assert.deepEqual(db.takeErrors(), []);
  assert.equal(sha(path), before);
});

test("a missing column loses only its own value: was_interrupted still reads, and the failure is reported", () => {
  const path = makeDb("drift.db", ["sessions.interruption_reason", "workspaces.name"]);
  const db = openAppDb(path);
  assert.deepEqual(db.probe(), ["column workspaces.name is missing", "column sessions.interruption_reason is missing"]);
  assert.deepEqual(db.interruption("s1"), { wasInterrupted: true, reason: null });
  assert.equal(db.workspaces("p1")?.[0].sessionId, "s1");
  assert.equal(db.workspaces("p1")?.[0].name, null);
  const errors = db.takeErrors();
  assert.ok(errors.some((e) => /^sessions\.interruption_reason: .*no such column/.test(e)), errors.join(" | "));
  assert.ok(errors.some((e) => /^workspaces\.name: /.test(e)));
  assert.deepEqual(db.takeErrors(), [], "errors are handed over once");
});

test("a missing database is reported, not thrown", () => {
  const db = openAppDb(join(dir, "missing.db"));
  assert.equal(db.interruption("s1"), null);
  assert.match(db.takeErrors()[0], /missing\.db not found/);
  assert.ok(db.probe().length > 0);
});
