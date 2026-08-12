import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assembleAzureFragments,
  REQUIRED_AZURE_CAPABILITIES
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
