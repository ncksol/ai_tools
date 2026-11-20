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

const T0 = Date.UTC(2026, 10, 20, 10);
const at = minutes => T0 + minutes * MINUTE;

function snapshotOf(logs, { automations = [], pr = null } = {}) {
  const app = {
    projects: new Map(), worktrees: new Map(), parentLinks: [], aliases: [], chatLinks: [], diagnostics: [],
    persistentProjects: new Set(['project']),
    workspaces: new Map([['ws-api', {
      id: 'ws-api', name: 'A1 API work', projectId: null, worktreeId: null, branch: null, sessionId: 'cli-api',
      createdAt: at(1), archivedAt: null, creatorSessionId: 'project', coordinatingCreatorSessionId: 'project', createdPr: pr,
    }]]),
    sessions: new Map([
      ['project', { id: 'project', title: 'Sample project', createdAt: T0, archivedAt: null }],
      ['cli-api', { id: 'cli-api', title: 'A1 API work', createdAt: at(1), archivedAt: null }],
    ]),
    automations,
  };
  const snapshot = buildSnapshot({
    forest: buildForest(app), rootId: 'project', app, ledger: createLedger(),
    states: new Map(Object.entries(logs).map(([id, log]) => [id, fold(log, id)])),
    alive: new Map(Object.keys(logs).map(id => [id, true])),
    workspaceFiles: new Map(), sessionDbs: new Map(), prInfo: () => null,
    now: at(60), thresholds: DEFAULT_THRESHOLDS, revision: 1, diagnostics: [],
  });
  assert.deepEqual(validateSnapshot(snapshot), []);
  return snapshot;
}

test('schedule activity reports successful sets and clears at completion time, and reports wakes', () => {
  const log = new EventLog(T0);
  log.start();
  const set = log.tool('save_session_automation', { interval: 'minutes', every_minutes: 30, prompt: 'Check progress' });
  log.at(at(1));
  log.done(set);
  log.at(at(31));
  log.automationWake('Check progress');
  log.at(at(32));
  log.done(log.tool('save_session_automation', { clear: true }));
  log.at(at(33));
  log.done(log.tool('save_session_automation', { interval: 'once', run_at: new Date(at(90)).toISOString(), prompt: 'Look again' }));
  log.done(log.tool('save_session_automation', { interval: 'minutes', every_minutes: 5, prompt: 'Too often' }), { success: false });
  const state = fold(log);
  assert.deepEqual(state.feed.map(item => [item.at, item.kind, item.text]), [
    [at(1), 'monitor-set', 'set a schedule (every 30 min)'],
    [at(31), 'monitor-check', 'ran a schedule'],
    [at(32), 'monitor-cleared', 'cleared a schedule'],
    [at(33), 'monitor-set', 'set a schedule'],
  ]);
  assert.deepEqual(state.marks.map(mark => [mark.kind, mark.text]), [['monitor', 'Schedule ran']]);
});

for (const [outcome, settle] of [
  ['pending', () => {}],
  ['failed', (log, call) => log.done(call, { success: false })],
  ['aborted', log => log.abort()],
  ['completed after abort', (log, call) => { log.abort(); log.done(call); }],
  ['missing confirmation', (log, call) => log.push('tool.execution_complete', { toolCallId: call })],
]) {
  test(`an unconfirmed schedule save (${outcome}) does not supply an interval or move a PR into review`, () => {
    const api = new EventLog(at(1));
    api.start();
    const call = api.tool('save_session_automation', { interval: 'minutes', every_minutes: 10, prompt: 'Check progress' });
    api.at(at(2));
    settle(api, call);
    const snapshot = snapshotOf({ 'cli-api': api }, { pr: { repo: 'sample/repo', number: 42, state: null } });
    const [unit] = snapshot.units;
    assert.deepEqual([unit.pr.state, unit.stage, unit.monitor.everyMinutes], ['unknown', 'pr_open', null]);
    assert.ok(!snapshot.feed.some(item => item.kind === 'monitor-set'));
  });
}

test('an unsuccessful clear does not replace the last successful schedule save', () => {
  const api = new EventLog(at(1));
  api.start();
  api.done(api.tool('save_session_automation', { interval: 'minutes', every_minutes: 10, prompt: 'Check progress' }));
  api.at(at(2));
  api.done(api.tool('save_session_automation', { clear: true }), { success: false });
  const snapshot = snapshotOf({ 'cli-api': api }, { pr: { repo: 'sample/repo', number: 42, state: null } });
  const [unit] = snapshot.units;
  assert.deepEqual([unit.pr.state, unit.stage, unit.monitor.everyMinutes], ['unknown', 'in_review', 10]);
  assert.ok(!snapshot.feed.some(item => item.kind === 'monitor-cleared'));
});

test('a Project names the child it schedules or clears without changing feed authorship', () => {
  const project = new EventLog(T0);
  project.start();
  project.at(at(5));
  project.done(project.tool('save_session_automation', { inline: true, interval: 'minutes', every_minutes: 30, prompt: 'Check the units' }));
  project.at(at(6));
  project.done(project.tool('save_session_automation', { session_id: 'cli-api', interval: 'minutes', every_minutes: 10, prompt: 'Check progress' }));
  project.at(at(35));
  project.automationWake('Check the units');
  const schedule = (sessionId, everyMinutes, nextRunAt) => ({
    sessionId, ownerSessionId: 'project', interval: 'minutes', everyMinutes, lastRunAt: null, nextRunAt, pausedAt: null, name: null,
  });
  const inline = schedule('project', 30, at(65));
  const api = new EventLog(at(1));
  api.start();
  const logs = { project, 'cli-api': api };
  const snapshot = snapshotOf(logs, { automations: [inline, schedule('cli-api', 10, at(62))] });
  const [unit] = snapshot.units;
  assert.deepEqual([unit.id, unit.monitor.state, unit.monitor.everyMinutes, unit.monitor.nextCheckAt], ['ws-api', 'alive', 10, at(62)]);
  assert.deepEqual(snapshot.feed.map(item => [item.unitId, item.text]), [
    ['project', 'ran a schedule'],
    ['project', `set a schedule for ${unit.label} (every 10 min)`],
    ['project', 'set a schedule (every 30 min)'],
  ]);
  assert.deepEqual(unit.recent, []);

  project.at(at(40));
  project.done(project.tool('save_session_automation', { session_id: 'ws-api', clear: true }));
  const cleared = snapshotOf(logs, { automations: [inline] });
  assert.deepEqual([cleared.feed[0].unitId, cleared.feed[0].text], ['project', `cleared the schedule of ${unit.label}`]);
  assert.equal(cleared.units[0].monitor.state, 'none');
});
