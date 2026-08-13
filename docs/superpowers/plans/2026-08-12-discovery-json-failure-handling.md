# Discovery JSON Failure Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR Review Graph strictly validate every discovery response, retain redacted failure diagnostics, and stop before verification whenever routed discovery coverage remains incomplete after one retry.

**Architecture:** A new deterministic `process-discovery.mjs` utility owns the model-output boundary. Its `ingest` operation strictly parses and validates one specialist attempt; its `finalize` operation compares terminal attempt results with the immutable review plan and writes merged candidates only when every routed batch completed.

**Tech Stack:** Node.js >= 18, Node built-ins, `node:test`, Markdown agent and skill prompts. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-discovery-json-failure-handling-design.md`

## Global Constraints

- Run plugin commands from `ghcp/plugins/pr-review-graph`: `npm test` and `npm run validate`.
- Use Node.js >= 18 and Node built-ins only. Do not change `package.json` or add a dependency.
- Parse specialist output as strict JSON. Do not strip code fences, escape malformed content, or otherwise repair a response.
- Retry an invalid discovery batch once. A second invalid attempt stops the graph before verification.
- Never create `CANDIDATES_JSON` when any routed batch remains incomplete or failed.
- Store failed responses only as mode-`0600`, JSON-encoded, deterministically redacted diagnostics under the run's temporary directory.
- Keep every custom agent on `tools: []`.
- Preserve the six finding categories and all existing confidence thresholds.
- The installable plugin version must end at `0.2.5` in both `plugin.json` and the root marketplace entry. Leave `package.json` at `0.2.0` and marketplace `metadata.version` at `1.0.0`.
- Commit messages must not contain a `Co-authored-by` trailer or any AI attribution trailer.
- Work on the current branch, `nicksologoub-microsoft-fix-discovery-json-failures`.

## File Map

| File | Responsibility |
| --- | --- |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs` | New strict ingestion, redaction, attempt envelopes, coverage classification, and candidate merge gate |
| `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` | Regression tests for escaped controls, malformed controls, redaction, cleanup, retry recovery, failed coverage, and prompt contracts |
| `ghcp/plugins/pr-review-graph/agents/prg-{contract,correctness,tests,security,data-compatibility,reliability}.agent.md` | Unambiguous strict JSON-array output contracts |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md` | Orchestration commands, retry protocol, and hard stop before Phase 3 |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md` | Authoritative discovery coverage semantics |
| `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs` | Required-script and discovery-prompt static validation |
| `ghcp/plugins/pr-review-graph/README.md` | User-visible fail-closed discovery behavior |
| `ghcp/plugins/pr-review-graph/plugin.json` | Plugin release version |
| `.github/plugin/marketplace.json` | Matching marketplace plugin version |

---

### Task 1: Strict discovery-response ingestion

**Files:**
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs`

**Interfaces:**
- Consumes: `validateFindings(value, { mode: "candidate" })` from `validate-findings.mjs`.
- Produces: `DISCOVERY_CATEGORIES`, `discoveryResultFileName(agent, batch, attempt)`, `redactDiagnosticText(value)`, and `ingestDiscoveryResponse(rawFile, resultDirectory, diagnosticsDirectory, options)`.
- Produces on disk: `<agent>-batch-<NNN>-attempt-<N>.json`, with either `status: "complete"` and `findings`, or `status: "invalid"` and a safe `failure` object.
- Deletes: the unredacted `rawFile` in a `finally` block on every path.

- [ ] **Step 1: Add test imports and a valid candidate helper**

In `tests/plugin.test.mjs`, add `access` to the `node:fs/promises` import and add:

```js
import {
  discoveryResultFileName,
  ingestDiscoveryResponse
} from '../skills/review-pull-request/scripts/process-discovery.mjs';
```

Below `fixture()`, add:

```js
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
```

- [ ] **Step 2: Write the failing escaped-control test**

Append this test before `BASH4_ONLY`:

```js
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
```

- [ ] **Step 3: Run the escaped-control test to verify it fails**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test tests/plugin.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `process-discovery.mjs`.

- [ ] **Step 4: Write the failing malformed-response and redaction test**

Append:

```js
test('discovery ingestion rejects literal controls and retains only redacted diagnostics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-invalid-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890ABCD'].join('_');
    const jwt = [
      'eyJhbGciOiJIUzI1NiJ9',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      'c2lnbmF0dXJlMTIzNDU2'
    ].join('.');
    const candidate = discoveryCandidate('correctness', {
      evidence: 'first line\nsecond line',
      recommendation: `Authorization: Bearer bearer-secret; token=${githubToken}; jwt=${jwt}`,
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
    for (const secret of ['bearer-secret', githubToken, jwt, 'password-secret', 'ZmFrZQ==']) {
      assert.doesNotMatch(diagnostic.response, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(diagnostic.response, /<redacted/);
    await assert.rejects(access(rawFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 5: Run both ingestion tests to verify they fail**

Run:

```bash
node --test tests/plugin.test.mjs
```

Expected: FAIL because the imported module does not exist.

- [ ] **Step 6: Implement strict ingestion and redaction**

Create `skills/review-pull-request/scripts/process-discovery.mjs` with these public constants and helpers:

```js
#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMain, parseFlags } from './lib.mjs';
import { validateFindings } from './validate-findings.mjs';

export const DISCOVERY_CATEGORIES = Object.freeze({
  'prg-contract': 'contract',
  'prg-correctness': 'correctness',
  'prg-tests': 'tests',
  'prg-security': 'security',
  'prg-data-compatibility': 'data-compatibility',
  'prg-reliability': 'reliability'
});

const SECRET_NAME = '(?:authorization|token|access[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|cookie|set-cookie|private[_-]?key)';

export function discoveryResultFileName(agent, batch, attempt) {
  return `${agent}-batch-${String(batch).padStart(3, '0')}-attempt-${attempt}.json`;
}

function diagnosticFileName(agent, batch, attempt) {
  return `${agent}-batch-${String(batch).padStart(3, '0')}-attempt-${attempt}.failure.json`;
}

export function redactDiagnosticText(value) {
  let text = String(value);
  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    '<redacted-private-key>'
  );
  text = text.replace(
    /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
    '<redacted-token>'
  );
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '<redacted-jwt>'
  );
  text = text.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    '$1 <redacted>'
  );
  text = text.replace(
    new RegExp(`("\\s*${SECRET_NAME}\\s*"\\s*:\\s*")([^"]*)(")`, 'gi'),
    '$1<redacted>$3'
  );
  text = text.replace(
    new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)(["'])([\\s\\S]*?)\\2`, 'gi'),
    '$1$2<redacted>$2'
  );
  return text.replace(
    new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)([^\\s,;}]+)`, 'gi'),
    '$1<redacted>'
  );
}
```

Add private metadata, file-writing, and failure helpers:

```js
function normalizeMetadata(options) {
  const agent = String(options.agent ?? '');
  const category = DISCOVERY_CATEGORIES[agent];
  const batch = Number(options.batch);
  const attempt = Number(options.attempt);
  if (!category) throw new Error(`Unsupported discovery agent: ${agent || '<empty>'}`);
  if (!Number.isInteger(batch) || batch < 1) throw new Error('Batch must be a positive integer');
  if (![1, 2].includes(attempt)) throw new Error('Attempt must be 1 or 2');
  return { agent, category, batch, attempt };
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}

function safeParseLocation(error) {
  const message = String(error?.message ?? '');
  const lineColumn = message.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const position = message.match(/\bposition\s+(\d+)\b/i);
  return position ? { offset: Number(position[1]) } : {};
}

async function recordFailure(raw, resultDirectory, diagnosticsDirectory, metadata, kind, details = {}) {
  const diagnostic = path.join(
    diagnosticsDirectory,
    diagnosticFileName(metadata.agent, metadata.batch, metadata.attempt)
  );
  await writePrivateJson(diagnostic, {
    schemaVersion: '1.0',
    ...metadata,
    failureKind: kind,
    response: redactDiagnosticText(raw)
  });
  const result = {
    schemaVersion: '1.0',
    ...metadata,
    status: 'invalid',
    failure: {
      kind,
      ...details,
      diagnostic
    }
  };
  await writePrivateJson(
    path.join(resultDirectory, discoveryResultFileName(metadata.agent, metadata.batch, metadata.attempt)),
    result
  );
  return result;
}
```

Add the ingestion function:

```js
export async function ingestDiscoveryResponse(
  rawFile,
  resultDirectory,
  diagnosticsDirectory,
  options
) {
  let raw = '';
  try {
    const metadata = normalizeMetadata(options);
    raw = await readFile(rawFile, 'utf8');
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-json',
        safeParseLocation(error)
      );
    }

    if (!Array.isArray(value)) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-shape',
        { problems: ['Response must be a JSON array'] }
      );
    }

    const validation = validateFindings(value, { mode: 'candidate' });
    if (!validation.valid) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-candidate',
        { problems: validation.errors }
      );
    }

    const categoryProblems = value
      .map((finding, index) => finding.category === metadata.category
        ? null
        : `finding[${index}].category must be ${metadata.category}`)
      .filter(Boolean);
    if (categoryProblems.length) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-category',
        { problems: categoryProblems }
      );
    }

    const result = {
      schemaVersion: '1.0',
      ...metadata,
      status: 'complete',
      findings: value
    };
    await writePrivateJson(
      path.join(resultDirectory, discoveryResultFileName(metadata.agent, metadata.batch, metadata.attempt)),
      result
    );
    return result;
  } finally {
    await rm(rawFile, { force: true });
  }
}
```

Finish Task 1 with an `ingest`-only CLI:

```js
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [mode, rawFile, resultDirectory, diagnosticsDirectory] = flags._;
  if (mode !== 'ingest' || !rawFile || !resultDirectory || !diagnosticsDirectory) {
    throw new Error('Usage: process-discovery.mjs ingest RAW_RESPONSE_FILE RESULTS_DIR DIAGNOSTICS_DIR --agent NAME --batch N --attempt 1|2');
  }
  const result = await ingestDiscoveryResponse(
    path.resolve(rawFile),
    path.resolve(resultDirectory),
    path.resolve(diagnosticsDirectory),
    { agent: flags.agent, batch: flags.batch, attempt: flags.attempt }
  );
  if (result.status !== 'complete') process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
```

Do not print `raw`, a parser message, or the diagnostic body.

- [ ] **Step 7: Run the ingestion tests**

Run:

```bash
node --test tests/plugin.test.mjs
```

Expected: PASS for both tests.

- [ ] **Step 8: Run the plugin suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 9: Commit strict ingestion**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "fix(pr-review-graph): validate discovery responses"
```

---

### Task 2: Deterministic coverage finalization

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs`

**Interfaces:**
- Consumes: `PLAN_JSON.agents[].name` and `PLAN_JSON.agents[].batches` from `build-review-plan.mjs`.
- Consumes: attempt files produced by Task 1.
- Produces: `finalizeDiscovery(plan, resultDirectory) -> Promise<{ coverage, findings }>` where `findings` is an array only when `coverage.status === "complete"` and is `null` otherwise.
- Produces on disk: `COVERAGE_JSON` for every finalization; `CANDIDATES_JSON` only for complete coverage.

- [ ] **Step 1: Add finalization imports and test helpers**

Extend the process-discovery import in `tests/plugin.test.mjs`:

```js
import {
  discoveryResultFileName,
  finalizeDiscovery,
  ingestDiscoveryResponse
} from '../skills/review-pull-request/scripts/process-discovery.mjs';
```

Add:

```js
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
```

- [ ] **Step 2: Write the failing retry-recovery test**

```js
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
```

- [ ] **Step 3: Write the failing mixed-coverage test**

```js
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
```

- [ ] **Step 4: Write the failing CLI candidate-file gate test**

```js
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
```

- [ ] **Step 5: Write the failing complete-empty CLI test**

```js
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
```

- [ ] **Step 6: Run finalization tests to verify they fail**

Run:

```bash
node --test tests/plugin.test.mjs
```

Expected: FAIL because `finalizeDiscovery` is not exported and the CLI supports only `ingest`.

- [ ] **Step 7: Implement attempt loading and coverage classification**

Add `readdir` to the `node:fs/promises` import in `process-discovery.mjs`.

Add these exact private helpers. `readAttempt()` returns `{ state: "missing" }` for `ENOENT`,
`{ state: "corrupt" }` for unreadable, malformed, or inconsistent result JSON, and
`{ state: "complete"|"invalid", value }` only after validating the envelope:

```js
function validateAttemptEnvelope(value, expected) {
  const problems = [];
  for (const field of ['agent', 'category', 'batch', 'attempt']) {
    if (value?.[field] !== expected[field]) {
      problems.push(`${field} does not match the expected attempt`);
    }
  }
  if (!['complete', 'invalid'].includes(value?.status)) {
    problems.push('status must be complete or invalid');
  }
  if (value?.status === 'complete') {
    const validation = validateFindings(value.findings, { mode: 'candidate' });
    problems.push(...validation.errors);
    for (const [index, finding] of (value.findings ?? []).entries()) {
      if (finding.category !== expected.category) {
        problems.push(`finding[${index}].category must be ${expected.category}`);
      }
    }
  }
  if (value?.status === 'invalid') {
    if (typeof value.failure?.kind !== 'string') problems.push('invalid result needs failure.kind');
    if (typeof value.failure?.diagnostic !== 'string') problems.push('invalid result needs failure.diagnostic');
  }
  return problems;
}

async function readAttempt(resultDirectory, expected) {
  const file = path.join(
    resultDirectory,
    discoveryResultFileName(expected.agent, expected.batch, expected.attempt)
  );
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', file };
    return { state: 'corrupt', file };
  }
  const problems = validateAttemptEnvelope(value, expected);
  return problems.length
    ? { state: 'corrupt', file, problems }
    : { state: value.status, file, value };
}

async function listResultFiles(resultDirectory) {
  try {
    return (await readdir(resultDirectory)).filter(file => file.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}
```

Use `discoveryResultFileName()` for every read. Do not accept an attempt file whose embedded metadata
differs from the expected plan position.

- [ ] **Step 8: Implement `finalizeDiscovery()`**

Export:

```js
export async function finalizeDiscovery(plan, resultDirectory) {
  const scopes = [];
  const failures = [];
  const partialFindings = [];
  const expectedFiles = new Set();

  for (const agentPlan of plan.agents ?? []) {
    const category = DISCOVERY_CATEGORIES[agentPlan.name];
    if (!category || !Array.isArray(agentPlan.batches)) {
      throw new Error(`Invalid discovery plan entry for ${agentPlan.name ?? '<unnamed>'}`);
    }
    let completedBatches = 0;
    let recoveredBatches = 0;
    let failedBatches = 0;

    for (let index = 0; index < agentPlan.batches.length; index += 1) {
      const batch = index + 1;
      for (const attempt of [1, 2]) {
        expectedFiles.add(discoveryResultFileName(agentPlan.name, batch, attempt));
      }
      const expected = { agent: agentPlan.name, category, batch };
      const first = await readAttempt(resultDirectory, { ...expected, attempt: 1 });
      const second = await readAttempt(resultDirectory, { ...expected, attempt: 2 });
      const secondExists = second.state !== 'missing';
      let terminal = null;

      if (first.state === 'complete' && !secondExists) {
        terminal = first.value;
      } else if (first.state === 'invalid' && second.state === 'complete') {
        terminal = second.value;
        recoveredBatches += 1;
      }

      const invalidAttempts = [first, second]
        .filter(item => item.state === 'invalid')
        .map(item => ({
          attempt: item.value.attempt,
          kind: item.value.failure.kind,
          diagnostic: item.value.failure.diagnostic
        }));

      if (terminal) {
        completedBatches += 1;
        partialFindings.push(...terminal.findings);
        if (invalidAttempts.length) {
          failures.push({ agent: agentPlan.name, batch, recovered: true, attempts: invalidAttempts });
        }
      } else {
        failedBatches += 1;
        failures.push({
          agent: agentPlan.name,
          batch,
          recovered: false,
          attempts: invalidAttempts,
          protocolStates: [first.state, second.state]
        });
      }
    }

    const expectedBatches = agentPlan.batches.length;
    const status = completedBatches === expectedBatches
      ? 'complete'
      : completedBatches === 0
        ? 'failed'
        : 'incomplete';
    scopes.push({
      agent: agentPlan.name,
      status,
      expectedBatches,
      completedBatches,
      recoveredBatches,
      failedBatches
    });
  }

  const actualFiles = await listResultFiles(resultDirectory);
  const protocolProblems = actualFiles
    .filter(file => !expectedFiles.has(file))
    .map(file => `Unexpected attempt result: ${file}`);
  const complete = scopes.every(scope => scope.status === 'complete') && !protocolProblems.length;
  const coverage = {
    schemaVersion: '1.0',
    status: complete ? 'complete' : 'failed',
    scopes,
    failures,
    protocolProblems,
    ...(complete
      ? { candidateCount: partialFindings.length }
      : { partialCandidateCount: partialFindings.length })
  };
  return { coverage, findings: complete ? partialFindings : null };
}
```

`readAttempt()` must classify a second attempt after a complete first attempt as a protocol failure through
the `terminal === null` branch. A second attempt without an invalid first attempt must never recover a
batch.

- [ ] **Step 9: Extend the CLI with `finalize`**

Import no shared writer for these outputs; use a small overwrite helper so finalization can deliberately
replace a stale coverage file:

```js
async function overwritePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await rm(file, { force: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}
```

Replace `main()` with:

```js
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [mode, ...args] = flags._;
  if (mode === 'ingest') {
    const [rawFile, resultDirectory, diagnosticsDirectory] = args;
    if (!rawFile || !resultDirectory || !diagnosticsDirectory) {
      throw new Error('Usage: process-discovery.mjs ingest RAW_RESPONSE_FILE RESULTS_DIR DIAGNOSTICS_DIR --agent NAME --batch N --attempt 1|2');
    }
    const result = await ingestDiscoveryResponse(
      path.resolve(rawFile),
      path.resolve(resultDirectory),
      path.resolve(diagnosticsDirectory),
      { agent: flags.agent, batch: flags.batch, attempt: flags.attempt }
    );
    if (result.status !== 'complete') process.exitCode = 1;
    return;
  }
  if (mode === 'finalize') {
    const [planFile, resultDirectory, candidatesFile, coverageFile] = args;
    if (!planFile || !resultDirectory || !candidatesFile || !coverageFile) {
      throw new Error('Usage: process-discovery.mjs finalize PLAN_JSON RESULTS_DIR CANDIDATES_JSON COVERAGE_JSON');
    }
    const plan = JSON.parse(await readFile(path.resolve(planFile), 'utf8'));
    const candidates = path.resolve(candidatesFile);
    const { coverage, findings } = await finalizeDiscovery(plan, path.resolve(resultDirectory));
    await rm(candidates, { force: true });
    await overwritePrivateJson(path.resolve(coverageFile), coverage);
    if (coverage.status === 'complete') {
      await overwritePrivateJson(candidates, findings);
    } else {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('First argument must be ingest or finalize');
}
```

Keep the existing `isMain()` guard and catch block.

- [ ] **Step 10: Run the finalization tests**

Run:

```bash
node --test tests/plugin.test.mjs
```

Expected: PASS for retry recovery, mixed coverage, failed CLI gating, and complete empty candidates.

- [ ] **Step 11: Run the package test command**

The failed CLI test already asserts that a scope with zero completed batches is `failed`:

```js
assert.equal(coverage.scopes[0].status, 'failed');
```

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 12: Commit deterministic finalization**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "fix(pr-review-graph): fail closed on incomplete discovery"
```

---

### Task 3: Wire the strict protocol into agents and orchestration

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-contract.agent.md`
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-correctness.agent.md`
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-tests.agent.md`
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-security.agent.md`
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-data-compatibility.agent.md`
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-reliability.agent.md`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md`
- Modify: `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs`
- Modify: `ghcp/plugins/pr-review-graph/README.md`

**Interfaces:**
- Consumes: the `ingest` and `finalize` CLI contracts from Tasks 1 and 2.
- Produces: one strict self-contained output contract in each discovery-agent prompt.
- Produces: an orchestration hard gate that never enters Phase 3 after failed discovery coverage.

- [ ] **Step 1: Write the failing prompt-contract test**

Append before `BASH4_ONLY`:

```js
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
```

- [ ] **Step 2: Run the prompt test to verify it fails**

Run:

```bash
node --test tests/plugin.test.mjs
```

Expected: FAIL on the first agent because the current prompts say only "Return one JSON array" and show a
bare object.

- [ ] **Step 3: Harden all six discovery-agent contracts**

In each listed discovery agent, replace its current `Return one JSON array...` sentence with this exact
shared block:

```markdown
Return exactly one JSON array, beginning with `[` and ending with `]`. Return no prose, JSON comments, or trailing commas. Do not wrap the array in a Markdown code fence. Escape every newline, carriage return, tab, NUL, and other control character inside string values with JSON escapes such as `\n`, `\r`, `\t`, and `\u0000`; never place a literal control character inside a quoted string.

Use this one-item array shape:
```

Keep every existing field and example value. In each JSON example, replace the opening `{` with these two
lines:

```json
[
  {
```

Indent the existing object fields two spaces, then replace the closing `}` with:

```json
  }
]
```

For `prg-contract`, keep its existing optional `requirementRef` field inside the array item. Keep each
file's existing final `Use []...` sentence.

- [ ] **Step 4: Run the prompt-contract test**

Run:

```bash
node --test tests/plugin.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Make plugin validation enforce the prompt contract and new script**

In `scripts/validate-plugin.mjs`, add before the agent loop:

```js
const discoveryAgentNames = new Set([
  'prg-contract',
  'prg-correctness',
  'prg-tests',
  'prg-security',
  'prg-data-compatibility',
  'prg-reliability'
]);
```

Inside the loop, after parsing frontmatter, add:

```js
if (discoveryAgentNames.has(frontmatter.name)) {
  if (!text.includes('Return exactly one JSON array')) {
    errors.push(`agents/${file} must require exactly one JSON array`);
  }
  if (!text.includes('Do not wrap the array in a Markdown code fence')) {
    errors.push(`agents/${file} must forbid Markdown code fences`);
  }
  if (!text.includes('\\u0000')) {
    errors.push(`agents/${file} must require JSON-escaped control characters`);
  }
}
```

Add `'process-discovery.mjs'` to `requiredScripts` immediately after `build-review-plan.mjs`.

- [ ] **Step 6: Run validation**

Run:

```bash
npm run validate
```

Expected: PASS and print
`Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 7: Replace permissive discovery handling in `review-graph.md`**

Under **Bounded loops**, replace the discovery bullet with:

```markdown
- Ingest every discovery response with `process-discovery.mjs`. Retry a batch once only when ingestion reports an invalid result. Never repair or silently drop malformed output.
- After all routed batches settle, finalize discovery coverage against the immutable review plan. If any batch remains invalid, stop before verification.
```

Replace **Coverage result** with:

```markdown
## Coverage result

Classify each selected scope as `complete`, `incomplete`, or `failed`. A scope is complete only when every planned batch produced a valid candidate array, including batches recovered by their one retry.

If any selected scope is incomplete or failed, the review status is failed and the graph stops before verification. Lead the report with `REVIEW FAILED - DISCOVERY INCOMPLETE`, show the scope matrix and redacted diagnostic paths, and do not describe the partial candidate set as clean.

An empty candidate set is authoritative only when every selected scope is complete.
```

- [ ] **Step 8: Wire ingestion and finalization into Phase 2 of `SKILL.md`**

After the risk-router command, add:

```markdown
Create `RESULTS_DIR`, `DIAGNOSTICS_DIR`, and a staging directory inside the mode-`0700` run directory. Every raw agent response staging file must be mode `0600`. Never print a raw response.
```

Replace the current last paragraph of Phase 2 with:

````markdown
Do not give discovery agents shell, editing, network, or publishing access. Dispatch independent discovery agents in parallel when supported.

For each agent batch, write the exact response to a fresh mode-`0600` staging file and ingest attempt 1:

```bash
node <SKILL_DIR>/scripts/process-discovery.mjs ingest \
  <RAW_RESPONSE_FILE> <RESULTS_DIR> <DIAGNOSTICS_DIR> \
  --agent <PRG_AGENT> --batch <ONE_BASED_INDEX> --attempt 1
```

If ingestion exits non-zero, read only the safe attempt-result JSON. Retry that batch once, repeating the exact JSON-array contract and supplying only the failure kind and numeric location. Ingest the retry with `--attempt 2`. Do not include the raw response or diagnostic body in the retry prompt.

After all routed batches settle, finalize them against the immutable plan:

```bash
node <SKILL_DIR>/scripts/process-discovery.mjs finalize \
  <PLAN_JSON> <RESULTS_DIR> <CANDIDATES_JSON> <COVERAGE_JSON>
```

If finalization exits non-zero, stop before Phase 3. Lead with `REVIEW FAILED - DISCOVERY INCOMPLETE`, show each scope's completed and failed batch counts plus every redacted diagnostic path, and do not say `no findings`, `no publishable findings`, `clean`, or equivalent. Do not preview or publish a review. Remove unredacted staging files and provider data; retain only the redacted diagnostics and coverage report in the reported temporary directory.
````

The nested shell fences above must be inserted as normal fenced blocks in the Markdown file; verify the
surrounding fences render correctly.

- [ ] **Step 9: Make Phase 3 consume only finalized candidates**

Change Phase 3 steps 1 and 2 from:

```markdown
1. Merge candidate arrays without rewriting them.
2. Run `scripts/validate-findings.mjs`. Reject malformed candidates.
```

to:

```markdown
1. Read candidates only from `CANDIDATES_JSON` written by successful discovery finalization.
2. Run `scripts/validate-findings.mjs` as a defensive candidate check before verification.
```

No later Phase 3 step changes.

- [ ] **Step 10: Document the user-visible failure behavior**

In `README.md`, after review-graph step 3 (`Route relevant slices to focused specialist agents.`), add:

```markdown
   A routed batch that remains invalid after one retry fails the review before verification; partial coverage is never reported as a clean review.
```

- [ ] **Step 11: Run targeted and full validation**

Run:

```bash
node --test tests/plugin.test.mjs
npm test
npm run validate
```

Expected: all commands PASS. Confirm `SKILL.md` remains under the validator's 500-line limit.

- [ ] **Step 12: Commit the prompt and orchestration wiring**

```bash
git add ghcp/plugins/pr-review-graph/agents/prg-contract.agent.md \
  ghcp/plugins/pr-review-graph/agents/prg-correctness.agent.md \
  ghcp/plugins/pr-review-graph/agents/prg-tests.agent.md \
  ghcp/plugins/pr-review-graph/agents/prg-security.agent.md \
  ghcp/plugins/pr-review-graph/agents/prg-data-compatibility.agent.md \
  ghcp/plugins/pr-review-graph/agents/prg-reliability.agent.md \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md \
  ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs \
  ghcp/plugins/pr-review-graph/README.md
git commit -m "fix(pr-review-graph): enforce fail-closed discovery"
```

---

### Task 4: Release version 0.2.5

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/plugin.json`
- Modify: `.github/plugin/marketplace.json`

**Interfaces:**
- Consumes: the version-match assertion in `scripts/validate-plugin.mjs`.
- Produces: installable plugin version `0.2.5`.

- [ ] **Step 1: Bump the plugin manifest**

In `ghcp/plugins/pr-review-graph/plugin.json`, change:

```json
"version": "0.2.4"
```

to:

```json
"version": "0.2.5"
```

- [ ] **Step 2: Verify the mismatch guard fails**

Run:

```bash
cd ghcp/plugins/pr-review-graph
npm run validate
```

Expected: FAIL with
`marketplace version 0.2.4 must match plugin.json version 0.2.5`.

- [ ] **Step 3: Bump the marketplace plugin entry**

In repository-root `.github/plugin/marketplace.json`, change only
`plugins[0].version` from `0.2.4` to `0.2.5`. Leave `metadata.version` at `1.0.0`.

- [ ] **Step 4: Run complete verification**

Run:

```bash
npm test && npm run validate
```

Expected: every test passes and validation prints
`Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

From the repository root, run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Status lists only the two version files before the release commit.

- [ ] **Step 5: Commit the release bump**

```bash
git add ghcp/plugins/pr-review-graph/plugin.json .github/plugin/marketplace.json
git commit -m "chore(pr-review-graph): release 0.2.5"
```

- [ ] **Step 6: Verify final branch state**

Run:

```bash
git status --short
git --no-pager log -5 --oneline
```

Expected: a clean worktree. The latest four implementation commits are:

```text
chore(pr-review-graph): release 0.2.5
fix(pr-review-graph): enforce fail-closed discovery
fix(pr-review-graph): fail closed on incomplete discovery
fix(pr-review-graph): validate discovery responses
```
