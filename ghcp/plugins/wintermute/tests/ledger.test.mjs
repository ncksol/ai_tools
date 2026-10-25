import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTail } from '../engine/readers/events.mjs';
import { BUCKET_MS, createLedger, readUsage, usageOf } from '../engine/readers/ledger.mjs';
import { tempDir } from './helpers/temp.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const iso = minute => new Date(T0 + minute * 60_000).toISOString();
let events = 0;

/** A session.usage_record as the CLI writes it; `usageId` repeats when a resumed session writes the same call again. */
function record(usageId, nano, { minute = 1, model = 'claude-sonnet-5', source = 'cli-a', task = null, agentId = null, duration = 1000 } = {}) {
  const usage = { model, duration, accounting: { sourceSessionId: source, sequence: 1, usageId }, copilotUsage: { totalNanoAiu: nano }, cost: 15 };
  if (task) usage.parentToolCallId = task;
  return { type: 'session.usage_record', data: { usage }, ...(agentId ? { agentId } : {}), id: `ev-${++events}`, timestamp: iso(minute), parentId: null };
}

function compaction(nano, { minute = 1, model = 'gpt-6-astra', agentId = null, id = `ev-${++events}` } = {}) {
  return {
    type: 'session.compaction_complete', ...(agentId ? { agentId } : {}), id, timestamp: iso(minute), parentId: null,
    data: { success: true, compactionTokensUsed: { model, duration: 5000, copilotUsage: { totalNanoAiu: nano } } },
  };
}

const started = (taskId, agentId, parentAgentId) => ({
  type: 'subagent.started', agentId, id: `ev-${++events}`, timestamp: iso(1), parentId: null,
  data: { toolCallId: taskId, agentName: 'explore', ...(parentAgentId ? { parentId: parentAgentId } : {}) },
});

test('apply aggregates per session, model, sub-agent call and 5-minute bucket', () => {
  const ledger = createLedger();
  ledger.apply('cli-a', record('u1', 1e9, { minute: 1 }));
  ledger.apply('cli-a', record('u2', 2e9, { minute: 2, model: 'gpt-5.5', duration: 2000 }));
  ledger.apply('cli-a', record('u3', 3e9, { minute: 7, task: 'call-7', agentId: 'agent-7', source: 'sub-7' }));
  ledger.apply('cli-b', record('u1', 4e9, { minute: 9, source: 'cli-b' }));
  const a = ledger.session('cli-a');
  assert.equal(a.nanoAiu, 6e9);
  assert.equal(a.calls, 3);
  assert.equal(a.apiMs, 4000);
  assert.deepEqual(a.byModel.get('gpt-5.5'), { nanoAiu: 2e9, calls: 1, apiMs: 2000 });
  assert.deepEqual(a.byParentToolCall.get('call-7'), { nanoAiu: 3e9, calls: 1, apiMs: 1000 });
  assert.equal(a.firstAt, T0 + 60_000);
  assert.equal(a.lastAt, T0 + 7 * 60_000);
  assert.equal(a.buckets.get(Math.floor((T0 + 60_000) / BUCKET_MS) * BUCKET_MS), 3e9);
  assert.equal(ledger.session('cli-b').nanoAiu, 4e9);
  assert.equal(ledger.hasSubagentWork('cli-a'), true);
  assert.equal(ledger.hasSubagentWork('cli-b'), false);
  const both = ledger.sumFor(['cli-a', 'cli-b', 'cli-a', 'missing']);
  assert.equal(both.nanoAiu, 10e9);
  assert.equal(both.calls, 4);
});

test('a usage record that a resumed session writes again is counted once', () => {
  const ledger = createLedger();
  assert.equal(ledger.apply('cli-a', record('u1', 5e9)), true);
  assert.equal(ledger.apply('cli-a', record('u1', 5e9, { minute: 30 })), false, 'same sourceSessionId and usageId');
  assert.equal(ledger.apply('cli-a', record('u1', 5e9, { source: 'sub-1' })), true, 'another source session is another call');
  assert.equal(ledger.session('cli-a').nanoAiu, 10e9);
  assert.equal(ledger.session('cli-a').calls, 2);
});

test('a long usageId is deduped by its digest', () => {
  const ledger = createLedger();
  const long = 'Y'.repeat(600);
  ledger.apply('cli-a', record(long, 1e9));
  ledger.apply('cli-a', record(long, 1e9));
  ledger.apply('cli-a', record(`${'Y'.repeat(599)}Z`, 1e9));
  assert.equal(ledger.session('cli-a').calls, 2);
});

test('a compaction adds its cost and model once; one in a sub-agent goes to its task through its agent id', () => {
  const ledger = createLedger();
  const main = compaction(7e9, { id: 'compact-1' });
  ledger.apply('cli-a', main);
  ledger.apply('cli-a', main);
  ledger.apply('cli-a', started('call-1', 'agent-1'));
  ledger.apply('cli-a', compaction(3e9, { agentId: 'agent-1', model: 'claude-opus-5.5' }));
  ledger.apply('cli-a', { type: 'session.compaction_complete', id: 'compact-x', timestamp: iso(1), data: { success: false } });
  const a = ledger.session('cli-a');
  assert.equal(a.nanoAiu, 10e9);
  assert.equal(a.calls, 2);
  assert.deepEqual(a.byModel.get('gpt-6-astra'), { nanoAiu: 7e9, calls: 1, apiMs: 5000 });
  assert.deepEqual(a.byParentToolCall.get('call-1'), { nanoAiu: 3e9, calls: 1, apiMs: 5000 });
});

test('a nested sub-agent\'s call is kept under its own task id, and a record with only an agent id finds its task', () => {
  const ledger = createLedger();
  ledger.apply('cli-a', started('call-outer', 'agent-outer'));
  ledger.apply('cli-a', started('call-inner', 'agent-inner', 'agent-outer'));
  ledger.apply('cli-a', record('u1', 2e9, { agentId: 'agent-outer', task: 'call-outer', source: 's1' }));
  ledger.apply('cli-a', record('u2', 5e9, { agentId: 'agent-inner', task: 'call-inner', source: 's2' }));
  ledger.apply('cli-a', record('u3', 1e9, { agentId: 'agent-inner', source: 's2' }));
  const a = ledger.session('cli-a');
  assert.deepEqual([...a.byParentToolCall].map(([id, entry]) => [id, entry.nanoAiu]), [['call-outer', 2e9], ['call-inner', 6e9]]);
});

test('usageOf ignores other events and malformed records', () => {
  assert.equal(usageOf({ type: 'assistant.message', data: { content: 'session.usage_record' } }), null);
  assert.equal(usageOf({ type: 'session.usage_record', data: {} }), null);
  assert.equal(usageOf(null), null);
  assert.equal(usageOf({ type: 'session.usage_record', data: { usage: { model: 'm' } } }), null, 'no usageId and no event id');
  assert.equal(usageOf({ type: 'session.usage_record', id: 'e1', data: { usage: { model: 'm' } } }).key, 'e:e1');
});

const line = event => `${JSON.stringify(event)}\n`;

test('readUsage reads only new bytes, counts a repeated record once after a resume, and starts again on a replaced log', async () => {
  const file = path.join(tempDir('ledger-'), 'events.jsonl');
  writeFileSync(file, [
    { type: 'session.start', id: 's', timestamp: iso(0), data: {} },
    record('u1', 1e9),
    { type: 'assistant.message', id: 'm', timestamp: iso(1), data: { content: 'mentions session.usage_record in text' } },
    record('u2', 2e9),
  ].map(line).join(''));
  const ledger = createLedger();
  const tail = createTail(file);
  await readUsage(tail, ledger, 'cli-a');
  assert.equal(ledger.session('cli-a').nanoAiu, 3e9);

  // The session resumes: the log repeats the earlier record, then the session makes one more call.
  appendFileSync(file, line({ type: 'session.resume', id: 'r', timestamp: iso(20), data: {} }) + line(record('u2', 2e9, { minute: 2 })) + line(record('u3', 4e9, { minute: 21 })));
  const result = await readUsage(tail, ledger, 'cli-a');
  assert.equal(result.lines, 3, 'only the appended lines are read');
  assert.equal(ledger.session('cli-a').nanoAiu, 7e9, 'the total goes up by the new call only');
  assert.equal(ledger.session('cli-a').calls, 3);

  writeFileSync(file, line(record('u9', 9e9)));
  await readUsage(tail, ledger, 'cli-a');
  assert.equal(ledger.session('cli-a').nanoAiu, 9e9, 'a shorter log is read again from the start');
});

test('retain forgets sessions that left every swarm', () => {
  const ledger = createLedger();
  ledger.apply('cli-a', record('u1', 1e9));
  ledger.apply('cli-b', record('u1', 1e9, { source: 'cli-b' }));
  ledger.retain(new Set(['cli-b']));
  assert.equal(ledger.session('cli-a'), null);
  assert.equal(ledger.session('cli-b').nanoAiu, 1e9);
});
