import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { createDemoEngine, loadFixtures, shiftTimes, simulateStep } from '../server/demo-engine.mjs';
import { createDefaultEngine } from '../server/engines.mjs';
import { createSwarmEngine } from '../engine/engine.mjs';

const seeded = seed => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const example = () => loadFixtures().snapshots[0];

test('times move to the present and durations stay as they are', () => {
  const base = example();
  const shifted = shiftTimes(base, 1000);
  assert.equal(shifted.generatedAt, base.generatedAt + 1000);
  assert.equal(shifted.units[0].timeline.segments[0].start, base.units[0].timeline.segments[0].start + 1000);
  assert.equal(shifted.feed[0].at, base.feed[0].at + 1000);
  assert.equal(shifted.needs[0].since, base.needs[0].since + 1000);
  assert.equal(shifted.units[0].busyMs, base.units[0].busyMs);
  assert.equal(shifted.units[0].monitor.everyMinutes, base.units[0].monitor.everyMinutes);
  assert.deepEqual(validateSnapshot(shifted), []);
});

test('the demo engine serves valid, current data through the engine API', async () => {
  const engine = createDemoEngine({ now: () => T, simulate: false });
  assert.equal(engine.isDemo, true);
  const snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.generatedAt, T);
  assert.deepEqual(engine.listSwarms().flatMap(validateSwarmListItem), []);
  assert.deepEqual((await engine.listHistory()).flatMap(validateRunListItem), []);
  const summary = await engine.getRunSummary('ws-1000-root');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.ok(summary.finishedAt < T);
  assert.equal(await engine.findSwarm('cli-0003-b1'), 'ws-0000-root');
});

test('simulated steps stay valid, add cost and keep feed ids unique', () => {
  const base = example();
  let snapshot = shiftTimes(base, T - base.generatedAt);
  const random = seeded(7);
  for (let step = 1; step <= 40; step += 1) {
    snapshot = simulateStep(snapshot, T + step * 5000, random);
    assert.deepEqual(validateSnapshot(snapshot), [], `step ${step}`);
  }
  assert.ok(snapshot.cost.credits > base.cost.credits);
  assert.equal(snapshot.revision, base.revision + 40);
  assert.equal(new Set(snapshot.feed.map(item => item.id)).size, snapshot.feed.length);
  const series = snapshot.cost.series;
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index].at > series[index - 1].at, 'series times increase');
    assert.ok(series[index].credits >= series[index - 1].credits, 'series is cumulative');
  }
});

test('a due PR monitor check lands in the feed and the unit\'s recent items', () => {
  const base = example();
  const due = base.units.find(unit => unit.label === 'D5').monitor.nextCheckAt + 1000;
  const next = simulateStep(base, due, () => 0.99);
  const d5 = next.units.find(unit => unit.label === 'D5');
  assert.equal(d5.monitor.lastCheckAt, due);
  assert.equal(d5.monitor.nextCheckAt, due + 10 * 60000);
  assert.equal(next.feed[0].kind, 'monitor-check');
  assert.equal(d5.recent[0].id, next.feed[0].id);
});

test('activity is simulated only between start() and stop()', async () => {
  const engine = createDemoEngine({ stepMs: 10, random: seeded(3) });
  const changes = [];
  engine.subscribe(change => changes.push(change));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(changes.length, 0, 'no timers before start()');
  engine.start();
  await new Promise(resolve => setTimeout(resolve, 80));
  engine.stop();
  const seen = changes.length;
  assert.ok(seen >= 2, `saw ${seen} changes`);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(changes.length, seen);
  const still = createDemoEngine({ simulate: false, stepMs: 10 });
  const none = [];
  still.subscribe(change => none.push(change));
  still.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  still.stop();
  assert.equal(none.length, 0);
});

test('the stress scenario is valid and covers every status, a stalled run, a warning, two live swarms and many sub-agent units', async () => {
  const engine = createDemoEngine({ scenario: 'stress', now: () => T, simulate: false });
  const snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  const statuses = new Set(snapshot.units.map(unit => unit.status));
  for (const status of ['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'archived']) assert.ok(statuses.has(status), status);
  assert.ok(snapshot.run.stalled);
  assert.ok(snapshot.diagnostics.some(entry => entry.level === 'warn'));
  assert.ok(snapshot.units.some(unit => unit.label.length > 4));
  assert.deepEqual(snapshot.units.filter(unit => unit.label.length === 4).map(unit => unit.label), ['C6-1', 'MM-1']);
  const closed = snapshot.units.find(unit => unit.label === 'C6-1');
  assert.deepEqual([closed.stage, closed.closedWithoutMerge, closed.pr.state, closed.monitor.state], ['pr_open', true, 'closed', 'ended']);
  assert.ok(snapshot.units.some(unit => unit.subagents.filter(sub => sub.status === 'running').length >= 6));
  assert.equal(engine.listSwarms().filter(swarm => swarm.lifecycle === 'live').length, 2);
  assert.throws(() => createDemoEngine({ scenario: 'nope' }), /scenario/);
  // The orchestrator's sub-agents: 23 units after every session unit, oldest first, and the orchestrator's view of them.
  const kinds = snapshot.units.map(unit => unit.kind);
  const firstSubagent = kinds.indexOf('subagent');
  assert.equal(kinds.filter(kind => kind === 'subagent').length, 23);
  assert.ok(kinds.slice(firstSubagent).every(kind => kind === 'subagent'), 'every session unit comes first');
  const subagents = snapshot.units.slice(firstSubagent);
  subagents.slice(1).forEach((unit, index) => assert.ok(unit.startedAt >= subagents[index].startedAt, `${unit.label} starts after the one before`));
  assert.equal(new Set(snapshot.units.map(unit => unit.label)).size, snapshot.units.length, 'labels are unique');
  const listed = bucket => snapshot.units.filter(unit => unit.bucket === bucket).length;
  assert.deepEqual(snapshot.omittedSubagents, { done: 37, failed: 4 });
  assert.equal(snapshot.counts.done, listed('done') + 37);
  assert.equal(snapshot.counts.failed, listed('failed') + 4);
  const unitIds = new Set(snapshot.units.map(unit => unit.id));
  const barIds = new Set(snapshot.orchestrator.timeline.subagents.map(sub => sub.id));
  const viewIds = new Set(snapshot.orchestrator.subagents.map(sub => sub.id));
  for (const unit of subagents) assert.ok(barIds.has(unit.id) && viewIds.has(unit.id), `${unit.label} has a bar and a view`);
  const notUnits = snapshot.orchestrator.timeline.subagents.filter(sub => !unitIds.has(sub.id));
  assert.deepEqual(notUnits.map(sub => sub.id).sort(), ['call-9190-omitted', 'call-9191-omitted']);
  assert.ok(notUnits.every(sub => sub.end !== null), 'only finished sub-agents are left out of units');
});

test('every reference in a scenario swarm points inside that swarm', async () => {
  for (const scenario of ['example', 'stress']) {
    const engine = createDemoEngine({ scenario, now: () => T, simulate: false });
    for (const { id } of engine.listSwarms()) {
      const snapshot = await engine.getSnapshot(id);
      if (!snapshot) continue;
      const ids = new Set([snapshot.orchestrator.id, ...snapshot.units.map(unit => unit.id)]);
      const refs = [
        ...snapshot.feed.map(item => item.unitId),
        ...snapshot.needs.flatMap(need => [need.fromId, ...need.unitIds]),
        ...snapshot.units.flatMap(unit => [unit.parentId, ...unit.recent.map(item => item.unitId)]),
      ];
      for (const ref of refs) assert.ok(ids.has(ref), `${scenario}, ${id}: ${ref}`);
    }
  }
});

test('the default engine is PR 1\'s engine over Copilot data', () => {
  assert.equal(createDefaultEngine, createSwarmEngine);
});
