# Surface the sanitized attempt/rejection ledger on incomplete Azure assembly

- **Date:** 2026-08-13
- **Status:** Approved (design); implementation pending
- **Target:** `ghcp/plugins/pr-review-graph`
- **Source:** Reviewer finding (issue 3) on PR ncksol/ai_tools#4, review round 2
- **Parent design:** `docs/superpowers/specs/2026-08-12-azdo-pr-access-design.md`

## 1. Problem statement

`assembleAzureFragments` (`assemble-azure-context.mjs`) builds a full sanitized ledger while it
runs — `attempts` (every capability attempt across every fragment, with source and
complete/failure status) and `rejectedFragments` (structurally broken fragments, source label
plus sanitized category/message). When assembly succeeds, both are written to
`packet.providerData.access`. When a required capability is missing, `assembleAzureFragments`
throws an `Error` carrying only `error.attempts` (line 265); `rejectedFragments` and which
capabilities *did* complete are dropped.

The `packet` CLI mode's top-level handler (`main().catch(error => { console.error(error.message);
process.exitCode = 1; })`, lines 439-442) prints only `error.message`. That message already
embeds the missing-capability list and, per missing capability, its failed attempts — but never
the capabilities that *did* complete, nor `rejectedFragments`.

`azure-devops-cli-provider.md:164` instructs the operator to "show its sanitized attempt ledger
and stop before agent dispatch" when assembly reports missing capabilities, but there is
currently no artifact containing that full ledger on failure — only the partial text embedded in
one thrown message. Design rule 7 in `docs/superpowers/specs/2026-08-12-azdo-pr-access-design.md`
("Report exactly which capabilities and credential contexts succeeded or failed") and §8 ("the
user receives a sanitized capability matrix listing each required operation, satisfied source,
attempted adapters, and blocker") are unmet on the failure path.

## 2. Goal

When assembly cannot complete:

1. `assembleAzureFragments` attaches the complete sanitized ledger to the thrown error as
   structured properties (not just a human-readable message fragment), so programmatic
   consumers can inspect it directly.
2. The `packet` (and `directory`, which shares the same assembly call) CLI modes emit a
   deterministic, machine-readable failure artifact containing that same ledger — successful
   capability sources, every attempt, missing capabilities, and rejected-fragment
   diagnostics — not just `error.message`.
3. No raw fragment data, credential material, tokens, or response bodies appear anywhere in the
   error properties or the artifact — the same sanitization already applied to `attempts` and
   `rejectedFragments` on the successful path.
4. Successful packet output and its `providerData.access` shape are unchanged.

## 3. Non-goals

- No change to which capabilities are required, how they're validated, or the assembly/selection
  algorithm itself.
- No change to `capability` or `failure` CLI modes — neither calls `assembleAzureFragments`.
- No change to `azure-devops-cli-provider.md`'s adapter sequencing, retry, or safety rules beyond
  documenting the new failure artifact.
- No version bump (plugin stays at `0.3.0`); no new dependencies.

## 4. Approach

### 4.1 Structured error properties

In `assembleAzureFragments`, when `missing.length` is non-empty, attach to the thrown `Error`,
alongside the existing `error.attempts`:

- `error.missingCapabilities` — the same sorted array already computed as `missing`.
- `error.rejectedFragments` — the same array passed to `providerData.access.rejectedFragments`
  on success (source label plus sanitized category/message only).
- `error.selectedCapabilities` — a `{ [capabilityName]: source }` map for capabilities that *did*
  complete and were selected, built the same way as `providerData.access.capabilities` on the
  successful path (source only, never the underlying `data`). This is the "successful capability
  sources" the finding calls out as currently unavailable on the failure path.

These three properties are additive; `error.message` keeps its existing text so every current
`assert.throws(..., /regex/)` test keeps passing unchanged.

### 4.2 CLI failure artifact

Both `directory` and `packet` CLI modes call `assembleAzureFragments` and write a `PACKET_JSON`
file on success. Wrap both call sites in a small shared helper,
`assembleAndWrite(fragments, packetJsonPath)`, that:

- On success: writes the packet exactly as today, returns it (no behavior change).
- On an assembly failure (identified by `error.attempts` being present — the marker that this
  error came from `assembleAzureFragments`'s missing-capability path, not a different validation
  error such as a conflicting-identity throw before that point): builds a failure artifact object
  and writes *that* to `packetJsonPath`, appends a pointer to that path onto `error.message`, then
  rethrows so the existing top-level `main().catch` still logs a message and sets
  `process.exitCode = 1` unchanged.

  Failure artifact shape:

  ```json
  {
    "provider": "azure-devops",
    "assembled": false,
    "message": "<original error message, unmodified>",
    "missingCapabilities": ["…"],
    "selectedCapabilities": { "metadata": { "adapter": "bluebird", "credentialContext": "…", "capturedAt": "…" } },
    "attempts": [{ "capability": "…", "source": { "…" }, "complete": false, "failure": { "category": "…", "message": "…" } }],
    "rejectedFragments": [{ "source": { "…" }, "failure": { "category": "malformed", "message": "…" } }]
  }
  ```

  A conflicting-identity error (thrown by `assertImmutableAgreement`, before `attempts` is even
  populated) has no `error.attempts` and is not treated as an assembly-failure artifact case; it
  falls through to the existing generic message-only behavior, which is correct because there is
  no partial ledger to report for it — it aborts before selection runs.

### 4.3 Why write to `PACKET_JSON` rather than a separate file

The skill/provider reference already treats `PACKET_JSON` as the single output path the caller
reads after invoking `packet` or `directory` mode. Reusing that path means no new CLI arguments,
no new file-naming convention, and the caller already knows where to look — it just needs to
branch on the new `assembled` field instead of assuming any file at that path is a complete
packet. This matches the "deterministic machine-readable failure artifact" requirement without
inventing a second contract.

### 4.4 Documentation

Update `azure-devops-cli-provider.md` §6 ("Assembly") to state that when the `packet` command
exits non-zero, `<PACKET_JSON>` contains this failure artifact (`assembled: false`) with the full
attempt ledger, selected-capability sources, and rejected-fragment diagnostics, and that the
operator should read it — not just the printed message — before stopping.

## 5. Test strategy

Extend `tests/azure-access.test.mjs`:

1. **Missing capability plus successful attempts:** assemble fragments where some required
   capabilities complete and at least one is missing; assert the thrown error carries
   `missingCapabilities` (matching the capabilities left incomplete), `selectedCapabilities`
   (containing the source for a capability that did complete, e.g. `metadata`), and that neither
   contains any `data`/patch/credential field.
2. **Rejected envelopes surface on failure:** include a structurally broken fragment (as in the
   existing "structurally broken fragment is dropped" success test) in an otherwise-incomplete
   assembly; assert `error.rejectedFragments` reports it.
3. **Sanitized diagnostics:** assert `error.attempts`, `error.rejectedFragments`, and
   `error.selectedCapabilities` never contain a `data` key or any string resembling a token/patch
   body — only source/category/message fields.
4. **Packet CLI failure behavior:** a `spawnSync` subprocess test invoking `packet` mode with
   fragments that leave capabilities missing; assert non-zero exit status, assert the
   `PACKET_JSON` file exists and parses with `assembled: false`, `missingCapabilities`,
   `attempts`, and (when applicable) `rejectedFragments` populated, and assert stderr still
   contains the original message text plus a pointer to the artifact path.

All tests remain offline and deterministic, consistent with the existing suite.

## 6. Acceptance criteria

1. `assembleAzureFragments` throws with `missingCapabilities`, `selectedCapabilities`, and
   `rejectedFragments` properties (in addition to the existing `attempts` and `message`) whenever
   assembly fails due to missing capabilities.
2. `packet` and `directory` CLI modes write a deterministic `assembled: false` JSON artifact to
   `PACKET_JSON` on that same failure path, containing the full sanitized ledger.
3. No raw fragment data, tokens, response bodies, or credential material appears in any new error
   property or artifact field.
4. A successful packet's shape and `providerData.access` contents are byte-for-byte unchanged.
5. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
