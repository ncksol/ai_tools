import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createHistoryStore } from '../engine/model/history.mjs';
import { SUMMARY_RULES } from '../engine/schema.mjs';
import { createSqliteReader } from '../engine/sqlite.mjs';
import { buildForest, rootProjectId } from '../engine/model/forest.mjs';
import { readProjectOptIn, sessionFile } from '../engine/readers/session-files.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { DAY, NO_SUCH_PID, T0, alwaysAlive } from './helpers/scenario.mjs';
import { TEST_BACKENDS, canWriteWithNode, execSql, holdExclusiveLock } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';

/*
 * A Copilot app Project is a chat-backed session that data.db lists in persistent_projects. With child sessions it is a swarm root
 * like any other. Without one, or with only sub-agents, it is a root only while the latest row of the wintermute_project table in
 * its own session.db turns wintermute on: the engine reads that row into `optedInProjects` (design 8.15).
 */

const session = id => [id, { id, title: id, mode: null, model: null, reasoningEffort: null, isRunning: false, wasInterrupted: false, createdAt: 1, archivedAt: null, agent: null }];

function workspace(id, createdAt, coordinator, projectId = null) {
  return [id, {
    id, projectId, worktreeId: null, name: id, branch: null, createdAt, archivedAt: null, sessionId: `cli-${id}`,
    creatorSessionId: coordinator, coordinatingCreatorSessionId: coordinator, createdPr: null,
  }];
}

function appWith({ projects = [], sessions = [], workspaces = [] } = {}) {
  return {
    projects: new Map(), worktrees: new Map(), automations: [], diagnostics: [], aliases: [], parentLinks: [], chatLinks: [],
    workspaces: new Map(workspaces), persistentProjects: new Set(projects),
    sessions: new Map([...sessions.map(session), ...workspaces.map(([id]) => session(`cli-${id}`))]),
  };
}

test('a Project with no child session is a swarm root only while its latest wintermute_project row turns wintermute on', () => {
  const app = appWith({ projects: ['p-on', 'p-off', 'p-never'], sessions: ['p-on', 'p-off', 'p-never', 'chat'] });
  const forest = buildForest(app, { optedInProjects: new Set(['p-on']) });
  assert.deepEqual(forest.roots.map(root => root.id), ['p-on']);
  assert.equal(forest.nodes.get('p-on').kind, 'chat');
  assert.equal(forest.nodes.get('p-on').persistentProject, true);
  assert.deepEqual(forest.projectCandidates.map(item => item.id).sort(), ['p-never', 'p-off', 'p-on']);
  assert.deepEqual(buildForest(app).roots, []);
});

test('a Project with child sessions is a root whether or not it opted in, and is not a candidate', () => {
  const app = appWith({ projects: ['p'], sessions: ['p'], workspaces: [workspace('a', 10, 'p')] });
  const forest = buildForest(app);
  assert.deepEqual(forest.roots.map(root => root.id), ['p']);
  assert.equal(forest.nodes.get('p').persistentProject, true);
  assert.equal(forest.nodes.get('a').persistentProject, false);
  assert.deepEqual(forest.projectCandidates, []);
});

test('an opt-in never promotes a session that is not a Project, or a Project that has no session row', () => {
  const app = appWith({ projects: ['gone'], sessions: ['chat'] });
  const forest = buildForest(app, { optedInProjects: new Set(['chat', 'gone']) });
  assert.deepEqual(forest.roots, []);
  assert.deepEqual(forest.projectCandidates, []);
});

test('an app without Projects data builds the same forest as before', () => {
  const app = appWith({ sessions: ['chat'], workspaces: [workspace('a', 10, 'chat')] });
  delete app.persistentProjects;
  const forest = buildForest(app, { optedInProjects: new Set(['chat']) });
  assert.deepEqual(forest.roots.map(root => root.id), ['chat']);
  assert.equal(forest.nodes.get('chat').persistentProject, false);
  assert.deepEqual(forest.projectCandidates, []);
});

test("a Project's app project is the one that most of its child sessions use, ties going to the earliest child", () => {
  const app = appWith({
    projects: ['p', 'q'], sessions: ['p', 'q', 'chat'],
    workspaces: [
      workspace('a', 10, 'p', 'repo-1'), workspace('b', 20, 'p', 'repo-2'), workspace('c', 30, 'p', 'repo-2'), workspace('d', 40, 'p'),
      workspace('e', 10, 'q', 'repo-3'), workspace('f', 20, 'q', 'repo-4'),
      workspace('g', 10, 'chat', 'repo-5'),
    ],
  });
  const forest = buildForest(app);
  assert.equal(rootProjectId(forest, 'p'), 'repo-2');
  assert.equal(rootProjectId(forest, 'q'), 'repo-3');
  assert.equal(rootProjectId(forest, 'chat'), null);
  assert.equal(rootProjectId(forest, 'a'), 'repo-1');
  assert.equal(rootProjectId(forest, 'missing'), null);
});

test("the engine names a Project's swarm by most of its children's app project, but never resolves a child's PR through it", async () => {
  const home = new CopilotHome();
  home.persistentProject({ id: 'p-team', title: 'Team', createdAt: T0 });
  home.project({ id: 'repo-1', name: 'sample-repo', githubOwner: 'sample-org', githubRepo: 'sample-repo' });
  home.project({ id: 'repo-2', name: 'other-repo' });
  home.workspace({ id: 'ws-a', projectId: 'repo-1', name: 'a: API', createdAt: T0 + 1000, creatorSessionId: 'p-team' });
  home.workspace({ id: 'ws-b', projectId: 'repo-1', name: 'b: UI', createdAt: T0 + 2000, creatorSessionId: 'p-team' });
  home.workspace({ id: 'ws-c', projectId: 'repo-2', name: 'c: docs', createdAt: T0 + 3000, creatorSessionId: 'p-team' });
  home.chat({ id: 'chat-x', parentSessionId: 'p-team', title: 'x: notes', createdAt: T0 + 4000 });
  const notes = new EventLog(T0 + 5000);
  notes.start();
  notes.report('p-team', 'swarm-status: complete unit=x pr=github:7\nSummary: The notes are done.', 'handoff');
  home.writeEvents('chat-x', notes.events);
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => T0 + 10_000, processProbe: alwaysAlive, prLookup: 'off' });
  await engine.refresh();
  assert.deepEqual(engine.listSwarms().map(swarm => [swarm.id, swarm.project]), [['p-team', { id: 'repo-1', name: 'sample-repo' }]]);
  const snapshot = await engine.getSnapshot('p-team');
  assert.deepEqual(snapshot.run.project, { id: 'repo-1', name: 'sample-repo' });
  const chat = snapshot.units.find(unit => unit.id === 'chat-x');
  assert.deepEqual([chat.pr.provider, chat.pr.id, chat.pr.repo], ['github', 7, null]);
});

test("a Project run's summary saved under older rules is rebuilt with the project its children use", async () => {
  const home = new CopilotHome();
  const old = T0 - 30 * DAY;
  home.persistentProject({ id: 'p-old', title: 'Old', createdAt: old });
  home.project({ id: 'repo-1', name: 'sample-repo' });
  home.workspace({ id: 'ws-a', projectId: 'repo-1', name: 'a: API', createdAt: old + 1000, creatorSessionId: 'p-old' });
  home.usage([{ sessionId: 'p-old', nanoAiu: 1e9, createdAt: old + 2000 }, { sessionId: 'ws-a', nanoAiu: 1e9, createdAt: old + 3000 }]);
  const historyDir = path.join(tempDir('project-roots-'), 'history');
  const stored = path.join(historyDir, 'runs', 'p-old.json');
  const open = () => createSwarmEngine({ copilotHome: home.root, historyDir, now: () => T0, processProbe: alwaysAlive, prLookup: 'off' });
  let engine = open();
  assert.deepEqual((await engine.getRunSummary('p-old')).project, { id: 'repo-1', name: 'sample-repo' });
  engine.stop();
  // As wintermute 1.5.1 saved it, under rules 3, before the dashboard read this from a Project.
  const summary = JSON.parse(readFileSync(stored, 'utf8'));
  writeFileSync(stored, `${JSON.stringify({ ...summary, project: null, rules: 3 }, null, 2)}\n`);
  engine = open();
  await engine.refresh();
  const rebuilt = await engine.getRunSummary('p-old');
  assert.deepEqual([rebuilt.project, rebuilt.rules], [{ id: 'repo-1', name: 'sample-repo' }, SUMMARY_RULES]);
  engine.stop();
});

/** The engine's SQLite reader, except that a data.db read of a table in `locked` fails, as a read of a busy database can. */
function lockingReader(dataDb, locked) {
  const reader = createSqliteReader();
  const guard = db => ({
    all: async sql => {
      if (locked.has(/\bFROM (\w+)$/.exec(sql)?.[1])) throw new Error('database is locked');
      return db.all(sql);
    },
  });
  return { read: (file, fn) => reader.read(file, file === dataDb ? db => fn(guard(db)) : fn), retain: files => reader.retain(files), close: () => reader.close() };
}

test('a failed read of the Project table keeps the last good Projects, with a warning, until the next good read', async () => {
  const home = new CopilotHome();
  home.persistentProject({ id: 'p-team', title: 'Team', createdAt: T0 });
  home.project({ id: 'repo-1', name: 'sample-repo' });
  home.workspace({ id: 'ws-a', projectId: 'repo-1', name: 'a: API', createdAt: T0 + 1000, creatorSessionId: 'p-team' });
  const locked = new Set();
  const engine = createSwarmEngine({
    copilotHome: home.root, persistHistory: false, now: () => T0 + 10_000, processProbe: alwaysAlive, prLookup: 'off', sqliteReader: lockingReader(home.dataDb, locked),
  });
  const shown = async () => [engine.listSwarms().map(swarm => swarm.project?.id ?? null), (await engine.getSnapshot('p-team')).run.project?.id ?? null];
  const warnings = () => engine.diagnostics().filter(item => item.source === 'data.db' && item.level === 'warn').map(item => item.message);
  await engine.refresh();
  assert.deepEqual(await shown(), [['repo-1'], 'repo-1']);
  locked.add('persistent_projects');
  await engine.refresh();
  assert.deepEqual(await shown(), [['repo-1'], 'repo-1']);
  assert.deepEqual(warnings(), ['persistentProjects: database is locked']);
  locked.clear();
  await engine.refresh();
  assert.deepEqual(await shown(), [['repo-1'], 'repo-1']);
  assert.deepEqual(warnings(), []);
  engine.stop();
});

for (const table of ['persistent_projects', 'projects']) {
  test(`a refresh that cannot read ${table} never replaces a run's stored summary, and the next good read rebuilds it`, async () => {
    const home = new CopilotHome();
    const old = T0 - 30 * DAY;
    home.persistentProject({ id: 'p-old', title: 'Old', createdAt: old });
    home.project({ id: 'repo-1', name: 'sample-repo' });
    home.workspace({ id: 'ws-a', projectId: 'repo-1', name: 'a: API', createdAt: old + 1000, creatorSessionId: 'p-old' });
    home.usage([{ sessionId: 'p-old', nanoAiu: 1e9, createdAt: old + 2000 }, { sessionId: 'ws-a', nanoAiu: 1e9, createdAt: old + 3000 }]);
    const historyDir = path.join(tempDir('project-roots-'), 'history');
    const stored = path.join(historyDir, 'runs', 'p-old.json');
    const saved = () => {
      const { project, rules } = JSON.parse(readFileSync(stored, 'utf8'));
      return [project?.id ?? null, rules];
    };
    const locked = new Set();
    const open = () => createSwarmEngine({
      copilotHome: home.root, historyDir, now: () => T0, processProbe: alwaysAlive, prLookup: 'off', sqliteReader: lockingReader(home.dataDb, locked),
    });
    let engine = open();
    await engine.getRunSummary('p-old');
    engine.stop();
    // A good summary that is due for a rebuild under newer rules.
    writeFileSync(stored, `${JSON.stringify({ ...JSON.parse(readFileSync(stored, 'utf8')), rules: SUMMARY_RULES - 1 }, null, 2)}\n`);
    assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES - 1]);
    // The engine starts while the table cannot be read, so it has no last good read of it.
    locked.add(table);
    engine = open();
    assert.equal((await engine.getRunSummary('p-old')).project?.id, 'repo-1');
    assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES - 1]);
    locked.clear();
    assert.equal((await engine.getRunSummary('p-old')).project?.id, 'repo-1');
    assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES]);
    engine.stop();
  });
}

for (const backend of TEST_BACKENDS) {
  test(`${backend}: the opt-in is the latest wintermute_project row, and anything else reads as null`, async () => {
    const home = new CopilotHome();
    const read = cliId => readProjectOptIn(home.projectOptIn(cliId, []), { backend });
    home.projectOptIn('on', [[T0, 0], [T0 + 1000, 1]]);
    home.projectOptIn('off', [[T0, 1], [T0 + 1000, 0]]);
    home.projectOptIn('tie', [[T0, 0], [T0, 1]]);
    assert.equal(await read('on'), true);
    assert.equal(await read('off'), false);
    assert.equal(await read('tie'), true);
    assert.equal(await read('empty'), null);
    const other = home.sessionDb('other');
    assert.equal(await readProjectOptIn(other, { backend }), null);
    execSql(other, 'CREATE TABLE wintermute_project (at TEXT, state TEXT)');
    assert.equal(await readProjectOptIn(other, { backend }), null);
    // A table without the skill's CHECK can hold anything; only an integer 0 or 1 in the latest row counts, on every backend.
    for (const value of ['NULL', "''", '2', "x'31'", '9223372036854775807']) {
      const loose = home.sessionDb(`loose-${value.length}`);
      execSql(loose, `CREATE TABLE wintermute_project (at TEXT, enabled INTEGER);
        INSERT INTO wintermute_project VALUES ('2026-10-15T07:00:00Z', 1), ('2026-10-15T08:00:00Z', ${value})`);
      assert.equal(await readProjectOptIn(loose, { backend }), null, value);
    }
  });
}

test('the engine lists an opted-in Project that has no child session, and no other childless Project', async () => {
  const home = new CopilotHome();
  home.persistentProject({ id: 'p-solo', title: 'Solo', createdAt: T0 });
  home.projectOptIn('p-solo', [[T0 + 1000, 1]]);
  const solo = new EventLog(T0 + 500);
  solo.start();
  home.writeEvents('p-solo', solo.events);
  home.persistentProject({ id: 'p-off', title: 'Off', createdAt: T0 });
  home.projectOptIn('p-off', [[T0 + 1000, 1], [T0 + 2000, 0]]);
  home.persistentProject({ id: 'p-never', title: 'Never', createdAt: T0 });
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => T0 + 10_000, processProbe: alwaysAlive, prLookup: 'off' });
  await engine.refresh();
  assert.deepEqual(engine.listSwarms().map(swarm => swarm.id), ['p-solo']);
  const snapshot = await engine.getSnapshot('p-solo');
  assert.deepEqual([snapshot.run.id, snapshot.units.length, snapshot.run.project], ['p-solo', 0, null]);
  assert.deepEqual(engine.diagnostics().filter(item => item.level === 'warn'), []);
});

test('a failed read of a Project opt-in keeps the last value read, with a warning, until the next good read', { skip: !canWriteWithNode }, async () => {
  const home = new CopilotHome();
  home.persistentProject({ id: 'p-solo', title: 'Solo', createdAt: T0 });
  const file = home.projectOptIn('p-solo', [[T0 + 1000, 1]]);
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => T0 + 10_000, processProbe: alwaysAlive, prLookup: 'off' });
  const warnings = () => engine.diagnostics().filter(item => item.level === 'warn' && /wintermute_project/.test(item.message)).map(item => item.message);
  await engine.refresh();
  assert.deepEqual(engine.listSwarms().map(swarm => swarm.id), ['p-solo']);
  // A writer in another process holds an exclusive lock while the file's stamps change, so the next read fails as busy.
  const lock = await holdExclusiveLock(file);
  try {
    utimesSync(file, new Date(), new Date(Date.now() + 9000));
    await engine.refresh();
    assert.deepEqual(engine.listSwarms().map(swarm => swarm.id), ['p-solo']);
    assert.equal(warnings().length, 1);
    assert.match(warnings()[0], /^p-solo: session\.db wintermute_project: .*database is locked/);
  } finally {
    await lock.release();
  }
  await engine.refresh();
  assert.deepEqual([engine.listSwarms().map(swarm => swarm.id), warnings()], [['p-solo'], []]);
  engine.stop();
});

/** A finished Project run 30 days old, with one child in the app project repo-1, and where its summary is stored. */
function finishedProjectRun() {
  const home = new CopilotHome();
  const old = T0 - 30 * DAY;
  home.persistentProject({ id: 'p-old', title: 'Old', createdAt: old });
  home.project({ id: 'repo-1', name: 'sample-repo' });
  home.workspace({ id: 'ws-a', projectId: 'repo-1', name: 'a: API', createdAt: old + 1000, creatorSessionId: 'p-old' });
  home.usage([{ sessionId: 'p-old', nanoAiu: 1e9, createdAt: old + 2000 }, { sessionId: 'ws-a', nanoAiu: 1e9, createdAt: old + 3000 }]);
  const historyDir = path.join(tempDir('project-roots-'), 'history');
  const stored = path.join(historyDir, 'runs', 'p-old.json');
  const saved = () => {
    if (!existsSync(stored)) return null;
    const { project, rules } = JSON.parse(readFileSync(stored, 'utf8'));
    return [project?.id ?? null, rules];
  };
  return { home, historyDir, saved };
}

test('a data.db that is gone after a partial read leaves that read incomplete, so no summary is stored from it', async () => {
  const { home, historyDir, saved } = finishedProjectRun();
  const locked = new Set();
  const open = () => createSwarmEngine({
    copilotHome: home.root, historyDir, now: () => T0, processProbe: alwaysAlive, prLookup: 'off', sqliteReader: lockingReader(home.dataDb, locked),
  });
  let engine = open();
  await engine.getRunSummary('p-old');
  assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES]);
  locked.add('projects');
  await engine.refresh();
  assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES]);
  locked.clear();
  const aside = `${home.dataDb}.aside`;
  renameSync(home.dataDb, aside);
  await engine.refresh();
  assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES]);
  renameSync(aside, home.dataDb);
  await engine.refresh();
  assert.deepEqual(saved(), ['repo-1', SUMMARY_RULES]);
  engine.stop();
  engine = open();
  assert.equal((await engine.getRunSummary('p-old')).project?.id, 'repo-1');
  engine.stop();
});

/**
 * A Project run with one child (CLI session ws-a, whose log has the run's last work), live at T0 + 10 s and finished from T0 + DAY,
 * with its summary stored in a fresh history folder. Its engine's data.db reads of the tables in `locked` fail, and `wrapHistory`
 * can change its history store. `poll(time)` refreshes at that time; `archived()` is the stored summary's project and whether
 * History lists it as summarized.
 */
function finishingRun({ wrapHistory = store => store, processProbe = alwaysAlive } = {}) {
  const home = new CopilotHome();
  home.persistentProject({ id: 'p-run', title: 'Run', createdAt: T0 });
  home.project({ id: 'repo-1', name: 'sample-repo' });
  home.workspace({ id: 'ws-a', projectId: 'repo-1', name: 'a: API', createdAt: T0 + 1000, creatorSessionId: 'p-run' });
  home.usage([{ sessionId: 'p-run', nanoAiu: 1e9, createdAt: T0 + 2000 }, { sessionId: 'ws-a', nanoAiu: 1e9, createdAt: T0 + 3000 }]);
  // As a real log does, the child's ends with a message after its last model call, so the run's last work is in that log alone.
  const last = new EventLog(T0 + 5000);
  last.message('The API is done.');
  home.writeEvents('ws-a', last.events, { append: true });
  const historyDir = path.join(tempDir('project-roots-'), 'history');
  const stored = path.join(historyDir, 'runs', 'p-run.json');
  const locked = new Set();
  let clock = T0;
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir, historyStore: wrapHistory(createHistoryStore(historyDir)), now: () => clock, processProbe,
    prLookup: 'off', sqliteReader: lockingReader(home.dataDb, locked),
  });
  return {
    home, engine, locked,
    poll: async time => {
      clock = time;
      await engine.refresh();
    },
    listed: () => engine.listSwarms().find(swarm => swarm.id === 'p-run')?.lifecycle ?? null,
    archived: async () => [
      existsSync(stored) ? JSON.parse(readFileSync(stored, 'utf8')).project?.id ?? null : null,
      (await engine.listHistory()).find(item => item.id === 'p-run')?.summarized ?? null,
    ],
    /** Three healthy polls a minute apart, after the finish. */
    recover: async () => {
      for (let minute = 1; minute <= 3; minute += 1) {
        clock = T0 + DAY + minute * 60_000;
        await engine.refresh();
      }
    },
  };
}

test('a run that finishes during a partial data.db read is stored by the next full read, without anyone asking for it', async () => {
  const run = finishingRun();
  await run.poll(T0 + 10_000);
  assert.equal(run.listed(), 'live');
  run.locked.add('projects');
  await run.poll(T0 + DAY);
  assert.deepEqual([run.listed(), await run.archived()], ['finished', [null, false]]);
  run.locked.clear();
  await run.recover();
  assert.deepEqual(await run.archived(), ['repo-1', true]);
  run.engine.stop();
});

test("a run that finishes while a child's log is missing for a moment is stored once the log is back", async () => {
  const run = finishingRun();
  await run.poll(T0 + 10_000);
  const log = path.join(run.home.stateDir, 'ws-a', 'events.jsonl');
  renameSync(log, `${log}.aside`);
  await run.poll(T0 + DAY);
  assert.deepEqual([run.listed(), await run.archived()], ['finished', [null, false]]);
  renameSync(`${log}.aside`, log);
  await run.recover();
  assert.deepEqual(await run.archived(), ['repo-1', true]);
  run.engine.stop();
});

test('a run whose summary could not be written as it finished is written by a later poll', async () => {
  let failing = false;
  const run = finishingRun({
    wrapHistory: store => ({
      ...store,
      put: async (summary, options) => {
        if (failing) throw new Error('no space left on device');
        return store.put(summary, options);
      },
    }),
  });
  await run.poll(T0 + 10_000);
  failing = true;
  await run.poll(T0 + DAY);
  assert.deepEqual([run.listed(), (await run.archived())[0]], ['finished', null]);
  failing = false;
  await run.recover();
  assert.deepEqual(await run.archived(), ['repo-1', true]);
  run.engine.stop();
});

for (const [when, steps] of [['as it finishes', [['workspaces']]], ['after it finished', [['projects'], ['workspaces']]]]) {
  test(`a run that a partial read of its workspaces hides ${when} is stored once it is back`, async () => {
    const run = finishingRun();
    await run.poll(T0 + 10_000);
    for (const [index, tables] of steps.entries()) {
      for (const table of tables) run.locked.add(table);
      await run.poll(T0 + DAY + index * 1000);
      run.locked.clear();
    }
    assert.deepEqual([run.listed(), await run.archived()], [null, [null, null]]);
    await run.recover();
    assert.deepEqual([run.listed(), await run.archived()], ['finished', ['repo-1', true]]);
    run.engine.stop();
  });
}

test('a run whose child log is gone for good is not rebuilt on every poll while its save is owed', async () => {
  // A dead process's lock on the Project: each rebuild of the run checks it, so the probe counts rebuilds once the run is finished.
  let probes = 0;
  const run = finishingRun({ processProbe: async locks => { probes += 1; return new Map(locks.map(lock => [lock.pid, false])); } });
  run.home.lock('p-run', NO_SUCH_PID, T0 + 2000);
  await run.poll(T0 + 10_000);
  rmSync(path.join(run.home.stateDir, 'ws-a', 'events.jsonl'));
  await run.poll(T0 + DAY);
  assert.equal(run.listed(), 'finished');
  probes = 0;
  for (let poll = 1; poll <= 30; poll += 1) await run.poll(T0 + DAY + poll * 20_000);
  assert.deepEqual([probes, (await run.archived())[0]], [0, null]);
  run.engine.stop();
});

test('a save that keeps failing is tried again less and less often', async () => {
  let puts = 0;
  const run = finishingRun({ wrapHistory: store => ({ ...store, put: async () => { puts += 1; throw new Error('read-only file system'); } }) });
  await run.poll(T0 + 10_000);
  for (let poll = 0; poll < 100; poll += 1) await run.poll(T0 + DAY + poll * 20_000);
  // 33 minutes of polls every 20 seconds: a try at the finish and at the next poll, then 1, 2, 4, 8 and 16 minutes after each
  // failed try.
  assert.equal(puts, 7);
  run.engine.stop();
});

const UNSAFE_IDS = ['../outside', 'nested/p', 'back\\slash', '..', '.'];

test('a Project whose id is not one safe folder name is never a candidate, opted in or not, and names no session file', () => {
  for (const id of UNSAFE_IDS) assert.equal(sessionFile('/synthetic/state', id, 'session.db'), null, id);
  assert.equal(sessionFile('/synthetic/state', 'p-ok', 'session.db'), path.join('/synthetic/state', 'p-ok', 'session.db'));
  const app = appWith({ projects: [...UNSAFE_IDS, 'p-ok'], sessions: [...UNSAFE_IDS, 'p-ok'] });
  const forest = buildForest(app, { optedInProjects: new Set([...UNSAFE_IDS, 'p-ok']) });
  assert.deepEqual(forest.projectCandidates.map(item => item.id), ['p-ok']);
  assert.deepEqual(forest.roots.map(root => root.id), ['p-ok']);
});

test('the engine reads no opt-in for a Project id that would leave its own session folder', async () => {
  const home = new CopilotHome();
  for (const id of ['../outside', 'nested/p']) {
    home.persistentProject({ id, title: id, createdAt: T0 });
    home.projectOptIn(id, [[T0 + 1000, 1]]);
  }
  const reads = [];
  const reader = createSqliteReader();
  const sqliteReader = { read: (file, fn) => { reads.push(file); return reader.read(file, fn); }, retain: files => reader.retain(files), close: () => reader.close() };
  const engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => T0 + 10_000, processProbe: alwaysAlive, prLookup: 'off', sqliteReader });
  await engine.refresh();
  assert.deepEqual([engine.listSwarms(), reads], [[], [home.dataDb]]);
  engine.stop();
});

test("the opt-in scan reports progress for each Project, so the dashboard doesn't take a slow scan for a stuck refresh", async () => {
  const home = new CopilotHome();
  for (const id of ['p-one', 'p-two']) {
    home.persistentProject({ id, title: id, createdAt: T0 });
    home.projectOptIn(id, [[T0 + 1000, 1]]);
  }
  const seen = [];
  const reader = createSqliteReader();
  let engine = null;
  const sqliteReader = {
    read: async (file, fn) => {
      if (file !== home.dataDb) {
        seen.push(engine.status().progressAt);
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      return reader.read(file, fn);
    },
    retain: files => reader.retain(files), close: () => reader.close(),
  };
  engine = createSwarmEngine({ copilotHome: home.root, persistHistory: false, now: () => T0 + 10_000, processProbe: alwaysAlive, prLookup: 'off', sqliteReader });
  await engine.refresh();
  assert.equal(seen.length >= 2, true);
  assert.ok(seen[1] - seen[0] >= 25, `progress ${seen[0]} then ${seen[1]}`);
  engine.stop();
});
