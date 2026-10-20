import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSnapshot } from '../engine/model/swarm.mjs';
import { deriveStage, prForeignToUnit } from '../engine/model/stage.mjs';
import { MINUTE } from '../engine/time.mjs';
import { closedNotMerged } from '../ui/model.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

// Regression tests for issue #44: on an Azure DevOps host, a bare "PR <n>" in a
// unit's reports is only a heuristic, and the mentioned PR can belong to another
// unit. Before the fix, a foreign PR merged before the unit started made a live
// unit show "Done. PR merged" with a zero runtime, and a unit the registry closed
// showed as merged.

const T0 = Date.UTC(2026, 9, 17, 18, 0, 0);
const at = minutes => T0 + minutes * MINUTE;
const iso = minutes => new Date(at(minutes)).toISOString();

/** A merged ADO PR record; mergedAt picks the merge minute, openedAt one minute before. */
const mergedLookup = mergedAt => pr => (pr.id === 4321 || pr.id === 9999
  ? { state: 'merged', title: `PR ${pr.id}`, openedAt: at(mergedAt - 1), mergedAt: at(mergedAt), closedAt: at(mergedAt), reviewNote: null, url: null, checkedAt: at(60), error: null }
  : null);

/**
 * A synthetic Azure DevOps swarm. Each unit: { id, mention?: PR number in a report, log?: (EventLog) => void,
 * openTurn?: keeps the turn open so the unit is busy, alive?, row?: registry fields }.
 * The units are created at at(5); the "foreign" PR is merged at at(2), before any unit started.
 */
function adoSwarm(units, prInfo) {
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
    chatLinks: [], sessions: new Map(), automations: [], diagnostics: [],
  };
  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.at(at(2)); root.turnEnd();
  const states = new Map([['cli-root', fold(root, 'cli-root')]]);
  const alive = new Map([['cli-root', true]]);
  for (const unit of units) {
    const log = new EventLog(at(5));
    log.start(); log.turnStart();
    if (unit.mention) log.report('ws-root', `Heads up: the api unit's queue has PR #${unit.mention} merged, rebasing on it.`, 'handoff');
    unit.log?.(log);
    if (unit.openTurn) {
      // Keep the turn open and fresh so the unit reads as busy, not stuck.
      log.at(at(56));
      log.done(log.tool('read_file', { path: '/synthetic/worktrees/file' }), { result: 'ok' });
    } else {
      log.at(at(40));
      log.turnEnd();
    }
    states.set(`cli-${unit.id}`, fold(log, `cli-${unit.id}`));
    alive.set(`cli-${unit.id}`, unit.alive ?? true);
  }
  const children = units.map(unit => ({
    unit: unit.id, session_id: `ws-${unit.id}`, title: unit.id, todo_id: null, branch: null, base_branch: null,
    pr_provider: null, pr_repo: null, pr_id: null, pr_url: null, outcome: null,
    created_at: iso(5), updated_at: iso(30), ended_at: null, ...unit.row,
  }));
  const workspaceFiles = new Map([
    ['cli-root', { cwd: '/synthetic/worktrees/root', branch: 'main', hostType: 'ado', repository: 'org/project/repo' }],
    ...units.map(unit => [`cli-${unit.id}`, { cwd: `/synthetic/worktrees/${unit.id}`, branch: `feature/${unit.id}`, hostType: 'ado', repository: 'org/project/repo' }]),
  ]);
  return {
    forest: buildForest(app), rootId: 'ws-root', app, ledger: createLedger(),
    states, alive, workspaceFiles, sessionDbs: new Map([['cli-root', { todos: [], deps: [], children }]]),
    prInfo, now: at(60), thresholds: DEFAULT_THRESHOLDS, revision: 1, diagnostics: [],
  };
}

const unitOf = (snapshot, label) => snapshot.units.find(unit => unit.label === label);

test('a live unit that only mentions a PR merged before it started keeps running', () => {
  // The foreign PR (id 4321) merged at at(2); the unit started at at(5) and is busy.
  const data = adoSwarm([{ id: 'reader', mention: 4321, openTurn: true }], mergedLookup(2));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const unit = unitOf(snapshot, 'reader');
  // The guessed PR belongs to another unit: it is dropped, not trusted.
  assert.equal(unit.pr, null);
  assert.deepEqual({ statusDetail: unit.statusDetail, stage: unit.stage, outcome: unit.outcome },
    { statusDetail: 'busy', stage: 'coding', outcome: null });
  // The unit keeps a live clock: no end, real busy time, timeline segments.
  assert.equal(unit.endedAt, null);
  assert.ok(unit.busyMs > 0, `busyMs ${unit.busyMs}`);
  assert.ok(unit.timeline.segments.length > 0);
  assert.ok(unit.timeline.segments.some(segment => segment.state === 'busy'));
});

test('a unit the registry recorded as closed shows closed even though a foreign PR merged', () => {
  // Same foreign merged PR, but now the registry says the unit closed at at(45) and its process is gone.
  const data = adoSwarm([{ id: 'closer', mention: 4321, alive: false, row: { outcome: 'closed', ended_at: iso(45) } }], mergedLookup(2));
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  const unit = unitOf(snapshot, 'closer');
  assert.equal(unit.outcome, 'closed');
  assert.notEqual(unit.stage, 'merged');
  assert.equal(closedNotMerged(unit), true);
  assert.equal(unit.endedAt, at(45));
});

test('a guessed PR merged during the unit\'s own lifetime is kept', () => {
  // Control: the same heuristic, but the PR merged at at(30), after the unit started,
  // so the mention can be this unit's own PR.
  const data = adoSwarm([{ id: 'own', mention: 9999, openTurn: true }], mergedLookup(30));
  const snapshot = buildSnapshot(data);
  const unit = unitOf(snapshot, 'own');
  assert.equal(unit.pr?.state, 'merged');
  assert.equal(unit.pr?.source, 'heuristic');
});

test('deriveStage: a closed registry outcome wins over a merged PR state', () => {
  assert.deepEqual(deriveStage({ archivedAt: at(50), outcome: 'closed', pr: { state: 'merged' } }),
    { stage: 'pr_open', merged: false, closedWithoutMerge: true });
});

test('prForeignToUnit: only guessed PRs that predate the unit are dropped', () => {
  const heuristic = extra => ({ source: 'heuristic', openedAt: null, mergedAt: null, closedAt: null, ...extra });
  const start = at(5);
  assert.equal(prForeignToUnit(heuristic({ mergedAt: at(2) }), start), true, 'merged before start');
  assert.equal(prForeignToUnit(heuristic({ openedAt: at(1), mergedAt: at(30) }), start), true, 'opened before start');
  assert.equal(prForeignToUnit(heuristic({ mergedAt: at(30) }), start), false, 'merged during life');
  assert.equal(prForeignToUnit(heuristic({ openedAt: at(6), mergedAt: null }), start), false, 'still open');
  assert.equal(prForeignToUnit(heuristic({ mergedAt: at(2) }), at(1)), false, 'unit predates the merge');
  assert.equal(prForeignToUnit({ source: 'registry', mergedAt: at(2) }, start), false, 'authoritative identities are kept');
  assert.equal(prForeignToUnit(null, start), false, 'no PR');
  assert.equal(prForeignToUnit(heuristic({ mergedAt: at(2) }), NaN), false, 'unknown start');
});
