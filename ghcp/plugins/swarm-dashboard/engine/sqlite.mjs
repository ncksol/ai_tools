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
 * - WAL with data in -wal and a -shm file: a plain read-only open (`live: true`; createSqliteReader holds one connection).
 * - WAL with data in -wal and no -shm file: immutable mode would silently drop the committed rows in the -wal, and a plain
 *   open would create side files, so it throws UnsafeReadError.
 */
export function openTarget(file) {
  const info = inspectDatabase(file);
  if (!info || !info.sqlite) return null;
  if (!info.wal) return { target: file, immutable: false };
  if (sizeOf(`${file}-wal`) === 0) return { target: `${pathToFileURL(file).href}?immutable=1`, immutable: true };
  if (existsSync(`${file}-shm`)) return { target: file, immutable: false, live: true };
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

function openNodeConnection(sqlite, target) {
  const db = new sqlite.DatabaseSync(target, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = 1');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Every statement runs to completion inside all(), so an idle connection holds no read transaction. */
function nodeHandle(db, immutable, close) {
  return {
    backend: 'node',
    immutable,
    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map(row => ({ ...row }));
    },
    close,
  };
}

/** The sqlite3 CLI cannot hold a connection, so each query applies openTarget's table to the file just before it runs. */
function cliDatabase(sqlite3Path, file, immutable, execFileImpl) {
  return {
    backend: 'cli',
    immutable,
    all(sql, params = []) {
      let text;
      let target;
      try {
        text = bindLiterals(sql, params);
        target = openTarget(file);
        if (!target) throw new Error(`${path.basename(file)}: the database is missing or is not SQLite.`);
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        execFileImpl(
          sqlite3Path,
          ['-readonly', '-json', '-cmd', 'PRAGMA query_only = 1', target.target, text],
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

function unavailableUri(nodeVersion) {
  return new SqliteUnavailableError(
    `node:sqlite in Node.js ${nodeVersion} cannot open file: URIs, which this database needs; use Node.js 22.15 or later, or the sqlite3 CLI`,
  );
}

/** 'node' or 'cli' for an open target. In 'auto' mode an immutable target needs file: URI support in node:sqlite. */
function chooseBackend(sqlite, target, { backend, nodeVersion }) {
  if (backend === 'auto' || backend === 'node') {
    if (!sqlite) {
      if (backend === 'node') throw new SqliteUnavailableError('node:sqlite is not available in this Node.js runtime');
    } else if (!target.immutable || nodeSqliteSupportsUri(nodeVersion)) {
      return 'node';
    } else if (backend === 'node') {
      throw unavailableUri(nodeVersion);
    }
  }
  return 'cli';
}

/**
 * Open a database read-only for one use. Resolves null when the file is missing or is not SQLite.
 * options: backend ('auto' | 'node' | 'cli'), sqlite3Path, execFileImpl, and nodeVersion (default process.versions.node;
 * a test seam for the file: URI check). In 'auto' mode an immutable target uses the node backend only when this Node.js
 * version supports file: URIs, and the sqlite3 CLI otherwise.
 */
export async function openReadOnly(file, options = {}) {
  const { backend = 'auto', sqlite3Path = 'sqlite3', execFileImpl = execFile, nodeVersion = process.versions.node } = options;
  const sqlite = backend === 'cli' ? null : await loadNodeSqlite();
  // Nothing is awaited from here to the open, so the file checks and the open sit next to each other.
  const target = openTarget(file);
  if (!target) return null;
  if (chooseBackend(sqlite, target, { backend, nodeVersion }) === 'node') {
    const db = openNodeConnection(sqlite, target.target);
    return nodeHandle(db, target.immutable, () => db.close());
  }
  return cliDatabase(sqlite3Path, file, target.immutable, execFileImpl);
}

const inodeOf = file => {
  try {
    return statSync(file).ino;
  } catch {
    return null;
  }
};

/**
 * Reads SQLite files for the engine, with one long-lived read-only connection per live WAL database (a -wal with content
 * and a -shm beside it). The other kinds are opened and closed on every read: rollback-journal databases with a plain
 * read-only open, and databases whose -wal is missing or empty through the immutable=1 URI. A -wal with content and no
 * -shm throws UnsafeReadError. With the sqlite3 CLI nothing is held; the same table is applied before each query.
 *
 * Why a held connection: a plain read-only open creates -wal and -shm when they are missing at SQLite's first read, and
 * no node:sqlite open mode prevents that. While our connection is open its lock stops a writer that is closing from
 * deleting those files, so later reads cannot create them.
 *
 * Connections close on retain(), close() (the engine calls it from stop()), after a failed read, and when the file's
 * inode changes. A reader that is dropped without close() releases its connections when it is garbage collected,
 * because node:sqlite closes a collected database.
 *
 * options are openReadOnly's. Test seams: openConnections, opened (connections opened so far), lastPath
 * ('live' | 'immutable' | 'plain').
 */
export function createSqliteReader(options = {}) {
  const { backend = 'auto', sqlite3Path = 'sqlite3', execFileImpl = execFile, nodeVersion = process.versions.node } = options;
  const connections = new Map();
  let lastPath = null;
  let opened = 0;

  function drop(file) {
    const entry = connections.get(file);
    if (!entry) return;
    connections.delete(file);
    try {
      entry.db.close();
    } catch {
      // already closed
    }
  }

  /** Synchronous from the first file check to the first statement: nothing is awaited in between. */
  function acquire(file, sqlite) {
    const held = connections.get(file);
    if (held) {
      if (inodeOf(file) === held.ino) {
        lastPath = 'live';
        return { handle: held.handle, pooled: true };
      }
      drop(file);
    }
    // The inode is read before the open: a file replaced in between then only causes a harmless reopen on the next read.
    const ino = inodeOf(file);
    const target = openTarget(file);
    if (!target) return null;
    if (chooseBackend(sqlite, target, { backend, nodeVersion }) === 'cli') {
      lastPath = target.immutable ? 'immutable' : 'plain';
      return { handle: cliDatabase(sqlite3Path, file, target.immutable, execFileImpl), pooled: false };
    }
    // Remaining window: SQLite looks for the -wal only after it takes its read lock. If the last writer finishes closing
    // in the few microseconds between our check and that lock, SQLite creates an empty -wal and a -shm beside the
    // database. No data changes, and the next writer reuses or removes them. Once this connection is open, its lock stops
    // writers deleting those files, so later reads cannot create them.
    const db = openNodeConnection(sqlite, target.target);
    if (!target.live) {
      lastPath = target.immutable ? 'immutable' : 'plain';
      return { handle: nodeHandle(db, target.immutable, () => db.close()), pooled: false };
    }
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (error) {
      db.close();
      throw error;
    }
    const handle = nodeHandle(db, false, () => {});
    connections.set(file, { db, ino, handle });
    opened += 1;
    lastPath = 'live';
    return { handle, pooled: true };
  }

  return {
    /** Apply the table to the file and run fn(db). Resolves null when the file is missing or is not SQLite. */
    async read(file, fn) {
      const sqlite = backend === 'cli' ? null : await loadNodeSqlite();
      const lease = acquire(file, sqlite);
      if (!lease) return null;
      try {
        return await fn(lease.handle);
      } catch (error) {
        if (lease.pooled) drop(file);
        throw error;
      } finally {
        if (!lease.pooled) lease.handle.close();
      }
    },
    /** Close the connections of every file not in the set. */
    retain(files) {
      for (const file of [...connections.keys()]) if (!files.has(file)) drop(file);
    },
    close() {
      for (const file of [...connections.keys()]) drop(file);
    },
    get openConnections() {
      return connections.size;
    },
    get opened() {
      return opened;
    },
    get lastPath() {
      return lastPath;
    },
  };
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
