# Design: Validate Fragment `capturedAt` Timestamps

**Date:** 2026-08-13  
**Status:** Approved  
**Scope:** `ghcp/plugins/pr-review-graph`

---

## Problem

`validateAzureFragment` uses `String(value ?? '').trim()` to check all three required source
fields — `adapter`, `credentialContext`, and `capturedAt` — for non-emptiness. This coercion
converts any non-null value to a string before checking, so a numeric `capturedAt` such as `42`
passes the check unchanged (because `String(42).trim()` is the non-empty string `"42"`).

A fragment carrying `capturedAt: 42` then enters `assembleAzureFragments` with a number in
`source.capturedAt`. When two candidates for the same capability have equal adapter authority,
the comparator calls `left.source.capturedAt.localeCompare(right.source.capturedAt)`. Numbers
do not have a `localeCompare` method, so the comparator throws a `TypeError` instead of
selecting the better candidate or rejecting the malformed fragment.

The JSON schema (`azure-access-fragment.schema.json`) already correctly declares `capturedAt` as
`{ "type": "string", "format": "date-time" }`. The runtime validation does not match.

---

## Design

### Single change point: `validateAzureFragment`

After the existing required-field loop that checks all three source keys for non-emptiness, add
a dedicated type-and-format check for `capturedAt`:

```js
const capturedAt = fragment.source?.capturedAt;
if (typeof capturedAt !== 'string' || isNaN(Date.parse(capturedAt))) {
  throw new Error('Azure access fragment source.capturedAt must be a valid ISO date-time string');
}
```

**Why here:** `validateAzureFragment` is the single gate used by both `sanitizeAzureFragment`
(which converts errors to malformed-fragment rejections) and by the CLI modes that construct
fragments programmatically. Strengthening this function enforces the contract at the only place
it needs to be enforced.

**The existing loop is left intact** for `adapter` and `credentialContext` — they are string
fields but do not require date-format validation. The new check is additive, not a replacement.

**Rejection path:** `sanitizeAzureFragment` wraps `validateAzureFragment` in a try-catch and
converts any thrown error to a malformed fragment entry in `rejectedFragments`. A fragment with
a bad `capturedAt` therefore does not abort assembly of other complete sources — it is silently
downgraded and excluded, with the rejection visible in `packet.providerData.access.rejectedFragments`.

### What does not change

- **Sort comparator** (`assembleAzureFragments` line 247): safe by construction — fragments that
  reach selection have already passed validation, so `source.capturedAt` is guaranteed to be a
  valid ISO string when `localeCompare` is called.
- **JSON schema** (`azure-access-fragment.schema.json`): already correct; no changes.
- **CLI modes** (`directory`, `capability`, `failure`, `packet`): all set `capturedAt` via
  `new Date().toISOString()` which always produces a valid string. No changes needed.
- **`fragmentFromRawDirectory`**: passes `source.capturedAt ?? new Date().toISOString()` so the
  only way to inject a bad value is via the `source` argument, which is validated immediately
  when the returned fragment is passed to `validateAzureFragment`.

---

## Tests

All tests go in `tests/azure-access.test.mjs`, grouped under a new `capturedAt` section.

| Scenario | Expected outcome |
|---|---|
| `capturedAt` is a number (`42`) | `validateAzureFragment` throws `…valid ISO date-time string` |
| `capturedAt` is empty string (`""`) | existing loop throws `…capturedAt is required` |
| `capturedAt` is an invalid date string (`"not-a-date"`) | `validateAzureFragment` throws `…valid ISO date-time string` |
| `capturedAt` is a valid ISO instant | passes without throwing |
| Assembly: one fragment has `capturedAt: 42`, others provide all capabilities | packet assembles; bad fragment in `rejectedFragments` |
| Equal-authority tie-break: two candidates with valid `capturedAt` at different times | later timestamp wins; no `TypeError` |

The equal-authority tie-break test is the regression test for the original crash (confirming the
sort reaches its result rather than throwing).

---

## Definition of Done

- `source.capturedAt` must be a `string` containing a valid RFC 3339 / ISO 8601 instant
  parseable by `Date.parse`.
- Fragments with invalid `capturedAt` are rejected through `sanitizeAzureFragment` and appear
  in `rejectedFragments` without aborting assembly of other complete sources.
- The sort comparator in `assembleAzureFragments` cannot receive an unvalidated `capturedAt`.
- JSON schema, runtime validation, and tests all agree on the `string` + `date-time` contract.
- All tests listed above pass.
- Node >=18 built-ins only (`typeof`, `Date.parse`); no dependency changes.
- No unrelated refactoring.
