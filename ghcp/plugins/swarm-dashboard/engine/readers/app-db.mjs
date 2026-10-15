import { parseTime } from '../time.mjs';

/** Named columns only: data.db also holds a GitHub token column, which the engine never reads. */
export const APP_QUERIES = Object.freeze({
  projects: 'SELECT id, name, github_owner, github_repo FROM projects',
  worktrees: 'SELECT id, branch, base_branch FROM worktrees',
  workspaces: `SELECT id, project_id, worktree_id, name, branch, created_at, archived_at, session_id,
      creator_session_id, coordinating_creator_session_id,
      created_pr_repo_full_name, created_pr_number, created_pr_html_url, created_pr_state, created_pr_merged_at
    FROM workspaces`,
  parentLinks: 'SELECT child_workspace_id, parent_workspace_id FROM workspace_parent_links',
  aliases: 'SELECT session_id, workspace_id, created_at FROM workspace_session_aliases',
  chatLinks: 'SELECT session_id, parent_session_id FROM chat_parent_links',
  sessions: 'SELECT id, title, mode, model, reasoning_effort, is_running, was_interrupted, created_at, archived_at FROM sessions',
  automations: 'SELECT session_id, interval, every_minutes, last_run_at, next_run_at, paused_at, name FROM session_automations',
});

const text = value => (typeof value === 'string' && value.length ? value : null);
const count = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

export async function readAppDb(db) {
  const diagnostics = [];
  const rows = {};
  for (const [key, sql] of Object.entries(APP_QUERIES)) {
    try {
      rows[key] = await db.all(sql);
    } catch (error) {
      rows[key] = [];
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
