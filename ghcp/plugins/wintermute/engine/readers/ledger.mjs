import { createHash } from 'node:crypto';
import { parseTime } from '../time.mjs';
import { readNewLines } from './events.mjs';

export const BUCKET_MS = 5 * 60 * 1000;
/** Dedupe keys longer than this are kept as a digest: a sub-agent's usageId can be several hundred characters long. */
const MAX_KEY_LENGTH = 96;
const USAGE_TYPES = new Set(['session.usage_record', 'session.compaction_complete', 'subagent.started']);

function emptyTotals() {
  return { nanoAiu: 0, calls: 0, apiMs: 0, firstAt: null, lastAt: null, byModel: new Map(), byParentToolCall: new Map(), buckets: new Map() };
}

function addEntry(map, key, nanoAiu, calls, apiMs) {
  const entry = map.get(key) ?? { nanoAiu: 0, calls: 0, apiMs: 0 };
  entry.nanoAiu += nanoAiu;
  entry.calls += calls;
  entry.apiMs += apiMs;
  map.set(key, entry);
}

const text = value => (typeof value === 'string' && value ? value : null);
const shortKey = key => (key.length > MAX_KEY_LENGTH ? `#${createHash('sha1').update(key).digest('base64')}` : key);

/**
 * The model call an event log line records, or null when it records none. A `session.usage_record` is one call, by the main
 * agent or a sub-agent; it is keyed by its accounting sourceSessionId and usageId, which a resumed session can write again. A
 * `session.compaction_complete` with compactionTokensUsed is a compaction call, which has no usage record; it is keyed by its
 * event id. `taskId` is the sub-agent's `task` tool call id when the record names it (data.usage.parentToolCallId), and
 * `agentId` the envelope agent id of a sub-agent's event, which maps to its task through subagent.started.
 */
export function usageOf(event) {
  if (!event || typeof event !== 'object' || !event.data || typeof event.data !== 'object') return null;
  const agentId = text(event.agentId);
  if (event.type === 'session.usage_record') {
    const usage = event.data.usage;
    if (!usage || typeof usage !== 'object') return null;
    const accounting = usage.accounting ?? {};
    const usageId = text(accounting.usageId);
    const key = usageId ? `u:${text(accounting.sourceSessionId) ?? ''}:${usageId}` : text(event.id) ? `e:${event.id}` : null;
    if (!key) return null;
    return {
      key, nanoAiu: Number(usage.copilotUsage?.totalNanoAiu) || 0, model: text(usage.model), apiMs: Number(usage.duration) || 0,
      at: parseTime(event.timestamp), taskId: text(usage.parentToolCallId), agentId,
    };
  }
  if (event.type === 'session.compaction_complete') {
    const used = event.data.compactionTokensUsed;
    if (!used || typeof used !== 'object' || !text(event.id)) return null;
    return {
      key: `c:${event.id}`, nanoAiu: Number(used.copilotUsage?.totalNanoAiu) || 0, model: text(used.model), apiMs: Number(used.duration) || 0,
      at: parseTime(event.timestamp), taskId: text(event.data.parentToolCallId), agentId,
    };
  }
  return null;
}

/**
 * Per-session cost accumulators fed from each session's events.jsonl: one entry per model call (see usageOf), counted once
 * per dedupe key. A sub-agent's calls are in its parent session's log; they are also added to byParentToolCall under the
 * sub-agent's `task` tool call id (a nested sub-agent's under its own task id, which the snapshot rolls up).
 */
export function createLedger() {
  const sessions = new Map();
  const entryOf = id => {
    let entry = sessions.get(id);
    if (!entry) {
      entry = { totals: emptyTotals(), seen: new Set(), agentTasks: new Map() };
      sessions.set(id, entry);
    }
    return entry;
  };
  return {
    /** Applies one parsed log event of the session. Returns true when it added a model call. */
    apply(sessionId, event) {
      if (!sessionId || !event || typeof event !== 'object') return false;
      if (event.type === 'subagent.started') {
        const agentId = text(event.agentId);
        const taskId = text(event.data?.toolCallId);
        if (agentId && taskId) entryOf(sessionId).agentTasks.set(agentId, taskId);
        return false;
      }
      const call = usageOf(event);
      if (!call) return false;
      const entry = entryOf(sessionId);
      const key = shortKey(call.key);
      if (entry.seen.has(key)) return false;
      entry.seen.add(key);
      const { totals } = entry;
      totals.nanoAiu += call.nanoAiu;
      totals.calls += 1;
      totals.apiMs += call.apiMs;
      if (call.at !== null) {
        if (totals.firstAt === null || call.at < totals.firstAt) totals.firstAt = call.at;
        if (totals.lastAt === null || call.at > totals.lastAt) totals.lastAt = call.at;
        const bucket = Math.floor(call.at / BUCKET_MS) * BUCKET_MS;
        totals.buckets.set(bucket, (totals.buckets.get(bucket) ?? 0) + call.nanoAiu);
      }
      addEntry(totals.byModel, call.model || 'unknown', call.nanoAiu, 1, call.apiMs);
      const taskId = call.taskId ?? (call.agentId ? entry.agentTasks.get(call.agentId) : null) ?? null;
      if (taskId) addEntry(totals.byParentToolCall, taskId, call.nanoAiu, 1, call.apiMs);
      return true;
    },
    /** Forgets a session, for example when its log was replaced and is read again from the start. */
    reset(sessionId) {
      sessions.delete(sessionId);
    },
    /** Forgets every session not in `ids`. */
    retain(ids) {
      for (const id of [...sessions.keys()]) if (!ids.has(id)) sessions.delete(id);
    },
    session(id) {
      return sessions.get(id)?.totals ?? null;
    },
    /** True when a sub-agent of the session made a model call: one attributed to the sub-agent's `task` call. */
    hasSubagentWork(id) {
      return (sessions.get(id)?.totals.byParentToolCall.size ?? 0) > 0;
    },
    sumFor(ids) {
      const total = emptyTotals();
      for (const id of new Set(ids)) {
        const totals = sessions.get(id)?.totals;
        if (!totals) continue;
        total.nanoAiu += totals.nanoAiu;
        total.calls += totals.calls;
        total.apiMs += totals.apiMs;
        if (totals.firstAt !== null && (total.firstAt === null || totals.firstAt < total.firstAt)) total.firstAt = totals.firstAt;
        if (totals.lastAt !== null && (total.lastAt === null || totals.lastAt > total.lastAt)) total.lastAt = totals.lastAt;
        for (const [key, value] of totals.byModel) addEntry(total.byModel, key, value.nanoAiu, value.calls, value.apiMs);
        for (const [key, value] of totals.byParentToolCall) addEntry(total.byParentToolCall, key, value.nanoAiu, value.calls, value.apiMs);
        for (const [key, value] of totals.buckets) total.buckets.set(key, (total.buckets.get(key) ?? 0) + value);
      }
      return total;
    },
  };
}

/**
 * Applies the usage events appended to a session's log since the last read of `tail` (see readNewLines), so a refresh reads
 * only new bytes. A log that was replaced or shrank is read again from the start, with the session's totals forgotten first.
 * Only lines that name a usage event type are parsed. Resolves readNewLines' result.
 */
export function readUsage(tail, ledger, sessionId) {
  return readNewLines(tail, line => {
    if (!line.includes('session.usage_record') && !line.includes('session.compaction_complete') && !line.includes('subagent.started')) return;
    const event = JSON.parse(line);
    if (event && USAGE_TYPES.has(event.type)) ledger.apply(sessionId, event);
  }, { onReset: () => ledger.reset(sessionId) });
}
