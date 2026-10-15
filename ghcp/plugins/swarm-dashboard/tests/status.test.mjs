import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { STATUS_DETAILS } from '../engine/schema.mjs';
import { busyWindowStart, displayOf, evaluateStatus, swarmStalled, toolLimitMs } from '../engine/model/status.mjs';
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
