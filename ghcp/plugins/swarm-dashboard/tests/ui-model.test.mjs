import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_STAGES, CARD_FADE_MS, STATE_LINES, SUBAGENT_CARD_GRACE_MS, UNIT_STAGES, archivedUnits, boardColumns, cardTimeLeft, cardUnits, closedNotMerged, feedText,
  findByLabel, findPlanned, flattenPlan, isFinishedSubagent, isSubagent, needItems, nextCardChange, omittedSubagents, planForest, planLayout, progressPercent, reportTitle, runEnd, sharePercent, stateLine, unitEnd, withoutStatusPrefix,
} from '../ui/model.mjs';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { NOW, closedSnapshot, exampleSnapshot } from './helpers/ui.mjs';

const labels = units => units.map(unit => unit.label);

test('cards sort stuck, question, plan, blocked, busy, idle, merged and hide archived units', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(labels(cardUnits(snapshot, NOW)), ['I1', 'table-research', 'B2', 'F1', 'B1', 'map-import-module', 'D5', 'F2a']);
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

test('a unit ends at endedAt, which the engine sets from its outcome', () => {
  const snapshot = exampleSnapshot();
  const f2a = findByLabel(snapshot, 'f2a');
  assert.equal(unitEnd(f2a), f2a.endedAt);
  assert.equal(unitEnd({ ...f2a, endedAt: null }), null);
  assert.equal(unitEnd(findByLabel(snapshot, 'B1')), null);
});

test('a finished run ends at finishedAt, else at its last activity, and a session without endedAt ends with it', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  const f2a = findByLabel(snapshot, 'F2a');
  assert.equal(runEnd(snapshot), null, 'a live run has not ended');
  assert.equal(unitEnd(b1, snapshot), null);
  snapshot.run.lifecycle = 'finished';
  assert.equal(runEnd(snapshot), snapshot.run.lastActivityAt);
  snapshot.run.finishedAt = NOW - 3600000;
  assert.equal(runEnd(snapshot), NOW - 3600000);
  assert.equal(unitEnd(b1, snapshot), NOW - 3600000);
  assert.equal(unitEnd(f2a, snapshot), f2a.endedAt, 'its own end comes first');
});

test('cards put a status the view does not know last', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').status = 'something_new';
  assert.deepEqual(labels(cardUnits(snapshot, NOW)), ['I1', 'table-research', 'B2', 'F1', 'map-import-module', 'D5', 'F2a', 'B1']);
});

test('cards show sub-agent units while they run or are stuck, and finished ones only in their grace period', () => {
  const snapshot = exampleSnapshot();
  const shown = labels(cardUnits(snapshot, NOW).filter(isSubagent));
  assert.deepEqual(shown, ['table-research', 'map-import-module']);
  for (const label of ['audit-schema-usage', 'migrate-fixtures', 'scan-docs-links']) assert.ok(!labels(cardUnits(snapshot, NOW)).includes(label), label);
  Object.assign(findByLabel(snapshot, 'map-import-module'), { status: 'done', statusDetail: 'completed', endedAt: NOW - SUBAGENT_CARD_GRACE_MS - 1000, since: NOW - SUBAGENT_CARD_GRACE_MS - 1000 });
  assert.deepEqual(labels(cardUnits(snapshot, NOW).filter(isSubagent)), ['table-research']);
});

/** The example with one sub-agent unit set to a finished state that ended `ago` ms before NOW. */
function finishedAgo(label, status, statusDetail, ago) {
  const snapshot = exampleSnapshot();
  const unit = findByLabel(snapshot, label);
  Object.assign(unit, { status, statusDetail, endedAt: NOW - ago, since: NOW - ago });
  return { snapshot, unit };
}
const FINISHED = [['audit-schema-usage', 'done', 'completed'], ['migrate-fixtures', 'blocked', 'failed'], ['scan-docs-links', 'blocked', 'cancelled'], ['migrate-fixtures', 'blocked', 'crashed']];

test('a finished sub-agent keeps its card for 10 minutes after it ended', () => {
  assert.equal(SUBAGENT_CARD_GRACE_MS, 10 * 60 * 1000);
  for (const [label, status, detail] of FINISHED) {
    const inside = finishedAgo(label, status, detail, SUBAGENT_CARD_GRACE_MS - 1000);
    assert.ok(cardUnits(inside.snapshot, NOW).includes(inside.unit), `${detail} inside the grace period`);
    assert.equal(isFinishedSubagent(inside.unit), true, detail);
    assert.equal(cardTimeLeft(inside.unit, NOW), 1000, detail);
    const past = finishedAgo(label, status, detail, SUBAGENT_CARD_GRACE_MS + 1000);
    assert.ok(!cardUnits(past.snapshot, NOW).includes(past.unit), `${detail} past the grace period`);
  }
});

test('a crashed sub-agent with no endedAt counts its grace period from since', () => {
  const { snapshot, unit } = finishedAgo('migrate-fixtures', 'blocked', 'crashed', 0);
  Object.assign(unit, { endedAt: null, since: NOW - 60000 });
  assert.equal(cardTimeLeft(unit, NOW), SUBAGENT_CARD_GRACE_MS - 60000);
  assert.ok(cardUnits(snapshot, NOW).includes(unit));
  unit.since = NOW - SUBAGENT_CARD_GRACE_MS - 60000;
  assert.ok(!cardUnits(snapshot, NOW).includes(unit));
});

test('a follow-up that makes a finished sub-agent busy again brings its card back', () => {
  const { snapshot, unit } = finishedAgo('audit-schema-usage', 'done', 'completed', SUBAGENT_CARD_GRACE_MS * 3);
  assert.ok(!cardUnits(snapshot, NOW).includes(unit));
  Object.assign(unit, { status: 'busy', statusDetail: 'busy', endedAt: null, since: NOW - 30000 });
  assert.equal(isFinishedSubagent(unit), false);
  assert.equal(cardTimeLeft(unit, NOW), null);
  assert.ok(cardUnits(snapshot, NOW).includes(unit));
});

test('a finished sub-agent with no time at all has no card', () => {
  const { snapshot, unit } = finishedAgo('audit-schema-usage', 'done', 'completed', 0);
  Object.assign(unit, { endedAt: null, since: null, lastEventAt: null });
  assert.equal(cardTimeLeft(unit, NOW), 0);
  assert.ok(!cardUnits(snapshot, NOW).includes(unit));
});

test('only finished sub-agents have card time left', () => {
  const snapshot = exampleSnapshot();
  for (const label of ['B1', 'F2a', 'B0', 'table-research', 'map-import-module']) assert.equal(cardTimeLeft(findByLabel(snapshot, label), NOW), null, label);
});

/** The example with a done and a failed sub-agent in their grace period, and a cancelled one past it. */
function graceSnapshot() {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'audit-schema-usage'), { endedAt: NOW - 3 * 60000, since: NOW - 3 * 60000 });
  Object.assign(findByLabel(snapshot, 'migrate-fixtures'), { endedAt: NOW - 5 * 60000, since: NOW - 5 * 60000 });
  Object.assign(findByLabel(snapshot, 'scan-docs-links'), { endedAt: NOW - SUBAGENT_CARD_GRACE_MS - 60000, since: NOW - SUBAGENT_CARD_GRACE_MS - 60000 });
  return snapshot;
}

test('cards in the grace period keep the usual sort order', () => {
  assert.deepEqual(labels(cardUnits(graceSnapshot(), NOW)), ['I1', 'table-research', 'B2', 'F1', 'migrate-fixtures', 'B1', 'map-import-module', 'D5', 'F2a', 'audit-schema-usage']);
});

test('the next change on the Cards tab is when a card starts to fade, or leaves once it fades', () => {
  assert.equal(nextCardChange(exampleSnapshot(), NOW), null, 'every finished sub-agent is past its grace period');
  const snapshot = graceSnapshot();
  const audit = findByLabel(snapshot, 'audit-schema-usage');
  const migrate = findByLabel(snapshot, 'migrate-fixtures');
  const leftAudit = cardTimeLeft(audit, NOW);
  assert.equal(leftAudit, 7 * 60000);
  assert.equal(nextCardChange(snapshot, NOW), 5 * 60000 - CARD_FADE_MS, 'the smallest wait over several');
  Object.assign(migrate, { endedAt: null, since: null, lastEventAt: null });
  assert.equal(nextCardChange(snapshot, NOW), leftAudit - CARD_FADE_MS, 'not fading yet');
  Object.assign(audit, { endedAt: NOW - SUBAGENT_CARD_GRACE_MS + 400 });
  assert.equal(nextCardChange(snapshot, NOW), 400, 'fading');
  audit.endedAt = NOW - SUBAGENT_CARD_GRACE_MS;
  assert.equal(nextCardChange(snapshot, NOW), null, 'gone');
});

test('omitted sub-agents add up the finished ones the snapshot leaves out', () => {
  const snapshot = exampleSnapshot();
  assert.equal(omittedSubagents(snapshot), 0);
  snapshot.omittedSubagents = { done: 2, failed: 1 };
  assert.equal(omittedSubagents(snapshot), 3);
  delete snapshot.omittedSubagents;
  assert.equal(omittedSubagents(snapshot), 0);
});

test('a blank report title reads "Untitled report"', () => {
  assert.equal(reportTitle({ title: '  ' }), 'Untitled report');
  assert.equal(reportTitle({ title: 'Done' }), 'Done');
});

test('a report title drops a leading "Status: <status>" only when it repeats the report\'s own status', () => {
  assert.equal(withoutStatusPrefix('Status: complete. All done', 'complete'), 'All done');
  assert.equal(withoutStatusPrefix('status: Needs input — please look', 'needs_input'), 'please look');
  assert.equal(withoutStatusPrefix('Status: needs-input: next', 'needs_input'), 'next');
  assert.equal(withoutStatusPrefix('Status: completed the move', 'complete'), 'Status: completed the move');
  assert.equal(withoutStatusPrefix('Status: blocked. X', 'complete'), 'Status: blocked. X');
  assert.equal(withoutStatusPrefix('No prefix here', 'complete'), 'No prefix here');
});

test('a report title is plain text without the repeated status', () => {
  assert.equal(reportTitle({ title: '**Status:** complete. All **five** done', status: 'complete' }), 'All five done');
  assert.equal(reportTitle({ title: 'Status: complete.', status: 'complete' }), 'Untitled report');
  assert.equal(reportTitle({ title: '  ', status: 'progress' }), 'Untitled report');
});

test('activity text is plain text without the engine\'s repetitions', () => {
  assert.equal(feedText({ kind: 'subagent-done', text: 'orchestrator-worker orchestrator-worker finished' }), 'orchestrator-worker finished');
  assert.equal(feedText({ kind: 'subagent-done', text: 'explore map-module finished' }), 'explore map-module finished');
  assert.equal(feedText({ kind: 'subagent-done', text: 'task task failed' }), 'task failed');
  assert.equal(feedText({ kind: 'report', text: 'reported needs input: Status: needs_input. PR 2 is **done**' }), 'reported needs input: PR 2 is done');
  assert.equal(feedText({ kind: 'report', text: 'reported complete: Status: complete.' }), 'reported complete');
  assert.equal(feedText({ kind: 'question', text: 'asked: keep the **v1** format?' }), 'asked: keep the v1 format?');
  assert.equal(feedText({ kind: 'report', text: 'reported complete: ## Summary' }), 'reported complete: Summary');
});

test('a sub-agent item drops a trailing ": <its own label>", and only that', () => {
  assert.equal(feedText({ kind: 'subagent-start', label: 'map-import-module', text: 'started explore: map-import-module' }), 'started explore');
  assert.equal(feedText({ kind: 'subagent-done', label: 'scan-docs-links', text: 'cancelled orchestrator-worker: scan-docs-links' }), 'cancelled orchestrator-worker');
  assert.equal(feedText({ kind: 'subagent-start', label: 'B1', text: 'started code-review: review-pr-418' }), 'started code-review: review-pr-418');
  assert.equal(feedText({ kind: 'subagent-start', label: 'docs', text: 'started explore: map-docs' }), 'started explore: map-docs');
  assert.equal(feedText({ kind: 'subagent-start', label: 'a.b', text: 'started explore: aXb' }), 'started explore: aXb');
  assert.equal(feedText({ kind: 'report', label: 'B1', text: 'reported complete: B1' }), 'reported complete: B1');
  assert.equal(feedText({ kind: 'subagent-done', label: 'explore', text: 'explore explore finished' }), 'explore finished');
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

test('the plan forest leaves out sub-agent units', () => {
  const snapshot = exampleSnapshot();
  const nodes = flattenPlan(planForest(snapshot)).map(({ node }) => node);
  assert.ok(nodes.every(node => !node.unit || !isSubagent(node.unit)));
  assert.equal(nodes.length, snapshot.units.filter(unit => !isSubagent(unit)).length + snapshot.planned.length);
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
  assert.equal(all.length, snapshot.units.filter(unit => !isSubagent(unit)).length + 3);
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
  assert.deepEqual(at('subagent'), ['table-research', 'migrate-fixtures', 'scan-docs-links', 'map-import-module', 'audit-schema-usage']);
});

test('the board ends with the Sub-agents column; the stage track keeps the session pipeline', () => {
  assert.deepEqual(BOARD_STAGES, ['planned', 'coding', 'pr_open', 'in_review', 'merged', 'archived', 'subagent']);
  assert.deepEqual(UNIT_STAGES, ['coding', 'pr_open', 'in_review', 'merged', 'archived']);
});

test('every unit the Cards tab leaves out is on the Board', async () => {
  const stress = await createDemoEngine({ scenario: 'stress', now: () => NOW, simulate: false }).getSnapshot();
  const archivedMerged = exampleSnapshot();
  Object.assign(archivedMerged.units.find(unit => unit.label === 'F2a'), { status: 'archived', stage: 'merged' });
  for (const snapshot of [exampleSnapshot(), stress, closedSnapshot(), archivedMerged, graceSnapshot()]) {
    const shown = new Set(cardUnits(snapshot, NOW));
    const left = snapshot.units.filter(unit => !shown.has(unit));
    assert.ok(left.length > 0);
    const onBoard = new Set(boardColumns(snapshot).flatMap(column => column.nodes.map(node => node.unit)));
    for (const unit of left) assert.ok(onBoard.has(unit), unit.label);
  }
});
