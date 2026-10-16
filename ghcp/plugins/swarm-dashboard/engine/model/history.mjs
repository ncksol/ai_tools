import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, validateRunSummary } from '../schema.mjs';
import { getRunStats } from './run-stats.mjs';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const round1 = value => Math.round(value * 10) / 10;

function unionMs(spans) {
  let total = 0;
  let current = null;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else {
      current[1] = Math.max(current[1], end);
    }
  }
  return current ? total + current[1] - current[0] : total;
}

/** Summary of a run for the history view: names, ids, times, counts, costs and models only. */
export function summarizeRun(snapshot, { computedAt }) {
  const { run, orchestrator } = snapshot;
  // children, units and busyMs cover the orchestrator and its child sessions only; sub-agent units are not child sessions.
  const units = snapshot.units.filter(unit => unit.kind !== 'subagent');
  const finishedAt = run.finishedAt ?? run.lastActivityAt;
  const sessions = [orchestrator, ...units];
  const waits = [];
  for (const session of sessions) {
    for (const segment of session.timeline.segments) {
      if (segment.state === 'question' || segment.state === 'plan') waits.push([segment.start, segment.end ?? finishedAt]);
    }
  }
  // Whole-run totals from the engine's counters when the snapshot has them; otherwise from the snapshot's own lists.
  const stats = getRunStats(snapshot);
  const types = new Map();
  let subagentTotal = 0;
  if (stats) {
    subagentTotal = stats.subagents;
    for (const [type, entry] of stats.types) types.set(type, { type, runs: entry.runs, durationMs: entry.durationMs, credits: round1(entry.credits) });
  } else {
    for (const session of sessions) {
      for (const sub of session.subagents) {
        const entry = types.get(sub.type) ?? { type: sub.type, runs: 0, durationMs: 0, credits: 0 };
        entry.runs += 1;
        entry.durationMs += sub.durationMs ?? 0;
        entry.credits = round1(entry.credits + sub.credits);
        types.set(sub.type, entry);
        subagentTotal += 1;
      }
    }
  }
  const count = predicate => units.filter(predicate).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: run.id,
    name: run.name,
    project: run.project ? { id: run.project.id, name: run.project.name } : null,
    startedAt: run.startedAt,
    firstChildAt: run.firstChildAt,
    finishedAt,
    tookMs: Math.max(0, finishedAt - run.startedAt),
    busyMs: sessions.reduce((sum, session) => sum + session.busyMs, 0),
    waitingOnUserMs: unionMs(waits),
    credits: snapshot.cost.credits,
    usd: snapshot.cost.usd,
    children: {
      total: units.length,
      merged: count(unit => unit.outcome === 'merged'),
      closed: count(unit => unit.outcome === 'closed'),
      failed: count(unit => unit.outcome === 'failed'),
      noOutcome: count(unit => unit.outcome === null),
    },
    subagents: subagentTotal,
    units: [
      {
        id: orchestrator.id, label: orchestrator.label, name: orchestrator.name, isOrchestrator: true, startedAt: orchestrator.startedAt,
        endedAt: orchestrator.endedAt ?? orchestrator.lastEventAt, busyMs: orchestrator.busyMs, credits: orchestrator.cost.credits, outcome: null, merged: false,
      },
      ...units.map(unit => ({
        id: unit.id, label: unit.label, name: unit.name, isOrchestrator: false, startedAt: unit.startedAt, endedAt: unit.endedAt ?? unit.lastEventAt,
        busyMs: unit.busyMs, credits: unit.cost.credits, outcome: unit.outcome, merged: unit.outcome === 'merged',
      })),
    ],
    models: snapshot.cost.byModel.map(entry => ({ model: entry.model, credits: entry.credits, calls: entry.calls, apiMs: entry.apiMs })),
    subagentTypes: [...types.values()].sort((a, b) => b.credits - a.credits),
    computedAt,
  };
}

export function listItemOf(summary) {
  return {
    id: summary.id, name: summary.name, project: summary.project, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
    tookMs: summary.tookMs, busyMs: summary.busyMs, credits: summary.credits, usd: summary.usd,
    children: summary.children.total, merged: summary.children.merged, summarized: true,
  };
}

/** The engine's only write target: <dir>/runs/<id>.json, written atomically. */
export function createHistoryStore(dir) {
  const runsDir = path.join(dir, 'runs');
  const fileOf = id => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`Invalid run id ${id}`);
    return path.join(runsDir, `${id}.json`);
  };
  async function get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    try {
      const value = JSON.parse(await readFile(fileOf(id), 'utf8'));
      return validateRunSummary(value).length ? null : value;
    } catch {
      return null;
    }
  }
  return {
    dir: runsDir,
    get,
    async list() {
      let names;
      try {
        names = await readdir(runsDir);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const summaries = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const summary = await get(name.slice(0, -'.json'.length));
        if (summary) summaries.push(summary);
      }
      return summaries.sort((a, b) => b.finishedAt - a.finishedAt);
    },
    async put(summary) {
      const target = fileOf(summary?.id);
      const errors = validateRunSummary(summary);
      if (errors.length) throw new Error(`Invalid run summary: ${errors[0]}`);
      await mkdir(runsDir, { recursive: true });
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      await rename(temp, target);
    },
  };
}
