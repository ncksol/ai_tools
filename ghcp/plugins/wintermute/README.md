# Wintermute

Wintermute is one Copilot plugin with two parts that are released and updated together:

- the orchestrator agents for the GitHub Copilot app, which plan work and hand it to child sessions and sub-agents;
- the swarm dashboard, which shows what those sessions and sub-agents are doing.

Each release is listed in the [CHANGELOG](CHANGELOG.md).

## Install

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install wintermute@ai-tools
```

Then start new sessions, or restart the Copilot app, to get the agents; a session that was already running keeps the agents it started with. Reloading extensions in a session, or restarting the app, loads the dashboard canvas. The plugin has no npm dependencies, and the canvas runs on the Node.js that ships with Copilot. The browser launcher and the commands below need Node.js 18 or later.

## Update

```bash
copilot plugin update wintermute@ai-tools
```

Then start new sessions, or restart the app, to get the updated agents: a running session keeps the agents it started with. Reloading extensions in a session, or restarting the app, refreshes the dashboard canvas. A dashboard server that already runs on the port keeps serving the old version until no session hosts it any more (see [Troubleshooting](#troubleshooting)). Agent changes in this repository reach you only through a plugin update, not through `git pull`.

## Moving from swarm-dashboard

Before 0.2.0 the dashboard was the `swarm-dashboard` plugin and the agents were loose files that you linked or copied into `~/.copilot/agents/`. To move to `wintermute`:

1. Remove the six agents from `~/.copilot/agents/`. The plugin's agents answer only to their `wintermute:` IDs. Old copies there stay separate agents under the bare names, with the same names in the agent picker, and run the old prompts, which start bare-named workers. Once your clone pulls this release, the symlinks also point at files that no longer exist.
2. Run `copilot plugin uninstall swarm-dashboard@ai-tools`. Two installed plugins that both register the `swarm-dashboard` canvas would clash.
3. Run `copilot plugin install wintermute@ai-tools`.
4. Restart the app, or start new sessions, so that sessions use this plugin's agents. Reloading extensions refreshes the dashboard canvas in a running session, but not its agents.

The [CHANGELOG](CHANGELOG.md) entry for 0.2.0 has the commands. The canvas id (`swarm-dashboard`), the port and the run history in `~/.copilot/swarm-dashboard/` stay the same, so past runs stay in History, including runs of the agents under their old plain names.

## The agents

The agents are in `com.github.copilot/agents/`. Copilot names a plugin agent `<plugin>:<file name>`, so their IDs are `wintermute:<name>`. The agent picker and the composer's **+** menu show the plain name.

| Agent | ID | What it does |
| --- | --- | --- |
| `orchestrator` | `wintermute:orchestrator` | Plans, delegates and tracks multi-PR work, with no shell, file-editing, search, web or MCP tools. Hands owned work to child sessions and one-off jobs to `orchestrator-worker` sub-agents. |
| `session-orchestrator` | `wintermute:session-orchestrator` | Like `orchestrator`, but delegates only to child sessions, which run as `session-worker`. |
| `hands-on-orchestrator` | `wintermute:hands-on-orchestrator` | Like `orchestrator`, but may do a quick job itself, and commits small edits on its own session branch. |
| `hands-on-session-orchestrator` | `wintermute:hands-on-session-orchestrator` | The same change made to `session-orchestrator`. |
| `orchestrator-worker` | `wintermute:orchestrator-worker` | Does one-off jobs for `orchestrator` and `hands-on-orchestrator`, which start it through `task`. Hidden from the picker. |
| `session-worker` | `wintermute:session-worker` | The agent every child session of `session-orchestrator` and `hands-on-session-orchestrator` runs as. Hidden from the picker. |

Run an orchestrator as the session's agent in the GitHub Copilot app: pick it before your first message, from the composer's **+** menu or with `/agent`. Where a tool or CLI flag takes an agent ID, use the `wintermute:` ID. A bare name never resolves to a plugin agent, so the orchestrators start their workers by these IDs, and the workers must come from this plugin too.

## The swarm dashboard

A watch-only dashboard for agentic swarms in the GitHub Copilot app. A swarm is a session that has started child sessions, such as an orchestrator that hands each unit of work to its own session. Before its first child session, an `orchestrator`, `session-orchestrator`, `hands-on-orchestrator` or `hands-on-session-orchestrator` session is a swarm once it has started a `task` sub-agent, or while it waits on a tagged question, such as its plan question, so that the question shows under "Needs you". Sub-agents alone don't make other sessions swarms. The dashboard shows what every session and sub-agent is doing, how far it has got, what it costs and what needs you, so you can follow the work at a glance instead of reading transcripts.

It opens as a canvas in the app's side panel, or in any browser through a small local launcher. It reads Copilot's local data read-only. Its only network requests are read-only `gh` and `az` queries about the swarm's pull requests.

## What it shows

- Header: the swarm, how long it has run, its cost in credits and dollars, and how many sessions and sub-agents are working, stuck, waiting, idle, done or failed. While nothing in the run is busy, stuck or waiting, its clock, and the runtimes of sessions and sub-agents that have not ended, stop at the last activity and the header says "quiet since" that time; they start again when work resumes. A run that stays quiet for 2 hours moves to History. Opening, restoring or closing a canvas in a session is not activity, so it never brings a finished run back.
- Needs you: a stalled swarm first, then questions, plans and PRs waiting for you, longest wait first.
- Cards: one card per unit with its state, stage, task-list progress, latest report, running sub-agents and cost. The orchestrator's one-off sub-agents get a card while they run or are stuck, with their type and mode in place of the stage and monitor; when one finishes, its card says how it ended and leaves the Cards tab 10 minutes later. Finished sub-agents stay on the Board. A card's border says what it is: blue for a one-off sub-agent, green for a child session; the Board's cards use the same colours.
- Activity: the latest events across the swarm.
- Timeline: each session's busy, idle and waiting time over the last hours or the whole run, with cost over time. The orchestrator's one-off sub-agents have their own lanes right under it, for those active in the chosen window.
- Plan and Board: the planned units and what each waits on, and every unit by stage, from planned to archived, with the orchestrator's sub-agents in a column of their own.
- Detail panel: one unit's current activity, why it counts as stuck or waiting, its latest report, sub-agents, PR and monitor (for a sub-agent: its type, mode and effort), and recent activity.
- History: finished runs with their duration, cost and outcomes, and a summary of each run.

## Open the dashboard

In the Copilot app, ask the agent to open the Swarm dashboard canvas. An orchestrator can open it itself with `open_canvas` and the canvas id `swarm-dashboard`, for example when it starts its first child session. The canvas shows the swarm of the session it was opened in. If that session is in no swarm, the canvas says so, offers the live swarms in its swarm picker, and shows the session's swarm as soon as the session joins one. To show a particular swarm, pass its root session id as input: `{ "swarm": "<root session id>" }`.

In a browser, run the launcher from the plugin folder and open the address it prints:

```bash
cd ~/.copilot/installed-plugins/ai-tools/wintermute   # or ghcp/plugins/wintermute in a clone
npm start
```

`npm start -- --demo` serves a synthetic swarm with simulated activity instead of your data, `--demo stress` a crowded one, and `--still` stops the simulation. The launcher reuses a dashboard that already runs on the port, but never one with other data: to run the sample data beside your own dashboard, give it another port, for example `npm start -- --demo --port 7928`.

## Light and dark

The dashboard has a light and a dark theme. It starts in the one your system uses, and follows the system while you have not picked one. The button beside the Cockpit button switches between them: it shows a moon in the light theme and a sun in the dark one. The dashboard remembers your choice for that browser or for the app's panel; where the browser blocks storage, it keeps the choice until the page reloads. The cockpit always has its own dark look, so it has no such button.

## The cockpit

The cockpit is a second, dark look at the same swarm: a seat at a mission control desk, looking through a curved window at a black hole, with the swarm on curved glass panels. It shows what the regular view shows, without new data or actions: the clock and run timer, what needs you, a tile per child session and per running sub-agent, the activity, the cost and the pull requests. Click a panel to see the details in the regular view.

The cockpit is made for Chrome and Edge. In the app's canvas, the Cockpit button shows its address to open in one of them.

Open it with the **Cockpit** button, the spaceship icon at the right end of the Live page's top bar. It opens in its own browser window on the swarm you are watching, at `http://127.0.0.1:<port>/cockpit?swarm=<root session id>`.

- Quality: **High** (the default) draws the black hole on every frame, at most 30 frames a second. **Balanced** draws it on every second frame, and on every frame while the pointer moves. The choice is kept in the browser. High keeps the GPU busy about a fifth of the time at 1440 × 900 and a quarter at 1920 × 1080 on an Apple M5 Pro, and may make a fanless laptop warm.
- The cockpit stops drawing while its window is hidden, shows one still frame when the system asks to reduce motion, and lowers the black hole's resolution when frames run late.
- It needs a window of at least 1100 × 800, about 1.3 times as wide as it is tall, and WebGL2. Without WebGL2 it shows the panels on a plain dark background.

## The port

The dashboard uses `http://127.0.0.1:7927/` by default. One dashboard server runs on the machine, shared by every canvas and browser: the first canvas you open, or the launcher, starts it, and everything else reuses it. If the session that hosts it ends, another open canvas takes the port over within a few seconds and the pages reconnect by themselves. A server started by a canvas stops a few minutes after the last canvas closes and no page is connected; the launcher runs until you press Ctrl+C. Before reusing a server on the port, the launcher and the canvas ask it who it is, and accept only a direct answer from that port: a server that redirects the question counts as another program.

If another program already uses port 7927, the launcher says so and exits, and the canvas shows the same error. Use another port with `npm start -- --port <n>`, or set `SWARM_DASHBOARD_PORT` for both the launcher and the environment the Copilot app starts with.

## Privacy and data access

Read-only access. The dashboard reads `~/.copilot/data.db`, `~/.copilot/session-store.db` and the session folders, and never writes to them. Its only writes are run summaries in `~/.copilot/swarm-dashboard/history/`, which keep finished runs in History after logs are cleaned up. SQLite databases are opened read-only. A database in WAL mode that a running Copilot process has open is read through one long-lived read-only connection, opened only when its `-wal` and `-shm` files already exist; while it's open, its lock keeps those files in place. A database that nothing has open is read in immutable mode, which never touches side files. If a database's write-ahead log holds data but its shared-memory file is missing, the dashboard skips that read, keeps the last data it read and shows a warning. One narrow case remains: if the last Copilot process finishes closing a database in the few microseconds between the dashboard's check and SQLite's read lock, SQLite creates an empty `-wal` and `-shm` beside it. No data changes, and the next process that opens the database reuses or removes them.

- From `data.db` it reads named columns only.
- The server listens on 127.0.0.1 only, answers only requests addressed to `127.0.0.1` or `localhost` on its port, and serves only GET and HEAD. In current browsers, its data and live-update endpoints also refuse requests that another website starts. The page loads nothing from the internet.
- The only outbound requests are read-only `gh` and `az` queries for the state of the swarm's pull requests, made with your existing CLI login and cached.

## How it decides what is stuck

A session counts as stuck when a model call, tool call or sub-agent has gone quiet for longer than a set limit, when it is busy but has written nothing for 10 minutes, when it keeps failing or repeating itself, or when it has been idle for 30 minutes after a progress report with no task finished and no monitor due; a session waiting for your answer is never stuck. The detail panel names the rule that fired and its numbers. The rules and their limits are in the [design](../../../docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md) (section 9) and the defaults in `engine/config.mjs`. Orchestrators can report status in a fixed format that the dashboard reads exactly (design section 10).

## Commands

Run these from the plugin folder.

| Command | What it does |
| --- | --- |
| `npm start` | Serve the dashboard for browsers (`--port`, `--demo`, `--still`) |
| `npm run snapshot -- --list` | Print the swarms as JSON; `--swarm <id>`, `--history` and `--run <id>` print the rest |
| `npm test` | Run the unit tests |
| `npm run validate` | Check the plugin's manifests, files and marketplace entry, the six agents and their worker IDs, and that the CHANGELOG has an entry for the current version |
| `npm run release:bump -- <version\|patch\|minor\|major>` | Advance the single package version and prepare its changelog section |
| `npm run release:publish -- --dry-run` | Check release readiness and preview the tag and notes without publishing |
| `npm run release:publish` | Tag the current main commit, push only that tag and create its GitHub Release |
| `npm run check:layout` | Check every view, in the light and the dark theme, for overlap, clipped text, type, spacing and contrast at every width, and that live updates leave the page steady, that History refreshes in place when a run finishes or the page reconnects, and that the theme button switches and remembers the theme, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one); `-- --live <url>` checks a running dashboard, and `-- --engine webkit` runs the same checks in WebKit (see below) |
| `node scripts/check-cockpit.mjs` | Run only the cockpit's checks: the scene, the panels' arrangement, type, spacing and contrast, motion, the links between the windows and the regular view's speed, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one) (`--engine webkit`, `--only <check>`, `--screenshots <dir>`); `npm run check:layout` runs them too |
| `node scripts/cockpit-gpu.mjs` | Measure the cockpit's GPU time per frame on this machine for High and Balanced (`--engine webkit`) |

### Check the layout in WebKit (optional)

The Copilot app shows the canvas in WebKit, so `npm run check:layout -- --engine webkit` runs the same checks in Playwright's WebKit build. Playwright is not a dependency of this plugin. Install it outside this repository, download its WebKit build once, and point the check at it:

```bash
npm install --prefix <folder outside this repository> playwright-core
node <folder>/node_modules/playwright-core/cli.js install webkit
PLAYWRIGHT_CORE=<folder>/node_modules/playwright-core npm run check:layout -- --engine webkit
```

Without Playwright or its WebKit build the check says so and skips. `npm test` and `npm run validate` never need it.

## Releases

Agents and dashboard ship as one version. Any change to either requires a version bump in `plugin.json`, `package.json` and the `wintermute` entry in the root marketplace, with notes in [CHANGELOG.md](CHANGELOG.md). The commands require Node.js 18 or later and no npm dependencies. Publishing also requires Git, authenticated `gh`, and permission to push tags and create releases.

Before merging a change, run from `ghcp/plugins/wintermute`:

```bash
npm run release:bump -- patch
# Replace the new CHANGELOG.md TODO with release notes.
npm test && npm run validate
```

Use `minor` for features and, while the package is 0.x, incompatible changes to agent IDs, invocation behaviour, the canvas ID or report/dashboard contracts. Use `patch` for compatible fixes; `major` advances to the next major version. You can also give an explicit stable SemVer such as `0.3.0`. Leading zeroes, `v` prefixes, prerelease/build suffixes and versions that do not increase are rejected. The bump command preserves an existing changelog section for the chosen version, and does not commit, tag or publish. Review and commit the three version changes and the completed notes with the implementation. Run `npm run check:layout` too when dashboard UI files change.

After merging, publish from a clean, up-to-date `main` checkout, not a feature branch or an installed plugin copy. Start at the repository root:

```bash
git switch main
git fetch origin
git merge --ff-only origin/main
cd ghcp/plugins/wintermute
npm run release:publish -- --dry-run
npm run release:publish
```

The publisher runs the plugin validator, requires finished notes for the current version, and requires HEAD to match both local `origin/main` and the live remote main ref. It refuses dirty trees (including untracked files) and tags that already exist locally or on origin. Before changing any refs, it checks `gh` authentication for origin's host and confirms that `gh` can resolve origin's repository. Origin must be an HTTPS or SSH GitHub URL with an owner/name path and no custom port. The dry run performs the same read-only checks, including network queries to origin and GitHub, and prints the planned tag and notes; it creates no refs, pushes nothing and creates no release.

A publish creates the annotated tag `wintermute-vX.Y.Z` on HEAD, pushes only that tag, and creates a GitHub Release using only that version's changelog section. The release explicitly targets origin's host and repository, regardless of `GH_REPO`, `GH_HOST` or `gh`'s default repository. The root marketplace continues to track main through its relative source path: tags and GitHub Releases are release records, not a separate installation channel or a gate on plugin updates. Updating the plugin does not replace already-running sessions or an old dashboard server; follow the update/restart guidance above.

Publishing is not atomic across Git and GitHub. If a push or GitHub Release creation fails, the command reports the failure and retains the annotated tag; rerunning refuses that existing tag. Inspect the local tag, origin tag and GitHub Release first. After resolving the cause, push only the retained tag if it never reached origin, or create the missing release with `gh release create wintermute-vX.Y.Z --repo <host>/<owner>/<repo> --verify-tag --title "Wintermute vX.Y.Z" --notes-file <file-containing-that-changelog-section>`, using origin's host and repository for `--repo`. Never move or overwrite an already-published tag.

## Troubleshooting

- "Port 7927 is used by another program" or "… is in use and not answering": see [The port](#the-port).
- "Port 7927 serves the dashboard with sample data": a launcher started with `--demo` holds the port. Stop it with Ctrl+C in its terminal, or start it with `--port <n>`.
- "Disconnected · retrying" in a browser: no dashboard server is running. Start the launcher or open the canvas. In the canvas the page recovers by itself within a few seconds; if it does not, close and reopen the canvas.
- Old behaviour after an update: restart the app, or reload extensions in every session, so that no session still serves the previous version. An open dashboard page reloads itself once when it reconnects to a server with new dashboard files, and keeps its tab, swarm and open panel. A canvas that finds an older dashboard on the port says so in the extension log.
- Pages that never load: browsers allow about six open connections per site, and each open dashboard page holds one. With more than about six dashboard tabs or canvases open at once, the extra pages wait; close the ones you do not need. The server itself serves at most 32 live pages at once. It disconnects a page that stops taking updates for 30 seconds, and that page reconnects by itself.
- "1 data warning" at the top right: some Copilot data could not be read, for example after a Copilot update changed a file format. Hover over it for details. The rest of the dashboard still works.

## Layout

| Folder | What it holds |
| --- | --- |
| `engine/` | Reads Copilot's local data into swarm snapshots and run summaries |
| `server/` | The local server, live updates, the shared port and the canvas host |
| `ui/` | The dashboard page: plain ES modules and CSS, no build step |
| `com.github.copilot/agents/` | The six orchestrator agents |
| `com.github.copilot/extensions/swarm-dashboard/` | The canvas extension |
| `scripts/` | The launcher, the snapshot command, the layout check and the validator |
| `tests/` | Unit tests and synthetic fixtures |
