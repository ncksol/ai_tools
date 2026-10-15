import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

function fingerprint(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push([path.relative(dir, full), createHash('sha1').update(readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir);
  return out;
}

test('the engine follows a swarm from live to history without writing Copilot data', async () => {
  const home = scenario();
  const before = fingerprint(home.root);
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });

  await engine.refresh();
  const swarms = engine.listSwarms();
  assert.deepEqual(swarms.map(swarm => [swarm.id, swarm.lifecycle, swarm.units]), [['ws-root', 'live', 2], ['ws-old', 'finished', 1]]);
  assert.deepEqual(swarms.flatMap(validateSwarmListItem), []);
  let snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.run.id, 'ws-root');
  assert.equal(snapshot.orchestrator.statusDetail, 'waiting_question');
  assert.deepEqual(snapshot.units.map(unit => [unit.label, unit.statusDetail]), [['a1', 'idle'], ['u1', 'idle']]);
  assert.deepEqual(snapshot.units[0].progress, { done: 1, total: 2 });
  assert.equal(snapshot.units[0].report.title, 'API done.');
  assert.equal(snapshot.cost.credits, 7);
  assert.deepEqual(snapshot.needs.map(need => need.labels), [['a1']]);
  const firstRevision = snapshot.revision;

  const changes = [];
  engine.subscribe(() => { throw new Error('a broken listener'); });
  engine.subscribe(change => changes.push(change));
  await engine.refresh();
  assert.deepEqual(changes, []);

  const asking = new EventLog(at(61));
  asking.turnStart();
  asking.ask('Which colour?');
  home.writeEvents('cli-ui', asking.events, { append: true });
  clock = at(62);
  await engine.refresh();
  assert.deepEqual(changes.map(change => change.swarmIds), [['ws-root']]);
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.units[1].statusDetail, 'waiting_question');
  assert.ok(snapshot.revision > firstRevision);

  const restart = new EventLog(at(6));
  restart.start();
  home.writeEvents('cli-ui', restart.events);
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.units[1].statusDetail, 'idle');
  assert.equal(snapshot.units[1].lastEventAt, at(6));

  const answered = new EventLog(at(63));
  answered.done('call-1', { result: 'Yes' });
  answered.turnEnd();
  home.writeEvents('cli-root', answered.events, { append: true });
  clock = at(63) + 2 * HOUR + MINUTE;
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.run.lifecycle, 'finished');
  assert.equal(snapshot.run.finishedAt, at(63));
  assert.ok(existsSync(path.join(historyDir, 'runs', 'ws-root.json')));
  const history = await engine.listHistory();
  assert.deepEqual(history.map(item => [item.id, item.summarized]), [['ws-root', true], ['ws-old', false]]);
  assert.deepEqual(history.flatMap(validateRunListItem), []);
  assert.deepEqual(validateRunSummary(await engine.getRunSummary('ws-root')), []);
  await engine.refresh();
  assert.equal(engine.listSwarms()[0].lifecycle, 'finished');

  const after = new Map(fingerprint(home.root));
  assert.deepEqual([...after.keys()], before.map(([file]) => file));
  for (const [file, hash] of before) if (!file.endsWith('events.jsonl')) assert.equal(after.get(file), hash, file);
});

test('findSwarm maps any session of a swarm to its root', async () => {
  const home = scenario();
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  assert.equal(await engine.findSwarm('ws-root'), 'ws-root');
  assert.equal(await engine.findSwarm('cli-root'), 'ws-root');
  assert.equal(await engine.findSwarm('cli-api'), 'ws-root');
  assert.equal(await engine.findSwarm('ws-ui'), 'ws-root');
  assert.equal(await engine.findSwarm('cli-old-child'), 'ws-old');
  assert.equal(await engine.findSwarm('nope'), null);
});

test('with persistHistory false the engine writes nothing', async () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, persistHistory: false, now: () => at(60) + 3 * HOUR, processProbe: alwaysAlive, prLookup: 'off' });
  const summary = await engine.getRunSummary('ws-old');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(existsSync(historyDir), false);
});

test('start polls until stop, and creating an engine starts nothing', async () => {
  const home = scenario();
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => (clock += 1000), processProbe: alwaysAlive, prLookup: 'off' });
  let seen = 0;
  engine.subscribe(() => { seen += 1; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(seen, 0);
  engine.start({ intervalMs: 20 });
  const deadline = Date.now() + 10_000;
  while (seen < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  engine.stop();
  assert.ok(seen >= 2, `expected repeated refreshes, saw ${seen}`);
  await engine.refresh();
  const after = seen;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(seen, after);
});

test('missing Copilot data degrades to diagnostics', async () => {
  const engine = createSwarmEngine({ copilotHome: tempDir('swarm-empty-'), historyDir: path.join(tempDir('swarm-engine-'), 'h'), prLookup: 'off' });
  await engine.refresh();
  assert.deepEqual(engine.listSwarms(), []);
  assert.equal(await engine.getSnapshot(), null);
  assert.ok(engine.diagnostics().some(item => item.source === 'data.db' && item.level === 'warn'));
});
