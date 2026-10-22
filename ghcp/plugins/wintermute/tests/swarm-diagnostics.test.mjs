import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { execSql } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';

const FOREIGN_TABLE = "CREATE TABLE children (name TEXT, status TEXT, session_id TEXT); INSERT INTO children VALUES ('x', 'running', 'ws-x')";
const note = cliId => `${cliId}: its children table is not in the data-contract format, so it is ignored`;
const OVERSIZED = 'cli-api: 1 log line over the size limit was not read in full; 0 were applied from its type and ids.';

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
  const messages = (snapshot, source) => snapshot.diagnostics.filter(item => item.source === source).map(item => item.message);

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
