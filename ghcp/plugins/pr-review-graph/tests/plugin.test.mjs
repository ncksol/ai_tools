import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalize } from '../skills/review-pull-request/scripts/normalize-context.mjs';
import { buildReviewPlan } from '../skills/review-pull-request/scripts/build-review-plan.mjs';
import { validateFindings } from '../skills/review-pull-request/scripts/validate-findings.mjs';
import { fingerprintFindings } from '../skills/review-pull-request/scripts/fingerprint-findings.mjs';
import { applyDeduplication, prepareDeduplication } from '../skills/review-pull-request/scripts/deduplicate-findings.mjs';
import { buildGitHubReview } from '../skills/review-pull-request/scripts/build-github-review.mjs';
import { buildAzureThreads } from '../skills/review-pull-request/scripts/build-azure-threads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(name) {
  return JSON.parse(await readFile(path.join(root, 'tests/fixtures', name), 'utf8'));
}

test('static plugin validation passes and declares no MCP integration', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'pr-review-graph');
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.hooks, undefined);

  const result = spawnSync(process.execPath, ['scripts/validate-plugin.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('both provider adapters delegate CLI conventions to external skills', async () => {
  const skill = await readFile(path.join(root, 'skills/review-pull-request/SKILL.md'), 'utf8');
  const github = await readFile(path.join(root, 'skills/review-pull-request/references/github-gh-cli-provider.md'), 'utf8');
  const azure = await readFile(path.join(root, 'skills/review-pull-request/references/azure-devops-cli-provider.md'), 'utf8');
  assert.match(skill, /separately installed `gh-cli` skill/);
  assert.match(skill, /separately installed `azure-devops-cli` skill/);
  assert.match(github, /First load and follow the separately installed `gh-cli` skill/);
  assert.match(azure, /Load and follow the separately installed `azure-devops-cli` skill/);
});

test('GitHub raw data normalizes into an immutable canonical packet', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  assert.equal(packet.provider, 'github');
  assert.equal(packet.repository.id, 'acme/widgets');
  assert.equal(packet.pullRequest.number, 42);
  assert.equal(packet.pullRequest.head.sha, '2222222222222222222222222222222222222222');
  assert.equal(packet.files[0].path, 'src/user.js');
  assert.match(packet.files[0].patch, /req\.query\.id/);
  assert.deepEqual(packet.existingThreads.map(thread => thread.type), ['review-comment', 'review', 'issue-comment']);
  assert.equal(packet.existingThreads[0].url, 'https://github.com/acme/widgets/pull/42#discussion_r501');
  assert.deepEqual(packet.limits.warnings, []);
});

test('risk router selects only relevant conditional specialists', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const plan = buildReviewPlan(packet);
  const names = plan.agents.map(agent => agent.name);
  assert.deepEqual(names.slice(0, 3), ['prg-contract', 'prg-correctness', 'prg-tests']);
  assert.ok(names.includes('prg-security'));
  assert.ok(!names.includes('prg-data-compatibility'));
  assert.ok(!names.includes('prg-reliability'));
});

test('finding validation enforces verification and security confidence', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const findings = await fixture('findings.json');
  const valid = validateFindings(findings, { mode: 'verified', packet });
  assert.equal(valid.valid, true, valid.errors.join('\n'));
  assert.ok(valid.warnings.some(warning => warning.includes('summary-only')));

  const lowConfidence = structuredClone(findings);
  lowConfidence[0].confidence = 0.84;
  const invalid = validateFindings(lowConfidence, { mode: 'verified', packet });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('below 0.85')));
});

test('fingerprints are stable and suppress already-published comments', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const findings = await fixture('findings.json');
  const first = fingerprintFindings(packet, findings);
  const second = fingerprintFindings(packet, findings);
  assert.equal(first.findings[0].fingerprint, second.findings[0].fingerprint);
  assert.match(first.findings[0].fingerprint, /^[a-f0-9]{64}$/);

  packet.existingThreads.push({ fingerprint: first.findings[0].fingerprint });
  const suppressed = fingerprintFindings(packet, findings);
  assert.equal(suppressed.findings.length, 1);
  assert.equal(suppressed.suppressed[0].reason, 'already-commented');
});

test('semantic duplicate from another engineer is suppressed with its review reference', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  assert.equal(prepared.existingThreadCount, 3);
  assert.equal(prepared.batches.flatMap(batch => batch.existingThreads).length, 3);

  const decisions = prepared.batches.map(batch => ({
    batchId: batch.batchId,
    decisions: fingerprinted.findings.map((finding, index) => index === 0
      ? {
          fingerprint: finding.fingerprint,
          verdict: 'duplicate',
          matchedThreadIds: ['501'],
          reason: 'Both findings report attacker-controlled input being inserted into the SQL query.'
        }
      : {
          fingerprint: finding.fingerprint,
          verdict: 'distinct',
          matchedThreadIds: [],
          reason: 'No existing comment reports the numeric identifier contract defect.'
        })
  }));

  const result = applyDeduplication(prepared, decisions);
  assert.equal(result.findings.length, 1);
  assert.equal(result.suppressed.at(-1).reason, 'existing-review-duplicate');
  assert.equal(result.suppressed.at(-1).matches[0].id, '501');
  assert.equal(result.suppressed.at(-1).matches[0].author, 'engineer-one');
  assert.equal(result.suppressed.at(-1).matches[0].url, 'https://github.com/acme/widgets/pull/42#discussion_r501');
});

test('CLI pipeline excludes a prior semantic duplicate from the GitHub review payload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-dedupe-cli-'));
  try {
    const packetFile = path.join(directory, 'packet.json');
    const findingsFile = path.join(directory, 'findings.json');
    const fingerprintedFile = path.join(directory, 'fingerprinted.json');
    const checksFile = path.join(directory, 'checks.json');
    const decisionsFile = path.join(directory, 'decisions.json');
    const dedupedFile = path.join(directory, 'deduped.json');
    const payloadFile = path.join(directory, 'review.json');
    await writeFile(packetFile, JSON.stringify(normalize(await fixture('github-raw.json'))));
    await writeFile(findingsFile, JSON.stringify(await fixture('findings.json')));

    let result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/fingerprint-findings.mjs',
      packetFile,
      findingsFile,
      fingerprintedFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/deduplicate-findings.mjs',
      'prepare',
      packetFile,
      fingerprintedFile,
      checksFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const checks = JSON.parse(await readFile(checksFile, 'utf8'));
    const [securityFingerprint, contractFingerprint] = checks.findings.map(finding => finding.fingerprint);
    await writeFile(decisionsFile, JSON.stringify({
      batches: checks.batches.map(batch => ({
        batchId: batch.batchId,
        decisions: [
          {
            fingerprint: securityFingerprint,
            verdict: 'duplicate',
            matchedThreadIds: ['501'],
            reason: 'Both report SQL injection caused by interpolating the request identifier.'
          },
          {
            fingerprint: contractFingerprint,
            verdict: 'distinct',
            matchedThreadIds: [],
            reason: 'No prior feedback identifies the missing numeric identifier validation.'
          }
        ]
      }))
    }));

    result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/deduplicate-findings.mjs',
      'apply',
      checksFile,
      decisionsFile,
      dedupedFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/build-github-review.mjs',
      packetFile,
      dedupedFile,
      payloadFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const deduped = JSON.parse(await readFile(dedupedFile, 'utf8'));
    const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
    assert.equal(deduped.findings.length, 1);
    assert.equal(deduped.suppressed.at(-1).matches[0].author, 'engineer-one');
    assert.equal(payload.comments.length, 0);
    assert.doesNotMatch(payload.body, /SQL injection|interpolat/i);
    assert.match(payload.body, /numeric identifier contract/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uncertain or incomplete duplicate checks are held and never publishable', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  const [first, second] = fingerprinted.findings;
  const decisions = [{
    batchId: prepared.batches[0].batchId,
    decisions: [{
      fingerprint: first.fingerprint,
      verdict: 'uncertain',
      matchedThreadIds: ['501'],
      reason: 'The existing comment is similar but does not clearly state the same consequence.'
    }]
  }];

  const result = applyDeduplication(prepared, decisions);
  assert.equal(result.findings.length, 0);
  assert.equal(result.held.length, 2);
  assert.equal(result.held.find(item => item.fingerprint === first.fingerprint).reason, 'possible-existing-review-duplicate');
  assert.equal(result.held.find(item => item.fingerprint === second.fingerprint).reason, 'incomplete-deduplication');
  assert.throws(() => buildGitHubReview(packet, [first]), /has not passed existing-review deduplication/);
});

test('a duplicate in any comment batch suppresses the finding', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [
    { id: 'a', type: 'review', body: 'x'.repeat(4_900), path: null },
    { id: 'b', type: 'review-comment', body: 'This raw id is concatenated into SQL and permits injection.', path: 'src/user.js', line: 11 }
  ];
  const fingerprinted = fingerprintFindings(packet, [await fixture('findings.json').then(items => items[0])]);
  const prepared = prepareDeduplication(packet, fingerprinted, { maxBatchChars: 5_000 });
  assert.equal(prepared.batches.length, 2);
  const finding = fingerprinted.findings[0];
  const decisions = [
    { batchId: 'batch-001', decisions: [{ fingerprint: finding.fingerprint, verdict: 'distinct', matchedThreadIds: [], reason: 'The first comment is unrelated.' }] },
    { batchId: 'batch-002', decisions: [{ fingerprint: finding.fingerprint, verdict: 'duplicate', matchedThreadIds: ['b'], reason: 'Both identify SQL injection from raw request input.' }] }
  ];
  const result = applyDeduplication(prepared, decisions);
  assert.equal(result.findings.length, 0);
  assert.equal(result.suppressed.at(-1).matches[0].id, 'b');
});

test('GitHub builder batches inline findings and moves unstable locations to summary', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [];
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  const findings = applyDeduplication(prepared, []).findings;
  const payload = buildGitHubReview(packet, findings);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.commit_id, packet.pullRequest.head.sha);
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].line, 11);
  assert.match(payload.comments[0].body, /<!-- pr-review-graph:[a-f0-9]{64} -->/);
  assert.match(payload.body, /without a stable inline position/);
});

test('Azure builder preserves iteration and change tracking context', async () => {
  const packet = normalize(await fixture('azure-raw.json'));
  const finding = {
    category: 'data-compatibility',
    severity: 'high',
    confidence: 0.92,
    title: 'NOT NULL column breaks rolling deployment',
    problem: 'the migration requires a value before old writers provide one',
    trigger: 'the migration runs while the previous application version is still writing users',
    consequence: 'old application instances fail every user insert',
    evidence: 'the new email column is NOT NULL and has no database default',
    recommendation: 'use an expand-and-contract migration before enforcing the constraint',
    location: { path: 'db/schema.sql', line: 3, side: 'RIGHT' },
    verification: { verdict: 'verified', reason: 'The supplied rolling-deployment requirement establishes version overlap.' }
  };
  const fingerprinted = fingerprintFindings(packet, [finding]);
  const finalFinding = applyDeduplication(prepareDeduplication(packet, fingerprinted), []).findings;
  const threads = buildAzureThreads(packet, finalFinding);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].inline, true);
  assert.equal(threads[0].payload.threadContext.filePath, '/db/schema.sql');
  assert.equal(threads[0].payload.pullRequestThreadContext.changeTrackingId, 9);
  assert.equal(threads[0].payload.pullRequestThreadContext.iterationContext.secondComparingIteration, 2);
});

test('Azure CLI builder writes one payload per finding and an index', async () => {
  const packet = normalize(await fixture('azure-raw.json'));
  const finding = {
    category: 'data-compatibility', severity: 'high', confidence: 0.9,
    title: 'Schema transition is not backward compatible',
    problem: 'old writers cannot satisfy the new required field',
    trigger: 'old and new versions run during deployment',
    consequence: 'writes from old instances fail',
    evidence: 'the added field is required without a default',
    recommendation: 'stage the constraint after all writers are upgraded',
    location: null,
    verification: { verdict: 'verified', reason: 'The transition contradicts the supplied rollout requirement.' }
  };
  const fingerprinted = fingerprintFindings(packet, [finding]);
  const value = applyDeduplication(prepareDeduplication(packet, fingerprinted), []);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-test-'));
  try {
    const packetFile = path.join(directory, 'packet.json');
    const findingsFile = path.join(directory, 'findings.json');
    const payloadDirectory = path.join(directory, 'payloads');
    await writeFile(packetFile, JSON.stringify(packet));
    await writeFile(findingsFile, JSON.stringify(value));
    const result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/build-azure-threads.mjs',
      packetFile,
      findingsFile,
      payloadDirectory
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const index = JSON.parse(await readFile(path.join(payloadDirectory, 'index.json'), 'utf8'));
    assert.equal(index.threads.length, 1);
    assert.equal(index.threads[0].inline, false);
    const threads = buildAzureThreads(packet, value);
    assert.equal(threads[0].inline, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
