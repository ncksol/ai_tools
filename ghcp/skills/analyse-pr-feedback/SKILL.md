---
name: analyse-pr-feedback
description: >- 
    Use this skill when the user asks to analyse, triage, classify, evaluate, or understand pull request review comments, reviewer feedback, requested changes, GitHub PR comments, Azure DevOps PR comments, or agent review feedback. This skill is analysis-only: it gathers review feedback, inspects the PR where possible, decides whether the feedback is valid, presents a concise issue table, and stops. It never edits code, commits, pushes, posts comments, or resolves threads.
---

# Analyse Pull Request Feedback

You are helping analyse pull request review feedback after a coding agent has implemented a feature and opened a PR.

Your job is not to satisfy every reviewer comment automatically. Your job is to understand the PR, understand each review comment, decide whether the feedback is valid, and present a clear decision table for the user to review.

This is an **analysis-only** skill.

Do not write code.

Do not edit files.

Do not implement fixes.

Do not prepare patches.

Do not make commits.

Do not push.

Do not post comments to the PR.

Do not resolve review threads.

The output of this skill is a triage report, not a code change.

The user may provide only a PR URL. Treat that as sufficient input.

## Core output

The main output must be a Markdown table with exactly these columns:

```text
| Issue # | Severity | Brief description | If we agree |
```

Use sequential issue numbers starting at 1.

The `If we agree` column must state your decision clearly. Use one of:

- Yes
- Partially
- No
- Already addressed
- Duplicate
- Needs clarification
- Out of scope
- Cannot verify

Keep the table concise, but make the brief description specific enough for the user to understand the issue without reading the original review comment.

After the table, include short notes only where useful, especially for:
- issues you disagree with
- partial agreement
- clarification needed
- duplicate comments
- out-of-scope comments
- comments that depend on product or business judgement
- comments that appear already addressed

End by clearly saying that no code was changed.

## Safety rules

You must only inspect and report.

Do not:
- edit files
- apply patches
- generate a patch file
- stage files
- commit
- push
- force push
- amend commits
- rebase
- merge
- complete, close, abandon, or update the PR
- approve the PR
- request changes
- vote on the PR
- post comments to the PR
- resolve threads
- use GitHub’s native Copilot PR reviewer
- run destructive commands
- make unrelated recommendations beyond the feedback being analysed

If the user asks you to fix the comments while this skill is active, do not fix them. Explain that this skill is analysis-only and provide the issue table so the user can decide what to do next.

Before changing branches or checking out a PR, inspect the working tree. If there are uncommitted changes, do not check out the PR. Continue with remote metadata and diff where possible.

## Core principle

For every review comment, maintain traceability:

Review comment → interpretation → severity → agreement decision → evidence → suggested next action.

Do not assume the reviewer is right.

Do not assume the original implementation is right.

Use the code, PR intent, project conventions, tests, and runtime behaviour to decide.

## Supported inputs

The user may provide:

- a GitHub PR URL
- an Azure DevOps / Azure Repos PR URL
- a local branch name
- a PR number, if the current repository context makes the provider and repository obvious
- pasted review comments
- pasted diff plus review comments

If the prompt contains a PR URL, use that URL as the source of truth.

If the provider or repository cannot be determined, ask for the full PR URL.

## Supported providers

Support:

- GitHub pull requests
- Azure DevOps / Azure Repos pull requests
- local PR branches
- pasted review comments

Do not assume all PRs are GitHub PRs.

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

If the provider cannot be determined, ask the user to provide the full PR URL.

## Overall workflow

1. Identify the PR provider.
2. Gather PR metadata.
3. Gather all review feedback.
4. Gather the PR diff.
5. Inspect local repository context and surrounding code where safely possible.
6. Understand the PR intent and changed areas.
7. Build an internal feedback ledger.
8. Triage each comment.
9. Decide whether you agree with each issue.
10. Present the required issue table.
11. Stop.

Do not proceed to implementation.

## Feedback ledger

Build an internal feedback ledger before producing the final table.

For each comment or thread, capture:

- issue number
- provider comment/thread ID, if available
- reviewer
- file and line, if applicable
- original comment summary
- requested change
- affected area
- category
- severity
- agreement decision
- evidence
- suggested next action

Use these categories:

- Correctness bug
- Edge case
- Security/auth/privacy
- Data consistency
- API contract
- Performance
- Test gap
- Maintainability
- Style/nit
- Question/clarification
- Duplicate
- Already addressed
- Out of scope
- Disagree / likely incorrect
- Cannot verify

Use these agreement decisions:

- Yes
- Partially
- No
- Already addressed
- Duplicate
- Needs clarification
- Out of scope
- Cannot verify

Group duplicate comments under one issue where they share the same root cause.

Do not create multiple issue rows for the same root cause unless the comments require materially different decisions.

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
gh pr view <PR_URL> --json number,title,body,baseRefName,headRefName,headRepository,headRepositoryOwner,files,commits,statusCheckRollup,reviews,comments,url
```

Gather PR diff:

```bash
gh pr diff <PR_URL> --patch
gh pr diff <PR_URL> --name-only
```

If local repository context is available and the working tree is clean, it is acceptable to check out the PR for inspection only:

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

If the working tree is not clean, do not check out the PR. Continue with PR metadata and diff.

If needed, use GitHub API to gather review details that are not visible through the simple PR view command:

```bash
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/reviews
gh api repos/<OWNER>/<REPO>/pulls/<PR_NUMBER>/comments
gh api repos/<OWNER>/<REPO>/issues/<PR_NUMBER>/comments
```

Interpret these separately:

- PR reviews: review summaries and states
- PR review comments: inline code comments
- issue comments: general PR conversation comments

Do not assume that a general PR comment refers to a specific line unless the comment or linked context makes that clear.

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

Gather PR threads/comments through Azure DevOps REST where needed:

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

If local repository context is available and the working tree is clean, it is acceptable to check out the PR for inspection only:

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

If checkout is not possible, continue with available PR metadata and review threads. Clearly state that surrounding-code inspection was limited.

Treat Azure DevOps threads as the source of reviewer comments. A thread may refer to a file/line, or it may be a general PR discussion.

## Local branch adapter

If the user gives a local branch or asks to analyse feedback for the current branch, inspect the local git state.

Start with:

```bash
git status
git branch --show-current
git remote -v
```

If review comments are not available from a PR provider, ask the user to paste the review comments or provide the PR URL.

If there is enough context, identify the likely base branch.

Prefer, in order:

1. the branch’s configured upstream target, if obvious
2. `origin/main`
3. `origin/master`
4. ask the user for the base branch if none can be inferred

Then inspect the diff:

```bash
git fetch origin
git diff origin/<baseBranch>...HEAD
```

Do not edit files.

## Pasted feedback adapter

If the user provides only pasted comments and no repository access is available:

- Analyse the pasted comments.
- Use the pasted diff or code context if available.
- Do not pretend to have inspected the repository.
- Mark issues as `Cannot verify` where repository context is needed.
- Ask for the PR URL or relevant code only if the comments cannot be triaged safely.

## Project context to inspect

Where available, inspect:

- `AGENTS.md`
- `CLAUDE.md`
- `.github/copilot-instructions.md`
- path-specific instruction files
- README files
- architecture or design documents
- package/build/test configuration
- nearby implementation patterns
- existing helper functions
- existing tests for the changed area
- type definitions
- API contracts
- database migrations
- infrastructure/configuration touched by the PR

Do not rely only on the comment text. A reviewer may be right about the symptom but wrong about the best solution.

Do not rely on memory for exact framework or library behaviour when the repository contains types, docs, examples, or existing usage.

## Analysis rules

When analysing comments:

- Compare the comment against the code, PR intent, project patterns, tests, and likely runtime behaviour.
- Prefer root-cause analysis over surface-level compliance.
- Distinguish actual bugs from style preferences.
- Identify duplicate comments and group them under one issue where appropriate.
- Identify conflicting reviewer requests.
- Identify comments that are already addressed by existing code.
- Identify comments that require product/business clarification.
- Identify comments that are out of scope for the PR.
- Identify comments that are technically wrong or based on a misunderstanding.
- Do not overstate certainty.
- Do not invent evidence.
- Do not invent line numbers.
- Do not claim to have run commands unless they actually ran.
- Do not claim to have inspected surrounding code unless it was actually inspected.

## Agreement decision guidance

Use `Yes` when the reviewer is right and the issue should be addressed.

Use `Partially` when the reviewer identified a real concern but the requested solution is incomplete, too broad, or not the best fix.

Use `No` when the comment is likely incorrect or would make the code worse.

Use `Already addressed` when the current PR code already handles the concern.

Use `Duplicate` when another issue row covers the same root cause.

Use `Needs clarification` when the comment is ambiguous or requires product/business judgement.

Use `Out of scope` when the comment is reasonable but should not be handled in this PR.

Use `Cannot verify` when the available code or context is insufficient to make a reliable judgement.

## Output format

Start with:

```text
Verdict: Feedback analysed
```

Then include:

```text
PR summary:
- Provider:
- PR:
- Base:
- Source:
- Apparent PR intent:
- Number of comments/threads reviewed:
- Local checkout inspected: Yes/No
- Surrounding code inspected: Yes/No
```

Then include the required table:

```md
| Issue # | Severity | Brief description | If we agree |
|---:|---|---|---|
| 1 | High | Example issue description. | Yes |
```

Then include:

```text
Notes:
- Issue X: brief explanation for disagreement, partial agreement, clarification, duplicate, already-addressed, out-of-scope, or cannot-verify decision.
```

Then include:

```text
Suggested next step:
- <short recommendation, such as “Address issues 1, 2, and 4 first” or “Ask for clarification on issue 3 before changing code”.>
```

End with:

```text
No code was changed.
```

## Output rules

The issue table must be concise and easy to scan.

Do not include implementation steps unless the user explicitly asks for high-level guidance.

Do not produce code snippets.

Do not produce patches.

Do not propose exact edits unless needed to explain why you agree or disagree.

Do not include a long implementation plan.

Every issue should map back to reviewer feedback, not to your own unrelated code review.

If you discover a serious new issue while inspecting the feedback, include it only if it is directly relevant to the reviewer feedback or materially changes whether the feedback is valid. Otherwise, say it belongs in a separate code review.

## If commands fail

If a command fails:

1. State which information could not be gathered.
2. Briefly explain the limitation.
3. Continue with the best available source of information.
4. Mark affected issues as `Cannot verify` where appropriate.

Common fallbacks:

- If checkout fails, use PR metadata and patch/diff.
- If PR metadata fails, use the URL and any accessible local branch.
- If provider auth fails, ask the user to authenticate with the relevant CLI.
- If line numbers are unavailable, reference file and nearest function/block.
- If comments cannot be fetched, ask the user to paste comments or provide access.

## Final reminder

The purpose of this skill is not to fix the PR.

The purpose is to help the user decide which review comments are valid, important, duplicated, out of scope, already addressed, or need clarification before any coding work begins.
