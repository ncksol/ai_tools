import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { renderApp } from '../ui/app.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { openEvents } from './helpers/http.mjs';
import { NO_SUCH_PID, alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';
import { NOW, exampleSnapshot, fixture } from './helpers/ui.mjs';

/*
 * Which session trees count as a swarm (issue #29, items 6 and 10). A tree whose top session has child sessions is a swarm,
 * as before. A top session with no child yet is one only while it runs an orchestrator agent and waits on an open
 * contract-tagged question, so the plan question shows in "Needs you" before the first child. A page opened for a session
 * that is in no swarm says so, instead of showing another swarm.
 */

const PLAN = '[unit=* need=plan] Approve this split into two units?';
let pids = 100;

/** A top-level session with no child sessions, its log and, unless `alive` is false, a lock its process holds. */
function lone(home, { id, cli = `cli-${id.slice(3)}`, agent = null, ask = null, answered = false, alive = true, archivedAt = null }) {
  home.workspace({ id, name: `Lone ${id}`, createdAt: at(55), sessionId: cli, agent, archivedAt });
  const log = new EventLog(at(55));
  log.start(); log.turnStart();
  log.at(at(56));
  if (ask) {
    const call = log.ask(ask);
    if (answered) {
      log.at(at(57));
      log.done(call, { result: 'Yes' });
      log.turnEnd();
    }
  } else {
    log.turnEnd();
  }
  home.writeEvents(cli, log.events);
  if (alive) home.lock(cli, NO_SUCH_PID + ++pids, at(55));
  return cli;
}

/** The scenario's live swarm and finished swarm, plus an orchestrator (ws-plan) that waits on its plan question with no child yet. */
function planningHome() {
  const home = scenario();
  lone(home, { id: 'ws-plan', cli: 'cli-plan', agent: 'orchestrator', ask: PLAN });
  return home;
}

const engineFor = (home, clock, processProbe = alwaysAlive) => createSwarmEngine({
  copilotHome: home.root, historyDir: path.join(tempDir('swarm-membership-'), 'history'), now: () => clock(), processProbe, prLookup: 'off',
});

const ids = engine => engine.listSwarms().map(swarm => swarm.id).sort();

test('an orchestrator waiting on its tagged plan question is a swarm before its first child, and its question needs you', async () => {
  const home = planningHome();
  const engine = engineFor(home, () => at(60));
  await engine.refresh();
  const listed = engine.listSwarms().find(swarm => swarm.id === 'ws-plan');
  assert.ok(listed, 'ws-plan is listed as a swarm');
  assert.deepEqual(validateSwarmListItem(listed), []);
  assert.deepEqual([listed.lifecycle, listed.units, listed.name], ['live', 0, 'Lone ws-plan']);
  assert.equal(await engine.findSwarm('cli-plan'), 'ws-plan');
  assert.equal(await engine.findSwarm('ws-plan'), 'ws-plan');
  const snapshot = await engine.getSnapshot('ws-plan');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.units, []);
  assert.equal(snapshot.orchestrator.statusDetail, 'waiting_question');
  assert.deepEqual(snapshot.needs.map(need => [need.kind, need.unitIds, need.tagged, need.text]), [['plan', [], true, 'Approve this split into two units?']]);
});

test('a top-level session with no child is not a swarm without the whole signal', async () => {
  const home = planningHome();
  const falseSwarms = {
    'ws-plain': { agent: null, ask: PLAN },
    'ws-quiet': { agent: 'orchestrator' },
    'ws-untagged': { agent: 'orchestrator', ask: 'Approve this split into two units?' },
    'ws-badtag': { agent: 'session-orchestrator', ask: '[unit=* need=approve] Approve this split?' },
    'ws-answered': { agent: 'orchestrator', ask: PLAN, answered: true },
    'ws-ended': { agent: 'orchestrator', ask: PLAN, alive: false },
    'ws-archived': { agent: 'orchestrator', ask: PLAN, archivedAt: at(58) },
    'ws-worker': { agent: 'orchestrator-worker', ask: PLAN },
    'ws-other-agent': { agent: 'andrej', ask: PLAN },
  };
  const cli = {};
  for (const [id, options] of Object.entries(falseSwarms)) cli[id] = lone(home, { id, ...options });
  // An open plan approval (exit_plan_mode) is not a tagged question, even when its summary starts with a tag.
  home.workspace({ id: 'ws-planmode', name: 'Plan mode', createdAt: at(55), sessionId: 'cli-planmode', agent: 'orchestrator' });
  const planMode = new EventLog(at(55));
  planMode.start(); planMode.turnStart(); planMode.at(at(56)); planMode.plan(PLAN);
  home.writeEvents('cli-planmode', planMode.events);
  home.lock('cli-planmode', NO_SUCH_PID + ++pids, at(55));
  cli['ws-planmode'] = 'cli-planmode';
  // An orchestrator that runs as a child session stays a unit of its parent's swarm.
  home.workspace({ id: 'ws-nested', name: 'Nested orchestrator', createdAt: at(55), sessionId: 'cli-nested', parentId: 'ws-root', creatorSessionId: 'cli-root', agent: 'orchestrator' });
  const nested = new EventLog(at(55));
  nested.start(); nested.turnStart(); nested.at(at(56)); nested.ask(PLAN);
  home.writeEvents('cli-nested', nested.events);
  home.lock('cli-nested', NO_SUCH_PID + ++pids, at(55));

  const engine = engineFor(home, () => at(60));
  await engine.refresh();
  assert.deepEqual(ids(engine), ['ws-old', 'ws-plan', 'ws-root']);
  for (const [id, cliId] of Object.entries(cli)) {
    assert.equal(await engine.findSwarm(cliId), null, `${id} is in no swarm`);
    assert.equal(await engine.getSnapshot(id), null, `${id} has no snapshot`);
  }
  assert.equal(await engine.findSwarm('cli-nested'), 'ws-root');
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-root').units, 3);
});

test('an orchestrator leaves the swarm list once its question is answered, and joins it again with its first child', async () => {
  const home = planningHome();
  let now = at(60);
  const engine = engineFor(home, () => now);
  await engine.refresh();
  assert.equal(await engine.findSwarm('cli-plan'), 'ws-plan');

  const answer = new EventLog(at(61));
  answer.done('call-1', { result: 'Approved' });
  answer.message('Starting the units.');
  home.writeEvents('cli-plan', answer.events, { append: true });
  now = at(62);
  await engine.refresh();
  assert.deepEqual(ids(engine), ['ws-old', 'ws-root']);
  assert.equal(await engine.findSwarm('cli-plan'), null);
  assert.equal(await engine.getSnapshot('ws-plan'), null);
  assert.equal((await engine.listHistory()).some(run => run.id === 'ws-plan'), false, 'a swarm with no child is not kept in History');

  home.workspace({ id: 'ws-plan-a', name: 'Plan a1', createdAt: at(63), sessionId: 'cli-plan-a', parentId: 'ws-plan', creatorSessionId: 'cli-plan' });
  now = at(64);
  await engine.refresh();
  assert.equal(await engine.findSwarm('cli-plan'), 'ws-plan');
  assert.equal(await engine.findSwarm('cli-plan-a'), 'ws-plan');
  assert.deepEqual((await engine.getSnapshot('ws-plan')).units.map(unit => unit.id), ['ws-plan-a']);
});

test('an orchestrator whose log has been quiet for the finished-run time stays a swarm only while its process is known to run', async () => {
  const home = planningHome();
  const running = lone(home, { id: 'ws-running', agent: 'orchestrator', ask: PLAN });
  const unknown = lone(home, { id: 'ws-unknown', agent: 'orchestrator', ask: PLAN });
  const unknownPid = NO_SUCH_PID + pids;
  // The process probe fails for ws-unknown's lock, so whether its process runs is not known.
  const probe = async locks => {
    if (locks.some(lock => lock.pid === unknownPid)) throw new Error('probe failed');
    return new Map(locks.map(lock => [lock.pid, true]));
  };
  const engine = engineFor(home, () => at(56) + 3 * 60 * 60000, probe);
  await engine.refresh();
  assert.equal(await engine.findSwarm(running), 'ws-running');
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-running').lifecycle, 'live');
  assert.equal(await engine.findSwarm(unknown), null);
});

test('a chat that runs an orchestrator and waits on a tagged question is a swarm before its first child', async () => {
  const home = scenario();
  home.chat({ id: 'chat-plan', title: 'Planning chat', createdAt: at(55), agent: 'session-orchestrator' });
  const log = new EventLog(at(55));
  log.start(); log.turnStart(); log.at(at(56)); log.ask(PLAN);
  home.writeEvents('chat-plan', log.events);
  home.lock('chat-plan', NO_SUCH_PID + ++pids, at(55));
  home.chat({ id: 'chat-plain', title: 'Plain chat', createdAt: at(55) });
  home.writeEvents('chat-plain', log.events);
  home.lock('chat-plain', NO_SUCH_PID + ++pids, at(55));

  const engine = engineFor(home, () => at(60));
  await engine.refresh();
  assert.deepEqual(ids(engine), ['chat-plan', 'ws-old', 'ws-root']);
  assert.equal(await engine.findSwarm('chat-plan'), 'chat-plan');
  assert.equal(await engine.findSwarm('chat-plain'), null);
  const snapshot = await engine.getSnapshot('chat-plan');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.orchestrator.kind, 'chat');
  assert.deepEqual(snapshot.needs.map(need => need.kind), ['plan']);
});

test('the forest makes a top session with no child a root only when the engine names it', () => {
  const session = (id, agent) => [id, { id, title: id, mode: null, model: null, reasoningEffort: null, isRunning: false, wasInterrupted: false, createdAt: 1, archivedAt: null, agent }];
  const workspace = (id, sessionId, archivedAt = null) => [id, { id, projectId: null, worktreeId: null, name: id, branch: null, createdAt: 1, archivedAt, sessionId, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null }];
  const app = {
    projects: new Map(), worktrees: new Map(), automations: [], diagnostics: [], parentLinks: [], chatLinks: [],
    workspaces: new Map([workspace('ws-orch', 'cli-orch'), workspace('ws-plain', 'cli-plain'), workspace('ws-gone', 'cli-gone', 2)]),
    aliases: [{ sessionId: 'cli-orch', workspaceId: 'ws-orch', createdAt: 1 }, { sessionId: 'cli-plain', workspaceId: 'ws-plain', createdAt: 1 }],
    sessions: new Map([session('cli-orch', 'orchestrator'), session('cli-plain', null), session('cli-gone', 'orchestrator'), session('chat-orch', 'session-orchestrator'), session('chat-plain', 'andrej')]),
  };
  const forest = buildForest(app);
  assert.deepEqual(forest.roots, []);
  assert.deepEqual(forest.candidates, [{ id: 'ws-orch', cliId: 'cli-orch' }, { id: 'chat-orch', cliId: 'chat-orch' }]);
  const promoted = buildForest(app, { waitingRoots: new Set(['ws-orch', 'chat-orch', 'ws-plain']) });
  assert.deepEqual(promoted.roots.map(root => root.id).sort(), ['chat-orch', 'ws-orch']);
  assert.equal(promoted.nodes.get('chat-orch').kind, 'chat');
});

test('a page opened for a session in no swarm gets no snapshot, never another swarm', async () => {
  const home = planningHome();
  lone(home, { id: 'ws-solo', cli: 'cli-solo' });
  const server = createDashboardServer({ createEngine: () => engineFor(home, () => at(60)), version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 } });
  await server.listen();
  const pages = {
    solo: openEvents(server.port, '/api/events?session=cli-solo'),
    unknown: openEvents(server.port, '/api/events?session=cli-unknown'),
    planning: openEvents(server.port, '/api/events?session=cli-plan'),
    unit: openEvents(server.port, '/api/events?session=cli-api'),
  };
  try {
    const first = async page => (await page.waitFor(entry => entry.event === 'snapshot', 10000)).data.snapshot;
    assert.equal(await first(pages.solo), null);
    assert.equal(await first(pages.unknown), null);
    assert.equal((await first(pages.planning)).run.id, 'ws-plan');
    assert.equal((await first(pages.unit)).run.id, 'ws-root');
  } finally {
    for (const page of Object.values(pages)) page.close();
    await server.close();
  }
});

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: null, session: null,
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides,
});

test('a page opened for a session in no swarm says so, and other empty pages still say there is no swarm yet', () => {
  const session = renderApp(view({ session: 'cli-solo' }));
  assert.match(session, /<h3>Not part of a swarm<\/h3>/);
  assert.match(session, /This session isn't part of a swarm\./);
  assert.doesNotMatch(session, /No swarm yet/);
  assert.match(renderApp(view()), /<h3>No swarm yet<\/h3>/);
  assert.match(renderApp(view({ session: 'cli-solo', swarm: 'ws-gone' })), /<h3>No swarm yet<\/h3>/, 'a swarm the page picked has gone');
  assert.doesNotMatch(renderApp(view({ session: 'cli-solo', loaded: false })), /Not part of a swarm/);
  assert.match(renderApp(view({ session: 'cli-0003-b1', snapshot: exampleSnapshot() })), /class="d-head"/);
});

test('with no swarm shown, the picker selects none and offers the live swarms', () => {
  const swarms = fixture('example-swarms.json');
  assert.match(renderApp(view({ session: 'cli-solo', swarms })),
    /<select data-swarm aria-label="Swarm"><option value="" selected disabled>Choose a swarm<\/option><option value="ws-0000-root">Sample story B<\/option><\/select>/);
  const both = swarms.map(swarm => ({ ...swarm, lifecycle: 'live' }));
  assert.match(renderApp(view({ session: 'cli-solo', swarms: both })),
    /<option value="" selected disabled>Choose a swarm<\/option><option value="ws-0000-root">Sample story B<\/option><option value="ws-1000-root">Sample story A<\/option><\/select>/);
  assert.doesNotMatch(renderApp(view({ session: 'cli-solo', swarms: both.map(swarm => ({ ...swarm, lifecycle: 'finished' })) })), /data-swarm/, 'no live swarm to choose');
  assert.doesNotMatch(renderApp(view({ session: 'cli-solo', swarms, loaded: false })), /data-swarm/, 'not while the page loads');
});
