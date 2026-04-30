# Copilot Instructions

## Repository purpose

This repo is a personal collection of **GitHub Copilot CLI Skills** authored by the user. It contains no application code, no build, no tests, and no lint configuration. The deliverables are the `SKILL.md` files themselves — they are markdown prompts loaded by the Copilot CLI at runtime.

## Layout

Skills live under `ghcp/skills/<skill-name>/SKILL.md`. Custom agents live under `ghcp/agents/<agent-name>.agent.md` (single file, not a directory). Current contents:

**Skills:**

- `strict-code-review` — first-pass strict PR review (analysis-only).
- `analyse-pr-feedback` — triage reviewer feedback into a decision table (analysis-only).
- `rereview-pr` — focused follow-up review after a previous review cycle (analysis-only).

**Agents:**

- `andrej` — Karpathy-flavoured coding-discipline persona; behavioural rules to reduce common LLM coding mistakes.

When adding a new skill, create `ghcp/skills/<kebab-name>/SKILL.md`. When adding a new agent, create `ghcp/agents/<kebab-name>.agent.md`.

## SKILL.md conventions

Every `SKILL.md` must start with YAML frontmatter:

```yaml
---
name: <kebab-case-name>            # must match the directory name
description: >-
  <one paragraph describing exactly when this skill should activate;
  written so the CLI's skill router can match user intent>
---
```

The body is a prompt addressed to the future Copilot session ("You are…"), not human documentation. Match the structural patterns already established across the three skills:

- An explicit **Operating mode / Safety rules** section listing what the skill must NOT do (edit files, commit, push, post PR comments, approve/reject, vote, merge, close, resolve threads, use GitHub's native Copilot reviewer, run destructive commands).
- A **Supported providers** section. All PR skills here are provider-neutral and must support both **GitHub** (`github.com/.../pull/<n>`) and **Azure DevOps** (`dev.azure.com/.../pullrequest/<id>` and `*.visualstudio.com/.../pullrequest/<id>`).
- Separate **provider adapter** sections with the exact CLI commands to use:
  - GitHub: `gh pr view`, `gh pr diff`, `gh api repos/.../pulls/...`, and a GraphQL query for `reviewThreads` (REST does not reliably expose thread resolution state).
  - Azure DevOps: `az repos pr show`, `az repos pr work-item list`, `az repos pr policy list`, and `az devops invoke --area git --resource pullRequestThreads ... --api-version 7.1`.
- A working-tree safety check: run `git status` first; if the tree is not clean, do **not** check out the PR — fall back to remote metadata + diff.
- Shared **Severity** scale: `Critical | High | Medium | Low | Info` (use the same wording across skills).
- A prescribed **Output format** with a markdown table as the primary artifact. End strict/re-review skills with the literal line `No code was changed.`
- Adapter sections for `Local branch` and `Pasted diff/feedback` so the skill works without network access.

When extending an existing skill, keep the existing section ordering and severity/status vocabulary so the three skills stay consistent.

## Agent file conventions

Agent files (`ghcp/agents/<name>.agent.md`) are simpler than skills:

- Single file, no enclosing per-agent directory.
- Frontmatter contains only `description:` (a short line shown in the agent picker — not a router intent string).
- Body is the agent's system prompt: persona, behavioural rules, operating mode. No mandatory sections.

## Authoring rules specific to this repo

- Skills are **inspection and reporting only**. Never add a skill that edits, commits, pushes, or mutates a PR unless the user explicitly requests that.
- Do **not** instruct the skill to invoke GitHub's native Copilot PR reviewer.
- Do not invent line numbers, claim commands ran when they didn't, or claim surrounding code was inspected when only the diff was read — these prohibitions are repeated across skills and must be preserved.
- Prefer `gh` CLI and `az` CLI commands over raw HTTP. When REST is insufficient (e.g., review thread resolution), use `gh api graphql` as shown in `rereview-pr/SKILL.md`.

## Working in this repo

- There is nothing to build, test, or lint. Validation = read the changed `SKILL.md` and confirm frontmatter parses and the prompt structure matches the conventions above.
- Commits in this repo follow the user's global policy (no `Co-authored-by` trailers).
