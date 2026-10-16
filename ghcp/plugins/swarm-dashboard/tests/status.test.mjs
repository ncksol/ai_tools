import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { STATUS_DETAILS } from '../engine/schema.mjs';
import { busyWindowStart, displayOf, evaluateStatus, evaluateSubagentUnit, swarmStalled, toolLimitMs } from '../engine/model/status.mjs';
import { MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const t = DEFAULT_THRESHOLDS;
const evaluate = (state, now, extra = {}) => evaluateStatus({
  state, alive: true, archivedAt: null, merged: false, mergedAt: null, outcome: null, hasRegistry: false, report: null,
  parentRepliedAt: null, monitorDueAt: null, isRunningFlag: false, startedAt: T0, now, thresholds: t, ...extra,
});
function busyLog() {
  const log = new EventLog(T0);
  log.start();
  log.turnStart();
  return log;
}

test('every status detail maps to a colour and a header bucket', () => {
  for (const detail of STATUS_DETAILS) assert.ok(displayOf(detail).status && displayOf(detail).bucket, detail);
  assert.deepEqual(displayOf('slow_model_call'), { status: 'busy', bucket: 'working' });
  assert.deepEqual(displayOf('stalled'), { status: 'stuck', bucket: 'stuck' });
  assert.deepEqual(displayOf('blocked_on_orchestrator'), { status: 'blocked', bucket: 'waiting' });
  assert.deepEqual(displayOf('crashed'), { status: 'blocked', bucket: 'failed' });
  assert.deepEqual(displayOf('stopped'), { status: 'idle', bucket: 'idle' });
  assert.deepEqual(displayOf('archived'), { status: 'archived', bucket: 'done' });
  assert.deepEqual(displayOf('completed'), { status: 'done', bucket: 'done' });
  assert.deepEqual(displayOf('cancelled'), { status: 'blocked', bucket: 'failed' });
});

test('ended states come first: archived, failed, merged, stopped, crashed', () => {
  const state = fold(busyLog());
  assert.equal(evaluate(state, T0 + MINUTE, { archivedAt: T0 + 1 }).detail, 'archived');
  assert.equal(evaluate(state, T0 + MINUTE, { outcome: 'failed' }).detail, 'failed');
  const idle = busyLog(); idle.wait(MINUTE); idle.turnEnd();
  assert.equal(evaluate(fold(idle), T0 + 2 * MINUTE, { merged: true, mergedAt: T0 + 30_000 }).detail, 'merged');
  assert.equal(evaluate(state, T0 + MINUTE, { merged: true }).detail, 'busy');
  const stopped = busyLog(); stopped.wait(MINUTE); stopped.shutdown();
  assert.equal(evaluate(fold(stopped), T0 + 2 * MINUTE, { alive: false }).detail, 'stopped');
  const crashed = evaluate(state, T0 + 2 * MINUTE, { alive: false });
  assert.equal(crashed.detail, 'crashed');
  assert.equal(crashed.reason, 'The session process ended without a shutdown event while it was working.');
});

test('an open question or plan is waiting, never stuck, however long it lasts', () => {
  const log = busyLog();
  log.ask('Approve?');
  const result = evaluate(fold(log), T0 + 29 * MINUTE);
  assert.equal(result.detail, 'waiting_question');
  assert.equal(result.since, T0);
  const plan = busyLog();
  plan.plan('Steps');
  assert.equal(evaluate(fold(plan), T0 + 60 * MINUTE).detail, 'waiting_plan');
});

test('a tool past its limit is stuck, and the reason names the rule and its numbers', () => {
  const log = busyLog();
  log.tool('bash', { command: 'dotnet test --filter E2E', initial_wait: 600 });
  const state = fold(log);
  assert.equal(evaluate(state, T0 + 14 * MINUTE).detail, 'busy');
  const stuck = evaluate(state, T0 + 48 * MINUTE);
  assert.equal(stuck.detail, 'stuck_tool');
  assert.equal(stuck.since, T0);
  assert.equal(stuck.reason, 'bash has run for 48 min with a limit of 15 min (initial_wait 10 min + 5 min).');
  assert.deepEqual(stuck.tool, { id: 'call-1', name: 'bash', summary: 'bash: dotnet test --filter E2E', startedAt: T0, limitMs: 15 * MINUTE });
  const plain = busyLog();
  plain.tool('bash', { command: 'sleep 1000' });
  assert.equal(evaluate(fold(plain), T0 + 11 * MINUTE).detail, 'stuck_tool');
  const view = busyLog();
  view.tool('view', { path: 'a.txt' });
  assert.equal(evaluate(fold(view), T0 + 3 * MINUTE).detail, 'stuck_tool');
});

test('tool limits follow the design call', () => {
  const limit = (name, args) => toolLimitMs({ name, args: { initialWait: null, delay: null, timeout: null, wait: false, mode: null, ...args } }, t);
  assert.equal(limit('bash', { initialWait: 600 }), 15 * MINUTE);
  assert.equal(limit('bash', {}), 10 * MINUTE);
  assert.equal(limit('read_bash', { delay: 60 }), 3 * MINUTE);
  assert.equal(limit('read_agent', { timeout: 180 }), 5 * MINUTE);
  assert.equal(limit('create_session', {}), 2 * MINUTE);
  assert.equal(limit('grep', {}), 2 * MINUTE);
  assert.equal(limit('task', {}), null);
  assert.equal(limit('web_fetch', {}), null);
});

test('a sub-agent silent past its limit makes the session stuck', () => {
  const log = busyLog();
  log.subagent({ name: 'reviewer', type: 'code-review' });
  const state = fold(log);
  assert.equal(evaluate(state, T0 + 9 * MINUTE).detail, 'busy');
  const stuck = evaluate(state, T0 + 11 * MINUTE);
  assert.equal(stuck.detail, 'stuck_subagent');
  assert.deepEqual([...stuck.stuckSubagents], ['call-1']);
  assert.equal(stuck.reason, 'Sub-agent reviewer (code-review) has had no events for 11 min; the limit is 10 min.');
  const heavy = busyLog();
  heavy.subagent({ type: 'general-purpose', model: 'claude-opus-5.5', effort: 'max' });
  assert.equal(evaluate(fold(heavy), T0 + 11 * MINUTE).detail, 'busy');
  assert.equal(evaluate(fold(heavy), T0 + 16 * MINUTE).detail, 'stuck_subagent');
});

test('a model call warns after 5 minutes and is stuck after 10', () => {
  const state = fold(busyLog());
  assert.equal(evaluate(state, T0 + 4 * MINUTE).detail, 'busy');
  assert.equal(evaluate(state, T0 + 6 * MINUTE).detail, 'slow_model_call');
  const stuck = evaluate(state, T0 + 11 * MINUTE);
  assert.equal(stuck.detail, 'stuck_model_call');
  assert.equal(stuck.reason, 'No model response for 11 min; the limit is 10 min.');
});

test('silent busy catches a stale busy flag or a tool without its own limit', () => {
  const idle = new EventLog(T0);
  idle.start();
  assert.equal(evaluate(fold(idle), T0 + 11 * MINUTE, { isRunningFlag: true }).detail, 'silent');
  const log = busyLog();
  log.tool('web_fetch', { url: 'https://example.com' });
  const silent = evaluate(fold(log), T0 + 11 * MINUTE);
  assert.equal(silent.detail, 'silent');
  assert.equal(silent.reason, 'Busy, but its log has had no new line for 11 min; the limit is 10 min.');
});

test('an open task call exempts a session from silent busy only while its sub-agent runs', () => {
  const heavy = busyLog();
  heavy.subagent({ type: 'general-purpose', model: 'claude-opus-5.5', effort: 'max' });
  assert.equal(evaluate(fold(heavy), T0 + 11 * MINUTE).detail, 'busy');
  const log = busyLog();
  const call = log.subagent({ name: 'reviewer', type: 'code-review' });
  log.subagentDone(call);
  const silent = evaluate(fold(log), T0 + 11 * MINUTE);
  assert.equal(silent.detail, 'silent');
  assert.equal(silent.reason, 'Busy, but its log has had no new line for 11 min; the limit is 10 min.');
  const failed = busyLog();
  failed.subagentDone(failed.subagent({ name: 'reviewer', type: 'code-review' }), { failed: true });
  assert.equal(evaluate(fold(failed), T0 + 11 * MINUTE).detail, 'silent');
});

test('spinning: failures, the same call in a row within a prompt, close compactions or an unattended denial', () => {
  const failing = busyLog();
  for (let i = 0; i < 5; i += 1) failing.done(failing.tool('view', { path: `missing-${i}` }), { success: false });
  assert.equal(evaluate(fold(failing), T0 + MINUTE).detail, 'spinning');
  const repeating = busyLog();
  for (let i = 0; i < 3; i += 1) repeating.done(repeating.tool('bash', { command: 'npm test' }));
  const result = evaluate(fold(repeating), T0 + MINUTE);
  assert.equal(result.detail, 'spinning');
  assert.equal(result.reason, 'In its last 30 min of busy time: the same tool call 3 times in a row.');
  const tdd = busyLog();
  for (let i = 0; i < 3; i += 1) {
    tdd.done(tdd.tool('bash', { command: 'npm test' }));
    tdd.done(tdd.tool('edit', { path: 'a.mjs', old_str: `${i}`, new_str: `${i + 1}` }));
  }
  assert.equal(evaluate(fold(tdd), T0 + MINUTE).detail, 'busy');
  const polling = busyLog();
  for (let i = 0; i < 4; i += 1) polling.done(polling.tool('read_agent', { agent_id: 'a', wait: true }));
  assert.equal(evaluate(fold(polling), T0 + MINUTE).detail, 'busy');
  const waking = busyLog();
  for (let i = 0; i < 3; i += 1) {
    waking.automationWake();
    waking.done(waking.tool('bash', { command: 'az repos pr show --id 4711' }));
  }
  assert.equal(evaluate(fold(waking), T0 + MINUTE).detail, 'busy');
  const compacting = busyLog();
  compacting.push('session.compaction_complete', {});
  compacting.push('session.compaction_complete', {});
  const compacted = evaluate(fold(compacting), T0 + MINUTE);
  assert.equal(compacted.detail, 'spinning');
  assert.equal(compacted.reason, 'In its last 30 min of busy time: 2 context compactions within 30 min.');
  const spaced = busyLog();
  spaced.push('session.compaction_complete', {});
  spaced.wait(5 * MINUTE); spaced.turnEnd();
  spaced.wait(60 * MINUTE); spaced.turnStart();
  spaced.push('session.compaction_complete', {});
  assert.equal(evaluate(fold(spaced), T0 + 66 * MINUTE).detail, 'busy');
  const denied = busyLog();
  denied.push('permission.completed', { decisionSource: 'unattended_fallback', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } });
  assert.equal(evaluate(fold(denied), T0 + MINUTE).detail, 'spinning');
});

test('a repeat streak ends at the next prompt, automation wake or cross-session message', () => {
  const afterPrompt = { human: log => log.user('next step'), automation: log => log.automationWake(), message: log => log.crossSession({ fromSessionId: 'ws-child', content: 'hello' }) };
  for (const [name, newPrompt] of Object.entries(afterPrompt)) {
    const log = busyLog();
    for (let i = 0; i < 3; i += 1) log.done(log.tool('bash', { command: 'npm test' }));
    newPrompt(log);
    log.done(log.tool('bash', { command: 'git status' }));
    assert.equal(evaluate(fold(log), T0 + MINUTE).detail, 'busy', name);
  }
  const same = busyLog();
  same.user('again');
  for (let i = 0; i < 3; i += 1) same.done(same.tool('bash', { command: 'npm test' }));
  assert.equal(evaluate(fold(same), T0 + MINUTE).detail, 'spinning');
});

test('long calls are compared by their full arguments, not a prefix', () => {
  const prefix = 'x'.repeat(500);
  const different = busyLog();
  for (const end of ['a', 'b', 'c']) different.done(different.tool('bash', { command: `${prefix}${end}` }));
  assert.equal(evaluate(fold(different), T0 + MINUTE).detail, 'busy');
  const identical = busyLog();
  for (let i = 0; i < 3; i += 1) identical.done(identical.tool('bash', { command: `${prefix}a` }));
  assert.equal(evaluate(fold(identical), T0 + MINUTE).detail, 'spinning');
  const keys = fold(identical).recent.calls.map(call => call.key);
  assert.ok(keys.every(key => key.length < 64), 'the key stays short');
});

test('idle units with unanswered reports are blocked or stalled', () => {
  const log = busyLog();
  log.wait(MINUTE);
  log.turnEnd();
  const state = fold(log);
  const at = T0 + MINUTE;
  assert.equal(evaluate(state, T0 + 2 * MINUTE, { report: { status: 'blocked', at } }).detail, 'blocked');
  assert.equal(evaluate(state, T0 + 2 * MINUTE, { report: { status: 'needs_input', at } }).detail, 'blocked_on_orchestrator');
  assert.equal(evaluate(state, T0 + 2 * MINUTE, { report: { status: 'needs_input', at }, parentRepliedAt: at + 1 }).detail, 'idle');
  const stalled = evaluate(state, T0 + 32 * MINUTE, { report: { status: 'progress', at } });
  assert.equal(stalled.detail, 'stalled');
  assert.equal(stalled.since, T0 + MINUTE);
  assert.equal(evaluate(state, T0 + 32 * MINUTE, { report: { status: 'progress', at }, monitorDueAt: T0 + 35 * MINUTE }).detail, 'idle');
  assert.equal(evaluate(state, T0 + 20 * MINUTE, { report: { status: 'progress', at } }).detail, 'idle');
});

test('a completed task after the last inbound message is not stalled', () => {
  const log = new EventLog(T0);
  log.start(); log.user('Do the work'); log.turnStart(); log.wait(MINUTE); log.taskComplete('Done'); log.turnEnd();
  assert.equal(evaluate(fold(log), T0 + 40 * MINUTE, { report: { status: 'progress', at: T0 + MINUTE } }).detail, 'idle');
});

test('without a registry, a failed last task means failed', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart(); log.taskComplete('Could not do it', false); log.turnEnd();
  const state = fold(log);
  assert.equal(evaluate(state, T0 + MINUTE).detail, 'failed');
  assert.equal(evaluate(state, T0 + MINUTE, { hasRegistry: true }).detail, 'idle');
});

test('the swarm is stalled when the orchestrator and every open unit are idle and no monitor is due', () => {
  assert.deepEqual(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'archived', 'stalled'], monitorDue: false, lastActivityAt: T0 }),
    { since: T0, reason: 'The orchestrator and every open unit are idle or ended, and no monitor is due.' });
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'busy'], monitorDue: false, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle'], monitorDue: true, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'busy', unitDetails: ['idle'], monitorDue: false, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['merged', 'archived'], monitorDue: false, lastActivityAt: T0 }), null);
});

test('busyWindowStart walks back through busy spans', () => {
  const state = { turn: { startedAt: T0 + 100 * MINUTE }, busySpans: [[T0, T0 + 20 * MINUTE], [T0 + 50 * MINUTE, T0 + 60 * MINUTE]] };
  assert.equal(busyWindowStart(state, T0 + 105 * MINUTE, 30 * MINUTE), T0 + 5 * MINUTE);
});

test('completed and cancelled sub-agent units are ended like merged and archived units; a busy one keeps the swarm open', () => {
  const stalled = { since: T0, reason: 'The orchestrator and every open unit are idle or ended, and no monitor is due.' };
  assert.deepEqual(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'completed', 'cancelled'], monitorDue: false, lastActivityAt: T0 }), stalled);
  assert.deepEqual(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['stalled', 'failed', 'crashed', 'completed'], monitorDue: false, lastActivityAt: T0 }), stalled);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'completed', 'busy'], monitorDue: false, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'stuck_subagent'], monitorDue: false, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['completed', 'cancelled'], monitorDue: false, lastActivityAt: T0 }), null);
});

// --- Sub-agent units ---

const evaluateSub = (sub, now, extra = {}) => evaluateSubagentUnit(sub, { alive: true, now, thresholds: t, ...extra });
const rootSub = (log, call) => fold(log, 'cli-1', { subagentUnits: true }).subagents.get(call);

test('a running sub-agent unit is busy from the start of its run until it has been silent past its limit', () => {
  const log = busyLog();
  const call = log.subagent({ name: 'scout', type: 'explore', mode: 'background' });
  log.wait(MINUTE); log.sub(call, 'assistant.message', { content: 'looking' });
  const sub = rootSub(log, call);
  assert.deepEqual(evaluateSub(sub, T0 + 11 * MINUTE), { detail: 'busy', since: T0, reason: null, endedAt: null, tool: null });
  assert.deepEqual(evaluateSub(sub, T0 + 26 * MINUTE), {
    detail: 'stuck_subagent', since: T0 + MINUTE, reason: 'No events for 25 min; the limit is 10 min.', endedAt: null, tool: null,
  });
  assert.equal(evaluateSub(sub, T0 + 11 * MINUTE + 1).detail, 'stuck_subagent', 'longer than the limit is stuck');
});

test('a general-purpose sub-agent on Opus at max effort gets the longer limit', () => {
  const log = busyLog();
  const call = log.subagent({ name: 'deep', type: 'general-purpose', mode: 'background', model: 'claude-opus-5', effort: 'max' });
  const sub = rootSub(log, call);
  assert.equal(evaluateSub(sub, T0 + 15 * MINUTE).detail, 'busy');
  assert.equal(evaluateSub(sub, T0 + 16 * MINUTE).reason, 'No events for 16 min; the limit is 15 min.');
});

test('a sub-agent unit whose orchestrator process ended while it ran is crashed at its last event; a finished one is not', () => {
  const log = busyLog();
  const running = log.subagent({ name: 'a', type: 'explore', mode: 'background' });
  const finished = log.subagent({ name: 'b', type: 'explore', mode: 'background' });
  log.wait(2 * MINUTE); log.sub(running, 'assistant.message', { content: 'x' });
  log.wait(MINUTE); log.subagentDone(finished, { durationMs: 3 * MINUTE });
  assert.deepEqual(evaluateSub(rootSub(log, running), T0 + 90 * MINUTE, { alive: false }), {
    detail: 'crashed', since: T0 + 2 * MINUTE, reason: 'The orchestrator\'s process ended while this sub-agent was running.', endedAt: T0 + 2 * MINUTE, tool: null,
  });
  assert.equal(evaluateSub(rootSub(log, finished), T0 + 90 * MINUTE, { alive: false }).detail, 'completed');
  assert.equal(evaluateSub(rootSub(log, running), T0 + 3 * MINUTE, { alive: null }).detail, 'busy', 'an unknown liveness is not a crash');
});

test('a finished sub-agent unit is failed, cancelled or completed, at the end of its last run', () => {
  const log = busyLog();
  const failed = log.subagent({ name: 'f', type: 'explore', mode: 'background' });
  const bare = log.subagent({ name: 'g', type: 'explore', mode: 'background' });
  const cancelled = log.subagent({ name: 'c', type: 'explore', mode: 'background', agentId: 'agent-c' });
  log.wait(3 * MINUTE);
  log.subagentDone(failed, { failed: true, error: 'Quota exceeded', durationMs: 3 * MINUTE });
  log.subagentDone(bare, { failed: true, durationMs: 3 * MINUTE });
  log.subagentDone(cancelled, { cancelled: true, durationMs: 3 * MINUTE });
  const now = T0 + 60 * MINUTE;
  assert.deepEqual(evaluateSub(rootSub(log, failed), now), { detail: 'failed', since: T0 + 3 * MINUTE, reason: 'Failed: Quota exceeded', endedAt: T0 + 3 * MINUTE, tool: null });
  assert.equal(evaluateSub(rootSub(log, bare), now).reason, 'Failed.');
  assert.deepEqual(evaluateSub(rootSub(log, cancelled), now), { detail: 'cancelled', since: T0 + 3 * MINUTE, reason: 'Cancelled after 3 min.', endedAt: T0 + 3 * MINUTE, tool: null });
  log.wait(10 * MINUTE); log.toAgent('agent-c', 'again');
  log.wait(2 * MINUTE); log.sub(cancelled, 'assistant.turn_end');
  const resumed = evaluateSub(rootSub(log, cancelled), now);
  assert.deepEqual([resumed.detail, resumed.since, resumed.endedAt, resumed.reason], ['completed', T0 + 15 * MINUTE, T0 + 15 * MINUTE, null],
    'the follow-up that ended normally is the last run: the unit is completed though its chip says cancelled');
});

test('a resumed sub-agent unit is busy from its follow-up, stuck when silent, and completed once its turn ends', () => {
  const log = busyLog();
  const call = log.subagent({ name: 'r', type: 'explore', mode: 'background', agentId: 'agent-r' });
  log.wait(MINUTE); log.subagentDone(call, { durationMs: MINUTE, agentId: 'agent-r' });
  log.wait(30 * MINUTE); log.toAgent('agent-r', 'again');
  const sub = rootSub(log, call);
  assert.deepEqual(evaluateSub(sub, T0 + 35 * MINUTE), { detail: 'busy', since: T0 + 31 * MINUTE, reason: null, endedAt: null, tool: null });
  assert.equal(evaluateSub(sub, T0 + 50 * MINUTE).detail, 'stuck_subagent');
  assert.equal(evaluateSub(sub, T0 + 50 * MINUTE).since, T0 + 31 * MINUTE);
  log.wait(2 * MINUTE); log.sub(call, 'assistant.turn_end');
  assert.deepEqual(evaluateSub(rootSub(log, call), T0 + 50 * MINUTE), { detail: 'completed', since: T0 + 33 * MINUTE, reason: null, endedAt: T0 + 33 * MINUTE, tool: null });
});

// --- An open tool call is judged by its own limit ---

/** A background sub-agent that starts a tool call inside itself one minute in. */
function withInnerTool(name, args) {
  const log = busyLog();
  const call = log.subagent({ name: 'worker', type: 'general-purpose', mode: 'background' });
  log.wait(MINUTE); log.sub(call, 'tool.execution_start', { toolCallId: 'inner-1', toolName: name, arguments: args });
  return { log, call };
}

test('a sub-agent unit with a long tool call open is judged by that tool\'s limit, not by silence', () => {
  const { log, call } = withInnerTool('bash', { command: 'long job', initial_wait: 600 });
  const sub = rootSub(log, call);
  assert.deepEqual(evaluateSub(sub, T0 + 12 * MINUTE), { detail: 'busy', since: T0, reason: null, endedAt: null, tool: null }, 'eleven minutes of silence is not stuck');
  assert.equal(evaluateSub(sub, T0 + 16 * MINUTE).detail, 'busy', 'the limit is 15 minutes, counted from the tool call');
  const stuck = evaluateSub(sub, T0 + 17 * MINUTE);
  assert.deepEqual(stuck, {
    detail: 'stuck_tool', since: T0 + MINUTE, endedAt: null,
    reason: 'bash has run for 16 min with a limit of 15 min (initial_wait 10 min + 5 min).',
    tool: { id: 'inner-1', name: 'bash', summary: 'bash: long job', startedAt: T0 + MINUTE, limitMs: 15 * MINUTE },
  });
});

test('a quick tool call that runs past 2 minutes makes the unit stuck_tool', () => {
  const { log, call } = withInnerTool('view', { path: 'a.txt' });
  const sub = rootSub(log, call);
  assert.equal(evaluateSub(sub, T0 + 3 * MINUTE).detail, 'busy');
  const stuck = evaluateSub(sub, T0 + 3 * MINUTE + 1);
  assert.deepEqual([stuck.detail, stuck.since, stuck.tool?.name, stuck.tool?.limitMs], ['stuck_tool', T0 + MINUTE, 'view', 2 * MINUTE]);
  assert.equal(stuck.reason, 'view has run for 2 min with a limit of 2 min.');
});

test('with no open tool that has its own limit, silence still makes the unit stuck_subagent', () => {
  const { log, call } = withInnerTool('web_fetch', { url: 'https://example.invalid' });
  const stuck = evaluateSub(rootSub(log, call), T0 + 12 * MINUTE);
  assert.deepEqual([stuck.detail, stuck.since, stuck.reason, stuck.tool], ['stuck_subagent', T0 + MINUTE, 'No events for 11 min; the limit is 10 min.', null]);
  const none = busyLog();
  const idle = none.subagent({ name: 'plain', type: 'explore', mode: 'background' });
  assert.equal(evaluateSub(rootSub(none, idle), T0 + 11 * MINUTE).detail, 'stuck_subagent');
});

test('the orchestrator\'s stuck flag for a sub-agent that has a unit follows the same rule', () => {
  const stuckOf = (log, now) => evaluate(fold(log, 'cli-1', { subagentUnits: true }), now).stuckSubagents.size;
  const bash = withInnerTool('bash', { command: 'long job', initial_wait: 600 });
  assert.equal(stuckOf(bash.log, T0 + 12 * MINUTE), 0, 'a long tool call is not stuck at 11 minutes');
  assert.equal(stuckOf(bash.log, T0 + 17 * MINUTE), 1, 'stuck past the tool\'s own limit');
  const view = withInnerTool('view', { path: 'a.txt' });
  assert.equal(stuckOf(view.log, T0 + 3 * MINUTE + 1), 1, 'a quick tool past its limit, long before the sub-agent limit');
  const plain = withInnerTool('web_fetch', { url: 'https://example.invalid' });
  assert.equal(stuckOf(plain.log, T0 + 12 * MINUTE), 1);
  assert.equal(evaluate(fold(withInnerTool('view', { path: 'a.txt' }).log), T0 + 3 * MINUTE + 1).stuckSubagents.size, 0, 'a state with no unit keeps the silence rule');
});
