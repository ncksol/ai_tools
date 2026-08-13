# Azure pagination cycle detection — full-history guard

- **Date:** 2026-08-13
- **Status:** Approved (autopilot mode; creator-approved scope)
- **Target:** `ghcp/plugins/pr-review-graph`
- **PR:** ncksol/ai_tools#4, issue 2

## 1. Problem

`pagedIterationChanges` and `pagedPolicyEvaluations` in
`collect-azure-devops-rest.mjs` each track only the immediately previous
cursor or page signature. A multi-step cycle such as A→B→A is undetectable:

| Step | cursor returned | seenCursor | comparison | outcome |
| ---- | --------------- | ---------- | ---------- | ------- |
| 1    | A               | null       | null ≠ A   | store A, continue |
| 2    | B               | A          | A ≠ B      | store B, continue |
| 3    | A               | B          | B ≠ A      | store A, **loop** |

The loop is unbounded. Any server that alternates two distinct pages or
cursors will cause the collector to run indefinitely.

## 2. Goals

1. Terminate on any pagination cycle, not only an immediately repeated value.
2. Keep the change surgical: no new abstractions, no scope creep.
3. Preserve all existing error categories and messages.

## 3. Non-goals

- No changes to retry logic, HTTP error handling, or any other function.
- No version bump (plugin stays at 0.3.0).

## 4. Design

Replace the single-value guard variable in each function with a `Set` that
accumulates every observed cursor/signature. Any re-entry is a cycle.

### `pagedIterationChanges`

Before:
```js
let seenCursor = null;
// ...
if (cursor === seenCursor) { throw ... }
seenCursor = cursor;
```

After:
```js
const seenCursors = new Set();
// ...
if (seenCursors.has(cursor)) { throw ... }
seenCursors.add(cursor);
```

### `pagedPolicyEvaluations`

Before:
```js
let seenPage = null;
// ...
if (signature === seenPage) { throw ... }
seenPage = signature;
```

After:
```js
const seenPages = new Set();
// ...
if (seenPages.has(signature)) { throw ... }
seenPages.add(signature);
```

Error messages remain unchanged so existing test assertions pass.

## 5. Tests

Two new regression tests in `tests/azure-access.test.mjs`:

1. **Multi-step iteration-change cycle** — `get` returns cursor A, then B, then A again.
   Asserts `pagedIterationChanges` rejects with the existing error message on the
   third call (not the second as in a direct-repeat test).

2. **Multi-step policy-evaluation cycle** — `get` returns two distinct 100-item pages
   alternately. Asserts `pagedPolicyEvaluations` rejects on the third call.

## 6. Acceptance criteria

1. The existing two cycle-detection tests still pass.
2. The two new multi-step cycle tests pass.
3. `npm test` passes from `ghcp/plugins/pr-review-graph`.
4. Plugin version stays at 0.3.0.
