# Changelog

All notable changes to the `wintermute` plugin. Each version here matches `plugin.json`, `package.json` and the plugin's entry in the root `.github/plugin/marketplace.json`.

For every agent or dashboard change, run `npm run release:bump -- <version|patch|minor|major>` from this plugin folder and replace the new section's TODO with release notes. Each section starts with a heading `## X.Y.Z — YYYY-MM-DD`, the release's version and date, which `release:bump` writes. `npm run validate` and `release:publish` refuse a section that is empty or still has the TODO. Use stable SemVer; during 0.x, compatible fixes advance the patch, features and incompatible contracts advance the minor. Commit the version files and notes with the change.

After merging, run `npm run release:publish -- --dry-run`, then `npm run release:publish`, from clean main at origin/main. The publisher validates the package, creates and pushes the annotated `wintermute-vX.Y.Z` tag, then creates a GitHub Release from that section. It refuses existing tags and unfinished notes. The marketplace still follows main. See [Releases](README.md#releases) for prerequisites, checks and recovery after a partial publish.

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
- Document draft and fact-check rows in the model table. Every load-bearing document gets a drafter and a fact-checker from different vendors. A shallow draft or fact-check is run again one level up within its row, never at Max.
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
