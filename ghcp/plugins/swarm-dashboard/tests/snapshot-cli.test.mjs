import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { main, parseArguments } from '../scripts/swarm-snapshot.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { T0, at, scenario } from './helpers/scenario.mjs';
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

/**
 * Issue #44 review: a unit with no registry row mentions PR 4800 three times, 4801 twice and its own 4802 once. 4800 and 4801 merged
 * before it started; 4802 is open on its branch. Each rejected candidate starts the next one's lookup on the following refresh.
 */
test('a one-shot snapshot with a cold PR cache reaches a later mentioned PR when the earlier ones are rejected', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-pr', projectId: 'project-1', name: 'PR story', createdAt: T0, sessionId: 'cli-pr' });
  home.workspace({ id: 'ws-pr-unit', projectId: 'project-1', name: 'Sample p1 unit', createdAt: at(5), sessionId: 'cli-pr-unit', parentId: 'ws-pr', creatorSessionId: 'cli-pr', branch: 'feature/p1', baseBranch: 'main' });
  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.at(at(10)); root.turnEnd();
  home.writeEvents('cli-pr', root.events);
  const unit = new EventLog(at(5));
  unit.start(); unit.turnStart(); unit.at(at(20));
  unit.report('ws-pr', 'PR 4800 merged. PR 4800 is in main. PR 4800 again. PR 4801 merged too, PR 4801. Opened PR 4802.', 'progress');
  unit.turnEnd();
  home.writeEvents('cli-pr-unit', unit.events);
  home.workspaceYaml('cli-pr-unit', { cwd: '/synthetic/worktrees/p1', branch: 'feature/p1', hostType: 'ado', repository: 'sample-org/sample-project/sample-repo' });
  const iso = minutes => new Date(at(minutes)).toISOString();
  const replies = {
    4800: { status: 'completed', creationDate: iso(-60), closedDate: iso(-10), sourceRefName: 'refs/heads/feature/other' },
    4801: { status: 'completed', creationDate: iso(-50), closedDate: iso(-5), sourceRefName: 'refs/heads/feature/another' },
    4802: { status: 'active', creationDate: iso(15), closedDate: null, sourceRefName: 'refs/heads/feature/p1' },
  };
  const looked = [];
  const run = async (command, args) => {
    const id = Number(args[args.indexOf('--id') + 1]);
    looked.push(id);
    await new Promise(resolve => setTimeout(resolve, 5));
    return JSON.stringify({ pullRequestId: id, title: `PR ${id}`, ...replies[id] });
  };
  let out = '';
  const code = await main(['--copilot-home', home.root, '--swarm', 'ws-pr', '--now', iso(30), '--compact'], {
    stdout: { write: text => { out += text; } }, stderr: { write: () => {} },
    createLookup: options => createPrLookup({ ...options, run, azureExtensionInstalled: async () => true }),
  });
  assert.equal(code, 0);
  const p1 = JSON.parse(out).units.find(item => item.id === 'ws-pr-unit');
  assert.deepEqual(looked, [4800, 4801, 4802]);
  assert.deepEqual([p1.pr?.id, p1.pr?.state, p1.stage], [4802, 'open', 'in_review']);
});
