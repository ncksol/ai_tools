# Review graph

## State machine

| State | Input | Output | Remote writes |
| --- | --- | --- | --- |
| Resolve | PR reference | Provider and unambiguous PR identity | None |
| Snapshot | Provider identity | Canonical packet with base/head SHAs | None |
| Route | Canonical packet | Reviewer plan and packet slices | None |
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

Dispatch independent reviewers concurrently. Give each reviewer only relevant patches and necessary context. Preserve the packet's provider line coordinates.

## Bounded loops

- Retry a discovery agent once only when it fails to return valid JSON.
- Verify each candidate once. If the verifier requests dynamic evidence, suppress the finding unless the user authorizes the exact safe command and the result proves it.
- If the head SHA changes, rebuild the packet and rerun only scopes intersecting changed files, but re-deduplicate the full finding set.
- If a deduplication batch fails or omits a finding, retry once; then hold that finding for human judgement.
- Retry remote publication only after showing which writes succeeded and obtaining confirmation for the remainder.

## Coverage result

Classify each selected scope as `complete`, `incomplete`, or `failed`. A final review may proceed with incomplete scope only when the preview states the limitation. Never call it comprehensive.

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
