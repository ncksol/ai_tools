import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwarmEngine } from '../engine/engine.mjs';
import { applyLine, applyRecovered, createSessionState } from '../engine/model/session-state.mjs';
import { createTail, readNewLines } from '../engine/readers/events.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';
import { T0 } from './helpers/scenario.mjs';

const NOW = T0 + 6 * HOUR;
const WORK = NOW - 4 * HOUR;
const SHUTDOWN = NOW - 90 * MINUTE;
const RESUME = NOW - 70 * MINUTE;
const RECENT_WORK = NOW - 5 * MINUTE;

function restartLog({ resume = true } = {}) {
  const log = new EventLog(WORK - MINUTE);
  log.start(); log.turnStart();
  log.at(WORK); log.turnEnd();
  log.push('session.usage_checkpoint', {});
  log.at(SHUTDOWN); log.shutdown();
  if (resume) {
    log.at(RESUME); log.resume();
    log.wait(1000);
    log.push('session.info', { infoType: 'remote', message: 'Remote control connected' });
    log.push('session.remote_steerable_changed', { remoteSteerable: true });
  }
  return log;
}

function swarm(log, now = NOW) {
  const home = new CopilotHome();
  const createdAt = Date.parse(log.events[0].timestamp);
  home.workspace({ id: 'root', name: 'Restarted swarm', createdAt, sessionId: 'cli-root' });
  home.workspace({ id: 'unit', name: 'Finished job', createdAt, sessionId: 'cli-unit',
    parentId: 'root', creatorSessionId: 'cli-root' });
  for (const id of ['cli-root', 'cli-unit']) home.writeEvents(id, log.events);
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => now, prLookup: 'off' });
  return { home, engine };
}

async function assertStoppedRun(log, workAt, now) {
  const state = fold(log);
  const { engine } = swarm(log, now);
  try {
    await engine.refresh();
    const listed = engine.listSwarms().find(run => run.id === 'root');
    const snapshot = await engine.getSnapshot('root');
    assert.deepEqual({
      workAt: state.lastEventAt,
      listed: [listed.lifecycle, listed.lastActivityAt],
      snapshot: [snapshot.run.lifecycle, snapshot.run.lastActivityAt, snapshot.run.stalled],
      sessions: [snapshot.orchestrator, ...snapshot.units].map(session => [session.statusDetail, session.reason]),
    }, {
      workAt,
      listed: ['finished', workAt],
      snapshot: ['finished', workAt, null],
      sessions: Array.from({ length: 2 }, () => ['stopped', 'The session process exited normally.']),
    });
  } finally {
    engine.stop();
  }
  return state;
}

test('AT1: a restart-only tail with no lock leaves every session stopped and the old run finished', async () => {
  const log = restartLog();
  assert.equal(fold(log).lastEventAt, WORK, 'the reducer keeps the last real work time');
  const { engine } = swarm(log);
  try {
    await engine.refresh();
    const listed = engine.listSwarms().find(run => run.id === 'root');
    assert.deepEqual([listed.lifecycle, listed.lastActivityAt], ['finished', WORK], 'the untracked run-list work clock');
    const snapshot = await engine.getSnapshot('root');
    assert.deepEqual([snapshot.run.lifecycle, snapshot.run.lastActivityAt, snapshot.run.stalled], ['finished', WORK, null]);
    for (const session of [snapshot.orchestrator, ...snapshot.units]) {
      assert.equal(session.statusDetail, 'stopped');
      assert.equal(session.reason, 'The session process exited normally.');
    }
    assert.equal(snapshot.counts.failed, 0);
  } finally {
    engine.stop();
  }
});

test('AT2: a user message and completed turn after a resume advance both work clocks and make the run live', async () => {
  const log = restartLog();
  log.at(RECENT_WORK - MINUTE); log.user(); log.turnStart();
  log.at(RECENT_WORK); log.message(); log.turnEnd();
  assert.equal(fold(log).lastEventAt, RECENT_WORK);
  const { engine } = swarm(log);
  try {
    await engine.refresh();
    const listed = engine.listSwarms().find(run => run.id === 'root');
    assert.deepEqual([listed.lifecycle, listed.lastActivityAt], ['live', RECENT_WORK]);
    const snapshot = await engine.getSnapshot('root');
    assert.deepEqual([snapshot.run.lifecycle, snapshot.run.lastActivityAt], ['live', RECENT_WORK]);
    // Its process has gone with no shutdown since that work, but the turn had ended, so nothing was cut off.
    for (const session of [snapshot.orchestrator, ...snapshot.units]) assert.equal(session.statusDetail, 'stopped');
  } finally {
    engine.stop();
  }
});

test('AT3: shutdown without a resume stops the session without moving the old run clock', async () => {
  const log = restartLog({ resume: false });
  const { engine } = swarm(log);
  try {
    await engine.refresh();
    const listed = engine.listSwarms().find(run => run.id === 'root');
    assert.deepEqual([listed.lifecycle, listed.lastActivityAt], ['finished', WORK]);
    assert.equal(fold(log).lastEventAt, WORK);
    const snapshot = await engine.getSnapshot('root');
    assert.deepEqual([snapshot.run.lifecycle, snapshot.run.lastActivityAt], ['finished', WORK]);
    assert.equal(snapshot.orchestrator.statusDetail, 'stopped');
  } finally {
    engine.stop();
  }
});

test('AT4: a resume still ends the previous process and applies its model and effort without becoming work', () => {
  const log = new EventLog(WORK - MINUTE);
  log.start(); log.turnStart();
  log.tool('bash', { command: 'sleep 999' });
  log.ask('Continue?');
  const sub = log.subagent({ mode: 'background' });
  log.at(WORK); log.message();
  log.at(RESUME);
  log.push('session.resume', { selectedModel: 'gpt-6.1-sol', reasoningEffort: 'high' });
  const state = fold(log);
  assert.equal(state.turn, null);
  assert.equal(state.openTools.size, 0);
  assert.equal(state.waits.size, 0);
  assert.equal(state.subagents.get(sub).status, 'failed');
  assert.deepEqual(state.busySpans, [[WORK - MINUTE, WORK]]);
  assert.deepEqual([state.model, state.effort], ['gpt-6.1-sol', 'high']);
  assert.equal(state.lastEventAt, WORK);
});

test('AT5: remote session.info is bookkeeping, while model and unknown info types remain work', async () => {
  for (const [infoType, lifecycle, workAt] of [
    ['remote', 'finished', WORK],
    ['model', 'live', RECENT_WORK],
    ['future-info-type', 'live', RECENT_WORK],
  ]) {
    const log = restartLog();
    log.at(RECENT_WORK);
    log.push('session.info', { infoType, message: 'Session notice' });
    assert.equal(fold(log).lastEventAt, workAt, infoType);
    const { engine } = swarm(log);
    try {
      await engine.refresh();
      const listed = engine.listSwarms().find(run => run.id === 'root');
      assert.deepEqual([listed.lifecycle, listed.lastActivityAt], [lifecycle, workAt], infoType);
      assert.equal((await engine.getSnapshot('root')).run.lastActivityAt, workAt, infoType);
    } finally {
      engine.stop();
    }
  }
});

test('ff8a989c: an SDK model change after a remote resume preserves the old work clock and stopped outcome', async () => {
  const workAt = Date.parse('2026-10-29T21:35:16.443Z');
  const log = new EventLog(workAt);
  log.push('session.fusion_completed');
  log.at(Date.parse('2026-10-29T21:35:16.447Z')); log.push('session.usage_checkpoint');
  log.at(Date.parse('2026-10-29T21:53:33.791Z')); log.shutdown();
  log.at(Date.parse('2026-10-30T10:08:47.923Z')); log.resume();
  log.at(Date.parse('2026-10-30T10:08:49.446Z')); log.push('session.info', { infoType: 'remote' });
  log.at(Date.parse('2026-10-30T10:08:49.452Z')); log.push('session.remote_steerable_changed');
  log.at(Date.parse('2026-10-30T10:08:55.006Z'));
  log.push('session.model_change', { source: 'sdk', newModel: 'claude-opus-5.5', reasoningEffort: 'medium' });
  const state = await assertStoppedRun(log, workAt, Date.parse('2026-10-30T10:09:00Z'));
  assert.deepEqual([state.model, state.effort], ['claude-opus-5.5', 'medium']);
});

test('405e8745: settings applied by a read-only attach do not revive a session idle since August', async () => {
  const workAt = Date.parse('2026-08-24T15:53:09.711Z');
  const log = new EventLog(workAt);
  log.push('hook.end', { hookType: 'agentStop' });
  log.push('hook.start', { hookType: 'sessionEnd' }); log.push('hook.end', { hookType: 'sessionEnd' });
  log.at(Date.parse('2026-08-24T15:53:09.715Z')); log.push('session.usage_checkpoint');
  log.at(Date.parse('2026-08-24T16:23:09.756Z')); log.shutdown();
  log.at(Date.parse('2026-11-03T14:29:19.403Z')); log.resume();
  log.at(Date.parse('2026-11-03T14:29:20.125Z')); log.push('session.info', { infoType: 'remote', message: 'Read-only remote session' });
  log.at(Date.parse('2026-11-03T14:29:20.289Z'));
  log.push('session.model_change', { source: 'sdk', newModel: 'gpt-6.1-sol', reasoningEffort: 'max' });
  const state = await assertStoppedRun(log, workAt, Date.parse('2026-11-03T14:30:00Z'));
  assert.deepEqual([state.model, state.effort], ['gpt-6.1-sol', 'max']);
});

test('056588f8: sessionEnd hooks after hours of quiet do not bring back a finished run', async () => {
  const workAt = Date.parse('2026-10-25T12:05:31.036Z');
  const log = new EventLog(workAt - 9);
  log.turnEnd();
  log.at(workAt); log.push('hook.start', { hookType: 'agentStop' }); log.push('hook.end', { hookType: 'agentStop' });
  log.at(Date.parse('2026-10-25T12:05:31.039Z')); log.push('session.usage_checkpoint');
  log.at(Date.parse('2026-10-25T19:03:40.723Z'));
  log.push('hook.start', { hookType: 'sessionEnd' }); log.push('hook.end', { hookType: 'sessionEnd' });
  log.at(Date.parse('2026-10-25T19:03:40.746Z')); log.shutdown();
  log.at(Date.parse('2026-10-25T19:07:18.851Z')); log.resume();
  log.at(Date.parse('2026-10-25T19:07:19.529Z')); log.push('session.info', { infoType: 'remote' });
  await assertStoppedRun(log, workAt, Date.parse('2026-10-25T19:08:00Z'));
});

test('398e3703: a cumulative usage checkpoint at shutdown is not work after 160 minutes of quiet', async () => {
  const workAt = Date.parse('2026-11-04T10:16:13.240Z');
  const log = new EventLog(workAt);
  log.push('session.compaction_complete');
  log.at(Date.parse('2026-11-04T12:56:06.248Z')); log.push('session.usage_checkpoint');
  log.at(Date.parse('2026-11-04T12:56:06.289Z')); log.shutdown();
  await assertStoppedRun(log, workAt, Date.parse('2026-11-04T13:00:00Z'));
});

test('sessionStart hooks and checkpoints without a shutdown remain bookkeeping, but other hooks remain work', () => {
  for (const [type, data, expected] of [
    ['hook.start', { hookType: 'sessionStart' }, WORK],
    ['hook.end', { hookType: 'sessionStart' }, WORK],
    ['hook.end', { hookType: 'userPromptSubmitted' }, RECENT_WORK],
    ['hook.start', { hookType: 'preToolUse' }, RECENT_WORK],
    ['session.usage_checkpoint', {}, WORK],
    ['session.usage_record', { usage: { model: 'gpt-6.1-sol' } }, RECENT_WORK],
  ]) {
    const log = restartLog();
    log.at(RECENT_WORK); log.push(type, data);
    assert.equal(fold(log).lastEventAt, expected, `${type} ${data.hookType ?? ''}`);
  }
});

test('settings changes are bookkeeping only at the top level, and later work still advances the clock', () => {
  for (const [type, data, extra, expected] of [
    ['session.model_change', { source: 'sdk' }, {}, WORK],
    ['session.model_change', { source: 'model_picker' }, {}, WORK],
    ['session.model_change', {}, {}, WORK],
    ['session.mode_changed', { newMode: 'autopilot' }, {}, WORK],
    ['session.permissions_changed', {}, {}, WORK],
    ['session.model_change', {}, { agentId: 'helper' }, RECENT_WORK],
    ['session.model_change', { parentToolCallId: 'helper-call' }, {}, RECENT_WORK],
    ['session.mode_changed', { newMode: 'autopilot', parentToolCallId: 'helper-call' }, {}, RECENT_WORK],
    ['session.permissions_changed', {}, { agentId: 'helper' }, RECENT_WORK],
  ]) {
    const log = restartLog();
    log.at(RECENT_WORK);
    log.push(type, { newModel: 'gpt-6.1-sol', reasoningEffort: 'high', ...data }, extra);
    const state = fold(log);
    assert.equal(state.lastEventAt, expected, type);
    if (expected === WORK && type === 'session.model_change') assert.deepEqual([state.model, state.effort], ['gpt-6.1-sol', 'high']);
    if (expected === WORK && type === 'session.mode_changed') assert.equal(state.mode, 'autopilot');
    log.wait(1000); log.user();
    assert.equal(fold(log).lastEventAt, RECENT_WORK + 1000);
  }
});

test('AT1 oversized shutdown: accounting metadata above 64 KiB does not move the run-list clock', async () => {
  const log = restartLog();
  log.events.find(event => event.type === 'session.shutdown').data.accountingSnapshot = 'x'.repeat(160 * 1024);
  await assertStoppedRun(log, WORK, NOW);
  await assertStoppedRun(log, WORK, NOW + HOUR);
});

test('repeated bookkeeping shutdowns keep the first stopped time until new work', () => {
  const log = restartLog();
  log.at(RESUME + MINUTE); log.shutdown();
  assert.equal(fold(log).shutdownAt, SHUTDOWN);
  log.at(RECENT_WORK); log.user();
  assert.equal(fold(log).shutdownAt, null);
  log.wait(1000); log.shutdown();
  assert.equal(fold(log).shutdownAt, RECENT_WORK + 1000);
});

test('oversized lifecycle events preserve resume effects and the remote info classification in any key order', async () => {
  for (const typeLast of [false, true]) {
    const log = restartLog();
    const resume = log.events.find(event => event.type === 'session.resume');
    Object.assign(resume.data, { selectedModel: 'gpt-6.1-sol', reasoningEffort: 'high' });
    log.push('session.model_change', { source: 'sdk', newModel: 'claude-opus-5.5', reasoningEffort: 'medium' });
    log.push('session.mode_changed', { newMode: 'autopilot' });
    log.push('session.permissions_changed');
    log.push('hook.start', { hookType: 'sessionStart' });
    log.push('hook.end', { hookType: 'sessionStart' });
    log.push('session.usage_checkpoint');
    const events = log.events.map(event => {
      if (!['session.shutdown', 'session.resume', 'session.info', 'session.remote_steerable_changed',
        'session.model_change', 'session.mode_changed', 'session.permissions_changed',
        'hook.start', 'hook.end', 'session.usage_checkpoint'].includes(event.type)) return event;
      const { type, ...rest } = event;
      const data = { ...rest.data, padding: 'x'.repeat(70 * 1024) };
      return typeLast ? { ...rest, data, type } : { type, ...rest, data };
    });
    const home = new CopilotHome();
    const file = home.writeEvents('oversized', events);
    const state = createSessionState('oversized');
    const result = await readNewLines(createTail(file), line => applyLine(state, line), {
      maxLineBytes: 500, onOversized: event => applyRecovered(state, event),
    });
    assert.equal(result.skipped, 11);
    assert.equal(state.lastEventAt, WORK);
    assert.equal(state.shutdownAt, SHUTDOWN);
    assert.deepEqual([state.model, state.effort], ['claude-opus-5.5', 'medium']);
    assert.equal(state.mode, 'autopilot');
    log.events = events;
    await assertStoppedRun(log, WORK, NOW);
  }
});
