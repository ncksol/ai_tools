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

export const NO_HANDOFF_NOTICE = 'The session finished without sending a handoff.';
const RESULTS_SOURCE = 'agent-coordinator-results';
const RECORD_RE = /^\d+\. (\{[^\r\n]*\})$/gm;

const resultId = value => typeof value === 'string' && value.trim() ? ownString(value) : null;

/** Project results are numbered JSON records. Keep only the IDs and display text, never metadata supplied by the handoff. */
export function parseResultRecords(content) {
  const records = [];
  if (typeof content !== 'string') return records;
  for (const match of content.matchAll(RECORD_RE)) {
    let record;
    try {
      record = JSON.parse(match[1]);
    } catch {
      continue; // One malformed record does not hide the rest of the batch.
    }
    const sessionId = resultId(record.id);
    if (!sessionId || typeof record.handoff !== 'string' || !record.handoff.trim()) continue;
    records.push({
      sessionId, workspaceId: resultId(record.project_session_id), assignmentId: resultId(record.assignment_id), handoff: record.handoff,
    });
  }
  return records;
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
  if (data.source === RESULTS_SOURCE) {
    for (const record of parseResultRecords(data.content)) {
      const notice = record.handoff.startsWith(NO_HANDOFF_NOTICE);
      pushBounded(state.inbound, {
        at, fromSessionId: record.sessionId, fromProjectSessionId: record.workspaceId, fromName: null, sourceToolCallId: null,
        content: clip(record.handoff, 8000), notice, purpose: notice ? null : 'handoff', assignmentId: record.assignmentId,
      }, LIMITS.inbound);
    }
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
    pushBounded(state.sendTimes, { toolCallId: callId, at, failed: false }, LIMITS.sendTimes);
    countPrMentions(state, message, at);
  } else if (name === 'create_session') {
    const kickoff = args.kickoff && typeof args.kickoff === 'object' ? args.kickoff : {};
    pushBounded(state.created, {
      at, toolCallId: callId, name: typeof args.name === 'string' ? args.name : null,
      prompt: clip(typeof kickoff.prompt === 'string' ? kickoff.prompt : '', 8000) ?? '', sessionId: null, failed: false,
    }, LIMITS.created);
  } else if (name === 'save_session_automation') {
    const clear = args.clear === true || args.clear === 'true';
    const minutes = Number(args.every_minutes);
    const everyMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
    pushBounded(state.automation.saves, { at, clear, everyMinutes, target: typeof args.session_id === 'string' ? args.session_id : null }, LIMITS.saves);
    addFeed(state, at, clear ? 'monitor-cleared' : 'monitor-set', clear ? 'stopped its PR monitor' : `started a PR monitor${everyMinutes ? ` (every ${everyMinutes} min)` : ''}`);
  }
}

// The app's create_session result: "Created session '<name>' (id: <id>) ...".
const CREATED_ID_RE = /\(id:\s*([^\s)]+)\)/;

export function recordToolComplete(state, callId, data) {
  const created = state.created.find(item => item.toolCallId === callId);
  if (data.success !== false) {
    const content = typeof data.result?.content === 'string' ? data.result.content : '';
    if (created) created.sessionId = CREATED_ID_RE.exec(content)?.[1] ?? null;
    return;
  }
  const entry = state.sent.find(item => item.toolCallId === callId) ?? created;
  if (entry) entry.failed = true;
  const send = state.sendTimes.find(item => item.toolCallId === callId);
  if (send) send.failed = true;
}

export function recordTaskComplete(state, data, at) {
  state.outboundSeq += 1;
  const summary = clip(typeof data.summary === 'string' ? data.summary : '', 4000) ?? '';
  const success = data.success !== false;
  pushBounded(state.taskCompletes, { at, success, summary }, LIMITS.taskCompletes);
  countPrMentions(state, summary, at);
  addFeed(state, at, 'task-complete', success ? 'completed a task' : 'reported a failed task');
}
