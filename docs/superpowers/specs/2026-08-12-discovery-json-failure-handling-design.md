# Discovery JSON failure handling

- **Date:** 2026-08-12
- **Status:** Proposed; awaiting user review
- **Target:** `ghcp/plugins/pr-review-graph/`
- **Origin:** [Issue #5](https://github.com/ncksol/ai_tools/issues/5)

## 1. Problem statement

PR Review Graph currently relies on the orchestrating model to parse discovery-agent replies directly.
The discovery agents are told to return JSON, but their examples show a bare object while the prose
requires an array, and none of the prompts explicitly require JSON escaping for multiline fields. In the
reported run, several agents placed literal control characters inside quoted values. Parsing failed on
both attempts for some batches.

The graph then continued with the batches that happened to parse. Every valid batch returned `[]`, so the
partial run reached a clean-looking "no publishable findings" result even though contract, correctness,
tests, data-compatibility, and reliability coverage was incomplete or failed. This is a fail-open boundary:
the absence of candidates was treated as evidence of a clean review without first proving that every
routed discovery batch completed.

The failed responses were not retained in a safe diagnostic form, so the parser location could not be
matched back to a redacted copy of the offending output.

## 2. Goals

1. Make every discovery-agent output contract unambiguous about arrays, code fences, and JSON escapes.
2. Put a deterministic strict parser and candidate validator between agent output and Phase 3.
3. Retry an invalid batch once, then fail the review before verification if the retry is also invalid.
4. Retain the complete failed response in a redacted, control-character-safe diagnostic artifact.
5. Make coverage status authoritative: an empty candidate array is meaningful only after every routed
   batch completes.
6. Cover escaped multiline values, literal control characters, redaction, retry recovery, and terminal
   coverage failure with the existing Node test suite.

## 3. Approaches considered

### 3.1 Deterministic ingestion and finalization (chosen)

Add one Node utility with `ingest` and `finalize` operations. `ingest` strictly parses and validates one
attempt, records a safe result envelope, and writes a redacted diagnostic on failure. `finalize` compares
terminal attempt results with the immutable review plan and emits candidates only when all planned batches
completed.

This adds a small deterministic boundary but makes both malformed-output handling and fail-closed coverage
testable. Agent prompts reduce the error rate; the utility enforces correctness when a model still violates
the prompt.

### 3.2 Prompt hardening only

Update the six discovery-agent prompts to require compact JSON and escaped control characters, then retain
the existing orchestration instructions.

This is the smallest edit, but it leaves correctness dependent on model compliance and cannot provide a
meaningful regression test for the reported failure. A future malformed response could reproduce the same
false-clean result.

### 3.3 Tolerant repair before parsing

Strip code fences and rewrite literal control characters inside quoted strings before parsing.

This would complete more runs, but it silently changes an agent's evidence and makes malformed output look
contract-compliant. Repair heuristics also have to distinguish string content from JSON structure. The
design therefore rejects repair: invalid output is retried once and then reported as a failed review.

## 4. Architecture

The change adds `skills/review-pull-request/scripts/process-discovery.mjs`. It follows the plugin's existing
script conventions: Node built-ins only, pure exported functions for tests, a CLI guarded by `isMain`, and
shared JSON/flag helpers from `lib.mjs`.

The utility owns two separate operations:

- **`ingest`** is the trust boundary for one raw specialist response. It parses exact JSON, validates the
  candidate shape with `validateFindings(..., {mode: "candidate"})`, enforces the expected category, and
  writes an attempt-result envelope.
- **`finalize`** is the coverage gate. It reads `PLAN_JSON`, resolves the terminal result for every planned
  agent batch, classifies each scope, and either writes the merged candidate array or fails without creating
  a candidate file.

Keeping both operations in one module avoids a second protocol between scripts while preserving isolated
functions for parsing, redaction, scope classification, and finalization.

## 5. Agent output contract

Update all six discovery agents:

- `prg-contract`
- `prg-correctness`
- `prg-tests`
- `prg-security`
- `prg-data-compatibility`
- `prg-reliability`

Each prompt will state:

1. Return exactly one JSON array, beginning with `[` and ending with `]`.
2. Return no prose, Markdown code fence, JSON comment, or trailing comma.
3. Escape newlines, carriage returns, tabs, NULs, and other control characters inside strings with JSON
   escapes such as `\n`, `\r`, `\t`, and `\u0000`; never place a literal control character inside a quoted
   value.
4. Return `[]` when there is no candidate.

Each example becomes a one-element array rather than the current bare object. The finding fields and
review criteria do not change.

`validate-plugin.mjs` will assert that every discovery-agent prompt contains the shared strict-output
clause. The prompts remain self-contained because agents cannot load a shared reference at runtime.

## 6. Ingestion operation

The orchestration command is:

```bash
node <SKILL_DIR>/scripts/process-discovery.mjs ingest \
  <RAW_RESPONSE_FILE> <RESULTS_DIR> <DIAGNOSTICS_DIR> \
  --agent <PRG_AGENT> --batch <ONE_BASED_INDEX> --attempt <1|2>
```

`ingest` validates the agent name against the six discovery agents and derives the only permitted category
from that name. Batch and attempt values must be positive integers, with attempt limited to `1` or `2`.
Those validated values produce the result and diagnostic filenames; untrusted text never contributes to a
path.

`ingest` writes
`<RESULTS_DIR>/<agent>-batch-<THREE_DIGIT_INDEX>-attempt-<ATTEMPT>.json`. `finalize` derives the expected
filenames from `PLAN_JSON`, so the orchestrator does not assemble a separate result manifest.

The raw response staging file is created inside the run directory with mode `0600`. `ingest` removes it in
a `finally` block on both success and failure. The outer workflow also removes any leftover staging files
before reporting, covering process interruption.

### 6.1 Successful result

Strict `JSON.parse` must produce an array. `validateFindings` must accept every item in candidate mode, and
every item must use the category assigned to the agent. On success, `ingest` writes a mode-`0600` result:

```json
{
  "schemaVersion": "1.0",
  "agent": "prg-correctness",
  "category": "correctness",
  "batch": 1,
  "attempt": 1,
  "status": "complete",
  "findings": []
}
```

The `findings` value is serialized with `JSON.stringify`, so valid multiline and control characters are
canonical escaped JSON in the result file.

### 6.2 Invalid result

Parsing, top-level shape, candidate validation, and category mismatch are distinct failure kinds. On
failure, `ingest`:

1. redacts the complete response;
2. stores it in a valid JSON diagnostic envelope, causing all remaining control characters to be visibly
   escaped by `JSON.stringify`;
3. writes an attempt result with `status: "invalid"`, the failure kind, safe validation messages, and the
   diagnostic path;
4. exits non-zero so the orchestrator retries that batch.

Raw parser messages are not copied to stderr or the result because newer runtimes may include source
fragments in those messages. The result may include only safely extracted numeric position, line, and
column data. The diagnostic contains the redacted response needed to inspect the failure.

## 7. Diagnostic redaction and lifetime

Diagnostics live under the run's existing temporary directory, never in the repository. The diagnostics
directory is mode `0700`; each artifact is mode `0600`. A failure artifact has this shape:

```json
{
  "schemaVersion": "1.0",
  "agent": "prg-correctness",
  "batch": 1,
  "attempt": 1,
  "failureKind": "invalid-json",
  "response": "complete redacted response"
}
```

Before serialization, deterministic text redaction replaces:

- values assigned to credential-bearing names such as `authorization`, `token`, `access_token`,
  `api_key`, `client_secret`, `password`, `cookie`, and `private_key`;
- Bearer and Basic authorization values;
- GitHub token formats, JWT-shaped values, and PEM private-key blocks.

The diagnostic JSON encoding makes literal newlines, NULs, escape characters, and other controls visible
without making the file itself malformed or terminal-active. The workflow reports the artifact path, not
its body.

A failed first attempt remains available even if the retry succeeds. On a successful review, diagnostic
artifacts remain available through the completion report and are then removed with the run directory. On a
terminal discovery failure, the redacted diagnostics and coverage report remain in the temporary directory
at the reported path for diagnosis; unredacted staging files and provider data are removed.

## 8. Retry and finalization flow

For every routed agent batch:

1. Dispatch the specialist and stage its response.
2. Run `process-discovery.mjs ingest` with `--attempt 1`.
3. If ingestion fails, retry the same batch once. The retry prompt repeats the exact output contract and
   supplies only the safe failure kind and location, never the raw response.
4. Stage and ingest the retry with `--attempt 2`.
5. After all in-flight batches settle, run:

```bash
node <SKILL_DIR>/scripts/process-discovery.mjs finalize \
  <PLAN_JSON> <RESULTS_DIR> <CANDIDATES_JSON> <COVERAGE_JSON>
```

`finalize` walks agents in plan order and batches in numeric order. Attempt 1 is terminal when complete;
attempt 2 is terminal only after an invalid attempt 1. Missing, duplicated, unexpected, or inconsistent
result envelopes count as invalid coverage rather than being ignored.

The merged candidate order is deterministic: plan agent order, batch order, then finding order. Partial
findings remain only in attempt-result files and never become `CANDIDATES_JSON`.

## 9. Coverage and failure semantics

Each routed scope is classified from its terminal batch results:

- `complete`: every planned batch completed, including batches recovered by retry;
- `incomplete`: at least one batch completed and at least one did not;
- `failed`: no planned batch completed.

`COVERAGE_JSON` records expected, completed, recovered, and failed batch counts plus diagnostic paths. The
top-level status is `complete` only when every routed scope is complete.

When top-level status is `failed`, `finalize` removes any stale candidate output, writes the coverage
report, and exits non-zero. The skill stops before Phase 3 verification and leads its response with:

> **REVIEW FAILED - DISCOVERY INCOMPLETE**

It then shows the scope matrix and diagnostic paths. It must not say "no findings", "no publishable
findings", "clean", or equivalent language, and it must not preview or publish a review.

When every routed batch completes, `finalize` writes `CANDIDATES_JSON`. In that state only, `[]` means
discovery completed without candidates and the graph may continue to verification and reduction.

`references/review-graph.md` and Phase 2 of `SKILL.md` will make this gate explicit. The current statement
that a final review may proceed with incomplete discovery coverage will be removed.

## 10. Error handling

- Agent contract violations are never repaired or silently dropped.
- One invalid attempt triggers one retry of that batch only.
- A second invalid attempt is terminal for the review, not merely for the batch.
- Attempt results are written for normal validation failures, and coverage is written even when an attempt
  result is missing, so reporting does not depend on parsing stderr.
- Candidate output is absent on failed coverage, preventing later scripts from consuming an empty or stale
  array.
- Diagnostic write failure is itself terminal. The workflow must not claim that a failed response was
  retained when the artifact could not be written.
- The workflow waits for already-dispatched batches to settle so the failure report contains the complete
  scope matrix; it does not launch verification work after any terminal discovery failure is known.

## 11. Tests

Add focused cases to `tests/plugin.test.mjs` using temporary directories and the real exported functions or
CLI:

1. **Escaped multiline candidate succeeds.** A candidate containing `\n`, `\r`, `\t`, and `\u0000`
   parses, validates, and is reserialized as valid escaped JSON.
2. **Literal control character fails.** A quoted field containing a literal newline or NUL produces an
   invalid attempt, a non-zero exit, no candidate output, and a valid diagnostic envelope.
3. **Diagnostic redaction is complete for supported secret forms.** Bearer credentials, labeled password
   and token values, a GitHub token, a JWT, and a PEM private key do not appear in the artifact.
4. **Staging input is removed.** Both successful and failed ingestion delete the unredacted raw response
   file.
5. **Retry recovery completes coverage.** An invalid first attempt followed by a valid second attempt is
   classified complete and records the recovered batch.
6. **Mixed terminal results fail closed.** A scope with valid and twice-invalid batches is `incomplete`,
   top-level status is failed, and `CANDIDATES_JSON` is absent.
7. **All terminal failures classify the scope as failed.**
8. **Empty candidates require complete coverage.** All-complete `[]` responses produce a valid empty
   candidate file; the same partial data with one failed batch produces only a failed coverage report.
9. **Discovery prompts preserve the strict contract.** All six prompts use an array example and the
   required escaping clause.

The existing test command remains `npm test`; no dependency is added.

## 12. Documentation and packaging

- `skills/review-pull-request/SKILL.md`: document staging, ingestion, retry, finalization, and the hard stop
  before Phase 3.
- `skills/review-pull-request/references/review-graph.md`: replace permissive incomplete-discovery behavior
  with the fail-closed gate and define when an empty candidate set is authoritative.
- `README.md`: state that a routed discovery batch that remains invalid after retry fails the review before
  verification.
- `scripts/validate-plugin.mjs`: require `process-discovery.mjs` and the strict discovery-agent clauses.
- `plugin.json`: version `0.2.4` to `0.2.5`.
- `.github/plugin/marketplace.json`: matching `pr-review-graph` version `0.2.5`.
- `package.json`: unchanged; this repository uses `plugin.json` and the root marketplace manifest as the
  installable plugin version.

## 13. Acceptance criteria

1. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
2. Valid escaped multiline and control-character fields survive ingestion and canonical serialization.
3. Literal unescaped control characters fail ingestion and produce a complete redacted diagnostic artifact.
4. Every invalid batch is retried at most once.
5. Any batch still invalid after retry stops the graph before verification with
   `REVIEW FAILED - DISCOVERY INCOMPLETE`.
6. A failed-coverage run does not create `CANDIDATES_JSON`, preview a review, publish a review, or describe
   the empty partial set as clean.
7. A complete-coverage run whose batches all return `[]` may proceed as a legitimate no-candidate review.
8. Failed raw staging files are deleted; only redacted diagnostic envelopes are retained temporarily.
9. Plugin and marketplace versions both read `0.2.5`.

## 14. Out of scope

- Repairing malformed model output.
- Changing finding fields, severity thresholds, routing heuristics, verification, deduplication, editing, or
  provider publication.
- Applying the new ingestion protocol to verifier, deduplicator, or editor outputs. Their contracts remain
  unchanged in this issue.
- Persisting diagnostics in the repository or adding a long-lived diagnostic store.
