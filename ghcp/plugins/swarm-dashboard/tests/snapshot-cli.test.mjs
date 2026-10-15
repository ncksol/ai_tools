import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { parseArguments } from '../scripts/swarm-snapshot.mjs';
import { at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

const script = fileURLToPath(new URL('../scripts/swarm-snapshot.mjs', import.meta.url));
const run = args => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the command prints valid JSON for swarms, snapshots, history and run summaries, and writes nothing', () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-cli-'), 'history');
  const base = ['--copilot-home', home.root, '--history-dir', historyDir, '--now', new Date(at(60)).toISOString(), '--no-pr-lookup'];
  const swarms = JSON.parse(run([...base, '--list']));
  assert.deepEqual(swarms.map(swarm => swarm.id), ['ws-root', 'ws-old']);
  assert.deepEqual(swarms.flatMap(validateSwarmListItem), []);
  const snapshot = JSON.parse(run(base));
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.run.id, 'ws-root');
  const compact = run([...base, '--swarm', 'ws-old', '--compact']);
  assert.equal(compact.trim().split('\n').length, 1);
  assert.equal(JSON.parse(compact).run.id, 'ws-old');
  assert.deepEqual(JSON.parse(run([...base, '--history'])).map(item => item.id), ['ws-old']);
  assert.deepEqual(validateRunSummary(JSON.parse(run([...base, '--run', 'ws-old']))), []);
  assert.equal(existsSync(historyDir), false);
});

test('bad options exit 2 and unknown swarms exit 1 with null', () => {
  const bad = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option --nope/);
  assert.equal(bad.stdout, '');
  const home = scenario();
  const missing = spawnSync(process.execPath, [script, '--copilot-home', home.root, '--swarm', 'nope', '--no-pr-lookup', '--now', String(at(60))], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout.trim(), 'null');
  assert.match(missing.stderr, /No swarm nope/);
});

test('argument parsing rejects conflicting or malformed options', () => {
  assert.throws(() => parseArguments(['--list', '--history']), /only one of/);
  assert.throws(() => parseArguments(['--swarm']), /needs a value/);
  assert.throws(() => parseArguments(['--sqlite', 'mysql']), /auto, node or cli/);
  assert.throws(() => parseArguments(['--now', 'yesterday']), /ISO time or epoch/);
  assert.deepEqual(parseArguments(['--swarm', 'ws-1', '--compact']), { swarm: 'ws-1', compact: true });
});
