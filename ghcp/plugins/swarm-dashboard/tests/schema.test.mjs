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
