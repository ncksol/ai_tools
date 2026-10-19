import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bindLiterals } from '../../engine/sqlite.mjs';
import { execSql } from './sqlite-writer.mjs';
import { tempDir } from './temp.mjs';

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

const APP_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, github_owner TEXT, github_repo TEXT, main_repo_path TEXT);
CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT, path TEXT, branch TEXT, base_branch TEXT, created_at TEXT);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, worktree_id TEXT, workspace_type TEXT, branch TEXT, name TEXT,
  created_at TEXT, updated_at TEXT, archived_at TEXT, session_id TEXT, created_by TEXT, creator_session_id TEXT,
  coordinating_creator_session_id TEXT, created_pr_repo_full_name TEXT, created_pr_number INTEGER, created_pr_html_url TEXT,
  created_pr_state TEXT, created_pr_merged_at TEXT);
CREATE TABLE workspace_parent_links (child_workspace_id TEXT PRIMARY KEY, parent_workspace_id TEXT, creator_session_id TEXT, created_at TEXT);
CREATE TABLE workspace_session_aliases (session_id TEXT PRIMARY KEY, workspace_id TEXT, created_at TEXT);
CREATE TABLE chat_parent_links (session_id TEXT PRIMARY KEY, parent_session_id TEXT, coordinating_creator_session_id TEXT, notify_creator_on_idle TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, session_type TEXT, mode TEXT, model TEXT, reasoning_effort TEXT,
  is_running INTEGER, was_interrupted INTEGER, created_at TEXT, updated_at TEXT, archived_at TEXT, total_nano_aiu INTEGER, agent TEXT);
CREATE TABLE session_automations (session_id TEXT PRIMARY KEY, prompt TEXT, interval TEXT, every_minutes INTEGER, schedule_hour INTEGER,
  schedule_day INTEGER, last_run_at TEXT, next_run_at TEXT, updated_at TEXT, name TEXT, owner_session_id TEXT, paused_at TEXT);
CREATE TABLE settings (id INTEGER PRIMARY KEY, github_token TEXT);
INSERT INTO settings (github_token) VALUES ('fixture-secret-must-never-be-read');
`;

const STORE_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT,
  parent_tool_call_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_nano_aiu INTEGER, duration_ms INTEGER,
  initiator TEXT, created_at TEXT);
CREATE INDEX idx_assistant_usage_events_session ON assistant_usage_events (session_id, id);
`;

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'blocked')),
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS todo_deps (todo_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (todo_id, depends_on));
`;

/** The children registry from the design's section 10, verbatim. */
export const CHILDREN_SCHEMA = `
CREATE TABLE IF NOT EXISTS children (
  unit TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, todo_id TEXT, branch TEXT, base_branch TEXT,
  pr_provider TEXT CHECK (pr_provider IN ('ado', 'github')), pr_repo TEXT, pr_id INTEGER, pr_url TEXT,
  outcome TEXT CHECK (outcome IN ('merged', 'closed', 'failed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
`;

/** A synthetic ~/.copilot folder. Every value in it is invented for tests. */
export class CopilotHome {
  constructor(root = tempDir('swarm-home-')) {
    this.root = root;
    this.dataDb = path.join(root, 'data.db');
    this.storeDb = path.join(root, 'session-store.db');
    this.stateDir = path.join(root, 'session-state');
    mkdirSync(this.stateDir, { recursive: true });
    execSql(this.dataDb, APP_SCHEMA);
    execSql(this.storeDb, STORE_SCHEMA);
  }

  insert(file, table, row) {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    execSql(file, bindLiterals(sql, keys.map(key => row[key])));
  }

  dir(cliId) {
    const dir = path.join(this.stateDir, cliId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  project({ id, name, githubOwner = null, githubRepo = null }) {
    this.insert(this.dataDb, 'projects', { id, name, github_owner: githubOwner, github_repo: githubRepo, main_repo_path: '/synthetic/repo' });
  }

  workspace({ id, projectId = null, name, branch = null, createdAt, archivedAt = null, sessionId = id, parentId = null,
    creatorSessionId = null, baseBranch = null, pr = null, isRunning = false, model = 'claude-sonnet-5', agent = null, workspaceType = 'worktree' }) {
    const worktreeId = baseBranch ? `wt-${id}` : null;
    if (worktreeId) {
      this.insert(this.dataDb, 'worktrees', { id: worktreeId, project_id: projectId, path: `/synthetic/worktrees/${id}`, branch, base_branch: baseBranch, created_at: iso(createdAt) });
    }
    this.insert(this.dataDb, 'workspaces', {
      id, project_id: projectId, worktree_id: worktreeId, workspace_type: workspaceType, branch, name,
      created_at: iso(createdAt), updated_at: iso(createdAt), archived_at: iso(archivedAt), session_id: sessionId,
      created_by: parentId || creatorSessionId ? 'agent' : 'user', creator_session_id: creatorSessionId,
      coordinating_creator_session_id: parentId ? creatorSessionId : null,
      created_pr_repo_full_name: pr?.repo ?? null, created_pr_number: pr?.number ?? null, created_pr_html_url: pr?.url ?? null,
      created_pr_state: pr?.state ?? null, created_pr_merged_at: iso(pr?.mergedAt ?? null),
    });
    if (parentId) {
      this.insert(this.dataDb, 'workspace_parent_links', { child_workspace_id: id, parent_workspace_id: parentId, creator_session_id: creatorSessionId, created_at: iso(createdAt) });
    }
    this.alias(sessionId, id, createdAt);
    this.session({ id: sessionId, title: name, createdAt, isRunning, model, agent });
  }

  alias(sessionId, workspaceId, createdAt) {
    this.insert(this.dataDb, 'workspace_session_aliases', { session_id: sessionId, workspace_id: workspaceId, created_at: iso(createdAt) });
  }

  session({ id, title = '', createdAt, isRunning = false, model = null, mode = null, archivedAt = null, agent = null }) {
    this.insert(this.dataDb, 'sessions', {
      id, title, session_type: 'session', mode, model, reasoning_effort: null, is_running: isRunning ? 1 : 0, was_interrupted: 0,
      created_at: iso(createdAt), updated_at: iso(createdAt), archived_at: iso(archivedAt), total_nano_aiu: 0, agent,
    });
  }

  chat({ id, parentSessionId = null, title, createdAt, isRunning = false, agent = null }) {
    this.session({ id, title, createdAt, isRunning, agent });
    if (parentSessionId) {
      this.insert(this.dataDb, 'chat_parent_links', { session_id: id, parent_session_id: parentSessionId, coordinating_creator_session_id: parentSessionId, notify_creator_on_idle: 'always' });
    }
  }

  automation({ sessionId, everyMinutes = 10, lastRunAt = null, nextRunAt = null, pausedAt = null, name = 'PR monitor' }) {
    this.insert(this.dataDb, 'session_automations', {
      session_id: sessionId, prompt: 'synthetic monitor prompt', interval: 'minutes', every_minutes: everyMinutes, schedule_hour: null,
      schedule_day: null, last_run_at: iso(lastRunAt), next_run_at: iso(nextRunAt), updated_at: iso(lastRunAt ?? nextRunAt), name,
      owner_session_id: sessionId, paused_at: iso(pausedAt),
    });
  }

  usage(rows) {
    for (const row of rows) {
      this.insert(this.storeDb, 'assistant_usage_events', {
        session_id: row.sessionId, turn_index: 0, agent_id: row.agentId ?? null, parent_tool_call_id: row.parentToolCallId ?? null,
        model: row.model ?? 'claude-sonnet-5', input_tokens: 1000, output_tokens: 100, total_nano_aiu: row.nanoAiu,
        duration_ms: row.durationMs ?? 1000, initiator: row.initiator ?? 'agent', created_at: iso(row.createdAt),
      });
    }
  }

  writeEvents(cliId, events, { append = false } = {}) {
    const file = path.join(this.dir(cliId), 'events.jsonl');
    const text = events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    (append ? appendFileSync : writeFileSync)(file, text);
    const last = events.length ? Date.parse(events[events.length - 1].timestamp) : Number.NaN;
    if (Number.isFinite(last)) utimesSync(file, last / 1000, last / 1000);
    return file;
  }

  sessionDb(cliId, { todos = [], deps = [], children = null } = {}) {
    const file = path.join(this.dir(cliId), 'session.db');
    execSql(file, SESSION_SCHEMA + (children ? CHILDREN_SCHEMA : ''));
    for (const todo of todos) {
      this.insert(file, 'todos', { id: todo.id, title: todo.title ?? todo.id, description: todo.description ?? null, status: todo.status ?? 'pending' });
    }
    for (const [todoId, dependsOn] of deps) this.insert(file, 'todo_deps', { todo_id: todoId, depends_on: dependsOn });
    for (const row of children ?? []) this.insert(file, 'children', row);
    return file;
  }

  workspaceYaml(cliId, { cwd = '/synthetic/worktree', branch = null, hostType = null, repository = null } = {}) {
    const lines = [`id: ${cliId}`, `cwd: ${cwd}`, branch && `branch: ${branch}`, repository && `repository: ${repository}`, hostType && `host_type: ${hostType}`, 'name: synthetic'];
    writeFileSync(path.join(this.dir(cliId), 'workspace.yaml'), `${lines.filter(Boolean).join('\n')}\n`);
  }

  lock(cliId, pid, mtimeMs = Date.now()) {
    const file = path.join(this.dir(cliId), `inuse.${pid}.lock`);
    writeFileSync(file, String(pid));
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    writeFileSync(path.join(this.dir(cliId), `inuse.${pid}.hold`), '');
  }
}
