import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let nodeSqlite = null;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  nodeSqlite = null;
}

function cliAvailable() {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const canWriteWithNode = Boolean(nodeSqlite);
/** Backends to run reader tests against, known synchronously so tests register without top-level await. */
export const TEST_BACKENDS = Object.freeze([...(nodeSqlite ? ['node'] : []), ...(cliAvailable() ? ['cli'] : [])]);

/** Run SQL against a database file, creating it when missing. Test fixtures only. */
export function execSql(file, sql) {
  if (nodeSqlite) {
    const db = new nodeSqlite.DatabaseSync(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  execFileSync('sqlite3', [file], { input: `${sql};\nPRAGMA wal_checkpoint(TRUNCATE);\n`, stdio: ['pipe', 'ignore', 'inherit'] });
  // Apple's sqlite3 keeps -wal and -shm after it exits (persistent WAL). Once checkpointed, remove them,
  // as node:sqlite does on close, so fixtures look like a database whose writer has closed.
  for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
}

/** Keep a writable connection open, so a WAL database keeps its -wal and -shm files (node:sqlite only). */
export function openWriter(file) {
  return nodeSqlite ? new nodeSqlite.DatabaseSync(file) : null;
}
