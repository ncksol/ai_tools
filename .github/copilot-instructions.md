# Copilot Instructions

## Repository purpose

This repo is a personal collection of **GitHub Copilot CLI artefacts** authored by the user: skills, custom agents, and plugins. The repository is itself a Copilot plugin marketplace named `ai-tools`.

Most deliverables are markdown prompts loaded by the Copilot CLI at runtime — there is no application code, build, or lint configuration at the repository level. Individual plugins may vendor their own Node.js scripts and tests; those are the only things in the repo that are executed.

## Layout

- Skills: `ghcp/skills/<skill-name>/SKILL.md`, plus any supporting files it links to by relative path (for example `references/*.md`); `SKILL.md` says when to read each one
- Custom agents: `ghcp/agents/<agent-name>.agent.md` (single file, not a directory)
- Plugins: `ghcp/plugins/<plugin-name>/` (self-contained bundle)
- Marketplace manifest: `.github/plugin/marketplace.json` (repository root, one file for all plugins)

Current contents:

**Skills:**

PR-review skills (provider-neutral, inspection-only):

- `strict-code-review` — the strict first-pass reviewer for GitHub and Azure DevOps PR URLs, local branches and pasted diffs (inspection-only; it never posts comments). Its provider adapters and review checklist are in `references/`. Users can invoke it explicitly with `/strict-code-review`.
- `analyse-pr-feedback` — triage reviewer feedback into a decision table (analysis-only).
- `rereview-pr` — focused follow-up review after a previous review cycle (analysis-only).

Research skills:

- `storm-research` — Stanford STORM multi-perspective research (always grounded in real web sources; produces a chat briefing and, only when the user explicitly accepts, a self-contained HTML report).

**Agents:**

- `andrej` — Karpathy-flavoured coding-discipline persona; behavioural rules to reduce common LLM coding mistakes.
- `azure-arch-diagram` — expert Azure architecture diagram creator; emits editable draw.io (`.drawio`) mxGraph XML following Microsoft Azure Architecture Centre style (official Azure2 icons, directional arrows, grouping containers, consistent colour palette).
- `orchestrator` — session-level coordinator for the GitHub Copilot app, selected with `/agent` or the composer. Its `tools` allowlist removes shell, file read/edit, search, web and MCP tools, so it must delegate: owned work (branch, PR, workstream) and jobs that need other agents to nested child sessions, other one-off jobs to `orchestrator-worker` sub-agents. Keeps plan state and a child-session registry in the session SQL database. Sets a model and reasoning effort on every child session and sub-agent from the tier table in its "Models and effort" section, which is the user's model policy.
- `orchestrator-worker` — helper that `orchestrator` starts through the `task` tool for one-off jobs (research, checks, reviews, documents, commands). Its own `tools` list gives it shell, file, search, web and skill tools but no `task` or session tools, so it can't start sub-agents or create sessions. `user-invocable: false` keeps it out of the agent picker. `model: claude-opus-5.5` and `reasoning-effort: high` set its default for `task` calls that don't name a model.

**Plugins:**

- `adr-authoring` — evidence-led ADR authoring in Microsoft Learn-inspired style. Bundles the `adr-writer` agent, `adr-write` skill, template, style profile, review rubric, four original example pairs, structural validators, and fourteen evaluation briefs. Writes authorized ADR files and separately requested supporting notes, preserves accepted records, and never mutates PRs. Decision relevance and audience fit are hard review gates; structural tests do not establish semantic quality or runtime consistency.
- `swarm-dashboard` — watch-only dashboard for agentic swarms, shown as a canvas in the Copilot app or in a browser. Bundles a read-only engine over Copilot's local data (`engine/`), a loopback server shared on port 7927 (`server/`), a no-build UI (`ui/`), the canvas extension (`com.github.copilot/extensions/swarm-dashboard/`), and a launcher, snapshot command and headless layout check (`scripts/`). No skills or agents and no npm dependencies; the layout check needs a local Chrome, Chromium or Edge, and its optional WebKit mode uses Playwright installed outside the repository.

When adding a new skill, create `ghcp/skills/<kebab-name>/SKILL.md`. When adding a new agent, create `ghcp/agents/<kebab-name>.agent.md`. When adding a new plugin, see the plugin conventions below.

## Plugin conventions

Plugins are **vendored intact** under `ghcp/plugins/<plugin-name>/`. A plugin keeps its own `plugin.json`, `package.json`, tests, scripts, LICENSE and README. Treat a vendored plugin as a unit: when updating it from an upstream drop, replace the directory rather than hand-editing individual files, then re-apply the two repo-specific deltas below.

- **One marketplace manifest, at the repository root.** `.github/plugin/marketplace.json` lists every plugin, each with a `source` path pointing at its directory (e.g. `"./ghcp/plugins/adr-authoring"`). A plugin must **not** carry its own `marketplace.json`; delete it when vendoring. Copilot CLI only reads the manifest at the repository root.
- **`version` must match** between a plugin's `plugin.json` and its entry in the root marketplace manifest.
- **Skill and agent names inside a plugin stay namespaced to that plugin** (e.g. `adr-*` for `adr-authoring`) so they don't collide with the loose skills in `ghcp/skills/` or agents in `ghcp/agents/`.
- Do **not** duplicate a plugin's skills or agents into `ghcp/skills/` or `ghcp/agents/`. A plugin ships as one installable unit.
- If a plugin has a validation script, it must check its entry in the root marketplace manifest, not a local one. See `ghcp/plugins/adr-authoring/scripts/validate-plugin.mjs`.

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
- Separate **provider adapter** sections, in `SKILL.md` or in supporting files it links to, with the exact CLI commands to use:
  - GitHub: `gh pr view`, `gh pr diff`, `gh api repos/.../pulls/...`, and a GraphQL query for `reviewThreads` (REST does not reliably expose thread resolution state).
  - Azure DevOps: `az repos pr show`, `az repos pr work-item list`, `az repos pr policy list`, and `az devops invoke --area git --resource pullRequestThreads ... --api-version 7.1`.
- A working-tree safety check: run `git status` first; if the tree is not clean, do **not** check out the PR — fall back to remote metadata + diff.
- Shared **Severity** scale: `Critical | High | Medium | Low` (use the same wording across the review skills).
- Adapter sections for `Local branch` and `Pasted diff/feedback` so the skill works without network access.

When extending an existing skill, keep that skill's established section ordering and vocabulary so the family stays consistent. Do **not** bolt PR-review machinery (provider adapters, PR safety rules) onto a non-PR skill such as `storm-research`.

## Agent file conventions

Agent files (`ghcp/agents/<name>.agent.md`) are simpler than skills:

- Single file, no enclosing per-agent directory.
- Frontmatter contains `description:` (a short line shown in the agent picker — not a router intent string). Add other fields only when the agent needs them, as `orchestrator.agent.md` does for a session-level agent with hard limits: `name`, a `tools` allowlist (the agent can't call unlisted tools; app tools such as `create_session` are listed by bare name), `include-custom-instructions: true`, and `disable-model-invocation: true` (stops other agents starting it as a sub-agent). A helper agent that only other agents start, such as `orchestrator-worker`, sets `user-invocable: false` and must not set `disable-model-invocation: true`, which blocks `task` launches. An agent can also set a default `model` (one ID, or a list tried in order) and `reasoning-effort`; a `model` or `reasoning_effort` on the `task` call overrides them.
- A `tools` allowlist also caps the built-in sub-agents the agent starts (`explore`, `task`, `research`, `rubber-duck`, `code-review`, `security-review`): `*` becomes the agent's own list, and `explore`'s fixed list ends up empty. `general-purpose` and custom agents with their own `tools` list keep their tools. This was checked on Copilot CLI 1.0.95-3, is not documented, and may change. In a `tools` list, name `grep`, `glob` and `web_fetch` directly: the `search` and `web` aliases match nothing in the CLI, and unknown names are dropped silently.
- Body is the agent's system prompt: persona, behavioural rules, operating mode. No mandatory sections.

## Authoring rules specific to this repo

- The **PR-review skills** are inspection-and-reporting only: they must never edit, commit, push, or otherwise mutate a PR. Other skills may write output when the user explicitly asks for it — e.g. `storm-research` writes its HTML report only after the user accepts the offer. Do not add a skill that mutates a PR.
- Do **not** instruct any skill to invoke GitHub's native Copilot PR reviewer.
- Do not invent line numbers or sources, claim commands ran when they didn't, or claim surrounding code was inspected when only the diff was read — these prohibitions are repeated across skills and must be preserved.
- Prefer `gh` CLI and `az` CLI commands over raw HTTP. When REST is insufficient (e.g., review thread resolution), use `gh api graphql` as shown in `rereview-pr/SKILL.md`.

## Working in this repo

- Skills and agents have nothing to build, test, or lint. Validation = read the changed `SKILL.md` / `.agent.md` and any supporting files it links to, and confirm frontmatter parses, links resolve and the structure matches the conventions above.
- Plugins **do** have tests. After touching anything under `ghcp/plugins/<name>/` or the root `.github/plugin/marketplace.json`, run `npm test && npm run validate` from that plugin's directory.
- For `swarm-dashboard`, also run `npm run check:layout` from its directory after any change under `ui/`; every view must report 0 issues.
- Commits in this repo follow the user's global policy (no `Co-authored-by` trailers).
