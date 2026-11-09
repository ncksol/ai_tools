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

function swarm(log) {
  const home = new CopilotHome();
  home.workspace({ id: 'root', name: 'Restarted swarm', createdAt: WORK - MINUTE, sessionId: 'cli-root' });
  home.workspace({ id: 'unit', name: 'Finished job', createdAt: WORK - MINUTE, sessionId: 'cli-unit',
    parentId: 'root', creatorSessionId: 'cli-root' });
  for (const id of ['cli-root', 'cli-unit']) home.writeEvents(id, log.events);
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => NOW, prLookup: 'off' });
  return { home, engine };
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

test('oversized lifecycle events preserve resume effects and the remote info classification in any key order', async () => {
  for (const typeLast of [false, true]) {
    const log = restartLog();
    const resume = log.events.find(event => event.type === 'session.resume');
    Object.assign(resume.data, { selectedModel: 'gpt-6.1-sol', reasoningEffort: 'high' });
    const events = log.events.map(event => {
      if (!['session.shutdown', 'session.resume', 'session.info', 'session.remote_steerable_changed'].includes(event.type)) return event;
      const { type, ...rest } = event;
      const data = { ...rest.data, padding: 'x'.repeat(1000) };
      return typeLast ? { ...rest, data, type } : { type, ...rest, data };
    });
    const home = new CopilotHome();
    const file = home.writeEvents('oversized', events);
    const state = createSessionState('oversized');
    const result = await readNewLines(createTail(file), line => applyLine(state, line), {
      maxLineBytes: 500, onOversized: event => applyRecovered(state, event),
    });
    assert.equal(result.skipped, 4);
    assert.equal(state.lastEventAt, WORK);
    assert.equal(state.shutdownAt, SHUTDOWN);
    assert.deepEqual([state.model, state.effort], ['gpt-6.1-sol', 'high']);
  }
});
