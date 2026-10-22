# Changelog

All notable changes to the `wintermute` plugin. Each version here matches `plugin.json`, `package.json` and the plugin's entry in the root `.github/plugin/marketplace.json`.

For every agent or dashboard change, run `npm run release:bump -- <version|patch|minor|major>` from this plugin folder and replace the new section's TODO with release notes. Use stable SemVer; during 0.x, compatible fixes advance the patch, features and incompatible contracts advance the minor. Commit the version files and notes with the change.

After merging, run `npm run release:publish -- --dry-run`, then `npm run release:publish`, from clean main at origin/main. The publisher validates the package, creates and pushes the annotated `wintermute-vX.Y.Z` tag, then creates a GitHub Release from that section. It refuses existing tags and unfinished notes. The marketplace still follows main. See [Releases](README.md#releases) for prerequisites, checks and recovery after a partial publish.

## 0.2.0 — 2026-10-22

The `swarm-dashboard` plugin is now `wintermute`: one plugin that ships the orchestrator agents and the swarm dashboard, released and updated together.

### Added

- Six agents, in `com.github.copilot/agents/`: `orchestrator`, `session-orchestrator`, `hands-on-orchestrator`, `hands-on-session-orchestrator`, `orchestrator-worker` and `session-worker`. Before, they were loose files in `ghcp/agents/` that you symlinked or copied into `~/.copilot/agents/`.
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

4. Restart the Copilot app, or start new sessions, so that sessions use the plugin's agents; a running session keeps the agents it started with. Reloading extensions in a session, or restarting the app, refreshes the dashboard canvas. A dashboard server that already runs on port 7927 keeps serving the old version until no session hosts it any more.
