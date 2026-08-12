# Copilot Instructions

## Repository purpose

This repo is a personal collection of **GitHub Copilot CLI artefacts** authored by the user: skills, custom agents, and plugins. The repository is itself a Copilot plugin marketplace named `ai-tools`.

Most deliverables are markdown prompts loaded by the Copilot CLI at runtime — there is no application code, build, or lint configuration at the repository level. Individual plugins may vendor their own Node.js scripts and tests; those are the only things in the repo that are executed.

## Layout

- Skills: `ghcp/skills/<skill-name>/SKILL.md`
- Custom agents: `ghcp/agents/<agent-name>.agent.md` (single file, not a directory)
- Plugins: `ghcp/plugins/<plugin-name>/` (self-contained bundle)
- Marketplace manifest: `.github/plugin/marketplace.json` (repository root, one file for all plugins)

Current contents:

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

**Plugins:**

- `pr-review-graph` — bounded multi-agent review of an already-open GitHub or Azure DevOps PR: snapshot, specialist routing, verification, deduplication against existing comments, preview-then-publish. Bundles one skill (`review-pull-request`) and nine `prg-*` specialist agents.

When adding a new skill, create `ghcp/skills/<kebab-name>/SKILL.md`. When adding a new agent, create `ghcp/agents/<kebab-name>.agent.md`. When adding a new plugin, see the plugin conventions below.

## Plugin conventions

Plugins are **vendored intact** under `ghcp/plugins/<plugin-name>/`. A plugin keeps its own `plugin.json`, `package.json`, tests, scripts, LICENSE and README. Treat a vendored plugin as a unit: when updating it from an upstream drop, replace the directory rather than hand-editing individual files, then re-apply the two repo-specific deltas below.

- **One marketplace manifest, at the repository root.** `.github/plugin/marketplace.json` lists every plugin, each with a `source` path pointing at its directory (e.g. `"./ghcp/plugins/pr-review-graph"`). A plugin must **not** carry its own `marketplace.json`; delete it when vendoring. Copilot CLI only reads the manifest at the repository root.
- **`version` must match** between a plugin's `plugin.json` and its entry in the root marketplace manifest.
- **Skill and agent names inside a plugin stay namespaced to that plugin** (e.g. `prg-*` for `pr-review-graph`) so they don't collide with the loose skills in `ghcp/skills/` or agents in `ghcp/agents/`.
- Do **not** duplicate a plugin's skills or agents into `ghcp/skills/` or `ghcp/agents/`. A plugin ships as one installable unit.
- If a plugin has a validation script, it must check its entry in the root marketplace manifest, not a local one. See `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs`.

Install and validate a plugin with:

```bash
cd ghcp/plugins/<plugin-name>
npm test
npm run validate
```

Prefer `copilot plugin install <name>@ai-tools` over direct repo/URL/local-path installs; the CLI reports the latter as deprecated.

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

- Skills and agents have nothing to build, test, or lint. Validation = read the changed `SKILL.md` / `.agent.md` and confirm frontmatter parses and the structure matches the conventions above.
- Plugins **do** have tests. After touching anything under `ghcp/plugins/<name>/` or the root `.github/plugin/marketplace.json`, run `npm test && npm run validate` from that plugin's directory.
- Commits in this repo follow the user's global policy (no `Co-authored-by` trailers).
