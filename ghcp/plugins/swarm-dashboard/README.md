# Swarm dashboard

A watch-only dashboard for agentic swarms in the GitHub Copilot app. A swarm is a session that has started child sessions, such as an orchestrator that hands each unit of work to its own session. The dashboard shows what every session and sub-agent is doing, how far it has got, what it costs and what needs you, so you can follow the work at a glance instead of reading transcripts.

It opens as a canvas in the app's side panel, or in any browser through a small local launcher. It reads Copilot's local data read-only. Its only network requests are read-only `gh` and `az` queries about the swarm's pull requests.

## What it shows

- Header: the swarm, how long it has run, its cost in credits and dollars, and how many sessions are working, stuck, waiting, idle, done or failed.
- Needs you: a stalled swarm first, then questions, plans and PRs waiting for you, longest wait first.
- Cards: one card per unit with its state, stage, task-list progress, latest report, running sub-agents and cost.
- Activity: the latest events across the swarm.
- Timeline: each session's busy, idle and waiting time over the last hours or the whole run, with cost over time.
- Plan and Board: the planned units and what each waits on, and every unit by stage, from planned to archived.
- Detail panel: one unit's current activity, why it counts as stuck or waiting, its latest report, sub-agents, PR and monitor, and recent activity.
- History: finished runs with their duration, cost and outcomes, and a summary of each run.

## Install

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install swarm-dashboard@ai-tools
```

Then restart your Copilot sessions, or ask Copilot to reload extensions, so the canvas loads. The plugin has no npm dependencies, and the canvas runs on the Node.js that ships with Copilot. The browser launcher and the commands below need Node.js 18 or later.

## Open the dashboard

In the Copilot app, ask the agent to open the Swarm dashboard canvas. An orchestrator can open it itself with `open_canvas` and the canvas id `swarm-dashboard`, for example when it starts its first child session. The canvas shows the swarm of the session it was opened in, or else the most recently active swarm. To show a particular swarm, pass its root session id as input: `{ "swarm": "<root session id>" }`.

In a browser, run the launcher from the plugin folder and open the address it prints:

```bash
cd ~/.copilot/installed-plugins/ai-tools/swarm-dashboard   # or ghcp/plugins/swarm-dashboard in a clone
npm start
```

`npm start -- --demo` serves a synthetic swarm with simulated activity instead of your data, `--demo stress` a crowded one, and `--still` stops the simulation. The launcher reuses a dashboard that already runs on the port, but never one with other data: to run the sample data beside your own dashboard, give it another port, for example `npm start -- --demo --port 7928`.

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
| `npm run validate` | Check the plugin's manifests, files and marketplace entry |
| `npm run check:layout` | Check every view for overlap, clipped text, type, spacing and contrast at every width, and that live updates leave the page steady, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one); `-- --live <url>` checks a running dashboard, and `-- --engine webkit` runs the same checks in WebKit (see below) |

### Check the layout in WebKit (optional)

The Copilot app shows the canvas in WebKit, so `npm run check:layout -- --engine webkit` runs the same checks in Playwright's WebKit build. Playwright is not a dependency of this plugin. Install it outside this repository, download its WebKit build once, and point the check at it:

```bash
npm install --prefix <folder outside this repository> playwright-core
node <folder>/node_modules/playwright-core/cli.js install webkit
PLAYWRIGHT_CORE=<folder>/node_modules/playwright-core npm run check:layout -- --engine webkit
```

Without Playwright or its WebKit build the check says so and skips. `npm test` and `npm run validate` never need it.

## Troubleshooting

- "Port 7927 is used by another program" or "… is in use and not answering": see [The port](#the-port).
- "Port 7927 serves the dashboard with sample data": a launcher started with `--demo` holds the port. Stop it with Ctrl+C in its terminal, or start it with `--port <n>`.
- "Disconnected · retrying" in a browser: no dashboard server is running. Start the launcher or open the canvas. In the canvas the page recovers by itself within a few seconds; if it does not, close and reopen the canvas.
- Old behaviour after an update: restart the app, or reload extensions in every session, so that no session still serves the previous version. A canvas that finds an older dashboard on the port says so in the extension log.
- Pages that never load: browsers allow about six open connections per site, and each open dashboard page holds one. With more than about six dashboard tabs or canvases open at once, the extra pages wait; close the ones you do not need. The server itself serves at most 32 live pages at once. It disconnects a page that has read nothing for 30 seconds, and that page reconnects by itself.
- "1 data warning" at the top right: some Copilot data could not be read, for example after a Copilot update changed a file format. Hover over it for details. The rest of the dashboard still works.

## Layout

| Folder | What it holds |
| --- | --- |
| `engine/` | Reads Copilot's local data into swarm snapshots and run summaries |
| `server/` | The local server, live updates, the shared port and the canvas host |
| `ui/` | The dashboard page: plain ES modules and CSS, no build step |
| `com.github.copilot/extensions/swarm-dashboard/` | The canvas extension |
| `scripts/` | The launcher, the snapshot command, the layout check and the validator |
| `tests/` | Unit tests and synthetic fixtures |
