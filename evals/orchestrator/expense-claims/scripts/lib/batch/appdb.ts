// Read-only lookups in the app's private database (~/.copilot/data.db). It has no contract, so each
// column is read with its own query: a renamed or missing column then loses only its own value, and
// the failure is collected (takeErrors) so the runner can flag it. Never writes.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface WorkspaceRow {
  id: string;
  sessionId: string | null;
  name: string | null;
  archivedAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface Interruption {
  wasInterrupted: boolean | null;
  reason: string | null;
}

export interface AppDb {
  sessionForWorkspace(appSessionId: string): string | null;
  workspaceForSession(sessionId: string): string | null;
  interruption(sessionId: string): Interruption | null;
  workspaces(projectId: string): WorkspaceRow[] | null;
  creatorLinks(appSessionId: string): { creator: string | null; coordinator: string | null; createdBy: string | null } | null;
  childSessions(sessionId: string): string[] | null;
  sessionAliases(sessionId: string): string[] | null;
  // True when the workspace exists but never got a CLI session (initialization failed). Null: lookup failed.
  workspaceNeverStarted(appSessionId: string): boolean | null;
  // The login of the app's default account, which projects with no account of their own use.
  defaultAccount(): string | null;
  // The login a project's sessions run as.
  projectAccount(projectId: string): string | null;
  // Only the user's local-host acceptance counts. Null means the lookup failed.
  projectTrusted(projectId: string): boolean | null;
  // Null: no project at this exact clone path. Undefined: failed/ambiguous lookup; do not create.
  projectForPath(path: string): string | null | undefined;
  // Every table and column the runner reads, checked against the database's schema.
  probe(): string[];
  // Query failures since the last call, for flags.
  takeErrors(): string[];
}

// The columns the runner reads. probe() checks each one exists.
export const APP_DB_COLUMNS: Record<string, string[]> = {
  workspaces: ["id", "session_id", "project_id", "name", "archived_at", "created_by", "created_at", "creator_session_id", "coordinating_creator_session_id", "is_initialized"],
  projects: ["id", "main_repo_path", "copilot_account_id", "github_account_id"],
  accounts: ["id", "login", "is_default"],
  sessions: ["id", "was_interrupted", "interruption_reason"],
  workspace_session_aliases: ["session_id", "workspace_id"],
  project_host_trust: ["project_id", "host_id", "trusted_config_sha256", "trusted_config_accepted_at"],
};

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function openAppDb(path: string): AppDb {
  const errors = new Set<string>();
  const withDb = <T>(what: string, fn: (db: DatabaseSync) => T): T | undefined => {
    if (!existsSync(path)) {
      errors.add(`${path} not found`);
      return undefined;
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      return fn(db);
    } catch (error) {
      errors.add(`${what}: ${(error as Error).message}`);
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {
        // already closed
      }
    }
  };
  // One column of one row; undefined when the query failed, null when there is no such row.
  const cell = (table: string, column: string, key: string, value: string): unknown =>
    withDb(`${table}.${column}`, (db) => {
      const row = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${key} = ?`).get(value) as { v: unknown } | undefined;
      return row ? row.v : null;
    });
  const workspaceId = (id: string) => text(cell("workspaces", "id", "session_id", id)) ??
    text(cell("workspace_session_aliases", "workspace_id", "session_id", id));

  const login = (accountId: string) => text(cell("accounts", "login", "id", accountId));
  const defaultAccount = () => text(withDb("accounts.login by is_default", (db) =>
    (db.prepare("SELECT login AS v FROM accounts WHERE is_default = 1").get() as { v: unknown } | undefined)?.v ?? null));

  return {
    sessionForWorkspace: (id) => text(cell("workspaces", "session_id", "id", id)),
    workspaceForSession: workspaceId,
    interruption: (id) => {
      const was = cell("sessions", "was_interrupted", "id", id);
      if (was === undefined || was === null) return null;
      const reason = cell("sessions", "interruption_reason", "id", id);
      return { wasInterrupted: Number(was) === 1, reason: text(reason) };
    },
    workspaces: (projectId) => {
      const ids = withDb("workspaces.id by project_id", (db) =>
        (db.prepare("SELECT id FROM workspaces WHERE project_id = ?").all(projectId) as { id: unknown }[]).map((row) => String(row.id)),
      );
      if (!ids) return null;
      return ids.map((id) => ({
        id,
        sessionId: text(cell("workspaces", "session_id", "id", id)),
        name: text(cell("workspaces", "name", "id", id)),
        archivedAt: text(cell("workspaces", "archived_at", "id", id)),
        createdBy: text(cell("workspaces", "created_by", "id", id)),
        createdAt: text(cell("workspaces", "created_at", "id", id)),
      }));
    },
    creatorLinks: (id) => {
      const exists = cell("workspaces", "id", "id", id);
      if (!exists) return null;
      return {
        creator: text(cell("workspaces", "creator_session_id", "id", id)),
        coordinator: text(cell("workspaces", "coordinating_creator_session_id", "id", id)),
        createdBy: text(cell("workspaces", "created_by", "id", id)),
      };
    },
    childSessions: (id) => {
      const workspace = workspaceId(id);
      const ids = withDb("workspaces.id by creator", (db) =>
        (db.prepare("SELECT id FROM workspaces WHERE creator_session_id IN (?, ?) OR coordinating_creator_session_id IN (?, ?)")
          .all(id, workspace ?? id, id, workspace ?? id) as { id: unknown }[]).map((row) => String(row.id)),
      );
      return ids ? ids.map((child) => text(cell("workspaces", "session_id", "id", child)) ?? child) : null;
    },
    sessionAliases: (id) => {
      const workspace = workspaceId(id);
      if (!workspace) return [];
      const aliases = withDb("workspace_session_aliases.session_id by workspace_id", (db) =>
        (db.prepare("SELECT session_id FROM workspace_session_aliases WHERE workspace_id = ?")
          .all(workspace) as { session_id: unknown }[]).map((row) => String(row.session_id)),
      );
      if (!aliases) return null;
      const current = text(cell("workspaces", "session_id", "id", workspace));
      return [...new Set([...aliases, ...(current ? [current] : [])])].filter((alias) => alias !== id);
    },
    workspaceNeverStarted: (id) => {
      const initialized = cell("workspaces", "is_initialized", "id", id);
      const session = cell("workspaces", "session_id", "id", id);
      if (initialized === undefined || session === undefined) return null;
      return initialized !== null && Number(initialized) === 0 && session === null;
    },
    defaultAccount,
    // As observed in the app: the project's Copilot account, else its GitHub account, else the default.
    projectAccount: (id) => {
      const pinned = text(cell("projects", "copilot_account_id", "id", id)) ?? text(cell("projects", "github_account_id", "id", id));
      return pinned ? login(pinned) : defaultAccount();
    },
    projectTrusted: (id) => {
      const trustCell = (column: string) => withDb(`project_host_trust.${column}`, (db) =>
        (db.prepare(`SELECT ${column} AS v FROM project_host_trust WHERE project_id = ? AND host_id = 'local'`)
          .get(id) as { v: unknown } | undefined)?.v ?? null);
      const hash = trustCell("trusted_config_sha256");
      const accepted = trustCell("trusted_config_accepted_at");
      if (hash === undefined || accepted === undefined) return null;
      return Boolean(text(hash) && text(accepted));
    },
    projectForPath: (path) => withDb("projects.id by main_repo_path", (db) => {
      const rows = db.prepare("SELECT id FROM projects WHERE main_repo_path = ?").all(path) as { id: unknown }[];
      if (rows.length > 1) throw new Error(`multiple projects have clone path ${path}`);
      return rows.length === 0 ? null : text(rows[0].id) ?? undefined;
    }),
    probe: () => {
      const problems: string[] = [];
      for (const [table, columns] of Object.entries(APP_DB_COLUMNS)) {
        const have = withDb(`schema of ${table}`, (db) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
        if (!have) {
          problems.push(`cannot read the schema of ${table}`);
          continue;
        }
        if (have.length === 0) problems.push(`table ${table} is missing`);
        else for (const column of columns) if (!have.includes(column)) problems.push(`column ${table}.${column} is missing`);
      }
      return problems;
    },
    takeErrors: () => {
      const list = [...errors];
      errors.clear();
      return list;
    },
  };
}

// For dry runs: answers nothing, like a database that can't be read.
export const noAppDb: AppDb = {
  sessionForWorkspace: () => null,
  workspaceForSession: () => null,
  interruption: () => null,
  workspaces: () => null,
  creatorLinks: () => null,
  childSessions: () => null,
  sessionAliases: () => null,
  workspaceNeverStarted: () => null,
  defaultAccount: () => null,
  projectAccount: () => null,
  projectTrusted: () => null,
  projectForPath: () => null,
  probe: () => ["no app database (dry run)"],
  takeErrors: () => [],
};
