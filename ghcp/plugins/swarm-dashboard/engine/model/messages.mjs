import { clip, ownString } from '../text.mjs';
import { LIMITS, addFeed, addMark, pushBounded } from './state-utils.mjs';

const PR_PATTERNS = [
  { provider: 'ado', re: /\/pullrequest\/(\d{1,9})\b/gi },
  { provider: 'ado', re: /(?:^|[\s(])!(\d{2,9})\b/gm },
  { provider: null, re: /\bPR\s*#?(\d{1,9})\b/gi },
];

function dropOldestMention(mentions) {
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [key, entry] of mentions) {
    if (entry.lastAt < oldestAt) {
      oldestAt = entry.lastAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) mentions.delete(oldestKey);
}

/** Count PR references for the Azure DevOps heuristic: !123 and /pullrequest/123, and a bare "PR #12" (provider unknown). */
export function countPrMentions(state, text, at) {
  if (typeof text !== 'string' || !text) return;
  for (const { provider, re } of PR_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const id = Number(match[1]);
      if (!Number.isInteger(id) || id <= 0) continue;
      const key = `${provider ?? 'any'}::${id}`;
      let entry = state.prMentions.get(key);
      if (!entry) {
        if (state.prMentions.size >= LIMITS.prMentions) dropOldestMention(state.prMentions);
        entry = { provider, repo: null, id, count: 0, firstAt: at, lastAt: at };
      }
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, at);
      state.prMentions.set(key, entry);
    }
  }
}

/** Fields of the app's <cross_session_message> envelope, which lives only in transformedContent. */
export function parseEnvelope(transformed) {
  const start = transformed.indexOf('<cross_session_message>');
  if (start < 0) return null;
  const end = transformed.indexOf('</cross_session_message>', start);
  const block = transformed.slice(start, end < 0 ? undefined : end);
  const field = name => {
    const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(block);
    return match && match[1].trim() ? ownString(match[1].trim()) : null;
  };
  const fromSessionId = field('from_session_id');
  const fromProjectSessionId = field('from_project_session_id');
  if (!fromSessionId && !fromProjectSessionId) return null;
  return {
    fromSessionId,
    fromProjectSessionId,
    fromName: field('from_project_session_name') ?? field('from_display_name'),
    sourceToolCallId: field('source_tool_call_id'),
  };
}

export function recordUserMessage(state, data, at) {
  state.lastInboundAt = at;
  if (state.turn) state.turn.progressAt = at;
  const transformed = typeof data.transformedContent === 'string' ? data.transformedContent : '';
  if (data.source === 'system' && transformed.includes('<session_automation')) {
    pushBounded(state.automation.wakes, at, LIMITS.wakes);
    addMark(state, at, 'monitor', 'PR monitor check');
    addFeed(state, at, 'monitor-check', 'PR monitor check');
    return;
  }
  const envelope = transformed.includes('<cross_session_message>') ? parseEnvelope(transformed) : null;
  if (envelope) {
    const content = typeof data.content === 'string' ? data.content : '';
    pushBounded(state.inbound, { at, ...envelope, content: clip(content, 8000) ?? '' }, LIMITS.inbound);
    noteReply(state, envelope, at);
    return;
  }
  if (data.source === undefined || data.source === null) state.lastHumanAt = at;
}

/** Notes the first message from each sender (its session id and its project session id) after the session's latest outbound event. */
function noteReply(state, envelope, at) {
  for (const id of new Set([envelope.fromSessionId, envelope.fromProjectSessionId])) {
    if (!id) continue;
    let entry = state.replyIndex.get(id);
    if (!entry) {
      if (state.replyIndex.size >= LIMITS.replySenders) state.replyIndex.delete(state.replyIndex.keys().next().value);
      entry = { seq: -1, times: [] };
      state.replyIndex.set(id, entry);
    }
    if (entry.seq === state.outboundSeq) continue;
    entry.seq = state.outboundSeq;
    pushBounded(entry.times, at, LIMITS.replyTimes);
  }
}

export function recordToolStart(state, name, args, callId, at) {
  if (name === 'send_session_message') {
    state.outboundSeq += 1;
    const message = clip(typeof args.message === 'string' ? args.message : '', 8000) ?? '';
    pushBounded(state.sent, {
      at, toolCallId: callId, source: state.source, target: typeof args.session_id === 'string' ? args.session_id : null,
      purpose: typeof args.purpose === 'string' ? args.purpose : null, message, failed: false,
    }, LIMITS.sent);
    countPrMentions(state, message, at);
  } else if (name === 'save_session_automation') {
    const clear = args.clear === true || args.clear === 'true';
    const minutes = Number(args.every_minutes);
    const everyMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
    pushBounded(state.automation.saves, { at, clear, everyMinutes, target: typeof args.session_id === 'string' ? args.session_id : null }, LIMITS.saves);
    addFeed(state, at, clear ? 'monitor-cleared' : 'monitor-set', clear ? 'stopped its PR monitor' : `started a PR monitor${everyMinutes ? ` (every ${everyMinutes} min)` : ''}`);
  }
}

export function recordToolComplete(state, callId, data) {
  if (data.success !== false) return;
  const entry = state.sent.find(item => item.toolCallId === callId);
  if (entry) entry.failed = true;
}

export function recordTaskComplete(state, data, at) {
  state.outboundSeq += 1;
  const summary = clip(typeof data.summary === 'string' ? data.summary : '', 4000) ?? '';
  const success = data.success !== false;
  pushBounded(state.taskCompletes, { at, success, summary }, LIMITS.taskCompletes);
  countPrMentions(state, summary, at);
  addFeed(state, at, 'task-complete', success ? 'completed a task' : 'reported a failed task');
}
