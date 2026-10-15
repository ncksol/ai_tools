import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { createJsonScanner } from '../engine/readers/json-scan.mjs';
import { createTail, readNewLines } from '../engine/readers/events.mjs';
import { applyLine, applyRecovered, createSessionState } from '../engine/model/session-state.mjs';
import { evaluateStatus } from '../engine/model/status.mjs';
import { MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { tempDir } from './helpers/temp.mjs';

const dir = tempDir('swarm-oversized-');
const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const LIMIT = 4000;
let counter = 0;

/** A log line far over LIMIT: a large data.result with escaped quotes and nested "type":"text" objects. */
function bigLine(event, { typeLast = false } = {}) {
  const late = new Set(['success', 'durationMs']);
  const early = Object.entries(event.data ?? {}).filter(([key]) => !late.has(key));
  const after = Object.entries(event.data ?? {}).filter(([key]) => late.has(key));
  const result = {
    content: 'é日 "type":"text" \\"quoted\\" 🙂 '.repeat(400),
    blocks: [{ type: 'text', toolCallId: 'nested-call', success: true, timestamp: 'nested', id: 'nested-id' }],
    summary: 'y'.repeat(5000),
  };
  const data = Object.fromEntries([...early, ['result', result], ...after]);
  const head = { id: event.id, timestamp: event.timestamp, parentId: event.parentId, ...(event.agentId ? { agentId: event.agentId } : {}) };
  const keys = typeLast ? { data, ...head, type: event.type } : { type: event.type, data, ...head };
  return JSON.stringify(keys);
}

async function readFile(lines, { chunkSize = 256 * 1024, maxLineBytes = LIMIT } = {}) {
  const file = path.join(dir, `log-${counter += 1}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const delivered = [];
  const oversized = [];
  const result = await readNewLines(createTail(file), line => delivered.push(line), {
    chunkSize, maxLineBytes, onOversized: (event, bytes) => oversized.push({ event, bytes }),
  });
  return { delivered, oversized, result };
}

const complete = (id = 'ev-5', extra = {}) => ({
  type: 'tool.execution_complete', id, timestamp: new Date(T0 + 4 * MINUTE).toISOString(), parentId: 'ev-4',
  data: { toolCallId: 'call-9', success: false, ...extra },
});

test('the scanner recovers type, ids, time and data keys from an oversized line whose type comes first', async () => {
  const { delivered, oversized, result } = await readFile([bigLine(complete()), '{"n":2}']);
  assert.deepEqual(delivered, ['{"n":2}']);
  assert.equal(result.skipped, 1);
  assert.equal(oversized.length, 1);
  const { event, bytes } = oversized[0];
  assert.ok(bytes > LIMIT);
  assert.deepEqual(event, {
    type: 'tool.execution_complete', id: 'ev-5', timestamp: new Date(T0 + 4 * MINUTE).toISOString(), parentId: 'ev-4',
    data: { toolCallId: 'call-9', success: false },
  });
});

test('the scanner reads a type that sits after a large data field, and ignores nested keys', async () => {
  const { oversized } = await readFile([bigLine(complete(), { typeLast: true })]);
  const { event } = oversized[0];
  assert.equal(event.type, 'tool.execution_complete');
  assert.equal(event.id, 'ev-5');
  assert.equal(event.parentId, 'ev-4');
  assert.deepEqual(event.data, { toolCallId: 'call-9', success: false });
  assert.equal(JSON.stringify(event).includes('nested'), false);
});

test('the same results come from tiny chunks that split strings, escapes, keys, literals and multi-byte characters', async () => {
  for (const typeLast of [false, true]) {
    const expected = (await readFile([bigLine(complete(), { typeLast })])).oversized[0].event;
    for (const chunkSize of [1, 3, 7]) {
      const { oversized, delivered } = await readFile([bigLine(complete(), { typeLast }), '{"n":3}'], { chunkSize });
      assert.deepEqual(oversized[0].event, expected, `typeLast ${typeLast}, chunk ${chunkSize}`);
      assert.deepEqual(delivered, ['{"n":3}']);
    }
  }
});

test('strings over 4 KB are never captured, not even in part', () => {
  const scanner = createJsonScanner();
  const line = JSON.stringify({
    type: 'assistant.message', timestamp: new Date(T0).toISOString(), title: 'z'.repeat(5000), data: { toolCallId: 'c', note: 'n'.repeat(4097), ok: 'n'.repeat(4096) },
  });
  scanner.write(Buffer.from(line));
  const event = scanner.finish();
  assert.equal(event.title, undefined);
  assert.equal(event.data.note, undefined);
  assert.equal(event.data.ok.length, 4096);
});

test('escapes, numbers and literals are decoded when captured', () => {
  const scanner = createJsonScanner();
  scanner.write(Buffer.from('{"data":{"a":"x\\"y\\u00e9\\n","n":-12.5e1,"t":true,"f":false,"z":null,"arr":[1,{"type":"no"}]},"type":"k","timestamp":"2026-10-15T08:00:00Z","agentId":"agent-1"}'));
  assert.deepEqual(scanner.finish(), {
    type: 'k', timestamp: '2026-10-15T08:00:00Z', agentId: 'agent-1', data: { a: 'x"yé\n', n: -125, t: true, f: false, z: null },
  });
});

test('a line with no recoverable type or time gives null, and later lines still arrive', async () => {
  const noType = JSON.stringify({ foo: 'bar', timestamp: new Date(T0).toISOString(), pad: 'x'.repeat(6000) });
  const noTime = JSON.stringify({ type: 'assistant.message', data: { text: 'x'.repeat(6000) } });
  const junk = 'not json at all '.repeat(500);
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  const { oversized, delivered, result } = await readFile([noType, noTime, junk, deep, '{"n":4}']);
  assert.deepEqual(oversized.map(item => item.event), [null, null, null, null]);
  assert.equal(result.skipped, 4);
  assert.deepEqual(delivered, ['{"n":4}']);
});

const evaluate = (state, now) => evaluateStatus({
  state, alive: true, archivedAt: null, merged: false, mergedAt: null, outcome: null, hasRegistry: false, report: null,
  parentRepliedAt: null, monitorDueAt: null, isRunningFlag: false, startedAt: T0, now, thresholds: DEFAULT_THRESHOLDS,
});

/** Fold lines into a session state the way the engine does, with a small size limit. */
async function fold(lines) {
  const state = createSessionState('cli-1');
  const file = path.join(dir, `fold-${counter += 1}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const result = await readNewLines(createTail(file), line => applyLine(state, line), {
    maxLineBytes: LIMIT, onOversized: event => applyRecovered(state, event),
  });
  return { state, result };
}

const lineOf = event => JSON.stringify(event);

test('an oversized completion still closes its tool call, so no false stuck tool', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.tool('bash', { command: 'npm test', initial_wait: 30 });
  const startLines = log.events.map(lineOf);
  const done = { type: 'tool.execution_complete', id: 'ev-done', timestamp: new Date(T0 + 4 * MINUTE).toISOString(), parentId: null, data: { toolCallId: call, success: true } };
  const after = new EventLog(T0 + 29 * MINUTE);
  after.message();
  const { state, result } = await fold([...startLines, bigLine(done, { typeLast: true }), ...after.events.map(lineOf)]);
  assert.equal(result.skipped, 1);
  assert.equal(state.openTools.size, 0);
  assert.equal(state.lines, startLines.length + 2);
  const status = evaluate(state, T0 + 30 * MINUTE);
  assert.notEqual(status.detail, 'stuck_tool');
  assert.equal(status.detail, 'busy');
});

test('an oversized failed completion closes its call and counts as a failure', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.tool('bash', { command: 'npm test' });
  const failed = { type: 'tool.execution_complete', id: 'ev-fail', timestamp: new Date(T0 + MINUTE).toISOString(), parentId: null, data: { toolCallId: call, success: false } };
  const { state } = await fold([...log.events.map(lineOf), bigLine(failed, { typeLast: true })]);
  assert.equal(state.openTools.size, 0);
  assert.deepEqual(state.recent.failures, [T0 + MINUTE]);
  assert.equal(state.lastEventAt, T0 + MINUTE);
});

test('an oversized ask_user completion closes the wait', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.ask('Which colour?');
  const answered = { type: 'tool.execution_complete', id: 'ev-answer', timestamp: new Date(T0 + MINUTE).toISOString(), parentId: null, data: { toolCallId: call, success: true } };
  const { state } = await fold([...log.events.map(lineOf), bigLine(answered, { typeLast: true })]);
  assert.equal(state.waits.size, 0);
  assert.equal(state.waitSpans.length, 1);
});

test('an oversized subagent.completed finishes its sub-agent, so no false stuck sub-agent', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ name: 'helper', mode: 'background', agentId: 'agent-1' });
  const finished = {
    type: 'subagent.completed', id: 'ev-sub', timestamp: new Date(T0 + 20 * MINUTE).toISOString(), parentId: null, agentId: 'agent-1',
    data: { toolCallId: call, durationMs: 1_140_000, totalTokens: 10 },
  };
  const { state } = await fold([...log.events.map(lineOf), bigLine(finished, { typeLast: true })]);
  const sub = state.subagents.get(call);
  assert.equal(sub.status, 'completed');
  assert.equal(sub.durationMs, 1_140_000);
  assert.notEqual(evaluate(state, T0 + 40 * MINUTE).detail, 'stuck_subagent');
});

test('an oversized event inside a sub-agent moves that sub-agent\'s last event time', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ name: 'helper', mode: 'background' });
  const inside = {
    type: 'assistant.message', id: 'ev-inside', timestamp: new Date(T0 + 15 * MINUTE).toISOString(), parentId: null, data: { parentToolCallId: call },
  };
  const { state } = await fold([...log.events.map(lineOf), bigLine(inside, { typeLast: true })]);
  assert.equal(state.subagents.get(call).lastEventAt, T0 + 15 * MINUTE);
  assert.equal(state.lastEventAt, T0 + 15 * MINUTE);
});

test('a recovered event of a skipped large type only moves the clock, as applyLine does', () => {
  const state = createSessionState('cli-1');
  applyRecovered(state, { type: 'session.usage_checkpoint', timestamp: new Date(T0).toISOString(), data: {} });
  assert.equal(state.lastEventAt, T0);
  assert.equal(state.lastMainAt, null);
  assert.equal(state.lines, 1);
  applyRecovered(state, null);
  assert.equal(state.lines, 2);
});

test('an oversized task completion adds no text, PR mention or feed entry, but moves the clock', async () => {
  const log = new EventLog(T0);
  log.start();
  const complete = {
    type: 'session.task_complete', id: 'ev-task', timestamp: new Date(T0 + 5 * MINUTE).toISOString(), parentId: null,
    data: { summary: 'Opened PR !4711 for review.', success: true },
  };
  const { state } = await fold([...log.events.map(lineOf), bigLine(complete, { typeLast: true })]);
  assert.equal(state.lastEventAt, T0 + 5 * MINUTE);
  assert.equal(state.taskCompletes.length, 0);
  assert.equal(state.prMentions.size, 0);
  assert.equal(state.feed.some(item => item.kind === 'task-complete'), false);
});

test('an oversized ask_user start adds no wait and no question text', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const ask = {
    type: 'tool.execution_start', id: 'ev-ask', timestamp: new Date(T0 + MINUTE).toISOString(), parentId: null,
    data: { toolCallId: 'call-ask', toolName: 'ask_user', arguments: JSON.stringify({ question: 'Which colour?' }) },
  };
  const { state } = await fold([...log.events.map(lineOf), bigLine(ask, { typeLast: true })]);
  assert.equal(state.lastEventAt, T0 + MINUTE);
  assert.equal(state.waits.size, 0);
  assert.equal(state.openTools.size, 0);
  assert.equal(state.marks.length, 0);
  assert.equal(state.feed.some(item => item.kind === 'question'), false);
});

test('an oversized user message does not count as a prompt or reach the message lists', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const prompt = {
    type: 'user.message', id: 'ev-user', timestamp: new Date(T0 + MINUTE).toISOString(), parentId: null,
    data: { content: 'Please open PR !4711', source: 'system' },
  };
  const { state } = await fold([...log.events.map(lineOf), bigLine(prompt, { typeLast: true })]);
  assert.equal(state.prompts, 0);
  assert.equal(state.lastHumanAt, null);
  assert.equal(state.inbound.length, 0);
  assert.equal(state.automation.wakes.length, 0);
  assert.equal(state.lastEventAt, T0 + MINUTE);
});

test('other oversized events inside a sub-agent only move that sub-agent\'s clock', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ name: 'helper', mode: 'background', agentId: 'agent-7' });
  const inside = { type: 'assistant.message', id: 'ev-in', timestamp: new Date(T0 + 9 * MINUTE).toISOString(), parentId: null, agentId: 'agent-7', data: {} };
  const { state } = await fold([...log.events.map(lineOf), bigLine(inside, { typeLast: true })]);
  assert.equal(state.subagents.get(call).lastEventAt, T0 + 9 * MINUTE);
});
