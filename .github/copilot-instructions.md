# Copilot Instructions

## Repository purpose

This repo is a personal collection of **GitHub Copilot CLI artefacts** authored by the user: skills, custom agents, and plugins. The repository is itself a Copilot plugin marketplace named `ai-tools`.

Most deliverables are markdown prompts loaded by the Copilot CLI at runtime — there is no application code, build, or lint configuration at the repository level. Individual plugins may vendor their own Node.js scripts and tests, and eval kits under evals/ have their own scripts and tests; those are the only things in the repo that are executed.

## Layout

- Skills: `ghcp/skills/<skill-name>/SKILL.md`, plus any supporting files it links to by relative path (for example `references/*.md`); `SKILL.md` says when to read each one
- Custom agents: `ghcp/agents/<agent-name>.agent.md` (single file, not a directory)
- Plugins: `ghcp/plugins/<plugin-name>/` (self-contained bundle). An Agent Plugins 1.0 plugin (a `plugin.json` with `$schema`) keeps its agents in `com.github.copilot/agents/<agent-name>.agent.md`
- Marketplace manifest: `.github/plugin/marketplace.json` (repository root, one file for all plugins)
- Evals: `evals/<area>/<eval-name>/` (a self-contained eval kit with its own `package.json`, scripts, tests and runbook)

Current contents:

**Skills:**

PR-review skills (provider-neutral, inspection-only):

- `strict-code-review` — the strict first-pass reviewer for GitHub and Azure DevOps PR URLs, local branches and pasted diffs (inspection-only; it never posts comments). Its provider adapters and review checklist are in `references/`. Users can invoke it explicitly with `/strict-code-review`.
- `analyse-pr-feedback` — triage reviewer feedback into a decision table (analysis-only).
- `rereview-pr` — focused follow-up review after a previous review cycle (analysis-only).

Research skills:

- `storm-research` — Stanford STORM multi-perspective research (always grounded in real web sources; produces a chat briefing and, only when the user explicitly accepts, a self-contained HTML report).

**Agents** (loose files in `ghcp/agents/`):

- `andrej` — Karpathy-flavoured coding-discipline persona; behavioural rules to reduce common LLM coding mistakes.
- `azure-arch-diagram` — expert Azure architecture diagram creator; emits editable draw.io (`.drawio`) mxGraph XML following Microsoft Azure Architecture Centre style (official Azure2 icons, directional arrows, grouping containers, consistent colour palette).
- `eval-runner` — the driver of an overnight orchestrator-eval batch, run by the user in one app session in autopilot. It loops on `node scripts/batch.ts next`, which blocks until there is a step to take, and makes only the app-tool calls and judgments the runner script can't: repository registration, creation and archiving of its own idle trust sessions, detached eval `create_session` calls from exact arguments, answer-sheet replies, and judging answers and final reports. It relays the trust-session links and never grants trust or writes app state. Its `tools` allowlist is the shell tools, `view`, `grep`, `glob`, `add_repository`, `create_session`, `archive_session`, `get_session`, `answer_session_input`, `send_session_message`, `report_intent` and `task_complete`: no `task`, file-edit or memory tools. Registration uses only the existing clone's `path`, leaving `show_in_sidebar` unset; the returned id is recorded with `--project-id` and remains `create_session`'s legacy `project_id`. Starting the batch authorises these registrations. `disable-model-invocation: true` stops other agents starting it. It must never start an orchestrator outside the runner's eval `create_session` actions, message a run beyond those actions, or touch a run's child sessions.

**`wintermute` plugin agents** (in `ghcp/plugins/wintermute/com.github.copilot/agents/`; the runtime names them `wintermute:<name>`, for example `wintermute:orchestrator`, and every reference that starts or matches one uses that ID):

- `orchestrator` — session-level coordinator for the GitHub Copilot app, selected with `/agent` or the composer. Its `tools` allowlist removes shell, file-edit, search, web and MCP tools and keeps one file tool, `view`, which a prompt rule limits to attachments, the file the user gives as the brief or spec, and its own session files folder. Everything else it must delegate: owned work (branch, PR, workstream) and jobs that need other agents to nested child sessions, other one-off jobs to `orchestrator-worker` sub-agents. Keeps plan state and a child-session registry in the session SQL database. Sets a model and reasoning effort on every child session and sub-agent from the tier table in its "Models and effort" section, which is the user's model policy.
- `orchestrator-worker` — helper that `orchestrator` and `hands-on-orchestrator` start through the `task` tool, as `agent_type: "wintermute:orchestrator-worker"`, for one-off jobs (research, checks, reviews, documents, commands). Its own `tools` list gives it shell, file, search, web and skill tools but no `task` or session tools, so it can't start sub-agents or create sessions. `user-invocable: false` keeps it out of the agent picker. `model: claude-opus-5.5` and `reasoning-effort: high` set its default for `task` calls that don't name a model.
- `session-orchestrator` — variant of `orchestrator` that delegates only to child sessions: owner sessions for owned work, one-off sessions for one-off jobs, all run as `wintermute:session-worker`. Its `tools` list is `orchestrator`'s minus `task`, `read_agent`, `write_agent` and `list_agents`, so it has the same `view` tool and the same rule limiting it. Children can't start agents, so it plans all fan-out itself and handles their helper requests. Built to run side by side with `orchestrator` for evals. It is derived from `orchestrator.agent.md`.
- `hands-on-orchestrator` — variant of `orchestrator` that may do a quick job itself: one it can finish in about five tool calls or about two minutes, such as reading a file or log, a grep, `git` or `gh` status commands, one web fetch, a note in its session files folder, or a small edit (a few lines in one or two files) that it commits and pushes only on its own session branch. Most work is still delegated, and it still uses `orchestrator-worker` for every `task` call. Its `tools` list is `orchestrator`'s plus shell, file view and edit, `grep`, `glob` and `web_fetch` tools, named as in `session-worker`, plus the app's `create_pull_request` and `update_pull_request` tools, which a prompt rule limits to its own unit's PR, and no MCP tools. It never writes to a child's branch or worktree and never does reviews, claims checks, panels or second opinions itself. Its own commits are a unit like any other, tracked in an `own_units` table and never in `children`: a PR from its own branch under the same go-ahead rules as a child's, with a claims check and a review from a vendor other than its own model's.
- `hands-on-session-orchestrator` — the same change made to `session-orchestrator`, with the same tools added. It still never starts sub-agents and still creates every child as `session-worker`.
- The four orchestrator files in `ghcp/plugins/wintermute/com.github.copilot/agents/` must stay in step. `session-orchestrator.agent.md` is derived from `orchestrator.agent.md`, and each `hands-on-` file from the base it is named after (`hands-on-orchestrator` from `orchestrator`, `hands-on-session-orchestrator` from `session-orchestrator`). Text that two or more of these files share stays word for word the same, so apply a change to a shared passage in every file that has it, and carry every change to a base into its `hands-on-` copy. The "Quick jobs you do yourself" section is byte-identical in both `hands-on-` files and names no agent; change it in both at once. The report-format block in `session-orchestrator` and `hands-on-session-orchestrator` stays word for word the one in `session-worker.agent.md`. Any edit to these six agents is a change to the `wintermute` plugin: bump its version, add a CHANGELOG entry, and run `npm test && npm run validate` from `ghcp/plugins/wintermute/`.
- `session-worker` — the agent every child of `session-orchestrator` and `hands-on-session-orchestrator` runs as, set through `kickoff.agent: "wintermute:session-worker"`. An explicit `tools` allowlist gives it shell, file, search, web, GitHub, PR and session-messaging tools, but no `task`, `create_session` or other tools to start sub-agents or sessions; it asks the orchestrator for a helper with a `needs_input` report. Its GitHub MCP tools are listed one by one, not as `github-mcp-server/*`, to leave out `assign_copilot_to_issue` and `request_copilot_review`, which hand work to other agents. Its report block is the one in `session-orchestrator.agent.md`, word for word. `user-invocable: false` keeps it out of the agent picker, and `disable-model-invocation: true` stops `task` launches; neither blocks `kickoff.agent`. It sets no `model` or `reasoning-effort`, because `kickoff.model` and `kickoff.reasoning_effort` set them.

**Plugins:**

- `adr-authoring` — evidence-led ADR authoring in Microsoft Learn-inspired style. Bundles the `adr-writer` agent, `adr-write` skill, template, style profile, review rubric, four original example pairs, structural validators, and fourteen evaluation briefs. Writes authorized ADR files and separately requested supporting notes, preserves accepted records, and never mutates PRs. Decision relevance and audience fit are hard review gates; structural tests do not establish semantic quality or runtime consistency.
- `wintermute` — the orchestrator agents and the watch-only dashboard for their swarms, released and updated as one plugin with one version and one `CHANGELOG.md`. Bundles the six agents above (`com.github.copilot/agents/`), a read-only engine over Copilot's local data (`engine/`), a loopback server shared on port 7927 (`server/`), a no-build UI (`ui/`) with a regular view in light and dark themes and a WebGL2 cockpit view, the canvas extension (`com.github.copilot/extensions/swarm-dashboard/`, canvas id `swarm-dashboard`), and a launcher, snapshot command, headless layout check, dev-only GPU frame-time test and validator (`scripts/`). The dashboard counts a session as an orchestrator by its agent ID, `wintermute:<name>` or the bare name of runs from before the agents moved into the plugin (`ORCHESTRATOR_AGENTS` in `engine/model/forest.mjs`). No skills and no npm dependencies; the layout check needs a local Chrome, Chromium or Edge, and its optional WebKit mode uses Playwright installed outside the repository.

**Evals:**

- `orchestrator/expense-claims` — speed eval for the orchestrator agents, with separate robustness and cost measurements. A run gives an orchestrator a fixed task (v2 of a small expense-claims API) in a fresh private repo, times it from the session's event log, and gates it on a hidden acceptance suite. Holds the v1 seed app, the v2 spec, the kickoff prompt and answer sheet, `acceptance/` and `robustness/` suites, a reference v2 implementation, `new-run` and `score` scripts, `results.csv`, and the overnight batch runner (`npm run batch`: `scripts/batch.ts` and `scripts/lib/batch/`). Robustness stays hidden like acceptance, runs after the score is saved, and never gates a run. A dated file in `pricing/` prices whole-swarm token usage; `results.csv` records cost, robustness and their provenance separately from the score. `variants/` holds pinned A/B/C alias snapshots and their shared worker, deliberately outside `ghcp/agents/`; only the user registers these files, and the kit never installs them. The runner plans and runs a batch of runs unattended with the `eval-runner` driver agent: it creates run repos, watches session logs, scores, immediately archives swarm logs and discovery under the batch's `sessions/` and `sessions.jsonl`, commits `results.csv` on the driver's branch, sends ntfy notifications (topic URL from a private file outside the repo) and writes a morning report, keeping all state in `~/orch-evals/batches/<id>/`. It reads `~/.copilot/data.db` read-only, one column per query. Only one batch is active per machine and only one driver runs a batch (kernel `flock` locks through `/usr/bin/lockf`, and a recorded owning session). `npm run batch -- rehearse` runs a stubbed batch with a fake app. Only `seed/` ever goes into a run repo. `npm run batch -- cleanup` is manual and dry-run by default: it verifies retained session archives; `--yes` refreshes changed logs or backfills legacy archives before deleting eligible recorded artifacts after safety checks. Missing evidence without a verified archive blocks deletion, even with `--force`; app removal stays a checklist and the app DB stays read-only. Runbook: `evals/orchestrator/expense-claims/README.md`, including "Overnight batches" and "Cleaning up".

The eval runner's `batch init` preflight requires every recorded row from the latest earlier live batch with rows in the selected batches root to exist in the current `results.csv`, preventing repeated calibration from unlanded driver results. Empty and rehearsal batches do not hide that batch. Only an explicit `--ignore-results-batch <id>` overrides missing rows for a deliberately abandoned batch; the planner still reads results only from `results.csv`.

When adding a new skill, create `ghcp/skills/<kebab-name>/SKILL.md`. When adding a new agent, create `ghcp/agents/<kebab-name>.agent.md`; an agent that belongs to the orchestrator family goes in `ghcp/plugins/wintermute/com.github.copilot/agents/` instead. When adding a new plugin, see the plugin conventions below.

## Plugin conventions

Plugins are **vendored intact** under `ghcp/plugins/<plugin-name>/`. A plugin keeps its own `plugin.json`, `package.json`, tests, scripts, LICENSE and README. Treat a vendored plugin as a unit: when updating it from an upstream drop, replace the directory rather than hand-editing individual files, then re-apply the two repo-specific deltas below.

- **One marketplace manifest, at the repository root.** `.github/plugin/marketplace.json` lists every plugin, each with a `source` path pointing at its directory (e.g. `"./ghcp/plugins/adr-authoring"`). A plugin must **not** carry its own `marketplace.json`; delete it when vendoring. Copilot CLI only reads the manifest at the repository root.
- **`version` must match** between a plugin's `plugin.json`, its `package.json` and its entry in the root marketplace manifest. Every change under `ghcp/plugins/<name>/`, an agent prompt included, bumps that version in all three: installed copies get a change only through a new version. A plugin with a `CHANGELOG.md`, such as `wintermute`, also gets an entry for the new version.
- **Agent Plugins 1.0 plugins** (`plugin.json` with `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"`) load agents only from `com.github.copilot/agents/`. A top-level `agents/` folder or an `agents` field in `plugin.json`, the legacy style `adr-authoring` uses, is ignored for them.
- **Skill and agent names inside a plugin stay namespaced to that plugin** (e.g. `adr-*` for `adr-authoring`) so they don't collide with the loose skills in `ghcp/skills/` or agents in `ghcp/agents/`. For agents, the runtime ID `<plugin>:<file-stem>` meets this rule (e.g. `adr-authoring:adr-writer`, `wintermute:orchestrator`), so `wintermute`'s agents keep their plain file names. Name a plugin agent by that ID wherever it is started or matched: `task` `agent_type`, `create_session` `kickoff.agent`, and the dashboard's agent lists. A bare name never resolves to a plugin agent, and a user or project agent with the same file stem loads beside it as a separate agent rather than shadowing it (checked on Copilot CLI 1.0.101-0).
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

Agent files (`ghcp/agents/<name>.agent.md`, or `com.github.copilot/agents/<name>.agent.md` inside an Agent Plugins 1.0 plugin) are simpler than skills:

- Single file, no enclosing per-agent directory.
- Frontmatter contains `description:` (a short line shown in the agent picker — not a router intent string). Add other fields only when the agent needs them, as `orchestrator.agent.md` does for a session-level agent with hard limits: `name`, a `tools` allowlist (the agent can't call unlisted tools; app tools such as `create_session` are listed by bare name), `include-custom-instructions: true`, and `disable-model-invocation: true` (stops other agents starting it as a sub-agent). A helper agent that only other agents start, such as `orchestrator-worker`, sets `user-invocable: false` and must not set `disable-model-invocation: true`, which blocks `task` launches. A helper that runs only as a child session's agent through `kickoff.agent`, such as `session-worker`, sets both: neither blocks `kickoff.agent`. An agent can also set a default `model` (one ID, or a list tried in order) and `reasoning-effort`; a `model` or `reasoning_effort` on the `task` call overrides them.
- A `tools` allowlist also caps the built-in sub-agents the agent starts (`explore`, `task`, `research`, `rubber-duck`, `code-review`, `security-review`): `*` becomes the agent's own list, and `explore`'s fixed list is cut to the tools also on the agent's list (empty for a list with no file tools; with `orchestrator`'s list, only `view`, checked on Copilot CLI 1.0.99-2 with a probe agent that had that list). `general-purpose` and custom agents with their own `tools` list keep their tools. This was checked on Copilot CLI 1.0.95-3, is not documented, and may change. In a `tools` list, name `grep`, `glob` and `web_fetch` directly: the `search` and `web` aliases match nothing in the CLI, and unknown names are dropped silently.
- Body is the agent's system prompt: persona, behavioural rules, operating mode. No mandatory sections.

## Authoring rules specific to this repo

- The **PR-review skills** are inspection-and-reporting only: they must never edit, commit, push, or otherwise mutate a PR. Other skills may write output when the user explicitly asks for it — e.g. `storm-research` writes its HTML report only after the user accepts the offer. Do not add a skill that mutates a PR.
- Do **not** instruct any skill to invoke GitHub's native Copilot PR reviewer.
- Do not invent line numbers or sources, claim commands ran when they didn't, or claim surrounding code was inspected when only the diff was read — these prohibitions are repeated across skills and must be preserved.
- Prefer `gh` CLI and `az` CLI commands over raw HTTP. When REST is insufficient (e.g., review thread resolution), use `gh api graphql` as shown in `rereview-pr/SKILL.md`.

## Working in this repo

- Skills and loose agents in `ghcp/agents/` have nothing to build, test, or lint. Validation = read the changed `SKILL.md` / `.agent.md` and any supporting files it links to, and confirm frontmatter parses, links resolve and the structure matches the conventions above.
- Plugins **do** have tests. After touching anything under `ghcp/plugins/<name>/` or the root `.github/plugin/marketplace.json`, run `npm test && npm run validate` from that plugin's directory. That includes any edit to the orchestrator agents in `wintermute`.
- For `wintermute`, also run `npm run check:layout` from its directory after any change under `ui/`; every view and every cockpit state must report 0 issues.
- Eval kits have tests. After touching anything under `evals/orchestrator/expense-claims/`, run `npm test && npm run check` from that directory. `npm run check` runs the kit's local acceptance checks.
- Agents run `npm run batch -- cleanup` with `--yes` or `--force` only when the user explicitly asks for that action for that batch. Cleanup is a manual option after results review, never an automatic follow-up to an eval.
- Orchestrator eval runs are top-level sessions. The user starts them, or the `eval-runner` driver starts them as detached top-level sessions (`create_session` with `detached: true`) in an overnight batch the user launched. Never start one as a child session, never start one any other way, and never create a run repo (`new-run` without `--dry-run`) without the user's approval; launching a batch is that approval for the batch's runs.
- Commits in this repo follow the user's global policy (no `Co-authored-by` trailers).
