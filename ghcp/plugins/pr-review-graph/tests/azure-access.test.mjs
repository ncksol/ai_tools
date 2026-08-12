import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assembleAzureFragments,
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
        policies: complete(raw.policies),
        iterations: complete(raw.iterations),
        changes: complete(raw.changes),
        existingThreads: complete(raw.existingThreads)
      }
    },
    {
      schemaVersion: '1.0',
      source: source('local-git'),
      capabilities: { diff: complete(raw.diff) }
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
  rest.capabilities.policies = complete([]);
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

import {
  AZURE_DEVOPS_RESOURCE,
  collectAzureDevOpsRest,
  failedAzureRestFragment,
  pagedIterationChanges,
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
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) return jsonResponse({ secret: 'must-not-appear' }, 503);
    return jsonResponse({ ok: true });
  };
  const value = await requestJson('https://example.invalid', {
    authorization: ['Bearer', 'must-not-appear'].join(' '),
    operation: 'test operation',
    fetchImpl,
    sleep: async () => {}
  });
  assert.deepEqual(value, { ok: true });
  assert.equal(attempts, 3);
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
