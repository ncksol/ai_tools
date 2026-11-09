import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_STAGES, REPORT_CLASS, REPORT_LABELS, STATE_LINES, UNIT_STAGES, activeSubagents, archivedUnits, askingIds, boardColumns, cardZones, closedNotMerged, countTiles, effortOf, feedText,
  findByLabel, findPlanned, finishedOutcome, flattenPlan, foldFooter, isDone, isFinished, isSubagent, needItems, needMark, nowLine, omittedSubagents, orchestratorView, planForest, planLayout,
  prWords, progressPercent, reportKind, reportTitle, runClockEnd, runEnd, sharePercent, shortModel, stateLine, stateWords, unitClockEnd, unitEnd, waitingOnYou, withoutStatusPrefix,
} from '../ui/model.mjs';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSnapshot } from '../engine/model/swarm.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';
import { NOW, closedSnapshot, exampleSnapshot } from './helpers/ui.mjs';

const labels = units => units.map(unit => unit.label);
const isArchivedUnit = unit => archivedUnits({ units: [unit] }).length === 1;

test('the Cards tab has an active grid, attention first, and a Finished section, latest first; archived units are on neither', () => {
  const snapshot = exampleSnapshot();
  const { active, finished } = cardZones(snapshot);
  assert.deepEqual(labels(active), ['I1', 'table-research', 'B2', 'F1', 'B1', 'map-import-module', 'D5']);
  assert.deepEqual(labels(finished), ['F2a', 'scan-docs-links', 'migrate-fixtures', 'audit-schema-usage']);
  assert.deepEqual(labels(archivedUnits(snapshot)), ['B0']);
});

test('the active grid puts a status the view does not know last', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').status = 'something_new';
  assert.deepEqual(labels(cardZones(snapshot).active), ['I1', 'table-research', 'B2', 'F1', 'map-import-module', 'D5', 'B1']);
});

test('questions and plans sort oldest wait first within their state', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'B1'), { status: 'question', statusDetail: 'waiting_question', since: NOW - 60000 });
  Object.assign(findByLabel(snapshot, 'D5'), { status: 'question', statusDetail: 'waiting_question', since: NOW - 600000 });
  Object.assign(findByLabel(snapshot, 'F1'), { status: 'plan', statusDetail: 'waiting_plan', since: NOW - 3600000 });
  assert.deepEqual(labels(cardZones(snapshot).active), ['I1', 'table-research', 'D5', 'B1', 'F1', 'B2', 'map-import-module']);
});

/** A unit for the finished and done rules: idle, with a complete report and no PR, unless `over` says otherwise. */
const unitWith = over => ({ id: 'u', kind: 'project', status: 'idle', statusDetail: 'idle', stage: 'coding', since: NOW - 60000, endedAt: null, pr: null, outcome: null, closedWithoutMerge: false, report: { status: 'complete', at: NOW - 120000, title: 'Done' }, ...over });
const none = new Set();

test('a unit is finished once its work has ended: stopped, merged, done, failed, crashed, cancelled or closed without merging', () => {
  for (const [status, statusDetail] of [['idle', 'stopped'], ['merged', 'merged'], ['done', 'completed'], ['blocked', 'failed'], ['blocked', 'crashed'], ['blocked', 'cancelled']]) {
    assert.equal(isFinished(unitWith({ status, statusDetail, report: null }), none), true, statusDetail);
  }
  assert.equal(isFinished(unitWith({ status: 'merged', statusDetail: 'idle', report: null }), none), true, 'status merged');
  assert.equal(isFinished(unitWith({ status: 'done', statusDetail: 'idle', report: null }), none), true, 'status done');
  assert.equal(isFinished(unitWith({ report: null, closedWithoutMerge: true, outcome: 'closed' }), none), true, 'closed without a PR');
  assert.equal(isFinished(unitWith({ report: null, closedWithoutMerge: true, pr: { id: 1, state: 'closed' } }), none), true, 'PR closed');
  for (const [status, statusDetail] of [['busy', 'busy'], ['stuck', 'silent'], ['question', 'waiting_question'], ['plan', 'waiting_plan'], ['blocked', 'blocked'], ['blocked', 'blocked_on_orchestrator'], ['idle', 'idle']]) {
    assert.equal(isFinished(unitWith({ status, statusDetail, report: null }), none), false, statusDetail);
  }
});

test('the done rule: idle, latest report complete and no PR still open; a PR in an unknown state keeps the unit active', () => {
  assert.equal(isDone(unitWith({})), true, 'no PR');
  for (const state of ['merged', 'closed']) assert.equal(isFinished(unitWith({ pr: { id: 1, state } }), none), true, state);
  for (const state of ['open', 'draft', 'unknown']) assert.equal(isFinished(unitWith({ pr: { id: 1, state } }), none), false, state);
  for (const status of ['progress', 'needs_input', 'blocked']) assert.equal(isFinished(unitWith({ report: { status, at: NOW } }), none), false, status);
  assert.equal(isFinished(unitWith({ report: null }), none), false, 'no report');
  assert.equal(isFinished(unitWith({ status: 'busy', statusDetail: 'busy' }), none), false, 'it turned busy again, so it is back on the grid');
  const snapshot = exampleSnapshot();
  const d5 = findByLabel(snapshot, 'D5');
  assert.equal(d5.report.status, 'complete');
  assert.ok(cardZones(snapshot).active.includes(d5), 'its draft PR is still open');
  d5.pr.state = 'merged';
  assert.ok(cardZones(snapshot).finished.includes(d5));
});

test('a unit with an open question or plan of its own stays active, whatever its state', () => {
  const failed = unitWith({ status: 'blocked', statusDetail: 'failed', outcome: 'failed' });
  assert.equal(isFinished(failed, new Set(['u'])), false);
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'B2'), { status: 'blocked', statusDetail: 'failed', outcome: 'failed', endedAt: NOW - 60000 });
  assert.deepEqual(askingIds(snapshot), new Set(['ws-0004-b2', 'ws-0000-root']));
  assert.ok(labels(cardZones(snapshot).active).includes('B2'));
  snapshot.needs = snapshot.needs.filter(need => need.fromId !== 'ws-0004-b2');
  assert.ok(labels(cardZones(snapshot).finished).includes('B2'));
});

test('an orchestrator sub-agent moves to Finished as soon as it ends, and comes back when a follow-up makes it busy', () => {
  const snapshot = exampleSnapshot();
  const unit = findByLabel(snapshot, 'map-import-module');
  Object.assign(unit, { status: 'done', statusDetail: 'completed', endedAt: NOW - 1000, since: NOW - 1000 });
  assert.equal(labels(cardZones(snapshot).finished)[0], 'map-import-module');
  Object.assign(unit, { status: 'busy', statusDetail: 'busy', endedAt: null, since: NOW - 500 });
  assert.ok(labels(cardZones(snapshot).active).includes('map-import-module'));
});

test('a finished unit reads its outcome and age, with a green, red or grey tone; "closed, not merged" only when it had a PR', () => {
  const outcome = over => { const { words, tone } = finishedOutcome(unitWith(over)); return [words, tone]; };
  assert.deepEqual(outcome({ status: 'idle', statusDetail: 'stopped', report: null }), ['stopped {a}', 'off']);
  assert.deepEqual(outcome({ status: 'merged', statusDetail: 'merged' }), ['merged {a}', 'ok']);
  assert.deepEqual(outcome({ status: 'done', statusDetail: 'completed' }), ['done {a}', 'ok']);
  assert.deepEqual(outcome({}), ['done {a}', 'ok'], 'the done rule');
  assert.deepEqual(outcome({ status: 'blocked', statusDetail: 'failed' }), ['failed {a}', 'bad']);
  assert.deepEqual(outcome({ status: 'blocked', statusDetail: 'crashed' }), ['crashed {a}', 'bad']);
  assert.deepEqual(outcome({ status: 'blocked', statusDetail: 'cancelled' }), ['cancelled {a}', 'off']);
  assert.deepEqual(outcome({ closedWithoutMerge: true, outcome: 'closed' }), ['closed {a}', 'off']);
  assert.deepEqual(outcome({ closedWithoutMerge: true, outcome: 'closed', pr: { id: 9, state: 'closed' } }), ['closed, not merged {a}', 'off']);
  assert.equal(finishedOutcome(unitWith({})).at, NOW - 120000, 'the done rule dates from the complete report');
  assert.equal(finishedOutcome(unitWith({ status: 'done', statusDetail: 'completed', endedAt: NOW - 5000 })).at, NOW - 5000);
  assert.equal(finishedOutcome(unitWith({ status: 'blocked', statusDetail: 'crashed' })).at, NOW - 60000, 'no end: the start of its state');
});

test('stuck state words name the cause; a sub-agent\'s own card says "silent"; others follow STATE_LINES', () => {
  const words = (statusDetail, kind = 'project') => stateWords({ kind, status: 'stuck', statusDetail });
  assert.equal(words('stuck_tool'), 'Stuck · tool call {t}');
  assert.equal(words('silent'), 'Stuck · silent {t}');
  assert.equal(words('stuck_model_call'), 'Stuck · no model reply {t}');
  assert.equal(words('stuck_subagent'), 'Stuck · sub-agent silent {t}');
  assert.equal(words('stuck_subagent', 'subagent'), 'Stuck · silent {t}');
  assert.equal(words('stuck_tool', 'subagent'), 'Stuck · tool call {t}');
  assert.equal(stateWords({ kind: 'project', status: 'blocked', statusDetail: 'blocked_on_orchestrator' }), STATE_LINES.blocked_on_orchestrator);
  assert.equal(stateLine({ status: 'stuck', statusDetail: 'stuck_tool' }), 'Stuck · no events {t}', 'the detail panel and the cockpit keep theirs');
});

/** A live session for the now-line rules: busy, with a progress report from before this busy stretch. */
const liveUnit = over => ({ id: 'u', kind: 'project', status: 'busy', statusDetail: 'busy', since: NOW - 60000, report: { status: 'progress', at: NOW - 600000, title: 'Earlier report' }, activity: { label: 'Thinking', tool: null }, todo: null, toolDesc: null, ...over });
const noNeeds = { needs: [] };
const tool = (name, summary) => ({ id: 't', name, summary, startedAt: NOW - 30000, limitMs: null });

test('a working unit\'s now line: the stuck tool call, else its todo, the sync sub-agent, the tool call, the activity, a fresh report, "Thinking"', () => {
  const line = over => nowLine(liveUnit(over), noNeeds);
  const bash = tool('bash', 'bash: npm run import:e2e');
  const stuck = { status: 'stuck', statusDetail: 'stuck_tool', activity: { label: 'Running bash: npm run import:e2e', tool: bash } };
  assert.deepEqual(line({ ...stuck, toolDesc: 'Running the slow import suite', todo: 'Prove the retry policy' }), { text: 'Running the slow import suite' });
  assert.deepEqual(line({ ...stuck, todo: 'Prove the retry policy' }), { text: 'Running bash: npm run import:e2e' }, 'no description: the command');
  assert.deepEqual(line({ todo: 'Wire the **refund** handler', activity: { label: 'Running bash: npm test', tool: bash } }), { text: 'Wire the refund handler' });
  const sync = { activity: { label: 'Waiting for its research (sync)', tool: tool('task', 'task: Find past incidents') }, toolDesc: 'Find past incidents' };
  assert.deepEqual(line(sync), { text: 'Waiting for its research (sync)' });
  assert.deepEqual(line({ activity: { label: 'Running bash: npm test', tool: bash }, toolDesc: 'Run the unit tests' }), { text: 'Run the unit tests' });
  assert.deepEqual(line({ activity: { label: 'Running bash: npm test', tool: bash } }), { text: 'Running bash: npm run import:e2e' });
  assert.deepEqual(line({ activity: { label: 'Compacting the conversation', tool: null } }), { text: 'Compacting the conversation' });
  assert.deepEqual(line({ report: { status: 'progress', at: NOW - 30000, title: 'Status: progress. Half way' } }), { text: 'Half way', at: NOW - 30000 });
  assert.deepEqual(line({}), { text: 'Thinking', muted: true });
  assert.deepEqual(nowLine({ ...liveUnit({}), todo: undefined, toolDesc: undefined }, noNeeds), { text: 'Thinking', muted: true }, 'a snapshot without the new fields');
  for (const statusDetail of ['slow_model_call', 'silent', 'stuck_model_call', 'stuck_subagent', 'spinning']) assert.deepEqual(line({ statusDetail, todo: 'A todo' }), { text: 'A todo' }, statusDetail);
});

/** A swarm with one child session whose log `write` fills, built by the real engine at `now`. Times are minutes after 12:00. */
function engineSwarm(write, now) {
  const T = Date.UTC(2026, 10, 9, 12, 0, 0);
  const at = minutes => T + minutes * MINUTE;
  const workspace = (id, name, sessionId) => [id, {
    id, projectId: 'p', worktreeId: null, name, branch: null, createdAt: T, archivedAt: null, sessionId,
    creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null,
  }];
  const app = {
    projects: new Map([['p', { id: 'p', name: 'sample', githubOwner: null, githubRepo: null }]]),
    worktrees: new Map(),
    workspaces: new Map([workspace('ws-root', 'Sample story', 'cli-root'), workspace('ws-api', 'Sample a1 api', 'cli-api')]),
    parentLinks: [{ childId: 'ws-api', parentId: 'ws-root' }],
    aliases: [['cli-root', 'ws-root'], ['cli-api', 'ws-api']].map(([sessionId, workspaceId]) => ({ sessionId, workspaceId, createdAt: T })),
    chatLinks: [], sessions: new Map(), automations: [], diagnostics: [],
  };
  const root = new EventLog(T);
  root.start();
  const api = new EventLog(T);
  api.start();
  write(api, at);
  const snapshot = buildSnapshot({
    forest: buildForest(app), rootId: 'ws-root', app, ledger: createLedger(), requests: [],
    states: new Map([['cli-root', fold(root, 'cli-root')], ['cli-api', fold(api, 'cli-api')]]),
    alive: new Map([['cli-root', true], ['cli-api', true]]), workspaceFiles: new Map(), sessionDbs: new Map(), prInfo: () => null,
    now: at(now), thresholds: DEFAULT_THRESHOLDS, revision: 1, diagnostics: [],
  });
  assert.deepEqual(validateSnapshot(snapshot), []);
  return { unit: snapshot.units.find(unit => unit.id === 'ws-api'), snapshot, at };
}

test('a report from the busy stretch stays on the now line when the stretch turns stuck; one from an earlier stretch does not', () => {
  const sameStretch = api => {
    api.at(api.t + 2 * MINUTE);
    api.turnStart();
    api.at(api.t + 3 * MINUTE);
    api.report('ws-root', 'Found the failing retry case.', 'progress');
    api.at(api.t + MINUTE);
    api.message('Looking at the retry policy');
  };
  let { unit, snapshot, at } = engineSwarm(sameStretch, 7);
  assert.equal(unit.statusDetail, 'busy');
  assert.deepEqual(nowLine(unit, snapshot), { text: 'Found the failing retry case.', at: at(5) });
  ({ unit, snapshot } = engineSwarm(sameStretch, 17));
  assert.equal(unit.statusDetail, 'stuck_model_call');
  assert.equal(unit.since, at(6), 'its state counts from the last model output');
  assert.deepEqual(nowLine(unit, snapshot), { text: 'Found the failing retry case.', at: at(5) });

  const earlierStretch = api => {
    api.at(api.t + 2 * MINUTE);
    api.turnStart();
    api.at(api.t + 2 * MINUTE);
    api.report('ws-root', 'Found the failing retry case.', 'progress');
    api.at(api.t + MINUTE);
    api.turnEnd();
    api.at(api.t + 5 * MINUTE);
    api.turnStart();
    api.at(api.t + MINUTE);
    api.message('Looking at the retry policy');
  };
  ({ unit, snapshot } = engineSwarm(earlierStretch, 12));
  assert.equal(unit.statusDetail, 'busy');
  assert.deepEqual(nowLine(unit, snapshot), { text: 'Thinking', muted: true });
  ({ unit, snapshot } = engineSwarm(earlierStretch, 22));
  assert.equal(unit.statusDetail, 'stuck_model_call');
  assert.deepEqual(nowLine(unit, snapshot), { text: 'Thinking', muted: true }, 'the idle gap ended the stretch that sent it');
});

test('a waiting unit\'s now line is its question or plan; any other unit with one of its own says "Asks you"; else its latest report', () => {
  const question = { id: 'n1', kind: 'question', unitIds: ['u'], labels: ['U'], fromId: 'u', text: 'Keep the **v1** header?', since: NOW - 60000, tagged: true };
  const plan = { ...question, id: 'n2', kind: 'plan', text: 'Split the job in two' };
  const waiting = liveUnit({ status: 'question', statusDetail: 'waiting_question' });
  assert.deepEqual(nowLine(waiting, { needs: [question] }), { text: 'Keep the v1 header?' });
  assert.deepEqual(nowLine({ ...waiting, status: 'plan', statusDetail: 'waiting_plan' }, { needs: [question, plan] }), { text: 'Split the job in two' });
  const failed = liveUnit({ status: 'blocked', statusDetail: 'failed' });
  assert.deepEqual(nowLine(failed, { needs: [question] }), { text: 'Asks you: Keep the v1 header?' });
  assert.deepEqual(nowLine(failed, { needs: [{ ...question, fromId: 'root' }] }), { text: 'Earlier report', at: NOW - 600000 }, 'an item that only names it is not its own');
  assert.deepEqual(nowLine(waiting, noNeeds), { text: 'Earlier report', at: NOW - 600000 }, 'waiting with no item: its report');
  for (const statusDetail of ['blocked', 'idle', 'stalled', 'blocked_on_orchestrator']) {
    assert.deepEqual(nowLine(liveUnit({ status: 'idle', statusDetail, todo: 'Not shown' }), noNeeds), { text: 'Earlier report', at: NOW - 600000 }, statusDetail);
  }
  assert.deepEqual(nowLine(liveUnit({ status: 'idle', statusDetail: 'idle', report: null }), noNeeds), { text: 'No report yet', muted: true });
});

test('a Needs you marker shows on a unit an item names, unless that unit asked it; PR and plan approvals shorten to "Approve"', () => {
  const snapshot = exampleSnapshot();
  const mark = label => needMark(findByLabel(snapshot, label), snapshot);
  assert.deepEqual([mark('D5').label, mark('D5').short, mark('D5').need.text], ['PR to approve', 'Approve', 'Publish PR #421 for review?']);
  assert.equal(mark('B2'), null, 'B2 asked its own plan');
  assert.equal(mark('B1'), null);
  snapshot.needs[0].fromId = 'ws-0000-root';
  assert.deepEqual([mark('B2').label, mark('B2').short], ['Plan to approve', 'Approve']);
  snapshot.needs[0].kind = 'question';
  assert.deepEqual([mark('B2').label, mark('B2').short], ['Question', 'Question']);
});

test('PRs read with their state, model IDs read short, and a sub-agent unit takes its agent\'s effort', () => {
  assert.equal(prWords({ id: 418, state: 'open' }), 'PR #418 · in review');
  assert.equal(prWords({ id: 418, state: 'draft' }), 'PR #418 · draft');
  assert.equal(prWords({ id: 418, state: 'merged' }), 'PR #418 · merged');
  assert.equal(prWords({ id: 418, state: 'closed' }), 'PR #418 · closed');
  assert.equal(prWords({ id: 418, state: 'unknown' }), 'PR #418');
  assert.equal(shortModel('claude-opus-5.5'), 'Opus 5.5');
  assert.equal(shortModel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(shortModel('gpt-6.1-sol'), 'GPT-6.1 Sol');
  assert.equal(shortModel('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(shortModel('gpt-5.4-mini'), 'GPT-5.4 Mini');
  assert.equal(shortModel('gemini-4-argon'), 'Gemini 4 Argon');
  assert.equal(shortModel('claude-haiku-5.5'), 'Haiku 5.5');
  assert.equal(shortModel(null), null);
  assert.equal(shortModel(''), null);
  assert.equal(effortOf({ effort: 'high', agent: { effort: 'low' } }), 'high');
  assert.equal(effortOf({ effort: null, agent: { effort: 'low' } }), 'low');
  assert.equal(effortOf({ effort: null, agent: null }), null);
});

/** A footer with item widths in px and 8 px gaps; the fold changes what it shows, and over() compares it with `width`. */
function footer({ width, need = 0, needShort = 0, chips = [], progress = 0, more = 24, count = 40 }) {
  const state = { progress: progress > 0, shown: chips.length, more: false, count: false, short: false };
  const sizes = () => [
    need && (state.short ? needShort : need),
    ...chips.slice(0, state.shown),
    state.more ? more : 0,
    state.count ? count : 0,
    state.progress ? progress : 0,
  ].filter(Boolean);
  return {
    state,
    over: () => sizes().reduce((sum, size) => sum + size, 0) + 8 * Math.max(0, sizes().length - 1) > width,
    progress: progress > 0,
    chips: chips.length,
    need: need > 0,
    hideProgress: () => { state.progress = false; },
    showChips: shown => { Object.assign(state, { shown, more: true }); },
    countChips: () => { Object.assign(state, { shown: 0, more: false, count: true }); },
    shortenNeed: () => { state.short = true; },
    hideCount: () => { state.count = false; },
  };
}

test('a footer folds in the agreed order: progress, chips into "+N", one count chip, the marker\'s short label, then no count chip', () => {
  const fold = options => foldFooter(footer(options));
  assert.deepEqual(fold({ width: 400, need: 100, chips: [80, 80], progress: 50 }), [], 'it fits');
  assert.deepEqual(fold({ width: 300, need: 100, chips: [80, 80], progress: 50 }), ['progress']);
  assert.deepEqual(fold({ width: 220, need: 100, chips: [80, 80, 80], progress: 50 }), ['progress', '+1', '+2']);
  assert.deepEqual(fold({ width: 180, need: 100, chips: [80, 80], progress: 50 }), ['progress', '+1', 'count']);
  assert.deepEqual(fold({ width: 120, need: 100, needShort: 60, chips: [80, 80] }), ['+1', 'count', 'need']);
  assert.deepEqual(fold({ width: 70, need: 100, needShort: 60, chips: [80, 80], progress: 50 }), ['progress', '+1', 'count', 'need', 'no count']);
  assert.deepEqual(fold({ width: 60, need: 100, needShort: 60, progress: 50 }), ['progress', 'need'], 'no chips: nothing to count');
  assert.deepEqual(fold({ width: 60, chips: [80], progress: 50 }), ['progress', 'count'], 'one chip has nothing to fold into "+N"');
  assert.deepEqual(fold({ width: 30, chips: [80] }), ['count', 'no count']);
  const folded = footer({ width: 70, need: 100, needShort: 60, chips: [80, 80], progress: 50 });
  foldFooter(folded);
  assert.deepEqual(folded.state, { progress: false, shown: 0, more: false, count: false, short: true }, 'the marker never hides');
});

test('waiting on you counts the Needs you items and a stall, and the tiles count the grid', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(waitingOnYou(snapshot), { count: 2, oldest: snapshot.needs[0].since });
  const tiles = () => countTiles(snapshot).map(({ key, state, count }) => `${key}:${state}:${count}`);
  assert.deepEqual(tiles(), ['working:busy:2', 'stuck:stuck:2', 'waiting on you:question:2', 'blocked:blocked:1', 'idle:idle:1', 'finished:merged:4']);
  snapshot.run.stalled = { since: NOW - 3 * 3600000, reason: 'Stalled.' };
  assert.deepEqual(waitingOnYou(snapshot), { count: 3, oldest: NOW - 3 * 3600000 });
  snapshot.needs = [];
  snapshot.run.stalled = null;
  assert.deepEqual(waitingOnYou(snapshot), { count: 0, oldest: null });
  assert.deepEqual(tiles(), ['working:busy:2', 'stuck:stuck:2', 'waiting on you:question:0', 'blocked:blocked:1', 'idle:idle:1', 'finished:merged:4'], 'B2 waits on a plan, so it counts in no state tile');
});

test('the orchestrator\'s view: a finished or stalled run, its own question, what it is doing, or what it waits for', () => {
  const snapshot = exampleSnapshot();
  const view = () => orchestratorView(snapshot);
  assert.deepEqual(view(), { status: 'question', detail: 'waiting_question', words: 'Waiting on question · {t}', at: snapshot.orchestrator.since, text: 'Publish PR #421 for review?' });
  snapshot.needs[1].fromId = 'ws-0007-d5';
  snapshot.needs.push({ id: 'swarm-q', kind: 'question', unitIds: [], labels: [], fromId: 'elsewhere', text: 'Whole swarm?', since: NOW, tagged: false });
  assert.equal(view().text, 'Whole swarm?', 'no item of its own: one about the whole swarm');
  const o = snapshot.orchestrator;
  Object.assign(o, { status: 'busy', statusDetail: 'busy', since: NOW - 40000, todo: 'Start R8', toolDesc: null, activity: { label: 'Thinking', tool: null } });
  assert.deepEqual([view().status, view().words, view().text, view().muted], ['busy', 'Busy · {t}', 'Start R8', undefined]);
  o.todo = null;
  assert.deepEqual([view().text, view().muted], ['Thinking', true]);
  o.activity = { label: 'Waiting for its explore (sync)', tool: tool('task', 'task: Map the handlers') };
  assert.equal(view().text, 'Waiting for its explore (sync)');
  Object.assign(o, { status: 'idle', statusDetail: 'idle', activity: { label: 'Idle', tool: null } });
  assert.deepEqual([view().words, view().text], ['Idle · {t}', 'Waiting for 2 sessions and 2 sub-agents to report; 1 unit waiting on you']);
  for (const unit of snapshot.units) if (['busy', 'stuck'].includes(unit.status)) Object.assign(unit, { status: 'idle', statusDetail: 'idle' });
  assert.equal(view().text, '1 unit waiting on you');
  findByLabel(snapshot, 'B2').status = 'idle';
  assert.deepEqual([view().text, view().muted], ['Nothing is running.', true]);
  snapshot.run.stalled = { since: NOW - 600000, reason: 'Swarm rule: **nothing** is due.' };
  assert.deepEqual(view(), { status: 'stuck', detail: 'stalled', words: 'Swarm stalled · {t}', at: NOW - 600000, text: 'Swarm rule: nothing is due.' });
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: NOW - 3600000 });
  assert.deepEqual(view(), { status: 'done', detail: 'completed', words: 'Swarm finished · {a}', at: NOW - 3600000, text: 'Nothing left to run.', muted: true });
});

test('running and stuck sub-agents make the footer chips, stuck first', () => {
  const sub = (id, status) => ({ id, status });
  assert.deepEqual(activeSubagents({ subagents: [sub('a', 'running'), sub('b', 'completed'), sub('c', 'stuck'), sub('d', 'running')] }).map(item => item.id), ['c', 'a', 'd']);
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

test('the run clock stops at the end of a finished run or the last activity of a quiet one, and runs while anything is active', () => {
  const snapshot = exampleSnapshot();
  assert.equal(runClockEnd(snapshot), null, 'an active run');
  delete snapshot.run.quietSince;
  assert.equal(runClockEnd(snapshot), null, 'a snapshot without the field');
  snapshot.run.quietSince = NOW - 600000;
  assert.equal(runClockEnd(snapshot), NOW - 600000);
  assert.equal(runEnd(snapshot), null, 'a quiet run has not ended');
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: NOW - 3600000 });
  assert.equal(runClockEnd(snapshot), NOW - 3600000);
});

test('a unit\'s runtime stops at its own end, else where the run\'s clock stops', () => {
  const snapshot = exampleSnapshot();
  const d5 = findByLabel(snapshot, 'D5');
  const f2a = findByLabel(snapshot, 'F2a');
  assert.equal(unitClockEnd(d5, snapshot), null, 'an active run');
  snapshot.run.quietSince = NOW - 600000;
  assert.equal(unitClockEnd(d5, snapshot), NOW - 600000);
  assert.equal(unitEnd(d5, snapshot), null, 'it has not ended');
  assert.equal(unitClockEnd(f2a, snapshot), f2a.endedAt, 'its own end comes first');
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

test('every unit off the active grid is on the Board, and every finished one in the Finished section', async () => {
  const stress = await createDemoEngine({ scenario: 'stress', now: () => NOW, simulate: false }).getSnapshot();
  const archivedMerged = exampleSnapshot();
  Object.assign(archivedMerged.units.find(unit => unit.label === 'F2a'), { status: 'archived', stage: 'merged' });
  for (const snapshot of [exampleSnapshot(), stress, closedSnapshot(), archivedMerged]) {
    const { active, finished } = cardZones(snapshot);
    const shown = new Set(active);
    const left = snapshot.units.filter(unit => !shown.has(unit));
    assert.ok(left.length > 0);
    const onBoard = new Set(boardColumns(snapshot).flatMap(column => column.nodes.map(node => node.unit)));
    for (const unit of left) assert.ok(onBoard.has(unit), unit.label);
    for (const unit of left) assert.equal(finished.includes(unit), !isArchivedUnit(unit), unit.label);
  }
});

test('a replied question or blocker reads as a neutral "question" or "blocker"; every other report reads as its status', () => {
  const at = NOW - 60_000;
  const cases = [
    [{ status: 'needs_input', repliedAt: at }, 'replied_question', 'question', 'replied'],
    [{ status: 'blocked', repliedAt: at }, 'replied_blocker', 'blocker', 'replied'],
    [{ status: 'needs_input', repliedAt: null }, 'needs_input', 'needs input', 'needs'],
    [{ status: 'blocked', repliedAt: null }, 'blocked', 'blocked', 'blocked'],
    [{ status: 'complete', repliedAt: at }, 'complete', 'complete', 'complete'],
    [{ status: 'progress', repliedAt: at }, 'progress', 'progress', 'progress'],
  ];
  for (const [report, kind, label, cls] of cases) {
    const name = JSON.stringify(report);
    assert.equal(reportKind(report), kind, name);
    assert.equal(REPORT_LABELS[kind], label, name);
    assert.equal(REPORT_CLASS[kind], cls, name);
  }
});
