import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSegments, buildSnapshot, deriveLabels, runLifecycle, splitFeed } from '../engine/model/swarm.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const at = minutes => T0 + minutes * MINUTE;
const iso = minutes => new Date(at(minutes)).toISOString();

function appData() {
  const workspaces = new Map();
  const ws = (id, name, cli, createdAt, extra = {}) => workspaces.set(id, {
    id, projectId: 'project-1', worktreeId: extra.baseBranch ? `wt-${id}` : null, name, branch: extra.branch ?? null, createdAt,
    archivedAt: extra.archivedAt ?? null, sessionId: cli, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null,
  });
  ws('ws-root', 'Sample story', 'cli-root', T0);
  ws('ws-api', 'Sample a1 api', 'cli-api', at(5), { branch: 'feature/api', baseBranch: 'main' });
  ws('ws-ui', 'Sample u1 ui', 'cli-ui', at(6), { branch: 'feature/ui', baseBranch: 'feature/api' });
  ws('ws-docs', 'Sample d1 docs', 'cli-docs', at(7), { branch: 'feature/docs', archivedAt: at(100) });
  return {
    projects: new Map([['project-1', { id: 'project-1', name: 'sample-project', githubOwner: null, githubRepo: null }]]),
    worktrees: new Map([
      ['wt-ws-api', { id: 'wt-ws-api', branch: 'feature/api', baseBranch: 'main' }],
      ['wt-ws-ui', { id: 'wt-ws-ui', branch: 'feature/ui', baseBranch: 'feature/api' }],
    ]),
    workspaces,
    parentLinks: ['ws-api', 'ws-ui', 'ws-docs'].map(childId => ({ childId, parentId: 'ws-root' })),
    aliases: [['cli-root', 'ws-root'], ['cli-api', 'ws-api'], ['cli-ui', 'ws-ui'], ['cli-docs', 'ws-docs']].map(([sessionId, workspaceId]) => ({ sessionId, workspaceId, createdAt: T0 })),
    chatLinks: [],
    sessions: new Map(),
    automations: [{ sessionId: 'cli-api', interval: 'minutes', everyMinutes: 10, lastRunAt: at(110), nextRunAt: at(125), pausedAt: null, name: 'PR monitor' }],
    diagnostics: [],
  };
}

function logs(contract) {
  const root = new EventLog(T0);
  root.start();
  root.at(at(100));
  root.turnStart();
  root.ask(contract ? '[unit=api need=pr] Publish PR !4711?' : 'Publish PR !4711?');

  const api = new EventLog(at(5));
  api.start();
  api.turnStart();
  api.at(at(20));
  const reviewer = api.subagent({ name: 'reviewer', type: 'code-review', mode: 'background', agentId: 'agent-r' });
  api.at(at(25));
  api.subagentDone(reviewer, { durationMs: 5 * MINUTE });
  api.at(at(30));
  api.report('ws-root', contract
    ? 'swarm-status: complete unit=api pr=ado:4711 commit=abc1234\nSummary: API done.\nEvidence:\n- 12 tests pass\nBlockers: none'
    : 'Need a decision before publishing PR !4711.', contract ? 'handoff' : 'needs_input');
  api.at(at(31));
  api.turnEnd();
  api.at(at(110));
  api.automationWake();
  api.turnStart();
  api.at(at(111));
  api.turnEnd();

  const ui = new EventLog(at(6));
  ui.start();
  ui.at(at(60));
  ui.turnStart();
  ui.at(at(90));
  ui.tool('bash', { command: 'npm run e2e', initial_wait: 60 });

  const docs = new EventLog(at(7));
  docs.start();
  docs.turnStart();
  docs.at(at(50));
  docs.turnEnd();
  docs.at(at(95));
  docs.report('ws-root', contract ? 'swarm-status: complete unit=docs pr=ado:4712\nSummary: Docs merged.' : 'Docs merged in PR !4712.', 'handoff');
  docs.at(at(99));
  docs.shutdown();
  return { root, api, ui, docs, reviewer };
}

function input(contract = true) {
  const app = appData();
  const { root, api, ui, docs, reviewer } = logs(contract);
  const ledger = createLedger();
  ledger.apply([
    { id: 1, session_id: 'cli-root', model: 'claude-opus-5.5', total_nano_aiu: 10e9, duration_ms: 1000, created_at: iso(1) },
    { id: 2, session_id: 'cli-api', model: 'gpt-5.5', total_nano_aiu: 20e9, duration_ms: 2000, created_at: iso(20) },
    { id: 3, session_id: 'cli-api', model: 'gpt-5.5', parent_tool_call_id: reviewer, agent_id: 'agent-r', total_nano_aiu: 5e9, duration_ms: 500, created_at: iso(22) },
  ]);
  const row = (unit, sessionId, title, extra = {}) => ({
    unit, session_id: sessionId, title, todo_id: unit, branch: null, base_branch: null, pr_provider: null, pr_repo: null, pr_id: null, pr_url: null,
    outcome: null, created_at: iso(5), updated_at: iso(30), ended_at: null, ...extra,
  });
  const children = contract ? [
    row('api', 'ws-api', 'API', { branch: 'feature/api', base_branch: 'main', pr_provider: 'ado', pr_repo: 'org/project/repo', pr_id: 4711 }),
    row('ui', 'cli-ui', 'UI', { branch: 'feature/ui', base_branch: 'feature/api' }),
    row('docs', 'ws-docs', 'Docs', { outcome: 'merged', ended_at: iso(95), updated_at: iso(100) }),
  ] : null;
  const todos = contract
    ? ['api:in_progress', 'ui:pending', 'docs:done', 'export:pending', 'unrelated:pending'].map(entry => {
      const [id, status] = entry.split(':');
      return { id, title: id[0].toUpperCase() + id.slice(1), description: '', status };
    })
    : [{ id: 'todo-api', title: 'API', description: 'Unit session ws-api', status: 'in_progress' }, { id: 'todo-next', title: 'Next', description: '', status: 'pending' }];
  const deps = contract
    ? [{ todoId: 'ui', dependsOn: 'api' }, { todoId: 'export', dependsOn: 'api' }]
    : [{ todoId: 'todo-next', dependsOn: 'todo-api' }];
  const requests = [];
  return {
    forest: buildForest(app), rootId: 'ws-root', app, ledger, requests,
    states: new Map([['cli-root', fold(root, 'cli-root')], ['cli-api', fold(api, 'cli-api')], ['cli-ui', fold(ui, 'cli-ui')], ['cli-docs', fold(docs, 'cli-docs')]]),
    alive: new Map([['cli-root', true], ['cli-api', true], ['cli-ui', true], ['cli-docs', false]]),
    workspaceFiles: new Map([['cli-api', { cwd: '/synthetic/worktrees/api', branch: 'feature/api', hostType: 'ado', repository: 'org/project/repo' }]]),
    sessionDbs: new Map([['cli-root', { todos, deps, children }]]),
    prInfo: (pr, options) => {
      requests.push({ ...pr, cwd: options.cwd });
      return contract && pr.provider === 'ado' && pr.id === 4711
        ? { state: 'open', title: 'API', openedAt: at(29), mergedAt: null, closedAt: null, reviewNote: '1 approval', url: null, checkedAt: at(115), error: null }
        : null;
    },
    now: at(120), thresholds: DEFAULT_THRESHOLDS, revision: 3, diagnostics: [],
  };
}

test('a contract-following swarm becomes a valid snapshot', () => {
  const data = input(true);
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.revision, 3);
  assert.deepEqual(snapshot.run.contract, { registry: true, statusLines: true, questionTags: true });
  assert.equal(snapshot.run.lifecycle, 'live');
  assert.equal(snapshot.run.firstChildAt, at(5));
  assert.equal(snapshot.run.project.name, 'sample-project');
  assert.equal(snapshot.orchestrator.statusDetail, 'waiting_question');
  assert.equal(snapshot.orchestrator.label, 'SS');
  assert.deepEqual(snapshot.units.map(unit => unit.label), ['api', 'ui', 'docs']);
  const [api, ui, docs] = snapshot.units;
  assert.deepEqual({ status: api.status, stage: api.stage, monitor: api.monitor.state, dependsOn: api.dependsOn, todoId: api.todoId, name: api.name },
    { status: 'idle', stage: 'in_review', monitor: 'alive', dependsOn: null, todoId: 'api', name: 'API' });
  assert.deepEqual({ provider: api.pr.provider, id: api.pr.id, repo: api.pr.repo, source: api.pr.source, state: api.pr.state, reviewNote: api.pr.reviewNote },
    { provider: 'ado', id: 4711, repo: 'org/project/repo', source: 'registry', state: 'open', reviewNote: '1 approval' });
  assert.deepEqual(
    { status: api.report.status, source: api.report.source, title: api.report.title, evidence: api.report.evidence, blockers: api.report.blockers, unit: api.report.unit, commit: api.report.commit },
    { status: 'complete', source: 'contract', title: 'API done.', evidence: ['12 tests pass'], blockers: [], unit: 'api', commit: 'abc1234' },
  );
  assert.deepEqual(api.subagents.map(sub => [sub.name, sub.status, sub.credits]), [['reviewer', 'completed', 5]]);
  assert.equal(api.cost.credits, 25);
  assert.deepEqual({ status: ui.status, detail: ui.statusDetail, since: ui.since, dependsOn: ui.dependsOn, stage: ui.stage },
    { status: 'stuck', detail: 'stuck_tool', since: at(90), dependsOn: 'api', stage: 'coding' });
  assert.equal(ui.reason, 'bash has run for 30 min with a limit of 6 min (initial_wait 1 min + 5 min).');
  assert.equal(ui.activity.tool.summary, 'bash: npm run e2e');
  assert.equal(ui.timeline.segments.at(-1).state, 'stuck');
  assert.deepEqual({ status: docs.status, stage: docs.stage, outcome: docs.outcome, monitor: docs.monitor.state, pr: docs.pr.id, alive: docs.alive, endedAt: docs.endedAt },
    { status: 'archived', stage: 'archived', outcome: 'merged', monitor: 'ended', pr: 4712, alive: false, endedAt: at(95) });
  assert.deepEqual(snapshot.planned, [{ label: 'export', name: 'Export', dependsOn: 'api', canStart: true, waitsOn: null, todoId: 'export' }]);
  assert.deepEqual(snapshot.needs, [{ id: 'ws-root:pr:cli-root/call-1', kind: 'pr', unitIds: ['ws-api'], labels: ['api'], fromId: 'ws-root', text: 'Publish PR !4711?', since: at(100), tagged: true }]);
  assert.deepEqual(snapshot.counts, { working: 0, stuck: 1, waiting: 0, idle: 1, done: 1, failed: 0 });
  assert.equal(snapshot.cost.credits, 35);
  assert.equal(snapshot.cost.usd, 0.35);
  assert.equal(snapshot.cost.maxUnitCredits, 25);
  assert.equal(snapshot.cost.series.at(-1).credits, 35);
  assert.ok(snapshot.feed.some(item => item.unitId === 'ws-api' && item.kind === 'report' && item.text === 'reported complete: API done.'));
  assert.ok(snapshot.feed.some(item => item.unitId === 'ws-root' && item.text === 'asked: Publish PR !4711?'));
  assert.ok(snapshot.feed.every((item, index, list) => index === 0 || list[index - 1].at >= item.at));
  const feedIds = snapshot.feed.map(item => item.id);
  assert.equal(new Set(feedIds).size, feedIds.length);
  assert.ok(snapshot.feed.every(item => item.id.startsWith(`${item.unitId}:${item.kind}:`)));
  for (const session of [snapshot.orchestrator, ...snapshot.units]) {
    assert.deepEqual(session.recent, snapshot.feed.filter(item => item.unitId === session.id).slice(0, 6));
  }
  assert.ok(data.requests.some(request => request.id === 4711));
});

test('a unit with an outcome stops its clock at the outcome time, even while its process runs', () => {
  const data = input(true);
  const lookup = data.prInfo;
  data.prInfo = (pr, options) => (pr.provider === 'ado' && pr.id === 4711
    ? { state: 'merged', title: 'API', openedAt: at(29), mergedAt: at(110), closedAt: at(110), reviewNote: null, url: null, checkedAt: at(115), error: null }
    : lookup(pr, options));
  const api = buildSnapshot(data).units.find(unit => unit.id === 'ws-api');
  assert.equal(api.outcome, 'merged');
  assert.equal(api.alive, true);
  assert.equal(api.endedAt, at(110));
  assert.equal(api.timeline.segments.at(-1).end, at(110));
});

test('the feed keeps its latest 200 items, and each session keeps its latest 6 from before the cut', () => {
  const item = (unitId, minute) => ({ id: `${unitId}:report:${minute}`, at: at(minute), unitId, label: unitId, kind: 'report', text: 'x' });
  const { feed, recent } = splitFeed([item('quiet', 0), ...Array.from({ length: 250 }, (_, index) => item('busy', 10 + index))]);
  assert.equal(feed.length, 200);
  assert.equal(feed[0].at, at(259));
  assert.ok(feed.every(entry => entry.unitId === 'busy'));
  assert.deepEqual(recent.get('quiet').map(entry => entry.at), [at(0)]);
  assert.deepEqual(recent.get('busy').map(entry => entry.at), [259, 258, 257, 256, 255, 254].map(minute => at(minute)));
});

test('without the contract, heuristics fill in labels, reports, PRs and plan entries', () => {
  const snapshot = buildSnapshot(input(false));
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.run.contract, { registry: false, statusLines: false, questionTags: false });
  assert.deepEqual(snapshot.units.map(unit => unit.label), ['a1', 'u1', 'd1']);
  const [api, ui, docs] = snapshot.units;
  assert.equal(api.statusDetail, 'blocked_on_orchestrator');
  assert.deepEqual({ status: api.report.status, source: api.report.source, body: api.report.body },
    { status: 'needs_input', source: 'purpose', body: 'Need a decision before publishing PR !4711.' });
  assert.deepEqual({ provider: api.pr.provider, id: api.pr.id, repo: api.pr.repo, source: api.pr.source, state: api.pr.state },
    { provider: 'ado', id: 4711, repo: 'org/project/repo', source: 'heuristic', state: 'unknown' });
  assert.equal(api.stage, 'in_review');
  assert.equal(api.todoId, 'todo-api');
  assert.equal(ui.dependsOn, 'a1');
  assert.equal(docs.outcome, null);
  assert.deepEqual(snapshot.planned, [{ label: 'todo-next', name: 'Next', dependsOn: 'a1', canStart: true, waitsOn: null, todoId: 'todo-next' }]);
  assert.deepEqual(snapshot.needs.map(need => [need.kind, need.unitIds, need.tagged]), [['question', [], false]]);
  assert.equal(snapshot.counts.waiting, 1);
});

test('a run is finished after two quiet hours with nothing active', () => {
  const thresholds = DEFAULT_THRESHOLDS;
  assert.deepEqual(runLifecycle({ lastActivityAt: T0, anyActive: false, now: T0 + 2 * HOUR, thresholds }), { lifecycle: 'finished', finishedAt: T0 });
  assert.deepEqual(runLifecycle({ lastActivityAt: T0, anyActive: false, now: T0 + 2 * HOUR - 1, thresholds }), { lifecycle: 'live', finishedAt: null });
  assert.deepEqual(runLifecycle({ lastActivityAt: T0, anyActive: true, now: T0 + 5 * HOUR, thresholds }), { lifecycle: 'live', finishedAt: null });
});

test('labels come from unique code-like words, then initials', () => {
  assert.deepEqual(deriveLabels(['Sample a0 parser checks', 'Sample a1 export format', 'Sample release notes', '4711 sample q1 UI checks']), ['a0', 'a1', 'RN', 'q1']);
});

test('timeline segments merge short gaps and show waits and a live stuck tail', () => {
  assert.deepEqual(buildSegments({ start: at(0), end: null, now: at(60), busy: [[at(10), at(20)], [at(21), at(30)]], waits: [[at(25), at(28), 'question']], stuckFrom: at(50) }), [
    { start: at(0), end: at(10), state: 'idle' },
    { start: at(10), end: at(25), state: 'busy' },
    { start: at(25), end: at(28), state: 'question' },
    { start: at(28), end: at(30), state: 'busy' },
    { start: at(30), end: at(50), state: 'idle' },
    { start: at(50), end: null, state: 'stuck' },
  ]);
});
