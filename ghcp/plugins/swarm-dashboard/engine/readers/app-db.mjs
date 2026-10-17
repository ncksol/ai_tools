import { parseTime } from '../time.mjs';

const table = (name, columns, required) => Object.freeze({ table: name, columns: Object.freeze(columns), required: Object.freeze(required) });

/**
 * Named columns only: data.db also holds a GitHub token column, which the engine never reads. data.db is the app's
 * private database with no contract, so each table is read through the columns that exist (see readAppDb).
 */
export const APP_TABLES = Object.freeze({
  projects: table('projects', ['id', 'name', 'github_owner', 'github_repo'], ['id']),
  worktrees: table('worktrees', ['id', 'branch', 'base_branch'], ['id']),
  workspaces: table('workspaces', [
    'id', 'project_id', 'worktree_id', 'name', 'branch', 'created_at', 'archived_at', 'session_id',
    'creator_session_id', 'coordinating_creator_session_id',
    'created_pr_repo_full_name', 'created_pr_number', 'created_pr_html_url', 'created_pr_state', 'created_pr_merged_at',
  ], ['id']),
  parentLinks: table('workspace_parent_links', ['child_workspace_id', 'parent_workspace_id'], ['child_workspace_id', 'parent_workspace_id']),
  aliases: table('workspace_session_aliases', ['session_id', 'workspace_id', 'created_at'], ['session_id', 'workspace_id']),
  chatLinks: table('chat_parent_links', ['session_id', 'parent_session_id'], ['session_id', 'parent_session_id']),
  sessions: table('sessions', ['id', 'title', 'mode', 'model', 'reasoning_effort', 'is_running', 'was_interrupted', 'created_at', 'archived_at'], ['id']),
  automations: table('session_automations', ['session_id', 'interval', 'every_minutes', 'last_run_at', 'next_run_at', 'paused_at', 'name'], ['session_id']),
});

/** Lists the existing columns of exactly the tables in APP_TABLES. */
export const SCHEMA_SQL = `SELECT m.name AS table_name, p.name AS column_name FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p WHERE m.type = 'table' AND m.name IN (${Object.values(APP_TABLES).map(item => `'${item.table}'`).join(', ')})`;

const text = value => (typeof value === 'string' && value.length ? value : null);
const count = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

export async function readAppDb(db) {
  const diagnostics = [];
  const rows = {};
  let present = null;
  try {
    present = new Map();
    for (const row of await db.all(SCHEMA_SQL)) {
      if (!present.has(row.table_name)) present.set(row.table_name, new Set());
      present.get(row.table_name).add(row.column_name);
    }
  } catch (error) {
    present = null;
    diagnostics.push({ level: 'warn', source: 'data.db', message: `schema: ${error.message}` });
  }
  for (const [key, { table: name, columns, required }] of Object.entries(APP_TABLES)) {
    rows[key] = [];
    let selected = columns;
    if (present) {
      const have = present.get(name);
      if (!have) {
        diagnostics.push({ level: 'warn', source: 'data.db', message: `${key}: table ${name} not found` });
        continue;
      }
      const missingRequired = required.filter(column => !have.has(column));
      if (missingRequired.length) {
        const names = columns.filter(column => missingRequired.includes(column));
        diagnostics.push({ level: 'warn', source: 'data.db', message: `${key}: missing column(s) ${names.join(', ')}` });
        continue;
      }
      selected = columns.filter(column => have.has(column));
      const absent = columns.filter(column => !have.has(column));
      if (absent.length) diagnostics.push({ level: 'info', source: 'data.db', message: `${key}: column(s) not found, read as empty: ${absent.join(', ')}` });
    }
    try {
      rows[key] = await db.all(`SELECT ${selected.join(', ')} FROM ${name}`);
    } catch (error) {
      diagnostics.push({ level: 'warn', source: 'data.db', message: `${key}: ${error.message}` });
    }
  }
  return {
    projects: new Map(rows.projects.map(row => [row.id, { id: row.id, name: row.name ?? '', githubOwner: text(row.github_owner), githubRepo: text(row.github_repo) }])),
    worktrees: new Map(rows.worktrees.map(row => [row.id, { id: row.id, branch: text(row.branch), baseBranch: text(row.base_branch) }])),
    workspaces: new Map(rows.workspaces.map(row => [row.id, {
      id: row.id, projectId: text(row.project_id), worktreeId: text(row.worktree_id), name: row.name ?? '', branch: text(row.branch),
      createdAt: parseTime(row.created_at), archivedAt: parseTime(row.archived_at), sessionId: text(row.session_id),
      creatorSessionId: text(row.creator_session_id), coordinatingCreatorSessionId: text(row.coordinating_creator_session_id),
      createdPr: count(row.created_pr_number) === null ? null : {
        repo: text(row.created_pr_repo_full_name), number: count(row.created_pr_number), url: text(row.created_pr_html_url),
        state: text(row.created_pr_state), mergedAt: parseTime(row.created_pr_merged_at),
      },
    }])),
    parentLinks: rows.parentLinks.map(row => ({ childId: row.child_workspace_id, parentId: row.parent_workspace_id })),
    aliases: rows.aliases.map(row => ({ sessionId: row.session_id, workspaceId: row.workspace_id, createdAt: parseTime(row.created_at) })),
    chatLinks: rows.chatLinks.map(row => ({ sessionId: row.session_id, parentSessionId: row.parent_session_id })),
    sessions: new Map(rows.sessions.map(row => [row.id, {
      id: row.id, title: row.title ?? '', mode: text(row.mode), model: text(row.model), reasoningEffort: text(row.reasoning_effort),
      isRunning: Number(row.is_running) === 1, wasInterrupted: Number(row.was_interrupted) === 1,
      createdAt: parseTime(row.created_at), archivedAt: parseTime(row.archived_at),
    }])),
    automations: rows.automations.map(row => ({
      sessionId: row.session_id, interval: text(row.interval), everyMinutes: count(row.every_minutes),
      lastRunAt: parseTime(row.last_run_at), nextRunAt: parseTime(row.next_run_at), pausedAt: parseTime(row.paused_at), name: text(row.name),
    })),
    diagnostics,
  };
}
