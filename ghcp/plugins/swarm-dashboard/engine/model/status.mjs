import { formatDuration } from '../time.mjs';

/** Details that keep a run live: real work, a hang, or a wait on the user inside an open turn. */
export const ACTIVE_DETAILS = new Set([
  'busy', 'slow_model_call', 'silent', 'stuck_model_call', 'stuck_tool', 'stuck_subagent', 'spinning', 'waiting_question', 'waiting_plan',
]);

const DISPLAY = {
  busy: ['busy', 'working'],
  slow_model_call: ['busy', 'working'],
  silent: ['stuck', 'stuck'],
  stuck_model_call: ['stuck', 'stuck'],
  stuck_tool: ['stuck', 'stuck'],
  stuck_subagent: ['stuck', 'stuck'],
  spinning: ['stuck', 'stuck'],
  stalled: ['stuck', 'stuck'],
  waiting_question: ['question', 'waiting'],
  waiting_plan: ['plan', 'waiting'],
  blocked: ['blocked', 'waiting'],
  blocked_on_orchestrator: ['blocked', 'waiting'],
  idle: ['idle', 'idle'],
  stopped: ['idle', 'idle'],
  crashed: ['blocked', 'failed'],
  failed: ['blocked', 'failed'],
  completed: ['done', 'done'],
  cancelled: ['blocked', 'failed'],
  merged: ['merged', 'done'],
  archived: ['archived', 'done'],
};

export function displayOf(detail) {
  const [status, bucket] = DISPLAY[detail];
  return { status, bucket };
}

const QUICK_TOOLS = new Set([
  'create_session', 'send_session_message', 'get_session', 'get_sessions_status', 'list_sessions_and_chats', 'archive_session',
  'answer_session_input', 'respond_to_session_plan_v2', 'navigate_to', 'open_canvas', 'invoke_canvas_action', 'list_canvas_capabilities',
  'rename_session', 'rename_branch', 'save_session_automation', 'get_session_automation', 'list_projects', 'publish_chat_update',
  'view', 'create', 'edit', 'apply_patch', 'str_replace_editor', 'grep', 'glob', 'rg', 'tool_search_tool', 'sql', 'store_memory', 'vote_memory', 'skill',
]);
const POLLING_TOOLS = new Set(['read_bash', 'read_agent', 'list_agents', 'list_bash', 'get_session', 'get_sessions_status', 'list_sessions_and_chats', 'get_session_automation']);
const IDLE_DETAILS = new Set(['idle', 'stopped', 'crashed', 'failed', 'stalled', 'blocked', 'blocked_on_orchestrator']);
/** Units that are over: they neither keep a swarm busy nor count as idle work. */
const ENDED_DETAILS = new Set(['archived', 'merged', 'completed', 'cancelled']);

/** The design's tool rule: bash initial_wait + 5 min (10 min without one); read_bash delay + 2 min; read_agent timeout + 2 min; quick tools 2 min. */
export function toolLimitMs(tool, t) {
  const args = tool.args ?? {};
  switch (tool.name) {
    case 'bash':
      if (args.mode === 'async') return t.quickToolMs;
      return args.initialWait > 0 ? args.initialWait * 1000 + t.bashExtraMs : t.bashDefaultMs;
    case 'read_bash':
      return (args.delay > 0 ? args.delay * 1000 : 0) + t.readBashExtraMs;
    case 'read_agent':
      return (args.timeout > 0 ? args.timeout * 1000 : args.wait ? 30_000 : 0) + t.readAgentExtraMs;
    default:
      return QUICK_TOOLS.has(tool.name) ? t.quickToolMs : null;
  }
}

function limitNote(tool, t) {
  const args = tool.args ?? {};
  if (tool.name !== 'bash' || args.mode === 'async') return '';
  return args.initialWait > 0 ? ` (initial_wait ${formatDuration(args.initialWait * 1000)} + ${formatDuration(t.bashExtraMs)})` : ' (no initial_wait)';
}

export function subagentLimitMs(sub, t) {
  const heavy = sub.type === 'general-purpose' && /opus/i.test(sub.model ?? '') && sub.effort === 'max';
  return heavy ? t.subagentSilentHeavyMs : t.subagentSilentMs;
}

export function toolView(tool, limitMs) {
  return { id: tool.id, name: tool.name, summary: tool.args?.summary ?? tool.name, startedAt: tool.startedAt, limitMs: limitMs ?? null };
}

/** Start of the most recent `windowMs` of busy time, counting the open turn up to now. */
export function busyWindowStart(state, now, windowMs) {
  const spans = state.turn ? [...state.busySpans, [state.turn.startedAt, now]] : state.busySpans;
  let remaining = windowMs;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const [start, end] = spans[i];
    if (end - start >= remaining) return end - remaining;
    remaining -= end - start;
  }
  return spans.length ? spans[0][0] : now;
}

/**
 * The running sub-agents of a state that count as stuck (they make the orchestrator's chip `stuck`). One with a unit is judged by
 * the unit rule (evaluateSubagentUnit): stuck_tool or stuck_subagent. Any other is stuck after a silence past its limit.
 */
function findStuckSubagents(state, now, t) {
  const stuck = new Set();
  if (!state) return stuck;
  for (const sub of state.subagents.values()) {
    if (sub.status !== 'running') continue;
    if (sub.unit) {
      const { detail } = evaluateSubagentUnit(sub, { alive: true, now, thresholds: t });
      if (detail === 'stuck_tool' || detail === 'stuck_subagent') stuck.add(sub.id);
    } else if (now - sub.lastEventAt > subagentLimitMs(sub, t)) {
      stuck.add(sub.id);
    }
  }
  return stuck;
}

function spinningReason(state, now, t) {
  const from = busyWindowStart(state, now, t.spinningWindowMs);
  const inWindow = list => list.filter(at => at >= from).length;
  const failures = inWindow(state.recent.failures);
  if (failures >= t.spinningFailures) return `${failures} failed tool calls`;
  let run = 0;
  let longest = 0;
  let previous = null;
  for (const call of state.recent.calls) {
    if (call.at < from || call.prompt !== state.prompts || POLLING_TOOLS.has(call.name)) continue;
    const key = call.key;
    run = key === previous ? run + 1 : 1;
    previous = key;
    longest = Math.max(longest, run);
  }
  if (longest >= t.spinningRepeats) return `the same tool call ${longest} times in a row`;
  const compactions = state.recent.compactions.filter(at => at >= from && now - at <= t.spinningWindowMs).length;
  if (compactions >= t.spinningCompactions) return `${compactions} context compactions within ${formatDuration(t.spinningWindowMs)}`;
  if (inWindow(state.recent.denials) > 0) return 'a permission request denied with no one to ask';
  return null;
}

export function evaluateStatus(input) {
  const { state, alive, archivedAt, now } = input;
  const t = input.thresholds;
  const stuckSubagents = findStuckSubagents(state, now, t);
  const lastAt = state?.lastEventAt ?? input.startedAt;
  const result = (detail, since, reason = null, tool = null) => ({ detail, since: Math.min(since ?? now, now), reason, tool, stuckSubagents });
  const turnOpen = Boolean(state?.turn);
  const lastTask = state?.taskCompletes.length ? state.taskCompletes[state.taskCompletes.length - 1] : null;

  // A failed outcome comes first, so an archived failed unit still counts as failed.
  if (input.outcome === 'failed') return result('failed', lastAt, 'The orchestrator recorded this unit as failed.');
  if (archivedAt !== null && archivedAt !== undefined) return result('archived', archivedAt);
  if (input.merged && !turnOpen) return result('merged', input.mergedAt ?? lastAt);
  if (alive === false) {
    if (state?.lastEventType === 'session.shutdown') return result('stopped', state.shutdownAt ?? lastAt, 'The session process exited normally.');
    return result('crashed', lastAt, `The session process ended without a shutdown event${turnOpen || input.isRunningFlag ? ' while it was working' : ''}.`);
  }
  if (!input.hasRegistry && !turnOpen && lastTask && lastTask.success === false) {
    return result('failed', lastTask.at, 'Its last task ended unsuccessfully.');
  }
  if (state && state.waits.size) {
    const wait = [...state.waits.values()].reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
    return result(wait.kind === 'plan' ? 'waiting_plan' : 'waiting_question', wait.startedAt);
  }
  const openTools = state ? [...state.openTools.values()].sort((a, b) => a.startedAt - b.startedAt) : [];
  for (const tool of openTools) {
    const limit = toolLimitMs(tool, t);
    if (limit !== null && now - tool.startedAt > limit) {
      return result('stuck_tool', tool.startedAt,
        `${tool.name} has run for ${formatDuration(now - tool.startedAt)} with a limit of ${formatDuration(limit)}${limitNote(tool, t)}.`,
        toolView(tool, limit));
    }
  }
  if (stuckSubagents.size) {
    const sub = state.subagents.get([...stuckSubagents][0]);
    // A sub-agent with a unit that is stuck on a tool call gets the unit's reason, so both views say the same.
    const unitEvaluation = sub.unit ? evaluateSubagentUnit(sub, { alive: true, now, thresholds: t }) : null;
    if (unitEvaluation?.detail === 'stuck_tool') {
      return result('stuck_subagent', unitEvaluation.since, `Sub-agent ${sub.name} (${sub.type}): ${unitEvaluation.reason}`);
    }
    return result('stuck_subagent', sub.lastEventAt,
      `Sub-agent ${sub.name} (${sub.type}) has had no events for ${formatDuration(now - sub.lastEventAt)}; the limit is ${formatDuration(subagentLimitMs(sub, t))}.`);
  }
  if (turnOpen && !openTools.length && now - state.turn.progressAt >= t.modelCallStuckMs) {
    return result('stuck_model_call', state.turn.progressAt,
      `No model response for ${formatDuration(now - state.turn.progressAt)}; the limit is ${formatDuration(t.modelCallStuckMs)}.`);
  }
  const ownLimit = openTools.some(tool => (tool.name === 'task' ? state.subagents.get(tool.id)?.status === 'running' : toolLimitMs(tool, t) !== null));
  if ((turnOpen || input.isRunningFlag) && !ownLimit && now - lastAt >= t.silentBusyMs) {
    return result('silent', lastAt, `Busy, but its log has had no new line for ${formatDuration(now - lastAt)}; the limit is ${formatDuration(t.silentBusyMs)}.`);
  }
  if (turnOpen) {
    const why = spinningReason(state, now, t);
    if (why) return result('spinning', busyWindowStart(state, now, t.spinningWindowMs), `In its last ${formatDuration(t.spinningWindowMs)} of busy time: ${why}.`);
    const since = state.busySince ?? state.turn.startedAt;
    if (!openTools.length && now - state.turn.progressAt >= t.modelCallWarnMs) {
      return result('slow_model_call', since,
        `Waiting ${formatDuration(now - state.turn.progressAt)} for a model response; it counts as stuck after ${formatDuration(t.modelCallStuckMs)}.`);
    }
    return result('busy', since);
  }
  const idleSince = state?.lastTurnEndAt ?? lastAt;
  const report = input.report;
  const replied = Boolean(report) && input.parentRepliedAt !== null && input.parentRepliedAt !== undefined && input.parentRepliedAt > report.at;
  if (report && !replied && report.status === 'blocked') return result('blocked', report.at, 'Its latest report says it is blocked.');
  if (report && !replied && report.status === 'needs_input') {
    return result('blocked_on_orchestrator', report.at, 'It asked the orchestrator for input and has had no reply.');
  }
  if (report && report.status === 'progress' && now - idleSince >= t.stalledIdleMs) {
    const completed = Boolean(lastTask) && state.lastInboundAt !== null && lastTask.at >= state.lastInboundAt;
    const monitorDue = input.monitorDueAt !== null && input.monitorDueAt !== undefined && input.monitorDueAt > now - t.monitorGraceMs;
    if (!completed && !monitorDue) {
      return result('stalled', idleSince, `Idle for ${formatDuration(now - idleSince)} after a progress report, with no completed task and no monitor due.`);
    }
  }
  return result('idle', idleSince);
}

export function swarmStalled({ orchestratorDetail, unitDetails, monitorDue, lastActivityAt }) {
  if (!IDLE_DETAILS.has(orchestratorDetail) || monitorDue) return null;
  const open = unitDetails.filter(detail => !ENDED_DETAILS.has(detail));
  if (!open.length || !open.every(detail => IDLE_DETAILS.has(detail))) return null;
  return { since: lastActivityAt, reason: 'The orchestrator and every open unit are idle or ended, and no monitor is due.' };
}

/**
 * Status of one of the root orchestrator's one-off sub-agents, from its unit (see session-state.mjs). It is running while its last
 * run is open: crashed when the orchestrator's process is gone; then judged like a session is.
 * An open tool call that has its own limit and has run past it is stuck_tool (the first such one, oldest first), with the same
 * reason text as a session. While any open tool has its own limit, that limit applies instead of the silence limit. With none,
 * a silence longer than the sub-agent's limit is stuck_subagent (a `task` call has no limit of its own, so a sub-agent that waits
 * on a sync child keeps this rule, and its child's events move the clock). Otherwise it is busy.
 * Once its last run has closed it is failed, cancelled or completed, and `endedAt` is the end of that run.
 * `tool` is the stuck tool call (a tool view), else null.
 * @returns {{ detail: string, since: number, reason: string|null, endedAt: number|null, tool: object|null }}
 */
export function evaluateSubagentUnit(sub, { alive, now, thresholds }) {
  const { unit } = sub;
  const last = unit.runs[unit.runs.length - 1];
  if (last[1] === null) {
    if (alive === false) {
      return { detail: 'crashed', since: sub.lastEventAt, reason: 'The orchestrator\'s process ended while this sub-agent was running.', endedAt: sub.lastEventAt, tool: null };
    }
    let hasOwnLimit = false;
    for (const tool of [...unit.openTools.values()].sort((a, b) => a.startedAt - b.startedAt)) {
      const limit = toolLimitMs(tool, thresholds);
      if (limit === null) continue;
      hasOwnLimit = true;
      if (now - tool.startedAt > limit) {
        return {
          detail: 'stuck_tool', since: tool.startedAt,
          reason: `${tool.name} has run for ${formatDuration(now - tool.startedAt)} with a limit of ${formatDuration(limit)}${limitNote(tool, thresholds)}.`,
          endedAt: null, tool: toolView(tool, limit),
        };
      }
    }
    const limit = subagentLimitMs(sub, thresholds);
    if (!hasOwnLimit && now - sub.lastEventAt > limit) {
      return {
        detail: 'stuck_subagent', since: Math.min(sub.lastEventAt, now),
        reason: `No events for ${formatDuration(now - sub.lastEventAt)}; the limit is ${formatDuration(limit)}.`, endedAt: null, tool: null,
      };
    }
    return { detail: 'busy', since: Math.min(last[0], now), reason: null, endedAt: null, tool: null };
  }
  const ended = { since: last[1], endedAt: last[1], tool: null };
  // The outcome of the last run: a follow-up can end differently from the chip (cut off by an abort or the end of the process).
  const outcome = unit.lastOutcome ?? sub.status;
  if (outcome === 'failed') return { detail: 'failed', reason: unit.error ? `Failed: ${unit.error}` : 'Failed.', ...ended };
  if (outcome === 'cancelled') {
    return { detail: 'cancelled', reason: `Cancelled after ${formatDuration(last[1] - last[0])}.`, ...ended };
  }
  return { detail: 'completed', reason: null, ...ended };
}
