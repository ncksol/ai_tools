# Reject malformed Azure REST responses

**Status:** approved  
**Scope:** `ghcp/plugins/pr-review-graph`

## Problem

`asValue()` in `collect-azure-devops-rest.mjs` returns `[]` for any response shape it does not recognise. It is called in three places:

| Call site | Capability |
|-----------|------------|
| `pagedPolicyEvaluations` – per-page extraction | `policies` |
| `workItems` capture – linked-item refs | `workItems` |
| `changes` capture – iteration-list extraction | `changes` |

A malformed provider response (e.g. `{ unexpected: true }`) passes through `asValue` as `[]`, and `capture()` stores `complete([])`. Because `assertCapabilityData` accepts an empty array as valid, the capability appears successful downstream. Consumers see "no work items" or "no policy checks" and cannot distinguish that from a correctly empty collection.

## Requirements

- `[]` and `{ value: [] }` remain valid, complete, empty enumerations.
- Any other shape is malformed; the affected capability must be `complete: false` with `category: 'malformed'`.
- Independent capabilities continue to be collected and returned as `complete`.
- No response bodies are exposed in error messages.
- No new dependencies; Node ≥ 18 built-ins only.
- Plugin version stays at 0.3.0.

## Design

### `requireValueArray(value, context)` replaces `asValue`

```javascript
function requireValueArray(value, context) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.value)) return value.value;
  throw accessError('malformed', `unexpected ${context} response shape`);
}
```

The error is thrown inside the `async` lambda passed to `capture()`, which already catches all errors and records `incomplete(error)` for the affected capability. Other capability captures are unaffected.

### Call site changes

| Location | Before | After |
|----------|--------|-------|
| `pagedPolicyEvaluations` line 56 | `asValue(page)` | `requireValueArray(page, 'policy evaluations page')` |
| `workItems` capture line 267 | `asValue(await get(...))` | `requireValueArray(await get(...), 'linked work items')` |
| `changes` capture line 287 | `asValue(iterations)` | `requireValueArray(iterations, 'iteration list')` |

The `changes` call site is inside `capture()`, so a throw marks only `changes` as incomplete. `capabilities.iterations.complete` is checked before entering this path, so the only reachable malformed case is a response shape that satisfied `assertCapabilityData` but wasn't an array or `{value:[]}` — effectively impossible in practice, but correct to guard.

## Tests

Two new integration-style tests in `tests/azure-access.test.mjs`, using the existing `collectAzureDevOpsRest` + `fetchImpl` pattern:

1. **Malformed work-item list** — `/workitems?` returns `{ unexpected: true }`.  
   Assert: `workItems` incomplete with `category='malformed'`; `policies`, `iterations`, `changes`, `existingThreads` all complete.

2. **Malformed policy-evaluations page** — policy evaluations endpoint returns `{ unexpected: true }`.  
   Assert: `policies` incomplete with `category='malformed'`; `workItems`, `iterations`, `changes`, `existingThreads` all complete.

The existing test "enumerated empty Azure collections are complete rather than missing" already covers valid-empty behaviour; it must continue to pass unchanged.
