# Agent response transport

- **Date:** 2026-08-12
- **Status:** Approved
- **Target:** `ghcp/plugins/pr-review-graph/`
- **Origin:** Follow-up to [issue #5](https://github.com/ncksol/ai_tools/issues/5)

## 1. Problem

PR Review Graph exchanges machine-readable JSON with discovery, verifier, deduplicator, and editor agents,
but the orchestration can stage rendered Copilot CLI text instead of the raw machine response. Text mode
combines display-only tool and skill narration with assistant output and wraps long strings for presentation.
Those display line breaks become literal controls inside JSON strings, while process announcements can
precede the JSON value. Stage-specific consumers correctly reject both forms, but retries receive the same
corrupted transport or the workflow stops after otherwise valid agent work.

The Copilot CLI already exposes the required boundary through `--output-format json`. Its JSONL stream keeps
assistant messages, tool calls, skill calls, and terminal status as separate typed events. The fix must extract
the one final assistant payload from that structure without repairing, interpreting, or assuming the JSON
schema of the payload itself.

## 2. Goals

1. Make JSONL the only supported subprocess transport for every PRG machine-response stage.
2. Preserve the exact agent payload after decoding the outer JSONL string.
3. Prevent rendered tool, skill, reasoning, and display text from entering any stage consumer.
4. Fail closed on ambiguous, malformed, unsuccessful, or non-terminal assistant payloads.
5. Keep discovery-specific attempt recording separate from schema-agnostic extraction.
6. Preserve each stage's existing reject, retry, hold, or stop behavior.
7. Preserve strict candidate validation, secret redaction, off-plan protection, and coverage finalization.
8. Test array and object payloads with long multiline fields and preamble contamination.

## 3. Approaches considered

### 3.1 Dedicated schema-agnostic JSONL extractor (chosen)

Add one transport adapter before every PRG machine-response consumer. The adapter validates JSONL framing,
selects one terminal assistant payload, and writes it unchanged to a private staging file. Existing
stage-specific consumers continue to own JSON parsing and schema validation.

This keeps transport framing independent from the candidate trust boundary and permits deterministic
end-to-end tests without invoking a model.

### 3.2 Add JSONL handling to each stage consumer

Stage-specific JSONL operations would couple the same Copilot CLI event protocol to discovery ingestion,
deduplication, comment application, and future verifier processing. They would also duplicate failure
handling and risk inconsistent transport semantics.

### 3.3 Launch Copilot from a wrapper

A wrapper could enforce every CLI flag itself, but it would also own model invocation, permissions, plugin
resolution, process lifecycle, and environment behavior. That scope is unnecessary for fixing the response
boundary.

## 4. Architecture

Add `skills/review-pull-request/scripts/extract-agent-response.mjs` between every tool-less PRG agent dispatch
and its stage-specific consumer.

The subprocess flow for discovery, verification, deduplication, and editing is:

1. Invoke the namespaced PRG agent with `--output-format json --stream off --silent`.
2. Redirect the JSONL event stream to a fresh mode-`0600` capture inside the mode-`0700` run directory.
3. Run:

   ```bash
   node <SKILL_DIR>/scripts/extract-agent-response.mjs \
     <EVENTS_JSONL> <RAW_RESPONSE_FILE> <TRANSPORT_STATUS_JSON>
   ```

4. On extraction success, pass the fresh mode-`0600` payload file unchanged to the current stage consumer.
5. On extraction failure, read only `TRANSPORT_STATUS_JSON` and apply that stage's existing failure policy.

The extractor owns JSONL framing and terminal response selection only. It does not parse, trim, normalize,
repair, redact, validate, or otherwise interpret the extracted agent payload. It therefore supports discovery
arrays and verifier, deduplicator, and editor objects without schema-specific branches.

## 5. JSONL extraction contract

Every non-empty input line must parse as one JSON object with a string `type`. The stream must contain exactly
one successful terminal `result` event. Assistant turns are defined by matching `assistant.turn_start`,
`assistant.message`, and `assistant.turn_end` events using their declared turn identifiers.

Tool, skill, MCP, reasoning, usage, and other non-assistant events are ignored by event type. They are never
removed from assistant text because assistant text is never searched or rewritten.

An empty `assistant.message` is an ignorable structural frame regardless of whether it carries tool requests. It remains subject to the same matching turn boundaries as every assistant message. A response payload is a non-empty, tool-free string in `assistant.message.data.content`. The stream is valid only when:

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
- a contentful process or skill preamble before the final JSON value;
- a response message with tool requests;
- an unmatched, incomplete, or non-final response turn; or
- assistant events after the selected response turn.

After outer JSONL decoding, the extractor writes `data.content` exactly as received. It adds no newline and
performs no whitespace trimming, code-fence removal, prose stripping, control-character escaping, or JSON
repair. The receiving stage remains responsible for deciding whether those bytes are strict,
schema-compliant JSON for that stage.

## 6. Files and permissions

The JSONL capture, extracted response, and transport status live only under the run's private temporary
directory. All are created with exclusive mode-`0600` writes. The extractor removes the JSONL capture in a
`finally` block on success and failure. It removes a partial extracted-response file on failure. The
orchestrator removes the status after acting on it, and each current stage removes its extracted response
after parsing or validation.

Raw JSONL is not retained because it can contain untrusted packet text, tool arguments, or other session
events. `TRANSPORT_STATUS_JSON` contains `status: "complete"` on success. On failure it contains one fixed
structural failure kind plus safe line number, event index, event type, or count when applicable. It never
contains event source lines, assistant content, tool arguments, or payload fragments.

## 7. Transport status and stage policies

The generic extractor uses only these fixed failure kinds:

- `transport-invalid-jsonl`;
- `transport-invalid-event`;
- `transport-missing-result`;
- `transport-multiple-results`;
- `transport-unsuccessful-result`;
- `transport-missing-payload`;
- `transport-multiple-payloads`; and
- `transport-non-terminal-payload`.

It rejects detail keys outside the structural allowlist and has no output field through which raw JSONL can
enter the status.

### 7.1 Discovery

A discovery transport failure consumes the current attempt. Add a separate
`process-discovery.mjs transport-failure` operation:

```bash
node <SKILL_DIR>/scripts/process-discovery.mjs transport-failure \
  <TRANSPORT_STATUS_JSON> <RESULTS_DIR> <DIAGNOSTICS_DIR> \
  --agent <PRG_AGENT> --batch <ONE_BASED_INDEX> --attempt <1|2>
```

This operation validates the extractor status and records a process-discovery-compatible invalid attempt.
Its diagnostic contains `failureKind` and a structural-only `transport` object instead of a response body.
`ingestDiscoveryResponse` and its existing raw-response diagnostic path remain unchanged.

The existing state machine therefore continues to apply:

- an invalid first transport or ingestion attempt permits one retry;
- a valid second attempt is classified as recovered;
- a second invalid attempt is terminal;
- no third model invocation is permitted;
- failed coverage produces no candidate file; and
- off-plan agents, batches, categories, or envelopes remain rejected.

Malformed extracted payloads continue through strict ingestion and its existing redacted diagnostic path.
Transport failures do not pass raw JSONL into redaction because only safe structural metadata is retained.

### 7.2 Verification

Verification still runs each candidate once. A transport failure, malformed object, or invalid verifier
contract cannot produce a verified finding; reject that candidate from the publishable set. Do not retry it
or infer a verdict from partial text.

### 7.3 Deduplication

A transport failure is a failed deduplication batch. Retry that batch once under the existing bounded-loop
rule. If the retry also fails, treat its decisions as missing so `deduplicate-findings.mjs apply` holds every
affected finding for human judgement. Never assume `distinct`.

### 7.4 Editing

A transport failure is equivalent to invalid editor output. Perform the currently required single editor
retry. If a valid complete editor object is still unavailable, stop before payload construction; never
publish unedited, partial, or transcript-derived text.

## 8. Native Task and subsession dispatch

Native dispatch is permitted only when the API provides an explicit final-response field with semantics
equivalent to `assistant.message.data.content`. The orchestrator stages that field unchanged and sends it to
the current stage consumer. This bypass is valid only when the response API structurally separates the final
field from progress, tool, skill, and transcript events.

A rendered transcript, concatenated message history, display text, generic task summary, or API response
without a distinct final-response field is not ingestible. It must be recorded as a transport failure. The
documented default is the Copilot CLI JSONL subprocess path.

## 9. Tests

Add deterministic CLI-level tests that cross the new transport boundary and existing stage consumers:

1. A JSONL stream containing tool and skill events plus one terminal long discovery array extracts and
   ingests exactly. Candidate fields include escaped newlines, carriage returns, tabs, NULs, and strings
   longer than typical terminal widths.
2. Long verifier, deduplicator, and editor object payloads extract unchanged and pass their existing
   stage-specific parsing or consumer validation.
3. Contentful `Using ...` assistant preambles before both array and object payloads fail rather than being
   stripped.
4. Rendered text input fails as malformed transport rather than reaching a stage consumer.
5. Missing, multiple, malformed, tool-bearing, incomplete, and non-terminal payloads fail closed.
6. Missing, duplicate, or unsuccessful terminal result events fail closed.
7. A first-attempt discovery transport failure followed by a valid retry finalizes as recovered.
8. Two failed discovery attempts produce failed coverage and no candidates.
9. A failed deduplication transport retry results in held findings, and invalid editor transport cannot reach
   payload construction.
10. JSONL captures, status files, and response staging files are cleaned up, and private writes use mode
    `0600`.
11. A static contract test requires the native-dispatch exception to accept only an API's explicit raw
    final-response field and to reject transcript, progress, tool, and summary fields.

Existing tests remain authoritative for strict JSON parsing, literal-control rejection, candidate validation,
secret redaction, retry bounds, stale-candidate removal, off-plan rejection, and fail-closed coverage.

## 10. Documentation and packaging

Update:

- `skills/review-pull-request/SKILL.md` with the required JSONL command before all four machine-response
  stages, their failure policies, the native-dispatch restriction, and the prohibition on rendered
  transcripts;
- `skills/review-pull-request/references/review-graph.md` with the transport gate before ingestion;
- `skills/review-pull-request/references/superpowers-compatibility.md` to state that skill narration is a
  separate JSONL event and rendered announcements are never staged;
- `README.md` with the machine-response transport guarantee;
- `scripts/validate-plugin.mjs` to require the extractor and transport clauses;
- `plugin.json` from `0.2.5` to `0.2.6`; and
- the root marketplace entry from `0.2.5` to `0.2.6`.

`package.json` remains unchanged because the installable plugin version is carried by `plugin.json` and the
root marketplace manifest. Agent prompts remain unchanged because their content contracts are already
correct.

## 11. Acceptance criteria

1. Long schema-compliant array and object outputs survive JSONL extraction and their current consumers
   without display wrapping or content changes.
2. Tool, skill, and process events cannot contaminate the payload channel.
3. Missing, multiple, malformed, unsuccessful, or non-terminal assistant payloads fail closed.
4. No prose stripping or malformed-JSON repair is introduced.
5. Discovery transport failure recovery uses at most the existing two attempts.
6. Verifier, deduplicator, and editor transport failures preserve their existing reject, retry/hold, and
   retry/stop policies.
7. Strict ingestion, secret redaction, off-plan protection, and coverage guarantees remain intact.
8. Transport-boundary regression tests cover long arrays, long objects, and preamble contamination.
9. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
10. Plugin and marketplace versions both read `0.2.6`.

## 12. Out of scope

- Repairing malformed specialist JSON.
- Parsing rendered text or locating an array inside prose.
- Changing discovery schemas, routing, verification, deduplication, editing, or publication.
- Changing verifier, deduplicator, or editor schemas or stage-specific validation policy.
- Embedding Copilot process launch, model selection, or permission policy in the extractor.
