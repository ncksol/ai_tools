# Agent Response Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve raw machine-readable responses from every PR Review Graph agent stage by extracting exactly one terminal assistant payload from Copilot CLI JSONL before stage-specific validation.

**Architecture:** A schema-agnostic `extract-agent-response.mjs` validates Copilot CLI JSONL framing and writes one terminal `assistant.message.data.content` unchanged. Discovery maps structural transport failures into its existing two-attempt envelopes; verifier, deduplicator, and editor keep their current reject, retry/hold, and retry/stop policies.

**Tech Stack:** Node.js >= 18, Node built-ins, `node:test`, Markdown skill/reference prompts. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-agent-response-transport-design.md`

## Global Constraints

- Run plugin commands from `ghcp/plugins/pr-review-graph`: `npm test` and `npm run validate`.
- Use Node.js >= 18 and Node built-ins only. Do not change `package.json` or add a dependency.
- Subprocess agents must use `--output-format json --stream off --silent`; rendered text is never ingestible.
- Extract exactly one non-empty, tool-free payload from the final completed assistant turn.
- Write the decoded `data.content` unchanged: no trimming, newline insertion, prose stripping, fence removal, or malformed-JSON repair.
- Transport status and diagnostics are structural-only and never contain event lines, payload text, tool arguments, or transcript fragments.
- Discovery transport failures consume the current attempt and preserve the existing maximum of two attempts.
- Verifier transport failure rejects that candidate; deduplicator failure retries once then holds; editor failure retries once then stops.
- Preserve strict discovery ingestion, secret redaction, off-plan protection, and coverage finalization.
- Keep every custom agent on `tools: []`.
- End with plugin version `0.2.6` in `plugin.json` and the root marketplace entry. Leave `package.json` at `0.2.0`.
- Commit messages must not contain a `Co-authored-by` trailer or any AI attribution trailer.

## File Map

| File | Responsibility |
| --- | --- |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/extract-agent-response.mjs` | Schema-agnostic JSONL framing, terminal payload extraction, private output/status writes, and capture cleanup |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs` | Discovery-only conversion of invalid transport status into existing attempt and diagnostic envelopes |
| `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` | Transport, ingestion, stage-policy, cleanup, and static orchestration regression coverage |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md` | Required transport before discovery, verification, deduplication, and editing |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md` | Transport gate and stage-specific failure state machine |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/superpowers-compatibility.md` | Structural separation of skill events from raw final responses |
| `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs` | Required extractor and workflow transport clauses |
| `ghcp/plugins/pr-review-graph/README.md` | User-visible machine-response transport guarantee |
| `ghcp/plugins/pr-review-graph/plugin.json` | Plugin version `0.2.6` |
| `.github/plugin/marketplace.json` | Matching marketplace version `0.2.6` |

---

### Task 1: Schema-agnostic JSONL extraction

**Files:**
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/extract-agent-response.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs`

**Interfaces:**
- Produces: `TRANSPORT_FAILURE_KINDS`, an immutable set of fixed failure names.
- Produces: `extractAgentResponse(eventsFile, responseFile, statusFile) -> Promise<TransportStatus>`.
- Writes on success: exact decoded payload bytes to `responseFile` and `{schemaVersion:"1.0",status:"complete"}` to `statusFile`.
- Writes on failure: no response file and `{schemaVersion:"1.0",status:"invalid",failure:{kind,...safeDetails}}` to `statusFile`.
- Deletes: `eventsFile` in a `finally` block.

- [ ] **Step 1: Add failing array/object transport tests**

Add the extractor import:

```js
// Also add `stat` to the existing node:fs/promises import.
import {
  extractAgentResponse
} from '../skills/review-pull-request/scripts/extract-agent-response.mjs';
```

Add a JSONL event helper:

```js
function agentEventStream(content, preceding = []) {
  const turnId = 'turn-final';
  return [...preceding, {
    type: 'assistant.turn_start',
    data: { turnId, interactionId: 'interaction-final' }
  }, {
    type: 'assistant.message',
    data: { turnId, content, toolRequests: [] }
  }, {
    type: 'assistant.turn_end',
    data: { turnId }
  }, {
    type: 'result',
    exitCode: 0
  }].map(event => JSON.stringify(event)).join('\n') + '\n';
}
```

Add one test whose array payload is `JSON.stringify([discoveryCandidate(...)])` with a 500-character title and `\n`, `\r`, `\t`, and `\0` inside string values. Add a second case with:

```js
const objectPayload = JSON.stringify({
  comments: [{
    fingerprint: 'a'.repeat(64),
    comment: `line one\nline two ${'x'.repeat(500)}`
  }]
});
```

For each case, write the JSONL file mode `0600`, call `extractAgentResponse`, and assert:

```js
assert.equal(status.status, 'complete');
assert.equal(await readFile(responseFile, 'utf8'), payload);
assert.equal((await stat(responseFile)).mode & 0o777, 0o600);
await assert.rejects(access(eventsFile), { code: 'ENOENT' });
```

- [ ] **Step 2: Run the transport tests to verify they fail**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="agent response transport" tests/plugin.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extract-agent-response.mjs`.

- [ ] **Step 3: Implement strict event framing and exact payload writes**

Create `extract-agent-response.mjs` with:

```js
#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMain } from './lib.mjs';

export const TRANSPORT_FAILURE_KINDS = Object.freeze([
  'transport-invalid-jsonl',
  'transport-invalid-event',
  'transport-missing-result',
  'transport-multiple-results',
  'transport-unsuccessful-result',
  'transport-missing-payload',
  'transport-multiple-payloads',
  'transport-non-terminal-payload'
]);

async function writePrivate(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function writeStatus(file, status) {
  await writePrivate(file, `${JSON.stringify(status, null, 2)}\n`);
}
```

Parse CRLF-safe JSONL without trimming content. Empty physical lines may be skipped; whitespace-only lines must fail. Validate every event as an object with a string `type`. Track `assistant.turn_start`, `assistant.message`, and `assistant.turn_end` by `data.turnId`. Treat an empty message as a structural frame regardless of tool-request presence, while still requiring it to belong to one matching assistant turn. Require exactly one non-empty message with an empty `toolRequests` array, require it to be in the last completed turn, and require exactly one final `result` with `exitCode === 0`.

Return only fixed failures:

```js
function invalid(kind, details = {}) {
  return {
    schemaVersion: '1.0',
    status: 'invalid',
    failure: { kind, ...details }
  };
}
```

On success, write `payloadMessage.data.content` directly with `writePrivate(responseFile, content)` and then write complete status. On failure, remove `responseFile`, write invalid status, and return it. Always remove `eventsFile`. If status writing fails after a response write, remove the response before rethrowing.

Add CLI handling:

```js
async function main() {
  const [eventsFile, responseFile, statusFile] = process.argv.slice(2);
  if (!eventsFile || !responseFile || !statusFile) {
    throw new Error('Usage: extract-agent-response.mjs EVENTS_JSONL RAW_RESPONSE_FILE TRANSPORT_STATUS_JSON');
  }
  const status = await extractAgentResponse(
    path.resolve(eventsFile),
    path.resolve(responseFile),
    path.resolve(statusFile)
  );
  if (status.status !== 'complete') process.exitCode = 1;
}
```

- [ ] **Step 4: Run the successful transport tests**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="agent response transport" tests/plugin.test.mjs
```

Expected: PASS for the array and object extraction tests.

- [ ] **Step 5: Add failing ambiguity and contamination tests**

Use table-driven JSONL fixtures for:

```js
[
  ['rendered text', 'Using strict-code-review...\n[]', 'transport-invalid-jsonl'],
  ['missing payload', agentEventStream('').replace('"toolRequests":[]', '"toolRequests":[{"name":"skill"}]'), 'transport-missing-payload'],
  ['contentful preamble', agentEventStream('[]', [
    { type: 'assistant.turn_start', data: { turnId: 'turn-preamble' } },
    { type: 'assistant.message', data: { turnId: 'turn-preamble', content: 'Using strict-code-review...', toolRequests: [] } },
    { type: 'assistant.turn_end', data: { turnId: 'turn-preamble' } }
  ]), 'transport-multiple-payloads'],
  ['failed result', agentEventStream('[]').replace('"exitCode":0', '"exitCode":1'), 'transport-unsuccessful-result']
]
```

Add explicit fixtures for duplicate `result`, message without a matching turn, a payload in a non-final turn, a tool-bearing contentful message, malformed `data.content`, and assistant turn/message events after the selected response turn. Assert each returns its fixed failure kind, writes no response, writes a valid structural-only status, and removes the capture. Assert the status serialization does not contain `Using strict-code-review`, the payload, or any event source line.

- [ ] **Step 6: Run the ambiguity tests to verify they fail, then complete validation**

Run the focused test before implementation changes and expect at least one wrong/missing failure classification. Implement the smallest event-order checks needed, then rerun:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="agent response transport" tests/plugin.test.mjs
```

Expected: all transport tests PASS.

- [ ] **Step 7: Commit schema-agnostic extraction**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/extract-agent-response.mjs \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "fix(pr-review-graph): extract raw agent responses"
```

---

### Task 2: Discovery transport failure integration

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs`

**Interfaces:**
- Consumes: invalid `TRANSPORT_STATUS_JSON` from Task 1.
- Produces: `recordDiscoveryTransportFailure(statusFile, resultDirectory, diagnosticsDirectory, options)`.
- Produces CLI: `process-discovery.mjs transport-failure STATUS_JSON RESULTS_DIR DIAGNOSTICS_DIR --agent NAME --batch N --attempt 1|2`.
- Preserves: `ingestDiscoveryResponse` behavior and existing attempt/finalization envelopes.

- [ ] **Step 1: Write the failing transport-recovery test**

Import `recordDiscoveryTransportFailure`. Create a temporary run, extract a preamble-contaminated first attempt, and record it:

```js
await recordDiscoveryTransportFailure(
  statusFile,
  path.join(directory, 'results'),
  path.join(directory, 'diagnostics'),
  { agent: 'prg-correctness', batch: 1, attempt: 1 }
);
await ingestText(directory, JSON.stringify([candidate]), {
  agent: 'prg-correctness', batch: 1, attempt: 2
});
const result = await finalizeDiscovery(
  discoveryPlan('prg-correctness', 1),
  path.join(directory, 'results')
);
assert.equal(result.coverage.status, 'complete');
assert.equal(result.coverage.scopes[0].recoveredBatches, 1);
```

Assert the attempt diagnostic contains `failureKind: "transport-multiple-payloads"` and a `transport` object, has no `response` property, contains no preamble or payload, and the status file is removed.

- [ ] **Step 2: Run the recovery test to verify it fails**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="discovery transport" tests/plugin.test.mjs
```

Expected: FAIL because `recordDiscoveryTransportFailure` is not exported.

- [ ] **Step 3: Implement structural-only discovery failure recording**

In `process-discovery.mjs`, import `TRANSPORT_FAILURE_KINDS` from `extract-agent-response.mjs`. Add fixed detail validation:

```js
const TRANSPORT_DETAIL_KEYS = new Set(['line', 'eventIndex', 'eventType', 'count']);

function validateTransportFailure(value) {
  if (value?.status !== 'invalid') throw new Error('Transport status must be invalid');
  if (!TRANSPORT_FAILURE_KINDS.includes(value.failure?.kind)) {
    throw new Error('Unsupported transport failure kind');
  }
  const details = Object.fromEntries(
    Object.entries(value.failure)
      .filter(([key]) => key !== 'kind' && TRANSPORT_DETAIL_KEYS.has(key))
  );
  if (Object.keys(value.failure).some(key => key !== 'kind' && !TRANSPORT_DETAIL_KEYS.has(key))) {
    throw new Error('Transport failure contains unsupported detail keys');
  }
  return { kind: value.failure.kind, details };
}
```

Allow `eventType` only when it is one of the fixed structural types handled by the extractor. Require `line >= 1`, `eventIndex >= 0`, and `count >= 0` as integers.

Implement `recordDiscoveryTransportFailure` with `normalizeMetadata`, `writePrivateJson`, and the same rollback behavior as `recordFailure`. Write:

```js
{
  schemaVersion: '1.0',
  ...metadata,
  failureKind: kind,
  transport: details
}
```

to the diagnostic and a normal `status: "invalid"` attempt envelope referencing that diagnostic. Remove `statusFile` in `finally`.

- [ ] **Step 4: Add and test the CLI operation**

Add `transport-failure` handling before `finalize` in `main()`. It reads the status path and metadata flags, records the invalid attempt, and sets exit code `1`. Update the invalid mode error to:

```js
throw new Error('First argument must be ingest, transport-failure, or finalize');
```

Spawn the real CLI in a test, assert exit status `1`, and assert the attempt envelope and structural-only diagnostic exist.

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="discovery transport" tests/plugin.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Add terminal transport-failure coverage**

Record invalid transport statuses for attempts 1 and 2, call `finalizeDiscovery`, and assert:

```js
assert.equal(result.coverage.status, 'failed');
assert.equal(result.coverage.scopes[0].status, 'failed');
assert.equal(result.findings, null);
assert.equal(result.coverage.failures[0].attempts.length, 2);
```

Also assert malformed status files, unknown failure kinds, unsupported detail keys, and unsafe `eventType` values are rejected without producing an attempt result.

Run the focused tests and expect PASS.

- [ ] **Step 6: Commit discovery integration**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/process-discovery.mjs \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "fix(pr-review-graph): record discovery transport failures"
```

---

### Task 3: Workflow-wide transport enforcement

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/superpowers-compatibility.md`
- Modify: `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs`
- Modify: `ghcp/plugins/pr-review-graph/README.md`
- Modify: `ghcp/plugins/pr-review-graph/plugin.json`
- Modify: `.github/plugin/marketplace.json`

**Interfaces:**
- Consumes: `extract-agent-response.mjs EVENTS_JSONL RAW_RESPONSE_FILE TRANSPORT_STATUS_JSON`.
- Discovery: success goes to `process-discovery.mjs ingest`; invalid status goes to `transport-failure`.
- Verification: transport/schema failure rejects the candidate without retry.
- Deduplication: failure retries once, then missing decisions flow to existing hold behavior.
- Editing: failure retries once, then stops before payload construction.
- Native bypass: only an API's structurally distinct raw final-response field may be staged directly.

- [ ] **Step 1: Write failing static workflow tests**

Add a test that reads `SKILL.md`, `review-graph.md`, and `superpowers-compatibility.md` and asserts:

```js
assert.match(skill, /--output-format json --stream off --silent/);
assert.match(skill, /extract-agent-response\.mjs/);
for (const agent of ['prg-verifier', 'prg-deduplicator', 'prg-editor']) {
  assert.match(skill, new RegExp(`${agent}[\\\\s\\\\S]*extract-agent-response\\\\.mjs`));
}
assert.match(skill, /rendered transcript[^.]*never ingestible/i);
assert.match(skill, /explicit final-response field/i);
assert.match(graph, /verification transport failure[^.]*reject/i);
assert.match(graph, /deduplication transport failure[^.]*retry once[^.]*hold/i);
assert.match(graph, /editor transport failure[^.]*retry once[^.]*stop/i);
assert.match(superpowers, /skill narration[^.]*JSONL event/i);
```

Expected: these tests fail against the current documentation.

- [ ] **Step 2: Document the common transport contract in `SKILL.md`**

Add a section before Phase 1 named `Machine-response transport`. It must:

1. Require JSONL subprocess flags and the extractor command for all PRG agents.
2. Forbid rendered text, transcript, progress, tool, skill, reasoning, and generic task-summary output.
3. Permit native Task/subsession dispatch only for an explicit raw final-response field.
4. Require staging that field unchanged.
5. Define structural-only status handling and cleanup.

Replace the discovery instruction to “write the exact response” with the extractor flow and `transport-failure` command. Add the same extractor gate immediately after verifier, deduplicator, and editor dispatch instructions, followed by their stage-specific policies.

- [ ] **Step 3: Update graph and compatibility references**

In `review-graph.md`, insert a Transport state between Route and Discover:

```markdown
| Transport | Tool-less agent event stream or explicit raw final-response field | One exact machine payload or structural failure status | None |
```

Add bounded-loop bullets for verifier reject, dedup retry/hold, and editor retry/stop. In `superpowers-compatibility.md`, state that skill/tool announcements are separate JSONL events and rendered announcements are never staged as machine responses.

- [ ] **Step 4: Add downstream object-policy regression tests**

Use the real extractor CLI to write:

- a deduplicator object consumed by `applyDeduplication`;
- an editor object consumed by `applyComments`; and
- a verifier object strictly parsed and checked for `verdict`, `confidence`, `reason`, and `finding`.

Assert a preamble-contaminated object writes no response. For deduplication, pass no decisions after two failed transport attempts and assert the finding is in `held`. For editing, assert no raw editor output reaches `buildGitHubReview` or `buildAzureThreads`.

- [ ] **Step 5: Extend plugin validation**

Add `extract-agent-response.mjs` to `requiredScripts`. Require `SKILL.md` to contain:

```js
if (!skillText.includes('--output-format json --stream off --silent')) {
  errors.push('SKILL.md must require JSONL agent transport');
}
if (!skillText.includes('extract-agent-response.mjs')) {
  errors.push('SKILL.md must extract raw agent responses');
}
for (const name of ['prg-verifier', 'prg-deduplicator', 'prg-editor']) {
  if (!skillText.includes(name)) errors.push(`SKILL.md must route ${name} through machine-response transport`);
}
```

Keep validation structural and dependency-free.

- [ ] **Step 6: Update README and release versions**

Add one concise Review graph statement that every machine-response stage uses raw JSONL extraction and never rendered text. Change `plugin.json` and the matching root marketplace entry from `0.2.5` to `0.2.6`. Leave `package.json` and marketplace metadata version unchanged.

- [ ] **Step 7: Run plugin tests and validation**

Run:

```bash
cd ghcp/plugins/pr-review-graph
npm test --silent
npm run validate --silent
```

Expected: both exit `0`; validation reports 9 agents, 1 skill, and zero MCP/hook dependencies.

- [ ] **Step 8: Commit workflow enforcement and release metadata**

```bash
git add .github/plugin/marketplace.json \
  ghcp/plugins/pr-review-graph/README.md \
  ghcp/plugins/pr-review-graph/plugin.json \
  ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/references/superpowers-compatibility.md \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "fix(pr-review-graph): require raw agent transport"
```

---

### Task 4: Final verification

**Files:**
- Verify: all files changed by Tasks 1-3

**Interfaces:**
- Consumes: completed implementation and committed history.
- Produces: verified local branch with no uncommitted changes.

- [ ] **Step 1: Run focused transport tests**

```bash
cd ghcp/plugins/pr-review-graph
node --test --test-name-pattern="agent response transport|discovery transport|machine-response transport" tests/plugin.test.mjs
```

Expected: exit `0`.

- [ ] **Step 2: Run complete plugin validation**

```bash
cd ghcp/plugins/pr-review-graph
npm test --silent
npm run validate --silent
```

Expected: both exit `0`.

- [ ] **Step 3: Inspect the final diff and history**

```bash
git --no-pager diff --check main...HEAD
git status --short
git --no-pager log --oneline main..HEAD
```

Expected: no whitespace errors, no uncommitted files, and commits for the approved spec, plan, extractor, discovery integration, and workflow enforcement. No commit contains a `Co-authored-by` trailer.
