import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from '../engine/model/session-state.mjs';
import { parseEnvelope } from '../engine/model/messages.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

test('reports sent to other sessions keep their purpose, failure and PR mentions', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.report('ws-root', 'Opened PR !4711 for review.\nSee https://dev.azure.com/org/project/_git/repo/pullrequest/4711', 'handoff');
  log.wait(1000);
  const failed = log.tool('send_session_message', { session_id: 'ws-root', message: 'PR #12 is ready' });
  log.done(failed, { success: false });
  const state = fold(log);
  assert.deepEqual(state.sent.map(item => [item.target, item.purpose, item.failed]), [['ws-root', 'handoff', false], ['ws-root', null, true]]);
  assert.ok(state.sent[0].message.startsWith('Opened PR !4711'));
  assert.equal(state.sent[0].source, 'cli-1/call-1');
  assert.deepEqual(state.prMentions.get('ado::4711'), { provider: 'ado', repo: null, id: 4711, count: 2, firstAt: T0, lastAt: T0 });
  assert.equal(state.prMentions.get('any::12').count, 1);
});

test('GitHub pull request URLs are not counted', () => {
  const log = new EventLog(T0);
  log.start();
  log.report('ws-root', 'Ready: https://github.com/sample-org/sample-repo/pull/42', 'handoff');
  assert.equal(fold(log).prMentions.size, 0);
});

test('cross-session messages, automation wakes and human messages are told apart', () => {
  const log = new EventLog(T0);
  log.start();
  log.crossSession({ fromSessionId: 'cli-orch', fromProjectSessionId: 'ws-orch', sourceToolCallId: 'call-77', name: 'Sample story', content: 'Go ahead with option A.' });
  log.wait(1000); log.automationWake();
  log.wait(1000); log.user('Status?');
  const state = fold(log);
  assert.deepEqual(state.inbound, [{ at: T0, fromSessionId: 'cli-orch', fromProjectSessionId: 'ws-orch', fromName: 'Sample story', sourceToolCallId: 'call-77', content: 'Go ahead with option A.' }]);
  assert.deepEqual(state.automation.wakes, [T0 + 1000]);
  assert.deepEqual(state.marks.map(mark => mark.kind), ['monitor']);
  assert.equal(state.lastHumanAt, T0 + 2000);
  assert.equal(state.lastInboundAt, T0 + 2000);
});

test('parseEnvelope returns null without an envelope', () => {
  assert.equal(parseEnvelope('plain text'), null);
});

test('monitor schedules and completed tasks are recorded', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.done(log.tool('save_session_automation', { interval: 'minutes', every_minutes: 10, prompt: 'Check PR !4321' }));
  log.wait(60_000);
  log.done(log.tool('save_session_automation', { clear: true }));
  log.taskComplete('Merged PR !4321 after review.');
  log.taskComplete('Could not finish.', false);
  const state = fold(log);
  assert.deepEqual(state.automation.saves.map(save => [save.at, save.clear, save.everyMinutes]), [[T0, false, 10], [T0 + 60_000, true, null]]);
  assert.deepEqual(state.taskCompletes.map(task => [task.success, task.summary]), [[true, 'Merged PR !4321 after review.'], [false, 'Could not finish.']]);
  assert.equal(state.prMentions.get('ado::4321').count, 1);
  assert.deepEqual(state.feed.map(item => item.text), ['started a PR monitor (every 10 min)', 'stopped its PR monitor', 'completed a task', 'reported a failed task']);
});

test('mergeStates combines the CLI sessions of one project session', () => {
  const first = new EventLog(T0);
  first.start(); first.turnStart(); first.wait(60_000);
  first.report('ws-root', 'PR !77 opened', 'progress'); first.turnEnd(); first.shutdown();
  const second = new EventLog(T0 + 3_600_000);
  second.start(); second.turnStart(); second.wait(30_000);
  second.report('ws-root', 'PR !77 merged', 'handoff'); second.turnEnd();
  const merged = mergeStates([fold(first, 'cli-a'), fold(second, 'cli-b')]);
  assert.equal(merged.busyMs, 90_000);
  assert.deepEqual(merged.busySpans, [[T0, T0 + 60_000], [T0 + 3_600_000, T0 + 3_630_000]]);
  assert.deepEqual(merged.sent.map(item => item.purpose), ['progress', 'handoff']);
  assert.equal(merged.prMentions.get('ado::77').count, 2);
  assert.equal(merged.lastEventAt, T0 + 3_630_000);
  assert.equal(merged.lastEventType, 'assistant.turn_end');
  assert.equal(merged.shutdownAt, T0 + 60_000);
  assert.equal(merged.turn, null);
});

test('a human message that mentions the automation tag is not a wake', () => {
  const log = new EventLog(T0);
  log.start();
  log.user('Why does <session_automation> fire so often?');
  const state = fold(log);
  assert.deepEqual(state.automation.wakes, []);
  assert.equal(state.feed.some(item => item.kind === 'monitor-check'), false);
  assert.equal(state.lastHumanAt, T0);
});

test('an envelope without sender fields is not an inbound message', () => {
  const block = '<cross_session_message>\nnote: pasted text\n</cross_session_message>';
  assert.equal(parseEnvelope(block), null);
  const log = new EventLog(T0);
  log.start();
  log.user('pasted', { transformedContent: block });
  const state = fold(log);
  assert.deepEqual(state.inbound, []);
  assert.equal(state.lastHumanAt, T0);
});

test('a string-typed clear flag stops the monitor', () => {
  const log = new EventLog(T0);
  log.start();
  log.done(log.tool('save_session_automation', { clear: 'true' }));
  const state = fold(log);
  assert.deepEqual(state.automation.saves.map(save => save.clear), [true]);
  assert.deepEqual(state.feed.map(item => item.kind), ['monitor-cleared']);
});
