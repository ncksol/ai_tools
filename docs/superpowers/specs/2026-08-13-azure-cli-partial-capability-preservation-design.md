# Azure CLI partial capability preservation

- **Date:** 2026-08-13
- **Status:** Approved (design); implementation pending
- **Target:** `ghcp/plugins/pr-review-graph`
- **Observed defect:** `collect-azure-devops.sh` is all-or-nothing. Under `set -e` with a
  cleanup trap, a failure in a late command discards the successful results of every earlier
  command, and the provider guide then records the whole CLI route as failed.

## 1. Problem statement

The approved Azure access design treats each adapter as a contributor of individual
capabilities. Its acquisition flow requires the CLI route to "preserve sanitized diagnostics
and keep any independently valid fragments it produced" so that REST, optional MCP, and local
Git fill only the remaining gaps.

The collector does not do this. It runs seven provider operations plus a local Git diff under
`set -euo pipefail`, writing every response into one `mktemp -d` work directory that an `EXIT`
trap deletes. Any non-zero exit — a failed `pullRequestThreads` call, an unresolvable
iteration, a repository-name mismatch — terminates the script before
`assemble-azure-context.mjs` runs, and the trap then removes the successful
`pull-request.json`, `work-items.json`, `policies.json`, and `iterations.json` responses.

The provider guide compounds the loss. After a failed collector run it instructs the agent to
write a single `failure` fragment covering `all` capabilities. Identity, metadata, snapshot,
work items, and policies that the CLI actually returned are therefore reported as
unsuccessful. Assembly can then fail the read gate even when the other adapters could have
supplied only the genuinely missing capabilities.

Two further defects follow from the same structure:

1. `loadRawDirectory` substitutes `[]` for an absent `work-items.json` or `policies.json`. A
   capability built from a partially populated directory would silently report a valid empty
   enumeration for data that was never collected, violating the fail-closed rule for missing
   versus empty results.
2. A shape violation from a single operation — for example an iteration-change response that
   still carries `nextSkip`/`nextTop` because the PR exceeds the `$top=2000` request — throws
   during assembly instead of marking that one capability incomplete.

## 2. Goals

1. Emit every independently successful CLI capability, whatever later operations do.
2. Mark only the failed operations incomplete, with a sanitized category and message.
3. Distinguish a collected empty result from a capability that was never collected.
4. Produce output that composes with the REST, optional MCP, and local Git adapters through
   the existing fragment schema.
5. Keep raw provider responses and authentication output out of the repository and out of
   user-visible diagnostics.

## 3. Non-goals

- Deadlines, timeouts, or process-tree cancellation for external commands. Another change
  owns that behaviour.
- Weakening the read gate. A packet still requires all nine capabilities.
- Changing the fragment schema version, the assembler's selection rules, REST collection, the
  review graph, or GitHub collection.
- Retrying a failed credential context inside the collector. The provider guide continues to
  own the second, PAT-free attempt.

## 4. Collector contract

```bash
bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON> [<FRAGMENT_JSON>]
```

- The collector always writes exactly one `azure-cli` fragment describing all nine
  capabilities, whether the run succeeded, partially succeeded, or failed outright.
- `FRAGMENT_JSON` defaults to `<dirname PACKET_JSON>/azure-cli-<credential-context>.fragment.json`,
  where the context is reduced to `A-Za-z0-9._-` so an arbitrary environment value cannot
  redirect the path. The resolved path is printed on stdout so the agent can pass it to
  assembler `packet` mode.
- `PACKET_JSON` is written only when all nine capabilities are complete.
- The fragment is written outside the collector's internal work directory, which the existing
  `EXIT` trap continues to delete along with every raw provider response.
- `source.adapter` is `azure-cli`; `source.credentialContext` continues to come from
  `PRG_AZURE_CREDENTIAL_CONTEXT`, defaulting to `current-environment`.

Exit statuses:

| Status | Meaning |
| --- | --- |
| `0` | Every capability complete; fragment and packet written |
| `1` | Fragment written; at least one capability incomplete, so no packet |
| `2` | Usage error, or a prerequisite that prevents writing any fragment at all |

Status `1` keeps "this CLI attempt did not produce a packet" as the agent's control signal
while the fragment preserves what the attempt did obtain.

## 5. Capability map

Each provider operation is attempted independently. A failed operation fails only the
capabilities it feeds, plus the capabilities that require its output.

| Capability | Source operation | Requires |
| --- | --- | --- |
| `identity`, `metadata`, `snapshot` | `az repos pr show` | — |
| `workItems` | `az repos pr work-item list` | — |
| `policies` | `az repos pr policy list` | — |
| `iterations` | `az devops invoke pullRequestIterations` | `az repos pr show` fields |
| `changes` | `az devops invoke pullRequestIterationChanges` | resolved iteration id |
| `existingThreads` | `az devops invoke pullRequestThreads` | `az repos pr show` fields |
| `diff` | `git fetch` and `git diff` | snapshot SHAs and repository identity |

`az repos pr work-item list` and `az repos pr policy list` address the PR by id through the
configured default organization, so they remain collectable when `az repos pr show` fails.

## 6. Failure categories

Failures are classified without echoing provider or authentication output.

| Category | Raised when |
| --- | --- |
| `tool-unavailable` | `az` is absent, or the Azure DevOps extension is missing |
| `authentication` | Captured stderr matches a known authorization signal (`TF400813`, `TF401019`, `401`, `403`, `Unauthorized`, `Forbidden`, `az login`) |
| `command-failed` | The operation exited non-zero for any other reason |
| `dependency-unavailable` | A prerequisite capability or field was not collected |
| `repository-mismatch` | The local Git origin does not correspond to the Azure repository |
| `malformed` | The response is missing, unreadable, or fails capability shape validation |
| `incomplete-pagination` | An iteration-change response still carries `nextSkip`/`nextTop` |

Messages name the operation and, where relevant, its exit status. They never include captured
stderr, request URLs, tokens, or PAT values. Captured stderr stays in the work directory that
the `EXIT` trap deletes and is never printed. Every message is collapsed to a single line.

## 7. Assembly changes

`assemble-azure-context.mjs` gains partial-directory support:

1. `capabilitiesFromRaw(raw)` holds the existing complete-capability shaping so the strict and
   partial builders cannot drift apart.
2. `fragmentFromPartialRawDirectory(directory, source)` builds all nine capabilities from
   whatever the directory holds. For each capability it first honours an explicit
   `<capability>.failure` sidecar written by the collector, then requires the raw files that
   capability depends on to exist and parse, and only then marks it complete. A missing file
   is `malformed`, never an empty result.
3. The result passes through the existing `downgradeMalformedCapabilities`, so a single
   shape violation becomes one incomplete capability instead of an aborted run.
4. `directory` mode accepts an optional fragment path:

   ```
   assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON> [<FRAGMENT_JSON>]
   ```

   With a fragment path it uses the partial builder, writes the fragment first, then attempts
   the packet. Without one it keeps today's strict behaviour.

The sidecar is a two-line text file — category on the first line, single-line message on the
second — so the Bash 3.2 collector never has to quote JSON.

`validateAzureFragment`, `assembleAzureFragments`, adapter authority, immutable-identity
agreement, and the attempt ledger are unchanged.

## 8. Collector structure

The collector keeps `set -euo pipefail`, the `mktemp -d` work directory, and the cleanup trap.
Every provider operation moves into a helper that runs the command inside an `if` condition,
so a non-zero exit records a sidecar instead of terminating the script. Node and `git` remain
hard prerequisites because the fragment cannot be written without Node; a missing `az`
produces a fragment whose nine capabilities are all `tool-unavailable`.

Conditions that previously called `exit 1` become scoped failures:

- missing `project_id`, `repository_id`, or organization URL fails only the operations that
  need them;
- an unresolvable iteration id fails only `changes`;
- an origin/repository name mismatch, a missing commit object, or a failed `git diff` fails
  only `diff`.

On exit the collector prints a per-capability status summary built from the fragment it just
wrote, listing each incomplete capability with its category only.

## 9. Test strategy

All tests are offline and deterministic. Shell tests place stub `az` and `git` executables on
`PATH` and run the collector with `bash`.

1. A fully successful stub run writes both the fragment and the packet and exits `0`.
2. A failing `pullRequestThreads` call exits `1`, writes no packet, and produces a fragment
   whose other eight capabilities are complete and whose `existingThreads` is incomplete.
3. A failing `az repos pr show` still yields complete `workItems` and `policies`, with the
   dependent capabilities marked `dependency-unavailable`.
4. An authorization signal in stub stderr yields category `authentication` and a message
   containing no provider text, URL, or credential value.
5. A missing `az` yields a fragment with all nine capabilities `tool-unavailable`.
6. Omitting `FRAGMENT_JSON` writes the documented default path and prints it.
7. `fragmentFromPartialRawDirectory` marks a capability whose raw file is absent as incomplete
   rather than as a complete empty collection.
8. An iteration-change response that still carries `nextSkip`/`nextTop` marks only `changes`
   incomplete while the other capabilities stay complete.
9. The collector remains free of Bash 4 constructs.
10. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.

## 10. Acceptance criteria

1. A late CLI failure no longer discards earlier successful capabilities.
2. Only the operations that actually failed are marked incomplete, each with a sanitized
   category and single-line message.
3. A capability whose raw response was never collected is never reported as a valid empty
   result.
4. The emitted fragment composes with REST, optional MCP, and local Git fragments through
   assembler `packet` mode without schema changes.
5. No raw provider response, captured stderr, or credential value is printed or persisted
   outside the deleted work directory.
6. The collector runs on stock macOS Bash 3.2, uses only Node built-ins, and the plugin stays
   at version `0.3.0`.
