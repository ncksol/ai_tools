import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { openEvents } from './helpers/http.mjs';
import { NO_SUCH_PID, alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { tempDir } from './helpers/temp.mjs';

/*
 * Issue #30, option (b): an orchestrator that has used only `task` sub-agents, with no child session yet, is a swarm root.
 * Issue #29, item 10: sub-agent work alone must not make a swarm, since most sessions start sub-agents; only a top session
 * that runs an orchestrator agent counts.
 */

let pids = 500;

/**
 * A top-level session with no child session that starts one `task` sub-agent. `kind` is 'project' (a workspace with no
 * worktree), 'folder' (a folder workspace), 'worktree' (a workspace with a worktree) or 'chat' (a standalone chat). `ledger`
 * adds the sub-agent's model call to the usage ledger; `alive` holds a lock for a running process.
 */
function withSubagent(home, { id, cli = id, kind = 'project', agent = 'orchestrator', ledger = true, alive = false, archivedAt = null, parentId = null }) {
  if (kind === 'chat') home.chat({ id: cli, title: `Lone ${id}`, createdAt: at(55), agent });
  else {
    home.workspace({
      id, name: `Lone ${id}`, createdAt: at(55), sessionId: cli, agent, archivedAt, parentId, creatorSessionId: parentId ? 'cli-root' : null,
      workspaceType: kind === 'folder' ? 'folder' : 'worktree', ...(kind === 'worktree' ? { branch: `feature/${id}`, baseBranch: 'main' } : {}),
    });
  }
  const log = new EventLog(at(55));
  log.start(); log.turnStart();
  log.at(at(56));
  const call = log.subagent({ name: 'research' });
  log.at(at(57));
  log.subagentDone(call);
  log.done(call);
  log.turnEnd();
  home.writeEvents(cli, log.events);
  const rows = [{ sessionId: cli, nanoAiu: 1e9, createdAt: at(56) }];
  if (ledger) rows.push({ sessionId: cli, nanoAiu: 2e9, createdAt: at(57), parentToolCallId: call });
  home.usage(rows);
  if (alive) home.lock(cli, NO_SUCH_PID + ++pids, at(55));
  return cli;
}

const engineFor = (home, now) => createSwarmEngine({
  copilotHome: home.root, historyDir: path.join(tempDir('subagent-roots-'), 'history'), now: () => now, processProbe: alwaysAlive, prLookup: 'off',
});

const ids = engine => engine.listSwarms().map(swarm => swarm.id).sort();

test('an orchestrator with only task sub-agents is a swarm root, by the ledger or by its log', async () => {
  const home = scenario();
  const folder = withSubagent(home, { id: 'cli-folder', kind: 'chat' });
  const project = withSubagent(home, { id: 'ws-project', cli: 'cli-project', agent: 'session-orchestrator' });
  const logOnly = withSubagent(home, { id: 'ws-log', cli: 'cli-log', ledger: false, alive: true });
  const engine = engineFor(home, at(60));
  await engine.refresh();
  assert.deepEqual(ids(engine), ['cli-folder', 'ws-log', 'ws-old', 'ws-project', 'ws-root']);
  for (const [root, cliId] of [['cli-folder', folder], ['ws-project', project], ['ws-log', logOnly]]) {
    assert.equal(await engine.findSwarm(cliId), root, cliId);
    const listed = engine.listSwarms().find(swarm => swarm.id === root);
    assert.deepEqual(validateSwarmListItem(listed), [], root);
    assert.deepEqual([listed.lifecycle, listed.units], ['live', 0], root);
    const snapshot = await engine.getSnapshot(root);
    assert.deepEqual(validateSnapshot(snapshot), [], root);
    assert.deepEqual(snapshot.units.map(unit => [unit.kind, unit.status]), [['subagent', 'done']], root);
  }
  assert.equal((await engine.getSnapshot('cli-folder')).orchestrator.kind, 'chat');
});

test('a finished or archived orchestrator with only task sub-agents is kept in History', async () => {
  const home = scenario();
  withSubagent(home, { id: 'ws-done', cli: 'cli-done' });
  withSubagent(home, { id: 'ws-archived', cli: 'cli-archived', archivedAt: at(58) });
  const engine = engineFor(home, at(57) + 3 * 60 * 60000);
  await engine.refresh();
  for (const id of ['ws-done', 'ws-archived']) assert.equal(engine.listSwarms().find(swarm => swarm.id === id)?.lifecycle, 'finished', id);
  const history = (await engine.listHistory()).map(run => run.id);
  assert.ok(history.includes('ws-done') && history.includes('ws-archived'), history.join(', '));
});

test('sub-agent work makes no swarm of a session that does not run an orchestrator agent, or that is a child session', async () => {
  const home = scenario();
  const plain = {
    plain: withSubagent(home, { id: 'ws-plain', cli: 'cli-plain', agent: null, alive: true }),
    other: withSubagent(home, { id: 'ws-andrej', cli: 'cli-andrej', agent: 'andrej', alive: true }),
    worker: withSubagent(home, { id: 'ws-worker', cli: 'cli-worker', agent: 'orchestrator-worker', alive: true }),
    chat: withSubagent(home, { id: 'chat-plain', kind: 'chat', agent: null, alive: true }),
    noWork: (() => {
      home.workspace({ id: 'ws-idle', name: 'Idle orchestrator', createdAt: at(55), sessionId: 'cli-idle', agent: 'orchestrator' });
      const log = new EventLog(at(55));
      log.start(); log.turnStart(); log.at(at(56)); log.message('Thinking.'); log.turnEnd();
      home.writeEvents('cli-idle', log.events);
      home.usage([{ sessionId: 'cli-idle', nanoAiu: 1e9, createdAt: at(56) }]);
      home.lock('cli-idle', NO_SUCH_PID + ++pids, at(55));
      return 'cli-idle';
    })(),
  };
  const nested = withSubagent(home, { id: 'ws-nested', cli: 'cli-nested', parentId: 'ws-root', alive: true });
  const engine = engineFor(home, at(60));
  await engine.refresh();
  assert.deepEqual(ids(engine), ['ws-old', 'ws-root']);
  for (const [name, cliId] of Object.entries(plain)) assert.equal(await engine.findSwarm(cliId), null, name);
  assert.equal(await engine.findSwarm(nested), 'ws-root', 'an orchestrator child session stays a unit of its parent\'s swarm');
});

test('a page for a session with sub-agent work but no orchestrator agent shows no swarm, never another one', async () => {
  const home = scenario();
  const plain = withSubagent(home, { id: 'ws-plain', cli: 'cli-plain', agent: null });
  const engine = engineFor(home, at(60));
  const server = createDashboardServer({ createEngine: () => engine, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 } });
  await server.listen();
  const page = openEvents(server.port, `/api/events?session=${plain}`);
  try {
    assert.equal((await page.waitFor(entry => entry.event === 'snapshot', 10000)).data.snapshot, null);
  } finally {
    page.close();
    await server.close();
  }
});

test('the forest makes a childless top session a root for sub-agent work only when that CLI session runs an orchestrator agent', () => {
  const session = (id, agent) => [id, { id, title: id, mode: null, model: null, reasoningEffort: null, isRunning: false, wasInterrupted: false, createdAt: 1, archivedAt: null, agent }];
  const workspace = id => [id, { id, projectId: null, worktreeId: null, name: id, branch: null, createdAt: 1, archivedAt: null, sessionId: `cli-${id}`, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null }];
  const app = {
    projects: new Map(), worktrees: new Map(), automations: [], diagnostics: [], parentLinks: [], chatLinks: [],
    workspaces: new Map([workspace('orch'), workspace('plain'), workspace('mixed')]),
    // ws mixed: its older CLI session ran an orchestrator without sub-agents, its current one started sub-agents with no agent.
    // cli-orphan's alias names a workspace that is gone, so it is no chat and no root.
    aliases: [{ sessionId: 'cli-mixed-old', workspaceId: 'mixed', createdAt: 0 }, { sessionId: 'cli-orphan', workspaceId: 'ws-gone', createdAt: 0 }],
    sessions: new Map([
      session('cli-orch', 'orchestrator'), session('cli-plain', null), session('cli-mixed-old', 'orchestrator'), session('cli-mixed', null),
      session('chat-orch', 'session-orchestrator'), session('chat-plain', 'andrej'), session('cli-orphan', 'orchestrator'),
    ]),
  };
  const worked = new Set(['cli-orch', 'cli-plain', 'cli-mixed', 'chat-orch', 'chat-plain', 'cli-orphan']);
  assert.deepEqual(buildForest(app).roots, []);
  const forest = buildForest(app, { hasSubagents: cliId => worked.has(cliId) });
  assert.deepEqual(forest.roots.map(root => root.id).sort(), ['chat-orch', 'orch']);
  assert.equal(forest.nodes.get('chat-orch').kind, 'chat');
});

test('pages for task-only orchestrators in a folder, a worktree and a chat each show their own swarm, beside other swarms', async () => {
  const home = scenario();
  // ws-old's root restored the dashboard canvas recently; ws-root is live.
  const canvas = new EventLog(at(6));
  canvas.push('session.canvas.recorded', { canvasId: 'swarm-dashboard' });
  home.writeEvents('cli-old', canvas.events, { append: true });
  const roots = {
    'cli-folder': withSubagent(home, { id: 'ws-folder', cli: 'cli-folder', kind: 'folder' }),
    'cli-tree': withSubagent(home, { id: 'ws-tree', cli: 'cli-tree', kind: 'worktree' }),
    'cli-chat': withSubagent(home, { id: 'cli-chat', kind: 'chat' }),
  };
  const expected = { 'cli-folder': 'ws-folder', 'cli-tree': 'ws-tree', 'cli-chat': 'cli-chat' };
  const engine = engineFor(home, at(60));
  const server = createDashboardServer({ createEngine: () => engine, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 } });
  await server.listen();
  const pages = Object.keys(roots).map(cliId => [cliId, openEvents(server.port, `/api/events?session=${cliId}`)]);
  const fallback = openEvents(server.port, '/api/events');
  try {
    for (const [cliId, page] of pages) {
      const { snapshot } = (await page.waitFor(entry => entry.event === 'snapshot', 10000)).data;
      assert.equal(snapshot?.run.id, expected[cliId], cliId);
    }
    const byDefault = (await fallback.waitFor(entry => entry.event === 'snapshot', 10000)).data.snapshot.run.id;
    assert.equal(byDefault, engine.listSwarms()[0].id, 'a page with no selector shows the most recently active live swarm');
    assert.notEqual(byDefault, 'ws-old');
    assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle, 'finished');
    assert.equal((await engine.getSnapshot('ws-tree')).orchestrator.branch, 'feature/ws-tree');
  } finally {
    for (const [, page] of pages) page.close();
    fallback.close();
    await server.close();
  }
});

test('an open page finds its session\'s swarm when the first task sub-agent starts, and keeps it when the first child joins', async () => {
  const home = new CopilotHome();
  home.workspace({ id: 'ws-grow', name: 'Growing', createdAt: at(55), sessionId: 'cli-grow', agent: 'orchestrator', workspaceType: 'folder' });
  const log = new EventLog(at(55));
  log.start(); log.turnStart(); log.at(at(56)); log.message('Planning.');
  home.writeEvents('cli-grow', log.events);
  home.lock('cli-grow', NO_SUCH_PID + ++pids, at(55));
  const engine = engineFor(home, at(57));
  const clocked = { ...engine, start() {} };
  const server = createDashboardServer({ createEngine: () => clocked, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 } });
  await server.listen();
  const settle = async () => { await engine.refresh(); await engine.refresh(); };
  const page = openEvents(server.port, '/api/events?session=cli-grow');
  const shown = () => page.events.filter(entry => entry.event === 'snapshot').map(entry => entry.data.snapshot?.run.id ?? null);
  try {
    assert.equal((await page.waitFor(entry => entry.event === 'snapshot', 10000)).data.snapshot, null, 'no sub-agent yet: no swarm');

    // The sub-agent has started but made no model call yet, so only the log shows it.
    const work = new EventLog(at(58));
    work.previous = log.previous;
    const call = work.subagent({ name: 'scout' });
    home.writeEvents('cli-grow', work.events, { append: true });
    await settle();
    await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot?.run.id === 'ws-grow', 10000);

    home.usage([{ sessionId: 'cli-grow', nanoAiu: 1e9, createdAt: at(59), parentToolCallId: call }, { sessionId: 'cli-grow', nanoAiu: 1e9, createdAt: at(59), parentToolCallId: call }]);
    home.workspace({ id: 'ws-grow-a', name: 'Grow a1', createdAt: at(60), sessionId: 'cli-grow-a', parentId: 'ws-grow', creatorSessionId: 'cli-grow' });
    await settle();
    const joined = await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot?.units.some(unit => unit.id === 'ws-grow-a'), 10000);
    assert.equal(joined.data.snapshot.run.id, 'ws-grow');
    assert.deepEqual([...new Set(shown())], [null, 'ws-grow']);
  } finally {
    page.close();
    await server.close();
  }
});
