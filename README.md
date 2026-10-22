# 🤖 ai_tools

> A growing collection of AI tools, skills, and prompts I've built and want to share.

This repo is where I park the AI-assistant tooling I find genuinely useful day to day — a set of opinionated **GitHub Copilot CLI skills** for pull request review, a couple of **custom agents** I reach for often, and now **plugins**, installable straight from this repo as a Copilot plugin marketplace. Expanding from there.

If something in here saves you ten minutes, it's done its job. ✨

---

## 📚 Table of contents

- [🤖 ai\_tools](#-ai_tools)
  - [📚 Table of contents](#-table-of-contents)
  - [🧰 What's inside today](#-whats-inside-today)
    - [Plugins](#plugins)
    - [Skills](#skills)
    - [Custom agents](#custom-agents)
  - [💡 Skills vs. agents](#-skills-vs-agents)
  - [📥 Install](#-install)
    - [Plugins (marketplace)](#plugins-marketplace)
    - [Option 1: Symlink (recommended — you get updates with `git pull`)](#option-1-symlink-recommended--you-get-updates-with-git-pull)
    - [Option 2: Copy](#option-2-copy)
    - [Option 3: Cherry-pick a single skill or agent](#option-3-cherry-pick-a-single-skill-or-agent)
  - [▶️ Use the skills](#️-use-the-skills)
  - [🗂 Repository layout](#-repository-layout)
  - [🛠 Authoring conventions](#-authoring-conventions)
  - [📄 License](#-license)

---

## 🧰 What's inside today

### Plugins

This repo is also a **Copilot CLI plugin marketplace** (`ai-tools`). Plugins are self-contained bundles of skills, agents and supporting scripts, installed as one unit.

| Plugin | What it does | Install |
|---|---|---|
| [`adr-authoring`](./ghcp/plugins/adr-authoring/README.md) | Writes evidence-led architecture decision records in **Microsoft Learn-inspired style**. Bundles an agent, a skill, a fixed template, four example pairs, structural validation, and fourteen evaluation briefs. Preserves accepted records and checks decision relevance and audience fit. | `copilot plugin install adr-authoring@ai-tools` |
| [`wintermute`](./ghcp/plugins/wintermute/README.md) | The **orchestrator agents** for the GitHub Copilot app and a **watch-only dashboard** for the swarms they run. Six agents (`orchestrator`, `session-orchestrator`, their `hands-on-` variants, and the `orchestrator-worker` and `session-worker` helpers) plan work and hand it to child sessions and sub-agents. The dashboard shows one card per child session or running sub-agent with its state, progress, cost and anything waiting for you, plus a timeline, plan, board and run history; it opens as a canvas in the Copilot app or in a browser, reads Copilot's local data read-only, and its only network requests are read-only `gh` and `az` queries about pull requests. Agents and dashboard share one version and update together. | `copilot plugin install wintermute@ai-tools` |

`adr-authoring` is a documentation workflow, not a PR-review tool. Ask it to draft an ADR in chat, write an authorized Markdown file, or review an existing ADR. It records supplied decisions by default and recommends architecture only when explicitly asked. Its structural checks do not establish factual accuracy or model-output consistency.

`wintermute` ships the orchestrator agents with the dashboard that watches them, so one `copilot plugin update` updates both. Its agents run under plugin IDs such as `wintermute:orchestrator`; the dashboard canvas is `swarm-dashboard`. The dashboard reads Copilot's local session data, so it shows the swarms that run on the same machine. Its [CHANGELOG](./ghcp/plugins/wintermute/CHANGELOG.md) lists each release and how to move from the old `swarm-dashboard` plugin and symlinked agents.

### Skills

| Skill | What it does | When to invoke |
|---|---|---|
| [`strict-code-review`](./ghcp/skills/strict-code-review/SKILL.md) | First-pass strict senior-engineer review of a GitHub or Azure DevOps PR, a local branch, or a pasted diff. Inspection only — no comments posted, no code changed. | `/strict-code-review <url>`, or "Do a strict review of my branch" |
| [`analyse-pr-feedback`](./ghcp/skills/analyse-pr-feedback/SKILL.md) | Triages reviewer comments into a decision table (agree / disagree / needs clarification) so you can reply intentionally. | "Analyse the feedback on `<url>`" |
| [`rereview-pr`](./ghcp/skills/rereview-pr/SKILL.md) | Focused **second-pass** review: were the previous findings actually addressed? Is the engineer's pushback valid? | "Re-review `<url>`" |
| [`storm-research`](./ghcp/skills/storm-research/SKILL.md) | Runs the Stanford **STORM** research method — five expert perspectives, a contradiction map, a synthesised briefing, and a self-critique — grounded in real web sources. Outputs a chat briefing plus an optional self-contained HTML report. Based on [this article](https://github.com/stanford-oval/storm) that turned [official repo](https://github.com/stanford-oval/storm) into a set of prompts. | "Research `<topic>` deeply" / "STORM `<topic>`". |

The three PR-review skills (`strict-code-review`, `analyse-pr-feedback`, `rereview-pr`) are **provider-neutral** — they work with both **GitHub** and **Azure DevOps** pull requests, and gracefully fall back to local branches or pasted diffs/feedback when remote access isn't available.

Those three are **safe by design**: they only inspect and report. They will not edit files, commit, push, post comments, resolve threads, approve, reject, merge, or close the PR.

[`storm-research`](./ghcp/skills/storm-research/SKILL.md) is a different kind of skill — grounded research, not code review. It reads from the web and writes to disk only when you explicitly accept its offer to save an HTML report.

### Custom agents

| Agent | What it does | How to invoke |
|---|---|---|
| [`andrej`](./ghcp/agents/andrej.agent.md) | Karpathy-flavoured coding guidelines: think before coding, simplicity first, surface tradeoffs, no speculative abstractions. Useful as a delegate for any non-trivial code change where you want a more careful, less eager collaborator. | Ask Copilot to delegate to the `andrej` agent, or wire it into your own workflows. |
| [`azure-arch-diagram`](./ghcp/agents/azure-arch-diagram.agent.md) | Expert Azure architecture diagram creator. Produces **editable draw.io (`.drawio`) files** as raw mxGraph XML, following Microsoft Azure Architecture Centre style guidelines — official Azure2 icons, directional arrows, grouping containers, and a consistent colour palette. Ships ready-made templates for system, network, data-flow, context, and deployment diagrams. | Ask Copilot to delegate to the `azure-arch-diagram` agent, e.g. "draw an Azure architecture diagram for…". |

#### Orchestrator agents (in the `wintermute` plugin)

These six agents ship in the [`wintermute`](./ghcp/plugins/wintermute/README.md) plugin, not as loose files: install the plugin with `copilot plugin install wintermute@ai-tools`. Their runtime IDs are `wintermute:<name>`, for example `wintermute:orchestrator`; the agent picker shows the plain name.

| Agent | What it does | How to invoke |
|---|---|---|
| [`orchestrator`](./ghcp/plugins/wintermute/com.github.copilot/agents/orchestrator.agent.md) | Coordinator for multi-PR work in the GitHub Copilot app. Plans, delegates, and tracks, but has **no shell, file-editing, search, web, or MCP tools**. Its one file tool, `view`, is limited to attachments, the file you give it as the brief or spec, and its own session files, so every other lookup and every change goes elsewhere: owned work (a branch, PR, or ongoing workstream) and jobs that need other agents to a nested child session, other one-off jobs to an `orchestrator-worker` sub-agent. Keeps its plan and a registry of child sessions in the session SQL database. Picks a model and reasoning effort for every child session and sub-agent from the tiers in its "Models and effort" section; edit them to match the models you have. Follows version 1 of the swarm dashboard data contract: each child report starts with a status line, a `children` table records each child's branch, PR and outcome, and every question to you is tagged with the units it concerns. | In the GitHub Copilot app (it relies on the app's session tools), select it as the session's agent before your first message: add the `orchestrator` chip from the composer's **+** menu, or pick it with `/agent`. Where a tool or flag takes an agent ID, use `wintermute:orchestrator`. |
| [`orchestrator-worker`](./ghcp/plugins/wintermute/com.github.copilot/agents/orchestrator-worker.agent.md) | Helper for `orchestrator` and `hands-on-orchestrator`. Does their one-off jobs (research, checks, reviews, documents, commands) with shell, file, search, and web tools, but has no tools to start sub-agents or create sessions. Runs on Opus at high effort unless the orchestrator sets a model and effort for the job, which it normally does. | Not invoked directly, and hidden from the agent picker. `orchestrator` and `hands-on-orchestrator` start it through the `task` tool as `wintermute:orchestrator-worker`. |
| [`session-orchestrator`](./ghcp/plugins/wintermute/com.github.copilot/agents/session-orchestrator.agent.md) | A variant of `orchestrator` that delegates only to child sessions and never starts sub-agents. One-off jobs (research, checks, reviews, documents, commands) get one-off sessions, which it archives when their results are in. Its children run as `session-worker` and can't start agents of their own, so it plans all fan-out up front, and children ask it when they need a helper. Otherwise the same as `orchestrator`, including the model tiers and version 1 of the swarm dashboard data contract. It can run side by side with `orchestrator`. | Select it as the session's agent in the GitHub Copilot app, as for `orchestrator`: the `session-orchestrator` chip, or `/agent`. Its ID is `wintermute:session-orchestrator`. |
| [`session-worker`](./ghcp/plugins/wintermute/com.github.copilot/agents/session-worker.agent.md) | The agent every child session of `session-orchestrator` and `hands-on-session-orchestrator` runs as. Has shell, file, search, web, GitHub and PR tools, but no tools to start sub-agents or sessions; it asks the orchestrator for a helper instead. Reports in the swarm dashboard format. | Not invoked directly, and hidden from the agent picker. `session-orchestrator` and `hands-on-session-orchestrator` set it as each child session's agent, as `wintermute:session-worker`. |
| [`hands-on-orchestrator`](./ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-orchestrator.agent.md) | A variant of `orchestrator` that may do a quick job itself: one it can finish in about five tool calls or about two minutes, such as reading a file or log, a grep, a `git` or `gh` status check, one web fetch, a note in its session files, or a small edit committed and pushed on its own session branch. Most work is still delegated, to child sessions and `orchestrator-worker` sub-agents. It has shell, file, search and web tools for those quick jobs, and the app's `create_pull_request` and `update_pull_request` tools for its own PR, but no MCP tools. It never writes to a child's branch or worktree, and never reviews or checks work itself: its own commits get a PR, a claims check and a review from another vendor, like any child's unit. | Select it as the session's agent in the GitHub Copilot app, as for `orchestrator`: the `hands-on-orchestrator` chip, or `/agent`. Its ID is `wintermute:hands-on-orchestrator`. |
| [`hands-on-session-orchestrator`](./ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-session-orchestrator.agent.md) | The same change made to `session-orchestrator`: it may do the same quick jobs itself, still never starts sub-agents, and delegates everything else to child sessions that run as `session-worker`. | Select it as the session's agent in the GitHub Copilot app: the `hands-on-session-orchestrator` chip, or `/agent`. Its ID is `wintermute:hands-on-session-orchestrator`. |

---

## 💡 Skills vs. agents

Both are markdown files the [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) loads on demand — they differ in *how* they're activated.

**Skills** live at:

```
~/.copilot/skills/<skill-name>/SKILL.md
```

The CLI auto-routes to a skill when the user's intent matches its `description`, and you can also invoke a skill by name with `/<skill-name>`. Each `SKILL.md` is markdown with a small YAML frontmatter block:

```yaml
---
name: my-skill
description: >-
  Use this skill when the user asks to ...
---

# My Skill

You are ...
```

**Custom agents** live at:

```
~/.copilot/agents/<agent-name>.agent.md
```

Agents aren't auto-routed the way skills are. They are either delegated to through Copilot's `task` tool (by you or by the model), where they run in their own context window, or selected as the session's main agent (`/agent`, `--agent`, or the app's composer). Frontmatter is usually just a short `description`; the body is the agent's system prompt:

```yaml
---
description: One-line description shown in the agent picker.
---

# My Agent

Behavioural rules, persona, and operating instructions go here.
```

An agent can also limit itself with a `tools` allowlist: the agent can't call tools that aren't on the list. The list also caps the built-in sub-agents it starts (`explore`, `task`, `research`, `rubber-duck`, `code-review`, `security-review`), which get at most the listed tools. `general-purpose` sub-agents and custom agents with their own `tools` list keep their tools. `orchestrator` uses this to remove every execution tool from itself, and sets `disable-model-invocation: true` so other agents can't start it as a sub-agent. It hands one-off jobs to `orchestrator-worker`, whose own list gives it shell, file, and web tools but no tools to start sub-agents or create sessions. The `hands-on-` variants also list shell, file, search, and web tools, for the quick jobs they may do themselves, and the app's `create_pull_request` and `update_pull_request` tools, for their own PR.

Rule of thumb: use a **skill** when the CLI should pick it up automatically from a user phrase, and an **agent** when you (or another agent) want to deliberately hand off a chunk of work to a specialist, or run a whole session under a fixed role.

---

## 📥 Install

Plugins install through the Copilot CLI. Skills and agents are plain files you symlink or copy into `~/.copilot/`.

### Plugins (marketplace)

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install adr-authoring@ai-tools
copilot plugin list
```

To iterate on a plugin locally, register your clone as the marketplace instead and reinstall after each edit — Copilot caches installed components:

```bash
copilot plugin marketplace add ~/src/ai_tools
copilot plugin install adr-authoring@ai-tools
```

Direct installs from a repo, URL or local path (`copilot plugin install ./ghcp/plugins/adr-authoring`) still work, but the CLI marks them deprecated in favour of `plugin@marketplace`.

For the orchestrator agents and the swarm dashboard, install `wintermute`:

```bash
copilot plugin install wintermute@ai-tools
```

To update it, run `copilot plugin update wintermute@ai-tools`. After you install or update it, start new sessions, or restart the Copilot app, to get the new agents: a running session keeps the agents it started with. Reloading extensions in a session, or restarting the app, refreshes the dashboard canvas. Changes to the agents reach you through a plugin update after they merge, not through `git pull`.

If you used the `swarm-dashboard` plugin or symlinked the orchestrator agents into `~/.copilot/agents/`, follow the migration steps in the [`wintermute` CHANGELOG](./ghcp/plugins/wintermute/CHANGELOG.md) first: old copies in `~/.copilot/agents/` stay separate agents with the same names in the picker and run the old prompts, and two plugins with the `swarm-dashboard` canvas clash.

### Option 1: Symlink (recommended — you get updates with `git pull`)

```bash
git clone https://github.com/ncksol/ai_tools.git ~/src/ai_tools

# Skills
mkdir -p ~/.copilot/skills
for skill in ~/src/ai_tools/ghcp/skills/*/; do
  ln -sfn "$skill" ~/.copilot/skills/"$(basename "$skill")"
done

# Agents
mkdir -p ~/.copilot/agents
for agent in ~/src/ai_tools/ghcp/agents/*.agent.md; do
  ln -sfn "$agent" ~/.copilot/agents/"$(basename "$agent")"
done
```

To update, run `git -C ~/src/ai_tools pull`, then run both loops again. `git pull` updates the skills and agents you have already linked, but a new one needs a link of its own. The `-n` flag makes a rerun replace each existing link instead of creating a new link inside the folder it points to.

The loops cover the loose skills and agents only. The orchestrator agents come with the `wintermute` plugin; don't link them into `~/.copilot/agents/`, where they would show up as separate bare-named agents beside the plugin's `wintermute:` ones.

### Option 2: Copy

```bash
git clone https://github.com/ncksol/ai_tools.git
cp -R ai_tools/ghcp/skills/* ~/.copilot/skills/
cp    ai_tools/ghcp/agents/*.agent.md ~/.copilot/agents/
```

To update, run `git -C ai_tools pull`, then run both `cp` commands again.

### Option 3: Cherry-pick a single skill or agent

```bash
# A skill: download SKILL.md and every file it links to.
# strict-code-review, for example, also needs the files in its references/ directory.
base=https://raw.githubusercontent.com/ncksol/ai_tools/main/ghcp/skills/strict-code-review
for f in SKILL.md references/azure-devops.md references/checklist.md \
         references/github.md references/local.md references/pasted-diff.md; do
  curl -fsSL --create-dirs "$base/$f" -o ~/.copilot/skills/strict-code-review/"$f"
done

# An agent
mkdir -p ~/.copilot/agents
curl -fsSL https://raw.githubusercontent.com/ncksol/ai_tools/main/ghcp/agents/andrej.agent.md \
  -o ~/.copilot/agents/andrej.agent.md
```

Don't fetch the orchestrator agents this way: they start their workers by `wintermute:` IDs, which only the `wintermute` plugin provides. Install the plugin instead.

Restart your Copilot CLI session and you're done.

---

## ▶️ Use the skills

Once installed, describe what you want and the CLI routes to the best match, or invoke a skill by name with `/<skill-name>`:

```text
> /strict-code-review https://github.com/acme/widgets/pull/482
  → runs strict-code-review on that PR

> Do a strict review of my current branch before I open a PR
  → activates strict-code-review

> The reviewer left a bunch of comments on PR 482 — help me triage them
  → activates analyse-pr-feedback

> I pushed fixes for the review comments on PR 482, can you re-review?
  → activates rereview-pr
```

Pasted diffs, local branch names, and Azure DevOps URLs all work too.

For a PR URL, start the prompt with `/strict-code-review`. When many skills are installed, the CLI may describe only some of them to the model, so a prompt such as "Review this PR: `<url>`" can go to another review skill.

`strict-code-review` reads files from its `references/` directory while it runs. In non-interactive runs (`copilot -p`), the CLI cannot ask for approval, so it refuses those reads unless you give it read access to the skill's resolved directory. Installed skills are often symlinks and the CLI checks the real path, so `--add-dir ~/.copilot/skills` is not enough:

```bash
copilot -p "<your request>" --add-dir "$(realpath ~/.copilot/skills/strict-code-review)"
```

Without that access, the skill stops with `Review incomplete` and says how to grant it.

---

## 🗂 Repository layout

```
ai_tools/
├── README.md                          ← you are here
├── .github/
│   ├── copilot-instructions.md        ← guidance for Copilot working in this repo
│   └── plugin/
│       └── marketplace.json           ← makes this repo the `ai-tools` plugin marketplace
└── ghcp/                              ← GitHub Copilot CLI artefacts
    ├── skills/
    │   ├── strict-code-review/
    │   │   ├── SKILL.md
    │   │   └── references/            ← provider adapters and the review checklist
    │   ├── analyse-pr-feedback/
    │   │   └── SKILL.md
    │   ├── rereview-pr/
    │   │   └── SKILL.md
    │   └── storm-research/
    │       └── SKILL.md
    ├── agents/
    │   ├── andrej.agent.md
    │   ├── azure-arch-diagram.agent.md
    │   └── eval-runner.agent.md
    └── plugins/
        ├── adr-authoring/             ← self-contained plugin (own manifest, tests, LICENSE)
        │   ├── plugin.json
        │   ├── package.json
        │   ├── agents/                ← adr-writer.agent.md
        │   ├── skills/
        │   │   └── adr-write/         ← template, style, rubric, and examples
        │   ├── evaluations/           ← ten briefs and a repeatability procedure
        │   ├── scripts/               ← structural and packaging validators
        │   └── tests/
        └── wintermute/                ← the orchestrator agents and the swarm dashboard
            ├── plugin.json
            ├── package.json
            ├── CHANGELOG.md
            ├── engine/                ← reads Copilot's local data into swarm snapshots
            ├── server/                ← local server, shared port and canvas host
            ├── ui/                    ← the dashboard page, no build step
            ├── com.github.copilot/    ← agents/ (the six orchestrator agents) and the canvas extension
            ├── scripts/               ← launcher, snapshot command, layout check, validator
            └── tests/
```

The top-level `ghcp/` namespace leaves room for more Copilot-CLI things later, and for sibling namespaces for other tools — `claude/`, `cursor/`, `prompts/`, etc. — as the collection grows.

Plugins are vendored **intact** under `ghcp/plugins/<name>/`: each keeps its own `plugin.json`, tests and LICENSE. The single marketplace manifest lives at the repository root and points at each plugin directory via its `source` field, so a plugin never carries its own `marketplace.json`.

---

## 🛠 Authoring conventions

The PR-related skills here all share the same shape so they feel like a coherent set rather than three random prompts. If you're contributing a new skill — or extending an existing one — please keep these in mind:

- **Frontmatter `name` matches the directory name** (kebab-case).
- **`description` is written for the router**, not the human reader. State *exactly when this skill should activate*, including the verbs a user is likely to say.
- **Safety rules up top.** Be explicit about what the skill must NOT do (edit, commit, push, post comments, approve, merge, …). Inspection-only skills are the default here.
- **Provider-neutral** for any PR/repo workflow: support GitHub *and* Azure DevOps, with adapters for local branches and pasted input.
- **Shared severity vocabulary**: `Critical | High | Medium | Low`.
- **Concrete commands, not vibes.** Show the exact `gh` / `az` invocations to use, including the GraphQL query for GitHub review-thread resolution state (REST doesn't expose it reliably).
- **Prescribed output format** — usually a markdown table — so results are skimmable and comparable across runs.
- **Forbid hallucination**: don't invent line numbers, don't claim a command ran when it didn't, don't claim surrounding code was inspected when only the diff was read.

The three existing `SKILL.md` files are the reference; copy their structure when adding a new one.

---

## 📄 License

MIT — do whatever is useful. Attribution is appreciated but not required.
