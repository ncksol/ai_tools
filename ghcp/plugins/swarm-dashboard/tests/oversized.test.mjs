import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, statSync, writeFileSync } from 'node:fs';
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

test('strings over 512 bytes are never captured, not even in part', () => {
  const scanner = createJsonScanner();
  const line = JSON.stringify({
    type: 'assistant.message', timestamp: new Date(T0).toISOString(), id: 'z'.repeat(513), parentId: 'p'.repeat(512),
    data: { toolCallId: 'n'.repeat(513), parentToolCallId: 'n'.repeat(512) },
  });
  scanner.write(Buffer.from(line));
  const event = scanner.finish();
  assert.equal(event.id, undefined);
  assert.equal(event.parentId.length, 512);
  assert.equal(event.data.toolCallId, undefined);
  assert.equal(event.data.parentToolCallId.length, 512);
});

test('escapes, numbers and literals of allowlisted keys are decoded, and other keys are not captured', () => {
  const scanner = createJsonScanner();
  scanner.write(Buffer.from('{"data":{"toolCallId":"x\\"y\\u00e9\\n","durationMs":-12.5e1,"success":true,"other":"no","arr":[1,{"type":"no"}]},"type":"k","timestamp":"2026-10-15T08:00:00Z","agentId":"agent-1","title":"no","n":5}'));
  assert.deepEqual(scanner.finish(), {
    type: 'k', timestamp: '2026-10-15T08:00:00Z', agentId: 'agent-1', data: { toolCallId: 'x"yé\n', durationMs: -125, success: true },
  });
  const nulls = createJsonScanner();
  nulls.write(Buffer.from('{"type":"k","timestamp":"2026-10-15T08:00:00Z","parentId":null,"data":{"success":false,"agentId":null}}'));
  assert.deepEqual(nulls.finish(), { type: 'k', timestamp: '2026-10-15T08:00:00Z', parentId: null, data: { success: false, agentId: null } });
});

const TOP_KEYS = ['type', 'id', 'timestamp', 'parentId', 'agentId', 'data'];
const DATA_KEYS = ['toolCallId', 'success', 'parentToolCallId', 'agentId', 'durationMs'];

test('a very wide line captures only the allowlisted metadata, however many fields it has', () => {
  const scanner = createJsonScanner();
  scanner.write(Buffer.from(`{"type":"tool.execution_complete","id":"ev-1","timestamp":"${new Date(T0).toISOString()}"`));
  // 20,000 short top-level fields, streamed in small batches (the line is never built whole)
  for (let batch = 0; batch < 200; batch += 1) {
    let text = '';
    for (let i = 0; i < 100; i += 1) text += `,"field${batch * 100 + i}":"value"`;
    scanner.write(Buffer.from(text));
  }
  scanner.write(Buffer.from(',"data":{"toolCallId":"call-1"'));
  for (let batch = 0; batch < 200; batch += 1) {
    let text = '';
    for (let i = 0; i < 100; i += 1) text += `,"item${batch * 100 + i}":${i}`;
    scanner.write(Buffer.from(text));
  }
  scanner.write(Buffer.from(',"success":false}}'));
  const event = scanner.finish();
  assert.deepEqual(event, { type: 'tool.execution_complete', id: 'ev-1', timestamp: new Date(T0).toISOString(), data: { toolCallId: 'call-1', success: false } });
  assert.ok(Object.keys(event).every(key => TOP_KEYS.includes(key)));
  assert.ok(Object.keys(event.data).every(key => DATA_KEYS.includes(key)));
});

test('a repeated allowlisted key keeps its last value', () => {
  const scanner = createJsonScanner();
  scanner.write(Buffer.from(`{"type":"first","type":"tool.execution_complete","timestamp":"${new Date(T0).toISOString()}","data":{"toolCallId":"a","toolCallId":"b"}}`));
  const event = scanner.finish();
  assert.equal(event.type, 'tool.execution_complete');
  assert.equal(event.data.toolCallId, 'b');
});

test('a key over 4 KB is ignored and later metadata is still recovered', async () => {
  const longKey = 'k'.repeat(5000);
  const line = `{"${longKey}":"ignored","data":{"${longKey}":1,"toolCallId":"call-2"},"type":"tool.execution_complete","timestamp":"${new Date(T0).toISOString()}"}`;
  for (const chunkSize of [4096, 7]) {
    const { oversized } = await readFile([line, '{"n":5}'], { chunkSize });
    assert.deepEqual(oversized[0].event, { type: 'tool.execution_complete', timestamp: new Date(T0).toISOString(), data: { toolCallId: 'call-2' } });
  }
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

test('an oversized cancelled subagent.completed keeps its cancelled flag, and the event after it is applied once', async () => {
  for (const typeLast of [false, true]) {
    const label = `typeLast ${typeLast}`;
    const log = new EventLog(T0);
    log.start(); log.turnStart();
    const call = log.subagent({ name: 'helper', mode: 'background', agentId: 'agent-1' });
    const cancelled = {
      type: 'subagent.completed', id: 'ev-cancel', timestamp: iso(T0 + 3 * MINUTE), parentId: null, agentId: 'agent-1',
      data: { toolCallId: call, cancelled: true, durationMs: 120_000, summary: 'synthetic free text '.repeat(400) },
    };
    const recovered = (await readFile([bigLine(cancelled, { typeLast })])).oversized[0].event;
    assert.deepEqual(recovered, {
      type: 'subagent.completed', id: 'ev-cancel', timestamp: iso(T0 + 3 * MINUTE), parentId: null, agentId: 'agent-1',
      data: { toolCallId: call, cancelled: true, durationMs: 120_000 },
    }, label);
    const after = new EventLog(T0 + 4 * MINUTE);
    after.turnEnd();
    const startLines = log.events.map(lineOf);
    const { state, result } = await fold([...startLines, bigLine(cancelled, { typeLast }), ...after.events.map(lineOf)]);
    assert.equal(result.skipped, 1, label);
    const sub = state.subagents.get(call);
    assert.equal(sub.status, 'cancelled', label);
    assert.equal(sub.durationMs, 120_000, label);
    assert.deepEqual(state.subagentOutcomes, { completed: 0, failed: 0, cancelled: 1 }, label);
    assert.equal(state.lines, startLines.length + 2, label);
    assert.equal(state.turn, null, label);
    assert.equal(state.lastTurnEndAt, T0 + 4 * MINUTE, label);
    assert.equal(state.feed.filter(item => item.kind === 'subagent-done').length, 1, label);
  }
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

const iso = ms => new Date(ms).toISOString();
const PROTOTYPE_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];
const ODD_TYPES = ['unknown.event', ...PROTOTYPE_NAMES];

test('events of an unknown type or a prototype-named type only move the clock', () => {
  for (const type of ODD_TYPES) {
    const state = createSessionState('cli-1');
    applyLine(state, lineOf({ type, id: 'ev-1', timestamp: iso(T0 + MINUTE), data: { toolCallId: 'call-1', success: false } }));
    assert.equal(state.lastEventAt, T0 + MINUTE, type);
    assert.equal(state.lines, 1, type);
    assert.equal(state.parseErrors, 0, type);
    assert.equal(state.openTools.size + state.waits.size + state.subagents.size, 0, type);
    assert.equal(state.feed.length + state.marks.length + state.recent.failures.length, 0, type);
  }
});

test('tools named after prototype members open and close a call and add no wait, question or plan', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    const log = new EventLog(T0);
    log.start(); log.turnStart();
    const state = createSessionState('cli-1');
    for (const event of log.events) applyLine(state, lineOf(event));
    const feedBefore = state.feed.length;
    const marksBefore = state.marks.length;
    const call = log.tool(name, { question: 'Which colour?', summary: 'A plan' });
    applyLine(state, lineOf(log.events[log.events.length - 1]));
    assert.equal(state.openTools.size, 1, name);
    assert.equal(state.openTools.get(call).name, name);
    assert.equal(state.waits.size, 0, name);
    log.done(call);
    applyLine(state, lineOf(log.events[log.events.length - 1]));
    assert.equal(state.openTools.size, 0, name);
    assert.equal(state.waits.size, 0, name);
    assert.equal(state.waitSpans.length, 0, name);
    assert.equal(state.marks.length, marksBefore, name);
    assert.equal(state.feed.some(item => ['question', 'plan-req', 'answer', 'plan-ok'].includes(item.kind)), false, name);
    assert.ok(state.feed.length >= feedBefore);
  }
});

test('oversized events of an unknown or prototype-named type only move the clock, and the turn end after them is applied', async () => {
  for (const type of ODD_TYPES) {
    for (const typeLast of [false, true]) {
      const log = new EventLog(T0);
      log.start(); log.turnStart();
      log.at(T0 + 4 * MINUTE); log.turnEnd();
      const [start, turnStart, turnEnd] = log.events.map(lineOf);
      const odd = { type, id: 'ev-odd', timestamp: iso(T0 + 5 * MINUTE), parentId: null, data: { toolCallId: 'call-1', success: false } };
      const { state, result } = await fold([start, turnStart, bigLine(odd, { typeLast }), turnEnd]);
      const label = `${type}, typeLast ${typeLast}`;
      assert.equal(result.skipped, 1, label);
      assert.equal(result.failed, undefined, label);
      assert.equal(state.turn, null, label);
      assert.equal(state.lastTurnEndAt, T0 + 4 * MINUTE, label);
      assert.equal(state.lastEventAt, T0 + 5 * MINUTE, label);
      assert.equal(state.lines, 4, label);
      assert.equal(state.recent.failures.length, 0, label);
    }
  }
});

const BOOM = 'throw-on-this-line';
const markedLine = (content = BOOM) => lineOf({ type: 'assistant.message', id: 'ev-marked', timestamp: iso(T0 + MINUTE), data: { content } });

/** Reads a log with handlers that may throw; returns the tail, state, result and how many lines each handler saw. */
async function readThrowing(lines, { onLine, onOversized }) {
  const state = createSessionState('cli-1');
  const file = path.join(dir, `throw-${counter += 1}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const tail = createTail(file);
  const seen = { lines: 0, oversized: 0 };
  const options = {
    maxLineBytes: LIMIT,
    onOversized: (event, bytes) => { seen.oversized += 1; onOversized(state, event, bytes); },
  };
  const read = () => readNewLines(tail, line => { seen.lines += 1; onLine(state, line); }, options);
  return { state, file, tail, seen, read };
}

const applyUnlessMarked = (state, line) => {
  if (line.includes(BOOM)) throw new Error('boom');
  applyLine(state, line);
};

test('a line that throws is counted and skipped, the rest of its chunk is applied, and nothing is read twice', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.at(T0 + 2 * MINUTE); log.turnEnd();
  const [start, turnStart, turnEnd] = log.events.map(lineOf);
  const run = await readThrowing([start, turnStart, markedLine(), turnEnd], { onLine: applyUnlessMarked, onOversized: applyRecovered });
  const first = await run.read();
  assert.equal(first.failed, 1);
  assert.equal(first.lastError, 'boom');
  assert.equal(first.lines, 4);
  assert.equal(run.state.turn, null);
  assert.equal(run.state.lastTurnEndAt, T0 + 2 * MINUTE);
  assert.equal(run.tail.offset, statSync(run.file).size);
  appendFileSync(run.file, `${lineOf({ type: 'assistant.message', id: 'ev-later', timestamp: iso(T0 + 3 * MINUTE), data: { content: 'later' } })}\n`);
  const second = await run.read();
  assert.equal(second.lines, 1);
  assert.equal('failed' in second, false);
  assert.equal('lastError' in second, false);
  assert.equal(run.seen.lines, 5);
  assert.equal(run.state.lastEventAt, T0 + 3 * MINUTE);
});

test('an oversized line whose handler throws is counted and skipped, and the turn end after it is applied', async () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.at(T0 + 2 * MINUTE); log.turnEnd();
  const [start, turnStart, turnEnd] = log.events.map(lineOf);
  const odd = { type: 'boom.type', id: 'ev-odd', timestamp: iso(T0 + MINUTE), parentId: null, data: {} };
  const onOversized = (state, event) => {
    if (event?.type === 'boom.type') throw new Error('oversized boom');
    applyRecovered(state, event);
  };
  const run = await readThrowing([start, turnStart, bigLine(odd), turnEnd], { onLine: applyUnlessMarked, onOversized });
  const first = await run.read();
  assert.equal(first.skipped, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.lastError, 'oversized boom');
  assert.equal(run.state.turn, null);
  assert.equal(run.tail.offset, statSync(run.file).size);
  appendFileSync(run.file, `${markedLine('fine')}\n`);
  const second = await run.read();
  assert.equal(second.lines, 1);
  assert.equal(second.failed, undefined);
  assert.equal(run.seen.oversized, 1);
  assert.equal(run.seen.lines, 4);
});

test('failed lines are all counted, and the last error is clipped to 200 characters', async () => {
  const lines = [markedLine(), markedLine('fine'), markedLine(), markedLine('fine')];
  let calls = 0;
  const onLine = (state, line) => {
    if (!line.includes(BOOM)) return;
    calls += 1;
    throw new Error(calls === 1 ? 'first' : 'x'.repeat(500));
  };
  const run = await readThrowing(lines, { onLine, onOversized: applyRecovered });
  const result = await run.read();
  assert.equal(result.failed, 2);
  assert.equal(result.lastError, 'x'.repeat(200));
  assert.equal(result.lines, 4);
});

test('an oversized line counts as failed once, whether its scanner, its handler or both threw', async () => {
  const always = () => { throw new Error('handler threw'); };
  // A real scanner and a handler that always throws.
  const real = await readThrowing([bigLine(complete()), markedLine('fine')], { onLine: applyUnlessMarked, onOversized: always });
  const first = await real.read();
  assert.equal(first.skipped, 1);
  assert.equal(first.failed, 1);
  assert.equal(first.lastError, 'handler threw');
  assert.equal(first.lines, 1);
  // No input makes the scanner throw, so the tail is seeded as if an oversized line were already streaming, with a
  // scanner that throws; the file holds the rest of that line and one more line.
  for (const broken of ['write', 'finish']) {
    const file = path.join(dir, `scanner-${counter += 1}.jsonl`);
    const rest = 'rest of a long line';
    writeFileSync(file, `${rest}\n${markedLine('fine')}\n`);
    const tail = createTail(file);
    tail.skipping = true;
    tail.skipBytes = 10;
    tail.scanner = {
      write() { if (broken === 'write') throw new Error('scanner threw'); },
      finish() { throw new Error('scanner threw'); },
    };
    const calls = [];
    const delivered = [];
    const result = await readNewLines(tail, line => delivered.push(line), {
      maxLineBytes: LIMIT, onOversized: (event, bytes) => { calls.push([event, bytes]); throw new Error('handler threw'); },
    });
    assert.deepEqual(calls, [[null, 10 + rest.length + 1]], broken);
    assert.equal(result.skipped, 1, broken);
    assert.equal(result.failed, 1, broken);
    assert.equal(result.lastError, 'scanner threw', broken);
    assert.equal(delivered.length, 1, broken);
    assert.equal(tail.offset, statSync(file).size, broken);
  }
});

const FALSY_THROWS = [undefined, null, false, 0, ''];
const nameOf = value => (value === '' ? "''" : String(value));

/** A tail seeded as if an oversized line were already streaming (no input makes the real scanner throw), with a custom scanner. */
function seededRead(scanner, { onOversized, chunkSize = 4 } = {}) {
  const file = path.join(dir, `falsy-${counter += 1}.jsonl`);
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.at(T0 + MINUTE); log.turnEnd();
  writeFileSync(file, `rest of a long line\n${log.events.map(lineOf).join('\n')}\n`);
  const tail = createTail(file);
  tail.skipping = true;
  tail.skipBytes = 10;
  tail.scanner = scanner;
  const state = createSessionState('cli-1');
  const calls = [];
  const read = readNewLines(tail, line => applyLine(state, line), {
    chunkSize, maxLineBytes: LIMIT, onOversized: (event, bytes) => { calls.push([event, bytes]); if (onOversized) onOversized(); },
  });
  return { read, calls, state, tail, file };
}

test('a scanner that throws a falsy value fails its line once, and is not written to again', async () => {
  for (const thrown of FALSY_THROWS) {
    const label = nameOf(thrown);
    let writes = 0;
    const { read, calls, state, tail, file } = seededRead({ write() { writes += 1; throw thrown; }, finish() { throw new Error('not reached'); } });
    const result = await read;
    assert.equal(writes, 1, label);
    assert.equal(result.skipped, 1, label);
    assert.equal(result.failed, 1, label);
    assert.ok(result.lastError.length > 0, label);
    assert.deepEqual(calls, [[null, 10 + 'rest of a long line'.length + 1]], label);
    assert.equal(state.turn, null, label);
    assert.equal(tail.offset, statSync(file).size, label);
  }
});

test('a scanner whose finish throws a falsy value fails its line once', async () => {
  for (const thrown of FALSY_THROWS) {
    const label = nameOf(thrown);
    const { read, calls, state } = seededRead({ write() {}, finish() { throw thrown; } });
    const result = await read;
    assert.equal(result.failed, 1, label);
    assert.ok(result.lastError.length > 0, label);
    assert.deepEqual(calls.map(call => call[0]), [null], label);
    assert.equal(state.turn, null, label);
  }
});

test('an onOversized that throws a falsy value fails its line once, and the turn end after it is applied', async () => {
  for (const thrown of FALSY_THROWS) {
    const label = nameOf(thrown);
    const { read, calls, state } = seededRead({ write() {}, finish() { return null; } }, { onOversized() { throw thrown; } });
    const result = await read;
    assert.equal(calls.length, 1, label);
    assert.equal(result.failed, 1, label);
    assert.ok(result.lastError.length > 0, label);
    assert.equal(state.turn, null, label);
    assert.equal(state.lastTurnEndAt, T0 + MINUTE, label);
  }
});

test('an onLine that throws a falsy value fails its line once', async () => {
  for (const thrown of FALSY_THROWS) {
    const label = nameOf(thrown);
    const run = await readThrowing([markedLine('fine'), markedLine('fine')], { onLine: () => { throw thrown; }, onOversized: applyRecovered });
    const result = await run.read();
    assert.equal(result.failed, 2, label);
    assert.ok(result.lastError.length > 0, label);
    assert.equal(result.lines, 2, label);
  }
});
