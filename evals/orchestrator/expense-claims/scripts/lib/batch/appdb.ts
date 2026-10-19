// Read-only lookups in the app's private database (~/.copilot/data.db). It has no contract, so every
// lookup is optional: a failure returns null and the runner falls back or flags. Never writes.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface WorkspaceRow {
  id: string;
  sessionId: string | null;
  name: string | null;
  archivedAt: string | null;
  createdBy: string | null;
}

export interface AppDb {
  sessionForWorkspace(appSessionId: string): string | null;
  workspaceForSession(sessionId: string): string | null;
  projectAutoApprove(projectId: string): number | null;
  sessionSettings(sessionId: string): Record<string, unknown> | null;
  workspaces(projectId: string): WorkspaceRow[] | null;
  creatorLinks(appSessionId: string): { creator: string | null; coordinator: string | null; createdBy: string | null } | null;
}

export function openAppDb(path: string): AppDb {
  const query = <T>(fn: (db: DatabaseSync) => T): T | null => {
    if (!existsSync(path)) return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      return fn(db);
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // already closed
      }
    }
  };
  const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
  return {
    sessionForWorkspace: (id) => query((db) => text((db.prepare("SELECT session_id FROM workspaces WHERE id = ?").get(id) as Record<string, unknown> | undefined)?.session_id)),
    workspaceForSession: (id) => query((db) => text((db.prepare("SELECT id FROM workspaces WHERE session_id = ?").get(id) as Record<string, unknown> | undefined)?.id)),
    projectAutoApprove: (id) =>
      query((db) => {
        const row = db.prepare("SELECT auto_approve FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
        return row && typeof row.auto_approve === "number" ? row.auto_approve : null;
      }),
    sessionSettings: (id) =>
      query((db) => {
        const row = db
          .prepare("SELECT session_type, mode, agent, model, reasoning_effort, context_tier, auto_approve, permission_mode, was_interrupted, interruption_reason FROM sessions WHERE id = ?")
          .get(id) as Record<string, unknown> | undefined;
        return row ? { ...row } : null;
      }),
    workspaces: (projectId) =>
      query((db) =>
        (db.prepare("SELECT id, session_id, name, archived_at, created_by FROM workspaces WHERE project_id = ? ORDER BY created_at").all(projectId) as Record<string, unknown>[]).map((row) => ({
          id: String(row.id),
          sessionId: text(row.session_id),
          name: text(row.name),
          archivedAt: text(row.archived_at),
          createdBy: text(row.created_by),
        })),
      ),
    creatorLinks: (id) =>
      query((db) => {
        const row = db.prepare("SELECT creator_session_id, coordinating_creator_session_id, created_by FROM workspaces WHERE id = ?").get(id) as
          | Record<string, unknown>
          | undefined;
        return row ? { creator: text(row.creator_session_id), coordinator: text(row.coordinating_creator_session_id), createdBy: text(row.created_by) } : null;
      }),
  };
}

// For tests and dry runs: answers nothing, like a database that can't be read.
export const noAppDb: AppDb = {
  sessionForWorkspace: () => null,
  workspaceForSession: () => null,
  projectAutoApprove: () => null,
  sessionSettings: () => null,
  workspaces: () => null,
  creatorLinks: () => null,
};
