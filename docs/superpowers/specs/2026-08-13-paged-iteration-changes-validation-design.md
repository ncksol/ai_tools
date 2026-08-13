# pagedIterationChanges validation hardening

**Date:** 2026-08-13  
**Scope:** `ghcp/plugins/pr-review-graph`  
**File:** `skills/review-pull-request/scripts/collect-azure-devops-rest.mjs`

---

## Problem

`pagedIterationChanges` has two silent-success paths for malformed provider responses:

1. **Missing `changeEntries` field** — `page.changeEntries ?? []` treats any page without the field as an empty page. Combined with absent pagination fields, the loop terminates and returns `{ changeEntries: [], nextSkip: 0, nextTop: 0 }`, which is indistinguishable from a genuinely empty result. `assertCapabilityData` passes it, so the `changes` capability is marked complete with zero entries even though the provider sent garbage.

2. **Absent or null pagination fields** — `Number(page.nextSkip ?? 0)` coerces `null`/`undefined` to `0`. If both fields are absent/null, the loop terminates immediately with a false "done" signal.

Together, a provider response of `{}` silently produces a complete, valid-looking empty changes capability.

---

## Design

### Change to `pagedIterationChanges`

Replace the two lenient lines with strict guards that throw `accessError('malformed', ...)` on the first non-conforming page.

**`changeEntries` guard** (before accumulating):
```js
if (!Array.isArray(page?.changeEntries)) {
  throw accessError('malformed', `iteration ${iterationId} changes page missing changeEntries array`);
}
allEntries.push(...page.changeEntries);
```

**Pagination guard** (before reading cursors):
```js
if (
  !Number.isInteger(page.nextSkip) || page.nextSkip < 0 ||
  !Number.isInteger(page.nextTop)  || page.nextTop  < 0
) {
  throw accessError('malformed', `iteration ${iterationId} changes page has invalid pagination fields`);
}
const nextSkip = page.nextSkip;
const nextTop  = page.nextTop;
```

`Number.isInteger` rejects `null`, `undefined`, floats, and non-numeric strings. The `< 0` check rejects negatives. Together they accept only non-negative safe integers.

**Termination** (unchanged semantics, now operating on trusted values):
```js
if (nextSkip === 0 && nextTop === 0) {
  return { changeEntries: allEntries, nextSkip: 0, nextTop: 0 };
}
```

Cycle detection (`seenCursors`) is preserved unchanged.

### Valid cases

| Scenario | Behaviour |
|---|---|
| `{ changeEntries: [], nextSkip: 0, nextTop: 0 }` | Accepted; terminates with zero entries |
| `{ changeEntries: [x], nextSkip: 100, nextTop: 2000 }` | Accepted; continues to next page |
| `{ changeEntries: [x], nextSkip: 100, nextTop: 2000 }` (second call same cursor) | `seenCursors` throws |
| `{}` (no fields) | `changeEntries` guard throws |
| `{ changeEntries: null }` | `changeEntries` guard throws |
| `{ changeEntries: [], nextSkip: null, nextTop: null }` | Pagination guard throws |
| `{ changeEntries: [], nextSkip: "100", nextTop: "2000" }` | Pagination guard throws |
| `{ changeEntries: [], nextSkip: -1, nextTop: 2000 }` | Pagination guard throws |

### Sibling capability isolation

`pagedIterationChanges` throws into the `capture` wrapper at the call site. `capture` converts the error to an `incomplete(error)` record. `downgradeMalformedCapabilities` handles capability-level failures in isolation, so identity, metadata, snapshot, workItems, policies, iterations, and existingThreads are unaffected.

### Scope

No changes to `assertCapabilityData`, `downgradeMalformedCapabilities`, `pagedPolicyEvaluations`, or any other function. No dependency changes.

---

## Tests

New unit tests in `tests/azure-access.test.mjs`:

1. **Missing `changeEntries` field** — `pagedIterationChanges` rejects a page missing the field.
2. **Non-array `changeEntries`** — rejects a page where `changeEntries` is `null`.
3. **Null pagination fields** — rejects `{ changeEntries: [], nextSkip: null, nextTop: null }`.
4. **String pagination fields** — rejects `{ changeEntries: [], nextSkip: "100", nextTop: "2000" }`.
5. **Negative pagination field** — rejects `{ changeEntries: [], nextSkip: -1, nextTop: 2000 }`.
6. **Valid empty first page** — `pagedIterationChanges` accepts `{ changeEntries: [], nextSkip: 0, nextTop: 0 }` and returns a complete result with zero entries.
7. **Sibling capabilities preserved** — full `collectAzureDevOpsRest` test where the changes endpoint returns a page without `changeEntries`: `changes` becomes incomplete/malformed while all other capabilities remain complete.

---

## Definition of done

- Every iteration-change page must contain a `changeEntries` array.
- Pagination fields must be finite non-negative integers; absent/null/string values fail closed.
- Valid empty change pages (all fields present and valid, `changeEntries: []`, both pagination fields 0) are accepted.
- Multi-page and cycle detection behaviour is unchanged.
- Node ≥18 built-ins only; no dependencies or version bump.
- All new and existing tests pass; `npm run validate` passes; `git diff --check` clean.
