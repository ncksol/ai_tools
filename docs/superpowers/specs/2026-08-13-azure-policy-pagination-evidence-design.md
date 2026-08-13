# Azure DevOps policy-evaluation completeness evidence

- **Date:** 2026-08-13
- **Status:** Approved (design); implementation pending
- **Target:** `ghcp/plugins/pr-review-graph`
- **Origin:** PR #4 review finding 5 (partially accepted)

## 1. Problem statement

Finding 5 on PR #4 flagged that `workItems`, `policies`, `iterations`, and `existingThreads`
prove only array shape (`assertCapabilityData` in `assemble-azure-context.mjs`), not whether a
potentially paginated source was exhausted. A first-page-only result can be marked `complete`
and become authoritative, weakening requirements, policy reporting, or thread deduplication.

The finding, read literally, treats all four capabilities as equally at risk. They are not.

## 2. What is actually truncatable

Checked against the Azure DevOps REST reference (`api-version=7.1`):

| Capability | Endpoint | Continuation parameters | Truncatable? |
| --- | --- | --- | --- |
| `workItems` | `GET .../pullRequests/{id}/workitems` | none documented | No — single call returns the full set |
| `iterations` | `GET .../pullRequests/{id}/iterations` | none documented | No — single call returns the full set |
| `existingThreads` | `GET .../pullRequests/{id}/threads` | none documented | No — single call returns the full set |
| `policies` | `GET .../policy/evaluations` | `$top` / `$skip` | **Yes** — `collect-azure-devops-rest.mjs` already loops this with its own `pagedPolicyEvaluations` cursor |
| `changes` | `GET .../iterations/{id}/changes` | `$top` / `$skip`, server-echoed `nextSkip`/`nextTop` | **Yes** — already fixed: `assertCapabilityData` rejects `changes` unless `nextSkip === 0 && nextTop === 0` |

`workItems`, `iterations`, and `existingThreads` have no protocol-level continuation
mechanism for a single pull request. Requiring pagination evidence for them would be
artificial machinery with nothing real to attest to, and would risk rejecting genuine
single-call results (including empty ones) that are already fully enumerated by definition.
Finding 5 is valid only for `policies`; `changes` already carries evidence.

## 3. Evidence contract

Mirror the existing `changes` pattern: embed real, adapter-computed completeness evidence in
the capability's `data`, and check it in `assertCapabilityData`. No schema change is needed —
`capability.data` is already unconstrained JSON (`azure-access-fragment.schema.json` §`$defs.capability`),
consistent with how `changes`'s `nextSkip`/`nextTop` check works today without a schema addition.

- `policies` capability data becomes `{ value: PolicyEvaluation[], exhausted: true }`.
  - `exhausted` must be the literal boolean `true`. Absent, `false`, or any other value fails
    validation — there is no partial-but-complete state.
  - `pagedPolicyEvaluations` in `collect-azure-devops-rest.mjs` already knows the real signal
    (`items.length < top` on the final page); it now reports that signal instead of discarding
    it.
  - The Azure CLI fast path (`fragmentFromRawDirectory`) delegates to `az repos pr policy
    list`, a vendor-maintained command with no partial-list mode — it always returns the
    complete evaluation set for the PR. Its output is wrapped as `{ value: asArray(raw.policies),
    exhausted: true }`, consistent with the existing `AUTHORITATIVE_ADAPTERS` trust rank
    already given to `azure-cli`/`azure-rest` elsewhere in the assembler.
  - Any other adapter (Bluebird, hand-transcribed, future MCP tool) that reports `policies`
    complete without `exhausted: true` fails `assertCapabilityData` and is downgraded to a
    `malformed` failure by the existing `downgradeMalformedCapabilities` — it does not
    discard sibling capabilities in the same fragment, and does not silently accept unproven
    completeness. This is the fail-closed behavior finding 5 asks for, scoped to the one
    capability that can actually be partial.
- `workItems`, `iterations`, `existingThreads`: **no change**. They keep today's
  array-or-`{value}` shape check. An empty array remains valid evidence of a successfully
  enumerated empty result, because the endpoint itself cannot return anything other than the
  complete set.

## 4. Non-goals

- No generic "pagination evidence" field added to the JSON schema or applied uniformly across
  capabilities — that would be exactly the artificial machinery the reviewer warned against.
- No retry/cursor logic changes for `changes` (already correct) or for `pagedPolicyEvaluations`'s
  existing cycle detection (already correct) — only the shape of the accepted result changes.
- No change to `workItems`, `iterations`, `existingThreads` collection code paths.

## 5. Test coverage (`tests/azure-access.test.mjs`)

1. **Complete empty**: `policies` fragment `{ value: [], exhausted: true }` is accepted;
   packet `checks` is `[]`.
2. **Exhausted pages**: `pagedPolicyEvaluations` returns `exhausted: true` after a genuine
   multi-page fetch (a full 100-item page followed by a short page) alongside the existing
   cycle-detection test.
3. **Missing evidence**: a `policies` fragment reporting `complete: true` with a bare array
   (no `exhausted` field) is downgraded to `malformed`/incomplete by
   `downgradeMalformedCapabilities`, and fails the read gate when no other source supplies it.
4. Existing fixtures/tests that build `policies` fragments from `raw.policies` (a plain array)
   are updated to the new `{ value, exhausted: true }` shape so they continue to model a
   genuinely authoritative result.
5. `fragmentFromRawDirectory` is exercised directly against a fixture raw directory to confirm
   CLI-collected `policies` carries `exhausted: true`.

## 6. Compatibility

- No new dependencies.
- `collect-azure-devops.sh` is unchanged (Bash 3.2 compatible as-is); only the `.mjs` files
  change.
- Plugin/marketplace version stays `0.3.0` — this is a bug fix within the already-shipped
  design, not a new capability.
