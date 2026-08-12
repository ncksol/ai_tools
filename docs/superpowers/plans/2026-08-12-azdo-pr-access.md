# Azure DevOps PR Access Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `review-pull-request` assemble a complete Azure DevOps review packet from every available deterministic access route instead of stopping when one `az` credential context fails.

**Architecture:** Keep `collect-azure-devops.sh` as the complete CLI fast path, but route its raw bundle through a new capability-fragment assembler that records provenance and rejects incomplete or conflicting input. Add a direct REST collector for anonymous, existing PAT, and existing Entra credentials; let the skill compose its fragments with optional Bluebird metadata and local Git diff fragments, while preserving the existing canonical packet and review graph.

**Tech Stack:** Node.js >= 18 ES modules and built-in `fetch`, Bash 3.2-compatible shell, Azure DevOps REST API 7.1, Azure CLI/Azure DevOps extension, optional Bluebird MCP tools, `node --test`. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-azdo-pr-access-design.md`

## Global Constraints

- Run plugin tests from `ghcp/plugins/pr-review-graph`: `npm test` and `npm run validate`.
- Node.js >= 18, ES modules only, Node built-ins only. Do not add a package dependency.
- Shell changes must remain valid on stock macOS Bash 3.2; the existing lint rejects Bash 4-only syntax.
- All review packets, raw responses, fragments, and auth-attempt diagnostics stay under a `mktemp -d` directory outside the repository and are removed by a trap.
- Never install Azure CLI or extensions, start interactive authentication, request a PAT, or mutate `az devops` defaults.
- Never write or print a PAT or Entra access token. Authentication errors contain only the adapter, credential-context label, operation, and sanitized status.
- Browser/UI scraping is not an Azure DevOps access fallback.
- Code search and local Git cannot independently satisfy the Azure DevOps provider contract.
- A review starts only after identity, metadata, snapshot, work items, policies, iterations, changes, existing threads, and diff capabilities are complete.
- Complete reads may reach preview without a write route. Publishing still requires explicit user confirmation and a fresh head recheck.
- `plugin.json` and the root marketplace entry end at version `0.3.0`; leave `package.json` at its current version because it is not the plugin marketplace version.
- Commit messages must not contain a `Co-authored-by` trailer or any AI attribution trailer.
- Work on the current branch, `nicksologoub-microsoft-azdo-pr-access-fallbacks`.

## File Structure

| File | Responsibility |
| --- | --- |
| `skills/review-pull-request/references/azure-access-fragment.schema.json` | Documents the capability-fragment contract shared by CLI, REST, Bluebird, and Git sources |
| `skills/review-pull-request/scripts/assemble-azure-context.mjs` | Validates fragments, rejects incomplete/conflicting context, emits the canonical Azure packet, and records provenance |
| `skills/review-pull-request/scripts/collect-azure-devops-rest.mjs` | Reads Azure DevOps REST endpoints using one existing credential context and emits a fragment without exposing credentials |
| `skills/review-pull-request/scripts/collect-azure-devops.sh` | Remains the CLI fast path; its final raw directory now enters the common assembler |
| `tests/azure-access.test.mjs` | Focused unit and CLI tests for fragment composition, REST paging/retries, redaction, and CLI integration |
| `skills/review-pull-request/SKILL.md` | Orchestrates credential retries and per-capability fallback instead of treating CLI failure as terminal |
| `skills/review-pull-request/references/azure-devops-cli-provider.md` | Exact adapter recipes, Bluebird limits, completeness rules, head recheck, and preview-only fallback |
| `scripts/validate-plugin.mjs` | Requires the new scripts/schema and the optional-MCP access language |
| `README.md`, `plugin.json`, `.github/plugin/marketplace.json` | User-facing access model and matching `0.3.0` package metadata |

---

### Task 1: Define and enforce the Azure capability-fragment contract

**Files:**
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-access-fragment.schema.json`
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs`
- Create: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Produces: `REQUIRED_AZURE_CAPABILITIES`, `validateAzureFragment(fragment)`, `assembleAzureFragments(fragments)`, and `fragmentFromRawDirectory(directory, source)` from `assemble-azure-context.mjs`.
- Produces CLI modes:
  - `node assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON>`
  - `node assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>`
  - `node assemble-azure-context.mjs failure <ADAPTER> <CREDENTIAL_CONTEXT> <CATEGORY> <MESSAGE> <CAPABILITIES_CSV> <FRAGMENT_JSON>`
  - `node assemble-azure-context.mjs packet <PACKET_JSON> <FRAGMENT_JSON>...`
- Consumes: `loadRawDirectory` and `normalize` from `normalize-context.mjs`, plus `isMain`, `readJson`, and `writeJson` from `lib.mjs`.
- Task 2 emits the fragment shape defined here. Task 3 switches the CLI collector to `directory` mode. Task 4 documents `capability` and `packet` modes.

- [ ] **Step 1: Write failing composition, incompleteness, and conflict tests**

Create `tests/azure-access.test.mjs` with the real Azure fixture and three source fragments:

```javascript
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
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test tests/azure-access.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `assemble-azure-context.mjs`.

- [ ] **Step 3: Add the fragment schema**

Create `references/azure-access-fragment.schema.json` with these exact capability names and complete/incomplete states:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://pr-review-graph.local/azure-access-fragment.schema.json",
  "title": "Azure DevOps access fragment",
  "type": "object",
  "required": ["schemaVersion", "source", "capabilities"],
  "properties": {
    "schemaVersion": { "const": "1.0" },
    "source": {
      "type": "object",
      "required": ["adapter", "credentialContext", "capturedAt"],
      "properties": {
        "adapter": { "type": "string", "minLength": 1 },
        "credentialContext": { "type": "string", "minLength": 1 },
        "capturedAt": { "type": "string", "format": "date-time" }
      },
      "additionalProperties": false
    },
    "capabilities": {
      "type": "object",
      "minProperties": 1,
      "properties": {
        "identity": { "$ref": "#/$defs/capability" },
        "metadata": { "$ref": "#/$defs/capability" },
        "snapshot": { "$ref": "#/$defs/capability" },
        "workItems": { "$ref": "#/$defs/capability" },
        "policies": { "$ref": "#/$defs/capability" },
        "iterations": { "$ref": "#/$defs/capability" },
        "changes": { "$ref": "#/$defs/capability" },
        "existingThreads": { "$ref": "#/$defs/capability" },
        "diff": { "$ref": "#/$defs/capability" }
      },
      "additionalProperties": false
    }
  },
  "$defs": {
    "capability": {
      "type": "object",
      "required": ["complete"],
      "properties": {
        "complete": { "type": "boolean" },
        "data": {},
        "failure": {
          "type": "object",
          "required": ["category", "message"],
          "properties": {
            "category": {
              "enum": [
                "tool-unavailable",
                "unsupported",
                "authentication",
                "transient",
                "malformed",
                "incomplete"
              ]
            },
            "message": { "type": "string", "minLength": 1 }
          },
          "additionalProperties": false
        }
      },
      "allOf": [
        {
          "if": { "properties": { "complete": { "const": true } } },
          "then": { "required": ["data"] }
        },
        {
          "if": { "properties": { "complete": { "const": false } } },
          "then": { "required": ["failure"] }
        }
      ],
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

- [ ] **Step 4: Implement fragment validation and assembly**

Create `scripts/assemble-azure-context.mjs`. Use the following public constants and functions; keep helper functions private:

```javascript
#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMain, readJson, writeJson } from './lib.mjs';
import { loadRawDirectory, normalize } from './normalize-context.mjs';

export const REQUIRED_AZURE_CAPABILITIES = Object.freeze([
  'identity',
  'metadata',
  'snapshot',
  'workItems',
  'policies',
  'iterations',
  'changes',
  'existingThreads',
  'diff'
]);

const RAW_FILES = Object.freeze([
  'pull-request.json',
  'work-items.json',
  'policies.json',
  'iterations.json',
  'changes.json',
  'threads.json',
  'diff.patch'
]);

export function validateAzureFragment(fragment) {
  if (fragment?.schemaVersion !== '1.0') throw new Error('Azure access fragment schemaVersion must be 1.0');
  for (const key of ['adapter', 'credentialContext', 'capturedAt']) {
    if (!String(fragment.source?.[key] ?? '').trim()) throw new Error(`Azure access fragment source.${key} is required`);
  }
  const names = Object.keys(fragment.capabilities ?? {});
  if (!names.length) throw new Error('Azure access fragment must declare at least one capability');
  for (const name of names) {
    if (!REQUIRED_AZURE_CAPABILITIES.includes(name)) throw new Error(`Unknown Azure capability: ${name}`);
    const capability = fragment.capabilities[name];
    if (typeof capability?.complete !== 'boolean') throw new Error(`Azure capability ${name} needs complete=true|false`);
    if (capability.complete) {
      if (!Object.hasOwn(capability, 'data')) throw new Error(`Complete Azure capability ${name} needs data`);
      assertCapabilityData(name, capability.data);
    }
    if (!capability.complete && !capability.failure?.category) throw new Error(`Incomplete Azure capability ${name} needs a failure`);
  }
  return fragment;
}

export function assembleAzureFragments(inputFragments) {
  const fragments = inputFragments.map(validateAzureFragment);
  assertImmutableAgreement(fragments);
  const selected = {};
  const attempts = [];

  for (const name of REQUIRED_AZURE_CAPABILITIES) {
    const candidates = [];
    for (const fragment of fragments) {
      const capability = fragment.capabilities[name];
      if (!capability) continue;
      attempts.push({ capability: name, source: fragment.source, complete: capability.complete, failure: capability.failure ?? null });
      if (capability.complete) candidates.push({ capability, source: fragment.source });
    }
    if (candidates.length) {
      candidates.sort((left, right) => left.source.capturedAt.localeCompare(right.source.capturedAt));
      selected[name] = candidates.at(-1);
    }
  }

  const missing = REQUIRED_AZURE_CAPABILITIES.filter(name => !selected[name]).sort();
  if (missing.length) {
    const blockers = missing.flatMap(name => {
      const failed = attempts.filter(attempt => attempt.capability === name && !attempt.complete);
      return failed.length
        ? failed.map(attempt =>
            `${name} <= ${attempt.source.adapter}/${attempt.source.credentialContext}: ${attempt.failure.category}: ${attempt.failure.message}`)
        : [`${name} <= no adapter produced a complete result`];
    });
    const error = new Error(
      `Incomplete Azure DevOps context: ${missing.join(', ')}\n${blockers.join('\n')}`
    );
    error.attempts = attempts;
    throw error;
  }

  const changeEntries = selected.changes.capability.data.changeEntries;
  if (changeEntries.length && !String(selected.diff.capability.data).trim()) {
    throw new Error('Incomplete Azure DevOps context: diff is empty for a non-empty change list');
  }

  const identity = selected.identity.capability.data;
  const raw = {
    provider: 'azure-devops',
    pullRequest: {
      ...identity,
      ...selected.metadata.capability.data,
      ...selected.snapshot.capability.data
    },
    workItems: selected.workItems.capability.data,
    policies: selected.policies.capability.data,
    iterations: selected.iterations.capability.data,
    changes: selected.changes.capability.data,
    existingThreads: selected.existingThreads.capability.data,
    diff: selected.diff.capability.data
  };
  const packet = normalize(raw);
  packet.providerData.access = {
    capabilities: Object.fromEntries(
      Object.entries(selected).map(([name, value]) => [name, value.source])
    ),
    attempts
  };
  return packet;
}
```

Implement `assertImmutableAgreement(fragments)` by collecting every complete identity and snapshot capability. Compare PR ID, repository ID/name, project ID/name, source commit ID, and target commit ID after string conversion. Throw `Conflicting Azure PR identity`, `Conflicting Azure head SHA`, or `Conflicting Azure base SHA` on the first disagreement.

Implement `assertCapabilityData(name, data)` with these exact semantic checks:

- `identity`: positive integer `pullRequestId`, non-empty `url`, non-empty
  repository ID or name, and non-empty project ID or name.
- `metadata`: string `title` and `description`, plus non-empty
  `sourceRefName` and `targetRefName`.
- `snapshot`: non-empty
  `lastMergeSourceCommit.commitId` and
  `lastMergeTargetCommit.commitId`.
- `workItems`, `policies`, `iterations`, and `existingThreads`: a bare array
  or an object with a `.value` array.
- `changes`: an object with a `changeEntries` array and both `nextSkip` and
  `nextTop` equal to zero. A non-zero cursor is incomplete pagination and
  throws `Complete Azure capability changes still has pagination`.
- `diff`: a string. Empty text is accepted at fragment validation because a
  no-change PR can be represented, but after selection
  `assembleAzureFragments` rejects empty diff text when the selected
  `changes.changeEntries` array is non-empty.

- [ ] **Step 5: Implement raw-directory and single-capability fragment creation**

Add these exports below the assembler:

```javascript
export async function fragmentFromRawDirectory(directory, source) {
  await Promise.all(RAW_FILES.map(file => access(path.join(directory, file))));
  const raw = await loadRawDirectory('azure-devops', directory);
  const pr = raw.pullRequest;
  return {
    schemaVersion: '1.0',
    source: { ...source, capturedAt: source.capturedAt ?? new Date().toISOString() },
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: pr._links?.web?.href ?? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
        repository: pr.repository
      }),
      metadata: complete({
        title: pr.title ?? '',
        description: pr.description ?? '',
        createdBy: pr.createdBy ?? null,
        status: pr.status ?? null,
        isDraft: Boolean(pr.isDraft),
        sourceRefName: pr.sourceRefName ?? '',
        targetRefName: pr.targetRefName ?? '',
        reviewers: pr.reviewers ?? []
      }),
      snapshot: complete({
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        lastMergeTargetCommit: pr.lastMergeTargetCommit
      }),
      workItems: complete(raw.workItems),
      policies: complete(raw.policies),
      iterations: complete(raw.iterations),
      changes: complete(raw.changes),
      existingThreads: complete(raw.existingThreads),
      diff: complete(raw.diff)
    }
  };
}

function complete(data) {
  return { complete: true, data };
}
```

Implement the four CLI modes exactly as declared in this task's Interfaces block:

- `directory` builds one complete fragment from the raw directory, assembles it, and writes the packet.
- `capability` reads JSON for every capability except `diff`, for which it reads UTF-8 text, then writes one fragment.
- `failure` writes one fragment whose named capabilities are incomplete with
  the supplied category and sanitized message. Accept `all` as the capability
  list to select every required capability.
- `packet` reads every positional fragment, assembles them, and writes the packet.

Print only the packet or fragment path and source labels; never print fragment data.

- [ ] **Step 6: Run the focused and full suites**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test tests/azure-access.test.mjs
npm test
```

Expected: PASS. The composition test produces a canonical packet whose metadata comes from Bluebird, provider collections come from REST, diff comes from Git, and access provenance names each source.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-access-fragment.schema.json \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs
git commit -m "feat(pr-review-graph): assemble Azure access fragments"
```

---

### Task 2: Add direct Azure DevOps REST collection

**Files:**
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops-rest.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: the fragment contract and `validateAzureFragment` from Task 1.
- Produces:
  - `AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'`
  - `parseAzurePullRequestUrl(value)`
  - `authorizationForMode(mode, options)`
  - `requestJson(url, options)`
  - `pagedIterationChanges(pullRoot, iterationId, get)`
  - `collectAzureDevOpsRest(options)`
  - `failedAzureRestFragment(credentialContext, error)`
- Produces CLI: `node collect-azure-devops-rest.mjs <PR_URL> <anonymous|pat|entra> <FRAGMENT_JSON>`.
- Task 4 documents one invocation per available credential context and passes every resulting fragment to the Task 1 assembler.

- [ ] **Step 1: Write the failing REST collection and change-paging test**

Append imports and a route-based fake fetch to `tests/azure-access.test.mjs`:

```javascript
import {
  AZURE_DEVOPS_RESOURCE,
  collectAzureDevOpsRest
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
```

- [ ] **Step 2: Run the focused test and verify the missing module failure**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test tests/azure-access.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `collect-azure-devops-rest.mjs`.

- [ ] **Step 3: Implement URL parsing and sanitized HTTP retries**

Create `scripts/collect-azure-devops-rest.mjs` with both supported URL shapes:

```javascript
#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMain, writeJson } from './lib.mjs';
import { validateAzureFragment } from './assemble-azure-context.mjs';

const execFileAsync = promisify(execFile);
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export function parseAzurePullRequestUrl(value) {
  const url = new URL(value);
  let organization;
  let segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.toLowerCase() === 'dev.azure.com') {
    organization = segments.shift();
  } else if (url.hostname.toLowerCase().endsWith('.visualstudio.com')) {
    organization = url.hostname.split('.')[0];
  } else {
    throw new Error('Azure DevOps PR URL must use dev.azure.com or visualstudio.com');
  }
  const gitIndex = segments.findIndex(segment => segment.toLowerCase() === '_git');
  const pullIndex = segments.findIndex(segment => segment.toLowerCase() === 'pullrequest');
  if (!organization || gitIndex < 1 || pullIndex !== gitIndex + 2 || !/^\d+$/.test(segments[pullIndex + 1] ?? '')) {
    throw new Error('Azure DevOps PR URL must identify organization, project, repository, and pull request');
  }
  const project = decodeURIComponent(segments[gitIndex - 1]);
  const repository = decodeURIComponent(segments[gitIndex + 1]);
  const pullRequestId = Number(segments[pullIndex + 1]);
  return {
    organization,
    organizationUrl: `https://${url.hostname.toLowerCase() === 'dev.azure.com' ? `dev.azure.com/${organization}` : `${organization}.visualstudio.com`}`,
    project,
    repository,
    pullRequestId,
    webUrl: value
  };
}

export async function requestJson(url, {
  authorization,
  operation,
  fetchImpl = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          ...(authorization ? { authorization } : {})
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      if (attempt === 2) throw accessError('transient', `${operation} timed out after 3 attempts`);
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) {
      throw accessError('authentication', `HTTP ${response.status} from ${operation}`);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 2) throw accessError('transient', `HTTP ${response.status} from ${operation} after 3 attempts`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000);
      continue;
    }
    throw accessError('malformed', `HTTP ${response.status} from ${operation}`);
  }
}
```

`accessError(category, message)` returns an `Error` carrying only `error.category` and the supplied sanitized message. It never reads or includes the response body.

- [ ] **Step 4: Implement credential modes**

Add:

```javascript
export async function authorizationForMode(mode, {
  env = process.env,
  execFileImpl = execFileAsync
} = {}) {
  if (mode === 'anonymous') return null;
  if (mode === 'pat') {
    const token = env.AZURE_DEVOPS_EXT_PAT;
    if (!token) throw accessError('tool-unavailable', 'AZURE_DEVOPS_EXT_PAT is not configured');
    return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  }
  if (mode === 'entra') {
    const { stdout } = await execFileImpl('az', [
      'account',
      'get-access-token',
      '--resource',
      AZURE_DEVOPS_RESOURCE,
      '--query',
      'accessToken',
      '--output',
      'tsv'
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const token = stdout.trim();
    if (!token) throw accessError('authentication', 'Azure CLI returned no Azure DevOps access token');
    return ['Bearer', token].join(' ');
  }
  throw new Error(`Unsupported Azure REST credential mode: ${mode}`);
}
```

Catch `execFileImpl` failures and rethrow `accessError('authentication', 'Azure CLI could not provide an Azure DevOps access token')`. Do not append `stderr`, `stdout`, environment values, or the original error.

- [ ] **Step 5: Implement per-capability REST collection**

Implement `collectAzureDevOpsRest` so one failed endpoint does not prevent independent endpoints from being attempted:

```javascript
export async function collectAzureDevOpsRest({
  prUrl,
  credentialContext,
  authorization,
  fetchImpl = fetch,
  sleep
}) {
  const target = parseAzurePullRequestUrl(prUrl);
  const source = {
    adapter: 'azure-rest',
    credentialContext,
    capturedAt: new Date().toISOString()
  };
  const capabilities = {};
  const get = (url, operation) => requestJson(url, { authorization, operation, fetchImpl, sleep });

  let pr;
  try {
    pr = await get(
      `${target.organizationUrl}/${encodeURIComponent(target.project)}/_apis/git/pullrequests/${target.pullRequestId}?api-version=7.1`,
      'pull request'
    );
    pr.repository.webUrl ??= `${target.organizationUrl}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(pr.repository.name)}`;
    pr._links ??= {};
    pr._links.web ??= { href: prUrl };
    capabilities.identity = complete({
      pullRequestId: pr.pullRequestId,
      url: prUrl,
      repository: pr.repository
    });
    capabilities.metadata = complete({
      title: pr.title ?? '',
      description: pr.description ?? '',
      createdBy: pr.createdBy ?? null,
      status: pr.status ?? null,
      isDraft: Boolean(pr.isDraft),
      sourceRefName: pr.sourceRefName ?? '',
      targetRefName: pr.targetRefName ?? '',
      reviewers: pr.reviewers ?? []
    });
    capabilities.snapshot = complete({
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      lastMergeTargetCommit: pr.lastMergeTargetCommit
    });
  } catch (error) {
    for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'existingThreads']) {
      capabilities[name] = incomplete(error);
    }
    return validateAzureFragment({ schemaVersion: '1.0', source, capabilities });
  }

  const project = pr.repository.project;
  const projectPath = encodeURIComponent(project.id ?? project.name);
  const repositoryPath = encodeURIComponent(pr.repository.id ?? pr.repository.name);
  const root = `${target.organizationUrl}/${projectPath}`;
  const pullRoot = `${root}/_apis/git/repositories/${repositoryPath}/pullRequests/${pr.pullRequestId}`;

  await capture(capabilities, 'workItems', async () => {
    const refs = asValue(await get(`${pullRoot}/workitems?api-version=7.1`, 'linked work items'));
    return Promise.all(refs.map(ref => get(
      `${root}/_apis/wit/workitems/${encodeURIComponent(ref.id)}?%24expand=All&api-version=7.1`,
      `work item ${ref.id}`
    )));
  });

  await capture(capabilities, 'policies', async () => {
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${project.id}/${pr.pullRequestId}`;
    return pagedPolicyEvaluations(root, artifactId, get);
  });

  let iterations;
  await capture(capabilities, 'iterations', async () => {
    iterations = await get(`${pullRoot}/iterations?api-version=7.1`, 'pull request iterations');
    return iterations;
  });

  if (capabilities.iterations.complete) {
    await capture(capabilities, 'changes', async () => {
      const latest = Math.max(...asValue(iterations).map(iteration => Number(iteration.id)));
      return pagedIterationChanges(pullRoot, latest, get);
    });
  } else {
    capabilities.changes = incomplete(accessError('incomplete', 'Iteration changes require complete iteration metadata'));
  }

  await capture(capabilities, 'existingThreads', () =>
    get(`${pullRoot}/threads?api-version=7.1`, 'pull request threads')
  );

  return validateAzureFragment({ schemaVersion: '1.0', source, capabilities });
}
```

Private helpers have these exact behaviours:

- `complete(data)` returns `{ complete: true, data }`.
- `incomplete(error)` returns `{ complete: false, failure: { category: error.category ?? 'malformed', message: error.message } }`.
- `capture(capabilities, name, operation)` stores a complete result or sanitized incomplete result and never rethrows.
- `asValue(value)` accepts a bare array or `.value` array.
- `pagedPolicyEvaluations` requests `$top=100&$skip=N&includeNotApplicable=true` until a page contains fewer than 100 records and returns one `{ value: [...] }` wrapper.
- Exported `pagedIterationChanges` starts with `$compareTo=0&$top=2000&$skip=0`, follows `nextSkip` and `nextTop`, rejects a repeated cursor, and returns `{ changeEntries, nextSkip: 0, nextTop: 0 }`.

- [ ] **Step 6: Add retry, pagination, and redaction tests**

Append:

```javascript
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
```

Add `pagedIterationChanges` and `requestJson` to the import from
`collect-azure-devops-rest.mjs`.

- [ ] **Step 7: Implement the CLI entry point**

Add this helper so failure to obtain a PAT or Entra token still produces a
machine-readable attempt:

```javascript
export function failedAzureRestFragment(credentialContext, error) {
  const failure = {
    complete: false,
    failure: {
      category: error.category ?? 'authentication',
      message: error.message
    }
  };
  return validateAzureFragment({
    schemaVersion: '1.0',
    source: {
      adapter: 'azure-rest',
      credentialContext,
      capturedAt: new Date().toISOString()
    },
    capabilities: Object.fromEntries(
      ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'existingThreads']
        .map(name => [name, structuredClone(failure)])
    )
  });
}
```

The CLI reads exactly three arguments after the script name. It catches an
`authorizationForMode` failure with `failedAzureRestFragment`, otherwise calls
`collectAzureDevOpsRest`, and always writes the resulting valid fragment. It
prints only:

```text
Captured Azure REST attempt <credential-context> at <fragment-path>
```

Invalid usage exits 2. An invalid URL or filesystem write failure exits 1 with
a sanitized message. A valid incomplete fragment exits 0 so the skill can
continue to other adapters and let the assembler report the final capability
matrix.

Append a regression test for credential-acquisition failure:

```javascript
test('credential acquisition failure becomes a sanitized incomplete fragment', () => {
  const error = Object.assign(new Error('AZURE_DEVOPS_EXT_PAT is not configured'), {
    category: 'tool-unavailable'
  });
  const fragment = failedAzureRestFragment('pat', error);
  assert.equal(fragment.capabilities.identity.complete, false);
  assert.equal(fragment.capabilities.existingThreads.failure.category, 'tool-unavailable');
  assert.equal(fragment.capabilities.existingThreads.failure.message, 'AZURE_DEVOPS_EXT_PAT is not configured');
});
```

Add `failedAzureRestFragment` to the test import.

- [ ] **Step 8: Run focused and full tests**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test tests/azure-access.test.mjs
npm test
```

Expected: PASS. The REST fragment has every provider capability except `diff`, follows `nextSkip`, retries only transient responses, and never exposes body or authorization content in an error.

- [ ] **Step 9: Commit**

```bash
git add ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops-rest.mjs
git commit -m "feat(pr-review-graph): collect Azure PR context through REST"
```

---

### Task 3: Route the Azure CLI fast path through the common assembler

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops.sh:109-113`
- Modify: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: Task 1's `directory` CLI mode.
- Produces: the same `collect-azure-devops.sh <PR_ID> <PACKET_JSON>` interface and canonical packet, now with `providerData.access`.
- Reads optional environment label `PRG_AZURE_CREDENTIAL_CONTEXT`; defaults to `current-environment`.
- Task 4 uses `PRG_AZURE_CREDENTIAL_CONTEXT=stored-az-login` on the retry that removes `AZURE_DEVOPS_EXT_PAT`.

- [ ] **Step 1: Write a failing integration assertion**

Append:

```javascript
test('Azure CLI collector routes its complete raw directory through the access assembler', async () => {
  const collector = await readFile(
    path.join(root, 'skills/review-pull-request/scripts/collect-azure-devops.sh'),
    'utf8'
  );
  assert.match(collector, /assemble-azure-context\.mjs" directory/);
  assert.match(collector, /PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment/);
  assert.doesNotMatch(collector, /normalize-context\.mjs" \\\n\s+--provider azure-devops/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test tests/azure-access.test.mjs
```

Expected: FAIL because the collector still invokes `normalize-context.mjs` directly.

- [ ] **Step 3: Replace only the collector's final normalization call**

In `collect-azure-devops.sh`, replace:

```bash
node "$script_dir/normalize-context.mjs" \
  --provider azure-devops \
  --input-dir "$work_dir" \
  --output "$output_file"
```

with:

```bash
node "$script_dir/assemble-azure-context.mjs" directory \
  "$work_dir" \
  azure-cli \
  "${PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment}" \
  "$output_file"
```

Do not change collection commands, Git fetch/diff behaviour, argument handling, temporary-directory cleanup, or the closing message.

- [ ] **Step 4: Run shell and plugin checks**

Run:

```bash
cd ghcp/plugins/pr-review-graph
/bin/bash -n skills/review-pull-request/scripts/collect-azure-devops.sh
node --test tests/azure-access.test.mjs
npm test
```

Expected: PASS. The Bash 3.2 lint remains green and the static integration assertion sees the assembler invocation.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops.sh
git commit -m "feat(pr-review-graph): record Azure CLI access provenance"
```

---

### Task 4: Teach the skill to exhaust deterministic Azure access routes

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md:21-52,127-177`
- Replace: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md`
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs:24-42`
- Modify: `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs:45-92`

**Interfaces:**
- Consumes: Task 1 assembler modes and Task 2 REST collector.
- Produces: a provider workflow that first tries CLI, then composes REST, optional Bluebird/other MCP, and Git fragments until every required capability is complete.
- Preserves: default preview-only, exact-head checks, explicit confirmation, and CLI thread publication.

- [ ] **Step 1: Write failing static contract tests**

Replace the existing provider-delegation test in `tests/plugin.test.mjs` with:

```javascript
test('provider adapters use skills without making one Azure access path mandatory', async () => {
  const skill = await readFile(path.join(root, 'skills/review-pull-request/SKILL.md'), 'utf8');
  const github = await readFile(path.join(root, 'skills/review-pull-request/references/github-gh-cli-provider.md'), 'utf8');
  const azure = await readFile(path.join(root, 'skills/review-pull-request/references/azure-devops-cli-provider.md'), 'utf8');

  assert.match(skill, /separately installed `gh-cli` skill/);
  assert.match(github, /First load and follow the separately installed `gh-cli` skill/);
  assert.match(skill, /complete Azure DevOps read packet/);
  assert.doesNotMatch(skill, /Do not substitute an Azure DevOps MCP server/);
  assert.match(azure, /Bluebird/);
  assert.match(azure, /env -u AZURE_DEVOPS_EXT_PAT/);
  assert.match(azure, /collect-azure-devops-rest\.mjs/);
  assert.match(azure, /assemble-azure-context\.mjs/);
  assert.match(azure, /code-only access is insufficient/i);
});
```

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="provider adapters" tests/plugin.test.mjs
```

Expected: FAIL because `SKILL.md` still forbids Azure DevOps MCP substitution and the provider reference has no Bluebird, REST collector, or assembler workflow.

- [ ] **Step 3: Update `SKILL.md` access rules**

Replace the Azure bullet under **Load only the relevant references** with:

```markdown
- For Azure DevOps, load the separately installed `azure-devops-cli` skill when available, then read [azure-devops-cli-provider.md](references/azure-devops-cli-provider.md). Azure CLI failure or absence is not terminal while another deterministic adapter can contribute to a complete Azure DevOps read packet.
```

Replace Phase 1 steps 3-8 with:

```markdown
3. Create a temporary work directory outside the repository with `mktemp -d`. Do not persist review packets, fragments, provider responses, or access diagnostics in the project tree.
4. For GitHub, confirm the required CLI authentication works and use the GitHub collector.
5. For Azure DevOps, follow the provider reference's capability ledger. Try the complete CLI collector first, then probe every available deterministic adapter for missing capabilities. Optional MCP tools such as Bluebird may contribute only the facts their tool contracts expose.
6. Capture provider-reported base and head SHAs before analysis.
7. Require metadata, full description, linked work items, policies, iterations, iteration changes, all existing threads/comments, and changed-file content. Code-only or metadata-only access is incomplete.
8. Normalize or assemble the provider bundle with the bundled scripts.
9. Inspect `limits.warnings`, `limits.truncatedFiles`, and `providerData.access`. Do not dispatch discovery agents or claim a review when material context or a required Azure capability is missing.
```

Replace the Azure collector paragraph after the command examples with:

```markdown
For Azure DevOps, a failed collector command is one adapter result, not proof that the PR is inaccessible. Follow the fallback and fragment-composition sequence in the provider reference. The review may proceed only after `assemble-azure-context.mjs` produces a complete packet.
```

In Phase 5, require an Azure head recheck both immediately before preview and again after confirmation immediately before publication. State explicitly that a complete read packet with no write route still receives a preview marked `publication unavailable`.

- [ ] **Step 4: Replace the Azure provider reference with the capability workflow**

Retain the existing line-tracking and publication payload rules, but organize the replacement reference in this order:

1. **Safety and completeness** — deterministic tools only; no install/login/default mutation; code-only access is insufficient; list all nine required capabilities.
2. **CLI fast path** — run the collector once with current environment, then once without injected PAT:

```bash
bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>

env -u AZURE_DEVOPS_EXT_PAT \
  PRG_AZURE_CREDENTIAL_CONTEXT=stored-az-login \
  bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
```

Run the second command only when `AZURE_DEVOPS_EXT_PAT` is present and the first command fails. Do not print either command's raw authentication error.

After a failed CLI collector attempt, record a sanitized failure fragment before
trying the next adapter:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli current-environment authentication \
  "Azure CLI did not produce a complete PR packet" all \
  <WORK_DIR>/cli-current-failure.json

node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli stored-az-login authentication \
  "Azure CLI stored login did not produce a complete PR packet" all \
  <WORK_DIR>/cli-stored-failure.json
```

Use `tool-unavailable` instead of `authentication` when `az` or the Azure
DevOps extension is absent.

3. **REST fragments** — run each configured context independently:

```bash
node <SKILL_DIR>/scripts/collect-azure-devops-rest.mjs \
  <PR_URL> anonymous <WORK_DIR>/rest-anonymous.json

node <SKILL_DIR>/scripts/collect-azure-devops-rest.mjs \
  <PR_URL> pat <WORK_DIR>/rest-pat.json

node <SKILL_DIR>/scripts/collect-azure-devops-rest.mjs \
  <PR_URL> entra <WORK_DIR>/rest-entra.json
```

Skip `pat` when `AZURE_DEVOPS_EXT_PAT` is absent. Skip `entra` when `az account get-access-token` is unavailable. Never prompt.

4. **Optional MCP fragments** — inspect available Azure DevOps tool descriptions. For Bluebird, call `bluebird-metadata` `connection_info` when scope is unknown and `bluebird-code_history` `pull_request` with explicit organization, project, repository, PR ID, and the user's original question. Record only returned facts. The current Bluebird PR operation can contribute identity and metadata; it does not prove exact base/target SHAs, complete threads, policies, iteration changes, or pagination. Do not mark a capability complete unless the tool contract and result provide it. When an attempted MCP operation fails, use assembler `failure` mode with a sanitized message instead of omitting the attempt.

Write the Bluebird fragment in this shape, replacing each runtime value only
with a value returned by the tool or parsed from the supplied PR URL:

```json
{
  "schemaVersion": "1.0",
  "source": {
    "adapter": "bluebird",
    "credentialContext": "configured-mcp",
    "capturedAt": "<RFC3339 capture time>"
  },
  "capabilities": {
    "identity": {
      "complete": true,
      "data": {
        "pullRequestId": 77,
        "url": "https://dev.azure.com/fabrikam/Platform/_git/widgets/pullrequest/77",
        "repository": {
          "name": "widgets",
          "webUrl": "https://dev.azure.com/fabrikam/Platform/_git/widgets",
          "project": {
            "name": "Platform"
          }
        }
      }
    },
    "metadata": {
      "complete": true,
      "data": {
        "title": "Require email address",
        "description": "<exact full description returned by Bluebird>",
        "createdBy": {
          "displayName": "Developer"
        },
        "status": "active",
        "isDraft": false,
        "sourceRefName": "refs/heads/email-required",
        "targetRefName": "refs/heads/main",
        "reviewers": [
          {
            "displayName": "Reviewer",
            "vote": 0
          }
        ]
      }
    }
  }
}
```

The concrete names above mirror the repository's fabricated Azure fixture; the
provider reference must label the block as a shape example, not hard-coded
fallback data. Omit `workItems` unless the tool returns every linked item's full
fields, not just code references or IDs.

5. **Git diff fragment** — after authoritative snapshot SHAs and repository identity exist, reuse the existing `ensure_commit` and `git diff --find-renames --no-ext-diff --no-color --unified=80 "$target_sha...$source_sha"` flow. Wrap the patch:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs capability \
  local-git configured-origin diff \
  <WORK_DIR>/diff.patch <WORK_DIR>/git-diff.json
```

6. **Assembly** — pass every valid fragment:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs packet \
  <PACKET_JSON> \
  <WORK_DIR>/cli-current-failure.json \
  <WORK_DIR>/cli-stored-failure.json \
  <WORK_DIR>/rest-anonymous.json \
  <WORK_DIR>/rest-pat.json \
  <WORK_DIR>/rest-entra.json \
  <WORK_DIR>/bluebird-identity.json \
  <WORK_DIR>/bluebird-metadata.json \
  <WORK_DIR>/git-diff.json
```

Include only files that exist. If assembly reports missing capabilities, show its sanitized attempt ledger and stop before agent dispatch.

7. **Head recheck and publication** — use `az repos pr show` when that
credential context works. For REST, rerun `collect-azure-devops-rest.mjs` with
the successful mode and read
`capabilities.snapshot.data.lastMergeSourceCommit.commitId` from the new
fragment. The current Bluebird PR operation cannot perform the recheck because
it does not return the exact provider source SHA. Recheck immediately before
preview and again after confirmation immediately before publishing. Keep
`az devops invoke --in-file` publication when a CLI write context works.
Otherwise preview and state `publication unavailable`; do not block analysis.

- [ ] **Step 5: Update static validation**

In `scripts/validate-plugin.mjs`:

- Parse `azure-access-fragment.schema.json` alongside the other schemas.
- Require `assemble-azure-context.mjs` and `collect-azure-devops-rest.mjs` in `requiredScripts`.
- Replace the strict Azure delegation assertion with checks for `Bluebird`, `complete read packet`, `collect-azure-devops-rest.mjs`, and `assemble-azure-context.mjs`.
- Keep `manifest.mcpServers === undefined`; optional runtime MCP use must not become a plugin dependency.
- Change the success line to:

```javascript
console.log(`Plugin validation passed: ${agentFiles.length} agents, 1 skill, zero required MCP and hook dependencies.`);
```

- [ ] **Step 6: Run targeted and full tests**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="provider adapters" tests/plugin.test.mjs
npm test
npm run validate
```

Expected: PASS. Validation reports `zero required MCP and hook dependencies`, and the plugin no longer contains the Azure prohibition that caused the observed Bluebird-capable session to stop.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md \
        ghcp/plugins/pr-review-graph/tests/plugin.test.mjs \
        ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs
git commit -m "feat(pr-review-graph): exhaust Azure PR access routes"
```

---

### Task 5: Document and package the access change

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/README.md:7-14,47-50`
- Modify: `ghcp/plugins/pr-review-graph/plugin.json:3-4`
- Modify: `.github/plugin/marketplace.json:13-15`

**Interfaces:**
- Consumes: the version-match assertion in `validate-plugin.mjs`.
- Produces: marketplace version `0.3.0` and user-facing documentation of optional adapter composition.

- [ ] **Step 1: Update the README access model**

Replace the provider table with:

```markdown
| Provider | Access path |
| --- | --- |
| GitHub | The `gh-cli` skill and an authenticated `gh` CLI |
| Azure DevOps | A complete packet composed from authenticated `az`, direct REST with existing credentials, optional Azure DevOps MCP tools such as Bluebird, and local Git |

There are no required MCP server dependencies. When an Azure DevOps MCP tool is available at runtime, the plugin may use only the PR capabilities that tool actually exposes.
```

Replace the Azure prerequisite paragraph with:

```markdown
Install the `azure-devops-cli` skill and configure the Azure DevOps CLI extension when you want the preferred fast path or comment publication. If that route fails, the plugin probes deterministic REST and optional Azure DevOps MCP tools already available to the session. It never installs an extension, starts interactive login, requests a PAT, or treats code-only access as enough for a review.
```

- [ ] **Step 2: Update plugin descriptions and bump `plugin.json`**

In `plugin.json`, set:

```json
"description": "High-signal pull request reviews through a bounded multi-agent graph, with resilient GitHub and capability-composed Azure DevOps access.",
"version": "0.3.0",
```

- [ ] **Step 3: Run validation to prove the marketplace mismatch is detected**

Run:

```bash
cd ghcp/plugins/pr-review-graph
npm run validate
```

Expected: FAIL with `marketplace version 0.2.4 must match plugin.json version 0.3.0`.

- [ ] **Step 4: Update the root marketplace entry**

In `.github/plugin/marketplace.json`, change the `pr-review-graph` entry to:

```json
"description": "High-signal pull request reviews through a bounded multi-agent graph, with resilient GitHub and capability-composed Azure DevOps access.",
"version": "0.3.0",
```

Leave root `metadata.version` at `1.0.0`.

- [ ] **Step 5: Run final validation**

Run:

```bash
cd ghcp/plugins/pr-review-graph
npm test
npm run validate
/bin/bash -n skills/review-pull-request/scripts/collect-azure-devops.sh
git diff --check
```

Expected: all tests pass, validation reports nine agents, one skill, zero required MCP and hook dependencies, Bash reports no syntax errors, and `git diff --check` is silent.

- [ ] **Step 6: Audit the final Azure access contract**

Run:

```bash
rg -n "Do not substitute an Azure DevOps MCP|stop with an actionable dependency|zero MCP and hook" \
  skills/review-pull-request README.md scripts tests

rg -n "Bluebird|complete Azure DevOps read packet|collect-azure-devops-rest|assemble-azure-context|publication unavailable" \
  skills/review-pull-request README.md scripts tests
```

Expected: the first command returns no matches. The second returns the skill, Azure provider reference, README, validator, and static tests. Inspect each match and confirm no text treats Bluebird or code-only access as a complete packet.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/pr-review-graph/README.md \
        ghcp/plugins/pr-review-graph/plugin.json \
        .github/plugin/marketplace.json
git commit -m "release(pr-review-graph): publish version 0.3.0"
```
