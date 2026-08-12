# Azure DevOps PR access composition

- **Date:** 2026-08-12
- **Status:** Approved (design); implementation pending
- **Target:** `ghcp/plugins/pr-review-graph`
- **Observed failure:** Azure DevOps PR 10313 returned `TF400813` through both the injected
  `AZURE_DEVOPS_EXT_PAT` and the stored `az devops` login, while the available Bluebird
  connection could read the PR metadata.

## 1. Problem statement

The Azure DevOps path in `review-pull-request` has one acquisition route. The skill requires
`azure-devops-cli`, explicitly forbids Azure DevOps MCP tools, and invokes
`collect-azure-devops.sh`. That collector exits on the first failed `az repos pr show` call.
It therefore treats failure of one command and credential context as proof that the pull
request is inaccessible.

The failed review of PR 10313 demonstrates that this assumption is false. Both Azure DevOps
CLI credential contexts were unauthorized, but Bluebird successfully returned the pull
request title, description, branches, reviewers, and commits. The plugin stopped without
trying that available route.

Bluebird alone is not enough. A safe review also needs linked work items, every existing
thread and comment, policies or checks, exact base and head commits, changed-file content,
iteration and line-tracking data, and a fresh head check. Code search or partial PR metadata
must not be mistaken for complete review context.

## 2. Goals

1. Use any available deterministic, machine-readable Azure DevOps tool that can contribute
   authoritative PR data.
2. Compose complementary sources when no one source supplies the whole packet.
3. Require a complete canonical read packet before dispatching review agents.
4. Permit a complete preview when reads succeed but no write route is available.
5. Preserve the existing preview-before-publish and immutable-snapshot safety boundaries.
6. Keep external MCP servers optional rather than plugin dependencies.
7. Report exactly which capabilities and credential contexts succeeded or failed without
   exposing credentials.

## 3. Non-goals

- Browser or UI scraping is not an access fallback.
- The plugin does not install tools or extensions, prompt for login, request a PAT, or
  mutate Azure DevOps defaults.
- Local Git and code-search tools cannot independently satisfy Azure DevOps PR access.
- The review graph, specialist routing, verification, deduplication, and comment editing
  do not change.
- The plugin does not weaken its completeness rules to produce a partial review.

## 4. Capability model

Azure acquisition is planned per operation rather than per tool. The planner maintains a
ledger with these required read capabilities:

| Capability | Completeness requirement |
| --- | --- |
| PR identity and metadata | Organization, project, repository, PR ID, URL, title, full description, author, state, source ref, and target ref |
| Immutable snapshot | Exact provider-reported source and target commit SHAs |
| Linked requirements | Complete linked-work-item enumeration plus the details needed to understand each item |
| Existing feedback | Every PR thread and comment, including general, inline, active, resolved, closed, outdated, bot-authored, and empty-result confirmation |
| Policies and checks | Complete current policy or build-signal response, including a confirmed empty result |
| Iteration changes | All pages of iterations and changes, with rename and `changeTrackingId` data |
| Changed content | Every changed path and either a unified patch, equivalent base/head content, or an explicit permitted exclusion |
| Head recheck | Current provider-reported source SHA immediately before preview or publication |

Publication is a separate optional capability. A packet may pass the read gate without a
write route, but publication remains unavailable until an adapter can create PR threads.

An empty description, no linked work items, no comments, or no policies can be valid. The
ledger distinguishes a successfully enumerated empty result from a capability that was
never collected.

## 5. Access adapters

### 5.1 Azure DevOps CLI fast path

The existing collector remains the preferred fast path because it already obtains all
provider-specific data and creates the local Git diff. Its failure no longer terminates
Phase 1. The planner records the failed operation and continues with other adapters.

The CLI route probes configured contexts independently:

1. the current environment, including `AZURE_DEVOPS_EXT_PAT` when present;
2. the stored `az devops` login with `AZURE_DEVOPS_EXT_PAT` removed only for that process.

An authorization failure in one context does not suppress the other. Neither probe changes
saved CLI configuration.

### 5.2 Direct Azure DevOps REST

A deterministic REST collector can satisfy the same provider operations through Azure
DevOps REST endpoints. It may use only credentials already available to the process:

- anonymous access for a public project;
- the existing `AZURE_DEVOPS_EXT_PAT`;
- an existing Entra token returned by `az account get-access-token` for the Azure DevOps
  resource.

Tokens remain in memory, are never written to the bundle, and are never printed. The
collector follows continuation tokens or endpoint-specific paging until exhaustion.
Reference-list endpoints, such as linked work items, are followed by detail requests before
the capability is marked complete.

### 5.3 Optional Azure DevOps MCP tools

The skill inspects available tool descriptions for Azure DevOps PR operations. Bluebird is
an explicitly supported optional adapter where configured. Other MCP tools may contribute
only when their documented operation returns authoritative, machine-readable data for a
ledger capability.

The adapter records only fields actually returned. A Bluebird pull-request response can
contribute metadata, description, reviewers, branches, linked work items, or commits when
present. It does not satisfy existing feedback, policies, iteration changes, exact snapshot
SHAs, or pagination unless the invoked tool explicitly returns those facts with completeness
semantics.

The plugin manifest continues to declare no MCP server. Absence or failure of an MCP tool is
an adapter result, not a missing plugin dependency.

### 5.4 Local Git

Local Git verifies repository identity, obtains missing commit objects without checkout, and
produces the full unified diff between the captured target and source SHAs. It may use the
current object database and configured Git remote credentials.

Local Git never supplies the PR description, work items, policies, comments, or provider
head recheck. A matching repository and complete diff therefore remain insufficient on
their own.

## 6. Fragment and provenance contract

Each adapter writes machine-readable fragments into a temporary directory outside the
repository. A fragment identifies:

- the adapter and credential-context label, without credential material;
- capture time;
- capabilities attempted and completed;
- raw authoritative values;
- pagination or empty-result evidence;
- sanitized failure category and message for incomplete operations.

A deterministic assembler merges fragments into the existing Azure raw bundle consumed by
`normalize-context.mjs`. Each canonical capability retains source provenance for diagnostics.
The assembler applies these rules:

1. prefer no adapter globally; select facts per capability;
2. reject conflicting organization, project, repository, PR ID, base SHA, or head SHA;
3. never replace a complete result with a partial one;
4. union paged collections only when page identity and continuation evidence are present;
5. deduplicate records by provider-stable IDs, not display text;
6. fail closed when a source cannot distinguish missing data from a valid empty result.

Tool-supplied fragments, including Bluebird results, use the same schema and validation as
CLI and REST fragments. The agent must transcribe exact returned values and cannot infer
fields the tool did not provide.

## 7. Acquisition flow

1. Parse the Azure DevOps URL into organization, project, repository, and PR ID. A bare PR
   number remains ambiguous unless repository scope is already explicit.
2. Create the temporary bundle and empty capability ledger.
3. Run the current CLI collector. On failure, preserve sanitized diagnostics and keep any
   independently valid fragments it produced.
4. For each missing capability, probe all available deterministic adapters whose documented
   operations can provide it. Do not rerun a source for a capability already complete unless
   immutable identity needs confirmation.
5. Use local Git after repository identity and provider SHAs are known.
6. Assemble fragments and validate the provider contract.
7. Stop before review-agent dispatch if any required read capability is incomplete,
   conflicting, or truncated.
8. Run the existing review graph against the canonical packet.
9. Recheck the head through any adapter that can authoritatively read the current PR source
   SHA. Refresh the packet when it changed.
10. Preview verified findings. State whether publication is available.
11. After explicit confirmation, recheck the head again and publish only through a
    write-capable adapter. Existing partial-publication handling remains unchanged.

## 8. Error handling

Adapter failures use these categories:

| Category | Handling |
| --- | --- |
| Tool unavailable | Record and continue |
| Unsupported capability | Record and continue |
| Authentication or authorization | Do not retry the same credential context; continue with other contexts and adapters |
| Timeout, `429`, or `5xx` | Retry at most twice after the first attempt, respecting `Retry-After` |
| Malformed or ambiguous output | Reject the fragment and continue |
| Incomplete pagination | Mark the capability incomplete and fail the final read gate |
| Immutable identity conflict | Stop acquisition immediately |

If the read gate fails, the user receives a sanitized capability matrix listing each
required operation, satisfied source, attempted adapters, and blocker. The plugin does not
claim that a review occurred.

If reads are complete and writes are unavailable, review and preview proceed. The final
preview says publication is unavailable and identifies the missing write capability without
asking the user to expose credentials.

## 9. Implementation boundary

The implementation will:

- revise `SKILL.md`, `azure-devops-cli-provider.md`, and README;
- retain `collect-azure-devops.sh` as the CLI fast path;
- add deterministic REST collection and fragment assembly helpers;
- add a schema for Azure source fragments and capability provenance;
- extend normalization and packet diagnostics only as needed to preserve provenance and
  enforce completeness;
- update static plugin validation for optional MCP access and the new access contract;
- bump `plugin.json` and the root marketplace entry from `0.2.4` to `0.3.0`.

Specialist agent prompts, finding schemas, deduplication, payload builders, and GitHub
collection remain unchanged.

## 10. Test strategy

All tests are offline and deterministic. Fixtures and fake executables model tool responses
without requiring live Azure DevOps access.

1. A complete CLI collection passes unchanged.
2. An injected-PAT authorization failure falls through to the stored CLI context.
3. CLI authorization failures followed by a complete REST response produce a valid packet.
4. Bluebird metadata, REST threads/work items/policies, and a local Git diff compose into a
   complete packet with per-capability provenance.
5. Bluebird metadata plus code access, without complete comments and work items, fails the
   read gate.
6. A successfully enumerated empty comment or work-item response counts as complete.
7. Missing continuation pages or unresolved work-item references fail the read gate.
8. Conflicting base or head SHAs fail closed.
9. Authorization diagnostics contain no token or credential value.
10. A complete read packet with no write adapter reaches preview and marks publication
    unavailable.
11. The Bash wrapper remains compatible with stock macOS Bash 3.2.
12. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.

## 11. Acceptance criteria

1. Failure of `az repos pr show` does not end acquisition while another eligible adapter is
   available.
2. Every required read capability has authoritative data and provenance before review agents
   run.
3. No code-only or metadata-only route can produce a review packet.
4. Bluebird is used when available for capabilities its tool contract actually satisfies.
5. The observed `TF400813` scenario reaches other configured adapters and reports any
   remaining capability gaps rather than incorrectly declaring the PR wholly inaccessible.
6. Complete reads can produce a preview without a write route.
7. No adapter installs software, starts interactive authentication, changes defaults, or
   reveals credentials.
8. Plugin and marketplace versions match at `0.3.0`.
