import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { withReadOnly } from '../sqlite.mjs';

export function readWorkspaceYaml(dir) {
  let text;
  try {
    text = readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
  } catch {
    return null;
  }
  const fields = { cwd: 'cwd', branch: 'branch', host_type: 'hostType', repository: 'repository' };
  const out = { cwd: null, branch: null, hostType: null, repository: null };
  for (const line of text.split(/\r?\n/)) {
    const match = /^(cwd|branch|host_type|repository):[ \t]*(.*)$/.exec(line);
    if (match) out[fields[match[1]]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return out;
}

export function listLocks(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const locks = [];
  for (const name of names) {
    const match = /^inuse\.(\d+)\.lock$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) continue;
    try {
      locks.push({ pid, mtimeMs: Math.round(statSync(path.join(dir, name)).mtimeMs) });
    } catch {
      // removed between readdir and stat
    }
  }
  return locks;
}

export const SESSION_DB_QUERIES = Object.freeze({
  todos: 'SELECT id, title, description, status FROM todos',
  deps: 'SELECT todo_id, depends_on FROM todo_deps',
  tables: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('todos', 'todo_deps', 'children')",
  children: `SELECT unit, session_id, title, todo_id, branch, base_branch, pr_provider, pr_repo, pr_id, pr_url, outcome,
    created_at, updated_at, ended_at FROM children`,
});

/** `source` is either openReadOnly's options or a reader from createSqliteReader (which holds live WAL connections). */
export async function readSessionDb(file, source = {}) {
  const run = typeof source.read === 'function' ? fn => source.read(file, fn) : fn => withReadOnly(file, source, fn);
  return run(async db => {
    const safe = async sql => {
      try {
        return await db.all(sql);
      } catch {
        return null;
      }
    };
    // Ask which tables exist first, so a normal read never runs a statement that fails (a failed statement discards a pooled connection).
    const present = new Set(((await safe(SESSION_DB_QUERIES.tables)) ?? []).map(row => row.name));
    const todos = present.has('todos') ? (await safe(SESSION_DB_QUERIES.todos)) ?? [] : [];
    const deps = present.has('todo_deps') ? (await safe(SESSION_DB_QUERIES.deps)) ?? [] : [];
    const hasChildren = present.has('children');
    return {
      todos: todos.map(todo => ({
        id: String(todo.id), title: String(todo.title ?? ''), description: typeof todo.description === 'string' ? todo.description : '',
        status: String(todo.status ?? 'pending'),
      })),
      deps: deps.map(dep => ({ todoId: String(dep.todo_id), dependsOn: String(dep.depends_on) })),
      children: hasChildren ? await safe(SESSION_DB_QUERIES.children) : null,
    };
  });
}

export function createSessionDbCache(read = readSessionDb) {
  const cache = new Map();
  async function get(file, sqliteOptions) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      cache.delete(file);
      return null;
    }
    let key = `${stat.mtimeMs}:${stat.size}`;
    try {
      const wal = statSync(`${file}-wal`);
      key += `|${wal.mtimeMs}:${wal.size}`;
    } catch {
      // no WAL file
    }
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value;
    const value = await read(file, sqliteOptions);
    cache.set(file, { key, value });
    return value;
  }
  /** The last value read successfully for this file, or undefined. */
  get.last = file => cache.get(file)?.value;
  get.retain = files => {
    for (const file of [...cache.keys()]) if (!files.has(file)) cache.delete(file);
  };
  return get;
}
