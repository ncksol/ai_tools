import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAGIC = 'SQLite format 3\u0000';

export class SqliteUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqliteUnavailableError';
  }
}

/** A WAL database that cannot be read without side effects or data loss right now (retry on the next refresh). */
export class UnsafeReadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsafeReadError';
  }
}

let nodeSqlite;
/**
 * node:sqlite when this runtime has it (Node >= 22.13 without flags), otherwise null. Loading does not mean every
 * database can be read: immutable reads need file: URI support, from Node 22.15 / 23.10 (see nodeSqliteSupportsUri).
 */
export function loadNodeSqlite() {
  nodeSqlite ??= import('node:sqlite').then(module => module, () => null);
  return nodeSqlite;
}

/** node:sqlite opens `file:` URIs, which immutable reads need, from Node 22.15 and 23.10. */
export function nodeSqliteSupportsUri(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)/.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 23 || (major === 23 && minor >= 10) || (major === 22 && minor >= 15);
}

/** Header check without opening SQLite: null when missing; wal = file format version 2. */
export function inspectDatabase(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const header = Buffer.alloc(100);
    const read = readSync(fd, header, 0, 100, 0);
    if (read < 100 || header.toString('latin1', 0, 16) !== MAGIC) return { sqlite: false, wal: false };
    return { sqlite: true, wal: header[18] === 2 };
  } finally {
    closeSync(fd);
  }
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * How to open a database without side effects.
 * - Rollback journal: a plain read-only open.
 * - WAL with a missing or empty -wal: the main file holds every committed row, so it is read through the immutable=1 URI
 *   (a plain open would create -wal and -shm beside it).
 * - WAL with data in -wal and a -shm file: a plain read-only open.
 * - WAL with data in -wal and no -shm file: immutable mode would silently drop the committed rows in the -wal, and a plain
 *   open would create side files, so it throws UnsafeReadError.
 */
export function openTarget(file) {
  const info = inspectDatabase(file);
  if (!info || !info.sqlite) return null;
  if (!info.wal) return { target: file, immutable: false };
  if (sizeOf(`${file}-wal`) === 0) return { target: `${pathToFileURL(file).href}?immutable=1`, immutable: true };
  if (existsSync(`${file}-shm`)) return { target: file, immutable: false };
  throw new UnsafeReadError(`${path.basename(file)}: its write-ahead log has data but no shared-memory file, so it cannot be read safely now.`);
}

/** Replace each ? with an SQL literal. Only for the engine's constant SQL, which has no ? inside string literals. */
export function bindLiterals(sql, params = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    if (index >= params.length) throw new Error('bindLiterals: missing parameter');
    return toLiteral(params[index++]);
  });
  if (index !== params.length) throw new Error('bindLiterals: too many parameters');
  return text;
}

function toLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('bindLiterals: non-finite number');
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000')) throw new Error('bindLiterals: NUL character in string');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new Error(`bindLiterals: unsupported parameter type ${typeof value}`);
}

function nodeDatabase(sqlite, target, immutable) {
  const db = new sqlite.DatabaseSync(target, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = 1');
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    backend: 'node',
    immutable,
    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map(row => ({ ...row }));
    },
    close() {
      db.close();
    },
  };
}

function cliDatabase(sqlite3Path, target, immutable, execFileImpl) {
  return {
    backend: 'cli',
    immutable,
    all(sql, params = []) {
      let text;
      try {
        text = bindLiterals(sql, params);
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        execFileImpl(
          sqlite3Path,
          ['-readonly', '-json', '-cmd', 'PRAGMA query_only = 1', target, text],
          { maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true },
          (error, stdout, stderr) => {
            if (error) {
              if (error.code === 'ENOENT') reject(new SqliteUnavailableError(`sqlite3 not found: ${sqlite3Path}`));
              else reject(new Error(`sqlite3 failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
              return;
            }
            const out = String(stdout).trim();
            if (!out) {
              resolve([]);
              return;
            }
            try {
              resolve(JSON.parse(out));
            } catch (parseError) {
              reject(new Error(`sqlite3 returned invalid JSON: ${parseError.message}`));
            }
          },
        );
      });
    },
    close() {},
  };
}

/**
 * Open a database read-only. Resolves null when the file is missing or is not SQLite.
 * options: backend ('auto' | 'node' | 'cli'), sqlite3Path, execFileImpl, and nodeVersion (default process.versions.node;
 * a test seam for the file: URI check). In 'auto' mode an immutable target uses the node backend only when this Node.js
 * version supports file: URIs, and the sqlite3 CLI otherwise.
 */
export async function openReadOnly(file, options = {}) {
  const { backend = 'auto', sqlite3Path = 'sqlite3', execFileImpl = execFile, nodeVersion = process.versions.node } = options;
  const target = openTarget(file);
  if (!target) return null;
  if (backend === 'auto' || backend === 'node') {
    const sqlite = await loadNodeSqlite();
    if (!sqlite) {
      if (backend === 'node') throw new SqliteUnavailableError('node:sqlite is not available in this Node.js runtime');
    } else if (!target.immutable || nodeSqliteSupportsUri(nodeVersion)) {
      return nodeDatabase(sqlite, target.target, target.immutable);
    } else if (backend === 'node') {
      throw new SqliteUnavailableError(
        `node:sqlite in Node.js ${nodeVersion} cannot open file: URIs, which this database needs; use Node.js 22.15 or later, or the sqlite3 CLI`,
      );
    }
  }
  return cliDatabase(sqlite3Path, target.target, target.immutable, execFileImpl);
}

/** Open, run fn(db), always close. Resolves null without calling fn when the database is missing. */
export async function withReadOnly(file, options, fn) {
  const db = await openReadOnly(file, options);
  if (!db) return null;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export async function sqliteBackends({ sqlite3Path = 'sqlite3' } = {}) {
  const found = [];
  if (await loadNodeSqlite()) found.push('node');
  const cli = await new Promise(resolve => {
    execFile(sqlite3Path, ['-version'], { timeout: 10_000 }, error => resolve(!error));
  });
  if (cli) found.push('cli');
  return found;
}
