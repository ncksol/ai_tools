import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FINISHED_SUBAGENT_UNITS, validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { createDemoEngine, loadFixtures, shiftTimes, simulateStep } from '../server/demo-engine.mjs';
import { createDefaultEngine } from '../server/engines.mjs';
import { createSwarmEngine } from '../engine/engine.mjs';
import { cardUnits, reportKind } from '../ui/model.mjs';

const seeded = seed => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const example = () => loadFixtures().snapshots[0];
/** The swarm total is the orchestrator's cost (its sub-agents included) plus every session unit's, each counted once. */
const sessionTotal = snapshot => Math.round((snapshot.orchestrator.cost.credits
  + snapshot.units.filter(unit => unit.kind === 'project' || unit.kind === 'chat').reduce((sum, unit) => sum + unit.cost.credits, 0)) * 10) / 10;

test('the example swarm counts each cost once: the orchestrator, its sub-agents included, and its session units', () => {
  const snapshot = example();
  assert.equal(snapshot.cost.credits, sessionTotal(snapshot));
});

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
  const subagentCredits = current => new Map(current.units.filter(unit => unit.kind === 'subagent').map(unit => [unit.id, unit.cost.credits]));
  let subagentSteps = 0;
  for (let step = 1; step <= 40; step += 1) {
    const before = subagentCredits(snapshot);
    snapshot = simulateStep(snapshot, T + step * 5000, random);
    assert.deepEqual(validateSnapshot(snapshot), [], `step ${step}`);
    assert.equal(snapshot.cost.credits, sessionTotal(snapshot), `step ${step}: the total is the orchestrator plus the session units`);
    if ([...subagentCredits(snapshot)].some(([id, credits]) => credits > (before.get(id) ?? 0))) subagentSteps += 1;
  }
  assert.ok(subagentSteps > 0, 'some step adds cost to a sub-agent unit');
  assert.ok(snapshot.cost.credits > base.cost.credits);
  assert.equal(snapshot.revision, base.revision + 40);
  assert.equal(new Set(snapshot.feed.map(item => item.id)).size, snapshot.feed.length);
  const series = snapshot.cost.series;
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index].at > series[index - 1].at, 'series times increase');
    assert.ok(series[index].credits >= series[index - 1].credits, 'series is cumulative');
  }
});

test('a simulated step keeps a quiet run quiet since its new last activity, and an active run active', () => {
  const base = example();
  const active = simulateStep(shiftTimes(base, T - base.generatedAt), T + 5000, seeded(3));
  assert.equal(active.run.quietSince, null);
  const quiet = shiftTimes(base, T - base.generatedAt);
  quiet.run.quietSince = quiet.run.lastActivityAt;
  const next = simulateStep(quiet, T + 5000, seeded(3));
  assert.deepEqual(validateSnapshot(next), []);
  assert.deepEqual([next.run.lastActivityAt, next.run.quietSince], [T + 5000, T + 5000]);
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

test('the stress scenario is valid and covers every status, a stalled and quiet run, a warning, two live swarms and many sub-agent units', async () => {
  const engine = createDemoEngine({ scenario: 'stress', now: () => T, simulate: false });
  const snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  const statuses = new Set(snapshot.units.map(unit => unit.status));
  for (const status of ['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'archived']) assert.ok(statuses.has(status), status);
  assert.ok(snapshot.run.stalled);
  assert.equal(snapshot.run.quietSince, snapshot.run.stalled.since, 'the stalled run is quiet, so its clock stops');
  assert.equal(snapshot.run.lastActivityAt, snapshot.run.quietSince);
  assert.ok(snapshot.run.quietSince > T - 3600000 && snapshot.run.quietSince < T, 'its quiet time moves to the present');
  assert.ok(snapshot.diagnostics.some(entry => entry.level === 'warn'));
  assert.ok(snapshot.units.some(unit => unit.label.length > 4));
  assert.deepEqual(snapshot.units.filter(unit => unit.label.length === 4).map(unit => unit.label), ['C6-1', 'MM-1']);
  const closed = snapshot.units.find(unit => unit.label === 'C6-1');
  assert.deepEqual([closed.stage, closed.closedWithoutMerge, closed.pr.state, closed.monitor.state], ['pr_open', true, 'closed', 'ended']);
  assert.ok(snapshot.units.some(unit => unit.subagents.filter(sub => sub.status === 'running').length >= 6));
  assert.equal(engine.listSwarms().filter(swarm => swarm.lifecycle === 'live').length, 2);
  assert.throws(() => createDemoEngine({ scenario: 'nope' }), /scenario/);
  // The orchestrator's sub-agents: 30 units after every session unit, oldest first, and the orchestrator's view of them.
  const kinds = snapshot.units.map(unit => unit.kind);
  const firstSubagent = kinds.indexOf('subagent');
  assert.deepEqual([kinds.filter(kind => kind !== 'subagent').length, kinds.filter(kind => kind === 'subagent').length], [18, 30]);
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
  // Units keep the most recently finished sub-agents, so omitted ones mean a full list, and they finished before it.
  const finished = subagents.filter(unit => unit.status !== 'busy' && unit.status !== 'stuck');
  assert.ok(snapshot.omittedSubagents.done + snapshot.omittedSubagents.failed > 0);
  assert.equal(finished.length, MAX_FINISHED_SUBAGENT_UNITS);
  const earliestEnd = Math.min(...finished.map(unit => unit.endedAt));
  for (const sub of notUnits) assert.ok(sub.end < earliestEnd, `${sub.id} ends before every listed finished sub-agent`);
  // Sub-agent units are part of the orchestrator's cost, so the swarm total adds them once.
  assert.equal(snapshot.cost.credits, sessionTotal(snapshot));
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

/** Session units on the Cards tab, by how their report badge reads, as [label, status] pairs. */
function cardLooks(snapshot) {
  const looks = { replied_question: [], needs_input: [], replied_blocker: [], blocked: [] };
  for (const unit of cardUnits(snapshot, snapshot.generatedAt)) {
    if (unit.kind === 'subagent' || !unit.report) continue;
    looks[reportKind(unit.report)]?.push([unit.label, unit.status]);
  }
  return looks;
}
/** A replied report was answered after it was written and by the snapshot time, and its unit no longer waits on the orchestrator. */
function assertReplied(snapshot, label) {
  const unit = snapshot.units.find(item => item.label === label);
  assert.ok(unit.report.repliedAt > unit.report.at && unit.report.repliedAt <= snapshot.generatedAt, `${label} was replied to after its report`);
  assert.ok(['busy', 'idle'].includes(unit.status), `${label} is ${unit.status}`);
  assert.notEqual(unit.statusDetail, 'blocked_on_orchestrator', label);
}

test('the example demo shows one replied question (B1) and one replied blocker (D5), and D5 stays idle', async () => {
  const snapshot = await createDemoEngine({ now: () => T, simulate: false }).getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  const looks = cardLooks(snapshot);
  assert.deepEqual(looks.replied_question, [['B1', 'busy']]);
  assert.deepEqual(looks.replied_blocker, [['D5', 'idle']]);
  for (const label of ['B1', 'D5']) assertReplied(snapshot, label);
  const d5 = snapshot.units.find(unit => unit.label === 'D5');
  const mark = d5.timeline.marks.find(item => item.at === d5.report.at);
  assert.deepEqual([mark.kind, mark.status], ['report', 'blocked'], 'D5\'s lane marks its blocked report');
  const fixture = example().units.find(unit => unit.label === 'D5');
  assert.deepEqual([fixture.report.status, fixture.report.repliedAt], ['complete', null], 'the fixture itself is unchanged');
});

test('the stress demo\'s Cards tab shows a replied and an unanswered question and blocker on session units', async () => {
  const snapshot = await createDemoEngine({ scenario: 'stress', now: () => T, simulate: false }).getSnapshot();
  const looks = cardLooks(snapshot);
  for (const [kind, units] of Object.entries(looks)) assert.ok(units.length > 0, `no ${kind} card`);
  for (const [label] of [...looks.replied_question, ...looks.replied_blocker]) assertReplied(snapshot, label);
  for (const [label] of [...looks.needs_input, ...looks.blocked]) assert.equal(snapshot.units.find(unit => unit.label === label).report.repliedAt, null, label);
});

test('the demos show set and null efforts on units and sub-agent rows, and the audited detail views cover every look', async () => {
  const looks = values => [...new Set(values.map(value => (value === null ? 'null' : typeof value === 'string' && value ? 'set' : String(value))))].sort();
  for (const scenario of ['example', 'stress']) {
    const snapshot = await createDemoEngine({ scenario, now: () => T, simulate: false }).getSnapshot();
    const sessions = [snapshot.orchestrator, ...snapshot.units];
    assert.deepEqual(looks(snapshot.units.map(unit => unit.effort)), ['null', 'set'], `${scenario}: unit efforts`);
    assert.deepEqual(looks(sessions.flatMap(session => session.subagents.map(sub => sub.effort))), ['null', 'set'], `${scenario}: sub-agent row efforts`);
    for (const unit of snapshot.units.filter(item => item.kind === 'subagent')) assert.equal(unit.effort, unit.agent.effort, `${scenario}: ${unit.label}`);
  }
  // check:layout opens these stress detail panels: a Model fact with no effort, rows with and without one, and a long model with xhigh.
  const stress = await createDemoEngine({ scenario: 'stress', now: () => T, simulate: false }).getSnapshot();
  const unit = id => stress.units.find(item => item.id === id);
  assert.equal(unit('call-9101-sub').effort, null);
  const q1 = unit('ws-9001-stress');
  assert.equal(q1.effort, 'xhigh');
  assert.ok(q1.model.length > 30, q1.model);
  assert.deepEqual(looks(q1.subagents.map(sub => sub.effort)), ['null', 'set']);
});

test('every demo report has repliedAt null or a time between its report and the snapshot, before and after simulated steps', async () => {
  const check = (snapshot, where) => {
    for (const unit of snapshot.units) {
      if (!unit.report) continue;
      const { at, repliedAt } = unit.report;
      assert.ok(repliedAt === null || (Number.isInteger(repliedAt) && repliedAt >= at && repliedAt <= snapshot.generatedAt), `${where}: ${unit.label} has repliedAt ${repliedAt}`);
    }
  };
  for (const scenario of ['example', 'stress']) {
    const engine = createDemoEngine({ scenario, now: () => T, simulate: false });
    for (const { id } of engine.listSwarms()) {
      const snapshot = await engine.getSnapshot(id);
      if (snapshot) check(snapshot, `${scenario}, ${id}`);
    }
    let snapshot = await engine.getSnapshot();
    const random = seeded(11);
    let written = 0;
    for (let step = 1; step <= 60; step += 1) {
      snapshot = simulateStep(snapshot, T + step * 5000, random);
      assert.deepEqual(validateSnapshot(snapshot), [], `${scenario}, step ${step}`);
      check(snapshot, `${scenario}, step ${step}`);
      written += snapshot.units.filter(unit => unit.report?.at === snapshot.generatedAt).length;
    }
    assert.ok(written > 0, `${scenario}: some step writes a report`);
  }
});

test('the default engine is PR 1\'s engine over Copilot data', () => {
  assert.equal(createDefaultEngine, createSwarmEngine);
});
