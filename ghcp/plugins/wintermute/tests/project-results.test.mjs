import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSnapshot } from '../engine/model/swarm.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

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

test('without comparable request IDs, only a unique earlier question with the same text absorbs a relay', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  api.at(at(35));
  api.ask('Open the sample pull request?');
  root.at(at(40));
  root.tool('relay_session_input', {
    project_session_id: 'ws-api', request_id: 'request-pr', context: '[unit=api need=pr] Open the sample pull request?',
  });
  root.at(at(41));
  root.tool('relay_session_input', { project_session_id: 'ws-api', request_id: 'request-other' });
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['pr', ['ws-api'], 'ws-api', 'Open the sample pull request?', true, at(35)],
    ['question', ['ws-api'], 'project', 'Relayed question', false, at(41)],
  ]);

  api.at(at(36));
  api.ask('Open the sample pull request?');
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['question', ['ws-api'], 'ws-api', 'Open the sample pull request?', false, at(35)],
    ['question', ['ws-api'], 'ws-api', 'Open the sample pull request?', false, at(36)],
    ['pr', ['ws-api'], 'project', 'Open the sample pull request?', true, at(40)],
    ['question', ['ws-api'], 'project', 'Relayed question', false, at(41)],
  ]);
});

test('a relay that ends without an answer leaves the child question open', () => {
  const root = startedLog(0);
  const api = startedLog(1);
  api.at(at(35));
  api.ask('Which port?');
  root.at(at(40));
  const failed = root.tool('relay_session_input', { project_session_id: 'ws-api', context: '[unit=api need=pr] Which port?' });
  const withdrawn = root.tool('relay_session_input', { project_session_id: 'ws-api' });
  const answered = root.tool('relay_session_input', {
    project_session_id: 'unknown-workspace', context: '[unit=D] Use this example?',
  });
  assert.deepEqual(needsOf(snapshotOf(root, { 'cli-api': api })), [
    ['pr', ['ws-api'], 'ws-api', 'Which port?', true, at(35)],
    ['question', ['ws-api'], 'project', 'Relayed question', false, at(40)],
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
