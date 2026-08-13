# Empty Assistant Frame Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow legitimate empty, tool-free Copilot CLI assistant frames while preserving exact extraction of one non-empty terminal PR Review Graph payload.

**Architecture:** Keep the schema-agnostic JSONL extractor and every downstream stage interface unchanged. Classify empty assistant messages as structural frames regardless of tool-request presence, retain existing turn-boundary validation for every message, and continue selecting only one non-empty, tool-free terminal payload.

**Tech Stack:** Node.js >= 18, Node built-ins, `node:test`, Bash, `jq`, Markdown plugin prompts and documentation.

**Design spec:** `docs/superpowers/specs/2026-08-13-empty-assistant-frame-transport-design.md`

## Global Constraints

- Work from merge commit `c2976f0e8da57d723a4294ca408eb4ce29080d62` or a descendant.
- Use Node.js >= 18 and Node built-ins only; add no dependency.
- Never parse or repair rendered text and never search prose for JSON.
- Never treat encrypted or reasoning fields as payloads.
- Preserve the exact decoded bytes of the one non-empty, tool-free terminal assistant payload.
- Empty assistant frames remain subject to all existing turn-boundary checks.
- Preserve contentful-preamble, content-plus-tool, multiple-payload, missing/non-terminal payload, result-order, file-mode, cleanup, structural-diagnostic, strict-ingestion, retry, coverage, verifier, deduplication, and editor fail-closed behavior.
- Do not add candidate salvage, weaker validation, or another discovery attempt.
- Do not print, commit, or retain raw Copilot JSONL.
- Keep model- and network-dependent Copilot invocation outside the automated test suite.
- Set `plugin.json` and the root marketplace entry to `0.2.7`; keep `package.json` at `0.2.0`.
- Run plugin commands from `ghcp/plugins/pr-review-graph`.
- Commit messages must not contain `Co-authored-by` or any AI attribution trailer.

## File Map

| File | Responsibility |
| --- | --- |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/extract-agent-response.mjs` | Structural JSONL validation and exact terminal payload extraction |
| `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` | Minimal empty-frame regression, captured reliability stream shape, strict ingestion, safety invariants, static contract, and release checks |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md` | Runtime machine-response transport instructions |
| `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md` | Review graph transport contract |
| `ghcp/plugins/pr-review-graph/README.md` | User-facing contract and opt-in real CLI structural verification |
| `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs` | Static enforcement of the empty-frame contract |
| `docs/superpowers/specs/2026-08-12-agent-response-transport-design.md` | Corrected original transport design |
| `docs/superpowers/plans/2026-08-12-agent-response-transport.md` | Corrected original implementation instructions |
| `ghcp/plugins/pr-review-graph/plugin.json` | Plugin release version `0.2.7` |
| `.github/plugin/marketplace.json` | Matching marketplace release version `0.2.7` |

---

### Task 1: Accept Empty Tool-free Frames

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs:50-295`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/extract-agent-response.mjs:86-97`

**Interfaces:**
- Consumes: `agentEventStream(content, options)`, `discoveryCandidate(category, overrides)`, `extractAgentResponse(eventsFile, responseFile, statusFile)`, and `ingestDiscoveryResponse(rawFile, resultDirectory, diagnosticsDirectory, metadata)`.
- Produces: unchanged `extractAgentResponse(...) -> Promise<TransportStatus>`.
- Preserves: exact payload files, fixed structural transport statuses, and capture cleanup.

- [ ] **Step 1: Extend the test stream helper for same-turn control frames**

Insert `options.beforePayload` between the final turn start and payload:

```js
function agentEventStream(content, options = {}) {
  const turnId = options.turnId ?? 'turn-final';
  const events = [
    ...(options.preceding ?? []),
    {
      type: 'assistant.turn_start',
      data: { turnId, interactionId: `interaction-${turnId}` }
    },
    ...(options.beforePayload ?? []),
    {
      type: 'assistant.message',
      data: { turnId, content, toolRequests: options.toolRequests ?? [] }
    },
    {
      type: 'assistant.turn_end',
      data: { turnId }
    },
    ...(options.following ?? []),
    {
      type: 'result',
      exitCode: options.exitCode ?? 0
    }
  ];
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}
```

- [ ] **Step 2: Write the exact minimal failing regression**

Add this test after the long payload transport test:

```js
test('agent response transport ignores an empty tool-free reasoning frame', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-empty-frame-'));
  try {
    const eventsFile = path.join(directory, 'events.jsonl');
    const responseFile = path.join(directory, 'response.json');
    const statusFile = path.join(directory, 'status.json');
    await writeFile(eventsFile, agentEventStream('[]', {
      beforePayload: [{
        type: 'assistant.message',
        data: {
          turnId: 'turn-final',
          content: '',
          toolRequests: [],
          encryptedContent: 'synthetic-encrypted-frame',
          reasoningOpaque: 'synthetic-reasoning-frame'
        }
      }]
    }), { mode: 0o600 });

    const result = await extractAgentResponse(eventsFile, responseFile, statusFile);

    assert.equal(result.status, 'complete');
    assert.equal(await readFile(responseFile, 'utf8'), '[]');
    assert.deepEqual(JSON.parse(await readFile(statusFile, 'utf8')), {
      schemaVersion: '1.0',
      status: 'complete'
    });
    await assert.rejects(access(eventsFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Write the captured reliability-shape extraction and ingestion regression**

Add a deterministic test with one tool-bearing empty message, seven empty
tool-free reasoning frames, and one final strict reliability candidate:

```js
test('captured reliability stream shape extracts and ingests the final candidate array', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-reliability-shape-'));
  try {
    const eventsFile = path.join(directory, 'events.jsonl');
    const responseFile = path.join(directory, 'response.json');
    const statusFile = path.join(directory, 'status.json');
    const candidate = discoveryCandidate('reliability', {
      title: 'Terminal payload survives empty reasoning frames',
      problem: 'valid final discovery output is discarded before strict ingestion',
      trigger: 'a long Copilot turn emits empty tool-free reasoning frames',
      consequence: 'the planned reliability batch is recorded as failed',
      evidence: 'the terminal assistant payload remains a strict candidate array',
      recommendation: 'exclude empty assistant frames from payload candidacy'
    });
    const payload = JSON.stringify([candidate]);
    const reasoningFrames = Array.from({ length: 7 }, (_, index) => ({
      type: 'assistant.message',
      data: {
        turnId: 'turn-final',
        content: '',
        toolRequests: [],
        encryptedContent: `synthetic-encrypted-${index + 1}`,
        reasoningOpaque: `synthetic-reasoning-${index + 1}`
      }
    }));
    await writeFile(eventsFile, agentEventStream(payload, {
      preceding: [
        { type: 'assistant.turn_start', data: { turnId: 'turn-tool' } },
        {
          type: 'assistant.message',
          data: {
            turnId: 'turn-tool',
            content: '',
            toolRequests: [{ toolCallId: 'call-1', name: 'skill' }]
          }
        },
        {
          type: 'tool.execution_start',
          data: { turnId: 'turn-tool', toolCallId: 'call-1', toolName: 'skill' }
        },
        {
          type: 'tool.execution_complete',
          data: { turnId: 'turn-tool', toolCallId: 'call-1', success: true }
        },
        { type: 'assistant.turn_end', data: { turnId: 'turn-tool' } }
      ],
      beforePayload: reasoningFrames
    }), { mode: 0o600 });

    const transport = await extractAgentResponse(eventsFile, responseFile, statusFile);
    assert.equal(transport.status, 'complete');
    assert.equal(await readFile(responseFile, 'utf8'), payload);

    const ingestion = await ingestDiscoveryResponse(
      responseFile,
      path.join(directory, 'results'),
      path.join(directory, 'diagnostics'),
      { agent: 'prg-reliability', batch: 1, attempt: 1 }
    );
    assert.equal(ingestion.status, 'complete');
    assert.deepEqual(ingestion.findings, [candidate]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Add a boundary regression for empty frames**

Add this case to the existing `cases` array in
`agent response transport fails closed on ambiguous or rendered streams`:

```js
{
  label: 'empty tool-free message outside a turn',
  stream: asJsonl([{
    type: 'assistant.message',
    data: {
      turnId: 'turn-orphan',
      content: '',
      toolRequests: [],
      encryptedContent: 'synthetic-encrypted-frame',
      reasoningOpaque: 'synthetic-reasoning-frame'
    }
  }, ...finalTurn, resultEvent]),
  kind: 'transport-non-terminal-payload'
},
```

This proves the implementation ignores the frame for payload selection but
still rejects it through the existing turn-boundary check.

- [ ] **Step 5: Run the focused tests to verify the regression is red**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test \
  --test-name-pattern="empty tool-free reasoning frame|captured reliability stream shape|ambiguous or rendered streams" \
  tests/plugin.test.mjs
```

Expected: the two successful-extraction assertions fail because the extractor
returns `transport-invalid-event`; the orphan-frame case also reports
`transport-invalid-event` instead of `transport-non-terminal-payload`.

- [ ] **Step 6: Remove only the incorrect empty-frame predicate**

Change the `assistant.message` structural condition to:

```js
if (
  typeof event.data?.turnId !== 'string'
  || !event.data.turnId
  || typeof event.data.content !== 'string'
  || !Array.isArray(event.data.toolRequests)
  || (event.data.content && event.data.toolRequests.length > 0)
) {
  return { status: invalid('transport-invalid-event', safeEventDetails(event, eventIndex)) };
}
```

Do not change payload selection, turn matching, result validation, status
writing, permissions, or cleanup.

- [ ] **Step 7: Run focused and complete transport tests**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test \
  --test-name-pattern="agent response transport|captured reliability stream shape" \
  tests/plugin.test.mjs
```

Expected: every selected transport test passes, including strict reliability
ingestion and all existing fail-closed cases.

- [ ] **Step 8: Commit the extractor regression fix**

```bash
git add \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/extract-agent-response.mjs \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "fix(pr-review-graph): accept empty assistant frames"
```

---

### Task 2: Align the Contract, Smoke Procedure, and Release

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs:390-446`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md:31-50`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md:33-36`
- Modify: `ghcp/plugins/pr-review-graph/README.md:65-99`
- Modify: `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs:76-94`
- Modify: `docs/superpowers/specs/2026-08-12-agent-response-transport-design.md:79-113`
- Modify: `docs/superpowers/plans/2026-08-12-agent-response-transport.md:13-26,145-170`
- Modify: `ghcp/plugins/pr-review-graph/plugin.json:4`
- Modify: `.github/plugin/marketplace.json:14`

**Interfaces:**
- Consumes: the selected empty-frame extraction semantics from Task 1.
- Produces: synchronized installable version `0.2.7`, static validation for the runtime contract, and a reproducible opt-in structural smoke procedure.
- Preserves: `package.json` version `0.2.0`.

- [ ] **Step 1: Make static contract and release tests fail**

In `static plugin validation passes and declares no MCP integration`, change:

```js
assert.equal(manifest.version, '0.2.7');
```

In `machine-response transport is required for every tool-less agent stage`,
read the README and assert the runtime and smoke contracts:

```js
const readme = await readFile(path.join(root, 'README.md'), 'utf8');
assert.match(skill, /empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i);
assert.match(graph, /empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i);
assert.match(readme, /empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i);
assert.match(readme, /## Opt-in transport smoke/);
assert.match(readme, /--available-tools=skill --allow-tool=skill/);
assert.match(readme, /emptyNoToolFrames/);
```

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test \
  --test-name-pattern="static plugin validation|machine-response transport" \
  tests/plugin.test.mjs
```

Expected: failures for version `0.2.6`, missing empty-frame clauses, and the
missing opt-in smoke section.

- [ ] **Step 2: Correct the runtime transport instructions**

Add this sentence after the extractor behavior in `SKILL.md`:

```markdown
Empty assistant messages are structural frames regardless of tool requests; they remain subject to matching turn boundaries and are never payload candidates.
```

Add the same rule to `references/review-graph.md` immediately after the
machine-response transport paragraph.

In the README review graph, replace the transport sentence with:

```markdown
Every machine-response stage extracts the raw final assistant payload from Copilot JSONL; rendered transcript text is never parsed as agent JSON. Empty assistant messages are structural frames regardless of tool requests and remain subject to assistant-turn validation.
```

- [ ] **Step 3: Correct the historical design and plan**

In `2026-08-12-agent-response-transport-design.md`, replace the contradicted
paragraph beginning `An empty assistant.message is ignorable only` with:

```markdown
An empty `assistant.message` is an ignorable structural frame regardless of whether it carries tool requests. It remains subject to the same matching turn boundaries as every assistant message. A response payload is a non-empty, tool-free string in `assistant.message.data.content`. The stream is valid only when:
```

In `2026-08-12-agent-response-transport.md`, replace:

```markdown
Permit an empty message only when `data.toolRequests` is a non-empty array.
```

with:

```markdown
Treat an empty message as a structural frame regardless of tool-request presence, while still requiring it to belong to one matching assistant turn.
```

Run this search and ensure no remaining statement requires tools on an empty
assistant message:

```bash
rg -n "empty.*only.*tool|Permit an empty message only|empty message only when" \
  docs/superpowers \
  ghcp/plugins/pr-review-graph
```

Expected: no matches.

- [ ] **Step 4: Add the opt-in real Copilot CLI smoke procedure**

Add this section under README `## Development`, after the standard test
commands:

````markdown
## Opt-in transport smoke

This manual smoke invokes Copilot and is intentionally excluded from `npm test`.
It allows only the `skill` tool, retains all output in a private temporary
directory, reports structural counts only, and removes the directory on exit.

```bash
set -euo pipefail
umask 077
tmp="$(mktemp -d "${TMPDIR:-/tmp}/prg-transport-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
events="$tmp/events.jsonl"
response="$tmp/response.json"
status="$tmp/status.json"
results="$tmp/results"
diagnostics="$tmp/diagnostics"

copilot --output-format json --stream off --silent \
  --available-tools=skill --allow-tool=skill --effort high \
  -p 'Invoke the gh-cli skill. Do not call another tool. After reading the skill, return exactly [] with no prose.' \
  > "$events"

jq -e -s '
  {
    assistantMessages: ([.[] | select(.type == "assistant.message")] | length),
    emptyNoToolFrames: ([
      .[]
      | select(
          .type == "assistant.message"
          and .data.content == ""
          and (.data.toolRequests | length) == 0
        )
    ] | length),
    toolBearingEmptyFrames: ([
      .[]
      | select(
          .type == "assistant.message"
          and .data.content == ""
          and (.data.toolRequests | length) > 0
        )
    ] | length),
    nonEmptyPayloads: ([
      .[]
      | select(
          .type == "assistant.message"
          and (.data.content | length) > 0
          and (.data.toolRequests | length) == 0
        )
    ] | length)
  }
  | select(
      .emptyNoToolFrames > 0
      and .toolBearingEmptyFrames > 0
      and .nonEmptyPayloads == 1
    )
' "$events"

node skills/review-pull-request/scripts/extract-agent-response.mjs \
  "$events" "$response" "$status"
mkdir -m 700 "$results" "$diagnostics"
node skills/review-pull-request/scripts/process-discovery.mjs ingest \
  "$response" "$results" "$diagnostics" \
  --agent prg-reliability --batch 1 --attempt 1
jq -e '
  .status == "complete"
  and .category == "reliability"
  and (.findings | length) == 0
' "$results/prg-reliability-batch-001-attempt-1.json" >/dev/null
printf '%s\n' 'Opt-in transport smoke passed'
```

Run it only from `ghcp/plugins/pr-review-graph`. Do not redirect, copy, or
retain the event or response files outside the private temporary directory.
````

- [ ] **Step 5: Enforce the contract in plugin validation**

After the existing extractor check in `validate-plugin.mjs`, add:

```js
if (!/empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i.test(skillText)) {
  errors.push('SKILL.md must classify empty assistant messages as structural frames');
}
```

- [ ] **Step 6: Bump the installable plugin version**

Change:

```json
"version": "0.2.7"
```

in both `ghcp/plugins/pr-review-graph/plugin.json` and the
`pr-review-graph` entry in `.github/plugin/marketplace.json`. Do not change
`ghcp/plugins/pr-review-graph/package.json`.

- [ ] **Step 7: Run focused documentation and validation tests**

Run:

```bash
cd ghcp/plugins/pr-review-graph
node --test \
  --test-name-pattern="static plugin validation|machine-response transport" \
  tests/plugin.test.mjs
npm run validate --silent
```

Expected: both selected tests and plugin validation pass with synchronized
version `0.2.7`.

- [ ] **Step 8: Commit the contract and release**

```bash
git add \
  .github/plugin/marketplace.json \
  docs/superpowers/specs/2026-08-12-agent-response-transport-design.md \
  docs/superpowers/plans/2026-08-12-agent-response-transport.md \
  ghcp/plugins/pr-review-graph/README.md \
  ghcp/plugins/pr-review-graph/plugin.json \
  ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md \
  ghcp/plugins/pr-review-graph/skills/review-pull-request/references/review-graph.md \
  ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "docs(pr-review-graph): release empty frame transport fix"
```

---

### Task 3: Verify the Corrected Release

**Files:**
- Verify only: all files changed by Tasks 1 and 2

**Interfaces:**
- Consumes: plugin release `0.2.7` with corrected extraction and documentation.
- Produces: local evidence that the deterministic suite, static validation, and opt-in real Copilot CLI path all pass without retaining raw output.

- [ ] **Step 1: Run the opt-in real CLI structural smoke**

From `ghcp/plugins/pr-review-graph`, execute the complete command block under
README `## Opt-in transport smoke` without altering its trap or redirecting
its files.

Expected: `jq` emits one structural count object with
`emptyNoToolFrames > 0`, `toolBearingEmptyFrames > 0`, and
`nonEmptyPayloads == 1`, followed by `Opt-in transport smoke passed`. The trap
removes the temporary JSONL, response, status, result, and diagnostic files.

- [ ] **Step 2: Run the full plugin test and validation commands**

Run:

```bash
cd ghcp/plugins/pr-review-graph
npm test --silent
npm run validate --silent
```

Expected: all tests pass and validation reports nine agents, one skill, and
zero MCP or hook dependencies.

- [ ] **Step 3: Check release and repository invariants**

Run:

```bash
git diff --check
node -e '
const fs = require("node:fs");
const plugin = JSON.parse(fs.readFileSync("ghcp/plugins/pr-review-graph/plugin.json", "utf8"));
const packageJson = JSON.parse(fs.readFileSync("ghcp/plugins/pr-review-graph/package.json", "utf8"));
const marketplace = JSON.parse(fs.readFileSync(".github/plugin/marketplace.json", "utf8"));
const entry = marketplace.plugins.find(item => item.name === plugin.name);
if (plugin.version !== "0.2.7" || entry?.version !== "0.2.7" || packageJson.version !== "0.2.0") {
  process.exit(1);
}
'
git status --short
git --no-pager log --oneline -5
```

Expected: no whitespace errors; plugin and marketplace are `0.2.7`;
`package.json` is `0.2.0`; the worktree is clean; recent commits include the
design, implementation, and release documentation with no attribution
trailers.
