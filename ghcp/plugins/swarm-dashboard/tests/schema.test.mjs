import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNT_BUCKETS, DISPLAY_STATES, MAX_FINISHED_SUBAGENT_UNITS, SCHEMA_VERSION, SESSION_KINDS, STAGES, STATUS_DETAILS, SUBAGENT_STATUSES,
  validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem,
} from '../engine/schema.mjs';
import { createFakeEngine } from '../engine/fake-engine.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const isSubagentUnit = unit => unit.kind === 'subagent';

test('the example snapshot matches the schema', () => {
  const snapshot = fixture('example-snapshot.json');
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validateSnapshot(snapshot), []);
});

test('the example swarm list, history and run summary match the schema', () => {
  assert.deepEqual(fixture('example-swarms.json').flatMap(validateSwarmListItem), []);
  assert.deepEqual(fixture('example-history.json').flatMap(validateRunListItem), []);
  assert.deepEqual(validateRunSummary(fixture('example-run-summary.json')), []);
});

test('the example snapshot shows the main states and consistent counts', () => {
  const snapshot = fixture('example-snapshot.json');
  const shown = new Set([snapshot.orchestrator, ...snapshot.units].map(session => session.status));
  for (const state of DISPLAY_STATES) assert.ok(shown.has(state), `example lacks state ${state}`);
  const { omittedSubagents } = snapshot;
  const expected = Object.fromEntries(COUNT_BUCKETS.map(bucket => [
    bucket,
    snapshot.units.filter(unit => unit.bucket === bucket).length + (omittedSubagents[bucket] ?? 0),
  ]));
  assert.deepEqual(snapshot.counts, expected, 'counts are the buckets of every unit plus omittedSubagents');
  assert.deepEqual(Object.keys(omittedSubagents), ['done', 'failed']);
  // Sub-agent unit costs are already inside the orchestrator's cost: never add them to a total.
  const sessionUnits = snapshot.units.filter(unit => !isSubagentUnit(unit));
  const total = [snapshot.orchestrator, ...sessionUnits].reduce((sum, session) => sum + session.cost.credits, 0);
  assert.equal(Math.round(total * 10) / 10, snapshot.cost.credits);
});

test('the example snapshot is internally consistent', () => {
  const snapshot = fixture('example-snapshot.json');
  const sessionUnits = snapshot.units.filter(unit => !isSubagentUnit(unit));
  const subagentUnits = snapshot.units.filter(isSubagentUnit);
  const children = new Map();
  for (const unit of sessionUnits) children.set(unit.parentId, [...(children.get(unit.parentId) ?? []), unit]);
  const order = [];
  const walk = id => {
    for (const unit of [...(children.get(id) ?? [])].sort((a, b) => a.startedAt - b.startedAt)) {
      order.push(unit.id);
      walk(unit.id);
    }
  };
  walk(snapshot.orchestrator.id);
  assert.deepEqual(sessionUnits.map(unit => unit.id), order, 'session units are depth-first by creation time');
  assert.deepEqual(
    snapshot.units.slice(0, sessionUnits.length).map(unit => unit.id), order,
    'session units come before sub-agent units',
  );
  assert.deepEqual(
    subagentUnits.map(unit => unit.id), [...subagentUnits].sort((a, b) => a.startedAt - b.startedAt).map(unit => unit.id),
    'sub-agent units are oldest start first',
  );
  const sum = values => Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10;
  const sessions = [snapshot.orchestrator, ...sessionUnits];
  assert.equal(sum(snapshot.cost.byModel.map(entry => entry.credits)), snapshot.cost.credits);
  assert.equal(sum(snapshot.cost.byModel.map(entry => entry.calls)), sum(sessions.map(session => session.cost.calls)));
  assert.equal(snapshot.cost.maxUnitCredits, Math.max(...snapshot.units.map(unit => unit.cost.credits)));
  const { series } = snapshot.cost;
  series.forEach((point, index) => {
    assert.equal(point.at % (5 * 60 * 1000), 0, `series[${index}] starts a 5-minute bucket`);
    if (index) assert.ok(point.credits >= series[index - 1].credits, `series[${index}] is cumulative`);
  });
  assert.equal(series[series.length - 1].credits, snapshot.cost.credits);
});

test('the example snapshot lists the orchestrator\'s one-off sub-agents as units in every state', () => {
  const snapshot = fixture('example-snapshot.json');
  const { orchestrator } = snapshot;
  const currentCli = orchestrator.cliSessionIds[orchestrator.cliSessionIds.length - 1];
  const subagentUnits = snapshot.units.filter(isSubagentUnit);
  const detail = { busy: 'busy', stuck_subagent: 'stuck', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
  const chipStatus = { busy: 'running', stuck_subagent: 'stuck', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
  for (const statusDetail of Object.keys(detail)) {
    assert.equal(subagentUnits.filter(unit => unit.statusDetail === statusDetail).length, 1, `one sub-agent unit is ${statusDetail}`);
  }
  assert.ok(subagentUnits.every(unit => unit.statusDetail in detail));
  assert.equal(subagentUnits.filter(unit => unit.endedAt !== null).length <= MAX_FINISHED_SUBAGENT_UNITS, true);
  const expectedState = {
    busy: ['busy', 'working'], stuck_subagent: ['stuck', 'stuck'], completed: ['done', 'done'],
    failed: ['blocked', 'failed'], cancelled: ['blocked', 'failed'],
  };
  for (const unit of subagentUnits) {
    const where = `sub-agent unit ${unit.id}`;
    assert.equal(unit.kind, 'subagent', where);
    assert.equal(unit.parentId, orchestrator.id, where);
    assert.equal(unit.depth, 1, where);
    assert.equal(unit.stage, 'subagent', where);
    assert.equal(unit.pr, null, where);
    assert.deepEqual(unit.monitor, { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null }, where);
    assert.equal(unit.outcome, null, where);
    assert.equal(unit.progress, null, where);
    assert.equal(unit.dependsOn, null, where);
    assert.equal(unit.todoId, null, where);
    assert.equal(unit.closedWithoutMerge, false, where);
    assert.deepEqual(unit.cliSessionIds, [], where);
    assert.equal(unit.branch, null, where);
    assert.equal(unit.waitingOnUserMs, 0, where);
    assert.ok(unit.agent && unit.agent.type && ['sync', 'background'].includes(unit.agent.mode), `${where} has an agent`);
    assert.deepEqual([unit.status, unit.bucket], expectedState[unit.statusDetail], where);
    assert.match(unit.label, /^[A-Za-z0-9._-]{1,32}$/, `${where} label is safe`);
    const chip = orchestrator.subagents.find(sub => sub.id === unit.id);
    assert.ok(chip, `${where} has a chip on the orchestrator`);
    assert.equal(chip.status, chipStatus[unit.statusDetail], where);
    assert.equal(chip.type, unit.agent.type, where);
    assert.equal(chip.mode, unit.agent.mode, where);
    assert.equal(chip.model, unit.model, where);
    assert.equal(chip.startedAt, unit.startedAt, where);
    assert.equal(chip.endedAt, unit.endedAt, where);
    assert.equal(chip.credits, unit.cost.credits, `${where} cost equals its chip credits`);
    assert.equal(chip.task, unit.name, where);
    assert.ok(orchestrator.timeline.subagents.some(bar => bar.id === unit.id && bar.start === unit.startedAt && bar.end === unit.endedAt), where);
    if (unit.statusDetail === 'stuck_subagent') {
      assert.equal(unit.since, unit.lastEventAt, 'stuck: since is its last event');
      assert.equal(unit.reason, 'No events for 15 min; the limit is 10 min.');
      assert.equal(snapshot.generatedAt - unit.since, 15 * 60 * 1000);
      assert.ok(snapshot.generatedAt - unit.startedAt >= 30 * 60 * 1000);
      assert.deepEqual(unit.timeline.segments[unit.timeline.segments.length - 1], { start: unit.since, end: null, state: 'stuck' });
    }
    if (unit.endedAt !== null) assert.equal(unit.since, unit.endedAt, `${where} since is endedAt once finished`);
    // Its start and finish feed items belong to its unit, not to the orchestrator.
    const own = snapshot.feed.filter(item => item.unitId === unit.id);
    assert.ok(own.every(item => item.label === unit.label), where);
    assert.equal(own.find(item => item.kind === 'subagent-start')?.id, `${unit.id}:subagent-start:${currentCli}/${unit.id}`, where);
    assert.equal(own.some(item => item.kind === 'subagent-done'), unit.endedAt !== null, where);
    for (const item of own.filter(entry => entry.kind === 'subagent-done')) {
      assert.ok(item.id.startsWith(`${unit.id}:subagent-done:${currentCli}/`), item.id);
    }
    assert.equal(orchestrator.recent.some(item => item.id.includes(`:${unit.id}`) && item.kind.startsWith('subagent-')), false, where);
  }
  const byDetail = Object.fromEntries(subagentUnits.map(unit => [unit.statusDetail, unit]));
  assert.equal(byDetail.busy.agent.type, 'explore');
  assert.ok(byDetail.busy.activity.tool, 'the busy sub-agent has an open tool call');
  assert.equal(byDetail.busy.report.status, 'progress');
  assert.equal(byDetail.stuck_subagent.agent.type, 'research');
  assert.equal(byDetail.completed.agent.type, 'general-purpose');
  assert.equal(byDetail.completed.agent.mode, 'sync');
  assert.equal(byDetail.completed.report.status, 'complete');
  assert.equal(byDetail.completed.report.source, 'message');
  assert.ok(byDetail.completed.timeline.marks.some(mark => mark.kind === 'report' && mark.at === byDetail.completed.endedAt));
  assert.equal(byDetail.failed.agent.type, 'task');
  assert.equal(byDetail.failed.reason, 'Failed: model request failed after 3 retries.');
  assert.equal(byDetail.cancelled.agent.type, 'orchestrator-worker');
  assert.equal(byDetail.cancelled.reason, 'Cancelled after 12 min.');
  assert.equal(byDetail.cancelled.endedAt - byDetail.cancelled.startedAt, 12 * 60 * 1000);
  // The orchestrator keeps waiting: waiting takes precedence over a stuck sub-agent.
  assert.equal(orchestrator.statusDetail, 'waiting_question');
  assert.equal(orchestrator.subagents.find(sub => sub.id === byDetail.stuck_subagent.id).status, 'stuck');
  for (const unit of snapshot.units.filter(entry => !isSubagentUnit(entry))) assert.equal(unit.agent, null, `${unit.id} is a session unit`);
});

test('the example snapshot has unique feed and need ids, matching recent items and consistent end times', () => {
  const snapshot = fixture('example-snapshot.json');
  const feedIds = snapshot.feed.map(item => item.id);
  assert.equal(new Set(feedIds).size, feedIds.length, 'feed ids are unique');
  const needIds = snapshot.needs.map(need => need.id);
  assert.equal(new Set(needIds).size, needIds.length, 'need ids are unique');
  const sessions = [snapshot.orchestrator, ...snapshot.units];
  for (const session of sessions) {
    const expected = snapshot.feed.filter(item => item.unitId === session.id).slice(0, 6);
    assert.deepEqual(session.recent, expected, `${session.id} recent matches its feed items`);
    const { segments } = session.timeline;
    assert.equal(segments[segments.length - 1].end, session.endedAt, `${session.id} last segment ends at endedAt`);
  }
  const f2a = snapshot.units.find(unit => unit.id === 'ws-0002-f2a');
  assert.equal(f2a.endedAt, f2a.pr.mergedAt);
});

test('the validator reports missing, unexpected and invalid fields with their paths', () => {
  const snapshot = fixture('example-snapshot.json');
  delete snapshot.units[0].stage;
  snapshot.units[1].extra = true;
  snapshot.units[2].status = 'sleeping';
  snapshot.cost.series[0].at = 'yesterday';
  snapshot.needs[0].since = 1.5;
  const errors = validateSnapshot(snapshot);
  assert.ok(errors.includes('snapshot.units[0].stage: missing'), errors.join('\n'));
  assert.ok(errors.includes('snapshot.units[1].extra: unexpected field'), errors.join('\n'));
  assert.ok(errors.some(error => error.startsWith('snapshot.units[2].status: expected one of busy')), errors.join('\n'));
  assert.ok(errors.some(error => error.startsWith('snapshot.cost.series[0].at: invalid value')), errors.join('\n'));
  assert.ok(errors.some(error => error.startsWith('snapshot.needs[0].since: invalid value')), errors.join('\n'));
});

test('the validator requires feed ids, need ids and recent items', () => {
  const snapshot = fixture('example-snapshot.json');
  delete snapshot.feed[0].id;
  delete snapshot.needs[0].id;
  delete snapshot.units[0].recent;
  const errors = validateSnapshot(snapshot);
  assert.ok(errors.includes('snapshot.feed[0].id: missing'), errors.join('\n'));
  assert.ok(errors.includes('snapshot.needs[0].id: missing'), errors.join('\n'));
  assert.ok(errors.includes('snapshot.units[0].recent: missing'), errors.join('\n'));
});

test('the validator requires agent on every unit and omittedSubagents on the snapshot', () => {
  const snapshot = fixture('example-snapshot.json');
  delete snapshot.units[0].agent;
  delete snapshot.omittedSubagents;
  const errors = validateSnapshot(snapshot);
  assert.ok(errors.includes('snapshot.units[0].agent: missing'), errors.join('\n'));
  assert.ok(errors.includes('snapshot.omittedSubagents: missing'), errors.join('\n'));

  const partial = fixture('example-snapshot.json');
  delete partial.omittedSubagents.failed;
  partial.omittedSubagents.stuck = 1;
  const bucketErrors = validateSnapshot(partial);
  assert.ok(bucketErrors.includes('snapshot.omittedSubagents.failed: missing'), bucketErrors.join('\n'));
  assert.ok(bucketErrors.includes('snapshot.omittedSubagents.stuck: unexpected field'), bucketErrors.join('\n'));

  const bad = fixture('example-snapshot.json');
  const subagentUnit = bad.units.find(isSubagentUnit);
  subagentUnit.agent.mode = 'foreground';
  delete subagentUnit.agent.effort;
  const agentErrors = validateSnapshot(bad);
  assert.ok(agentErrors.some(error => error.startsWith(`snapshot.units[${bad.units.indexOf(subagentUnit)}].agent.mode: expected one of sync, background`)), agentErrors.join('\n'));
  assert.ok(agentErrors.includes(`snapshot.units[${bad.units.indexOf(subagentUnit)}].agent.effort: missing`), agentErrors.join('\n'));
});

test('the contract accepts the sub-agent enum values', () => {
  assert.equal(MAX_FINISHED_SUBAGENT_UNITS, 20);
  assert.ok(DISPLAY_STATES.includes('done'));
  assert.deepEqual(STATUS_DETAILS.slice(STATUS_DETAILS.indexOf('failed'), STATUS_DETAILS.indexOf('failed') + 3), ['failed', 'completed', 'cancelled']);
  assert.ok(STAGES.includes('subagent'));
  assert.ok(SESSION_KINDS.includes('subagent'));
  assert.ok(SUBAGENT_STATUSES.includes('cancelled'));

  const snapshot = fixture('example-snapshot.json');
  const unit = snapshot.units.find(entry => entry.statusDetail === 'cancelled');
  assert.deepEqual([unit.kind, unit.status, unit.stage], ['subagent', 'blocked', 'subagent']);
  const done = snapshot.units.find(entry => entry.statusDetail === 'completed');
  assert.deepEqual([done.status, done.statusDetail], ['done', 'completed']);
  assert.deepEqual(validateSnapshot(snapshot), []);
  // A chip of a child session can be cancelled too.
  snapshot.units[0].subagents[0].status = 'cancelled';
  assert.deepEqual(validateSnapshot(snapshot), []);
  snapshot.units[0].subagents[0].status = 'aborted';
  assert.ok(validateSnapshot(snapshot).some(error => error.startsWith('snapshot.units[0].subagents[0].status: expected one of running, completed, failed, stuck, cancelled')));
});

test('the fake engine serves fixtures through the engine API', async () => {
  const snapshot = fixture('example-snapshot.json');
  const history = fixture('example-history.json');
  const summary = fixture('example-run-summary.json');
  const engine = createFakeEngine({ snapshots: [snapshot], swarms: fixture('example-swarms.json'), history, summaries: [summary] });
  assert.equal(engine.listSwarms()[0].id, snapshot.run.id);
  assert.deepEqual(await engine.getSnapshot(), snapshot);
  assert.deepEqual(await engine.getSnapshot(snapshot.run.id), snapshot);
  assert.equal(await engine.getSnapshot('missing'), null);
  const changes = [];
  const unsubscribe = engine.subscribe(change => changes.push(change));
  engine.push({ ...snapshot, revision: snapshot.revision + 1 });
  unsubscribe();
  engine.push(snapshot);
  assert.deepEqual(changes, [{ revision: 1, swarmIds: [snapshot.run.id] }]);
  assert.equal((await engine.listHistory()).length, history.length);
  assert.equal((await engine.getRunSummary(summary.id)).id, summary.id);
  assert.equal(await engine.getRunSummary('missing'), null);
  assert.deepEqual(engine.diagnostics(), []);
});

test('the fake engine finds the swarm of a session', async () => {
  const snapshot = fixture('example-snapshot.json');
  const engine = createFakeEngine({ snapshots: [snapshot] });
  const root = snapshot.run.id;
  assert.equal(await engine.findSwarm(root), root);
  assert.equal(await engine.findSwarm(snapshot.orchestrator.cliSessionIds[0]), root);
  assert.equal(await engine.findSwarm('ws-0003-b1'), root);
  assert.equal(await engine.findSwarm('cli-0003-b1'), root);
  assert.equal(await engine.findSwarm('unknown-session'), null);
  // Sub-agent unit ids are tool-call ids, not session ids.
  const subagentUnit = snapshot.units.find(isSubagentUnit);
  assert.ok(subagentUnit);
  for (const unit of snapshot.units.filter(isSubagentUnit)) assert.equal(await engine.findSwarm(unit.id), null, unit.id);
});

test('the fake engine keeps its swarm list in step with pushed snapshots', async () => {
  const snapshot = fixture('example-snapshot.json');
  const engine = createFakeEngine({ snapshots: [snapshot] });
  const [entry] = engine.listSwarms();
  assert.equal(entry.id, snapshot.run.id);
  assert.equal(entry.lifecycle, 'live');
  assert.equal(entry.units, 7, 'units counts session units only');
  assert.ok(snapshot.units.length > 7, 'the example also lists sub-agent units');
  assert.equal(entry.credits, 97652.4);

  const later = structuredClone(snapshot);
  later.run.lastActivityAt = snapshot.run.lastActivityAt + 60000;
  later.cost.credits = 98000.5;
  engine.push(later);
  const afterPush = engine.listSwarms();
  assert.equal(afterPush.length, 1);
  assert.equal(afterPush[0].lastActivityAt, later.run.lastActivityAt);
  assert.equal(afterPush[0].credits, 98000.5);

  const other = structuredClone(later);
  other.run.id = 'swarm-synthetic-2';
  other.run.lastActivityAt = later.run.lastActivityAt + 60000;
  engine.push(other);
  assert.deepEqual(engine.listSwarms().map(swarm => swarm.id), ['swarm-synthetic-2', snapshot.run.id]);
  assert.equal((await engine.getSnapshot()).run.id, 'swarm-synthetic-2');

  other.run.lifecycle = 'finished';
  engine.push(other);
  const ordered = engine.listSwarms();
  assert.deepEqual(ordered.map(swarm => swarm.id), [snapshot.run.id, 'swarm-synthetic-2']);
  assert.equal(ordered[1].lifecycle, 'finished');
  assert.equal((await engine.getSnapshot()).run.id, snapshot.run.id);
});

test('the fake engine falls back to the most recent swarm, else null', async () => {
  const finished = fixture('example-snapshot.json');
  finished.run.lifecycle = 'finished';
  const engine = createFakeEngine({ snapshots: [finished] });
  assert.equal((await engine.getSnapshot()).run.id, finished.run.id);
  const empty = createFakeEngine();
  assert.deepEqual(empty.listSwarms(), []);
  assert.equal(await empty.getSnapshot(), null);
});

test('the fake engine does not share its inputs', () => {
  const swarms = fixture('example-swarms.json');
  const name = swarms[0].name;
  const engine = createFakeEngine({ swarms });
  swarms[0].name = 'changed';
  swarms.push({ ...swarms[0], id: 'extra' });
  const listed = engine.listSwarms();
  assert.equal(listed.length, fixture('example-swarms.json').length);
  assert.equal(listed[0].name, name);
});

test('every report has repliedAt: null or a time, and a report without it fails validation', () => {
  const snapshot = fixture('example-snapshot.json');
  const reports = snapshot.units.map(unit => unit.report).filter(Boolean);
  assert.ok(reports.length > 0);
  for (const report of reports) assert.ok('repliedAt' in report, `report at ${report.at} has no repliedAt`);
  const target = snapshot.units.findIndex(unit => unit.report);
  const errorsFor = value => {
    const copy = structuredClone(snapshot);
    if (value === undefined) delete copy.units[target].report.repliedAt;
    else copy.units[target].report.repliedAt = value;
    return validateSnapshot(copy);
  };
  assert.deepEqual(errorsFor(null), []);
  assert.deepEqual(errorsFor(snapshot.units[target].report.at + 1000), []);
  assert.ok(errorsFor(undefined).includes(`snapshot.units[${target}].report.repliedAt: missing`));
  assert.ok(errorsFor('later').some(error => error.startsWith(`snapshot.units[${target}].report.repliedAt: invalid value`)));
});

test('the example snapshot has an answered and an unanswered needs_input report, and the answered one reads consistently', () => {
  const snapshot = fixture('example-snapshot.json');
  const asking = snapshot.units.filter(unit => unit.report?.status === 'needs_input');
  const answered = asking.filter(unit => unit.report.repliedAt !== null);
  const unanswered = asking.filter(unit => unit.report.repliedAt === null);
  assert.equal(answered.length, 1);
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].statusDetail, 'blocked_on_orchestrator');
  const [unit] = answered;
  assert.ok(unit.report.repliedAt > unit.report.at);
  assert.notEqual(unit.statusDetail, 'blocked_on_orchestrator');
  const text = `reported needs input: ${unit.report.title}`;
  for (const items of [unit.recent, snapshot.feed]) {
    assert.ok(items.some(item => item.unitId === unit.id && item.kind === 'report' && item.at === unit.report.at && item.text === text), 'the report feed item reads as a question');
  }
  assert.ok(unit.timeline.marks.some(mark => mark.at === unit.report.at && mark.kind === 'question' && mark.status === 'needs_input'));
});
