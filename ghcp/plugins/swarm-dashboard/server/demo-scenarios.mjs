const MIN = 60000;
const round1 = value => Math.round(value * 10) / 10;
const BUCKETS = ['working', 'stuck', 'waiting', 'idle', 'done', 'failed'];
const SEGMENT = { busy: 'busy', idle: 'idle', plan: 'plan', question: 'question', stuck: 'stuck' };
const TYPES = ['explore', 'task', 'code-review', 'rubber-duck', 'research', 'general-purpose'];
/**
 * Extra units for the stress scenario: every status detail, long names and labels (C6-1 fits its ring whole, MM-1 does
 * not), crowded chips, a PR closed without merging and a deep plan.
 */
const EXTRA = [
  { label: 'Q1', name: 'Export format questions for the reporting service, with a name long enough to need an ellipsis', status: 'question', statusDetail: 'waiting_question', bucket: 'waiting', stage: 'pr_open', dependsOn: 'B1' },
  { label: 'S2', name: 'retry loop', status: 'stuck', statusDetail: 'spinning', bucket: 'stuck', reason: 'Spinning rule: 6 failed tool calls within 30 busy minutes.', dependsOn: 'Q1' },
  { label: 'X3', name: 'crashed worker', status: 'blocked', statusDetail: 'crashed', bucket: 'failed', reason: 'Ended rule: the process is gone, with no shutdown event and a turn still open.', alive: false, dependsOn: 'S2' },
  { label: 'P4', name: 'paused monitor', status: 'idle', statusDetail: 'idle', bucket: 'idle', stage: 'in_review', monitor: 'paused', dependsOn: 'X3' },
  { label: 'N5', name: 'no report and no task list', status: 'busy', statusDetail: 'busy', bucket: 'working', report: null, progress: null, dependsOn: 'P4' },
  { label: 'C6', name: 'crowded chips', status: 'busy', statusDetail: 'slow_model_call', bucket: 'working', crowd: 7 },
  { label: 'REPORTING-SERVICE', name: 'a label longer than the ring', status: 'stuck', statusDetail: 'stuck_subagent', bucket: 'stuck', reason: 'Sub-agent rule: code-review has had no events for 14 min (limit 10 min).', stuckSubagent: true },
  { label: 'R8', name: 'blocked report', status: 'blocked', statusDetail: 'blocked', bucket: 'waiting', reportStatus: 'blocked' },
  { label: 'M9', name: 'merged after review', status: 'merged', statusDetail: 'merged', bucket: 'done', stage: 'merged', outcome: 'merged' },
  { label: 'C6-1', name: 'closed without merging', status: 'idle', statusDetail: 'idle', bucket: 'idle', stage: 'pr_open', outcome: 'closed' },
  { label: 'MM-1', name: 'a four-character label too wide for its ring', status: 'idle', statusDetail: 'idle', bucket: 'idle' },
];

function monitorFor(spec, stage, t) {
  if (spec.monitor === 'paused') return { state: 'paused', lastCheckAt: t - 70 * MIN, nextCheckAt: null, everyMinutes: 10, since: t - 50 * MIN };
  if (stage === 'merged' || spec.outcome === 'closed') return { state: 'ended', lastCheckAt: t - 25 * MIN, nextCheckAt: null, everyMinutes: 10, since: null };
  if (stage === 'coding') return { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null };
  return { state: 'alive', lastCheckAt: t - 4 * MIN, nextCheckAt: t + 6 * MIN, everyMinutes: 10, since: null };
}

function subagentsFor(spec, n, t) {
  const make = (k, status, type) => ({
    id: `call-90${n}-${k}`, name: `helper-${k + 1}`, type, model: 'gpt-5.4-mini', mode: 'background', status,
    startedAt: t - (k + 1) * 3 * MIN, endedAt: null, durationMs: null, credits: 10 + k, task: `Background check ${k + 1}`,
  });
  if (spec.crowd) return Array.from({ length: spec.crowd }, (_, k) => make(k, 'running', TYPES[k % TYPES.length]));
  if (spec.stuckSubagent) return [make(0, 'stuck', 'code-review')];
  return [];
}

function stressUnit(template, spec, index, t, parentId) {
  const n = String(index + 1).padStart(2, '0');
  const unit = structuredClone(template);
  const stage = spec.stage ?? 'coding';
  const startedAt = t - (240 + index * 30) * MIN;
  const lastEventAt = t - (1 + index) * MIN;
  const endedAt = spec.outcome ? t - 20 * MIN : spec.alive === false ? lastEventAt : null;
  Object.assign(unit, {
    id: `ws-90${n}-stress`, label: spec.label, name: spec.name, cliSessionIds: [`cli-90${n}-stress`], branch: `feature/stress-${n}`,
    status: spec.status, statusDetail: spec.statusDetail, bucket: spec.bucket, since: t - (5 + index * 7) * MIN, reason: spec.reason ?? null,
    startedAt, endedAt, lastEventAt, alive: spec.alive ?? true, cost: { credits: round1(1500 + index * 2333.3), calls: 100 + index * 10 },
    parentId, depth: 1, stage, closedWithoutMerge: spec.outcome === 'closed', outcome: spec.outcome ?? null, dependsOn: spec.dependsOn ?? null, todoId: null,
  });
  unit.pr = stage === 'coding' ? null : {
    ...template.pr, id: 500 + index, title: `${spec.name} PR`, url: `https://github.com/sample-org/sample-repo/pull/${500 + index}`,
    state: spec.outcome === 'closed' ? 'closed' : stage === 'merged' ? 'merged' : stage === 'pr_open' ? 'draft' : 'open', openedAt: t - 90 * MIN,
    mergedAt: stage === 'merged' ? endedAt : null, closedAt: stage === 'merged' || spec.outcome === 'closed' ? endedAt : null,
  };
  unit.monitor = monitorFor(spec, stage, t);
  unit.report = 'report' in spec ? spec.report : {
    status: spec.reportStatus ?? 'progress', source: 'contract', at: t - (3 + index) * MIN,
    title: `${spec.name}: a progress report long enough to need an ellipsis on a narrow card`, summary: `${spec.name}: work continues on the branch.`,
    evidence: ['Unit tests pass'], blockers: spec.reportStatus === 'blocked' ? ['Waiting for the parent branch to merge'] : [], body: null, unit: spec.label, commit: null,
  };
  if ('progress' in spec) unit.progress = spec.progress;
  unit.subagents = subagentsFor(spec, n, t);
  unit.activity = { label: spec.status === 'busy' ? 'Working on the branch' : 'Waiting', tool: null, lastEventAt };
  unit.timeline = {
    segments: [{ start: startedAt, end: t - 60 * MIN, state: 'busy' }, { start: t - 60 * MIN, end: endedAt, state: SEGMENT[spec.status] ?? 'idle' }],
    subagents: unit.subagents.map(sub => ({ id: sub.id, start: sub.startedAt, end: sub.endedAt, type: sub.type })),
    marks: unit.report ? [{ at: unit.report.at, kind: 'report', text: unit.report.title, status: unit.report.status }] : [],
  };
  unit.recent = [unit.report
    ? { id: `${unit.id}:report:stress`, at: unit.report.at, unitId: unit.id, label: unit.label, kind: 'report', text: `reported ${unit.report.status}: ${unit.report.title}` }
    : { id: `${unit.id}:plan-ok:stress`, at: t - 30 * MIN, unitId: unit.id, label: unit.label, kind: 'plan-ok', text: 'plan approved' }];
  return unit;
}

/**
 * A crowded synthetic swarm for layout checks, built from the example fixtures so it stays inside the schema: every
 * status and status detail, long names and labels, crowded chips, missing reports and task lists, an eight-level plan,
 * a stalled run, a data warning and a second live swarm for the picker.
 */
export function stressScenario(fixtures) {
  const example = fixtures.snapshots[0];
  const snapshot = structuredClone(example);
  const t = snapshot.generatedAt;
  const template = snapshot.units.find(unit => unit.label === 'B1');
  const extra = EXTRA.map((spec, index) => stressUnit(template, spec, index, t, snapshot.orchestrator.id));
  snapshot.units.push(...extra);
  snapshot.planned.push({ label: 'Z10', name: 'final clean-up once everything else has merged', dependsOn: 'N5', canStart: false, waitsOn: 'N5', todoId: null });
  snapshot.needs.push(
    { id: 'stress:need:question', kind: 'question', unitIds: [], labels: [], fromId: snapshot.orchestrator.id, text: 'Should the export keep the old CSV column order for existing users, or move everyone to the new order at once?', since: t - 95 * MIN, tagged: true },
    { id: 'stress:need:pr', kind: 'pr', unitIds: [extra[0].id], labels: [extra[0].label], fromId: snapshot.orchestrator.id, text: 'Publish PR #500 for review?', since: t - 12 * MIN, tagged: true },
  );
  snapshot.needs.sort((a, b) => a.since - b.since);
  snapshot.run.stalled = { since: t - 32 * MIN, reason: 'Swarm rule: the orchestrator and every open child are idle, and no monitor is due.' };
  snapshot.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: 'gh is not signed in, so GitHub PR states are not known.' });
  snapshot.feed = [...extra.flatMap(unit => unit.recent), ...snapshot.feed].sort((a, b) => b.at - a.at).slice(0, 200);
  snapshot.counts = Object.fromEntries(BUCKETS.map(bucket => [bucket, snapshot.units.filter(unit => unit.bucket === bucket).length]));
  const added = round1(extra.reduce((sum, unit) => sum + unit.cost.credits, 0));
  snapshot.cost.credits = round1(snapshot.cost.credits + added);
  snapshot.cost.usd = Math.round(snapshot.cost.credits) / 100;
  snapshot.cost.maxUnitCredits = Math.max(...snapshot.units.map(unit => unit.cost.credits));
  const model = snapshot.cost.byModel.find(entry => entry.model === template.model);
  if (model) model.credits = round1(model.credits + added);
  const last = snapshot.cost.series[snapshot.cost.series.length - 1];
  snapshot.cost.series.push({ at: last.at + 5 * MIN, credits: snapshot.cost.credits });

  const other = structuredClone(example);
  other.run = { ...other.run, id: 'ws-8000-root', name: 'Sample story C', lastActivityAt: t - 40 * MIN };
  other.orchestrator = { ...other.orchestrator, id: 'ws-8000-root', label: 'SC', name: 'Sample story C', cliSessionIds: ['cli-8000-root'] };
  other.units = other.units.map(unit => ({ ...unit, id: unit.id.replace(/^ws-0/, 'ws-8'), parentId: 'ws-8000-root', cliSessionIds: unit.cliSessionIds.map(id => id.replace(/^cli-0/, 'cli-8')) }));
  return { snapshots: [snapshot, other], swarms: null, history: fixtures.history, summaries: fixtures.summaries };
}
