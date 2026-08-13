# Bind Azure DevOps diff fragments to repository and snapshot identity

- **Date:** 2026-08-13
- **Status:** Approved (design); implementation pending
- **Target:** `ghcp/plugins/pr-review-graph`
- **Source:** Reviewer finding (High) on PR ncksol/ai_tools#4, issue 3 of the review
- **Parent design:** `docs/superpowers/specs/2026-08-12-azdo-pr-access-design.md`

## 1. Problem statement

The Azure DevOps access-fragment assembler (`assemble-azure-context.mjs`) treats the `diff`
capability's `data` as a bare string. `assertCapabilityData('diff', …)` only checks
`typeof data === 'string'` (line 78). `assertImmutableAgreement` (lines 86-120) cross-checks
`identity` and `snapshot` fragments for conflicting repository, project, and base/head SHA
values, but never inspects `diff` fragments.

A diff fragment therefore carries no logical relationship to the repository or exact
base/head commits it claims to represent. A stale, mismatched, or unrelated patch — from
another PR, another repository, or a fetch that raced ahead of the recorded snapshot — passes
shape validation unchanged and can be assembled with an agreed identity/snapshot pair,
producing a packet that is reviewed as if the patch were authoritative for that exact
base..head range.

## 2. Goal

A `diff` capability fragment must self-declare the repository and exact base/head commit it
was generated from. The assembler must reject, before `normalize()` runs:

1. a `diff` fragment missing this declaration (shape validation), and
2. a `diff` fragment whose declared repository/base/head disagrees with any other complete
   fragment's declared identity or snapshot (cross-fragment agreement), regardless of which
   fragment is ultimately selected for each capability.

## 3. Non-goals

- No change to the separate "conflicting organization" finding (identity/snapshot agreement
  already omits organization; that remains a distinct, unaddressed finding).
- No change to pagination-cycle detection, malformed-capability downgrade scoping, or any
  other issue raised in the same review batch.
- No new required capability, no change to the nine-capability completeness gate, no version
  bump (plugin stays at `0.3.0`).
- No cryptographic signing. The system has no adapter that mints a real signature; the only
  available trust signal is cross-fragment agreement on provider-reported identifiers, which
  is what `identity`/`snapshot` already rely on.

## 4. Approach

Extend the `diff` capability's `data` to an object, following the same self-declaring pattern
already used by `identity` and `snapshot`:

```json
{
  "repository": { "id": "…", "name": "…", "project": { "id": "…", "name": "…" } },
  "baseSha": "<target/base commit id the diff was generated from>",
  "headSha": "<source/head commit id the diff was generated from>",
  "patch": "<unified diff text>"
}
```

### 4.1 Shape validation

`assertCapabilityData('diff', …)` requires:

- a non-empty repository id or name;
- a non-empty project id or name;
- a non-empty `baseSha`;
- a non-empty `headSha`;
- a string `patch` (may be empty, matching today's "no changes" behavior).

A `diff` fragment missing any of these fails shape validation exactly like a malformed
`identity`/`snapshot` fragment does today (rejected fragment, `malformed` failure category
when reached through `downgradeMalformedCapabilities`).

### 4.2 Cross-fragment agreement

`assertImmutableAgreement` folds a complete `diff` fragment's `repository.id`,
`repository.name`, `project.id`, `project.name`, `headSha`, and `baseSha` into the *same*
`agree()` ledger already populated by `identity` and `snapshot` fragments, using the exact
same keys (`repository.id`, `repository.name`, `project.id`, `project.name`, `head`, `base`).
No new comparison logic is introduced — a diff fragment's declared identity is simply another
voter in the existing ledger, so any mismatch against *any* other complete fragment (not only
the one ultimately selected) throws `Conflicting Azure PR identity` / `Conflicting Azure head
SHA` / `Conflicting Azure base SHA` before selection or normalization.

### 4.3 Assembly read sites

Two existing read sites in `assembleAzureFragments` treat `selected.diff.capability.data` as
the raw string; both switch to `.patch`:

- the "diff is empty for a non-empty change list" completeness check;
- the final `raw.diff` field passed into `normalize()`.

### 4.4 Producers

- **CLI fast path** (`fragmentFromRawDirectory`, used by `collect-azure-devops.sh`): builds
  the bound diff object directly from the already-loaded `pr` object (`pr.repository`,
  `pr.lastMergeTargetCommit.commitId`, `pr.lastMergeSourceCommit.commitId`). No changes to
  `collect-azure-devops.sh` are required — the identity and SHA data it already collects is
  simply reused when the fragment is composed.
- **Standalone `capability diff` CLI mode** (used by the REST + local-git path documented in
  `azure-devops-cli-provider.md` §5, where the Git diff is captured independently of the CLI
  fast path): gains a dedicated argument shape, since it must supply the repository object
  and exact base/head SHAs alongside the patch file:

  ```
  assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> diff \
    <REPOSITORY_JSON> <BASE_SHA> <HEAD_SHA> <DIFF_PATCH> <FRAGMENT_JSON>
  ```

  All other capabilities keep the existing `capability <ADAPTER> <CREDENTIAL_CONTEXT>
  <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>` shape unchanged.

### 4.5 Documentation

- `azure-access-fragment.schema.json` gains a `diffCapability` definition (an `allOf` over the
  existing generic `capability` definition) that requires `repository`, `baseSha`, `headSha`,
  and `patch` on `data` when `complete: true`. This is documentation-grade — nothing in the
  codebase runs fragments through this schema at runtime (`validate-plugin.mjs` only checks
  the file parses as JSON) — but it must stay accurate since it is the canonical reference for
  the fragment contract.
- `azure-devops-cli-provider.md` §5 ("Git diff fragment") is updated to show writing the
  repository object already known from the identity fragment to
  `<WORK_DIR>/repository.json` and passing the exact `target_sha`/`source_sha` used to
  generate the patch into the new invocation shape.

## 5. Rejected alternative

**A separate `diffProvenance` capability** that must independently corroborate `diff` (10th
required capability, repository + baseSha + headSha only, no patch). Rejected because it
inflates the required-capability count and the "all nine capabilities" language embedded in
`SKILL.md`, `azure-devops-cli-provider.md`, and `validate-plugin.mjs`'s completeness checks,
for a capability that is conceptually part of `diff`, not independent PR context. It also
delivers no additional assurance over binding the fields directly onto `diff`: neither
approach involves a real cryptographic signature, so both rely on the identical cross-fragment
SHA/repository agreement mechanism already in place for `identity`/`snapshot`.

## 6. Test strategy

Extend `tests/azure-access.test.mjs`:

1. Update the existing `local-git` diff fixture fragment to the new bound-object shape so the
   existing composition/provenance test keeps passing.
2. **Positive:** a diff fragment whose `repository`/`baseSha`/`headSha` agree with the
   `identity`/`snapshot` fragments composes into a packet whose `diff` equals the patch text.
3. **Mismatch — different repository:** a diff fragment declaring a different repository id
   than the identity fragment throws `Conflicting Azure PR identity`.
4. **Mismatch — different head/base SHA:** a diff fragment declaring a `headSha` (or
   `baseSha`) that disagrees with the snapshot fragment throws `Conflicting Azure head SHA` (or
   `Conflicting Azure base SHA`).
5. **Shape validation:** a diff fragment missing `repository`, `baseSha`, or `headSha` fails
   capability shape validation (`assertCapabilityShape`/`downgradeMalformedCapabilities`
   downgrades it to a malformed failure rather than accepting a bare string).

All tests remain offline and deterministic, consistent with the existing suite.

## 7. Acceptance criteria

1. A `diff` fragment without repository/base/head binding is rejected before normalization.
2. A `diff` fragment whose declared repository/base/head conflicts with any other complete
   fragment's declared identity/snapshot is rejected before normalization, with the same
   `Conflicting Azure …` error family already used for identity/snapshot conflicts.
3. The CLI fast path (`collect-azure-devops.sh`) requires no changes and continues to produce
   a valid, bound diff fragment.
4. The standalone local-git diff capability invocation documented in
   `azure-devops-cli-provider.md` supplies the same binding.
5. Existing behavior — provenance tracking, authority ordering, empty-diff-for-nonempty-change
   detection, Bash 3.2 compatibility, no new dependencies, plugin version `0.3.0` — is
   unchanged.
6. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
