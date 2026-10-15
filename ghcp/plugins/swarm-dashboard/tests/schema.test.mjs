import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNT_BUCKETS, DISPLAY_STATES, SCHEMA_VERSION,
  validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem,
} from '../engine/schema.mjs';
import { createFakeEngine } from '../engine/fake-engine.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

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
  const expected = Object.fromEntries(COUNT_BUCKETS.map(bucket => [bucket, snapshot.units.filter(unit => unit.bucket === bucket).length]));
  assert.deepEqual(snapshot.counts, expected);
  const total = [snapshot.orchestrator, ...snapshot.units].reduce((sum, session) => sum + session.cost.credits, 0);
  assert.equal(Math.round(total * 10) / 10, snapshot.cost.credits);
});

test('the example snapshot is internally consistent', () => {
  const snapshot = fixture('example-snapshot.json');
  const children = new Map();
  for (const unit of snapshot.units) children.set(unit.parentId, [...(children.get(unit.parentId) ?? []), unit]);
  const order = [];
  const walk = id => {
    for (const unit of [...(children.get(id) ?? [])].sort((a, b) => a.startedAt - b.startedAt)) {
      order.push(unit.id);
      walk(unit.id);
    }
  };
  walk(snapshot.orchestrator.id);
  assert.deepEqual(snapshot.units.map(unit => unit.id), order, 'units are depth-first by creation time');
  const sum = values => Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10;
  const sessions = [snapshot.orchestrator, ...snapshot.units];
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
