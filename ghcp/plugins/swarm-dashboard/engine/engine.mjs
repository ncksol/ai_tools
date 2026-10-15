import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { copilotPaths, resolveThresholds } from './config.mjs';
import { CREDIT_USD, NANO_AIU_PER_CREDIT } from './schema.mjs';
import { SqliteUnavailableError, createSqliteReader, loadNodeSqlite } from './sqlite.mjs';
import { readAppDb } from './readers/app-db.mjs';
import { createTail, readNewLines } from './readers/events.mjs';
import { createLedger, pullLedger } from './readers/ledger.mjs';
import { createProcessProbe } from './readers/process-probe.mjs';
import { createSessionDbCache, listLocks, readWorkspaceYaml } from './readers/session-files.mjs';
import { buildForest, resolveNodeId, treeNodes } from './model/forest.mjs';
import { createHistoryStore, listItemOf, summarizeRun } from './model/history.mjs';
import { createPrLookup } from './model/pr-lookup.mjs';
import { applyLine, createSessionState } from './model/session-state.mjs';
import { buildSnapshot } from './model/swarm.mjs';

const LIVENESS_TTL_MS = 15_000;
const EXTRA_TRACKED = 3;
const round1 = value => Math.round(value * 10) / 10;
const shortId = id => String(id).slice(0, 8);

function emptyApp() {
  return { projects: new Map(), worktrees: new Map(), workspaces: new Map(), parentLinks: [], aliases: [], chatLinks: [], sessions: new Map(), automations: [], diagnostics: [] };
}

function sqliteProblem(source, error) {
  return {
    level: 'warn',
    source,
    message: error instanceof SqliteUnavailableError
      ? 'No SQLite reader: use Node.js 22.15 or later, or install the sqlite3 command-line tool.'
      : error.message,
  };
}

/** Digest of a run summary without its computedAt, so a rewrite happens only when something else changed. */
function summaryDigest(summary) {
  return createHash('sha1').update(JSON.stringify({ ...summary, computedAt: 0 })).digest('hex');
}

function digest(snapshot) {
  return createHash('sha1').update(JSON.stringify({ ...snapshot, generatedAt: 0, revision: 0 })).digest('hex');
}

async function mtimeOf(file) {
  try {
    return Math.round((await stat(file)).mtimeMs);
  } catch {
    return null;
  }
}

const byLifecycleThenActivity = (a, b) => (a.lifecycle === b.lifecycle ? b.lastActivityAt - a.lastActivityAt : a.lifecycle === 'live' ? -1 : 1);

/**
 * The swarm data engine. Strictly read-only towards Copilot data; its only write target is the history folder.
 * @param {import('./schema.mjs').EngineOptions & { processProbe?: (locks: {pid: number, mtimeMs: number}[]) => Promise<Map<number, boolean>> }} options
 * @returns {import('./schema.mjs').SwarmEngine}
 */
export function createSwarmEngine(options = {}) {
  const paths = copilotPaths(options.copilotHome);
  const persist = options.persistHistory ?? true;
  const now = options.now ?? Date.now;
  const thresholds = resolveThresholds(options.thresholds);
  const sqlite = { backend: options.sqlite ?? 'auto' };
  const reader = createSqliteReader(sqlite);
  const log = item => {
    try {
      if (typeof options.log === 'function') options.log(item);
    } catch {
      // a failing logger must not break polling
    }
  };
  const probe = options.processProbe ?? createProcessProbe();
  const lookup = options.prLookup === 'off' ? null
    : options.prLookup && typeof options.prLookup === 'object' ? options.prLookup : createPrLookup({ now });
  const history = createHistoryStore(options.historyDir ?? paths.historyDir);
  const ledger = createLedger();
  const readDb = createSessionDbCache();
  const sessions = new Map();
  const liveness = new Map();
  const snapshots = new Map();
  const revisions = new Map();
  const cheapLast = new Map();
  const knownFinished = new Map();
  const summaryDigests = new Map();
  const pendingRoots = new Set();
  const requested = [];
  const listeners = new Set();
  let app = null;
  let forest = null;
  let swarms = [];
  let diagnostics = [];
  let revision = 0;
  let timer = null;
  let generation = 0;
  let running = null;

  const projectOf = node => {
    const project = node.projectId ? app.projects.get(node.projectId) : null;
    return project ? { id: project.id, name: project.name } : null;
  };

  function notify(change) {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        log({ level: 'warn', source: 'subscriber', message: error.message });
      }
    }
  }

  async function livenessOf(cliId, at) {
    const cached = liveness.get(cliId);
    if (cached && at - cached.checkedAt < LIVENESS_TTL_MS) return cached.value;
    const locks = listLocks(path.join(paths.stateDir, cliId));
    let value = null;
    if (locks && !locks.length) value = false;
    if (locks && locks.length) {
      try {
        value = [...(await probe(locks)).values()].some(Boolean);
      } catch {
        value = null;
      }
    }
    liveness.set(cliId, { value, checkedAt: at });
    return value;
  }

  async function listRoot(root, at) {
    const nodes = treeNodes(forest, root.id);
    const cliIds = [...new Set(nodes.flatMap(node => node.cliSessionIds))];
    let last = root.createdAt ?? 0;
    for (const cliId of cliIds) last = Math.max(last, (await mtimeOf(path.join(paths.stateDir, cliId, 'events.jsonl'))) ?? 0);
    const totals = ledger.sumFor(cliIds);
    last = Math.max(last, totals.lastAt ?? 0);
    cheapLast.set(root.id, last);
    const recent = at - last < thresholds.runFinishedAfterMs;
    const entry = snapshots.get(root.id);
    const tracked = entry && entry.last === last ? entry.snapshot : null;
    // Design call 12: a run stays Live while anything in it is busy or stuck, so a quiet run is checked for live
    // processes too, unless it is already confirmed finished at this activity time.
    let alive = false;
    let allDead = cliIds.length > 0;
    if (knownFinished.get(root.id) !== last) {
      for (const cliId of cliIds) {
        const value = await livenessOf(cliId, at);
        if (value === true) {
          alive = true;
          break;
        }
        if (value !== false) allDead = false;
      }
    }
    if (!tracked && !recent && !alive && allDead) knownFinished.set(root.id, last);
    const lifecycle = tracked ? tracked.run.lifecycle
      : knownFinished.get(root.id) === last ? 'finished'
        : recent || alive ? 'live' : 'finished';
    const lastActivityAt = tracked?.run.lastActivityAt ?? (last || at);
    return {
      id: root.id, name: root.name ?? '', project: projectOf(root), startedAt: root.createdAt || lastActivityAt, lastActivityAt,
      lifecycle, units: nodes.length - 1, credits: round1(totals.nanoAiu / NANO_AIU_PER_CREDIT), alive,
    };
  }

  async function listRoots(at, diag) {
    const items = [];
    for (const root of forest.roots) {
      try {
        items.push(await listRoot(root, at));
      } catch (error) {
        diag.push({ level: 'warn', source: 'swarms', message: `${shortId(root.id)}: ${error.message}` });
      }
    }
    return items.sort(byLifecycleThenActivity);
  }

  async function tailSession(cliId, diag) {
    let entry = sessions.get(cliId);
    if (!entry) {
      entry = { tail: createTail(path.join(paths.stateDir, cliId, 'events.jsonl')), state: createSessionState(cliId), missing: true, skipped: 0 };
      sessions.set(cliId, entry);
    }
    try {
      const result = await readNewLines(entry.tail, line => applyLine(entry.state, line), {
        onReset: () => {
          entry.state = createSessionState(cliId);
          entry.skipped = 0;
        },
      });
      entry.missing = result.missing;
      entry.skipped += result.skipped ?? 0;
    } catch (error) {
      diag.push({ level: 'warn', source: 'events', message: `${shortId(cliId)}: ${error.message}` });
    }
    if (entry.skipped) {
      diag.push({ level: 'warn', source: 'events', message: `${shortId(cliId)}: skipped ${entry.skipped} log line${entry.skipped === 1 ? '' : 's'} over the size limit.` });
    }
    return entry.missing ? null : entry.state;
  }

  async function buildTracked(rootId, at, diag, dbFiles) {
    const nodes = treeNodes(forest, rootId);
    const states = new Map();
    const alive = new Map();
    const workspaceFiles = new Map();
    for (const cliId of new Set(nodes.flatMap(node => node.cliSessionIds))) {
      const state = await tailSession(cliId, diag);
      if (state) states.set(cliId, state);
      alive.set(cliId, await livenessOf(cliId, at));
      workspaceFiles.set(cliId, readWorkspaceYaml(path.join(paths.stateDir, cliId)));
    }
    const sessionDbs = new Map();
    for (const cliId of new Set([...nodes[0].cliSessionIds, ...nodes.map(node => node.currentCliSessionId).filter(Boolean)])) {
      const dbFile = path.join(paths.stateDir, cliId, 'session.db');
      dbFiles.add(dbFile);
      try {
        sessionDbs.set(cliId, await readDb(dbFile, reader));
      } catch (error) {
        const lastGood = readDb.last(dbFile);
        if (lastGood) sessionDbs.set(cliId, lastGood);
        diag.push({ level: 'warn', source: 'session.db', message: `${shortId(cliId)}: ${error.message}` });
      }
    }
    let sawPending = false;
    const snapshot = buildSnapshot({
      forest, rootId, app, states, alive, workspaceFiles, ledger, sessionDbs, now: at, thresholds, revision: 0, diagnostics: [...diag],
      prInfo: (pr, { cwd }) => {
        if (!lookup) return null;
        lookup.request(pr, { cwd });
        if (lookup.pending?.(pr)) sawPending = true;
        return lookup.get(pr);
      },
    });
    if (sawPending) pendingRoots.add(rootId);
    else pendingRoots.delete(rootId);
    return snapshot;
  }

  /** Writes the run's summary when it differs from the last one stored or read, apart from computedAt. */
  async function writeSummary(snapshot) {
    const id = snapshot.run.id;
    const fresh = summarizeRun(snapshot, { computedAt: 0 });
    const key = summaryDigest(fresh);
    let known = summaryDigests.get(id);
    if (known === undefined) {
      const stored = await history.get(id);
      known = stored ? summaryDigest(stored) : null;
      if (known !== null) summaryDigests.set(id, known);
    }
    if (known === key) return;
    await history.put({ ...fresh, computedAt: now() });
    summaryDigests.set(id, key);
  }

  async function persistFinished(snapshot, diag) {
    if (!persist) return;
    try {
      await writeSummary(snapshot);
    } catch (error) {
      diag.push({ level: 'warn', source: 'history', message: error.message });
    }
  }

  async function doRefresh() {
    const at = now();
    const diag = [];
    if (sqlite.backend === 'auto') {
      diag.push({ level: 'info', source: 'sqlite', message: (await loadNodeSqlite()) ? 'Reading SQLite through node:sqlite.' : 'Reading SQLite through the sqlite3 command-line tool.' });
    }
    try {
      const data = await reader.read(paths.dataDb, readAppDb);
      if (data) {
        app = data;
        diag.push(...data.diagnostics);
      } else {
        app = app ?? emptyApp();
        diag.push({ level: 'warn', source: 'data.db', message: 'The Copilot app database was not found.' });
      }
    } catch (error) {
      app = app ?? emptyApp();
      diag.push(sqliteProblem('data.db', error));
    }
    try {
      forest = buildForest(app);
    } catch (error) {
      forest = forest ?? buildForest(emptyApp());
      diag.push({ level: 'warn', source: 'forest', message: error.message });
    }
    try {
      const pulled = await reader.read(paths.storeDb, db => pullLedger(db, ledger));
      if (pulled === null) diag.push({ level: 'warn', source: 'session-store.db', message: 'The Copilot session store was not found, so costs are unknown.' });
    } catch (error) {
      diag.push(sqliteProblem('session-store.db', error));
    }
    for (const failure of lookup?.errors() ?? []) diag.push({ level: 'info', source: 'pr-lookup', message: `${failure.key}: ${failure.error}` });

    swarms = await listRoots(at, diag);
    const rootIds = new Set(forest.roots.map(root => root.id));
    const tracked = new Set([
      ...swarms.filter(swarm => swarm.lifecycle === 'live').map(swarm => swarm.id),
      ...requested.filter(id => rootIds.has(id)),
      ...[...pendingRoots].filter(id => rootIds.has(id)),
    ]);
    const changed = [];
    const failed = new Set();
    const dbFiles = new Set();
    for (const rootId of tracked) {
      try {
        const snapshot = await buildTracked(rootId, at, diag, dbFiles);
        const hash = digest(snapshot);
        const entry = snapshots.get(rootId);
        if (entry && entry.hash === hash) {
          snapshot.revision = entry.revision;
          entry.snapshot = snapshot;
          entry.last = cheapLast.get(rootId);
        } else {
          snapshot.revision = (entry?.revision ?? revisions.get(rootId) ?? 0) + 1;
          snapshots.set(rootId, { snapshot, hash, revision: snapshot.revision, last: cheapLast.get(rootId) });
          revisions.set(rootId, snapshot.revision);
          changed.push(rootId);
        }
        if (snapshot.run.lifecycle === 'finished') {
          knownFinished.set(rootId, cheapLast.get(rootId));
          await persistFinished(snapshot, diag);
        } else {
          knownFinished.delete(rootId);
        }
      } catch (error) {
        failed.add(rootId);
        diag.push({ level: 'warn', source: 'snapshot', message: `${shortId(rootId)}: ${error.message}` });
      }
    }
    const keep = new Set();
    for (const rootId of tracked) for (const node of treeNodes(forest, rootId)) for (const cliId of node.cliSessionIds) keep.add(cliId);
    for (const cliId of [...sessions.keys()]) if (!keep.has(cliId)) sessions.delete(cliId);
    for (const rootId of [...snapshots.keys()]) if (!tracked.has(rootId) && !failed.has(rootId)) snapshots.delete(rootId);
    const current = new Set(forest.roots.map(root => root.id));
    for (const rootId of [...revisions.keys()]) if (!current.has(rootId)) revisions.delete(rootId);
    for (const rootId of [...cheapLast.keys()]) if (!current.has(rootId)) cheapLast.delete(rootId);
    for (const rootId of [...knownFinished.keys()]) if (!current.has(rootId)) knownFinished.delete(rootId);
    for (const rootId of [...summaryDigests.keys()]) if (!current.has(rootId)) summaryDigests.delete(rootId);
    for (const rootId of [...pendingRoots]) if (!current.has(rootId)) pendingRoots.delete(rootId);
    for (const [cliId, entry] of [...liveness]) if (at - entry.checkedAt > 4 * LIVENESS_TTL_MS) liveness.delete(cliId);
    readDb.retain(dbFiles);
    reader.retain(new Set([...dbFiles, paths.dataDb, paths.storeDb]));
    swarms = swarms.map(item => {
      const entry = snapshots.get(item.id);
      return entry ? { ...item, lifecycle: entry.snapshot.run.lifecycle, lastActivityAt: entry.snapshot.run.lastActivityAt } : item;
    }).sort(byLifecycleThenActivity);

    const previous = new Set(diagnostics.map(item => `${item.source}|${item.message}`));
    for (const item of diag) if (item.level === 'warn' && !previous.has(`${item.source}|${item.message}`)) log(item);
    diagnostics = diag;
    if (changed.length) {
      revision += 1;
      notify({ revision, swarmIds: changed });
    }
  }

  function refresh() {
    if (!running) running = doRefresh().finally(() => { running = null; });
    return running;
  }

  function track(id) {
    const index = requested.indexOf(id);
    if (index >= 0) requested.splice(index, 1);
    requested.unshift(id);
    if (requested.length > EXTRA_TRACKED) requested.length = EXTRA_TRACKED;
  }

  async function getSnapshot(swarmId) {
    if (!forest) await refresh();
    const id = swarmId ?? swarms[0]?.id ?? null;
    if (!id || !forest.roots.some(root => root.id === id)) return null;
    if (!snapshots.has(id)) {
      track(id);
      await refresh();
      if (!snapshots.has(id)) await refresh();
    }
    return snapshots.get(id)?.snapshot ?? null;
  }

  async function findSwarm(sessionId) {
    if (!forest) await refresh();
    let id = resolveNodeId(forest, sessionId);
    if (!id) return null;
    for (let node = forest.nodes.get(id); node?.parentId; node = forest.nodes.get(node.parentId)) id = node.parentId;
    return forest.roots.some(root => root.id === id) ? id : null;
  }

  async function listHistory() {
    if (!forest) await refresh();
    const items = new Map();
    const live = new Set(swarms.filter(swarm => swarm.lifecycle === 'live').map(swarm => swarm.id));
    for (const summary of await history.list()) if (!live.has(summary.id)) items.set(summary.id, listItemOf(summary));
    for (const { snapshot } of snapshots.values()) {
      if (snapshot.run.lifecycle === 'finished' && !live.has(snapshot.run.id) && !items.has(snapshot.run.id)) {
        items.set(snapshot.run.id, listItemOf(summarizeRun(snapshot, { computedAt: now() })));
      }
    }
    for (const swarm of swarms) {
      if (swarm.lifecycle !== 'finished' || items.has(swarm.id)) continue;
      items.set(swarm.id, {
        id: swarm.id, name: swarm.name, project: swarm.project, startedAt: swarm.startedAt, finishedAt: swarm.lastActivityAt,
        tookMs: Math.max(0, swarm.lastActivityAt - swarm.startedAt), busyMs: null, credits: swarm.credits,
        usd: Math.round(swarm.credits * CREDIT_USD * 100) / 100, children: swarm.units, merged: null, summarized: false,
      });
    }
    return [...items.values()].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  }

  async function getRunSummary(runId) {
    if (!forest) await refresh();
    if (swarms.some(swarm => swarm.id === runId && swarm.lifecycle === 'live')) {
      const current = await getSnapshot(runId);
      if (current?.run.lifecycle === 'live') return summarizeRun(current, { computedAt: now() });
    }
    const stored = await history.get(runId);
    if (stored) {
      summaryDigests.set(runId, summaryDigest(stored));
      return stored;
    }
    const snapshot = await getSnapshot(runId);
    if (!snapshot) return null;
    const persisted = await history.get(runId);
    if (persisted) {
      summaryDigests.set(runId, summaryDigest(persisted));
      return persisted;
    }
    const summary = summarizeRun(snapshot, { computedAt: now() });
    if (persist && snapshot.run.lifecycle === 'finished') {
      try {
        await writeSummary(snapshot);
      } catch (error) {
        log({ level: 'warn', source: 'history', message: error.message });
      }
    }
    return summary;
  }

  return {
    refresh,
    start({ intervalMs = 3000 } = {}) {
      if (timer) return;
      const mine = ++generation;
      const tick = async () => {
        try {
          await refresh();
        } catch (error) {
          log({ level: 'warn', source: 'engine', message: error.message });
        }
        if (mine === generation && timer) timer = setTimeout(tick, intervalMs);
      };
      timer = setTimeout(tick, 0);
    },
    stop() {
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      // An engine dropped without stop() releases its connections when garbage collected (node:sqlite closes a collected database).
      reader.close();
      // A refresh still in flight can reopen connections after this point. Close them again once it settles, unless
      // start() ran in the meantime (it bumps the generation).
      if (running) {
        const mine = generation;
        const closeAgain = () => {
          if (generation === mine) reader.close();
        };
        running.then(closeAgain, closeAgain);
      }
    },
    listSwarms: () => swarms.map(item => ({ ...item })),
    getSnapshot,
    findSwarm,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listHistory,
    getRunSummary,
    diagnostics: () => diagnostics.map(item => ({ ...item })),
  };
}
