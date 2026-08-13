import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assembleAzureFragments,
  downgradeMalformedCapabilities,
  fragmentFromRawDirectory,
  REQUIRED_AZURE_CAPABILITIES,
  validateAzureFragment
} from '../skills/review-pull-request/scripts/assemble-azure-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(await readFile(path.join(root, 'tests/fixtures/azure-raw.json'), 'utf8'));
const capturedAt = '2026-08-12T12:00:00.000Z';

function source(adapter) {
  return { adapter, credentialContext: 'configured', capturedAt };
}

function complete(data) {
  return { complete: true, data };
}

function fragments() {
  const pr = raw.pullRequest;
  return [
    {
      schemaVersion: '1.0',
      source: source('bluebird'),
      capabilities: {
        identity: complete({
          pullRequestId: pr.pullRequestId,
          url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
          repository: pr.repository
        }),
        metadata: complete({
          title: pr.title,
          description: pr.description,
          createdBy: pr.createdBy,
          status: 'active',
          isDraft: false,
          sourceRefName: pr.sourceRefName,
          targetRefName: pr.targetRefName,
          reviewers: []
        })
      }
    },
    {
      schemaVersion: '1.0',
      source: source('azure-rest'),
      capabilities: {
        snapshot: complete({
          lastMergeSourceCommit: pr.lastMergeSourceCommit,
          lastMergeTargetCommit: pr.lastMergeTargetCommit
        }),
        workItems: complete(raw.workItems),
        policies: complete({ value: raw.policies, exhausted: true }),
        iterations: complete(raw.iterations),
        changes: complete(raw.changes),
        existingThreads: complete(raw.existingThreads)
      }
    },
    {
      schemaVersion: '1.0',
      source: source('local-git'),
      capabilities: {
        diff: complete({
          repository: pr.repository,
          baseSha: pr.lastMergeTargetCommit.commitId,
          headSha: pr.lastMergeSourceCommit.commitId,
          patch: raw.diff
        })
      }
    }
  ];
}

test('Azure fragments compose by capability and preserve provenance', () => {
  const packet = assembleAzureFragments(fragments());
  assert.equal(packet.provider, 'azure-devops');
  assert.equal(packet.pullRequest.number, 77);
  assert.equal(packet.pullRequest.description, raw.pullRequest.description);
  assert.equal(packet.pullRequest.head.sha, raw.pullRequest.lastMergeSourceCommit.commitId);
  assert.deepEqual(
    Object.keys(packet.providerData.access.capabilities).sort(),
    [...REQUIRED_AZURE_CAPABILITIES].sort()
  );
  assert.equal(packet.providerData.access.capabilities.metadata.adapter, 'bluebird');
  assert.equal(packet.providerData.access.capabilities.snapshot.adapter, 'azure-rest');
  assert.equal(packet.providerData.access.capabilities.diff.adapter, 'local-git');
});

test('code and metadata without every provider capability cannot start a review', () => {
  const partial = fragments().filter(fragment => fragment.source.adapter !== 'azure-rest');
  assert.throws(
    () => assembleAzureFragments(partial),
    /Incomplete Azure DevOps context: changes, existingThreads, iterations, policies, snapshot, workItems/
  );
});

test('enumerated empty Azure collections are complete rather than missing', () => {
  const input = fragments();
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  rest.capabilities.workItems = complete([]);
  rest.capabilities.policies = complete({ value: [], exhausted: true });
  rest.capabilities.existingThreads = complete({ value: [] });

  const packet = assembleAzureFragments(input);
  assert.deepEqual(packet.existingThreads, []);
  assert.deepEqual(packet.checks, []);
  assert.equal(packet.providerData.access.capabilities.workItems.adapter, 'azure-rest');
});

test('a fragment cannot mark a truncated Azure change list complete', () => {
  const input = fragments();
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  rest.capabilities.changes = complete({
    ...raw.changes,
    nextSkip: 2000,
    nextTop: 2000
  });
  assert.throws(
    () => assembleAzureFragments(input),
    /Complete Azure capability changes still has pagination/
  );
});

test('conflicting immutable snapshots fail closed', () => {
  const conflicting = structuredClone(fragments());
  conflicting.push({
    schemaVersion: '1.0',
    source: source('other-provider-tool'),
    capabilities: {
      snapshot: complete({
        lastMergeSourceCommit: { commitId: 'f'.repeat(40) },
        lastMergeTargetCommit: raw.pullRequest.lastMergeTargetCommit
      })
    }
  });
  assert.throws(() => assembleAzureFragments(conflicting), /Conflicting Azure head SHA/);
});

test('empty-string head SHA is rejected — by fragment validation and by agreement check', () => {
  // Part 1: validateAzureFragment itself rejects an empty commitId.
  const badSnap = {
    schemaVersion: '1.0',
    source: source('sneaky-adapter'),
    capabilities: {
      snapshot: {
        complete: true,
        data: {
          lastMergeSourceCommit: { commitId: '' },
          lastMergeTargetCommit: raw.pullRequest.lastMergeTargetCommit
        }
      }
    }
  };
  assert.throws(() => validateAzureFragment(badSnap), /snapshot needs lastMergeSourceCommit/);

  // Part 2: a fragment where the first snapshot has a real SHA and a second
  // snapshot has a conflicting *non-empty* SHA still triggers the agreement check.
  const conflictingHead = structuredClone(fragments());
  conflictingHead.push({
    schemaVersion: '1.0',
    source: source('other-adapter'),
    capabilities: {
      snapshot: complete({
        lastMergeSourceCommit: { commitId: 'a'.repeat(40) },
        lastMergeTargetCommit: raw.pullRequest.lastMergeTargetCommit
      })
    }
  });
  assert.throws(() => assembleAzureFragments(conflictingHead), /Conflicting Azure head SHA/);

  // Part 3: assertImmutableAgreement rejects an empty head SHA independently
  // of validateAzureFragment.  We reach it via assembleAzureFragments using
  // a fragment that passes validateAzureFragment (non-empty commitId) but
  // whose data is then mutated to be empty before the agreement loop runs.
  // We verify this by patching the snapshot capability data directly on the
  // already-constructed object that will be passed to assembleAzureFragments.
  const inputEmptyHead = fragments();
  const snapFrag = inputEmptyHead.find(f => f.capabilities.snapshot);
  // Temporarily replace commitId with empty; we bypass validateAzureFragment
  // by using a pre-built fragment array whose elements already passed
  // validateAzureFragment when snapFrag was constructed — here we exercise that
  // assembleAzureFragments re-validates each fragment, so the empty commitId
  // is caught at the validateAzureFragment stage inside assembleAzureFragments.
  snapFrag.capabilities.snapshot.data.lastMergeSourceCommit = { commitId: '' };
  assert.throws(
    () => assembleAzureFragments(inputEmptyHead),
    /snapshot needs lastMergeSourceCommit|Conflicting Azure head SHA/
  );
});

test('identity fragments with disjoint id and name keys describe the same PR', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  // Bluebird transcribes display names only.
  input[0].capabilities.identity = complete({
    pullRequestId: pr.pullRequestId,
    url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
    repository: {
      name: pr.repository.name,
      webUrl: pr.repository.webUrl,
      project: { name: pr.repository.project.name }
    }
  });
  // REST returns GUIDs only.
  input[1].capabilities.identity = complete({
    pullRequestId: pr.pullRequestId,
    url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
    repository: {
      id: pr.repository.id,
      webUrl: pr.repository.webUrl,
      project: { id: pr.repository.project.id }
    }
  });

  const packet = assembleAzureFragments(input);
  assert.equal(packet.pullRequest.number, 77);

  // A key both candidates carry must still agree.
  const conflicting = structuredClone(input);
  conflicting.push({
    schemaVersion: '1.0',
    source: source('other-adapter'),
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
        repository: { id: 'different-repo-guid', project: { id: pr.repository.project.id } }
      })
    }
  });
  assert.throws(() => assembleAzureFragments(conflicting), /Conflicting Azure PR identity/);
});

test('authoritative adapters outrank a later hand-transcribed fragment per capability', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  const bluebird = input.find(fragment => fragment.source.adapter === 'bluebird');

  rest.capabilities.identity = complete({
    pullRequestId: pr.pullRequestId,
    url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
    repository: pr.repository
  });
  rest.capabilities.metadata = complete({
    title: pr.title,
    description: pr.description,
    createdBy: pr.createdBy,
    status: 'active',
    isDraft: false,
    sourceRefName: pr.sourceRefName,
    targetRefName: pr.targetRefName,
    reviewers: []
  });
  rest.capabilities.workItems = { complete: false, failure: { category: 'authentication', message: 'HTTP 403 from work item 901' } };

  // The MCP fragment is captured later but is hand transcribed.
  bluebird.source.capturedAt = '2026-08-12T13:00:00.000Z';
  bluebird.capabilities.metadata.data.description = 'truncated transcription';
  bluebird.capabilities.workItems = complete(raw.workItems);

  const packet = assembleAzureFragments(input);
  const capabilities = packet.providerData.access.capabilities;
  assert.equal(capabilities.identity.adapter, 'azure-rest');
  assert.equal(capabilities.metadata.adapter, 'azure-rest');
  assert.equal(packet.pullRequest.description, pr.description);
  // Bluebird still fills a capability no authoritative adapter completed.
  assert.equal(capabilities.workItems.adapter, 'bluebird');
  assert.ok(packet.providerData.access.attempts.some(
    attempt => attempt.capability === 'metadata' && attempt.source.adapter === 'bluebird'
  ));
  assert.ok(packet.providerData.access.attempts.some(
    attempt => attempt.capability === 'workItems' && attempt.source.adapter === 'azure-rest' && !attempt.complete
  ));
});

test('a malformed capability in one fragment is downgraded without discarding its complete siblings', () => {
  const input = fragments();
  const bluebird = input.find(fragment => fragment.source.adapter === 'bluebird');
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  // A backup identity source keeps the packet completable even though
  // Bluebird's own identity capability is broken (missing pullRequestId) —
  // this reproduces the reported bug: previously the eager validate-all-first
  // pass would throw for the *whole* assembly here, discarding REST's and
  // local Git's already-complete capabilities along with it.
  rest.capabilities.identity = complete(structuredClone(bluebird.capabilities.identity.data));
  delete bluebird.capabilities.identity.data.pullRequestId;

  const packet = assembleAzureFragments(input);
  assert.equal(packet.pullRequest.number, 77);
  const capabilities = packet.providerData.access.capabilities;
  assert.equal(capabilities.identity.adapter, 'azure-rest');
  // Bluebird's still-valid metadata capability survives the downgrade of its
  // sibling identity capability in the same fragment.
  assert.equal(capabilities.metadata.adapter, 'bluebird');
  const identityAttempt = packet.providerData.access.attempts.find(
    attempt => attempt.capability === 'identity' && attempt.source.adapter === 'bluebird'
  );
  assert.equal(identityAttempt.complete, false);
  assert.equal(identityAttempt.failure.category, 'malformed');
  assert.match(identityAttempt.failure.message, /pullRequestId/);
});

test('a structurally broken fragment is dropped, not fatal, and is visible in diagnostics', () => {
  const input = fragments();
  input.push({ source: { adapter: 'broken-adapter', credentialContext: 'configured', capturedAt } });
  input.push({ schemaVersion: '2.0', source: source('other-broken'), capabilities: { identity: complete({}) } });

  const packet = assembleAzureFragments(input);
  assert.equal(packet.pullRequest.number, 77);
  const rejected = packet.providerData.access.rejectedFragments;
  assert.equal(rejected.length, 2);
  assert.deepEqual(rejected.map(entry => entry.source?.adapter).sort(), ['broken-adapter', 'other-broken']);
  for (const entry of rejected) {
    assert.equal(entry.failure.category, 'malformed');
    assert.ok(entry.failure.message.length > 0);
  }
});

test('capturedAt must be a string containing a valid ISO date-time', () => {
  const base = {
    schemaVersion: '1.0',
    source: { adapter: 'test', credentialContext: 'ctx' },
    capabilities: { identity: complete({ pullRequestId: 1, url: 'https://example.com', repository: { id: 'r', project: { id: 'p' } } }) }
  };

  // Number is not a string — passes emptiness check but fails type check.
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: 42 } }),
    /RFC 3339 date-time string/
  );

  // Empty string is caught by the existing required-field loop.
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '' } }),
    /capturedAt is required/
  );

  // Non-date string passes the emptiness check but fails the RFC 3339 pattern.
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: 'not-a-date' } }),
    /RFC 3339 date-time string/
  );

  // Date-only string (no T separator, no timezone) is rejected.
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-01-01' } }),
    /RFC 3339 date-time string/
  );

  // Date-time without a timezone offset is rejected.
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-01-01T12:00:00' } }),
    /RFC 3339 date-time string/
  );

  // Semantically invalid calendar dates are rejected by the explicit day-bound check
  // (Date.parse alone is insufficient because V8 normalises overflow dates).
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-02-30T12:00:00Z' } }),
    /RFC 3339 date-time string/,
    'Feb 30 must be rejected'
  );
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-04-31T12:00:00Z' } }),
    /RFC 3339 date-time string/,
    'Apr 31 must be rejected'
  );
  assert.throws(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-02-29T12:00:00Z' } }),
    /RFC 3339 date-time string/,
    'Feb 29 in a non-leap year must be rejected'
  );
  // Leap year: Feb 29 is a real calendar date.
  assert.doesNotThrow(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2024-02-29T12:00:00Z' } }),
    'Feb 29 in a leap year must be accepted'
  );

  // Valid ISO instant passes.
  assert.doesNotThrow(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-08-12T12:00:00.000Z' } })
  );

  // Valid instant with a non-UTC timezone offset also passes.
  assert.doesNotThrow(
    () => validateAzureFragment({ ...base, source: { ...base.source, capturedAt: '2026-08-12T13:00:00+01:00' } })
  );
});

test('a fragment with a numeric capturedAt is rejected as malformed without aborting assembly', () => {
  const input = fragments();
  // Add an extra fragment that is otherwise valid but has a non-string capturedAt.
  input.push({
    schemaVersion: '1.0',
    source: { adapter: 'clock-broken', credentialContext: 'ctx', capturedAt: 99999 },
    capabilities: {
      identity: complete({
        pullRequestId: raw.pullRequest.pullRequestId,
        url: `${raw.pullRequest.repository.webUrl}/pullrequest/${raw.pullRequest.pullRequestId}`,
        repository: raw.pullRequest.repository
      })
    }
  });

  const packet = assembleAzureFragments(input);
  assert.equal(packet.pullRequest.number, 77);
  const rejected = packet.providerData.access.rejectedFragments;
  assert.ok(rejected.some(entry => entry.source?.adapter === 'clock-broken'), 'bad-timestamp fragment must appear in rejectedFragments');
  const entry = rejected.find(e => e.source?.adapter === 'clock-broken');
  assert.equal(entry.failure.category, 'malformed');
  assert.match(entry.failure.message, /RFC 3339 date-time string/);
});

test('equal-authority tie-break uses capturedAt lexicographic order without crashing', () => {
  const pr = raw.pullRequest;
  const earlier = '2026-08-12T11:00:00.000Z';
  const later   = '2026-08-12T13:00:00.000Z';

  // Two azure-rest fragments: both authoritative, same capability, different capturedAt.
  const fragmentA = {
    schemaVersion: '1.0',
    source: { adapter: 'azure-rest', credentialContext: 'ctx-a', capturedAt: earlier },
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
        repository: pr.repository
      }),
      metadata: complete({
        title: pr.title,
        description: 'from A',
        createdBy: pr.createdBy,
        status: 'active',
        isDraft: false,
        sourceRefName: pr.sourceRefName,
        targetRefName: pr.targetRefName,
        reviewers: []
      }),
      snapshot: complete({
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        lastMergeTargetCommit: pr.lastMergeTargetCommit
      }),
      workItems: complete(raw.workItems),
      policies: complete({ value: raw.policies, exhausted: true }),
      iterations: complete(raw.iterations),
      changes: complete(raw.changes),
      existingThreads: complete(raw.existingThreads)
    }
  };
  const fragmentB = {
    schemaVersion: '1.0',
    source: { adapter: 'azure-rest', credentialContext: 'ctx-b', capturedAt: later },
    capabilities: {
      metadata: complete({
        title: pr.title,
        description: 'from B',
        createdBy: pr.createdBy,
        status: 'active',
        isDraft: false,
        sourceRefName: pr.sourceRefName,
        targetRefName: pr.targetRefName,
        reviewers: []
      })
    }
  };
  const diffFrag = fragments().find(f => f.source.adapter === 'local-git');

  const packet = assembleAzureFragments([fragmentA, fragmentB, diffFrag]);
  // The later capturedAt wins for metadata — 'from B' was captured more recently.
  assert.equal(packet.pullRequest.description, 'from B');
  assert.equal(packet.providerData.access.capabilities.metadata.credentialContext, 'ctx-b');
});

test('a diff fragment must declare repository, baseSha, headSha, and patch, not a bare string', () => {
  const input = fragments();
  const diffFragment = input.find(fragment => fragment.source.adapter === 'local-git');
  diffFragment.capabilities.diff = complete(raw.diff);
  assert.throws(
    () => assembleAzureFragments(input),
    /Azure capability diff needs an object with repository, baseSha, headSha, and patch/
  );
});

test('a diff fragment missing baseSha or headSha fails shape validation', () => {
  const pr = raw.pullRequest;
  const input = fragments();
  const diffFragment = input.find(fragment => fragment.source.adapter === 'local-git');
  diffFragment.capabilities.diff = complete({
    repository: pr.repository,
    baseSha: '',
    headSha: pr.lastMergeSourceCommit.commitId,
    patch: raw.diff
  });
  assert.throws(
    () => assembleAzureFragments(input),
    /Azure capability diff needs a non-empty baseSha/
  );
});

test('a bound diff fragment composes into the packet when its repository and SHAs agree', () => {
  const packet = assembleAzureFragments(fragments());
  assert.equal(packet.providerData.access.capabilities.diff.adapter, 'local-git');
  assert.ok(packet.files.some(file => file.patch?.includes('email TEXT NOT NULL')));
});

test('a diff fragment from a different repository is rejected before normalization', () => {
  const pr = raw.pullRequest;
  const input = fragments();
  const diffFragment = input.find(fragment => fragment.source.adapter === 'local-git');
  diffFragment.capabilities.diff = complete({
    repository: { id: 'unrelated-repo-guid', name: 'other-repo', project: { id: pr.repository.project.id } },
    baseSha: pr.lastMergeTargetCommit.commitId,
    headSha: pr.lastMergeSourceCommit.commitId,
    patch: raw.diff
  });
  assert.throws(() => assembleAzureFragments(input), /Conflicting Azure PR identity/);
});

test('a diff fragment whose head SHA disagrees with the snapshot is rejected before normalization', () => {
  const pr = raw.pullRequest;
  const input = fragments();
  const diffFragment = input.find(fragment => fragment.source.adapter === 'local-git');
  diffFragment.capabilities.diff = complete({
    repository: pr.repository,
    baseSha: pr.lastMergeTargetCommit.commitId,
    headSha: 'ffffffffffffffffffffffffffffffffffffffff',
    patch: raw.diff
  });
  assert.throws(() => assembleAzureFragments(input), /Conflicting Azure head SHA/);
});

test('a diff fragment whose base SHA disagrees with the snapshot is rejected before normalization', () => {
  const pr = raw.pullRequest;
  const input = fragments();
  const diffFragment = input.find(fragment => fragment.source.adapter === 'local-git');
  diffFragment.capabilities.diff = complete({
    repository: pr.repository,
    baseSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    headSha: pr.lastMergeSourceCommit.commitId,
    patch: raw.diff
  });
  assert.throws(() => assembleAzureFragments(input), /Conflicting Azure base SHA/);
});

test('the CLI-directory fast path produces a diff fragment bound to repository and snapshot SHAs', async () => {
  const pr = structuredClone(raw.pullRequest);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'azure-raw-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(pr));
    await writeFile(path.join(dir, 'work-items.json'), JSON.stringify(raw.workItems));
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));
    await writeFile(path.join(dir, 'iterations.json'), JSON.stringify(raw.iterations));
    await writeFile(path.join(dir, 'changes.json'), JSON.stringify(raw.changes));
    await writeFile(path.join(dir, 'threads.json'), JSON.stringify(raw.existingThreads));
    await writeFile(path.join(dir, 'diff.patch'), raw.diff);

    const fragment = await fragmentFromRawDirectory(dir, { adapter: 'azure-cli', credentialContext: 'current-environment' });

    assert.equal(fragment.capabilities.diff.data.patch, raw.diff);
    assert.equal(fragment.capabilities.diff.data.baseSha, pr.lastMergeTargetCommit.commitId);
    assert.equal(fragment.capabilities.diff.data.headSha, pr.lastMergeSourceCommit.commitId);
    assert.deepEqual(fragment.capabilities.diff.data.repository, pr.repository);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the standalone capability CLI mode binds a local-git diff to its repository and SHAs', async () => {
  const pr = raw.pullRequest;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'azure-diff-cli-'));
  try {
    const repositoryJson = path.join(dir, 'repository.json');
    const diffPatch = path.join(dir, 'diff.patch');
    const fragmentJson = path.join(dir, 'fragment.json');
    await writeFile(repositoryJson, JSON.stringify(pr.repository));
    await writeFile(diffPatch, raw.diff);

    const result = spawnSync(process.execPath, [
      path.join(root, 'skills/review-pull-request/scripts/assemble-azure-context.mjs'),
      'capability',
      'local-git',
      'configured-origin',
      'diff',
      repositoryJson,
      pr.lastMergeTargetCommit.commitId,
      pr.lastMergeSourceCommit.commitId,
      diffPatch,
      fragmentJson
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(fragment.capabilities.diff.data.patch, raw.diff);
    assert.equal(fragment.capabilities.diff.data.baseSha, pr.lastMergeTargetCommit.commitId);
    assert.equal(fragment.capabilities.diff.data.headSha, pr.lastMergeSourceCommit.commitId);
    assert.deepEqual(fragment.capabilities.diff.data.repository, pr.repository);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import {
  authorizationForMode,
  AZURE_DEVOPS_RESOURCE,
  collectAzureDevOpsRest,
  failedAzureRestFragment,
  pagedIterationChanges,
  pagedPolicyEvaluations,
  requestJson
} from '../skills/review-pull-request/scripts/collect-azure-devops-rest.mjs';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('REST collection captures all provider capabilities and pages iteration changes', async () => {
  const pr = structuredClone(raw.pullRequest);
  const calls = [];
  const fetchImpl = async url => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/_apis/git/pullrequests/77?')) return jsonResponse(pr);
    if (value.includes('/workitems?')) return jsonResponse({ value: [{ id: '901' }] });
    if (value.includes('/_apis/wit/workitems/901?')) return jsonResponse(raw.workItems[0]);
    if (value.includes('/_apis/policy/evaluations?')) return jsonResponse({ value: raw.policies });
    if (value.includes('/iterations?')) return jsonResponse(raw.iterations);
    if (value.includes('/iterations/2/changes?') && value.includes('%24skip=0')) {
      return jsonResponse({
        changeEntries: [raw.changes.changeEntries[0]],
        nextSkip: 1,
        nextTop: 2000
      });
    }
    if (value.includes('/iterations/2/changes?') && value.includes('%24skip=1')) {
      return jsonResponse({ changeEntries: [], nextSkip: 0, nextTop: 0 });
    }
    if (value.includes('/threads?')) return jsonResponse(raw.existingThreads);
    return jsonResponse({ message: `Unexpected URL ${value}` }, 404);
  };

  const fragment = await collectAzureDevOpsRest({
    prUrl: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    credentialContext: 'anonymous',
    authorization: null,
    fetchImpl,
    sleep: async () => {}
  });

  for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'existingThreads']) {
    assert.equal(fragment.capabilities[name].complete, true, name);
  }
  assert.equal(fragment.capabilities.metadata.data.description, raw.pullRequest.description);
  assert.equal(fragment.capabilities.workItems.data[0].id, 901);
  assert.equal(fragment.capabilities.policies.data.exhausted, true);
  assert.equal(fragment.capabilities.changes.data.changeEntries.length, 1);
  assert.equal(fragment.capabilities.changes.data.nextSkip, 0);
  assert.equal(fragment.capabilities.changes.data.nextTop, 0);
  assert.ok(calls.some(url => url.includes('%24skip=1')));
  assert.equal(fragment.capabilities.diff, undefined);
});

assert.equal(AZURE_DEVOPS_RESOURCE, '499b84ac-1321-427f-aa17-267ca6975798');

test('REST rejects a repeated iteration-change cursor instead of accepting a partial list', async () => {
  let calls = 0;
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => {
        calls += 1;
        return {
          changeEntries: [],
          nextSkip: 100,
          nextTop: 100
        };
      }
    ),
    /repeated Azure iteration-change cursor/
  );
  assert.equal(calls, 2);
});

test('REST rejects a multi-step iteration-change cursor cycle (A→B→A)', async () => {
  // Cursors alternate: 100:100, 200:100, 100:100, ... — never immediately repeated.
  // The old single-value guard would not catch this; a Set must.
  const cursors = [
    { nextSkip: 100, nextTop: 100 },
    { nextSkip: 200, nextTop: 100 },
    { nextSkip: 100, nextTop: 100 }
  ];
  let calls = 0;
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => {
        const response = cursors[Math.min(calls, cursors.length - 1)];
        calls += 1;
        return { changeEntries: [], ...response };
      }
    ),
    /repeated Azure iteration-change cursor/
  );
  assert.equal(calls, 3);
});

test('REST rejects an iteration-change page with no changeEntries field', async () => {
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => ({ nextSkip: 0, nextTop: 0 })
    ),
    /changes page missing changeEntries array/
  );
});

test('REST rejects an iteration-change page where changeEntries is not an array', async () => {
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => ({ changeEntries: null, nextSkip: 0, nextTop: 0 })
    ),
    /changes page missing changeEntries array/
  );
});

test('REST rejects an iteration-change page with null pagination fields', async () => {
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => ({ changeEntries: [], nextSkip: null, nextTop: null })
    ),
    /changes page has invalid pagination fields/
  );
});

test('REST rejects an iteration-change page with string pagination fields', async () => {
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => ({ changeEntries: [], nextSkip: '100', nextTop: '2000' })
    ),
    /changes page has invalid pagination fields/
  );
});

test('REST rejects an iteration-change page with a negative pagination field', async () => {
  await assert.rejects(
    () => pagedIterationChanges(
      'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
      2,
      async () => ({ changeEntries: [], nextSkip: -1, nextTop: 2000 })
    ),
    /changes page has invalid pagination fields/
  );
});

test('REST accepts a valid empty first iteration-change page and returns zero entries', async () => {
  const result = await pagedIterationChanges(
    'https://dev.azure.com/acme/project/_apis/git/repositories/repo/pullRequests/77',
    2,
    async () => ({ changeEntries: [], nextSkip: 0, nextTop: 0 })
  );
  assert.deepEqual(result, { changeEntries: [], nextSkip: 0, nextTop: 0 });
});

test('REST keeps sibling capabilities complete when iteration-change page is malformed', async () => {
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/_apis/git/pullrequests/77?')) return jsonResponse(structuredClone(raw.pullRequest));
    if (value.includes('/workitems?')) return jsonResponse({ value: [] });
    if (value.includes('/_apis/policy/evaluations?')) return jsonResponse({ value: [] });
    if (value.includes('/iterations?')) return jsonResponse(raw.iterations);
    if (value.includes('/iterations/2/changes?')) return jsonResponse({ nextSkip: 0, nextTop: 0 }); // missing changeEntries
    if (value.includes('/threads?')) return jsonResponse({ value: [] });
    return jsonResponse({}, 404);
  };

  const fragment = await collectAzureDevOpsRest({
    prUrl: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    credentialContext: 'anonymous',
    authorization: null,
    fetchImpl,
    sleep: async () => {}
  });

  assert.equal(fragment.capabilities.changes.complete, false);
  assert.equal(fragment.capabilities.changes.failure.category, 'malformed');
  for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'existingThreads']) {
    assert.equal(fragment.capabilities[name].complete, true, `sibling capability ${name} must remain complete`);
  }
});

test('REST rejects a multi-step policy-evaluation page cycle (A→B→A)', async () => {
  // Two distinct 100-item pages alternate; the old single-value guard misses the revisit.
  const pageA = Array.from({ length: 100 }, (_, i) => ({ evaluationId: `a${i}` }));
  const pageB = Array.from({ length: 100 }, (_, i) => ({ evaluationId: `b${i}` }));
  const pages = [pageA, pageB, pageA];
  let calls = 0;
  await assert.rejects(
    () => pagedPolicyEvaluations(
      'https://dev.azure.com/acme/project',
      'vstfs:///CodeReview/CodeReviewId/project-guid/77',
      async () => {
        const page = pages[Math.min(calls, pages.length - 1)];
        calls += 1;
        return { value: page };
      }
    ),
    /repeated Azure policy evaluation page/
  );
  assert.equal(calls, 3);
});

test('REST keeps independent capabilities when linked work-item details are forbidden', async () => {
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/_apis/git/pullrequests/77?')) return jsonResponse(structuredClone(raw.pullRequest));
    if (value.includes('/workitems?')) return jsonResponse({ value: [{ id: '901' }] });
    if (value.includes('/_apis/wit/workitems/901?')) return jsonResponse({ secret: 'must-not-appear' }, 403);
    if (value.includes('/_apis/policy/evaluations?')) return jsonResponse({ value: [] });
    if (value.includes('/iterations?')) return jsonResponse(raw.iterations);
    if (value.includes('/iterations/2/changes?')) return jsonResponse({ changeEntries: [], nextSkip: 0, nextTop: 0 });
    if (value.includes('/threads?')) return jsonResponse({ value: [] });
    return jsonResponse({}, 404);
  };

  const fragment = await collectAzureDevOpsRest({
    prUrl: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    credentialContext: 'anonymous',
    authorization: null,
    fetchImpl,
    sleep: async () => {}
  });

  assert.equal(fragment.capabilities.workItems.complete, false);
  assert.equal(fragment.capabilities.workItems.failure.category, 'authentication');
  assert.doesNotMatch(fragment.capabilities.workItems.failure.message, /must-not-appear/);
  assert.equal(fragment.capabilities.existingThreads.complete, true);
});

test('REST retries transient responses without exposing response bodies', async () => {
  let attempts = 0;
  const delays = [];
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) return jsonResponse({ secret: 'must-not-appear' }, 503);
    return jsonResponse({ ok: true });
  };
  const value = await requestJson('https://example.invalid', {
    authorization: ['Bearer', 'must-not-appear'].join(' '),
    operation: 'test operation',
    fetchImpl,
    sleep: async milliseconds => { delays.push(milliseconds); }
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(attempts, 3);
  // No Retry-After header means exponential backoff, never a zero-length sleep.
  assert.deepEqual(delays, [1000, 2000]);
});

test('REST uses Retry-After only when it is present, finite, and positive', async () => {
  async function delaysFor(headers) {
    let attempts = 0;
    const delays = [];
    await requestJson('https://example.invalid', {
      operation: 'test operation',
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) return jsonResponse({}, 429, headers);
        return jsonResponse({ ok: true });
      },
      sleep: async milliseconds => { delays.push(milliseconds); }
    });
    return delays;
  }

  assert.deepEqual(await delaysFor({ 'retry-after': '3' }), [3000, 3000]);
  assert.deepEqual(await delaysFor({ 'retry-after': '0' }), [1000, 2000]);
  assert.deepEqual(await delaysFor({ 'retry-after': 'later' }), [1000, 2000]);
});

test('REST reports exhausted network failures without claiming they were timeouts', async () => {
  const delays = [];
  await assert.rejects(
    () => requestJson('https://example.invalid', {
      operation: 'pull request',
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND must-not-appear'); },
      sleep: async milliseconds => { delays.push(milliseconds); }
    }),
    error => {
      assert.equal(error.category, 'transient');
      assert.doesNotMatch(error.message, /^pull request timed out/);
      assert.match(error.message, /pull request failed after 3 attempts/);
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    }
  );
  assert.deepEqual(delays, [1000, 2000]);
});

test('REST rejects a repeated policy-evaluation page instead of looping forever', async () => {
  let calls = 0;
  const page = { value: Array.from({ length: 100 }, (unused, index) => ({ evaluationId: `e${index}` })) };
  await assert.rejects(
    () => pagedPolicyEvaluations(
      'https://dev.azure.com/acme/project',
      'vstfs:///CodeReview/CodeReviewId/project-guid/77',
      async () => {
        calls += 1;
        return structuredClone(page);
      }
    ),
    /repeated Azure policy evaluation page/
  );
  assert.equal(calls, 2);
});

test('pagedPolicyEvaluations reports exhausted evidence after a genuine multi-page fetch', async () => {
  const fullPage = { value: Array.from({ length: 100 }, (unused, index) => ({ evaluationId: `full-${index}` })) };
  const shortPage = { value: [{ evaluationId: 'last' }] };
  let calls = 0;
  const result = await pagedPolicyEvaluations(
    'https://dev.azure.com/acme/project',
    'vstfs:///CodeReview/CodeReviewId/project-guid/77',
    async () => {
      calls += 1;
      return calls === 1 ? structuredClone(fullPage) : structuredClone(shortPage);
    }
  );
  assert.equal(calls, 2);
  assert.equal(result.exhausted, true);
  assert.equal(result.value.length, 101);
});

test('an empty policy-evaluation result is exhausted evidence, not missing data', async () => {
  const result = await pagedPolicyEvaluations(
    'https://dev.azure.com/acme/project',
    'vstfs:///CodeReview/CodeReviewId/project-guid/77',
    async () => ({ value: [] })
  );
  assert.deepEqual(result, { value: [], exhausted: true });
});

test('a hand-built fragment cannot mark policies complete without exhausted evidence', () => {
  const input = fragments();
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  rest.capabilities.policies = complete(raw.policies);
  assert.throws(
    () => assembleAzureFragments(input),
    /Azure capability policies needs an object with a value array/
  );
});

test('a hand-built fragment cannot mark policies complete with exhausted=false', () => {
  const input = fragments();
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  rest.capabilities.policies = complete({ value: raw.policies, exhausted: false });
  assert.throws(
    () => assembleAzureFragments(input),
    /Azure capability policies needs exhausted=true evidence that pagination ended/
  );
});

test('an adapter-produced policies capability without exhausted evidence downgrades to malformed and fails the read gate', () => {
  const capabilities = downgradeMalformedCapabilities({ policies: complete(raw.policies) });
  assert.equal(capabilities.policies.complete, false);
  assert.equal(capabilities.policies.failure.category, 'malformed');
  assert.match(capabilities.policies.failure.message, /Azure capability policies needs an object with a value array/);

  const input = fragments();
  const rest = input.find(fragment => fragment.source.adapter === 'azure-rest');
  rest.capabilities.policies = capabilities.policies;
  assert.throws(
    () => assembleAzureFragments(input),
    /Incomplete Azure DevOps context: policies/
  );
});

test('one malformed REST capability is downgraded without discarding the others', async () => {
  const pr = structuredClone(raw.pullRequest);
  pr.lastMergeSourceCommit = { commitId: '' };
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/_apis/git/pullrequests/77?')) return jsonResponse(pr);
    if (value.includes('/workitems?')) return jsonResponse({ value: [{ id: '901' }] });
    if (value.includes('/_apis/wit/workitems/901?')) return jsonResponse(raw.workItems[0]);
    if (value.includes('/_apis/policy/evaluations?')) return jsonResponse({ value: raw.policies });
    if (value.includes('/iterations?')) return jsonResponse(raw.iterations);
    if (value.includes('/iterations/2/changes?')) return jsonResponse({ changeEntries: [], nextSkip: 0, nextTop: 0 });
    if (value.includes('/threads?')) return jsonResponse(raw.existingThreads);
    return jsonResponse({}, 404);
  };

  const fragment = await collectAzureDevOpsRest({
    prUrl: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    credentialContext: 'anonymous',
    authorization: null,
    fetchImpl,
    sleep: async () => {}
  });

  assert.equal(fragment.capabilities.snapshot.complete, false);
  assert.equal(fragment.capabilities.snapshot.failure.category, 'malformed');
  assert.match(fragment.capabilities.snapshot.failure.message, /lastMergeSourceCommit/);
  assert.doesNotMatch(fragment.capabilities.snapshot.failure.message, /[\r\n]/);
  for (const name of ['identity', 'metadata', 'workItems', 'policies', 'iterations', 'changes', 'existingThreads']) {
    assert.equal(fragment.capabilities[name].complete, true, name);
  }
});

test('REST authentication failures are sanitized and not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    () => requestJson('https://example.invalid', {
      authorization: 'Basic must-not-appear',
      operation: 'pull request threads',
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse({ token: 'must-not-appear' }, 401);
      },
      sleep: async () => {}
    }),
    error => {
      assert.equal(error.category, 'authentication');
      assert.equal(error.message, 'HTTP 401 from pull request threads');
      assert.doesNotMatch(error.message, /must-not-appear/);
      return true;
    }
  );
  assert.equal(attempts, 1);
});

test('credential acquisition failure becomes a sanitized incomplete fragment', () => {
  const error = Object.assign(new Error('AZURE_DEVOPS_EXT_PAT is not configured'), {
    category: 'tool-unavailable'
  });
  const fragment = failedAzureRestFragment('pat', error);
  assert.equal(fragment.capabilities.identity.complete, false);
  assert.equal(fragment.capabilities.existingThreads.failure.category, 'tool-unavailable');
  assert.equal(fragment.capabilities.existingThreads.failure.message, 'AZURE_DEVOPS_EXT_PAT is not configured');
});

test('failure CLI mode rejects an unknown capability name', () => {
  // Simulate what the failure CLI mode builds before calling validateAzureFragment.
  const badName = 'unknownCapability';
  const fragment = {
    schemaVersion: '1.0',
    source: source('test-adapter'),
    capabilities: {
      [badName]: { complete: false, failure: { category: 'tool-unavailable', message: 'not available' } }
    }
  };
  assert.throws(() => validateAzureFragment(fragment), /Unknown Azure capability: unknownCapability/);
});

test('Azure CLI collector routes its complete raw directory through the access assembler', async () => {
  const collector = await readFile(
    path.join(root, 'skills/review-pull-request/scripts/collect-azure-devops.sh'),
    'utf8'
  );
  assert.match(collector, /assemble-azure-context\.mjs" directory/);
  assert.match(collector, /PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment/);
  assert.doesNotMatch(collector, /normalize-context\.mjs" \\\n\s+--provider azure-devops/);
});

test('identity fragments from the same organization pass the agreement check', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  const second = {
    schemaVersion: '1.0',
    source: source('second-adapter'),
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
        repository: pr.repository
      })
    }
  };
  input.push(second);
  // Both identity fragments resolve to the same org — no conflict.
  assert.doesNotThrow(() => assembleAzureFragments(input));
});

test('identity fragments from different organizations fail closed', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  input.push({
    schemaVersion: '1.0',
    source: source('cross-org-adapter'),
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: 'https://dev.azure.com/contoso/Platform/_git/widgets/pullrequest/77',
        repository: { ...pr.repository, webUrl: 'https://dev.azure.com/contoso/Platform/_git/widgets' }
      })
    }
  });
  assert.throws(() => assembleAzureFragments(input), /Conflicting Azure organization/);
});

test('dev.azure.com and visualstudio.com URL forms for the same org are treated as equivalent', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  // Replace the identity URL in the first fragment with the legacy visualstudio.com form.
  input[0].capabilities.identity = complete({
    pullRequestId: pr.pullRequestId,
    url: 'https://acme.visualstudio.com/Platform/_git/widgets/pullrequest/77',
    repository: pr.repository
  });
  // The second identity (from the fixture) uses dev.azure.com/acme — same org slug.
  assert.doesNotThrow(() => assembleAzureFragments(input));
});

test('mixed-case dev.azure.com org slugs are treated as equivalent', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  // First fragment uses the mixed-case slug "Acme".
  input[0].capabilities.identity = complete({
    pullRequestId: pr.pullRequestId,
    url: 'https://dev.azure.com/Acme/Platform/_git/widgets/pullrequest/77',
    repository: pr.repository
  });
  // Second identity fragment (pushed below) uses lowercase "acme".
  input.push({
    schemaVersion: '1.0',
    source: source('second-adapter'),
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
        repository: pr.repository
      })
    }
  });
  assert.doesNotThrow(() => assembleAzureFragments(input));
});

test('mixed-case visualstudio.com and dev.azure.com slugs are treated as equivalent', () => {
  const pr = raw.pullRequest;
  const input = structuredClone(fragments());
  // First fragment uses the uppercase legacy form "ACME.visualstudio.com".
  input[0].capabilities.identity = complete({
    pullRequestId: pr.pullRequestId,
    url: 'https://ACME.visualstudio.com/Platform/_git/widgets/pullrequest/77',
    repository: pr.repository
  });
  // Second identity fragment uses dev.azure.com/acme — lowercase.
  input.push({
    schemaVersion: '1.0',
    source: source('second-adapter'),
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
        repository: pr.repository
      })
    }
  });
  assert.doesNotThrow(() => assembleAzureFragments(input));
});

test('CLI-sourced policies carry exhausted evidence because az has no partial-list mode', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-raw-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));
    await writeFile(path.join(dir, 'work-items.json'), JSON.stringify(raw.workItems));
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));
    await writeFile(path.join(dir, 'iterations.json'), JSON.stringify(raw.iterations));
    await writeFile(path.join(dir, 'changes.json'), JSON.stringify(raw.changes));
    await writeFile(path.join(dir, 'threads.json'), JSON.stringify(raw.existingThreads));
    await writeFile(path.join(dir, 'diff.patch'), raw.diff);

    const fragment = await fragmentFromRawDirectory(dir, { adapter: 'azure-cli', credentialContext: 'current-environment' });
    assert.deepEqual(fragment.capabilities.policies.data, { value: raw.policies, exhausted: true });
    validateAzureFragment(fragment);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REST marks workItems incomplete when linked-items list response is not a value array', async () => {
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/_apis/git/pullrequests/77?')) return jsonResponse(structuredClone(raw.pullRequest));
    if (value.includes('/workitems?')) return jsonResponse({ unexpected: true });
    if (value.includes('/_apis/policy/evaluations?')) return jsonResponse({ value: [] });
    if (value.includes('/iterations?')) return jsonResponse(raw.iterations);
    if (value.includes('/iterations/2/changes?')) return jsonResponse({ changeEntries: [], nextSkip: 0, nextTop: 0 });
    if (value.includes('/threads?')) return jsonResponse({ value: [] });
    return jsonResponse({}, 404);
  };

  const fragment = await collectAzureDevOpsRest({
    prUrl: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    credentialContext: 'anonymous',
    authorization: null,
    fetchImpl,
    sleep: async () => {}
  });

  assert.equal(fragment.capabilities.workItems.complete, false);
  assert.equal(fragment.capabilities.workItems.failure.category, 'malformed');
  assert.match(fragment.capabilities.workItems.failure.message, /linked work items/);
  for (const name of ['identity', 'metadata', 'snapshot', 'policies', 'iterations', 'changes', 'existingThreads']) {
    assert.equal(fragment.capabilities[name].complete, true, name);
  }
});

test('REST marks policies incomplete when a policy-evaluations page is not a value array', async () => {
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/_apis/git/pullrequests/77?')) return jsonResponse(structuredClone(raw.pullRequest));
    if (value.includes('/workitems?')) return jsonResponse({ value: [] });
    if (value.includes('/_apis/policy/evaluations?')) return jsonResponse({ unexpected: true });
    if (value.includes('/iterations?')) return jsonResponse(raw.iterations);
    if (value.includes('/iterations/2/changes?')) return jsonResponse({ changeEntries: [], nextSkip: 0, nextTop: 0 });
    if (value.includes('/threads?')) return jsonResponse({ value: [] });
    return jsonResponse({}, 404);
  };

  const fragment = await collectAzureDevOpsRest({
    prUrl: 'https://dev.azure.com/acme/Platform/_git/widgets/pullrequest/77',
    credentialContext: 'anonymous',
    authorization: null,
    fetchImpl,
    sleep: async () => {}
  });

  assert.equal(fragment.capabilities.policies.complete, false);
  assert.equal(fragment.capabilities.policies.failure.category, 'malformed');
  assert.match(fragment.capabilities.policies.failure.message, /policy evaluations page/);
  for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'iterations', 'changes', 'existingThreads']) {
    assert.equal(fragment.capabilities[name].complete, true, name);
  }
});

test('a missing-capability assembly failure exposes selected capabilities alongside missing ones', () => {
  const partial = fragments().filter(fragment => fragment.source.adapter !== 'azure-rest');
  assert.throws(() => assembleAzureFragments(partial), error => {
    assert.deepEqual(
      error.missingCapabilities,
      ['changes', 'existingThreads', 'iterations', 'policies', 'snapshot', 'workItems']
    );
    assert.deepEqual(Object.keys(error.selectedCapabilities).sort(), ['diff', 'identity', 'metadata']);
    assert.equal(error.selectedCapabilities.identity.adapter, 'bluebird');
    assert.equal(error.selectedCapabilities.metadata.adapter, 'bluebird');
    assert.equal(error.selectedCapabilities.diff.adapter, 'local-git');
    assert.ok(Array.isArray(error.attempts) && error.attempts.length > 0);
    assert.deepEqual(error.rejectedFragments, []);
    return true;
  });
});

test('rejected fragments surface on a failed assembly, not only on a successful one', () => {
  const partial = fragments().filter(fragment => fragment.source.adapter !== 'azure-rest');
  partial.push({ source: { adapter: 'broken-adapter', credentialContext: 'configured', capturedAt } });
  assert.throws(() => assembleAzureFragments(partial), error => {
    assert.equal(error.rejectedFragments.length, 1);
    assert.equal(error.rejectedFragments[0].source.adapter, 'broken-adapter');
    assert.equal(error.rejectedFragments[0].failure.category, 'malformed');
    assert.ok(error.rejectedFragments[0].failure.message.length > 0);
    return true;
  });
});

test('a failed-assembly error never carries raw capability data or credential material', () => {
  const partial = fragments().filter(fragment => fragment.source.adapter !== 'azure-rest');
  assert.throws(() => assembleAzureFragments(partial), error => {
    for (const capabilitySource of Object.values(error.selectedCapabilities)) {
      assert.deepEqual(Object.keys(capabilitySource).sort(), ['adapter', 'capturedAt', 'credentialContext']);
    }
    for (const attempt of error.attempts) {
      assert.deepEqual(Object.keys(attempt).sort(), ['capability', 'complete', 'failure', 'source']);
      assert.deepEqual(Object.keys(attempt.source).sort(), ['adapter', 'capturedAt', 'credentialContext']);
    }
    return true;
  });
});

test('packet CLI mode writes a sanitized assembled:false failure artifact when capabilities are missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-packet-fail-'));
  try {
    const partial = fragments().filter(fragment => fragment.source.adapter !== 'azure-rest');
    const fragmentPaths = await Promise.all(partial.map(async (fragment, index) => {
      const file = path.join(dir, `fragment-${index}.json`);
      await writeFile(file, JSON.stringify(fragment));
      return file;
    }));
    const packetJson = path.join(dir, 'packet.json');

    const result = spawnSync(process.execPath, [
      path.join(root, 'skills/review-pull-request/scripts/assemble-azure-context.mjs'),
      'packet',
      packetJson,
      ...fragmentPaths
    ], { encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incomplete Azure DevOps context/);
    assert.match(result.stderr, /failure artifact: /);
    assert.match(result.stderr, new RegExp(path.basename(packetJson)));

    const artifact = JSON.parse(await readFile(packetJson, 'utf8'));
    assert.equal(artifact.provider, 'azure-devops');
    assert.equal(artifact.assembled, false);
    assert.deepEqual(
      artifact.missingCapabilities,
      ['changes', 'existingThreads', 'iterations', 'policies', 'snapshot', 'workItems']
    );
    assert.ok(Array.isArray(artifact.attempts) && artifact.attempts.length > 0);
    assert.deepEqual(Object.keys(artifact.selectedCapabilities).sort(), ['diff', 'identity', 'metadata']);
    assert.deepEqual(artifact.rejectedFragments, []);
    assert.equal(JSON.stringify(artifact).includes('"data"'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('authorizationForMode(entra) reports a sanitized transient timeout instead of hanging', async () => {
  const hangingExecFileImpl = () => new Promise(() => {
    // Never resolves — simulates a stalled `az account get-access-token`. If
    // authorizationForMode did not bound this call, this test would hang forever.
  });
  await assert.rejects(
    () => authorizationForMode('entra', {
      env: { PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS: '50' },
      execFileImpl: hangingExecFileImpl
    }),
    error => {
      assert.equal(error.category, 'transient');
      assert.match(error.message, /timed out after 50ms/);
      return true;
    }
  );
});

test('authorizationForMode(entra) still reports authentication failure for a real rejection', async () => {
  const failingExecFileImpl = async () => {
    throw new Error('az: command not found');
  };
  await assert.rejects(
    () => authorizationForMode('entra', {
      env: { PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS: '5000' },
      execFileImpl: failingExecFileImpl
    }),
    error => {
      assert.equal(error.category, 'authentication');
      return true;
    }
  );
});

test('authorizationForMode(entra) uses a sane default deadline when unset', async () => {
  const fastExecFileImpl = async () => ({ stdout: 'token-value\n' });
  const authorization = await authorizationForMode('entra', {
    env: {},
    execFileImpl: fastExecFileImpl
  });
  assert.equal(authorization, 'Bearer token-value');
});
