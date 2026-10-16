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

/**
 * The orchestrator's one-off sub-agents for the stress scenario: every sub-agent status, a 32-character label, a long
 * name, crowded chips, an open tool call, no report, finished ones inside and outside the 12-hour window, and two
 * finished ones still in their card grace period (summarise-reviews and scan-test-names).
 * start and end are minutes before the snapshot time; end is null while the sub-agent runs.
 */
const SUBAGENT_UNITS = [
  { label: 'investigate-flaky-integration-te', state: 'running', type: 'general-purpose', mode: 'background', effort: 'high', start: 25, end: null, name: 'Investigate the flaky integration tests in the export pipeline, with a description long enough to need an ellipsis' },
  { label: 'review-api-diff', state: 'running', type: 'code-review', mode: 'sync', effort: null, start: 8, end: null, name: 'Review the API diff for breaking changes', crowd: 4 },
  { label: 'trace-import-callers', state: 'running', type: 'explore', mode: 'background', effort: 'low', start: 3, end: null, name: 'Trace who calls the import service', tool: true },
  { label: 'draft-release-notes', state: 'running', type: 'task', mode: 'background', effort: 'medium', start: 1, end: null, name: 'Draft the release notes for the export changes', report: null },
  { label: 'rubber-duck-plan', state: 'running', type: 'rubber-duck', mode: 'sync', effort: 'high', start: 14, end: null, name: 'Talk through the migration plan' },
  { label: 'compare-grid-libraries', state: 'running', type: 'research', mode: 'background', effort: 'medium', start: 40, end: null, name: 'Compare three grid libraries for the report view', title: 'Compared the first two grid libraries on bundle size, sorting, virtual scrolling and keyboard support so far' },
  { label: 'measure-render-cost', state: 'stuck', type: 'explore', mode: 'background', effort: 'low', start: 50, end: null, name: 'Measure the render cost of the report table', silent: 16, reason: 'Sub-agent rule: no events for 16 min (limit 10 min).' },
  { label: 'check-lint-config', state: 'stuck', type: 'task', mode: 'sync', effort: null, start: 75, end: null, name: 'Check the lint configuration against the style guide', silent: 12, reason: 'Sub-agent rule: no events for 12 min (limit 10 min).' },
  { label: 'audit-feed-ids', state: 'completed', type: 'general-purpose', mode: 'sync', effort: 'high', start: 200, end: 170, name: 'Audit the feed item ids for duplicates' },
  { label: 'list-dead-code', state: 'completed', type: 'explore', mode: 'background', effort: 'low', start: 400, end: 380, name: 'List the functions that nothing calls' },
  { label: 'old-schema-survey', state: 'completed', type: 'research', mode: 'background', effort: 'medium', start: 1500, end: 1450, name: 'Survey where the old schema is still read' },
  { label: 'old-fixture-scan', state: 'completed', type: 'explore', mode: 'background', effort: 'low', start: 900, end: 880, name: 'Scan the old fixtures for unused fields' },
  { label: 'summarise-reviews', state: 'completed', type: 'code-review', mode: 'sync', effort: null, start: 10, end: 2, name: 'Summarise the open review comments' },
  { label: 'write-migration-notes', state: 'completed', type: 'task', mode: 'background', effort: 'medium', start: 130, end: 100, name: 'Write the notes for the data migration' },
  { label: 'retry-model-call', state: 'failed', type: 'task', mode: 'background', effort: null, start: 300, end: 290, name: 'Retry the summary step', reason: 'Failed: the model request failed after 3 retries.' },
  { label: 'probe-cache-sizes', state: 'failed', type: 'explore', mode: 'background', effort: 'low', start: 800, end: 790, name: 'Probe the cache sizes on the sample data', reason: 'Failed: the tool call timed out.' },
  { label: 'scan-test-names', state: 'cancelled', type: 'orchestrator-worker', mode: 'background', effort: 'medium', start: 24, end: 4, name: 'Scan the test names for duplicates', reason: 'Cancelled after 20 min.' },
  { label: 'map-old-endpoints', state: 'crashed', type: 'explore', mode: 'background', effort: 'low', start: 35, end: 20, name: 'Map the old endpoints to the new ones', reason: 'Ended rule: the orchestrator process ended while it ran.' },
  // Seven more finished ones, so the snapshot lists MAX_FINISHED_SUBAGENT_UNITS finished sub-agents, as the engine would.
  { label: 'tidy-css-tokens', state: 'completed', type: 'general-purpose', mode: 'background', effort: 'low', start: 160, end: 150, name: 'Tidy the CSS colour tokens' },
  { label: 'verify-port-probe', state: 'completed', type: 'task', mode: 'sync', effort: null, start: 220, end: 210, name: 'Verify the port probe on a busy port' },
  { label: 'collect-flaky-logs', state: 'failed', type: 'explore', mode: 'background', effort: 'low', start: 260, end: 255, name: 'Collect the logs of the flaky test runs', reason: 'Failed: the log folder was not found.' },
  { label: 'check-a11y-labels', state: 'completed', type: 'code-review', mode: 'background', effort: 'medium', start: 340, end: 320, name: 'Check the accessible labels on the controls' },
  { label: 'compare-fixture-shapes', state: 'completed', type: 'explore', mode: 'background', effort: 'low', start: 460, end: 440, name: 'Compare the fixture shapes with the schema' },
  { label: 'review-docs-tone', state: 'completed', type: 'rubber-duck', mode: 'sync', effort: 'high', start: 520, end: 500, name: 'Review the tone of the user docs' },
  { label: 'scan-old-branches', state: 'cancelled', type: 'orchestrator-worker', mode: 'background', effort: 'medium', start: 640, end: 600, name: 'Scan the old branches for unmerged work', reason: 'Cancelled after 40 min.' },
];
/** Per sub-agent state: the unit's status, statusDetail and bucket, the orchestrator's SubagentView status, the report status, the activity label and the feed verb. */
const SUBAGENT_STATES = {
  running: { status: 'busy', statusDetail: 'busy', bucket: 'working', viewStatus: 'running', reportStatus: 'progress', activity: 'Thinking', verb: null },
  stuck: { status: 'stuck', statusDetail: 'stuck_subagent', bucket: 'stuck', viewStatus: 'stuck', reportStatus: 'progress', activity: 'Thinking', verb: null },
  completed: { status: 'done', statusDetail: 'completed', bucket: 'done', viewStatus: 'completed', reportStatus: 'complete', activity: 'Done', verb: 'completed' },
  failed: { status: 'blocked', statusDetail: 'failed', bucket: 'failed', viewStatus: 'failed', reportStatus: 'blocked', activity: 'Failed', verb: 'failed' },
  cancelled: { status: 'blocked', statusDetail: 'cancelled', bucket: 'failed', viewStatus: 'cancelled', reportStatus: 'blocked', activity: 'Cancelled', verb: 'cancelled' },
  // The contract has no 'crashed' sub-agent status or feed text, so the orchestrator's view and the feed say failed.
  crashed: { status: 'blocked', statusDetail: 'crashed', bucket: 'failed', viewStatus: 'failed', reportStatus: 'blocked', activity: 'Stopped', verb: 'failed' },
};

function subagentUnit(template, spec, index, t, parentId) {
  const unit = structuredClone(template);
  const { status, statusDetail, bucket, reportStatus, activity: activityLabel, verb } = SUBAGENT_STATES[spec.state];
  const id = `call-91${String(index + 1).padStart(2, '0')}-sub`;
  const startedAt = t - spec.start * MIN;
  const endedAt = spec.end === null ? null : t - spec.end * MIN;
  const lastEventAt = endedAt ?? t - (spec.silent ?? 1) * MIN;
  const since = endedAt ?? (spec.silent ? lastEventAt : startedAt);
  Object.assign(unit, {
    id, kind: 'subagent', label: spec.label, name: spec.name, cliSessionIds: [], branch: null,
    status, statusDetail, bucket, since, reason: spec.reason ?? null, startedAt, endedAt, lastEventAt,
    busyMs: (endedAt ?? t) - startedAt, waitingOnUserMs: 0, alive: true,
    cost: { credits: round1(20 + 13.7 * index), calls: 5 + index },
    parentId, depth: 1, stage: 'subagent', pr: null,
    monitor: { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null },
    progress: null, outcome: null, closedWithoutMerge: false, dependsOn: null, todoId: null,
    agent: { type: spec.type, mode: spec.mode, effort: spec.effort },
  });
  unit.activity = spec.tool
    ? { label: 'Running grep: ImportService', tool: { id: `${id}-tool`, name: 'grep', summary: 'grep: ImportService', startedAt: lastEventAt, limitMs: 120000 }, lastEventAt }
    : { label: activityLabel, tool: null, lastEventAt };
  unit.report = 'report' in spec ? spec.report : {
    status: reportStatus, source: 'message', at: lastEventAt,
    title: spec.title ?? `${spec.name}: ${{ progress: 'work continues.', complete: 'finished.', blocked: 'stopped early.' }[reportStatus]}`,
    // A 'message' report has no parsed status line, so it names no unit.
    summary: null, evidence: [], blockers: null, body: null, unit: null, commit: null,
  };
  unit.subagents = Array.from({ length: spec.crowd ?? 0 }, (_, k) => ({
    id: `${id}-${k + 1}`, name: `helper-${k + 1}`, type: TYPES[k % TYPES.length], model: 'gpt-5.4-mini', mode: 'background', status: 'running',
    startedAt: t - (k + 2) * MIN, endedAt: null, durationMs: null, credits: 3 + k, task: `Check ${k + 1} of the API diff`,
  }));
  const segments = spec.silent
    ? [{ start: startedAt, end: lastEventAt, state: 'busy' }, { start: lastEventAt, end: null, state: 'stuck' }]
    : [{ start: startedAt, end: endedAt, state: 'busy' }];
  unit.timeline = {
    segments,
    subagents: unit.subagents.map(sub => ({ id: sub.id, start: sub.startedAt, end: sub.endedAt, type: sub.type })),
    marks: endedAt !== null && unit.report ? [{ at: endedAt, kind: 'report', text: unit.report.title, status: unit.report.status }] : [],
  };
  const item = (kind, at, text) => ({ id: `${id}:${kind}:stress`, at, unitId: id, label: spec.label, kind, text });
  unit.recent = [
    ...(endedAt !== null ? [item('subagent-done', endedAt, `${verb} ${spec.type}: ${spec.label}`)] : []),
    item('subagent-start', startedAt, `started ${spec.type}: ${spec.label}`),
  ];
  return unit;
}

function subagentView(unit, spec) {
  return {
    id: unit.id, name: unit.label, type: unit.agent.type, model: unit.model, mode: unit.agent.mode, status: SUBAGENT_STATES[spec.state].viewStatus,
    startedAt: unit.startedAt, endedAt: unit.endedAt, durationMs: unit.endedAt === null ? null : unit.endedAt - unit.startedAt,
    credits: unit.cost.credits, task: unit.name,
  };
}

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
 * a stalled run, a data warning, many of the orchestrator's one-off sub-agents and a second live swarm for the picker.
 */
export function stressScenario(fixtures) {
  const example = fixtures.snapshots[0];
  const snapshot = structuredClone(example);
  const t = snapshot.generatedAt;
  const template = snapshot.units.find(unit => unit.label === 'B1');
  const orchestrator = snapshot.orchestrator;
  const extra = EXTRA.map((spec, index) => stressUnit(template, spec, index, t, orchestrator.id));
  const subTemplate = snapshot.units.find(unit => unit.id === 'call-root-41');
  const subs = SUBAGENT_UNITS.map((spec, index) => subagentUnit(subTemplate, spec, index, t, orchestrator.id));
  // Session units first, in their current order, then every sub-agent unit, oldest start first.
  const sessions = snapshot.units.filter(unit => unit.kind !== 'subagent');
  const subagentUnits = [...snapshot.units.filter(unit => unit.kind === 'subagent'), ...subs].sort((a, b) => a.startedAt - b.startedAt);
  snapshot.units = [...sessions, ...extra, ...subagentUnits];
  // The orchestrator still lists every sub-agent, two omitted finished ones included, so its lane keeps drawing them.
  // Omitted ones finished before every listed finished one, because units keep the most recently finished.
  const omitted = [
    { id: 'call-9190-omitted', name: 'old-cache-check', type: 'explore', model: subTemplate.model, mode: 'background', status: 'completed', startedAt: t - 4420 * MIN, endedAt: t - 4400 * MIN, durationMs: 20 * MIN, credits: 12, task: 'Check the old cache keys' },
    { id: 'call-9191-omitted', name: 'old-schema-probe', type: 'task', model: subTemplate.model, mode: 'background', status: 'failed', startedAt: t - 4620 * MIN, endedAt: t - 4600 * MIN, durationMs: 20 * MIN, credits: 9, task: 'Probe the old schema' },
  ];
  const running = status => status === 'running' || status === 'stuck';
  orchestrator.subagents = [...orchestrator.subagents, ...subs.map((unit, index) => subagentView(unit, SUBAGENT_UNITS[index])), ...omitted]
    .sort((a, b) => Number(running(b.status)) - Number(running(a.status)) || b.startedAt - a.startedAt);
  const bar = (id, start, end, type) => ({ id, start, end, type });
  orchestrator.timeline.subagents = [
    ...orchestrator.timeline.subagents,
    ...subs.map(unit => bar(unit.id, unit.startedAt, unit.endedAt, unit.agent.type)),
    ...omitted.map(sub => bar(sub.id, sub.startedAt, sub.endedAt, sub.type)),
  ].sort((a, b) => a.start - b.start);
  const subCredits = round1(subs.reduce((sum, unit) => sum + unit.cost.credits, 0));
  orchestrator.cost.credits = round1(orchestrator.cost.credits + subCredits);
  snapshot.omittedSubagents = { done: 37, failed: 4 };
  snapshot.planned.push({ label: 'Z10', name: 'final clean-up once everything else has merged', dependsOn: 'N5', canStart: false, waitsOn: 'N5', todoId: null });
  snapshot.needs.push(
    { id: 'stress:need:question', kind: 'question', unitIds: [], labels: [], fromId: snapshot.orchestrator.id, text: 'Should the export keep the old CSV column order for existing users, or move everyone to the new order at once?', since: t - 95 * MIN, tagged: true },
    { id: 'stress:need:pr', kind: 'pr', unitIds: [extra[0].id], labels: [extra[0].label], fromId: snapshot.orchestrator.id, text: 'Publish PR #500 for review?', since: t - 12 * MIN, tagged: true },
  );
  snapshot.needs.sort((a, b) => a.since - b.since);
  snapshot.run.stalled = { since: t - 32 * MIN, reason: 'Swarm rule: the orchestrator and every open child are idle, and no monitor is due.' };
  snapshot.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: 'gh is not signed in, so GitHub PR states are not known.' });
  snapshot.feed = [...[...extra, ...subs].flatMap(unit => unit.recent), ...snapshot.feed].sort((a, b) => b.at - a.at).slice(0, 200);
  snapshot.counts = Object.fromEntries(BUCKETS.map(bucket => [bucket, snapshot.units.filter(unit => unit.bucket === bucket).length]));
  snapshot.counts.done += snapshot.omittedSubagents.done;
  snapshot.counts.failed += snapshot.omittedSubagents.failed;
  // New spending: the extra sessions, and the new sub-agents once (their cost is part of the orchestrator's).
  const added = round1(extra.reduce((sum, unit) => sum + unit.cost.credits, 0));
  snapshot.cost.credits = round1(snapshot.cost.credits + added + subCredits);
  snapshot.cost.usd = Math.round(snapshot.cost.credits) / 100;
  snapshot.cost.maxUnitCredits = Math.max(...snapshot.units.map(unit => unit.cost.credits));
  for (const [modelName, credits] of [[template.model, added], [subTemplate.model, subCredits]]) {
    const model = snapshot.cost.byModel.find(entry => entry.model === modelName);
    if (model) model.credits = round1(model.credits + credits);
  }
  const last = snapshot.cost.series[snapshot.cost.series.length - 1];
  snapshot.cost.series.push({ at: last.at + 5 * MIN, credits: snapshot.cost.credits });

  // A second live swarm for the picker: the example under new ids everywhere, so every reference stays inside it.
  const other = JSON.parse(JSON.stringify(example).replace(/\b(ws|cli)-0(\d{3})-/g, '$1-8$2-'));
  other.run = { ...other.run, name: 'Sample story C', lastActivityAt: t - 40 * MIN };
  other.orchestrator = { ...other.orchestrator, label: 'SC', name: 'Sample story C' };
  return { snapshots: [snapshot, other], swarms: null, history: fixtures.history, summaries: fixtures.summaries };
}
