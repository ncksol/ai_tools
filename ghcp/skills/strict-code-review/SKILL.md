---
name: strict-code-review
description: Use this skill whenever the user asks to review a pull request, PR URL, merge request, branch diff, GitHub PR, Azure DevOps PR, Azure Repos PR, or code review link. It detects the provider, gathers PR context, checks out or diffs the change locally where possible, and performs a strict senior-engineer review without posting comments or modifying code.
---

# Strict Pull Request Review

You are performing a strict but pragmatic senior-engineer pull request review.

The user may provide only a PR URL. Treat that as sufficient input.

Your goal is to find real issues introduced or made worse by the PR before it is merged. Do not rubber-stamp the implementation. Do not rewrite code unless explicitly asked. Do not produce generic advice.

## Supported providers

This skill supports:

- GitHub pull request URLs
- Azure DevOps / Azure Repos pull request URLs

The workflow must be provider-neutral. Do not assume the PR is hosted on GitHub.

## Safety rules

You must only inspect and report.

Do not:

- post comments to the PR
- use GitHub’s native Copilot PR reviewer
- approve the PR
- reject the PR
- vote on the PR
- request changes on the PR
- complete, merge, close, abandon, or update the PR
- modify files
- commit
- push
- run destructive commands
- check out the PR, change branches, stash, reset, or clean the working tree

Leave the user’s working tree as you found it, including uncommitted changes. Read the PR from Git objects or from the provider instead (see the adapters).

## Inputs

The user may provide one of:

- a GitHub PR URL
- an Azure DevOps PR URL
- a local branch name
- a PR number, if the current repository context makes the provider and repository obvious
- a pasted diff

If the prompt contains a PR URL, use that URL as the source of truth.

If the user gave a PR number or URL and its provider or repository cannot be determined, ask for the full PR URL.

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

A local branch or a pasted diff has no provider. Use the local-only branch adapter or the pasted diff adapter, and give `Local branch` or `Pasted diff` as the provider in the report.

If a PR’s provider cannot be determined, ask the user to provide the full PR URL.

## General review flow

When reviewing a PR:

1. Identify the PR provider, or that the input is a local branch or a pasted diff.
2. Gather PR metadata.
3. Find the base and head commits, and gather the diff between them.
4. Inspect surrounding code at the head commit, without switching branches.
5. Read project-specific instructions and nearby implementation patterns.
6. Review the PR against its stated intent.
7. Report only concrete issues introduced or made worse by this PR.

Do not review only the raw diff if you can read the repository at the head commit. Diffs often hide important control flow, type definitions, configuration, tests, and existing helper functions.

## Base and head commits

The adapters below give you a base commit, `<BASE_SHA>`, and a head commit, `<HEAD_SHA>`, except for a pasted diff and a GitHub PR without a local clone. In those two cases, report every commit you cannot know as `unavailable`. Review the change between the two commits from Git objects. No checkout is needed, so this works even when the working tree has uncommitted changes or another branch is checked out. Run Git commands in the repository under review; if the user gave its path, use `git -C <path> …`. A pipeline returns the exit status of its last command, so also check that the first command succeeded (for example, start the command with `set -o pipefail;`).

```bash
git merge-base <BASE_SHA> <HEAD_SHA>
git diff <BASE_SHA>...<HEAD_SHA>
git ls-tree -r --name-only <HEAD_SHA>
git show <HEAD_SHA>:<path> | cat -n
git grep -n '<pattern>' <HEAD_SHA> -- <pathspec>
```

- `git merge-base` prints `<MERGE_BASE>`. The three-dot diff compares `<HEAD_SHA>` with `<MERGE_BASE>`, not with `<BASE_SHA>`, so later changes on the base branch are left out. Review only this diff.
- Read code at `<HEAD_SHA>`, never from the working tree: it may hold another branch or uncommitted edits. `cat -n` adds the line numbers you cite.
- When you need the old side, such as a deleted file or the code around a removed line, read it at `<MERGE_BASE>` and take old-side line numbers from there.
- Report the base and head refs and the three commits.

Before you report, check the commits again as the adapter describes:

- If the head commit changed, or the PR now targets another base branch, start the adapter again.
- If only the base commit changed, get the new base commit the same way and run `git merge-base <NEW_BASE_SHA> <HEAD_SHA>`. If it prints `<MERGE_BASE>` again, the diff has not changed and your review stands. If not, review the new diff.
- If anything changes again during the second review, report the commits you reviewed and say that the branch or PR has changed since.

## GitHub PR adapter

For GitHub PRs, prefer GitHub CLI.

Use the PR URL directly where possible. `<OWNER>`, `<REPO>` and `<NUMBER>` come from the URL. If you have only a PR number, run `gh pr view <NUMBER> --json url` in the repository and use the URL it prints.

Gather PR metadata:

```bash
gh pr view <PR_URL> --json number,title,body,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,files,commits,statusCheckRollup,reviews,comments,url
```

`headRefOid` is the head commit, `<HEAD_SHA>`. Review that commit and no other. Do not use `baseRefOid` as the base commit: GitHub does not update it every time the base branch moves.

Run `git --no-optional-locks status --short` and `git remote -v`, and find the remote that points at `<OWNER>/<REPO>`. In a fork workflow this is often `upstream`, not `origin`. If one matches, fetch the PR head and the base branch from it:

```bash
git fetch <REMOTE> refs/pull/<NUMBER>/head
git rev-parse FETCH_HEAD
git fetch <REMOTE> refs/heads/<baseRefName>
git rev-parse FETCH_HEAD
```

The first `git rev-parse FETCH_HEAD` must print `<HEAD_SHA>`; if it does not, the PR changed after `gh pr view`, so start again. The second prints `<BASE_SHA>`, the current tip of the base branch. Then follow "Base and head commits". `git diff --name-only <BASE_SHA>...<HEAD_SHA>` should list the same files as `gh pr diff <PR_URL> --name-only`; if it does not, say which files differ. To check the commits again before you report, run:

```bash
gh pr view <PR_URL> --json baseRefName,headRefOid
git ls-remote <REMOTE> refs/heads/<baseRefName> refs/pull/<NUMBER>/head
```

If no remote matches, the current directory is not a clone of this repository, so do not fetch into it. Review GitHub’s net diff instead. Do not use `--patch`: it prints one patch per commit, not the net change of the PR.

```bash
DIFF=$(gh pr diff <PR_URL>) && printf '%s\n' "$DIFF" | git hash-object --stdin && printf '%s\n' "$DIFF"
gh pr view <PR_URL> --json baseRefName,headRefOid
```

Run the first line as one command. It stops if `gh pr diff` fails; otherwise it prints the hash of the diff and then the diff itself, so the hash identifies exactly what you review. Do not treat a failed retrieval as an empty PR. If the second command does not print the `baseRefName` and `<HEAD_SHA>` from your first `gh pr view`, the PR changed while you fetched the diff: start again. Report `<HEAD_SHA>` and the hash; the base and merge-base commits are `unavailable`. The old side of this diff is the merge base. Read other files at the head commit:

```bash
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/<OWNER>/<REPO>/contents/<path>?ref=<HEAD_SHA>'
```

Before you report, run `DIFF=$(gh pr diff <PR_URL>) && printf '%s\n' "$DIFF" | git hash-object --stdin` and `gh pr view <PR_URL> --json baseRefName,headRefOid` again. If the hash, the base branch or the head commit changed, start again. If they change again, report the commits you reviewed and say that the PR has changed since. If either command fails, say that you could not check the PR again.

If a fetch or `git merge-base` fails, use the steps for a directory that is not a clone. If you cannot read files at the head commit either, review the checked `gh pr diff` output and state clearly that surrounding-code inspection was limited.

## Azure DevOps PR adapter

For Azure DevOps PRs, prefer Azure CLI with the Azure DevOps extension.

Extract the PR ID from the URL segment after `/pullrequest/`.

For a URL like:

```text
https://dev.azure.com/org/project/_git/repo/pullrequest/123
```

the PR ID is:

```text
123
```

Take the organisation, project and repository from the URL. Do not rely on `az devops configure` defaults or on detection from the current Git remote: PR IDs are unique only within an organisation, so another organisation can return a different PR with the same ID. If you have only a PR ID, build the URL from the remote that points at Azure DevOps (`git remote -v`).

For `dev.azure.com` URLs:

```text
https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
```

the organisation URL, `<ORG_URL>`, is `https://dev.azure.com/<org>`. For `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>/pullrequest/<id>` URLs, it is also `https://dev.azure.com/<org>`. URL-decode `<project>` and `<repo>` (for example, `%20` becomes a space).

Pass `--org <ORG_URL> --detect false` to every `az repos pr` command. The three commands below do not accept `--project`; do not pass it.

Gather PR metadata, linked work items and policy status:

```bash
az repos pr show --id <PR_ID> --org <ORG_URL> --detect false --output json
az repos pr work-item list --id <PR_ID> --org <ORG_URL> --detect false --output json
az repos pr policy list --id <PR_ID> --org <ORG_URL> --detect false --output json
```

Check that `repository.name` and `repository.project.name` in the `show` result match `<repo>` and `<project>` from the URL, ignoring case. If they do not, stop and report the mismatch: this is not the PR the user asked for.

From `az repos pr show`, identify:

- `sourceRefName`
- `targetRefName`
- `forkSource`, if present
- PR title
- PR description
- repository
- reviewers
- status

In the report, shorten branch refs (`refs/heads/main` becomes `main`). Use the full ref names in Git commands.

Get the diff from Git, without switching the user’s branch. Do not use `az repos pr checkout`: before it checks out the branch, it asks Azure DevOps to mark the source branch as one of your favourites, which is a write to the service. `az repos` has no command that prints the PR diff.

Run `git --no-optional-locks status --short` and `git remote -v`, and find two remotes before you fetch anything:

- `<BASE_REMOTE>` points at the PR’s repository. Its URL names the same organisation, project and repository, for example `dev.azure.com/<org>/<project>/_git/<repo>`, `<org>.visualstudio.com/<project>/_git/<repo>`, or `v3/<org>/<project>/<repo>` over SSH. Names in remote URLs may be URL-encoded.
- `<HEAD_REMOTE>` is the same remote, unless `forkSource` is present. Then it must point at the fork’s repository, `forkSource.repository`.

```bash
git fetch <BASE_REMOTE> <targetRefName>
git rev-parse FETCH_HEAD
git fetch <HEAD_REMOTE> <sourceRefName>
git rev-parse FETCH_HEAD
```

The first `git rev-parse FETCH_HEAD` prints `<BASE_SHA>` and the second prints `<HEAD_SHA>`. Then follow "Base and head commits". To check the commits again before you report, run:

```bash
az repos pr show --id <PR_ID> --org <ORG_URL> --detect false --query "[targetRefName, sourceRefName]" --output json
git ls-remote <BASE_REMOTE> <targetRefName>
git ls-remote <HEAD_REMOTE> <sourceRefName>
```

If a remote is missing, do not add one, and do not fetch. If a remote is missing or a fetch fails, you cannot see the code, so do not review the metadata alone. Report that the review is incomplete, show the failed step, and ask for a local clone with the needed remotes, or a pasted diff.

## Local-only branch adapter

Use this adapter when the user names a local branch or asks you to review the current branch. Use any title, description or intent that the user gives you as the PR metadata.

Start with:

```bash
git --no-optional-locks status --short
git branch --show-current
git remote -v
```

Use full ref names, such as `refs/heads/<name>` or `refs/remotes/<REMOTE>/<name>`, so that a tag with the same name is never used instead.

Set the head, `<HEAD_REF>`:

- If the user named a branch, use `refs/heads/<name>`, even when another branch is checked out. Check it with `git rev-parse --verify refs/heads/<name>`. If there is no local branch with that name, list remote-tracking branches with `git branch -r --list '*/<name>'`. If exactly one matches, use it and say so; if several match, ask which one. If none matches, check the remote with `git ls-remote --heads <REMOTE> refs/heads/<name>`; if it has the branch, refresh it (see below) and use `refs/remotes/<REMOTE>/<name>`.
- If the user asked you to review the current branch, use `HEAD`.

`<BRANCH>` is the head branch’s name. `<REMOTE>` is the remote for the repository you merge into: `upstream` in a fork workflow, otherwise usually `origin`. Set the base, `<BASE_REF>`, from the first of these that applies:

1. the base branch the user named, as `refs/heads/<name>` or `refs/remotes/<REMOTE>/<name>`, whichever exists. If both exist and point at different commits, refresh the remote one (see below), then use whichever contains the other (`git merge-base --is-ancestor <A> <B>` succeeds when `<B>` contains `<A>`). If they have diverged, ask which one to use.
2. the target branch of an open PR from `<BRANCH>`, if exactly one open PR has `<BRANCH>` as its source branch and that PR’s head commit is in the head’s history (`git merge-base --is-ancestor <PR head commit> <HEAD_REF>` succeeds). GitHub: `gh pr list --head <BRANCH> --state open --json baseRefName,headRefOid,url`. Azure DevOps: `az repos pr list --source-branch <BRANCH> --status active --org <ORG_URL> --project <PROJECT> --repository <REPO> --detect false --output json`, with the names taken from the remote URL; the PR’s head commit is `lastMergeSourceCommit.commitId`. Use the remote-tracking ref of the remote that points at the PR’s repository.
3. the default branch of `<REMOTE>`: `git ls-remote --symref <REMOTE> HEAD` prints it as `ref: refs/heads/<name>`, so use `refs/remotes/<REMOTE>/<name>`. If the remote cannot be reached, `git symbolic-ref refs/remotes/<REMOTE>/HEAD` prints the last known value as a full ref; use it as it is.
4. a local `main` or `master` branch
5. otherwise, ask the user for the base branch

The head branch’s own upstream (for example, `origin/<BRANCH>`) is not a base: a diff against it shows only unpushed commits.

If the repository has no remote, use local branches and do not fetch. Before you use a remote branch as the head or the base, refresh its remote-tracking ref with an explicit refspec. The full source name means that a tag with the same name is never fetched instead, and the destination creates the ref even in a single-branch clone:

```bash
git fetch <remote> +refs/heads/<name>:refs/remotes/<remote>/<name>
```

If the fetch fails, say so and use the ref you have.

Record the two commits:

```bash
git rev-parse <BASE_REF> <HEAD_REF>
```

It prints `<BASE_SHA>`, then `<HEAD_SHA>`. Then follow "Base and head commits". To check the commits again before you report, repeat any fetch or PR lookup you used, and run the same command.

The review covers commits only. If `<HEAD_REF>` is the checked-out branch and `git status` shows uncommitted or untracked changes, say that the review leaves them out. Review them too (`git diff HEAD` and the untracked files) only if the user asked for that. If another branch is checked out, its uncommitted changes are not part of this review.

## Pasted diff adapter

If the user provides only a pasted diff and no repository access is available:

- Review the pasted diff.
- Do not pretend to have inspected surrounding code.
- Call out that the review is limited to the pasted diff.
- Ask for the PR URL or repository context only if the diff is insufficient to answer safely.

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

Do not rely on memory for exact framework or library behaviour when the repository contains types, docs, examples, or existing usage.

## Review method

First summarise the PR:

- PR provider
- PR title
- PR link
- base branch
- source branch
- apparent intent
- changed areas
- the base and head commits you reviewed
- whether surrounding code was inspected

Then review the PR against:

- the PR title
- the PR description
- linked issue/work item, if available
- changed files
- the diff
- surrounding code
- project instructions
- existing tests
- nearby implementation patterns

Only report issues that are introduced or made worse by this PR.

Do not report a pre-existing issue unless the PR makes it worse or makes it newly reachable.

## Review priorities

Look for real issues in these categories.

### Correctness and logic

Check for:

- incorrect business logic
- wrong conditions
- missing branches
- bad defaults
- off-by-one errors
- incorrect state transitions
- null or undefined handling bugs
- incorrect assumptions about data shape
- regressions against existing behaviour
- broken control flow
- swallowed errors
- incorrect feature flag behaviour

### Edge cases

Check for:

- empty input
- missing input
- malformed input
- duplicate input
- large input
- paginated data
- boundary values
- unusual ordering
- retries
- repeated requests
- partial failures
- time zones
- daylight saving time
- concurrency
- race conditions

### Security and privacy

Check for:

- missing authentication
- missing authorisation
- broken ownership checks
- broken tenancy isolation
- privilege escalation
- SQL injection
- command injection
- XSS
- template injection
- path traversal
- unsafe deserialisation
- unsafe HTML rendering
- secrets in logs
- tokens in errors
- credentials in client responses
- PII leakage
- overly broad permissions
- insecure defaults

### Data and persistence

Check for:

- unsafe migrations
- backwards-incompatible schema changes
- missing indexes for new query patterns
- N+1 queries
- unbounded queries
- missing transaction boundaries
- partial-failure data corruption
- duplicate writes
- non-idempotent webhook or job handling
- incorrect retry behaviour
- stale reads
- cache invalidation bugs
- data loss during rollback

### API and contract compatibility

Check for:

- request shape changes
- response shape changes
- backwards compatibility breaks
- wrong HTTP status codes
- inconsistent error formats
- missing validation
- server/client type mismatches
- undocumented breaking changes
- versioning issues
- changes that break existing consumers

### Resilience and operations

Check for:

- missing timeouts
- missing cancellation
- retry storms
- no fallback path
- poor failure behaviour
- connection leaks
- file handle leaks
- memory leaks
- missing resource cleanup
- insufficient logging
- unsafe logging
- missing metrics or traces for important new flows
- operational blind spots
- poor behaviour when dependencies fail

### Performance

Check for:

- hot-path inefficiencies
- unnecessary serial awaits
- blocking work
- excessive database calls
- repeated expensive computation
- memory growth
- inefficient data fetching
- excessive payload size
- excessive frontend re-renders
- cache misuse
- changes that will not scale with realistic data volume

### Frontend-specific issues

Where applicable, check for:

- invalid React hook usage
- incorrect effect dependencies
- missing effect cleanup
- redundant or inconsistent state
- unsafe rendering of user-generated or AI-generated content
- SSR/client boundary mistakes
- hydration issues
- accessibility regressions
- broken keyboard navigation
- missing focus states
- incorrect ARIA usage
- poor loading or error states
- stale client cache behaviour

### Test quality

Check for:

- missing tests for changed behaviour
- missing negative tests
- missing boundary tests
- missing regression tests
- missing error-path tests
- missing auth/authz tests
- missing migration tests
- missing concurrency or idempotency tests
- tests that only verify implementation details
- tests that would pass even if the feature were broken
- flaky tests due to timing, randomness, network, or ordering
- untested production-critical paths

### Maintainability and simplicity

Check for:

- unnecessary abstraction
- duplicate logic
- ignoring existing helper functions
- broad changes unrelated to the PR intent
- unclear ownership boundaries
- confusing control flow
- excessive coupling
- over-engineering
- hand-rolled logic where a project primitive already exists
- changes that make future bugs more likely

### Dependencies and deployment safety

Check for:

- new dependency risk
- licence risk
- supply-chain risk
- incompatible dependency versions
- config changes
- environment variable changes
- missing deployment notes
- missing rollback plan for risky changes
- feature flag concerns
- build or packaging changes
- CI/CD compatibility
- infrastructure drift

## What not to report

Do not report:

- formatting problems
- personal naming preferences
- stylistic preferences
- linter-only issues
- formatter-only issues
- pre-existing problems unrelated to this PR
- speculative problems without concrete evidence
- duplicate comments for the same root cause
- generic “consider improving” advice
- large rewrites unless required to fix a concrete issue
- issues that require guessing about business requirements without evidence

If a concern is plausible but not provable, place it under “Needs human judgement” instead of presenting it as a finding.

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

Use sparingly for:

- small improvement
- minor maintainability concern
- optional clarity improvement

Do not include Low findings unless they are clearly useful.

## Confidence levels

Use:

- High: directly supported by diff and surrounding code
- Medium: likely issue with good evidence, but some context is missing
- Low: plausible concern requiring human confirmation

Do not overstate confidence.

## Output format

Start with this section:

```text
Verdict: Ready to merge / Needs minor changes / Needs important fixes / Do not merge yet
```

Then include:

```text
PR summary:
- Provider:
- PR:
- Base:
- Source:
- Apparent intent:
- Changed areas:
- Commits (base, head, merge base; "unavailable" if unknown):
- Surrounding code inspected: Yes/No
```

Then list findings grouped by severity.

For every finding include:

```text
Severity:
Category:
File and line:
What is wrong:
Why it matters:
Evidence:
Suggested fix:
Confidence:
```

Then finish with:

```text
Most important fix first:

Tests I would add or run:

Needs human judgement:

Questions for the author:
```

If there are no findings, say so clearly. Still include tests you would run.

## Output rules

Prefer a small number of high-signal findings over a long noisy list.

Every finding must have concrete evidence.

Every finding must include a file and line reference where possible.

If exact line numbers are unavailable, reference the file and nearest function, class, component, or changed block.

Do not invent line numbers.

Do not claim to have run tests unless they were actually run.

Do not claim to have inspected surrounding code unless it was actually inspected.

Do not claim the PR is safe solely because no issue was found.

## Recommended final verdict logic

Use:

```text
Ready to merge
```

only when no material issues were found and the remaining risk is low.

Use:

```text
Needs minor changes
```

when issues are small and unlikely to cause production problems.

Use:

```text
Needs important fixes
```

when there is at least one High issue, or several Medium issues that materially increase risk.

Use:

```text
Do not merge yet
```

when there is a Critical issue, a likely production incident, security vulnerability, data loss risk, or broken core flow.

## If commands fail

If a command fails:

1. Show the command that failed.
2. Briefly explain the limitation.
3. Continue with the best available source of information.
4. Do not stop unless you cannot get the diff of the change at all.

Common fallbacks:

- If you cannot fetch the PR’s commits, use the fallback in the provider adapter.
- If PR metadata fails, you cannot tell which commits belong to the PR. Do not review a local branch in its place unless the user confirms that it is the PR’s source branch; ask for access, or for the base and head branch names.
- If provider auth fails, ask the user to authenticate with the relevant CLI.
- If line numbers are unavailable, reference file and function/block.

## Final reminder

The purpose of this review is not to sound clever. The purpose is to prevent real bugs, security issues, data problems, production failures, and weak tests from reaching the main branch.
