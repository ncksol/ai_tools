# Wintermute in Copilot app Projects: design

Date: 29 October 2026. Status: draft for the user's approval. Scope: the `wintermute` plugin in `ncksol/ai_tools` (`ghcp/plugins/wintermute/`), built on version 0.3.3 at `origin/main` commit `d0a3b8d`, and GitHub Copilot app 1.1.33 Projects (public preview). Repository paths and line numbers refer to that commit.

## How to read this

- Section 7 holds the user's decisions. They are fixed.
- Choices made on the user's behalf are marked **(designer's call)**, each with a one-line reason. None is formally approved.
- Section 9 lists what is left to the builder, and section 10 the unknowns to check before or during the build.
- "Inference" marks a claim that was not checked directly.

Evidence notation:

| Tag | Source |
|---|---|
| [PC §n] | `projects-contract.md`, section n (or §A–§D), in the orchestrator's files folder `/Users/nicksologoub/.copilot/session-state/e0c34f1a-6bb3-4fb1-82c0-1978a6b221f8/files/`. The app side: what a Project is, its contract, tools and limits. |
| [WF §n] | `wintermute-fit.md`, same folder. Our side: engine, agents, mapping, options. |
| [PP] | `projects-public.md`, same folder. What GitHub has published. |
| [FC] | `design-factcheck.md`, same folder. Read-only checks of app strings, `data.db` rows and repository source. |
| [DS §10] | `docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md`, section 10: the dashboard data contract, version 1. |
| [HSO "…"] | `ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-session-orchestrator.agent.md`, the named section. |
| [SW] | `ghcp/plugins/wintermute/com.github.copilot/agents/session-worker.agent.md`. |
| [E1:n] | Line n of the "Expense reports" Project's log, `~/.copilot/session-state/a36bd31e-b7da-41d1-8ebb-368b40434038/events.jsonl`. |
| [C1:n] | Line n of the log of a child that Project created ([E1:1371-1372]), `~/.copilot/session-state/01af1df6-0da0-4cd6-a22f-efaaf53bae83/events.jsonl`. |
| [S n] | Line n of `strings -n 20 /Applications/GitHub.app/Contents/MacOS/github` for the installed app 1.1.33. A string in the binary, not a source line. |
| [CL:n] | Line n of the installed Copilot CLI changelog, `~/.copilot/pkg/darwin-arm64/1.0.104/changelog.json`. |
| [K1]–[K8] | Checks made for this document, listed below. |

Checks made for this document (all read-only):

- **K1.** [E1:289] and [E1:380]: when a skill loads in a Project, its context starts with `Base directory for this skill: <absolute path>`, then a list of its related files.
- **K2.** In E1, compactions complete at lines 880, 1160, 1835 and 2980. Skills are invoked again after them, for example `skill.invoked_ref` for `brainstorming` at line 1294. `skill.invoked` and `skill.invoked_ref` events carry `name`, `path`, `source: "plugin"`, `pluginName` and `trigger` (`user-invoked` at line 5, `agent-invoked` elsewhere). The log doesn't show what caused the later invocations.
- **K3.** E1 has no `open_canvas` tool call. The dashboard canvas record at [E1:2949] has the instance id `plugin-wintermute-swarm-dashboard-swarm-dashboard`. Inference: the user opened it from the app's UI.
- **K4.** [E1:2947]: Project child "Expense rules" (workspace `2abb1719`, CLI session `add99e31`) reported that every shell action was denied, because the autopilot child had no way to get command approval.
- **K5.** Sizes of the two sections that the coordinator skill borrows from the installed agent file, measured with `awk` and `wc -c`: "Models and effort" 8,420 bytes, "Evidence and review" 7,125 bytes. The cross-references inside them are "Choose the delegation type", "Plan by stage", "Talking to the user", "Security review" (a bold label inside "Evidence and review"), and the two sections themselves.
- **K6.** The Agent Plugins specification (https://agent-plugins.org/, fetched 2026-10-29) puts portable skills in a top-level `skills/<name>/SKILL.md` folder and client-specific parts in reverse-domain folders. The Copilot CLI changelog says Agent Plugins plugins read `commands/`, `agents/`, `rules/`, `hooks/hooks.json`, `lsp.json` and `extensions/` only under `com.github.copilot/`. Skills are not in that list.
- **K7.** The Agent Skills specification (https://agentskills.io/specification, fetched 2026-10-29): a skill's `name` must match its folder name. `allowed-tools` is experimental and pre-approves tools; it doesn't restrict them.
- **K8.** `scripts/lib/validate-package.mjs:5-9,82-115` checks the six packaged agents, rejects an `agents` field in `plugin.json`, rejects bare agent IDs and checks the CHANGELOG. It checks no skills. No test in `tests/` or `scripts/` guards the shared sections today (grep).

## 1. Intent and why

The user's words:

- "GitHub Copilot team just released new feature "Projects" in the GitHub Copilot App. Lets see if we can somehow integrate our orchestrator and dashboard into that. Can they work together? Compliment each other?"
- "Can we maybe somehow setup the main project session so that it behaves like our agent? That would serve the same goal as running custom agent"
- "Projects seems to be a new way how to use this app. I feel like it specifically fits into our idea of agentic swarm work. So I was wondering if I can take what I can from our wintermute plugin and enhance Projects with it, while keeping the UI/UX from the new Projects feature."

A Project is already a durable coordinator. It creates repository-backed child sessions, tracks them in its Overview, collects deliverables in its Inbox and Library, and runs its own schedules [PC §1, §5; PP]. What it lacks is the discipline wintermute's orchestrators add: a split into units, a model and effort chosen for each job, an independent review from another vendor and a claims check before every merge, and limits on repair cycles [HSO "Models and effort", "Evidence and review"]. The dashboard adds what the Overview doesn't show: cost, sub-agents, the model per child and the cockpit view [WF §3].

A Project can't run our orchestrator as its agent: the app rejects custom agents in a Project's lineage [PC §2, §C]. It does load plugin skills, and so do its children [PC §A; C1:22]. So the plan is to bring the discipline in as skills, keep the Project as the face of the work, and teach the dashboard to read the Project.

## 2. Goals

1. A Project that the user opts in runs swarm work with wintermute's discipline: units, a tier per child, an independent cross-vendor review and a claims check before every merge, and repair-cycle limits.
2. The Project's own UI keeps working as designed. Overview, Inbox, Library and Automations get the data they expect: typed reports, assignment IDs, short handoffs, deliverables published by the session that made them, and Project-owned schedules.
3. The dashboard, opened inside the Project, shows the whole swarm: every child, sub-agents, cost, the model per child, and the cockpit.
4. The model policy and the review rules stay in one place, the installed `hands-on-session-orchestrator.agent.md`.
5. Opt-in per Project.

## 3. Non-goals

- Changing the six existing agents or their behaviour. They stay as they are for top-level sessions and evals (decision 5).
- Replacing the Project's built-in coordinator prompt or any of its UI.
- Hard tool limits in a Project. A skill can't remove tools [PC §A, §C; K7].
- Approach B, generating agents and skills from shared fragments. It can come later.
- Event subscriptions (`manage_event_subscriptions`) for PR monitoring. The feature is gated, with a rollout date of 2026-11-06 [PC §3, §4].
- Dashboard controls. The dashboard stays watch-only [DS §3].
- A hook that bootstraps the skill (decision 4).
- Running wintermute swarms across several Projects, or with `create_persistent_project`.
- Any change to the eval kit.

## 4. Anti-goals

The design fails, even if it technically works, when:

- a Project or an ordinary session gets wintermute's rules without the user asking for them;
- the Project's Overview or Inbox gets worse: reports the app can't route, long handoffs that flood the coordinator, deliverables that never reach the Inbox, or unchecked work that does;
- the model policy or the review rules exist in another copy that drifts from the agent file;
- the coordinator skill runs without the two sections it borrows, and nobody notices;
- the dashboard crashes, or shows wrong data, when the app changes its Project tables;
- a child loads the coordinator skill and starts to coordinate.

## 5. Constraints

App (Copilot app 1.1.33, public preview, "subject to change" [PP]):

- **C1. No custom agents in a Project's lineage.** The app rejects them in the Project's conversation and, by strong static evidence, in `create_session` for its children. Not tested [PC §2, §C].
- **C2. Children can't create app sessions.** They can run `task` sub-agents and schedule themselves [PC §3, quoting `<copilot_coordinated_child>`].
- **C3. A broad default tool set, with no allowlist.** The default Project has used shell, file editing, SQL, `task` sub-agents, child creation, skills and publishing (`bash`, `apply_patch`, `sql`, `task`, `create_session`, `skill`, `publish_chat_update`). No restrictive coordinator allowlist was observed. The complete set of tools it is offered was not captured. Its prompt asks it to delegate checkout work, but nothing enforces that [PC §C].
- **C4. A Project has no checkout.** Its working folder is under `~/.copilot/chats/`. `create_session` needs a `project_id` for a repository registration that the Project owns; the Project adds repositories with `add_repositories`, `add_repository(show_in_sidebar:false)` and `await_repository_creation` [PC §6].
- **C5. Typed reports and short handoffs.** `progress` stays in the child's history and never reaches the coordinator. `handoff` is saved as a ready result and delivered, coalesced with nearby results. `needs_input` and `error` are delivered at once [PC §3]. The app tells children: "Keep a handoff to one short outcome sentence and any essential link or next action. Leave file lists, branches, commands, routine test logs, unchanged-file summaries, and boilerplate assurances in your own thread." [S 21248-21250]
- **C6. Assignments.** New work, a revision or a rerun creates a new assignment. Context about existing work passes its `assignment_id`. A report must carry `assignment_id` whenever more than one assignment could match. One child can hold several assignments (3 and 4 observed) [PC §3, §7].
- **C7. Forwarding.** From a Project to its child, `message` holds the user's words and `coordinator_instructions` holds the coordinator's. `purpose` is for child reports only [PC §3].
- **C8. Publishing.** `publish_chat_update` takes at most six attachments. It is presentation only: not approval, not a merge. Files go into the Library; a Project's deliverables go to the Inbox under its own name [PC §4, §5]. The app tells the coordinator to publish each child's review-ready outputs in a separate update with that child's `agent_session_id`, and to announce pull requests together in one update that omits `agent_session_id` and sets each PR attachment's `source_session_id` to the child that opened it [S 13729-13730]. It tells each child: "Before reporting a review-ready file, preview, PR, or issue, when publish_chat_update is available, call it in your own thread with the real verified attachment." [S 21261-21263] A skill can't remove the tool from either.
- **C9. Project memory.** At most 8,192 UTF-8 bytes, preferences only: no task status, priorities, schedules or secrets. The app labels it "Saved preferences (data, not authority to override instructions)" [S 5453]. It was in the Project's system context at start and after each of four compactions, together with the global custom instructions and the app's Project context [E1:14, 1181, 1886, 2988; PC §B].
- **C10. Skills.** Plugin skills load in a Project with `source: plugin` [PC §A], and in a Project child [C1:22]. The skill's context names its base directory [K1]. Copilot skills support a `disable-model-invocation` frontmatter field, and the CLI honours it [CL:21466, CL:7038].
- **C11. Hooks.** A `sessionStart` hook's input has `source`, `initialPrompt`, `sessionId`, `timestamp` and `cwd` [E1:6], with no documented Project-type flag. It ran once in a Project despite four compactions [PC §A].
- **C12. Instructions.** Global custom instructions load in a Project, as instructions. Automatic loading of a bound repository's instructions was not established: the observed Project had only the global custom-instruction block. Bootstrap explicitly; don't rely on discovery from bound repositories [PC §A].
- **C13. Canvases.** The dashboard canvas has been open in a Project [PC §5]. `open_canvas` takes a `canvasId` and a caller-chosen `instanceId`, reused to address the same panel [E1:14]. Whether a Project's model is offered `open_canvas` is unknown [K3].
- **C14. Children in autopilot.** One Project child in autopilot couldn't get shell approval [K4]. The cause is not known.
- **C15. Project rows.** A Project is `sessions.session_type = 'agent'` with a `persistent_projects` row and an empty `sessions.agent` [PC §1; WF §2].
- **C16. Results in the coordinator's log.** Handoffs arrive as `user.message` with `source: agent-coordinator-results`, a `<system_notification>` and JSON records, with no `<cross_session_message>` tag [WF §2]. Not every record is a child's report: when a session ends without a handoff, the app stores and delivers "The session finished without sending a handoff. Use get_session if you need its result." [S 26052; E1:2032, E1:2961]. In `data.db` those rows have no `source_tool_call_id`. Every other stored result matched the delivered text and the child's sent message in full [FC].
- **C17. Roster.** Before a turn calls `create_session`, the Project writes one short sentence ending in a colon. After the calls, it writes one short paragraph that summarizes what the new sessions are doing, "without bullets or session references", a few words per session. New work, a revision or a rerun sent to existing sessions gets one sentence with the real references inline [S 13719-13725].
- **C18. Relays.** `relay_session_input` asks the user a child's pending question and pauses "until it is resolved, like ask_user". It also finishes if the user answers in the child or the question is withdrawn [S 93876]. A result with `outcome: "answered_here"` says the answer was delivered: "don't send it again" [E1:1838, E1:1853].

Engine:

- **C19.** The engine reads a fixed list of `data.db` tables and columns (`engine/readers/app-db.mjs:9-67`). A missing table produces a warning diagnostic, a missing optional column an informational note, and reading goes on [WF §1, §5].
- **C20.** The child-linking fix is merged: PR #91, at `d0a3b8d`, links every session that a chat or a Project created to it (`engine/model/forest.mjs:88-95`; `tests/forest-creator.test.mjs`).

Repository (`.github/copilot-instructions.md`):

- **C21.** Every change under `ghcp/plugins/wintermute/` bumps the version in `plugin.json`, `package.json` and the root `.github/plugin/marketplace.json`, with a CHANGELOG entry, and runs `npm test && npm run validate` from the plugin folder. UI changes also run `npm run check:layout`.
- **C22.** Skill names inside a plugin stay namespaced to that plugin. No copy of a plugin's skills goes into `ghcp/skills/`. Every `SKILL.md` starts with `name` and `description` frontmatter and has an Operating mode section, an Output format and the rules against invented results.
- **C23.** Agent Plugins 1.0 plugins load agents only from `com.github.copilot/agents/`.
- **C24.** The plugin stays Node 18 compatible; `tests/guards.test.mjs` fails on a listed set of newer Node APIs and on `t.after`/`t.before` in tests.
- **C25.** The four orchestrator files stay in step, with word-for-word shared text, and the report block in the session orchestrators matches `session-worker` word for word.

## 6. Approaches considered

All three put the rules in two skills. They differ in where the shared rules live.

| | A. Copy | B. Generate | C. Reference (chosen) |
|---|---|---|---|
| How | Copy "Models and effort", "Evidence and review" and other shared text into the skills. | A Node script writes the agents and skills from shared fragments; a test fails on stale output. | Write both skills fresh for Projects. At load, the coordinator skill reads the two sections from the installed `hands-on-session-orchestrator.agent.md`. A test guards the headings. |
| Gain | Fastest to ship. Each skill is self-contained. | Most durable: one source for every shared passage. | Policy in one place; the Project-specific text stays easy to rewrite. |
| Cost | Every model-policy or review-rule change then touches 6 files instead of 4. | The biggest change, and the slowest to ship. | About 15 KB more to read each time the skill loads [K5]. |

Why C: Projects is a public preview that will change, so the Project-specific parts should stay easy to rewrite, while the policy the user changes most stays in one place. B can come later if the copies still hurt.

## 7. The user's decisions

1. The Project stays the coordinator and the face of the work. Its Overview, Inbox, Library and Automations stay as they are. Our rules follow the Project's conventions wherever they feed that UI: assignment IDs, typed `purpose` reports, short handoffs, and publishing deliverables to the Inbox.
2. Wintermute adds the discipline the Project lacks, through a coordinator skill the Project loads: splitting work into units, a model and effort per child, an independent review from another vendor's model and a claims check before every merge, and limits on repair cycles. Children get a matching worker skill, because the app very likely won't run `wintermute:session-worker` under a Project (custom agents are gated by Project lineage; strong static evidence, not tested).
3. The dashboard becomes a companion panel inside the Project for what the Overview doesn't show: cost, sub-agents, the model per child, and the cockpit view. For that, the engine must read the Project's data. The child-linking fix is merged (PR #91): every session that a chat or a Project created links to it.
4. Opt-in per Project: the user turns it on by invoking the skill, or with a line in the Project's memory, not through a hook that runs in every session. Reason: a `sessionStart` hook's input has no documented Project-type flag (C11), and not every Project is swarm work.
5. The existing orchestrator agents stay unchanged, for top-level sessions and for the evals. They keep the hard tool limits that a Project can't have.
6. Approach C, "Reference". Both skills are written fresh for Projects. When the coordinator skill loads, it reads "Models and effort" and "Evidence and review" from the installed `hands-on-session-orchestrator.agent.md` instead of copying them. A test guards those section headings. The extra ~15 KB per load is accepted.

## 8. Design

### 8.1 The pieces

| Piece | Where | What it does |
|---|---|---|
| Coordinator skill `wintermute-project` | `ghcp/plugins/wintermute/skills/wintermute-project/SKILL.md` | Loaded by the Project. Adds wintermute's planning, delegation, review and reporting rules on top of the Project's built-in coordinator. Reads two sections from the agent file at load. |
| Worker skill `wintermute-project-worker` | `ghcp/plugins/wintermute/skills/wintermute-project-worker/SKILL.md` | Loaded by each child on the kickoff's instruction. The child-side rules: evidence, gates, publishing, helper requests, reports. |
| Borrowed sections | `com.github.copilot/agents/hands-on-session-orchestrator.agent.md`, "Models and effort" and "Evidence and review" | Unchanged. They also feed Projects. |
| Engine and dashboard | `engine/`, `ui/` | Read Project roots, Project results, relays and Project-owned schedules. |
| Validator and tests | `scripts/`, `tests/` | Package the skills; guard the headings and cross-references. |

- Skill names **(designer's call)**: `wintermute-project` and `wintermute-project-worker`. Reason: namespaced to the plugin (C22), short to type as `/wintermute-project`, and they say they are for Projects.
- Skill location **(designer's call)**: a top-level `skills/` folder in the plugin. Reason: it is the Agent Plugins location for portable skills, and the CLI's move to `com.github.copilot/` didn't include skills [K6]. Unknown U2 confirms it; if the CLI loads skills only from `com.github.copilot/skills/`, move them there and update the relative path in 8.3.3.

### 8.2 Turning it on, and recovering after a compaction

**Opt-in.** The user turns a Project on in one of two ways (decision 4):

- types `/wintermute-project` with or before the goal in the Project's conversation; or
- has this line in the Project's memory, through Settings or by asking the Project to save it:

  > Wintermute: for swarm work in this Project, follow the `wintermute-project` skill. If its rules aren't in your context, load it before you plan or dispatch work.

The skill's `description` says to load it only on `/wintermute-project` in a Copilot app Project, or when the Project's memory says to. It names no general triggers such as "swarm" or "parallel work" **(designer's call)**. Reason: anti-goal 1; the skill router must not pick it up in ordinary sessions.

**Neither skill sets `disable-model-invocation` (designer's call).** Copilot skills support the field (C10), but the model must be able to load the coordinator skill again from the memory line after a compaction, and each child loads the worker skill on its kickoff's instruction. The guards are the narrow description and the scope checks (8.3.1, 8.4). Reason: the field would block the only automatic recovery path and the worker's loading.

**The memory line (designer's call).** When the user invokes the skill and the Project's memory lacks the line, the coordinator adds it with `update_project_memory`. It keeps every existing line unchanged, stays within 8,192 bytes, and tells the user in one line what it saved and how to remove it. If the tool is missing or the limit would be exceeded, it asks the user to add the line in Settings. Reason: Project memory stays in the Project's system context through compactions (C9), and invoking the skill in this Project is the user's opt-in to a per-Project preference.

**Recovery after a compaction or a resume (designer's call).** The memory line is the proposed recovery trigger, subject to U5. It is not verified behaviour: memory is labelled data, not authority (C9), and no log yet shows a memory line causing a skill to load (K2). What is known is that Project memory, the global custom instructions and the app's Project context all survived the four observed compactions (C9).

- Until U5 passes, the documented recovery is that the user invokes `/wintermute-project` again.
- If U5 shows that the memory line doesn't trigger a reload, the fallback is a conditional line in the user's global custom instructions (`~/.copilot/copilot-instructions.md`), which load as instructions rather than data (C12). For example: "In a Copilot app Project whose memory names the `wintermute-project` skill, load that skill before you plan or dispatch work if its rules aren't in your context." It is added only with the user's consent, because it is their personal file.
- Reason: only system-context sources survive a compaction, and decision 4 rules out a hook.

On every load the skill:

1. reads the two borrowed sections again (8.3.3);
2. reads its SQL state (`todos`, `tasks`, `children`, `child_notes`, `unit_assignments`);
3. calls `get_session` for every child that `child_notes` doesn't mark as archived, and reconciles what changed, before it dispatches anything new [HSO "State and registry"].

**Turning it off.** The user removes the memory line and tells the Project to stop. The skill says to stop applying its rules from then on. Its tables stay, so the dashboard keeps the record.

### 8.3 Coordinator skill `wintermute-project`

The skill is a prompt to the Project's built-in agent, written fresh for Projects. It follows the repository's `SKILL.md` conventions (C22): an Operating mode section with its safety limits, a prescribed Output format (the roster, question tags and user updates in 8.3.8), and the rules against invented status, results and sources.

#### 8.3.1 Scope check

The skill runs only in a Project's own conversation **(designer's call)**. Its first instruction checks the context:

- The system context has the app's persistent-Project block ("You are a persistent Project…", `<copilot_persistent_agent>` [PC §1]): go on.
- The context has `<copilot_coordinated_child>` [PC §3]: this is a Project child. Stop, and load `wintermute-project-worker` instead if the kickoff asked for it.
- Neither: this is an ordinary session. Stop, and tell the user that in a top-level session the `wintermute:` orchestrator agents do this job.

Reason: it keeps children and ordinary sessions from applying coordinator rules (anti-goal 6) and keeps the agents and the skill from overlapping, as a guard that still lets the model load the skill (8.2).

#### 8.3.2 Tools and quick jobs

The Project has shell, edit, `sql`, `task`, `create_session` and more (C3). The skill can't remove them, so the hands-on rules apply as soft limits, written fresh in a section of the skill:

- A quick job is one the coordinator can finish in about five tool calls or about two minutes: read a file, a log or a Library item; grep; `gh` or `git` status commands for PR state and CI; one web fetch; a note in the Project's own files folder.
- **The Project makes no repository commits (designer's call).** Every repository edit goes to a child, so the hands-on `own_units` flow and table are not used. Reason: the Project has no checkout (C4), the app's own prompt delegates checkout work [PC §C], and the hands-on agents already delegate edits when they have no worktree [HSO "Quick jobs you do yourself"].
- Never read in or write to a child's worktree. Never do a review, a claims check, a panel or a second opinion itself.
- A job that grows past the budget is delegated, with what was done so far.
- `view` is free for attachments, the brief the user gives, Library material and the Project's files folder.

#### 8.3.3 Reading the borrowed sections

At every load, before it plans or dispatches anything:

1. Take the skill's base directory from the line `Base directory for this skill: …` [K1].
2. The agent file is `../../com.github.copilot/agents/hands-on-session-orchestrator.agent.md` relative to it. The builder fixes the exact relative path once U2 settles the skill's location.
3. Find the headings with the search tool (`rg` or `grep`, whichever the Project has: `^## ` lines, with line numbers), then `view` the two ranges: from `## Models and effort` to the next `## ` heading, and from `## Evidence and review` to the next `## ` heading. **(designer's call)** Reason: read-only tools with no shell, so no approval prompt (C14), and the Project has them [PC §C].
4. Apply both sections as the user's model policy and review rules for this Project, read through the adaptation table below.

**If the file or either heading is missing, fail closed (designer's call).** The coordinator dispatches no work, tells the user that the installed `wintermute` plugin is missing, broken or too old, and asks them to install or update it. Reason: the sections are the model policy and the review gates; without them the skill would silently drop the discipline it exists to add (anti-goal 4). No version check is needed: the skill and the agent file ship in the same plugin.

**Adapting agent mechanics.** The borrowed text was written for an agent that runs only child sessions. The skill carries this table, and says that where the two disagree, the table wins inside a Project:

| Borrowed text says | In a Project, read it as |
|---|---|
| Set `kickoff.model` and `kickoff.reasoning_effort` on every child session | The same, and `model` and `reasoning_effort` on every `task` call as well (8.3.4). |
| "one-off session" | A one-off job, run as 8.3.4 says: a child session when it needs a checkout, a sub-agent otherwise. |
| "created with `base_branch` set to that branch" | The same for checkout jobs. The branch must already be pushed. |
| "Send it as a follow-up to the reviewer's idle session" | A new assignment to the reviewer child (omit `assignment_id`), or `write_agent` to a background sub-agent reviewer. `write_agent` wasn't seen in a Project's tool list [PC §C]; without it, a re-check goes to a new reviewer at the same row. |
| "the vendor of the child's `kickoff.model`" | For a sub-agent, the vendor of its `model`. |
| "your own quick jobs" (Max tier) | The Project's quick jobs (8.3.2). |
| "the swarm", "the last PR", "`main`" (final panel and post-merge claims check) | This task, in this repository, and that repository's `main` (8.3.13). |
| `ask_user`, tagged (see "Talking to the user") | The tag rules in this skill (8.3.8). |
| `children`, `child_notes` | The tables in 8.3.7, same names. |
| See "Plan by stage", "Choose the delegation type", "Talking to the user" | The sections of this skill with those exact names. |

**Section names (designer's call):** the skill has sections named "Plan by stage", "Choose the delegation type" and "Talking to the user". Reason: the borrowed sections refer to those names [K5], so the references resolve without rewriting.

"Plan by stage" carries the hands-on rules for research, implementation, critical units (the six criteria and the one-line reason) and investigation, because the borrowed sections depend on "critical" [HSO "Plan by stage"].

#### 8.3.4 Delegation: owner units and one-off jobs

**Owner units** are child sessions, one per branch and PR, as today. Stack dependent units with `base_branch` once the parent has pushed its branch. Split for speed: as many independent units as the design allows, with research inputs, reviews and claims checks planned up front [HSO "Split work for speed"].

**One-off jobs (designer's call):**

- A job that needs a checkout runs as a one-off child session with `base_branch` set to the pushed branch under test. This covers reviews, claims checks, panel judges, disagreement judges, verification and repository commands.
- A job that needs no checkout runs as a `task` sub-agent, with `model` and `reasoning_effort` set from the tiers, in `mode: "background"` when it may take a re-check. This covers web research, summaries of Library files, plan critiques, second opinions on a document, and fact-checks. Use `agent_type: "wintermute:orchestrator-worker"` when it resolves (unknown U4); otherwise `general-purpose`.
- A result longer than one sentence goes to a file in the Project's files folder, by absolute path, and the report gives the path (8.3.6).

Reasons: checkout jobs keep the borrowed text's own method, give each check an isolated worktree at the commit, and follow the app's rule that checkout work goes to children [PC §C]. Jobs with no checkout start faster as sub-agents and add no Overview items, and the dashboard shows them as root sub-agents [WF §1]. Trade-off: review and check sessions appear in the Overview under Working and Done. Give them unit labels that name their job, for example `api-review`, so the session name (8.4) says what they are, and archive them when their unit ends.

**Never set `kickoff.agent` in a Project (designer's call),** even if U1 shows the app accepts it. Reason: `session-worker`'s report block conflicts with the Project contract (blocked as `needs_input`, long handoffs), and it must stay word for word the same as in the session orchestrators (C25). The worker skill replaces it.

**Kickoff fields (designer's call):** `project_id` of a Project-owned registration (from `list_repositories`, or the Project's repository setup flow when the repository isn't added yet [PC §6]); `base_branch` when stacked or under test; `kickoff.mode: "autopilot"`, or `"plan"` when the user wants to approve the approach first, never left to the default (plan) [PC §C]; `kickoff.model` and `kickoff.reasoning_effort` always; `notify_on_idle: "always"`; `coordinate_with_creator` unset. Reason: wintermute's silent-child check needs idle notifications, and the Project links its children without `coordinate_with_creator` [WF §4]. The Project's own children used `notify_on_idle: "once"` [E1:1371]; if the app rejects `"always"` for Project children (U9), use `"once"`.

Other rules carried over from the hands-on session orchestrator:

- One owner per piece of work; anything about owned work goes to its owner. Never a second session for work with an active owner, except the independent checks.
- Confirm a child started with `get_session` or its first report.
- A failed `create_session` can leave a session behind: archive it, note it, fix the cause, retry once as a new unit.
- A child paused on a plan or a question doesn't read messages: bring it to the user (8.3.8).
- Helper requests from children follow [HSO "Helper requests"]: answer from state, route to the owner, do it as a quick job, reuse an idle session with the right tier, or start a helper. A request for an independent review becomes the unit's planned review.
- Children can't start sessions (C2) and don't start sub-agents (8.4), so the coordinator plans the fan-out of any workflow that launches agents.

#### 8.3.5 Kickoff prompts and forwarding

Each kickoff prompt:

- starts with one line: "Load the `wintermute-project-worker` skill now, before anything else, and follow it for this whole session.";
- quotes the user's request verbatim, then adds only the context needed to work alone;
- gives the unit label, what the child owns and must leave alone, and keeps confirmed decisions apart from suggestions;
- for Mid-tier implementation, includes acceptance tests written from the spec;
- turns every user memory that applies into an explicit requirement;
- for a one-off job, gives the absolute path of the Project's files folder for its result file;
- says that each gate ends with a handoff (8.3.6), and that the coordinator starts the unit's review and claims check itself.

Later messages:

- New work, a revision, a rerun or a go-ahead is a new assignment: omit `assignment_id` [C6].
- An answer to a child's question, or other context about its current work, passes that work's `assignment_id`.
- When the message carries the user's words, put them in `message` and the coordinator's own instructions in `coordinator_instructions` [C7]. This replaces the agents' rule to put everything in `message` and leave `coordinator_instructions` unset.
- **Every new assignment starts the coordinator's own text with "Follow the `wintermute-project-worker` skill; load it again if its rules aren't in your context." (designer's call)** That is the start of `coordinator_instructions` when it is set, and of `message` otherwise. Reason: children have no Project memory, so this one line is how a compacted child gets its rules back.

#### 8.3.6 Reports, gates and assignments

The status line and the contract terms stay as in [DS §10]. What changes is the `purpose` each status uses, and what a handoff holds.

| Status line | `purpose` | Reaches the coordinator | Use it for |
|---|---|---|---|
| `complete` | `handoff` | Yes, as a ready result, coalesced with others (C5) | The end of each assignment |
| `progress` | `progress` | No; it stays in the child's history. The dashboard still reads it from the child's log [WF §3]. | Optional notes only |
| `needs_input` | `needs_input` | Yes, at once | A question, or a helper request |
| `blocked` | `error` | Yes, at once | A material blocker, including two failed attempts |

- `blocked → error` replaces `blocked → needs_input` from the agents' report block (decision 1; [PC §3] calls `error` a material blocker). The engine already maps `error` to `blocked` (`engine/model/contract.mjs:6-12`).
- Every report carries `assignment_id` as an argument of `send_session_message`. **It doesn't go on the status line (designer's call).** Reason: contract v1 stays unchanged, and the engine can read the argument.

**Handoffs (designer's call).** The Project's rule wins (C5). A handoff is the `swarm-status:` line plus `Summary:` with one outcome sentence, which may carry an essential link or next action:

```text
swarm-status: complete unit=api pr=github:42 commit=3f9a2c1
Summary: The endpoint is pushed and the draft PR is open for CI.
```

- The status line keeps `unit=`, `pr=` and `commit=`, because the coordinator needs the exact commit to start checks.
- A handoff has no `Evidence:` or `Blockers:` field, and no test counts or commands. The coordinator gets the branch from `get_session`, and the claims check gathers test counts and CI itself. Detail stays in the child's own thread.
- A result longer than one sentence, such as review findings or research, goes to a file in the Project's files folder, and the outcome sentence gives its absolute path as the essential link.
- `needs_input` and `error` reports keep all three fields, as [DS §10] defines them.
- Reason: decision 1 makes the Project's conventions win where they feed its UI, and the claims check verifies independently anyway.

**Clean worktree (designer's call).** A one-off job's outcome sentence also says whether its worktree is clean, for example "…; worktree clean". The coordinator confirms with `get_session` before it archives the session. Reason: archiving needs this fact, and `session-worker`'s `git status` evidence has no field in a handoff.

**Gates (designer's call).** A unit's work runs as a chain of assignments, each ending in one handoff. The borrowed rules decide what each gate needs: opening a draft PR is not a publish, so it needs only the go-ahead, not a claims check.

1. Kickoff: implement, test and push → handoff with `commit=`.
2. The go-ahead to open a draft PR, a new assignment → handoff with `pr=`. The go-ahead comes from the user, tagged `need=pr`, unless the user delegated it.
3. The regular or critical review and the claims check, including CI on the draft PR. Findings go back as new assignments; each fix ends in a handoff with the new commit. Re-checks follow the borrowed rules.
4. The go-ahead to publish, that is to take the PR out of draft, a new assignment → handoff.
5. The go-ahead to merge, a new assignment → handoff.

- The claims check runs before the publish and before the merge, as the borrowed section says.
- Opening the draft early is optional when CI doesn't need a PR. Then step 3 runs on the pushed commit, and the child opens the PR at step 4, ready for review, which is the publish.
- Reasons: the Project's model is "new work is a new assignment" (C6), observed children held several assignments [PC §7], and a gate result is a ready result, so it fits `handoff`. Children never ask for a go-ahead with `needs_input`, which keeps the immediate channel for real questions and blockers. Inference: a child's `needs_input` may also show in the Overview's "Needs input", which would wrongly suggest that the user must act.

**Status checks (designer's call).** The coordinator doesn't ask a child for a progress report, because the reply would never reach it (C5). It uses `get_session` and the child's todos instead. A child that is idle with no handoff since its last assignment gets a message with that `assignment_id`, asking for its result as a handoff or its blocker as an error. A result that is the app's notice that the session finished without a handoff (C16) is not a report: the coordinator checks the child with `get_session`. This replaces "ask it for a report with `send_session_message`" in [HSO "Lifecycle"]. Reason: a progress reply never reaches a Project, and the app's notice says nothing about the outcome.

#### 8.3.7 State and registry

All state lives in the Project's own `session.db`, through the `sql` tool. A Project has one; the "Expense reports" Project's held `todos` and other tables [WF §2].

- `todos` and `todo_deps`: the plan, as today. The engine reads the root's todos for progress [WF §2].
- `tasks` **(designer's call)**: one row per task, the set of units planned from one user request: `task` id, a short title, the user's request quoted, `created_at`, `ended_at`. Each unit's task is recorded in `child_notes`, never in `children`. Reason: the final panel, the post-merge claims check and archiving run per task and per repository (8.3.13), and the contract table is fixed.
- `children`: the contract table, exactly as [DS §10] and [HSO "The `children` table"] define it, with the same rules (labels, insert on creation, PR columns, `outcome`, never delete rows). **The skill creates it at load, even before the first child (designer's call).** Reason: an empty `children` table is a durable wintermute marker for the engine (8.6). Today's engine counts the registry as present only when it has rows, so reading an empty table as a marker is new engine work.
- `child_notes`: per unit, as today: its task, kind, model and effort with a reason, working status, last report, review verdicts with their commit, skipped reviews, escalations, and the archive.
- `unit_assignments` **(designer's call)**: `unit`, `assignment_id`, what the assignment covers, `created_at`, `ended_at`. Reason: one child holds several assignments (C6), and context messages must name the right one. It is private to the coordinator and not part of the contract.
- `own_units`: not used (8.3.2).
- `session_id` in `children` is the id `create_session` returns; the engine resolves either id [DS §10].

#### 8.3.8 Talking to the user

- **Question tags** stay as [DS §10] and [HSO "Talking to the user"] define them: every `ask_user` question starts with `[unit=<unit>]`, `[unit=<unit> need=pr]` or `[unit=* need=plan]`. The dashboard turns open tagged questions into "Needs you" items.
- **Relayed child input (designer's call).** When a child pauses on a plan or a question, the coordinator answers it from its own state when it can (`answer_session_input`, or `respond_to_session_plan_v2` with a `selected_action` that is never `autopilot_fleet`). Otherwise it uses `relay_session_input` and starts the `context` text with the tag. The relay pauses the Project until it is resolved, like `ask_user`. When it returns `outcome: "answered_here"`, the answer has already reached the child, and the coordinator doesn't send it again (C18). Reason: the app's relay shows the child's exact question to the user and keeps it in the Project's UI, and the tag keeps the dashboard's unit mapping.
- **The roster (designer's call).** The app's roster rules apply as they are (C17): a sentence ending in a colon before `create_session`; after the calls, one short paragraph without bullets or session references, a few words per session; one sentence with inline references when work goes to existing sessions. Wintermute adds only each new child's model and effort to its few words, for example "…one builds the API on Opus at medium…". Unit labels show in the session names (8.4). Reason: the user's policy names the model and effort of each delegation, and this keeps the shape the app asks for.
- **Updates** lead with what needs the user's attention, and say nothing about idle notifications or monitor runs with no news [HSO "Talking to the user"].
- Anything the user's memories say needs approval needs it here too, and kickoffs pass that rule on.

#### 8.3.9 Publishing to the Inbox

**Children publish their own deliverables once wintermute's gates make them review-ready (designer's call).** The app tells Project children to publish review-ready files, previews, PRs and issues in their own thread before they report (C8), and decision 1 keeps the Project's Inbox conventions. The worker skill defines "review-ready", which narrows the app's instruction without contradicting it:

- A PR is review-ready at the publish go-ahead (gate 4 in 8.3.6), after a clean review and claims check. The child takes it out of draft, publishes it with `publish_chat_update`, then hands off. A draft PR opened for CI is not review-ready.
- A document is review-ready when its fact-check has passed and the coordinator tells the drafter so in a new assignment.
- Any other file, preview or issue is review-ready when the coordinator says so in a new assignment.

The coordinator publishes only its own deliverables, such as a plan it wrote or the final result after the post-merge claims check. When it presents children's outputs from a batch of results, it follows the app's routing rules (C8): non-PR outputs in a separate update for each producing child, with that child's `agent_session_id`; pull requests in one update that omits `agent_session_id` and sets `source_session_id` on each PR attachment; at most six attachments per update. Publishing is not approval, and the go-ahead rules don't change (C8).

Reason: the Inbox gets checked work only (anti-goal 2), and the app's own publishing and routing stay intact (decision 1).

#### 8.3.10 PR monitoring

**The coordinator schedules each owner's PR monitor as a Project automation, in place on the owner child (designer's call):** `save_session_automation` with `session_id` set to the child, `name` "PR monitor: <unit>" (40 characters at most), `interval: "minutes"` and a prompt that tells the child to check its PR, CI and review comments and report as the worker skill says. It starts when the PR is published, and is cleared with `clear: true` and its `automation_id` when the PR merges or closes. Reason: the monitor shows in the Project's Automations tab, where the user can pause it [PC §4, §5]. If U7 shows that an in-place schedule isn't Project-owned or doesn't appear there, fall back to today's rule: the child schedules itself. Event subscriptions may replace polling later (non-goal).

#### 8.3.11 Project memory

- Standing preferences for this Project go in Project memory: for example "approve PRs on my behalf", or "use only Anthropic models". The plan, the registry, task status and schedules never do (C9).
- The opt-in line (8.2) lives there.
- User-wide Copilot memories still apply as before.

#### 8.3.12 Dashboard

**When the first child of a swarm exists, the coordinator opens the dashboard once with `open_canvas` (`canvasId: "swarm-dashboard"`, `instanceId: "swarm-dashboard"`, `input: {}`), if the tool is available. If not (U3), it tells the user once how to open it from the app's canvas menu (designer's call).** Reason: the same `instanceId` as the orchestrator agents use addresses one panel (C13), the canvas accepts an empty input (`com.github.copilot/extensions/swarm-dashboard/extension.mjs:26-32`), and there is no evidence yet that a Project's model is offered the tool [K3]. It never waits for the canvas or retries.

#### 8.3.13 Evidence, review and lifecycle

- "Evidence and review" comes from the borrowed section, unchanged, read through 8.3.3: claims checks before every merge, publish and "done"; one regular or critical review per unit from another vendor; security reviews; the final panel; the disagreement panel; documents; findings; re-checks; at most two repair cycles; second opinions.
- **The final panel runs per task and per repository (designer's call).** When one unit of a task is left unmerged in a repository, that PR gets the final panel, rebased onto that repository's `main`. The judges' vendors, and whether any unit was critical, are counted over this task's units in this repository. Units of other tasks don't wait. The post-merge claims check runs on that repository's `main`. A task's children in a repository are archived after its panel there passes, once each branch is pushed and the child has no open work, PR, automation or Agent merge. Reason: a Project is long-lived and runs many requests, so "the swarm" has no end for a panel to wait for.
- Lifecycle otherwise follows [HSO "Lifecycle"], with these changes: no status-report requests (8.3.6), monitors per 8.3.10, publishing per 8.3.9, the dashboard per 8.3.12.

### 8.4 Worker skill `wintermute-project-worker`

**How it loads.** The kickoff prompt's first line (8.3.5), and the first line of the coordinator's text in every new assignment. Plugin skills load in Project children: one loaded `brainstorming` from a plugin [C1:22]. U2 still checks that this package's skills are found. The skill doesn't set `disable-model-invocation` (8.2).

**Scope check (designer's call).** The skill runs only when the context has `<copilot_coordinated_child>`. Otherwise it stops. Reason: it describes a Project child's duties and would be wrong anywhere else.

**Carried over from `session-worker`** [SW], rewritten for Projects:

- Owner unit or one-off job, as the kickoff says.
- No sessions (the app enforces it, C2). No agent CLIs from the shell (`copilot -p`, `gh agent-task`, `claude`, `codex`), no app local API, no assigning work to Copilot, no Copilot code review requests.
- **No sub-agents (designer's call).** The app allows them (C2), so this is a soft rule. When a skill, a memory or the brief says to start one, do the step yourself; when the step needs independence or parallel work, send a helper request. Reason: the coordinator keeps the model policy and the fan-out plan in one place, and cost lands where the dashboard expects it. A builder can relax this later for routine work inside a unit.
- **No `ask_user` (designer's call).** Questions go to the coordinator as `needs_input`, followed by `task_complete` and a wait. Reason: the coordinator answers what it can, and tags what it can't, so every question reaches the user through one place.
- No opening a PR, taking it out of draft or merging it without the coordinator's go-ahead, which arrives as a new assignment (8.3.6).
- After two failed attempts at the same problem, stop and report `blocked` with the diagnosis.
- Helper requests: a `needs_input` report with the job, the inputs (repository, branch, pushed commit or absolute paths), what to send back, and whether work can go on meanwhile [SW "Helper requests"].
- One-off job limits: stay inside the brief, no commits or pushes, write files only where the brief says, and read-only when asked.
- Evidence: keep commands, test output and file lists in the session's own thread; reports state outcomes. No invented results, sources, line numbers or command output; mark anything not checked as unverified.

**Replaced by the Project child contract:**

| `session-worker` | `wintermute-project-worker` |
|---|---|
| Report to the session the kickoff names | Report to the coordinating Project, the sender in the envelope [PC §3] |
| The full report block, every report | Handoffs: the status line and a one-sentence `Summary:`. `needs_input` and `error`: all three fields (8.3.6) |
| `blocked` uses `needs_input` | `blocked` uses `error` |
| A reply to a status check is `progress` | No status checks; `progress` reaches no one but the dashboard |
| Ask for the go-ahead with `needs_input` | Hand off at the gate and wait for the next assignment |
| No `assignment_id` | Copy `assignment_id` from the kickoff or forwarded envelope into every report |
| One-off job: `git status` output under `Evidence:` | One-off job: whether the worktree is clean, in the outcome sentence |
| The child schedules its own PR monitor | The coordinator schedules it in place (8.3.10); the child runs it when woken. If the fallback applies, the child schedules itself. |
| No publishing rule | Publish your own deliverables in your own thread once review-ready as 8.3.9 defines it, then hand off; a draft PR for CI is not review-ready |

Also from the Project child contract: keep the session's todos current, because the Overview reads them [WF §3].

**Session name (designer's call).** At start, the child renames its session to begin with its unit label, for example "api: Orders endpoint", if `rename_session` is available. Reason: the user sees the Overview and the dashboard side by side, and one shared name links them.

### 8.5 Contract terms: what stays and what is replaced

| Term | In a Project |
|---|---|
| Unit labels | Kept, same rules [DS §10]. |
| `children` table | Kept, same definition, in the Project's `session.db`. |
| `swarm-status:` line | Kept on every report. |
| `Summary:`/`Evidence:`/`Blockers:` fields | Kept on `needs_input` and `error` reports. A handoff has only `Summary:`, one outcome sentence (8.3.6). |
| `[unit=… need=…]` tags | Kept on `ask_user`, and added at the start of `relay_session_input` context. |
| `purpose` mapping | Replaced: `blocked → error`. |
| Progress reports to the orchestrator | Replaced: they stay in the child's history. |
| Go-ahead requests (`needs_input`) | Replaced by gates and new assignments. |
| `kickoff.agent: "wintermute:session-worker"` | Replaced by the worker skill. |
| Everything in `message`, `coordinator_instructions` unset | Replaced: the user's words in `message`, the coordinator's in `coordinator_instructions`. |
| One-line delegation notice | Replaced by the app's roster sentence and paragraph, with each new child's model and effort. |
| Deliverables reported as paths | Replaced: each child publishes its own review-ready deliverables, and the coordinator its own (8.3.9). Long results are files, linked from the outcome sentence. |
| Final panel on the swarm's last PR | Replaced: per task and per repository (8.3.13). |
| A child's own PR monitor | Replaced: a Project automation in place on the child (with a fallback). |
| `own_units` | Not used. |
| The `tools` allowlist | Replaced by soft rules. |

### 8.6 Engine and dashboard

The engine stays read-only. It builds on the merged linking fix (C20).

**Project roots before the first child (designer's call).** A top session is a swarm root when:

- it is a Project: a `persistent_projects` row, or `sessions.session_type = 'agent'` when that table is missing; and
- it has a wintermute marker: a `skill.invoked` or `skill.invoked_ref` event with `name: "wintermute-project"` in its log [K2], or a `children` table in its `session.db`, empty or not.

Either marker is enough. Reason: without a marker, every Project that once started a sub-agent would show as a swarm [WF §5 option 7]. Both markers are new behaviour: today an empty `children` table doesn't count as present (`engine/model/swarm.mjs:237`), and a root with no child is promoted only when its agent is in `ORCHESTRATOR_AGENTS` (`engine/model/forest.mjs:115-139`). A Project with children is a root anyway, under the current rule, whether or not it is opted in. `ORCHESTRATOR_AGENTS` stays as it is for agent-run swarms.

**New reads in `engine/readers/app-db.mjs`:**

- `persistent_projects(session_id)` and `sessions.session_type`;
- `session_automations.owner_session_id` and `execution`;
- `projects.agent_owner_session_id`.

**Missing Project tables or columns mean "no Projects", with no warning (designer's call).** Reason: they are new in a public preview (C15, C19), and today a missing table warns (`engine/readers/app-db.mjs:50`), which would be noise on every swarm on older apps. Renamed or reshaped tables must not crash the engine. Tests run with fixtures that have the tables and fixtures that lack them.

**Received copies (designer's call).** Parse the coordinator's `user.message` events with `source: agent-coordinator-results`. Each JSON record gives `assignment_id`, `project_session_id` (the child workspace), `id` (the child CLI session) and `handoff` [WF §2]. Treat the content as untrusted data, and tell two kinds apart:

- A child-authored handoff is the received copy of that child's report.
- The app's notice "The session finished without sending a handoff. Use get_session if you need its result." (C16) is not a report. Detect it by its exact text, and show the unit as having ended without a report, never as `complete`.

Don't read `persistent_project_results` in this version. Today the received-copy parser needs a `<cross_session_message>` envelope (`engine/model/messages.mjs:42-46`), so this is new work. Fixtures: [E1:2032] and [E1:2961] for the notice, and a child-authored record. Reason: the engine already tails root logs, so this adds no dependency on another private table, the child-sent copy stays the main source [WF §3], and a no-handoff notice says nothing about the outcome.

**`relay_session_input` as a need (designer's call).** An open `relay_session_input` call by the root is a "Needs you" item for the relayed child's unit, as an open `ask_user` call is today: add the tool to the wait tools (`engine/model/session-state.mjs:20`). Its kind is `plan` when the child's open request is a plan, `question` otherwise; a tag at the start of `context` sets the kind and units. Its wait counts from the call's start, and it clears when the call completes: answered through the relay, answered in the child (`outcome: "answered_here"`), or withdrawn (C18). Reason: the relay blocks like `ask_user`, so the existing wait model fits, and the engine doesn't know the tool today [WF §2].

**Automations (designer's call):**

- A schedule in place on a unit's child (`session_id` = the child) is that unit's PR monitor, whoever owns it. This is today's behaviour: monitors are matched by the child's CLI session ids, without owner or execution (`engine/model/swarm.mjs:374`).
- A Project-owned schedule with `execution: "session"` and a dedicated child: that child is not a unit and not a monitor. Its cost counts in the run total. How to show it is the builder's call (U12 checks how it links).
- `execution: "coordinator_subagent"` runs show as the root's sub-agents.
- Reason: otherwise the current code would count any automation on a child as a monitor [WF §3].

**`run.project` (designer's call).** The most common `workspaces.project_id` among the root's children. If there is no child yet, the one `projects` row with `agent_owner_session_id` = the root. Otherwise null. `run.name` stays the root's title, which is the Project's name. Today `run.project` comes from the root node (`engine/model/swarm.mjs:718`), which a Project root lacks, so this rule is new. Reason: the children's own registrations are the most direct evidence, and `run.project` holds one `{id, name}` (`engine/schema.mjs:171`).

**No schema change for the root kind (designer's call).** A Project root stays `kind: 'chat'`. Reason: a new kind changes the UI contract and the schema version for no user-visible gain yet. The builder may add a Project marker to the snapshot with a schema-version bump if the UI needs it.

**Optional, for the builder:** a per-assignment timeline from `persistent_project_assignments`; dropping children listed in `coordination_revocations`; publishing attachments `kind: "pr"` in the Project's and children's logs as another PR source [WF §3].

**Dashboard UI.** No new views are required. With every child linked, cost, sub-agents and the model per child already work [WF §2, §3]. The cockpit works on the same snapshot. Run `npm run check:layout` if `ui/` changes (C21).

### 8.7 Packaging, tests and documentation

- **Files.** `skills/wintermute-project/SKILL.md` and `skills/wintermute-project-worker/SKILL.md`, plus `references/` files only if a skill grows too long. Frontmatter: `name` (equal to the folder, [K7]) and `description`; no `disable-model-invocation` (8.2).
- **Version.** Bump the minor version from 0.3.3, in `plugin.json`, `package.json` and the root marketplace entry, with `npm run release:bump -- minor` and a CHANGELOG section with release notes (C21). Reason: a new feature; during 0.x, features advance the minor (CHANGELOG preamble).
- **`plugin.json`.** No `skills` field unless U2 shows the CLI needs one. The validator keeps rejecting `agents`.
- **Validator** (`scripts/lib/validate-package.mjs`, or a new `validate-skills.mjs` called from `validate-plugin.mjs`) **(designer's call)**:
  - a `PACKAGED_SKILLS` list with both skills; each `SKILL.md` exists, its frontmatter parses, `name` equals its folder, and `description` is present;
  - no copy of either skill in `ghcp/skills/` (C22);
  - the agent file at the coordinator skill's relative path exists in the package and has `## Models and effort` and `## Evidence and review`;
  - every `see "X"` reference inside those two sections names a `##` heading in the coordinator skill, one of the two borrowed sections, or a bold label inside them (such as "Security review" [K5]).
  - Reason: decision 6 asks for a heading guard; the cross-reference check also catches an edit to the agent sections that points at a section the skill lacks.
- **Tests** (Node 18, no `t.after`/`t.before`, C24):
  - the validator rules above, each with a broken sandbox copy, as `tests/packaging.test.mjs` does;
  - engine: a Project root before its first child, with each marker (including an empty `children` table) and with none; a child-authored received copy and the app's no-handoff notice, from [E1:2032] and [E1:2961]; a relay answered through the relay, one answered in the child, and one withdrawn; an in-place automation and a dedicated-child automation; `run.project`; a `data.db` fixture without the Project tables, which must produce no warning.
- **Documentation:**
  - the plugin README: how to turn a Project on and off; how to recover after a compaction (8.2); what the skills do; and that editing "Models and effort" or "Evidence and review" in `hands-on-session-orchestrator.agent.md` also changes Projects;
  - `.github/copilot-instructions.md`: the `wintermute` entry gains the two skills and the plugin's skill folder; add a rule that renaming those two headings, or the skill's "Plan by stage", "Choose the delegation type" and "Talking to the user" headings, needs the matching change in the other file, guarded by the validator;
  - [DS §10] gains a short note on how Project children use the contract: the `purpose` mapping, one-sentence handoffs, and relayed needs.
- **Checks:** `npm test && npm run validate` from the plugin folder; `npm run check:layout` if `ui/` changes.

### 8.8 Evals

The eval kit in `evals/orchestrator/expense-claims/`, its pinned agent variants, the `eval-runner` agent and `results.csv` are untouched. Eval runs keep using the existing orchestrator agents as top-level sessions. The new skills are not part of any eval.

## 9. Left to the builder

- The exact wording of both skills, within the decisions and calls above, and their split into `references/` files if they grow long.
- The exact wording of the opt-in memory line, kept under about 200 bytes, and of the global-instruction fallback line if U5 needs it.
- The engine's code structure, function names and fixture shapes.
- Whether to add a Project marker to the snapshot schema (with a schema-version bump), how to show dedicated automation children, and how to show a unit that ended without a report.
- The optional engine reads in 8.6.
- The order of the probes in section 10, and how to undo anything a probe creates.
- The PR monitor's interval and wake prompt.
- Whether to relax the workers' no-sub-agents rule after the first real runs.

## 10. Unknowns to check

"Before" means before the part that depends on it is built.

| # | Unknown | When | How to check | If the answer is bad |
|---|---|---|---|---|
| U1 | Does `create_session` reject `kickoff.agent` for a Project's children, and does a rejected call leave a session behind? | During | One `create_session` from a scratch Project with `kickoff.agent` set; archive anything it leaves. | Nothing changes: the design never sets it (8.3.4). Record the result in the README. |
| U2 | Where must an Agent Plugins 1.0 plugin keep skills so that they load? `wintermute` ships none today. Plugin skills in general load in Projects and their children (C10). | Before | Install a local build with the skills in top-level `skills/`; check that `/wintermute-project` is listed in a Project and that the worker skill is listed in a child. | Move them to `com.github.copilot/skills/`, or add a `skills` field if the CLI needs one, and fix the relative path in 8.3.3. |
| U3 | Is a Project's model offered `open_canvas`? Its arguments are known (C13). | During | Look for it in a Project's tool list, or call it once. | The coordinator tells the user how to open the canvas (8.3.12). |
| U4 | Does `task` resolve plugin agents, such as `wintermute:orchestrator-worker`, in a Project's lineage? | During | One `task` call from a Project with that `agent_type`. | Use `general-purpose`, always with `model` and `reasoning_effort` set. |
| U5 | Does loaded skill text survive a context compaction, and does the memory line make the Project load the skill again? Known so far: memory, global instructions and the app's Project context survive (C9); skills were invoked again after compactions, cause not shown (K2). | Before | Load the skill in a Project and let a compaction happen. Check that the Project still follows the rules, loads the skill again, and reads its state and reconciles before it dispatches. | Use the fallback in 8.2: a conditional line in the user's global custom instructions, added only with the user's consent. Until then, the user invokes `/wintermute-project` again. |
| U6 | Do the scope checks hold: does a fresh Project's context contain the persistent-Project block, and a fresh child's the `<copilot_coordinated_child>` block? Both were observed in existing logs [PC §1, §3]. | Before | Read a fresh Project's and a fresh child's system prompts in their logs. | Use other markers that the app injects, or the session type from `get_session`. |
| U7 | Does `save_session_automation` with `session_id` set to a child create a Project-owned schedule that shows in the Automations tab? What are its `owner_session_id` and `execution`? | During | Create one, read `session_automations` read-only, look at the tab, clear it. | Use the fallback: the child schedules itself (8.3.10). |
| U8 | How does a withdrawn or cancelled relay look in the logs, and how does the engine tie a relay to the child's request? Blocking and the `answered_here` outcome are known (C18). | During | Read the relay calls in [E1] and their children's logs; build fixtures for each outcome. | Show the need from the child's own open request instead. |
| U9 | Is `notify_on_idle: "always"` accepted for Project children, and do idle notifications reach the Project? `"once"` was observed [E1:1371]. | During | One child created with it. | Use `"once"`, and rely on handoffs and `get_session`. |
| U10 | Why did an autopilot Project child get no shell approval [K4], and will autopilot children work for builds and tests? | Before | Check the app's permission settings for Project children; run one autopilot child that runs a shell command. | Tell the user what setting is needed; the coordinator says so in its first roster. Skill `allowed-tools` only pre-approves tools and is experimental [K7]; test it before relying on it. |
| U11 | What shows in the Overview's "Needs input" and in the Inbox: a child's `needs_input`, the Project's own pending `ask_user`, a relay, and a child's own publish followed by the coordinator's presentation of the same output? | During | Watch the Overview and the Inbox during one case of each kind. | Adjust 8.3.6, 8.3.8 and 8.3.9 so that what needs the user shows where the user looks, once. |
| U12 | How does a Project-owned schedule's dedicated child link to the Project in `data.db`? | During | Create one and read `workspaces` and `session_automations` read-only. | Adjust the automation rules in 8.6. |
| U13 | Does the skill's `description` keep the router from loading it in ordinary sessions? Description matching is not a hard boundary. | During | Ask a few swarm-like questions in an ordinary session with the plugin installed. | Tighten the description; the scope check (8.3.1) still stops it. |
