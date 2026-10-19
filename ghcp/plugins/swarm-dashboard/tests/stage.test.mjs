import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { deriveMonitor, deriveStage, hostOf, prView, resolvePr } from '../engine/model/stage.mjs';
import { MINUTE } from '../engine/time.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const mention = (provider, repo, id, count, at = T0) => [`${provider ?? 'any'}:${repo ?? ''}:${id}`, { provider, repo, id, count, firstAt: at, lastAt: at }];

test('a registry repository is kept only when it is valid for its provider', () => {
  const registry = (prProvider, prRepo) => ({ prProvider, prId: 42, prRepo, prUrl: null });
  const adoHost = { provider: 'ado', repo: 'org/project/repo' };
  assert.equal(resolvePr({ registry: registry('ado', 'project/repo'), host: adoHost }).repo, 'org/project/repo');
  assert.equal(resolvePr({ registry: registry('ado', 'project/repo'), host: { provider: 'ado', repo: null } }).repo, null);
  assert.equal(resolvePr({ registry: registry('ado', 'project/repo'), host: { provider: 'github', repo: 'sample-org/sample-repo' } }).repo, null);
  assert.equal(resolvePr({ registry: registry('ado', 'org/project/other'), host: adoHost }).repo, 'org/project/other');
  assert.equal(resolvePr({ registry: registry('github', 'org/project/repo'), host: { provider: 'github', repo: 'sample-org/sample-repo' } }).repo, 'sample-org/sample-repo');
  assert.equal(resolvePr({ registry: registry('github', 'sample-org/sample-repo'), host: null }).repo, 'sample-org/sample-repo');
});

test('PR identity follows the contract order', () => {
  const registry = { prProvider: 'ado', prId: 4711, prRepo: 'org/project/repo', prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4711' };
  const statusLines = [{ at: T0 + 2, pr: { provider: 'github', id: 7 } }, { at: T0 + 1, pr: { provider: 'github', id: 7 } }];
  const createdPr = { repo: 'sample-org/sample-repo', number: 9, url: 'https://github.com/sample-org/sample-repo/pull/9', state: 'open', mergedAt: null };
  const mentions = new Map([mention('ado', null, 55, 3)]);
  assert.equal(resolvePr({ registry, statusLines, createdPr, mentions }).source, 'registry');
  assert.deepEqual(resolvePr({ statusLines, createdPr, mentions }), { provider: 'github', id: 7, repo: null, url: null, source: 'status_line', knownAt: T0 + 1 });
  assert.deepEqual(resolvePr({ createdPr, mentions }), { provider: 'github', id: 9, repo: 'sample-org/sample-repo', url: createdPr.url, source: 'app', knownAt: null });
  assert.deepEqual(resolvePr({ mentions, host: { provider: 'ado', repo: null } }), { provider: 'ado', id: 55, repo: null, url: null, source: 'heuristic', knownAt: T0 });
  assert.equal(resolvePr({ statusLines, host: { provider: 'github', repo: 'sample-org/sample-repo' } }).repo, 'sample-org/sample-repo');
  assert.equal(resolvePr({}), null);
});

test('the most-mentioned PR is used for Azure DevOps hosts only', () => {
  const mentions = new Map([mention(null, null, 12, 2, T0 + 5), mention('ado', null, 12, 1), mention('ado', null, 3, 2)]);
  assert.deepEqual(resolvePr({ mentions, host: { provider: 'ado', repo: 'org/project/repo' } }),
    { provider: 'ado', id: 12, repo: 'org/project/repo', url: null, source: 'heuristic', knownAt: T0 });
  assert.equal(resolvePr({ mentions, host: { provider: 'github', repo: 'sample-org/sample-repo' } }), null);
  assert.equal(resolvePr({ mentions, host: { provider: null, repo: null } }), null);
});

test('the code host comes from workspace.yaml, else from the project', () => {
  assert.deepEqual(hostOf({ hostType: 'ado', repository: 'org/project/repo' }, null), { provider: 'ado', repo: 'org/project/repo' });
  assert.deepEqual(hostOf({ hostType: 'github', repository: 'sample-org/sample-repo' }, null), { provider: 'github', repo: 'sample-org/sample-repo' });
  assert.deepEqual(hostOf({ hostType: 'ado', repository: '--evil' }, null), { provider: 'ado', repo: null });
  assert.deepEqual(hostOf(null, { githubOwner: 'sample-org', githubRepo: 'sample-repo' }), { provider: 'github', repo: 'sample-org/sample-repo' });
  assert.deepEqual(hostOf({ cwd: '/synthetic/worktree', hostType: null, repository: null }, { githubOwner: null, githubRepo: null }), { provider: null, repo: null });
  assert.deepEqual(hostOf(null, { githubOwner: null, githubRepo: null }), { provider: null, repo: null });
  assert.deepEqual(hostOf(null, null), { provider: null, repo: null });
});

test('prView prefers looked-up state, then the app columns, else unknown', () => {
  const pr = { provider: 'github', id: 9, repo: 'sample-org/sample-repo', url: 'https://github.com/sample-org/sample-repo/pull/9', source: 'app', knownAt: null };
  const info = { state: 'open', title: 'Add API', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'approved', url: pr.url, checkedAt: T0 + 1, error: null };
  assert.deepEqual(prView(pr, info, null), {
    provider: 'github', id: 9, repo: 'sample-org/sample-repo', url: pr.url, title: 'Add API', state: 'open', openedAt: T0,
    mergedAt: null, closedAt: null, reviewNote: 'approved', source: 'app', checkedAt: T0 + 1,
  });
  const fromApp = prView(pr, { ...info, state: 'unknown' }, { state: 'merged', mergedAt: T0 + 9 });
  assert.equal(fromApp.state, 'merged');
  assert.equal(fromApp.mergedAt, T0 + 9);
  assert.equal(prView({ ...pr, source: 'heuristic' }, null, null).state, 'unknown');
});

test('stages run from coding through review to merged and archived', () => {
  const pr = state => ({ state });
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: null, pr: null }), { stage: 'coding', merged: false, closedWithoutMerge: false });
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('draft') }).stage, 'pr_open');
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('open') }).stage, 'in_review');
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('unknown') }).stage, 'pr_open');
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('unknown'), monitorEver: true }).stage, 'in_review');
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: 'merged', pr: pr('unknown') }), { stage: 'merged', merged: true, closedWithoutMerge: false });
  assert.deepEqual(deriveStage({ archivedAt: T0, outcome: null, pr: pr('merged') }), { stage: 'merged', merged: true, closedWithoutMerge: false });
  assert.deepEqual(deriveStage({ archivedAt: T0, outcome: 'closed', pr: null }), { stage: 'archived', merged: false, closedWithoutMerge: true });
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: null, pr: pr('closed') }), { stage: 'pr_open', merged: false, closedWithoutMerge: true });
});

test('monitors are alive, missing, paused, ended or none', () => {
  const base = { hasPr: true, automations: [], wakes: [], saves: [], prKnownAt: T0, now: T0 + 60 * MINUTE, thresholds: DEFAULT_THRESHOLDS };
  const row = { sessionId: 'cli-1', interval: 'minutes', everyMinutes: 10, lastRunAt: T0 + 55 * MINUTE, nextRunAt: T0 + 65 * MINUTE, pausedAt: null, name: 'PR monitor' };
  assert.deepEqual(deriveMonitor({ ...base, stage: 'in_review', automations: [row] }),
    { state: 'alive', lastCheckAt: T0 + 55 * MINUTE, nextCheckAt: T0 + 65 * MINUTE, everyMinutes: 10, since: null });
  assert.deepEqual(deriveMonitor({ ...base, stage: 'in_review', automations: [{ ...row, nextRunAt: T0 + 40 * MINUTE }] }).state, 'missing');
  assert.equal(deriveMonitor({ ...base, stage: 'in_review', automations: [{ ...row, nextRunAt: T0 + 40 * MINUTE }] }).since, T0 + 40 * MINUTE);
  assert.equal(deriveMonitor({ ...base, stage: 'in_review', automations: [{ ...row, nextRunAt: T0 + 57 * MINUTE }] }).state, 'alive');
  assert.deepEqual(deriveMonitor({ ...base, stage: 'pr_open', automations: [{ ...row, pausedAt: T0 + 30 * MINUTE }] }).since, T0 + 30 * MINUTE);
  const missing = deriveMonitor({ ...base, stage: 'in_review', wakes: [T0 + 10 * MINUTE, T0 + 20 * MINUTE], saves: [{ at: T0, clear: false, everyMinutes: 10 }] });
  assert.deepEqual(missing, { state: 'missing', lastCheckAt: T0 + 20 * MINUTE, nextCheckAt: null, everyMinutes: 10, since: T0 + 30 * MINUTE });
  assert.equal(deriveMonitor({ ...base, stage: 'pr_open' }).since, T0);
  assert.equal(deriveMonitor({ ...base, stage: 'coding', hasPr: false }).state, 'none');
  assert.equal(deriveMonitor({ ...base, stage: 'merged' }).state, 'ended');
  assert.equal(deriveMonitor({ ...base, stage: 'archived', hasPr: false }).state, 'none');
});

test('a PR closed without merge ends its monitor, with no stage change', () => {
  const base = { hasPr: true, automations: [], wakes: [], saves: [], prKnownAt: T0, now: T0 + 60 * MINUTE, thresholds: DEFAULT_THRESHOLDS };
  const row = { sessionId: 'cli-1', interval: 'minutes', everyMinutes: 10, lastRunAt: T0 + 55 * MINUTE, nextRunAt: T0 + 65 * MINUTE, pausedAt: null, name: 'PR monitor' };
  assert.deepEqual(deriveMonitor({ ...base, stage: 'pr_open', closedWithoutMerge: true }),
    { state: 'ended', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null });
  assert.deepEqual(deriveMonitor({ ...base, stage: 'in_review', closedWithoutMerge: true, automations: [row] }).nextCheckAt, null);
  assert.equal(deriveMonitor({ ...base, stage: 'coding', hasPr: false, closedWithoutMerge: true }).state, 'none');
  assert.equal(deriveMonitor({ ...base, stage: 'pr_open', closedWithoutMerge: false }).state, 'missing');
});
