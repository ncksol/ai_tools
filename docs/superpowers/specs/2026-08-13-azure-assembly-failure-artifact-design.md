# Azure assembly failure artifact

**Status:** approved  
**Scope:** `ghcp/plugins/pr-review-graph`

## Problem

`assemble-azure-context.mjs` writes `<PACKET_JSON>` only on success. Every failure path — missing capabilities, immutable identity/SHA conflict, a non-empty change list with an empty diff, an unreadable or malformed fragment file, an unreadable raw capture directory — prints to stderr and exits non-zero without touching the output path.

The provider contract in `references/azure-devops-cli-provider.md` §6 tells the operator to read the assembler's sanitized attempt ledger and stop before agent dispatch. When `<PACKET_JSON>` already exists from an earlier successful run, or from an earlier failed run of a different shape, that file survives the failure. The reader is pointed at a file that describes a different assembly than the one that just failed. A stale complete packet is the dangerous case: it satisfies every downstream completeness check and a review can proceed on retired evidence.

## Requirements

- Every failed `packet` and `directory` assembly replaces `<PACKET_JSON>` with a failure artifact, once the output path is known.
- The artifact is machine-readable and carries a stable `category`, a stable `reason`, and a single-line `message`.
- The artifact carries whichever of `missing`, `selected`, `attempts`, `rejectedFragments` the failure produced, and omits the rest.
- The artifact never contains raw fragment data, capability data, provider response bodies, credentials, or tokens.
- A successful packet is unchanged, byte for byte.
- `capability` and `failure` fragment-emission modes are unchanged.
- Usage errors, which occur before the output path is known, write nothing.
- Exit code stays 1 on failure; stderr output is unchanged.
- No new dependencies; Node ≥ 18 built-ins only. Plugin version stays at 0.2.0.

## Design

### Artifact shape

```json
{
  "schemaVersion": "1.0",
  "assembled": false,
  "provider": "azure-devops",
  "failedAt": "2026-08-13T12:00:00.000Z",
  "failure": {
    "category": "incomplete",
    "reason": "missing-capabilities",
    "message": "Incomplete Azure DevOps context: diff, policies"
  },
  "diagnostics": {
    "missing": ["diff", "policies"],
    "selected": { "identity": { "adapter": "azure-rest", "credentialContext": "pat", "capturedAt": "..." } },
    "attempts": [
      {
        "capability": "policies",
        "source": { "adapter": "azure-rest", "credentialContext": "pat", "capturedAt": "..." },
        "complete": false,
        "failure": { "category": "authentication", "message": "..." }
      }
    ],
    "rejectedFragments": [
      { "source": { "adapter": "bluebird", "credentialContext": "manual", "capturedAt": "..." },
        "failure": { "category": "malformed", "message": "..." } }
    ]
  }
}
```

`assembled: false` is the discriminator. A packet has no such key, so a consumer that reads `<PACKET_JSON>` can tell the two apart without schema inference. Absent diagnostics keys are omitted rather than emitted empty, so presence means evidence.

### Categories and reasons

| Failure | `category` | `reason` | Diagnostics |
|---------|-----------|----------|-------------|
| Required capabilities unresolved | `incomplete` | `missing-capabilities` | `missing`, `selected`, `attempts`, `rejectedFragments` |
| Identity, organization, head or base SHA disagreement | `conflict` | `identity-conflict` | `rejectedFragments` |
| Non-empty change list with an empty diff patch | `conflict` | `empty-diff` | `selected`, `attempts`, `rejectedFragments` |
| Fragment file unreadable or not JSON | `malformed` | `unreadable-fragment` | none |
| Raw capture directory unreadable or not JSON | `malformed` | `unreadable-raw-directory` | none |
| Anything else | `unexpected` | `unexpected-error` | none |

Classification does not string-match error messages. Each known throw site tags its error with an `assembly` property holding the already-sanitized `{ category, reason, message, diagnostics }`. `classifyFailure` returns that property when present and otherwise falls back to the `unexpected` row with a fixed message. An error that no throw site tagged is by definition an error whose message this module does not control, so its text is not persisted.

`error.message` at every existing throw site is unchanged, because callers and tests match on it.

### Sanitizing by construction

Two leak vectors are closed rather than filtered.

**Parse errors.** `JSON.parse` failure messages embed a slice of the input on Node ≥ 20 (`Unexpected token 'x', "…" is not valid JSON`). A fragment file holds provider data, so that text must never reach the artifact. `readFragmentFile` and the raw-directory read catch the error and construct their own message from the path and a coarse kind — the `error.code` when the failure came from the filesystem, `invalid JSON` otherwise. The underlying message is discarded.

**Source and failure objects.** `validateAzureFragment` requires `source.adapter`, `source.credentialContext` and `source.capturedAt` but passes unknown sibling keys through. The artifact builder projects every `source` to exactly those three fields and every `failure` to `{ category, message }`, so an unexpected key in an input fragment cannot ride into the artifact. Successful packets keep their current projection-free shape, so their bytes do not change.

Every `message` is newline-stripped. The `missing-capabilities` message is the first line of the existing multi-line error; its per-adapter blocker lines are already present structurally in `attempts`.

### Wiring

`assembleAndWrite(outputPath, build)` wraps both packet-producing modes:

```javascript
async function assembleAndWrite(outputPath, build) {
  try {
    const packet = await build();
    await writeJson(outputPath, packet);
    return packet;
  } catch (error) {
    await writeFailureArtifact(outputPath, error);
    throw error;
  }
}
```

`build` covers fragment or raw-directory reading as well as assembly, so read failures land inside the artifact path. Argument validation stays outside, so a usage error still writes nothing. `writeFailureArtifact` swallows its own write error, so an unwritable output path still surfaces the original failure rather than a masking one. The rethrow preserves the existing stderr line and exit code 1.

`assembleAzureFragments` gains the diagnostics it cannot currently expose: `selected` sources and `rejectedFragments` are attached to the missing-capability and empty-diff errors, and `rejectedFragments` to the agreement-conflict error. `assertImmutableAgreement` runs before the attempt ledger exists, so a conflict artifact carries no `attempts` — the requirement is that available diagnostics are reported, not that every failure reports all four.

## Tests

New tests in `tests/azure-access.test.mjs`, driving the CLI with `spawnSync` against a pre-existing stale packet file:

1. **Missing capabilities replace a stale successful packet** — write a valid packet to the output path, then assemble fragments that leave capabilities unresolved. Assert exit 1, `assembled === false`, `reason === 'missing-capabilities'`, `missing` non-empty, `attempts` non-empty.
2. **Immutable SHA conflict replaces a stale successful packet** — assert `reason === 'identity-conflict'`, `category === 'conflict'`, and that no packet key (`pullRequest`, `files`) survives.
3. **Empty diff for a non-empty change list** — assert `reason === 'empty-diff'`.
4. **Malformed fragment file** — a fragment containing a credential-shaped token in invalid JSON. Assert `reason === 'unreadable-fragment'` and that the artifact text does not contain the token.
5. **Unreadable raw directory in `directory` mode** — assert `reason === 'unreadable-raw-directory'` and that the stale packet was replaced.
6. **Successful assembly is unchanged** — a stale artifact at the output path is replaced by a normal packet with no `assembled` key.
7. **Usage error writes nothing** — run `packet` with no fragment paths against an existing stale packet; assert exit 1 and the stale file untouched.
8. **Source projection** — a fragment whose `source` carries an extra secret-shaped key produces an artifact that does not contain it.
