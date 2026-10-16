import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SESSION_DB_QUERIES, SESSION_DB_TABLES, createSessionDbCache, listLocks, readSessionDb, readWorkspaceYaml } from '../engine/readers/session-files.mjs';
import { createProcessProbe, parsePsOutput } from '../engine/readers/process-probe.mjs';
import { createSqliteReader, withReadOnly } from '../engine/sqlite.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS, canWriteWithNode, execSql, holdExclusiveLock, openWriter } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';

const home = new CopilotHome();

test('workspace.yaml gives cwd, branch, code host and repository', () => {
  home.workspaceYaml('cli-1', { cwd: '/synthetic/worktrees/one', branch: 'feature/one', hostType: 'ado', repository: 'org/project/repo' });
  assert.deepEqual(readWorkspaceYaml(home.dir('cli-1')), { cwd: '/synthetic/worktrees/one', branch: 'feature/one', hostType: 'ado', repository: 'org/project/repo' });
  home.workspaceYaml('cli-2', { cwd: "'/synthetic/quoted path'" });
  assert.deepEqual(readWorkspaceYaml(home.dir('cli-2')), { cwd: '/synthetic/quoted path', branch: null, hostType: null, repository: null });
  assert.equal(readWorkspaceYaml(path.join(home.stateDir, 'missing')), null);
});

test('lock files list their PIDs and times', () => {
  home.lock('cli-3', 4242, 1_700_000_000_000);
  writeFileSync(path.join(home.dir('cli-3'), 'inuse.oops.lock'), '');
  assert.deepEqual(listLocks(home.dir('cli-3')), [{ pid: 4242, mtimeMs: 1_700_000_000_000 }]);
  for (const pid of ['0', '00']) writeFileSync(path.join(home.dir('cli-3'), `inuse.${pid}.lock`), '');
  assert.deepEqual(listLocks(home.dir('cli-3')), [{ pid: 4242, mtimeMs: 1_700_000_000_000 }]);
  assert.deepEqual(listLocks(home.dir('cli-4')), []);
  assert.equal(listLocks(path.join(home.stateDir, 'missing')), null);
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: session.db gives todos, dependencies and the registry`, async () => {
    const file = home.sessionDb(`cli-db-${backend}`, {
      todos: [{ id: 'a', title: 'First', status: 'done' }, { id: 'b', description: 'Uses ws-123' }],
      deps: [['b', 'a']],
      children: [{ unit: 'api', session_id: 'ws-123', title: 'API', created_at: '2026-10-15T08:00:00Z', updated_at: '2026-10-15T09:00:00Z' }],
    });
    const result = await readSessionDb(file, { backend });
    assert.deepEqual(result.todos, [
      { id: 'a', title: 'First', description: '', status: 'done' },
      { id: 'b', title: 'b', description: 'Uses ws-123', status: 'pending' },
    ]);
    assert.deepEqual(result.deps, [{ todoId: 'b', dependsOn: 'a' }]);
    assert.equal(result.children.length, 1);
    assert.equal(result.children[0].unit, 'api');
    assert.equal(result.children[0].pr_id, null);
  });

  test(`${backend}: a session.db without a registry has children null`, async () => {
    const file = home.sessionDb(`cli-plain-${backend}`, { todos: [] });
    assert.deepEqual(await readSessionDb(file, { backend }), { todos: [], deps: [], children: null });
  });

  test(`${backend}: a session.db that a writer holds locked rejects instead of reading as empty`, { skip: !canWriteWithNode }, async () => {
    const file = home.sessionDb(`cli-locked-${backend}`, { todos: [{ id: 'a' }] });
    const lock = await holdExclusiveLock(file);
    try {
      await assert.rejects(readSessionDb(file, { backend }), /^Error: session\.db tables: .*database is locked/);
    } finally {
      await lock.release();
    }
    assert.equal((await readSessionDb(file, { backend })).todos.length, 1);
  });

  test(`${backend}: a children table of another shape is ignored with a note, and no query fails`, async () => {
    const file = home.sessionDb(`cli-foreign-children-${backend}`, { todos: [{ id: 'a', status: 'done' }, { id: 'b' }] });
    // Another orchestrator version's registry: a table named children without the data-contract columns.
    execSql(file, "CREATE TABLE children (name TEXT, status TEXT, session_id TEXT); INSERT INTO children VALUES ('api', 'running', 'ws-123')");
    const failures = [];
    const counting = db => ({
      async all(sql) {
        try {
          return await db.all(sql);
        } catch (error) {
          failures.push(error.message);
          throw error;
        }
      },
    });
    const source = { read: (target, fn) => withReadOnly(target, { backend }, db => fn(counting(db))) };
    const result = await readSessionDb(file, source);
    assert.deepEqual(result.todos.map(todo => [todo.id, todo.status]), [['a', 'done'], ['b', 'pending']]);
    assert.deepEqual(result.deps, []);
    assert.equal(result.children, null);
    assert.deepEqual(result.notes, ['its children table is not in the data-contract format, so it is ignored']);
    assert.deepEqual(failures, []);
  });

  test(`${backend}: a todos table without a column that the read selects is ignored with a note`, async () => {
    const file = path.join(home.dir(`cli-foreign-todos-${backend}`), 'session.db');
    execSql(file, `CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT, status TEXT); INSERT INTO todos VALUES ('a', 'First', 'done');
      CREATE TABLE todo_deps (todo_id TEXT, depends_on TEXT); INSERT INTO todo_deps VALUES ('b', 'a')`);
    assert.deepEqual(await readSessionDb(file, { backend }), {
      todos: [], deps: [{ todoId: 'b', dependsOn: 'a' }], children: null,
      notes: ['its todos table is not in the data-contract format, so it is ignored'],
    });
  });
}

test('a live session.db with a children table of another shape is read twice on one connection', { skip: !canWriteWithNode }, async () => {
  const file = path.join(tempDir('swarm-foreign-children-'), 'session.db');
  const writer = openWriter(file);
  const reader = createSqliteReader({ backend: 'node' });
  try {
    writer.exec(`PRAGMA journal_mode = WAL; CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT);
      INSERT INTO todos (id, title, status) VALUES ('a', 'First', 'done');
      CREATE TABLE children (name TEXT, owns TEXT, last_report TEXT); INSERT INTO children VALUES ('api', 'src/api', 'done');`);
    for (let i = 0; i < 2; i += 1) {
      const result = await readSessionDb(file, reader);
      assert.deepEqual(result.todos.map(todo => [todo.id, todo.status]), [['a', 'done']]);
      assert.equal(result.children, null);
      assert.equal(result.notes.length, 1);
      assert.equal(reader.opened, 1, 'no statement failed, so the connection was not discarded');
      assert.equal(reader.openConnections, 1);
    }
  } finally {
    reader.close();
    writer.close();
  }
});

/**
 * A session.db source whose query for `failing` fails, as a busy or locked database does; the other queries see `tables`,
 * each in the data-contract shape.
 */
function failingSource(failing, tables = ['todos', 'todo_deps', 'children']) {
  const rows = {
    tables: tables.map(name => ({ name })),
    todos: [{ id: 'a', title: 'First', description: null, status: 'done' }],
    deps: [],
    children: [],
  };
  for (const [name, { columns }] of Object.entries(SESSION_DB_TABLES)) rows[`${name}Columns`] = columns.map(column => ({ name: column }));
  const db = {
    async all(sql) {
      const name = Object.keys(SESSION_DB_QUERIES).find(key => SESSION_DB_QUERIES[key] === sql);
      if (name === failing) throw new Error('database is locked');
      return rows[name];
    },
  };
  return { read: (file, fn) => fn(db) };
}

test('a failed session.db query rejects with the query name instead of giving empty tables', async () => {
  await assert.rejects(readSessionDb('session.db', failingSource('todos')), /^Error: session\.db todos: database is locked$/);
  await assert.rejects(readSessionDb('session.db', failingSource('tables')), /^Error: session\.db tables: database is locked$/);
  await assert.rejects(readSessionDb('session.db', failingSource('children')), /^Error: session\.db children: database is locked$/);
  // Asking a present table for its columns can only fail as the database does, and that failure propagates too.
  await assert.rejects(readSessionDb('session.db', failingSource('todosColumns')), /^Error: session\.db todosColumns: database is locked$/);
  await assert.rejects(readSessionDb('session.db', failingSource('childrenColumns')), /^Error: session\.db childrenColumns: database is locked$/);
});

test('a missing optional session.db table is not an error', async () => {
  assert.deepEqual(await readSessionDb('session.db', failingSource(null, ['todos', 'todo_deps'])), {
    todos: [{ id: 'a', title: 'First', description: '', status: 'done' }], deps: [], children: null,
  });
  // A query for an absent table never runs, so its failure cannot show.
  assert.deepEqual(await readSessionDb('session.db', failingSource('children', ['todos'])), {
    todos: [{ id: 'a', title: 'First', description: '', status: 'done' }], deps: [], children: null,
  });
});

test('a failed first session.db read caches nothing, and the next get retries with unchanged stamps', async () => {
  const file = home.sessionDb('cli-first-fails', { todos: [{ id: 'a' }] });
  let reads = 0;
  const get = createSessionDbCache(async () => {
    reads += 1;
    if (reads === 1) throw new Error('session.db tables: database is locked');
    return { read: reads };
  });
  await assert.rejects(get(file), /database is locked/);
  assert.equal(get.last(file), undefined);
  assert.deepEqual(await get(file), { read: 2 });
  assert.deepEqual(await get(file), { read: 2 });
  assert.equal(reads, 2);
});

test('a failed session.db read keeps the last good value and retries on the next get', async () => {
  const file = home.sessionDb('cli-fails-later', { todos: [{ id: 'a' }] });
  let reads = 0;
  let failing = false;
  const get = createSessionDbCache(async () => {
    reads += 1;
    if (failing) throw new Error('session.db todos: database is locked');
    return { read: reads };
  });
  assert.deepEqual(await get(file), { read: 1 });
  utimesSync(file, new Date(), new Date(Date.now() + 7000));
  failing = true;
  await assert.rejects(get(file), /database is locked/);
  assert.deepEqual(get.last(file), { read: 1 });
  await assert.rejects(get(file), /database is locked/);
  assert.equal(reads, 3);
  failing = false;
  assert.deepEqual(await get(file), { read: 4 });
  assert.deepEqual(await get(file), { read: 4 });
  assert.deepEqual(get.last(file), { read: 4 });
});

test('the session.db cache re-reads only after a change', async () => {
  const file = home.sessionDb('cli-cache', { todos: [{ id: 'a' }] });
  let reads = 0;
  const get = createSessionDbCache(async () => ({ read: ++reads }));
  assert.deepEqual(await get(file), { read: 1 });
  assert.deepEqual(await get(file), { read: 1 });
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(await get(file), { read: 2 });
  assert.equal(await get(path.join(home.stateDir, 'none', 'session.db')), null);
});

test('the session.db cache drops files that are not retained', async () => {
  const keep = home.sessionDb('cli-retain-keep', { todos: [{ id: 'a' }] });
  const drop = home.sessionDb('cli-retain-drop', { todos: [{ id: 'a' }] });
  let reads = 0;
  const get = createSessionDbCache(async () => ({ read: ++reads }));
  await get(keep);
  await get(drop);
  assert.equal(reads, 2);
  get.retain(new Set([keep]));
  await get(keep);
  assert.equal(reads, 2);
  assert.deepEqual(await get(drop), { read: 3 });
});

test('the session.db cache keeps the last good value when a later read fails', async () => {
  const file = home.sessionDb('cli-last-good', { todos: [{ id: 'a' }] });
  let reads = 0;
  const get = createSessionDbCache(async () => {
    reads += 1;
    if (reads > 1) throw new Error('unreadable now');
    return { read: reads };
  });
  assert.equal(get.last(file), undefined);
  assert.deepEqual(await get(file), { read: 1 });
  utimesSync(file, new Date(), new Date(Date.now() + 9000));
  await assert.rejects(get(file), /unreadable now/);
  assert.deepEqual(get.last(file), { read: 1 });
});

test('the session.db cache also re-reads after a WAL write', async () => {
  const file = home.sessionDb('cli-wal-cache', { todos: [{ id: 'a' }] });
  const wal = `${file}-wal`;
  writeFileSync(wal, 'one');
  let reads = 0;
  const get = createSessionDbCache(async () => ({ read: ++reads }));
  assert.deepEqual(await get(file), { read: 1 });
  assert.deepEqual(await get(file), { read: 1 });
  appendFileSync(wal, 'two');
  assert.deepEqual(await get(file), { read: 2 });
  rmSync(wal);
  assert.deepEqual(await get(file), { read: 3 });
  assert.deepEqual(await get(file), { read: 3 });
});

test('parsePsOutput reads PID and start time lines', () => {
  const started = parsePsOutput('  101 Thu Oct 15 09:59:40 2026\n bad line\n202 Thu Oct 15 10:00:00 2026\n');
  assert.equal(started.size, 2);
  assert.equal(started.get(101), new Date(2026, 9, 15, 9, 59, 40).getTime());
});

test('a lock is alive only when its PID exists and started before the lock was written', async () => {
  const lockTime = new Date(2026, 9, 15, 10, 0, 0).getTime();
  const kill = pid => {
    if (pid === 2) {
      const error = new Error('no such process');
      error.code = 'ESRCH';
      throw error;
    }
  };
  const execFileImpl = (command, args, options, callback) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-o', 'pid=,lstart=', '-p', '1,3']);
    callback(null, '1 Thu Oct 15 09:59:58 2026\n3 Thu Oct 15 11:00:00 2026\n', '');
  };
  const probe = createProcessProbe({ kill, execFileImpl });
  const result = await probe([{ pid: 1, mtimeMs: lockTime }, { pid: 2, mtimeMs: lockTime }, { pid: 3, mtimeMs: lockTime }]);
  assert.deepEqual([...result], [[2, false], [1, true], [3, false]]);
});

test('when ps is unavailable, a signal check decides', async () => {
  const probe = createProcessProbe({ kill: () => {}, execFileImpl: (c, a, o, callback) => callback(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }), '', '') });
  assert.deepEqual([...(await probe([{ pid: 7, mtimeMs: 0 }]))], [[7, true]]);
});
