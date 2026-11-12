# Wintermute

Wintermute is a plugin for the GitHub Copilot app that plans and runs substantial work as a crew of agent sessions: research, specs, code, investigations and documents. Copilot can already use sub-agents and second opinions, but by default nothing requires an independent check, long sessions [can get less reliable](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents), and with several sessions open you become the project manager. You describe the goal once; Wintermute splits it across sessions with a model for each job, running independent parts in parallel. Before work counts as done, another session checks it: code gets a cross-vendor review and a check that the tests ran at the pushed commit before merging; a spec or other key document gets a fact-check from another vendor. A dashboard shows progress, cost, stuck work and what needs you. New here? Start with the [quick start](QUICKSTART.md).

## Compared with one session and `/orchestrate`

The app's built-in `/orchestrate` already runs child sessions in parallel and stacks PRs; use it when you want to set the workflow yourself. Wintermute packages model choice, independent review and verification into a preset workflow, with a dashboard to follow the whole job. For code work, the difference looks like this:

| | One session | Built-in `/orchestrate` | Wintermute |
| --- | --- | --- | --- |
| Who does the work | One main session, which can use sub-agents | Child sessions in parallel, with stacked PRs | Child sessions in parallel, with stacked PRs |
| Model and effort | The session's model, or Copilot Fusion's pick per step | No fixed tier policy; defaults or your instructions | Set for every child session from the agent's tier table |
| Review | On demand, or automatically with rubber duck (when enabled) or Fusion | No prescribed per-PR review gate; automatic critique is still available | A model from another vendor, before every merge |
| Proof that the tests ran | The session's own report | No prescribed independent test or CI verification | A separate session checks tests, CI and scope at the pushed commit |
| Final check | No prescribed two-judge merge panel | No prescribed two-judge merge panel | Two judges from two vendors check the last PR |
| Following the work | The transcript | The app's project Overview | The Overview, plus a dashboard with progress, cost, stuck work and what needs you |

The app also gives second opinions from other models, such as `/rubber-duck` and Copilot Fusion's Critique pattern. Those advise the session. In Wintermute, the review by another vendor and the claims check are conditions for merging.

## Good fit and trade-offs

- For a small, self-contained task, a single session is usually simpler; the coordination overhead may not be worth it.
- Even a one-PR swarm normally adds a unit review, a claims check and a two-judge panel. These add model calls and can increase token use and cost.
- Cross-vendor review needs at least two vendors; the default policy uses Anthropic, OpenAI and Google. You can limit the work to one vendor, but you lose that diversity. The checks make independent review happen, but they don't guarantee correct code.

## What's in the plugin

Wintermute is one Copilot plugin with two parts that are released and updated together:

- the `wintermute-core` orchestrator agent for the GitHub Copilot app, which plans work and hands it to child sessions;
- the [swarm dashboard](DASHBOARD.md), which shows what those sessions are doing.

Each release is listed in the [CHANGELOG](CHANGELOG.md).

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

Follow each session's progress, cost and blockers in one watch-only view, and see what needs your input without reading every transcript. The dashboard reads Copilot's local data without changing it; see [Privacy and data access](#privacy-and-data-access).

- In the Copilot app, `wintermute-core` opens it in the side panel when it creates its first child session. To open it again, ask the agent to open the swarm dashboard canvas (canvas id `swarm-dashboard`).
- In a browser, run the launcher from the plugin folder and open the address it prints:

  ```bash
  cd ~/.copilot/installed-plugins/ai-tools/wintermute   # or ghcp/plugins/wintermute in a clone
  npm start
  ```

  `npm start -- --demo` shows sample data instead of yours; add `--port 7928` if your own dashboard already runs on the default port.

The [dashboard guide](DASHBOARD.md) walks through every view with screenshots and explains how the dashboard decides what is stuck.

## The port

The dashboard uses `http://127.0.0.1:7927/` by default. One dashboard server runs on the machine, shared by every canvas and browser: the first canvas you open, or the launcher, starts it, and everything else reuses it. If the session that hosts it ends, another open canvas takes the port over within a few seconds and the pages reconnect by themselves. A server started by a canvas stops a few minutes after the last canvas closes and no page is connected; the launcher runs until you press Ctrl+C. Before reusing a server on the port, the launcher and the canvas ask it who it is, and accept only a direct answer from that port: a server that redirects the question counts as another program.

If another program already uses port 7927, the launcher says so and exits, and the canvas shows the same error. Use another port with `npm start -- --port <n>`, or set `SWARM_DASHBOARD_PORT` for both the launcher and the environment the Copilot app starts with.

## Privacy and data access

Read-only access. The dashboard reads `~/.copilot/data.db` and the session folders, and never writes to them. Costs come from the model-call records (`session.usage_record`) and compactions in each session's `events.jsonl`; a session whose log has no `session.usage_record` events shows only its compaction cost. While a log of a run is missing, its cost is incomplete: the dashboard warns, and never replaces the run's stored summary. It writes run summaries to `~/.copilot/swarm-dashboard/history/`, which keep finished runs in History after logs are cleaned up, and the page keeps its display choices, such as the tab, time span, swarm and theme, in browser storage. SQLite databases are opened read-only. A database in WAL mode that a running Copilot process has open is read only when its `-wal` and `-shm` files already exist. With Node.js's built-in SQLite, it is read through one long-lived read-only connection, whose lock keeps those files in place; with the `sqlite3` command-line tool, each query opens its own read-only connection. A database that nothing has open is read in immutable mode, which never touches side files. If a database's write-ahead log holds data but its shared-memory file is missing, the dashboard skips that read, keeps the last data it read and shows a warning. One narrow case remains: if the last Copilot process finishes closing a database in the few microseconds between the dashboard's check and SQLite's read lock, SQLite creates an empty `-wal` and `-shm` beside it. No data changes, and the next process that opens the database reuses or removes them.

- From `data.db` it reads named columns only.
- The server listens on 127.0.0.1 only, answers only requests addressed to `127.0.0.1` or `localhost` on its port, and serves only GET and HEAD. In current browsers, its data and live-update endpoints also refuse requests that another website starts. The page loads nothing from the internet.
- The only outbound requests the dashboard makes are read-only `gh` and `az` queries for the state of the swarm's pull requests, made with your existing CLI login and cached. `az` runs only when its `azure-devops` extension is already installed; the dashboard never installs it. Both CLIs may still do their own housekeeping when they run: they refresh their sign-in caches, `az` updates its config folder, and after `az` is installed or upgraded it fetches version metadata from GitHub once.

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
| `npm run check:layout` | Check every view, in the light and the dark theme, for overlap, clipped text, type, spacing and contrast at every width, and that live updates leave the page steady, that History refreshes in place when a run finishes or the page reconnects, and that the theme button switches and remembers the theme, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one); `-- --live <url>` checks a running dashboard, and `-- --engine webkit` runs the checks in WebKit (see below) |

### Check the layout in WebKit (optional)

The Copilot app shows the canvas in WebKit, so `npm run check:layout -- --engine webkit` runs the checks in Playwright's WebKit build. A few motion, multi-window and speed checks run only in Chrome, Chromium or Edge, and WebKit skips them. Playwright is not a dependency of this plugin. Install it outside this repository, download its WebKit build once, and point the check at it:

```bash
npm install --prefix <folder outside this repository> playwright-core
node <folder>/node_modules/playwright-core/cli.js install webkit
PLAYWRIGHT_CORE=<folder>/node_modules/playwright-core npm run check:layout -- --engine webkit
```

Without Playwright or its WebKit build the check says so and skips. `npm test` and `npm run validate` never need it.

## Troubleshooting

- "Port 7927 is used by another program" or "… is in use and not answering": see [The port](#the-port).
- "Port 7927 serves the dashboard with sample data": a launcher started with `--demo` holds the port. Stop it with Ctrl+C in its terminal, or start it with `--port <n>`.
- "Disconnected · retrying" in a browser: the page lost its live connection. Usually no dashboard server is running: start the launcher or open the canvas. It also shows when the server already serves its limit of 32 live pages (see the item on pages that never load). In the canvas the page recovers by itself within a few seconds; if it does not, close and reopen the canvas.
- Old behaviour after an update: restart the app, or reload extensions in every session, so that no session still serves the previous version; a dashboard started separately in a browser has to be restarted by whoever started it. `curl -s http://127.0.0.1:7927/api/health` shows the version that serves the port. An open dashboard page reloads itself once when it reconnects to a server with new dashboard files, and keeps its tab, swarm and open panel. A canvas that finds an older dashboard on the port says so in the extension log, and shows an out-of-date notice on the page.
- Pages that never load: browsers allow about six open connections per site, and each open dashboard page holds one. With more than about six dashboard tabs or canvases open at once, the extra pages wait; close the ones you do not need. The server itself serves at most 32 live pages at once. It disconnects a page that stops taking updates for 30 seconds, and that page reconnects by itself.
- "1 data warning" at the top right: some Copilot data could not be read, for example after a Copilot update changed a file format. Session-log and cost warnings apply only to the selected swarm, including its child sessions and older session aliases; engine-wide problems appear on every swarm. Hover over it for details. The rest of the dashboard still works.

## Layout

| Folder | What it holds |
| --- | --- |
| `engine/` | Reads Copilot's local data into swarm snapshots and run summaries |
| `server/` | The local server, live updates, the shared port and the canvas host |
| `ui/` | The dashboard page: plain ES modules and CSS, no build step |
| `docs/images/` | Screenshots for the [dashboard guide](DASHBOARD.md) |
| `com.github.copilot/agents/` | The orchestrator agent and its peon |
| `com.github.copilot/extensions/swarm-dashboard/` | The canvas extension |
| `scripts/` | The launcher, the snapshot command, the layout check and the validator |
| `tests/` | Unit tests and synthetic fixtures |
