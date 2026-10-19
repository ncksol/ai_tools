import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSnapshot } from '../engine/model/swarm.mjs';
import { summarizeRun } from '../engine/model/history.mjs';
import { deriveMonitor, deriveStage, prView, resolvePr } from '../engine/model/stage.mjs';
import { evaluateStatus } from '../engine/model/status.mjs';
import { MINUTE } from '../engine/time.mjs';
import { cardUnits } from '../ui/model.mjs';
import { monitorHtml } from '../ui/parts.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

// Regression tests for issue #29, items 1-3: a unit's stage, header count and PR state when it is archived, when the
// PR lookup fails, and when no time is known for the PR.

const T0 = Date.UTC(2026, 9, 17, 18, 0, 0);
const at = minutes => T0 + minutes * MINUTE;
const iso = minutes => new Date(at(minutes)).toISOString();
const text = html => html.replace(/<[^>]+>/g, '');

/**
 * A synthetic top-level swarm. Each unit: { id, archivedAt?, createdPr?, row?: registry fields, log?: (EventLog) => void }.
 * prInfo answers the gh lookup; null means the lookup is unavailable.
 */
function swarm(units, prInfo = () => null) {
  const workspaces = new Map();
  const ws = (id, cli, createdAt, extra = {}) => workspaces.set(id, {
    id, projectId: 'project-1', worktreeId: null, name: id, branch: null, createdAt, archivedAt: extra.archivedAt ?? null,
    sessionId: cli, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: extra.createdPr ?? null,
  });
  ws('ws-root', 'cli-root', T0);
  for (const unit of units) ws(`ws-${unit.id}`, `cli-${unit.id}`, at(5), unit);
  const app = {
    projects: new Map([['project-1', { id: 'project-1', name: 'shop', githubOwner: 'acme', githubRepo: 'shop' }]]),
    worktrees: new Map(),
    workspaces,
    parentLinks: units.map(unit => ({ childId: `ws-${unit.id}`, parentId: 'ws-root' })),
    aliases: [['cli-root', 'ws-root'], ...units.map(unit => [`cli-${unit.id}`, `ws-${unit.id}`])].map(([sessionId, workspaceId]) => ({ sessionId, workspaceId, createdAt: T0 })),
    chatLinks: [],
    sessions: new Map(),
    automations: [],
    diagnostics: [],
  };
  const root = new EventLog(T0);
  root.start();
  root.turnStart();
  root.at(at(2));
  root.turnEnd();
  const states = new Map([['cli-root', fold(root, 'cli-root')]]);
  const alive = new Map([['cli-root', true]]);
  for (const unit of units) {
    const log = new EventLog(at(5));
    log.start();
    log.turnStart();
    unit.log?.(log);
    log.at(at(40));
    log.turnEnd();
    states.set(`cli-${unit.id}`, fold(log, `cli-${unit.id}`));
    alive.set(`cli-${unit.id}`, true);
  }
  const children = units.map(unit => ({
    unit: unit.id, session_id: `ws-${unit.id}`, title: unit.id, todo_id: null, branch: null, base_branch: null,
    pr_provider: null, pr_repo: null, pr_id: null, pr_url: null, outcome: null, created_at: iso(5), updated_at: iso(30), ended_at: null, ...unit.row,
  }));
  return {
    forest: buildForest(app), rootId: 'ws-root', app, ledger: createLedger(),
    states, alive, workspaceFiles: new Map(), sessionDbs: new Map([['cli-root', { todos: [], deps: [], children }]]),
    prInfo, now: at(60), thresholds: DEFAULT_THRESHOLDS, revision: 1, diagnostics: [],
  };
}

const unitOf = (snapshot, label) => snapshot.units.find(unit => unit.label === label);
const githubPr = (id, extra = {}) => ({ pr_provider: 'github', pr_repo: 'acme/shop', pr_id: id, ...extra });

// Item 1: merged units end up under "Archived", and archived failed units count as Done.

test('an archived unit whose PR merged goes under Merged, not Archived', () => {
  assert.equal(deriveStage({ archivedAt: T0, outcome: null, pr: { state: 'merged' } }).stage, 'merged');
  assert.equal(deriveStage({ archivedAt: T0, outcome: 'merged', pr: null }).stage, 'merged');
});

test('an archived unit stays under Archived when nothing better is known', () => {
  assert.equal(deriveStage({ archivedAt: T0, outcome: null, pr: null }).stage, 'archived');
  assert.equal(deriveStage({ archivedAt: T0, outcome: null, pr: { state: 'open' } }).stage, 'archived');
  assert.equal(deriveStage({ archivedAt: T0, outcome: 'closed', pr: { state: 'closed' } }).stage, 'archived');
  assert.equal(deriveStage({ archivedAt: T0, outcome: 'failed', pr: null }).stage, 'archived');
});

test('an archived unit that the registry records as failed counts as failed, not done', () => {
  const evaluate = outcome => evaluateStatus({
    state: null, alive: false, archivedAt: at(50), merged: false, mergedAt: null, outcome, hasRegistry: true, report: null,
    parentRepliedAt: null, monitorDueAt: null, isRunningFlag: false, startedAt: T0, now: at(60), thresholds: DEFAULT_THRESHOLDS,
  }).detail;
  assert.equal(evaluate('failed'), 'failed');
  assert.equal(evaluate('closed'), 'archived');
  assert.equal(evaluate(null), 'archived');
});

test('archived units are placed and counted by their outcome, and the header agrees with History', () => {
  const data = swarm([
    { id: 'fail', archivedAt: at(50), row: { outcome: 'failed', ended_at: iso(45) } },
    { id: 'close', archivedAt: at(50), row: { outcome: 'closed', ended_at: iso(45) } },
    { id: 'merge', archivedAt: at(50), row: githubPr(7) },
  ], pr => (pr.id === 7 ? { state: 'merged', title: 'Merge', openedAt: at(20), mergedAt: at(45), closedAt: at(45), reviewNote: null, url: null, checkedAt: at(55), error: null } : null));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const fail = unitOf(snapshot, 'fail');
  const close = unitOf(snapshot, 'close');
  const merge = unitOf(snapshot, 'merge');
  assert.deepEqual({ stage: fail.stage, bucket: fail.bucket, outcome: fail.outcome }, { stage: 'archived', bucket: 'failed', outcome: 'failed' });
  assert.deepEqual({ stage: close.stage, bucket: close.bucket, outcome: close.outcome }, { stage: 'archived', bucket: 'done', outcome: 'closed' });
  assert.deepEqual({ stage: merge.stage, bucket: merge.bucket, outcome: merge.outcome }, { stage: 'merged', bucket: 'done', outcome: 'merged' });
  assert.equal(snapshot.counts.failed, 1);
  assert.equal(snapshot.counts.done, 2);
  const children = summarizeRun(snapshot, { computedAt: at(60) }).children;
  assert.deepEqual({ merged: children.merged, closed: children.closed, failed: children.failed }, { merged: 1, closed: 1, failed: 1 });
  // Archived units still leave the Cards tab, and an archived failed unit is over: it does not make the swarm stalled.
  assert.deepEqual(cardUnits(snapshot, at(60)), []);
  assert.equal(snapshot.run.stalled, null);
});

// Item 2: a registry PR shows "Not known yet" when the gh lookup fails.

test('the app\'s PR state backs up a registry PR with the same repository and number', () => {
  const identity = resolvePr({ registry: { prProvider: 'github', prId: 8, prRepo: 'acme/shop' } });
  assert.equal(identity.source, 'registry');
  const createdPr = { repo: 'acme/shop', number: 8, url: null, state: 'OPEN', mergedAt: null };
  assert.equal(prView(identity, null, createdPr).state, 'open');
  assert.equal(prView(identity, { state: 'unknown' }, createdPr).state, 'open');
  assert.equal(prView(identity, null, { ...createdPr, repo: 'Acme/Shop' }).state, 'open');
  const merged = prView(identity, null, { ...createdPr, state: 'MERGED', mergedAt: at(30) });
  assert.deepEqual({ state: merged.state, mergedAt: merged.mergedAt }, { state: 'merged', mergedAt: at(30) });
});

test('the app\'s PR state never backs up a PR with a different repository or number', () => {
  const identity = resolvePr({ registry: { prProvider: 'github', prId: 8, prRepo: 'acme/shop' } });
  const createdPr = { repo: 'acme/shop', number: 8, url: null, state: 'OPEN', mergedAt: null };
  assert.equal(prView(identity, null, { ...createdPr, number: 9 }).state, 'unknown');
  assert.equal(prView(identity, null, { ...createdPr, repo: 'acme/other' }).state, 'unknown');
  assert.equal(prView(identity, null, { ...createdPr, repo: null }).state, 'unknown');
  assert.equal(prView({ ...identity, repo: null }, null, createdPr).state, 'unknown');
  const ado = resolvePr({ registry: { prProvider: 'ado', prId: 8, prRepo: 'org/project/shop' } });
  assert.equal(prView(ado, null, createdPr).state, 'unknown');
});

test('the lookup\'s PR state wins over the app\'s, which can lag', () => {
  const identity = resolvePr({ registry: { prProvider: 'github', prId: 8, prRepo: 'acme/shop' } });
  const createdPr = { repo: 'acme/shop', number: 8, url: null, state: 'OPEN', mergedAt: null };
  assert.equal(prView(identity, { state: 'merged', mergedAt: at(40) }, createdPr).state, 'merged');
});

test('a registry PR takes its state from the app\'s record when the lookup fails, only when the record matches', () => {
  const createdPr = repo => ({ repo, number: 8, url: null, state: 'OPEN', mergedAt: null });
  const snapshot = buildSnapshot(swarm([
    { id: 'match', createdPr: createdPr('acme/shop'), row: githubPr(8) },
    { id: 'other', createdPr: createdPr('acme/other'), row: githubPr(8) },
  ]));
  const match = unitOf(snapshot, 'match');
  const other = unitOf(snapshot, 'other');
  assert.deepEqual({ source: match.pr.source, state: match.pr.state, stage: match.stage }, { source: 'registry', state: 'open', stage: 'in_review' });
  assert.deepEqual({ source: other.pr.source, state: other.pr.state, stage: other.stage }, { source: 'registry', state: 'unknown', stage: 'pr_open' });
});

// Item 3: the monitor timer shows "0s" for registry PRs.

test('a registry PR is known from the first status line that names it', () => {
  const registry = { prProvider: 'github', prId: 8, prRepo: 'acme/shop' };
  const statusLines = [{ at: at(30), pr: { provider: 'github', id: 8 } }, { at: at(25), pr: { provider: 'github', id: 9 } }, { at: at(20), pr: { provider: 'github', id: 8 } }];
  assert.equal(resolvePr({ registry, statusLines }).knownAt, at(20));
  assert.equal(resolvePr({ registry, statusLines: [{ at: at(25), pr: { provider: 'github', id: 9 } }] }).knownAt, null);
});

test('a missing monitor with no known start time has no start time, not now', () => {
  const missing = deriveMonitor({ stage: 'in_review', hasPr: true, prKnownAt: null, now: at(60), thresholds: DEFAULT_THRESHOLDS });
  assert.deepEqual({ state: missing.state, since: missing.since, lastCheckAt: missing.lastCheckAt }, { state: 'missing', since: null, lastCheckAt: null });
  assert.equal(deriveMonitor({ stage: 'in_review', hasPr: true, prKnownAt: at(20), now: at(60), thresholds: DEFAULT_THRESHOLDS }).since, at(20));
});

test('a missing monitor with no known start time says so instead of "0s"', () => {
  const unit = { monitor: { state: 'missing', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null } };
  assert.equal(text(monitorHtml(unit, at(60))), 'missing · no check, start time not known');
  assert.equal(text(monitorHtml(unit, at(60), true)), 'missing · no check, start time not known');
});

test('a registry PR\'s monitor counts from a real time, or says that none is known', () => {
  const snapshot = buildSnapshot(swarm([
    { id: 'told', row: githubPr(8), log: log => { log.at(at(20)); log.report('ws-root', 'swarm-status: progress unit=told pr=github:8\nSummary: PR open.', 'progress'); } },
    { id: 'quiet', row: githubPr(9) },
    { id: 'looked', row: githubPr(10) },
  ], pr => (pr.id === 10 ? { state: 'open', title: 'Looked', openedAt: at(25), mergedAt: null, closedAt: null, reviewNote: null, url: null, checkedAt: at(55), error: null } : null)));
  assert.deepEqual(validateSnapshot(snapshot), []);
  const told = unitOf(snapshot, 'told');
  const quiet = unitOf(snapshot, 'quiet');
  const looked = unitOf(snapshot, 'looked');
  assert.deepEqual({ state: told.monitor.state, since: told.monitor.since }, { state: 'missing', since: at(20) });
  assert.equal(text(monitorHtml(told, at(60))), 'missing · no check for 40m');
  assert.deepEqual({ state: quiet.monitor.state, since: quiet.monitor.since }, { state: 'missing', since: null });
  assert.equal(text(monitorHtml(quiet, at(60))), 'missing · no check, start time not known');
  assert.deepEqual({ state: looked.monitor.state, since: looked.monitor.since }, { state: 'missing', since: at(25) });
});
