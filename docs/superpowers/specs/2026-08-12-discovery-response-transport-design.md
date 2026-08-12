# Discovery response transport

- **Date:** 2026-08-12
- **Status:** Approved
- **Target:** `ghcp/plugins/pr-review-graph/`
- **Origin:** Follow-up to [issue #5](https://github.com/ncksol/ai_tools/issues/5)

## 1. Problem

PR Review Graph strictly parses discovery-agent responses, but the orchestration can stage rendered Copilot
CLI text instead of the raw machine response. Text mode combines display-only tool and skill narration with
assistant output and wraps long strings for presentation. Those display line breaks become literal controls
inside JSON strings, while process announcements can precede the array. Strict ingestion correctly rejects
both forms, but retries receive the same corrupted transport and discovery coverage fails.

The Copilot CLI already exposes the required boundary through `--output-format json`. Its JSONL stream keeps
assistant messages, tool calls, skill calls, and terminal status as separate typed events. The fix must extract
the one final assistant payload from that structure without repairing or interpreting the payload itself.

## 2. Goals

1. Make JSONL the only supported subprocess transport for discovery responses.
2. Preserve the exact specialist payload after decoding the outer JSONL string.
3. Prevent rendered tool, skill, reasoning, and display text from entering strict ingestion.
4. Fail closed on ambiguous, malformed, unsuccessful, or non-terminal assistant payloads.
5. Count transport failures within the existing two-attempt protocol so a valid retry can recover.
6. Preserve strict candidate validation, secret redaction, off-plan protection, and coverage finalization.
7. Test the transport-to-ingestion boundary with long multiline fields and preamble contamination.

## 3. Approaches considered

### 3.1 Dedicated JSONL extractor (chosen)

Add a small transport adapter before `process-discovery.mjs ingest`. The adapter validates JSONL framing,
selects one terminal assistant payload, and writes it unchanged to a private staging file. Existing ingestion
continues to own JSON parsing and candidate validation.

This keeps transport framing independent from the candidate trust boundary and permits deterministic
end-to-end tests without invoking a model.

### 3.2 Add JSONL handling to `process-discovery.mjs`

An `ingest-jsonl` operation would use fewer scripts, but it would make the existing finalization module own
Copilot CLI event framing as well as candidate validation and coverage state.

### 3.3 Launch Copilot from a wrapper

A wrapper could enforce every CLI flag itself, but it would also own model invocation, permissions, plugin
resolution, process lifecycle, and environment behavior. That scope is unnecessary for fixing the response
boundary.

## 4. Architecture

Add `skills/review-pull-request/scripts/extract-discovery-response.mjs` between discovery dispatch and strict
ingestion.

The subprocess flow is:

1. Invoke the namespaced discovery agent with `--output-format json --stream off --silent`.
2. Redirect the JSONL event stream to a fresh mode-`0600` capture inside the mode-`0700` run directory.
3. Run:

   ```bash
   node <SKILL_DIR>/scripts/extract-discovery-response.mjs \
     <EVENTS_JSONL> <RAW_RESPONSE_FILE> <RESULTS_DIR> <DIAGNOSTICS_DIR> \
     --agent <PRG_AGENT> --batch <ONE_BASED_INDEX> --attempt <1|2>
   ```

4. On extraction success, pass the fresh mode-`0600` payload file to the unchanged
   `process-discovery.mjs ingest` operation.
5. On extraction failure, record one invalid attempt and apply the existing one-retry rule.
6. Finalize all attempts against the immutable plan exactly as before.

The extractor owns JSONL framing and terminal response selection only. It does not parse, trim, normalize,
repair, redact, validate, or otherwise interpret the extracted specialist payload.

## 5. JSONL extraction contract

Every non-empty input line must parse as one JSON object with a string `type`. The stream must contain exactly
one successful terminal `result` event. Assistant turns are defined by matching `assistant.turn_start`,
`assistant.message`, and `assistant.turn_end` events using their declared turn identifiers.

Tool, skill, MCP, reasoning, usage, and other non-assistant events are ignored by event type. They are never
removed from assistant text because assistant text is never searched or rewritten.

An empty `assistant.message` is ignorable only when it carries one or more tool requests. A response payload
is a non-empty, tool-free string in `assistant.message.data.content`. The stream is valid only when:

- exactly one response payload exists;
- its message belongs to the final completed assistant turn;
- its message appears after that turn starts and before that turn ends;
- no later assistant turn or assistant message appears;
- the successful terminal `result` follows the completed turn; and
- no non-empty JSONL data follows the terminal result.

The following fail transport:

- invalid JSONL or malformed event objects;
- missing or duplicate terminal results;
- a non-zero terminal result;
- missing response payload;
- multiple contentful assistant messages;
- a contentful process or skill preamble before the final array;
- a response message with tool requests;
- an unmatched, incomplete, or non-final response turn; or
- assistant events after the selected response turn.

After outer JSONL decoding, the extractor writes `data.content` exactly as received. It adds no newline and
performs no whitespace trimming, code-fence removal, prose stripping, control-character escaping, or JSON
repair. `process-discovery.mjs ingest` remains responsible for deciding whether those bytes are strict,
schema-compliant candidate JSON.

## 6. Files and permissions

The JSONL capture and extracted response live only under the run's private temporary directory. Both are
created with exclusive mode-`0600` writes. The extractor removes the JSONL capture in a `finally` block on
success and failure. It removes a partial extracted-response file on failure. Existing ingestion removes the
successful extracted-response file after processing.

Raw JSONL is not retained because it can contain untrusted packet text, tool arguments, or other session
events. Transport diagnostics contain fixed structural failure kinds and safe event counts or positions only.
They never contain event source lines, assistant content, tool arguments, or payload fragments.

## 7. Failure and retry protocol

A transport failure consumes the current discovery attempt. Export
`recordDiscoveryTransportFailure(resultDirectory, diagnosticsDirectory, options, kind, details)` from
`process-discovery.mjs`. It reuses the module's metadata validation, exclusive private writes, filenames, and
invalid attempt-result envelope. Its diagnostic envelope contains `failureKind` and a `transport` object
instead of a response body. `ingestDiscoveryResponse` and its existing raw-response diagnostic path remain
unchanged.

The extractor uses only these fixed failure kinds:

- `transport-invalid-jsonl`;
- `transport-invalid-event`;
- `transport-missing-result`;
- `transport-multiple-results`;
- `transport-unsuccessful-result`;
- `transport-missing-payload`;
- `transport-multiple-payloads`; and
- `transport-non-terminal-payload`.

Its diagnostic contains the failure kind plus safe line number, event index, event type, or count when
applicable. `recordDiscoveryTransportFailure` rejects unknown transport failure kinds, rejects detail keys
outside that structural allowlist, and has no parameter through which raw JSONL can enter diagnostics.

The existing state machine therefore continues to apply:

- an invalid first transport or ingestion attempt permits one retry;
- a valid second attempt is classified as recovered;
- a second invalid attempt is terminal;
- no third model invocation is permitted;
- failed coverage produces no candidate file; and
- off-plan agents, batches, categories, or envelopes remain rejected.

Malformed extracted payloads continue through strict ingestion and its existing redacted diagnostic path.
Transport failures do not pass raw JSONL into redaction because only safe structural metadata is retained.

## 8. Native Task and subsession dispatch

Native dispatch is permitted only when the API provides an explicit final-response field with semantics
equivalent to `assistant.message.data.content`. The orchestrator stages that field unchanged and sends it to
strict ingestion.

A rendered transcript, concatenated message history, display text, generic task summary, or API response
without a distinct final-response field is not ingestible. It must be recorded as a transport failure. The
documented default is the Copilot CLI JSONL subprocess path.

## 9. Tests

Add deterministic CLI-level tests that cross the new transport boundary and existing ingestion:

1. A JSONL stream containing tool and skill events plus one terminal long candidate extracts and ingests
   exactly. Candidate fields include escaped newlines, carriage returns, tabs, NULs, and strings longer than
   typical terminal widths.
2. A contentful `Using ...` assistant preamble before a final array fails rather than being stripped.
3. Rendered text input fails as malformed transport rather than reaching ingestion.
4. Missing, multiple, malformed, tool-bearing, incomplete, and non-terminal payloads fail closed.
5. Missing, duplicate, or unsuccessful terminal result events fail closed.
6. A first-attempt transport failure followed by a valid retry finalizes as recovered.
7. Two failed attempts produce failed coverage and no candidates.
8. JSONL captures and response staging files are cleaned up, and successful extraction uses mode `0600`.

Existing tests remain authoritative for strict JSON parsing, literal-control rejection, candidate validation,
secret redaction, retry bounds, stale-candidate removal, off-plan rejection, and fail-closed coverage.

## 10. Documentation and packaging

Update:

- `skills/review-pull-request/SKILL.md` with the required JSONL command, extraction step, native-dispatch
  restriction, and prohibition on rendered transcripts;
- `skills/review-pull-request/references/review-graph.md` with the transport gate before ingestion;
- `skills/review-pull-request/references/superpowers-compatibility.md` to state that skill narration is a
  separate JSONL event and rendered announcements are never staged;
- `README.md` with the machine-response transport guarantee;
- `scripts/validate-plugin.mjs` to require the extractor and transport clauses;
- `plugin.json` from `0.2.5` to `0.2.6`; and
- the root marketplace entry from `0.2.5` to `0.2.6`.

`package.json` remains unchanged because the installable plugin version is carried by `plugin.json` and the
root marketplace manifest. Discovery-agent prompts remain unchanged because their strict content contract is
already correct.

## 11. Acceptance criteria

1. Long schema-compliant discovery output survives JSONL extraction and strict ingestion without display
   wrapping or content changes.
2. Tool, skill, and process events cannot contaminate the payload channel.
3. Missing, multiple, malformed, unsuccessful, or non-terminal assistant payloads fail closed.
4. No prose stripping or malformed-JSON repair is introduced.
5. Transport failure recovery uses at most the existing two attempts.
6. Strict ingestion, secret redaction, off-plan protection, and coverage guarantees remain intact.
7. Transport-boundary regression tests cover long fields and preamble contamination.
8. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
9. Plugin and marketplace versions both read `0.2.6`.

## 12. Out of scope

- Repairing malformed specialist JSON.
- Parsing rendered text or locating an array inside prose.
- Changing discovery schemas, routing, verification, deduplication, editing, or publication.
- Applying the JSONL subprocess adapter to verifier, deduplicator, or editor responses.
- Embedding Copilot process launch, model selection, or permission policy in the extractor.
