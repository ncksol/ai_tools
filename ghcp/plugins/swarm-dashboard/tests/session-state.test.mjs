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

test('sub-agents evicted while running still add their runtime when they finish', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const calls = [];
  for (let i = 0; i < 510; i += 1) calls.push(log.subagent({ mode: 'background', type: 'explore', agentId: `agent-${i}` }));
  for (const call of calls) log.subagentDone(call, { durationMs: 1000 });
  const state = fold(log);
  assert.equal(state.subagents.size, 500);
  assert.equal(state.subagentCount, 510);
  assert.deepEqual(state.subagentStats.get('explore'), { runs: 510, durationMs: 510_000 });
  assert.equal(state.evictedRunning.size, 0, 'no record is kept once the sub-agent has finished');
  assert.equal(state.subagents.has(calls[0]), false, 'details are never restored');
});

test('an evicted running sub-agent finishes through its task call, a failure or the end of the process', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const syncCalls = [];
  const sync = log.tool('task', { name: 'one', agent_type: 'explore', mode: 'sync' });
  syncCalls.push(sync);
  const background = [];
  for (let i = 0; i < 505; i += 1) background.push(log.subagent({ mode: 'background', type: 'research' }));
  assert.equal(fold(log).subagents.has(sync), false);
  log.wait(5000);
  log.done(sync, { success: true });
  log.subagentDone(background[0], { failed: true, durationMs: 2000 });
  log.shutdown();
  const state = fold(log);
  assert.deepEqual(state.subagentStats.get('explore'), { runs: 1, durationMs: 5000 });
  assert.equal(state.evictedRunning.size, 0);
  // background[0] failed with its own duration (2000); the four other evicted records and the 500 retained ones end with the
  // process, 5000 ms after they were launched
  assert.equal(state.subagentStats.get('research').durationMs, 2000 + 4 * 5000 + 500 * 5000);
  assert.equal(state.subagentStats.get('research').runs, 505);
});

test('a repeated start for an evicted running sub-agent stays ignored and keeps its record', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const calls = [];
  for (let i = 0; i < 502; i += 1) calls.push(log.subagent({ mode: 'background', type: 'explore' }));
  log.push('tool.execution_start', { toolCallId: calls[0], toolName: 'task', arguments: { name: 'again', agent_type: 'research', mode: 'background' } });
  const state = fold(log);
  assert.equal(state.subagentCount, 502);
  assert.equal(state.subagents.has(calls[0]), false);
  assert.equal(state.evictedRunning.has(calls[0]), true);
  assert.deepEqual([...state.subagentStats.keys()], ['explore']);
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

// --- Sub-agent units: a root state follows each one-off sub-agent in detail ---

const ROOT = { subagentUnits: true };
const foldRoot = (log, id = 'cli-1') => fold(log, id, ROOT);
const unitOf = (state, id) => state.subagents.get(id).unit;
const subagentItems = state => state.feed.filter(item => item.kind.startsWith('subagent'));

test('the new sub-agent limits are fixed', () => {
  assert.deepEqual(
    { runs: LIMITS.subagentRuns, feed: LIMITS.subagentFeed, openTools: LIMITS.subagentOpenTools, children: LIMITS.subagentChildren },
    { runs: 50, feed: 8, openTools: 50, children: 100 },
  );
});

test('a root state follows a background sub-agent: one run, its last message, open tools and its own feed', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.wait(1000);
  const call = log.subagent({ name: 'scout', type: 'explore', mode: 'background', agentId: 'agent-s' });
  log.wait(1000); log.toAgent('agent-s', 'the prompt');
  log.sub(call, 'assistant.turn_start');
  log.wait(1000);
  log.sub(call, 'tool.execution_start', { toolCallId: 'inner-1', toolName: 'grep', arguments: { pattern: 'needle' } });
  log.sub(call, 'tool.execution_start', { toolCallId: 'inner-2', toolName: 'view', arguments: { path: 'a.txt' } });
  const during = unitOf(foldRoot(log), call);
  assert.equal(during.turnOpen, true);
  assert.deepEqual([...during.openTools.values()].map(tool => [tool.id, tool.name, tool.startedAt, tool.args.summary]),
    [['inner-1', 'grep', T0 + 3000, 'grep: needle'], ['inner-2', 'view', T0 + 3000, 'view: a.txt']]);
  assert.deepEqual(during.runs, [[T0 + 1000, null]], 'the prompt at its start is not a follow-up');
  assert.equal(during.lastMessage, null);

  log.wait(1000); log.sub(call, 'tool.execution_complete', { toolCallId: 'inner-1', success: true });
  log.wait(1000); log.sub(call, 'tool.execution_complete', { toolCallId: 'inner-2', success: true });
  log.sub(call, 'assistant.message', { content: 'first answer' });
  log.wait(1000); log.sub(call, 'assistant.message', { content: `final answer\n${'x'.repeat(5000)}` });
  log.wait(1000); log.sub(call, 'assistant.message', { content: '  \n ' });
  log.sub(call, 'assistant.turn_end');
  log.subagentDone(call, { durationMs: 6000, agentId: 'agent-s' });
  const state = foldRoot(log);
  const sub = state.subagents.get(call);
  const unit = sub.unit;
  assert.deepEqual({ status: sub.status, startedAt: sub.startedAt, endedAt: sub.endedAt, durationMs: sub.durationMs }, { status: 'completed', startedAt: T0 + 1000, endedAt: T0 + 7000, durationMs: 6000 });
  assert.deepEqual(unit.runs, [[T0 + 1000, T0 + 7000]]);
  assert.equal(unit.taskName, 'scout');
  assert.equal(unit.openTools.size, 0);
  assert.equal(unit.turnOpen, false);
  assert.equal(unit.lastTurnEndAt, T0 + 7000);
  assert.equal(unit.firstFinishAt, T0 + 7000);
  assert.equal(unit.error, null);
  assert.equal(unit.lastMessage.at, T0 + 6000);
  assert.equal(unit.lastMessage.text.length, 4000);
  assert.ok(unit.lastMessage.text.startsWith('final answer\nxxx'));
  assert.deepEqual(unit.feed, [
    { at: T0 + 1000, kind: 'subagent-start', text: 'started explore: scout', source: `cli-1/${call}` },
    { at: T0 + 7000, kind: 'subagent-done', text: 'completed explore: scout', source: `cli-1/${call}` },
  ]);
  assert.deepEqual(subagentItems(state), [], 'a root state keeps these items out of the session feed');
  assert.deepEqual(state.subagentOutcomes, { completed: 1, failed: 0, cancelled: 0 });
  assert.equal(fold(log).subagents.get(call).unit, undefined, 'a non-root state keeps no unit');
  assert.equal(subagentItems(fold(log)).length, 2);
});

test('a follow-up message opens a run, its turn end closes it, and a later turn start reopens it', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ name: 'scout', type: 'explore', mode: 'background', agentId: 'agent-s' });
  log.wait(1000); log.toAgent('agent-s', 'first prompt');
  log.wait(1000); log.sub(call, 'assistant.turn_start');
  log.wait(1000); log.sub(call, 'assistant.turn_end');
  assert.deepEqual(unitOf(foldRoot(log), call).runs, [[T0, null]], 'a turn end before the first finish does not end the first run');
  log.wait(1000); log.subagentDone(call, { durationMs: 4000, agentId: 'agent-s' });
  assert.deepEqual(unitOf(foldRoot(log), call).runs, [[T0, T0 + 4000]]);
  log.wait(60_000);
  const followUp = log.toAgent('agent-s', 'one more thing');
  let unit = unitOf(foldRoot(log), call);
  assert.deepEqual(unit.runs, [[T0, T0 + 4000], [T0 + 64_000, null]]);
  assert.deepEqual(unit.feed.at(-1), { at: T0 + 64_000, kind: 'subagent-start', text: 'resumed explore: scout', source: `cli-1/${followUp}` });
  log.wait(1000); log.sub(call, 'assistant.turn_start');
  assert.deepEqual(unitOf(foldRoot(log), call).runs.at(-1), [T0 + 64_000, null]);
  log.wait(1000); log.sub(call, 'assistant.turn_end');
  unit = unitOf(foldRoot(log), call);
  assert.deepEqual(unit.runs, [[T0, T0 + 4000], [T0 + 64_000, T0 + 66_000]]);
  assert.equal(unit.lastTurnEndAt, T0 + 66_000);
  assert.equal(unit.turnOpen, false);
  log.wait(1000); log.sub(call, 'assistant.turn_start');
  unit = unitOf(foldRoot(log), call);
  assert.deepEqual(unit.runs.at(-1), [T0 + 64_000, null]);
  assert.equal(unit.turnOpen, true);
  log.wait(1000); log.sub(call, 'assistant.turn_end');
  const state = foldRoot(log);
  assert.deepEqual(unitOf(state, call).runs, [[T0, T0 + 4000], [T0 + 64_000, T0 + 68_000]]);
  assert.equal(unitOf(state, call).firstFinishAt, T0 + 4000);
  assert.equal(state.subagents.get(call).status, 'completed');
  assert.deepEqual(state.subagentOutcomes, { completed: 1, failed: 0, cancelled: 0 });
  assert.equal(unitOf(state, call).feed.filter(item => item.text.startsWith('resumed')).length, 1);
  log.toAgent('agent-unknown', 'nobody');
  assert.equal(unitOf(foldRoot(log), call).runs.length, 2, 'a message to an unknown agent opens no run');
});

test('a failed and a cancelled sub-agent keep their status, error and feed text; a chip in a non-root state says cancelled', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const failed = log.subagent({ name: 'f', type: 'explore', mode: 'background', agentId: 'agent-f' });
  const cancelled = log.subagent({ name: 'c', type: 'explore', mode: 'background', agentId: 'agent-c' });
  const finished = log.subagent({ name: 'd', type: 'explore', mode: 'background', agentId: 'agent-d' });
  log.wait(30_000); log.subagentDone(failed, { failed: true, durationMs: 30_000, error: `Model quota exceeded\n${'retry later '.repeat(40)}` });
  log.wait(1000); log.subagentDone(cancelled, { cancelled: true, durationMs: 31_000 });
  log.wait(1000); log.subagentDone(finished, { durationMs: 32_000 });
  const state = foldRoot(log);
  const f = state.subagents.get(failed);
  assert.equal(f.status, 'failed');
  assert.ok(f.unit.error.startsWith('Model quota exceeded retry later'));
  assert.ok(f.unit.error.length <= 200);
  assert.deepEqual(f.unit.runs, [[T0, T0 + 30_000]]);
  assert.equal(f.unit.feed.at(-1).text, 'failed explore: f');
  const c = state.subagents.get(cancelled);
  assert.equal(c.status, 'cancelled');
  assert.equal(c.unit.error, null);
  assert.deepEqual(c.unit.runs, [[T0, T0 + 31_000]]);
  assert.equal(c.unit.feed.at(-1).text, 'cancelled explore: c');
  assert.equal(state.subagents.get(finished).status, 'completed');
  assert.deepEqual(state.subagentOutcomes, { completed: 1, failed: 1, cancelled: 1 });
  const plain = fold(log);
  assert.equal(plain.subagents.get(cancelled).status, 'cancelled');
  assert.deepEqual(subagentItems(plain).filter(item => item.kind === 'subagent-done').map(item => item.text),
    ['explore f failed', 'explore c cancelled', 'explore d finished']);
  assert.deepEqual(plain.subagentOutcomes, { completed: 1, failed: 1, cancelled: 1 });
});

test('a sub-agent that starts sub-agents registers them, counts them once, and is kept alive by their events', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const parent = log.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: 'agent-l' });
  log.wait(60_000);
  const child = log.nested(parent, { name: 'helper', type: 'explore', mode: 'sync', agentId: 'agent-c' });
  log.wait(60_000);
  const grand = log.nested(child, { name: 'deep', type: 'explore', mode: 'background', agentId: 'agent-g' });
  let state = foldRoot(log);
  assert.deepEqual([...state.descendants].map(([id, entry]) => [id, entry.root, entry.parent]), [[child, parent, parent], [grand, parent, child]]);
  assert.equal(state.subagents.size, 1);
  assert.equal(state.subagentCount, 3);
  assert.deepEqual([...state.subagentStats].map(([type, entry]) => [type, entry.runs]).sort(), [['explore', 2], ['general-purpose', 1]]);
  assert.equal(state.subagentIndex.get(child), 'explore');
  assert.equal(state.subagentIndex.get(grand), 'explore');
  assert.equal(state.agentToTask.get('agent-g'), grand);
  let unit = unitOf(state, parent);
  assert.deepEqual(unit.children.map(sub => [sub.id, sub.name, sub.type, sub.mode, sub.status, sub.unit]), [[child, 'helper', 'explore', 'sync', 'running', undefined]]);
  assert.deepEqual([...unit.openTools.keys()], [child], 'a sync child shows as its parent\'s open tool');
  assert.deepEqual(unit.feed.map(item => item.text), ['started general-purpose: lead', 'started explore: helper (sync)']);
  assert.equal(state.subagents.get(parent).lastEventAt, T0 + 120_000);

  log.wait(30_000); log.sub(child, 'assistant.message', { content: 'x' });
  assert.equal(foldRoot(log).subagents.get(parent).lastEventAt, T0 + 150_000);
  log.wait(30_000); log.sub(grand, 'assistant.message', { content: 'y' });
  state = foldRoot(log);
  assert.equal(state.subagents.get(parent).lastEventAt, T0 + 180_000);
  assert.equal(state.descendants.get(child).sub.lastEventAt, T0 + 180_000);
  log.wait(10_000); log.push('session.usage_record', { usage: { model: 'claude-sonnet-5' } }, { agentId: 'agent-g' });
  state = foldRoot(log);
  assert.equal(state.subagents.get(parent).lastEventAt, T0 + 190_000);
  assert.equal(state.descendants.get(grand).sub.lastEventAt, T0 + 190_000);

  log.wait(1000); log.subagentDone(child, { durationMs: 90_000, agentId: 'agent-c' });
  state = foldRoot(log);
  const finishedChild = state.descendants.get(child).sub;
  assert.deepEqual({ status: finishedChild.status, endedAt: finishedChild.endedAt, durationMs: finishedChild.durationMs }, { status: 'completed', endedAt: T0 + 191_000, durationMs: 90_000 });
  unit = unitOf(state, parent);
  assert.deepEqual(unit.feed.at(-1), { at: T0 + 191_000, kind: 'subagent-done', text: 'completed explore: helper', source: `cli-1/${child}` });
  assert.deepEqual(unit.feed.map(item => item.text), ['started general-purpose: lead', 'started explore: helper (sync)', 'completed explore: helper']);
  assert.equal(state.subagentStats.get('explore').durationMs, 90_000);
  log.wait(1000); log.sub(parent, 'tool.execution_complete', { toolCallId: child, success: true });
  log.subagentDone(child, { durationMs: 99_000, agentId: 'agent-c' });
  state = foldRoot(log);
  assert.equal(unitOf(state, parent).openTools.size, 0);
  assert.equal(state.subagentStats.get('explore').durationMs, 90_000, 'a duration is added once');
  assert.equal(state.subagentCount, 3);
  assert.deepEqual(state.subagentOutcomes, { completed: 0, failed: 0, cancelled: 0 }, 'only the root\'s own sub-agents count in the outcomes');

  log.wait(1000); log.subagentDone(grand, { durationMs: 5000, failed: true, agentId: 'agent-g' });
  state = foldRoot(log);
  assert.equal(state.descendants.get(grand).sub.status, 'failed');
  assert.equal(state.subagentStats.get('explore').durationMs, 95_000);
  assert.equal(unitOf(state, parent).feed.length, 3, 'a grandchild adds nothing to the unit feed');
  assert.equal(state.subagents.get(parent).status, 'running');
});

test('a nested sub-agent finishes through its task call when it has no lifecycle events, and an unknown parent registers nothing', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const parent = log.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: 'agent-l' });
  const args = { name: 'n', agent_type: 'explore', mode: 'sync', description: 'quiet one' };
  log.sub(parent, 'tool.execution_start', { toolCallId: 'quiet-1', toolName: 'task', arguments: args });
  log.sub(parent, 'tool.execution_start', { toolCallId: 'quiet-2', toolName: 'task', arguments: args });
  log.push('tool.execution_start', { toolCallId: 'ghost-1', toolName: 'task', arguments: args, parentToolCallId: 'ghost-parent' });
  log.wait(5000);
  log.sub(parent, 'tool.execution_complete', { toolCallId: 'quiet-1', success: true });
  log.sub(parent, 'tool.execution_complete', { toolCallId: 'quiet-2', success: false });
  const state = foldRoot(log);
  assert.equal(state.descendants.get('quiet-1').sub.status, 'completed');
  assert.equal(state.descendants.get('quiet-1').sub.durationMs, 5000);
  assert.equal(state.descendants.get('quiet-2').sub.status, 'failed');
  assert.equal(state.descendants.has('ghost-1'), false);
  assert.equal(state.subagentCount, 3);
  assert.deepEqual(unitOf(state, parent).children.map(sub => sub.status), ['completed', 'failed']);
  assert.deepEqual(unitOf(state, parent).feed.map(item => item.text).slice(1), ['started explore: n (sync)', 'started explore: n (sync)', 'completed explore: n', 'failed explore: n']);
});

test('a non-root state registers nested sub-agents too, with no unit and no extra session feed items', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const parent = log.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: 'agent-l' });
  log.wait(60_000);
  const child = log.nested(parent, { name: 'helper', type: 'explore', mode: 'sync', agentId: 'agent-c' });
  log.wait(60_000); log.sub(child, 'assistant.message', { content: 'x' });
  log.wait(1000); log.subagentDone(child, { durationMs: 7000, agentId: 'agent-c' });
  const state = fold(log);
  assert.equal(state.descendants.size, 1);
  assert.equal(state.subagentCount, 2);
  assert.equal(state.subagentStats.get('explore').runs, 1);
  assert.equal(state.subagentStats.get('explore').durationMs, 7000);
  assert.equal(state.subagents.get(parent).lastEventAt, T0 + 121_000);
  assert.equal(state.subagents.get(parent).unit, undefined);
  assert.deepEqual(state.feed.map(item => item.text), ['started general-purpose: lead']);
});

test('subagent.configured sets the effort and model through the tool call or the agent id', () => {
  for (const options of [undefined, ROOT]) {
    const log = new EventLog(T0);
    log.start(); log.turnStart();
    const byAgent = log.subagent({ name: 'a', type: 'explore', mode: 'background', agentId: 'agent-a' });
    const byCall = log.subagent({ name: 'b', type: 'explore', mode: 'background', agentId: 'agent-b' });
    log.wait(1000); log.push('subagent.configured', { model: 'claude-opus-5', reasoningEffort: 'max' }, { agentId: 'agent-a' });
    log.wait(1000); log.push('subagent.configured', { toolCallId: byCall, model: 'gpt-5.5', reasoningEffort: 'low' });
    log.push('subagent.configured', { model: 'ignored' }, { agentId: 'agent-unknown' });
    const state = fold(log, 'cli-1', options);
    const a = state.subagents.get(byAgent);
    assert.deepEqual([a.model, a.effort, a.lastEventAt], ['claude-opus-5', 'max', T0 + 1000]);
    const b = state.subagents.get(byCall);
    assert.deepEqual([b.model, b.effort], ['gpt-5.5', 'low']);
    assert.equal(state.subagents.size, 2);
  }
});

test('an abort stops the sync sub-agents and their runs; the end of the process stops everything left', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const sync = log.subagent({ name: 's', type: 'explore', mode: 'sync', agentId: 'agent-s' });
  const background = log.subagent({ name: 'b', type: 'explore', mode: 'background', agentId: 'agent-b' });
  const lead = log.subagent({ name: 'l', type: 'explore', mode: 'background', agentId: 'agent-l' });
  const syncChild = log.nested(sync, { name: 'sc', type: 'explore', mode: 'sync' });
  const leadChild = log.nested(lead, { name: 'lc', type: 'explore', mode: 'sync' });
  const done = log.subagent({ name: 'd', type: 'explore', mode: 'background', agentId: 'agent-d' });
  log.wait(1000); log.subagentDone(done, { durationMs: 1000, agentId: 'agent-d' });
  log.wait(1000); log.toAgent('agent-d', 'again');
  log.wait(898_000);
  log.abort();
  let state = foldRoot(log);
  const aborted = state.subagents.get(sync);
  assert.equal(aborted.status, 'failed');
  assert.equal(aborted.unit.error, 'Stopped when the orchestrator\'s turn was aborted.');
  assert.deepEqual(aborted.unit.runs, [[T0, T0 + 900_000]]);
  assert.deepEqual(aborted.unit.feed.find(item => item.kind === 'subagent-done'), { at: T0 + 900_000, kind: 'subagent-done', text: 'failed explore: s', source: `cli-1/${sync}` });
  assert.equal(aborted.unit.feed.at(-1).text, 'failed explore: sc', 'then its sync child');
  assert.equal(aborted.unit.openTools.size, 0);
  assert.equal(state.descendants.get(syncChild).sub.status, 'failed', 'its sync child stops with it');
  assert.equal(state.descendants.get(leadChild).sub.status, 'running', 'a child of a sub-agent that keeps running goes on');
  assert.equal(state.subagents.get(background).status, 'running');
  assert.equal(state.subagents.get(background).unit.error, null);
  assert.deepEqual(state.subagents.get(background).unit.runs, [[T0, null]]);
  assert.deepEqual(state.subagents.get(done).unit.runs, [[T0, T0 + 1000], [T0 + 2000, null]], 'an abort keeps the follow-up run of a background one');

  log.wait(1000); log.shutdown();
  state = foldRoot(log);
  const ended = state.subagents.get(background);
  assert.equal(ended.status, 'failed');
  assert.equal(ended.unit.error, 'Stopped when the orchestrator\'s process ended.');
  assert.deepEqual(ended.unit.runs, [[T0, T0 + 901_000]]);
  assert.equal(ended.unit.feed.at(-1).text, 'failed explore: b');
  assert.deepEqual(state.subagents.get(done).unit.runs, [[T0, T0 + 1000], [T0 + 2000, T0 + 901_000]]);
  assert.equal(state.subagents.get(done).status, 'completed');
  assert.equal(state.subagents.get(done).unit.error, null);
  assert.equal(state.descendants.get(leadChild).sub.status, 'failed');
  assert.equal(state.subagents.get(sync).unit.error, 'Stopped when the orchestrator\'s turn was aborted.', 'an earlier stop keeps its text');
  assert.deepEqual(state.subagentOutcomes, { completed: 1, failed: 3, cancelled: 0 });
});

test('the runs, unit feed, open tools and children of a sub-agent stay at their limits', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ name: 'busy', type: 'explore', mode: 'background', agentId: 'agent-b' });
  log.wait(1000); log.subagentDone(call, { durationMs: 1000, agentId: 'agent-b' });
  for (let i = 0; i < 60; i += 1) {
    log.wait(1000); log.toAgent('agent-b', `follow-up ${i}`);
    log.wait(1000); log.sub(call, 'assistant.turn_end');
  }
  for (let i = 0; i < 105; i += 1) log.nested(call, { name: `kid-${i}`, type: 'explore', mode: 'background', agentId: `agent-kid-${i}` });
  for (let i = 0; i < 60; i += 1) log.sub(call, 'tool.execution_start', { toolCallId: `inner-${i}`, toolName: 'view', arguments: { path: `f${i}` } });
  const state = foldRoot(log);
  const unit = unitOf(state, call);
  assert.equal(unit.runs.length, LIMITS.subagentRuns);
  assert.deepEqual(unit.runs.at(-1), [T0 + 1000 + 60 * 2000 - 1000, T0 + 1000 + 60 * 2000]);
  assert.equal(unit.feed.length, LIMITS.subagentFeed);
  assert.equal(unit.feed.at(-1).text, 'started explore: kid-104');
  assert.equal(unit.openTools.size, LIMITS.subagentOpenTools);
  assert.equal(unit.openTools.has('inner-0'), false);
  assert.equal(unit.openTools.has('inner-10'), true);
  assert.equal(unit.children.length, LIMITS.subagentChildren);
  assert.equal(unit.children[0].name, 'kid-5');
  assert.equal(state.descendants.size, 105);
  assert.equal(state.subagentCount, 106);
});

test('known nested sub-agents are bounded by the task index, and a dropped one loses its agent id mapping', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ name: 'lead', type: 'explore', mode: 'background', agentId: 'agent-lead' });
  const kids = [];
  for (let i = 0; i < LIMITS.subagentIndex + 5; i += 1) kids.push(log.nested(call, { name: 'kid', type: 'explore', mode: 'background', agentId: `agent-${i}` }));
  const state = foldRoot(log);
  assert.equal(state.descendants.size, LIMITS.subagentIndex);
  assert.equal(state.descendants.has(kids[0]), false);
  assert.equal(state.descendants.has(kids[5]), true);
  assert.equal(state.agentToTask.has('agent-0'), false);
  assert.equal(state.agentToTask.has('agent-5'), true);
  assert.equal(state.agentToTask.size, LIMITS.subagentIndex + 1);
  assert.equal(state.subagentCount, LIMITS.subagentIndex + 6);
});

test('outcomes count sub-agents that were evicted from the details when they finish', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const calls = [];
  for (let i = 0; i < 505; i += 1) calls.push(log.subagent({ mode: 'background', type: 'explore', agentId: `agent-${i}` }));
  for (let i = 0; i < 505; i += 1) {
    if (i < 3) log.subagentDone(calls[i], { cancelled: true });
    else if (i === 3) log.subagentDone(calls[i], { failed: true });
    else log.subagentDone(calls[i]);
  }
  const state = foldRoot(log);
  assert.equal(state.subagents.size, 500);
  assert.deepEqual(state.subagentOutcomes, { completed: 501, failed: 1, cancelled: 3 });
});

test('merged states add up their descendants and outcomes', () => {
  const make = (id, base, kids) => {
    const log = new EventLog(T0);
    log.calls = base;
    log.start(); log.turnStart();
    const call = log.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: `${id}-lead` });
    for (let i = 0; i < kids; i += 1) log.nested(call, { name: `kid-${i}`, type: 'explore', mode: 'background', agentId: `${id}-kid-${i}` });
    log.subagentDone(call, { durationMs: 10, agentId: `${id}-lead` });
    return fold(log, id, ROOT);
  };
  const a = make('cli-a', 100, 2);
  const b = make('cli-b', 200, 3);
  const merged = mergeStates([a, b]);
  assert.equal(merged.descendants.size, 5);
  assert.equal(merged.descendants.get('call-102').root, 'call-101');
  assert.equal(merged.descendants.get('call-203').root, 'call-201');
  assert.deepEqual(merged.subagentOutcomes, { completed: 2, failed: 0, cancelled: 0 });
  assert.equal(merged.subagentCount, 7);
  assert.equal(merged.subagents.get('call-101').unit.children.length, 2);
});
