# Azure fragment assembly: tolerate one malformed optional fragment

- **Date:** 2026-08-13
- **Status:** Approved (design); implementation pending
- **Target:** `ghcp/plugins/pr-review-graph`
- **Parent design:** `docs/superpowers/specs/2026-08-12-azdo-pr-access-design.md`
- **Source:** Issue 1 from the review of GitHub PR `ncksol/ai_tools#4`

## 1. Problem statement

`assembleAzureFragments` in `assemble-azure-context.mjs` validates every input fragment
up front with `inputFragments.map(validateAzureFragment)`. `validateAzureFragment` throws
on the first malformed capability it finds. Because the `.map()` call is eager, a single
malformed capability in *any* fragment — including an optional, hand-transcribed Bluebird
or other MCP fragment — throws out of `assembleAzureFragments` entirely, before the
function ever reaches capability selection.

This means a malformed optional fragment aborts the whole assembly even when the Azure
CLI, Azure REST, and local Git adapters already produced a complete, valid packet. That
contradicts the parent design's error-handling table (section 8): "Malformed or ambiguous
output → Reject the fragment and continue," and its capability-composition rule 3: "never
replace a complete result with a partial one."

The codebase already has the right primitive for this: `downgradeMalformedCapabilities`,
which validates each capability in a fragment independently and downgrades only the
malformed ones to an incomplete/`malformed` failure, preserving the fragment's other valid
capabilities. It is already used by `collectAzureDevOpsRest` to self-sanitize its own
output before constructing a fragment. It is *not* applied to fragments handed to
`assembleAzureFragments` — which is exactly where hand-authored MCP fragments (e.g.
`bluebird.json`, built by the agent from the reference doc's example, not through any
validating helper) enter the system.

## 2. Goals

1. A malformed capability inside one fragment must not discard that fragment's other
   valid capabilities, and must not stop other fragments from contributing.
2. A fragment so structurally broken it cannot be sanitized (missing `schemaVersion`,
   missing `source` fields, or no capabilities at all) must be dropped on its own, not
   abort assembly of the remaining fragments.
3. Downgraded/dropped fragments must still be visible in diagnostics (the existing
   attempt ledger, plus a small rejected-fragment list) so a real read-gate failure still
   reports what happened, per the parent design's reporting goal.
4. No change to: immutable-identity conflict detection (still stops acquisition
   immediately), capability selection/authority ordering, pagination-completeness checks,
   or the public shape of a complete packet.

## 3. Non-goals

- No change to `validateAzureFragment`'s strict behavior when called directly (it is
  still used by the CLI's `directory`/`capability`/`failure` modes and by existing tests
  that intentionally exercise its strict throw behavior).
- No change to `downgradeMalformedCapabilities` itself; it is reused as-is.
- No new dependencies, no schema changes to `azure-access-fragment.schema.json` (a
  downgraded capability already conforms to the existing capability schema).
- No change to plugin version; stays at `0.3.0` per this task's constraints (this is a
  fix to already-unreleased-as-shipped behavior within the same version, not a new
  feature).

## 4. Approaches considered

**A. Sanitize each fragment's capabilities before validating it, inside
`assembleAzureFragments` (recommended).** Reuse `downgradeMalformedCapabilities` on every
input fragment's `capabilities` object before calling `validateAzureFragment` on it, and
wrap that per-fragment step in a `try`/`catch` so a fragment whose *envelope* is broken
(not just one capability) is dropped rather than thrown. This mirrors the exact pattern
`collectAzureDevOpsRest` already uses, applied uniformly to every fragment source
including hand-authored ones. Malformed capabilities become ordinary incomplete
capabilities and flow through the existing selection/attempt-ledger machinery unchanged.

**B. Require every fragment producer to pre-sanitize itself.** Push the
`downgradeMalformedCapabilities` call out to each producer (REST collector, a new
Bluebird-fragment-building helper, etc.) instead of centralizing it in the assembler.
Rejected: hand-authored fragments (Bluebird, other optional MCP tools) have no code path
today — the agent writes JSON directly per the reference doc's example — so this would
require inventing a new script/step for every future optional adapter, duplicating logic
the assembler already centralizes.

**C. Wrap only the top-level `.map()` in `try`/`catch` and drop the whole fragment on any
error, without per-capability downgrading.** Rejected: a fragment with one malformed
capability among several valid ones would lose all of them, not just the bad one. This
fails the task's requirement to "preserve valid capabilities where the chosen design
safely permits it" and regresses the guarantee `downgradeMalformedCapabilities` already
provides for REST fragments.

Recommendation: **A**. It is the smallest change, reuses tested code, and treats every
adapter (authoritative or hand-transcribed) the same way.

## 5. Design

### 5.1 Per-fragment sanitize-then-validate

In `assembleAzureFragments`, replace the eager `inputFragments.map(validateAzureFragment)`
with a loop that, per input fragment:

1. Coerces `capabilities` to a plain object (empty object if missing/not an object).
2. Runs `downgradeMalformedCapabilities` over it, turning any capability that fails
   `assertCapabilityShape`/`assertCapabilityData` into `{ complete: false, failure:
   { category: 'malformed', message } }` instead of throwing — exactly as
   `collectAzureDevOpsRest` already does for its own output.
3. Calls `validateAzureFragment` on the sanitized fragment. This now only throws for
   envelope-level problems the capability downgrade can't fix: bad `schemaVersion`,
   missing `source.adapter`/`credentialContext`/`capturedAt`, or zero capabilities.
4. If that throws, the fragment is dropped: its `source` (if present) and a sanitized
   `malformed` failure message are recorded in a `rejectedFragments` list, and the loop
   continues with the next fragment. Nothing further in the function throws because of it.

Fragments that survive sanitization (whether or not some of their capabilities were
downgraded) proceed through the existing `assertImmutableAgreement`, per-capability
candidate selection, authority ordering, and completeness-gate logic unchanged. A
capability downgraded to `malformed` behaves exactly like any other incomplete capability:
it is absent from `candidates`, appears in `attempts` with `complete: false`, and — if no
other fragment supplies that capability — makes the packet's overall read gate fail with
the existing "Incomplete Azure DevOps context" error, whose blocker list already includes
the malformed message. This is unchanged from today's behavior for a truly missing
capability; the only change is that *other, still-complete* capabilities and fragments are
no longer collateral damage.

### 5.2 Diagnostics for dropped fragments

`packet.providerData.access` gains an optional `rejectedFragments` array (present only
when non-empty), each entry `{ source, failure: { category: 'malformed', message } }`,
mirroring the shape already used for capability failures. This lets the sanitized
attempt-ledger reporting mentioned in the parent design's SKILL.md guidance ("show its
sanitized attempt ledger and stop before agent dispatch") surface an envelope-level drop,
not just capability-level ones.

### 5.3 Documentation touch-up

`azure-devops-cli-provider.md` section 6 gets one clarifying sentence: a malformed
hand-transcribed fragment (e.g. a broken `bluebird.json`) has its bad capability
downgraded to a normal incomplete/`malformed` entry rather than aborting assembly of the
other fragments passed to `packet` mode.

## 6. Testing

Two new regression tests in `tests/azure-access.test.mjs`:

1. A Bluebird-like fragment with one structurally malformed capability (e.g. `identity`
   missing `pullRequestId`) alongside complete REST and local-Git fragments still produces
   a complete packet; the malformed capability is downgraded, its valid sibling capability
   in the same fragment (e.g. `metadata`) is still selected from that fragment, and the
   attempt ledger records the malformed failure.
2. A wholly malformed fragment (no `capabilities` object at all, or missing
   `schemaVersion`) alongside otherwise-complete fragments does not throw; assembly
   succeeds using the other fragments, and the malformed fragment appears in
   `packet.providerData.access.rejectedFragments`.

Existing tests are re-run unchanged to confirm no regression, in particular:
- the pagination/immutable-agreement tests that rely on `assembleAzureFragments` still
  throwing for genuine completeness/conflict failures;
- `collectAzureDevOpsRest`'s own malformed-capability downgrade test.

## 7. Acceptance criteria

1. A malformed optional Bluebird/MCP capability no longer aborts assembly when Azure
   REST/CLI and Git fragments are complete.
2. Valid capabilities in the same fragment as a malformed one are still used.
3. A structurally broken fragment is dropped, not fatal, and is visible in diagnostics.
4. Immutable-identity conflicts and pagination-incompleteness still fail closed exactly as
   before.
5. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
