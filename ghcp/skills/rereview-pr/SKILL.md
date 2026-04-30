---
name: rereview-pr
description: >-
  Use this skill when the user asks to re-review, rereview, follow up on,
  verify fixes for, or reassess a pull request after an earlier review has
  already found issues and requested changes. This skill is focused on the
  re-review cycle: it verifies whether previous findings were addressed,
  evaluates engineer replies or pushback, inspects only relevant new changes,
  and reports remaining blockers without performing a full fresh review.
---

# Re-review Pull Request

You are performing a focused pull request re-review.

This skill is for the second or later review cycle, after a previous review has already happened.

Typical situation:

- A coding agent or engineer implemented a feature.
- A PR was opened.
- The PR was reviewed already, often using a stricter first-pass review.
- Issues were raised and changes were requested.
- The engineer has since pushed fixes, replied to comments, or pushed back on some findings.
- The user now wants a focused re-review.

Your job is to answer:

1. Were the previous findings actually addressed?
2. Are the engineer’s replies or pushback valid?
3. Did the fixes introduce any obvious regressions in the affected areas?
4. Are there any remaining blockers before approval?

This is **not** a fresh broad code review.

Do not repeat the full strict-code-review checklist unless a new change clearly requires it.

## Operating mode

This is an inspection and reporting skill.

Do not edit files.

Do not apply patches.

Do not commit.

Do not push.

Do not post comments to the PR unless the user explicitly asks.

Do not approve, request changes, merge, complete, abandon, or close the PR.

The output should help the user decide whether to approve, request more changes, or reply to the engineer.

## Core principle

A re-review should be narrower than a first review.

Focus on:

- previous review findings
- unresolved threads
- engineer replies
- requested changes
- new commits pushed after the previous review
- code paths touched by the fix
- tests added or changed to cover the fix
- obvious regressions caused by the fix

Do not go hunting for unrelated new issues across the whole PR.

If you notice a severe unrelated issue while inspecting the fix, mention it separately as a “new severe concern”, but do not turn the re-review into a full audit.

## Supported providers

Support:

- GitHub pull requests
- Azure DevOps / Azure Repos pull requests
- local PR branches with pasted review feedback
- pasted PR comments and diffs

Do not assume the PR is hosted on GitHub.

## Provider detection

If the URL contains `github.com` and `/pull/`, treat it as a GitHub PR.

Examples:

```text
https://github.com/org/repo/pull/123
https://github.com/org/repo/pull/123/files
```

If the URL contains `dev.azure.com` or `visualstudio.com` and `/pullrequest/`, treat it as an Azure DevOps PR.

Examples:

```text
https://dev.azure.com/org/project/_git/repo/pullrequest/123
https://org.visualstudio.com/project/_git/repo/pullrequest/123
```

If the provider cannot be determined, ask the user for the full PR URL or the review comments to re-check.

## Inputs

The user may provide:

- a PR URL
- a PR number, if the current repository context is obvious
- a local branch
- pasted previous findings
- pasted review threads
- pasted engineer replies
- pasted diff since the previous review

If the user provides only the PR URL, use the provider tools to gather the previous review comments, engineer replies, and current diff.

If you cannot identify which comments belong to the earlier review, focus on:

- unresolved threads
- comments requesting changes
- comments after the first review
- reviewer comments with direct engineer replies
- comments that mention bugs, blockers, security, correctness, tests, or requested changes

State any uncertainty clearly.

## Safety rules

You must only inspect and report.

Do not:

- edit files
- generate patches
- stage files
- commit
- push
- force push
- rebase
- merge
- complete, close, abandon, or update the PR
- approve the PR
- request changes
- vote on the PR
- post comments to the PR
- resolve review threads
- use GitHub’s native Copilot PR reviewer
- run destructive commands

Before checking out a PR, inspect the working tree.

If the working tree is not clean, do not check out the PR. Continue with remote metadata, comments, and diff where possible.

## Overall workflow

1. Identify the provider.
2. Gather PR metadata.
3. Gather review threads, inline comments, general comments, and reviewer decisions.
4. Identify the previous findings and the engineer’s responses.
5. Identify commits or file changes made after the previous review where possible.
6. Inspect the current diff and relevant surrounding code.
7. For each previous finding, decide whether it is resolved, partially resolved, unresolved, invalid, or needs clarification.
8. Check whether the fix introduced obvious regressions in the same affected area.
9. Produce a focused re-review report.
10. Stop.

Do not implement fixes.

## Re-review scope

The default scope is:

- previously raised issues
- unresolved review threads
- engineer replies to review comments
- new commits since the previous review
- tests or verification added to address review feedback
- nearby code needed to judge whether the fix works

Out of scope by default:

- broad full-PR review
- style or naming nits
- unrelated files
- architectural re-litigation
- new wishlist improvements
- issues that existed before the PR and were not part of the earlier review
- repeating comments already handled correctly

## Status decisions

Use these statuses for each previous finding:

### Resolved

The concern was valid and the current PR now addresses it sufficiently.

### Partially resolved

The engineer made a relevant change, but the issue is not fully handled, or the implementation only covers some cases.

### Unresolved

The concern remains materially valid and should still block approval or require another change.

### Pushback accepted

The engineer pushed back, and after inspecting the code and context, their reasoning is valid.

### Pushback rejected

The engineer pushed back, but the original concern remains valid.

### Already addressed

The concern was already addressed before the latest changes, or the original review likely missed existing handling.

### Duplicate

The concern is covered by another finding or thread.

### Needs clarification

The right answer depends on product, business, UX, API contract, or ownership assumptions that are not clear from the code.

### Cannot verify

Available PR data, comments, diff, or local context is insufficient to decide.

## Severity definitions

Use these severity levels.

### Critical

Use for issues likely to cause:

- production outage
- data loss
- security vulnerability
- privacy breach
- broken core user flow
- financial loss
- irreversible migration failure

### High

Use for:

- real bug likely to affect users
- serious security weakness
- serious data consistency issue
- risky deployment issue
- important missing validation
- likely production failure in realistic conditions

### Medium

Use for:

- meaningful issue worth fixing
- edge case likely enough to matter
- test gap that could hide a real bug
- maintainability issue that materially increases risk

### Low

Use for:

- small improvement
- minor maintainability concern
- optional clarity improvement
- style/nit comments that are still reasonable

### Info

Use for:

- reviewer questions
- non-actionable comments
- comments that require clarification
- comments that are already addressed
- comments that are duplicates
- comments that cannot be verified from available context

## GitHub PR adapter

For GitHub PRs, use GitHub CLI and GitHub API where available.

Use the PR URL directly where possible.

Gather PR metadata:

```bash
gh pr view <PR_URL> --json number,title,body,baseRefName,headRefName,headRepository,headRepositoryOwner,files,commits,statusCheckRollup,reviews,comments,url,reviewDecision
```

Gather the current diff:

```bash
gh pr diff <PR_URL> --patch
gh pr diff <PR_URL> --name-only
```

Gather review summaries, inline review comments, and general PR comments:

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments
gh api repos/<OWNER>/<REPO>/issues/<PR_NUMBER>/comments
```

Interpret these separately:

- PR reviews: review summaries, approvals, requested changes, and review-level comments
- PR review comments: inline code comments and replies
- issue comments: general PR conversation comments

Where useful, use GraphQL to inspect review threads and resolved state, because REST results may not expose all thread-resolution details consistently:

```bash
gh api graphql -f query='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewDecision
      reviewThreads(first:100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first:50) {
            nodes {
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}' -F owner=<OWNER> -F repo=<REPO> -F number=<PR_NUMBER>
```

If local repository context is available and the working tree is clean, check out the PR for inspection only:

```bash
git status
gh pr checkout <PR_URL>
git status
git fetch origin
```

After checkout, compare the PR branch against its base branch:

```bash
git diff origin/<baseRefName>...HEAD
```

To focus on changes since the previous review, identify the latest relevant review timestamp from the review/comments data, then inspect commits after that time where possible:

```bash
git log --oneline --decorate --since="<REVIEW_TIMESTAMP>"
```

If a review timestamp cannot be determined, inspect the most recent commits and compare them to the unresolved threads and engineer replies.

If checkout is not possible, continue with PR metadata, review comments, and patch. Clearly state that local surrounding-code inspection was limited.

## Azure DevOps PR adapter

For Azure DevOps PRs, use Azure CLI and Azure DevOps REST APIs where available.

Extract the PR ID from the URL segment after `/pullrequest/`.

For:

```text
https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
```

extract:

- organisation: `<org>`
- project: `<project>`
- repository: `<repo>`
- PR ID: `<id>`

Gather PR metadata:

```bash
az repos pr show --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>" --output json
```

Gather linked work items where available:

```bash
az repos pr work-item list --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>" --output json
```

Gather PR policy/status information where available:

```bash
az repos pr policy list --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>" --output json
```

Gather PR threads/comments:

```bash
az devops invoke \
  --area git \
  --resource pullRequestThreads \
  --route-parameters project="<PROJECT>" repositoryId="<REPO>" pullRequestId="<PR_ID>" \
  --org https://dev.azure.com/<ORG> \
  --api-version 7.1 \
  --http-method GET \
  --output json
```

Treat Azure DevOps threads as the primary source of reviewer comments, engineer replies, active/resolved thread state, file context, and review discussion.

If local repository context is available and the working tree is clean, check out the PR for inspection only:

```bash
git status
az repos pr checkout --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>"
git status
git fetch origin
```

From `az repos pr show`, identify:

- `sourceRefName`
- `targetRefName`
- PR title
- PR description
- repository
- reviewers
- status

Normalise branch refs.

For example:

```text
refs/heads/main
```

becomes:

```text
main
```

Then compare the checked-out source branch against the target branch:

```bash
git diff origin/<targetBranch>...HEAD
```

To focus on changes since the previous review, use PR thread timestamps and git history where possible:

```bash
git log --oneline --decorate --since="<REVIEW_TIMESTAMP>"
```

If checkout is not possible, continue with PR metadata and review threads. Clearly state that local surrounding-code inspection was limited.

## Local or pasted feedback adapter

If the user provides pasted previous findings, engineer replies, or review comments:

- Use the pasted feedback as the source of truth.
- Analyse each previous finding and reply.
- Use local git diff where available.
- Do not pretend to have fetched PR comments.
- Mark items as `Cannot verify` where repository context is needed.

If only a local branch is available and no review comments are accessible, ask the user to paste the previous findings or provide the PR URL.

## Project context to inspect

Where relevant, inspect:

- files mentioned in review comments
- current code around the changed lines
- tests added or changed in response to feedback
- existing tests for the changed area
- nearby implementation patterns
- existing helper functions
- type definitions
- API contracts
- database migrations
- package/build/test configuration
- `AGENTS.md`
- `CLAUDE.md`
- `.github/copilot-instructions.md`
- README files
- architecture or design documents

Do not rely only on the review comment text. A reviewer may be right about the symptom but wrong about the fix.

Do not rely on memory for exact framework or library behaviour when the repository contains types, docs, examples, or existing usage.

## Re-review analysis rules

When analysing the follow-up:

- Start from the previous findings, not from a blank-slate review.
- Verify whether each concern is still valid in the current PR.
- Evaluate engineer replies fairly.
- Accept valid pushback when the original concern was wrong or already handled.
- Reject pushback when the original concern remains valid.
- Check whether added tests actually cover the concern.
- Check whether the fix handles the relevant edge cases, not just the happy path.
- Check whether the fix changes public behaviour or contracts unexpectedly.
- Check whether the fix introduces a new issue in the same affected area.
- Do not re-raise old comments if they are fixed.
- Do not invent new requirements.
- Do not escalate style disagreements into blockers.
- Do not make a broad list of new unrelated issues.
- Do not overstate certainty.
- Do not invent line numbers.
- Do not claim to have run commands unless they actually ran.
- Do not claim to have inspected surrounding code unless it was actually inspected.

## How to judge engineer replies

For each engineer reply or pushback, decide whether it is supported by evidence.

Accept pushback when:

- the code already handles the claimed issue
- the reviewer misunderstood the data flow
- the requested change would break the intended behaviour
- the requested change is outside the PR scope
- the issue depends on a product decision that has not been made
- the engineer added a test that proves the concern is handled
- the project has an established pattern that supports the implementation

Reject pushback when:

- the edge case is still unhandled
- the code only handles the happy path
- the test does not actually exercise the failure mode
- the explanation contradicts the code
- the code relies on an unsafe assumption
- the comment exposes a security, auth, data, or correctness risk
- the fix masks the symptom rather than addressing the root cause
- the engineer says it is out of scope but the issue was introduced by this PR

Mark as `Needs clarification` when:

- the correct behaviour depends on product or business rules
- API compatibility expectations are unclear
- ownership or tenancy semantics are unclear
- reviewer and engineer are making different valid assumptions
- more information is needed before approval is safe

## Output format

Start with:

```text
Verdict: Ready to approve / Still needs changes / Needs clarification / Cannot complete re-review
```

Then include:

```text
PR summary:
- Provider:
- PR:
- Base:
- Source:
- Previous review source:
- New commits or replies inspected:
- Local checkout inspected: Yes/No
- Surrounding code inspected: Yes/No
```

Then include the main re-review table:

```md
| Issue # | Previous concern | Engineer response/fix | Status | Severity now | Re-review decision |
|---:|---|---|---|---|---|
| 1 | Brief summary of the original concern. | Brief summary of the reply or fix. | Resolved | Info | Accept the fix. |
```

Use these `Status` values:

- Resolved
- Partially resolved
- Unresolved
- Pushback accepted
- Pushback rejected
- Already addressed
- Duplicate
- Needs clarification
- Cannot verify

Use these `Severity now` values:

- Critical
- High
- Medium
- Low
- Info

Then include:

```text
Remaining blockers:
- Issue #:
  Reason:
```

If there are no blockers, write:

```text
Remaining blockers:
- None found in the re-review scope.
```

Then include:

```text
Suggested reviewer replies:
- Issue #:
  Suggested reply:
```

Replies should be concise and professional.

Then include:

```text
Checks or evidence used:
- <command, file, thread, test, or code area inspected>
```

End with:

```text
No code was changed.
```

## Suggested reviewer reply style

For a resolved issue:

```text
Thanks, this addresses my concern. The updated code now handles the missing validation path and the added test covers the case I was worried about.
```

For a partially resolved issue:

```text
This is moving in the right direction, but I think one case is still uncovered: <brief reason>. Could you also handle <specific case>?
```

For rejected pushback:

```text
I see the reasoning, but I think the original concern still applies because <brief code-based reason>. The current change still allows <failure mode>.
```

For accepted pushback:

```text
That makes sense. I re-checked the current flow and agree this is already handled by <specific code path/helper/test>.
```

For clarification:

```text
I think this depends on the intended product/API behaviour. Before requesting a code change, can we confirm whether <specific behaviour> is expected?
```

## Verdict guidance

Use:

```text
Ready to approve
```

when all material previous findings are resolved, valid pushback is accepted, and no obvious regressions were introduced in the re-review scope.

Use:

```text
Still needs changes
```

when at least one material previous finding remains unresolved or partially resolved in a way that should block approval.

Use:

```text
Needs clarification
```

when the remaining decision depends on unclear product, API, ownership, or reviewer assumptions.

Use:

```text
Cannot complete re-review
```

when comments, diff, or PR context cannot be accessed sufficiently.

## If commands fail

If a command fails:

1. State which information could not be gathered.
2. Briefly explain the limitation.
3. Continue with the best available information.
4. Mark affected issues as `Cannot verify` where appropriate.

Common fallbacks:

- If checkout fails, use PR metadata, review comments, and patch/diff.
- If review threads cannot be fetched, use review summaries and general comments.
- If provider auth fails, ask the user to authenticate with the relevant CLI.
- If line numbers are unavailable, reference file and nearest function/block.
- If previous findings cannot be identified, ask the user to paste the previous review or specify which reviewer/comments to re-check.

## Output rules

Keep the re-review focused and concise.

Do not include a full strict review.

Do not include unrelated findings unless they are severe and discovered directly while validating the fix.

Do not include code snippets unless needed to explain a decision.

Do not produce patches.

Do not recommend broad refactors.

Do not repeat fixed issues as if they are still problems.

Every unresolved or rejected-pushback issue must include a concrete reason.

Every accepted-fix decision should mention the evidence that made it acceptable.

## Final reminder

The purpose of this skill is to close the review loop.

Focus on whether previous concerns were handled correctly, whether pushback is valid, and whether the PR is now safe to approve within the scope of the earlier review.
