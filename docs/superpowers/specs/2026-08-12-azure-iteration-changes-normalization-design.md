# Azure iteration changes normalization

- **Date:** 2026-08-12
- **Status:** Approved (design); implementation pending
- **Target files:** `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/normalize-context.mjs`, `tests/fixtures/azure-raw.json`, `tests/plugin.test.mjs`, version manifests
- **Origin:** Issue 3 of the review on PR #3 (`ncksol/ai_tools`), verified independently before acceptance
- **Related:** issues 1 and 2 of the same review are fixed under
  `2026-08-12-prg-editor-comment-join-design.md` and
  `2026-08-12-azure-collector-bash3-compatibility-design.md`

## 1. Problem statement

`normalizeAzure` never sees the Azure DevOps iteration changes it collects. It reads them with
`asArray(raw.changes)`, and `asArray` accepts only a bare array or an object with a `value` array.
The endpoint the collector calls, `pullRequestIterationChanges`, returns the response type
`GitPullRequestIterationChanges`, whose documented body is:

```json
{ "changeEntries": [ … ], "nextSkip": 0, "nextTop": 0 }
```

No `value` key exists, so real collector output normalizes to an empty list.

The consequence is narrower than it first appears, and worth stating precisely. The file list is the
union of paths parsed from the local git diff and paths from the change list, so no file disappears
from the review. What is lost is the per-file data that only the change list carries:
`changeTrackingId`, `changeType`, and `sourceServerItem` for renames. `changeTrackingId` matters most:
`buildAzureThreads` puts it in `pullRequestThreadContext`, which is how Azure anchors an inline comment
to a file across iterations. Without it, published comments lose cross-iteration tracking.

## 2. Why the test suite did not catch it

`tests/fixtures/azure-raw.json` stores `changes` as `{"count": 1, "value": [...]}` — the generic
collection wrapper that `asArray` does handle. The existing assertion

```javascript
assert.equal(threads[0].payload.pullRequestThreadContext.changeTrackingId, 9);
```

therefore passes. This is worse than absent coverage: the test appears to protect `changeTrackingId`
while exercising a response shape the API never produces, so it actively vouches for behaviour that
fails in practice. Correcting the fixture is the substance of this change, not an incidental tidy-up.

## 3. Design decisions

### 3.1 Read the documented shape at the call site

`asArray` is a generic helper used in roughly a dozen places across both providers. Teaching it an
Azure-specific `changeEntries` key would push one endpoint's vocabulary into shared code. The read is
therefore fixed where it happens, in `normalizeAzure`:

```javascript
const changes = asArray(raw.changes?.changeEntries ?? raw.changes);
```

One expression covers the real `{changeEntries}` body and still tolerates a bare array, which is what
`optionalJson` substitutes when `changes.json` is absent. No new branch is introduced.

Only the real shape is tested. Shapes the API does not produce get no tests, because tests for
imagined inputs document nothing and still have to be maintained.

### 3.2 Warn on truncation rather than paging

`GitPullRequestIterationChanges` carries `nextSkip` and `nextTop`, both zero when no further changes
exist. The collector requests `$top=2000`, so a pull request with more than 2000 changed entries would
silently lose change tracking for the remainder.

Implementing paging means adding a `$skip` loop to `collect-azure-devops.sh` and merging JSON pages in
shell — meaningful work for a pull request larger than any this tool can usefully review.

Warning is the proportionate response, and the mechanism already exists. `normalizeAzure` builds a
`warnings` array; `packet.schema.json` requires `warnings` under `limits`; SKILL.md step 8 already
instructs the reviewer to "Inspect `limits.warnings` and `limits.truncatedFiles`. Do not claim a
complete review when material context is missing"; and Phase 5 shows "coverage and any incomplete
scopes" in the preview. A truncation warning is therefore surfaced to the operator without any new
plumbing.

The warning must not name the collector's `$top` value. `normalizeAzure` normalizes whatever it is
given and has no knowledge of how the request was made; embedding `2000` would couple the two and go
stale if the collector changed.

### 3.3 Out of scope

The collector's `$top=2000` is left alone, and no paging is added. `asArray` itself is unchanged.

## 4. The change

### 4.1 Reading the change entries

In `normalizeAzure`, replace:

```javascript
const changes = asArray(raw.changes);
```

with:

```javascript
const changes = asArray(raw.changes?.changeEntries ?? raw.changes);
```

Everything downstream — `changeByPath`, the `paths` union, and the per-file `changeTrackingId`,
`changeType` and `previousPath` derivation — is unchanged and starts receiving real data.

### 4.2 Truncation warning

In `normalizeAzure`, alongside the existing `Unified diff is unavailable` check, which is the natural
sibling — both are packet-level observations about missing context rather than per-file ones — add:

```javascript
if (Number(raw.changes?.nextSkip ?? 0) > 0 || Number(raw.changes?.nextTop ?? 0) > 0) {
  warnings.push('Azure change list is truncated; some files have no change tracking data');
}
```

Both fields are checked because the API documents both, and either being non-zero indicates more
changes remain. `Number(… ?? 0)` keeps a missing or non-numeric field from producing a spurious
warning.

### 4.3 Fixture

`tests/fixtures/azure-raw.json` changes its `changes` value from the generic wrapper to the documented
response body:

```json
"changes": {
  "changeEntries": [
    {
      "changeTrackingId": 9,
      "changeType": "edit",
      "item": { "path": "/db/schema.sql" }
    }
  ],
  "nextSkip": 0,
  "nextTop": 0
}
```

The entry itself is unchanged, so the existing `changeTrackingId` assertion keeps its current
expected value and becomes meaningful rather than misleading. No other fixture field changes.

## 5. Tests

1. **The existing Azure builder test becomes the regression test.** Once the fixture carries the real
   shape, `assert.equal(threads[0].payload.pullRequestThreadContext.changeTrackingId, 9)` fails
   against the unfixed `normalizeAzure` and passes after it. The assertion is not edited. This must be
   demonstrated: the fixture is corrected first and the suite run to observe the failure, before the
   normalizer is changed.
2. **A new test asserts the truncation warning.** It normalizes an Azure packet whose `changes` carries
   a non-zero `nextSkip` and asserts `packet.limits.warnings` contains the truncation message, and that
   a response with `nextSkip` and `nextTop` both zero produces no such warning.

## 6. Packaging

- `plugin.json`: version `0.2.2` → `0.2.3`.
- `.github/plugin/marketplace.json` at the repository root: matching bump of the `pr-review-graph`
  entry's `version`, leaving `metadata.version` at `1.0.0`.

## 7. Acceptance criteria

1. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
2. With the fixture corrected and the normalizer not yet fixed, the existing Azure builder test fails
   on `changeTrackingId`. This is observed and recorded, proving the fixture change alone converts a
   false-passing test into a real one.
3. After the normalizer fix, that test passes without its assertion having been edited.
4. A truncated `changes` response produces a `limits.warnings` entry; an untruncated one does not.
5. `tests/fixtures/azure-raw.json` matches the documented `GitPullRequestIterationChanges` body.

## 8. Remaining out of scope

One defect from the original review stays open: repository resolution in `collect-github.sh`, where
`gh repo view` reads the current directory while `gh pr view` may resolve a URL in another repository.
It is unrelated to Azure normalization.
