# Swarm dashboard design

Date: 15 October 2026. Status: draft for the owner's approval. The layout was approved after the second mockup round.

## How to read this

- Section 6 holds the owner's decisions, in his words where he gave them, and section 7 the layout he approved. They are fixed.
- Section 9 holds choices made on his behalf, each marked "Orchestrator's call", and section 10 the data contract that one of them defines. None is formally approved.
- Section 12 is left to the builder.
- Evidence: the facts here come from analysis of a real three-day swarm run (the reference run), of a colleague's canvas dashboard for Copilot (the reference dashboard), and of local Copilot data on the owner's Mac in October 2026 (GitHub Copilot app 1.1.29, Copilot CLI 1.0.95). Copilot's local formats are internal and may change.

## 1. Intent and why

The owner runs agentic swarms in the GitHub Copilot desktop app: an orchestrator session creates child sessions (units), usually one per branch and pull request (PR), and children start sub-agents, mostly for reviews.

His request (square brackets replace internal names): "I would like you to build a dashboard for my agentic swarm type of work. [...] take a look at my session [name]. it has been running heavily on agentic swarm to implement a feature in [project] project. This is broadly how I am planning to work [...] take a look at this repo. my colleague build this full suite of agentic workflow skills and agents. it also has a dashboard, I want something like his dashboard - [repo]. In terms of requirements, I would like to have visualisation of agentic swarm work. Each subsession/subagent. What are they doing, how much it costs, what is the progress etc..."

What he wanted to know mid-run: "I was wondering how long the session has been running, what was the latest report from it, how much is it costing me, is it stuck or not."

Why the reference dashboard appeals: "I think visualisation of the agentic swarm work is quite cool. I like to sit back and see them working and see status displayed visually instead of having to read text."

The reference run built one feature in a work repository hosted on Azure DevOps (ADO). It had 16 child sessions, 124 sub-agents, 13 PRs and 13 PR monitors, with up to 10 children open at once. The orchestrator session ran about 48 hours, or 72 with the analysis session before it. The tree cost 102,510 AI credits, about $1,025 at list price. Children lived about 21–46 hours but were busy for only 0.4–4.6 hours each; most of that time was probably spent waiting for reviews, approvals and parent merges.

The pain was visibility. About 20 of the 86 user messages asked what was ready or what came next. He found misses himself: a PR unmonitored for about 16 hours, a child that asked him a question directly, and a child hung for 21 minutes that the orchestrator said was not stuck, because it trusted the busy flag.

## 2. Goals

1. Show each swarm visually: orchestrator, children and sub-agents, with activity, run time, cost, latest report and progress.
2. Answer his four mid-run questions at a glance.
3. Tell stuck from busy reliably, and say why.
4. Show what waits on him: questions, plans and PRs.
5. Show each unit's stage, from coding through PR review to merged, and whether its PR monitor is alive.
6. Keep a history of finished runs that answers time and cost first.
7. Open in a browser or in the app's canvas panel.
8. Look calm and exact.
9. Work on any swarm, as well as the data allows, and read it exactly when its orchestrator follows the data contract in section 10 (decision 11).

## 3. Non-goals for the first version

- Acting on sessions: no stop, answer, approve, archive or monitor controls (decision 1).
- Phone or push alerts, and cloud or remote sessions (orchestrator's calls 5 and 6).
- The reference dashboard's sprint and iteration views, which read that tool's own records.
- Other ideas from the reference-run analysis that he has not asked for: a per-PR compliance checklist, a view of work the orchestrator did itself, traceability links and archive hygiene.
- Changing the orchestrator agent (`ghcp/agents/orchestrator.agent.md`). A GitHub issue will describe the required changes, with section 10 as the spec (decision 11).

## 4. Anti-goals

The dashboard fails, even if it technically works, when:

- it looks like the "standard design that LLMs create" (decision 3): heavy bold, italic, loud colour, overlap or uneven padding. The reference dashboard shows what to avoid: a dark glass look with blur and glow, saturated accents, weights of 700–800, uppercase captions and 11–12 font sizes per view;
- he has to read text to learn the state;
- a hung session looks busy or healthy. After the 21-minute hang he told the orchestrator: "this failure is on you. you should have told me ealier that you think the session is stuck";
- stuck and waiting look alike;
- its time or cost figures cannot be trusted.

## 5. Constraints

Platform:

- Every local data source is internal and undocumented, and changes between versions; for example, `session.usage_record` events appeared only with CLI 1.0.95. Parsers must accept missing keys and string-typed tool arguments.
- A canvas is a Copilot CLI extension: an ES module named `extension.mjs` that calls `joinSession({ canvases: [createCanvas({ id, displayName, description, inputSchema, open, onClose })] })` from `@github/copilot-sdk/extension`, which the host provides. `open()` returns `{ url, title }`, and the app shows that URL in a side-panel webview. The app's `create-canvas` skill and the SDK docs in the app bundle (`copilot-sdk/docs/extensions.md`, `canvas.d.ts`) describe the API, which is marked experimental.
- The runtime starts one extension process per session and talks JSON-RPC over its stdio, so the extension must never write to stdout. An extension sees only the session it joined, so swarm data must come from disk.
- The canvas page has no bridge to the host and talks only to the extension's own server. Downloads, print and new windows do not work; localStorage does. The host injects its theme as CSS variables (`--background-color-default`, `--text-color-default`, `--text-color-muted`, `--border-color-default`, `--font-sans`, `--font-mono` and others), without `!important`.
- The app's docs say canvas URLs must be loopback (the app binary also mentions http(s) and file URLs). Open canvases are saved per session and reopened on resume; the port changes on reload. The built-in browser canvas opens http, https and file URLs.
- The CLI strips sensitive environment variables such as `GITHUB_TOKEN` from extensions unless the extension requests them and the user approves.
- ADO PR state is not stored locally, and PR numbers appear only in message text.
- `~/.copilot/data.db` has a GitHub token column.
- Scale: the reference run's 18 CLI session logs total 229.1 MB, the orchestrator's alone 41.2 MB (about 17,500 lines), and the largest single log seen was 132 MB. `~/.copilot/session-store.db` is 483 MB. A full parse of the reference tree takes about 3 s. Earlier swarms reached 27 children.

Repository rules (from `.github/copilot-instructions.md`, modelled on `ghcp/plugins/pr-review-graph/`):

- `ghcp/plugins/<name>/` holds its own plugin.json, package.json, tests, scripts, LICENSE and README, and no marketplace.json.
- The root `.github/plugin/marketplace.json` lists it with a `source` path and the same version as plugin.json.
- package.json as in pr-review-graph: private, ES module, Node >=18, `npm test` (`node --test`) and `npm run validate`. The validator checks the plugin's entry in the root manifest; reuse only pr-review-graph's manifest checks, because its other checks cover agents and skills.
- Run `npm test && npm run validate` in every plugin; all of them read the root manifest.
- List the plugin under "Current contents" in `.github/copilot-instructions.md`. Users install it with `copilot plugin install <name>@ai-tools`.
- No Co-authored-by trailer or other AI attribution in commits.

## 6. The owner's decisions

1. Watch-only. When something is stuck or waiting: "At this point I will switch to the orchestrator and resolve it".
2. Location and access: "the code will live in this repo. don't care what you build it with, chose the best tool. it should be accessible in browser or in github app canvas." He also noted: "that project I gave you link to from my colleague has dashboard running in canvas".
3. Design: "the UI has to be minimalistic, with pastel colours and accurate (i.e. items don't overlap, paddings are uniformed). I hate standard design that LLMs create with lots of bold and italic and stuff."
4. The visual language he accepted in round 1 (section 8 gives the exact values from the approved round-2 mockup):
   - a light background;
   - pastel colours for eight states: busy, idle, waiting on plan, waiting on question, stuck, blocked, merged, archived, each with a fill, a darker text ink and a soft background;
   - one sans-serif font family; sizes 12, 14 and 18 px; weights 400 and 500; no italic;
   - a 4 px spacing grid and 16 px card padding;
   - high text contrast (lowest measured: 5.75:1 in round 1, 4.78:1 in round 2);
   - calm motion: pulses, ticking clocks, flowing dots;
   - stuck in soft coral with a dashed, slowly blinking ring, not saturated red.
5. Three additions to the first version: a "needs me" list (open questions and PRs waiting for his approval; plans waiting too), each unit's stage from coding through PR review to merged, and whether each PR monitor is alive.
6. History: "I want to be able to go back to the history of the runs and analyse it. Mostly for time and costs benefit." His main question for a finished run: "How long did it take this swarm to finish this task and how much did it cost".
7. The reference dashboard's six live-view parts (summary tiles, a card per agent, activity feed, plan dependency graph, per-agent timeline, status board): "all of it is useful to me".
8. Cost display: AI credits with the estimated dollar figure beside them, as the reference dashboard shows them (1 credit = $0.01 at list price). He chose this over dollars first and over premium requests.
9. Views: "B is the best as main view. C might be interesting as an aux". B, "Mission control", became the Cards tab. C, "Timeline swimlanes", became the Timeline tab: one lane per session over time, sub-agents as thin bars under their parent, and markers for reports, questions, plan approvals, PR events and monitor checks.
10. The layout in section 7, approved after the second mockup round: "Looks right, write it up".
11. Any swarm, best effort, with the orchestrator agent changed separately: "I don't want you to update the orchestrator agent in this session. But I want it to be updated. So I need you instead to create an issue in the repo that describes all the required functionality, that another session can pick up and implement later. Also dashboard should try to work on any swarm to the best of its abilities." So the dashboard works on any swarm, best effort; changing `ghcp/agents/orchestrator.agent.md` is not part of this build; a GitHub issue will track it.
12. When a run is finished: "Subsessions might not be archived but run is finished. So lets agree on when nothing happened for 2 hours". A run is finished when nothing has happened anywhere in it (orchestrator, children, sub-agents, automations) for 2 hours, whether or not anything is archived.
13. Progress bar: the share of the child's own task list (its todos) that is done, hidden when the child keeps no task list. He chose this from the options offered to him.

## 7. Layout (approved in round 2)

This is the owner's decision.

- Header: orchestrator name and project, running time, swarm cost (credits ≈ $), and counts for working, stuck, waiting, idle, done and failed. Stuck got its own count in round 2. The running time stops at the run's last activity while nothing in the run is active, and the header then says since when the run has been quiet (decision 12).
- "Needs you" strip under the header: one item per PR to approve, plan to approve or question, each showing its unit and wait time, longest first.
- Tabs: Cards (default), Timeline, Plan, Board. A Live/History switch leads to history.
- Cards: one per child session. Stuck and waiting cards come first and are tinted by status. Each card shows its state and time in that state; a running clock; cost with a cost bar; the latest report with a status badge and its age; progress (bar and %); the stage (coding → PR open → in review → merged → archived); the monitor state (no PR yet; alive, with last and next check; missing for N min, as a warning; paused); and sub-agent chips with type and runtime. A stuck card also shows its current call and how long it has run.
- Activity feed: the right rail, all units, latest first.
- Detail panel: opened by clicking a card, a board card or a plan node. At full width it replaces the feed; at narrow width it replaces the card list and offers "← Back to cards". It holds the full latest report (status, summary, evidence, blockers); current activity (current tool call, time since the last event, why it counts as stuck); sub-agents (type, model, status, runtime, credits); PR and monitor details; and recent activity.
- Plan: units as a dependency graph of stacked branches, coloured by stage, showing what can start now.
- Board: one column per stage.
- History: a list of finished runs (name, project, dates, wall-clock, busy time, total cost, units merged), then a run summary that answers time and cost first and breaks both down by unit, model and sub-agent type.
- Side panel (about 480–640 px): the counts become a 3×2 grid, "Needs you" becomes a vertical list, the feed becomes an Activity tab, cards go to one column, Plan becomes an indented list, and Board shows three stage columns per row.

How the approved mockup fills in the details (reference, not separate decisions):

- Cards sort stuck, question, plan, blocked, busy, idle, merged. Archived units leave the Cards tab, with a note naming them, and stay on the Board. The PR number sits at the card's top right. "Running" becomes "Ran" once a unit ends; while the run is quiet (decision 12) a unit's running time stops without becoming "Ran". The monitor reads "ended, PR merged" after a merge.
- The cost bar compares the unit's cost with the most expensive unit's.
- Header counts: busy is working; waiting on plan or question is waiting; merged and archived are done. The mockup showed blocked as failed; call 13 changes that.
- Report badges read complete, needs input or blocked.
- Plan and Board add a "planned" stage for units not started yet. A planned unit has a dashed outline, or a solid blue one when it can start now; otherwise it says what it waits on.
- The run summary leads with "took, start to finish" (with dates) and total cost (with counts of children and sub-agents), then agent busy time, time waiting on him, children merged and sub-agent count. Below come time by unit (a start-to-finish bar with busy time drawn over it, and units closed without merging marked), cost by unit, cost and time by model, and sub-agents by type (runs, time and cost, already included in unit costs).
- Narrow mode starts when the dashboard's inner width is under 900 px; the 3×2 counts and single-column "Needs you" start at 720 px or less.

## 8. Visual language

Values from the approved round-2 mockup. Colours are OKLCH (lightness, chroma, hue).

| Base token | Value | Use |
| --- | --- | --- |
| page | 0.975 0.004 250 | page background |
| surface | 0.993 0.002 250 | dashboard, cards, panels |
| sunk | 0.95 0.005 250 | pressed buttons, inline code |
| line | 0.905 0.008 250 | borders |
| line-2 | 0.94 0.006 250 | dividers, bar tracks |
| ink | 0.30 0.02 255 | main text |
| ink-2 | 0.48 0.018 255 | secondary text |
| ink-3 | 0.55 0.015 255 | hover borders, plan edges |
| meter | 0.80 0.03 250 | cost bars |
| focus | 0.55 0.10 245 | 2 px focus ring, 2 px offset |

| State | Fill | Text ink | Soft background |
| --- | --- | --- | --- |
| busy | 0.84 0.07 238 | 0.46 0.09 245 | 0.955 0.02 238 |
| idle | 0.87 0.012 250 | 0.48 0.015 250 | 0.96 0.004 250 |
| waiting on plan | 0.89 0.08 92 | 0.47 0.08 75 | 0.97 0.03 95 |
| waiting on question | 0.85 0.07 300 | 0.47 0.11 300 | 0.965 0.02 300 |
| stuck | 0.78 0.11 25 | 0.49 0.14 27 | 0.96 0.025 25 |
| blocked | 0.85 0.085 62 | 0.48 0.10 55 | 0.965 0.03 65 |
| merged | 0.86 0.07 160 | 0.45 0.08 160 | 0.965 0.02 160 |
| archived | 0.91 0.006 250 | 0.55 0.012 250 | 0.97 0.003 250 |

- Stages: planned uses the surface colour with a dashed ink-3 outline (solid busy ink when it can start now); coding 0.955 0.025 195; PR open 0.925 0.045 188; in review 0.895 0.06 178; merged and archived use their state fills; filled stage-track segments 0.62 0.07 185.
- Colour rules: attention cards (plan, question, stuck, blocked) take their soft background and a fill-coloured border. Badges use merged ink (complete), question ink (needs input) or blocked ink (blocked) on a 12% tint of that colour. Monitor dots: alive uses merged ink; missing and paused use blocked ink for dot and text; no PR and ended use the line colour. Progress bars use the state fill.
- Type: `system-ui, -apple-system, "Segoe UI", sans-serif` with tabular numbers. Sizes and line heights: 12/16 px (labels, chips, meta), 14/20 px (body), 18/24 px (headings, key numbers). Weights 400 and 500 only. No italic, uppercase or letter-spacing.
- Spacing and shape: a 4 px grid; gaps of 4, 8, 12, 16, 24, 32 and 48 px; 16 px padding on the dashboard, cards, rail and panels, and 12 px on smaller items (needs items, plan nodes, board cards). Radius 8 px on containers, 4 px on chips, badges and buttons, 2 px on bars. Chips are 24 px high, badges 20 px, buttons 28 px. Bars are 4 px high (12 px in history charts). Status rings are 40 px with a 4 px stroke. Borders are 1 px; hover uses ink-3; the selected card adds a 1 px inset ink outline. The rail is 320 px wide (440 px with the detail panel). Card columns are at least 296 px, "Needs you" items 240 px and board columns 160 px. The dashboard is at most 1,920 px wide.
- Motion: a busy ring spins a 28% arc every 4 s (linear); stuck rings and stuck timeline spans blink between full and 30% opacity over 2.4 s (ease-in-out); the timeline's live edge blinks over 2 s; new items fade in over 0.6 s, and changed rows flash the busy soft colour over 1.6 s (cubic-bezier(.25, 1, .5, 1)); clocks tick every second. All animation stops under `prefers-reduced-motion`.
- Round-2 checks: headless Chrome measured bounding boxes for overlap at nine widths (480, 560, 640, 800, 1024, 1280, 1440, 1600 and 1920 px), at full width and in the side-panel view: 256 checks, 0 issues, no console errors. Every view used one family, 12/14/18 px, weights 400/500 and no italic. The lowest text contrast was 4.78:1, on archived text in a board card.

## 9. Orchestrator's calls

He handed the stack to us. These are choices made on his behalf, not decisions he made. He saw calls 1–8 in a summary and raised no objection; calls 9–15 were added later, with the round-2 write-up and after the builder check. He has not formally approved any of them.

1. Orchestrator's call: one Node.js server module with no build step and no third-party runtime npm dependencies, like the reference dashboard. It reads local data strictly read-only, serves one page and pushes updates with Server-Sent Events. Two entry points share it:
   - a standalone launcher on a fixed local port, for any browser or, by URL, the app's built-in browser canvas;
   - a thin canvas extension shipped as a plugin in `ghcp/plugins/<name>/`, packaged like the reference dashboard: plugin.json declares `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` and `"extensions": {"com.github.copilot": {}}`, and the code sits in `com.github.copilot/extensions/<ext>/extension.mjs` beside `copilot-extension.json` (`{"name": "<ext>", "version": 1}`). That dashboard's changelog says declaring `$schema` is what made Copilot find its canvas. Plugin extensions load only while the plugin is enabled; after installing, run `extensions_reload` or restart the session.

   Because the runtime starts the extension in every session where the plugin is enabled, it starts no timers until a canvas is opened; the reference dashboard starts polling in every session at load. The page uses the host theme's CSS variables, with fallbacks.
2. Orchestrator's call: data sources as described in section 11. The hierarchy comes from `~/.copilot/data.db`; cost from the `assistant_usage_events` ledger in `~/.copilot/session-store.db`; activity, reports and questions from `~/.copilot/session-state/<cli-session-id>/events.jsonl`, tailed by byte offset; liveness from `sessions.is_running` plus lock-file and PID checks. Only named columns are read from data.db, because it holds a GitHub token column.
3. Orchestrator's call: stuck detection follows the rules below, calibrated on the reference run. An open `ask_user` or `exit_plan_mode` means waiting on him, which is never "stuck". Health is never inferred from the busy flag alone; in the reference run the app showed "busy" through two real hangs. All thresholds are configurable. The detail panel's "why it counts as stuck" text names the rule that fired and its numbers; the mockup's "20 minutes" text is sample copy, not a rule.

   | Rule | Condition | Result |
   | --- | --- | --- |
   | Ended | `workspaces.archived_at` is set; or no live process: stopped if the last event is `session.shutdown`, else crashed (worse if a turn was open) | archived, stopped or crashed |
   | Model call | Main turn open, and no `session.usage_record` or `assistant.message` since the last turn start, tool completion or user message for 5 min, then 10 min | warn, then stuck |
   | Tool | Open longer than its limit: bash `initial_wait` + 5 min (10 min without one); `read_bash` delay + 2 min; `read_agent` timeout + 2 min; app, file and search tools 2 min | stuck |
   | Sub-agent | Started, not completed, and no event with its `parentToolCallId` for 10 min (15 for general-purpose on Opus at max effort) | stuck |
   | Silent busy | Busy or main turn open, not waiting, and no new line in `events.jsonl` for 10 min | suspect |
   | Stalled child | Idle 30 min after a `progress` report, no `session.task_complete` since its last inbound message, no monitor due; or a `needs_input` report the orchestrator never answered | stalled, or blocked on the orchestrator |
   | Spinning | Within 30 busy minutes: 5+ failed tool calls, the same tool and arguments 3+ times, 2+ compactions, or a permission denial with `decisionSource: "unattended_fallback"` | spinning |
   | Swarm | Orchestrator idle, every open child idle or dead, no monitor due | swarm stalled |

   Calibration from the reference run: model calls had a p99 of 105–136 s depending on model (one model's maximum was 1,067 s); silent gaps inside open turns had a p99.9 of 102 s; bash calls had a p95 of 20 s; synchronous sub-agents had a p95 of about 8 min; `ask_user` waits had a median of 51 s and a maximum of 29 min. The two real hangs lasted 15 and 21 minutes.
4. Orchestrator's call: the PR stage comes from read-only, cached `az` calls for ADO PRs and `gh` calls for GitHub PRs, because ADO PR state is not stored locally. PR numbers come from the children registry when it exists (section 10), otherwise from the child's events. Without the CLI, the dashboard falls back to local inference. The dashboard runs them with the CLIs' telemetry, update checks, prompts, log files, error recommendations and extension installs turned off, and runs `az` only when the azure-devops extension is already installed. Three things remain that the CLIs do on their own on any use, not requests the dashboard makes: they refresh their own sign-in caches; `az` keeps its config folder up to date (its session and cache files and its command index); and after `az` is installed or upgraded, while its version cache is empty, `az` fetches version metadata from GitHub.
5. Orchestrator's call: no phone or push alerts in the first version.
6. Orchestrator's call: every session that has child sessions is a swarm. Live swarms come first; finished ones (decision 12) go to history. Local sessions only.
7. Orchestrator's call: history must survive log clean-up, so computed run summaries are kept in the dashboard's own folder, the only place it writes (apart from what the CLIs do in their own folders, noted in call 4).
8. Orchestrator's call: bind to 127.0.0.1, check the Host header and send no data anywhere else. The read-only `az` and `gh` queries in call 4 are the only outbound requests the dashboard makes. Apart from them, only what those CLIs do on their own, listed in call 4, reaches the network.
9. Orchestrator's call: the build ships an automated version of the round-2 overlap and token check (section 8), run on every view at the nine widths, at full width and in the side panel. It requires text contrast of at least 4.5:1.
10. Orchestrator's call: before the build starts, a cleaned copy of the approved round-2 mockup is committed beside this document as `docs/superpowers/specs/assets/2026-10-15-swarm-dashboard-mockup.html` and serves as the visual reference. Cleaning means: wrap the fragment in a minimal HTML document with a doctype and `<meta charset="utf-8">`, remove its server-relative link to the round-1 page, and replace the sample orchestrator, project, run and unit names with generic ones. A standalone check of the uncleaned file found no external resources; opened from disk with networking blocked, it rendered fully with no console errors.
11. Orchestrator's call: the orchestrator data contract in section 10. The dashboard parses those formats exactly when they are present and falls back to the heuristics in section 11 when they are not.
12. Orchestrator's call: run lifecycle. Under decision 12, a run is finished once no new line has appeared in any of its sessions' `events.jsonl` files and no new ledger row has been written for 2 hours; sub-agent events and automation runs are in those files. The 2-hour rule applies only when nothing in the run is busy: a run stays Live while any of its sessions is busy or stuck, even if no events have arrived for 2 hours. When activity resumes, the run returns to Live and its summary is recomputed. While a Live run has nothing busy, stuck or waiting, the snapshot's `run.quietSince` holds its last activity time; the run's clocks (the header's running time, the cockpit's run timer and the orchestrator's runtime on the Timeline) stop there, show the same duration the finished run will show, and the header and cockpit say since when the run has been quiet. The runtimes of units, sub-agents and tool calls that have not ended (on cards, in the detail panel and on the Timeline) stop there too, still reading "Running". Ages and times in a state keep counting. They tick again as soon as anything becomes active. The 2-hour rule and History do not change. "Took" runs from the creation of the root project session (the swarm root's `workspaces.created_at`), so it includes any analysis phase, to the run's last event, with busy time shown beside it. The run summary also shows when the first child session was created, so the analysis phase is visible. In the reference run, "took" would be about 72 hours, of which about a day came before the first child. Known effect: a run paused overnight moves to History and returns when work resumes.
13. Orchestrator's call: header counts. "Failed" means a crash (the process is gone, with no `session.shutdown` and no archive) or a session that ended unsuccessfully: registry `outcome` is `failed` (archived or not) or, without a registry, its last `session.task_complete` has `success: false`. "Blocked" counts under "waiting". The other counts follow the mockup: busy is working, merged and archived are done. The Board places a unit whose registry `outcome` is `merged`, or whose PR is known to be merged, under "Merged" even once it is archived; "Archived" holds archived units with no better-known stage.
14. Orchestrator's call: the repository is public, so every test fixture is synthetic. Real session data, logs and database extracts are never committed.
15. Orchestrator's call: stage derivation stays with the builder, guided by item 12 in section 12.

## 10. Orchestrator data contract

Orchestrator's call (call 11). This is version 1 of the contract. It fixes the formats an orchestrator can emit so that the dashboard reads its swarm exactly. Any orchestrator may follow it; the orchestrator agent in this repo will adopt it through the GitHub issue in decision 11. When contract data is present and well formed, the dashboard uses it as given. When it is missing or malformed, the dashboard falls back to the heuristics in section 11. A later breaking change gets a new status-line prefix and a new table name.

Unit labels: each child session (unit) has a label of 1–32 characters from `A–Z`, `a–z`, `0–9`, `.`, `_` and `-`. Labels are unique within the swarm, never reused, and compared without regard to case.

### Report status line and fields

The first line of every report a child sends to the orchestrator is:

```text
swarm-status: <status> unit=<unit> pr=<provider>:<id> commit=<sha>
```

- `<status>` is one of:
  - `complete`: the unit's current objective is done and the result is ready;
  - `progress`: an update; work continues and nothing is needed;
  - `needs_input`: the child needs a decision or an answer before it can continue;
  - `blocked`: the child cannot continue until something outside its control changes, such as a parent branch merging or a failing service recovering.
- `unit=` is required. `pr=` appears once the unit has a PR: `<provider>` is `ado` or `github`, and `<id>` is the Azure DevOps pull request id or the GitHub PR number. `commit=` appears when the report is about pushed code: the commit SHA in lowercase hex, 7–40 characters.
- Emit the fields in this order, separated by single spaces, with no other text and no Markdown on the line. Parsers accept any order and ignore unknown fields.
- When the transport has its own message type, keep it consistent. For the app's `send_session_message` `purpose`: `complete` → `handoff`, `progress` → `progress`, `needs_input` and `blocked` → `needs_input`.
- The dashboard reads the line from the first line of the `message` argument of the child's `send_session_message` call, or of the `content` of the matching `user.message` in the orchestrator's log, and shows `<status>` as the report badge.

After the status line, a report may carry up to three labelled fields, in this order: `Summary:` (what happened, in one or two sentences), `Evidence:` (what supports it, such as checks run, test counts, review results or file paths) and `Blockers:` (what stops progress, or `none`). Each field is one line (`Summary: <text>`) or a block: the label alone on its line, followed by lines up to the next label or the end of the report, with list items starting with `- `. Labels start a line and are written exactly as shown; parsers match them without regard to case. The detail panel shows the fields separately when they are present. Otherwise, and for any text before the first label, it shows the report body as free text.

Example:

```text
swarm-status: complete unit=api pr=github:42 commit=3f9a2c1
Summary: The endpoint and its tests are done, and a draft PR is open.
Evidence:
- 120 API tests pass
- A second-model review found no issues
Blockers: none
```

### Children registry

The orchestrator keeps one row per child in a table named `children` in its session database (the `session.db` in its session-state folder, beside the `todos` table):

```sql
CREATE TABLE IF NOT EXISTS children (
  unit        TEXT PRIMARY KEY,  -- unit label
  session_id  TEXT NOT NULL,     -- id returned when the child session was created
  title       TEXT NOT NULL,     -- short human name for the unit
  todo_id     TEXT,              -- the unit's todos.id, when the plan uses todos
  branch      TEXT,              -- the unit's branch
  base_branch TEXT,              -- branch it was created from: a parent unit's branch, or main
  pr_provider TEXT CHECK (pr_provider IN ('ado', 'github')),
  pr_repo     TEXT,              -- GitHub: owner/repo; Azure DevOps: organization/project/repository
  pr_id       INTEGER,           -- Azure DevOps pull request id or GitHub PR number
  pr_url      TEXT,              -- the PR's web URL
  outcome     TEXT CHECK (outcome IN ('merged', 'closed', 'failed')),
  created_at  TEXT NOT NULL,     -- ISO 8601, UTC
  updated_at  TEXT NOT NULL,     -- ISO 8601, UTC; set on every change
  ended_at    TEXT               -- ISO 8601, UTC; set together with outcome
);
```

- Insert the row as soon as the child exists. Set `updated_at` on every change. Never delete rows.
- `session_id` may be a project session id or a CLI session id; the dashboard resolves either through `workspace_session_aliases`.
- Fill `pr_provider`, `pr_repo`, `pr_id` and `pr_url` as soon as a PR exists, draft or published.
- Leave `outcome` empty while the unit is active. Set it, with `ended_at`, to `merged` when the PR merges, `closed` when the unit ends without merging (for example, it was dropped from the plan or its PR was abandoned), or `failed` when the unit could not be completed.
- If the orchestrator's project session has several CLI sessions, the dashboard reads `children` from each and keeps the row with the latest `updated_at` for each unit.

### Question tags

Every question the orchestrator asks the owner begins with a tag:

```text
[unit=<unit>] <question>
[unit=<unit> need=pr] <question>
```

- `unit=` is one label, several labels separated by commas, or `*` for the whole swarm.
- `need=` is optional: `pr` when he is asked to approve a PR (creating, publishing or merging it), `plan` when he is asked to approve a plan, and `question` otherwise, which is the default.
- The dashboard turns each open tagged question (an `ask_user` call with no completion yet) into a "Needs you" item for that unit and kind. Its wait time counts from the call's `tool.execution_start` timestamp.
- The owner sees the tag, so it stays short and in exactly this form.

### Opening the dashboard

An orchestrator may open the dashboard canvas with `open_canvas` once, when it creates the first child of a swarm; the canvas id is fixed when the plugin is named. This is optional. It must not wait for the canvas, and if the canvas is not installed or fails to open, it carries on. An orchestrator with a tool allowlist needs `open_canvas`, and the tool for its session database, in that list.

## 11. Data reference

Observed with app 1.1.29 and CLI 1.0.95-3.

| Source | What the dashboard needs from it |
| --- | --- |
| `~/.copilot/data.db` (app SQLite, WAL mode) | `workspaces` (project sessions: `id`, `project_id`, `name`, `branch`, `created_at`, `archived_at`, `session_id`); `workspace_parent_links` (`child_workspace_id`, `parent_workspace_id`); `workspace_session_aliases` (`session_id`, `workspace_id`); `chat_parent_links` (chat children); `sessions` (`is_running`, `was_interrupted`, `model`, `reasoning_effort`, `mode`); `projects` (`name`); `session_automations` (`session_id`, `every_minutes`, `last_run_at`, `next_run_at`, `paused_at`); `activity_items` (`activity_type` such as `agent_asking` and `agent_plan_ready`) |
| `~/.copilot/session-store.db` (CLI SQLite, WAL mode) | `assistant_usage_events`: one row per model call, written with its event (`session_id`, `agent_id`, `parent_tool_call_id`, `model`, token counts, `total_nano_aiu`, `duration_ms`, `initiator`, `created_at`). Poll with `WHERE id > :last`. |
| `~/.copilot/session-state/<cli-session-id>/` | `events.jsonl` (append-only log); `inuse.<pid>.lock` and `inuse.<pid>.hold`; `session.db` (`todos`, `todo_deps`); `workspace.yaml` (`cwd`, `branch`) |

Events are JSON lines: `{type, data, id, timestamp, parentId}`. `parentId` is the previous line's `id`, so gaps show. Main-agent events have no `data.parentToolCallId`; a sub-agent's events carry its `task` call's id there.

| Need | Events |
| --- | --- |
| Busy | `assistant.turn_start` to `assistant.turn_end` (main agent); there is no idle event |
| Tool calls | `tool.execution_start` (`toolCallId`, `toolName`, `arguments`) to `tool.execution_complete` (`success`); duration is the timestamp gap |
| Waiting on him | open `ask_user` (`question`, `choices`) or `exit_plan_mode` (`summary`) |
| Sub-agents | a `task` call (`agent_type`, `name`, `mode`, `model`), then `subagent.started` and `subagent.completed` (`durationMs`, `totalTokens`); in background mode the `task` call completes at once |
| Reports | the child's `send_session_message` call (`session_id`, `message`, `purpose`: progress, handoff, needs_input or error); `session.task_complete` (`summary`, `success`) |
| Monitors | `save_session_automation` calls; each run is a `user.message` with `source: "system"` and a `<session_automation>` body |
| Ends and errors | `session.shutdown`, `abort`, `session.error`, `session.compaction_complete`, `permission.completed` |

Derivations and traps:

- Tree: start from a workspace and follow `workspace_parent_links` recursively (the reference run had one level; allow more). A workspace can own several CLI sessions over time (the reference root had two: analysis, then orchestrator), so resolve them through `workspace_session_aliases`. Key on ids, because names change mid-run.
- Archived: use `workspaces.archived_at`. `sessions.archived_at` stays empty, `worktree_id` is cleared, and an archived session may have no `session.shutdown`.
- Process alive: the PID in `inuse.<pid>.lock` is running and holds `inuse.<pid>.hold` open. 74 of 95 lock files on disk were stale. `is_running` is a persisted busy flag, not process liveness.
- Time: start is `workspaces.created_at`; busy is the sum of main turns; waiting on him is the time inside open `ask_user` or `exit_plan_mode`; working is busy minus waiting. The app's busy time includes these waits (26 of 45 busy minutes one morning).
- Cost: credits = sum of `total_nano_aiu` / 1e9; dollars = credits × 0.01. Join a sub-agent's rows (`parent_tool_call_id`) to its `task` call for name and type; sub-agent costs are already inside session totals. Use only the ledger: per-turn checkpoints can miss compaction calls, and the app's `sessions.total_nano_aiu` lags (7% low on one live session). The $0.01 rate is GitHub's published list price and matches the per-token prices stored locally. Monthly included credits and the billing plan are not stored locally.
- Reports: `purpose` exists only on the sender's side. The orchestrator's copy is a `user.message` with a `<cross_session_message>` envelope whose `source_tool_call_id` allows the join. Reference-run reports were free text. Without the status line in section 10, map `purpose` instead: `handoff` → complete, `progress` → progress, `needs_input` → needs_input, `error` → blocked.
- Questions: an untagged question has no unit; show it against the whole swarm.
- PRs: without a registry, for ADO, the most frequent PR number in a child's reports is a usable heuristic, though children also mention other PRs. For GitHub, `workspaces.created_pr_*` holds the PR.
- Monitors: `session_automations` holds only current monitors; cleared ones vanish, so history comes from events. In the reference run, each PR's child ran its own 10-minute monitor.
- Plan: the orchestrator's `todos` and `todo_deps` held the stacking graph, but went stale: nothing was written after a context compaction, "done" meant "branch ready", and `updated_at` never changes. Todo descriptions included the child's session id. With a registry, `todo_id` links each todo to its unit.
- Progress (decision 13): `todos` rows with status `done`, divided by all rows, in the child's own `session.db`; no rows means no bar. In the reference run one child had 27 todos done and another kept none.
- Noise: the orchestrator receives an idle notification each time a child finishes a turn (380 in the reference run). These are state changes, not feed items.
- Tailing: read by byte offset, re-read when a file shrinks, and skip a partial last line.

## 12. Left to the builder

Open risks to check early:

1. SQLite from the extension's Node runtime: `node:sqlite` may be missing; the `sqlite3` CLI is a fallback.
2. The Node version that runs extensions is unknown; the system Node is v24.19.0.
3. Whether he can open the canvas from the app's "+" menu without an agent. Likely, because the app keeps a canvas catalogue with a `requiresInput` flag (so keep the input schema optional), but unverified. A mode that opens canvases without any session exists behind a flag that is off.
4. File formats are undocumented and can change; the dashboard must degrade gracefully.
5. Whether the Agent Plugins `$schema` changes how Copilot reads fields this repo's plugins already use, such as `agents` and `skills`; the app binary has a message about fields that are "no longer read". Another installed plugin uses an older form that works: `"extensions": "extensions"` in its `.claude-plugin/plugin.json`, with code in `extensions/<ext>/extension.mjs`.
6. The dark theme: the accepted look is light, but the host theme can be dark.
7. The plugin name and the port.
8. Refresh intervals (the reference dashboard polls every 3–5 s and redraws every second).
9. Test strategy, including how to automate the overlap and token check (call 9). The reference dashboard runs its extension code in a Node `vm` context with a stubbed session and synthetic events.
10. `gh` and `az` may behave differently inside the extension, because the CLI strips `GITHUB_TOKEN` and similar variables.

Open points:

11. How detector results without a colour of their own (warn, suspect, stopped, stalled, spinning, blocked on the orchestrator) map onto the eight states and the header counts. Call 13 fixes "failed" and "blocked".
12. How each stage is derived, such as "PR open" versus "in review", and where the reference run's pre-PR steps fall (tests paused for review, branch ready, preview ready, draft PR). This stays with the builder (call 15).
13. When a PR waits for his approval if no question tag says so. In the reference run he approved each PR's creation, published drafts himself and approved each merge.
14. The colour of a `progress` report badge; the mockup shows only complete, needs input and blocked.
15. When a monitor counts as missing (the N in "missing for N min").
16. Whether the canvas wrapper reuses a running standalone server or starts its own, and how the launcher starts and handles a taken port.
17. How plan nodes map to child sessions without a registry. In the reference run, todo descriptions included the child's session id; the reference dashboard's matching of ids in launch prompts was fragile.
18. Where run summaries are stored and what they contain. Session files can hold secrets; the reference run's held a notification topic that works like one.
19. How he picks among several live swarms; the approved layout shows one at a time.
