# GitHub PR commands

Reads with the `gh` CLI. Each one ran against a real, merged PR. No GitHub writes are verified here. The operating mode in `SKILL.md` applies.

## Context

```bash
GH_REPO='<owner>/<name>'
GH_OWNER='<owner>'
GH_NAME='<name>'
GH_PR='<PR number>'
```

## Reads (ran)

G1. PR state, draft, mergeability, head, base, review decision and checks:

```bash
gh pr view "$GH_PR" -R "$GH_REPO" \
  --json number,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,reviewDecision,statusCheckRollup \
  --jq '{number,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,reviewDecision,checks:[.statusCheckRollup[]?|{name,status,conclusion}]}'
```

G2. PR state through REST:

```bash
gh api "repos/$GH_REPO/pulls/$GH_PR" \
  --jq '{number,state,merged,mergeable,mergeable_state,head:.head.sha,base:.base.ref}'
```

G3. Review threads and whether each is resolved:

```bash
gh api graphql -F owner="$GH_OWNER" -F name="$GH_NAME" -F number="$GH_PR" \
  -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved isOutdated comments(first:1){nodes{databaseId body}}} pageInfo{hasNextPage endCursor}}}}}' \
  --jq '.data.repository.pullRequest.reviewThreads|{count:(.nodes|length),hasNextPage:.pageInfo.hasNextPage,threads:[.nodes[]|{id,isResolved,isOutdated}]}'
```

G4. Changed paths:

```bash
gh pr diff "$GH_PR" -R "$GH_REPO" --name-only
```

G5. Checks:

```bash
gh pr checks "$GH_PR" -R "$GH_REPO"
```

## Reading the results

- Take thread resolution from G3. REST review comments don't show it.
- G3 returns up to 100 threads. If `hasNextPage` is true, get the next page with the returned cursor before you say anything about all the threads.
- G5 exits 1 with "no checks reported" when a PR has no checks. That isn't a passing CI result: don't hide it behind a fallback that looks like success.
- On a merged or closed PR, `mergeable` can be `UNKNOWN` or `null`. That isn't an error.

## Writes

None are verified here. Use the tools your agent's rules name for writes. When your rules allow a write:

- reply to a review comment inside its thread, to the thread's root comment, not as a top-level PR comment;
- merge with an explicit merge method, and keep the source branch;
- check the head commit before a merge, and after a write whose result is unclear, read the PR again instead of repeating the write.
