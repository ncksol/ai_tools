# Surface Azure Assembly Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Azure fragment assembly cannot complete because a required capability is
missing, expose the full sanitized ledger — successful capability sources, every attempt,
missing capabilities, and rejected-fragment diagnostics — both as structured properties on the
thrown error and as a deterministic `assembled: false` JSON artifact written by the `packet`
and `directory` CLI modes, instead of only `error.message`.

**Architecture:** `assembleAzureFragments` already builds `attempts` and `rejectedFragments`
while it runs. Attach three more properties (`missingCapabilities`, `rejectedFragments`,
`selectedCapabilities`) to the thrown `Error` alongside the existing `error.attempts`. Add one
small shared helper, `assembleAndWrite`, used by both the `directory` and `packet` CLI modes,
that writes the normal packet on success and a sanitized failure-artifact JSON (reusing the same
`PACKET_JSON` output path) on this specific failure, then rethrows with a pointer to that path
appended to the message so the existing top-level `main().catch` still logs it and sets
`process.exitCode = 1` unchanged.

**Tech Stack:** Node.js (no new dependencies), `node:test` + `node:assert/strict`, `node:child_process.spawnSync` for CLI-level tests.

## Global Constraints

- No change to which capabilities are required, how they're validated, or the assembly/selection algorithm.
- No change to `capability` or `failure` CLI modes — neither calls `assembleAzureFragments`.
- No raw fragment data, tokens, response bodies, or credential material may appear in any new error property or artifact field.
- Successful packet output and `providerData.access` shape are unchanged (byte-for-byte).
- No version bump (plugin stays at `0.3.0`); no new dependencies; Node >=18 built-ins only.
- Scope is limited to this one finding — do not touch pagination-cycle detection, org-identity casing, or any other issue raised in the same review batch.

---

### Task 1: Attach structured diagnostics to the assembly-failure error

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:253-267` (`assembleAzureFragments` missing-capability branch)
- Test: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: nothing new — reuses the existing local `missing`, `attempts`, `rejectedFragments`, and `selected` variables already computed inside `assembleAzureFragments`.
- Produces: on a missing-capability throw, the `Error` now additionally carries:
  - `error.missingCapabilities` — `string[]`, the same sorted list as the existing `missing` local.
  - `error.rejectedFragments` — same array shape as `packet.providerData.access.rejectedFragments` on success (`{ source, failure: { category, message } }[]`).
  - `error.selectedCapabilities` — `{ [capabilityName]: { adapter, credentialContext, capturedAt } }`, one entry per capability that *did* complete and was selected, built the same way as `packet.providerData.access.capabilities` on success (source only, never `data`).
  - `error.attempts` (existing, unchanged) and `error.message` (existing, unchanged text) stay as they are today.

- [ ] **Step 1: Write the failing tests**

Add to the end of `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`:

```js
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
    for (const source of Object.values(error.selectedCapabilities)) {
      assert.deepEqual(Object.keys(source).sort(), ['adapter', 'capturedAt', 'credentialContext']);
    }
    for (const attempt of error.attempts) {
      assert.deepEqual(Object.keys(attempt).sort(), ['capability', 'complete', 'failure', 'source']);
      assert.deepEqual(Object.keys(attempt.source).sort(), ['adapter', 'capturedAt', 'credentialContext']);
    }
    return true;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ghcp/plugins/pr-review-graph && npm test 2>&1 | grep -A 5 "missing-capability assembly failure\|rejected fragments surface\|never carries raw capability"`
Expected: FAIL — `error.missingCapabilities`, `error.selectedCapabilities` are `undefined` (only `error.attempts` exists today), so the `assert.deepEqual`/`Object.keys` calls throw `TypeError` or assertion failures.

- [ ] **Step 3: Implement the structured error properties**

In `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs`, replace:

```js
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
```

with:

```js
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
    error.missingCapabilities = missing;
    error.rejectedFragments = rejectedFragments;
    error.selectedCapabilities = Object.fromEntries(
      Object.entries(selected).map(([name, value]) => [name, value.source])
    );
    throw error;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — all tests, including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs \
        ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "fix(pr-review-graph): attach selected/rejected diagnostics to Azure assembly failures"
```

---

### Task 2: Write a sanitized failure artifact from packet/directory CLI modes

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs:348-433` (`main()` — `directory` and `packet` branches, plus a new helper above `main`)
- Test: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: `error.attempts` / `error.missingCapabilities` / `error.rejectedFragments` / `error.selectedCapabilities` from Task 1, and the existing `assembleAzureFragments`, `writeJson` (from `./lib.mjs`).
- Produces: a new local helper `assembleAndWrite(fragments, packetJsonPath)` (not exported — used only inside this file's `main()`), returning the packet on success. On an assembly failure it writes `{ provider: 'azure-devops', assembled: false, message, missingCapabilities, selectedCapabilities, attempts, rejectedFragments }` to `packetJsonPath` and rethrows the same error with `\nfailure artifact: <packetJsonPath>` appended to `error.message`.

- [ ] **Step 1: Write the failing CLI-level test**

Add to the end of `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`:

```js
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
    assert.match(result.stderr, new RegExp(packetJson.split(path.sep).pop()));

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/pr-review-graph && npm test 2>&1 | grep -A 10 "packet CLI mode writes a sanitized"`
Expected: FAIL — the `packet.json` file is never written on failure today (`assembleAzureFragments` throws before any `writeJson` call in `main()`), so `readFile(packetJson, ...)` rejects with `ENOENT`.

- [ ] **Step 3: Implement `assembleAndWrite` and use it from both CLI modes**

In `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs`, add this helper immediately before `async function main() {`:

```js
function buildFailureArtifact(error) {
  return {
    provider: 'azure-devops',
    assembled: false,
    message: error.message,
    missingCapabilities: error.missingCapabilities ?? [],
    selectedCapabilities: error.selectedCapabilities ?? {},
    attempts: error.attempts ?? [],
    rejectedFragments: error.rejectedFragments ?? []
  };
}

// Both `directory` and `packet` CLI modes assemble fragments and write PACKET_JSON. When
// assembly fails on missing capabilities, write the same sanitized ledger the caller would
// have seen on `providerData.access` to that same path instead of leaving only a printed
// message, so the operator (or a re-read of PACKET_JSON) can see the full attempt/rejection
// ledger before stopping.
async function assembleAndWrite(inputFragments, packetJsonPath) {
  let packet;
  try {
    packet = assembleAzureFragments(inputFragments);
  } catch (error) {
    if (!error.attempts) throw error;
    await writeJson(packetJsonPath, buildFailureArtifact(error));
    error.message += `\nfailure artifact: ${packetJsonPath}`;
    throw error;
  }
  await writeJson(packetJsonPath, packet);
  return packet;
}
```

Then replace the body of the `directory` branch:

```js
  if (mode === 'directory') {
    const [rawDir, adapter, credentialContext, packetJson] = args;
    if (!rawDir || !adapter || !credentialContext || !packetJson) {
      throw new Error('Usage: assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON>');
    }
    const fragment = await fragmentFromRawDirectory(path.resolve(rawDir), { adapter, credentialContext });
    const packet = assembleAzureFragments([fragment]);
    await writeJson(path.resolve(packetJson), packet);
    console.log(`packet: ${packetJson} (source: ${adapter}/${credentialContext})`);
    return;
  }
```

with:

```js
  if (mode === 'directory') {
    const [rawDir, adapter, credentialContext, packetJson] = args;
    if (!rawDir || !adapter || !credentialContext || !packetJson) {
      throw new Error('Usage: assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON>');
    }
    const fragment = await fragmentFromRawDirectory(path.resolve(rawDir), { adapter, credentialContext });
    await assembleAndWrite([fragment], path.resolve(packetJson));
    console.log(`packet: ${packetJson} (source: ${adapter}/${credentialContext})`);
    return;
  }
```

And replace the body of the `packet` branch:

```js
  if (mode === 'packet') {
    const [packetJson, ...fragmentPaths] = args;
    if (!packetJson || !fragmentPaths.length) {
      throw new Error('Usage: assemble-azure-context.mjs packet <PACKET_JSON> <FRAGMENT_JSON>...');
    }
    const fragments = await Promise.all(fragmentPaths.map(p => readJson(path.resolve(p))));
    const packet = assembleAzureFragments(fragments);
    await writeJson(path.resolve(packetJson), packet);
    const sources = fragments.map(f => `${f.source.adapter}/${f.source.credentialContext}`).join(', ');
    console.log(`packet: ${packetJson} (sources: ${sources})`);
    return;
  }
```

with:

```js
  if (mode === 'packet') {
    const [packetJson, ...fragmentPaths] = args;
    if (!packetJson || !fragmentPaths.length) {
      throw new Error('Usage: assemble-azure-context.mjs packet <PACKET_JSON> <FRAGMENT_JSON>...');
    }
    const fragments = await Promise.all(fragmentPaths.map(p => readJson(path.resolve(p))));
    await assembleAndWrite(fragments, path.resolve(packetJson));
    const sources = fragments.map(f => `${f.source.adapter}/${f.source.credentialContext}`).join(', ');
    console.log(`packet: ${packetJson} (sources: ${sources})`);
    return;
  }
```

- [ ] **Step 4: Run the full suite to verify it passes**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — all tests, including the new CLI-level test. Confirm the pre-existing success-path tests (`'the CLI-directory fast path produces a diff fragment...'`, `'the standalone capability CLI mode binds a local-git diff...'`) still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs \
        ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "fix(pr-review-graph): write a sanitized failure artifact from Azure packet/directory CLI modes"
```

---

### Task 3: Document the failure artifact in the provider reference

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md:164`

**Interfaces:**
- Consumes: nothing new — documents the behavior from Task 2.
- Produces: nothing new — documentation only.

- [ ] **Step 1: Update §6 ("Assembly")**

In `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md`, replace this sentence in the paragraph that currently ends "…a fragment too broken to sanitize at all (missing `schemaVersion` or every capability) is dropped and listed in `providerData.access.rejectedFragments`. If assembly reports missing capabilities, show its sanitized attempt ledger and stop before agent dispatch. A complete `<PACKET_JSON>` with all nine capabilities is required; code-only access is insufficient even when the diff and changed files are complete.":

```
Include only files that exist. For a capability more than one fragment completed, the assembler prefers `azure-cli` and `azure-rest` over hand-transcribed MCP or manual fragments regardless of capture order, and every candidate stays in the attempt ledger. A malformed capability in one fragment — for example a broken `bluebird.json` — is downgraded to an incomplete/malformed entry in that ledger rather than aborting assembly of the other fragments; a fragment too broken to sanitize at all (missing `schemaVersion` or every capability) is dropped and listed in `providerData.access.rejectedFragments`. If assembly reports missing capabilities, show its sanitized attempt ledger and stop before agent dispatch. A complete `<PACKET_JSON>` with all nine capabilities is required; code-only access is insufficient even when the diff and changed files are complete.
```

with:

```
Include only files that exist. For a capability more than one fragment completed, the assembler prefers `azure-cli` and `azure-rest` over hand-transcribed MCP or manual fragments regardless of capture order, and every candidate stays in the attempt ledger. A malformed capability in one fragment — for example a broken `bluebird.json` — is downgraded to an incomplete/malformed entry in that ledger rather than aborting assembly of the other fragments; a fragment too broken to sanitize at all (missing `schemaVersion` or every capability) is dropped and listed in `providerData.access.rejectedFragments`. If the `packet` command exits non-zero, `<PACKET_JSON>` itself now holds a sanitized `assembled: false` failure artifact — `missingCapabilities`, `selectedCapabilities` (sources for capabilities that did complete), the full `attempts` ledger, and `rejectedFragments` — so read that file rather than relying on the printed message alone before stopping. A complete `<PACKET_JSON>` with all nine capabilities is required; code-only access is insufficient even when the diff and changed files are complete.
```

- [ ] **Step 2: Confirm the doc change doesn't break plugin validation**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: PASS — `validate-plugin.mjs` only checks structural/JSON concerns, not this prose.

- [ ] **Step 3: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md
git commit -m "docs(pr-review-graph): document the Azure assembly failure artifact"
```

---

### Task 4: Full validation pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — all tests in `tests/azure-access.test.mjs` and `tests/plugin.test.mjs`.

- [ ] **Step 2: Run plugin validation**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: PASS.

- [ ] **Step 3: Review the full diff for scope**

Run: `git diff 88e3431 --stat`
Expected: only `assemble-azure-context.mjs`, `azure-devops-cli-provider.md`, `tests/azure-access.test.mjs`, and the two new docs files under `docs/superpowers/` are touched.
