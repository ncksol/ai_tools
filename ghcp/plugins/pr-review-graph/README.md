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
   A routed batch that remains invalid after one retry fails the review before verification; partial coverage is never reported as a clean review.
   Every machine-response stage extracts the raw final assistant payload from Copilot JSONL; rendered transcript text is never parsed as agent JSON. Empty assistant messages are structural frames regardless of tool requests and remain subject to assistant-turn validation.
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

This manual smoke invokes Copilot and is intentionally excluded from `npm test`.
It allows only the `skill` tool, retains all output in a private temporary
directory, reports structural counts only, and removes the directory on exit.

```bash
set -euo pipefail
umask 077
tmp="$(mktemp -d "${TMPDIR:-/tmp}/prg-transport-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
events="$tmp/events.jsonl"
response="$tmp/response.json"
status="$tmp/status.json"
results="$tmp/results"
diagnostics="$tmp/diagnostics"

copilot --output-format json --stream off --silent \
  --available-tools=skill --allow-tool=skill --effort high \
  -p 'Invoke the gh-cli skill. Do not call another tool. After reading the skill, return exactly [] with no prose.' \
  > "$events"

jq -e -s '
  {
    assistantMessages: ([.[] | select(.type == "assistant.message")] | length),
    emptyNoToolFrames: ([
      .[]
      | select(
          .type == "assistant.message"
          and .data.content == ""
          and (.data.toolRequests | length) == 0
        )
    ] | length),
    toolBearingEmptyFrames: ([
      .[]
      | select(
          .type == "assistant.message"
          and .data.content == ""
          and (.data.toolRequests | length) > 0
        )
    ] | length),
    nonEmptyPayloads: ([
      .[]
      | select(
          .type == "assistant.message"
          and (.data.content | length) > 0
          and (.data.toolRequests | length) == 0
        )
    ] | length)
  }
  | select(
      .emptyNoToolFrames > 0
      and .toolBearingEmptyFrames > 0
      and .nonEmptyPayloads == 1
    )
' "$events"

node skills/review-pull-request/scripts/extract-agent-response.mjs \
  "$events" "$response" "$status"
mkdir -m 700 "$results" "$diagnostics"
node skills/review-pull-request/scripts/process-discovery.mjs ingest \
  "$response" "$results" "$diagnostics" \
  --agent prg-reliability --batch 1 --attempt 1
jq -e '
  .status == "complete"
  and .category == "reliability"
  and (.findings | length) == 0
' "$results/prg-reliability-batch-001-attempt-1.json" >/dev/null
printf '%s\n' 'Opt-in transport smoke passed'
```

Run it only from `ghcp/plugins/pr-review-graph`. Do not redirect, copy, or
retain the event or response files outside the private temporary directory.
