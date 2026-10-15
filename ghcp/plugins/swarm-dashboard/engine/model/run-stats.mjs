/**
 * Whole-run sub-agent totals, kept beside a snapshot instead of inside it (snapshot fields are a fixed contract).
 * Each session lists at most LIMITS.subagents sub-agents, so the run summary reads its totals from here when present.
 * Shape: { subagents: number, types: Map<type, { runs, durationMs, credits }> }
 */
const stats = new WeakMap();

export function setRunStats(snapshot, value) {
  stats.set(snapshot, value);
}

export function getRunStats(snapshot) {
  return stats.get(snapshot) ?? null;
}
