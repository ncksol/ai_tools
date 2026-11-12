# Wintermute

Wintermute is one Copilot plugin with two parts that are released and updated together:

- the `wintermute-core` orchestrator agent for the GitHub Copilot app, which plans work and hands it to child sessions;
- the swarm dashboard, which shows what those sessions are doing.

New to Wintermute? Start with the [quick start](QUICKSTART.md). This README is the reference. Each release is listed in the [CHANGELOG](CHANGELOG.md).

## Install

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install wintermute@ai-tools
```

Then start a new session, or restart the Copilot app, to get the agents. Reloading extensions in a session, or restarting the app, loads the dashboard canvas. The plugin has no npm dependencies, and the canvas runs on the Node.js that ships with Copilot. The browser launcher and the commands below need Node.js 18 or later. The browser launcher and `npm run snapshot` also need a SQLite reader to read Copilot's data: Node.js 22.15 or later (23.10 or later on the 23.x line), or the `sqlite3` command-line tool on your `PATH`.

## Update

```bash
copilot plugin update wintermute@ai-tools
```

Then start new sessions, or restart the app, to get the updated agents. A session that is already running keeps the agents and prompts it started with, and automations it created keep running until you stop them in the app or archive the session. Reloading extensions in a session, or restarting the app, refreshes the dashboard canvas. A dashboard server that already runs on the port keeps serving the old version until no session hosts it any more; `curl -s http://127.0.0.1:7927/api/health` shows the version it runs (see [Troubleshooting](#troubleshooting)). Agent changes in this repository reach you only through a plugin update, not through `git pull`.

## The agents

The agents are in `com.github.copilot/agents/`. Copilot names a plugin agent `<plugin>:<file name>`, so their IDs are `wintermute:<name>`. The agent picker and the composer's **+** menu show the plain name.

| Agent | ID | What it does |
| --- | --- | --- |
| `wintermute-core` | `wintermute:wintermute-core` | The orchestrator. Plans, delegates and tracks multi-PR work. Hands owned work and one-off jobs to child sessions, which run as `wintermute-peon`, and never starts sub-agents. May do a quick job itself, and commits small edits on its own session branch. Plans for wall-clock speed. |
| `wintermute-peon` | `wintermute:wintermute-peon` | The agent every child session of `wintermute-core` runs as. Can't start sub-agents or sessions. Hidden from the picker. |

Run `wintermute-core` as the session's agent in the GitHub Copilot app: pick it before your first message, from the composer's **+** menu or with `/agent`. Where a tool or CLI flag takes an agent ID, use the `wintermute:` ID. A bare name never resolves to a plugin agent, so `wintermute-core` starts its children as `wintermute:wintermute-peon`.

`wintermute-core` is meant to run on Claude Opus 5.5 at `max` reasoning effort. Its "Models and effort" tiers set the model and effort only for the jobs it hands out.

## The swarm dashboard

A watch-only dashboard for agentic swarms in the GitHub Copilot app. A swarm is a session that has started child sessions, such as an orchestrator that hands each unit of work to its own session. Before its first child session, a `wintermute-core` session is a swarm while it waits on a tagged question, such as its plan question, so that the question shows in the header. Sub-agents alone don't make a session a swarm. Wintermute's own agents never start sub-agents, but the dashboard works for any session that starts child sessions, and shows the sub-agents that sessions in such a swarm run. The dashboard shows what every session and sub-agent is doing, how far it has got, what it costs and what needs you, so you can follow the work at a glance instead of reading transcripts.

It opens as a canvas in the app's side panel, or in any browser through a small local launcher. It reads Copilot's local data read-only and never changes it. Its only network requests of its own are read-only `gh` and `az` queries about the swarm's pull requests (see [Privacy and data access](#privacy-and-data-access)).

## What it shows

- Header: the orchestrator's card. Its status mark and its state in words, with a now line that says what it is doing, the question or plan it waits on, why the swarm stalled, or what it waits for. Then how long the swarm has run, its cost in dollars (credits in the tooltip), and tiles that count the active units working, stuck, blocked and idle, what waits on you, and the finished units. While nothing in the run is busy, stuck or waiting, its clock, and the runtimes of sessions and sub-agents that have not ended, stop at the last activity and the header says "quiet since" that time; they start again when work resumes. A run that stays quiet for 2 hours moves to History. Canvas changes, app shutdown/resume, remote connections, main-session settings, session-start/end hooks and cumulative usage checkpoints are bookkeeping, not activity. A normally shut-down session with only bookkeeping since then stays stopped when no in-use lock identifies a live session; a new user message or turn still counts as work.
- Cards: one card for each active unit, all the same height, stuck ones first, then questions and plans (oldest wait first), blocked, busy and idle. A card has a status mark, the unit's label and name, its state in words, and its PR, the PR it reviews ("reviews PR #418") when it has none of its own, or, for a sub-agent of the swarm's root session, its type. A now line says what it is doing or said last: its own question or plan, the stuck tool call, the todo in progress, the sub-agent it waits for, the tool call's description, or its latest report. The footer shows when a Needs you item names the unit (for example "PR to approve"), its running sub-agents, its todos done, its model and reasoning effort, and its cost in dollars. A mark at the top right says when some of its data could not be read. Units that have finished (stopped, merged, done, failed, crashed, cancelled or closed, or idle with a complete report and no PR still open) move to a Finished section below the cards, closed by default; a unit with an open question or plan of its own stays on the grid. Archived units are on the Board.
- Waiting on you: the cards and the header show what waits on you; off the Cards tab one line says how much and since when, and opens the Cards tab.
- Activity: the latest events across the swarm.
- While the page is disconnected, the cards dim and the clocks stop, and the status says since when the data is shown.
- Timeline: each session's busy, idle and waiting time over the last hours or the whole run, with cost over time. The root session's sub-agents have their own lanes right under it, for those active in the chosen window.
- Plan and Board: the planned units and what each waits on, as a graph of stacked branches; and a board of units grouped as on the Cards tab: planned, in progress, in review (an open or draft PR) and finished (the latest 10, with Show all), with archived units under a closed row below.
- Detail panel: one unit's current activity, why it counts as stuck or waiting, its latest report, sub-agents, PR and monitor (for a sub-agent: its type, mode and effort), and recent activity. The monitor shows a scheduled automation on the unit, if there is one; the agents don't start PR monitors, so an open PR without one shows "no monitor", which is normal. Only a configured schedule that is overdue shows as missing.
- History: finished runs with their duration, cost and outcomes, and a summary of each run. A run that resumes and finishes again gets a new summary. When a run's logs are cleaned up, or a child workspace is deleted and the run's listed cost falls, its saved summary is kept.

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

Read-only access. The dashboard reads `~/.copilot/data.db` and the session folders, and never writes to them. Costs come from the model-call records (`session.usage_record`) and compactions in each session's `events.jsonl`; a session whose log has no `session.usage_record` events shows only its compaction cost. While a log of a run is missing, its cost is incomplete: the dashboard warns, and never replaces the run's stored summary. It writes run summaries to `~/.copilot/swarm-dashboard/history/`, which keep finished runs in History after logs are cleaned up, and the page keeps its display choices (tab, time span, swarm, theme and cockpit quality) in browser storage. SQLite databases are opened read-only. A database in WAL mode that a running Copilot process has open is read only when its `-wal` and `-shm` files already exist. With Node.js's built-in SQLite, it is read through one long-lived read-only connection, whose lock keeps those files in place; with the `sqlite3` command-line tool, each query opens its own read-only connection. A database that nothing has open is read in immutable mode, which never touches side files. If a database's write-ahead log holds data but its shared-memory file is missing, the dashboard skips that read, keeps the last data it read and shows a warning. One narrow case remains: if the last Copilot process finishes closing a database in the few microseconds between the dashboard's check and SQLite's read lock, SQLite creates an empty `-wal` and `-shm` beside it. No data changes, and the next process that opens the database reuses or removes them.

- From `data.db` it reads named columns only.
- The server listens on 127.0.0.1 only, answers only requests addressed to `127.0.0.1` or `localhost` on its port, and serves only GET and HEAD. In current browsers, its data and live-update endpoints also refuse requests that another website starts. The page loads nothing from the internet.
- The only outbound requests the dashboard makes are read-only `gh` and `az` queries for the state of the swarm's pull requests, made with your existing CLI login and cached. `az` runs only when its `azure-devops` extension is already installed; the dashboard never installs it. Both CLIs may still do their own housekeeping when they run: they refresh their sign-in caches, `az` updates its config folder, and after `az` is installed or upgraded it fetches version metadata from GitHub once.

## How it decides what is stuck

A session counts as stuck when a model call, tool call or sub-agent has gone quiet for longer than a set limit, when it is busy but has written nothing for 10 minutes, when it keeps failing or repeating itself, or when it has been idle for 30 minutes after a progress report with no task finished and no monitor due; a session waiting for your answer is never stuck. The detail panel names the rule that fired and its numbers. The rules are in `engine/model/status.mjs` and their limits in `engine/config.mjs`. `wintermute-core` and its children report in a fixed format that the dashboard reads exactly; the [`wintermute-core` prompt](com.github.copilot/agents/wintermute-core.agent.md) defines it in its "Dashboard data contract", "The `children` table" and "Report format" sections.

A whole swarm counts as stalled when at least one open unit remains, the orchestrator and every open unit are idle, and nothing is scheduled to run. Open units are those on the Cards tab's active grid: archived units and units in Finished do not count. Finished includes stopped, merged, completed, done, failed, crashed, cancelled or closed work (done: the orchestrator closed it after a complete report, and it has no PR of its own), and idle units with a complete latest report and no PR still open. A unit with an open question or plan of its own stays active and prevents a stall, even when its outcome hides that wait in its status. A unit whose latest report is `complete`, whose PR is open (draft or ready) and that has had no reply from the orchestrator since is waiting on review: it has done its part, so it doesn't count towards a stall either. A swarm with no remaining open units is not stalled.

## Commands

Run these from the plugin folder.

| Command | What it does |
| --- | --- |
| `npm start` | Serve the dashboard for browsers (`--port`, `--demo`, `--still`) |
| `npm run snapshot -- --list` | Print the swarms as JSON; `--swarm <id>`, `--history` and `--run <id>` print the rest |
| `npm test` | Run the unit tests |
| `npm run validate` | Check the plugin's manifests, files and marketplace entry, the two agents and the peon's plugin ID, and that the CHANGELOG has an entry for the current version |
| `npm run release:bump -- <version\|patch\|minor\|major>` | Advance the single package version and prepare its changelog section |
| `npm run release:publish -- --dry-run` | Check release readiness and preview the tag and notes without publishing |
| `npm run release:publish` | Tag the current main commit, push only that tag and create its GitHub Release |
| `npm run check:layout` | Check every view, in the light and the dark theme, for overlap, clipped text, type, spacing and contrast at every width, and that live updates leave the page steady, that History refreshes in place when a run finishes or the page reconnects, and that the theme button switches and remembers the theme, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one); `-- --live <url>` checks a running dashboard, and `-- --engine webkit` runs the checks in WebKit, apart from the cockpit's motion, window-link and regular-view speed checks, which run only in Chrome, Chromium or Edge (see below) |
| `node scripts/check-cockpit.mjs` | Run only the cockpit's checks: the scene, the panels' arrangement, type, spacing and contrast, motion, the links between the windows and the regular view's speed, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one) (`--engine webkit`, `--only <check>`, `--screenshots <dir>`); `npm run check:layout` runs them too |
| `node scripts/cockpit-gpu.mjs` | Measure the cockpit's GPU time per frame on this machine for High and Balanced (`--engine webkit`) |

### Check the layout in WebKit (optional)

The Copilot app shows the canvas in WebKit, so `npm run check:layout -- --engine webkit` runs the checks in Playwright's WebKit build. The cockpit's motion, window-link and regular-view speed checks run only in Chrome, Chromium or Edge, and WebKit skips them. Playwright is not a dependency of this plugin. Install it outside this repository, download its WebKit build once, and point the check at it:

```bash
npm install --prefix <folder outside this repository> playwright-core
node <folder>/node_modules/playwright-core/cli.js install webkit
PLAYWRIGHT_CORE=<folder>/node_modules/playwright-core npm run check:layout -- --engine webkit
```

Without Playwright or its WebKit build the check says so and skips. `npm test` and `npm run validate` never need it.

## Releases

This section is for maintainers. Agents and dashboard ship as one version. Any change to either requires a version bump in `plugin.json`, `package.json` and the `wintermute` entry in the root marketplace, with notes in [CHANGELOG.md](CHANGELOG.md). The commands require Node.js 18 or later and no npm dependencies. Publishing also requires Git, authenticated `gh`, and permission to push tags and create releases.

Before merging a change, run from `ghcp/plugins/wintermute`:

```bash
npm run release:bump -- patch
# Replace the new CHANGELOG.md TODO with release notes.
npm test && npm run validate
```

Versions follow semantic versioning. Use `major` for incompatible changes to agent IDs, invocation behaviour, the canvas ID or the report and dashboard contracts, `minor` for compatible features, and `patch` for compatible fixes. You can also give an explicit stable version such as `1.2.0`; leading zeroes, `v` prefixes, prerelease or build suffixes and versions that do not increase are rejected. The bump command keeps an existing changelog section for the chosen version, and does not commit, tag or publish. Commit the three version changes and the finished notes with the change. Run `npm run check:layout` too when dashboard UI files change.

After merging, publish from a clean, up-to-date `main` checkout, not a feature branch or an installed plugin copy. Start at the repository root:

```bash
git switch main
git fetch origin
git merge --ff-only origin/main
cd ghcp/plugins/wintermute
npm run release:publish -- --dry-run
npm run release:publish
```

The publisher runs the plugin validator, requires finished notes for the current version, and requires HEAD to match both local `origin/main` and the live remote main ref. It refuses dirty trees (including untracked files) and tags that already exist locally or on origin, and checks that `gh` is signed in to origin's host and can resolve origin's repository. Origin must be an HTTPS or SSH GitHub URL with an owner/name path and no custom port. The dry run makes the same read-only checks and prints the planned tag and notes; it creates no refs, pushes nothing and creates no release.

A publish creates the annotated tag `wintermute-vX.Y.Z` on HEAD, pushes only that tag, and creates a GitHub Release from that version's changelog section, on origin's host and repository whatever `GH_REPO`, `GH_HOST` or `gh`'s default repository say. The root marketplace tracks main through its relative source path: tags and GitHub Releases are release records, not a separate installation channel. Users get a release through `copilot plugin update` (see [Update](#update)).

Publishing is not atomic across Git and GitHub. If a push or the GitHub Release fails, the command reports the failure and keeps the annotated tag, and a rerun refuses that tag. Inspect the local tag, origin tag and GitHub Release first. After fixing the cause, push only the kept tag if it never reached origin, or create the missing release with `gh release create wintermute-vX.Y.Z --repo <host>/<owner>/<repo> --verify-tag --title "Wintermute vX.Y.Z" --notes-file <file-containing-that-changelog-section>`, using origin's host and repository for `--repo`. Never move or overwrite a published tag.

## Troubleshooting

- "Port 7927 is used by another program" or "… is in use and not answering": see [The port](#the-port).
- "Port 7927 serves the dashboard with sample data": a launcher started with `--demo` holds the port. Stop it with Ctrl+C in its terminal, or start it with `--port <n>`.
- "Disconnected · retrying" in a browser: the page lost its live connection. Usually no dashboard server is running: start the launcher or open the canvas. It also shows when the server already serves its limit of 32 live pages (see the item on pages that never load). In the canvas the page recovers by itself within a few seconds; if it does not, close and reopen the canvas.
- Old behaviour after an update: restart the app, or reload extensions in every session, so that no session still serves the previous version; a dashboard started separately in a browser has to be restarted by whoever started it. `curl -s http://127.0.0.1:7927/api/health` shows the version that serves the port. An open dashboard or cockpit page reloads itself once when it reconnects to a server with new dashboard files, and keeps its tab, swarm and open panel. A canvas that finds an older dashboard on the port says so in the extension log, and shows an out-of-date notice in the regular view and the cockpit.
- Pages that never load: browsers allow about six open connections per site, and each open dashboard page holds one. With more than about six dashboard tabs or canvases open at once, the extra pages wait; close the ones you do not need. The server itself serves at most 32 live pages at once. It disconnects a page that stops taking updates for 30 seconds, and that page reconnects by itself.
- "1 data warning" at the top right: some Copilot data could not be read, for example after a Copilot update changed a file format. Session-log and cost warnings apply only to the selected swarm, including its child sessions and older session aliases; engine-wide problems appear on every swarm. Hover over it for details. The rest of the dashboard still works.

## Layout

| Folder | What it holds |
| --- | --- |
| `engine/` | Reads Copilot's local data into swarm snapshots and run summaries |
| `server/` | The local server, live updates, the shared port and the canvas host |
| `ui/` | The dashboard page: plain ES modules and CSS, no build step |
| `com.github.copilot/agents/` | The orchestrator agent and its peon |
| `com.github.copilot/extensions/swarm-dashboard/` | The canvas extension |
| `scripts/` | The launcher, the snapshot command, the layout check and the validator |
| `tests/` | Unit tests and synthetic fixtures |
