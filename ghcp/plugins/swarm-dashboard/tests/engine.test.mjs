import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { DAY, T0, alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

function fingerprint(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push([path.relative(dir, full), createHash('sha1').update(readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir);
  return out;
}

test('the engine follows a swarm from live to history without writing Copilot data', async () => {
  const home = scenario();
  const before = fingerprint(home.root);
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });

  await engine.refresh();
  const swarms = engine.listSwarms();
  assert.deepEqual(swarms.map(swarm => [swarm.id, swarm.lifecycle, swarm.units]), [['ws-root', 'live', 2], ['ws-old', 'finished', 1]]);
  assert.deepEqual(swarms.flatMap(validateSwarmListItem), []);
  let snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.run.id, 'ws-root');
  assert.equal(snapshot.orchestrator.statusDetail, 'waiting_question');
  assert.deepEqual(snapshot.units.map(unit => [unit.label, unit.statusDetail]), [['a1', 'idle'], ['u1', 'idle']]);
  assert.deepEqual(snapshot.units[0].progress, { done: 1, total: 2 });
  assert.equal(snapshot.units[0].report.title, 'API done.');
  assert.equal(snapshot.cost.credits, 7);
  assert.deepEqual(snapshot.needs.map(need => need.labels), [['a1']]);
  const firstRevision = snapshot.revision;

  const changes = [];
  engine.subscribe(() => { throw new Error('a broken listener'); });
  engine.subscribe(change => changes.push(change));
  await engine.refresh();
  assert.deepEqual(changes, []);

  const asking = new EventLog(at(61));
  asking.turnStart();
  asking.ask('Which colour?');
  home.writeEvents('cli-ui', asking.events, { append: true });
  clock = at(62);
  await engine.refresh();
  assert.deepEqual(changes.map(change => change.swarmIds), [['ws-root']]);
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.units[1].statusDetail, 'waiting_question');
  assert.ok(snapshot.revision > firstRevision);

  const restart = new EventLog(at(6));
  restart.start();
  home.writeEvents('cli-ui', restart.events);
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.units[1].statusDetail, 'idle');
  assert.equal(snapshot.units[1].lastEventAt, at(6));

  const answered = new EventLog(at(63));
  answered.done('call-1', { result: 'Yes' });
  answered.turnEnd();
  home.writeEvents('cli-root', answered.events, { append: true });
  clock = at(63) + 2 * HOUR + MINUTE;
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.run.lifecycle, 'finished');
  assert.equal(snapshot.run.finishedAt, at(63));
  assert.ok(existsSync(path.join(historyDir, 'runs', 'ws-root.json')));
  const history = await engine.listHistory();
  assert.deepEqual(history.map(item => [item.id, item.summarized]), [['ws-root', true], ['ws-old', false]]);
  assert.deepEqual(history.flatMap(validateRunListItem), []);
  assert.deepEqual(validateRunSummary(await engine.getRunSummary('ws-root')), []);
  await engine.refresh();
  assert.equal(engine.listSwarms()[0].lifecycle, 'finished');

  const after = new Map(fingerprint(home.root));
  assert.deepEqual([...after.keys()], before.map(([file]) => file));
  for (const [file, hash] of before) if (!file.endsWith('events.jsonl')) assert.equal(after.get(file), hash, file);
});

test('findSwarm maps any session of a swarm to its root', async () => {
  const home = scenario();
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  assert.equal(await engine.findSwarm('ws-root'), 'ws-root');
  assert.equal(await engine.findSwarm('cli-root'), 'ws-root');
  assert.equal(await engine.findSwarm('cli-api'), 'ws-root');
  assert.equal(await engine.findSwarm('ws-ui'), 'ws-root');
  assert.equal(await engine.findSwarm('cli-old-child'), 'ws-old');
  assert.equal(await engine.findSwarm('nope'), null);
});

test('with persistHistory false the engine writes nothing', async () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, persistHistory: false, now: () => at(60) + 3 * HOUR, processProbe: alwaysAlive, prLookup: 'off' });
  const summary = await engine.getRunSummary('ws-old');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(existsSync(historyDir), false);
});

test('start polls until stop, and creating an engine starts nothing', async () => {
  const home = scenario();
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => (clock += 1000), processProbe: alwaysAlive, prLookup: 'off' });
  let seen = 0;
  engine.subscribe(() => { seen += 1; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(seen, 0);
  engine.start({ intervalMs: 20 });
  const deadline = Date.now() + 10_000;
  while (seen < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  engine.stop();
  assert.ok(seen >= 2, `expected repeated refreshes, saw ${seen}`);
  await engine.refresh();
  const after = seen;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(seen, after);
});

test('missing Copilot data degrades to diagnostics', async () => {
  const engine = createSwarmEngine({ copilotHome: tempDir('swarm-empty-'), historyDir: path.join(tempDir('swarm-engine-'), 'h'), prLookup: 'off' });
  await engine.refresh();
  assert.deepEqual(engine.listSwarms(), []);
  assert.equal(await engine.getSnapshot(), null);
  assert.ok(engine.diagnostics().some(item => item.source === 'data.db' && item.level === 'warn'));
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a swarm keeps increasing its revision after it leaves tracking', async () => {
  const home = scenario();
  for (const n of [1, 2, 3]) {
    home.workspace({ id: `ws-x${n}`, name: `Extra ${n}`, createdAt: T0 - 20 * DAY + n * MINUTE, sessionId: `cli-x${n}` });
    home.workspace({ id: `ws-x${n}-child`, name: `Extra ${n} child`, createdAt: T0 - 20 * DAY + (n + 5) * MINUTE, sessionId: `cli-x${n}-child`, parentId: `ws-x${n}`, creatorSessionId: `cli-x${n}` });
  }
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  const first = await engine.getSnapshot('ws-old');
  assert.ok(first.revision >= 1);
  for (const n of [1, 2, 3]) assert.ok(await engine.getSnapshot(`ws-x${n}`));

  const later = new EventLog(T0 - 30 * DAY + 10 * MINUTE);
  later.turnStart();
  home.writeEvents('cli-old', later.events, { append: true });
  const second = await engine.getSnapshot('ws-old');
  assert.ok(second.revision > first.revision, `${second.revision} should be above ${first.revision}`);
});

test('one failing swarm does not stop the refresh', async () => {
  const home = scenario();
  home.workspace({ id: 'ws-bad', name: 'Bad swarm', createdAt: at(10), sessionId: 'cli-bad' });
  home.workspace({ id: 'ws-bad-child', name: 'Bad child', createdAt: at(11), sessionId: 'cli-bad-child', parentId: 'ws-bad', creatorSessionId: 'cli-bad', pr: { repo: 'sample/repo', number: 77, state: 'open' } });
  const bad = new EventLog(at(11));
  bad.start(); bad.turnStart();
  home.writeEvents('cli-bad-child', bad.events);
  const lookup = {
    request(pr) {
      if (pr.id === 77) throw new Error('a lookup failure');
    },
    get: () => null,
    errors: () => [],
  };
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: lookup });
  const changes = [];
  engine.subscribe(change => changes.push(change));
  await engine.refresh();
  assert.equal((await engine.getSnapshot('ws-root')).run.id, 'ws-root');
  assert.deepEqual(changes.map(change => change.swarmIds), [['ws-root']]);
  assert.ok(engine.listSwarms().some(swarm => swarm.id === 'ws-bad'));
  const problem = engine.diagnostics().find(item => item.source === 'snapshot');
  assert.equal(problem.level, 'warn');
  assert.equal(problem.message, 'ws-bad: a lookup failure');
});

test('stop then start runs a single polling chain', async () => {
  const home = scenario();
  let refreshes = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const probe = async locks => {
    await gate;
    return alwaysAlive(locks);
  };
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => { refreshes += 1; return at(60); }, processProbe: probe, prLookup: 'off',
  });
  engine.start({ intervalMs: 50 });
  const deadline = Date.now() + 5000;
  while (refreshes < 1 && Date.now() < deadline) await sleep(5);
  assert.equal(refreshes, 1);
  engine.stop();
  engine.start({ intervalMs: 50 });
  await sleep(20);
  release();
  await engine.refresh();
  engine.stop();
  const settled = refreshes;
  await sleep(250);
  assert.equal(refreshes, settled);
});

test('a finished run that is first requested through getRunSummary is written once', async () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const stored = path.join(historyDir, 'runs', 'ws-old.json');
  let readsAfterWrite = 0;
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir, now: () => { if (existsSync(stored)) readsAfterWrite += 1; return at(60); }, processProbe: alwaysAlive, prLookup: 'off',
  });
  const summary = await engine.getRunSummary('ws-old');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.ok(existsSync(stored));
  assert.equal(readsAfterWrite, 0);
});

const readSummary = file => JSON.parse(readFileSync(file, 'utf8'));

test('a resumed run returns to Live and leaves History', async () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const stored = path.join(historyDir, 'runs', 'ws-old.json');
  const lastEvent = T0 - 30 * DAY + MINUTE;
  let clock = at(0);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  const first = await engine.getRunSummary('ws-old');
  assert.equal(first.finishedAt, lastEvent);
  assert.ok(existsSync(stored));
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle, 'finished');
  assert.deepEqual((await engine.listHistory()).map(item => item.id), ['ws-old']);
  const before = { text: readFileSync(stored, 'utf8'), ino: statSync(stored).ino };

  const resumeAt = at(10);
  const later = new EventLog(resumeAt);
  later.turnStart();
  home.writeEvents('cli-old', later.events, { append: true });
  clock = at(15);
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle, 'live');
  assert.deepEqual((await engine.listHistory()).map(item => item.id), []);
  const live = await engine.getRunSummary('ws-old');
  assert.deepEqual(validateRunSummary(live), []);
  assert.equal(live.finishedAt, resumeAt);
  assert.equal(live.computedAt, clock);
  assert.deepEqual({ text: readFileSync(stored, 'utf8'), ino: statSync(stored).ino }, before);

  clock = resumeAt + 2 * HOUR + MINUTE;
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle, 'finished');
  const history = await engine.listHistory();
  assert.deepEqual(history.map(item => [item.id, item.finishedAt]), [['ws-old', resumeAt]]);
  assert.equal(readSummary(stored).finishedAt, resumeAt);
  assert.equal((await engine.getRunSummary('ws-old')).finishedAt, resumeAt);
});

test('a tracked run that finished shows Live after one refresh when work resumes', async () => {
  const home = scenario();
  const lastEvent = T0 - 30 * DAY + MINUTE;
  let clock = lastEvent + HOUR;
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off',
  });
  const lifecycleOf = () => engine.listSwarms().find(swarm => swarm.id === 'ws-old').lifecycle;
  await engine.refresh();
  assert.equal(lifecycleOf(), 'live');
  clock = lastEvent + 2 * HOUR + MINUTE;
  await engine.refresh();
  assert.equal(lifecycleOf(), 'finished');
  const resumeAt = lastEvent + 3 * HOUR;
  const later = new EventLog(resumeAt);
  later.turnStart();
  home.writeEvents('cli-old', later.events, { append: true });
  clock = resumeAt + MINUTE;
  await engine.refresh();
  assert.equal(lifecycleOf(), 'live');
});

test('a throwing log callback cannot break polling', async () => {
  const home = scenario();
  rmSync(home.storeDb, { force: true });
  rmSync(`${home.storeDb}-wal`, { force: true });
  rmSync(`${home.storeDb}-shm`, { force: true });
  let calls = 0;
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off',
    log: () => { calls += 1; throw new Error('a broken logger'); },
  });
  await engine.refresh();
  await engine.refresh();
  assert.ok(calls > 0);
  assert.ok(engine.diagnostics().some(item => item.source === 'session-store.db' && item.level === 'warn'));
});

test('a missing data.db keeps the last good app data and its revisions', async () => {
  const home = scenario();
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  const before = (await engine.getSnapshot('ws-root')).revision;
  const aside = path.join(tempDir('swarm-aside-'), 'moved');
  mkdirSync(aside);
  const suffixes = ['', '-wal', '-shm'];
  for (const suffix of suffixes) if (existsSync(home.dataDb + suffix)) renameSync(home.dataDb + suffix, path.join(aside, `data.db${suffix}`));
  await engine.refresh();
  assert.ok(engine.listSwarms().some(swarm => swarm.id === 'ws-root'));
  assert.ok(engine.diagnostics().some(item => item.source === 'data.db' && item.level === 'warn'));
  const during = (await engine.getSnapshot('ws-root')).revision;
  assert.ok(during >= before);
  for (const suffix of suffixes) if (existsSync(path.join(aside, `data.db${suffix}`))) renameSync(path.join(aside, `data.db${suffix}`), home.dataDb + suffix);
  const asking = new EventLog(at(61));
  asking.turnStart();
  home.writeEvents('cli-ui', asking.events, { append: true });
  clock = at(62);
  await engine.refresh();
  assert.ok(engine.diagnostics().every(item => item.source !== 'data.db'));
  assert.ok((await engine.getSnapshot('ws-root')).revision > during);
});

function prHome() {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-pr', projectId: 'project-1', name: 'PR story', createdAt: T0, sessionId: 'cli-pr' });
  home.workspace({ id: 'ws-pr-unit', projectId: 'project-1', name: 'Sample p1 unit', createdAt: at(5), sessionId: 'cli-pr-unit', parentId: 'ws-pr', creatorSessionId: 'cli-pr', branch: 'feature/p1', baseBranch: 'main' });
  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.at(at(10)); root.turnEnd();
  home.writeEvents('cli-pr', root.events);
  const unit = new EventLog(at(5));
  unit.start(); unit.turnStart(); unit.at(at(20));
  unit.report('ws-pr', 'Opened PR !4711 for review.', 'handoff');
  unit.turnEnd();
  home.writeEvents('cli-pr-unit', unit.events);
  home.workspaceYaml('cli-pr-unit', { cwd: '/synthetic/worktrees/p1', hostType: 'ado', repository: 'sample-org/sample-project/sample-repo' });
  return home;
}

const MERGED_REPLY = JSON.stringify({ status: 'completed', title: 'Sample PR', creationDate: '2026-10-15T08:30:00Z', closedDate: '2026-10-15T09:00:00Z' });

function gatedLookup(clock) {
  const gate = { release: null };
  const run = () => new Promise(resolve => { gate.release = resolve; });
  return { gate, lookup: createPrLookup({ run, now: () => clock() }) };
}

const stat = file => ({ text: readFileSync(file, 'utf8'), ino: statSync(file).ino });

test('a stored summary picks up PR results that arrive later', async t => {
  const lastAt = at(20);
  const pr = { provider: 'ado', id: 4711, repo: 'sample-org/sample-project/sample-repo' };
  const unitOutcome = summary => summary.units.find(unit => unit.label === 'p1').outcome;

  await t.test('path A: a live, tracked run whose lookup is pending turns finished', async () => {
    const home = prHome();
    const historyDir = path.join(tempDir('swarm-engine-'), 'history');
    const stored = path.join(historyDir, 'runs', 'ws-pr.json');
    let clock = at(30);
    const { gate, lookup } = gatedLookup(() => clock);
    const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => clock, processProbe: alwaysAlive, prLookup: lookup, persistHistory: true });
    await engine.refresh();
    assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-pr').lifecycle, 'live');
    assert.equal(lookup.pending(pr), true);
    assert.equal(existsSync(stored), false);
    clock = lastAt + 2 * HOUR + MINUTE;
    await engine.refresh();
    assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-pr').lifecycle, 'finished');
    assert.equal(readSummary(stored).children.merged, 0);
    gate.release(MERGED_REPLY);
    await lookup.settle();
    await engine.refresh();
    const updated = readSummary(stored);
    assert.equal(updated.children.merged, 1);
    assert.equal(unitOutcome(updated), 'merged');
    const settled = stat(stored);
    await engine.refresh();
    await engine.refresh();
    assert.deepEqual(stat(stored), settled);
  });

  await t.test('path B: getRunSummary on a finished run that was never tracked stores it before the lookup resolves', async () => {
    const home = prHome();
    const historyDir = path.join(tempDir('swarm-engine-'), 'history');
    const stored = path.join(historyDir, 'runs', 'ws-pr.json');
    const clock = () => lastAt + 3 * HOUR;
    const { gate, lookup } = gatedLookup(clock);
    const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: clock, processProbe: alwaysAlive, prLookup: lookup, persistHistory: true });
    assert.equal((await engine.getRunSummary('ws-pr')).children.merged, 0);
    assert.equal(readSummary(stored).children.merged, 0);
    gate.release(MERGED_REPLY);
    await lookup.settle();
    await engine.refresh();
    assert.equal(readSummary(stored).children.merged, 1);
    assert.equal((await engine.getRunSummary('ws-pr')).children.merged, 1);
    const settled = stat(stored);
    await engine.refresh();
    assert.deepEqual(stat(stored), settled);
  });
});
