import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SqliteUnavailableError, UnsafeReadError, bindLiterals, inspectDatabase, loadNodeSqlite, nodeSqliteSupportsUri, openReadOnly, openTarget, sqliteBackends,
  withReadOnly,
} from '../engine/sqlite.mjs';
import { TEST_BACKENDS, canWriteWithNode, execSql, openWriter } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';

const dir = tempDir('swarm-sqlite-');
const backends = TEST_BACKENDS;
const rollback = path.join(dir, 'rollback.db');
execSql(rollback, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a''q'), ('b'), ('c');");
const closedWal = path.join(dir, 'closed-wal.db');
execSql(closedWal, "PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('w');");

test('at least one SQLite backend is available, and the engine finds the same ones', async () => {
  assert.ok(backends.length > 0, 'install node:sqlite (Node >= 22.15) or the sqlite3 CLI');
  assert.deepEqual(await sqliteBackends(), [...backends]);
});

test('inspectDatabase recognises missing, non-SQLite, rollback and WAL files', () => {
  const text = path.join(dir, 'text.db');
  writeFileSync(text, 'not a database');
  assert.equal(inspectDatabase(path.join(dir, 'missing.db')), null);
  assert.deepEqual(inspectDatabase(text), { sqlite: false, wal: false });
  assert.deepEqual(inspectDatabase(rollback), { sqlite: true, wal: false });
  assert.deepEqual(inspectDatabase(closedWal), { sqlite: true, wal: true });
});

test('a WAL database without -shm is opened immutable; others by path', () => {
  assert.equal(existsSync(`${closedWal}-shm`), false);
  const wal = openTarget(closedWal);
  assert.equal(wal.immutable, true);
  assert.match(wal.target, /^file:\/\/.*closed-wal\.db\?immutable=1$/);
  assert.deepEqual(openTarget(rollback), { target: rollback, immutable: false });
  assert.equal(openTarget(path.join(dir, 'missing.db')), null);
});

test('bindLiterals escapes strings and checks the parameter count', () => {
  assert.equal(bindLiterals('SELECT ? , ?, ?, ?', ["it's", 7, null, 2n]), "SELECT 'it''s' , 7, NULL, 2");
  assert.throws(() => bindLiterals('SELECT ?', []), /missing parameter/);
  assert.throws(() => bindLiterals('SELECT 1', [1]), /too many parameters/);
  assert.throws(() => bindLiterals('SELECT ?', ['a\u0000b']), /NUL/);
  assert.throws(() => bindLiterals('SELECT ?', [{}]), /unsupported parameter type/);
});

for (const backend of backends) {
  test(`${backend}: reads rows with bound parameters`, async () => {
    const rows = await withReadOnly(rollback, { backend }, db => db.all('SELECT id, v FROM t WHERE id > ? AND v <> ? ORDER BY id', [0, 'c']));
    assert.deepEqual(rows, [{ id: 1, v: "a'q" }, { id: 2, v: 'b' }]);
  });

  test(`${backend}: rejects writes`, async () => {
    const db = await openReadOnly(rollback, { backend });
    try {
      await assert.rejects(db.all("INSERT INTO t (v) VALUES ('x')"));
    } finally {
      db.close();
    }
    const rows = await withReadOnly(rollback, { backend }, db2 => db2.all('SELECT count(*) AS n FROM t'));
    assert.deepEqual(rows, [{ n: 3 }]);
  });

  test(`${backend}: reads a closed WAL database without creating side files`, async () => {
    const rows = await withReadOnly(closedWal, { backend }, db => db.all('SELECT v FROM t'));
    assert.deepEqual(rows, [{ v: 'w' }]);
    assert.equal(existsSync(`${closedWal}-wal`), false);
    assert.equal(existsSync(`${closedWal}-shm`), false);
  });

  test(`${backend}: reads committed rows of a WAL database with a live writer`, { skip: !canWriteWithNode }, async () => {
    const file = path.join(dir, `live-${backend}.db`);
    const writer = openWriter(file);
    try {
      writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('live');");
      assert.equal(openTarget(file).immutable, false);
      const rows = await withReadOnly(file, { backend }, db => db.all('SELECT v FROM t'));
      assert.deepEqual(rows, [{ v: 'live' }]);
    } finally {
      writer.close();
    }
  });

  test(`${backend}: returns null for a missing file without calling the reader`, async () => {
    let called = false;
    const result = await withReadOnly(path.join(dir, 'nope.db'), { backend }, async () => {
      called = true;
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });
}

test('the CLI backend reports a missing sqlite3 binary as SqliteUnavailableError', async () => {
  const db = await openReadOnly(rollback, { backend: 'cli', sqlite3Path: path.join(dir, 'no-such-sqlite3') });
  await assert.rejects(db.all('SELECT 1'), SqliteUnavailableError);
});

test('nodeSqliteSupportsUri needs Node 22.15, 23.10 or later', () => {
  const expected = { '22.13.0': false, '22.14.1': false, '22.15.0': true, '23.9.0': false, '23.10.0': true, '24.0.0': true, '25.1.0': true, '18.11.0': false, garbage: false };
  for (const [version, supported] of Object.entries(expected)) assert.equal(nodeSqliteSupportsUri(version), supported, version);
});

test('auto falls back to the CLI for an immutable target when node:sqlite lacks file URIs', { skip: !backends.includes('cli') }, async () => {
  const db = await openReadOnly(closedWal, { backend: 'auto', nodeVersion: '22.14.0' });
  try {
    assert.equal(db.backend, 'cli');
    assert.equal(db.immutable, true);
    assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'w' }]);
  } finally {
    db.close();
  }
  assert.equal(existsSync(`${closedWal}-wal`), false);
  assert.equal(existsSync(`${closedWal}-shm`), false);
});

test('the node backend needs URI support for an immutable target', { skip: !backends.includes('node') }, async () => {
  assert.ok(await loadNodeSqlite());
  const db = await openReadOnly(closedWal, { backend: 'auto', nodeVersion: '22.15.0' });
  try {
    assert.equal(db.backend, 'node');
  } finally {
    db.close();
  }
  await assert.rejects(
    openReadOnly(closedWal, { backend: 'node', nodeVersion: '22.14.0' }),
    error => error instanceof SqliteUnavailableError && /22\.15/.test(error.message),
  );
});

/** A WAL database copy whose -wal holds a committed row that is not checkpointed, and that has no -shm file. */
function walDataWithoutShm(name) {
  const source = path.join(dir, `${name}-source.db`);
  const copy = path.join(dir, `${name}.db`);
  const writer = openWriter(source);
  try {
    writer.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); PRAGMA wal_checkpoint(TRUNCATE);');
    writer.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO t (v) VALUES ('in-wal');");
    assert.ok(existsSync(`${source}-wal`));
    copyFileSync(source, copy);
    copyFileSync(`${source}-wal`, `${copy}-wal`);
  } finally {
    writer.close();
  }
  assert.equal(existsSync(`${copy}-shm`), false);
  return copy;
}

test('openTarget follows the decision table for WAL databases', { skip: !canWriteWithNode }, () => {
  const withData = walDataWithoutShm('table-data');
  assert.throws(() => openTarget(withData), error => error instanceof UnsafeReadError && error.name === 'UnsafeReadError');
  const empty = walDataWithoutShm('table-empty');
  writeFileSync(`${empty}-wal`, '');
  assert.equal(openTarget(empty).immutable, true);
  rmSync(`${empty}-wal`);
  assert.equal(openTarget(empty).immutable, true);
  writeFileSync(`${withData}-shm`, '');
  assert.deepEqual(openTarget(withData), { target: withData, immutable: false });
});

for (const backend of backends) {
  test(`${backend}: a WAL database with unread -wal data and no -shm is not read, and nothing is created`, { skip: !canWriteWithNode }, async () => {
    const file = walDataWithoutShm(`unsafe-${backend}`);
    const before = readdirSync(dir).sort();
    await assert.rejects(
      openReadOnly(file, { backend }),
      error => error instanceof UnsafeReadError
        && error.message === `unsafe-${backend}.db: its write-ahead log has data but no shared-memory file, so it cannot be read safely now.`,
    );
    assert.deepEqual(readdirSync(dir).sort(), before);
  });

  test(`${backend}: a WAL database with an empty -wal and no -shm is read immutably`, { skip: !canWriteWithNode }, async () => {
    const file = path.join(dir, `empty-wal-${backend}.db`);
    copyFileSync(closedWal, file);
    writeFileSync(`${file}-wal`, '');
    const before = readdirSync(dir).sort();
    const db = await openReadOnly(file, { backend });
    try {
      assert.equal(db.immutable, true);
      assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'w' }]);
    } finally {
      db.close();
    }
    assert.deepEqual(readdirSync(dir).sort(), before);
  });
}
