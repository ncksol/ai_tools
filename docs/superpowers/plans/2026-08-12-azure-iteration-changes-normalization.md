# Azure Iteration Changes Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `normalizeAzure` read the iteration changes the API actually returns, so `changeTrackingId` survives and published Azure comments keep cross-iteration anchoring.

**Architecture:** Correct the test fixture first, so the existing `changeTrackingId` assertion starts failing and stops vouching for a response shape the API never produces. Then fix the single read in `normalizeAzure` to accept the documented `{changeEntries}` body, and add a truncation warning through the `limits.warnings` mechanism that already exists and is already surfaced to the operator.

**Tech Stack:** Node.js ≥ 18 ES modules, `node --test`. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-azure-iteration-changes-normalization-design.md`

## Global Constraints

- All commands run from `ghcp/plugins/pr-review-graph`. Tests: `npm test`. Validation: `npm run validate`.
- Node.js ≥ 18, ES modules only (`import`, never `require`). Node built-ins only.
- Do NOT add any dependency. `package.json` must stay dependency-free.
- Do NOT modify `asArray` in `lib.mjs`. It is a generic helper used across both providers and must not learn one Azure endpoint's vocabulary.
- Do NOT modify `collect-azure-devops.sh`. The collector's `$top=2000` stays as it is; no paging is being added.
- Do NOT edit the existing assertion `assert.equal(threads[0].payload.pullRequestThreadContext.changeTrackingId, 9)`. Making that assertion meaningful without changing it is the point of the task.
- Shell scripts in this plugin must remain Bash 3.2-compatible; a lint enforces this. This plan changes no shell.
- Commit messages must not contain a `Co-authored-by` trailer or any AI attribution trailer.
- Work on the current branch, `nicksologoub-microsoft-add-pr-review-graph-plugin`, which has PR #3 open.

---

### Task 1: Read the documented change-entries shape

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/tests/fixtures/azure-raw.json` (the `changes` value)
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/normalize-context.mjs:166`

**Interfaces:**
- Consumes: `asArray` from `./lib.mjs`, already imported by `normalize-context.mjs`.
- Produces: no new exports. `normalize(raw)` keeps its signature. Task 2 relies on `normalizeAzure` populating `changeByPath` from real data, and on `raw.changes` being an object rather than an array in the fixture.

- [ ] **Step 1: Correct the fixture to the documented API response body**

In `tests/fixtures/azure-raw.json`, the `changes` value is currently:

```json
"changes": {
  "count": 1,
  "value": [
    {
      "changeTrackingId": 9,
      "changeType": "edit",
      "item": {
        "path": "/db/schema.sql"
      }
    }
  ]
}
```

Replace it with the body that `GitPullRequestIterationChanges` actually returns. The change entry itself is unchanged — only the wrapper around it:

```json
"changes": {
  "changeEntries": [
    {
      "changeTrackingId": 9,
      "changeType": "edit",
      "item": {
        "path": "/db/schema.sql"
      }
    }
  ],
  "nextSkip": 0,
  "nextTop": 0
}
```

Change nothing else in the fixture. Its other top-level keys — `provider`, `pullRequest`, `diff`, `iterations`, `existingThreads`, `workItems`, `policies` — stay exactly as they are.

- [ ] **Step 2: Run the tests to verify the fixture change breaks the existing assertion**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: FAIL. The test `Azure builder preserves iteration and change tracking context` fails on
`assert.equal(threads[0].payload.pullRequestThreadContext.changeTrackingId, 9)`, because
`asArray({changeEntries: […]})` returns `[]`, so no change is found for the file and
`changeTrackingId` is absent.

This failure is the entire point of the task and must be observed, not assumed. It demonstrates that
the old fixture was making a broken code path look healthy. Record the exact failure output in your
report. Do not edit the assertion to accommodate it.

- [ ] **Step 3: Fix the read in `normalizeAzure`**

In `skills/review-pull-request/scripts/normalize-context.mjs`, inside `normalizeAzure`, replace this
line:

```javascript
  const changes = asArray(raw.changes);
```

with:

```javascript
  const changes = asArray(raw.changes?.changeEntries ?? raw.changes);
```

Change nothing else. The lines around it — `parsedByPath`, `changeByPath`, and the loop that fills it —
stay as they are. Do not modify `asArray` in `lib.mjs`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS. The Azure builder test now passes with its original assertion untouched, and validation
prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/tests/fixtures/azure-raw.json \
        ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/normalize-context.mjs
git commit -m "Read Azure iteration changes from the documented response body

The pullRequestIterationChanges endpoint returns
{changeEntries, nextSkip, nextTop}, but normalizeAzure read it with
asArray, which accepts only a bare array or a .value array. Real
collector output normalized to nothing, so changeTrackingId was lost and
published inline comments lost cross-iteration anchoring.

The fixture stored the generic {count, value} wrapper, which asArray does
handle, so the changeTrackingId assertion passed against a shape the API
never returns. Correcting the fixture turns that test from one that
vouched for the defect into one that catches it; the assertion itself is
unchanged."
```

---

### Task 2: Warn when the change list is truncated

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/normalize-context.mjs:225` (alongside the existing `Unified diff is unavailable` check)
- Test: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` (append)

**Interfaces:**
- Consumes: `normalize(raw)` from `./normalize-context.mjs`, already imported by the test file. Task 1's fixture correction means `raw.changes` is an object carrying `nextSkip` and `nextTop`, which this task reads.
- Produces: a new entry in `packet.limits.warnings`, the array `packet.schema.json` already requires and SKILL.md step 8 already instructs the reviewer to inspect. No new exports.

- [ ] **Step 1: Write the failing test**

Append to `tests/plugin.test.mjs`. The file already imports `normalize` and defines the `fixture(name)`
helper, so no new imports are needed:

```javascript
test('a truncated Azure change list is reported as a packet warning', async () => {
  const raw = await fixture('azure-raw.json');
  const untruncated = normalize(raw);
  assert.equal(untruncated.limits.warnings.some(warning => /change list is truncated/.test(warning)), false);

  const truncated = normalize({ ...raw, changes: { ...raw.changes, nextSkip: 2000, nextTop: 2000 } });
  assert.equal(truncated.limits.warnings.some(warning => /change list is truncated/.test(warning)), true);
  assert.equal(truncated.files.length, untruncated.files.length);
});
```

The final assertion records that a truncation warning does not itself discard files: the file list is
the union of the parsed diff and the change list, so truncation costs change-tracking data rather than
whole files.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: FAIL on the second assertion — the truncated packet produces no matching warning, so
`assert.equal(false, true)` reports `Expected values to be strictly equal: false !== true`. The first
assertion passes already, which is correct: it is the control.

- [ ] **Step 3: Add the truncation warning**

In `skills/review-pull-request/scripts/normalize-context.mjs`, inside `normalizeAzure`, find this line:

```javascript
  if (!String(raw.diff ?? '').trim()) warnings.push('Unified diff is unavailable');
```

Add the truncation check immediately after it, so the two packet-level observations sit together:

```javascript
  if (Number(raw.changes?.nextSkip ?? 0) > 0 || Number(raw.changes?.nextTop ?? 0) > 0) {
    warnings.push('Azure change list is truncated; some files have no change tracking data');
  }
```

Both fields are checked because the API documents both, and either being non-zero means more changes
remain. `Number(… ?? 0)` keeps a missing or non-numeric field from raising a spurious warning. Do not
mention the collector's `$top` value in the message: `normalizeAzure` normalizes whatever it is handed
and has no knowledge of how the request was made.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS — every test passes, including the pre-existing Azure tests, and validation prints
`Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/normalize-context.mjs \
        ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "Warn when the Azure change list is truncated

The collector requests \$top=2000, and the API reports more available
changes through nextSkip and nextTop. Those files keep their patches from
the local diff but lose change tracking, so inline comments on them lose
cross-iteration anchoring.

Paging would mean a \$skip loop and JSON page merging in the collector for
a pull request larger than this tool can usefully review. A warning routes
through limits.warnings, which the packet schema already requires and
SKILL.md already tells the reviewer to inspect before claiming a complete
review."
```

---

### Task 3: Version bump

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/plugin.json` (`version`)
- Modify: `.github/plugin/marketplace.json` (`plugins[0].version`)

**Interfaces:**
- Consumes: the version-match assertion in `scripts/validate-plugin.mjs`, which compares `plugin.json` `version` against the repository-root marketplace entry for the same plugin name.
- Produces: nothing. This is the final task.

- [ ] **Step 1: Bump the plugin version**

In `ghcp/plugins/pr-review-graph/plugin.json`, change `"version": "0.2.2",` to `"version": "0.2.3",`.

- [ ] **Step 2: Run the validator to verify it now fails**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: FAIL with `marketplace version 0.2.2 must match plugin.json version 0.2.3`. This confirms the
version-match assertion is live rather than vacuous.

- [ ] **Step 3: Bump the marketplace entry to match**

In the repository-root `.github/plugin/marketplace.json`, change the `version` **inside the single entry
of the `plugins` array** from `"0.2.2"` to `"0.2.3"`. Leave `metadata.version` at `"1.0.0"` — it versions
the marketplace, not the plugin.

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS — every test passes and validation prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/plugin.json .github/plugin/marketplace.json
git commit -m "Release pr-review-graph 0.2.3

Patch bump for Azure iteration-changes normalization, kept in step across
plugin.json and the repository marketplace entry."
```
