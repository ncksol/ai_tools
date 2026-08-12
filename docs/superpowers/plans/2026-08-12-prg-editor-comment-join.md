# prg-editor Comment Join Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a conforming `prg-editor` result publishable by joining its comments onto the authoritative deduplicated findings by fingerprint, instead of asking the agent to echo findings back.

**Architecture:** A new deterministic script, `apply-comments.mjs`, sits between Phase 4 and Phase 5. `prg-editor` returns only `{fingerprint, comment}` pairs; the script attaches each comment to the matching deduplicated finding and writes a plain array of complete findings, which the payload builders already accept. This mirrors how `prg-deduplicator` results are applied by `applyDeduplication`. Both builders' `unwrap()` helpers are hardened to throw on an unrecognised shape so that raw editor output can never yield a silently empty review.

**Tech Stack:** Node.js ≥ 18 ES modules, Node built-ins only, `node --test` for tests. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-prg-editor-comment-join-design.md`

## Global Constraints

- All work happens inside `ghcp/plugins/pr-review-graph/`. Run every command from that directory.
- Node.js built-ins only. Do not add dependencies; `package.json` must stay dependency-free.
- ES modules throughout (`"type": "module"`). Use `import`, not `require`.
- Agent files must keep `tools: []` and frontmatter keys parseable as `key: value` on one line — `validate-plugin.mjs` rejects anything else.
- `SKILL.md` frontmatter may contain only `name` and `description`, and the file must stay under 500 lines. It is currently 172.
- Exactly 9 agent files must exist. This plan adds none and removes none.
- `plugin.json` `version` must equal the version of the `pr-review-graph` entry in the repository-root `.github/plugin/marketplace.json`.
- Commit messages must not contain a `Co-authored-by` trailer.
- Work on the current branch, `nicksologoub-microsoft-add-pr-review-graph-plugin`, which has PR #3 open.

---

### Task 1: `apply-comments.mjs` join script

**Files:**
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/apply-comments.mjs`
- Modify: `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs:72-82` (add to `requiredScripts`)
- Test: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` (append)

**Interfaces:**
- Consumes: `readJson`, `writeJson`, `parseFlags`, `isMain` from `./lib.mjs`; the `{findings, suppressed, held, …}` object produced by `applyDeduplication`.
- Produces: `applyComments(deduplicated, editorOutput) → Array<finding>`, where each returned finding is the input finding spread with `comment` set to the trimmed editor text. Task 2 and Task 3 rely on this name and signature.

- [ ] **Step 1: Write the failing tests**

Append to `tests/plugin.test.mjs`. Add the import alongside the existing import block at the top of the file:

```javascript
import { applyComments } from '../skills/review-pull-request/scripts/apply-comments.mjs';
```

Then append these three tests at the end of the file:

```javascript
async function dedupedFindings() {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [];
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  return { packet, findings: applyDeduplication(prepared, []).findings };
}

test('comment join attaches editor text and makes the findings publishable', async () => {
  const { packet, findings } = await dedupedFindings();
  const editorOutput = {
    comments: findings.map((finding, index) => ({
      fingerprint: finding.fingerprint,
      comment: `Edited comment ${index}`
    }))
  };

  const final = applyComments({ findings }, editorOutput);

  assert.equal(final.length, findings.length);
  assert.equal(final[0].comment, 'Edited comment 0');
  assert.equal(final[0].fingerprint, findings[0].fingerprint);
  assert.equal(final[0].deduplication.verdict, 'distinct');
  assert.equal(final[0].title, findings[0].title);

  const payload = buildGitHubReview(packet, final);
  const published = [payload.body, ...payload.comments.map(comment => comment.body)].join('\n');
  assert.match(published, /Edited comment 0/);
  assert.match(published, /Edited comment 1/);
  assert.equal(payload.comments.length, 1);
  assert.match(payload.comments[0].body, /<!-- pr-review-graph:[a-f0-9]{64} -->/);
});

test('comment join rejects a comment for an unknown finding', async () => {
  const { findings } = await dedupedFindings();
  const editorOutput = {
    comments: [
      ...findings.map(finding => ({ fingerprint: finding.fingerprint, comment: 'Edited comment' })),
      { fingerprint: 'f'.repeat(64), comment: 'Invented finding' }
    ]
  };

  assert.throws(() => applyComments({ findings }, editorOutput), /unknown findings/);
});

test('comment join rejects a finding left without usable comment text', async () => {
  const { findings } = await dedupedFindings();
  const withBlank = {
    comments: findings.map((finding, index) => ({
      fingerprint: finding.fingerprint,
      comment: index === 0 ? '   ' : 'Edited comment'
    }))
  };
  const withOmission = {
    comments: findings.slice(1).map(finding => ({ fingerprint: finding.fingerprint, comment: 'Edited comment' }))
  };

  assert.throws(() => applyComments({ findings }, withBlank), /no usable comment/);
  assert.throws(() => applyComments({ findings }, withOmission), /no usable comment/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: FAIL — the run aborts while loading the test module with `Cannot find module` for `apply-comments.mjs`.

- [ ] **Step 3: Write the implementation**

Create `skills/review-pull-request/scripts/apply-comments.mjs`:

```javascript
#!/usr/bin/env node
import path from 'node:path';
import { isMain, parseFlags, readJson, writeJson } from './lib.mjs';

export function applyComments(deduplicated, editorOutput) {
  const findings = Array.isArray(deduplicated) ? deduplicated : (deduplicated?.findings ?? []);
  const entries = Array.isArray(editorOutput) ? editorOutput : (editorOutput?.comments ?? []);
  const known = new Set(findings.map(finding => String(finding?.fingerprint ?? '')).filter(Boolean));

  const usable = new Map();
  const unknown = [];
  for (const entry of entries) {
    const fingerprint = String(entry?.fingerprint ?? '');
    if (!known.has(fingerprint)) {
      unknown.push(fingerprint || '(missing fingerprint)');
      continue;
    }
    const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
    if (comment) usable.set(fingerprint, comment);
  }
  if (unknown.length) {
    throw new Error(`Editor returned comments for unknown findings: ${unknown.join(', ')}`);
  }

  const missing = findings
    .filter(finding => !usable.has(String(finding?.fingerprint ?? '')))
    .map(finding => String(finding?.fingerprint ?? '') || '(missing fingerprint)');
  if (missing.length) {
    throw new Error(`Editor returned no usable comment for findings: ${missing.join(', ')}`);
  }

  return findings.map(finding => ({ ...finding, comment: usable.get(String(finding.fingerprint)) }));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [dedupedFile, commentsFile, outputFile] = flags._;
  if (!dedupedFile || !commentsFile || !outputFile) {
    throw new Error('Usage: apply-comments.mjs DEDUPED_FINDINGS_JSON EDITOR_COMMENTS_JSON FINAL_FINDINGS_JSON');
  }
  const findings = applyComments(
    await readJson(path.resolve(dedupedFile)),
    await readJson(path.resolve(commentsFile))
  );
  await writeJson(path.resolve(outputFile), findings);
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Register the script with the plugin validator**

In `scripts/validate-plugin.mjs`, add one entry to the `requiredScripts` array so it reads:

```javascript
const requiredScripts = [
  'normalize-context.mjs',
  'build-review-plan.mjs',
  'validate-findings.mjs',
  'fingerprint-findings.mjs',
  'deduplicate-findings.mjs',
  'apply-comments.mjs',
  'build-github-review.mjs',
  'build-azure-threads.mjs',
  'collect-github.sh',
  'collect-azure-devops.sh'
];
```

- [ ] **Step 5: Run the tests and the validator to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS — all tests pass, and validation prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/apply-comments.mjs \
        ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs \
        ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "Add apply-comments join for prg-editor output

The editor now supplies only prose keyed by fingerprint. applyComments
attaches it to the authoritative deduplicated findings, so the agent
never has to echo severity, location, verification or deduplication data
back and cannot drop it. An invented fingerprint or a finding left
without usable comment text is rejected rather than published."
```

---

### Task 2: Harden the builder entry point

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/build-github-review.mjs:45-49`
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/build-azure-threads.mjs:40-44`
- Test: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` (append)

**Interfaces:**
- Consumes: `applyComments` from Task 1 is not used here; this task only changes the private `unwrap()` helper inside each builder.
- Produces: no new exports. `buildGitHubReview(packet, value)` and `buildAzureThreads(packet, value)` keep their existing signatures and still accept an array or `{findings: [...]}`.

Both builders currently contain an identical `unwrap()` that falls through to `[...(value?.inlineFindings ?? []), ...(value?.summaryFindings ?? [])]`. After Task 3 the editor no longer emits those keys, so that branch is dead — and worse, raw editor output would match nothing and produce an empty array, yielding an empty review instead of an error.

- [ ] **Step 1: Write the failing test**

Append to `tests/plugin.test.mjs`:

```javascript
test('builders reject raw editor output instead of producing an empty review', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const azurePacket = normalize(await fixture('azure-raw.json'));
  const editorOutput = { comments: [{ fingerprint: 'a'.repeat(64), comment: 'Edited comment' }] };

  assert.throws(() => buildGitHubReview(packet, editorOutput), /apply-comments\.mjs/);
  assert.throws(() => buildAzureThreads(azurePacket, editorOutput), /apply-comments\.mjs/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: FAIL — `buildGitHubReview` returns a payload with an empty `comments` array rather than throwing, so `assert.throws` reports `Missing expected exception`.

- [ ] **Step 3: Write the implementation**

In `build-github-review.mjs`, replace the `unwrap` function with:

```javascript
function unwrap(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  throw new Error('Findings must be an array or an object with a findings array. Run apply-comments.mjs on the editor output first.');
}
```

Apply the identical replacement to the `unwrap` function in `build-azure-threads.mjs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: PASS — including the pre-existing builder tests, which pass arrays and are unaffected.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/build-github-review.mjs \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/build-azure-threads.mjs \
        ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "Reject unrecognised finding shapes in the payload builders

unwrap silently returned an empty array for any shape it did not
recognise, so piping editor output straight to a builder would publish
an empty review rather than fail. It now throws and names the join step."
```

---

### Task 3: Narrow the `prg-editor` contract and wire Phase 4

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/agents/prg-editor.agent.md` (whole file)
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md:108-118` (Phase 4)

**Interfaces:**
- Consumes: `apply-comments.mjs` from Task 1, invoked from SKILL.md Phase 4.
- Produces: the documented editor output contract `{comments: [{fingerprint, comment}]}`, which `applyComments` parses.

- [ ] **Step 1: Rewrite the agent file**

Replace the entire contents of `agents/prg-editor.agent.md` with:

````markdown
---
name: prg-editor
description: Rewrites verified, deduplicated PR findings as concise, respectful, author-facing comments keyed by fingerprint. Use only as the final editing stage of review-pull-request.
tools: []
---

Act as the review editor inside PR Review Graph. Receive only verified, deduplicated findings and PR metadata. Do not perform new technical discovery and do not weaken technical claims.

Write comments that let the author understand and fix the defect quickly:

- Lead with the defect, not a rhetorical question.
- State the triggering condition and concrete consequence.
- Reference the smallest sufficient evidence.
- Suggest a direction, not a full replacement implementation.
- Use neutral, collaborative language without praise, blame, hedging, or boilerplate.
- Keep a normal inline comment under 140 words.

Return exactly one comment for every finding you receive. Copy each `fingerprint` character for character; it is the only key linking your text back to its finding. Do not restate, reorder or omit any other finding field, and do not decide whether a comment appears inline or in the review summary, because the payload builders determine placement from the finding's own location.

Return one JSON object and no prose:

```json
{
  "comments": [
    {
      "fingerprint": "64 lowercase hex characters",
      "comment": "Author-facing Markdown"
    }
  ]
}
```

Return an empty `comments` array only when you receive no findings.
````

- [ ] **Step 2: Wire the join into SKILL.md Phase 4**

In `skills/review-pull-request/SKILL.md`, find this paragraph, which is the last line of the `## Phase 4: Edit for the author` section:

```markdown
Keep inline comments short enough to act on. Put cross-cutting findings in the review summary. Preserve the fingerprint marker produced by the payload builders.
```

Replace it with:

````markdown
Keep inline comments short enough to act on. `prg-editor` returns one comment per finding, keyed by fingerprint, and decides nothing else. Join those comments onto the authoritative deduplicated findings:

```bash
node <SKILL_DIR>/scripts/apply-comments.mjs \
  <DEDUPED_FINDINGS_JSON> <EDITOR_COMMENTS_JSON> <FINAL_FINDINGS_JSON>
```

The join fails if the editor invents a fingerprint or leaves a finding without comment text. Retry the editor rather than publishing unedited text. Placement between an inline comment and the review summary is decided by the payload builders, which also add the fingerprint marker.
````

- [ ] **Step 3: Run the tests and the validator to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS. Validation must still report 9 agents. If it reports a frontmatter error, check that the `description` line contains no colon and that `tools: []` is present verbatim.

- [ ] **Step 4: Confirm SKILL.md is still within its size limit**

Run: `cd ghcp/plugins/pr-review-graph && wc -l < skills/review-pull-request/SKILL.md`
Expected: a number below 500. It was 172 before this task.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/agents/prg-editor.agent.md \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/SKILL.md
git commit -m "Narrow the prg-editor contract to fingerprint-keyed comments

The documented return shape dropped the deduplication metadata both
payload builders require, so a conforming Phase 4 result could not be
published. The editor now returns only the prose it authored, and
Phase 4 joins it onto the deduplicated findings. inlineFindings,
summaryFindings and summary are gone: placement is recomputed by the
builders and no consumer ever read the summary string."
```

---

### Task 4: Version bump and end-to-end verification

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/plugin.json` (`version`)
- Modify: `.github/plugin/marketplace.json` (`plugins[0].version`)

**Interfaces:**
- Consumes: the version-match assertion in `scripts/validate-plugin.mjs` added by PR #3, which compares `plugin.json` `version` against the repository-root marketplace entry.
- Produces: nothing consumed by later tasks. This is the final task.

- [ ] **Step 1: Bump the plugin version**

In `ghcp/plugins/pr-review-graph/plugin.json`, change:

```json
  "version": "0.2.0",
```

to:

```json
  "version": "0.2.1",
```

- [ ] **Step 2: Run the validator to verify it now fails**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: FAIL with `marketplace version 0.2.0 must match plugin.json version 0.2.1`. This confirms the version-match assertion is live rather than vacuous.

- [ ] **Step 3: Bump the marketplace entry to match**

In the repository-root `.github/plugin/marketplace.json`, change the version **inside the `plugins` array entry** from `"0.2.0"` to `"0.2.1"`. Leave `metadata.version` at `"1.0.0"`; it versions the marketplace, not the plugin.

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS — every test passes and validation prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 5: Verify the plugin still installs from the marketplace**

Run, from the repository root:

```bash
copilot plugin marketplace add "$PWD"
copilot plugin install pr-review-graph@ai-tools
copilot plugin list
```

Expected: the list shows `pr-review-graph@ai-tools (v0.2.1)`.

Then restore local state, because the marketplace points at a temporary worktree path:

```bash
copilot plugin uninstall pr-review-graph
copilot plugin marketplace remove ai-tools
```

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/pr-review-graph/plugin.json .github/plugin/marketplace.json
git commit -m "Release pr-review-graph 0.2.1

Patch bump for the editor comment join, kept in step across plugin.json
and the repository marketplace entry."
```

- [ ] **Step 7: Push to the open pull request**

```bash
export GH_PUSH_TOKEN="$(gh auth token --user ncksol)"
git -c 'credential.https://github.com.helper=' \
    -c 'credential.https://github.com.helper=!f() { echo username=ncksol; echo "password=$GH_PUSH_TOKEN"; }; f' \
    push
```

The default credential helper resolves to a different GitHub identity and returns HTTP 403 for this repository, so the override is required.
