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

/** Each data query's table and the columns it selects (the data contract's shape of session.db). */
export const SESSION_DB_TABLES = Object.freeze({
  todos: Object.freeze({ table: 'todos', columns: Object.freeze(['id', 'title', 'description', 'status']) }),
  deps: Object.freeze({ table: 'todo_deps', columns: Object.freeze(['todo_id', 'depends_on']) }),
  children: Object.freeze({
    table: 'children',
    columns: Object.freeze(['unit', 'session_id', 'title', 'todo_id', 'branch', 'base_branch', 'pr_provider', 'pr_repo', 'pr_id', 'pr_url',
      'outcome', 'created_at', 'updated_at', 'ended_at']),
  }),
});

const selectFrom = ({ table, columns }) => `SELECT ${columns.join(', ')} FROM ${table}`;
// The table names are constants, never data, so they can be written into the statement.
const columnsOf = ({ table }) => `SELECT name FROM pragma_table_info('${table}')`;

export const SESSION_DB_QUERIES = Object.freeze({
  todos: selectFrom(SESSION_DB_TABLES.todos),
  deps: selectFrom(SESSION_DB_TABLES.deps),
  tables: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('todos', 'todo_deps', 'children')",
  children: selectFrom(SESSION_DB_TABLES.children),
  todosColumns: columnsOf(SESSION_DB_TABLES.todos),
  depsColumns: columnsOf(SESSION_DB_TABLES.deps),
  childrenColumns: columnsOf(SESSION_DB_TABLES.children),
});

/**
 * `source` is either openReadOnly's options or a reader from createSqliteReader (which holds live WAL connections).
 * A table that is absent gives its empty value (`[]`, or `null` for children). So does a table that lacks a column its query
 * selects, such as a children table that another orchestrator version wrote; the result then has a `notes` array that names
 * each ignored table (`notes` is present only when there is a note). A query that fails, such as one that finds the database
 * busy or locked, rejects with an Error naming the query, so a caller never takes a failed read for empty tables.
 */
export async function readSessionDb(file, source = {}) {
  const run = typeof source.read === 'function' ? fn => source.read(file, fn) : fn => withReadOnly(file, source, fn);
  return run(async db => {
    const query = async name => {
      try {
        return (await db.all(SESSION_DB_QUERIES[name])) ?? [];
      } catch (error) {
        throw new Error(`session.db ${name}: ${error?.message ?? error}`, { cause: error });
      }
    };
    const notes = [];
    // Ask which tables exist, and then which columns each present table has, so a normal read never runs a statement that
    // fails (a failed statement discards a pooled connection). Asking for the columns of a present table cannot fail.
    const present = new Set((await query('tables')).map(row => row.name));
    const read = async (name, empty) => {
      const { table, columns } = SESSION_DB_TABLES[name];
      if (!present.has(table)) return empty;
      const has = new Set((await query(`${name}Columns`)).map(row => row.name));
      if (!columns.every(column => has.has(column))) {
        notes.push(`its ${table} table is not in the data-contract format, so it is ignored`);
        return empty;
      }
      return query(name);
    };
    const todos = await read('todos', []);
    const deps = await read('deps', []);
    const children = await read('children', null);
    return {
      todos: todos.map(todo => ({
        id: String(todo.id), title: String(todo.title ?? ''), description: typeof todo.description === 'string' ? todo.description : '',
        status: String(todo.status ?? 'pending'),
      })),
      deps: deps.map(dep => ({ todoId: String(dep.todo_id), dependsOn: String(dep.depends_on) })),
      children,
      ...(notes.length ? { notes } : {}),
    };
  });
}

/**
 * Caches each file's last successful read under its stamps. A read that throws stores nothing: the last good entry stays for
 * get.last(file), and its stamps no longer match, so the next get reads again even when the file has not changed since.
 * Only a stat that fails with ENOENT or ENOTDIR means absent: the main file then gives null and its entry goes, and a -wal file
 * then counts as none. Any other stat failure (EACCES, say) is a failed read: it throws and the entry stays, so the caller keeps
 * get.last(file) and knows that this read failed.
 */
export function createSessionDbCache(read = readSessionDb) {
  const cache = new Map();
  const absent = error => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  async function get(file, sqliteOptions) {
    let stat;
    try {
      stat = statSync(file);
    } catch (error) {
      if (!absent(error)) throw error;
      cache.delete(file);
      return null;
    }
    let key = `${stat.mtimeMs}:${stat.size}`;
    try {
      const wal = statSync(`${file}-wal`);
      key += `|${wal.mtimeMs}:${wal.size}`;
    } catch (error) {
      if (!absent(error)) throw error;
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
