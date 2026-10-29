import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { get, openEvents } from './helpers/http.mjs';
import { alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { execSql } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';

const FOREIGN_TABLE = "CREATE TABLE children (name TEXT, status TEXT, session_id TEXT); INSERT INTO children VALUES ('x', 'running', 'ws-x')";
const note = cliId => `${cliId}: its children table is not in the data-contract format, so it is ignored`;
const OVERSIZED = 'cli-api: 1 log line over the size limit was not read in full; 0 were applied from its type and ids.';

const messages = (snapshot, source) => snapshot.diagnostics.filter(item => item.source === source).map(item => item.message);
const MISSING_CHILD = "cli-old-: the session's log is missing, so its cost is unknown.";

for (const { role, cliId, warning } of [
  { role: 'root', cliId: 'cli-old', warning: "cli-old: the session's log is missing, so its cost is unknown." },
  { role: 'child', cliId: 'cli-old-child', warning: MISSING_CHILD },
  { role: 'older alias', cliId: 'cli-old-alias', warning: MISSING_CHILD },
]) {
  test(`a missing ${role} log warns only its own swarm, including after another refresh`, async () => {
    const home = scenario();
    if (role === 'older alias') home.alias(cliId, 'ws-old', at(-1));
    else rmSync(path.join(home.stateDir, cliId, 'events.jsonl'));
    execSql(home.dataDb, 'DROP TABLE session_automations');
    const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
    try {
      await engine.refresh();
      assert.deepEqual(messages(await engine.getSnapshot('ws-root'), 'events'), [], 'an untracked run must not warn another swarm');
      const affected = await engine.getSnapshot('ws-old');
      assert.deepEqual(messages(affected, 'events'), [warning]);
      await engine.refresh();
      for (const id of ['ws-root', 'ws-old']) {
        const snapshot = await engine.getSnapshot(id);
        assert.deepEqual(messages(snapshot, 'events'), id === 'ws-old' ? [warning] : []);
        assert.equal(snapshot.diagnostics.filter(item => item.source === 'sqlite' && item.level === 'info').length, 1);
        assert.ok(snapshot.diagnostics.some(item => item.source === 'data.db' && item.level === 'warn' && item.message.includes('session_automations')));
      }
      assert.equal(engine.diagnostics().filter(item => item.message === warning).length, 1, 'aggregate diagnostics keep the warning once');
    } finally {
      engine.stop();
    }
  });
}

for (const problem of ['unreadable log', 'invalid usage line']) {
  test(`an ${problem} cost diagnostic stays within its swarm`, async () => {
    const home = scenario();
    const file = path.join(home.stateDir, 'cli-old-child', 'events.jsonl');
    if (problem === 'unreadable log') {
      rmSync(file);
      symlinkSync('events.jsonl', file);
    } else {
      appendFileSync(file, '{"type":"session.usage_record",invalid}\n');
    }
    const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
    try {
      await engine.refresh();
      assert.deepEqual(messages(await engine.getSnapshot('ws-root'), 'events'), []);
      const warnings = messages(await engine.getSnapshot('ws-old'), 'events');
      assert.ok(warnings.some(message => problem === 'unreadable log' ? message.includes('ELOOP') : message.includes('1 usage line could not be read, so the cost is incomplete')));
      await engine.refresh();
      assert.deepEqual(messages(await engine.getSnapshot('ws-root'), 'events'), []);
    } finally {
      engine.stop();
    }
  });
}

test('REST and live snapshots scope cost warnings; run summaries and listings carry none', async () => {
  const home = scenario();
  rmSync(path.join(home.stateDir, 'cli-old-child', 'events.jsonl'));
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  const server = createDashboardServer({ createEngine: () => engine, hub: { intervalMs: 60_000 } });
  const pages = [];
  await server.listen();
  const read = async route => {
    const response = await get(server.port, route);
    assert.equal(response.status, 200, route);
    return JSON.parse(response.body);
  };
  try {
    for (const id of ['ws-root', 'ws-old']) {
      const want = id === 'ws-old' ? [MISSING_CHILD] : [];
      assert.deepEqual(messages((await read(`/api/snapshot?swarm=${id}`)).snapshot, 'events'), want);
      const page = openEvents(server.port, `/api/events?swarm=${id}`);
      pages.push(page);
      const event = await page.waitFor(entry => entry.event === 'snapshot');
      assert.deepEqual(messages(event.data.snapshot, 'events'), want);
      assert.equal(Object.hasOwn(await read(`/api/runs/${id}`), 'diagnostics'), false);
    }
    for (const route of ['/api/swarms', '/api/history']) {
      const items = await read(route);
      assert.ok(items.length > 0, route);
      for (const item of items) assert.equal(Object.hasOwn(item, 'diagnostics'), false, route);
    }
    home.writeEvents('cli-old-child', []);
    await engine.refresh();
    const recovered = await pages[1].waitFor(entry => entry.event === 'snapshot' && messages(entry.data.snapshot, 'events').length === 0);
    assert.equal(recovered.data.snapshot.run.id, 'ws-old');
    assert.deepEqual(messages((await read('/api/snapshot?swarm=ws-old')).snapshot, 'events'), []);
  } finally {
    for (const page of pages) page.close();
    await server.close();
  }
});

test('each tracked swarm\'s snapshot carries only its own session notes, plus the engine-wide ones', async () => {
  const home = scenario();
  // ws-root (live) and ws-old (finished, tracked on request) each have a session.db note; ws-root also has a session-log warning.
  execSql(path.join(home.stateDir, 'cli-api', 'session.db'), FOREIGN_TABLE);
  execSql(path.join(home.stateDir, 'cli-old', 'session.db'), FOREIGN_TABLE);
  appendFileSync(path.join(home.dir('cli-api'), 'events.jsonl'), `${'x'.repeat(17 * 1024 * 1024)}\n`);
  const lookup = { request() {}, get: () => null, errors: () => [{ key: 'github:sample/repo:9', error: 'a lookup failure' }] };
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: lookup });
  await engine.getSnapshot('ws-old');
  await engine.refresh();
  const root = await engine.getSnapshot('ws-root');
  const old = await engine.getSnapshot('ws-old');
  assert.deepEqual(messages(root, 'session.db'), [note('cli-api')]);
  assert.deepEqual(messages(old, 'session.db'), [note('cli-old')]);
  assert.deepEqual(messages(root, 'events'), [OVERSIZED]);
  assert.deepEqual(messages(old, 'events'), []);
  for (const snapshot of [root, old]) assert.deepEqual(messages(snapshot, 'pr-lookup'), ['github:sample/repo:9: a lookup failure']);

  const engineWide = engine.diagnostics().map(item => item.message);
  for (const message of [note('cli-api'), note('cli-old'), OVERSIZED]) assert.ok(engineWide.includes(message), `the engine still reports ${message}`);
});
