import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoArgs, createPrLookup, githubArgs, mapAdo, mapGithub, prKey } from '../engine/model/pr-lookup.mjs';
import { MINUTE } from '../engine/time.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

test('Azure DevOps PR JSON maps to a PR state and review note', () => {
  const base = { pullRequestId: 4711, title: 'Add API', creationDate: '2026-10-15T08:00:00Z', closedDate: null, repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' } };
  assert.deepEqual(mapAdo({ ...base, status: 'active', isDraft: true, reviewers: [] }), {
    state: 'draft', title: 'Add API', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'no approvals yet',
    url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4711',
  });
  assert.equal(mapAdo({ ...base, status: 'active', isDraft: false, reviewers: [{ vote: 10 }, { vote: 5 }] }).reviewNote, '2 approvals');
  assert.equal(mapAdo({ ...base, status: 'active', reviewers: [{ vote: -5 }] }).reviewNote, 'waiting for the author');
  const merged = mapAdo({ ...base, status: 'completed', closedDate: '2026-10-15T09:00:00Z', reviewers: [{ vote: -10 }] });
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedAt, T0 + 60 * MINUTE);
  assert.equal(merged.reviewNote, 'rejected');
  assert.equal(mapAdo({ ...base, status: 'abandoned' }).state, 'closed');
});

test('GitHub PR JSON maps to a PR state and review note', () => {
  assert.deepEqual(mapGithub({ state: 'OPEN', isDraft: false, title: 'Docs', createdAt: '2026-10-15T08:00:00Z', mergedAt: null, closedAt: null, reviewDecision: 'APPROVED', url: 'https://github.com/o/r/pull/3' }), {
    state: 'open', title: 'Docs', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'approved', url: 'https://github.com/o/r/pull/3',
  });
  assert.equal(mapGithub({ state: 'OPEN', isDraft: true }).state, 'draft');
  assert.equal(mapGithub({ state: 'MERGED', mergedAt: '2026-10-15T08:00:00Z' }).mergedAt, T0);
  assert.equal(mapGithub({ state: 'CLOSED' }).state, 'closed');
});

test('arguments are fixed read-only commands with validated values', () => {
  assert.deepEqual(adoArgs({ provider: 'ado', id: 7, repo: 'org/project/repo' }),
    ['repos', 'pr', 'show', '--id', '7', '--output', 'json', '--organization', 'https://dev.azure.com/org', '--detect', 'false']);
  assert.deepEqual(adoArgs({ provider: 'ado', id: 7, repo: null }), ['repos', 'pr', 'show', '--id', '7', '--output', 'json']);
  assert.deepEqual(githubArgs({ provider: 'github', id: 3, repo: 'o/r' }).slice(-2), ['--repo', 'o/r']);
  assert.equal(githubArgs({ provider: 'github', id: 3, repo: '--evil' }).includes('--evil'), false);
});

test('lookups are cached, refreshed after the TTL, final once merged, and failures are kept', async () => {
  let clock = T0;
  const calls = [];
  const replies = [
    JSON.stringify({ state: 'OPEN', isDraft: false, title: 'One' }),
    JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-15T09:00:00Z', title: 'One' }),
  ];
  const run = async (command, args, options) => {
    calls.push([command, args[2], options.cwd]);
    return replies.shift();
  };
  const lookup = createPrLookup({ run, now: () => clock });
  const pr = { provider: 'github', id: 1, repo: 'o/r' };
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).state, 'open');
  assert.equal(lookup.get(pr).checkedAt, T0);
  lookup.request(pr);
  await lookup.settle();
  assert.equal(calls.length, 1);
  clock += 5 * MINUTE;
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).state, 'merged');
  clock += 60 * MINUTE;
  lookup.request(pr);
  await lookup.settle();
  assert.equal(calls.length, 2);
  assert.equal(prKey(pr), 'github:o/r:1');

  const failing = createPrLookup({ run: async () => { throw new Error('gh failed: not logged in'); }, now: () => clock });
  failing.request({ provider: 'github', id: 2, repo: 'o/r' });
  await failing.settle();
  assert.equal(failing.get({ provider: 'github', id: 2, repo: 'o/r' }).state, 'unknown');
  assert.deepEqual(failing.errors(), [{ key: 'github:o/r:2', error: 'gh failed: not logged in' }]);
});

test('a PR without a repository is looked up only from an existing worktree', async () => {
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push([args[4], options.cwd]); return '{"status":"active"}'; },
    exists: dir => dir === '/synthetic/worktree',
  });
  lookup.request({ provider: 'ado', id: 5, repo: null });
  lookup.request({ provider: 'ado', id: 6, repo: null }, { cwd: '/synthetic/worktree' });
  lookup.request({ provider: 'ado', id: 7, repo: null }, { cwd: '/synthetic/gone' });
  lookup.request({ provider: 'ado', id: 8, repo: 'org/project/repo' }, { cwd: '/synthetic/gone' });
  await lookup.settle();
  assert.deepEqual(calls, [['6', '/synthetic/worktree'], ['8', undefined]]);
  assert.equal(lookup.get({ provider: 'ado', id: 7, repo: null }).state, 'unknown');
  assert.match(lookup.get({ provider: 'ado', id: 7, repo: null }).error, /worktree is gone/);
});

test('a registry repository that is not organization/project/repo adds no organization and keeps the worktree fallback', async () => {
  const pr = { provider: 'ado', id: 42, repo: 'project/repo' };
  assert.deepEqual(adoArgs(pr), ['repos', 'pr', 'show', '--id', '42', '--output', 'json']);
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push([args, options.cwd]); return '{"status":"active"}'; },
    exists: () => true,
  });
  lookup.request(pr, { cwd: '/synthetic/worktree' });
  await lookup.settle();
  assert.deepEqual(calls, [[['repos', 'pr', 'show', '--id', '42', '--output', 'json'], '/synthetic/worktree']]);
});

test('pending is true from the request until its lookup resolves or fails', async () => {
  const gates = [];
  const run = () => new Promise((resolve, reject) => gates.push({ resolve, reject }));
  const lookup = createPrLookup({ run });
  const first = { provider: 'github', id: 1, repo: 'o/r' };
  const second = { provider: 'github', id: 2, repo: 'o/r' };
  const third = { provider: 'github', id: 3, repo: 'o/r' };
  assert.equal(lookup.pending(first), false);
  for (const pr of [first, second, third]) lookup.request(pr);
  assert.deepEqual([first, second, third].map(pr => lookup.pending(pr)), [true, true, true]);
  gates[0].resolve('{"state":"OPEN"}');
  gates[1].reject(new Error('gh failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([first, second].map(pr => lookup.pending(pr)), [false, false]);
  assert.equal(lookup.pending(third), true);
  gates[2].resolve('{"state":"MERGED"}');
  await lookup.settle();
  assert.equal(lookup.pending(third), false);
  assert.equal(lookup.get(second).error, 'gh failed');
  assert.equal(lookup.pending(null), false);
});
