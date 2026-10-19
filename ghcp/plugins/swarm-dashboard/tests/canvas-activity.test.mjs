import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { UI_EVENT_TYPES, applyLine, createSessionState } from '../engine/model/session-state.mjs';
import { lastWorkTime } from '../engine/readers/events.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { openEvents } from './helpers/http.mjs';
import { MINUTE } from '../engine/time.mjs';
import { DAY, T0, alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

/*
 * Issue #30: opening or restoring the dashboard canvas in a session writes session.canvas.* events to its log. They are
 * app UI events, not work, so they must not move a run's activity time or make a finished run live again.
 */

const OLD_LAST = T0 - 30 * DAY + MINUTE;

/** Appends canvas events to a session's log, the newest last, as the app does when it opens or restores the canvas. */
function canvasEvents(home, cliId, times) {
  const log = new EventLog(times[0]);
  for (const [index, time] of times.entries()) {
    log.at(time);
    log.push(index % 2 ? 'session.canvas.removed' : 'session.canvas.recorded', { canvasId: 'swarm-dashboard', instanceId: 'swarm' });
  }
  home.writeEvents(cliId, log.events, { append: true });
}

const line = (type, time, data = {}) => `${JSON.stringify({ type, data, id: `ev-${type}-${time}`, timestamp: new Date(time).toISOString() })}\n`;
const canvasLine = time => line('session.canvas.recorded', time, { canvasId: 'swarm-dashboard', title: 'Swarm dashboard', input: {} });
const MTIME = at(90);

/** A log file with the given text and an mtime of MTIME. */
function logFile(text) {
  const file = path.join(tempDir('canvas-activity-log-'), 'events.jsonl');
  writeFileSync(file, text);
  utimesSync(file, MTIME / 1000, MTIME / 1000);
  return file;
}

const workAt = async (text, options) => (await lastWorkTime(logFile(text), UI_EVENT_TYPES, options)).at;

test('a log\'s work time is its mtime unless it ends with UI events, then the time of the last line before them', async () => {
  assert.equal(await workAt(line('assistant.turn_end', at(5))), MTIME);
  assert.equal(await workAt(line('assistant.turn_end', at(5)) + canvasLine(at(50))), at(5));
  assert.equal(await workAt(line('assistant.turn_end', at(5)) + canvasLine(at(50)) + line('user.message', at(51))), MTIME);
  assert.equal(await workAt(canvasLine(at(50)) + canvasLine(at(51))), null, 'a log with only UI events shows no work');
  assert.equal(await workAt(''), null);
  assert.equal(await lastWorkTime(path.join(tempDir('canvas-activity-log-'), 'missing.jsonl'), UI_EVENT_TYPES), null);
  assert.equal(await workAt(line('assistant.turn_end', at(5)) + canvasLine(at(50)).replace('\n', '\r\n') + '\n'), at(5), 'CRLF and blank lines');
  assert.equal(await workAt(line('assistant.turn_end', at(5)) + canvasLine(at(50)) + '{"type":"assistant.mess'), MTIME, 'a line being written is work');
  assert.equal(await workAt('not json\n' + canvasLine(at(50))), MTIME, 'a line with no type and no time falls back to the mtime');
});

test('a log\'s work time is found across read chunks, and a long line is taken as work', async () => {
  const many = Array.from({ length: 40 }, (_, index) => canvasLine(at(10 + index))).join('');
  const text = line('assistant.turn_end', at(5)) + many;
  assert.equal(await workAt(text, { chunkSize: 100 }), at(5));
  assert.equal(await workAt(text, { chunkSize: 100, maxBytes: 1000 }), MTIME, 'past the read cap, the mtime');
  const long = line('assistant.message', at(7), { content: 'x'.repeat(100 * 1024) });
  assert.equal(await workAt(long + canvasLine(at(50)), { chunkSize: 4096 }), at(7));
  assert.equal(await workAt(canvasLine(at(1)) + long + canvasLine(at(50)), { chunkSize: 4096 }), at(7));
});

const engineFor = (home, now) => createSwarmEngine({
  copilotHome: home.root, historyDir: path.join(tempDir('canvas-activity-'), 'history'), now: () => now, processProbe: alwaysAlive, prLookup: 'off',
});

test('canvas events do not move a session\'s activity time', () => {
  const state = createSessionState('cli-1');
  const log = new EventLog(at(0));
  log.start(); log.turnStart(); log.at(at(5)); log.turnEnd();
  log.at(at(50));
  log.push('session.canvas.recorded', { canvasId: 'swarm-dashboard' });
  log.at(at(51));
  log.push('session.canvas.removed', { canvasId: 'swarm-dashboard' });
  for (const event of log.events) applyLine(state, JSON.stringify(event));
  assert.equal(state.lines, 5);
  assert.equal(state.lastEventAt, at(5));
  assert.equal(state.lastEventType, 'assistant.turn_end');
});

test('a canvas opened in an old swarm\'s root does not make that swarm live', async () => {
  const home = scenario();
  canvasEvents(home, 'cli-old', [at(6)]);
  const now = at(60);
  const engine = engineFor(home, now);
  await engine.refresh();
  const listed = engine.listSwarms().find(swarm => swarm.id === 'ws-old');
  assert.deepEqual([listed.lifecycle, listed.lastActivityAt], ['finished', OLD_LAST], 'the quick listing');
  const snapshot = await engine.getSnapshot('ws-old');
  assert.deepEqual([snapshot.run.lifecycle, snapshot.run.lastActivityAt], ['finished', OLD_LAST], 'the full snapshot');
  assert.deepEqual(engine.listSwarms().map(swarm => [swarm.id, swarm.lifecycle]), [['ws-root', 'live'], ['ws-old', 'finished']]);
});

test('work after the canvas events still counts as activity', async () => {
  const home = scenario();
  canvasEvents(home, 'cli-old', [at(6), at(7)]);
  const work = new EventLog(at(8));
  work.turnStart();
  home.writeEvents('cli-old', work.events, { append: true });
  canvasEvents(home, 'cli-old', [at(9)]);
  const engine = engineFor(home, at(60));
  await engine.refresh();
  const listed = engine.listSwarms().find(swarm => swarm.id === 'ws-old');
  assert.deepEqual([listed.lifecycle, listed.lastActivityAt], ['live', at(8)]);
  assert.equal((await engine.getSnapshot('ws-old')).run.lastActivityAt, at(8));
});

test('a page for a session with only task sub-agents shows no swarm, not an old swarm whose canvas was restored', async () => {
  const home = scenario();
  canvasEvents(home, 'cli-old', [at(6)]);
  home.session({ id: 'cli-new', title: 'Folder orchestrator', createdAt: at(55), agent: 'orchestrator' });
  const log = new EventLog(at(55));
  log.start(); log.turnStart();
  log.at(at(56));
  const call = log.subagent({ name: 'research' });
  log.at(at(57));
  log.subagentDone(call);
  log.done(call);
  log.turnEnd();
  home.writeEvents('cli-new', log.events);
  const engine = engineFor(home, at(60));
  const server = createDashboardServer({ createEngine: () => engine, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 } });
  await server.listen();
  const page = openEvents(server.port, '/api/events?session=cli-new');
  try {
    assert.equal((await page.waitFor(entry => entry.event === 'snapshot', 10000)).data.snapshot, null);
    assert.equal(await engine.findSwarm('cli-new'), null);
    assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle, 'finished');
  } finally {
    page.close();
    await server.close();
  }
});
