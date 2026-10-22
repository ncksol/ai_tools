import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { UI_EVENT_TYPES, applyLine, applyRecovered, createSessionState } from '../engine/model/session-state.mjs';
import { createTail, lastWorkTime, readNewLines } from '../engine/readers/events.mjs';
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

test('a log\'s work time skips UI events in any key order', async () => {
  const work = line('assistant.turn_end', at(5));
  assert.equal(await workAt(work + reordered(at(50)).join('\n') + '\n'), at(5));
  assert.equal(await workAt(work + `   \n${reordered(at(50))[1]}\n`), at(5), 'a line of spaces is blank');
  const typeLastWork = `{"timestamp":"${new Date(at(7)).toISOString()}","type":"assistant.turn_start","data":{}}\n`;
  assert.equal(await workAt(work + typeLastWork + canvasLine(at(50))), at(7));
  assert.equal(await workAt(work + '[1,2]\n' + canvasLine(at(50))), MTIME, 'a line that is not an object is work');
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

/** Canvas lines as some writer might encode them: the type last, or spaces around keys. */
const reordered = time => [
  `{"timestamp":"${new Date(time).toISOString()}","type":"session.canvas.recorded","data":{"canvasId":"swarm-dashboard"}}`,
  `{ "type" : "session.canvas.removed", "data" : {}, "timestamp" : "${new Date(time).toISOString()}" }`,
];

test('canvas events in any key order, normal or recovered from an oversized line, do not move a session\'s clock', async () => {
  const state = createSessionState('cli-1');
  const log = new EventLog(at(0));
  log.start(); log.turnStart(); log.at(at(5)); log.turnEnd();
  for (const event of log.events) applyLine(state, JSON.stringify(event));
  for (const text of reordered(at(50))) applyLine(state, text);
  applyRecovered(state, { type: 'session.canvas.recorded', timestamp: new Date(at(51)).toISOString(), data: {} });
  assert.deepEqual([state.lastEventAt, state.lastEventType], [at(5), 'assistant.turn_end']);

  // Lines over the size limit go through the oversized scanner and applyRecovered, with the type first or last.
  const padded = { canvasId: 'swarm-dashboard', input: { note: 'x'.repeat(400) } };
  const iso = new Date(at(52)).toISOString();
  const big = [
    JSON.stringify({ type: 'session.canvas.recorded', data: padded, id: 'ev-a', timestamp: iso }),
    JSON.stringify({ data: padded, id: 'ev-b', timestamp: iso, type: 'session.canvas.removed' }),
  ];
  const file = logFile(log.lines() + big.join('\n') + '\n');
  const read = createSessionState('cli-2');
  const result = await readNewLines(createTail(file), line => applyLine(read, line), { onOversized: event => applyRecovered(read, event), maxLineBytes: 300 });
  assert.equal(result.skipped, 2);
  assert.deepEqual([read.lines, read.lastEventAt, read.lastEventType], [5, at(5), 'assistant.turn_end']);
});

test('a canvas opened in an old swarm\'s root does not make that swarm live', async () => {
  const home = scenario();
  canvasEvents(home, 'cli-old', [at(6)]);
  const now = at(60);
  const engine = engineFor(home, now);
  const built = [];
  engine.subscribe(change => built.push(...change.swarmIds));
  await engine.refresh();
  assert.deepEqual(built, ['ws-root'], 'the listing alone decides that ws-old is finished: it is not built');
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

test('a log replaced by another of the same size and mtime is read again, so resumed work shows in the listing', async () => {
  const home = scenario();
  canvasEvents(home, 'cli-old', [at(6)]);
  let now = at(60);
  const engine = engineFor(home, now);
  const lifecycleOf = () => engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle;
  await engine.refresh();
  now += MINUTE;
  await engine.refresh();
  assert.equal(lifecycleOf(), 'finished', 'the cache is warm');

  // The same bytes, but the canvas event is now work of the same length; written aside and renamed in, as an atomic save does.
  const file = path.join(home.stateDir, 'cli-old', 'events.jsonl');
  const { size, mtime } = statSync(file);
  const text = readFileSync(file, 'utf8').replace('"session.canvas.recorded"', '"assistant.message_delta"');
  assert.equal(Buffer.byteLength(text), size);
  writeFileSync(`${file}.tmp`, text);
  utimesSync(`${file}.tmp`, mtime, mtime);
  renameSync(`${file}.tmp`, file);
  assert.deepEqual([statSync(file).size, statSync(file).mtimeMs], [size, mtime.getTime()]);
  now += MINUTE;
  await engine.refresh();
  assert.equal(lifecycleOf(), 'live');
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lastActivityAt, at(6));
});

test('a page for a session with only task sub-agents shows that session\'s swarm, not an old swarm whose canvas was restored', async () => {
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
  home.usage([{ sessionId: 'cli-new', nanoAiu: 1e9, createdAt: at(56) }, { sessionId: 'cli-new', nanoAiu: 2e9, createdAt: at(57), parentToolCallId: call }]);
  const engine = engineFor(home, at(60));
  const server = createDashboardServer({ createEngine: () => engine, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 } });
  await server.listen();
  const page = openEvents(server.port, '/api/events?session=cli-new');
  try {
    const { snapshot } = (await page.waitFor(entry => entry.event === 'snapshot', 10000)).data;
    assert.equal(snapshot.run.id, 'cli-new');
    assert.deepEqual(snapshot.units.map(unit => [unit.kind, unit.name]), [['subagent', 'research work']]);
    assert.ok(page.events.filter(entry => entry.event === 'snapshot').every(entry => entry.data.snapshot?.run.id === 'cli-new'), 'never another swarm');
    assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle, 'finished');
  } finally {
    page.close();
    await server.close();
  }
});
