import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createHistoryStore } from '../engine/model/history.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { DAY, NO_SUCH_PID, T0, alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { canWriteWithNode, execSql, holdExclusiveLock, openWriter } from './helpers/sqlite-writer.mjs';
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
  return { gate, lookup: createPrLookup({ run, now: () => clock(), azureExtensionInstalled: async () => true }) };
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

/** The last event of ws-old in scenario(). */
const OLD_LAST = T0 - 30 * DAY + MINUTE;

/** ws-old from scenario() with 1 credit, its summary stored by an engine that then stops. reopen() makes a new engine, 30 days on. */
async function storedOldRun() {
  const home = scenario();
  home.usage([{ sessionId: 'cli-old', nanoAiu: 1e9, createdAt: OLD_LAST - 30_000 }]);
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const stored = path.join(historyDir, 'runs', 'ws-old.json');
  const reopen = () => createSwarmEngine({ copilotHome: home.root, historyDir, now: () => at(0), processProbe: alwaysAlive, prLookup: 'off' });
  const first = reopen();
  const summary = await first.getRunSummary('ws-old');
  first.stop();
  assert.deepEqual([summary.finishedAt, summary.credits], [OLD_LAST, 1]);
  assert.deepEqual([readSummary(stored).finishedAt, readSummary(stored).credits], [OLD_LAST, 1]);
  return { home, stored, reopen };
}

const oldItem = async engine => {
  const item = (await engine.listHistory()).find(entry => entry.id === 'ws-old');
  return item && [item.finishedAt, item.credits, item.summarized];
};

test('a stored summary is rebuilt when its run resumed and finished again while no engine ran', async () => {
  const { home, stored, reopen } = await storedOldRun();
  const resumeAt = OLD_LAST + 10 * MINUTE;
  const finishedAt = resumeAt + 10 * MINUTE;
  const later = new EventLog(resumeAt);
  later.turnStart(); later.at(finishedAt); later.turnEnd();
  home.writeEvents('cli-old', later.events, { append: true });
  home.usage([{ sessionId: 'cli-old', nanoAiu: 2e9, createdAt: resumeAt + 5 * MINUTE }]);

  const engine = reopen();
  await engine.refresh();
  const listed = engine.listSwarms().find(swarm => swarm.id === 'ws-old');
  assert.deepEqual([listed.lifecycle, listed.lastActivityAt, listed.credits], ['finished', finishedAt, 3]);
  assert.deepEqual(await oldItem(engine), [finishedAt, 3, false], 'History lists the run from the listing until it is summarised again');
  const summary = await engine.getRunSummary('ws-old');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.deepEqual([summary.finishedAt, summary.credits], [finishedAt, 3]);
  assert.deepEqual([readSummary(stored).finishedAt, readSummary(stored).credits], [finishedAt, 3]);
  assert.deepEqual(await oldItem(engine), [finishedAt, 3, true]);
  engine.stop();
});

test('a stored summary is rebuilt when cost for the time it covers arrives later', async () => {
  const { home, stored, reopen } = await storedOldRun();
  home.usage([{ sessionId: 'cli-old', nanoAiu: 2e9, createdAt: OLD_LAST - 10_000 }]);
  const engine = reopen();
  const summary = await engine.getRunSummary('ws-old');
  assert.deepEqual([summary.finishedAt, summary.credits], [OLD_LAST, 3]);
  assert.equal(readSummary(stored).credits, 3);
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 3, true]);
  engine.stop();
});

test('a stored summary with nothing newer is returned as stored, and lower cost does not replace it', async () => {
  const { home, stored, reopen } = await storedOldRun();
  const before = stat(stored);
  const engine = reopen();
  assert.deepEqual(await engine.getRunSummary('ws-old'), readSummary(stored));
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 1, true]);
  assert.deepEqual(stat(stored), before);
  engine.stop();

  // Cleaning up logs can drop ledger rows; the stored cost then stays.
  execSql(home.storeDb, "DELETE FROM assistant_usage_events WHERE session_id = 'cli-old'");
  const cleaned = reopen();
  await cleaned.refresh();
  assert.equal(cleaned.listSwarms().find(swarm => swarm.id === 'ws-old').credits, 0);
  assert.equal((await cleaned.getRunSummary('ws-old')).credits, 1);
  assert.deepEqual(await oldItem(cleaned), [OLD_LAST, 1, true]);
  assert.deepEqual(stat(stored), before);
  cleaned.stop();
});

test('a stored summary is still returned once its run has left the listing', async () => {
  const { home, stored, reopen } = await storedOldRun();
  const before = stat(stored);
  execSql(home.dataDb, `
    DELETE FROM workspace_parent_links WHERE child_workspace_id = 'ws-old-child';
    DELETE FROM workspace_session_aliases WHERE workspace_id IN ('ws-old', 'ws-old-child');
    DELETE FROM workspaces WHERE id IN ('ws-old', 'ws-old-child');
    DELETE FROM sessions WHERE id IN ('cli-old', 'cli-old-child');`);
  rmSync(path.join(home.stateDir, 'cli-old'), { recursive: true, force: true });
  const engine = reopen();
  await engine.refresh();
  assert.equal(engine.listSwarms().some(swarm => swarm.id === 'ws-old'), false);
  assert.deepEqual(await engine.getRunSummary('ws-old'), readSummary(stored));
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 1, true]);
  assert.deepEqual(stat(stored), before);
  engine.stop();
});

/**
 * A history store that passes through, except while `armed`: then the first read of ws-old passes, and each later read of it
 * waits until a summary with 3 credits has been saved. `firstRead` resolves once the first armed read has its value.
 */
function holdableHistory(dir) {
  const store = createHistoryStore(dir);
  const control = { armed: false, puts: [] };
  let reads = 0;
  let savedThree;
  const three = new Promise(resolve => { savedThree = resolve; });
  let firstReadDone;
  control.firstRead = new Promise(resolve => { firstReadDone = resolve; });
  control.store = {
    ...store,
    async get(id) {
      if (!control.armed || id !== 'ws-old') return store.get(id);
      reads += 1;
      if (reads === 1) {
        const value = await store.get(id);
        firstReadDone();
        return value;
      }
      await three;
      return store.get(id);
    },
    async put(summary) {
      await store.put(summary);
      if (control.armed) control.puts.push(summary.credits);
      if (summary.credits === 3) savedThree();
    },
  };
  return control;
}

test('a summary request that overlaps a refresh never overwrites the newer summary that the refresh saves', async () => {
  const { home, stored } = await storedOldRun();
  // A lock on cli-old makes the refresh probe it while it rebuilds the run's snapshot: after its listing shows the new cost,
  // and before the cached snapshot is replaced. The probe is the hook that runs the request inside that window.
  const oldPid = NO_SUCH_PID + 30;
  home.lock('cli-old', oldPid, OLD_LAST);
  let duringRefresh = null;
  const processProbe = async locks => {
    if (duringRefresh && locks.some(lock => lock.pid === oldPid)) {
      const hook = duringRefresh;
      duringRefresh = null;
      await hook();
    }
    return new Map(locks.map(lock => [lock.pid, lock.pid !== oldPid]));
  };
  const history = holdableHistory(path.dirname(path.dirname(stored)));
  let clock = at(0);
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir: path.dirname(path.dirname(stored)), historyStore: history.store, now: () => clock, processProbe, prLookup: 'off',
  });
  assert.equal((await engine.getSnapshot('ws-old')).cost.credits, 1, 'the run is tracked, and its cached snapshot has 1 credit');

  // Cost for the time the run covers arrives later; the next refresh's listing shows 3 credits.
  home.usage([{ sessionId: 'cli-old', nanoAiu: 2e9, createdAt: OLD_LAST - 10_000 }]);
  let request = null;
  let listedDuring = null;
  let overlapItem = null;
  duringRefresh = async () => {
    listedDuring = engine.listSwarms().find(swarm => swarm.id === 'ws-old').credits;
    request = engine.getRunSummary('ws-old');
    // The request's first history read completes; whatever the request does next without I/O runs before this resumes.
    await history.firstRead;
    await new Promise(resolve => setImmediate(resolve));
    overlapItem = await oldItem(engine);
  };
  history.armed = true;
  clock = at(0) + 20_000;
  await engine.refresh();
  assert.equal(listedDuring, 3, 'the hook ran after the listing showed the new cost');
  assert.ok(request, 'the hook ran while the refresh rebuilt the run');
  const summary = await request;

  assert.equal(summary.credits, 3);
  assert.equal(readSummary(stored).credits, 3);
  assert.deepEqual(history.puts, [3], 'only the refresh writes, and only the newer summary');
  assert.deepEqual(overlapItem, [OLD_LAST, 3, false], 'History does not show the older cached snapshot as summarised once the listing shows 3');
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 3, true]);
  engine.stop();
});

/**
 * Finished runs whose last log line has no timestamp, so each events.jsonl was modified 5 minutes after its last parsed
 * event: their listing shows activity more than the slack after their summaries' finish time.
 */
function untimedTailHome(count) {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  const runs = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `ws-untimed-${i}`;
    const cliId = `cli-untimed-${i}`;
    home.workspace({ id, projectId: 'project-1', name: `Untimed story ${i}`, createdAt: at(i), sessionId: cliId });
    home.workspace({ id: `${id}-unit`, projectId: 'project-1', name: `Untimed u${i} unit`, createdAt: at(i), sessionId: `${cliId}-unit`, parentId: id, creatorSessionId: cliId });
    const unit = new EventLog(at(i));
    unit.start(); unit.turnStart(); unit.turnEnd();
    home.writeEvents(`${cliId}-unit`, unit.events);
    const log = new EventLog(at(i));
    log.start(); log.turnStart(); log.wait(MINUTE); log.turnEnd();
    const lastParsed = log.t;
    const file = home.writeEvents(cliId, [...log.events, { type: 'session.info', data: { message: 'a line without a timestamp' } }]);
    utimesSync(file, (lastParsed + 5 * MINUTE) / 1000, (lastParsed + 5 * MINUTE) / 1000);
    runs.push({ id, cliId, lastParsed });
  }
  return { home, runs };
}

test('a checked summary is remembered, so an unchanged run is not rebuilt again after its snapshot leaves the cache', async () => {
  const { home, runs } = untimedTailHome(4);
  const clock = at(10) + 3 * HOUR;
  const engine = createSwarmEngine({
    copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'history'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off',
  });
  // A run whose snapshot is built anew (as it is when an evicted run is tracked again) is announced to subscribers.
  const built = [];
  engine.subscribe(change => built.push(...change.swarmIds));
  for (const run of runs) assert.equal((await engine.getRunSummary(run.id)).finishedAt, run.lastParsed);
  assert.deepEqual([...built].sort(), runs.map(run => run.id), 'each run was built once');
  // Four runs, but only three requested snapshots are kept. The next refresh (as the poller runs) lists the first run from its files.
  await engine.refresh();
  const first = engine.listSwarms().find(swarm => swarm.id === runs[0].id);
  assert.equal(first.lastActivityAt, runs[0].lastParsed + 5 * MINUTE, 'the listing shows the file time of the untracked run');

  built.length = 0;
  const summarized = async () => (await engine.listHistory()).map(item => [item.id, item.summarized]).sort();
  for (let round = 0; round < 3; round += 1) {
    await engine.refresh();
    assert.deepEqual(await summarized(), runs.map(run => [run.id, true]), `round ${round}`);
    for (const run of runs) assert.equal((await engine.getRunSummary(run.id)).finishedAt, run.lastParsed);
  }
  assert.deepEqual(built, [], 'no run was rebuilt');

  // New activity makes the first run stale again, and it is rebuilt once.
  const later = new EventLog(runs[0].lastParsed + 30 * MINUTE);
  later.turnStart(); later.wait(MINUTE); later.turnEnd();
  home.writeEvents(runs[0].cliId, later.events, { append: true });
  await engine.refresh();
  assert.deepEqual((await summarized()).find(([id]) => id === runs[0].id), [runs[0].id, false]);
  assert.equal((await engine.getRunSummary(runs[0].id)).finishedAt, later.t);
  assert.deepEqual(built, [runs[0].id], 'the changed run was rebuilt');
  assert.deepEqual((await summarized()).find(([id]) => id === runs[0].id), [runs[0].id, true]);
  engine.stop();
});

test('a summary is not marked checked by a rebuild that failed, so a later request still rebuilds it', async () => {
  const home = scenario();
  // ws-old's child gets a PR, so each build of ws-old asks the PR lookup about it; the lookup fails while `fault` is set.
  execSql(home.dataDb, "UPDATE workspaces SET created_pr_repo_full_name = 'sample/repo', created_pr_number = 78, created_pr_state = 'open' WHERE id = 'ws-old-child'");
  for (const n of [1, 2, 3]) {
    home.workspace({ id: `ws-x${n}`, name: `Extra ${n}`, createdAt: T0 - 20 * DAY + n * MINUTE, sessionId: `cli-x${n}` });
    home.workspace({ id: `ws-x${n}-child`, name: `Extra ${n} child`, createdAt: T0 - 20 * DAY + (n + 5) * MINUTE, sessionId: `cli-x${n}-child`, parentId: `ws-x${n}`, creatorSessionId: `cli-x${n}` });
  }
  home.usage([{ sessionId: 'cli-old', nanoAiu: 1e9, createdAt: OLD_LAST - 30_000 }]);
  let fault = false;
  const lookup = {
    request(pr) {
      if (fault && pr.id === 78) throw new Error('a lookup failure');
    },
    get: () => null,
    errors: () => [],
  };
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const stored = path.join(historyDir, 'runs', 'ws-old.json');
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => at(0), processProbe: alwaysAlive, prLookup: lookup });
  assert.equal((await engine.getRunSummary('ws-old')).credits, 1);
  assert.equal(readSummary(stored).credits, 1, 'the run is stored, and its snapshot cached, at 1 credit');

  // Cost for the time the run covers arrives later, and every rebuild of the run fails from now on.
  home.usage([{ sessionId: 'cli-old', nanoAiu: 2e9, createdAt: OLD_LAST - 10_000 }]);
  fault = true;
  await engine.refresh();
  assert.ok(engine.diagnostics().some(item => item.source === 'snapshot' && item.message === 'ws-old: a lookup failure'));
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 3, false]);
  assert.equal((await engine.getRunSummary('ws-old')).credits, 1, 'the stored summary is returned while the run cannot be rebuilt');
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 3, false], 'the kept older snapshot does not mark the stored summary as checked');

  // Three other requested runs push ws-old out of tracking, so its snapshot leaves the cache; then the fault goes away.
  for (const n of [1, 2, 3]) assert.ok(await engine.getSnapshot(`ws-x${n}`));
  fault = false;
  const summary = await engine.getRunSummary('ws-old');
  assert.equal(summary.credits, 3, 'the next request rebuilds the run');
  assert.equal(readSummary(stored).credits, 3);
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 3, true]);
  engine.stop();
});

test('a summary is not marked checked by a refresh that could not read its events, so it is rebuilt once they can be read', async t => {
  const home = scenario();
  for (const n of [1, 2, 3]) {
    home.workspace({ id: `ws-x${n}`, name: `Extra ${n}`, createdAt: T0 - 20 * DAY + n * MINUTE, sessionId: `cli-x${n}` });
    home.workspace({ id: `ws-x${n}-child`, name: `Extra ${n} child`, createdAt: T0 - 20 * DAY + (n + 5) * MINUTE, sessionId: `cli-x${n}-child`, parentId: `ws-x${n}`, creatorSessionId: `cli-x${n}` });
  }
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const stored = path.join(historyDir, 'runs', 'ws-old.json');
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => at(0), processProbe: alwaysAlive, prLookup: 'off' });
  assert.equal((await engine.getRunSummary('ws-old')).finishedAt, OLD_LAST);
  assert.equal(readSummary(stored).finishedAt, OLD_LAST, 'the run is stored, and its snapshot cached, finishing at its first finish');

  // The run works again and finishes later; the helper keeps the file's time at its last event.
  const finishedAt = OLD_LAST + 19 * MINUTE;
  const later = new EventLog(OLD_LAST + 10 * MINUTE);
  later.turnStart(); later.at(finishedAt); later.turnEnd();
  const file = home.writeEvents('cli-old', later.events, { append: true });
  const { mode, mtime } = statSync(file);
  // The next read of the events fails, and the engine handles it with a warning.
  chmodSync(file, 0o000);
  let readable = true;
  try {
    readFileSync(file);
  } catch {
    readable = false;
  }
  if (readable) {
    chmodSync(file, mode);
    engine.stop();
    t.skip('this user can read a file with no permissions (root, or a file system without modes)');
    return;
  }
  try {
    await engine.refresh();
    assert.ok(engine.diagnostics().some(item => item.source === 'events' && item.message.includes('EACCES')), 'the failed read is reported');
    assert.equal((await engine.getRunSummary('ws-old')).finishedAt, OLD_LAST, 'the stored summary is returned while the events cannot be read');

    // Three other requested runs push ws-old out of tracking, so its snapshot leaves the cache.
    for (const n of [1, 2, 3]) assert.ok(await engine.getSnapshot(`ws-x${n}`));
  } finally {
    chmodSync(file, mode);
    utimesSync(file, mtime, mtime);
  }
  assert.equal(statSync(file).mtimeMs, finishedAt, 'the file time is as before the fault');
  // The next poll lists the untracked run from its file time.
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-old').lastActivityAt, finishedAt, 'the listing shows the new activity');

  assert.equal((await oldItem(engine))[0], finishedAt, 'History shows the current finish time');
  assert.equal((await engine.getRunSummary('ws-old')).finishedAt, finishedAt, 'the same engine rebuilds the run');
  assert.equal(readSummary(stored).finishedAt, finishedAt);
  assert.deepEqual(await oldItem(engine), [finishedAt, 0, true]);
  engine.stop();
});

/**
 * Makes `file` unreadable for this user (mode 000). Returns a function that restores its mode and times, or null, with the
 * mode already restored, when the user can still read it (root, or a file system without modes).
 */
function makeUnreadable(file) {
  const { mode, atime, mtime } = statSync(file);
  const restore = () => {
    chmodSync(file, mode);
    utimesSync(file, atime, mtime);
  };
  chmodSync(file, 0o000);
  try {
    readFileSync(file);
  } catch {
    return restore;
  }
  restore();
  return null;
}

test('a new engine that cannot read a run\'s events leaves its stored summary as it is, and stores the current one once it can', async t => {
  const { home, stored, reopen } = await storedOldRun();
  const finishedAt = OLD_LAST + 19 * MINUTE;
  const later = new EventLog(OLD_LAST + 10 * MINUTE);
  later.turnStart(); later.at(finishedAt); later.turnEnd();
  const file = home.writeEvents('cli-old', later.events, { append: true });
  const before = stat(stored);
  const restore = makeUnreadable(file);
  if (!restore) {
    t.skip('this user can read a file with no permissions (root, or a file system without modes)');
    return;
  }
  const engine = reopen();
  try {
    assert.equal((await engine.getRunSummary('ws-old')).finishedAt, OLD_LAST, 'the stored summary is returned while the events cannot be read');
    await engine.refresh();
    assert.ok(engine.diagnostics().some(item => item.source === 'events' && item.message.includes('EACCES')), 'the failed read is reported');
    assert.deepEqual(stat(stored), before, 'the stored summary is not replaced by one built without the run\'s events');
  } finally {
    restore();
  }
  await engine.refresh();
  assert.deepEqual([readSummary(stored).finishedAt, readSummary(stored).credits], [finishedAt, 1], 'the next complete refresh stores the current summary');
  assert.deepEqual(await oldItem(engine), [finishedAt, 1, true]);
  engine.stop();
});

for (const source of ['data.db', 'session-store.db']) {
  test(`a refresh whose ${source} read fails neither stores nor marks checked a finished run's summary`, async t => {
    const { home, stored, reopen } = await storedOldRun();
    for (const n of [1, 2, 3]) {
      home.workspace({ id: `ws-x${n}`, name: `Extra ${n}`, createdAt: T0 - 20 * DAY + n * MINUTE, sessionId: `cli-x${n}` });
      home.workspace({ id: `ws-x${n}-child`, name: `Extra ${n} child`, createdAt: T0 - 20 * DAY + (n + 5) * MINUTE, sessionId: `cli-x${n}-child`, parentId: `ws-x${n}`, creatorSessionId: `cli-x${n}` });
    }
    const engine = reopen();
    // The run is tracked, and a complete refresh has checked its stored summary.
    assert.ok(await engine.getSnapshot('ws-old'));
    assert.deepEqual(await oldItem(engine), [OLD_LAST, 1, true]);

    // The run works again and finishes later, and the database is replaced by an unreadable copy (a new inode, so no
    // connection held for the old file is reused).
    const finishedAt = OLD_LAST + 19 * MINUTE;
    const later = new EventLog(OLD_LAST + 10 * MINUTE);
    later.turnStart(); later.at(finishedAt); later.turnEnd();
    home.writeEvents('cli-old', later.events, { append: true });
    const db = source === 'data.db' ? home.dataDb : home.storeDb;
    const saved = `${db}.saved`;
    renameSync(db, saved);
    copyFileSync(saved, db);
    const restore = makeUnreadable(db);
    if (!restore) {
      renameSync(saved, db);
      engine.stop();
      t.skip('this user can read a file with no permissions (root, or a file system without modes)');
      return;
    }
    const before = stat(stored);
    try {
      await engine.refresh();
      assert.ok(engine.diagnostics().some(item => item.source === source && item.level === 'warn'), `the failed ${source} read is reported`);
      assert.deepEqual(stat(stored), before, 'the stored summary is not rewritten');

      // Three other requested runs push ws-old out of tracking, so its snapshot leaves the cache, and the next poll lists it
      // from its files. Only a stamp could then keep the older stored summary listed as summarised.
      for (const n of [1, 2, 3]) assert.ok(await engine.getSnapshot(`ws-x${n}`));
      await engine.refresh();
      assert.deepEqual(stat(stored), before);
      assert.deepEqual(await oldItem(engine), [finishedAt, 1, false], 'no stamp was recorded');
    } finally {
      restore();
      renameSync(saved, db);
    }
    // The stale check rebuilds the run, now from sources that all read, and stores the current summary.
    assert.equal((await engine.getRunSummary('ws-old')).finishedAt, finishedAt);
    assert.deepEqual([readSummary(stored).finishedAt, readSummary(stored).credits], [finishedAt, 1]);
    assert.deepEqual(await oldItem(engine), [finishedAt, 1, true]);
    engine.stop();
  });
}

/** A root session that has been quiet for 181 minutes. With background = true it launched a sub-agent that never reported. */
function quietHome({ background }) {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-quiet', projectId: 'project-1', name: 'Quiet story', createdAt: T0, sessionId: 'cli-quiet' });
  home.workspace({ id: 'ws-quiet-unit', projectId: 'project-1', name: 'Quiet q1 unit', createdAt: at(1), sessionId: 'cli-quiet-unit', parentId: 'ws-quiet', creatorSessionId: 'cli-quiet' });
  const unit = new EventLog(at(1));
  unit.start(); unit.turnStart(); unit.wait(MINUTE); unit.turnEnd();
  home.writeEvents('cli-quiet-unit', unit.events);
  home.lock('cli-quiet-unit', NO_SUCH_PID + 10, at(1));
  const root = new EventLog(T0);
  root.start(); root.user('go'); root.turnStart();
  if (background) root.subagent({ name: 'hung', mode: 'background' });
  root.wait(MINUTE); root.turnEnd();
  home.writeEvents('cli-quiet', root.events);
  home.lock('cli-quiet', NO_SUCH_PID + 9, T0);
  return { home, quietAt: T0 + 2 * MINUTE + 181 * MINUTE };
}

function countingProbe(alive) {
  const probe = async locks => {
    probe.calls += 1;
    return new Map(locks.map(lock => [lock.pid, alive]));
  };
  probe.calls = 0;
  return probe;
}

const quietEngine = (home, processProbe, clock) => createSwarmEngine({
  copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: clock, processProbe, prLookup: 'off',
});

test('a quiet run with a hung background sub-agent stays live from a cold start', async () => {
  const { home, quietAt } = quietHome({ background: true });
  const engine = quietEngine(home, countingProbe(true), () => quietAt);
  await engine.refresh();
  assert.deepEqual(engine.listSwarms().map(swarm => [swarm.id, swarm.lifecycle]), [['ws-quiet', 'live']]);
  const snapshot = await engine.getSnapshot('ws-quiet');
  assert.equal(snapshot.run.lifecycle, 'live');
  assert.equal(snapshot.orchestrator.statusDetail, 'stuck_subagent');
});

test('the same quiet run is listed finished when its process is dead, and is not probed again', async () => {
  const { home, quietAt } = quietHome({ background: true });
  const probe = countingProbe(false);
  let clock = quietAt;
  const engine = quietEngine(home, probe, () => clock);
  await engine.refresh();
  assert.deepEqual(engine.listSwarms().map(swarm => [swarm.id, swarm.lifecycle]), [['ws-quiet', 'finished']]);
  const afterFirst = probe.calls;
  assert.ok(afterFirst >= 1);
  clock += MINUTE;
  await engine.refresh();
  assert.equal(probe.calls, afterFirst);
  assert.equal(engine.listSwarms()[0].lifecycle, 'finished');
});

test('a quiet run with a live process and nothing busy or stuck is finished, and is not probed or rebuilt again', async () => {
  const { home, quietAt } = quietHome({ background: false });
  const probe = countingProbe(true);
  let clock = quietAt;
  const engine = quietEngine(home, probe, () => clock);
  await engine.refresh();
  assert.ok(probe.calls >= 1, 'the first refresh checks for live processes');
  assert.deepEqual(engine.listSwarms().map(swarm => [swarm.id, swarm.lifecycle]), [['ws-quiet', 'finished']]);
  const afterFirst = probe.calls;
  clock += MINUTE;
  await engine.refresh();
  assert.equal(probe.calls, afterFirst, 'neither the listing nor a rebuild probes again');
  assert.equal(engine.listSwarms()[0].lifecycle, 'finished');
});

test('a run summary counts every sub-agent of the run, though each session lists at most 500', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-many', projectId: 'project-1', name: 'Many story', createdAt: T0, sessionId: 'cli-many' });
  home.workspace({ id: 'ws-many-unit', projectId: 'project-1', name: 'Many m1 unit', createdAt: at(1), sessionId: 'cli-many-unit', parentId: 'ws-many', creatorSessionId: 'cli-many' });
  const root = new EventLog(T0);
  root.start(); root.turnStart();
  const usage = [];
  for (let i = 0; i < 600; i += 1) {
    const call = root.subagent({ mode: 'sync', type: i % 3 ? 'explore' : 'code-review' });
    root.wait(1000);
    root.subagentDone(call, { durationMs: 1000 });
    root.done(call);
    usage.push({ sessionId: 'cli-many', parentToolCallId: call, nanoAiu: 1e9, createdAt: T0 + MINUTE });
  }
  root.turnEnd();
  home.writeEvents('cli-many', root.events);
  const unit = new EventLog(at(1));
  unit.start(); unit.turnStart(); unit.wait(MINUTE); unit.turnEnd();
  home.writeEvents('cli-many-unit', unit.events);
  home.usage(usage);
  home.lock('cli-many', NO_SUCH_PID + 20, T0);
  home.lock('cli-many-unit', NO_SUCH_PID + 21, at(1));
  const engine = quietEngine(home, countingProbe(false), () => at(500));
  const summary = await engine.getRunSummary('ws-many');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(summary.subagents, 600);
  assert.deepEqual(summary.subagentTypes.map(entry => [entry.type, entry.runs, entry.credits, entry.durationMs]).sort(), [['code-review', 200, 200, 200_000], ['explore', 400, 400, 400_000]]);
  const snapshot = await engine.getSnapshot('ws-many');
  assert.equal(snapshot.orchestrator.subagents.length, 500);
  assert.equal(snapshot.cost.credits, 600);
});

test('a run summary includes the runtime of sub-agents that were evicted while running', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-bg', projectId: 'project-1', name: 'Background story', createdAt: T0, sessionId: 'cli-bg' });
  home.workspace({ id: 'ws-bg-unit', projectId: 'project-1', name: 'Background b1 unit', createdAt: at(1), sessionId: 'cli-bg-unit', parentId: 'ws-bg', creatorSessionId: 'cli-bg' });
  const root = new EventLog(T0);
  root.start(); root.turnStart();
  const calls = [];
  for (let i = 0; i < 510; i += 1) calls.push(root.subagent({ mode: 'background', type: 'explore' }));
  root.wait(2000);
  for (const call of calls) root.subagentDone(call, { durationMs: 1000 });
  root.turnEnd();
  home.writeEvents('cli-bg', root.events);
  const unit = new EventLog(at(1));
  unit.start(); unit.turnStart(); unit.wait(MINUTE); unit.turnEnd();
  home.writeEvents('cli-bg-unit', unit.events);
  home.lock('cli-bg', NO_SUCH_PID + 30, T0);
  home.lock('cli-bg-unit', NO_SUCH_PID + 31, at(1));
  const engine = quietEngine(home, countingProbe(false), () => at(500));
  const summary = await engine.getRunSummary('ws-bg');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(summary.subagents, 510);
  assert.deepEqual(summary.subagentTypes.map(entry => [entry.type, entry.runs, entry.durationMs]), [['explore', 510, 510_000]]);
  assert.equal((await engine.getSnapshot('ws-bg')).orchestrator.subagents.length, 500);
});

test('log lines over the size limit are skipped with a warning, and a recoverable one is still applied', async () => {
  const home = scenario();
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  await engine.getSnapshot('ws-root');
  assert.ok(engine.diagnostics().every(item => item.source !== 'events'));
  assert.notEqual((await engine.getSnapshot('ws-root')).units.find(unit => unit.id === 'ws-ui').statusDetail, 'busy');
  const file = path.join(home.dir('cli-ui'), 'events.jsonl');
  const filler = 'x'.repeat(17 * 1024 * 1024);
  const working = new EventLog(at(61));
  working.turnStart();
  const call = working.tool('bash', { command: 'npm test' });
  home.writeEvents('cli-ui', working.events, { append: true });
  appendFileSync(file, `${filler}\n`);
  const done = JSON.stringify({ data: { toolCallId: call, filler, success: true }, id: 'ev-big', timestamp: new Date(at(79)).toISOString(), type: 'tool.execution_complete' });
  appendFileSync(file, `${done}\n`);
  clock = at(80);
  await engine.refresh();
  const warning = engine.diagnostics().find(item => item.source === 'events');
  assert.equal(warning.level, 'warn');
  assert.equal(warning.message, 'cli-ui: 2 log lines over the size limit were not read in full; 1 was applied from its type and ids.');
  assert.equal((await engine.getSnapshot('ws-root')).units.find(unit => unit.id === 'ws-ui').statusDetail, 'busy');
});

test('an oversized line of a prototype-named type does not hide the turn end after it in the same chunk', async () => {
  const home = scenario();
  const clock = at(80);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  const file = path.join(home.dir('cli-ui'), 'events.jsonl');
  const working = new EventLog(at(61));
  working.turnStart();
  home.writeEvents('cli-ui', working.events, { append: true });
  const odd = JSON.stringify({ type: 'constructor', timestamp: new Date(at(70)).toISOString(), filler: 'x'.repeat(17 * 1024 * 1024) });
  appendFileSync(file, `${odd}\n`);
  const ending = new EventLog(at(75));
  ending.turnEnd();
  appendFileSync(file, ending.lines());
  await engine.refresh();
  const snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.notEqual(snapshot.units.find(unit => unit.id === 'ws-ui').statusDetail, 'busy');
  const events = engine.diagnostics().filter(item => item.source === 'events');
  assert.deepEqual(events.map(item => item.message), ['cli-ui: 1 log line over the size limit was not read in full; 1 was applied from its type and ids.']);
});

/** Opens a writer on data.db that holds an uncheckpointed rename of the root workspace in the -wal. */
function holdUncheckpointedRename(home) {
  const writer = openWriter(home.dataDb);
  writer.exec("PRAGMA wal_autocheckpoint = 0; UPDATE workspaces SET name = 'Renamed in the WAL' WHERE id = 'ws-root';");
  return writer;
}

test('data.db with log data but no shared-memory file keeps the last good data and warns', { skip: !canWriteWithNode }, async () => {
  const home = scenario();
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-root').name, 'Sample story');
  const aside = tempDir('swarm-aside-');
  const writer = holdUncheckpointedRename(home);
  copyFileSync(home.dataDb, path.join(aside, 'data.db'));
  copyFileSync(`${home.dataDb}-wal`, path.join(aside, 'data.db-wal'));
  writer.close();
  for (const suffix of ['-wal', '-shm']) rmSync(`${home.dataDb}${suffix}`, { force: true });
  copyFileSync(path.join(aside, 'data.db'), home.dataDb);
  copyFileSync(path.join(aside, 'data.db-wal'), `${home.dataDb}-wal`);
  clock = at(61);
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-root').name, 'Sample story');
  const warning = engine.diagnostics().find(item => item.source === 'data.db');
  assert.equal(warning.level, 'warn');
  assert.equal(warning.message, 'data.db: its write-ahead log has data but no shared-memory file, so it cannot be read safely now.');
  assert.equal(existsSync(`${home.dataDb}-shm`), false);
});

test('a locked session.db keeps the last good todos with a warning, and the next refresh reads it again', { skip: !canWriteWithNode }, async () => {
  const home = scenario();
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  const progress = async () => (await engine.getSnapshot('ws-root')).units.find(unit => unit.label === 'a1').progress;
  const warnings = () => engine.diagnostics().filter(item => item.source === 'session.db');
  assert.deepEqual(await progress(), { done: 1, total: 2 });
  const file = path.join(home.stateDir, 'cli-api', 'session.db');
  // A writer in another process holds an exclusive lock while the file's stamps change, so the next read fails as busy.
  const lock = await holdExclusiveLock(file);
  try {
    utimesSync(file, new Date(), new Date(Date.now() + 9000));
    await engine.refresh();
    assert.deepEqual(await progress(), { done: 1, total: 2 });
    assert.equal(warnings().length, 1);
    assert.equal(warnings()[0].level, 'warn');
    assert.match(warnings()[0].message, /^cli-api: session\.db tables: .*database is locked/);
  } finally {
    await lock.release();
  }
  await engine.refresh();
  assert.deepEqual(await progress(), { done: 1, total: 2 });
  assert.deepEqual(warnings(), []);
});

test('a session.db children table of another shape is ignored with a note, and the session keeps its todo progress', async () => {
  const home = scenario();
  // Another orchestrator version's registry: a table named children without the data-contract columns.
  execSql(path.join(home.stateDir, 'cli-api', 'session.db'), "CREATE TABLE children (name TEXT, status TEXT, session_id TEXT); INSERT INTO children VALUES ('api', 'running', 'ws-123')");
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  const snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(snapshot.units.find(unit => unit.label === 'a1').progress, { done: 1, total: 2 });
  const notes = () => engine.diagnostics().filter(item => item.source === 'session.db');
  const expected = [{ level: 'info', source: 'session.db', message: 'cli-api: its children table is not in the data-contract format, so it is ignored' }];
  assert.deepEqual(notes(), expected);
  await engine.refresh();
  assert.deepEqual(notes(), expected, 'the note shows on every refresh while the file is unchanged');
});

test('stop() closes the reader connections, so a closing writer can remove its side files', { skip: !canWriteWithNode }, async () => {
  const kept = scenario();
  const engine = createSwarmEngine({ copilotHome: kept.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  let writer = holdUncheckpointedRename(kept);
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-root').name, 'Renamed in the WAL');
  writer.close();
  assert.equal(existsSync(`${kept.dataDb}-shm`), true, 'the engine connection keeps the side files while it is open');
  engine.stop();
  const reopened = openWriter(kept.dataDb);
  reopened.exec("UPDATE workspaces SET name = 'Renamed again' WHERE id = 'ws-root';");
  await engine.refresh();
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-root').name, 'Renamed again', 'a read after stop() really reads');
  reopened.close();
  assert.equal(existsSync(`${kept.dataDb}-shm`), true, 'the reopened connection keeps the side files');
  engine.stop();
  const last = openWriter(kept.dataDb);
  last.exec('SELECT count(*) FROM workspaces');
  last.close();
  assert.equal(existsSync(`${kept.dataDb}-shm`), false, 'a second stop() closes it again');
  assert.equal(existsSync(`${kept.dataDb}-wal`), false);

  const stopped = scenario();
  const second = createSwarmEngine({ copilotHome: stopped.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  writer = holdUncheckpointedRename(stopped);
  await second.refresh();
  second.stop();
  writer.close();
  assert.equal(existsSync(`${stopped.dataDb}-shm`), false);
  assert.equal(existsSync(`${stopped.dataDb}-wal`), false);
});

test('stop() during a refresh in flight closes the connections that refresh opens', { skip: !canWriteWithNode }, async () => {
  const home = scenario();
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  const writer = holdUncheckpointedRename(home);
  const settled = engine.refresh();
  engine.stop();
  await settled;
  assert.equal(engine.listSwarms().find(swarm => swarm.id === 'ws-root').name, 'Renamed in the WAL');
  writer.close();
  assert.equal(existsSync(`${home.dataDb}-shm`), false, 'no connection was left open');
  assert.equal(existsSync(`${home.dataDb}-wal`), false);
});

test('start() after stop() during a refresh keeps the connections', { skip: !canWriteWithNode }, async () => {
  const home = scenario();
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => at(60), processProbe: alwaysAlive, prLookup: 'off' });
  const writer = holdUncheckpointedRename(home);
  const settled = engine.refresh();
  engine.stop();
  engine.start({ intervalMs: 3_600_000 });
  await settled;
  await sleep(20);
  writer.close();
  assert.equal(existsSync(`${home.dataDb}-shm`), true, 'the restarted engine still holds its connection');
  engine.stop();
});

test('only the root orchestrator\'s sessions follow sub-agents in detail, and a session that stops being a root is read again from its start', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root' });
  home.workspace({ id: 'ws-kid', projectId: 'project-1', name: 'Sample k1 kid', createdAt: at(1), sessionId: 'cli-kid', parentId: 'ws-root', creatorSessionId: 'cli-root' });
  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.wait(MINUTE);
  root.subagent({ name: 'scout', type: 'explore', mode: 'background' });
  home.writeEvents('cli-root', root.events);
  const kid = new EventLog(at(1));
  kid.calls = 100;
  kid.start(); kid.turnStart(); kid.wait(MINUTE);
  kid.subagent({ name: 'peeker', type: 'explore', mode: 'background' });
  home.writeEvents('cli-kid', kid.events);
  let clock = at(10);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  const texts = view => view.recent.map(item => item.text);

  let snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(texts(snapshot.orchestrator), [], 'a root session keeps its one-off sub-agents out of the session feed');
  assert.deepEqual(texts(snapshot.units[0]), ['started explore: peeker'], 'a child session keeps its sub-agents as feed items');
  assert.equal(snapshot.feed.some(item => item.text.includes('scout') && item.unitId === 'ws-root'), false);
  assert.deepEqual(snapshot.feed.filter(item => item.text.includes('scout')).map(item => [item.unitId === snapshot.units.find(unit => unit.kind === 'subagent').id, item.label]), [[true, 'scout']], 'the item belongs to the sub-agent\'s own unit');

  home.workspace({ id: 'ws-top', projectId: 'project-1', name: 'Top story', createdAt: T0 - 5 * MINUTE, sessionId: 'cli-top' });
  home.insert(home.dataDb, 'workspace_parent_links', { child_workspace_id: 'ws-root', parent_workspace_id: 'ws-top', creator_session_id: 'cli-top', created_at: new Date(T0).toISOString() });
  const top = new EventLog(T0 - 5 * MINUTE);
  top.start(); top.turnStart(); top.wait(MINUTE); top.turnEnd();
  home.writeEvents('cli-top', top.events);
  clock = at(11);
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-top');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.units.map(unit => [unit.id, unit.depth]), [['ws-root', 1], ['ws-kid', 2]]);
  assert.deepEqual(texts(snapshot.units[0]), ['started explore: scout'], 'the session was read again from its start without the flag');
  assert.deepEqual(texts(snapshot.orchestrator), []);
  assert.equal((await engine.getRunSummary('ws-top')).subagents, 2, 'the counters were reset, not added twice');
});

test('a background sub-agent of the root orchestrator is a unit: busy, done with its final answer, then busy again after a follow-up', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root' });
  home.workspace({ id: 'ws-kid', projectId: 'project-1', name: 'Sample k1 kid', createdAt: at(1), sessionId: 'cli-kid', parentId: 'ws-root', creatorSessionId: 'cli-root' });
  const root = new EventLog(T0);
  root.start(); root.at(at(1));
  const call = root.subagent({ name: 'scout', type: 'explore', mode: 'background', agentId: 'ag-scout' });
  root.at(at(2)); root.sub(call, 'assistant.message', { content: 'Working' });
  home.writeEvents('cli-root', root.events);
  const kid = new EventLog(at(1));
  kid.calls = 100;
  kid.start(); kid.turnStart(); kid.wait(MINUTE);
  kid.subagent({ name: 'peeker', type: 'explore', mode: 'background', agentId: 'ag-peeker' });
  home.writeEvents('cli-kid', kid.events);
  home.lock('cli-root', NO_SUCH_PID + 30, T0);
  home.lock('cli-kid', NO_SUCH_PID + 31, at(1));
  let clock = at(3);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  const scoutUnit = async () => {
    const snapshot = await engine.getSnapshot('ws-root');
    assert.deepEqual(validateSnapshot(snapshot), []);
    assert.deepEqual(snapshot.units.map(unit => [unit.kind, unit.label]), [['project', 'k1'], ['subagent', 'scout']], 'the child session\'s sub-agent stays a chip');
    return snapshot.units[1];
  };

  let unit = await scoutUnit();
  assert.equal(unit.id, call);
  assert.deepEqual([unit.status, unit.statusDetail, unit.startedAt, unit.endedAt, unit.alive], ['busy', 'busy', at(1), null, true]);
  assert.deepEqual([unit.report.status, unit.report.title], ['progress', 'Working']);

  const finished = new EventLog(at(4));
  finished.count = 1000;
  finished.sub(call, 'assistant.message', { content: 'Final answer' });
  finished.subagentDone(call, { durationMs: 3 * MINUTE, agentId: 'ag-scout' });
  home.writeEvents('cli-root', finished.events, { append: true });
  clock = at(5);
  await engine.refresh();
  unit = await scoutUnit();
  assert.deepEqual([unit.status, unit.statusDetail, unit.bucket, unit.endedAt, unit.since], ['done', 'completed', 'done', at(4), at(4)]);
  assert.deepEqual([unit.report.status, unit.report.title, unit.report.source], ['complete', 'Final answer', 'message']);

  const again = new EventLog(at(6));
  again.count = 2000;
  again.toAgent('ag-scout', 'one more thing');
  home.writeEvents('cli-root', again.events, { append: true });
  clock = at(7);
  await engine.refresh();
  unit = await scoutUnit();
  assert.deepEqual([unit.status, unit.statusDetail, unit.endedAt, unit.since], ['busy', 'busy', null, at(6)]);
  assert.equal(unit.report.title, 'Final answer');
  assert.deepEqual(unit.recent.map(item => item.text), ['resumed explore: scout', 'completed explore: scout', 'started explore: scout']);
});

test('a sub-agent unit keeps its label across refreshes when a session\'s derived label would otherwise collide with it', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root' });
  home.workspace({ id: 'ws-kid', projectId: 'project-1', name: 'Sample q9 kid', createdAt: at(1), sessionId: 'cli-kid', parentId: 'ws-root', creatorSessionId: 'cli-root' });
  const root = new EventLog(T0);
  root.start(); root.at(at(1));
  const call = root.subagent({ name: 'a1', type: 'explore', mode: 'background', agentId: 'ag-a1' });
  home.writeEvents('cli-root', root.events);
  const kid = new EventLog(at(1));
  kid.start(); kid.turnStart();
  home.writeEvents('cli-kid', kid.events);
  home.lock('cli-root', NO_SUCH_PID + 40, T0);
  home.lock('cli-kid', NO_SUCH_PID + 41, at(1));
  let clock = at(3);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });
  const labels = snapshot => Object.fromEntries(snapshot.units.map(unit => [unit.id, unit.label]));
  let snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual([labels(snapshot)[call], labels(snapshot)['ws-kid']], ['a1', 'q9']);

  home.workspace({ id: 'ws-new', projectId: 'project-1', name: 'Sample a1 new', createdAt: at(4), sessionId: 'cli-new', parentId: 'ws-root', creatorSessionId: 'cli-root' });
  const fresh = new EventLog(at(4));
  fresh.start(); fresh.turnStart();
  home.writeEvents('cli-new', fresh.events);
  home.lock('cli-new', NO_SUCH_PID + 42, at(4));
  clock = at(5);
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual([labels(snapshot)[call], labels(snapshot)['ws-kid'], labels(snapshot)['ws-new']], ['a1', 'q9', 'a1-2'], 'the task keeps its label; the new session takes the suffix');
});
