# Bind Azure diff fragments to snapshot identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `diff` capability in the Azure DevOps access-fragment assembler prove the
repository and exact base/head commit it was generated from, and reject any fragment that
does not, or that disagrees with another fragment's declared identity/snapshot, before
`normalize()` runs.

**Architecture:** Extend `diff` capability `data` from a bare string to
`{ repository, baseSha, headSha, patch }`, following the same self-declaring shape already
used by `identity`/`snapshot`. Fold the new fields into the existing `assertImmutableAgreement`
ledger (same keys already used for identity/snapshot) so a conflict throws with zero new
comparison logic. Update both producers of a `diff` fragment (the CLI-directory fast path and
the standalone local-git `capability` CLI mode) and the two assembler read sites that consume
`selected.diff.capability.data`.

**Tech Stack:** Node.js (no new dependencies), `node:test` + `node:assert/strict`, Bash 3.2
compatible shell (no shell script changes required for this plan).

## Global Constraints

- Preserve the Azure DevOps CLI fast path (`collect-azure-devops.sh`) — no changes to that
  script.
- Preserve Bash 3.2 compatibility — no shell script changes in this plan.
- Preserve local Git fallback and immutable, fail-closed behavior.
- No secrets in any fragment, log, or error message.
- No new dependencies.
- Plugin stays at version `0.3.0` (no bump).
- Scope is limited to this finding only: do not add the organization-identity check or the
  pagination-cycle-detection fix raised elsewhere in the same review.
- Every producer and consumer of the existing `diff` capability must be updated together so
  the fast path, the standalone local-git path, and the assembler stay consistent.

---

### Task 1: Bind and validate the `diff` capability shape

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:77-81` (`assertCapabilityData` `diff` case)
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:86-120` (`assertImmutableAgreement`)
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:207-210,225` (`assembleAzureFragments` read sites)
- Test: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: nothing new — reuses `agree()`, `seen` map, and `attempts` machinery already in
  `assembleAzureFragments`/`assertImmutableAgreement`.
- Produces: the `diff` capability's `data` shape `{ repository: { id?, name?, project: { id?,
  name? } }, baseSha: string, headSha: string, patch: string }`, which Task 2 and Task 3 must
  produce and which the test fixture helper (`fragments()` in `azure-access.test.mjs`) now
  encodes as the baseline shape every other test in the file builds on.

- [ ] **Step 1: Update the shared test fixture helper to the new diff shape**

In `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`, replace the `local-git` fragment
inside `fragments()`:

```js
    {
      schemaVersion: '1.0',
      source: source('local-git'),
      capabilities: { diff: complete(raw.diff) }
    }
```

with:

```js
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
```

This is the shape every existing composition/provenance/authority test in the file will now
exercise; it is not yet a new test, just the fixture update the rest of this task depends on.

- [ ] **Step 2: Run the existing suite to confirm it now fails**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: FAIL — the existing tests that build packets from `fragments()` now throw
`Azure capability diff needs a string` (or similar), because production code still expects a
bare string while the fixture now supplies an object. This confirms the fixture change is
live and production code has not been touched yet.

- [ ] **Step 3: Write the new failing tests for diff binding**

Add to `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`, after the existing test
`'authoritative adapters outrank a later hand-transcribed fragment per capability'` (the test
ending at line 273) and before the `import { AZURE_DEVOPS_RESOURCE, ... }` block:

```js
test('a diff fragment must declare repository, baseSha, headSha, and patch, not a bare string', () => {
  const pr = raw.pullRequest;
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
```

- [ ] **Step 4: Run the new tests to confirm they fail for the right reason**

Run: `cd ghcp/plugins/pr-review-graph && npm test 2>&1 | grep -A5 "diff fragment\|bound diff"`
Expected: every new test FAILs — the "must declare" and "missing baseSha" tests fail because
production code still accepts a bare string and never throws the new message; the "composes",
"different repository", "head SHA", and "base SHA" tests fail because
`assertCapabilityData('diff', …)` still rejects the new object shape outright with
`Azure capability diff needs a string`.

- [ ] **Step 5: Implement the `diff` shape validation**

In `assemble-azure-context.mjs`, replace the `diff` case in `assertCapabilityData`:

```js
    case 'diff': {
      if (typeof data !== 'string')
        throw new Error('Azure capability diff needs a string');
      break;
    }
```

with:

```js
    case 'diff': {
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new Error('Azure capability diff needs an object with repository, baseSha, headSha, and patch');
      if (typeof data.patch !== 'string')
        throw new Error('Azure capability diff needs a string patch');
      const repo = data.repository ?? {};
      if (!String(repo.id ?? repo.name ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty repository id or name');
      const project = repo.project ?? {};
      if (!String(project.id ?? project.name ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty project id or name');
      if (!String(data.baseSha ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty baseSha');
      if (!String(data.headSha ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty headSha');
      break;
    }
```

- [ ] **Step 6: Implement cross-fragment agreement for `diff`**

In `assertImmutableAgreement`, immediately after the existing `snap` block (which ends right
before the closing brace of the `for (const fragment of fragments)` loop):

```js
    const snap = fragment.capabilities?.snapshot;
    if (snap?.complete) {
      const head = String(snap.data.lastMergeSourceCommit?.commitId ?? '').trim();
      if (!head) throw new Error('Conflicting Azure head SHA');
      agree('head', head, 'Conflicting Azure head SHA');
      const base = String(snap.data.lastMergeTargetCommit?.commitId ?? '').trim();
      if (!base) throw new Error('Conflicting Azure base SHA');
      agree('base', base, 'Conflicting Azure base SHA');
    }
  }
```

add a new `diff` block between the `snap` block and the loop's closing brace, so the function
reads:

```js
    const snap = fragment.capabilities?.snapshot;
    if (snap?.complete) {
      const head = String(snap.data.lastMergeSourceCommit?.commitId ?? '').trim();
      if (!head) throw new Error('Conflicting Azure head SHA');
      agree('head', head, 'Conflicting Azure head SHA');
      const base = String(snap.data.lastMergeTargetCommit?.commitId ?? '').trim();
      if (!base) throw new Error('Conflicting Azure base SHA');
      agree('base', base, 'Conflicting Azure base SHA');
    }
    const diff = fragment.capabilities?.diff;
    if (diff?.complete) {
      const repo = diff.data.repository ?? {};
      const project = repo.project ?? {};
      agree('repository.id', repo.id, 'Conflicting Azure PR identity');
      agree('repository.name', repo.name, 'Conflicting Azure PR identity');
      agree('project.id', project.id, 'Conflicting Azure PR identity');
      agree('project.name', project.name, 'Conflicting Azure PR identity');
      agree('head', diff.data.headSha, 'Conflicting Azure head SHA');
      agree('base', diff.data.baseSha, 'Conflicting Azure base SHA');
    }
  }
```

- [ ] **Step 7: Update the two `assembleAzureFragments` read sites**

Replace:

```js
  const changeEntries = selected.changes.capability.data.changeEntries;
  if (changeEntries.length && !String(selected.diff.capability.data).trim()) {
    throw new Error('Incomplete Azure DevOps context: diff is empty for a non-empty change list');
  }
```

with:

```js
  const changeEntries = selected.changes.capability.data.changeEntries;
  if (changeEntries.length && !String(selected.diff.capability.data.patch).trim()) {
    throw new Error('Incomplete Azure DevOps context: diff is empty for a non-empty change list');
  }
```

Replace:

```js
    existingThreads: selected.existingThreads.capability.data,
    diff: selected.diff.capability.data
  };
```

with:

```js
    existingThreads: selected.existingThreads.capability.data,
    diff: selected.diff.capability.data.patch
  };
```

- [ ] **Step 8: Run the full test suite and confirm it passes**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — every test in `azure-access.test.mjs` (existing and newly added) passes.

- [ ] **Step 9: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs \
        ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "fix(pr-review-graph): bind Azure diff fragments to repository and snapshot SHAs"
```

---

### Task 2: Produce the bound diff shape from the CLI-directory fast path

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:264-270` (`fragmentFromRawDirectory`)
- Test: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: `assertCapabilityData`/`assertImmutableAgreement` from Task 1 (the new object
  shape they now require and cross-check).
- Produces: `fragmentFromRawDirectory(directory, source)` now returns a `diff` capability
  whose `data` is `{ repository, baseSha, headSha, patch }`, sourced from the same `pr` object
  (`pr.repository`, `pr.lastMergeTargetCommit.commitId`, `pr.lastMergeSourceCommit.commitId`)
  already used to build the `identity` and `snapshot` capabilities in the same function. No
  change to `collect-azure-devops.sh` is required — it already writes `pull-request.json` and
  `diff.patch` into the raw directory this function reads.

- [ ] **Step 1: Write the failing test**

Add to `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`, after the `import {
fragmentFromRawDirectory` — first add the import. Update the existing import block:

```js
import {
  assembleAzureFragments,
  REQUIRED_AZURE_CAPABILITIES,
  validateAzureFragment
} from '../skills/review-pull-request/scripts/assemble-azure-context.mjs';
```

to:

```js
import {
  assembleAzureFragments,
  fragmentFromRawDirectory,
  REQUIRED_AZURE_CAPABILITIES,
  validateAzureFragment
} from '../skills/review-pull-request/scripts/assemble-azure-context.mjs';
```

Add `mkdtemp`, `rm`, and `writeFile` to the existing `node:fs/promises` import at the top of
the file (currently `import { readFile } from 'node:fs/promises';`):

```js
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
```

Add `os` alongside the existing `path`/`url` imports:

```js
import os from 'node:os';
```

Then add the test itself, near the end of the file (after the last existing test, before any
trailing top-level `assert.equal` statements if present — place it as the final `test(...)`
block):

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ghcp/plugins/pr-review-graph && node --test tests/azure-access.test.mjs 2>&1 | grep -B2 -A10 "CLI-directory fast path"`
Expected: FAIL — `fragment.capabilities.diff.data.patch` is `undefined` because
`fragmentFromRawDirectory` still returns `diff: complete(raw.diff)` (a bare string), so
`.patch` does not exist on it yet.

- [ ] **Step 3: Implement the minimal change**

In `assemble-azure-context.mjs`, inside `fragmentFromRawDirectory`, replace:

```js
      existingThreads: complete(raw.existingThreads),
      diff: complete(raw.diff)
    }
  };
```

with:

```js
      existingThreads: complete(raw.existingThreads),
      diff: complete({
        repository: pr.repository,
        baseSha: pr.lastMergeTargetCommit?.commitId ?? '',
        headSha: pr.lastMergeSourceCommit?.commitId ?? '',
        patch: raw.diff
      })
    }
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/pr-review-graph && node --test tests/azure-access.test.mjs 2>&1 | grep -B2 -A10 "CLI-directory fast path"`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — no regressions in the rest of the suite.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs \
        ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "fix(pr-review-graph): bind the CLI-directory diff fragment to its snapshot"
```

---

### Task 3: Update the standalone local-git `capability diff` CLI mode

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:293-310` (`main()`, `capability` mode)
- Test: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: `assertCapabilityData`/`validateAzureFragment` from Task 1.
- Produces: a new CLI argument shape specific to `diff`:
  `capability <ADAPTER> <CREDENTIAL_CONTEXT> diff <REPOSITORY_JSON> <BASE_SHA> <HEAD_SHA> <DIFF_PATCH> <FRAGMENT_JSON>`,
  distinct from the unchanged shape for every other capability:
  `capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>`.
  This is the CLI invocation Task 4 documents in `azure-devops-cli-provider.md`.

- [ ] **Step 1: Write the failing test**

Add to `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`. First add `spawnSync` to
the imports at the top of the file:

```js
import { spawnSync } from 'node:child_process';
```

Then add the test as the final `test(...)` block in the file:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ghcp/plugins/pr-review-graph && node --test tests/azure-access.test.mjs 2>&1 | grep -B2 -A15 "standalone capability CLI mode"`
Expected: FAIL — the CLI process exits non-zero (or the written fragment's `diff.data` is a
bare string without `.patch`), because `main()`'s `capability` mode still reads a single
`<DATA_FILE>` positional argument via `readJson`, not the five-argument diff-specific shape.

- [ ] **Step 3: Implement the minimal change**

In `assemble-azure-context.mjs`, replace the `capability` mode block in `main()`:

```js
  if (mode === 'capability') {
    const [adapter, credentialContext, capability, dataFile, fragmentJson] = args;
    if (!adapter || !credentialContext || !capability || !dataFile || !fragmentJson) {
      throw new Error('Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>');
    }
    const data = capability === 'diff'
      ? await readFile(path.resolve(dataFile), 'utf8')
      : await readJson(path.resolve(dataFile));
    const fragment = {
      schemaVersion: '1.0',
      source: { adapter, credentialContext, capturedAt: new Date().toISOString() },
      capabilities: { [capability]: complete(data) }
    };
    validateAzureFragment(fragment);
    await writeJson(path.resolve(fragmentJson), fragment);
    console.log(`fragment: ${fragmentJson} (source: ${adapter}/${credentialContext}, capability: ${capability})`);
    return;
  }
```

with:

```js
  if (mode === 'capability') {
    const [adapter, credentialContext, capability] = args;
    if (!adapter || !credentialContext || !capability) {
      throw new Error(
        'Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>\n' +
        '       assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> diff <REPOSITORY_JSON> <BASE_SHA> <HEAD_SHA> <DIFF_PATCH> <FRAGMENT_JSON>'
      );
    }
    let data;
    let fragmentJson;
    if (capability === 'diff') {
      const [repositoryJson, baseSha, headSha, diffPatch, fragJson] = args.slice(3);
      if (!repositoryJson || !baseSha || !headSha || !diffPatch || !fragJson) {
        throw new Error('Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> diff <REPOSITORY_JSON> <BASE_SHA> <HEAD_SHA> <DIFF_PATCH> <FRAGMENT_JSON>');
      }
      const repository = await readJson(path.resolve(repositoryJson));
      const patch = await readFile(path.resolve(diffPatch), 'utf8');
      data = { repository, baseSha, headSha, patch };
      fragmentJson = fragJson;
    } else {
      const [dataFile, fragJson] = args.slice(3);
      if (!dataFile || !fragJson) {
        throw new Error('Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>');
      }
      data = await readJson(path.resolve(dataFile));
      fragmentJson = fragJson;
    }
    const fragment = {
      schemaVersion: '1.0',
      source: { adapter, credentialContext, capturedAt: new Date().toISOString() },
      capabilities: { [capability]: complete(data) }
    };
    validateAzureFragment(fragment);
    await writeJson(path.resolve(fragmentJson), fragment);
    console.log(`fragment: ${fragmentJson} (source: ${adapter}/${credentialContext}, capability: ${capability})`);
    return;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/pr-review-graph && node --test tests/azure-access.test.mjs 2>&1 | grep -B2 -A15 "standalone capability CLI mode"`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs \
        ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "fix(pr-review-graph): require repository and SHA binding for the diff CLI capability mode"
```

---

### Task 4: Update the fragment schema and provider reference doc

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-access-fragment.schema.json`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md:129-143`

**Interfaces:**
- Consumes: nothing — documentation and a descriptive JSON schema only.
- Produces: an accurate reference for anyone (human or agent) reading the fragment contract
  or following the local-git diff-fragment instructions. No code depends on this schema at
  runtime; `scripts/validate-plugin.mjs` only checks that the file parses as valid JSON.

- [ ] **Step 1: Add a `diffCapability` definition to the schema and reference it from `diff`**

In `azure-access-fragment.schema.json`, replace:

```json
        "diff": { "$ref": "#/$defs/capability" }
```

with:

```json
        "diff": { "$ref": "#/$defs/diffCapability" }
```

Then add a new definition inside `$defs`, alongside the existing `capability` definition
(after its closing brace, before the closing brace of `$defs`):

```json
    "diffCapability": {
      "allOf": [
        { "$ref": "#/$defs/capability" },
        {
          "if": { "properties": { "complete": { "const": true } } },
          "then": {
            "properties": {
              "data": {
                "type": "object",
                "required": ["repository", "baseSha", "headSha", "patch"],
                "properties": {
                  "repository": { "type": "object" },
                  "baseSha": { "type": "string", "minLength": 1 },
                  "headSha": { "type": "string", "minLength": 1 },
                  "patch": { "type": "string" }
                }
              }
            }
          }
        }
      ]
    }
```

- [ ] **Step 2: Validate the schema still parses as JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-access-fragment.schema.json','utf8')); console.log('ok')"`
Expected: prints `ok`

- [ ] **Step 3: Update the provider reference doc's Git diff fragment section**

In `azure-devops-cli-provider.md`, replace section 5 (currently):

```markdown
## 5. Git diff fragment

After authoritative snapshot SHAs and repository identity exist, reuse the existing collector's
`ensure_commit` fetch behavior and:

```bash
git diff --find-renames --no-ext-diff --no-color --unified=80 "$target_sha...$source_sha" >"$diff_patch"
```

Fetch missing commit objects without checkout; never execute changed code. Stop if the local repository does not correspond to the PR or the commit objects cannot be obtained. Wrap the patch:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs capability \
  local-git configured-origin diff \
  <WORK_DIR>/diff.patch <WORK_DIR>/git-diff.json
```
```

with:

```markdown
## 5. Git diff fragment

After authoritative snapshot SHAs and repository identity exist, reuse the existing collector's
`ensure_commit` fetch behavior and:

```bash
git diff --find-renames --no-ext-diff --no-color --unified=80 "$target_sha...$source_sha" >"$diff_patch"
```

Fetch missing commit objects without checkout; never execute changed code. Stop if the local repository does not correspond to the PR or the commit objects cannot be obtained. The diff fragment must prove which repository and exact commits it was generated from: write the repository object already recorded in the identity fragment to `<WORK_DIR>/repository.json`, then wrap the patch together with the exact SHAs used above:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs capability \
  local-git configured-origin diff \
  <WORK_DIR>/repository.json "$target_sha" "$source_sha" \
  <WORK_DIR>/diff.patch <WORK_DIR>/git-diff.json
```

The assembler rejects this fragment before normalization if its repository, base SHA, or head SHA disagree with any other fragment's declared identity or snapshot.
```

- [ ] **Step 4: Run the plugin validator**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: PASS — no new errors (this only checks structural conventions, e.g. that the doc
still names `assemble-azure-context.mjs`, `collect-azure-devops-rest.mjs`, `<WORK_DIR>/bluebird.json`, etc.; the exact wording changes made here do not remove any of those markers).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-access-fragment.schema.json \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md
git commit -m "docs(pr-review-graph): document the bound diff fragment shape"
```

---

### Task 5: Final full-suite verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Run the full test suite**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — all tests, including every test added in Tasks 1-3, pass with no regressions.

- [ ] **Step 2: Run the plugin validator**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: PASS

- [ ] **Step 3: Confirm no unrelated scope crept in**

Run: `cd /path/to/repo && git diff docs/superpowers/plans/2026-08-13-azure-diff-snapshot-binding.md..HEAD -- ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs | grep -c "organization\|nextSkip\|nextTop\|pagination"`

(Use the actual base commit rather than the plan file itself if scripting this; the intent is
a manual read-through.) Read the full diff for `assemble-azure-context.mjs` and confirm it
touches only: the `diff` case in `assertCapabilityData`, the new `diff` block in
`assertImmutableAgreement`, the two `selected.diff.capability.data` read sites in
`assembleAzureFragments`, the `diff` capability construction in `fragmentFromRawDirectory`, and
the `capability` mode branch in `main()`. No changes to organization-identity checks or
pagination/cursor logic.
Expected: confirmed — diff is scoped to the `diff` capability binding only.
