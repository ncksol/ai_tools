import { parseTime } from '../time.mjs';

export const BUCKET_MS = 5 * 60 * 1000;
export const LEDGER_SQL = `SELECT id, session_id, agent_id, parent_tool_call_id, model, total_nano_aiu, duration_ms, created_at
  FROM assistant_usage_events WHERE id > ? ORDER BY id LIMIT ?`;

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

/** Per-session cost accumulators fed from assistant_usage_events, one row per model call. */
export function createLedger() {
  const sessions = new Map();
  let lastId = 0;
  return {
    get lastId() {
      return lastId;
    },
    apply(rows) {
      for (const row of rows) {
        const id = Number(row.id);
        if (!Number.isFinite(id) || id <= lastId) continue;
        lastId = id;
        if (!row.session_id) continue;
        const nanoAiu = Number(row.total_nano_aiu) || 0;
        const apiMs = Number(row.duration_ms) || 0;
        const at = parseTime(row.created_at);
        const totals = sessions.get(row.session_id) ?? emptyTotals();
        totals.nanoAiu += nanoAiu;
        totals.calls += 1;
        totals.apiMs += apiMs;
        if (at !== null) {
          if (totals.firstAt === null || at < totals.firstAt) totals.firstAt = at;
          if (totals.lastAt === null || at > totals.lastAt) totals.lastAt = at;
          const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
          totals.buckets.set(bucket, (totals.buckets.get(bucket) ?? 0) + nanoAiu);
        }
        addEntry(totals.byModel, row.model || 'unknown', nanoAiu, 1, apiMs);
        if (row.parent_tool_call_id) addEntry(totals.byParentToolCall, row.parent_tool_call_id, nanoAiu, 1, apiMs);
        sessions.set(row.session_id, totals);
      }
    },
    session(id) {
      return sessions.get(id) ?? null;
    },
    /** True when a sub-agent of the session made a model call: a row with a parent_tool_call_id, the sub-agent's `task` call. */
    hasSubagentWork(id) {
      return (sessions.get(id)?.byParentToolCall.size ?? 0) > 0;
    },
    sumFor(ids) {
      const total = emptyTotals();
      for (const id of new Set(ids)) {
        const totals = sessions.get(id);
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

/** Pull every row newer than the ledger's watermark. Returns the number of rows read. */
export async function pullLedger(db, ledger, { batch = 20_000 } = {}) {
  let pulled = 0;
  for (;;) {
    const rows = await db.all(LEDGER_SQL, [ledger.lastId, batch]);
    ledger.apply(rows);
    pulled += rows.length;
    if (rows.length < batch) return pulled;
  }
}
