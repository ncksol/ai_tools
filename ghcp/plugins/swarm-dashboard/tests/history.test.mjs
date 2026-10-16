import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateRunSummary } from '../engine/schema.mjs';
import { createHistoryStore, listItemOf, summarizeRun } from '../engine/model/history.mjs';
import { tempDir } from './helpers/temp.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const COMPUTED = 1792072800000;

test('a run summary answers time and cost first, by unit, model and sub-agent type', () => {
  const snapshot = fixture('example-snapshot.json');
  const summary = summarizeRun(snapshot, { computedAt: COMPUTED });
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(summary.finishedAt, snapshot.run.lastActivityAt);
  assert.equal(summary.tookMs, snapshot.run.lastActivityAt - snapshot.run.startedAt);
  assert.equal(summary.credits, snapshot.cost.credits);
  const sessionUnits = snapshot.units.filter(unit => unit.kind !== 'subagent');
  assert.equal(summary.busyMs, [snapshot.orchestrator, ...sessionUnits].reduce((sum, session) => sum + session.busyMs, 0));
  assert.equal(summary.waitingOnUserMs, 2_220_000);
  assert.deepEqual(summary.children, { total: 7, merged: 2, closed: 0, failed: 0, noOutcome: 5 });
  assert.equal(summary.units.length, 1 + sessionUnits.length, 'sub-agent units are not listed as run units');
  assert.equal(summary.subagents, 10, 'every sub-agent chip counts once, the orchestrator\'s one-off sub-agents included');
  assert.deepEqual(summary.units[0], {
    id: 'ws-0000-root', label: 'SB', name: 'Sample story B', isOrchestrator: true, startedAt: snapshot.run.startedAt,
    endedAt: snapshot.orchestrator.lastEventAt, busyMs: snapshot.orchestrator.busyMs, credits: 31532.4, outcome: null, merged: false,
  });
  assert.deepEqual(summary.units[1], {
    id: 'ws-0001-b0', label: 'B0', name: 'schema', isOrchestrator: false, startedAt: 1791814200000, endedAt: 1791964200000,
    busyMs: 18000000, credits: 10912, outcome: 'merged', merged: true,
  });
  assert.deepEqual(summary.subagentTypes.map(entry => entry.type), ['task', 'general-purpose', 'research', 'code-review', 'explore', 'orchestrator-worker']);
  assert.deepEqual(summary.models, snapshot.cost.byModel);
  assert.deepEqual(listItemOf(summary), {
    id: summary.id, name: summary.name, project: summary.project, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
    tookMs: summary.tookMs, busyMs: summary.busyMs, credits: summary.credits, usd: summary.usd, children: 7, merged: 2, summarized: true,
  });
});

test('a run summary never carries report text, questions or activity', () => {
  const snapshot = fixture('example-snapshot.json');
  const secret = 'sentinel-free-text-4242';
  snapshot.units[3].report.body = secret;
  snapshot.units[3].report.summary = secret;
  snapshot.units[3].activity.label = secret;
  snapshot.units[4].reason = secret;
  snapshot.needs[0].text = secret;
  snapshot.feed[0].text = secret;
  snapshot.orchestrator.timeline.marks[0].text = secret;
  snapshot.units[2].subagents[0].task = secret;
  assert.equal(JSON.stringify(summarizeRun(snapshot, { computedAt: COMPUTED })).includes(secret), false);
});

test('the history store writes atomically, lists newest first and skips bad files', async () => {
  const dir = tempDir('swarm-history-');
  const store = createHistoryStore(dir);
  const older = fixture('example-run-summary.json');
  const newer = { ...older, id: 'ws-3000-root', name: 'Later run', finishedAt: older.finishedAt + 1000 };
  await store.put(older);
  await store.put(newer);
  assert.deepEqual(await store.get(older.id), older);
  assert.deepEqual((await store.list()).map(summary => summary.id), ['ws-3000-root', 'ws-1000-root']);
  assert.deepEqual(readdirSync(path.join(dir, 'runs')).sort(), ['ws-1000-root.json', 'ws-3000-root.json']);
  writeFileSync(path.join(dir, 'runs', 'broken.json'), '{ not json');
  writeFileSync(path.join(dir, 'runs', 'invalid.json'), JSON.stringify({ id: 'invalid' }));
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.get('../escape'), null);
  assert.equal(await store.get('missing'), null);
  await assert.rejects(store.put({ ...older, id: '../escape' }), /Invalid run id/);
  await assert.rejects(store.put({ ...older, credits: 'lots' }), /Invalid run summary/);
});

test('an empty history folder lists nothing', async () => {
  assert.deepEqual(await createHistoryStore(path.join(tempDir('swarm-history-'), 'none')).list(), []);
});
