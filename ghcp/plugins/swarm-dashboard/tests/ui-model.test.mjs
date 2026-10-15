import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_STAGES, STATE_LINES, archivedUnits, boardColumns, cardUnits, closedNotMerged, findByLabel, findPlanned, flattenPlan, needItems,
  planForest, planLayout, progressPercent, sharePercent, stateLine, unitEnd,
} from '../ui/model.mjs';
import { closedSnapshot, exampleSnapshot } from './helpers/ui.mjs';

const labels = units => units.map(unit => unit.label);

test('cards sort stuck, question, plan, blocked, busy, idle, merged and hide archived units', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(labels(cardUnits(snapshot)), ['I1', 'B2', 'F1', 'B1', 'D5', 'F2a']);
  assert.deepEqual(labels(archivedUnits(snapshot)), ['B0']);
});

test('a unit whose PR closed without merging is marked until it is archived', () => {
  const d5 = findByLabel(closedSnapshot(), 'D5');
  assert.equal(closedNotMerged(d5), true);
  assert.equal(d5.stage, 'pr_open');
  assert.equal(closedNotMerged({ ...d5, stage: 'archived' }), false);
  assert.equal(closedNotMerged({ ...d5, outcome: 'failed', pr: { ...d5.pr, state: 'open' } }), false);
  assert.equal(closedNotMerged(findByLabel(exampleSnapshot(), 'F2a')), false);
});

test('a unit ends at endedAt, else at its PR outcome when it has one', () => {
  const snapshot = exampleSnapshot();
  const f2a = findByLabel(snapshot, 'f2a');
  assert.equal(unitEnd(f2a), f2a.endedAt);
  assert.equal(unitEnd({ ...f2a, endedAt: null }), f2a.pr.mergedAt);
  assert.equal(unitEnd({ ...f2a, endedAt: null, outcome: null }), null);
  assert.equal(unitEnd(findByLabel(snapshot, 'B1')), null);
});

test('state lines follow statusDetail and fall back to status', () => {
  const snapshot = exampleSnapshot();
  assert.equal(stateLine(findByLabel(snapshot, 'I1')), 'Stuck · no events {t}');
  assert.equal(stateLine(findByLabel(snapshot, 'F1')), 'Blocked on orchestrator · {t}');
  assert.equal(stateLine(findByLabel(snapshot, 'F2a')), 'Merged · {a}');
  assert.equal(stateLine({ status: 'idle', statusDetail: 'something_new' }), STATE_LINES.idle);
});

test('progress and cost shares are whole percentages', () => {
  const snapshot = exampleSnapshot();
  assert.equal(progressPercent(findByLabel(snapshot, 'B1')), 70);
  assert.equal(progressPercent({ progress: null }), null);
  assert.equal(progressPercent({ progress: { done: 0, total: 0 } }), null);
  assert.equal(sharePercent(snapshot.cost.maxUnitCredits, snapshot.cost.maxUnitCredits), 100);
  assert.equal(sharePercent(9702, 24016), 40);
  assert.equal(sharePercent(5, 0), 0);
});

test('needs keep the engine order and name their units; a stalled swarm comes first', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(needItems(snapshot).map(item => [item.kind, item.from, item.verb]), [['plan', 'B2 import', 'waiting'], ['pr', 'D5 docs', 'waiting']]);
  snapshot.needs[0].unitIds = [];
  snapshot.run.stalled = { since: snapshot.generatedAt - 600000, reason: 'Swarm rule: the orchestrator and every open child are idle and no monitor is due.' };
  const items = needItems(snapshot);
  assert.deepEqual(items.map(item => [item.kind, item.from, item.verb]), [['stalled', 'Sample story B', 'stalled'], ['plan', 'Sample story B', 'waiting'], ['pr', 'D5 docs', 'waiting']]);
  assert.equal(items[0].text, snapshot.run.stalled.reason);
});

test('the plan forest stacks units and planned entries on their parents, case-insensitively', () => {
  const snapshot = exampleSnapshot();
  snapshot.planned[1].dependsOn = 'i1';
  const roots = planForest(snapshot);
  assert.deepEqual(labels(roots), ['B0']);
  const tree = node => [node.label, node.children.map(tree)];
  assert.deepEqual(tree(roots[0]), ['B0', [['F2a', []], ['B1', [['I1', [['I2', []]]], ['F1', []], ['B3', []]]], ['D5', []], ['B2', []]]]);
  assert.equal(findPlanned(snapshot, 'b3').canStart, true);
  assert.deepEqual(flattenPlan(roots).map(({ node, depth }) => `${node.label}:${depth}`), ['B0:0', 'F2a:1', 'B1:1', 'I1:2', 'I2:3', 'F1:2', 'B3:2', 'D5:1', 'B2:1']);
});

test('the plan layout gives leaves their own rows and centres parents on their children', () => {
  const roots = planForest(exampleSnapshot());
  const { pos, rows, maxDepth } = planLayout(roots);
  const at = label => [...pos].find(([node]) => node.label === label)[1];
  assert.equal(rows, 6);
  assert.equal(maxDepth, 3);
  assert.deepEqual(at('F2a'), { depth: 1, row: 0 });
  assert.deepEqual(at('I1'), { depth: 2, row: 1 });
  assert.deepEqual(at('B1'), { depth: 1, row: 2 });
  assert.deepEqual(at('B0'), { depth: 0, row: 2.75 });
});

test('dependency cycles and unknown parents become roots instead of vanishing', () => {
  const snapshot = exampleSnapshot();
  snapshot.planned = [
    { label: 'X1', name: 'first', dependsOn: 'X2', canStart: false, waitsOn: 'X2', todoId: null },
    { label: 'X2', name: 'second', dependsOn: 'X1', canStart: false, waitsOn: 'X1', todoId: null },
    { label: 'X3', name: 'orphan', dependsOn: 'nowhere', canStart: false, waitsOn: null, todoId: null },
  ];
  const all = flattenPlan(planForest(snapshot)).map(({ node }) => node.label);
  for (const label of ['X1', 'X2', 'X3']) assert.ok(all.includes(label), label);
  assert.equal(all.length, snapshot.units.length + 3);
});

test('the board has one column per stage, attention first', () => {
  const columns = boardColumns(exampleSnapshot());
  assert.deepEqual(columns.map(column => column.stage), BOARD_STAGES);
  const at = stage => columns.find(column => column.stage === stage).nodes.map(node => (node.unit ?? node.planned).label);
  assert.deepEqual(at('planned'), ['B3', 'I2']);
  assert.deepEqual(at('coding'), ['I1', 'B2', 'F1']);
  assert.deepEqual(at('pr_open'), ['D5']);
  assert.deepEqual(at('in_review'), ['B1']);
  assert.deepEqual(at('merged'), ['F2a']);
  assert.deepEqual(at('archived'), ['B0']);
});
