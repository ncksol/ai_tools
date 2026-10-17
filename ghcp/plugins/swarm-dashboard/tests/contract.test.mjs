import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRegistry, parseQuestionTag, parseReportBody, parseStatusLine, purposeToStatus } from '../engine/model/contract.mjs';

const EXAMPLE = [
  'swarm-status: complete unit=api pr=github:42 commit=3f9a2c1',
  'Summary: The endpoint and its tests are done, and a draft PR is open.',
  'Evidence:',
  '- 120 API tests pass',
  '- A second-model review found no issues',
  'Blockers: none',
].join('\n');

test('the spec example status line parses', () => {
  assert.deepEqual(parseStatusLine(EXAMPLE), { status: 'complete', unit: 'api', pr: { provider: 'github', id: 42 }, commit: '3f9a2c1' });
});

test('status line fields may come in any order and unknown fields are ignored', () => {
  assert.deepEqual(parseStatusLine('swarm-status: needs_input commit=abcdef1 extra=1 unit=F2b pr=ado:4711'),
    { status: 'needs_input', unit: 'F2b', pr: { provider: 'ado', id: 4711 }, commit: 'abcdef1' });
});

test('invalid optional fields are dropped; invalid required parts reject the line', () => {
  assert.deepEqual(parseStatusLine('swarm-status: progress unit=api pr=gitlab:4 commit=XYZ'), { status: 'progress', unit: 'api', pr: null, commit: null });
  for (const bad of [
    'swarm-status: done unit=api', 'swarm-status: complete', 'swarm-status: complete unit=bad?label',
    `swarm-status: complete unit=${'x'.repeat(33)}`, 'Swarm-Status: complete unit=api', 'status: complete unit=api', '', null,
  ]) assert.equal(parseStatusLine(bad), null, String(bad));
});

test('purpose maps to report status', () => {
  assert.equal(purposeToStatus('handoff'), 'complete');
  assert.equal(purposeToStatus('progress'), 'progress');
  assert.equal(purposeToStatus('needs_input'), 'needs_input');
  assert.equal(purposeToStatus('error'), 'blocked');
  assert.equal(purposeToStatus(undefined), null);
});

test('report fields parse in one-line and block form', () => {
  const body = EXAMPLE.split('\n').slice(1).join('\n');
  assert.deepEqual(parseReportBody(body), {
    summary: 'The endpoint and its tests are done, and a draft PR is open.',
    evidence: ['120 API tests pass', 'A second-model review found no issues'],
    blockers: [],
    freeText: null,
  });
});

test('text before the first label is free text, labels are case-insensitive, and continuation lines join', () => {
  const body = ['Picked up the review comments.', '', 'SUMMARY:', 'Two fixes pushed.', 'Both small.', 'blockers:', '- Waiting for the parent', '  branch to merge'].join('\n');
  assert.deepEqual(parseReportBody(body), {
    summary: 'Two fixes pushed. Both small.',
    evidence: [],
    blockers: ['Waiting for the parent branch to merge'],
    freeText: 'Picked up the review comments.',
  });
});

test('a body without labels is all free text', () => {
  assert.deepEqual(parseReportBody('Plain update.\nNothing structured.'), { summary: null, evidence: [], blockers: null, freeText: 'Plain update.\nNothing structured.' });
});

test('question tags name units and an optional need', () => {
  assert.deepEqual(parseQuestionTag('[unit=api] Use the new client?'), { units: ['api'], need: 'question', text: 'Use the new client?' });
  assert.deepEqual(parseQuestionTag('[unit=api,F2b need=pr] Merge both PRs?'), { units: ['api', 'F2b'], need: 'pr', text: 'Merge both PRs?' });
  assert.deepEqual(parseQuestionTag('[unit=* need=plan] Approve the plan?'), { units: ['*'], need: 'plan', text: 'Approve the plan?' });
  for (const bad of ['Use the new client?', '[need=pr] Merge?', '[unit=api need=later] Merge?', '[unit=api who=me] Merge?', '[unit=bad label] Merge?', '[unit=api unit=b] Merge?']) {
    assert.equal(parseQuestionTag(bad), null, bad);
  }
});

test('the registry keeps valid rows and the latest update per unit across sessions', () => {
  const base = { session_id: 'ws-1', title: 'API', created_at: '2026-10-15T08:00:00Z', updated_at: '2026-10-15T09:00:00Z' };
  const { units, invalid } = normaliseRegistry([
    [{ ...base, unit: 'api' }, { ...base, unit: 'bad unit' }, { ...base, unit: 'docs', session_id: '' }],
    [{ ...base, unit: 'API', title: 'API v2', updated_at: '2026-10-15T10:00:00Z', pr_provider: 'ado', pr_id: 4711, pr_repo: 'org/project/repo', outcome: 'merged', ended_at: '2026-10-15T10:00:00Z' }],
    [{ ...base, unit: 'web', pr_provider: 'github', pr_id: null, outcome: 'abandoned' }],
  ]);
  assert.equal(invalid, 2);
  assert.deepEqual([...units.keys()], ['api', 'web']);
  const api = units.get('api');
  assert.equal(api.unit, 'API');
  assert.equal(api.title, 'API v2');
  assert.equal(api.prProvider, 'ado');
  assert.equal(api.prId, 4711);
  assert.equal(api.outcome, 'merged');
  assert.equal(api.endedAt, Date.UTC(2026, 9, 15, 10));
  const web = units.get('web');
  assert.equal(web.prProvider, null);
  assert.equal(web.outcome, null);
});
