# PR Review Graph

PR Review Graph is a GitHub Copilot plugin for reviewing existing pull requests. It gathers a stable PR snapshot, routes the change to focused read-only reviewers, verifies their findings, compares them with every existing review comment, and prepares only new issues as concise comments for the author.

It does not modify the branch, execute changed code, vote on the PR, enable auto-complete, or publish comments without confirmation.

## Providers

| Provider | Access path |
| --- | --- |
| GitHub | The `gh-cli` skill and an authenticated `gh` CLI |
| Azure DevOps | The `azure-devops-cli` skill and an authenticated `az` CLI |

There are no MCP server dependencies.

## Install

This plugin ships from the [`ncksol/ai_tools`](https://github.com/ncksol/ai_tools) marketplace repository:

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install pr-review-graph@ai-tools
copilot plugin list
```

In Copilot CLI, run `/skills list` and confirm that `review-pull-request` is available.

For local development, register the clone as a marketplace and reinstall from it after each edit, because Copilot caches installed components:

```bash
copilot plugin marketplace add /path/to/ai_tools
copilot plugin install pr-review-graph@ai-tools
```

Direct installs from a repository, URL or local path still work but the CLI marks them deprecated, so prefer the marketplace route.

### GitHub prerequisite

Install the `gh-cli` skill separately, then configure GitHub CLI authentication according to that skill:

```bash
gh auth status
```

The plugin does not vendor or replace `gh-cli`.

### Azure DevOps prerequisites

Install the `azure-devops-cli` skill separately, then configure the Azure DevOps CLI extension and authentication according to that skill. The plugin deliberately does not install the extension or handle credentials.

## Use

Examples:

```text
Review GitHub PR 123 with review-pull-request. Preview the comments only.
```

```text
Review this Azure DevOps PR and show me only verified findings: <PR URL>
```

The default is preview-only. After inspecting the proposed comments, explicitly ask Copilot to publish the approved findings.

## Review graph

1. Resolve the provider and capture an immutable base/head snapshot.
2. Build a canonical review packet.
3. Route relevant slices to focused specialist agents.
   Oversized single-line JSON replacements are converted into bounded semantic delta units with exact numeric lexemes instead of being sent as one prompt.
   Discovery prompts have hard rendered and command-transport limits, and run through a dispatcher capped at four concurrent Copilot subprocesses with a five-minute attempt timeout.
   A routed batch that remains invalid after one retry fails the review before verification; partial coverage is never reported as a clean review.
   Every machine-response stage extracts the raw final assistant payload from Copilot JSONL; rendered transcript text is never parsed as agent JSON. Empty assistant messages are structural frames regardless of tool requests and remain subject to assistant-turn validation. The extractor tolerates Copilot's stdout-redaction corruption only for a `user.message` prompt echo whose metadata envelope remains valid; it discards that non-authoritative prompt text and never repairs assistant output.
4. Verify every candidate against the PR snapshot.
5. Compare verified findings with every existing inline comment, review body and PR conversation comment.
6. Suppress confirmed duplicates and hold uncertain matches for human judgement.
7. Rewrite the remaining findings as author-facing comments.
8. Recheck the head SHA, preview the review, and wait for confirmation.
9. Publish through the provider skill's `gh` or `az` commands using generated JSON payload files.

## Superpowers

PR Review Graph and Superpowers have separate responsibilities:

- Superpowers can review work during implementation and help an author process received feedback.
- PR Review Graph reviews an already-open PR and reports verified problems through the hosting provider.
- The plugin does not shadow Superpowers skill names, invoke its implementation workflow, or fix the reported problems itself.

## Development

The deterministic utilities use only Node.js built-ins. Run both commands from this directory:

```bash
cd ghcp/plugins/pr-review-graph
npm test
npm run validate
```

`npm run validate` also checks this plugin against the repository marketplace at `.github/plugin/marketplace.json`, so the declared version and source path must stay in step with `plugin.json`.

The provider collection scripts use Bash. Specialist agents have no tools and cannot execute shell commands or edit files.

## Opt-in transport smoke

This manual smoke is intentionally excluded from `npm test`. It builds a
SHA-guarded packet for a specific open PR in this working copy's own
repository: an initial exact-SHA check binds the GitHub responses to
`EXPECTED_BASE`/`EXPECTED_HEAD`, a local `git diff` between those exact commit
objects supplies the immutable code delta, and a final exact-SHA recheck
confirms the PR did not move during the run — together these establish the
review window, not an assumption that GitHub's mutable PR metadata itself is
immutable. It invokes the local `pr-review-graph:prg-reliability` agent with
no added capabilities, validates structural topology, extracts the response,
and runs strict ingestion. All private data stays in a mode-`0700` scratch
directory removed on exit.

Run every numbered block below in one non-interactive shell so `set -euo
pipefail`, the exported variables, and the `EXIT` trap share state across
blocks; sourcing them into separate shells, or an interactive session that
resets `$?` between commands, breaks the trap and the identity checks. Step 8
(prompt construction) mirrors the dispatch contract in SKILL.md's
[Phase 2: Build the graph](skills/review-pull-request/SKILL.md#phase-2-build-the-graph);
re-read that section before changing this step so the two do not drift.

**Prerequisites:** `gh` CLI, `git`, `node`, `jq`. Run from
`ghcp/plugins/pr-review-graph` inside a checkout of the repository you intend
to review — `REPO` below is not an arbitrary value, it is asserted to match
this checkout. Set these variables before running:

```bash
REPO=<owner/repo>       # must be this checkout's own repository, e.g. ncksol/ai_tools
PR=<number>             # e.g. 4
EXPECTED_BASE=<SHA>     # full lowercase 40-hex base commit SHA
EXPECTED_HEAD=<SHA>     # full lowercase 40-hex head commit SHA
BATCH=<number>          # planned prg-reliability batch number (e.g. 1)
```

**1. Scratch directory and EXIT trap.**

```bash
set -euo pipefail
umask 077
scratch="$(mktemp -d "${TMPDIR:-/tmp}/prg-smoke.XXXXXX")"
chmod 700 "$scratch"
trap 'rm -rf -- "$scratch"' EXIT
mkdir -m 700 "$scratch/results" "$scratch/diagnostics" \
             "$scratch/copilot-home" "$scratch/copilot-logs" "$scratch/tmp"
```

**2. Validate SHA format and bind `REPO` to this checkout.**

Reject anything but a full lowercase 40-hex SHA. Require `REPO` to name the
repository this working copy actually points at, by cross-checking
`git remote get-url origin` against `gh repo view`, so `REPO` cannot silently
name an unrelated repository.

```bash
[[ "$EXPECTED_BASE" =~ ^[0-9a-f]{40}$ ]]
[[ "$EXPECTED_HEAD" =~ ^[0-9a-f]{40}$ ]]

origin_url="$(git remote get-url origin)"
origin_repo="$(printf '%s\n' "$origin_url" \
  | sed -E 's#^(git@|https://|git://)([^:/]+)[:/]##; s#\.git$##')"
gh_repo="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
[ "$REPO" = "$origin_repo" ]
[ "$REPO" = "$gh_repo" ]
```

**3. Fetch the PR head into `FETCH_HEAD` (read-only, no persistent ref).**

A single-sided refspec fetches the commit objects and updates only
`FETCH_HEAD`; it creates no local branch and no `refs/remotes/...` entry, so
this also works for a fork PR or a head this clone has never seen, without
writing to the PR or the local ref namespace.

```bash
git fetch --no-tags --quiet origin "refs/pull/${PR}/head"
```

**4. Verify immutable commit objects.**

```bash
git cat-file -e "${EXPECTED_BASE}^{commit}"
git cat-file -e "${EXPECTED_HEAD}^{commit}"
```

**5. Fetch read-only provider data (no writes to the PR) and bind the initial
identity.**

```bash
gh pr view "$PR" --repo "$REPO" \
  --json number,title,body,baseRefName,baseRefOid,headRefName,headRefOid,\
additions,deletions,changedFiles,author,labels,milestone,state,url,\
isDraft,mergeStateStatus,mergeable > "$scratch/pull-request.json"
jq -e --arg b "$EXPECTED_BASE" --arg h "$EXPECTED_HEAD" \
  '.baseRefOid == $b and .headRefOid == $h' "$scratch/pull-request.json"

gh repo view "$REPO" --json nameWithOwner,url,defaultBranchRef \
  > "$scratch/repository.json"
gh api --method GET --paginate --slurp \
  "repos/${REPO}/pulls/${PR}/files?per_page=100"    > "$scratch/files.json"
gh api --method GET --paginate --slurp \
  "repos/${REPO}/pulls/${PR}/comments?per_page=100" > "$scratch/review-comments.json"
gh api --method GET --paginate --slurp \
  "repos/${REPO}/pulls/${PR}/reviews?per_page=100"  > "$scratch/reviews.json"
gh api --method GET --paginate --slurp \
  "repos/${REPO}/issues/${PR}/comments?per_page=100"> "$scratch/issue-comments.json"
```

**6. Immutable local diff between the exact commit objects.**

```bash
git --no-pager diff --no-ext-diff --no-textconv --no-color \
  --ignore-submodules=all "$EXPECTED_BASE" "$EXPECTED_HEAD" -- \
  > "$scratch/diff.patch"
```

**7. Normalize packet and build review plan, and bind the derived identity.**

```bash
node skills/review-pull-request/scripts/normalize-context.mjs \
  --provider github --input-dir "$scratch" --output "$scratch/packet.json"
node skills/review-pull-request/scripts/build-review-plan.mjs \
  "$scratch/packet.json" "$scratch/plan.json"

jq -e --arg b "$EXPECTED_BASE" --arg h "$EXPECTED_HEAD" \
  '.pullRequest.base.sha == $b and .pullRequest.head.sha == $h' \
  "$scratch/packet.json"
jq -e --arg b "$EXPECTED_BASE" --arg h "$EXPECTED_HEAD" \
  '.snapshot.baseSha == $b and .snapshot.headSha == $h' "$scratch/plan.json"
jq -e --argjson batch "$BATCH" '
  [.agents[] | select(.name == "prg-reliability")] as $reliability
  | ($reliability | length) == 1
  and $batch >= 1
  and $batch <= ($reliability[0].batches | length)
' "$scratch/plan.json"
```

**8. Construct the batch prompt (private — do not print or retain outside
`$scratch`).**

```bash
node skills/review-pull-request/scripts/build-discovery-prompt.mjs \
  "$scratch/packet.json" "$scratch/plan.json" \
  prg-reliability "$BATCH" "$scratch/prompt.txt" \
  --max-prompt-chars 120000
```

The builder selects only the planned review units, preserves the exact
base/head identity and normalized requirements, and rejects prompts above the
hard limit. Do not print, copy, or execute the prompt contents.

**9. Invoke the local `pr-review-graph:prg-reliability` agent.**

```bash
chmod 600 "$scratch/prompt.txt"
COPILOT_HOME="$scratch/copilot-home" \
COPILOT_AUTO_UPDATE=false \
COPILOT_OTEL_ENABLED=false \
OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false \
TMPDIR="$scratch/tmp" \
copilot -C . --plugin-dir . \
  --agent pr-review-graph:prg-reliability \
  --output-format json --stream off --silent \
  --model gpt-5.6-sol --effort max \
  --disable-builtin-mcps --no-remote --no-remote-export \
  --no-auto-update --no-custom-instructions --no-ask-user \
  --disallow-temp-dir \
  --log-dir "$scratch/copilot-logs" --log-level none \
  -p "$(cat "$scratch/prompt.txt")" \
  > "$scratch/events.jsonl" 2> "$scratch/copilot.err"
chmod 600 "$scratch/events.jsonl"
```

**10. Validate structural topology.**

Require at least one opaque empty/no-tool frame and exactly one non-empty
tool-free terminal payload. Record the tool-bearing frame count but do not
gate on it. Print the safe structural count object before the gate, so the
counts are visible even if the gate below fails the block.

```bash
jq -r -s '{
  events:                   length,
  assistantMessages:        ([.[] | select(.type=="assistant.message")] | length),
  opaqueEmptyNoToolFrames:  ([.[] | select(.type=="assistant.message" and .data.content=="" and (.data.toolRequests|length)==0)] | length),
  toolBearingFrames:        ([.[] | select(.type=="assistant.message" and (.data.toolRequests|length)>0)] | length),
  nonEmptyToolFreePayloads: ([.[] | select(.type=="assistant.message" and (.data.content|length)>0 and (.data.toolRequests|length)==0)] | length)
}' "$scratch/events.jsonl" > "$scratch/structural.json"
jq . "$scratch/structural.json"
jq -e '.opaqueEmptyNoToolFrames >= 1 and .nonEmptyToolFreePayloads == 1' \
  "$scratch/structural.json"
```

**11. Extract agent response and run strict ingestion.**

Wrap both commands so a failure prints only the fixed structural failure
kind/status already carried in their own private status/result JSON, then
exits non-zero. Never print payload, candidate, or packet content.

```bash
set +e
node skills/review-pull-request/scripts/extract-agent-response.mjs \
  "$scratch/events.jsonl" "$scratch/response.json" \
  "$scratch/transport-status.json"
extract_exit=$?
set -e
jq -r '.status' "$scratch/transport-status.json"
if [ "$extract_exit" -ne 0 ]; then
  jq -r '.failure.kind' "$scratch/transport-status.json"
  exit 1
fi

set +e
node skills/review-pull-request/scripts/process-discovery.mjs ingest \
  "$scratch/response.json" "$scratch/results" "$scratch/diagnostics" \
  --agent prg-reliability --batch "$BATCH" --attempt 1
ingest_exit=$?
set -e
result_file="$scratch/results/prg-reliability-batch-$(printf '%03d' "$BATCH")-attempt-1.json"
jq -r '.status' "$result_file"
if [ "$ingest_exit" -ne 0 ]; then
  jq -r '.failure.kind' "$result_file"
  exit 1
fi
```

**12. Recheck remote SHAs and report.**

```bash
gh pr view "$PR" --repo "$REPO" \
  --json number,baseRefOid,headRefOid > "$scratch/final-shas.json"
jq -e --arg b "$EXPECTED_BASE" --arg h "$EXPECTED_HEAD" \
  '.baseRefOid == $b and .headRefOid == $h' "$scratch/final-shas.json"
printf 'Opt-in transport smoke passed\n'
```

The EXIT trap removes `$scratch` on completion. Do not redirect, copy, or
retain event, response, prompt, packet, result, or diagnostic files outside
the private scratch directory. No step writes to the PR, pushes a ref, or
executes code from the PR.
