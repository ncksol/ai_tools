# Wintermute package design

Date: 2026-10-22. Status: approved by the user, implemented in plugin version 0.2.0.

## Goal

The user asked to "wrap the dashboard and the orchestrator agents into one package that will be released and update in one go". Before this change, the swarm dashboard was the `swarm-dashboard` plugin and the six orchestrator agents were loose files in `ghcp/agents/` that the user symlinked into `~/.copilot/agents/`. The dashboard updated through `copilot plugin update`; the agents updated through `git pull`. The two could drift apart, although the dashboard reads the data contract the agents write.

## Decisions

1. **One plugin.** Copilot has no plugin dependencies or bundles: the Agent Plugins 1.0 manifest is closed, and a marketplace entry has no bundle field. One plugin is the only way to get one version and one update. The app documentation allows custom agents and canvas extensions in the same plugin.
2. **Name `wintermute`.** The user asked for a name that is "scifi related, but not too popular. From books not movies", and chose `wintermute`, the AI in William Gibson's *Neuromancer*. The plugin is `wintermute@ai-tools` in `ghcp/plugins/wintermute/`; releases are tagged `wintermute-vX.Y.Z`.
3. **Agents in `com.github.copilot/agents/`.** `swarm-dashboard` was already an Agent Plugins 1.0 plugin (`plugin.json` with `$schema`). Such plugins read agents only from `com.github.copilot/agents/`; a top-level `agents/` folder or `agents` manifest field is ignored (CLI changelog 1.0.80-0). The six agents moved there with their file names: `orchestrator`, `session-orchestrator`, `hands-on-orchestrator`, `hands-on-session-orchestrator`, `orchestrator-worker` and `session-worker`. `eval-runner`, `andrej` and `azure-arch-diagram` stay in `ghcp/agents/`.
4. **Prefixed agent IDs everywhere.** Copilot names a plugin agent `<plugin>:<file-stem>`. `~/.copilot/data.db` `sessions.agent` records such IDs (for example `adr-authoring:adr-writer`), and `task` `agent_type` and `create_session` `kickoff.agent` accept them. Whether a bare name resolves to a plugin agent is unknown, so every reference that starts or matches one of these agents uses the prefixed ID: `agent_type: "wintermute:orchestrator-worker"` and `kickoff.agent: "wintermute:session-worker"`. The display name in the agent picker stays plain. The runtime prefix meets the repository rule that agent names inside a plugin are namespaced, so the files keep their plain names.
5. **The dashboard matches both forms.** `ORCHESTRATOR_AGENTS` in `engine/model/forest.mjs` lists the four orchestrators by bare name and by `wintermute:` ID. A childless top session becomes a swarm root only when its agent is on that list, so keeping the bare names keeps past runs in History.
6. **One version, one changelog.** Version 0.2.0 in `plugin.json`, `package.json` and the root marketplace entry. Any change to an agent or the dashboard bumps all three and adds a `CHANGELOG.md` entry. The marketplace keeps a relative `source` that tracks `main`.
7. **The validator checks the package.** `npm run validate` checks that the six agents exist with parseable frontmatter whose `name` matches the file name, that they start their workers by `wintermute:` IDs, that no copy stays in `ghcp/agents/`, that `plugin.json` has no `agents` field, that the three versions are equal, and that `CHANGELOG.md` has an entry for the current version.
8. **Dashboard identity unchanged.** The canvas id stays `swarm-dashboard` (its provider ID becomes `plugin:wintermute:swarm-dashboard`), the shared server keeps port 7927 and its health identity `"app": "swarm-dashboard"`, and history stays in `~/.copilot/swarm-dashboard/`. A new canvas still recognises an old server, and history survives. The dashboard's internal file and folder names stay as they are.

## Related work, in separate units

- The eval kit in `evals/orchestrator/expense-claims/` moves to the prefixed IDs and the installed plugin path; its pinned A/B/C snapshots stay user-level aliases.
- The dashboard shows an "out of date, reload" notice when the server is older than the installed plugin, and the cockpit reloads on a changed UI fingerprint like the regular view.
- Release tooling creates the `wintermute-vX.Y.Z` tag and GitHub Release.

## Migration

After merge, with the user's go-ahead, in this order (also in `CHANGELOG.md` 0.2.0):

1. Remove the six agent symlinks from `~/.copilot/agents/`. User agents load before plugin agents and would shadow them.
2. Uninstall `swarm-dashboard@ai-tools`. Two installed plugins that both register the `swarm-dashboard` canvas would clash.
3. Install `wintermute@ai-tools`.
4. Restart the app, or reload extensions in every session.
5. Check that a new `session-orchestrator` session starts `wintermute:session-worker` children and that the dashboard shows them.

## Trade-off

Agent edits reach the user through a plugin update after merge, not through `git pull`.

## Alternatives not taken

- Keep the name `swarm-dashboard`: no reinstall, but agent IDs such as `swarm-dashboard:orchestrator`.
- Pin the marketplace entry to a release tag or SHA: `main` could hold unreleased work, but it needs a validator change and a two-step release, and the app's handling of GitHub-sourced subdirectory entries is unverified.
- An automatic server takeover in place of the notice: a real live update, but it needs a cooperative port handover and race control.
