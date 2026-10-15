import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SqliteUnavailableError, UnsafeReadError, bindLiterals, createSqliteReader, inspectDatabase, loadNodeSqlite, nodeSqliteSupportsUri, openReadOnly, openTarget, sqliteBackends,
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
  writeFileSync(`${empty}-shm`, '');
  assert.equal(openTarget(empty).immutable, true, 'a missing -wal is immutable whatever the -shm');
  writeFileSync(`${empty}-wal`, '');
  assert.deepEqual(openTarget(empty), { target: empty, immutable: false, live: true });
  rmSync(`${empty}-shm`);
  assert.equal(openTarget(empty).immutable, true, 'an empty -wal with no -shm is immutable');
  assert.deepEqual(openTarget(rollback), { target: rollback, immutable: false });
  writeFileSync(`${withData}-shm`, '');
  assert.deepEqual(openTarget(withData), { target: withData, immutable: false, live: true });
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

const names = folder => readdirSync(folder).sort();
const SCHEMA = 'PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);';
const values = db => db.all('SELECT v FROM t ORDER BY id');

test('one long-lived connection reads a live WAL database and creates no side files', { skip: !canWriteWithNode }, async () => {
  const folder = tempDir('swarm-live-');
  const file = path.join(folder, 'live.db');
  const writer = openWriter(file);
  const reader = createSqliteReader({ backend: 'node' });
  try {
    writer.exec(`${SCHEMA} INSERT INTO t (v) VALUES ('first');`);
    for (let i = 0; i < 4; i += 1) {
      if (i) writer.exec(`INSERT INTO t (v) VALUES ('row-${i}');`);
      const rows = await reader.read(file, values);
      assert.equal(rows.length, i + 1);
      assert.equal(reader.openConnections, 1);
      assert.equal(reader.lastPath, 'live');
      assert.deepEqual(names(folder), ['live.db', 'live.db-shm', 'live.db-wal']);
    }
    assert.equal(reader.opened, 1);
    const checkpoint = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'an idle reader connection must not block checkpoints');
    writer.close();
    assert.deepEqual((await reader.read(file, values)).map(row => row.v), ['first', 'row-1', 'row-2', 'row-3']);
    assert.deepEqual(names(folder), ['live.db', 'live.db-shm', 'live.db-wal']);
    assert.equal(reader.openConnections, 1);
  } finally {
    reader.close();
  }
  assert.equal(reader.openConnections, 0);
});

test('the reader takes the immutable path only for a missing or empty -wal', { skip: !canWriteWithNode }, async t => {
  for (const backend of backends) {
    await t.test(backend, async () => {
      const reader = createSqliteReader({ backend });
      try {
        assert.deepEqual((await reader.read(rollback, values)).map(row => row.v), ["a'q", 'b', 'c']);
        assert.equal(reader.lastPath, 'plain');
        const folder = tempDir('swarm-table-');
        const missingWal = path.join(folder, 'missing-wal.db');
        copyFileSync(closedWal, missingWal);
        assert.deepEqual((await reader.read(missingWal, values)).map(row => row.v), ['w']);
        assert.equal(reader.lastPath, 'immutable');
        const emptyWal = path.join(folder, 'empty-wal.db');
        copyFileSync(closedWal, emptyWal);
        writeFileSync(`${emptyWal}-wal`, '');
        assert.deepEqual((await reader.read(emptyWal, values)).map(row => row.v), ['w']);
        assert.equal(reader.lastPath, 'immutable');
        const shmOnly = path.join(folder, 'shm-only.db');
        copyFileSync(closedWal, shmOnly);
        writeFileSync(`${shmOnly}-shm`, '');
        assert.deepEqual((await reader.read(shmOnly, values)).map(row => row.v), ['w']);
        assert.equal(reader.lastPath, 'immutable', 'a missing -wal is immutable whatever the -shm');
        const emptyWithShm = path.join(folder, 'empty-wal-shm.db');
        copyFileSync(closedWal, emptyWithShm);
        writeFileSync(`${emptyWithShm}-wal`, '');
        writeFileSync(`${emptyWithShm}-shm`, '');
        assert.deepEqual((await reader.read(emptyWithShm, values)).map(row => row.v), ['w']);
        assert.equal(reader.lastPath, backend === 'node' ? 'live' : 'plain', 'an empty -wal with a -shm is a live database');
        const noShm = walDataWithoutShm(`reader-${backend}`);
        await assert.rejects(reader.read(noShm, values), UnsafeReadError);
        const live = path.join(folder, 'live.db');
        const writer = openWriter(live);
        try {
          writer.exec(`${SCHEMA} INSERT INTO t (v) VALUES ('live');`);
          assert.deepEqual((await reader.read(live, values)).map(row => row.v), ['live']);
          assert.equal(reader.lastPath, backend === 'node' ? 'live' : 'plain');
        } finally {
          writer.close();
        }
        assert.equal(await reader.read(path.join(folder, 'missing.db'), values), null);
      } finally {
        reader.close();
      }
    });
  }
});

test('a live writer with an empty log keeps the locked read path, and the connection survives a checkpoint', { skip: !canWriteWithNode }, async () => {
  const folder = tempDir('swarm-empty-log-');
  const file = path.join(folder, 'live.db');
  const writer = openWriter(file);
  const reader = createSqliteReader({ backend: 'node' });
  try {
    writer.exec(`${SCHEMA} INSERT INTO t (v) VALUES ('first');`);
    assert.equal(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
    assert.equal(statSync(`${file}-wal`).size, 0);
    assert.equal(existsSync(`${file}-shm`), true);
    for (const backend of backends) {
      const db = await openReadOnly(file, { backend });
      try {
        assert.equal(db.immutable, false, `${backend}: the one-shot helper uses the plain path`);
        assert.deepEqual((await values(db)).map(row => row.v), ['first']);
      } finally {
        db.close();
      }
    }
    assert.deepEqual((await reader.read(file, values)).map(row => row.v), ['first']);
    assert.equal(reader.lastPath, 'live');
    writer.exec("INSERT INTO t (v) VALUES ('second');");
    assert.equal(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy, 0);
    assert.equal(statSync(`${file}-wal`).size, 0);
    writer.exec("INSERT INTO t (v) VALUES ('third');");
    assert.deepEqual((await reader.read(file, values)).map(row => row.v), ['first', 'second', 'third']);
    assert.equal(reader.opened, 1);
    assert.equal(reader.openConnections, 1);
    assert.deepEqual(names(folder), ['live.db', 'live.db-shm', 'live.db-wal']);
  } finally {
    reader.close();
    writer.close();
  }
});

test('a replaced database file closes the old connection and opens a new one', { skip: !canWriteWithNode }, async () => {
  const folder = tempDir('swarm-inode-');
  const file = path.join(folder, 'live.db');
  const reader = createSqliteReader({ backend: 'node' });
  const first = openWriter(file);
  try {
    first.exec(`${SCHEMA} INSERT INTO t (v) VALUES ('old');`);
    assert.deepEqual((await reader.read(file, values)).map(row => row.v), ['old']);
    first.close();
    for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    const next = path.join(folder, 'next.db');
    execSql(next, `${SCHEMA} INSERT INTO t (v) VALUES ('checkpointed');`);
    renameSync(next, file);
    const second = openWriter(file);
    try {
      second.exec("INSERT INTO t (v) VALUES ('new');");
      assert.deepEqual((await reader.read(file, values)).map(row => row.v), ['checkpointed', 'new']);
      assert.equal(reader.opened, 2);
      assert.equal(reader.openConnections, 1);
      assert.deepEqual(names(folder), ['live.db', 'live.db-shm', 'live.db-wal']);
    } finally {
      second.close();
    }
  } finally {
    reader.close();
  }
});

test('close releases every connection, a later read reopens, and retain keeps only the named files', { skip: !canWriteWithNode }, async () => {
  const folder = tempDir('swarm-close-');
  const writers = [];
  const files = ['a.db', 'b.db'].map(name => path.join(folder, name));
  for (const file of files) {
    const writer = openWriter(file);
    writer.exec(`${SCHEMA} INSERT INTO t (v) VALUES ('x');`);
    writers.push(writer);
  }
  const reader = createSqliteReader({ backend: 'node' });
  try {
    for (const file of files) await reader.read(file, values);
    assert.equal(reader.openConnections, 2);
    reader.retain(new Set([files[0]]));
    assert.equal(reader.openConnections, 1);
    reader.close();
    assert.equal(reader.openConnections, 0);
    assert.deepEqual((await reader.read(files[0], values)).map(row => row.v), ['x']);
    assert.equal(reader.openConnections, 1);
    assert.equal(reader.opened, 3);
    // With no reader connection left, the last writer to close removes the side files, as it does with no reader at all.
    reader.close();
    for (const writer of writers) writer.close();
    assert.deepEqual(names(folder), ['a.db', 'b.db']);
  } finally {
    reader.close();
  }
});

test('a failed read closes the connection, and the next read opens a new one', { skip: !canWriteWithNode }, async () => {
  const folder = tempDir('swarm-fail-');
  const file = path.join(folder, 'live.db');
  const writer = openWriter(file);
  const reader = createSqliteReader({ backend: 'node' });
  try {
    writer.exec(`${SCHEMA} INSERT INTO t (v) VALUES ('x');`);
    await reader.read(file, values);
    await assert.rejects(reader.read(file, db => db.all('SELECT nope FROM t')), /nope/);
    assert.equal(reader.openConnections, 0);
    assert.deepEqual((await reader.read(file, values)).map(row => row.v), ['x']);
    assert.equal(reader.opened, 2);
  } finally {
    reader.close();
    writer.close();
  }
});

test('the CLI backend applies the table before every query', async () => {
  const folder = tempDir('swarm-cli-table-');
  const file = path.join(folder, 'cli.db');
  copyFileSync(closedWal, file);
  const targets = [];
  const execFileImpl = (command, args, options, callback) => {
    targets.push(args[4]);
    callback(null, '[{"v":"w"}]', '');
  };
  const reader = createSqliteReader({ backend: 'cli', execFileImpl });
  const query = db => db.all('SELECT v FROM t');
  const uri = `${pathToFileURL(file).href}?immutable=1`;
  await reader.read(file, async db => {
    await query(db);
    writeFileSync(`${file}-wal`, '');
    await query(db);
    writeFileSync(`${file}-wal`, 'data');
    await assert.rejects(query(db), error => error instanceof UnsafeReadError && error.message.startsWith('cli.db: '));
    writeFileSync(`${file}-shm`, '');
    await query(db);
    rmSync(`${file}-shm`);
    rmSync(`${file}-wal`);
    await query(db);
  });
  assert.deepEqual(targets, [uri, uri, file, uri]);
  assert.equal(reader.openConnections, 0);
});
