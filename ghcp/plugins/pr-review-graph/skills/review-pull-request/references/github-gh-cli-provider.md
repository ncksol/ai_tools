# GitHub provider through `gh-cli`

First load and follow the separately installed `gh-cli` skill. Use its authentication, repository-resolution, output, pagination, and safety conventions when they are more specific than this provider contract. Use Bash and its authenticated `gh` CLI commands. Do not use a GitHub MCP server, install GitHub CLI, request a token, or reproduce the provider skill inside this plugin.

The bundled collection and payload scripts are deterministic helpers for PR Review Graph. They do not replace `gh-cli`.

## Collection

Prefer `scripts/collect-github.sh`, which performs these reads and normalizes them:

```bash
gh repo view --json nameWithOwner,url,defaultBranchRef
gh pr view <PR> --json number,title,body,author,url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,commits,statusCheckRollup,reviewDecision,closingIssuesReferences
gh pr diff <PR> --patch
gh api --paginate --slurp repos/<OWNER>/<REPO>/pulls/<NUMBER>/files?per_page=100
gh api --paginate --slurp repos/<OWNER>/<REPO>/pulls/<NUMBER>/comments?per_page=100
gh api --paginate --slurp repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews?per_page=100
gh api --paginate --slurp repos/<OWNER>/<REPO>/issues/<NUMBER>/comments?per_page=100
gh pr checks <PR> --json name,state,link,bucket
```

Flatten paginated page arrays before normalization. Collect review comments, review bodies, and issue conversation comments because GitHub exposes feedback in separate surfaces. Deduplication must receive all three surfaces, including bot comments and outdated inline comments; do not filter them by author, state, path, or line.

## Targeted unchanged context

Prefer immutable local Git objects when present:

```bash
git show <BASE_OR_HEAD_SHA>:<PATH>
```

When the object is unavailable locally, read the file at the captured commit through `gh api` with the GitHub raw-content media type. URL-encode the path before constructing the endpoint. Retrieve only files needed to prove or disprove a candidate; do not replace the captured snapshot with the current working tree.

## Snapshot integrity

Recheck immediately before publication:

```bash
gh pr view <PR> --json headRefOid --jq .headRefOid
```

Abort when it differs from `pullRequest.head.sha` in the packet.

## Publication

Generate a single batched review payload with `build-github-review.mjs`, then publish it only after confirmation:

```bash
gh api \
  --method POST \
  repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews \
  --input <REVIEW_PAYLOAD_JSON>
```

Use `event: COMMENT` by default. Do not use `gh pr review --approve`, `--request-changes`, merge commands, or branch-editing commands.

The review builder puts stable changed-line findings in `comments` and moves findings without a valid diff coordinate into the review body. If GitHub rejects an inline coordinate, do not retry it blindly; refresh the head and diff, then preview the summary-only fallback.

## Forks and permissions

Read operations may work when review publication does not. Treat a permission failure as a stop condition. Do not attempt to change authentication scopes or use another identity.

## Duplicate marker

Published comments end with:

```html
<!-- pr-review-graph:<64 lowercase hex characters> -->
```

Suppress a finding when its marker already exists anywhere in the PR feedback. Also suppress semantic duplicates even when the existing comment was written by a human.
