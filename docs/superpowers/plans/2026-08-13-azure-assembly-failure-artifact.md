# Azure assembly failure artifact — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Write the test first for each task, watch it fail for the right reason, then implement.

**Goal:** Make every failed `packet` or `directory` assembly in `assemble-azure-context.mjs` replace `<PACKET_JSON>` with a sanitized, machine-readable failure artifact, so a stale successful packet or an outdated artifact can never be read as the result of the assembly that just failed.

**Architecture:** Tag each known throw site inside `assembleAzureFragments` with a sanitized `error.assembly = { category, reason, message, diagnostics }`. Wrap both packet-producing CLI modes in `assembleAndWrite`, which writes the packet on success and a failure artifact built from `classifyFailure(error)` on any error, then rethrows so stderr and exit code 1 are unchanged. Sanitize by construction: never persist a message this module did not build, and project every `source`/`failure` object to its known fields.

**Tech Stack:** Node.js ≥ 18 (no new dependencies), `node:test` + `node:assert/strict`.

## Global Constraints

- A successful packet stays byte-identical: no projection, no new keys, no reordering.
- `capability` and `failure` fragment-emission modes are untouched.
- `error.message` at every existing throw site is unchanged — existing tests match on it.
- Usage errors happen before the output path is known and must write nothing.
- No raw fragment data, capability data, response bodies, credentials, or tokens in the artifact.
- stderr output and exit code 1 are unchanged.
- No new dependencies. Plugin stays at version `0.2.0` (no bump).
- Scope is this finding only.

---

### Task 1: Tag assembly failures with sanitized structured diagnostics

**Files:**
- Modify: `skills/review-pull-request/scripts/assemble-azure-context.mjs` (`assertImmutableAgreement`, `assembleAzureFragments`)

**Steps:**
- [ ] Add `assemblyError(category, reason, message, diagnostics)` returning an `Error` whose `message` is the caller's text and whose `assembly` property holds the sanitized record.
- [ ] Route `assertImmutableAgreement`'s four throws through it as `conflict` / `identity-conflict`, preserving the exact existing messages. Pass `rejectedFragments` in.
- [ ] Route the missing-capability throw through it as `incomplete` / `missing-capabilities`, with `missing`, `selected`, `attempts`, `rejectedFragments`; keep `error.attempts` for backward compatibility and keep the existing multi-line `error.message`, using only its first line for the artifact.
- [ ] Route the empty-diff throw through it as `conflict` / `empty-diff` with `selected`, `attempts`, `rejectedFragments`.

**Verify:** existing `npm test` suite still passes — every current `assert.throws` message regex is unaffected.

---

### Task 2: Build and write the failure artifact

**Files:**
- Modify: `skills/review-pull-request/scripts/assemble-azure-context.mjs`
- Modify: `tests/azure-access.test.mjs`

**Steps:**
- [ ] Add `projectSource` and `projectFailure` helpers that keep exactly `{ adapter, credentialContext, capturedAt }` and `{ category, message }`.
- [ ] Add `classifyFailure(error)` returning `error.assembly` when present, else the fixed `unexpected` / `unexpected-error` record with a message this module owns.
- [ ] Add `buildFailureArtifact(error)` producing the spec's shape, omitting absent diagnostics keys and newline-stripping every message.
- [ ] Add `writeFailureArtifact(outputPath, error)` that writes it with `writeJson` and swallows its own write error.
- [ ] Add `assembleAndWrite(outputPath, build)`.
- [ ] Export `buildFailureArtifact` for direct unit assertions.

**Verify:** unit tests for `buildFailureArtifact` over a tagged and an untagged error.

---

### Task 3: Route both packet-producing modes through the wrapper

**Files:**
- Modify: `skills/review-pull-request/scripts/assemble-azure-context.mjs` (`main`)
- Modify: `tests/azure-access.test.mjs`

**Steps:**
- [ ] Add `readFragmentFile(p)` that converts any read/parse failure into a tagged `malformed` / `unreadable-fragment` error whose message names the path and a coarse kind (`error.code` or `invalid JSON`) and discards the underlying message.
- [ ] `packet` mode: keep argument validation outside the wrapper; move fragment reading and assembly inside `build`.
- [ ] `directory` mode: same, with `fragmentFromRawDirectory` failures converted to `malformed` / `unreadable-raw-directory`.
- [ ] Keep both success `console.log` lines exactly as they are.

**Verify:** CLI tests 1–8 from the spec, driven with `spawnSync` against a pre-seeded stale packet file.

---

### Task 4: Update the provider contract documentation

**Files:**
- Modify: `skills/review-pull-request/references/azure-devops-cli-provider.md` §6

**Steps:**
- [ ] State that a failed assembly replaces `<PACKET_JSON>` with an `assembled: false` artifact carrying `failure.category`, `failure.reason`, `failure.message` and available diagnostics, and that this is the file to read and report before stopping.

**Verify:** `npm run validate` passes.

---

### Task 5: Full validation

**Steps:**
- [ ] `npm test` from the plugin directory.
- [ ] `npm run validate` from the plugin directory.
- [ ] `node --check` on every modified script.
- [ ] `git diff --check`.
- [ ] Commit without any `Co-authored-by` or AI attribution trailer.
