import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSessionDbCache, listLocks, readSessionDb, readWorkspaceYaml } from '../engine/readers/session-files.mjs';
import { createProcessProbe, parsePsOutput } from '../engine/readers/process-probe.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS } from './helpers/sqlite-writer.mjs';

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
}

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
