import { createHash } from 'node:crypto';
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
const WAIT_TOOLS = { ask_user: 'question', exit_plan_mode: 'plan' };
const BUSY_JOIN_MS = 5000;

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

export function createSessionState(id) {
  return {
    id, lines: 0, parseErrors: 0, firstEventAt: null, lastEventAt: null, lastEventType: null, lastMainAt: null,
    copilotVersion: null, model: null, mode: null,
    turn: null, busySince: null, lastTurnEndAt: null, busySpans: [], busyMs: 0,
    openTools: new Map(), waits: new Map(), waitSpans: [], waitingMs: 0,
    subagents: new Map(), agentToTask: new Map(),
    // Whole-session sub-agent totals that the capped detail list never changes: launches, per type runs and finished
    // duration, and each task tool-call id's type (to attribute ledger credits by type).
    subagentCount: 0, subagentStats: new Map(), subagentIndex: new Map(),
    sent: [], inbound: [], lastInboundAt: null, lastHumanAt: null, taskCompletes: [],
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
    touchSubagent(state, owner, at);
    return;
  }
  if (event.type === 'user.message' && data.source === `agent-${state.id}`) return;
  onMainEvent(state, event.type, data, at);
  state.lastMainAt = at;
}

function onMainEvent(state, type, data, at) {
  switch (type) {
    case 'session.start':
    case 'session.resume':
      endProcess(state, state.lastMainAt ?? at);
      if (typeof data.copilotVersion === 'string') state.copilotVersion = data.copilotVersion;
      if (typeof data.selectedModel === 'string') state.model = data.selectedModel;
      break;
    case 'session.model_change':
      if (typeof data.newModel === 'string') state.model = data.newModel;
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
  pushBounded(state.waitSpans, [wait.startedAt, end, wait.kind], LIMITS.spans);
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

/** The single place a sub-agent leaves 'running'. Adds its duration to the per-type totals, once. */
function finishSubagent(state, sub, at, status, durationMs) {
  if (sub.status !== 'running') return;
  sub.status = status;
  sub.endedAt = Math.max(at, sub.launchedAt);
  sub.durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : Math.max(0, sub.endedAt - (sub.startedAt ?? sub.launchedAt));
  statsEntry(state.subagentStats, sub.bucket).durationMs += sub.durationMs;
}

/** Moves a sub-agent's run (and finished duration) to another type when its start event names a different one. */
function retypeSubagent(state, sub, type) {
  sub.type = type;
  if (typeBucket(state.subagentStats, type) === sub.bucket) return;
  const from = statsEntry(state.subagentStats, sub.bucket);
  from.runs -= 1;
  if (sub.durationMs !== null) from.durationMs -= sub.durationMs;
  // An old type with no runs left is dropped, so it neither shows in the totals nor holds one of the type slots.
  if (from.runs <= 0) state.subagentStats.delete(sub.bucket);
  const bucket = typeBucket(state.subagentStats, type);
  const to = statsEntry(state.subagentStats, bucket);
  to.runs += 1;
  if (sub.durationMs !== null) to.durationMs += sub.durationMs;
  sub.bucket = bucket;
  if (state.subagentIndex.has(sub.id)) state.subagentIndex.set(sub.id, bucket);
}

/** Work that cannot outlive the turn or process: open waits, tools and running sub-agents. */
function endOpenWork(state, at, keepBackground) {
  for (const [id, wait] of state.waits) closeWait(state, id, wait, at);
  state.openTools.clear();
  for (const sub of state.subagents.values()) {
    if (sub.status !== 'running' || (keepBackground && sub.mode === 'background')) continue;
    finishSubagent(state, sub, at, 'failed', null);
  }
}

function endProcess(state, at) {
  closeTurn(state, at);
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

/** Drops the oldest finished sub-agent from the detail list, or the oldest running one when none has finished. */
function evictSubagent(state) {
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
}

/**
 * A sub-agent is counted once per task tool-call id. A repeated start for an id that is still in the details updates them;
 * for an id that only the type index remembers (evicted from the details) the details are restored. Neither changes the counts.
 */
function newSubagent(state, id, at, args) {
  const fields = {
    name: oneLine(args.name ?? args.description ?? 'sub-agent', 80) || 'sub-agent',
    type: oneLine(args.agent_type ?? 'task', 60) || 'task',
    mode: args.mode === 'background' ? 'background' : 'sync',
    model: typeof args.model === 'string' ? args.model : null,
    effort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : null,
    task: typeof args.description === 'string' ? oneLine(args.description, 200) : null,
  };
  const known = state.subagents.get(id);
  if (known) {
    const { type, ...rest } = fields;
    Object.assign(known, rest);
    retypeSubagent(state, known, type);
    return known;
  }
  const indexed = state.subagentIndex.get(id);
  const sub = { id, ...fields, launchedAt: at, startedAt: null, endedAt: null, durationMs: null, status: 'running', lastEventAt: at, agentId: null };
  if (indexed === undefined) {
    sub.bucket = typeBucket(state.subagentStats, sub.type);
    state.subagentCount += 1;
    statsEntry(state.subagentStats, sub.bucket).runs += 1;
    state.subagentIndex.set(id, sub.bucket);
    while (state.subagentIndex.size > LIMITS.subagentIndex) state.subagentIndex.delete(state.subagentIndex.keys().next().value);
  } else {
    sub.bucket = indexed;
    retypeSubagent(state, sub, sub.type);
  }
  state.subagents.set(id, sub);
  while (state.subagents.size > LIMITS.subagents) evictSubagent(state);
  return sub;
}

function onToolStart(state, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  const name = typeof data.toolName === 'string' ? data.toolName : 'tool';
  const args = argsOf(data.arguments);
  state.openTools.set(id, { id, name, startedAt: at, args: toolArgs(name, args) });
  pushBounded(state.recent.calls, { at, name, key: callKey(name, data.arguments), prompt: state.prompts }, LIMITS.recent);
  const kind = WAIT_TOOLS[name];
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
    if (!repeated) addFeed(state, at, 'subagent-start', `started ${sub.type}: ${sub.name}${sub.mode === 'sync' ? ' (sync)' : ''}`);
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
  }
  recordToolComplete(state, id, data);
}

function onSubagentLifecycle(state, event, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  const sub = state.subagents.get(id);
  if (!sub) return;
  if (event.agentId !== undefined && event.agentId !== null) {
    sub.agentId = String(event.agentId);
    state.agentToTask.set(sub.agentId, id);
  }
  if (at > sub.lastEventAt) sub.lastEventAt = at;
  if (event.type === 'subagent.started') {
    sub.startedAt = at;
    if (typeof data.model === 'string') sub.model = data.model;
    if (typeof data.agentType === 'string' && data.agentType) retypeSubagent(state, sub, oneLine(data.agentType, 60));
    if (typeof data.agentDisplayName === 'string' && data.agentDisplayName) sub.name = oneLine(data.agentDisplayName, 80);
    if (data.executionMode === 'background' || data.executionMode === 'sync') sub.mode = data.executionMode;
  } else if ((event.type === 'subagent.completed' || event.type === 'subagent.failed') && sub.status === 'running') {
    finishSubagent(state, sub, at, event.type === 'subagent.failed' ? 'failed' : 'completed', data.durationMs);
    addFeed(state, at, 'subagent-done', `${sub.type} ${sub.name} ${sub.status === 'failed' ? 'failed' : 'finished'}`);
  }
}

function touchSubagent(state, owner, at) {
  const sub = owner ? state.subagents.get(owner) : null;
  if (sub && at > sub.lastEventAt) sub.lastEventAt = at;
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
    merged.busyMs += state.busyMs;
    merged.waitingMs += state.waitingMs;
    merged.busySpans.push(...state.busySpans);
    merged.waitSpans.push(...state.waitSpans);
    for (const [id, sub] of state.subagents) merged.subagents.set(id, sub);
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
  const byAt = (a, b) => a.at - b.at;
  for (const list of [merged.sent, merged.inbound, merged.taskCompletes, merged.feed, merged.marks, merged.automation.saves]) list.sort(byAt);
  merged.automation.wakes.sort((a, b) => a - b);
  merged.busySpans.sort((a, b) => a[0] - b[0]);
  merged.waitSpans.sort((a, b) => a[0] - b[0]);
  return merged;
}
