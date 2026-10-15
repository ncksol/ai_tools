import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLine, createSessionState, mergeStates } from '../engine/model/session-state.mjs';
import { LIMITS } from '../engine/model/state-utils.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

test('main turns add up to busy time and chain into one busy period', () => {
  const log = new EventLog(T0);
  log.start();
  log.turnStart(); log.wait(60_000); log.turnEnd();
  log.wait(2000); log.turnStart(); log.wait(58_000); log.turnEnd();
  log.wait(60_000); log.turnStart();
  const state = fold(log);
  assert.equal(state.busyMs, 118_000);
  assert.deepEqual(state.busySpans, [[T0, T0 + 60_000], [T0 + 62_000, T0 + 120_000]]);
  assert.equal(state.lastTurnEndAt, T0 + 120_000);
  assert.deepEqual(state.turn, { startedAt: T0 + 180_000, progressAt: T0 + 180_000 });
  assert.equal(state.busySince, T0 + 180_000);
  assert.equal(state.model, 'claude-sonnet-5');
  assert.equal(state.copilotVersion, '1.0.95-3');
});

test('open tools, questions and plans are tracked until they complete', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const bash = log.tool('bash', { command: 'npm test', initial_wait: 600, mode: 'sync' });
  const patch = log.tool('apply_patch', '*** Begin Patch\n*** Update File: a.txt');
  const question = log.ask('[unit=api] Ship it?', ['Yes', 'No']);
  let state = fold(log);
  assert.deepEqual([...state.openTools.keys()], [bash, patch, question]);
  assert.deepEqual(state.openTools.get(bash).args, { summary: 'bash: npm test', mode: 'sync', initialWait: 600, delay: null, timeout: null, wait: false });
  assert.equal(state.openTools.get(patch).args.summary, 'apply_patch: *** Begin Patch *** Update File: a.txt');
  assert.deepEqual(state.waits.get(question), { id: question, kind: 'question', text: '[unit=api] Ship it?', startedAt: T0 });
  log.wait(120_000); log.done(question, { result: 'Yes' });
  const plan = log.plan('Two steps');
  log.wait(30_000); log.done(plan, { result: 'Plan approved! Exited plan mode.' });
  state = fold(log);
  assert.equal(state.waits.size, 0);
  assert.equal(state.openTools.has(question), false);
  assert.equal(state.waitingMs, 150_000);
  assert.deepEqual(state.waitSpans, [[T0, T0 + 120_000, 'question'], [T0 + 120_000, T0 + 150_000, 'plan']]);
  assert.deepEqual(state.marks.map(mark => mark.kind), ['question', 'answer', 'plan-req', 'plan-ok']);
  assert.deepEqual(state.feed.map(item => item.kind), ['question', 'answer', 'plan-req', 'plan-ok']);
});

test('sub-agents run from their task call to completion, fed by their own events', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const sync = log.subagent({ name: 'reviewer', type: 'code-review', mode: 'sync', model: 'claude-opus-5', effort: 'max', agentId: 'agent-1' });
  log.wait(60_000); log.sub(sync, 'tool.execution_start', { toolCallId: 'inner-1', toolName: 'view', arguments: { path: 'a' } });
  log.wait(60_000); log.usage('claude-opus-5', { agentId: 'agent-1' });
  log.wait(60_000); log.subagentDone(sync, { durationMs: 180_000 }); log.done(sync, { result: 'done' });
  const background = log.subagent({ name: 'explorer', type: 'explore', mode: 'background', agentId: 'agent-2' });
  const state = fold(log);
  const a = state.subagents.get(sync);
  assert.deepEqual(
    { status: a.status, startedAt: a.startedAt, endedAt: a.endedAt, durationMs: a.durationMs, type: a.type, name: a.name, effort: a.effort, mode: a.mode, lastEventAt: a.lastEventAt },
    { status: 'completed', startedAt: T0, endedAt: T0 + 180_000, durationMs: 180_000, type: 'code-review', name: 'reviewer', effort: 'max', mode: 'sync', lastEventAt: T0 + 180_000 },
  );
  const b = state.subagents.get(background);
  assert.equal(b.status, 'running');
  assert.equal(b.mode, 'background');
  assert.equal(state.agentToTask.get('agent-2'), background);
  assert.deepEqual(state.turn, { startedAt: T0, progressAt: T0 + 180_000 });
  assert.deepEqual(state.feed.map(item => item.text), ['started code-review: reviewer (sync)', 'code-review reviewer finished', 'started explore: explorer']);
});

test('sub-agent prompts and model calls are not main-agent activity', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ agentId: 'agent-9' });
  log.wait(300_000);
  log.push('user.message', { content: 'sub prompt', source: 'agent-cli-1' });
  log.usage('claude-sonnet-5', { agentId: 'agent-9' });
  log.sub(call, 'assistant.message', { content: 'thinking' });
  const state = fold(log);
  assert.equal(state.lastInboundAt, null);
  assert.equal(state.turn.progressAt, T0);
  assert.equal(state.subagents.get(call).lastEventAt, T0 + 300_000);
  assert.equal(state.lastEventAt, T0 + 300_000);
});

test('a resume ends the work of the previous process at its last main event', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.tool('bash', { command: 'sleep 999' });
  log.ask('Still there?');
  const sync = log.subagent({ mode: 'sync' });
  const background = log.subagent({ mode: 'background' });
  log.wait(60_000); log.message();
  log.wait(3_600_000); log.resume();
  const state = fold(log);
  assert.equal(state.turn, null);
  assert.deepEqual(state.busySpans, [[T0, T0 + 60_000]]);
  assert.equal(state.openTools.size, 0);
  assert.equal(state.waits.size, 0);
  assert.deepEqual(state.waitSpans, [[T0, T0 + 60_000, 'question']]);
  assert.equal(state.subagents.get(sync).status, 'failed');
  assert.equal(state.subagents.get(background).status, 'failed');
  assert.equal(state.lastEventType, 'session.resume');
});

test('an abort ends the turn and sync sub-agents but keeps background ones', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const sync = log.subagent({ mode: 'sync' });
  const background = log.subagent({ mode: 'background' });
  log.wait(900_000);
  const abortId = log.abort();
  const state = fold(log);
  assert.equal(state.turn, null);
  assert.equal(state.abortAt, T0 + 900_000);
  assert.equal(state.subagents.get(sync).status, 'failed');
  assert.equal(state.subagents.get(background).status, 'running');
  assert.deepEqual(state.feed.at(-1), { at: T0 + 900_000, kind: 'abort', text: 'turn aborted', source: `cli-1/${abortId}` });
});

test('a shutdown is the last event and ends open work', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart(); log.wait(10_000); log.shutdown();
  const state = fold(log);
  assert.equal(state.shutdownAt, T0 + 10_000);
  assert.equal(state.lastEventType, 'session.shutdown');
  assert.equal(state.busyMs, 10_000);
});

test('failures, repeated calls, compactions and unattended denials are recorded', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  for (let i = 0; i < 3; i += 1) log.done(log.tool('bash', { command: 'npm test' }), { success: false });
  log.push('session.compaction_complete', { success: true });
  log.push('permission.completed', { decisionSource: 'unattended_fallback', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } });
  log.push('permission.completed', { decisionSource: 'user', result: { kind: 'denied-by-user' } });
  const state = fold(log);
  assert.equal(state.recent.failures.length, 3);
  assert.equal(new Set(state.recent.calls.map(call => call.key)).size, 1);
  assert.equal(state.recent.compactions.length, 1);
  assert.equal(state.recent.denials.length, 1);
});

test('tool calls remember which prompt they answer', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.done(log.tool('bash', { command: 'npm test' }));
  log.automationWake();
  log.done(log.tool('bash', { command: 'npm test' }));
  log.user('Status?');
  log.done(log.tool('bash', { command: 'npm test' }));
  const state = fold(log);
  assert.equal(state.prompts, 2);
  assert.deepEqual(state.recent.calls.map(call => call.prompt), [0, 1, 2]);
});

test('feed entries carry a stable source: the tool call, else the event id, else the line', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.ask('Ship it?');
  log.done(call, { result: 'yes' });
  const compaction = log.push('session.compaction_complete', { success: true });
  const state = fold(log, 'cli-x');
  assert.deepEqual(state.feed.map(item => [item.kind, item.source]), [['question', `cli-x/${call}`], ['answer', `cli-x/${call}`], ['compaction', `cli-x/${compaction}`]]);
  const bare = createSessionState('cli-y');
  applyLine(bare, JSON.stringify({ type: 'session.compaction_complete', data: {}, timestamp: new Date(T0).toISOString() }));
  assert.equal(bare.feed[0].source, 'cli-y#1');
});

test('large irrelevant lines only move the clock, and malformed lines are counted', () => {
  const state = createSessionState('cli-1');
  applyLine(state, JSON.stringify({ type: 'session.usage_checkpoint', data: { huge: 'x'.repeat(1000) }, id: 'a', timestamp: new Date(T0).toISOString(), parentId: null }));
  applyLine(state, '{"type":"assistant.turn_start",');
  assert.equal(state.lastEventAt, T0);
  assert.equal(state.lastEventType, 'session.usage_checkpoint');
  assert.equal(state.parseErrors, 1);
  assert.equal(state.lines, 2);
});

test('sub-agent history is capped, keeping running sub-agents', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const finished = [];
  for (let i = 0; i < 505; i += 1) {
    const call = log.subagent({ mode: 'sync', agentId: `agent-${i}` });
    log.subagentDone(call);
    log.done(call);
    finished.push(call);
  }
  const running = log.subagent({ mode: 'background', agentId: 'agent-running' });
  const state = fold(log);
  assert.equal(state.subagents.size, 500);
  assert.equal(state.subagents.has(finished[0]), false);
  assert.equal(state.subagents.has(finished[5]), false);
  assert.equal(state.subagents.has(finished[6]), true);
  assert.equal(state.agentToTask.has('agent-0'), false);
  assert.equal(state.agentToTask.has('agent-5'), false);
  assert.equal(state.agentToTask.has('agent-6'), true);
  assert.equal(state.subagents.get(running).status, 'running');
  assert.equal(state.agentToTask.get('agent-running'), running);
});

test('lifecycle events for an unknown tool call do not create sub-agents', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.push('subagent.started', { toolCallId: 'ghost-1', agentType: 'explore', agentDisplayName: 'ghost', executionMode: 'sync' }, { agentId: 'agent-ghost' });
  log.push('subagent.completed', { toolCallId: 'ghost-1', durationMs: 1000 }, { agentId: 'agent-ghost' });
  const state = fold(log);
  assert.equal(state.subagents.size, 0);
  assert.equal(state.agentToTask.has('agent-ghost'), false);
  assert.equal(state.feed.some(item => item.kind === 'subagent-done'), false);
});

test('tool arguments given as a JSON string are read like an object', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.tool('task', JSON.stringify({ name: 'helper', agent_type: 'explore', mode: 'background', description: 'Look around' }));
  const plain = log.tool('bash', 'echo hi');
  const state = fold(log);
  const sub = state.subagents.get(call);
  assert.deepEqual({ name: sub.name, type: sub.type, mode: sub.mode }, { name: 'helper', type: 'explore', mode: 'background' });
  assert.equal(state.openTools.get(plain).args.summary, 'bash: echo hi');
});

test('running sub-agents are capped too, and eviction leaves the run totals alone', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const calls = [];
  for (let i = 0; i < 510; i += 1) calls.push(log.subagent({ mode: 'background', type: i % 2 ? 'explore' : 'code-review', agentId: `agent-${i}` }));
  const state = fold(log);
  assert.equal(state.subagents.size, 500);
  assert.equal(state.subagentCount, 510);
  assert.equal(state.subagents.has(calls[0]), false);
  assert.equal(state.subagents.has(calls[10]), true);
  assert.equal(state.agentToTask.has('agent-0'), false);
  assert.deepEqual([...state.subagentStats].map(([type, entry]) => [type, entry.runs]).sort(), [['code-review', 255], ['explore', 255]]);
  assert.equal(state.subagentIndex.get(calls[0]), 'code-review');
});

test('finished sub-agents add their duration to the per-type totals once, and eviction keeps it', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  for (let i = 0; i < 505; i += 1) {
    const call = log.subagent({ mode: 'sync', type: 'explore', agentId: `agent-${i}` });
    log.subagentDone(call, { durationMs: 1000 });
    log.done(call);
  }
  const state = fold(log);
  assert.equal(state.subagents.size, 500);
  assert.deepEqual(state.subagentStats.get('explore'), { runs: 505, durationMs: 505_000 });
  assert.equal(state.subagentCount, 505);
});

test('distinct sub-agent types beyond the limit are counted under other', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  for (let i = 0; i < LIMITS.subagentTypes + 5; i += 1) log.subagentDone(log.subagent({ mode: 'sync', type: `type-${i}` }), { durationMs: 10 });
  const state = fold(log);
  assert.equal(state.subagentStats.size, LIMITS.subagentTypes + 1);
  assert.deepEqual(state.subagentStats.get('other'), { runs: 5, durationMs: 50 });
});

test('a sub-agent whose start event names another type leaves no empty type behind', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.tool('task', { name: 'helper', mode: 'sync', description: 'no type given' });
  log.push('subagent.started', { toolCallId: call, agentType: 'explore', agentDisplayName: 'helper', executionMode: 'sync' }, { agentId: 'agent-1' });
  log.subagentDone(call, { durationMs: 2000 });
  const state = fold(log);
  assert.deepEqual([...state.subagentStats], [['explore', { runs: 1, durationMs: 2000 }]]);
  assert.equal(state.subagentIndex.get(call), 'explore');
  assert.equal(state.subagentCount, 1);
});

test('a repeated start event for one task call counts the sub-agent once', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.tool('task', { name: 'helper', agent_type: 'explore', mode: 'background', description: 'first' });
  log.push('tool.execution_start', { toolCallId: call, toolName: 'task', arguments: { name: 'helper', agent_type: 'explore', mode: 'background', description: 'second' } });
  const state = fold(log);
  assert.equal(state.subagentCount, 1);
  assert.deepEqual([...state.subagentStats], [['explore', { runs: 1, durationMs: 0 }]]);
  assert.equal(state.subagentIndex.size, 1);
  assert.equal(state.subagents.size, 1);
  assert.equal(state.subagents.get(call).task, 'second');
  assert.equal(state.subagents.get(call).launchedAt, T0);
});

test('a repeated start event for a task call that left the detail list changes nothing', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const first = log.subagent({ mode: 'sync', type: 'explore' });
  log.subagentDone(first, { durationMs: 10 });
  for (let i = 0; i < 505; i += 1) log.subagentDone(log.subagent({ mode: 'sync', type: 'explore' }), { durationMs: 10 });
  const before = fold(log);
  assert.equal(before.subagents.has(first), false);
  const view = state => JSON.stringify({
    count: state.subagentCount, stats: [...state.subagentStats], index: state.subagentIndex.get(first), details: [...state.subagents.keys()],
    feed: state.feed, openTools: [...state.openTools.keys()],
  });
  log.push('tool.execution_start', { toolCallId: first, toolName: 'task', arguments: { name: 'helper', agent_type: 'research', mode: 'background' } });
  const after = fold(log);
  assert.equal(after.subagents.has(first), false);
  assert.equal(after.subagentCount, 506);
  assert.deepEqual([...after.subagentStats], [['explore', { runs: 506, durationMs: 5060 }]]);
  assert.equal(after.subagentIndex.get(first), 'explore');
  assert.equal(view(after), view(before));
});

test('a repeated start for a sub-agent still in the details adds no second feed entry', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.tool('task', { name: 'helper', agent_type: 'explore', mode: 'background' });
  log.push('tool.execution_start', { toolCallId: call, toolName: 'task', arguments: { name: 'helper', agent_type: 'explore', mode: 'background' } });
  assert.equal(fold(log).feed.filter(item => item.kind === 'subagent-start').length, 1);
});

test('merged states add up the sub-agent totals and keep the task index', () => {
  const make = (id, type, count) => {
    const log = new EventLog(T0);
    log.calls = id.charCodeAt(id.length - 1) * 100;
    log.start(); log.turnStart();
    for (let i = 0; i < count; i += 1) log.subagentDone(log.subagent({ mode: 'sync', type }), { durationMs: 100 });
    return fold(log, id);
  };
  const merged = mergeStates([make('cli-a', 'explore', 2), make('cli-b', 'explore', 3), make('cli-c', 'research', 1)]);
  assert.equal(merged.subagentCount, 6);
  assert.deepEqual(merged.subagentStats.get('explore'), { runs: 5, durationMs: 500 });
  assert.deepEqual(merged.subagentStats.get('research'), { runs: 1, durationMs: 100 });
  assert.equal(merged.subagentIndex.size, 6);
  assert.equal(merged.subagentIndex.get('call-9701'), 'explore');
});
