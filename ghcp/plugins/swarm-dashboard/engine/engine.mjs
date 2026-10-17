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
import { applyLine, applyRecovered, createSessionState } from './model/session-state.mjs';
import { buildSnapshot } from './model/swarm.mjs';

const LIVENESS_TTL_MS = 15_000;
const EXTRA_TRACKED = 3;
// The listing's activity time comes from file modification times, which on real files run a few milliseconds after the last
// event's timestamp. Without this slack every stored summary would look stale against the listing.
const STALE_SLACK_MS = 60_000;
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

/**
 * True when the run's listing item shows newer activity or more cost than its stored summary, for example when the run
 * resumed and finished again while no engine ran. Both credit values are rounded to 0.1. Lower cost is never stale: a ledger
 * can lose rows when logs are cleaned up, and the stored summary is then kept. A run that is not listed (its logs are gone)
 * keeps its stored summary.
 */
function isStale(stored, swarm) {
  if (!swarm) return false;
  return swarm.credits > stored.credits || swarm.lastActivityAt > stored.finishedAt + STALE_SLACK_MS;
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
 * @param {import('./schema.mjs').EngineOptions & {
 *   processProbe?: (locks: {pid: number, mtimeMs: number}[]) => Promise<Map<number, boolean>>,
 *   historyStore?: ReturnType<typeof createHistoryStore>,
 * }} options `historyStore` is a test seam: the store to use instead of one on `historyDir`.
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
  const history = options.historyStore ?? createHistoryStore(options.historyDir ?? paths.historyDir);
  const ledger = createLedger();
  const readDb = createSessionDbCache();
  const sessions = new Map();
  const liveness = new Map();
  const snapshots = new Map();
  // Per root id: the labels its sub-agent units showed in earlier snapshots (see assignSubagentLabels). Dropped with the root's snapshot.
  const subagentLabels = new Map();
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

  /**
   * `subagentUnits` is true for the CLI sessions of the swarm's root orchestrator. A cached entry that was built with the other
   * value is read again from the start of its log, so its state has the right shape.
   */
  async function tailSession(cliId, diag, subagentUnits = false) {
    let entry = sessions.get(cliId);
    if (entry && entry.subagentUnits !== subagentUnits) {
      sessions.delete(cliId);
      entry = null;
    }
    if (!entry) {
      entry = {
        tail: createTail(path.join(paths.stateDir, cliId, 'events.jsonl')), state: createSessionState(cliId, { subagentUnits }), subagentUnits,
        missing: true, skipped: 0, applied: 0, failed: 0, lastError: '',
      };
      sessions.set(cliId, entry);
    }
    try {
      const result = await readNewLines(entry.tail, line => applyLine(entry.state, line), {
        onReset: () => {
          entry.state = createSessionState(cliId, { subagentUnits });
          entry.skipped = 0;
          entry.applied = 0;
          entry.failed = 0;
          entry.lastError = '';
        },
        // A line over the size limit is not read in full, but its type, ids and time are applied when they can be recovered.
        onOversized: event => {
          applyRecovered(entry.state, event);
          if (event) entry.applied += 1;
        },
      });
      entry.missing = result.missing;
      entry.skipped += result.skipped ?? 0;
      if (result.failed) {
        entry.failed += result.failed;
        entry.lastError = result.lastError;
      }
    } catch (error) {
      diag.push({ level: 'warn', source: 'events', message: `${shortId(cliId)}: ${error.message}` });
    }
    if (entry.skipped) {
      const { skipped, applied } = entry;
      diag.push({
        level: 'warn', source: 'events',
        message: `${shortId(cliId)}: ${skipped} log line${skipped === 1 ? '' : 's'} over the size limit ${skipped === 1 ? 'was' : 'were'} not read in full; `
          + `${applied} ${applied === 1 ? 'was' : 'were'} applied from its type and ids.`,
      });
    }
    if (entry.failed) {
      const { failed, lastError } = entry;
      diag.push({
        level: 'warn', source: 'events',
        message: `${shortId(cliId)}: ${failed} log line${failed === 1 ? '' : 's'} could not be applied and ${failed === 1 ? 'was' : 'were'} skipped (last error: ${lastError}).`,
      });
    }
    return entry.missing ? null : entry.state;
  }

  async function buildTracked(rootId, at, diag, dbFiles) {
    const nodes = treeNodes(forest, rootId);
    const states = new Map();
    const alive = new Map();
    const workspaceFiles = new Map();
    const rootCliIds = new Set(nodes[0].cliSessionIds);
    for (const cliId of new Set(nodes.flatMap(node => node.cliSessionIds))) {
      const state = await tailSession(cliId, diag, rootCliIds.has(cliId));
      if (state) states.set(cliId, state);
      alive.set(cliId, await livenessOf(cliId, at));
      workspaceFiles.set(cliId, readWorkspaceYaml(path.join(paths.stateDir, cliId)));
    }
    const sessionDbs = new Map();
    for (const cliId of new Set([...nodes[0].cliSessionIds, ...nodes.map(node => node.currentCliSessionId).filter(Boolean)])) {
      const dbFile = path.join(paths.stateDir, cliId, 'session.db');
      dbFiles.add(dbFile);
      try {
        const value = await readDb(dbFile, reader);
        sessionDbs.set(cliId, value);
        // A table that is not in the data-contract shape is ignored; the cached value keeps its notes, so they show on every refresh.
        for (const note of value?.notes ?? []) diag.push({ level: 'info', source: 'session.db', message: `${shortId(cliId)}: ${note}` });
      } catch (error) {
        const lastGood = readDb.last(dbFile);
        if (lastGood) sessionDbs.set(cliId, lastGood);
        diag.push({ level: 'warn', source: 'session.db', message: `${shortId(cliId)}: ${error.message}` });
      }
    }
    let sawPending = false;
    if (!subagentLabels.has(rootId)) subagentLabels.set(rootId, new Map());
    const snapshot = buildSnapshot({
      forest, rootId, app, states, alive, workspaceFiles, ledger, sessionDbs, now: at, thresholds, revision: 0, diagnostics: [...diag],
      subagentLabels: subagentLabels.get(rootId),
      prInfo: (pr, { cwd }) => {
        if (!lookup) return null;
        lookup.request(pr, { cwd });
        if (lookup.pending?.(pr, { cwd })) sawPending = true;
        return lookup.get(pr, { cwd });
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
    const dropped = rootId => !tracked.has(rootId) && !failed.has(rootId);
    for (const rootId of [...snapshots.keys()]) if (dropped(rootId)) snapshots.delete(rootId);
    for (const rootId of [...subagentLabels.keys()]) if (dropped(rootId)) subagentLabels.delete(rootId);
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

  /** Resolves once a refresh that started after this call has finished. refresh() alone can return one that started earlier. */
  async function refreshStartedNow() {
    if (running) {
      try {
        await running;
      } catch {
        // that refresh's failure belongs to its own caller; the refresh below reports its own
      }
    }
    await refresh();
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
    const listed = new Map(swarms.map(swarm => [swarm.id, swarm]));
    // A stale stored summary is left out, so the run is listed below from the listing with summarized: false; getRunSummary rebuilds it.
    for (const summary of await history.list()) {
      if (!live.has(summary.id) && !isStale(summary, listed.get(summary.id))) items.set(summary.id, listItemOf(summary));
    }
    for (const { snapshot } of snapshots.values()) {
      if (snapshot.run.lifecycle === 'finished' && !live.has(snapshot.run.id) && !items.has(snapshot.run.id)) {
        const summary = summarizeRun(snapshot, { computedAt: now() });
        // A cached snapshot can be older than the listing (a refresh lists before it rebuilds); the listing item is used then.
        if (!isStale(summary, listed.get(snapshot.run.id))) items.set(snapshot.run.id, listItemOf(summary));
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
    // A stored summary stands unless the listing shows newer activity or cost for the run (see isStale).
    if (stored && !isStale(stored, swarms.find(swarm => swarm.id === runId))) {
      summaryDigests.set(runId, summaryDigest(stored));
      return stored;
    }
    if (!forest.roots.some(root => root.id === runId)) return stored;
    // A cached snapshot can be older than the listing that judged the stored summary stale, so the run is rebuilt by a
    // refresh that starts now. That refresh also stores the summary of a finished run (persistFinished): summaries are written
    // only inside the serialized refresh, never here, so a request cannot overwrite a newer summary.
    track(runId);
    await refreshStartedNow();
    const snapshot = snapshots.get(runId)?.snapshot ?? null;
    if (!snapshot) return stored;
    if (snapshot.run.lifecycle === 'live') return summarizeRun(snapshot, { computedAt: now() });
    const fresh = summarizeRun(snapshot, { computedAt: 0 });
    const persisted = await history.get(runId);
    if (persisted && summaryDigest(persisted) === summaryDigest(fresh)) return persisted;
    return { ...fresh, computedAt: now() };
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
