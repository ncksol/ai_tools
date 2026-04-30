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
- change branches unless this is required to inspect the PR and the user’s working tree is clean

If the working tree is not clean, do not check out the PR until the user decides what to do. Continue with remote metadata and patch/diff if possible.

## Inputs

The user may provide one of:

- a GitHub PR URL
- an Azure DevOps PR URL
- a local branch name
- a PR number, if the current repository context makes the provider and repository obvious
- a pasted diff

If the prompt contains a PR URL, use that URL as the source of truth.

If the provider or repository cannot be determined, ask for the missing PR URL.

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

## General review flow

When reviewing a PR:

1. Identify the PR provider.
2. Gather PR metadata.
3. Gather the diff.
4. If possible, inspect surrounding code locally.
5. Read project-specific instructions and nearby implementation patterns.
6. Review the PR against its stated intent.
7. Report only concrete issues introduced or made worse by this PR.

Do not review only the raw diff if local repository context is available. Diffs often hide important control flow, type definitions, configuration, tests, and existing helper functions.

## GitHub PR adapter

For GitHub PRs, prefer GitHub CLI.

Use the PR URL directly where possible.

Gather PR metadata:

```bash
gh pr view <PR_URL> --json number,title,body,baseRefName,headRefName,headRepository,headRepositoryOwner,files,commits,statusCheckRollup,reviews,comments,url
```

Gather the patch and changed file list:

```bash
gh pr diff <PR_URL> --patch
gh pr diff <PR_URL> --name-only
```

If local repository context is available and the working tree is clean, check out the PR:

```bash
gh pr checkout <PR_URL>
git status
```

Then compare the PR branch against the base branch.

Determine the base branch from `gh pr view`. Then run:

```bash
git fetch origin
git diff origin/<baseRefName>...HEAD
```

If checkout fails, continue with the PR metadata and patch. State clearly that surrounding-code inspection was limited.

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

If Azure DevOps defaults are not configured, parse the organisation and project from the URL and pass them explicitly.

For `dev.azure.com` URLs:

```text
https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
```

the organisation URL is:

```text
https://dev.azure.com/<org>
```

and the project is:

```text
<project>
```

Gather PR metadata:

```bash
az repos pr show --id <PR_ID> --output json
```

If organisation and project are required:

```bash
az repos pr show --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>" --output json
```

Gather linked work items where available:

```bash
az repos pr work-item list --id <PR_ID> --output json
```

If organisation and project are required:

```bash
az repos pr work-item list --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>" --output json
```

Gather PR policy/status information where available:

```bash
az repos pr policy list --id <PR_ID> --output json
```

If organisation and project are required:

```bash
az repos pr policy list --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>" --output json
```

If local repository context is available and the working tree is clean, check out the PR:

```bash
az repos pr checkout --id <PR_ID>
git status
```

If organisation and project are required:

```bash
az repos pr checkout --id <PR_ID> --org https://dev.azure.com/<ORG> --project "<PROJECT>"
git status
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

Then compare against the target branch:

```bash
git fetch origin
git diff origin/<targetBranch>...HEAD
```

If checkout is not possible, continue with available PR metadata. Clearly state that surrounding-code inspection was limited.

Azure DevOps does not always provide a convenient direct patch command equivalent to GitHub CLI’s `gh pr diff`. Prefer local checkout plus `git diff` whenever possible.

## Local-only branch adapter

If the user gives a local branch or asks to review the current branch, inspect the local git state.

Start with:

```bash
git status
git branch --show-current
git remote -v
```

Identify the likely base branch.

Prefer, in order:

1. the branch’s configured upstream target, if obvious
2. `origin/main`
3. `origin/master`
4. ask the user for the base branch if none can be inferred

Then run:

```bash
git fetch origin
git diff origin/<baseBranch>...HEAD
```

Review only the diff against the base branch.

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
- whether local checkout was available
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
- Local checkout inspected: Yes/No
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
4. Do not stop unless the PR cannot be accessed at all.

Common fallbacks:

- If checkout fails, use PR metadata and patch/diff.
- If PR metadata fails, use the URL and any accessible local branch.
- If provider auth fails, ask the user to authenticate with the relevant CLI.
- If line numbers are unavailable, reference file and function/block.

## Final reminder

The purpose of this review is not to sound clever. The purpose is to prevent real bugs, security issues, data problems, production failures, and weak tests from reaching the main branch.
