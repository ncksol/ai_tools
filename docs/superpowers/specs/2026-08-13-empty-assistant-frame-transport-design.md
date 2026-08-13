# Empty Assistant Frame Transport

- **Date:** 2026-08-13
- **Status:** Approved
- **Target:** `ghcp/plugins/pr-review-graph/`
- **Release:** `0.2.7`

## Problem

PR Review Graph 0.2.6 rejects an `assistant.message` when both
`data.content` and `data.toolRequests` are empty. Long-running Copilot CLI
JSONL streams legitimately emit empty, tool-free assistant messages carrying
opaque encrypted or reasoning state before the one final plaintext response.
The extractor stops at the first such frame and discards the later valid
payload.

The failed PR #4 review produced 18 `transport-invalid-event` results through
this path. Each affected initial invocation subsequently reached a valid final
JSON array. Four malformed fallback responses occurred only after transport
had rejected usable first-attempt output, so candidate repair and weaker
validation are outside this fix.

## Goals

1. Accept legitimate empty assistant control frames regardless of whether they
   contain tool requests.
2. Keep empty frames subject to the existing assistant-turn boundary checks.
3. Extract exactly one non-empty, tool-free terminal payload unchanged.
4. Preserve all current ambiguity, ordering, result, permissions, cleanup,
   diagnostic, retry, and downstream validation behavior.
5. Add deterministic coverage modeled on the captured reliability stream and
   a reproducible opt-in real Copilot CLI verification.
6. Release the corrected plugin as `0.2.7`.

## Non-goals

- Parsing, repairing, trimming, or searching rendered text for JSON.
- Treating encrypted or reasoning fields as response payloads.
- Per-item candidate salvage or weaker candidate validation.
- Additional discovery attempts or changed verifier, deduplicator, or editor
  failure policies.
- A model- or network-dependent invocation in the automated test suite.

## Approaches

### Content-based empty-frame handling

Keep the current extractor architecture and classify messages by `content`.
Every empty-content message is a structural frame; every non-empty message is
a payload candidate only when it has no tool requests. This is the selected
approach because it matches the observable CLI contract without depending on
opaque metadata fields.

### Reasoning-field allowlist

Accept empty, tool-free messages only when fields such as `encryptedContent`
or `reasoningOpaque` are present. This is narrower but couples the extractor to
undocumented fields that can change independently of the response transport.

### Stream reducer rewrite

Replace the existing analysis with a new event-state reducer. This could make
classification more explicit, but it changes proven ordering and failure
behavior to fix one incorrect predicate.

## Extraction Contract

`extractAgentResponse(eventsFile, responseFile, statusFile)` and every
downstream interface remain unchanged.

An `assistant.message` is structurally valid only when:

- `data.turnId` is a non-empty string;
- `data.content` is a string; and
- `data.toolRequests` is an array.

Message classification is:

| Content | Tool requests | Classification |
| --- | --- | --- |
| Empty | Empty | Structural frame |
| Empty | Non-empty | Structural frame |
| Non-empty | Empty | Payload candidate |
| Non-empty | Non-empty | `transport-invalid-event` |

Additional fields, including encrypted and reasoning state, are opaque. They
are neither validated as payloads nor used to decide whether an empty frame is
legitimate.

All assistant messages, including empty frames, remain subject to the existing
turn checks. Each message must be between one matching
`assistant.turn_start` and `assistant.turn_end`. Empty frames do not relax
turn matching, terminal-turn selection, or result ordering.

The stream remains valid only when:

- exactly one non-empty payload candidate exists;
- that payload has no tool requests;
- it belongs to the final completed assistant turn;
- no assistant message follows that turn;
- exactly one terminal `result` exists with `exitCode === 0`; and
- no event follows the terminal result.

After outer JSONL decoding, the extractor writes the selected `data.content`
unchanged. It does not trim, normalize, append a newline, strip prose or
fences, inspect reasoning fields, or repair malformed JSON.

## Data Flow and Failure Handling

JSONL parsing, structural event validation, payload extraction, private output
writes, and cleanup remain separate from stage-specific JSON validation.

1. Copilot CLI writes JSONL to a fresh mode-`0600` file.
2. The extractor validates every assistant frame and terminal result.
3. Empty assistant frames participate in turn validation but not payload
   selection.
4. The extractor writes the one selected payload and structural status using
   exclusive mode-`0600` files.
5. Discovery or another stage consumes the payload under its existing strict
   schema.
6. The extractor always removes the event capture.

Transport failures continue to contain only fixed failure kinds and safe
structural details. Discovery remains bounded to two attempts. Verification
still rejects transport failures without retry. Deduplication still retries
once and then holds affected findings. Editing still retries once and then
stops.

## Automated Tests

Implementation follows test-driven development.

### Minimal regression

Construct this exact sequence:

1. `assistant.turn_start`;
2. an empty, tool-free `assistant.message` with synthetic encrypted and
   reasoning fields;
3. a tool-free `assistant.message` containing `[]`;
4. the matching `assistant.turn_end`; and
5. a successful terminal `result`.

Before the implementation change, extraction must fail with
`transport-invalid-event` at the empty frame. After the change, extraction
must complete and the response file must contain exactly `[]`.

### Captured-structure reliability regression

Construct an immutable synthetic event sequence modeled on the safe captured
PR #4 reliability shape:

- an empty assistant message with a tool request;
- multiple empty, tool-free assistant frames carrying synthetic encrypted and
  reasoning metadata;
- one final non-empty reliability candidate array;
- the matching terminal turn end; and
- one successful terminal result.

The fixture contains no captured response text or raw JSONL. Serialize it only
inside the test's private temporary directory. Extraction must preserve the
candidate array exactly, and `ingestDiscoveryResponse` must accept it under the
existing strict finding contract.

### Empty-only-turn characterization

Construct a valid, successfully completed stream whose only
`assistant.message` is empty and tool-free — no other assistant message
precedes or follows it in the turn. Extraction must fail with
`transport-missing-payload`, write no response file, and remove the event
capture. Because the corrected extractor already treats a lone empty frame as
containing no payload candidate, this fixture is added as a characterization
of existing behavior rather than a regression that requires an implementation
change; it is not expected to be RED before the fix.

### Existing safety coverage

The suite must continue covering contentful preambles, multiple payloads,
content-plus-tool messages, missing and non-terminal payloads, unsuccessful or
multiple results, events after the terminal result, private file modes,
cleanup, structural diagnostics, failed coverage finalization, verifier
rejection, deduplication retry/hold, and editor retry/stop behavior.

## Opt-in Copilot CLI Verification

Document a manual, numbered reproduction — validated against the real
`pr-review-graph:prg-reliability` agent on immutable PR #4 batches — that:

1. creates a private, mode-`0700` scratch directory outside the repository
   with `umask 077`, mode-`0600` sensitive files, and an `EXIT` trap;
2. binds exact identity before any model invocation: full lowercase 40-hex
   `EXPECTED_BASE`/`EXPECTED_HEAD`, `REPO` cross-checked against
   `git remote get-url origin` and `gh repo view` for this checkout, and a
   read-only fetch of `refs/pull/${PR}/head` into `FETCH_HEAD` (no persistent
   ref) so fork PRs and locally missing objects still resolve before the
   `git cat-file` checks;
3. fetches read-only provider data and asserts, with executable `jq -e`, that
   the initial remote base/head SHAs match exactly — not a prose-only
   verification;
4. builds the packet and review plan from the exact commit diff, and asserts
   with executable `jq -e` that the packet and plan carry the identical
   base/head SHAs and that exactly one `prg-reliability` plan entry contains
   the selected batch;
5. invokes the local, tool-less `pr-review-graph:prg-reliability` agent
   (`tools: []`, no added capabilities) with a SHA-pinned immutable batch
   prompt built only from that plan entry;
6. structurally requires at least one opaque empty/no-tool assistant frame
   before exactly one non-empty, tool-free terminal payload — printing the
   safe structural count object before gating on it — and records, without
   gating on, any tool-bearing frame count;
7. runs the extractor and strict discovery ingestion, wrapping both so a
   failure prints only the fixed structural failure kind/status from their
   own private status/result JSON and then exits non-zero, never printing
   payload, candidate, or packet content;
8. strictly ingests whatever valid reliability candidate array the agent
   returns — it does not require a specific finding count, only that the
   array satisfies the existing strict finding contract;
9. rechecks the remote base/head SHAs exactly before reporting success; and
10. removes the entire scratch directory through the exit trap.

The procedure must never print, copy, commit, or retain the JSONL, raw
response, prompt, packet, result, or diagnostic content outside the scratch
directory, and it must never write to the PR or execute code from the PR. It
is intentionally excluded from `npm test` because model behavior, installed
skills, authentication, and network availability are not deterministic test
dependencies.

## Documentation and Release

Correct the directly contradicted empty-message rule in:

- `docs/superpowers/specs/2026-08-12-agent-response-transport-design.md`; and
- `docs/superpowers/plans/2026-08-12-agent-response-transport.md`.

State the control-frame rule consistently in the review skill, graph
reference, README, and plugin validation. Keep the existing transport and
stage-policy wording otherwise unchanged.

Set `plugin.json` and the root marketplace entry to `0.2.7`.
`package.json` remains at `0.2.0` under the repository's plugin versioning
convention.

## Acceptance Criteria

1. The minimal empty/no-tool frame fixture fails before the change and extracts
   the later `[]` unchanged after it.
2. The captured-structure reliability fixture extracts and passes strict
   discovery ingestion.
3. Empty frames remain subject to existing turn-boundary checks.
4. A stream whose only assistant message is an empty, tool-free frame extracts
   as `transport-missing-payload`, writes no response, and cleans the event
   capture (characterization, since the corrected extractor already passes
   it).
5. Every existing fail-closed transport and downstream-stage test remains
   passing.
6. The opt-in real CLI reproduction — a SHA-pinned immutable PR batch against
   the local, tool-less `prg-reliability` agent — succeeds without retaining
   raw output, and its README procedure binds exact SHA and current-repository
   identity with executable `jq -e` checks rather than prose.
7. `npm test --silent` and `npm run validate --silent` pass from
   `ghcp/plugins/pr-review-graph`.
8. Contradicted documentation is corrected and plugin versions are
   synchronized at `0.2.7`.
