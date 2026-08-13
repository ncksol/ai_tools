# Azure CLI partial capability preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `collect-azure-devops.sh` emit every independently successful Azure DevOps CLI capability, marking only the failed operations incomplete, so other adapters fill just the real gaps.

**Architecture:** Each provider operation runs inside a helper that captures its exit status instead of aborting the script, writing a two-line `<capability>.failure` sidecar into the temporary work directory on failure. `assemble-azure-context.mjs` gains a partial raw-directory builder that turns that directory into one nine-capability `azure-cli` fragment, always written, and assembles the packet only when every capability is complete.

**Tech Stack:** Bash 3.2, Node.js >= 18 built-ins only, `node --test`.

## Global Constraints

- Shell must run on stock macOS Bash 3.2: no `mapfile`, `readarray`, `${var,,}`, `${var^^}`, or associative arrays.
- Node scripts use built-in modules only; `package.json` declares `"engines": { "node": ">=18" }`.
- `plugin.json` and `.github/plugin/marketplace.json` stay at version `0.3.0`.
- The fragment schema stays at `schemaVersion` `1.0`; `validateAzureFragment`, `assembleAzureFragments`, adapter authority, and immutable-identity agreement are unchanged.
- Raw provider responses and captured stderr live only in the `mktemp -d` work directory removed by the existing `EXIT` trap. Never write them into the repository, never print them.
- Failure messages are single-line, name the operation, and contain no provider text, URL, token, or PAT value.
- No external-command deadlines, timeouts, or process-tree cancellation: a separate change owns that.
- The read gate does not weaken. A packet still requires all nine capabilities.
- Commit messages carry no `Co-authored-by` or AI-attribution trailers.

Run all commands from `ghcp/plugins/pr-review-graph`.

---

## File Structure

- Modify `skills/review-pull-request/scripts/assemble-azure-context.mjs` — extract `capabilitiesFromRaw`, add `fragmentFromPartialRawDirectory`, extend `directory` mode with an optional fragment path, honour `error.exitCode`.
- Rewrite `skills/review-pull-request/scripts/collect-azure-devops.sh` — per-operation failure capture, sidecar records, always-emitted fragment.
- Modify `skills/review-pull-request/references/azure-devops-cli-provider.md` — new collector contract and failure categories.
- Modify `skills/review-pull-request/SKILL.md` — collector invocation line.
- Create `tests/azure-cli-collector.test.mjs` — end-to-end collector tests with stub `az` and a real temporary Git repository.
- Modify `tests/azure-access.test.mjs` — partial-directory unit tests; update the collector text assertion.

---

## Task 1: Partial raw-directory fragment builder

**Files:**
- Modify: `skills/review-pull-request/scripts/assemble-azure-context.mjs`
- Test: `tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: existing `REQUIRED_AZURE_CAPABILITIES`, `downgradeMalformedCapabilities`, `validateAzureFragment`, `assembleAzureFragments`.
- Produces:
  - `capabilitiesFromRaw(raw) -> Record<string, {complete: true, data: unknown}>` — total, never throws.
  - `fragmentFromPartialRawDirectory(directory: string, source: {adapter, credentialContext, capturedAt?}) -> Promise<fragment>` — always returns a fragment with all nine capabilities.

- [ ] **Step 1: Write the failing tests**

Append to `tests/azure-access.test.mjs`:

```js
test('a partial raw directory keeps collected capabilities and marks the rest incomplete', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-partial-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));
    await writeFile(path.join(dir, 'work-items.json'), JSON.stringify(raw.workItems));
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));
    await writeFile(path.join(dir, 'existingThreads.failure'), 'authentication\naz devops invoke pullRequestThreads failed with exit status 1\n');

    const fragment = await fragmentFromPartialRawDirectory(dir, {
      adapter: 'azure-cli',
      credentialContext: 'current-environment'
    });

    validateAzureFragment(fragment);
    for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies']) {
      assert.equal(fragment.capabilities[name].complete, true, name);
    }
    assert.equal(fragment.capabilities.existingThreads.complete, false);
    assert.equal(fragment.capabilities.existingThreads.failure.category, 'authentication');
    assert.equal(fragment.capabilities.iterations.complete, false);
    assert.equal(fragment.capabilities.iterations.failure.category, 'malformed');
    assert.match(fragment.capabilities.iterations.failure.message, /iterations\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an uncollected list capability is never reported as a valid empty result', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-partial-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));

    const fragment = await fragmentFromPartialRawDirectory(dir, {
      adapter: 'azure-cli',
      credentialContext: 'current-environment'
    });

    assert.equal(fragment.capabilities.workItems.complete, false);
    assert.equal(fragment.capabilities.policies.complete, false);
    assert.equal(fragment.capabilities.existingThreads.complete, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable raw response fails only its own capability', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-partial-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));
    await writeFile(path.join(dir, 'work-items.json'), '{ this is not json');
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));

    const fragment = await fragmentFromPartialRawDirectory(dir, {
      adapter: 'azure-cli',
      credentialContext: 'current-environment'
    });

    assert.equal(fragment.capabilities.workItems.complete, false);
    assert.equal(fragment.capabilities.workItems.failure.category, 'malformed');
    assert.equal(fragment.capabilities.policies.complete, true);
    assert.equal(fragment.capabilities.identity.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a still-paginated change response fails only the changes capability', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-partial-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));
    await writeFile(path.join(dir, 'work-items.json'), JSON.stringify(raw.workItems));
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));
    await writeFile(path.join(dir, 'iterations.json'), JSON.stringify(raw.iterations));
    await writeFile(path.join(dir, 'threads.json'), JSON.stringify(raw.existingThreads));
    await writeFile(path.join(dir, 'diff.patch'), raw.diff);
    await writeFile(
      path.join(dir, 'changes.json'),
      JSON.stringify({ ...raw.changes, nextSkip: 2000, nextTop: 2000 })
    );

    const fragment = await fragmentFromPartialRawDirectory(dir, {
      adapter: 'azure-cli',
      credentialContext: 'current-environment'
    });

    assert.equal(fragment.capabilities.changes.complete, false);
    assert.equal(fragment.capabilities.changes.failure.category, 'malformed');
    for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'existingThreads', 'diff']) {
      assert.equal(fragment.capabilities[name].complete, true, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Add `fragmentFromPartialRawDirectory` to the existing import block at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/azure-access.test.mjs`
Expected: FAIL — `fragmentFromPartialRawDirectory is not a function` / import error.

- [ ] **Step 3: Implement the builder**

In `assemble-azure-context.mjs`, add `readFile` to the `node:fs/promises` import (it is already imported alongside `access`). Replace the body of `fragmentFromRawDirectory` so both builders share one shaping function, and add the partial builder immediately after it:

```js
const CAPABILITY_SOURCES = Object.freeze({
  identity: ['pull-request.json'],
  metadata: ['pull-request.json'],
  snapshot: ['pull-request.json'],
  workItems: ['work-items.json'],
  policies: ['policies.json'],
  iterations: ['iterations.json'],
  changes: ['changes.json'],
  existingThreads: ['threads.json'],
  diff: ['pull-request.json', 'diff.patch']
});

const RAW_FILE_KEYS = Object.freeze({
  'pull-request.json': 'pullRequest',
  'work-items.json': 'workItems',
  'policies.json': 'policies',
  'iterations.json': 'iterations',
  'changes.json': 'changes',
  'threads.json': 'existingThreads',
  'diff.patch': 'diff'
});

function sanitizeMessage(message) {
  return String(message).replace(/\s+/g, ' ').trim();
}

// Shaping must be total: a missing or malformed field becomes a capability
// that assertCapabilityData rejects, never an exception that discards the
// capabilities collected alongside it.
export function capabilitiesFromRaw(raw) {
  const pr = raw.pullRequest ?? {};
  const repository = pr.repository ?? {};
  const webUrl = String(repository.webUrl ?? '').trim();
  return {
    identity: complete({
      pullRequestId: pr.pullRequestId,
      url: pr._links?.web?.href ?? (webUrl ? `${webUrl}/pullrequest/${pr.pullRequestId}` : ''),
      repository
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
    // `az repos pr policy list` has no partial-list mode: it always returns the
    // complete evaluation set, so the CLI route can attest to exhaustion directly.
    policies: complete({ value: asArray(raw.policies), exhausted: true }),
    iterations: complete(raw.iterations),
    changes: complete(raw.changes),
    existingThreads: complete(raw.existingThreads),
    diff: complete({
      repository,
      baseSha: pr.lastMergeTargetCommit?.commitId ?? '',
      headSha: pr.lastMergeSourceCommit?.commitId ?? '',
      patch: raw.diff
    })
  };
}

async function readFailureSidecar(directory, name) {
  let text;
  try {
    text = await readFile(path.join(directory, `${name}.failure`), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const category = sanitizeMessage(lines[0] ?? '');
  if (!category) return { category: 'malformed', message: `${name} failure record is empty` };
  const message = sanitizeMessage(lines.slice(1).join(' '));
  return { category, message: message || `${name} was not collected` };
}

// Each raw file is read independently so one unreadable response cannot
// discard the responses collected next to it, and a file that was never
// written is never defaulted to an empty collection.
async function readRawFiles(directory) {
  const values = {};
  const failures = {};
  await Promise.all(Object.entries(RAW_FILE_KEYS).map(async ([file, key]) => {
    try {
      const text = await readFile(path.join(directory, file), 'utf8');
      values[key] = file === 'diff.patch' ? text : JSON.parse(text);
    } catch (error) {
      failures[file] = {
        category: 'malformed',
        message: error.code === 'ENOENT'
          ? `${file} was not collected`
          : `${file} could not be read: ${error.code ?? 'invalid JSON'}`
      };
    }
  }));
  return { values, failures };
}

export async function fragmentFromPartialRawDirectory(directory, source) {
  const { values, failures } = await readRawFiles(directory);
  const shaped = capabilitiesFromRaw(values);
  const capabilities = {};

  for (const name of REQUIRED_AZURE_CAPABILITIES) {
    const recorded = await readFailureSidecar(directory, name);
    if (recorded) {
      capabilities[name] = { complete: false, failure: recorded };
      continue;
    }
    const missing = CAPABILITY_SOURCES[name].map(file => failures[file]).filter(Boolean);
    capabilities[name] = missing.length
      ? { complete: false, failure: missing[0] }
      : shaped[name];
  }

  return {
    schemaVersion: '1.0',
    source: { ...source, capturedAt: source.capturedAt ?? new Date().toISOString() },
    capabilities: downgradeMalformedCapabilities(capabilities)
  };
}
```

Replace the existing `fragmentFromRawDirectory` body with the shared shaping call:

```js
export async function fragmentFromRawDirectory(directory, source) {
  await Promise.all(RAW_FILES.map(file => access(path.join(directory, file))));
  const raw = await loadRawDirectory('azure-devops', directory);
  return {
    schemaVersion: '1.0',
    source: { ...source, capturedAt: source.capturedAt ?? new Date().toISOString() },
    capabilities: capabilitiesFromRaw(raw)
  };
}
```

`complete(data)` is already declared in the module as a hoisted function, so `capabilitiesFromRaw` can call it without moving anything.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/azure-access.test.mjs`
Expected: PASS, including the pre-existing `CLI-sourced policies carry exhausted evidence because az has no partial-list mode` test.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "feat(pr-review-graph): build Azure fragments from a partial CLI raw directory"
```

---

## Task 2: Fragment-emitting `directory` mode

**Files:**
- Modify: `skills/review-pull-request/scripts/assemble-azure-context.mjs:348-360` (the `directory` branch of `main`) and the `main().catch` handler
- Test: `tests/azure-access.test.mjs`

**Interfaces:**
- Consumes: `fragmentFromPartialRawDirectory` from Task 1.
- Produces: CLI contract `assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON> [<FRAGMENT_JSON>]`. Exit `0` = fragment and packet written; exit `1` = fragment written, packet withheld; exit `2` = no fragment could be written.

- [ ] **Step 1: Write the failing tests**

Append to `tests/azure-access.test.mjs`:

```js
const assembler = path.join(root, 'skills/review-pull-request/scripts/assemble-azure-context.mjs');

test('directory mode writes a fragment and withholds the packet when a capability is missing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-dirmode-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));
    await writeFile(path.join(dir, 'work-items.json'), JSON.stringify(raw.workItems));
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));
    await writeFile(path.join(dir, 'existingThreads.failure'), 'authentication\naz devops invoke pullRequestThreads failed with exit status 1\n');

    const packetJson = path.join(dir, 'out', 'packet.json');
    const fragmentJson = path.join(dir, 'out', 'fragment.json');
    const result = spawnSync(
      process.execPath,
      [assembler, 'directory', dir, 'azure-cli', 'current-environment', packetJson, fragmentJson],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(fragment.capabilities.identity.complete, true);
    assert.equal(fragment.capabilities.existingThreads.complete, false);
    assert.match(result.stdout, /fragment:/);
    assert.match(result.stderr, /existingThreads \(authentication\)/);
    await assert.rejects(readFile(packetJson, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('directory mode writes both the fragment and the packet when every capability is complete', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prg-azure-dirmode-'));
  try {
    await writeFile(path.join(dir, 'pull-request.json'), JSON.stringify(raw.pullRequest));
    await writeFile(path.join(dir, 'work-items.json'), JSON.stringify(raw.workItems));
    await writeFile(path.join(dir, 'policies.json'), JSON.stringify(raw.policies));
    await writeFile(path.join(dir, 'iterations.json'), JSON.stringify(raw.iterations));
    await writeFile(path.join(dir, 'changes.json'), JSON.stringify(raw.changes));
    await writeFile(path.join(dir, 'threads.json'), JSON.stringify(raw.existingThreads));
    await writeFile(path.join(dir, 'diff.patch'), raw.diff);

    const packetJson = path.join(dir, 'out', 'packet.json');
    const fragmentJson = path.join(dir, 'out', 'fragment.json');
    const result = spawnSync(
      process.execPath,
      [assembler, 'directory', dir, 'azure-cli', 'current-environment', packetJson, fragmentJson],
      { encoding: 'utf8' }
    );

    assert.equal(result.status, 0, result.stderr);
    const packet = JSON.parse(await readFile(packetJson, 'utf8'));
    assert.equal(packet.providerData.access.capabilities.identity.adapter, 'azure-cli');
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(Object.keys(fragment.capabilities).length, REQUIRED_AZURE_CAPABILITIES.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/azure-access.test.mjs`
Expected: FAIL — `directory` mode ignores the sixth argument and exits `1` without writing a fragment.

- [ ] **Step 3: Implement the mode**

Replace the `directory` branch inside `main()`:

```js
  if (mode === 'directory') {
    const [rawDir, adapter, credentialContext, packetJson, fragmentJson] = args;
    if (!rawDir || !adapter || !credentialContext || !packetJson) {
      throw new Error('Usage: assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON> [<FRAGMENT_JSON>]');
    }

    if (!fragmentJson) {
      const fragment = await fragmentFromRawDirectory(path.resolve(rawDir), { adapter, credentialContext });
      const packet = assembleAzureFragments([fragment]);
      await writeJson(path.resolve(packetJson), packet);
      console.log(`packet: ${packetJson} (source: ${adapter}/${credentialContext})`);
      return;
    }

    const fragment = await fragmentFromPartialRawDirectory(path.resolve(rawDir), { adapter, credentialContext });
    try {
      await mkdir(path.dirname(path.resolve(fragmentJson)), { recursive: true });
      await writeJson(path.resolve(fragmentJson), fragment);
    } catch (error) {
      throw Object.assign(new Error(`Could not write the Azure access fragment: ${error.code ?? error.message}`), { exitCode: 2 });
    }
    console.log(`fragment: ${fragmentJson} (source: ${adapter}/${credentialContext})`);

    const incomplete = REQUIRED_AZURE_CAPABILITIES
      .filter(name => !fragment.capabilities[name].complete);
    if (incomplete.length) {
      for (const name of incomplete) {
        console.error(`incomplete: ${name} (${fragment.capabilities[name].failure.category})`);
      }
      throw Object.assign(
        new Error(`Azure CLI collection is incomplete: ${incomplete.join(', ')}`),
        { exitCode: 1 }
      );
    }

    const packet = assembleAzureFragments([fragment]);
    await mkdir(path.dirname(path.resolve(packetJson)), { recursive: true });
    await writeJson(path.resolve(packetJson), packet);
    console.log(`packet: ${packetJson} (source: ${adapter}/${credentialContext})`);
    return;
  }
```

Add `mkdir` to the `node:fs/promises` import, and honour the exit code in the entry point:

```js
if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/azure-access.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/assemble-azure-context.mjs ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "feat(pr-review-graph): emit an Azure CLI fragment before packet assembly"
```

---

## Task 3: Per-operation failure capture in the collector

**Files:**
- Rewrite: `skills/review-pull-request/scripts/collect-azure-devops.sh`
- Modify: `tests/azure-access.test.mjs:829-838` (the collector text assertion)
- Test: `tests/azure-cli-collector.test.mjs` (create)

**Interfaces:**
- Consumes: `assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON> <FRAGMENT_JSON>` from Task 2.
- Produces: `collect-azure-devops.sh <PR_ID> <PACKET_JSON> [<FRAGMENT_JSON>]`; default fragment path `<dirname PACKET_JSON>/azure-cli-<slug>.fragment.json`; exit `0` complete, `1` partial, `2` usage or missing prerequisite.

- [ ] **Step 1: Write the failing tests**

Create `tests/azure-cli-collector.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collector = path.join(root, 'skills/review-pull-request/scripts/collect-azure-devops.sh');
const raw = JSON.parse(await readFile(path.join(root, 'tests/fixtures/azure-raw.json'), 'utf8'));

const AZ_STUB = `#!/bin/sh
op=""
case "$1 $2 $3" in
  "repos pr show") op=show ;;
  "repos pr work-item") op=work-items ;;
  "repos pr policy") op=policies ;;
esac
if [ "$1" = "devops" ]; then
  case "$*" in
    *pullRequestIterationChanges*) op=changes ;;
    *pullRequestIterations*) op=iterations ;;
    *pullRequestThreads*) op=threads ;;
  esac
fi
if [ -z "$op" ]; then
  echo "unexpected az invocation: $*" >&2
  exit 64
fi
if [ "$op" = "$PRG_STUB_FAIL_OP" ]; then
  printf '%s\\n' "$PRG_STUB_FAIL_STDERR" >&2
  exit 1
fi
cat "$PRG_STUB_RESPONSES/$op.json"
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// A real repository with real commits keeps the diff capability honest: the
// collector must fetch nothing and produce a genuine patch.
async function scenario() {
  const base = await mkdtemp(path.join(tmpdir(), 'prg-azure-cli-'));
  const repo = path.join(base, 'widgets');
  const bin = path.join(base, 'bin');
  const responses = path.join(base, 'responses');
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(responses, { recursive: true });

  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/acme/Platform/_git/widgets.git');
  await writeFile(path.join(repo, 'schema.sql'), 'CREATE TABLE users (id INT PRIMARY KEY);\n');
  git(repo, 'add', 'schema.sql');
  git(repo, 'commit', '--quiet', '-m', 'base');
  const targetSha = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'schema.sql'), 'CREATE TABLE users (id INT PRIMARY KEY, email TEXT);\n');
  git(repo, 'add', 'schema.sql');
  git(repo, 'commit', '--quiet', '-m', 'head');
  const sourceSha = git(repo, 'rev-parse', 'HEAD');

  const pullRequest = {
    ...raw.pullRequest,
    lastMergeSourceCommit: { commitId: sourceSha },
    lastMergeTargetCommit: { commitId: targetSha }
  };
  await writeFile(path.join(responses, 'show.json'), JSON.stringify(pullRequest));
  await writeFile(path.join(responses, 'work-items.json'), JSON.stringify(raw.workItems));
  await writeFile(path.join(responses, 'policies.json'), JSON.stringify(raw.policies));
  await writeFile(path.join(responses, 'iterations.json'), JSON.stringify(raw.iterations));
  await writeFile(path.join(responses, 'changes.json'), JSON.stringify(raw.changes));
  await writeFile(path.join(responses, 'threads.json'), JSON.stringify(raw.existingThreads));

  await writeFile(path.join(bin, 'az'), AZ_STUB);
  await chmod(path.join(bin, 'az'), 0o755);

  return { base, repo, bin, responses, sourceSha, targetSha };
}

function run(context, args, env = {}) {
  return spawnSync('bash', [collector, ...args], {
    cwd: context.repo,
    encoding: 'utf8',
    env: {
      PATH: `${context.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: context.base,
      PRG_STUB_RESPONSES: context.responses,
      ...env
    }
  });
}

test('a complete CLI run writes both the fragment and the packet', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson]);

    assert.equal(result.status, 0, result.stderr);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    for (const name of Object.keys(fragment.capabilities)) {
      assert.equal(fragment.capabilities[name].complete, true, name);
    }
    const packet = JSON.parse(await readFile(packetJson, 'utf8'));
    assert.equal(packet.pullRequest.head.sha, context.sourceSha);
    assert.match(fragment.capabilities.diff.data.patch, /email TEXT/);
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('a late thread failure preserves every capability collected before it', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson], {
      PRG_STUB_FAIL_OP: 'threads',
      PRG_STUB_FAIL_STDERR: 'TF400813: user is not authorized'
    });

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'diff']) {
      assert.equal(fragment.capabilities[name].complete, true, name);
    }
    assert.equal(fragment.capabilities.existingThreads.complete, false);
    assert.equal(fragment.capabilities.existingThreads.failure.category, 'authentication');
    assert.doesNotMatch(fragment.capabilities.existingThreads.failure.message, /TF400813|not authorized/);
    assert.doesNotMatch(result.stdout + result.stderr, /TF400813|not authorized/);
    await assert.rejects(readFile(packetJson, 'utf8'));
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('a failed PR read still yields the independently collected capabilities', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson], {
      PRG_STUB_FAIL_OP: 'show',
      PRG_STUB_FAIL_STDERR: 'connection reset'
    });

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(fragment.capabilities.workItems.complete, true);
    assert.equal(fragment.capabilities.policies.complete, true);
    assert.equal(fragment.capabilities.identity.complete, false);
    assert.equal(fragment.capabilities.identity.failure.category, 'command-failed');
    assert.equal(fragment.capabilities.iterations.failure.category, 'dependency-unavailable');
    assert.equal(fragment.capabilities.changes.failure.category, 'dependency-unavailable');
    assert.equal(fragment.capabilities.diff.failure.category, 'dependency-unavailable');
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('a missing az CLI records every capability as tool-unavailable', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = spawnSync('bash', [collector, '77', packetJson, fragmentJson], {
      cwd: context.repo,
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: context.base
      }
    });

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    for (const name of Object.keys(fragment.capabilities)) {
      assert.equal(fragment.capabilities[name].complete, false, name);
      assert.equal(fragment.capabilities[name].failure.category, 'tool-unavailable', name);
    }
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('an origin that is not the Azure repository fails only the diff capability', async () => {
  const context = await scenario();
  try {
    git(context.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/acme/Platform/_git/gadgets.git');
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson]);

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(fragment.capabilities.diff.complete, false);
    assert.equal(fragment.capabilities.diff.failure.category, 'repository-mismatch');
    assert.equal(fragment.capabilities.identity.complete, true);
    assert.equal(fragment.capabilities.existingThreads.complete, true);
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('the fragment path defaults beside the packet and is printed', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const result = run(context, ['77', packetJson], { PRG_AZURE_CREDENTIAL_CONTEXT: 'stored az/login' });

    assert.equal(result.status, 0, result.stderr);
    const expected = path.join(context.base, 'out/azure-cli-stored-az-login.fragment.json');
    assert.match(result.stdout, /fragment: /);
    const fragment = JSON.parse(await readFile(expected, 'utf8'));
    assert.equal(fragment.source.credentialContext, 'stored az/login');
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('wrong argument counts are rejected without a fragment', async () => {
  const context = await scenario();
  try {
    const result = run(context, ['77']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: collect-azure-devops\.sh/);
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});
```

Update the existing assertion in `tests/azure-access.test.mjs` so it describes the new contract:

```js
test('Azure CLI collector routes its raw directory through the access assembler with a fragment', async () => {
  const collector = await readFile(
    path.join(root, 'skills/review-pull-request/scripts/collect-azure-devops.sh'),
    'utf8'
  );
  assert.match(collector, /assemble-azure-context\.mjs" directory/);
  assert.match(collector, /PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment/);
  assert.match(collector, /fragment_file/);
  assert.doesNotMatch(collector, /normalize-context\.mjs" \\\n\s+--provider azure-devops/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/azure-cli-collector.test.mjs`
Expected: FAIL — the collector aborts on the first failure and never writes a fragment.

- [ ] **Step 3: Rewrite the collector**

Replace the whole of `skills/review-pull-request/scripts/collect-azure-devops.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: collect-azure-devops.sh <PR id> <packet.json> [fragment.json]" >&2
  exit 2
fi

pr_id="$1"
output_file="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
credential_context="${PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment}"
context_slug="$(printf '%s' "$credential_context" | tr -c 'A-Za-z0-9._-' '-')"
fragment_file="${3:-$(dirname "$output_file")/azure-cli-${context_slug}.fragment.json}"

command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "Git is required" >&2; exit 2; }

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

failure_category=""
failure_message=""

# Failure records stay one category line plus one sanitized message line so the
# Bash 3.2 collector never has to quote JSON, and captured provider stderr never
# leaves the work directory.
record_failure() {
  printf '%s\n%s\n' "$2" "$(printf '%s' "$3" | tr '\n\r' '  ')" >"$work_dir/$1.failure"
}

record_failures() {
  local category="$1"
  local message="$2"
  local name
  shift 2
  for name in "$@"; do
    record_failure "$name" "$category" "$message"
  done
}

classify_stderr() {
  if grep -qiE 'TF400813|TF401019|unauthorized|forbidden|not authorized|az login|401|403' "$1" 2>/dev/null; then
    printf 'authentication'
  else
    printf 'command-failed'
  fi
}

# Runs one provider operation without letting `set -e` abort the collector, so a
# later failure cannot discard the responses already collected.
run_operation() {
  local label="$1"
  local out="$2"
  local status=0
  shift 2
  "$@" >"$out" 2>"$work_dir/stderr.txt" || status=$?
  if [[ $status -eq 0 ]]; then
    return 0
  fi
  failure_category="$(classify_stderr "$work_dir/stderr.txt")"
  failure_message="$label failed with exit status $status"
  rm -f -- "$out" "$work_dir/stderr.txt"
  return 1
}

if ! command -v az >/dev/null 2>&1; then
  record_failures tool-unavailable "Azure CLI is not installed" \
    identity metadata snapshot workItems policies iterations changes existingThreads diff
else
  pr_show_ok=0
  if run_operation "az repos pr show" "$work_dir/pull-request.json" \
    az repos pr show --id "$pr_id" --output json; then
    pr_show_ok=1
  else
    record_failures "$failure_category" "$failure_message" identity metadata snapshot
  fi

  if ! run_operation "az repos pr work-item list" "$work_dir/work-items.json" \
    az repos pr work-item list --id "$pr_id" --output json; then
    record_failure workItems "$failure_category" "$failure_message"
  fi

  if ! run_operation "az repos pr policy list" "$work_dir/policies.json" \
    az repos pr policy list --id "$pr_id" --output json; then
    record_failure policies "$failure_category" "$failure_message"
  fi

  project_id=""
  repository_id=""
  repository_name=""
  source_sha=""
  target_sha=""
  source_ref=""
  target_ref=""
  organization_url=""
  pr_values=()

  if [[ $pr_show_ok -eq 1 ]]; then
    if node -e '
      const fs=require("fs");
      const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const r=p.repository ?? {}, project=r.project ?? {}, url=r.webUrl ?? p.url ?? "";
      let org="";
      let m=url.match(/https?:\/\/dev\.azure\.com\/([^/]+)/i);
      if (m) org=`https://dev.azure.com/${m[1]}`;
      m=url.match(/https?:\/\/([^.]+)\.visualstudio\.com/i);
      if (!org && m) org=`https://${m[1]}.visualstudio.com`;
      for (const value of [project.id ?? project.name ?? "", r.id ?? "", r.name ?? "", p.lastMergeSourceCommit?.commitId ?? "", p.lastMergeTargetCommit?.commitId ?? "", p.sourceRefName ?? "", p.targetRefName ?? "", org]) console.log(String(value));
    ' "$work_dir/pull-request.json" >"$work_dir/pr-values.txt" 2>/dev/null; then
      while IFS= read -r line; do
        pr_values+=("$line")
      done <"$work_dir/pr-values.txt"
      project_id="${pr_values[0]:-}"
      repository_id="${pr_values[1]:-}"
      repository_name="${pr_values[2]:-}"
      source_sha="${pr_values[3]:-}"
      target_sha="${pr_values[4]:-}"
      source_ref="${pr_values[5]:-}"
      target_ref="${pr_values[6]:-}"
      organization_url="${pr_values[7]:-}"
    fi
  fi

  provider_scope_ok=1
  for required in project_id repository_id organization_url; do
    if [[ -z "${!required}" ]]; then
      provider_scope_ok=0
    fi
  done

  iterations_ok=0
  if [[ $provider_scope_ok -eq 1 ]]; then
    if run_operation "az devops invoke pullRequestIterations" "$work_dir/iterations.json" \
      az devops invoke \
        --organization "$organization_url" \
        --area git \
        --resource pullRequestIterations \
        --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" \
        --api-version 7.1 \
        --output json; then
      iterations_ok=1
    else
      record_failure iterations "$failure_category" "$failure_message"
    fi

    if ! run_operation "az devops invoke pullRequestThreads" "$work_dir/threads.json" \
      az devops invoke \
        --organization "$organization_url" \
        --area git \
        --resource pullRequestThreads \
        --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" \
        --api-version 7.1 \
        --output json; then
      record_failure existingThreads "$failure_category" "$failure_message"
    fi
  else
    record_failures dependency-unavailable "Azure PR project, repository, or organization was not collected" \
      iterations existingThreads
  fi

  iteration_id=0
  if [[ $iterations_ok -eq 1 ]]; then
    iteration_id="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const a=Array.isArray(x)?x:(x.value??[]); process.stdout.write(String(Math.max(0,...a.map(v=>Number(v.id??0)))))' "$work_dir/iterations.json" 2>/dev/null || printf '0')"
  fi

  if [[ "$iteration_id" =~ ^[0-9]+$ ]] && [[ "$iteration_id" -gt 0 ]]; then
    if ! run_operation "az devops invoke pullRequestIterationChanges" "$work_dir/changes.json" \
      az devops invoke \
        --organization "$organization_url" \
        --area git \
        --resource pullRequestIterationChanges \
        --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" iterationId="$iteration_id" \
        --query-parameters '$compareTo=0' '$top=2000' \
        --api-version 7.1 \
        --output json; then
      record_failure changes "$failure_category" "$failure_message"
    fi
  else
    record_failure changes dependency-unavailable "No Azure DevOps PR iteration id was collected"
  fi

  collect_diff() {
    if [[ -z "$source_sha" || -z "$target_sha" || -z "$repository_name" ]]; then
      record_failure diff dependency-unavailable "Azure PR snapshot SHAs or repository name were not collected"
      return
    fi
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      record_failure diff repository-mismatch "The working directory is not a Git repository"
      return
    fi
    local origin_url
    if ! origin_url="$(git remote get-url origin 2>/dev/null)"; then
      record_failure diff repository-mismatch "The Git repository has no origin remote"
      return
    fi
    local origin_name origin_lower repository_lower
    origin_name="$(basename "${origin_url%.git}")"
    origin_lower="$(printf '%s' "$origin_name" | tr '[:upper:]' '[:lower:]')"
    repository_lower="$(printf '%s' "$repository_name" | tr '[:upper:]' '[:lower:]')"
    if [[ "$origin_lower" != "$repository_lower" ]]; then
      record_failure diff repository-mismatch "The local Git repository is not the Azure repository for this PR"
      return
    fi
    local sha ref
    for sha in "$target_sha" "$source_sha"; do
      ref="$target_ref"
      if [[ "$sha" == "$source_sha" ]]; then
        ref="$source_ref"
      fi
      if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
        continue
      fi
      git fetch --no-tags --no-recurse-submodules origin "$sha" >/dev/null 2>&1 ||
        git fetch --no-tags --no-recurse-submodules origin "$ref" >/dev/null 2>&1 || true
      if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
        record_failure diff command-failed "Commit $sha could not be obtained from origin"
        return
      fi
    done
    if ! git diff --find-renames --no-ext-diff --no-color --unified=80 \
      "$target_sha...$source_sha" >"$work_dir/diff.patch" 2>/dev/null; then
      rm -f -- "$work_dir/diff.patch"
      record_failure diff command-failed "git diff failed for the captured PR commits"
    fi
  }

  collect_diff
fi

mkdir -p "$(dirname "$output_file")" "$(dirname "$fragment_file")"

assemble_status=0
node "$script_dir/assemble-azure-context.mjs" directory \
  "$work_dir" \
  azure-cli \
  "$credential_context" \
  "$output_file" \
  "$fragment_file" || assemble_status=$?

if [[ $assemble_status -ne 0 ]]; then
  exit "$assemble_status"
fi

echo "Captured Azure DevOps PR $pr_id at $output_file"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/azure-cli-collector.test.mjs tests/azure-access.test.mjs`
Expected: PASS.

Then check the syntax and Bash 3.2 rules explicitly:

Run: `bash -n skills/review-pull-request/scripts/collect-azure-devops.sh && node --test tests/plugin.test.mjs`
Expected: no syntax output; PASS.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops.sh ghcp/plugins/pr-review-graph/tests/azure-cli-collector.test.mjs ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs
git commit -m "fix(pr-review-graph): preserve successful Azure CLI capabilities after a later failure"
```

---

## Task 4: Document the collector contract

**Files:**
- Modify: `skills/review-pull-request/references/azure-devops-cli-provider.md:21-53` and `:148-164`
- Modify: `skills/review-pull-request/SKILL.md:71`

**Interfaces:**
- Consumes: the collector contract from Task 3.
- Produces: no code interface. The provider guide stops instructing a blanket `failure … all` fragment after a failed CLI run.

- [ ] **Step 1: Replace section 2 of the provider guide**

Replace everything from `## 2. CLI fast path` up to (but excluding) `## 3. REST fragments` with:

````markdown
## 2. CLI fast path

Run the collector once with the current environment:

```bash
bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON> <WORK_DIR>/cli-current.json
```

Run it a second time only when `AZURE_DEVOPS_EXT_PAT` is present and the first command failed, with the injected PAT removed so the collector falls back to a stored `az login` context:

```bash
env -u AZURE_DEVOPS_EXT_PAT \
  PRG_AZURE_CREDENTIAL_CONTEXT=stored-az-login \
  bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON> <WORK_DIR>/cli-stored.json
```

The collector always writes the fragment named by its third argument, whether the run succeeded, partially succeeded, or failed. Omit that argument only if you accept the default path `<dirname PACKET_JSON>/azure-cli-<credential-context>.fragment.json`, which the collector prints on stdout. `<PACKET_JSON>` is written only when all nine capabilities are complete.

| Exit status | Meaning |
| --- | --- |
| `0` | Every capability complete; fragment and packet written |
| `1` | Fragment written; at least one capability incomplete, so no packet |
| `2` | Usage error, or `node`/`git` missing, so no fragment exists |

Pass every fragment the collector wrote to assembler `packet` mode. Do not write a separate blanket `failure … all` fragment for a CLI attempt that produced one: the collector already records each capability it collected and marks only the failed operations incomplete, with these categories.

| Category | Meaning |
| --- | --- |
| `tool-unavailable` | `az` or the Azure DevOps extension is absent |
| `authentication` | The operation failed with an authorization signal |
| `command-failed` | The operation exited non-zero for another reason |
| `dependency-unavailable` | A prerequisite capability or field was not collected |
| `repository-mismatch` | The local Git origin is not the Azure repository for this PR |
| `malformed` | The response is missing, unreadable, or fails shape validation |

Use assembler `failure` mode only for an attempt that produced no fragment at all — an exit status of `2`, or an adapter you could not invoke:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli current-environment tool-unavailable \
  "Azure CLI could not be invoked" all \
  <WORK_DIR>/cli-current-failure.json
```

Do not print either command's raw authentication error to the user or into any persisted file. The collector keeps captured stderr inside its own temporary directory and deletes it on exit.
````

- [ ] **Step 2: Update the assembly list in section 6**

In `## 6. Assembly`, replace the fragment list so it names the collector's own fragments:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs packet \
  <PACKET_JSON> \
  <WORK_DIR>/cli-current.json \
  <WORK_DIR>/cli-stored.json \
  <WORK_DIR>/rest-anonymous.json \
  <WORK_DIR>/rest-pat.json \
  <WORK_DIR>/rest-entra.json \
  <WORK_DIR>/bluebird.json \
  <WORK_DIR>/git-diff.json
```

Immediately after that code block, before the sentence beginning `Include only files that exist.`, add:

```markdown
A partially successful CLI fragment is a contributor like any other: the capabilities it completed are selected normally, and the other adapters need only cover the capabilities it marked incomplete.
```

- [ ] **Step 3: Update the SKILL.md invocation**

Replace line 71's code block in `skills/review-pull-request/SKILL.md`:

```bash
bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON> <WORK_DIR>/cli-current.json
```

And extend the paragraph that follows it so it reads:

```markdown
For Azure DevOps, a failed collector command is one adapter result, not proof that the PR is inaccessible. The collector always writes its fragment, preserving the capabilities it did collect, and writes `<PACKET_JSON>` only when all nine are complete. Follow the fallback and fragment-composition sequence in the provider reference. The review may proceed only after `assemble-azure-context.mjs` produces a complete packet.
```

- [ ] **Step 4: Verify the documentation matches the code**

Run: `npm test && npm run validate`
Expected: PASS; validation reports the required references and scripts.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md
git commit -m "docs(pr-review-graph): document the partial Azure CLI collector contract"
```

---

## Task 5: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS with no failing subtests.

- [ ] **Step 2: Run plugin validation**

Run: `npm run validate`
Expected: `Plugin validation passed: … zero required MCP and hook dependencies.`

- [ ] **Step 3: Check shell syntax on both collectors**

Run: `bash -n skills/review-pull-request/scripts/collect-azure-devops.sh && bash -n skills/review-pull-request/scripts/collect-github.sh`
Expected: no output.

- [ ] **Step 4: Check whitespace**

Run: `git diff --check 88e3431 HEAD`
Expected: no output.

- [ ] **Step 5: Confirm the plugin version is untouched**

Run: `git diff 88e3431 HEAD -- ghcp/plugins/pr-review-graph/plugin.json .github/plugin/marketplace.json`
Expected: no output — both stay at `0.3.0`.
