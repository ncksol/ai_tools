# Design: Azure organization in identity agreement check

**Date:** 2026-08-13  
**Status:** approved  
**Files:** `assemble-azure-context.mjs`, `normalize-context.mjs`, `azure-access.test.mjs`

---

## Problem

`assertImmutableAgreement` in `assemble-azure-context.mjs` validates that all identity
fragments describe the same PR by comparing PR ID, repository id/name, and project id/name,
plus commit SHAs from snapshot fragments. It does not check the Azure DevOps **organization**.

Two fragments from different organizations can share identical project names, repository
names, PR IDs, and commit SHAs — for example if two orgs each have a repo named `widgets`
inside a project named `Platform` with a PR number 77. Those fragments would pass the
agreement check today and be silently combined into a single context packet referencing
two different PRs.

---

## Design

### Approach

Export the existing `organizationFromUrl` function from `normalize-context.mjs` (it already
handles both `dev.azure.com/<org>` and `<org>.visualstudio.com` URL forms, normalizing them
to the same lowercase org slug). Import it in `assemble-azure-context.mjs` and call it once
inside the `assertImmutableAgreement` identity block.

### Production changes (3 lines)

**`normalize-context.mjs`**
- Add `export` keyword to `organizationFromUrl`.

**`assemble-azure-context.mjs`**
- Import `organizationFromUrl` from `./normalize-context.mjs`.
- In `assertImmutableAgreement`, inside the `if (id?.complete)` block, after the existing
  project/repo `agree` calls:
  ```js
  agree('organization', organizationFromUrl(id.data.url), 'Conflicting Azure organization');
  ```

### Why this is safe

- `agree` skips null/empty values — on-premises or unrecognized URL formats produce `null`
  from `organizationFromUrl` which is skipped via the `?? ''` guard. No false positives.
- `id.data.url` is validated non-empty for all complete identity fragments by
  `assertCapabilityData`. It always carries the full PR web URL which contains the org for
  cloud ADO.
- id-to-id / name-to-name comparison semantics are entirely unchanged; this adds one
  new agreement key that only fires when both sides yield a non-empty org slug.

---

## Tests

Three new tests in `azure-access.test.mjs`:

1. **Same org, both modern URL form** — two identity fragments whose `url` fields both point
   at `dev.azure.com/acme/...` → `assembleAzureFragments` succeeds.

2. **Cross-org conflict** — one identity fragment from `dev.azure.com/acme/...` and another
   from `dev.azure.com/contoso/...` with otherwise identical project/repo/PR data →
   throws `Conflicting Azure organization`.

3. **Equivalent URL forms** — one fragment uses `https://dev.azure.com/acme/...` and a
   second uses `https://acme.visualstudio.com/...` → normalized to the same slug, no
   conflict.

---

## Invariants

- Version stays `0.3.0`.
- No external dependencies added.
- No unrelated refactoring.
