import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { MAX_FINISHED_SUBAGENT_UNITS, validateRunSummary, validateSnapshot } from '../engine/schema.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSegments, buildSnapshot, deriveLabels, runLifecycle, splitFeed } from '../engine/model/swarm.mjs';
import { ACTIVE_DETAILS } from '../engine/model/status.mjs';
import { summarizeRun } from '../engine/model/history.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { LIMITS } from '../engine/model/state-utils.mjs';
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

test('a session whose process is gone stops counting time, and its open questions leave the needs', () => {
  const data = input(true);
  data.alive.set('cli-root', false);
  const early = buildSnapshot(data);
  const late = buildSnapshot({ ...data, now: data.now + 24 * HOUR });
  assert.equal(early.orchestrator.endedAt, early.orchestrator.lastEventAt);
  assert.equal(late.orchestrator.endedAt, late.orchestrator.lastEventAt);
  assert.ok(early.orchestrator.busyMs >= 0);
  assert.equal(late.orchestrator.busyMs, early.orchestrator.busyMs);
  assert.equal(late.orchestrator.waitingOnUserMs, early.orchestrator.waitingOnUserMs);
  assert.deepEqual(early.needs, []);
  assert.deepEqual(late.needs, []);
});

test('an empty registry table keeps the heuristics', () => {
  const plain = buildSnapshot(input(false));
  const data = input(false);
  data.sessionDbs.get('cli-root').children = [];
  const snapshot = buildSnapshot(data);
  assert.deepEqual(snapshot.planned, plain.planned);
  assert.deepEqual(snapshot.units.map(unit => unit.todoId), plain.units.map(unit => unit.todoId));
  assert.equal(snapshot.run.contract.registry, false);
});

test('answered tagged questions still count as contract use', () => {
  const data = input(true);
  const root = new EventLog(T0);
  root.start();
  root.at(at(100));
  root.turnStart();
  const question = root.ask('[unit=api need=pr] Publish PR !4711?');
  root.at(at(101));
  root.done(question, { result: 'Yes, publish it.' });
  data.states.set('cli-root', fold(root, 'cli-root'));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(snapshot.needs, []);
  assert.equal(snapshot.run.contract.questionTags, true);
});

test('registry labels are assigned before derived labels', () => {
  const data = input(true);
  const rows = data.sessionDbs.get('cli-root').children
    .filter(row => row.unit !== 'api')
    .map(row => (row.unit === 'ui' ? { ...row, unit: 'a1' } : row));
  data.sessionDbs.get('cli-root').children = rows;
  const snapshot = buildSnapshot(data);
  assert.equal(snapshot.units.find(unit => unit.id === 'ws-ui').label, 'a1');
  assert.equal(snapshot.units.find(unit => unit.id === 'ws-api').label, 'a1-2');
});

const caseFolded = snapshot => [snapshot.orchestrator.label, ...snapshot.units.map(unit => unit.label), ...snapshot.planned.map(entry => entry.label)].map(label => label.toLowerCase());

test('a session whose derived label equals the orchestrator\'s takes the suffix', () => {
  const data = input(false);
  data.app.workspaces.get('ws-api').name = 'Some stuff';
  data.forest = buildForest(data.app);
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.orchestrator.label, 'SS');
  assert.equal(snapshot.units.find(unit => unit.id === 'ws-api').label, 'SS-2');
  assert.equal(new Set(caseFolded(snapshot)).size, caseFolded(snapshot).length);
});

test('a registry label equal to the orchestrator\'s stays with its unit, the orchestrator takes the suffix, and a tagged question still routes', () => {
  const data = input(true);
  const registry = data.sessionDbs.get('cli-root');
  registry.children = registry.children.map(row => (row.unit === 'ui' ? { ...row, unit: 'ss' } : row));
  const root = new EventLog(T0);
  root.start();
  root.at(at(100)); root.turnStart();
  root.ask('[unit=ss] Ship the UI now?');
  data.states.set('cli-root', fold(root, 'cli-root'));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.units.find(unit => unit.id === 'ws-ui').label, 'ss');
  assert.equal(snapshot.orchestrator.label, 'SS-2');
  assert.deepEqual(snapshot.needs.map(need => [need.kind, need.unitIds, need.labels, need.tagged]), [['question', ['ws-ui'], ['ss'], true]]);
  assert.equal(new Set(caseFolded(snapshot)).size, caseFolded(snapshot).length, caseFolded(snapshot).join(' '));
});

test('an unarchived unit whose PR was closed has an ended monitor', () => {
  const data = input(true);
  const lookup = data.prInfo;
  data.prInfo = (pr, options) => (pr.provider === 'ado' && pr.id === 4711
    ? { state: 'closed', title: 'API', openedAt: at(29), mergedAt: null, closedAt: at(100), reviewNote: null, url: null, checkedAt: at(115), error: null }
    : lookup(pr, options));
  const api = buildSnapshot(data).units.find(unit => unit.id === 'ws-api');
  assert.equal(api.closedWithoutMerge, true);
  assert.equal(api.stage, 'pr_open');
  assert.equal(api.monitor.state, 'ended');
  assert.equal(api.monitor.nextCheckAt, null);
});

test('a unit on an unknown code host gets no PR from mentions', () => {
  const data = input(false);
  assert.equal(buildSnapshot(data).units[0].pr.source, 'heuristic');
  data.workspaceFiles.set('cli-api', { cwd: '/synthetic/worktrees/api', branch: 'feature/api', hostType: null, repository: null });
  data.requests.length = 0;
  const [api] = buildSnapshot(data).units;
  assert.equal(api.pr, null);
  assert.equal(api.stage, 'coding');
  assert.equal(data.requests.length, 0);
});

test('the same report-inferred PR number in two worktrees keeps each worktree\'s own state', async () => {
  const data = input(false);
  const reporting = (start, minute) => {
    const log = new EventLog(at(start));
    log.start(); log.turnStart(); log.at(at(minute));
    log.report('ws-root', 'Opened PR !42 for review.', 'handoff');
    log.turnEnd();
    return log;
  };
  data.states.set('cli-api', fold(reporting(5, 30), 'cli-api'));
  data.states.set('cli-ui', fold(reporting(6, 40), 'cli-ui'));
  data.workspaceFiles.set('cli-api', { cwd: '/synthetic/worktrees/api', branch: 'feature/api', hostType: 'ado', repository: null });
  data.workspaceFiles.set('cli-ui', { cwd: '/synthetic/worktrees/ui', branch: 'feature/ui', hostType: 'ado', repository: null });
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => {
      calls.push(options.cwd);
      return options.cwd === '/synthetic/worktrees/api' ? '{"status":"completed","closedDate":"2026-10-15T09:50:00Z"}' : '{"status":"active"}';
    },
    now: () => at(120), exists: () => true, azureExtensionInstalled: async () => true,
  });
  data.prInfo = (pr, { cwd }) => {
    lookup.request(pr, { cwd });
    return lookup.get(pr, { cwd });
  };
  buildSnapshot(data);
  await lookup.settle();
  const units = buildSnapshot(data).units;
  const api = units.find(unit => unit.id === 'ws-api');
  const ui = units.find(unit => unit.id === 'ws-ui');
  assert.deepEqual(calls.sort(), ['/synthetic/worktrees/api', '/synthetic/worktrees/ui']);
  assert.deepEqual([api.pr.id, api.pr.state, api.outcome, api.stage], [42, 'merged', 'merged', 'merged']);
  assert.deepEqual([ui.pr.id, ui.pr.state, ui.outcome], [42, 'open', null]);
  assert.notEqual(ui.stage, 'merged');
});

/** The unit sent no report of its own; only the orchestrator's received copy of its status line exists. */
function receivedOnly({ registry }) {
  const data = input(true);
  const api = new EventLog(at(5));
  api.start(); api.turnStart(); api.at(at(31)); api.turnEnd();
  const root = new EventLog(T0);
  root.start();
  root.at(at(30));
  root.crossSession({ fromSessionId: 'cli-api', fromProjectSessionId: 'ws-api', name: 'api', content: 'swarm-status: complete unit=api pr=github:77\nSummary: API done.' });
  root.at(at(100));
  root.turnStart();
  data.states.set('cli-api', fold(api, 'cli-api'));
  data.states.set('cli-root', fold(root, 'cli-root'));
  if (!registry) data.sessionDbs = new Map([['cli-root', { todos: [], deps: [], children: null }]]);
  return data;
}

test('a unit that spans two CLI sessions lists at most 500 sub-agents, while the run counts all of them', () => {
  const data = input(true);
  data.app.aliases.push({ sessionId: 'cli-api-2', workspaceId: 'ws-api', createdAt: at(40) });
  data.forest = buildForest(data.app);
  assert.deepEqual([...data.forest.nodes.get('ws-api').cliSessionIds].sort(), ['cli-api', 'cli-api-2']);
  const session = (base, id) => {
    const log = new EventLog(at(5));
    log.calls = base;
    log.start(); log.turnStart();
    for (let i = 0; i < 350; i += 1) {
      const call = log.subagent({ mode: 'sync', type: 'explore' });
      log.wait(1000);
      log.subagentDone(call, { durationMs: 1000 });
      log.done(call);
    }
    log.turnEnd();
    return fold(log, id);
  };
  data.states.set('cli-api', session(0, 'cli-api'));
  data.states.set('cli-api-2', session(1000, 'cli-api-2'));
  data.alive.set('cli-api-2', true);
  const snapshot = buildSnapshot(data);
  const unit = snapshot.units.find(item => item.id === 'ws-api');
  assert.equal(unit.subagents.length, 500);
  assert.ok(unit.timeline.subagents.length <= 500);
  const summary = summarizeRun(snapshot, { computedAt: at(120) });
  assert.equal(summary.subagents, 700);
  assert.deepEqual(summary.subagentTypes.map(entry => [entry.type, entry.runs, entry.durationMs]), [['explore', 700, 700_000]]);
});

test('a status line that only the orchestrator received still gives the unit its PR', () => {
  const unit = buildSnapshot(receivedOnly({ registry: false })).units.find(item => item.id === 'ws-api');
  assert.equal(unit.report.source, 'contract');
  assert.equal(unit.pr.provider, 'github');
  assert.equal(unit.pr.id, 77);
  assert.equal(unit.pr.source, 'status_line');
  const withRegistry = buildSnapshot(receivedOnly({ registry: true })).units.find(item => item.id === 'ws-api');
  assert.deepEqual([withRegistry.pr.provider, withRegistry.pr.id, withRegistry.pr.source], ['ado', 4711, 'registry']);
});

test('a sub-agent that is retyped by its start event appears under its final type only in the run summary', () => {
  const data = input(true);
  const root = new EventLog(T0);
  root.start(); root.turnStart();
  const call = root.tool('task', { name: 'helper', mode: 'sync', description: 'no type given' });
  root.push('subagent.started', { toolCallId: call, agentType: 'explore', agentDisplayName: 'helper', executionMode: 'sync' });
  root.subagentDone(call, { durationMs: 1000 });
  root.at(at(100));
  root.turnStart();
  data.states.set('cli-root', fold(root, 'cli-root'));
  const summary = summarizeRun(buildSnapshot(data), { computedAt: at(120) });
  assert.deepEqual(summary.subagentTypes.map(entry => entry.type).sort(), ['code-review', 'explore']);
  assert.equal(summary.subagents, 2);
});

/** A root orchestrator log that asks `count` one-minute questions back to back from at(from). */
function askingLog(start, count, from) {
  const log = new EventLog(start);
  log.start(); log.turnStart();
  log.at(at(from));
  for (let i = 0; i < count; i += 1) {
    const question = log.ask('Go on?');
    log.wait(MINUTE);
    log.done(question, { result: 'Yes' });
  }
  return log;
}

test('a run summary counts waiting time that the bounded wait history dropped', () => {
  const data = input(true);
  const count = LIMITS.spans + 1;
  data.states.set('cli-root', fold(askingLog(T0, count, 200), 'cli-root'));
  data.now = at(200 + count + 10);
  const snapshot = buildSnapshot(data);
  const summary = summarizeRun(snapshot, { computedAt: data.now });
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(snapshot.orchestrator.waitingOnUserMs, count * MINUTE);
  assert.equal(summary.waitingOnUserMs, count * MINUTE);
});

test('a wait that two sessions share counts once in the run summary', () => {
  const data = input(true);
  data.states.set('cli-root', fold(askingLog(T0, 1, 40), 'cli-root'));
  data.states.set('cli-ui', fold(askingLog(at(6), 1, 40), 'cli-ui'));
  const snapshot = buildSnapshot(data);
  const ui = snapshot.units.find(unit => unit.id === 'ws-ui');
  assert.deepEqual([snapshot.orchestrator.waitingOnUserMs, ui.waitingOnUserMs], [MINUTE, MINUTE]);
  assert.equal(summarizeRun(snapshot, { computedAt: at(120) }).waitingOnUserMs, MINUTE);
});

// --- Sub-agent units: the orchestrator's one-off sub-agents ---

const ROOT_STATE = { subagentUnits: true };
const subUnits = snapshot => snapshot.units.filter(unit => unit.kind === 'subagent');
const NO_MONITOR = { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null };

/** The contract swarm with the orchestrator's log replaced by one that `build` fills in; it follows sub-agents in detail, as the engine's root sessions do. */
function withSubagents(build, { alive = true, now = at(120), ledger = [], contract = true } = {}) {
  const data = input(contract);
  const root = new EventLog(T0);
  root.calls = 100;
  root.start();
  root.at(at(1));
  const ids = build(root);
  data.states.set('cli-root', fold(root, 'cli-root', ROOT_STATE));
  data.alive.set('cli-root', alive);
  data.now = now;
  data.ledger.apply(ledger);
  return { data, ids };
}

function assertFixed(unit, agent) {
  assert.deepEqual(
    {
      kind: unit.kind, parentId: unit.parentId, depth: unit.depth, stage: unit.stage, pr: unit.pr, monitor: unit.monitor, outcome: unit.outcome,
      closedWithoutMerge: unit.closedWithoutMerge, progress: unit.progress, dependsOn: unit.dependsOn, todoId: unit.todoId,
      cliSessionIds: unit.cliSessionIds, branch: unit.branch, waitingOnUserMs: unit.waitingOnUserMs, alive: unit.alive, agent: unit.agent,
    },
    {
      kind: 'subagent', parentId: 'ws-root', depth: 1, stage: 'subagent', pr: null, monitor: NO_MONITOR, outcome: null,
      closedWithoutMerge: false, progress: null, dependsOn: null, todoId: null, cliSessionIds: [], branch: null, waitingOnUserMs: 0, alive: true, agent,
    },
    unit.label,
  );
}

test('sub-agent units show the orchestrator\'s one-off sub-agents in each state, after the session units, oldest start first', () => {
  const { data, ids } = withSubagents(root => {
    const ids = {};
    root.at(at(4)); ids.resumedRun = root.subagent({ name: 'resumed-run', type: 'explore', mode: 'background', effort: 'high', agentId: 'ag-rr' });
    root.at(at(5)); ids.resumedIdle = root.subagent({ name: 'resumed-idle', type: 'explore', mode: 'background', agentId: 'ag-ri' });
    root.sub(ids.resumedRun, 'assistant.message', { content: 'Round one' });
    root.at(at(5.5)); root.sub(ids.resumedIdle, 'assistant.message', { content: 'Round one' });
    root.at(at(6));
    root.subagentDone(ids.resumedRun, { durationMs: 2 * MINUTE, agentId: 'ag-rr' });
    root.subagentDone(ids.resumedIdle, { durationMs: MINUTE, agentId: 'ag-ri' });
    root.at(at(10)); ids.done = root.subagent({ name: 'done-one', type: 'explore', mode: 'background', agentId: 'ag-d' });
    root.at(at(11)); root.sub(ids.done, 'assistant.message', { content: 'First' });
    root.at(at(14)); root.sub(ids.done, 'assistant.message', { content: 'The final answer' }); root.sub(ids.done, 'assistant.message', { content: ' ' });
    root.at(at(15)); root.subagentDone(ids.done, { durationMs: 5 * MINUTE, agentId: 'ag-d' });
    root.at(at(20)); ids.failed = root.subagent({ name: 'failed-one', type: 'code-review', mode: 'background', agentId: 'ag-f' });
    root.at(at(21)); root.sub(ids.failed, 'assistant.message', { content: 'Trying' });
    root.at(at(22)); root.subagentDone(ids.failed, { failed: true, error: 'Quota exceeded', durationMs: 2 * MINUTE, agentId: 'ag-f' });
    root.at(at(30)); ids.cancelled = root.subagent({ name: 'cancelled-one', type: 'explore', mode: 'background', agentId: 'ag-c' });
    root.at(at(33)); root.subagentDone(ids.cancelled, { cancelled: true, durationMs: 3 * MINUTE, agentId: 'ag-c' });
    root.at(at(50)); ids.stuck = root.subagent({ name: 'stuck-one', type: 'explore', mode: 'background', agentId: 'ag-s' });
    root.at(at(60)); root.sub(ids.stuck, 'assistant.message', { content: 'Still going' });
    root.at(at(80)); root.toAgent('ag-ri', 'one more round'); root.sub(ids.resumedIdle, 'assistant.turn_start');
    root.at(at(84)); root.sub(ids.resumedIdle, 'assistant.message', { content: 'Round two' });
    root.at(at(85)); root.sub(ids.resumedIdle, 'assistant.turn_end');
    root.at(at(100)); ids.busy = root.subagent({ name: 'busy-one', type: 'explore', mode: 'background', agentId: 'ag-b' });
    root.at(at(110)); root.toAgent('ag-rr', 'again');
    root.at(at(115)); root.sub(ids.resumedRun, 'assistant.turn_start');
    root.at(at(118));
    root.sub(ids.busy, 'tool.execution_start', { toolCallId: 'tool-1', toolName: 'grep', arguments: { pattern: 'needle' } });
    root.sub(ids.busy, 'assistant.message', { content: 'Working on it' });
    return ids;
  });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.units.slice(0, 3).map(unit => unit.label), ['api', 'ui', 'docs'], 'session units come first');
  const subs = subUnits(snapshot);
  assert.deepEqual(subs.map(unit => unit.label), ['resumed-run', 'resumed-idle', 'done-one', 'failed-one', 'cancelled-one', 'stuck-one', 'busy-one']);
  assert.equal(snapshot.units.length, 3 + 7);
  const by = Object.fromEntries(subs.map(unit => [unit.label, unit]));
  const brief = unit => ({ id: unit.id, name: unit.name, status: unit.status, statusDetail: unit.statusDetail, bucket: unit.bucket, since: unit.since, reason: unit.reason, startedAt: unit.startedAt, endedAt: unit.endedAt, busyMs: unit.busyMs, lastEventAt: unit.lastEventAt, model: unit.model });

  const busy = by['busy-one'];
  assertFixed(busy, { type: 'explore', mode: 'background', effort: null });
  assert.deepEqual(brief(busy), {
    id: ids.busy, name: 'busy-one work', status: 'busy', statusDetail: 'busy', bucket: 'working', since: at(100), reason: null,
    startedAt: at(100), endedAt: null, busyMs: 20 * MINUTE, lastEventAt: at(118), model: 'claude-sonnet-5',
  });
  assert.deepEqual(busy.activity, {
    label: 'Running grep: needle', lastEventAt: at(118),
    tool: { id: 'tool-1', name: 'grep', summary: 'grep: needle', startedAt: at(118), limitMs: 2 * MINUTE },
  });
  assert.deepEqual(busy.report, { status: 'progress', source: 'message', at: at(118), title: 'Working on it', summary: null, evidence: [], blockers: null, body: 'Working on it', unit: null, commit: null, repliedAt: null });
  assert.deepEqual(busy.timeline, { segments: [{ start: at(100), end: null, state: 'busy' }], subagents: [], marks: [] });
  assert.deepEqual(busy.subagents, []);
  assert.deepEqual(busy.cost, { credits: 0, calls: 0 });

  const stuck = by['stuck-one'];
  assertFixed(stuck, { type: 'explore', mode: 'background', effort: null });
  assert.deepEqual(brief(stuck), {
    id: ids.stuck, name: 'stuck-one work', status: 'stuck', statusDetail: 'stuck_subagent', bucket: 'stuck', since: at(60),
    reason: 'No events for 60 min; the limit is 10 min.', startedAt: at(50), endedAt: null, busyMs: 70 * MINUTE, lastEventAt: at(60), model: 'claude-sonnet-5',
  });
  assert.deepEqual(stuck.activity, { label: 'Thinking', tool: null, lastEventAt: at(60) });
  assert.equal(stuck.report.status, 'progress');
  assert.deepEqual(stuck.timeline.segments, [{ start: at(50), end: at(60), state: 'busy' }, { start: at(60), end: null, state: 'stuck' }]);

  const done = by['done-one'];
  assertFixed(done, { type: 'explore', mode: 'background', effort: null });
  assert.deepEqual(brief(done), {
    id: ids.done, name: 'done-one work', status: 'done', statusDetail: 'completed', bucket: 'done', since: at(15), reason: null,
    startedAt: at(10), endedAt: at(15), busyMs: 5 * MINUTE, lastEventAt: at(15), model: 'claude-sonnet-5',
  });
  assert.deepEqual(done.activity, { label: 'Done', tool: null, lastEventAt: at(15) });
  assert.deepEqual(done.report, { status: 'complete', source: 'message', at: at(14), title: 'The final answer', summary: null, evidence: [], blockers: null, body: 'The final answer', unit: null, commit: null, repliedAt: null });
  assert.deepEqual(done.timeline.segments, [{ start: at(10), end: at(15), state: 'busy' }]);
  assert.deepEqual(done.timeline.marks, [{ at: at(15), kind: 'report', text: 'The final answer', status: 'complete' }]);

  const failed = by['failed-one'];
  assertFixed(failed, { type: 'code-review', mode: 'background', effort: null });
  assert.deepEqual(brief(failed), {
    id: ids.failed, name: 'failed-one work', status: 'blocked', statusDetail: 'failed', bucket: 'failed', since: at(22), reason: 'Failed: Quota exceeded',
    startedAt: at(20), endedAt: at(22), busyMs: 2 * MINUTE, lastEventAt: at(22), model: 'claude-sonnet-5',
  });
  assert.deepEqual(failed.activity, { label: 'Failed', tool: null, lastEventAt: at(22) });
  assert.deepEqual([failed.report.status, failed.report.title], ['blocked', 'Trying']);
  assert.deepEqual(failed.timeline.marks, [{ at: at(22), kind: 'report', text: 'Trying', status: 'blocked' }]);

  const cancelled = by['cancelled-one'];
  assert.deepEqual(brief(cancelled), {
    id: ids.cancelled, name: 'cancelled-one work', status: 'blocked', statusDetail: 'cancelled', bucket: 'failed', since: at(33),
    reason: 'Cancelled after 3 min.', startedAt: at(30), endedAt: at(33), busyMs: 3 * MINUTE, lastEventAt: at(33), model: 'claude-sonnet-5',
  });
  assert.deepEqual(cancelled.activity, { label: 'Cancelled', tool: null, lastEventAt: at(33) });
  assert.equal(cancelled.report, null);
  assert.deepEqual(cancelled.timeline.marks, []);

  const resumedRun = by['resumed-run'];
  assertFixed(resumedRun, { type: 'explore', mode: 'background', effort: 'high' });
  assert.deepEqual(brief(resumedRun), {
    id: ids.resumedRun, name: 'resumed-run work', status: 'busy', statusDetail: 'busy', bucket: 'working', since: at(110), reason: null,
    startedAt: at(4), endedAt: null, busyMs: 12 * MINUTE, lastEventAt: at(115), model: 'claude-sonnet-5',
  });
  assert.deepEqual([resumedRun.report.status, resumedRun.report.title], ['progress', 'Round one']);
  assert.deepEqual(resumedRun.timeline.segments, [
    { start: at(4), end: at(6), state: 'busy' }, { start: at(6), end: at(110), state: 'idle' }, { start: at(110), end: null, state: 'busy' },
  ]);
  assert.deepEqual(resumedRun.timeline.marks, []);

  const resumedIdle = by['resumed-idle'];
  assert.deepEqual(brief(resumedIdle), {
    id: ids.resumedIdle, name: 'resumed-idle work', status: 'done', statusDetail: 'completed', bucket: 'done', since: at(85), reason: null,
    startedAt: at(5), endedAt: at(85), busyMs: 6 * MINUTE, lastEventAt: at(85), model: 'claude-sonnet-5',
  });
  assert.deepEqual([resumedIdle.report.status, resumedIdle.report.title, resumedIdle.report.at], ['complete', 'Round two', at(84)]);
  assert.deepEqual(resumedIdle.timeline.segments, [
    { start: at(5), end: at(6), state: 'busy' }, { start: at(6), end: at(80), state: 'idle' }, { start: at(80), end: at(85), state: 'busy' },
  ]);

  assert.deepEqual(snapshot.counts, { working: 2, stuck: 2, waiting: 0, idle: 1, done: 3, failed: 2 });
  assert.deepEqual(snapshot.omittedSubagents, { done: 0, failed: 0 });
  assert.equal(snapshot.orchestrator.subagents.length, 7, 'the orchestrator still has a chip for each');
  assert.equal(snapshot.orchestrator.subagents.find(sub => sub.id === ids.cancelled).status, 'cancelled');
});

test('a sub-agent whose orchestrator process ended while it ran is crashed, and its clock stops at its last event', () => {
  const build = root => {
    root.at(at(100));
    const call = root.subagent({ name: 'lost', type: 'explore', mode: 'background', agentId: 'ag-lost' });
    root.at(at(105));
    root.sub(call, 'assistant.message', { content: 'Working' });
    return { call };
  };
  const early = buildSnapshot(withSubagents(build, { alive: false, now: at(110) }).data);
  const late = buildSnapshot(withSubagents(build, { alive: false, now: at(300) }).data);
  assert.deepEqual(validateSnapshot(late), []);
  const [unit] = subUnits(late);
  assert.deepEqual(
    { status: unit.status, detail: unit.statusDetail, bucket: unit.bucket, since: unit.since, endedAt: unit.endedAt, reason: unit.reason, alive: unit.alive, busyMs: unit.busyMs },
    {
      status: 'blocked', detail: 'crashed', bucket: 'failed', since: at(105), endedAt: at(105),
      reason: 'The orchestrator\'s process ended while this sub-agent was running.', alive: false, busyMs: 5 * MINUTE,
    },
  );
  assert.deepEqual(unit.activity, { label: 'Process ended unexpectedly', tool: null, lastEventAt: at(105) });
  assert.deepEqual([unit.report.status, unit.report.title], ['blocked', 'Working']);
  assert.deepEqual(unit.timeline.segments, [{ start: at(100), end: at(105), state: 'busy' }]);
  assert.deepEqual(unit.timeline.marks, [{ at: at(105), kind: 'report', text: 'Working', status: 'blocked' }]);
  assert.equal(subUnits(early)[0].busyMs, unit.busyMs);
  assert.equal(late.counts.failed, early.counts.failed);
  assert.equal(late.counts.failed, 1);
});

test('a snapshot lists every unfinished sub-agent and the latest finished ones, and counts the others as omitted', () => {
  assert.equal(MAX_FINISHED_SUBAGENT_UNITS, 20);
  const { data, ids } = withSubagents(root => {
    const ids = { finished: [], running: [] };
    root.at(at(10.5)); ids.running.push(root.subagent({ name: 'run-1', type: 'explore', mode: 'background', agentId: 'ag-r1' }));
    root.at(at(11.5)); ids.running.push(root.subagent({ name: 'run-2', type: 'explore', mode: 'background', agentId: 'ag-r2' }));
    for (let i = 0; i < 25; i += 1) {
      root.at(at(1 + i));
      ids.finished.push(root.subagent({ name: `done-${i}`, type: 'explore', mode: 'background', agentId: `ag-${i}` }));
    }
    for (let i = 0; i < 25; i += 1) {
      root.at(at(40 + i));
      root.subagentDone(ids.finished[i], { failed: i % 5 === 4, durationMs: MINUTE, agentId: `ag-${i}` });
    }
    root.at(at(119));
    for (const id of ids.running) root.sub(id, 'assistant.message', { content: 'still working' });
    return ids;
  });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const subs = subUnits(snapshot);
  assert.equal(subs.length, 22);
  assert.deepEqual(subs.map(unit => unit.label), [
    ...[5, 6, 7, 8, 9].map(i => `done-${i}`), 'run-1', 'done-10', 'run-2', ...Array.from({ length: 14 }, (_, k) => `done-${11 + k}`),
  ]);
  assert.deepEqual(snapshot.omittedSubagents, { done: 4, failed: 1 });
  assert.deepEqual(snapshot.counts, { working: 2, stuck: 1, waiting: 0, idle: 1, done: 21, failed: 5 });
  assert.equal(snapshot.units.length, 3 + 22);
  assert.ok(snapshot.feed.some(item => item.unitId === ids.finished[0] && item.label === 'done-0' && item.text === 'completed explore: done-0'),
    'an omitted unit keeps its feed items, under its own unit id and label');
  assert.equal(snapshot.feed.some(item => item.unitId === ids.finished[4] && item.kind === 'subagent-done' && item.text === 'failed explore: done-4'), true);
  assert.ok(subs.every(unit => snapshot.feed.some(item => item.unitId === unit.id)), 'every listed unit has items in the feed');
  const feedIds = snapshot.feed.map(item => item.id);
  assert.equal(new Set(feedIds).size, feedIds.length);
});

test('a finished sub-agent that left the 500 details still counts as omitted', () => {
  const { data } = withSubagents(root => {
    for (let i = 0; i < 505; i += 1) {
      const call = root.subagent({ name: `s-${i}`, type: 'explore', mode: 'sync' });
      root.wait(1000);
      root.subagentDone(call, { durationMs: 1000 });
      root.done(call);
    }
  });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.orchestrator.subagents.length, 500);
  assert.equal(subUnits(snapshot).length, 20);
  assert.deepEqual(snapshot.omittedSubagents, { done: 485, failed: 0 });
  assert.equal(snapshot.counts.done, 1 + 20 + 485, 'the session unit, the listed ones and the omitted ones: every sub-agent is counted once');
});

test('labels come from the task names, made safe, unique against every label, and a fallback names the type and position', () => {
  const { data } = withSubagents(root => {
    const start = (name, extra = {}) => {
      root.wait(MINUTE);
      return root.subagent({ name, type: 'explore', mode: 'background', ...extra });
    };
    root.at(at(100));
    for (const name of ['api', 'Fix the bug!', 'fix the bug', '***', 'API', 'x'.repeat(40), 'x'.repeat(40), 'ss']) start(name);
    root.wait(MINUTE);
    const described = root.tool('task', { description: 'Do things!', agent_type: 'explore', mode: 'background' });
    root.push('subagent.started', { toolCallId: described, agentType: 'review', agentDisplayName: 'Renamed at start', executionMode: 'background' });
    root.wait(MINUTE);
    root.tool('task', { agent_type: 'review', mode: 'background' });
    start('export');
  });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.orchestrator.label, 'SS');
  assert.deepEqual(snapshot.planned.map(entry => entry.label), ['export']);
  assert.deepEqual(subUnits(snapshot).map(unit => unit.label), [
    'api-2', 'Fix-the-bug', 'fix-the-bug-2', 'explore-4', 'API-3', 'x'.repeat(32), `${'x'.repeat(30)}-2`, 'ss-2', 'explore-9', 'review-10', 'export-2',
  ]);
  assert.equal(subUnits(snapshot)[8].name, 'Do things!', 'a task without a name is labelled by its type and position; the unit is still named by its description');
  const labels = [snapshot.orchestrator.label, ...snapshot.units.map(unit => unit.label), ...snapshot.planned.map(entry => entry.label)].map(label => label.toLowerCase());
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(subUnits(snapshot).every(unit => /^[A-Za-z0-9._-]{1,32}$/.test(unit.label)));
});

test('a task without a name keeps its type-and-position label when its start event names another type', () => {
  const { data } = withSubagents(root => {
    root.at(at(100));
    const call = root.tool('task', { agent_type: 'general-purpose', mode: 'background' });
    root.push('subagent.started', { toolCallId: call, agentType: 'explore', agentDisplayName: 'Display Name', executionMode: 'background' }, { agentId: 'ag-late' });
  });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const [unit] = subUnits(snapshot);
  assert.deepEqual([unit.label, unit.agent.type, unit.name], ['general-purpose-1', 'explore', 'Display Name']);
});

test('a sub-agent keeps its label when the set of listed units changes', () => {
  const build = extra => root => {
    for (let i = 0; i < 25; i += 1) {
      root.at(at(1 + i));
      const call = root.subagent({ name: 'same', type: 'explore', mode: 'background', agentId: `ag-${i}` });
      root.at(at(40 + i));
      root.subagentDone(call, { durationMs: MINUTE, agentId: `ag-${i}` });
    }
    if (extra) {
      root.at(at(30));
      const call = root.subagent({ name: 'same', type: 'explore', mode: 'background', agentId: 'ag-extra' });
      root.at(at(70));
      root.subagentDone(call, { durationMs: MINUTE, agentId: 'ag-extra' });
    }
  };
  const before = subUnits(buildSnapshot(withSubagents(build(false)).data));
  assert.deepEqual(before.map(unit => unit.label), Array.from({ length: 20 }, (_, k) => `same-${k + 6}`));
  const after = subUnits(buildSnapshot(withSubagents(build(true)).data));
  const labelOf = new Map(after.map(unit => [unit.id, unit.label]));
  assert.equal(after.length, 20);
  assert.ok(before.length > 0);
  for (const unit of before) if (labelOf.has(unit.id)) assert.equal(labelOf.get(unit.id), unit.label);
  assert.ok(labelOf.size > 0 && before.some(unit => !labelOf.has(unit.id)), 'the listed set did change');
});

const costRows = (parents, rows) => rows.map(([id, parent, nano]) => ({ id, session_id: 'cli-root', model: 'gpt-5.5', parent_tool_call_id: parents[parent] ?? null, total_nano_aiu: nano, duration_ms: 100, created_at: iso(30) }));

test('a sub-agent unit costs what it and its own sub-agents cost, while the orchestrator\'s total and its chips stay as they were', () => {
  const ids = {};
  const { data } = withSubagents(root => {
    root.at(at(10));
    ids.lead = root.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: 'ag-l' });
    ids.kid = root.nested(ids.lead, { name: 'kid', type: 'explore', mode: 'background', agentId: 'ag-k' });
    ids.grand = root.nested(ids.kid, { name: 'grand', type: 'explore', mode: 'background', agentId: 'ag-g' });
    root.at(at(100));
    ids.other = root.subagent({ name: 'other', type: 'explore', mode: 'background', agentId: 'ag-o' });
    root.at(at(118));
    root.sub(ids.other, 'assistant.message', { content: 'busy' });
    root.sub(ids.lead, 'assistant.message', { content: 'busy' });
    root.sub(ids.grand, 'assistant.message', { content: 'busy' });
  });
  data.ledger.apply(costRows(ids, [
    [10, 'lead', 20e9], [11, 'kid', 10e9], [12, 'grand', 15e9], [13, 'other', 1e9], [14, null, 4e9],
  ]));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const lead = snapshot.units.find(unit => unit.id === ids.lead);
  assert.deepEqual(lead.cost, { credits: 45, calls: 3 });
  assert.deepEqual(snapshot.units.find(unit => unit.id === ids.other).cost, { credits: 1, calls: 1 });
  assert.deepEqual(lead.subagents.map(sub => [sub.id, sub.name, sub.credits]), [[ids.kid, 'kid', 25]], 'a child\'s chip rolls up its own sub-agents');
  const chips = Object.fromEntries(snapshot.orchestrator.subagents.map(sub => [sub.id, sub.credits]));
  assert.deepEqual([chips[ids.lead], chips[ids.other]], [20, 1], 'the orchestrator\'s chips count only each sub-agent\'s own calls');
  assert.equal(snapshot.orchestrator.cost.credits, 10 + 20 + 10 + 15 + 1 + 4);
  assert.equal(snapshot.cost.credits, 35 + 20 + 10 + 15 + 1 + 4, 'sub-agent costs are not added a second time');
  assert.equal(snapshot.cost.maxUnitCredits, 45, 'the largest unit can be a sub-agent unit');
});

test('feed items about a one-off sub-agent belong to its unit, not to the orchestrator', () => {
  const ids = {};
  const { data } = withSubagents(root => {
    root.at(at(10)); ids.lead = root.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: 'ag-l' });
    root.at(at(11)); ids.kid = root.nested(ids.lead, { name: 'kid', type: 'explore', mode: 'sync', agentId: 'ag-k' });
    root.at(at(12)); root.subagentDone(ids.kid, { durationMs: MINUTE, agentId: 'ag-k' });
    root.at(at(14)); root.subagentDone(ids.lead, { durationMs: 4 * MINUTE, agentId: 'ag-l' });
    root.at(at(20)); root.toAgent('ag-l', 'once more');
    root.at(at(21)); root.sub(ids.lead, 'assistant.turn_start');
  });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.orchestrator.recent.filter(item => item.kind.startsWith('subagent')), []);
  assert.equal(snapshot.feed.some(item => item.unitId === snapshot.orchestrator.id && item.kind.startsWith('subagent')), false);
  const lead = snapshot.units.find(unit => unit.id === ids.lead);
  assert.deepEqual(lead.recent.map(item => [item.kind, item.text]), [
    ['subagent-start', 'resumed general-purpose: lead'], ['subagent-done', 'completed general-purpose: lead'], ['subagent-done', 'completed explore: kid'],
    ['subagent-start', 'started explore: kid (sync)'], ['subagent-start', 'started general-purpose: lead'],
  ]);
  assert.ok(lead.recent.every(item => item.unitId === ids.lead && item.label === 'lead'));
  assert.deepEqual(snapshot.feed.filter(item => item.unitId === ids.lead), lead.recent);
  const feedIds = snapshot.feed.map(item => item.id);
  assert.equal(new Set(feedIds).size, feedIds.length);
  assert.ok(lead.recent.every(item => item.id.startsWith(`${ids.lead}:${item.kind}:`)));
});

function quietSwarm(build, now) {
  const { data, ids } = withSubagents(build, { now });
  const ui = new EventLog(at(6));
  ui.start(); ui.turnStart(); ui.at(at(30)); ui.turnEnd();
  data.states.set('cli-ui', fold(ui, 'cli-ui'));
  data.app.automations = [];
  return { data, ids };
}

test('a run whose only activity is a silent resumed sub-agent stays live, and finishes once it is not', () => {
  const build = resumed => root => {
    root.at(at(60));
    const call = root.subagent({ name: 'late', type: 'explore', mode: 'background', agentId: 'ag-late' });
    root.at(at(61));
    root.subagentDone(call, { durationMs: MINUTE, agentId: 'ag-late' });
    if (resumed) {
      root.at(at(62));
      root.toAgent('ag-late', 'again');
    }
  };
  const live = buildSnapshot(quietSwarm(build(true), at(261)).data);
  assert.equal(subUnits(live)[0].statusDetail, 'stuck_subagent');
  assert.equal(live.run.lifecycle, 'live');
  assert.equal(live.run.finishedAt, null);
  const finished = buildSnapshot(quietSwarm(build(false), at(261)).data);
  assert.equal(subUnits(finished)[0].statusDetail, 'completed');
  assert.equal(finished.run.lifecycle, 'finished');
  assert.equal(finished.run.finishedAt, at(111));
});

test('a live run with nothing active is quiet since its last activity, and is not quiet while anything is active', () => {
  const build = ({ running = false, resumed = false } = {}) => root => {
    root.at(at(60));
    const call = root.subagent({ name: 'one', type: 'explore', mode: 'background', agentId: 'ag-1' });
    root.at(at(61));
    if (!running) root.subagentDone(call, { durationMs: MINUTE, agentId: 'ag-1' });
    if (resumed) {
      root.at(at(125));
      root.turnStart();
    }
  };
  const quiet = buildSnapshot(quietSwarm(build(), at(130)).data);
  assert.deepEqual(validateSnapshot(quiet), []);
  assert.equal(quiet.run.lifecycle, 'live');
  assert.equal(quiet.run.lastActivityAt, at(111));
  assert.equal(quiet.run.quietSince, at(111));

  const active = buildSnapshot(quietSwarm(build({ running: true }), at(130)).data);
  assert.deepEqual(validateSnapshot(active), []);
  assert.ok(ACTIVE_DETAILS.has(subUnits(active)[0].statusDetail));
  assert.equal(active.run.lifecycle, 'live');
  assert.equal(active.run.quietSince, null);

  const resumed = buildSnapshot(quietSwarm(build({ resumed: true }), at(130)).data);
  assert.deepEqual(validateSnapshot(resumed), []);
  assert.ok(ACTIVE_DETAILS.has(resumed.orchestrator.statusDetail));
  assert.equal(resumed.run.lastActivityAt, at(125));
  assert.equal(resumed.run.quietSince, null);

  const finished = buildSnapshot(quietSwarm(build(), at(111) + 2 * HOUR).data);
  assert.equal(finished.run.lifecycle, 'finished');
  assert.equal(finished.run.quietSince, finished.run.finishedAt);
});

/**
 * The quiet swarm, except that the UI child starts a background task at minute 116, ends its own turn at 117, and its agent writes
 * at 118. With done, the task completes at 120; with resumed, the child starts a new turn at 124.
 */
function childBackgroundSwarm(now, { done = false, resumed = false, alive = true } = {}) {
  const { data } = quietSwarm(() => {}, now);
  const ui = new EventLog(at(6));
  ui.start(); ui.at(at(115)); ui.turnStart();
  ui.at(at(116)); const call = ui.subagent({ name: 'bg', type: 'general-purpose', mode: 'background', agentId: 'ag-bg' });
  ui.at(at(117)); ui.turnEnd();
  ui.at(at(118)); ui.sub(call, 'assistant.message', { content: 'still working' });
  if (done) { ui.at(at(120)); ui.subagentDone(call, { durationMs: 4 * MINUTE, agentId: 'ag-bg' }); }
  if (resumed) { ui.at(at(124)); ui.turnStart(); }
  data.states.set('cli-ui', fold(ui, 'cli-ui'));
  data.alive.set('cli-ui', alive);
  return buildSnapshot(data);
}
const uiUnit = snapshot => snapshot.units.find(unit => unit.id === 'ws-ui');

test('a background task a child session started keeps the run active after the child ends its turn, while its CLI is alive', () => {
  for (const now of [at(119), at(122)]) {
    const snapshot = childBackgroundSwarm(now);
    assert.deepEqual(validateSnapshot(snapshot), []);
    assert.equal(uiUnit(snapshot).endedAt, null);
    assert.equal(snapshot.run.lifecycle, 'live');
    assert.equal(snapshot.run.quietSince, null, 'the run and unit clocks tick while the task runs');
  }
  const completed = childBackgroundSwarm(at(125), { done: true });
  assert.deepEqual(validateSnapshot(completed), []);
  assert.equal(completed.run.lastActivityAt, at(120));
  assert.equal(completed.run.quietSince, at(120), 'once the task completes the run is quiet since its last activity');
  const resumed = childBackgroundSwarm(at(126), { done: true, resumed: true });
  assert.equal(resumed.run.quietSince, null, 'the clocks tick again once the child works again');
});

test('a background task of a child session whose CLI is gone does not keep the run active', () => {
  const snapshot = childBackgroundSwarm(at(122), { alive: false });
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.run.quietSince, at(118));
  const later = childBackgroundSwarm(at(118) + 2 * HOUR, { alive: false });
  assert.equal(later.run.lifecycle, 'finished');
  assert.equal(later.run.finishedAt, at(118));
});

test('completed and cancelled sub-agent units do not keep a swarm from stalling, and a busy one does', () => {
  const finishedOnes = root => {
    root.at(at(60));
    const done = root.subagent({ name: 'one', type: 'explore', mode: 'background', agentId: 'ag-1' });
    const cancelled = root.subagent({ name: 'two', type: 'explore', mode: 'background', agentId: 'ag-2' });
    root.at(at(61));
    root.subagentDone(done, { durationMs: MINUTE, agentId: 'ag-1' });
    root.subagentDone(cancelled, { cancelled: true, durationMs: MINUTE, agentId: 'ag-2' });
  };
  const stalled = buildSnapshot(quietSwarm(finishedOnes, at(130)).data);
  assert.deepEqual(subUnits(stalled).map(unit => unit.statusDetail), ['completed', 'cancelled']);
  assert.equal(stalled.run.lifecycle, 'live');
  assert.deepEqual(stalled.run.stalled, { since: at(111), reason: 'The orchestrator and every open unit are idle or ended, and no monitor is due.' });
  const busyToo = buildSnapshot(quietSwarm(root => {
    finishedOnes(root);
    root.at(at(125));
    root.subagent({ name: 'three', type: 'explore', mode: 'background', agentId: 'ag-3' });
  }, at(130)).data);
  assert.equal(subUnits(busyToo).at(-1).statusDetail, 'busy');
  assert.equal(busyToo.run.stalled, null);
});

test('a sub-agent left running in an older root CLI session whose process is gone is crashed, and does not keep the run live', () => {
  const swarm = alive => {
    const { data } = quietSwarm(() => {}, at(261));
    data.app.aliases.push({ sessionId: 'cli-root-old', workspaceId: 'ws-root', createdAt: T0 - MINUTE });
    data.forest = buildForest(data.app);
    assert.deepEqual(data.forest.nodes.get('ws-root').cliSessionIds, ['cli-root-old', 'cli-root']);
    const old = new EventLog(T0);
    old.calls = 200;
    old.start();
    old.at(at(60));
    old.subagent({ name: 'orphan', type: 'explore', mode: 'background', agentId: 'ag-orphan' });
    old.at(at(61));
    old.sub('call-201', 'assistant.message', { content: 'Working' });
    data.states.set('cli-root-old', fold(old, 'cli-root-old', ROOT_STATE));
    data.alive.set('cli-root-old', alive);
    return buildSnapshot(data);
  };
  const gone = swarm(false);
  assert.deepEqual(validateSnapshot(gone), []);
  const [unit] = subUnits(gone);
  assert.deepEqual([unit.label, unit.statusDetail, unit.bucket, unit.endedAt, unit.alive], ['orphan', 'crashed', 'failed', at(61), true]);
  assert.equal(gone.run.lifecycle, 'finished');
  assert.equal(gone.counts.failed, 1);
  const running = swarm(true);
  assert.equal(subUnits(running)[0].statusDetail, 'stuck_subagent', 'a live older session is judged like the current one');
  assert.equal(running.run.lifecycle, 'live');
});

test('a unit counts the busy time of runs that dropped out of its bounded list', () => {
  const { data } = withSubagents(root => {
    root.at(at(10));
    const call = root.subagent({ name: 'many', type: 'explore', mode: 'background', agentId: 'ag-many' });
    root.wait(1000); root.subagentDone(call, { durationMs: 1000, agentId: 'ag-many' });
    for (let i = 0; i < 55; i += 1) {
      root.wait(1000); root.toAgent('ag-many', `again ${i}`);
      root.wait(1000); root.sub(call, 'assistant.turn_end');
    }
  });
  const [unit] = subUnits(buildSnapshot(data));
  assert.equal(unit.busyMs, 56_000);
});

test('the run summary leaves sub-agent units out of its children, units and busy time, and counts every sub-agent once', () => {
  const ids = {};
  const { data } = withSubagents(root => {
    root.at(at(10));
    ids.lead = root.subagent({ name: 'lead', type: 'general-purpose', mode: 'background', agentId: 'ag-l' });
    ids.kid = root.nested(ids.lead, { name: 'kid', type: 'explore', mode: 'background', agentId: 'ag-k' });
    ids.grand = root.nested(ids.kid, { name: 'grand', type: 'explore', mode: 'background', agentId: 'ag-g' });
    root.at(at(118));
    root.sub(ids.grand, 'assistant.message', { content: 'busy' });
  });
  data.ledger.apply(costRows(ids, [[10, 'lead', 20e9], [11, 'kid', 10e9], [12, 'grand', 15e9]]));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(subUnits(snapshot).map(unit => unit.id), [ids.lead], 'the unit exists, and the summary still leaves it out');
  const summary = summarizeRun(snapshot, { computedAt: at(120) });
  assert.deepEqual(validateRunSummary(summary), []);
  const sessions = [snapshot.orchestrator, ...snapshot.units.filter(unit => unit.kind !== 'subagent')];
  assert.equal(summary.busyMs, sessions.reduce((sum, session) => sum + session.busyMs, 0));
  assert.deepEqual(summary.children, { total: 3, merged: 1, closed: 0, failed: 0, noOutcome: 2 });
  assert.deepEqual(summary.units.map(unit => unit.id), ['ws-root', 'ws-api', 'ws-ui', 'ws-docs']);
  assert.equal(summary.subagents, 1 + 3, 'the unit\'s session reviewer, the one-off sub-agent and its two nested ones');
  assert.deepEqual(summary.subagentTypes.map(entry => [entry.type, entry.runs, entry.credits]).sort(), [['code-review', 1, 5], ['explore', 2, 25], ['general-purpose', 1, 20]]);
});

test('a child session\'s sub-agents stay chips, with no units of their own', () => {
  const { data } = withSubagents(root => {
    root.at(at(100));
    root.subagent({ name: 'own', type: 'explore', mode: 'background', agentId: 'ag-own' });
  });
  data.states.set('cli-api', fold((() => {
    const api = new EventLog(at(5));
    api.start(); api.turnStart(); api.at(at(20));
    api.subagent({ name: 'reviewer', type: 'code-review', mode: 'background', agentId: 'agent-r' });
    return api;
  })(), 'cli-api', ROOT_STATE));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(subUnits(snapshot).map(unit => unit.label), ['own']);
  assert.deepEqual(snapshot.units.find(unit => unit.id === 'ws-api').subagents.map(sub => sub.name), ['reviewer']);
  assert.deepEqual(snapshot.omittedSubagents, { done: 0, failed: 0 });
});

// --- A follow-up run that the orchestrator's abort or shutdown stops ---

/** A task that finishes at minute 61, gets a follow-up at 62 and starts its turn at 63; `end` then adds what stops it. */
function followUpSwarm(mode, end, now, { nested = false } = {}) {
  const ids = {};
  const { data } = quietSwarm(root => {
    root.at(at(55)); root.turnStart();
    root.at(at(60)); ids.call = root.subagent({ name: 'late', type: 'explore', mode, agentId: 'ag-late' });
    root.at(at(61)); ids.firstDone = root.subagentDone(ids.call, { durationMs: MINUTE, agentId: 'ag-late' });
    root.at(at(62)); root.toAgent('ag-late', 'again');
    root.at(at(63)); root.sub(ids.call, 'assistant.turn_start');
    if (nested) ids.child = root.nested(ids.call, { name: 'kid', type: 'explore', mode: 'sync', agentId: 'ag-kid' });
    root.at(at(64)); root.sub(ids.call, 'assistant.message', { content: 'Working on it' });
    end(root);
  }, now);
  return { data, ids };
}

test('a shutdown fails the open follow-up of a finished sub-agent, and its chip keeps its first outcome', () => {
  const { data, ids } = followUpSwarm('background', root => { root.at(at(70)); root.shutdown(); }, at(80));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const [unit] = subUnits(snapshot);
  assert.deepEqual(
    { status: unit.status, detail: unit.statusDetail, bucket: unit.bucket, reason: unit.reason, endedAt: unit.endedAt, report: unit.report.status },
    { status: 'blocked', detail: 'failed', bucket: 'failed', reason: 'Failed: Stopped when the orchestrator\'s process ended.', endedAt: at(70), report: 'blocked' },
  );
  assert.deepEqual([unit.recent[0].kind, unit.recent[0].text, unit.recent[0].at], ['subagent-done', 'failed explore: late', at(70)]);
  const firstDone = unit.recent.find(item => item.text === 'completed explore: late');
  assert.ok(firstDone && firstDone.id !== unit.recent[0].id, 'the failure is its own item, not the first completion');
  const chip = snapshot.orchestrator.subagents.find(sub => sub.id === ids.call);
  assert.deepEqual([chip.status, chip.endedAt], ['completed', at(61)]);
  assert.equal(snapshot.counts.failed, 1);
});

test('an abort cancels the open follow-up of a finished sync sub-agent, so the run can finish', () => {
  const end = root => { root.at(at(65)); root.abort(); };
  const { data } = followUpSwarm('sync', end, at(111 + 121));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const [unit] = subUnits(snapshot);
  assert.deepEqual([unit.statusDetail, unit.bucket, unit.endedAt, unit.reason], ['cancelled', 'failed', at(65), 'Cancelled after 3 min.']);
  assert.equal(unit.recent[0].text, 'cancelled explore: late');
  assert.equal(snapshot.run.lifecycle, 'finished');
});

test('an abort leaves the follow-up of a background sub-agent running', () => {
  const { data } = followUpSwarm('background', root => { root.at(at(65)); root.abort(); }, at(66));
  const snapshot = buildSnapshot(data);
  const [unit] = subUnits(snapshot);
  assert.deepEqual([unit.statusDetail, unit.endedAt], ['busy', null]);
  assert.equal(snapshot.run.lifecycle, 'live');
});

test('a cancelled sync follow-up takes its running sync child with it', () => {
  const { data, ids } = followUpSwarm('sync', root => { root.at(at(65)); root.abort(); }, at(66), { nested: true });
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const [unit] = subUnits(snapshot);
  assert.equal(unit.statusDetail, 'cancelled');
  assert.deepEqual(unit.subagents.map(sub => [sub.id, sub.status]), [[ids.child, 'cancelled']]);
});

test('a follow-up that completes shows a completed item as the latest of its unit, with an id of its own', () => {
  const ids = {};
  const { data } = quietSwarm(root => {
    root.at(at(60)); ids.call = root.subagent({ name: 'late', type: 'explore', mode: 'background', agentId: 'ag-late' });
    root.at(at(61)); root.subagentDone(ids.call, { durationMs: MINUTE, agentId: 'ag-late' });
    root.at(at(62)); root.toAgent('ag-late', 'again');
    root.at(at(63)); root.sub(ids.call, 'assistant.turn_start');
    root.at(at(65)); root.sub(ids.call, 'assistant.turn_end');
  }, at(70));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const [unit] = subUnits(snapshot);
  assert.deepEqual([unit.statusDetail, unit.endedAt], ['completed', at(65)]);
  assert.deepEqual([unit.recent[0].text, unit.recent[0].at], ['completed explore: late', at(65)]);
  const first = unit.recent.find(item => item.at === at(61));
  assert.equal(first.text, 'completed explore: late');
  assert.notEqual(first.id, unit.recent[0].id);
  const ids2 = snapshot.feed.map(item => item.id);
  assert.equal(new Set(ids2).size, ids2.length);
});

// --- A nested sub-agent that still works keeps the run live ---

/** A top task with a nested one (and, at depth 2, a grandchild). Only the ones above the last level complete; the last one sends an event at minute 112. */
function nestedSwarm({ now = at(112 + 121), alive = true, depth = 1 } = {}) {
  const ids = {};
  const { data } = quietSwarm(root => {
    root.at(at(100)); ids.top = root.subagent({ name: 'top', type: 'explore', mode: 'background', agentId: 'ag-top' });
    root.at(at(101)); ids.kid = root.nested(ids.top, { name: 'kid', type: 'explore', mode: 'background', agentId: 'ag-kid' });
    if (depth === 2) ids.grand = root.nested(ids.kid, { name: 'grand', type: 'explore', mode: 'background', agentId: 'ag-grand' });
    root.at(at(102)); root.subagentDone(ids.top, { durationMs: 2 * MINUTE, agentId: 'ag-top' });
    if (depth === 2) root.subagentDone(ids.kid, { durationMs: MINUTE, agentId: 'ag-kid' });
    root.at(at(112)); root.sub(ids.grand ?? ids.kid, 'assistant.message', { content: 'still here' });
  }, now);
  data.alive.set('cli-root', alive);
  return { data, ids };
}

test('a run stays live while a nested sub-agent works under a completed top task, and finishes when the process is gone', () => {
  const { data } = nestedSwarm();
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const [top] = subUnits(snapshot);
  assert.equal(top.statusDetail, 'completed', 'the unit statuses are not changed');
  assert.deepEqual(top.subagents.map(sub => sub.status), ['stuck']);
  assert.equal(snapshot.run.lifecycle, 'live');
  assert.equal(snapshot.run.finishedAt, null);
  const dead = buildSnapshot(nestedSwarm({ alive: false }).data);
  assert.equal(dead.run.lifecycle, 'finished');
  assert.equal(dead.run.finishedAt, at(112));
});

test('a grandchild that still works under a completed child and top task keeps the run live', () => {
  const snapshot = buildSnapshot(nestedSwarm({ depth: 2 }).data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(subUnits(snapshot)[0].statusDetail, 'completed');
  assert.equal(snapshot.run.lifecycle, 'live');
});

test('a running nested sub-agent in a child session keeps the run live', () => {
  const { data } = quietSwarm(() => {}, at(112 + 121));
  const api = new EventLog(at(5));
  api.start(); api.turnStart(); api.at(at(20));
  const top = api.subagent({ name: 'reviewer', type: 'code-review', mode: 'background', agentId: 'agent-r' });
  api.nested(top, { name: 'kid', type: 'explore', mode: 'background', agentId: 'agent-k' });
  api.at(at(22)); api.subagentDone(top, { durationMs: 2 * MINUTE, agentId: 'agent-r' });
  api.at(at(23)); api.turnEnd();
  data.states.set('cli-api', fold(api, 'cli-api'));
  const kid = api.events.find(event => event.type === 'tool.execution_start' && event.data.toolName === 'task' && event.data.parentToolCallId).data.toolCallId;
  api.at(at(112)); api.sub(kid, 'assistant.message', { content: 'still here' });
  data.states.set('cli-api', fold(api, 'cli-api'));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const unit = snapshot.units.find(item => item.id === 'ws-api');
  assert.deepEqual(unit.subagents.map(sub => sub.status), ['completed']);
  assert.equal(ACTIVE_DETAILS.has(unit.statusDetail), false, 'the session itself is not active');
  assert.equal(snapshot.run.lifecycle, 'live');
  data.alive.set('cli-api', false);
  assert.equal(buildSnapshot(data).run.lifecycle, 'finished', 'a dead session\'s sub-agents do not keep it live');
});

test('a running nested sub-agent in an older root CLI session counts only while that process is alive', () => {
  const swarm = alive => {
    const { data } = quietSwarm(() => {}, at(112 + 121));
    data.app.aliases.push({ sessionId: 'cli-root-old', workspaceId: 'ws-root', createdAt: T0 - MINUTE });
    data.forest = buildForest(data.app);
    const old = new EventLog(T0);
    old.calls = 200;
    old.start();
    old.at(at(100)); const top = old.subagent({ name: 'top', type: 'explore', mode: 'background', agentId: 'ag-top' });
    old.at(at(101)); const kid = old.nested(top, { name: 'kid', type: 'explore', mode: 'background', agentId: 'ag-kid' });
    old.at(at(102)); old.subagentDone(top, { durationMs: MINUTE, agentId: 'ag-top' });
    old.at(at(112)); old.sub(kid, 'assistant.message', { content: 'still here' });
    data.states.set('cli-root-old', fold(old, 'cli-root-old', ROOT_STATE));
    data.alive.set('cli-root-old', alive);
    return buildSnapshot(data);
  };
  assert.equal(swarm(false).run.lifecycle, 'finished');
  assert.equal(swarm(true).run.lifecycle, 'live');
});

// --- Unit retention at the detail limit ---

/** The bucket counts of the sub-agent units alone: the snapshot's counts without its session units. */
function subCounts(snapshot) {
  const counts = { ...snapshot.counts };
  for (const unit of snapshot.units.filter(item => item.kind !== 'subagent')) counts[unit.bucket] -= 1;
  return counts;
}

const bgTask = (root, name) => root.subagent({ name, type: 'explore', mode: 'background', agentId: `ag-${name}` });

test('a resumed unit stays listed and keeps the run live after 500 other sub-agents come and go', () => {
  const ids = {};
  const { data } = quietSwarm(root => {
    root.at(at(115));
    ids.first = bgTask(root, 'first');
    root.wait(1000); root.subagentDone(ids.first, { agentId: 'ag-first' });
    root.wait(1000); root.toAgent('ag-first', 'again');
    root.wait(1000); root.sub(ids.first, 'assistant.turn_start');
    for (let i = 0; i < 500; i += 1) {
      root.wait(1000);
      const call = bgTask(root, `s-${i}`);
      root.wait(1000); root.subagentDone(call, { agentId: `ag-s-${i}` });
    }
  }, at(115 + 17 + 125));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const resumed = subUnits(snapshot).find(unit => unit.id === ids.first);
  assert.ok(resumed, 'the resumed unit is still listed');
  assert.equal(resumed.statusDetail, 'stuck_subagent');
  assert.equal(snapshot.run.lifecycle, 'live');
  const counts = subCounts(snapshot);
  assert.deepEqual([counts.working + counts.stuck, counts.done, counts.failed], [1, 500, 0]);
  assert.deepEqual(snapshot.omittedSubagents, { done: 480, failed: 0 });
  assert.equal(subUnits(snapshot).length, 21);
});

test('the latest finished unit stays listed when 500 are open and one more starts, and nothing is counted twice', () => {
  const ids = {};
  const { data } = quietSwarm(root => {
    root.at(at(115));
    ids.first = bgTask(root, 'first');
    for (let i = 0; i < 499; i += 1) {
      root.wait(10);
      bgTask(root, `o-${i}`);
    }
    root.wait(10); root.subagentDone(ids.first, { agentId: 'ag-first' });
    root.wait(10); bgTask(root, 'last');
  }, at(118));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const listed = subUnits(snapshot);
  assert.equal(listed.length, 501);
  assert.equal(listed.find(unit => unit.id === ids.first).statusDetail, 'completed');
  assert.deepEqual(snapshot.omittedSubagents, { done: 0, failed: 0 });
  const counts = subCounts(snapshot);
  assert.deepEqual([counts.working + counts.stuck, counts.done, counts.failed], [500, 1, 0]);
});

test('an evicted unit whose follow-up was cancelled is omitted as failed', () => {
  const { data } = quietSwarm(root => {
    root.at(at(115));
    const old = root.subagent({ name: 'old', type: 'explore', mode: 'sync', agentId: 'ag-old' });
    root.wait(10); root.subagentDone(old, { agentId: 'ag-old' });
    root.wait(10); root.toAgent('ag-old', 'again');
    root.wait(10); root.sub(old, 'assistant.turn_start');
    root.wait(10); root.abort();
    for (let i = 0; i < 520; i += 1) {
      root.wait(10);
      const call = bgTask(root, `s-${i}`);
      root.wait(10); root.subagentDone(call, { agentId: `ag-s-${i}` });
    }
  }, at(120));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.omittedSubagents, { done: 500, failed: 1 });
  assert.deepEqual(subCounts(snapshot), { working: 0, stuck: 0, waiting: 0, idle: 0, done: 520, failed: 1 });
});

// --- Sub-agent unit labels and launch numbers stay stable across snapshots ---

const labelsById = snapshot => Object.fromEntries(snapshot.units.map(unit => [unit.id, unit.label]));
const allLabels = snapshot => [snapshot.orchestrator.label, ...snapshot.units.map(unit => unit.label), ...snapshot.planned.map(entry => entry.label)].map(label => label.toLowerCase());

test('a task keeps its label when a session\'s derived label later becomes the same, and the session takes the suffix', () => {
  const { data, ids } = withSubagents(root => {
    root.at(at(100));
    return { call: root.subagent({ name: 'a1', type: 'explore', mode: 'background', agentId: 'ag-a1' }) };
  }, { contract: false });
  const rename = name => {
    data.app.workspaces.get('ws-api').name = name;
    data.forest = buildForest(data.app);
  };
  data.subagentLabels = new Map();
  rename('Sample q9 api');
  const before = buildSnapshot(data);
  assert.deepEqual([labelsById(before)[ids.call], labelsById(before)['ws-api']], ['a1', 'q9']);
  rename('Sample a1 api');
  const after = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(after), []);
  assert.deepEqual([labelsById(after)[ids.call], labelsById(after)['ws-api']], ['a1', 'a1-2'], 'the task keeps a1; the session yields');
  assert.equal(new Set(allLabels(after)).size, allLabels(after).length);
  assert.equal(data.subagentLabels.get(ids.call), 'a1');
  const fresh = buildSnapshot({ ...data, subagentLabels: new Map() });
  assert.deepEqual([labelsById(fresh)[ids.call], labelsById(fresh)['ws-api']], ['a1-2', 'a1'], 'with no memory the labels are worked out afresh, as before');
});

/** Unnamed background tasks that start and finish one after another: their labels are `explore-<launch number>`. */
const unnamedTasks = count => root => {
  root.at(at(115));
  const calls = [];
  for (let i = 0; i < count; i += 1) {
    root.wait(10);
    const call = root.tool('task', { agent_type: 'explore', mode: 'background', description: `work ${i}` });
    root.wait(10);
    root.subagentDone(call, { durationMs: 1000 });
    calls.push(call);
  }
  return calls;
};

test('an unnamed task keeps its launch number when older sub-agents leave the details, with or without memory', () => {
  const small = withSubagents(unnamedTasks(500), { now: at(120) });
  const large = withSubagents(unnamedTasks(505), { now: at(120) });
  const memory = new Map();
  const first = buildSnapshot({ ...small.data, subagentLabels: memory });
  const target = large.ids[499];
  assert.equal(target, small.ids[499]);
  assert.equal(labelsById(first)[target], 'explore-500');
  assert.equal(memory.size, 500);
  const remembered = buildSnapshot({ ...large.data, subagentLabels: memory });
  assert.deepEqual(validateSnapshot(remembered), []);
  assert.equal(labelsById(remembered)[target], 'explore-500');
  assert.equal(memory.size, 500, 'the memory forgets the sub-agents that left the details');
  assert.equal(memory.has(small.ids[0]), false);
  assert.equal(labelsById(buildSnapshot(large.data))[target], 'explore-500', 'without memory it is the same');
});

test('a planned label or a registry label that newly equals a remembered sub-agent label takes it', () => {
  const { data, ids } = withSubagents(root => {
    root.at(at(100));
    return { exportCall: root.subagent({ name: 'export', type: 'explore', mode: 'background', agentId: 'ag-export' }), apiCall: root.subagent({ name: 'api', type: 'explore', mode: 'background', agentId: 'ag-api' }) };
  });
  const db = data.sessionDbs.get('cli-root');
  const { todos, deps, children } = db;
  data.sessionDbs.set('cli-root', { todos: todos.filter(todo => todo.id !== 'export'), deps: deps.filter(dep => dep.todoId !== 'export'), children: null });
  data.subagentLabels = new Map();
  const before = buildSnapshot(data);
  assert.deepEqual([labelsById(before)[ids.exportCall], labelsById(before)[ids.apiCall]], ['export', 'api']);
  data.sessionDbs.set('cli-root', { todos, deps, children });
  const after = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(after), []);
  assert.deepEqual(after.planned.map(entry => entry.label), ['export']);
  assert.equal(labelsById(after)['ws-api'], 'api', 'the registry label is unchanged');
  assert.deepEqual([labelsById(after)[ids.exportCall], labelsById(after)[ids.apiCall]], ['export-2', 'api-2']);
  assert.equal(new Set(allLabels(after)).size, allLabels(after).length);
});

test('the launch numbers of older root CLI sessions come before those of the current one, in either order of the session list', () => {
  // The node's list is ['cli-root-b', 'cli-root'] (the current session last), so by id it is the reverse. The session that started
  // first by firstEventAt is the first of the list in one case and the first by id in the other: sorting by either would fail one.
  for (const earlyId of ['cli-root-b', 'cli-root']) {
    const { data } = quietSwarm(() => {}, at(120));
    data.app.aliases.push({ sessionId: 'cli-root-b', workspaceId: 'ws-root', createdAt: T0 - MINUTE });
    data.forest = buildForest(data.app);
    assert.deepEqual(data.forest.nodes.get('ws-root').cliSessionIds, ['cli-root-b', 'cli-root']);
    const session = (id, calls, start, launches) => {
      const log = new EventLog(start);
      log.calls = calls;
      log.start();
      for (const minute of launches) {
        log.at(at(minute));
        log.tool('task', { agent_type: 'explore', mode: 'background' });
      }
      data.states.set(id, fold(log, id, ROOT_STATE));
      data.alive.set(id, true);
    };
    const lateId = earlyId === 'cli-root' ? 'cli-root-b' : 'cli-root';
    session(earlyId, 200, T0 - MINUTE, [60, 61]);
    session(lateId, 100, T0, [100]);
    assert.ok(data.states.get(earlyId).firstEventAt < data.states.get(lateId).firstEventAt);
    assert.deepEqual(subUnits(buildSnapshot(data)).map(unit => unit.label), ['explore-1', 'explore-2', 'explore-3'], `${earlyId} started first`);
  }
});

test('a session label stays stable when a remembered sub-agent label meets a planned label and a derived session label together', () => {
  const { data, ids } = withSubagents(root => {
    root.at(at(100));
    return { call: root.subagent({ name: 'a1', type: 'explore', mode: 'background', agentId: 'ag-a1' }) };
  }, { contract: false });
  const rename = name => {
    data.app.workspaces.get('ws-api').name = name;
    data.forest = buildForest(data.app);
  };
  const db = data.sessionDbs.get('cli-root');
  const withPlanned = { ...db, todos: [...db.todos, { id: 'a1', title: 'A1', description: '', status: 'pending' }], deps: [...db.deps, { todoId: 'a1', dependsOn: 'todo-api' }] };
  data.subagentLabels = new Map();
  rename('Sample q9 api');
  const first = buildSnapshot(data);
  assert.deepEqual([labelsById(first)[ids.call], labelsById(first)['ws-api']], ['a1', 'q9']);
  rename('Sample a1 api');
  data.sessionDbs.set('cli-root', withPlanned);
  const seen = [];
  for (let i = 0; i < 3; i += 1) {
    const snapshot = buildSnapshot(data);
    assert.deepEqual(validateSnapshot(snapshot), []);
    assert.ok(snapshot.planned.some(entry => entry.label === 'a1'), 'the planned label a1 is present');
    seen.push([labelsById(snapshot)[ids.call], labelsById(snapshot)['ws-api']]);
    const unplanned = [snapshot.orchestrator.label, ...snapshot.units.map(unit => unit.label)].map(label => label.toLowerCase());
    assert.equal(new Set(unplanned).size, unplanned.length, 'every label is unique but a session and a planned one');
  }
  assert.deepEqual(seen, [['a1-2', 'a1'], ['a1-2', 'a1'], ['a1-2', 'a1']]);
});

// --- A unit with an open tool call is judged by that call's own limit ---

/** A background task with a `bash` call (initial_wait 600) that starts at minute 116. */
function bashSwarm(now) {
  const ids = {};
  const { data } = quietSwarm(root => {
    root.at(at(115)); ids.call = root.subagent({ name: 'worker', type: 'general-purpose', mode: 'background', agentId: 'ag-worker' });
    root.at(at(116)); root.sub(ids.call, 'tool.execution_start', { toolCallId: 'inner-bash', toolName: 'bash', arguments: { command: 'long job', initial_wait: 600 } });
  }, now);
  return { data, ids };
}

test('a sub-agent that waits on a long bash call is busy at 11 minutes and stuck_tool at 16', () => {
  const early = buildSnapshot(bashSwarm(at(116 + 11)).data);
  assert.deepEqual(validateSnapshot(early), []);
  const [busy] = subUnits(early);
  assert.deepEqual([busy.statusDetail, busy.bucket, busy.reason], ['busy', 'working', null]);
  assert.equal(busy.activity.label, 'Running bash: long job');
  assert.equal(early.orchestrator.subagents.find(sub => sub.id === busy.id).status, 'running', 'the orchestrator\'s chip is not stuck');

  const { data, ids } = bashSwarm(at(116 + 16));
  const late = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(late), []);
  const [stuck] = subUnits(late);
  assert.deepEqual([stuck.statusDetail, stuck.status, stuck.since], ['stuck_tool', 'stuck', at(116)]);
  assert.equal(stuck.reason, 'bash has run for 16 min with a limit of 15 min (initial_wait 10 min + 5 min).');
  assert.deepEqual(stuck.activity.tool, { id: 'inner-bash', name: 'bash', summary: 'bash: long job', startedAt: at(116), limitMs: 15 * MINUTE });
  assert.equal(stuck.activity.label, 'Running bash: long job');
  assert.deepEqual(stuck.timeline.segments.at(-1), { start: at(116), end: null, state: 'stuck' });
  assert.equal(late.orchestrator.subagents.find(sub => sub.id === ids.call).status, 'stuck');
  assert.equal(late.run.lifecycle, 'live');
});

test('a sub-agent that waits on its sync child stays busy while the child works, and is stuck_subagent once both are silent', () => {
  const build = now => quietSwarm(root => {
    root.at(at(115));
    const top = root.subagent({ name: 'top', type: 'general-purpose', mode: 'background', agentId: 'ag-top' });
    root.at(at(116)); const kid = root.nested(top, { name: 'kid', type: 'explore', mode: 'sync', agentId: 'ag-kid' });
    root.at(at(122)); root.sub(kid, 'assistant.message', { content: 'still going' });
    root.at(at(128)); root.sub(kid, 'assistant.message', { content: 'nearly there' });
  }, now).data;
  const working = buildSnapshot(build(at(134)));
  const [busy] = subUnits(working);
  assert.deepEqual([busy.statusDetail, busy.reason], ['busy', null]);
  assert.equal(busy.activity.tool?.name, 'task');
  assert.equal(busy.activity.label, 'Waiting for its explore (sync)');
  const silent = buildSnapshot(build(at(140)));
  const [stuck] = subUnits(silent);
  assert.deepEqual([stuck.statusDetail, stuck.reason], ['stuck_subagent', 'No events for 12 min; the limit is 10 min.']);
  assert.equal(stuck.activity.tool?.name, 'task');
  assert.deepEqual(stuck.timeline.segments.at(-1), { start: at(128), end: null, state: 'stuck' });
});

test('a heavy sub-agent whose task start repeats keeps the model it runs on, so it is busy, not stuck, after 11 silent minutes', () => {
  for (const observe of ['started', 'configured']) {
    const { data } = quietSwarm(root => {
      root.at(at(115));
      const args = model => ({
        name: 'heavy', agent_type: 'general-purpose', mode: 'background', description: 'heavy work', prompt: 'synthetic prompt', reasoning_effort: 'max',
        ...(model === undefined ? {} : { model }),
      });
      root.push('tool.execution_start', { toolCallId: 'call-heavy', toolName: 'task', arguments: args('claude-sonnet-x') });
      root.push('subagent.started', {
        toolCallId: 'call-heavy', agentName: 'general-purpose', agentDisplayName: 'heavy', agentType: 'general-purpose', executionMode: 'background',
        ...(observe === 'started' ? { model: 'claude-opus-x' } : {}),
      }, { agentId: 'ag-heavy' });
      if (observe === 'configured') root.push('subagent.configured', { model: 'claude-opus-x', reasoningEffort: 'max' }, { agentId: 'ag-heavy' });
      root.done('call-heavy', { result: 'Agent started in background' });
      root.push('tool.execution_start', { toolCallId: 'call-heavy', toolName: 'task', arguments: args('claude-sonnet-x') });
      root.push('tool.execution_start', { toolCallId: 'call-heavy', toolName: 'task', arguments: args(undefined) });
    }, at(115 + 11));
    const snapshot = buildSnapshot(data);
    assert.deepEqual(validateSnapshot(snapshot), []);
    const [unit] = subUnits(snapshot);
    assert.deepEqual([unit.statusDetail, unit.reason], ['busy', null], observe);
    assert.deepEqual([unit.model, unit.effort], ['claude-opus-x', 'max'], observe);
  }
});

// --- ReportView.repliedAt ---

/** The heuristic swarm where the api session reports needs_input at minute 30, with `replies` from its parent at the given minutes. */
function askingSwarm(replies) {
  const data = input(false);
  const api = new EventLog(at(5));
  api.start(); api.turnStart();
  api.at(at(20)); api.crossSession({ fromSessionId: 'cli-root', fromProjectSessionId: 'ws-root', name: 'Sample story', content: 'Start with the models.' });
  api.at(at(30)); api.report('ws-root', 'Need a decision before publishing PR !4711.', 'needs_input');
  api.at(at(31)); api.turnEnd();
  for (const minute of replies) {
    api.at(at(minute)); api.crossSession({ fromSessionId: 'cli-root', fromProjectSessionId: 'ws-root', name: 'Sample story', content: `Reply at ${minute}.` });
  }
  data.states.set('cli-api', fold(api, 'cli-api'));
  return buildSnapshot(data);
}

test('a needs_input report has repliedAt null until its parent sends a message after it, and then the time of the first one', () => {
  const none = askingSwarm([]);
  assert.deepEqual(validateSnapshot(none), []);
  const waiting = none.units.find(unit => unit.id === 'ws-api');
  assert.deepEqual([waiting.report.status, waiting.report.at, waiting.report.repliedAt, waiting.statusDetail], ['needs_input', at(30), null, 'blocked_on_orchestrator'],
    'the parent message from minute 20 is before the report and does not count');
  const answered = askingSwarm([40, 50]);
  assert.deepEqual(validateSnapshot(answered), []);
  const unit = answered.units.find(item => item.id === 'ws-api');
  assert.equal(unit.report.repliedAt, at(40));
  assert.notEqual(unit.statusDetail, 'blocked_on_orchestrator');
  for (const view of answered.units) if (view.id !== 'ws-api' && view.report) assert.equal(view.report.repliedAt, null, `${view.id} has no reply`);
});

test('a sub-agent unit\'s report has repliedAt null, the follow-up\'s time after a follow-up, and null again after its next message', () => {
  const build = stage => quietSwarm(root => {
    root.at(at(115));
    const call = root.subagent({ name: 'late', type: 'explore', mode: 'background', agentId: 'ag-late' });
    root.at(at(116)); root.sub(call, 'assistant.message', { content: 'First answer' });
    if (stage >= 1) { root.at(at(118)); root.toAgent('ag-late', 'one more thing'); }
    if (stage >= 2) { root.at(at(120)); root.sub(call, 'assistant.message', { content: 'Second answer' }); }
  }, at(122)).data;
  const reports = [0, 1, 2].map(stage => {
    const snapshot = buildSnapshot(build(stage));
    assert.deepEqual(validateSnapshot(snapshot), []);
    return subUnits(snapshot)[0].report;
  });
  assert.deepEqual(reports.map(report => [report.title, report.repliedAt]), [['First answer', null], ['First answer', at(118)], ['Second answer', null]]);
});

// --- A reply stays recorded when later messages fill the rolling inbound list ---

const fromParent = log => log.crossSession({ fromSessionId: 'cli-root', fromProjectSessionId: 'ws-root', name: 'Sample story', content: 'A message from the parent.' });
const fromSibling = log => log.crossSession({ fromSessionId: 'cli-ui', fromProjectSessionId: 'ws-ui', name: 'Sample u1 ui', content: 'A message from a sibling.' });

/** The heuristic swarm where the api session reports needs_input at minute 30, then `build` adds what follows (from minute 40). */
function replyLogSwarm(build) {
  const data = input(false);
  const api = new EventLog(at(5));
  api.start(); api.turnStart();
  api.at(at(30)); api.report('ws-root', 'Need a decision before publishing PR !4711.', 'needs_input');
  api.at(at(31)); api.turnEnd();
  build(api);
  data.states.set('cli-api', fold(api, 'cli-api'));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  return { snapshot, unit: snapshot.units.find(item => item.id === 'ws-api'), data };
}

test('a reply stays recorded after 81 unrelated messages, and after 81 later messages from the parent itself', () => {
  for (const sender of [fromSibling, fromParent]) {
    const { unit } = replyLogSwarm(api => {
      api.at(at(40)); fromParent(api);
      api.at(at(41));
      for (let i = 0; i < 81; i += 1) { api.wait(1000); sender(api); }
    });
    assert.equal(unit.report.status, 'needs_input');
    assert.equal(unit.report.repliedAt, at(40), `after 81 messages from ${sender === fromParent ? 'the parent' : 'a sibling'}`);
    assert.notEqual(unit.statusDetail, 'blocked_on_orchestrator');
  }
});

test('a new needs_input report after the reply is unanswered until the parent replies again', () => {
  const asked = replyLogSwarm(api => {
    api.at(at(40)); fromParent(api);
    api.at(at(50)); api.report('ws-root', 'One more decision before publishing PR !4711.', 'needs_input');
    api.at(at(51)); api.turnEnd();
  });
  assert.deepEqual([asked.unit.report.at, asked.unit.report.repliedAt, asked.unit.statusDetail], [at(50), null, 'blocked_on_orchestrator']);
  const answered = replyLogSwarm(api => {
    api.at(at(40)); fromParent(api);
    api.at(at(50)); api.report('ws-root', 'One more decision before publishing PR !4711.', 'needs_input');
    api.at(at(51)); api.turnEnd();
    api.at(at(60)); fromParent(api);
    api.at(at(61)); fromParent(api);
  });
  assert.equal(answered.unit.report.repliedAt, at(60));
  assert.notEqual(answered.unit.statusDetail, 'blocked_on_orchestrator');
});

test('a reply that is the first message of a later CLI session of the unit still counts after 81 other messages', () => {
  const { data } = replyLogSwarm(() => {});
  data.app.aliases.push({ sessionId: 'cli-api-old', workspaceId: 'ws-api', createdAt: T0 });
  data.forest = buildForest(data.app);
  assert.deepEqual(data.forest.nodes.get('ws-api').cliSessionIds, ['cli-api-old', 'cli-api']);
  const old = new EventLog(at(5));
  old.calls = 300;
  old.start(); old.turnStart();
  old.at(at(30)); old.report('ws-root', 'Need a decision before publishing PR !4711.', 'needs_input');
  old.at(at(31)); old.turnEnd();
  data.states.set('cli-api-old', fold(old, 'cli-api-old'));
  data.alive.set('cli-api-old', false);
  const current = new EventLog(at(35));
  current.start();
  current.at(at(40)); fromParent(current);
  current.at(at(41));
  for (let i = 0; i < 81; i += 1) { current.wait(1000); fromSibling(current); }
  data.states.set('cli-api', fold(current, 'cli-api'));
  const unit = buildSnapshot(data).units.find(item => item.id === 'ws-api');
  assert.deepEqual([unit.report.status, unit.report.at, unit.report.repliedAt], ['needs_input', at(30), at(40)]);
});

test('a fallback label fits within 32 characters from the 1,000th launch, even with a long agent type', () => {
  const longType = 'general-purpose-with-a-really-long-agent-type-name';
  const { data } = quietSwarm(root => {
    unnamedTasks(999)(root);
    root.wait(10);
    root.tool('task', { agent_type: longType, mode: 'background' });
  }, at(120));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const label = subUnits(snapshot).at(-1).label;
  assert.ok(label.length <= 32, `${label} has ${label.length} characters`);
  assert.ok(label.endsWith('-1000'), label);
  assert.match(label, /^[A-Za-z0-9._-]{1,32}$/);
  assert.ok(label.startsWith('general-purpose-with-a-r'), 'the type is cut to make room for the number');
});

// --- Reasoning effort ---

/** An app session row (data.db) as the app-db reader gives it, with only the effort set. */
const sessionRow = (id, reasoningEffort) => ({
  id, title: '', mode: null, model: null, reasoningEffort, isRunning: false, wasInterrupted: false, createdAt: null, archivedAt: null,
});

/** A log whose start asks for 'low' and whose later model change says 'medium', or one that never names an effort. */
function effortLog(start, withEffort) {
  const log = new EventLog(start);
  log.push('session.start', { copilotVersion: '1.0.95-3', selectedModel: 'claude-sonnet-5', ...(withEffort ? { reasoningEffort: 'low' } : {}) });
  log.wait(1000);
  log.push('session.model_change', { newModel: 'claude-opus-5', ...(withEffort ? { reasoningEffort: 'medium' } : {}) });
  return log;
}

test('a session shows the app\'s effort for it, else the latest effort in its log, else null; the orchestrator follows the same rule', () => {
  const effortsFor = ({ row, withEffort }) => {
    const data = input(true);
    data.states.set('cli-root', fold(effortLog(T0, withEffort), 'cli-root'));
    data.states.set('cli-api', fold(effortLog(at(5), withEffort), 'cli-api'));
    if (row !== undefined) for (const id of ['cli-root', 'cli-api']) data.app.sessions.set(id, sessionRow(id, row));
    const snapshot = buildSnapshot(data);
    assert.deepEqual(validateSnapshot(snapshot), []);
    assert.equal(snapshot.units.find(unit => unit.id === 'ws-ui').effort, null, 'a session with neither shows null');
    return [snapshot.orchestrator.effort, snapshot.units.find(unit => unit.id === 'ws-api').effort];
  };
  assert.deepEqual(effortsFor({ row: 'high', withEffort: true }), ['high', 'high'], 'the app\'s setting wins over the log');
  assert.deepEqual(effortsFor({ row: null, withEffort: true }), ['medium', 'medium'], 'a null row falls back to the log\'s latest effort');
  assert.deepEqual(effortsFor({ row: undefined, withEffort: true }), ['medium', 'medium'], 'no row falls back to the log\'s latest effort');
  assert.deepEqual(effortsFor({ row: null, withEffort: false }), [null, null], 'neither gives null');
});

test('a sub-agent unit, its agent and the orchestrator\'s chip show the configured effort, else the requested one, else null', () => {
  for (const repeat of [false, true]) {
    const { data, ids } = withSubagents(root => {
      const configured = root.subagent({ name: 'configured', type: 'explore', mode: 'background', effort: 'low', agentId: 'ag-configured' });
      root.wait(1000);
      root.push('subagent.configured', { model: 'claude-sonnet-5', reasoningEffort: 'max' }, { agentId: 'ag-configured' });
      if (repeat) {
        root.wait(1000);
        root.push('tool.execution_start', {
          toolCallId: configured, toolName: 'task',
          arguments: { name: 'configured', agent_type: 'explore', mode: 'background', description: 'configured work', reasoning_effort: 'low' },
        });
      }
      root.wait(1000);
      const requested = root.subagent({ name: 'requested', type: 'explore', mode: 'background', effort: 'low', agentId: 'ag-requested' });
      root.wait(1000);
      const plain = root.subagent({ name: 'plain', type: 'explore', mode: 'background', agentId: 'ag-plain' });
      return { configured, requested, plain };
    });
    const snapshot = buildSnapshot(data);
    assert.deepEqual(validateSnapshot(snapshot), []);
    const efforts = id => {
      const unit = snapshot.units.find(item => item.id === id);
      const chip = snapshot.orchestrator.subagents.find(item => item.id === id);
      return [unit.effort, unit.agent.effort, chip.effort];
    };
    assert.deepEqual(efforts(ids.configured), ['max', 'max', 'max'], repeat ? 'a repeated task start keeps the configured effort' : 'the configured effort wins');
    assert.deepEqual(efforts(ids.requested), ['low', 'low', 'low'], 'without subagent.configured, the requested effort');
    assert.deepEqual(efforts(ids.plain), [null, null, null], 'with neither, null');
  }
});

test('a child session\'s chip shows its sub-agent\'s configured effort', () => {
  const { data } = withSubagents(() => {});
  const api = new EventLog(at(5));
  api.start(); api.turnStart(); api.at(at(20));
  const reviewer = api.subagent({ name: 'reviewer', type: 'code-review', mode: 'background', effort: 'low', agentId: 'agent-r' });
  api.wait(1000);
  api.push('subagent.configured', { model: 'claude-sonnet-5', reasoningEffort: 'high' }, { agentId: 'agent-r' });
  const helper = api.subagent({ name: 'helper', type: 'explore', mode: 'background', effort: 'medium', agentId: 'agent-h' });
  data.states.set('cli-api', fold(api, 'cli-api'));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const chips = snapshot.units.find(unit => unit.id === 'ws-api').subagents;
  assert.equal(chips.find(chip => chip.id === reviewer).effort, 'high');
  assert.equal(chips.find(chip => chip.id === helper).effort, 'medium');
});

test('a data.db row with an empty or blank effort falls through to the log\'s latest effort', () => {
  for (const blank of ['', '   ']) {
    const data = input(true);
    data.states.set('cli-api', fold(effortLog(at(5), true), 'cli-api'));
    data.app.sessions.set('cli-api', sessionRow('cli-api', blank));
    data.app.sessions.set('cli-root', sessionRow('cli-root', ' high '));
    const snapshot = buildSnapshot(data);
    assert.deepEqual(validateSnapshot(snapshot), []);
    assert.equal(snapshot.units.find(unit => unit.id === 'ws-api').effort, 'medium', JSON.stringify(blank));
    assert.equal(snapshot.orchestrator.effort, 'high', 'a padded row effort is trimmed');
  }
});

test('a session whose current CLI session cleared its effort shows null, not an older CLI session\'s effort', () => {
  const data = input(true);
  data.app.aliases.push({ sessionId: 'cli-api-old', workspaceId: 'ws-api', createdAt: T0 });
  data.forest = buildForest(data.app);
  assert.deepEqual(data.forest.nodes.get('ws-api').cliSessionIds, ['cli-api-old', 'cli-api']);
  const old = new EventLog(at(5));
  old.calls = 300;
  old.push('session.start', { copilotVersion: '1.0.95-3', selectedModel: 'claude-opus-5', reasoningEffort: 'high' });
  old.turnStart(); old.at(at(10)); old.turnEnd();
  data.states.set('cli-api-old', fold(old, 'cli-api-old'));
  data.alive.set('cli-api-old', false);
  const current = new EventLog(at(15));
  current.push('session.start', { copilotVersion: '1.0.95-3', selectedModel: 'claude-sonnet-5', reasoningEffort: 'medium' });
  current.wait(1000);
  current.push('session.model_change', { newModel: 'claude-haiku-5.5', reasoningEffort: null });
  data.states.set('cli-api', fold(current, 'cli-api'));
  data.app.sessions.set('cli-api', sessionRow('cli-api', null));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.units.find(unit => unit.id === 'ws-api').effort, null);
});
