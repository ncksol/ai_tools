# Copilot Instructions

## Repository purpose

This repo is a personal collection of **GitHub Copilot CLI Skills** authored by the user. It contains no application code, no build, no tests, and no lint configuration. The deliverables are the `SKILL.md` files themselves — they are markdown prompts loaded by the Copilot CLI at runtime.

## Layout

Skills live under `ghcp/skills/<skill-name>/SKILL.md`. Custom agents live under `ghcp/agents/<agent-name>.agent.md` (single file, not a directory). Current contents:

**Skills:**

PR-review skills (provider-neutral, inspection-only):

- `strict-code-review` — first-pass strict PR review (analysis-only).
- `analyse-pr-feedback` — triage reviewer feedback into a decision table (analysis-only).
- `rereview-pr` — focused follow-up review after a previous review cycle (analysis-only).

Research skills:

- `storm-research` — Stanford STORM multi-perspective research (always grounded in real web sources; produces a chat briefing and, only when the user explicitly accepts, a self-contained HTML report).

**Agents:**

- `andrej` — Karpathy-flavoured coding-discipline persona; behavioural rules to reduce common LLM coding mistakes.
- `azure-arch-diagram` — expert Azure architecture diagram creator; emits editable draw.io (`.drawio`) mxGraph XML following Microsoft Azure Architecture Centre style (official Azure2 icons, directional arrows, grouping containers, consistent colour palette).

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

The body is a prompt addressed to the future Copilot session ("You are…"), not human documentation.

**General conventions (every skill):**

- An explicit **Operating mode** section stating the skill's safety boundaries — what it must and must not do. The exact boundaries depend on the skill: the PR-review skills are strictly inspection-only; `storm-research` reads from the web and writes a report file only when the user explicitly accepts. Spell out whichever rules apply.
- A prescribed **Output format**, usually built around a markdown artifact (a decision/findings table for the review skills; a four-phase briefing for `storm-research`).
- Forbid hallucination: do not invent line numbers, sources, quotes, or results; do not claim a command or search ran when it didn't; do not claim surrounding code was inspected when only the diff was read.

**PR-review conventions (the `strict-code-review`, `analyse-pr-feedback`, `rereview-pr` family only):**

- A **Supported providers** section. These skills are provider-neutral and must support both **GitHub** (`github.com/.../pull/<n>`) and **Azure DevOps** (`dev.azure.com/.../pullrequest/<id>` and `*.visualstudio.com/.../pullrequest/<id>`).
- Separate **provider adapter** sections with the exact CLI commands to use:
  - GitHub: `gh pr view`, `gh pr diff`, `gh api repos/.../pulls/...`, and a GraphQL query for `reviewThreads` (REST does not reliably expose thread resolution state).
  - Azure DevOps: `az repos pr show`, `az repos pr work-item list`, `az repos pr policy list`, and `az devops invoke --area git --resource pullRequestThreads ... --api-version 7.1`.
- A working-tree safety check: run `git status` first; if the tree is not clean, do **not** check out the PR — fall back to remote metadata + diff.
- Shared **Severity** scale: `Critical | High | Medium | Low | Info` (use the same wording across the review skills).
- Adapter sections for `Local branch` and `Pasted diff/feedback` so the skill works without network access.
- End strict/re-review skills with the literal line `No code was changed.`

When extending an existing skill, keep that skill's established section ordering and vocabulary so the family stays consistent. Do **not** bolt PR-review machinery (provider adapters, PR safety rules) onto a non-PR skill such as `storm-research`.

## Agent file conventions

Agent files (`ghcp/agents/<name>.agent.md`) are simpler than skills:

- Single file, no enclosing per-agent directory.
- Frontmatter contains only `description:` (a short line shown in the agent picker — not a router intent string).
- Body is the agent's system prompt: persona, behavioural rules, operating mode. No mandatory sections.

## Authoring rules specific to this repo

- The **PR-review skills** are inspection-and-reporting only: they must never edit, commit, push, or otherwise mutate a PR. Other skills may write output when the user explicitly asks for it — e.g. `storm-research` writes its HTML report only after the user accepts the offer. Do not add a skill that mutates a PR.
- Do **not** instruct any skill to invoke GitHub's native Copilot PR reviewer.
- Do not invent line numbers or sources, claim commands ran when they didn't, or claim surrounding code was inspected when only the diff was read — these prohibitions are repeated across skills and must be preserved.
- Prefer `gh` CLI and `az` CLI commands over raw HTTP. When REST is insufficient (e.g., review thread resolution), use `gh api graphql` as shown in `rereview-pr/SKILL.md`.

## Working in this repo

- There is nothing to build, test, or lint. Validation = read the changed `SKILL.md` and confirm frontmatter parses and the prompt structure matches the conventions above.
- Commits in this repo follow the user's global policy (no `Co-authored-by` trailers).
