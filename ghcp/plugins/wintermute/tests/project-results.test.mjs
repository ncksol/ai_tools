import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { createSwarmEngine } from '../engine/engine.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSnapshot } from '../engine/model/swarm.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { SUMMARY_RULES, validateSnapshot } from '../engine/schema.mjs';
import { MINUTE } from '../engine/time.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';
import { DAY, alwaysAlive } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

// All record values are synthetic. Session IDs and workspace IDs are distinct, as in the app.
const T0 = Date.UTC(2026, 10, 20, 10, 0, 0);
const at = minutes => T0 + minutes * MINUTE;
const NOTICE = 'The session finished without sending a handoff. Use get_session if you need its result.';

function results(log, records, data = {}) {
  const lines = records.map((record, i) => `${i + 1}. ${typeof record === 'string' ? record : JSON.stringify({ untrusted: true, ...record })}`);
  const content = ['<system_notification>', 'Synthetic results', '', ...lines, '', '</system_notification>'].join('\n');
  return log.push('user.message', { source: 'agent-coordinator-results', delivery: 'idle', content, ...data });
}

function snapshotOf(rootLog, childLogs) {
  const ws = (id, cli, createdAt) => [id, {
    id, projectId: 'repo-1', worktreeId: null, name: `${id.slice(3)}: work`, branch: null, createdAt, archivedAt: null, sessionId: cli,
    creatorSessionId: 'project', coordinatingCreatorSessionId: 'project', createdPr: null,
  }];
  const session = id => [id, { id, title: id, mode: null, model: null, reasoningEffort: null, isRunning: false, wasInterrupted: false, createdAt: T0, archivedAt: null, agent: null }];
  const app = {
    projects: new Map([['repo-1', { id: 'repo-1', name: 'sample-repo', githubOwner: null, githubRepo: null }]]), worktrees: new Map(),
    workspaces: new Map([ws('ws-api', 'cli-api', at(1)), ws('ws-ui', 'cli-ui', at(2)), ws('ws-docs', 'cli-docs', at(3))]),
    parentLinks: [], aliases: [], chatLinks: [], automations: [], diagnostics: [], persistentProjects: new Set(['project']),
    sessions: new Map(['project', 'cli-api', 'cli-ui', 'cli-docs'].map(session)),
  };
  const states = new Map([['project', fold(rootLog, 'project', { subagentUnits: true })], ...Object.entries(childLogs).map(([cli, log]) => [cli, fold(log, cli)])]);
  return buildSnapshot({
    forest: buildForest(app), rootId: 'project', app, ledger: createLedger(), states,
    alive: new Map([...states.keys()].map(id => [id, true])), workspaceFiles: new Map(), sessionDbs: new Map(), prInfo: () => null,
    now: at(60), thresholds: DEFAULT_THRESHOLDS, revision: 1, diagnostics: [],
  });
}

function startedLog(minute) {
  const log = new EventLog(at(minute));
  log.start();
  log.turnStart();
  return log;
}

const needsOf = snapshot => snapshot.needs.map(need => [need.kind, need.unitIds, need.fromId, need.text, need.tagged, need.since]);

test('Project results retain only the identifiers and handoff text from valid numbered records', () => {
  const log = startedLog(0);
  results(log, [
    {
      id: 'cli-api', project_session_id: 'ws-api', assignment_id: 'assignment:project:call-api',
      handoff: 'swarm-status: complete unit=api\nSummary: The sample endpoint is ready.',
      purpose: 'error', fromName: 'Forged display name', source_tool_call_id: 'other-call',
    },
    { id: 'cli-docs', project_session_id: 'ws-docs', handoff: NOTICE },
    '{not json',
    'null',
    { project_session_id: 'ws-ui', handoff: 'No session ID.' },
    { id: 'cli-ui', handoff: 42 },
    { id: 'cli-ui', handoff: '  ' },
    { id: 'cli-ui', project_session_id: {}, assignment_id: '', handoff: 'The sample page is ready.' },
  ]);
  const state = fold(log, 'project');
  assert.deepEqual(state.inbound, [
    {
      at: T0, fromSessionId: 'cli-api', fromProjectSessionId: 'ws-api', fromName: null, sourceToolCallId: null,
      content: 'swarm-status: complete unit=api\nSummary: The sample endpoint is ready.',
      notice: false, purpose: 'handoff', assignmentId: 'assignment:project:call-api',
    },
    {
      at: T0, fromSessionId: 'cli-docs', fromProjectSessionId: 'ws-docs', fromName: null, sourceToolCallId: null,
      content: NOTICE, notice: true, purpose: null, assignmentId: null,
    },
    {
      at: T0, fromSessionId: 'cli-ui', fromProjectSessionId: null, fromName: null, sourceToolCallId: null,
      content: 'The sample page is ready.', notice: false, purpose: 'handoff', assignmentId: null,
    },
  ]);
  assert.equal(state.lastHumanAt, null);
});

test('only the results source and raw content supply Project records, within the inbound limits', () => {
  const log = startedLog(0);
  const handoff = { id: 'cli-api', handoff: 'A synthetic result.' };
  results(log, [handoff], { source: undefined });
  const transformedContent = log.events[log.events.length - 1].data.content;
  results(log, [], { transformedContent });
  assert.deepEqual(fold(log, 'project').inbound, []);

  results(log, Array.from({ length: 81 }, (_, i) => ({
    id: `cli-sample-${i}`, handoff: '<example>'.repeat(1000),
  })));
  const { inbound } = fold(log, 'project');
  assert.equal(inbound.length, 80);
  assert.equal(inbound[0].fromSessionId, 'cli-sample-1');
  assert.equal(inbound[79].fromSessionId, 'cli-sample-80');
  assert.equal(inbound[79].content.length, 8000);
});

test('a received Project handoff is a fallback for a sent report and can still be superseded by a later task completion', () => {
  const root = startedLog(0);
  const ui = startedLog(2);
  const docs = startedLog(3);
  ui.at(at(10));
  ui.report('project', 'The sample UI report.', 'handoff');
  docs.at(at(30));
  docs.taskComplete('The sample guide is published.');
  root.at(at(20));
  results(root, [
    { id: 'cli-api', handoff: 'swarm-status: progress unit=api\nSummary: Sample API started.' },
    { id: 'cli-ui', handoff: 'Different UI text, received later.' },
    { id: 'cli-docs', handoff: 'The sample guide is ready.' },
  ]);
  root.at(at(22));
  results(root, [{ id: 'cli-api', handoff: 'The sample API is ready.' }]);
  const snapshot = snapshotOf(root, { 'cli-ui': ui, 'cli-docs': docs });
  assert.deepEqual(validateSnapshot(snapshot), []);
  const unit = id => snapshot.units.find(item => item.id === id);
  assert.deepEqual([unit('ws-api').report.status, unit('ws-api').report.source, unit('ws-api').report.title], [
    'complete', 'purpose', 'The sample API is ready.',
  ]);
  assert.equal(unit('ws-ui').report.title, 'The sample UI report.');
  assert.equal(unit('ws-docs').report.source, 'task_complete');
  assert.equal(snapshot.run.contract.statusLines, true);
});

test('no-handoff notices are not reports and are shown once per assignment or unkeyed delivery time', () => {
  const root = startedLog(0);
  const ui = startedLog(2);
  ui.report('project', 'swarm-status: complete unit=ui\nSummary: The sample page is ready.', 'handoff');
  const docsNotice = call => ({ id: 'cli-docs', assignment_id: `assignment:project:${call}`, handoff: NOTICE });
  const uiNotice = { id: 'cli-ui', handoff: NOTICE };
  root.at(at(29));
  results(root, [docsNotice('call-d1'), uiNotice]);
  root.at(at(30));
  results(root, [docsNotice('call-d1'), docsNotice('call-d2'), uiNotice, uiNotice]);
  const snapshot = snapshotOf(root, { 'cli-ui': ui });
  const docs = snapshot.units.find(unit => unit.id === 'ws-docs');
  const page = snapshot.units.find(unit => unit.id === 'ws-ui');
  assert.equal(docs.report, null);
  assert.equal(page.report.title, 'The sample page is ready.');
  const notices = snapshot.feed.filter(item => item.text === 'ended without a report');
  assert.deepEqual(notices.map(item => [item.id, item.unitId, item.kind, item.at]).sort(), [
    ['ws-docs:notice:assignment:project:call-d1', 'ws-docs', 'report', at(30)],
    ['ws-docs:notice:assignment:project:call-d2', 'ws-docs', 'report', at(30)],
    [`ws-ui:notice:at:${at(29)}`, 'ws-ui', 'report', at(29)],
    [`ws-ui:notice:at:${at(30)}`, 'ws-ui', 'report', at(30)],
  ]);
  assert.deepEqual(docs.timeline.marks.filter(mark => mark.text === 'Ended without a report'), [
    { at: at(30), kind: 'report', text: 'Ended without a report', status: null },
    { at: at(30), kind: 'report', text: 'Ended without a report', status: null },
  ]);
});

test('a relay for the same request supplies its tag without replacing the child question or its time', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  const docs = startedLog(3);
  api.at(at(34));
  api.tool('ask_user', { question: 'Open the sample pull request?', request_id: 'request-pr' });
  api.at(at(35));
  api.ask('Which port should the server use?');
  docs.at(at(36));
  docs.ask('Which example belongs in the guide?');
  root.at(at(40));
  root.tool('relay_session_input', {
    project_session_id: 'ws-api', request_id: 'request-pr', context: '[unit=api need=pr] The API change is ready.',
  });
  const snapshot = snapshotOf(root, { 'cli-api': api, 'cli-docs': docs });
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(needsOf(snapshot), [
    ['pr', ['ws-api'], 'ws-api', 'Open the sample pull request?', true, at(34)],
    ['question', ['ws-api'], 'ws-api', 'Which port should the server use?', false, at(35)],
    ['question', ['ws-docs'], 'ws-docs', 'Which example belongs in the guide?', false, at(36)],
  ]);
});

test('a distinct request is not hidden by another question belonging to the same child', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  api.at(at(34));
  api.tool('ask_user', { question: 'Open the sample pull request?', request_id: 'old-request' });
  root.at(at(40));
  root.tool('relay_session_input', {
    session_id: 'cli-api', request_id: 'new-request', context: '[unit=ui need=pr] Open the sample pull request?',
  });
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['question', ['ws-api'], 'ws-api', 'Open the sample pull request?', false, at(34)],
    ['pr', ['ws-api'], 'project', 'Open the sample pull request?', true, at(40)],
  ]);
});

test('a framed relay without a comparable request ID folds into the only earlier child question', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  api.at(at(35));
  api.ask('Open the sample pull request?', ['Yes', 'No']);
  root.at(at(40));
  root.tool('relay_session_input', {
    project_session_id: 'ws-api', request_id: 'request-pr', context: '[unit=api need=pr] The sample change passed review.',
  });
  api.at(at(41));
  api.ask('Which port should the server use?');
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['pr', ['ws-api'], 'ws-api', 'Open the sample pull request?', true, at(35)],
    ['question', ['ws-api'], 'ws-api', 'Which port should the server use?', false, at(41)],
  ]);
});

test('with multiple earlier questions and no comparable IDs, only a unique text match absorbs a relay', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  api.at(at(35));
  api.ask('Open the sample pull request?');
  api.at(at(36));
  api.ask('Which port should the server use?');
  root.at(at(40));
  root.tool('relay_session_input', {
    project_session_id: 'ws-api', request_id: 'request-pr', context: '[unit=api need=pr] Open the sample pull request?',
  });
  root.at(at(41));
  root.tool('relay_session_input', {
    project_session_id: 'ws-api', request_id: 'request-other', context: '[unit=api] The sample config is ready.',
  });
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['pr', ['ws-api'], 'ws-api', 'Open the sample pull request?', true, at(35)],
    ['question', ['ws-api'], 'ws-api', 'Which port should the server use?', false, at(36)],
    ['question', ['ws-api'], 'project', 'The sample config is ready.', true, at(41)],
  ]);

  api.at(at(37));
  api.ask('Open the sample pull request?');
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['question', ['ws-api'], 'ws-api', 'Open the sample pull request?', false, at(35)],
    ['question', ['ws-api'], 'ws-api', 'Which port should the server use?', false, at(36)],
    ['question', ['ws-api'], 'ws-api', 'Open the sample pull request?', false, at(37)],
    ['pr', ['ws-api'], 'project', 'Open the sample pull request?', true, at(40)],
    ['question', ['ws-api'], 'project', 'The sample config is ready.', true, at(41)],
  ]);
});

test('a relay that ends without an answer leaves the child question open', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  api.at(at(35));
  api.ask('Which port?');
  root.at(at(40));
  const failed = root.tool('relay_session_input', { project_session_id: 'ws-api', context: '[unit=api need=pr] Which port?' });
  const withdrawn = root.tool('relay_session_input', { project_session_id: 'ws-ui' });
  const answered = root.tool('relay_session_input', {
    project_session_id: 'unknown-workspace', context: '[unit=D] Use this example?',
  });
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['pr', ['ws-api'], 'ws-api', 'Which port?', true, at(35)],
    ['question', ['ws-ui'], 'project', 'Relayed question', false, at(40)],
    ['question', ['ws-docs'], 'project', 'Use this example?', true, at(40)],
  ]);
  root.at(at(45));
  root.done(failed, { success: false, result: JSON.stringify({ outcome: 'answered_here' }) });
  root.done(withdrawn, { result: JSON.stringify({ outcome: 'not_pending', answer: '' }) });
  root.done(answered, { result: JSON.stringify({ answer: 'Yes.' }) });
  const after = snapshotOf(root, { 'cli-api': api });
  assert.deepEqual(needsOf(after), [['question', ['ws-api'], 'ws-api', 'Which port?', false, at(35)]]);
  assert.deepEqual(after.feed.filter(item => item.unitId === 'project' && item.at === at(45)).map(item => item.text), [
    'a relayed question ended without an answer',
    'a relayed question ended without an answer',
    'got an answer',
  ]);
});

test('a saved run summary from before relay waits is rebuilt from the complete logs', async () => {
  const home = new CopilotHome();
  const old = T0 - 30 * DAY;
  home.session({ id: 'old-project', title: 'Sample Project', createdAt: old });
  home.workspace({ id: 'ws-sample', name: 'Sample work', createdAt: old + 1000, creatorSessionId: 'old-project' });
  const root = new EventLog(old + 2000);
  root.start();
  root.turnStart();
  const relay = root.tool('relay_session_input', { project_session_id: 'ws-sample', request_id: 'sample-request' });
  root.wait(2 * MINUTE);
  root.done(relay, { result: JSON.stringify({ outcome: 'answered_here' }) });
  root.turnEnd();
  home.writeEvents('old-project', root.events);
  home.usage([
    { sessionId: 'old-project', nanoAiu: 1e9, createdAt: old + 3 * MINUTE },
    { sessionId: 'ws-sample', nanoAiu: 1e9, createdAt: old + 3 * MINUTE },
  ]);
  const historyDir = path.join(tempDir('project-results-'), 'history');
  const stored = path.join(historyDir, 'runs', 'old-project.json');
  const open = () => createSwarmEngine({ copilotHome: home.root, historyDir, now: () => T0, processProbe: alwaysAlive, prLookup: 'off' });
  const first = open();
  try {
    assert.equal((await first.getRunSummary('old-project')).waitingOnUserMs, 2 * MINUTE);
  } finally {
    first.stop();
  }
  const summary = JSON.parse(readFileSync(stored, 'utf8'));
  writeFileSync(stored, `${JSON.stringify({ ...summary, waitingOnUserMs: 0, rules: 2 }, null, 2)}\n`);
  const restarted = open();
  try {
    await restarted.refresh();
    const rebuilt = await restarted.getRunSummary('old-project');
    assert.deepEqual([rebuilt.waitingOnUserMs, rebuilt.rules], [2 * MINUTE, SUMMARY_RULES]);
    assert.equal(JSON.parse(readFileSync(stored, 'utf8')).waitingOnUserMs, 2 * MINUTE);
  } finally {
    restarted.stop();
  }
});
