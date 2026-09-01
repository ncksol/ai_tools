# Review graph

## State machine

| State | Input | Output | Remote writes |
| --- | --- | --- | --- |
| Resolve | PR reference | Provider and unambiguous PR identity | None |
| Snapshot | Provider identity | Canonical packet with base/head SHAs | None |
| Route | Canonical packet | Reviewer plan and packet slices | None |
| Transport | Tool-less agent JSONL or explicit raw final-response field | Exact machine payload or structural failure status | None |
| Discover | Reviewer slices | Candidate findings | None |
| Verify | Candidates and evidence | Verified or rejected findings | None |
| Fingerprint | Verified findings | Internally deduplicated set | None |
| Deduplicate | Fingerprinted findings and every existing comment | New, suppressed, or held findings | None |
| Edit | Deduplicated set | Author-facing inline and summary comments | None |
| Preview | Edited findings and current head SHA | User decision | None |
| Publish | Explicit approval and unchanged head | Provider review threads | Approved comments only |

## Fan-out policy

Always dispatch:

- `prg-contract`
- `prg-correctness`
- `prg-tests`

Conditionally dispatch:

- `prg-security` for trust boundaries, authentication, authorization, parsing, dependencies, secrets, cryptography, or attacker-controlled input.
- `prg-data-compatibility` for schemas, migrations, persistence, serialization, public payloads, or version skew.
- `prg-reliability` for concurrency, async work, I/O, networking, retries, resources, infrastructure, or lifecycle changes.

Dispatch independent reviewers with `run-discovery.mjs`, capped at four concurrent subprocesses. Give each reviewer only relevant review units and necessary context. Preserve the packet's provider line coordinates.

Normal patches become one review unit. Oversized single-line JSON replacements become deterministic JSON-pointer delta units, each bound to the real file path and changed line. Planning stops before dispatch when an oversized patch cannot be represented within the unit budget. The dispatcher also rejects any rendered prompt above its hard prompt limit.

Every discovery, verifier, deduplicator, and editor subprocess uses Copilot JSONL output and `extract-agent-response.mjs`; rendered transcript text is never a machine response. Native dispatch may bypass extraction only for an explicit raw final-response field that is structurally separate from progress, tool, skill, reasoning, summary, and transcript data. Empty assistant messages are structural frames regardless of tool requests and remain subject to assistant-turn validation.

## Bounded loops

- Ingest every discovery response with `process-discovery.mjs`. Retry a batch once only when ingestion reports an invalid result. Never repair or silently drop malformed output.
- Do not retry `execution-capacity`, `execution-spawn`, or `execution-exit` with an identical prompt. Record the safe execution diagnostic and leave the batch failed.
- After all routed batches settle, finalize discovery coverage against the immutable review plan. If any batch remains invalid, stop before verification.
- A verification transport failure rejects that candidate without retry; malformed transport can never create a verified finding. Otherwise verify each candidate once. If the verifier requests dynamic evidence, suppress the finding unless the user authorizes the exact safe command and the result proves it.
- If the head SHA changes, rebuild the packet and rerun only scopes intersecting changed files, but re-deduplicate the full finding set.
- For a deduplication transport failure, retry once; if the retry fails, hold every affected finding for human judgement. The same hold applies when a valid batch omits a finding.
- For an editor transport failure, retry once; if the retry fails, stop before payload construction.
- Retry remote publication only after showing which writes succeeded and obtaining confirmation for the remainder.

## Coverage result

Classify each selected scope as `complete`, `incomplete`, or `failed`. A scope is complete only when every planned batch produced a valid candidate array, including batches recovered by their one retry.

If any selected scope is incomplete or failed, the review status is failed and the graph stops before verification. Lead the report with `REVIEW FAILED - DISCOVERY INCOMPLETE`, show the scope matrix and redacted diagnostic paths, and do not describe the partial candidate set as clean.

An empty candidate set is authoritative only when every selected scope is complete.

## Reduction order

1. Reject invalid schema.
2. Reject failed confidence thresholds.
3. Reject non-verified verdicts.
4. Compute fingerprints.
5. Collapse identical fingerprints.
6. Batch every non-empty existing comment without filtering by location or status.
7. Use `prg-deduplicator` to compare every finding against every batch.
8. Suppress any finding with at least one `duplicate` verdict.
9. Hold any remaining finding with an `uncertain`, missing, or invalid verdict.
10. Publish only findings classified `distinct` in every batch.
11. Sort by severity, confidence, path, and line.
12. Keep at most 20 publishable findings.
