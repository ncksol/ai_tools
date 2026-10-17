/**
 * Whole-run totals, kept beside a snapshot instead of inside it (snapshot fields are a fixed contract).
 * Each session lists at most LIMITS.subagents sub-agents and keeps at most LIMITS.spans wait spans, so the run summary reads
 * its totals from here when present.
 * Shape: { subagents: number, types: Map<type, { runs, durationMs, credits }>, waitDroppedMs: number }
 * waitDroppedMs is the waiting time of the spans the sessions' bounded wait histories dropped.
 */
const stats = new WeakMap();

export function setRunStats(snapshot, value) {
  stats.set(snapshot, value);
}

export function getRunStats(snapshot) {
  return stats.get(snapshot) ?? null;
}
