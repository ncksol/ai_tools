import { createHash } from 'node:crypto';
import { MAX_FINISHED_SUBAGENT_UNITS } from '../schema.mjs';
import { clip, oneLine, ownString } from '../text.mjs';
import { maxTime, minTime, parseTime } from '../time.mjs';
import { recordTaskComplete, recordToolComplete, recordToolStart, recordUserMessage } from './messages.mjs';
import { LIMITS, addFeed, addMark, pushBounded } from './state-utils.mjs';

/** Large event types the reducer does not need; only their timestamps are read. */
export const SKIP_TYPES = new Set([
  'session.usage_checkpoint', 'system.message', 'skill.context_delivered_ref', 'session.binary_asset',
  'session.workspace_file_changed', 'session.canvas.recorded', 'session.canvas.removed',
]);
/** Each skip type mapped to its own constant: keeping head[1], a slice of the line, would pin the whole read chunk. */
const SKIP_NAMES = new Map([...SKIP_TYPES].map(type => [type, type]));
const WAIT_TOOLS = new Map([['ask_user', 'question'], ['exit_plan_mode', 'plan']]);
const BUSY_JOIN_MS = 5000;
/** Most levels of nested sub-agents followed when a sub-agent's clock moves its ancestors' (a guard against a cycle). */
const MAX_NESTING = 64;

function argsOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON: keep the text as is.
  }
  return { raw: value };
}
const numberOrNull = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/**
 * `subagentUnits` is set for the CLI sessions of a swarm's root orchestrator: each of its one-off sub-agents then keeps a `unit`
 * (runs, open tools, last message, own feed, children), and its start and finish items go to that unit instead of the session feed.
 */
export function createSessionState(id, { subagentUnits = false } = {}) {
  return {
    id, subagentUnits, lines: 0, parseErrors: 0, firstEventAt: null, lastEventAt: null, lastEventType: null, lastMainAt: null,
    copilotVersion: null, model: null, effort: null, mode: null,
    turn: null, busySince: null, lastTurnEndAt: null, busySpans: [], busyMs: 0,
    openTools: new Map(), waits: new Map(), waitSpans: [], waitingMs: 0,
    // Total length of the closed waits that waitSpans no longer holds (it keeps the latest LIMITS.spans).
    waitDroppedMs: 0,
    subagents: new Map(), agentToTask: new Map(),
    // Root states only: closed units that left `subagents` (see evictSubagent), by the bucket their current outcome gives.
    unitsEvicted: { done: 0, failed: 0 },
    // Root states only: top-level sub-agent launches so far. Each unit stores the count at its launch (`unit.ordinal`), so the number
    // in a fallback label never changes when older units leave the details.
    unitLaunches: 0,
    // Whole-session sub-agent totals that the capped detail list never changes: launches, per type runs and finished
    // duration, and each task tool-call id's type (to attribute ledger credits by type).
    subagentCount: 0, subagentStats: new Map(), subagentIndex: new Map(), evictedRunning: new Map(),
    // Sub-agents started by a sub-agent: task id -> { root: the top sub-agent's id, parent: its direct parent's id, bucket, status,
    // mode, agentId, launchedAt, startedAt }, enough to count them and end them once. Bounded like subagentIndex. A direct child of a
    // root sub-agent also has a full record in that sub-agent's unit. Outcomes count the details and their evicted records the
    // first time each leaves running.
    descendants: new Map(), subagentOutcomes: { completed: 0, failed: 0, cancelled: 0 },
    sent: [], inbound: [], lastInboundAt: null, lastHumanAt: null, taskCompletes: [],
    // Reply index: `outboundSeq` counts the session's own outbound events (a sent session message, a task completion); `replyIndex`
    // maps each sender id to { seq, times }: the time of the first message from it after each such event, ascending and bounded.
    // Unlike the rolling `inbound` list, later messages never push a recorded reply out (see messages.mjs).
    outboundSeq: 0, replyIndex: new Map(),
    automation: { saves: [], wakes: [] },
    shutdownAt: null, abortAt: null, lastErrorAt: null,
    recent: { failures: [], calls: [], compactions: [], denials: [] }, prompts: 0,
    feed: [], marks: [], prMentions: new Map(), source: null,
  };
}

export function applyLine(state, line) {
  if (!line) return;
  state.lines += 1;
  const head = /^\{"type":"([^"]+)"/.exec(line);
  const skipped = head ? SKIP_NAMES.get(head[1]) : undefined;
  if (skipped) {
    const at = sniffTimestamp(line);
    if (at !== null) touch(state, at, skipped);
    return;
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    state.parseErrors += 1;
    return;
  }
  if (event && typeof event === 'object' && typeof event.type === 'string') applyEvent(state, event);
}

/** The only data keys applied from an oversized line, by event type: enough to close a tool call, wait or sub-agent. */
/** A Map, not an object: the event type comes from a log, and a plain object would also answer to `constructor` or `__proto__`. */
const RECOVERED_DATA = new Map([
  ['tool.execution_complete', ['toolCallId', 'success', 'parentToolCallId']],
  ['subagent.completed', ['toolCallId', 'durationMs', 'parentToolCallId', 'agentId', 'cancelled']],
  ['subagent.failed', ['toolCallId', 'durationMs', 'parentToolCallId', 'agentId']],
]);

/**
 * Applies an event recovered from an oversized line (see readers/json-scan.mjs). It counts the line like applyLine and applies
 * metadata only, never text: a tool completion or a sub-agent completion or failure is applied with just the ids, success and
 * cancelled flags and duration it needs to close its tool call, wait or sub-agent. Any other event only moves the session's clock, and the
 * clock of the sub-agent it belongs to (by data.parentToolCallId, or a top-level agentId that is known).
 */
export function applyRecovered(state, event) {
  state.lines += 1;
  if (!event) return;
  const at = parseTime(event.timestamp);
  if (at === null) return;
  const keys = RECOVERED_DATA.get(event.type);
  if (keys) {
    const data = {};
    for (const key of keys) if (event.data && event.data[key] !== undefined) data[key] = event.data[key];
    const metadata = { type: event.type, timestamp: event.timestamp, data };
    for (const key of ['id', 'parentId', 'agentId']) if (event[key] !== undefined) metadata[key] = event[key];
    applyEvent(state, metadata);
    return;
  }
  touch(state, at, SKIP_NAMES.get(event.type) ?? event.type);
  const agentId = event.agentId === undefined || event.agentId === null ? null : String(event.agentId);
  const owner = event.data?.parentToolCallId ?? (agentId ? state.agentToTask.get(agentId) ?? null : null);
  touchSubagent(state, owner, at);
}

function sniffTimestamp(line) {
  const key = '"timestamp":"';
  const index = line.lastIndexOf(key);
  if (index < 0) return null;
  const end = line.indexOf('"', index + key.length);
  return end < 0 ? null : parseTime(line.slice(index + key.length, end));
}

function touch(state, at, type) {
  if (state.firstEventAt === null || at < state.firstEventAt) state.firstEventAt = at;
  if (state.lastEventAt === null || at >= state.lastEventAt) {
    state.lastEventAt = at;
    state.lastEventType = type;
  }
}

/** Stable id of the event being applied, for feed ids: its tool call, else its event id, else its line number. */
function eventSource(state, event, data) {
  if (typeof data.toolCallId === 'string' && data.toolCallId) return `${state.id}/${data.toolCallId}`;
  if (typeof event.id === 'string' && event.id) return `${state.id}/${event.id}`;
  return `${state.id}#${state.lines}`;
}

export function applyEvent(state, event) {
  const at = parseTime(event.timestamp);
  if (at === null) return;
  touch(state, at, event.type);
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  state.source = eventSource(state, event, data);
  if (event.type.startsWith('subagent.')) {
    onSubagentLifecycle(state, event, data, at);
    return;
  }
  const agentId = event.agentId === undefined || event.agentId === null ? null : String(event.agentId);
  const owner = data.parentToolCallId ?? (agentId ? state.agentToTask.get(agentId) ?? null : null);
  if (owner || agentId) {
    onOwnedEvent(state, event, data, owner, agentId, at);
    return;
  }
  if (event.type === 'user.message' && data.source === `agent-${state.id}`) return;
  onMainEvent(state, event.type, data, at);
  state.lastMainAt = at;
}

/**
 * A reasoning effort from any source (a log event, a task call, data.db), on one line and at most 40 characters; null when it is
 * not a string or is empty after that.
 */
export function effortOf(value) {
  return typeof value === 'string' ? oneLine(value, 40) || null : null;
}

/**
 * The session's reasoning effort from a start, resume or model change that names one. A null or empty value clears it (a model
 * change can drop the effort); an event without the key (older CLI versions) leaves it as it is.
 */
function setEffort(state, data) {
  if (!Object.hasOwn(data, 'reasoningEffort')) return;
  state.effort = effortOf(data.reasoningEffort);
}

function onMainEvent(state, type, data, at) {
  switch (type) {
    case 'session.start':
    case 'session.resume':
      endProcess(state, state.lastMainAt ?? at);
      if (typeof data.copilotVersion === 'string') state.copilotVersion = data.copilotVersion;
      if (typeof data.selectedModel === 'string') state.model = data.selectedModel;
      setEffort(state, data);
      break;
    case 'session.model_change':
      if (typeof data.newModel === 'string') state.model = data.newModel;
      setEffort(state, data);
      break;
    case 'session.mode_changed':
      if (typeof data.newMode === 'string') state.mode = data.newMode;
      break;
    case 'assistant.turn_start':
      if (!state.turn) {
        const joined = state.busySince !== null && state.lastTurnEndAt !== null && at - state.lastTurnEndAt <= BUSY_JOIN_MS;
        state.busySince = joined ? state.busySince : at;
        state.turn = { startedAt: at, progressAt: at };
      }
      break;
    case 'assistant.turn_end':
      closeTurn(state, at);
      break;
    case 'assistant.message':
      if (state.turn) state.turn.progressAt = at;
      if (typeof data.model === 'string') state.model = data.model;
      break;
    case 'session.usage_record':
      if (state.turn) state.turn.progressAt = at;
      if (typeof data.usage?.model === 'string') state.model = data.usage.model;
      break;
    case 'tool.execution_start':
      onToolStart(state, data, at);
      break;
    case 'tool.execution_complete':
      onToolComplete(state, data, at);
      break;
    case 'user.message':
      state.prompts += 1;
      recordUserMessage(state, data, at);
      break;
    case 'session.task_complete':
      recordTaskComplete(state, data, at);
      break;
    case 'session.shutdown':
      state.shutdownAt = at;
      endProcess(state, at);
      break;
    case 'abort':
      state.abortAt = at;
      closeTurn(state, at);
      endOpenWork(state, at, true);
      addFeed(state, at, 'abort', 'turn aborted');
      break;
    case 'session.error':
      state.lastErrorAt = at;
      addFeed(state, at, 'error', `error${typeof data.errorType === 'string' ? `: ${data.errorType}` : ''}`);
      break;
    case 'session.compaction_complete':
      pushBounded(state.recent.compactions, at, LIMITS.recent);
      addFeed(state, at, 'compaction', 'compacted its context');
      break;
    case 'permission.completed':
      if (data.decisionSource === 'unattended_fallback' && /denied/i.test(String(data.result?.kind ?? ''))) {
        pushBounded(state.recent.denials, at, LIMITS.recent);
      }
      break;
    default:
      break;
  }
}

function closeTurn(state, at) {
  if (!state.turn) return;
  const end = Math.max(at, state.turn.startedAt);
  pushBounded(state.busySpans, [state.turn.startedAt, end], LIMITS.spans);
  state.busyMs += end - state.turn.startedAt;
  state.turn = null;
  state.lastTurnEndAt = end;
}

function closeWait(state, id, wait, at) {
  state.waits.delete(id);
  const end = Math.max(at, wait.startedAt);
  state.waitSpans.push([wait.startedAt, end, wait.kind]);
  // The oldest spans leave the bounded list; their time is kept in waitDroppedMs, so totals built from spans stay exact.
  while (state.waitSpans.length > LIMITS.spans) {
    const [start, stop] = state.waitSpans.shift();
    state.waitDroppedMs += stop - start;
  }
  state.waitingMs += end - wait.startedAt;
}

/** The type a sub-agent is counted under: its own, or 'other' once the session has LIMITS.subagentTypes distinct types. */
function typeBucket(stats, type) {
  return stats.has(type) || stats.size < LIMITS.subagentTypes ? type : 'other';
}

function statsEntry(stats, bucket) {
  let entry = stats.get(bucket);
  if (!entry) {
    entry = { runs: 0, durationMs: 0 };
    stats.set(bucket, entry);
  }
  return entry;
}

/** The label a sub-agent has in feed texts: `<type>: <name>`. */
const subLabel = sub => `${sub.type}: ${sub.name}`;

/** An item of a sub-agent's own feed (root states only). `source` defaults to the event being applied. */
function addUnitFeed(state, sub, at, kind, text, source = state.source) {
  pushBounded(sub.unit.feed, { at, kind, text: oneLine(text, 200), source: source ?? `${state.id}#${state.lines}` }, LIMITS.subagentFeed);
}

/** Closes the last open run of a sub-agent unit at `at` (never before its start). */
function closeRun(unit, at) {
  const last = unit.runs[unit.runs.length - 1];
  if (last && last[1] === null) last[1] = Math.max(at, last[0]);
}

/** The source of the finish item of a unit's current run after the first: one item per run. */
const runSource = (state, sub) => `${state.id}/${sub.id}/run-${sub.unit.runCount}`;

/** Sets the finish item of a unit's current run (replacing one it already has) at `at`. */
function setRunFinishItem(state, sub, at, status) {
  const source = runSource(state, sub);
  const { feed } = sub.unit;
  const index = feed.findIndex(item => item.source === source);
  if (index >= 0) feed.splice(index, 1);
  addUnitFeed(state, sub, at, 'subagent-done', `${status} ${subLabel(sub)}`, source);
}

/** The task's `name` argument: the base of a unit's label. Fixed at launch; the display name that arrives with subagent.started never changes it. */
function taskNameOf(args) {
  return (typeof args.name === 'string' ? oneLine(args.name, 80) : '') || null;
}

/** The task call's agent type. A unit's label falls back to it, fixed at launch, though subagent.started can retype the sub-agent. */
function agentTypeOf(args) {
  return oneLine(args.agent_type ?? 'task', 60) || 'task';
}

function newUnit(args, at) {
  return {
    taskName: taskNameOf(args), labelType: agentTypeOf(args), runs: [[at, null]], droppedBusyMs: 0, turnOpen: false, lastTurnEndAt: null,
    // runCount: runs opened (the first, then one per follow-up). lastOutcome: how the last closed run ended; the chip's own outcome
    // (the sub-agent's status) never changes after the first finish.
    runCount: 1, lastOutcome: null,
    // When a message was first sent to the sub-agent after its latest message (`lastMessage`); null until then and after the next message.
    repliedAt: null,
    openTools: new Map(), lastMessage: null, error: null, feed: [], children: [], firstFinishAt: null,
  };
}

/** Adds a run to a unit (a follow-up). A run that leaves the bounded list adds its length to `droppedBusyMs`, so the busy total stays whole. */
function pushRun(unit, run) {
  unit.runs.push(run);
  unit.runCount += 1;
  while (unit.runs.length > LIMITS.subagentRuns) {
    const [start, end] = unit.runs.shift();
    unit.droppedBusyMs += (end ?? start) - start;
  }
}

/**
 * The single place a detail leaves 'running'. Adds its duration to the per-type totals, once, and counts its outcome (the
 * outcomes cover the session's own sub-agents, not the ones they started). A root state's sub-agent unit ends its first run
 * and gets its feed item and error.
 */
function finishSubagent(state, sub, at, status, durationMs, error = null) {
  if (sub.status !== 'running') return;
  sub.status = status;
  sub.endedAt = Math.max(at, sub.launchedAt);
  sub.durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : Math.max(0, sub.endedAt - (sub.startedAt ?? sub.launchedAt));
  statsEntry(state.subagentStats, sub.bucket).durationMs += sub.durationMs;
  state.subagentOutcomes[status] += 1;
  if (sub.unit) {
    closeRun(sub.unit, sub.endedAt);
    sub.unit.firstFinishAt ??= sub.endedAt;
    sub.unit.lastOutcome = status;
    sub.unit.openTools.clear();
    if (error) sub.unit.error = error;
    addUnitFeed(state, sub, sub.endedAt, 'subagent-done', `${status} ${subLabel(sub)}`, `${state.id}/${sub.id}`);
  }
}

/** The detail of a direct child of a root sub-agent, while that sub-agent's unit still keeps it. */
function childOf(state, id, entry) {
  if (entry.parent !== entry.root) return null;
  const list = state.subagents.get(entry.root)?.unit?.children;
  return list ? list.find(child => child.id === id) ?? null : null;
}

/** The same for a nested sub-agent: its duration reaches the totals once, and its kept detail and its parent's unit feed are updated. */
function finishNested(state, id, entry, at, status, durationMs) {
  if (entry.status !== 'running') return;
  entry.status = status;
  const ended = Math.max(at, entry.launchedAt);
  const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : Math.max(0, ended - (entry.startedAt ?? entry.launchedAt));
  statsEntry(state.subagentStats, entry.bucket).durationMs += duration;
  entry.durationMs = duration;
  const child = childOf(state, id, entry);
  if (!child) return;
  child.status = status;
  child.endedAt = ended;
  child.durationMs = duration;
  addUnitFeed(state, state.subagents.get(entry.root), ended, 'subagent-done', `${status} ${subLabel(child)}`, `${state.id}/${id}`);
}

/** The same for a running sub-agent that was evicted from the details: adds its duration once, then forgets the record. */
function finishEvicted(state, record, at, durationMs, status) {
  state.evictedRunning.delete(record.id);
  state.subagentOutcomes[status] += 1;
  const ended = Math.max(at, record.launchedAt);
  const duration = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : Math.max(0, ended - (record.startedAt ?? record.launchedAt));
  statsEntry(state.subagentStats, record.bucket).durationMs += duration;
}

/** Moves a sub-agent's run (and finished duration) to another type when its start event names a different one. `holder.bucket` is updated. */
function moveBucket(state, id, holder, type, durationMs) {
  if (typeBucket(state.subagentStats, type) === holder.bucket) return;
  const from = statsEntry(state.subagentStats, holder.bucket);
  from.runs -= 1;
  if (durationMs !== null) from.durationMs -= durationMs;
  // An old type with no runs left is dropped, so it neither shows in the totals nor holds one of the type slots.
  if (from.runs <= 0) state.subagentStats.delete(holder.bucket);
  const bucket = typeBucket(state.subagentStats, type);
  const to = statsEntry(state.subagentStats, bucket);
  to.runs += 1;
  if (durationMs !== null) to.durationMs += durationMs;
  holder.bucket = bucket;
  if (state.subagentIndex.has(id)) state.subagentIndex.set(id, bucket);
}

function retypeSubagent(state, sub, type) {
  sub.type = type;
  moveBucket(state, sub.id, sub, type, sub.durationMs);
}

/** A nested sub-agent has no type of its own; its bucket (and its kept detail, if any) follows the new type. */
function retypeNested(state, id, entry, type) {
  const child = childOf(state, id, entry);
  moveBucket(state, id, entry, type, entry.durationMs);
  if (child) {
    child.type = type;
    child.bucket = entry.bucket;
  }
}

/** Work that cannot outlive the turn or process: open waits, tools and running sub-agents. An abort cancels them; the end of the process fails them. */
function endOpenWork(state, at, keepBackground) {
  for (const [id, wait] of state.waits) closeWait(state, id, wait, at);
  state.openTools.clear();
  const status = keepBackground ? 'cancelled' : 'failed';
  const error = keepBackground ? null : 'Stopped when the orchestrator\'s process ended.';
  for (const sub of state.subagents.values()) {
    if (sub.status !== 'running' || (keepBackground && sub.mode === 'background')) continue;
    finishSubagent(state, sub, at, status, null, error);
  }
  // A sub-agent that finished and was then sent a follow-up (or whose run was reopened) has an open run of its own. The same rule
  // ends it: an abort cancels it unless the sub-agent runs in the background, the end of the process fails it. The chip stays as it was.
  for (const sub of state.subagents.values()) {
    const { unit } = sub;
    if (!unit || sub.status === 'running' || (keepBackground && sub.mode === 'background')) continue;
    const last = unit.runs[unit.runs.length - 1];
    if (!last || last[1] !== null) continue;
    closeRun(unit, at);
    unit.openTools.clear();
    unit.turnOpen = false;
    unit.lastOutcome = status;
    if (error) unit.error = error;
    setRunFinishItem(state, sub, at, status);
  }
  // Sub-agents started by a sub-agent end with the process. An abort ends a sync one only when its top sub-agent has ended:
  // one that is running, runs in the background (also when evicted from the details), or was resumed (its last run is open) goes on.
  for (const [id, entry] of state.descendants) {
    if (entry.status !== 'running') continue;
    if (keepBackground) {
      const top = state.subagents.get(entry.root);
      const lastRun = top?.unit?.runs[top.unit.runs.length - 1];
      if (entry.mode === 'background' || top?.mode === 'background' || top?.status === 'running' || (lastRun && lastRun[1] === null) || state.evictedRunning.get(entry.root)?.mode === 'background') continue;
    }
    finishNested(state, id, entry, at, status, null);
  }
  for (const record of [...state.evictedRunning.values()]) {
    if (keepBackground && record.mode === 'background') continue;
    finishEvicted(state, record, at, null, status);
  }
}

function endProcess(state, at) {
  closeTurn(state, at);
  // endOpenWork ends every open run of a sub-agent unit, a follow-up's included.
  endOpenWork(state, at, false);
}

function toolArgs(name, args) {
  const pick = [args.command, args.description, args.path, args.pattern, args.url, args.query, args.name, args.session_id, args.agent_id, args.shellId, args.raw]
    .find(value => typeof value === 'string' && value.trim());
  return {
    summary: oneLine(pick ? `${name}: ${pick}` : name, 160),
    mode: typeof args.mode === 'string' ? args.mode : null,
    initialWait: numberOrNull(args.initial_wait),
    delay: numberOrNull(args.delay),
    timeout: numberOrNull(args.timeout),
    wait: args.wait === true,
  };
}

function callKey(name, raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  return ownString(`${name}|${createHash('sha256').update(text).digest('base64url')}`);
}

/**
 * The root orchestrator's sub-agents are kept by their units (a unit's last run decides, not the first one's status). A unit is
 * open while its last run is open; a sub-agent without a unit is open while it is running. `lastFinish` is when a closed one last ended.
 */
const isOpen = sub => (sub.unit ? sub.unit.runs[sub.unit.runs.length - 1][1] === null : sub.status === 'running');
const lastFinish = sub => (sub.unit ? sub.unit.runs[sub.unit.runs.length - 1][1] : sub.endedAt ?? sub.launchedAt);
/** The bucket a closed sub-agent is counted in once it is no longer listed: its current outcome decides. */
const closedBucket = sub => ((sub.unit?.lastOutcome ?? sub.status) === 'completed' ? 'done' : 'failed');

/**
 * Drops a sub-agent from the detail list; returns false when it dropped none.
 * A root state (units) never drops an open unit, nor any of the MAX_FINISHED_SUBAGENT_UNITS closed ones that finished last: it drops
 * the closed one that finished longest ago (the earliest in the map on a tie) and counts it in `unitsEvicted` by its outcome.
 * With nothing left to drop the list may pass LIMITS.subagents, by open units only.
 * Any other state drops the oldest finished sub-agent, or the oldest running one when none has finished. A running
 * one leaves a minimal record behind (bounded like the type index), so its runtime still reaches the per-type totals when it
 * finishes. Its details are never restored.
 */
function evictSubagent(state) {
  if (state.subagentUnits) return evictUnit(state);
  let victim = null;
  for (const sub of state.subagents.values()) {
    if (sub.status !== 'running') {
      victim = sub;
      break;
    }
    victim ??= sub;
  }
  state.subagents.delete(victim.id);
  if (victim.agentId) state.agentToTask.delete(victim.agentId);
  if (victim.status === 'running') {
    state.evictedRunning.set(victim.id, { id: victim.id, launchedAt: victim.launchedAt, startedAt: victim.startedAt, bucket: victim.bucket, mode: victim.mode });
    while (state.evictedRunning.size > LIMITS.subagentIndex) state.evictedRunning.delete(state.evictedRunning.keys().next().value);
  }
  return true;
}

function evictUnit(state) {
  let closed = 0;
  let victim = null;
  for (const sub of state.subagents.values()) {
    if (isOpen(sub)) continue;
    closed += 1;
    if (victim === null || lastFinish(sub) < lastFinish(victim)) victim = sub;
  }
  // The victim is the first of the closed ones by finish time, so it is protected only when it is among the latest MAX_FINISHED_SUBAGENT_UNITS.
  if (victim === null || closed <= MAX_FINISHED_SUBAGENT_UNITS) return false;
  state.subagents.delete(victim.id);
  if (victim.agentId) state.agentToTask.delete(victim.agentId);
  state.unitsEvicted[closedBucket(victim)] += 1;
  return true;
}

/** The fields a task call gives a sub-agent. */
function subagentFields(args) {
  return {
    name: oneLine(args.name ?? args.description ?? 'sub-agent', 80) || 'sub-agent',
    type: agentTypeOf(args),
    mode: args.mode === 'background' ? 'background' : 'sync',
    model: typeof args.model === 'string' ? args.model : null,
    effort: effortOf(args.reasoning_effort),
    task: typeof args.description === 'string' ? oneLine(args.description, 200) : null,
  };
}

/** A new sub-agent record, counted once in the session totals and the task index. */
function countSubagent(state, id, at, fields) {
  const sub = { id, ...fields, launchedAt: at, startedAt: null, endedAt: null, durationMs: null, status: 'running', lastEventAt: at, agentId: null };
  sub.bucket = typeBucket(state.subagentStats, sub.type);
  state.subagentCount += 1;
  statsEntry(state.subagentStats, sub.bucket).runs += 1;
  state.subagentIndex.set(id, sub.bucket);
  while (state.subagentIndex.size > LIMITS.subagentIndex) state.subagentIndex.delete(state.subagentIndex.keys().next().value);
  return sub;
}

/**
 * A sub-agent of the session itself is counted once per task tool-call id. A repeated start for an id that is still in the details
 * updates them and leaves the counts alone (onToolStart ignores a repeated start for an id that has left the details). It keeps an
 * effort that subagent.configured set (`effortConfigured`) over the one the task call requests, and a model that subagent.started
 * or subagent.configured reported (`modelObserved`) over the one the task call requests, or its lack of one; so does onNestedTaskStart.
 */
function newSubagent(state, id, at, args) {
  const fields = subagentFields(args);
  const known = state.subagents.get(id);
  if (known) {
    const { type, ...rest } = fields;
    if (known.effortConfigured) delete rest.effort;
    if (known.modelObserved) delete rest.model;
    Object.assign(known, rest);
    if (known.unit) {
      known.unit.taskName = taskNameOf(args);
      known.unit.labelType = agentTypeOf(args);
    }
    retypeSubagent(state, known, type);
    return known;
  }
  const sub = countSubagent(state, id, at, fields);
  if (state.subagentUnits) {
    state.unitLaunches += 1;
    sub.unit = newUnit(args, at);
    sub.unit.ordinal = state.unitLaunches;
  }
  state.subagents.set(id, sub);
  while (state.subagents.size > LIMITS.subagents) if (!evictSubagent(state)) break;
  return sub;
}

/** Forgets the oldest nested sub-agent, and the agent id that mapped to it. */
function dropDescendant(state) {
  const [id, entry] = state.descendants.entries().next().value;
  state.descendants.delete(id);
  if (entry.agentId && state.agentToTask.get(entry.agentId) === id) state.agentToTask.delete(entry.agentId);
}

/**
 * A `task` call made by a sub-agent. The nested sub-agent is counted once and kept as a small entry in `state.descendants`; only
 * a direct child of a root sub-agent also gets a full record, in that sub-agent's unit (the last LIMITS.subagentChildren of them).
 */
function onNestedTaskStart(state, id, parentId, args, at) {
  if (state.subagents.has(id)) return;
  const entry = state.descendants.get(id);
  if (!entry && state.subagentIndex.has(id)) return;
  const fields = subagentFields(args);
  if (entry) {
    entry.mode = fields.mode;
    const { type, ...rest } = fields;
    const child = childOf(state, id, entry);
    if (child) {
      if (child.effortConfigured) delete rest.effort;
      if (child.modelObserved) delete rest.model;
      Object.assign(child, rest);
    }
    retypeNested(state, id, entry, type);
    return;
  }
  const sub = countSubagent(state, id, at, fields);
  state.descendants.set(id, {
    root: state.descendants.get(parentId)?.root ?? parentId, parent: parentId, bucket: sub.bucket, status: 'running', mode: sub.mode,
    agentId: null, launchedAt: at, startedAt: null, durationMs: null,
  });
  while (state.descendants.size > LIMITS.subagentIndex) dropDescendant(state);
  const parent = state.subagents.get(parentId);
  if (!parent?.unit) return;
  pushBounded(parent.unit.children, sub, LIMITS.subagentChildren);
  addUnitFeed(state, parent, at, 'subagent-start', `started ${subLabel(sub)}${sub.mode === 'sync' ? ' (sync)' : ''}`, `${state.id}/${id}`);
}

function onToolStart(state, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  const name = typeof data.toolName === 'string' ? data.toolName : 'tool';
  // A repeated start for a sub-agent that was evicted from the details changes nothing: no details, counts, feed or open tool.
  if (name === 'task' && !state.subagents.has(id) && state.subagentIndex.has(id)) return;
  const args = argsOf(data.arguments);
  state.openTools.set(id, { id, name, startedAt: at, args: toolArgs(name, args) });
  pushBounded(state.recent.calls, { at, name, key: callKey(name, data.arguments), prompt: state.prompts }, LIMITS.recent);
  const kind = WAIT_TOOLS.get(name);
  if (kind) {
    const text = clip(String((kind === 'question' ? args.question : args.summary) ?? ''), 2000);
    state.waits.set(id, { id, kind, text, startedAt: at });
    if (kind === 'question') {
      addMark(state, at, 'question', text || 'Question');
      addFeed(state, at, 'question', `asked: ${text}`);
    } else {
      addMark(state, at, 'plan-req', 'Plan sent for approval');
      addFeed(state, at, 'plan-req', 'sent a plan for approval');
    }
  } else if (name === 'task') {
    const repeated = state.subagents.has(id);
    const sub = newSubagent(state, id, at, args);
    if (!repeated) {
      const text = `started ${subLabel(sub)}${sub.mode === 'sync' ? ' (sync)' : ''}`;
      if (sub.unit) addUnitFeed(state, sub, at, 'subagent-start', text, `${state.id}/${id}`);
      else addFeed(state, at, 'subagent-start', text);
    }
  } else {
    recordToolStart(state, name, args, id, at);
  }
}

function resultText(data) {
  const content = data.result?.content;
  return typeof content === 'string' ? content : '';
}

function onToolComplete(state, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  state.openTools.delete(id);
  if (state.turn) state.turn.progressAt = at;
  if (data.success === false) pushBounded(state.recent.failures, at, LIMITS.recent);
  const wait = state.waits.get(id);
  if (wait) {
    closeWait(state, id, wait, at);
    if (wait.kind === 'question') {
      addMark(state, at, 'answer', 'Answer received');
      addFeed(state, at, 'answer', 'got an answer');
    } else if (data.success !== false && /plan approved/i.test(resultText(data))) {
      addMark(state, at, 'plan-ok', 'Plan approved');
      addFeed(state, at, 'plan-ok', 'plan approved');
    }
  }
  const sub = state.subagents.get(id);
  if (sub) {
    const agentId = data.toolTelemetry?.restrictedProperties?.agent_id;
    if (typeof agentId === 'string') {
      sub.agentId = agentId;
      state.agentToTask.set(agentId, id);
    }
    if (sub.status === 'running' && (data.success === false || (sub.mode === 'sync' && sub.startedAt === null))) {
      finishSubagent(state, sub, at, data.success === false ? 'failed' : 'completed', null);
    }
  } else {
    const record = state.evictedRunning.get(id);
    if (record && (data.success === false || (record.mode === 'sync' && record.startedAt === null))) {
      finishEvicted(state, record, at, null, data.success === false ? 'failed' : 'completed');
    }
  }
  recordToolComplete(state, id, data);
}

/** The completion of the task call that started a nested sub-agent: it ends a failed or sync one that no lifecycle event covers. */
function onNestedTaskComplete(state, id, data, at) {
  const entry = state.descendants.get(id);
  if (!entry) return;
  const agentId = data.toolTelemetry?.restrictedProperties?.agent_id;
  if (typeof agentId === 'string') {
    entry.agentId = agentId;
    const child = childOf(state, id, entry);
    if (child) child.agentId = agentId;
    state.agentToTask.set(agentId, id);
  }
  if (entry.status === 'running' && (data.success === false || (entry.mode === 'sync' && entry.startedAt === null))) {
    finishNested(state, id, entry, at, data.success === false ? 'failed' : 'completed', null);
  }
}

/**
 * An event that belongs to a sub-agent: carries its tool-call id as data.parentToolCallId, or its agent id at the top level. It
 * moves the clock of the sub-agent and of every sub-agent above it. A task call made by a sub-agent registers a nested
 * sub-agent. In a root state a top-level sub-agent also follows its own events (turns, tool calls, messages, follow-ups).
 */
function onOwnedEvent(state, event, data, owner, agentId, at) {
  touchSubagent(state, owner, at);
  if (!owner) return;
  const parent = state.subagents.get(owner) ?? null;
  if (!parent && !state.descendants.has(owner)) return;
  const unit = parent ? parent.unit : null;
  const toolId = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  switch (event.type) {
    case 'tool.execution_start': {
      if (!toolId) break;
      const name = typeof data.toolName === 'string' ? data.toolName : 'tool';
      const args = argsOf(data.arguments);
      if (name === 'task') onNestedTaskStart(state, toolId, owner, args, at);
      if (unit) {
        unit.openTools.delete(toolId);
        unit.openTools.set(toolId, { id: toolId, name, startedAt: at, args: toolArgs(name, args) });
        while (unit.openTools.size > LIMITS.subagentOpenTools) unit.openTools.delete(unit.openTools.keys().next().value);
      }
      break;
    }
    case 'tool.execution_complete':
      if (!toolId) break;
      if (unit) unit.openTools.delete(toolId);
      onNestedTaskComplete(state, toolId, data, at);
      break;
    case 'assistant.turn_start':
      if (!unit) break;
      unit.turnOpen = true;
      if (unit.firstFinishAt !== null) {
        const last = unit.runs[unit.runs.length - 1];
        if (last && last[1] !== null) {
          last[1] = null;
          // A run that works again has not finished: its finish item (if any) comes back after its last turn.
          unit.feed = unit.feed.filter(item => item.source !== runSource(state, parent));
        }
      }
      break;
    case 'assistant.turn_end':
      if (!unit) break;
      unit.turnOpen = false;
      unit.lastTurnEndAt = at;
      if (unit.firstFinishAt !== null) {
        const last = unit.runs[unit.runs.length - 1];
        if (last && last[1] === null) {
          closeRun(unit, at);
          unit.lastOutcome = 'completed';
          // The first run has its finish item already; each run opened by a follow-up gets one of its own.
          if (unit.runCount >= 2) setRunFinishItem(state, parent, at, 'completed');
        }
      }
      break;
    case 'assistant.message':
      if (unit && typeof data.content === 'string' && data.content.trim()) {
        unit.lastMessage = { at, text: ownString(clip(data.content, 4000)) };
        unit.repliedAt = null;
      }
      break;
    case 'user.message': {
      // A message to the sub-agent: the first is its prompt (its first run is already open). One sent after its work ended is a follow-up.
      if (!unit || data.parentToolCallId || agentId === null) break;
      // The first message after its latest one is its reply, whether the sub-agent is running or not.
      if (unit.lastMessage && unit.repliedAt === null && at > unit.lastMessage.at) unit.repliedAt = at;
      const last = unit.runs[unit.runs.length - 1];
      if (!last || last[1] === null) break;
      pushRun(unit, [at, null]);
      unit.openTools.clear();
      addUnitFeed(state, parent, at, 'subagent-start', `resumed ${subLabel(parent)}`);
      break;
    }
    default:
      break;
  }
}

function onSubagentLifecycle(state, event, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  const agentId = event.agentId === undefined || event.agentId === null ? null : String(event.agentId);
  // Only subagent.configured has no tool-call id; it names the sub-agent by its agent id.
  const key = id ?? (event.type === 'subagent.configured' && agentId ? state.agentToTask.get(agentId) ?? null : null);
  if (!key) return;
  const entry = state.descendants.get(key) ?? null;
  const sub = state.subagents.get(key) ?? null;
  if (!sub && !entry) {
    const record = id ? state.evictedRunning.get(id) : null;
    if (!record) return;
    if (event.type === 'subagent.started') record.startedAt = at;
    else if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      finishEvicted(state, record, at, data.durationMs, event.type === 'subagent.failed' ? 'failed' : data.cancelled === true ? 'cancelled' : 'completed');
    }
    return;
  }
  // The record that carries the fields: the detail, or a direct child's kept detail. A deeper nested sub-agent has only its entry.
  const target = sub ?? childOf(state, key, entry);
  if (agentId !== null) {
    (sub ?? entry).agentId = agentId;
    if (target) target.agentId = agentId;
    state.agentToTask.set(agentId, key);
  }
  touchSubagent(state, key, at);
  if (event.type === 'subagent.configured') {
    if (target && typeof data.model === 'string') {
      target.model = data.model;
      target.modelObserved = true;
    }
    const effort = effortOf(data.reasoningEffort);
    if (target && effort) {
      target.effort = effort;
      target.effortConfigured = true;
    }
  } else if (event.type === 'subagent.started') {
    (sub ?? entry).startedAt = at;
    if (target) {
      if (typeof data.model === 'string') {
        target.model = data.model;
        target.modelObserved = true;
      }
      if (typeof data.agentDisplayName === 'string' && data.agentDisplayName) target.name = oneLine(data.agentDisplayName, 80);
      if (data.executionMode === 'background' || data.executionMode === 'sync') target.mode = data.executionMode;
      target.startedAt = at;
    }
    if (entry && (data.executionMode === 'background' || data.executionMode === 'sync')) entry.mode = data.executionMode;
    if (typeof data.agentType === 'string' && data.agentType) {
      if (sub) retypeSubagent(state, sub, oneLine(data.agentType, 60));
      else retypeNested(state, key, entry, oneLine(data.agentType, 60));
    }
  } else if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
    const status = event.type === 'subagent.failed' ? 'failed' : data.cancelled === true ? 'cancelled' : 'completed';
    if (!sub) {
      finishNested(state, key, entry, at, status, data.durationMs);
    } else if (sub.status === 'running') {
      const error = status === 'failed' && typeof data.error === 'string' ? oneLine(data.error, 200) : '';
      finishSubagent(state, sub, at, status, data.durationMs, error || null);
      // A root state reports its sub-agents in their units.
      if (!state.subagentUnits) addFeed(state, at, 'subagent-done', `${sub.type} ${sub.name} ${status === 'completed' ? 'finished' : status}`);
    }
  }
}

/** Moves the clock of a sub-agent and of every sub-agent above it, up to its top one. Only the top one and its kept children have a clock. */
function touchSubagent(state, owner, at) {
  let id = owner;
  for (let hops = 0; id && hops < MAX_NESTING; hops += 1) {
    const entry = state.descendants.get(id);
    const sub = entry ? childOf(state, id, entry) : state.subagents.get(id);
    if (sub && at > sub.lastEventAt) sub.lastEventAt = at;
    id = entry ? entry.parent : null;
  }
}

/**
 * Keeps at most LIMITS.subagents details in a merged state. A root state's units: every open one, then the
 * MAX_FINISHED_SUBAGENT_UNITS that finished last, then the most recently finished up to the limit, never dropping a protected one
 * (so the list can pass the limit by open units). Each closed unit it drops is counted in `unitsEvicted` by its outcome.
 * Any other state: running sub-agents first (the newest when there are too many), then the most recently finished.
 * The totals (count, per-type stats, index) are not touched.
 */
function capSubagents(merged) {
  if (merged.subagents.size <= LIMITS.subagents) return;
  const all = [...merged.subagents.values()];
  if (merged.subagentUnits) {
    const open = all.filter(isOpen);
    // Latest finish last; the sort is stable, so a tie keeps the map order.
    const closed = all.filter(sub => !isOpen(sub)).sort((a, b) => lastFinish(a) - lastFinish(b));
    const kept = Math.max(MAX_FINISHED_SUBAGENT_UNITS, LIMITS.subagents - open.length);
    const dropped = closed.slice(0, Math.max(0, closed.length - kept));
    for (const sub of dropped) merged.unitsEvicted[closedBucket(sub)] += 1;
    const gone = new Set(dropped);
    merged.subagents = new Map(all.filter(sub => !gone.has(sub)).sort((a, b) => a.launchedAt - b.launchedAt).map(sub => [sub.id, sub]));
    return;
  }
  const running = all.filter(sub => sub.status === 'running').sort((a, b) => a.launchedAt - b.launchedAt).slice(-LIMITS.subagents);
  const room = LIMITS.subagents - running.length;
  const finished = room > 0
    ? all.filter(sub => sub.status !== 'running').sort((a, b) => (a.endedAt ?? a.launchedAt) - (b.endedAt ?? b.launchedAt)).slice(-room)
    : [];
  merged.subagents = new Map([...finished, ...running].sort((a, b) => a.launchedAt - b.launchedAt).map(sub => [sub.id, sub]));
}

/** Aggregate of one project session's CLI sessions, oldest first. Live fields stay empty. */
export function mergeStates(states) {
  const merged = createSessionState(states.map(state => state.id).join('+') || 'none');
  for (const state of states) {
    merged.lines += state.lines;
    merged.parseErrors += state.parseErrors;
    merged.firstEventAt = minTime(merged.firstEventAt, state.firstEventAt);
    if (state.lastEventAt !== null && (merged.lastEventAt === null || state.lastEventAt >= merged.lastEventAt)) {
      merged.lastEventAt = state.lastEventAt;
      merged.lastEventType = state.lastEventType;
    }
    merged.copilotVersion = state.copilotVersion ?? merged.copilotVersion;
    merged.model = state.model ?? merged.model;
    merged.effort = state.effort ?? merged.effort;
    merged.busyMs += state.busyMs;
    merged.waitingMs += state.waitingMs;
    merged.waitDroppedMs += state.waitDroppedMs;
    merged.busySpans.push(...state.busySpans);
    merged.waitSpans.push(...state.waitSpans);
    for (const [id, sub] of state.subagents) merged.subagents.set(id, sub);
    for (const [id, entry] of state.descendants) merged.descendants.set(id, entry);
    for (const key of Object.keys(merged.subagentOutcomes)) merged.subagentOutcomes[key] += state.subagentOutcomes[key];
    merged.subagentUnits ||= state.subagentUnits;
    for (const key of Object.keys(merged.unitsEvicted)) merged.unitsEvicted[key] += state.unitsEvicted[key];
    merged.subagentCount += state.subagentCount;
    for (const [type, entry] of state.subagentStats) {
      const target = statsEntry(merged.subagentStats, typeBucket(merged.subagentStats, type));
      target.runs += entry.runs;
      target.durationMs += entry.durationMs;
    }
    for (const [id, type] of state.subagentIndex) {
      merged.subagentIndex.delete(id);
      merged.subagentIndex.set(id, merged.subagentStats.has(type) ? type : 'other');
    }
    merged.sent.push(...state.sent);
    merged.inbound.push(...state.inbound);
    // Reply times per sender across the CLI sessions (`seq` has no meaning in the merged view); sorted and bounded after the loop.
    for (const [sender, entry] of state.replyIndex) {
      const target = merged.replyIndex.get(sender) ?? { seq: -1, times: [] };
      target.times.push(...entry.times);
      merged.replyIndex.set(sender, target);
    }
    merged.taskCompletes.push(...state.taskCompletes);
    merged.automation.saves.push(...state.automation.saves);
    merged.automation.wakes.push(...state.automation.wakes);
    merged.feed.push(...state.feed);
    merged.marks.push(...state.marks);
    for (const [key, value] of state.prMentions) {
      const entry = merged.prMentions.get(key);
      merged.prMentions.set(key, entry
        ? { ...entry, count: entry.count + value.count, firstAt: Math.min(entry.firstAt, value.firstAt), lastAt: Math.max(entry.lastAt, value.lastAt) }
        : { ...value });
    }
    merged.lastInboundAt = maxTime(merged.lastInboundAt, state.lastInboundAt);
    merged.lastHumanAt = maxTime(merged.lastHumanAt, state.lastHumanAt);
    merged.lastTurnEndAt = maxTime(merged.lastTurnEndAt, state.lastTurnEndAt);
    merged.shutdownAt = maxTime(merged.shutdownAt, state.shutdownAt);
    merged.abortAt = maxTime(merged.abortAt, state.abortAt);
    merged.lastErrorAt = maxTime(merged.lastErrorAt, state.lastErrorAt);
  }
  while (merged.subagentIndex.size > LIMITS.subagentIndex) merged.subagentIndex.delete(merged.subagentIndex.keys().next().value);
  while (merged.descendants.size > LIMITS.subagentIndex) merged.descendants.delete(merged.descendants.keys().next().value);
  const byAt = (a, b) => a.at - b.at;
  for (const entry of merged.replyIndex.values()) {
    entry.times.sort((a, b) => a - b);
    if (entry.times.length > LIMITS.replyTimes) entry.times.splice(0, entry.times.length - LIMITS.replyTimes);
  }
  while (merged.replyIndex.size > LIMITS.replySenders) merged.replyIndex.delete(merged.replyIndex.keys().next().value);
  capSubagents(merged);
  for (const list of [merged.sent, merged.inbound, merged.taskCompletes, merged.feed, merged.marks, merged.automation.saves]) list.sort(byAt);
  merged.automation.wakes.sort((a, b) => a - b);
  merged.busySpans.sort((a, b) => a[0] - b[0]);
  merged.waitSpans.sort((a, b) => a[0] - b[0]);
  return merged;
}
