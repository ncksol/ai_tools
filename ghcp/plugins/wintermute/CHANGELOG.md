# Changelog

All notable changes to the `wintermute` plugin. Each version here matches `plugin.json`, `package.json` and the plugin's entry in the root `.github/plugin/marketplace.json`.

For every agent or dashboard change, run `npm run release:bump -- <version|patch|minor|major>` from this plugin folder and replace the new section's TODO with release notes. Each section starts with a heading `## X.Y.Z — YYYY-MM-DD`, the release's version and date, which `release:bump` writes. `npm run validate` and `release:publish` refuse a section that is empty or still has the TODO. Use stable SemVer; during 0.x, compatible fixes advance the patch, features and incompatible contracts advance the minor. Commit the version files and notes with the change.

After merging, run `npm run release:publish -- --dry-run`, then `npm run release:publish`, from clean main at origin/main. The publisher validates the package, creates and pushes the annotated `wintermute-vX.Y.Z` tag, then creates a GitHub Release from that section. It refuses existing tags and unfinished notes. The marketplace still follows main. See [Releases](README.md#releases) for prerequisites, checks and recovery after a partial publish.

## 0.12.0 — 2026-11-11

### Changed

- The plugin ships one orchestrator, the one that delegates only to child sessions. `hands-on-session-orchestrator` is now `wintermute-core` (`wintermute:wintermute-core`), and its worker `session-worker` is now `wintermute-peon` (`wintermute:wintermute-peon`). Their prompts change only in these names and in dropping mentions of the removed agents. Select `wintermute:wintermute-core` for new orchestrator sessions, and update any setting, memory or script that names the old IDs.
- A running session keeps the agent it started with, but each new child session loads its agent from the installed plugin. An orchestrator session started before this update can't create children, because `wintermute:session-worker` no longer exists. Finish or archive such sessions, and start new work with `wintermute-core`.

### Removed

- The `hands-on-orchestrator` agent, which handed one-off jobs to sub-agents, and its sub-agent worker `orchestrator-worker`. Use `wintermute-core` instead.
- The swarm dashboard counts only `wintermute-core` sessions as orchestrators. Past runs of the old agents that never started a child session no longer show as swarms. Runs with child sessions still show.

## 0.11.0 — 2026-11-11

### Changed

- Both orchestrators use Gemini 4 Carbon at `medium` for harder Mid implementation and light review, and at `high` for hard find-and-fix debugging when quality matters more than cost. Carbon takes the Google judge seat at `medium` on regular final panels and `high` on critical final panels and disagreement panels. Code-centred consults can use Carbon at `high`, but long-document and security consults cannot. Argon stays for routine Mid work and closed-book fact-checks.
- Argon and Carbon count as one Google vendor for author-review separation and panel selection. Neither may run at `xhigh` or `max` or do unchecked web research; Carbon at `low` is excluded.
- Security reviews of OpenAI-written code use Opus at `xhigh`, with Argon at `high` if Opus refuses, fails or times out. All other code still goes to Astra at `xhigh`.

## 0.10.0 — 2026-11-11

### Changed

- The Board follows the Cards tab and the header. Its columns are Planned (when there are planned units), In progress, In review (active units with an open or draft PR, shown once the swarm has had a PR) and Finished (the latest 10, with Show all). Archived units wait under one closed row below the columns. Cards show the state in words, the PR or a sub-agent's type, the Needs you marker, the warning mark and the cost in dollars, all with the neutral border. The Cards tab's link to archived units opens that row.

## 0.9.4 — 2026-11-10

### Fixed

- Finished reviewers, claims checks, research and one-off jobs read as "done", not "closed" or "closed, not merged" (#112). A registry `closed` unit with no PR of its own and a complete latest report gets the new outcome `done`: "done" in Finished, even when it stopped, and "Done" in Plan. History counts it apart from closed units and doesn't mark it in peach. Other closed units read "closed, not merged" with a PR of their own and "closed" without one, in Plan too.
- A unit no longer owns a PR that its status lines name when the registry records that PR for another unit, as a reviewer's do. The dashboard doesn't take that PR as the unit's own `pr`, even when its reports mention it. The new snapshot field `reviewedPr` holds it, and when the unit has no PR of its own, its card and details say "reviews PR #…" and it no longer counts as in review. A status-line PR that no other unit records is still the unit's own.
- Run summaries record the rules they were built with. Summaries saved before 0.9.4 are rebuilt when every log of the run can be read and the run has lost no cost or child sessions since; the others are kept as they are. Until you open such a run in History, its row shows "—" for busy time and merged count; opening it rebuilds the summary. Dashboards older than 0.9.4 can't read summaries that 0.9.4 saves, so don't go back to an older version after you update.

## 0.9.3 — 2026-11-10

### Fixed

- A session whose process ended while it was idle, with no `session.shutdown` event, shows as stopped instead of crashed. Quitting the Copilot app can end idle session processes without writing that event; on 2026-11-10 one quit wrote it for none of 16 sessions, and the dashboard then showed the orchestrator and its idle children as "Crashed · Process ended unexpectedly". A session still counts as crashed when its process ended with work open: a turn, tool call, question or plan, or running sub-agent, or the app marks it as running. A resume that closes that open work keeps the crash until the session does new work.

## 0.9.2 — 2026-11-10

### Fixed

- Swarms with no active units no longer show a false stall or add a false "waiting on you" item (#108). Stall detection and Cards share the same finished-unit rules; open questions and plans still require attention.

## 0.9.1 — 2026-11-09

### Fixed

- Restarting the Copilot app no longer brings finished swarms back to Live or makes normally stopped sessions look crashed and stalled (#106). Shutdown, resume, remote connection notices (`session.info` with `infoType: remote`), remote-steerable changes, main-session settings changes, session-start/end hooks and cumulative usage checkpoints do not count as work in session snapshots or the run list. Other info types, work-related hooks and sub-agent settings still count as activity. Resumes and settings still apply their model, mode and reasoning effort; new work still moves the clock and clears the previous shutdown outcome.
- Large shutdown accounting payloads use the same event classification in the run list, including lines above 64 KiB. Repeated bookkeeping shutdowns keep the first stopped time after the last work.
- History summaries whose finish time came from bookkeeping are rebuilt when complete logs show an earlier work time without a drop in cost. Missing or unreadable logs and cost lost through deleted child workspaces keep the saved summary.

## 0.9.0 — 2026-11-09

### Added

- Session snapshots now include `busySince`: the start of the current busy period, which is the open turn or turns that followed each other within 5 s, or for a sub-agent unit the open run; null when nothing is open. Unlike `since`, it stays put when a busy session stalls, so a card keeps the report it sent earlier in the same busy period.

### Changed

- The Cards tab is redesigned (#103). Every active card has three rows and the same height, 162 px. The head has a status mark (the ring with a state icon inside), the unit's label and name, its state in words with its time, and its PR with the PR's state or a sub-agent's type. A now line, up to two lines, says what the unit is doing or said last: its own question or plan, the stuck tool call, the todo in progress, the sync sub-agent it waits for, the tool call's description, or its latest report and its age. The footer has a Needs you marker when an item names the unit, running and stuck sub-agent chips, todos done, the model and reasoning effort, and the cost in dollars. When the footer runs out of space its left side folds; the marker, the model and the cost never hide. Running time, the cost bar, the Progress, Stage, Monitor, Type and Mode rows, the report badge and the tool chip move to the details view only.
- Stuck states name their cause on cards and in the header: "Stuck · tool call" and "Stuck · silent". A sub-agent's own card says "silent". The details view and the cockpit keep their words.
- Finished units leave the grid for a Finished section below it, closed by default. A unit is finished when it stopped, merged, completed, failed, crashed, was cancelled or closed without merging, or when it is idle with a complete latest report and no PR still open. A unit with an open question or plan of its own stays on the grid. Orchestrator sub-agents move there as soon as they end, instead of staying on the grid for 10 minutes. The section shows mini cards, latest first, that say "closed" for a unit that never had a PR and "closed, not merged" for one that had.
- The orchestrator header is the orchestrator's card: a status mark, the run name, its state in words, and a now line that says what it is doing, its question or plan, a stall, or what it waits for. The swarm cost shows in dollars. The count tiles follow the grid: working, stuck, waiting on you, blocked, idle and finished.
- The Needs you band is gone from the regular view. Its items show on the cards and in the header, and the Timeline, Plan, Board and Activity tabs show one line with how much waits on you and the oldest wait, which opens the Cards tab. The cockpit's Needs panel is unchanged.
- Every card on the Cards tab has the neutral border. The Board keeps its kind borders.
- A card whose data could not all be read shows a warning mark; its tooltip says what failed.
- While the page is disconnected, the cards and the Finished section dim, the marks stop moving and the clocks stop. The status says since when the data is shown.

### Upgrading

- A shared dashboard server that is already running keeps its version. Reload extensions in every session or restart the app to get this one.

## 0.8.0 — 2026-11-09

### Added

- Session snapshots now include `todo`, `toolDesc` and `dataWarning` for the Cards tab and orchestrator header redesign. The current todo uses the latest known update time, then the smallest id to break ties. Tool descriptions follow the displayed tool call without replacing its command-first summary. Data warnings identify missing or unreadable logs and incomplete usage, stay within the affected sessions and sub-agent source logs, and clear once the data can be read in full. Log warnings keep the first failure time in local 24-hour format until recovery. Sub-agent usage warnings say the cost may be incomplete because a bad line cannot always be attributed to one sub-agent.

## 0.7.1 — 2026-11-09

### Changed

- A re-check stays small. In `hands-on-orchestrator` and `hands-on-session-orchestrator`, a re-check brief now tells the reviewer to run code only to settle a possible finding, with the smallest check that settles it. The reviewer doesn't repeat the owner's test runs, full test suites or mutation checks, even when a project's test rules ask authors for them. The owner's evidence and CI cover those, and so does the claims check when one runs. Before this, a reviewer could rerun mutation checks and full suites for a 14-line follow-up.

### Upgrading

- Running sessions keep the prompts they started with.

## 0.7.0 — 2026-11-06

### Changed

- Follow-up work is sized on its own. `hands-on-orchestrator` and `hands-on-session-orchestrator` have a new "Follow-up jobs" rule in "Evidence and review". Every fix, reviewer re-check, panel re-check, claims check and rebase is sized from the diff at the pushed commit and the owner's test and CI evidence, with the same inputs as planning. It no longer inherits the unit's tier, review rows, reviewer count or critical status. An owner still does the fixes and rebases on its own work at its own model; sizing sets their review and checks. A mechanical change that tests and CI fully cover needs no reviewer re-check. A small change with real logic gets at most one reviewer. A significant change gets the unit's original reviewers, and a change that meets a critical-unit trigger gets a critical review, even in a regular unit. Lower scrutiny needs evidence the orchestrator states; if unsure, it chooses the higher level, and it records one line for each follow-up.
- A mechanical follow-up may skip its separate claims check when an earlier claims check passed for the unit, the whole change since that check is mechanical, touches no build, CI or test configuration and removes or skips no tests, and CI's test job ran and passed at the exact new head. The orchestrator reads that CI result itself and records it. A unit's first claims check and the claims check on `main` after the last merge always run.
- A new Light review row (Sol at `high`, Sonnet at `xhigh` or Argon at `high`, never from the author's vendor) is only for small follow-ups with real logic and no critical-unit trigger, never for a unit's first review.
- A claims check may go to the unit's own idle claims checker from an earlier check, which the orchestrator now keeps until the unit merges. A claims check still never goes to a reviewer, a judge or any other agent.
- "Re-checks", "Critical units", the fix PR for a panel finding and "Models and effort" point to the new rule. After the final panel, the judges re-check a change only when it can affect how units work together or the spec as a whole.

### Upgrading

- Running sessions keep the prompts they started with.

## 0.6.0 — 2026-11-02

### Changed

- Claims checks have their own route. `hands-on-orchestrator` and `hands-on-session-orchestrator` decide whether a job is a review or a claims check before they choose who does it, and split a request that asks for both. Every claims check, including a request to refresh earlier claims and the check of the orchestrator's own unit, goes to a new claims checker at the Claims check row (Sol at `medium`, or Opus at `low` if Sol isn't listed): a `wintermute:orchestrator-worker` sub-agent or a `wintermute:session-worker` one-off session. An idle reviewer's context is no longer a reason to send it a claims job, and the claims check row is no longer called a review row. The claims brief gives the exact pushed head commit and the base branch. Reviewers may still run tests to establish a finding.
- When a worker is asked to do a claims job as part of a review, it does the review, leaves the claims job undone and reports it for a separate claims checker.
- Required reviews, panels, security reviews and claims checks, and when they run, are unchanged.

### Upgrading

- Running sessions keep the prompts they started with.

## 0.5.0 — 2026-11-02

### Changed

- The agents no longer watch PRs. `hands-on-orchestrator` and `hands-on-session-orchestrator` no longer tell a child to start a PR monitor when it publishes a PR, or to stop one when it merges, and they forbid any replacement: no session automation, event subscription, polling loop, background script, heartbeat or extra agent to watch a PR. `session-worker` has the same rule and sends `complete` once its PR is open and its assigned gates are done. A reply to a later status check while a unit only waits for reviews is also `complete`, in all three agents' report rules, so the dashboard keeps counting the unit as waiting on review. One-shot PR checks for assigned work are unchanged. When a required gate needs CI that is still running, the owner may wait for it once, with one blocking command limited to about 30 minutes, then report the result or that CI is still pending. Nothing reacts to new reviewer activity on its own any more; review comments go to the PR's owner as owned work when the orchestrator learns of them.
- The swarm dashboard shows "no monitor" for an open PR with no schedule, instead of a missing-monitor warning, and no longer says a monitor starts when the PR opens. A configured schedule that is overdue still shows as missing. Live PR lookups and past monitor checks are unchanged.
- A unit that has done its part counts as waiting on review: its latest report is `complete`, its PR is open (draft or ready), and the orchestrator hasn't replied since. It no longer makes the swarm count as stalled. A swarm is stalled only when the orchestrator and every other open unit are idle. The stalled reason no longer mentions a monitor. As before, a run with no activity for 2 hours moves to History.

### Upgrading

- Running sessions keep the prompts they started with, and PR-monitor schedules they already created keep running. Stop those in the app, or archive their session, if you no longer want them.

## 0.4.0 — 2026-11-02

### Removed

- The `orchestrator` and `session-orchestrator` agents. Use `hands-on-orchestrator` or `hands-on-session-orchestrator` instead. Switch any session or setting that selects a removed agent to one of these.
- The swarm dashboard no longer counts a session as an orchestrator because its agent is one of the removed ones, so their past runs without child sessions no longer show as swarms.
- `npm run validate` now reports any agent file in `com.github.copilot/agents/` that the plugin doesn't package.

### Changed

- `orchestrator-worker` no longer says the orchestrator that starts it has no shell, file, search or web tools. Its only caller, `hands-on-orchestrator`, has them but does only quick jobs itself.

## 0.3.4 — 2026-10-29

### Changed

- `hands-on-orchestrator` now has the same instructions as `hands-on-session-orchestrator`, apart from delegating one-off jobs to sub-agents instead of one-off sessions. Before, only the session variants had "Split work for speed", which tells them the user measures wall-clock time and how to plan for it, so evals that compared the two hands-on variants also compared different planning instructions. `hands-on-orchestrator` gains that section, adapted to sub-agents, and four rules from `hands-on-session-orchestrator`:
  - confirm that a child started before you count on it;
  - give each sub-agent one job;
  - a sub-agent gets the tier or review row of its job;
  - tell each owner that you start its review and claims check.
- `orchestrator` is unchanged, so it still lacks these rules.

## 0.3.3 — 2026-10-29

### Fixed

- The dashboard now shows every session that a chat or a Copilot app Project created. Before, it showed only the first one. A chat orchestrator's swarm, or a Project, that started several sessions showed one unit, and the cost of the other sessions was missing. Sessions created by another project session still need a parent link, and detached sessions, which the app records without a creator, stay top-level sessions.

## 0.3.2 — 2026-10-29

### Fixed

- Cost warnings about missing or unreadable session logs and invalid usage lines now appear only on the swarm that contains the session, including child sessions and older aliases. Unrelated swarms no longer show those data warnings. Engine-wide diagnostics still appear on every swarm, and aggregate engine diagnostics still include all session warnings.

## 0.3.1 — 2026-10-27

Fixes child sessions that failed to start because their base branch wasn't pushed yet ([#70](https://github.com/ncksol/ai_tools/issues/70)), in `orchestrator`, `session-orchestrator`, `hands-on-orchestrator` and `hands-on-session-orchestrator`.

### Fixed

- "Choose the delegation type" says a child's `base_branch` must already be pushed to origin. For another unit's branch, the orchestrator waits until that unit reports a pushed commit. This covers review and check sessions too.
- When `create_session` reports that workspace setup failed, the orchestrator archives the broken session, notes it in `child_notes`, fixes the cause and tries once more as a new unit. It never retries several at once.
- The `hands-on-` orchestrators push their own branch before they hand their own unit to a child.
- The session variants still stack dependent units early, but only once the parent has pushed its branch.

## 0.3.0 — 2026-10-27

New model routing in `orchestrator`, `session-orchestrator`, `hands-on-orchestrator` and `hands-on-session-orchestrator`, based on a study of which models and effort levels suit which jobs.

### Changed

- Every row names only levels that Copilot offers: Argon runs at `high`, not `xhigh`, in the Mid tier and on both panels.
- Low tier: Sol at `medium`, or at `low` for a single command or lookup; Sonnet at `medium` only for read-only jobs. If Sol isn't available, Opus at `low` takes the jobs that aren't read-only. The claims check runs on Sol at `medium`, or Opus at `low`.
- Mid tier: Opus at `medium` or `high`, Sol at `high` or `xhigh`, Sonnet at `xhigh`, or Argon at `medium` or `high`. The defaults are Opus at `medium` and Sol at `high`. Astra no longer runs at Mid.
- High tier adds Sol at `max` for long autonomous coding or terminal work and for find-and-fix debugging. A unit marked critical now runs at High by default.
- Max tier: Opus at `max` for orchestration, and Opus or Astra at `max` for consults. Execution may now run at Max in two roles, Astra for incident RCA and Opus for the hardest implementation, but only when success matters more than cost and the user approves. Automatic tier-ups still stop at High.
- Critical reviews and the critical final panel run Opus at `xhigh` instead of `max`. The disagreement panel keeps Opus at `max`.
- If a model family isn't available, the fallback family runs at the level its row gives it.

### Added

- Routing for security, authentication and secrets reviews: Argon at `high` for code written by OpenAI models, with Opus at `xhigh` if Argon fails, and Astra at `xhigh` for all other code, including code with no model author. `orchestrator` and `hands-on-orchestrator` pass this route to their children for the reviews the children start themselves.
- Routing for investigation and debugging. Opus is never the only investigator of an incident: when an Opus owner investigates an incident in its own work, the orchestrator adds an independent investigator on Astra at `xhigh`, and the owner still owns the fix.
- Document draft and fact-check rows in the model table. Every load-bearing document gets a drafter and a fact-checker from different vendors. A shallow draft or fact-check is run again at the next level its row lists for that model, never at Max; at the top of its row it is treated as unverified instead.
- A list of model and level combinations never to use. Reviewers and fact-checkers never come from the author's vendor; panel judges keep their own vendor rules.
- Kickoff prompts for units that implement code at the Mid tier include acceptance tests written from the spec, which the unit implements and makes pass.
- Every code-review brief asks the reviewer to report every finding, including the briefs that children write.
- The README says the orchestrators are meant to run on Opus 5.5 at `max`.

## 0.2.2 — 2026-10-25

### Fixed

- Costs were 0 for every session started since the Copilot app moved its sessions to the native runtime (app 1.1.31), which no longer writes `~/.copilot/session-store.db` ([#71](https://github.com/ncksol/ai_tools/issues/71)). The dashboard now reads cost from each session's `events.jsonl`: one `session.usage_record` per model call (`copilotUsage.totalNanoAiu`, model, duration and time), plus the compaction calls in `session.compaction_complete` (`compactionTokensUsed`), which have no usage record. A session's total now equals its last `session.usage_checkpoint` where that checkpoint is correct.
- Resumed sessions were over-counted: the session store wrote a session's usage rows again on resume. Each model call is now counted once, by its `accounting.sourceSessionId` and `usageId`. Run summaries now record their cost source (`costSource: "events"`). A History summary written from the session store is rebuilt from the logs once every log of its run reads in full, even when the corrected cost is lower; while a log is missing it is kept as it is.
- A sub-agent's cost is attributed to its `task` call from the record's `parentToolCallId`, or from its envelope `agentId` through `subagent.started` (which is how a compaction inside a sub-agent is attributed). A nested sub-agent's cost goes to its own `task` call and rolls up to the sub-agents above it, as before.

- A run's summary is never stored from an incomplete cost read: a session log that is missing, or a usage line that can't be read. Each shows a warning on every refresh, and the last good summary stays.

### Removed

- The session-store reader, its path and its "session store was not found" warning. Sessions from CLI versions before 1.0.93 (and other runs without `session.usage_record` events) show only the cost of their compactions.

## 0.2.1 — 2026-10-23

### Changed

- Updated `orchestrator`, `session-orchestrator`, `hands-on-orchestrator` and `hands-on-session-orchestrator` to use the Copilot app's renamed `list_repositories` tool in their `tools` allowlists and child-session delegation instructions.
- Updated `QUICK_TOOLS` (`engine/model/status.mjs`) to cover `list_repositories`, `add_repository` and `await_repository_creation` under the two-minute quick-tool limit.

## 0.2.0 — 2026-10-22

The `swarm-dashboard` plugin is now `wintermute`: one plugin that ships the orchestrator agents and the swarm dashboard, released and updated together.

### Added

- Six agents, in `com.github.copilot/agents/`: `orchestrator`, `session-orchestrator`, `hands-on-orchestrator`, `hands-on-session-orchestrator`, `orchestrator-worker` and `session-worker`. Before, they were loose files in `ghcp/agents/` that you symlinked or copied into `~/.copilot/agents/`.
- When a canvas opened by a newer installed plugin is served by an older running dashboard server, both the regular view and the cockpit show an out-of-date notice naming the running and installed versions and how to update the dashboard; the cockpit also reloads once when the UI fingerprint changes after reconnect, matching the regular view. The notice appears from 0.2.0 on; an older running dashboard from before 0.2.0 is replaced by the migration's app restart or extension reload in every open session (steps 4 and 5).
- This changelog.
- Dependency-free release commands to bump the three versions together and publish a guarded `wintermute-vX.Y.Z` tag and GitHub Release, with authentication and origin-repository preflight checks, a read-only dry run and offline tests.
- `npm run validate` also checks the six agents (each exists, its frontmatter follows a strict flat YAML subset and its decoded `name` matches the file name, and it starts the workers by their `wintermute:` IDs), that `plugin.json` has no `agents` field, that no copy of them stays in `ghcp/agents/`, and that this file has an entry for the current version.

### Changed

- Plugin agents run under the ID `wintermute:<agent>`. The orchestrators now start their workers as `wintermute:orchestrator-worker` (`task` `agent_type`) and `wintermute:session-worker` (`create_session` `kickoff.agent`). To pick an orchestrator, choose it in the agent picker, or pass `wintermute:orchestrator` (or another `wintermute:` ID) where a tool or CLI flag takes an agent ID.
- The dashboard treats a top session as an orchestrator when its agent is `wintermute:orchestrator`, `wintermute:session-orchestrator`, `wintermute:hands-on-orchestrator` or `wintermute:hands-on-session-orchestrator`, and still when it is the bare name, so runs from before this release stay in History.

### Unchanged

- The canvas is still `swarm-dashboard`. The shared server still uses port 7927 and reports `"app": "swarm-dashboard"`, and run history stays in `~/.copilot/swarm-dashboard/`.

### Migration from `swarm-dashboard` and symlinked agents

Do these steps in order:

1. Remove the six agent symlinks or copies from `~/.copilot/agents/`. The plugin's agents answer only to their `wintermute:` IDs. Old copies there stay separate agents under the bare names, with the same names in the agent picker, and run the old prompts, which start bare-named workers. Once your clone pulls this release, the symlinks also point at files that no longer exist. A bare name never resolves to a plugin agent, so the orchestrators start their workers by `wintermute:` IDs. To remove the old agents:

   ```bash
   for agent in orchestrator session-orchestrator hands-on-orchestrator hands-on-session-orchestrator orchestrator-worker session-worker; do
     rm -f ~/.copilot/agents/"$agent".agent.md
   done
   ```

2. Uninstall the old plugin. Two installed plugins that both register the `swarm-dashboard` canvas would clash:

   ```bash
   copilot plugin uninstall swarm-dashboard@ai-tools
   ```

3. Install the new one:

   ```bash
   copilot plugin install wintermute@ai-tools
   ```

4. Restart the Copilot app, or reload extensions in every open session. Any session that still runs the old extension can keep hosting the 0.1.x dashboard server on port 7927, and versions before 0.2.0 show no out-of-date notice. A session keeps the agents it started with until the app restarts, so if you only reload extensions, start a new session for orchestrator work.

5. Check that the port serves the new dashboard. With a dashboard canvas open:

   ```bash
   curl -s http://127.0.0.1:7927/api/health
   ```

   The answer must include `"version":"0.2.0"`. If it shows an older version, a session still hosts the old server: restart the app.
