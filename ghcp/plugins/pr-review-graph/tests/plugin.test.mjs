import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { applyComments } from '../skills/review-pull-request/scripts/apply-comments.mjs';
import {
  discoveryResultFileName,
  finalizeDiscovery,
  ingestDiscoveryResponse
} from '../skills/review-pull-request/scripts/process-discovery.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(name) {
  return JSON.parse(await readFile(path.join(root, 'tests/fixtures', name), 'utf8'));
}

function discoveryCandidate(category = 'correctness', overrides = {}) {
  return {
    category,
    severity: 'high',
    confidence: 0.9,
    title: 'Malformed output loses review coverage',
    problem: 'the discovery response cannot be parsed as strict JSON',
    trigger: 'a specialist emits a literal control character inside a string',
    consequence: 'the batch is omitted from discovery coverage',
    evidence: 'the strict parser rejects the response before candidate validation',
    recommendation: 'serialize every string with JSON escapes',
    location: null,
    relatedLocations: [],
    ...overrides
  };
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

async function dedupedFindings() {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [];
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  return { packet, findings: applyDeduplication(prepared, []).findings };
}

test('comment join attaches editor text and makes the findings publishable', async () => {
  const { packet, findings } = await dedupedFindings();
  const editorOutput = {
    comments: findings.map((finding, index) => ({
      fingerprint: finding.fingerprint,
      comment: `Edited comment ${index}`
    }))
  };

  const final = applyComments({ findings }, editorOutput);

  assert.equal(final.length, findings.length);
  assert.equal(final[0].comment, 'Edited comment 0');
  assert.equal(final[0].fingerprint, findings[0].fingerprint);
  assert.equal(final[0].deduplication.verdict, 'distinct');
  assert.equal(final[0].title, findings[0].title);

  const payload = buildGitHubReview(packet, final);
  const published = [payload.body, ...payload.comments.map(comment => comment.body)].join('\n');
  assert.match(published, /Edited comment 0/);
  assert.match(published, /Edited comment 1/);
  assert.equal(payload.comments.length, 1);
  assert.match(payload.comments[0].body, /<!-- pr-review-graph:[a-f0-9]{64} -->/);
});

test('comment join rejects a comment for an unknown finding', async () => {
  const { findings } = await dedupedFindings();
  const editorOutput = {
    comments: [
      ...findings.map(finding => ({ fingerprint: finding.fingerprint, comment: 'Edited comment' })),
      { fingerprint: 'f'.repeat(64), comment: 'Invented finding' }
    ]
  };

  assert.throws(() => applyComments({ findings }, editorOutput), /unknown findings/);
});

test('comment join rejects a finding left without usable comment text', async () => {
  const { findings } = await dedupedFindings();
  const withBlank = {
    comments: findings.map((finding, index) => ({
      fingerprint: finding.fingerprint,
      comment: index === 0 ? '   ' : 'Edited comment'
    }))
  };
  const withOmission = {
    comments: findings.slice(1).map(finding => ({ fingerprint: finding.fingerprint, comment: 'Edited comment' }))
  };

  assert.throws(() => applyComments({ findings }, withBlank), /no usable comment/);
  assert.throws(() => applyComments({ findings }, withOmission), /no usable comment/);
});

test('builders reject raw editor output instead of producing an empty review', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const azurePacket = normalize(await fixture('azure-raw.json'));
  const editorOutput = { comments: [{ fingerprint: 'a'.repeat(64), comment: 'Edited comment' }] };

  assert.throws(() => buildGitHubReview(packet, editorOutput), /apply-comments\.mjs/);
  assert.throws(() => buildAzureThreads(azurePacket, editorOutput), /apply-comments\.mjs/);
});

test('comment join rejects duplicate fingerprints in editor output', async () => {
  const { findings } = await dedupedFindings();
  const editorOutput = {
    comments: [
      ...findings.map((finding, index) => ({ fingerprint: finding.fingerprint, comment: `Edited comment ${index}` })),
      { fingerprint: findings[0].fingerprint, comment: 'Duplicate for first finding' }
    ]
  };

  assert.throws(() => applyComments({ findings }, editorOutput), /more than one comment/);
});

test('discovery ingestion accepts escaped multiline and control characters', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-ingest-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const evidence = 'first line\nsecond line\twith a tab\0and a nul';
    await writeFile(rawFile, JSON.stringify([
      discoveryCandidate('correctness', { evidence })
    ]), { mode: 0o600 });

    const result = await ingestDiscoveryResponse(
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );

    assert.equal(result.status, 'complete');
    assert.equal(result.findings[0].evidence, evidence);
    const persisted = await readFile(path.join(
      resultDirectory,
      discoveryResultFileName('prg-correctness', 1, 1)
    ), 'utf8');
    assert.match(persisted, /first line\\nsecond line\\twith a tab\\u0000and a nul/);
    await assert.rejects(access(rawFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery ingestion rejects literal controls and retains only redacted diagnostics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-invalid-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890ABCD'].join('_');
    const candidate = discoveryCandidate('correctness', {
      evidence: 'first line\nsecond line',
      recommendation: `Authorization: bearer-secret; token=${githubToken}`,
      debug: {
        password: 'password-secret',
        private_key: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----'
      }
    });
    const malformed = JSON.stringify([candidate]).replace(
      'first line\\nsecond line',
      'first line\nsecond line'
    );
    await writeFile(rawFile, malformed, { mode: 0o600 });

    const result = await ingestDiscoveryResponse(
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );

    assert.equal(result.status, 'invalid');
    assert.equal(result.failure.kind, 'invalid-json');
    const diagnosticText = await readFile(result.failure.diagnostic, 'utf8');
    const diagnostic = JSON.parse(diagnosticText);
    assert.equal(diagnostic.failureKind, 'invalid-json');
    assert.match(diagnosticText, /first line\\nsecond line/);
    for (const secret of ['bearer-secret', githubToken, 'password-secret', 'ZmFrZQ==']) {
      assert.doesNotMatch(diagnostic.response, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(diagnostic.response, /<redacted/);
    await assert.rejects(access(rawFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('JWT redaction uses precise regex and does not overmatch', async () => {
  const { redactDiagnosticText } = await import('../skills/review-pull-request/scripts/process-discovery.mjs');
  
  const validJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const anotherValidJwt = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2.aGFzQWZvdXJ0aFNlZ21lbnQ1NjU';
  const notAJwt = 'not.a.jwt.string';
  const falsePositiveJwt = 'some.thing.else';
  
  const redacted = redactDiagnosticText(
    `Valid: ${validJwt} Another: ${anotherValidJwt} Not-JWT: ${notAJwt} False: ${falsePositiveJwt}`
  );
  
  assert.doesNotMatch(redacted, new RegExp(validJwt));
  assert.doesNotMatch(redacted, new RegExp(anotherValidJwt));
  assert.match(redacted, /Valid: <redacted-jwt>/);
  assert.match(redacted, /Another: <redacted-jwt>/);
  assert.match(redacted, /Not-JWT: not\.a\.jwt\.string/);
  assert.match(redacted, /False: some\.thing\.else/);
});

test('discovery ingestion cleans up diagnostic if result write fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cleanup-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const candidate = discoveryCandidate('correctness', {
      evidence: 'escaped\\nstring',
      recommendation: 'no secrets here'
    });
    const malformed = JSON.stringify([candidate]).replace(
      'escaped\\nstring',
      'escaped\nstring'
    );
    await writeFile(rawFile, malformed, { mode: 0o600 });
    
    await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
    const resultPath = path.join(resultDirectory, 'prg-correctness-batch-001-attempt-1.json');
    await writeFile(resultPath, '{}', { mode: 0o600 });
    
    const ingestPromise = ingestDiscoveryResponse(
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );
    
    try {
      await ingestPromise;
      assert.fail('Expected EEXIST error');
    } catch (error) {
      assert.equal(error.code, 'EEXIST');
      const diagnosticPath = path.join(diagnosticsDirectory, 'prg-correctness-batch-001-attempt-1.failure.json');
      await assert.rejects(access(diagnosticPath), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function discoveryPlan(agent, batchCount) {
  return {
    schemaVersion: '1.0',
    agents: [{
      name: agent,
      batches: Array.from({ length: batchCount }, (_, index) => [`file-${index + 1}.js`])
    }]
  };
}

async function ingestText(directory, text, metadata) {
  const rawFile = path.join(
    directory,
    `${metadata.agent}-${metadata.batch}-${metadata.attempt}.raw`
  );
  await writeFile(rawFile, text, { mode: 0o600 });
  return ingestDiscoveryResponse(
    rawFile,
    path.join(directory, 'results'),
    path.join(directory, 'diagnostics'),
    metadata
  );
}

test('discovery finalization treats a valid retry as complete coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-retry-'));
  try {
    const candidate = discoveryCandidate();
    const malformed = JSON.stringify([{
      ...candidate,
      evidence: 'first line\nsecond line'
    }]).replace('first line\\nsecond line', 'first line\nsecond line');
    await ingestText(directory, malformed, {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'complete');
    assert.deepEqual(result.coverage.scopes[0], {
      agent: 'prg-correctness',
      status: 'complete',
      expectedBatches: 1,
      completedBatches: 1,
      recoveredBatches: 1,
      failedBatches: 0
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.coverage.failures[0].attempts[0].attempt, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization fails closed when one batch remains invalid', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-partial-'));
  try {
    await ingestText(directory, '[]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    for (const attempt of [1, 2]) {
      await ingestText(directory, '[{"evidence":"literal\nnewline"}]', {
        agent: 'prg-correctness', batch: 2, attempt
      });
    }

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 2),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'incomplete');
    assert.equal(result.coverage.scopes[0].completedBatches, 1);
    assert.equal(result.coverage.scopes[0].failedBatches, 1);
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalize CLI removes stale candidates on failed coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cli-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await writeFile(planFile, JSON.stringify(discoveryPlan('prg-correctness', 1)));
    await writeFile(candidatesFile, '[]\n');
    await ingestText(directory, '[{"evidence":"literal\nnewline"}]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    await ingestText(directory, '[{"evidence":"literal\nnewline"}]', {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stderr);
    await assert.rejects(access(candidatesFile), { code: 'ENOENT' });
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    assert.equal(coverage.status, 'failed');
    assert.equal(coverage.scopes[0].status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalize CLI emits an authoritative empty array only for complete coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-empty-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await writeFile(planFile, JSON.stringify(discoveryPlan('prg-correctness', 1)));
    await ingestText(directory, '[]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(await readFile(candidatesFile, 'utf8')), []);
    assert.equal(JSON.parse(await readFile(coverageFile, 'utf8')).status, 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization classifies complete-first-plus-second as failed with explicit reason', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-reason-'));
  try {
    const candidate = discoveryCandidate();
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'failed');
    assert.equal(result.coverage.failures[0].recovered, false);
    assert.equal(result.coverage.failures[0].reason, 'complete-first-unexpected-retry');
    assert.deepEqual(result.coverage.failures[0].attempts, []);
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validateAttemptEnvelope rejects an envelope when expected category is not a known discovery category', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-badcat-'));
  try {
    const candidate = discoveryCandidate('correctness');
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });

    // Remove the category field from the stored result envelope so that
    // value.category is undefined; validateAttemptEnvelope's field loop will
    // flag it as corrupt (category does not match) before the findings check.
    const resultFile = path.join(
      directory, 'results',
      discoveryResultFileName('prg-correctness', 1, 1)
    );
    const envelope = JSON.parse(await readFile(resultFile, 'utf8'));
    delete envelope.category;
    await writeFile(resultFile, JSON.stringify(envelope), { mode: 0o600 });

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      path.join(directory, 'results')
    );
    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'failed');
    assert.equal(result.coverage.failures[0].reason, 'corrupt-envelope');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('discovery agents require escaped JSON arrays without fences', async () => {
  const agents = [
    'prg-contract',
    'prg-correctness',
    'prg-tests',
    'prg-security',
    'prg-data-compatibility',
    'prg-reliability'
  ];
  for (const agent of agents) {
    const text = await readFile(path.join(root, 'agents', `${agent}.agent.md`), 'utf8');
    assert.match(text, /Return exactly one JSON array/);
    assert.match(text, /Do not wrap the array in a Markdown code fence/);
    assert.ok(text.includes('\\u0000'), `${agent} must require escaped control characters`);
    assert.match(text, /```json\s*\[/);
  }
});

const BASH4_ONLY = [
  { pattern: /\bmapfile\b/, name: 'mapfile (use a `while IFS= read -r` loop)' },
  { pattern: /\breadarray\b/, name: 'readarray (use a `while IFS= read -r` loop)' },
  { pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*,/, name: 'lowercase expansion ${var,} or ${var,,} (use tr)' },
  { pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*\^/, name: 'uppercase expansion ${var^} or ${var^^} (use tr)' },
  { pattern: /\b(declare|local|typeset)\s+-[A-Za-z]*A/, name: 'associative array declaration' }
];

async function shellScripts(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await shellScripts(full)));
    else if (entry.name.endsWith('.sh')) found.push(full);
  }
  return found;
}

test('shell scripts avoid Bash 4 constructs so they run on the stock macOS Bash 3.2', async () => {
  const scripts = await shellScripts(root);
  assert.ok(scripts.length >= 2, `expected to find the collector scripts, found ${scripts.length}`);

  const offences = [];
  for (const file of scripts) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { pattern, name } of BASH4_ONLY) {
        if (pattern.test(line)) {
          offences.push(`${path.relative(root, file)}:${index + 1} uses ${name}`);
        }
      }
    });
  }

  assert.deepEqual(offences, [], `macOS ships Bash 3.2, and SKILL.md invokes these scripts as plain \`bash\`, so Bash 4 syntax makes them fail at runtime:\n${offences.join('\n')}`);
});

test('a truncated Azure change list is reported as a packet warning', async () => {
  const raw = await fixture('azure-raw.json');
  const untruncated = normalize(raw);
  assert.equal(untruncated.limits.warnings.some(warning => /change list is truncated/.test(warning)), false);

  const truncated = normalize({ ...raw, changes: { ...raw.changes, nextSkip: 2000, nextTop: 2000 } });
  assert.equal(truncated.limits.warnings.some(warning => /change list is truncated/.test(warning)), true);
  assert.equal(truncated.files.length, untruncated.files.length);
});
