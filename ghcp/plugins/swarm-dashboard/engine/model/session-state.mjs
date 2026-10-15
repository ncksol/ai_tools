import { clip, oneLine, ownString } from '../text.mjs';
import { parseTime } from '../time.mjs';
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

const argsOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : typeof value === 'string' ? { raw: value } : {});
const numberOrNull = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

export function createSessionState(id) {
  return {
    id, lines: 0, parseErrors: 0, firstEventAt: null, lastEventAt: null, lastEventType: null, lastMainAt: null,
    copilotVersion: null, model: null, mode: null,
    turn: null, busySince: null, lastTurnEndAt: null, busySpans: [], busyMs: 0,
    openTools: new Map(), waits: new Map(), waitSpans: [], waitingMs: 0,
    subagents: new Map(), agentToTask: new Map(),
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
      onUserMessage(state, data, at);
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

function onUserMessage(state, data, at) {
  state.lastInboundAt = at;
  if (state.turn) state.turn.progressAt = at;
  if (data.source === undefined || data.source === null) state.lastHumanAt = at;
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

function finishSubagent(sub, at, status, durationMs) {
  sub.status = status;
  sub.endedAt = Math.max(at, sub.launchedAt);
  sub.durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : Math.max(0, sub.endedAt - (sub.startedAt ?? sub.launchedAt));
}

/** Work that cannot outlive the turn or process: open waits, tools and running sub-agents. */
function endOpenWork(state, at, keepBackground) {
  for (const [id, wait] of state.waits) closeWait(state, id, wait, at);
  state.openTools.clear();
  for (const sub of state.subagents.values()) {
    if (sub.status !== 'running' || (keepBackground && sub.mode === 'background')) continue;
    finishSubagent(sub, at, 'failed', null);
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
  return ownString(`${name}|${text.length}|${text.slice(0, 400)}`);
}

function newSubagent(state, id, at, args) {
  const sub = {
    id,
    name: oneLine(args.name ?? args.description ?? 'sub-agent', 80) || 'sub-agent',
    type: oneLine(args.agent_type ?? 'task', 60) || 'task',
    mode: args.mode === 'background' ? 'background' : 'sync',
    model: typeof args.model === 'string' ? args.model : null,
    effort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : null,
    task: typeof args.description === 'string' ? oneLine(args.description, 200) : null,
    launchedAt: at, startedAt: null, endedAt: null, durationMs: null, status: 'running', lastEventAt: at, agentId: null,
  };
  state.subagents.set(id, sub);
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
    const sub = newSubagent(state, id, at, args);
    addFeed(state, at, 'subagent-start', `started ${sub.type}: ${sub.name}${sub.mode === 'sync' ? ' (sync)' : ''}`);
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
      finishSubagent(sub, at, data.success === false ? 'failed' : 'completed', null);
    }
  }
}

function onSubagentLifecycle(state, event, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  const sub = state.subagents.get(id) ?? newSubagent(state, id, at, {});
  if (event.agentId !== undefined && event.agentId !== null) {
    sub.agentId = String(event.agentId);
    state.agentToTask.set(sub.agentId, id);
  }
  if (at > sub.lastEventAt) sub.lastEventAt = at;
  if (event.type === 'subagent.started') {
    sub.startedAt = at;
    if (typeof data.model === 'string') sub.model = data.model;
    if (typeof data.agentType === 'string' && data.agentType) sub.type = oneLine(data.agentType, 60);
    if (typeof data.agentDisplayName === 'string' && data.agentDisplayName) sub.name = oneLine(data.agentDisplayName, 80);
    if (data.executionMode === 'background' || data.executionMode === 'sync') sub.mode = data.executionMode;
  } else if ((event.type === 'subagent.completed' || event.type === 'subagent.failed') && sub.status === 'running') {
    finishSubagent(sub, at, event.type === 'subagent.failed' ? 'failed' : 'completed', data.durationMs);
    addFeed(state, at, 'subagent-done', `${sub.type} ${sub.name} ${sub.status === 'failed' ? 'failed' : 'finished'}`);
  }
}

function touchSubagent(state, owner, at) {
  const sub = owner ? state.subagents.get(owner) : null;
  if (sub && at > sub.lastEventAt) sub.lastEventAt = at;
}
