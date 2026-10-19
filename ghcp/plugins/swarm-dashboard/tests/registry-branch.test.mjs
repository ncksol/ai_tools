import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSnapshot } from '../engine/model/swarm.mjs';
import { MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const at = minutes => T0 + minutes * MINUTE;
const iso = minutes => new Date(at(minutes)).toISOString();

/**
 * An orchestrator with two stacked units, web on api. The registry names their branches; `app` gives the app's branch and base
 * branch for each unit. No todo or todo dependency links them, so only branch matching can.
 */
function stackedSwarm({ app, registry }) {
  const workspaces = new Map();
  const worktrees = new Map();
  const ws = (id, name, cli, createdAt, branches = {}) => {
    const worktreeId = branches.baseBranch !== undefined ? `wt-${id}` : null;
    if (worktreeId) worktrees.set(worktreeId, { id: worktreeId, branch: branches.branch ?? null, baseBranch: branches.baseBranch ?? null });
    workspaces.set(id, {
      id, projectId: 'project-1', worktreeId, name, branch: branches.branch ?? null, createdAt, archivedAt: null, sessionId: cli,
      creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null,
    });
  };
  ws('ws-root', 'Sample story', 'cli-root', T0);
  ws('ws-api', 'Sample api', 'cli-api', at(5), app.api);
  ws('ws-web', 'Sample web', 'cli-web', at(6), app.web);
  const appData = {
    projects: new Map([['project-1', { id: 'project-1', name: 'sample-project', githubOwner: null, githubRepo: null }]]),
    worktrees, workspaces,
    parentLinks: ['ws-api', 'ws-web'].map(childId => ({ childId, parentId: 'ws-root' })),
    aliases: [['cli-root', 'ws-root'], ['cli-api', 'ws-api'], ['cli-web', 'ws-web']].map(([sessionId, workspaceId]) => ({ sessionId, workspaceId, createdAt: T0 })),
    chatLinks: [], sessions: new Map(), automations: [], diagnostics: [],
  };
  const log = start => {
    const events = new EventLog(start);
    events.start();
    events.turnStart();
    events.at(start + 10 * MINUTE);
    events.turnEnd();
    return events;
  };
  const row = (unit, sessionId, title, branches) => ({
    unit, session_id: sessionId, title, todo_id: null, branch: branches.branch ?? null, base_branch: branches.base_branch ?? null,
    pr_provider: null, pr_repo: null, pr_id: null, pr_url: null, outcome: null, created_at: iso(5), updated_at: iso(30), ended_at: null,
  });
  const children = [row('api', 'ws-api', 'API', registry.api), row('web', 'ws-web', 'Web', registry.web)];
  return {
    forest: buildForest(appData), rootId: 'ws-root', app: appData, ledger: createLedger(),
    states: new Map([['cli-root', fold(log(T0), 'cli-root')], ['cli-api', fold(log(at(5)), 'cli-api')], ['cli-web', fold(log(at(6)), 'cli-web')]]),
    alive: new Map([['cli-root', true], ['cli-api', true], ['cli-web', true]]),
    workspaceFiles: new Map(),
    sessionDbs: new Map([['cli-root', { todos: [], deps: [], children }]]),
    prInfo: () => null,
    now: at(60), thresholds: DEFAULT_THRESHOLDS, revision: 1, diagnostics: [],
  };
}

const REGISTRY = {
  api: { branch: 'contract/api', base_branch: 'main' },
  web: { branch: 'contract/web', base_branch: 'contract/api' },
};

function unitsOf(input) {
  const snapshot = buildSnapshot(input);
  assert.deepEqual(validateSnapshot(snapshot), []);
  return Object.fromEntries(snapshot.units.map(unit => [unit.label, unit]));
}

test('a stacked unit links to its parent by the registry\'s branch when the app has no branch for either unit', () => {
  const units = unitsOf(stackedSwarm({ app: { api: {}, web: {} }, registry: REGISTRY }));
  assert.equal(units.web.dependsOn, 'api');
  assert.equal(units.api.dependsOn, null);
  assert.deepEqual({ api: units.api.branch, web: units.web.branch }, { api: 'contract/api', web: 'contract/web' });
});

test('a stacked unit links to its parent by the registry\'s branch when the app\'s branches are stale', () => {
  const app = { api: { branch: 'app/api', baseBranch: 'main' }, web: { branch: 'app/web', baseBranch: 'app/api' } };
  const units = unitsOf(stackedSwarm({ app, registry: REGISTRY }));
  assert.equal(units.web.dependsOn, 'api');
  assert.equal(units.api.dependsOn, null);
  assert.deepEqual({ api: units.api.branch, web: units.web.branch }, { api: 'contract/api', web: 'contract/web' });
});

test('a unit whose registry row has no branch keeps the app\'s branch for linking', () => {
  const app = { api: { branch: 'contract/api', baseBranch: 'main' }, web: { branch: 'app/web', baseBranch: 'contract/api' } };
  const registry = { api: {}, web: { base_branch: 'contract/api' } };
  const units = unitsOf(stackedSwarm({ app, registry }));
  assert.deepEqual({ api: units.api.branch, web: units.web.branch }, { api: 'contract/api', web: 'app/web' });
  assert.equal(units.web.dependsOn, 'api');
});
