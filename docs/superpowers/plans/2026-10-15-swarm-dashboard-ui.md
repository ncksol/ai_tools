# Swarm Dashboard UI and Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the swarm dashboard's local server with live updates, the approved UI (header, Needs you, Cards, activity feed, Timeline, Plan, Board, detail panel, History, run summary and the side-panel layout), the standalone launcher, the canvas extension, an automated layout check, and the plugin and repository docs, on top of the data engine's snapshot contract.

**Architecture:** One plain Node HTTP server (`server/`) serves a no-build ES-module UI (`ui/`) and pushes snapshots over Server-Sent Events. Exactly one server runs per machine, on the fixed loopback port 7927: the first canvas to open hosts it inside its own extension process, the launcher can host it for browsers, and every other canvas reuses it after an identity check and takes it over if its host goes away. The engine inside that server exists only while pages are connected (plus a 5-minute grace period). UI rendering is pure functions from snapshot to HTML string, tested in Node; one thin browser module does the DOM work, patching the page in place on every update. A zero-dependency script drives a locally installed Chrome over the DevTools protocol to check every view for overlap, tokens and contrast.

**Tech Stack:** Node.js >= 18 built-ins only (`node:http`, `node:test`, `node:child_process`, `node:fs`); browser ES modules, CSS container queries and OKLCH colours; the Copilot SDK canvas API (`@github/copilot-sdk/extension`, provided by the host) in the canvas wrapper only; a local Chrome, Chromium or Edge for the layout check only.

**Spec:** `docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md`, with the visual reference `docs/superpowers/specs/assets/2026-10-15-swarm-dashboard-mockup.html`. Executors read the spec's sections 7, 8, 9 and 12 and open the mockup in a browser before any UI task. The data contract is `ghcp/plugins/swarm-dashboard/engine/schema.mjs` (PR 1); the fake engine and example fixtures are `engine/fake-engine.mjs` and `tests/fixtures/example-*.json`.

## Global Constraints

- Work only under `ghcp/plugins/swarm-dashboard/` plus the root `README.md` and `.github/copilot-instructions.md`. PR 1 owns `engine/`, `tests/fixtures/example-*.json`, `tests/helpers/*`, `tests/schema.test.mjs`, `tests/validate-plugin.test.mjs` and its other tests: never edit them. Edits to the shared files `package.json`, `plugin.json` and `scripts/validate-plugin.mjs` stay small and separate from PR 1's lines, because this branch is rebased onto PR 1's later commits.
- Plugin name `swarm-dashboard`, version `0.1.0` in `plugin.json`, `package.json` and the root `.github/plugin/marketplace.json` entry; this PR does not change the version.
- `package.json` keeps `"private": true`, `"type": "module"`, `"engines": {"node": ">=18"}`, `npm test` = `node --test tests/*.test.mjs`, `npm run validate` = `node scripts/validate-plugin.mjs`, and no `dependencies` or `devDependencies` (the validator rejects both). This PR adds only the `start` and `check:layout` scripts.
- No build step and no third-party code. Shipped modules import only `node:` built-ins and relative paths; the one exception is the canvas wrapper's `@github/copilot-sdk/extension`, which the host provides. The page loads nothing from outside its own server.
- Server, launcher, scripts and tests run on Node 18.0+: no `toSorted`, `toReversed`, `toSpliced`, `Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, `Array.fromAsync`, Set methods, `t.after()` or `mock` from `node:test`. The canvas runs on the Copilot CLI's Node v24.20.0.
- Read-only. The server, UI and scripts never write to `~/.copilot/data.db`, `~/.copilot/session-store.db` or anything under `~/.copilot/session-state/`, and write no files except the temporary browser profile the layout check deletes and, only when asked with `--screenshots`, screenshots of the synthetic swarms (`--live` refuses it, so no image of real data is written; the engine's history folder is PR 1's). Code under `server/` never writes to stdout, because it runs inside the canvas extension, whose stdout carries JSON-RPC; only `scripts/*.mjs` print.
- Bind `127.0.0.1` only. Reject requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`. Serve GET and HEAD only. Send nothing off the machine.
- The canvas extension starts no timers and no server until a canvas is opened, and never starts a second engine: one dashboard server, with at most one engine, runs per machine.
- Visual language exactly as spec section 8, with these approved choices: the light palette whatever the host theme; the font family from the host's `--font-sans` with the fallback `system-ui, -apple-system, "Segoe UI", sans-serif` and tabular numbers; sizes and line heights 12/16, 14/20 and 18/24 px; weights 400 and 500; no italic, uppercase or letter-spacing; a 4 px grid; padding 16 px on the dashboard, cards, rail and panels and 12 px on Needs you items, plan nodes and board cards; radius 8/4/2 px; chips 24 px, badges 20 px and buttons 28 px high; bars 4 px (12 px in history charts); rings 40 px with a 4 px stroke; rail 320 px (440 px with the detail panel); card columns at least 296 px, Needs you items 240 px, board columns 160 px; at most 1,920 px wide. Narrow mode below 900 px of dashboard inner width; 3×2 counts and single-column Needs you at 720 px or less. Motion as section 8, all of it stopped under `prefers-reduced-motion`.
- Every view passes `npm run check:layout`: the browser layout at 480, 560, 640, 800, 1024, 1280, 1440, 1600 and 1920 px and the canvas layout at 480, 560 and 640 px, with no overlap, no clipped or spilled text, no horizontal scroll, only approved type and spacing, text contrast of at least 4.5:1 and no console errors.
- The repository is public: every fixture, scenario and screenshot is synthetic. Never commit real session data, logs, database extracts, internal names, people's names, session ids or local user paths.
- After any change under the plugin folder, run `npm test && npm run validate` in `ghcp/plugins/swarm-dashboard`.
- Conventional commit messages; no `Co-authored-by` trailer or other AI attribution.

## Decisions settled before implementation

### 1. How the canvas starts and reaches the shared server

Evidence gathered on this machine on 15 October 2026:

- Extensions run inside the Copilot CLI binary, not the system Node: every extension process is `~/Library/Caches/github-copilot-sdk/cli/1.0.95-3/copilot extension_bootstrap.mjs`. The CLI's `index.js` imports `preloads/extension_bootstrap.mjs` when that name is in its arguments, and the bootstrap imports the module in `EXTENSION_PATH`.
- A throwaway module run through that bootstrap (no `joinSession`, nothing installed) reported Node v24.20.0, a working `node:sqlite`, global `fetch` and `WebSocket`, `import.meta.dirname`, and a loopback server that answered its own `fetch`. The binary also contains the Node v24.20.0 release URL.
- The bootstrap exits within a second of its parent CLI process going away (a parent-PID watch), and the CLI stops extensions on exit with SIGTERM, then SIGKILL after 5 s (`copilot-sdk/docs/extensions.md`). A server inside an extension therefore lives exactly as long as that session's CLI.
- The runtime starts one extension process per session that has the plugin enabled. `open()` receives `{ sessionId, extensionId, canvasId, instanceId, input }` (`CanvasProviderOpenRequest` in the SDK's `generated/rpc.d.ts`) and must return `{ url, title }`; after a reload the runtime calls `open()` again for each open instance (the app's create-canvas skill). The page has no bridge to the host.
- One engine uses about 180–275 MB (the coordinator's measurement), so engines must not multiply with canvases or sessions.
- Pages recover from a server change on the same URL: in headless Chrome 155, a page's `EventSource` stayed in CONNECTING (three retries at 1 s) while nothing listened, then received events from a replacement server on the same port 805 ms after it started.

Decision:

- One dashboard server per machine, on the fixed port (decision 2), shared by every canvas and browser. Pages always use `http://127.0.0.1:7927/`.
- Who starts it: the first canvas `open()` that finds no dashboard on the port binds it inside its own extension process (no child processes), or the user runs the launcher (`npm start`).
- Identity: before anything reuses the port, `GET /api/health` must answer `{ "app": "swarm-dashboard", ... }`; any other listener is never reused, and `open()` then fails with a clear error.
- Reuse: other canvases return the shared URL; their extensions start no server and no engine.
- Takeover: an extension that has at least one open canvas and does not host the server checks `/api/health` every 2 s (plus up to 1 s of jitter). When the port refuses connections, it binds the port itself; its pages and everyone else's reconnect to the same URL. The OS arbitrates races: the loser of a bind gets `EADDRINUSE`, identifies the winner and reuses it.
- The engine inside the server is created when the first page connects or the first API call needs it, polls every 3 s only while a page is connected, and is dropped (stopped and released for garbage collection) 5 minutes after the last page leaves.
- When the server stops: a canvas-hosted server closes its port once its own extension has no open canvas and no page is connected (after that 5-minute grace period), and in any case when its session ends. A launcher-hosted server runs until Ctrl+C, and drops its engine the same way when idle.
- The canvas shows the swarm of the session it was opened in (`engine.findSwarm(ctx.sessionId)`), or the swarm named in its optional `swarm` input, else the default swarm.

### 2. The fixed port and what happens when it is taken

Evidence: the IANA service-name and port registry (CSV downloaded on 15 October 2026) lists 7927 inside an unassigned range; nothing listens on 7927 here (`lsof -iTCP:7927`); macOS hands out ephemeral ports from 49152–65535 (`sysctl net.inet.ip.portrange`), so 7927 is never given to an outgoing connection; it avoids common development ports (3000, 5000, 5173, 8000, 8080, 9222, 9229, 4317).

Decision: port 7927, overridable with `SWARM_DASHBOARD_PORT` (read by the launcher and the canvas) and the launcher's `--port`.

- Launcher: it probes `/api/health` first (macOS lets a loopback bind succeed beside a program that holds the port on every address), then binds, and on `EADDRINUSE` probes again. If the dashboard answers, it prints `The swarm dashboard is already running at http://127.0.0.1:7927/` and exits 0. If another program holds the port, it prints `Port 7927 is used by another program. Start with --port <n> or set SWARM_DASHBOARD_PORT.` and exits 1. If the holder accepts connections but does not answer within 2.5 s three times, it says the port `is in use and not answering` and exits 1. It never falls back to a random port, because pages and bookmarks rely on the fixed URL.
- Canvas: the same bind-then-identify step. If another program holds the port, `open()` throws `CanvasError('port_in_use', ...)` with the same advice.

### 3. How the layout check runs headless without dependencies

Evidence: `scripts/validate-plugin.mjs` rejects any `dependencies` or `devDependencies`, which rules out Playwright or Puppeteer packages. A prototype drove the installed Google Chrome 155 headless over the DevTools protocol on a pipe (`--remote-debugging-pipe`, file descriptors 3 and 4) using only `node:child_process`: it loaded the mockup at 480, 1280 and 1920 px and measured element boxes (0 overlaps) in 3.6 s, and a second run captured screenshots of every mockup view. The pipe needs no WebSocket, so it also works on Node 18. Microsoft Edge 155 and Playwright's cached Chromium are also present on this machine.

Decision: `npm run check:layout` is a separate command, not part of `npm test`. It needs a locally installed Chrome, Chromium or Edge (found automatically, or set `CHROME_PATH`) and no npm package. It first proves its own rules on a deliberately broken page, then serves two synthetic scenarios (the example swarm and a stress swarm) with the demo engine in-process and checks every view at the nine widths in the browser layout and at 480, 560 and 640 px in the canvas layout.

Limit: the app renders canvases in WKWebView (the app is built on Tauri: its binary links `WebKit.framework` and has no Electron framework), so the Chrome check approximates WebKit. The CSS avoids Chrome-only features, and an in-app look is a manual check.

### 4. Contract additions and UI choices approved by the coordinator

- From PR 1 (`0ddae04`): `FeedItem.id` and `NeedItem.id` (opaque, unique within each list, the same for the same item everywhere) key animations; `SessionView.recent` (up to 6, latest first, possibly empty) feeds the detail panel's Recent activity; `findSwarm(sessionId): Promise<string|null>` picks the canvas's swarm; `endedAt` is the outcome time for units with an outcome. Until PR 1's real engine lands, `unitEnd()` keeps a fallback to the PR's merge or close time; Task 20 removes it.
- `getSnapshot()` without an id returns the most recently active live swarm, else the most recently active swarm, else null. When the page did not ask for a specific swarm and the snapshot is finished, Live shows an empty state that links to that run's summary.
- a. A `progress` report badge in busy ink on a 12% tint, labelled "progress".
- b. With two or more live swarms, a small select in the top bar beside Live/History; the choice is remembered. (After the final review: a picked or remembered swarm applies only while it is live, and the picker also appears when the page shows a swarm that has ended while another is live. See Final review fixes.)
- c. A stalled swarm (`run.stalled`) is the first Needs you item, in stuck colours, naming the rule that fired and how long it has been stalled.
- d. The light palette whatever the host theme; fonts from the host's `--font-sans`, with fallbacks.
- e. Warn-level diagnostics: a muted "1 data warning" at the top right, with details on hover.
- f. In the canvas the dashboard fills the panel edge to edge; in a browser it keeps the mockup's framed look.
- g. States the mockup does not show: loading ("Reading Copilot data…"), "Disconnected · retrying", empty Live and History, "Nothing waiting", "No task list" in a card's progress row (bar hidden, row kept so cards align), "No report yet", "No recent activity", and a "+N" chip when sub-agent chips do not fit.

Builder choices within the design, listed for review: card state lines by `statusDetail` (Task 2, `STATE_LINES`; for example "Stuck · no events 48m", "Stuck · no model reply 12m", "Spinning · 9m", "Blocked on orchestrator · 5m", "Crashed · 2h ago"); the timeline, plan and board state words copied from the mockup; ring labels show the first three characters with the full label as a tooltip; the detail panel lists at most 12 sub-agents and says how many more there are; the run summary adds "First child" (time from the run's start to its first child session), which spec call 12 asks for.

### 5. Decisions at the go-ahead

The coordinator's go-ahead (after PR 1 finished at `bf255ab`) added these; the tasks below already include them.

- The branch is rebased onto PR 1's finished branch, and Task 20 (the real engine) runs straight after Task 11, so the early preview shows real data (see Execution order).
- A unit whose PR closed without merging, and that is not archived, stays in the PR open stage and Board column with a "closed, not merged" badge in the blocked colour; its monitor shows "ended" (Tasks 2, 4, 5, 8, 13). PR 1's engine already keeps such a unit in `pr_open` and ends its monitor.
- Ring labels: a 4-character label (such as `C6-1`) shows whole when it fits inside the ring at 12 px, otherwise it is cut to 3 characters without a trailing separator; longer labels are cut the same way. The label is an HTML span over the ring so the layout check sees it, and the stress scenario has `C6-1` (fits) and `MM-1` (does not) (Tasks 3, 6, 8, 10).
- `getSnapshot()` of the real engine returns its cached object: nothing may change a snapshot, and the tests prove it with deep-frozen snapshots (Tasks 2, 7, 9, 12, 13). While a swarm is live, updates arrive about every 3 s with snapshots of about 437 KB, so the page patches the DOM in place (`ui/morph.mjs`): updates do not restart animations, reset clocks or the scroll position, or flash items that did not change. The page measures every update, and the layout check fails when updates re-create cards, re-highlight items, move the scroll position or put busy rings out of phase, and reports the update times on the demo and, with `--live`, on real data (Tasks 10, 16, 21).
- The in-app check uses a session-scoped extension in the controller's own session; nothing is installed in `~/.copilot/extensions`. If a session-scoped extension cannot provide the canvas, stop and ask the coordinator: a user-level install needs the owner's approval (Task 17).
- The early preview runs detached on 127.0.0.1:7927 and stays up until the coordinator says to stop it (Task 20).
- Sub-agents run as the orchestrator-worker agent, which has no task or session tools, and every prompt carries the safety clause.

## Execution order

Run the tasks in this order: 1–11, 20, 12–19, 21. Task 20 switches the server to PR 1's engine as soon as the launcher exists (Task 11) and ends with the early preview on real data; Task 21 does the real-data smoke check with `--live` once the layout check exists. Force-pushing this feature branch with `--force-with-lease` is approved until its pull request opens; after that, ask the coordinator.

## File Structure

All paths are under `ghcp/plugins/swarm-dashboard/` unless they start with `docs/`, `.github/` or `README.md`.

| File | Responsibility |
| --- | --- |
| `ui/format.mjs` | Pure formatting: escaping, durations, credits and dollars, dates, live time spans |
| `ui/model.mjs` | Pure derivations from a snapshot: orders, labels, state words, needs, plan forest and layout, board columns |
| `ui/parts.mjs` | Shared HTML parts: ring, state line, stage track, badge, bars, monitor text, chips, feed list |
| `ui/live.mjs` | Header, Needs you, Cards, activity rail and tab, detail panel |
| `ui/timeline.mjs` | Timeline rows and the lane, axis and cost SVGs |
| `ui/plan.mjs` | Plan graph and indented list, Board |
| `ui/history.mjs` | Finished runs list and run summary |
| `ui/app.mjs` | Page composition: top bar, Live body (wide and narrow), History pages, empty and loading states |
| `ui/morph.mjs` | Patch the DOM in place from new HTML, keeping the nodes that stay |
| `ui/main.mjs` | Browser glue: SSE, state, events, resizing, ticking clocks, animations, chip and ring-label fitting, update timing |
| `ui/styles.css` | Tokens and component styles from the mockup |
| `ui/index.html` | Page shell |
| `server/assets.mjs` | The fixed set of UI files the server may serve |
| `server/hub.mjs` | SSE connections and the engine's lifetime |
| `server/http.mjs` | `createDashboardServer`: routes, Host check, security headers, API, static files |
| `server/shared.mjs` | Port 7927, `SWARM_DASHBOARD_PORT`, identity probe, bind-or-reuse |
| `server/demo-engine.mjs` | Synthetic engine: fixtures moved to the present, optional simulated activity |
| `server/demo-scenarios.mjs` | The stress scenario for layout checks |
| `server/engines.mjs` | `createDefaultEngine`: the one-line switch to PR 1's engine |
| `server/canvas-host.mjs` | Canvas side of the shared server: reuse, hosting, takeover |
| `com.github.copilot/extensions/swarm-dashboard/extension.mjs` | Canvas wrapper: `joinSession` with one canvas |
| `com.github.copilot/extensions/swarm-dashboard/copilot-extension.json` | Extension marker `{ "name": "swarm-dashboard", "version": 1 }` |
| `scripts/swarm-dashboard.mjs` | Standalone launcher (`npm start`) |
| `scripts/check-layout.mjs` | Layout check runner (`npm run check:layout`) |
| `scripts/lib/cdp.mjs` | Find a local Chromium browser; DevTools protocol over a pipe |
| `scripts/lib/page-audit.mjs` | Colour maths and the in-page audit |
| `plugin.json`, `package.json`, `scripts/validate-plugin.mjs` | Canvas packaging fields, two scripts, canvas and UI file checks |
| `scripts/lib/validate-dashboard.mjs` | The dashboard's own validation: canvas packaging fields, required files, the two commands |
| `README.md` (plugin), root `README.md`, `.github/copilot-instructions.md` | Docs |
| `tests/helpers/ui.mjs` | Fixture loading and render contexts for UI tests |
| `tests/ui-*.test.mjs`, `tests/demo-engine.test.mjs`, `tests/server.test.mjs`, `tests/shared.test.mjs`, `tests/launcher.test.mjs`, `tests/canvas.test.mjs`, `tests/page-audit.test.mjs`, `tests/packaging.test.mjs` | Tests for this PR |
| `tests/fixtures/layout-good.html`, `tests/fixtures/layout-bad.html` | Synthetic pages for the layout check's self-test |

The early preview comes at the end of Task 20, right after Task 11 (see Execution order).

---

### Task 1: Formatting helpers

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/format.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-format.test.mjs`

**Interfaces:**
- Consumes: `CREDIT_USD` from `engine/schema.mjs` (test only).
- Produces: `MIN`, `HOUR`, `DAY`, `CREDIT_USD`; `esc(value): string`; `dur(ms, format = 'short'): string` with formats `'short' | 'clock' | 'age' | 'hm'`; `tickText(at, format, now): string` (format `'left'` counts down); `liveTime(at, now, format = 'short'): string` (a `<span data-t data-f>` that `ui/main.mjs` refreshes every second); `elapsed(at, now)`, `ago(at, now)`, `countdown(at, now)`; `count(n)`, `credits(n)`, `usd(n)`, `usdRounded(n)`, `costText(n)`, `costHtml(n, total = false)`; `dateTime(ms)`, `dateRange(start, end)`; `plural(n, one, many)`.

- [ ] **Step 1: Write the failing test**

`tests/ui-format.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_USD as ENGINE_CREDIT_USD } from '../engine/schema.mjs';
import {
  CREDIT_USD, DAY, HOUR, MIN, ago, costHtml, costText, countdown, credits, dateRange, dateTime, dur, elapsed, esc, liveTime,
  plural, tickText, usd, usdRounded,
} from '../ui/format.mjs';

const span = (days, hours, minutes, seconds = 0) => ((days * 24 + hours) * 60 + minutes) * MIN + seconds * 1000;

test('esc escapes markup for text and attribute values', () => {
  assert.equal(esc('<b title="x">Tom & Jerry\'s</b>'), '&lt;b title=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('dur matches the mockup formats', () => {
  assert.equal(dur(span(2, 23, 12, 1), 'clock'), '2d 23h 12m 01s');
  assert.equal(dur(span(0, 9, 5, 1), 'clock'), '9h 05m 01s');
  assert.equal(dur(span(0, 0, 12, 4), 'clock'), '12m 04s');
  assert.equal(dur(span(1, 4, 0), 'age'), '1d 4h ago');
  assert.equal(dur(span(0, 5, 59), 'age'), '5h ago');
  assert.equal(dur(40 * 1000, 'age'), 'just now');
  assert.equal(dur(50 * 1000, 'age'), '1m ago');
  assert.equal(dur(span(3, 0, 10), 'hm'), '72h 10m');
  assert.equal(dur(span(1, 17, 40)), '1d 17h');
  assert.equal(dur(span(0, 5, 0)), '5h 00m');
  assert.equal(dur(span(0, 0, 48, 30)), '48m');
  assert.equal(dur(23 * 1000), '23s');
  assert.equal(dur(-5000), '0s');
});

test('live times carry their start and format so the page can tick them', () => {
  assert.equal(liveTime(1000, 1000 + 35 * MIN), '<span data-t="1000" data-f="short">35m</span>');
  assert.equal(elapsed(0, 2 * HOUR), '<span data-t="0" data-f="short">2h 00m</span>');
  assert.equal(ago(0, 2 * HOUR), '<span data-t="0" data-f="age">2h ago</span>');
  assert.equal(countdown(10 * MIN, 9 * MIN), '<span data-t="600000" data-f="left">1m</span>');
  assert.equal(tickText(10 * MIN, 'left', 9 * MIN + 37 * 1000), '23s');
  assert.equal(tickText(0, 'clock', 61 * 1000), '1m 01s');
});

test('cost shows credits with the list-price dollar estimate', () => {
  assert.equal(CREDIT_USD, ENGINE_CREDIT_USD);
  assert.equal(credits(24016), '24,016 cr');
  assert.equal(credits(97652.4), '97,652 cr');
  assert.equal(credits(0.4), '0.4 cr');
  assert.equal(credits(0), '0 cr');
  assert.equal(usd(9702), '≈$97.02');
  assert.equal(usdRounded(102510), '≈$1,025');
  assert.equal(costText(3058), '3,058 cr · ≈$30.58');
  assert.equal(costHtml(9702), '9,702 cr<span class="usd"> · ≈$97.02</span>');
  assert.equal(costHtml(102510, true), '102,510 cr<span class="usd"> · ≈$1,025</span>');
});

test('dates use local time in the mockup format', () => {
  const start = new Date(2026, 9, 8, 9, 12).getTime();
  assert.equal(dateTime(start), '8 Oct 09:12');
  assert.equal(dateRange(start, start + 3 * DAY + 10 * MIN), '8 Oct 09:12 to 11 Oct 09:22');
  assert.equal(dateRange(start, null), 'from 8 Oct 09:12');
  assert.equal(plural(1, 'run'), '1 run');
  assert.equal(plural(16, 'child', 'children'), '16 children');
  assert.equal(plural(1240, 'sub-agent'), '1,240 sub-agents');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-format.test.mjs`
Expected: FAIL with `Cannot find module '.../ui/format.mjs'`.

- [ ] **Step 3: Write `ui/format.mjs`**

```js
/** Pure formatting helpers for the views. No DOM access: Node tests import this module. */
export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
/** Dollars per AI credit at list price; equal to CREDIT_USD in engine/schema.mjs. */
export const CREDIT_USD = 0.01;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NUMBER = new Intl.NumberFormat('en-US');
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = value => String(value).padStart(2, '0');

/** Escape text for HTML text and attribute values. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);
}

/**
 * Format a duration. 'short': 2d 4h, 3h 05m, 12m, 40s. 'clock': 1d 02h 03m 04s, 3h 05m 01s, 12m 04s.
 * 'age': just now, 12m ago, 3h ago, 1d 4h ago. 'hm': 72h 10m.
 */
export function dur(ms, format = 'short') {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (format === 'clock') return d ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s` : h ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
  if (format === 'age') return total < 45 ? 'just now' : d ? `${d}d ${h}h ago` : h ? `${h}h ago` : `${Math.max(1, m)}m ago`;
  if (format === 'hm') return `${Math.floor(total / 3600)}h ${pad(m)}m`;
  return d ? `${d}d ${h}h` : h ? `${h}h ${pad(m)}m` : m ? `${m}m` : `${s}s`;
}

/** Text of a live time: 'left' counts down to `at`; every other format measures the time since `at`. */
export function tickText(at, format, now) {
  return format === 'left' ? dur(at - now, 'short') : dur(now - at, format);
}

/** A time span that ui/main.mjs refreshes every second. */
export function liveTime(at, now, format = 'short') {
  return `<span data-t="${at}" data-f="${format}">${tickText(at, format, now)}</span>`;
}
export const elapsed = (at, now) => liveTime(at, now, 'short');
export const ago = (at, now) => liveTime(at, now, 'age');
export const countdown = (at, now) => liveTime(at, now, 'left');

export const count = value => NUMBER.format(value);
export const credits = value => `${value >= 10 || value === 0 ? NUMBER.format(Math.round(value)) : ONE_DECIMAL.format(value)} cr`;
export const usd = value => `≈$${CENTS.format(value * CREDIT_USD)}`;
export const usdRounded = value => `≈$${NUMBER.format(Math.round(value * CREDIT_USD))}`;
export const costText = value => `${credits(value)} · ${usd(value)}`;
/** Credits, then dollars in a smaller muted span; totals round the dollars to whole numbers. */
export const costHtml = (value, total = false) => `${credits(value)}<span class="usd"> · ${total ? usdRounded(value) : usd(value)}</span>`;

/** Local date and time, for example "8 Oct 09:12". */
export function dateTime(ms) {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const dateRange = (start, end) => (end == null ? `from ${dateTime(start)}` : `${dateTime(start)} to ${dateTime(end)}`);
export const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-format.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/format.mjs ghcp/plugins/swarm-dashboard/tests/ui-format.test.mjs
git commit -m "feat(swarm-dashboard): add UI formatting helpers"
```

### Task 2: Snapshot view model

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/model.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/ui.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-model.test.mjs`

**Interfaces:**
- Consumes: nothing at runtime (pure data); tests read `tests/fixtures/example-snapshot.json`.
- Produces (`ui/model.mjs`): constants `STATUS_ORDER`, `UNIT_STAGES` (`['coding','pr_open','in_review','merged','archived']`), `BOARD_STAGES` (`['planned', ...UNIT_STAGES]`), `STAGE_NAMES`, `STAGE_CLASS` (`pr_open → 'pr'`, `in_review → 'review'`), `REPORT_LABELS`, `REPORT_CLASS` (`needs_input → 'needs'`), `NEED_LABELS`, `NEED_CLASS`, `COUNT_TILES`, `STATE_LINES`, `TIMELINE_WORDS`, `PLAN_WORDS`, `BOARD_WORDS` (word templates: `{t}` = time in state, `{a}` = age); functions `unitEnd(session): number|null`, `closedNotMerged(unit): boolean` (its PR closed without merging and it is not archived; it stays in its PR stage and Board column with a "closed, not merged" badge in the blocked colour), `stateLine(session): string`, `cardUnits(snapshot): UnitView[]`, `archivedUnits(snapshot)`, `findUnit(snapshot, id)`, `findByLabel(snapshot, label)`, `findPlanned(snapshot, label)`, `progressPercent(session): number|null`, `sharePercent(value, max): number`, `needItems(snapshot): {id, kind, text, since, from, verb}[]`, `planForest(snapshot): PlanNode[]`, `planLayout(roots): {pos: Map<PlanNode,{depth,row}>, rows, maxDepth}`, `flattenPlan(roots): {node, depth}[]`, `boardColumns(snapshot): {stage, nodes}[]`. A `PlanNode` is `{ key, label, name, stage, status, dependsOn, unit, planned, children }` (`unit` or `planned` is set; `status` is `'planned'` for planned entries). A board node is `{ stage, status, unit, planned }`.
- Produces (`tests/helpers/ui.mjs`): `fixture(name)`, `exampleSnapshot()` (a fresh copy each call), `NOW` (the example's `generatedAt`), `context(snapshot, overrides = {}): RenderContext` with `{ snapshot, now: NOW, phaseMs: 0, detail: null, fresh: { feed: Set, reports: Set, chips: Set } }`; `deepFreeze(value)` (the real engine's `getSnapshot()` returns its cached object, so tests freeze snapshots to prove nothing changes them); `closedSnapshot()` (the example with D5's PR closed without merging, as the engine reports it: stage `pr_open`, `closedWithoutMerge`, outcome `closed`, monitor `ended`).

- [ ] **Step 1: Write the test helper**

`tests/helpers/ui.mjs`:

```js
import { readFileSync } from 'node:fs';

export const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const EXAMPLE = fixture('example-snapshot.json');
export const NOW = EXAMPLE.generatedAt;
export const exampleSnapshot = () => structuredClone(EXAMPLE);
export function context(snapshot, overrides = {}) {
  return { snapshot, now: NOW, phaseMs: 0, detail: null, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides };
}

/** Freeze a value and everything in it, so any code that changes it throws (ES modules run in strict mode). */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The example with D5's PR closed without merging and D5 not archived, as the engine reports it. */
export function closedSnapshot() {
  const snapshot = exampleSnapshot();
  const unit = snapshot.units.find(item => item.label === 'D5');
  const closedAt = NOW - 20 * 60000;
  Object.assign(unit, { stage: 'pr_open', closedWithoutMerge: true, outcome: 'closed', endedAt: closedAt });
  unit.pr = { ...unit.pr, state: 'closed', closedAt };
  unit.monitor = { ...unit.monitor, state: 'ended', nextCheckAt: null, since: null };
  return snapshot;
}
```

- [ ] **Step 2: Write the failing test**

`tests/ui-model.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_STAGES, STATE_LINES, archivedUnits, boardColumns, cardUnits, closedNotMerged, findByLabel, findPlanned, flattenPlan, needItems,
  planForest, planLayout, progressPercent, sharePercent, stateLine, unitEnd,
} from '../ui/model.mjs';
import { closedSnapshot, exampleSnapshot } from './helpers/ui.mjs';

const labels = units => units.map(unit => unit.label);

test('cards sort stuck, question, plan, blocked, busy, idle, merged and hide archived units', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(labels(cardUnits(snapshot)), ['I1', 'B2', 'F1', 'B1', 'D5', 'F2a']);
  assert.deepEqual(labels(archivedUnits(snapshot)), ['B0']);
});

test('a unit whose PR closed without merging is marked until it is archived', () => {
  const d5 = findByLabel(closedSnapshot(), 'D5');
  assert.equal(closedNotMerged(d5), true);
  assert.equal(d5.stage, 'pr_open');
  assert.equal(closedNotMerged({ ...d5, stage: 'archived' }), false);
  assert.equal(closedNotMerged({ ...d5, outcome: 'failed', pr: { ...d5.pr, state: 'open' } }), false);
  assert.equal(closedNotMerged(findByLabel(exampleSnapshot(), 'F2a')), false);
});

test('a unit ends at endedAt, else at its PR outcome when it has one', () => {
  const snapshot = exampleSnapshot();
  const f2a = findByLabel(snapshot, 'f2a');
  assert.equal(unitEnd(f2a), f2a.endedAt);
  assert.equal(unitEnd({ ...f2a, endedAt: null }), f2a.pr.mergedAt);
  assert.equal(unitEnd({ ...f2a, endedAt: null, outcome: null }), null);
  assert.equal(unitEnd(findByLabel(snapshot, 'B1')), null);
});

test('state lines follow statusDetail and fall back to status', () => {
  const snapshot = exampleSnapshot();
  assert.equal(stateLine(findByLabel(snapshot, 'I1')), 'Stuck · no events {t}');
  assert.equal(stateLine(findByLabel(snapshot, 'F1')), 'Blocked on orchestrator · {t}');
  assert.equal(stateLine(findByLabel(snapshot, 'F2a')), 'Merged · {a}');
  assert.equal(stateLine({ status: 'idle', statusDetail: 'something_new' }), STATE_LINES.idle);
});

test('progress and cost shares are whole percentages', () => {
  const snapshot = exampleSnapshot();
  assert.equal(progressPercent(findByLabel(snapshot, 'B1')), 70);
  assert.equal(progressPercent({ progress: null }), null);
  assert.equal(progressPercent({ progress: { done: 0, total: 0 } }), null);
  assert.equal(sharePercent(snapshot.cost.maxUnitCredits, snapshot.cost.maxUnitCredits), 100);
  assert.equal(sharePercent(9702, 24016), 40);
  assert.equal(sharePercent(5, 0), 0);
});

test('needs keep the engine order and name their units; a stalled swarm comes first', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(needItems(snapshot).map(item => [item.kind, item.from, item.verb]), [['plan', 'B2 import', 'waiting'], ['pr', 'D5 docs', 'waiting']]);
  snapshot.needs[0].unitIds = [];
  snapshot.run.stalled = { since: snapshot.generatedAt - 600000, reason: 'Swarm rule: the orchestrator and every open child are idle and no monitor is due.' };
  const items = needItems(snapshot);
  assert.deepEqual(items.map(item => [item.kind, item.from, item.verb]), [['stalled', 'Sample story B', 'stalled'], ['plan', 'Sample story B', 'waiting'], ['pr', 'D5 docs', 'waiting']]);
  assert.equal(items[0].text, snapshot.run.stalled.reason);
});

test('the plan forest stacks units and planned entries on their parents, case-insensitively', () => {
  const snapshot = exampleSnapshot();
  snapshot.planned[1].dependsOn = 'i1';
  const roots = planForest(snapshot);
  assert.deepEqual(labels(roots), ['B0']);
  const tree = node => [node.label, node.children.map(tree)];
  assert.deepEqual(tree(roots[0]), ['B0', [['F2a', []], ['B1', [['I1', [['I2', []]]], ['F1', []], ['B3', []]]], ['D5', []], ['B2', []]]]);
  assert.equal(findPlanned(snapshot, 'b3').canStart, true);
  assert.deepEqual(flattenPlan(roots).map(({ node, depth }) => `${node.label}:${depth}`), ['B0:0', 'F2a:1', 'B1:1', 'I1:2', 'I2:3', 'F1:2', 'B3:2', 'D5:1', 'B2:1']);
});

test('the plan layout gives leaves their own rows and centres parents on their children', () => {
  const roots = planForest(exampleSnapshot());
  const { pos, rows, maxDepth } = planLayout(roots);
  const at = label => [...pos].find(([node]) => node.label === label)[1];
  assert.equal(rows, 6);
  assert.equal(maxDepth, 3);
  assert.deepEqual(at('F2a'), { depth: 1, row: 0 });
  assert.deepEqual(at('I1'), { depth: 2, row: 1 });
  assert.deepEqual(at('B1'), { depth: 1, row: 2 });
  assert.deepEqual(at('B0'), { depth: 0, row: 2.75 });
});

test('dependency cycles and unknown parents become roots instead of vanishing', () => {
  const snapshot = exampleSnapshot();
  snapshot.planned = [
    { label: 'X1', name: 'first', dependsOn: 'X2', canStart: false, waitsOn: 'X2', todoId: null },
    { label: 'X2', name: 'second', dependsOn: 'X1', canStart: false, waitsOn: 'X1', todoId: null },
    { label: 'X3', name: 'orphan', dependsOn: 'nowhere', canStart: false, waitsOn: null, todoId: null },
  ];
  const all = flattenPlan(planForest(snapshot)).map(({ node }) => node.label);
  for (const label of ['X1', 'X2', 'X3']) assert.ok(all.includes(label), label);
  assert.equal(all.length, snapshot.units.length + 3);
});

test('the board has one column per stage, attention first', () => {
  const columns = boardColumns(exampleSnapshot());
  assert.deepEqual(columns.map(column => column.stage), BOARD_STAGES);
  const at = stage => columns.find(column => column.stage === stage).nodes.map(node => (node.unit ?? node.planned).label);
  assert.deepEqual(at('planned'), ['B3', 'I2']);
  assert.deepEqual(at('coding'), ['I1', 'B2', 'F1']);
  assert.deepEqual(at('pr_open'), ['D5']);
  assert.deepEqual(at('in_review'), ['B1']);
  assert.deepEqual(at('merged'), ['F2a']);
  assert.deepEqual(at('archived'), ['B0']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-model.test.mjs`
Expected: FAIL with `Cannot find module '.../ui/model.mjs'`.

- [ ] **Step 4: Write `ui/model.mjs`**

```js
/** Data derivations for the views: no HTML and no DOM. Words and orders follow the approved mockup. */
export const STATUS_ORDER = Object.freeze({ stuck: 0, question: 1, plan: 2, blocked: 3, busy: 4, idle: 5, merged: 6, archived: 7 });
export const UNIT_STAGES = Object.freeze(['coding', 'pr_open', 'in_review', 'merged', 'archived']);
export const BOARD_STAGES = Object.freeze(['planned', ...UNIT_STAGES]);
export const STAGE_NAMES = Object.freeze({ planned: 'Planned', coding: 'Coding', pr_open: 'PR open', in_review: 'In review', merged: 'Merged', archived: 'Archived' });
export const STAGE_CLASS = Object.freeze({ planned: 'planned', coding: 'coding', pr_open: 'pr', in_review: 'review', merged: 'merged', archived: 'archived' });
export const REPORT_LABELS = Object.freeze({ complete: 'complete', progress: 'progress', needs_input: 'needs input', blocked: 'blocked' });
export const REPORT_CLASS = Object.freeze({ complete: 'complete', progress: 'progress', needs_input: 'needs', blocked: 'blocked' });
export const NEED_LABELS = Object.freeze({ stalled: 'Swarm stalled', question: 'Question', plan: 'Plan to approve', pr: 'PR to approve' });
export const NEED_CLASS = Object.freeze({ stalled: 'stuck', question: 'question', plan: 'plan', pr: 'pr' });
/** Header tiles: the count bucket and the state colour of its dot. */
export const COUNT_TILES = Object.freeze([['working', 'busy'], ['stuck', 'stuck'], ['waiting', 'plan'], ['idle', 'idle'], ['done', 'merged'], ['failed', 'blocked']]);

/** Card and detail state lines by statusDetail, falling back to status. {t}: time in this state. {a}: age of the change. */
export const STATE_LINES = Object.freeze({
  busy: 'Busy · {t}',
  slow_model_call: 'Slow model call · {t}',
  silent: 'Stuck · no events {t}',
  stuck_tool: 'Stuck · no events {t}',
  stuck_model_call: 'Stuck · no model reply {t}',
  stuck_subagent: 'Stuck · sub-agent silent {t}',
  spinning: 'Spinning · {t}',
  stalled: 'Stalled · {t}',
  stuck: 'Stuck · no events {t}',
  waiting_question: 'Waiting on question · {t}',
  question: 'Waiting on question · {t}',
  waiting_plan: 'Waiting on plan · {t}',
  plan: 'Waiting on plan · {t}',
  blocked: 'Blocked · {t}',
  blocked_on_orchestrator: 'Blocked on orchestrator · {t}',
  crashed: 'Crashed · {a}',
  failed: 'Failed · {a}',
  idle: 'Idle · {t}',
  stopped: 'Stopped · {a}',
  merged: 'Merged · {a}',
  archived: 'Archived · {a}',
});
/** Shorter words from the mockup, by status: timeline summary column, plan nodes, board cards. */
export const TIMELINE_WORDS = Object.freeze({ stuck: 'stuck {t}', plan: 'waiting on plan {t}', question: 'question {t}', blocked: 'blocked {t}', idle: 'idle {t}', merged: 'merged', archived: 'archived' });
export const PLAN_WORDS = Object.freeze({ busy: 'busy', idle: 'idle', plan: 'plan waiting', question: 'question', stuck: 'stuck {t}', blocked: 'blocked' });
export const BOARD_WORDS = Object.freeze({ busy: 'busy', idle: 'idle {t}', plan: 'plan waiting {t}', question: 'question {t}', stuck: 'stuck {t}', blocked: 'blocked', merged: 'merged {a}', archived: 'archived {a}' });

/**
 * When a unit's work ended (null while it runs). The contract's endedAt already uses the outcome time; the PR fallback
 * covers engines built before that rule and goes once PR 1's engine is in (Task 20).
 */
export function unitEnd(session) {
  if (session.endedAt != null) return session.endedAt;
  if (!session.outcome) return null;
  return session.pr?.mergedAt ?? session.pr?.closedAt ?? null;
}

/** Its PR closed without merging and it is not archived: it stays in its PR stage, with a badge (approved decision 5). */
export const closedNotMerged = unit => Boolean(unit.closedWithoutMerge && unit.pr && unit.stage !== 'archived' && (unit.pr.state === 'closed' || unit.outcome === 'closed'));

export const stateLine = session => STATE_LINES[session.statusDetail] ?? STATE_LINES[session.status] ?? '{t}';

/** Units shown as cards: attention first, then creation order; archived units leave the Cards tab. */
export function cardUnits(snapshot) {
  return snapshot.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.status !== 'archived')
    .sort((a, b) => STATUS_ORDER[a.unit.status] - STATUS_ORDER[b.unit.status] || a.index - b.index)
    .map(({ unit }) => unit);
}
export const archivedUnits = snapshot => snapshot.units.filter(unit => unit.status === 'archived');
export const findUnit = (snapshot, id) => snapshot.units.find(unit => unit.id === id) ?? null;
const sameLabel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const findByLabel = (snapshot, label) => snapshot.units.find(unit => sameLabel(unit.label, label)) ?? null;
export const findPlanned = (snapshot, label) => snapshot.planned.find(entry => sameLabel(entry.label, label)) ?? null;

export function progressPercent(session) {
  const progress = session.progress;
  return progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
}
export const sharePercent = (value, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0);

/** Needs you items: a stalled swarm first, then the engine's items, which come longest wait first. */
export function needItems(snapshot) {
  const items = snapshot.needs.map(need => ({ id: need.id, kind: need.kind, text: need.text, since: need.since, from: needFrom(snapshot, need), verb: 'waiting' }));
  const stalled = snapshot.run.stalled;
  if (stalled) items.unshift({ id: `stalled:${stalled.since}`, kind: 'stalled', text: stalled.reason, since: stalled.since, from: snapshot.run.name, verb: 'stalled' });
  return items;
}
function needFrom(snapshot, need) {
  if (!need.unitIds.length) return snapshot.run.name;
  return need.unitIds.map((id, index) => {
    const session = findUnit(snapshot, id) ?? (snapshot.orchestrator.id === id ? snapshot.orchestrator : null);
    return session ? `${session.label} ${session.name}` : need.labels[index] ?? id;
  }).join(', ');
}

/** Units and planned entries as a forest of stacked branches. A cycle or an unknown parent makes a node a root. */
export function planForest(snapshot) {
  const nodes = [
    ...snapshot.units.map(unit => ({ key: unit.label.toLowerCase(), label: unit.label, name: unit.name, stage: unit.stage, status: unit.status, dependsOn: unit.dependsOn, unit, planned: null, children: [] })),
    ...snapshot.planned.map(entry => ({ key: entry.label.toLowerCase(), label: entry.label, name: entry.name, stage: 'planned', status: 'planned', dependsOn: entry.dependsOn, unit: null, planned: entry, children: [] })),
  ];
  const byKey = new Map();
  for (const node of nodes) if (!byKey.has(node.key)) byKey.set(node.key, node);
  const parentOf = new Map();
  for (const node of nodes) {
    const parent = node.dependsOn ? byKey.get(node.dependsOn.toLowerCase()) : undefined;
    parentOf.set(node, parent && parent !== node ? parent : null);
  }
  for (const node of nodes) {
    const seen = new Set([node]);
    for (let parent = parentOf.get(node); parent; parent = parentOf.get(parent)) {
      if (parent === node) {
        parentOf.set(node, null);
        break;
      }
      if (seen.has(parent)) break;
      seen.add(parent);
    }
  }
  const roots = [];
  for (const node of nodes) {
    const parent = parentOf.get(node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Grid positions: depth is the column; leaves take rows in order and a parent sits at its children's mean row. */
export function planLayout(roots) {
  const pos = new Map();
  let leaf = 0;
  let maxDepth = 0;
  const walk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children) walk(child, depth + 1);
    const row = node.children.length ? node.children.reduce((sum, child) => sum + pos.get(child).row, 0) / node.children.length : leaf++;
    pos.set(node, { depth, row });
  };
  for (const root of roots) walk(root, 0);
  return { pos, rows: leaf, maxDepth };
}

/** Depth-first rows for the indented plan list. */
export function flattenPlan(roots) {
  const rows = [];
  const walk = (node, depth) => {
    rows.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

export function boardColumns(snapshot) {
  const nodes = [
    ...snapshot.units.map(unit => ({ stage: unit.stage, status: unit.status, unit, planned: null })),
    ...snapshot.planned.map(entry => ({ stage: 'planned', status: 'planned', unit: null, planned: entry })),
  ];
  return BOARD_STAGES.map(stage => ({
    stage,
    nodes: nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.stage === stage)
      .sort((a, b) => (STATUS_ORDER[a.node.status] ?? 9) - (STATUS_ORDER[b.node.status] ?? 9) || a.index - b.index)
      .map(({ node }) => node),
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-model.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/model.mjs ghcp/plugins/swarm-dashboard/tests/helpers/ui.mjs ghcp/plugins/swarm-dashboard/tests/ui-model.test.mjs
git commit -m "feat(swarm-dashboard): derive card order, needs, plan and board from snapshots"
```

### Task 3: Shared HTML parts

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/parts.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-parts.test.mjs`

**Interfaces:**
- Consumes: `esc`, `elapsed`, `ago`, `countdown` (Task 1); `STAGE_NAMES`, `UNIT_STAGES`, `REPORT_CLASS`, `REPORT_LABELS`, `stateLine` (Task 2).
- List items carry `data-key` (chips: the sub-agent id, or `tool` for the open tool; feed items: the FeedItem id) so `morph()` matches them across updates.
- Produces: `phase(seconds, phaseMs): string` (the attributes `data-phase style="animation-delay:…"`, a negative delay that keeps re-rendered animations in phase; `ui/main.mjs` passes `performance.now()`, and `morph()` (Task 10) keeps the delay of an element that is already running); `fill(template, at, now): string`; `ring(status, label, phaseMs = 0)` (the label is an HTML `.ring-l` span over the SVG, so the layout check sees it: labels of up to 4 characters whole, a 4-character one marked `data-fit` so `ui/main.mjs` cuts it when it does not fit, longer ones cut by `shortLabel`); `shortLabel(label): string` (the first 3 characters without a trailing `.`, `_` or `-`); `stateLineHtml(session, now)`; `stageTrack(stage)`; `badge(reportStatus)`; `closedBadge` (the "closed, not merged" badge in the blocked colour); `reportClass(reportStatus)`; `meter(pct)`; `bar(pct)`; `monitorHtml(unit, now, long = false)`; `chipsHtml(session, now, freshChips = new Set())`; `feedList(items, limit, now, freshFeed = new Set(), empty = 'No activity yet')`.

- [ ] **Step 1: Write the failing test**

`tests/ui-parts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findByLabel } from '../ui/model.mjs';
import { bar, chipsHtml, feedList, fill, meter, monitorHtml, phase, ring, shortLabel, stageTrack, stateLineHtml } from '../ui/parts.mjs';
import { NOW, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, '');

test('rings spin when busy, blink dashed when stuck and lose their arc when archived', () => {
  assert.match(ring('busy', 'B1', 1000), /class="arc spin"[^>]*stroke-dasharray="29\.9 106\.8"[^>]*animation-delay:-1\.00s/);
  assert.match(ring('stuck', 'I1'), /class="arc stuck"/);
  assert.doesNotMatch(ring('archived', 'B0'), /class="arc/);
  assert.match(ring('idle', '<x>'), /&lt;x&gt;/);
  assert.equal(phase(2.4, 3000), 'data-phase style="animation-delay:-0.60s"');
});

test('a stuck sub-agent shows once, not again as the open call that launched it', () => {
  const startedAt = NOW - 15 * 60000;
  const sub = { id: 'call-launch', name: 'map', type: 'explore', status: 'stuck', startedAt, task: 'Map the module' };
  const tool = { id: 'call-launch', name: 'task', summary: 'task: Map the module', startedAt, limitMs: null };
  const html = chipsHtml({ status: 'stuck', subagents: [sub], activity: { label: 'Waiting', tool, lastEventAt: NOW } }, NOW);
  assert.equal((html.match(/class="chip /g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-key="tool"/);
});

test('ring labels show up to four characters; a four-character label may still be cut, longer ones are', () => {
  assert.match(ring('idle', 'B1'), /<span class="ring-l">B1<\/span>/);
  assert.match(ring('idle', 'C6-1'), /title="C6-1".*<span class="ring-l" data-fit>C6-1<\/span>/);
  assert.match(ring('idle', 'LONGLABEL'), /title="LONGLABEL".*<span class="ring-l">LON<\/span>/);
  assert.match(ring('idle', 'B2-x1'), /<span class="ring-l">B2<\/span>/);
  assert.equal(shortLabel('C6-1'), 'C6');
  assert.equal(shortLabel('F2a'), 'F2a');
  assert.equal(shortLabel('A_._b'), 'A');
});

test('state lines and word templates insert live times', () => {
  const snapshot = exampleSnapshot();
  assert.equal(text(stateLineHtml(findByLabel(snapshot, 'I1'), NOW)), 'Stuck · no events 48m');
  assert.equal(text(stateLineHtml(findByLabel(snapshot, 'F2a'), NOW)), 'Merged · 1d 12h ago');
  assert.equal(fill('stuck {t}', NOW - 125000, NOW), `stuck <span data-t="${NOW - 125000}" data-f="short">2m</span>`);
  assert.equal(fill('<b> {a}', NOW, NOW), `&lt;b&gt; <span data-t="${NOW}" data-f="age">just now</span>`);
});

test('the stage track fills one segment per stage reached', () => {
  const html = stageTrack('in_review');
  assert.equal((html.match(/class="on"/g) ?? []).length, 3);
  assert.match(html, /aria-label="Stage: In review"/);
  assert.equal((stageTrack('archived').match(/class="on"/g) ?? []).length, 5);
  assert.equal(meter(40), '<span class="meter"><i style="width:40%"></i></span>');
  assert.equal(bar(70), '<span class="bar"><i style="width:70%"></i></span>');
});

test('monitor text covers alive, missing, ended and no PR', () => {
  const snapshot = exampleSnapshot();
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'D5'), NOW)), 'alive · last 9m ago · next in 1m');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'B1'), NOW)), 'missing · no check for 42m');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'F2a'), NOW)), 'ended, PR merged');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'F2a'), NOW, true)), 'ended when the PR merged');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW)), 'no PR yet');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW, true)), 'starts when the PR opens');
  const paused = { ...findByLabel(snapshot, 'D5'), monitor: { state: 'paused', lastCheckAt: null, nextCheckAt: null, everyMinutes: 10, since: NOW - 300000 } };
  assert.equal(text(monitorHtml(paused, NOW)), 'paused · 5m');
});

test('chips show running sub-agents and the open call of a stuck session', () => {
  const snapshot = exampleSnapshot();
  const b1 = chipsHtml(findByLabel(snapshot, 'B1'), NOW, new Set(['call-b1-8']));
  assert.equal(text(b1), 'code-review 6m');
  assert.match(b1, /class="chip st-busy is-new" data-key="call-b1-8" title="Review PR #418"/);
  assert.equal(text(chipsHtml(findByLabel(snapshot, 'I1'), NOW)), 'bash: dotnet test --filter E2E · 48m');
  assert.match(chipsHtml(findByLabel(snapshot, 'I1'), NOW), /class="chip st-stuck"/);
  assert.equal(text(chipsHtml(findByLabel(snapshot, 'D5'), NOW)), 'No active sub-agents');
});

test('feed lists escape text, cap their length and mark new items', () => {
  const snapshot = exampleSnapshot();
  const html = feedList(snapshot.feed, 3, NOW, new Set([snapshot.feed[1].id]));
  assert.equal((html.match(/<li /g) ?? []).length, 3);
  assert.match(html, /<li class="fi" data-key="[^"]+"><span class="fi-t"><span data-t="\d+" data-f="age">4m ago<\/span><\/span><span><span class="fi-u">SB<\/span> started explore: map-import-module<\/span><\/li>/);
  assert.match(html, /<li class="fi is-new" data-key="[^"]+">/);
  assert.match(feedList([{ ...snapshot.feed[0], text: '<img onerror=x>' }], 1, NOW), /&lt;img onerror=x&gt;/);
  assert.equal(feedList([], 6, NOW, new Set(), 'No recent activity'), '<p class="none">No recent activity</p>');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-parts.test.mjs`
Expected: FAIL with `Cannot find module '.../ui/parts.mjs'`.

- [ ] **Step 3: Write `ui/parts.mjs`**

```js
import { ago, countdown, elapsed, esc } from './format.mjs';
import { REPORT_CLASS, REPORT_LABELS, STAGE_NAMES, UNIT_STAGES, stateLine } from './model.mjs';

const RING = 2 * Math.PI * 17;

/**
 * Attributes for an endless animation that stays in phase across renders: a negative delay from performance.now() at
 * render (phaseMs), and data-phase, which tells morph() to keep the delay of an element whose animation already runs.
 */
export const phase = (seconds, phaseMs) => `data-phase style="animation-delay:-${((phaseMs / 1000) % seconds).toFixed(2)}s"`;

/** The first three characters of a label, without a trailing separator. */
export const shortLabel = label => String(label).slice(0, 3).replace(/[._-]+$/, '');

/** Escape a word template and fill {t} (time in state) and {a} (age) with live times. */
export function fill(template, at, now) {
  return esc(template).replace('{t}', elapsed(at, now)).replace('{a}', ago(at, now));
}

/**
 * 40 px status ring around the label; the full label is the tooltip. Labels of up to four characters show whole, and
 * main.mjs cuts a four-character one (data-fit) to shortLabel() when it does not fit inside the ring.
 */
export function ring(status, label, phaseMs = 0) {
  const text = String(label);
  let arc = '';
  if (status === 'busy') arc = `<circle class="arc spin" cx="20" cy="20" r="17" stroke-dasharray="${(RING * 0.28).toFixed(1)} ${RING.toFixed(1)}" ${phase(4, phaseMs)}/>`;
  else if (status === 'stuck') arc = `<circle class="arc stuck" cx="20" cy="20" r="17" ${phase(2.4, phaseMs)}/>`;
  else if (status !== 'archived') arc = '<circle class="arc" cx="20" cy="20" r="17"/>';
  return `<span class="ring st-${status}" title="${esc(text)}"><svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="17"/>${arc}</svg>`
    + `<span class="ring-l"${text.length === 4 ? ' data-fit' : ''}>${esc(text.length <= 4 ? text : shortLabel(text))}</span></span>`;
}

export const stateLineHtml = (session, now) => fill(stateLine(session), session.since, now);

export function stageTrack(stage) {
  const reached = UNIT_STAGES.indexOf(stage);
  return `<span class="stage" role="img" aria-label="Stage: ${esc(STAGE_NAMES[stage] ?? stage)}">${UNIT_STAGES.map((_, index) => `<i${index <= reached ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

export const badge = status => `<span class="badge">${REPORT_LABELS[status]}</span>`;
export const closedBadge = '<span class="badge rp-blocked">closed, not merged</span>';
export const reportClass = status => `rp-${REPORT_CLASS[status]}`;
export const meter = pct => `<span class="meter"><i style="width:${pct}%"></i></span>`;
export const bar = pct => `<span class="bar"><i style="width:${pct}%"></i></span>`;

/** PR monitor state: short on cards, long in the detail panel. */
export function monitorHtml(unit, now, long = false) {
  const monitor = unit.monitor;
  const dot = '<span class="dot"></span>';
  if (monitor.state === 'alive') {
    return `${dot}alive · last ${monitor.lastCheckAt ? ago(monitor.lastCheckAt, now) : 'not yet'}${monitor.nextCheckAt ? ` · next in ${countdown(monitor.nextCheckAt, now)}` : ''}`;
  }
  if (monitor.state === 'missing') {
    const from = monitor.lastCheckAt ?? monitor.since;
    return `${dot}missing · ${from ? `no check for ${elapsed(from, now)}` : 'no check yet'}`;
  }
  if (monitor.state === 'paused') return `${dot}paused${monitor.since ? ` · ${elapsed(monitor.since, now)}` : ''}`;
  if (monitor.state === 'ended') {
    const merged = unit.outcome === 'merged' || unit.pr?.state === 'merged';
    return `${dot}${merged ? (long ? 'ended when the PR merged' : 'ended, PR merged') : 'ended'}`;
  }
  return `${dot}${long ? 'starts when the PR opens' : 'no PR yet'}`;
}

/** Chips for running (or stuck) sub-agents, plus the open tool call of a stuck session. */
export function chipsHtml(session, now, freshChips = new Set()) {
  const chips = session.subagents
    .filter(sub => sub.status === 'running' || sub.status === 'stuck')
    .map(sub => `<span class="chip st-${sub.status === 'stuck' ? 'stuck' : 'busy'}${freshChips.has(sub.id) ? ' is-new' : ''}" data-key="${esc(sub.id)}" title="${esc(sub.task ?? sub.name)}"><span class="dot"></span><span class="chip-t">${esc(sub.type)} ${elapsed(sub.startedAt, now)}</span></span>`);
  const tool = session.activity.tool;
  // A stuck sub-agent already has its chip; its launching task call would only repeat it.
  if (session.status === 'stuck' && tool && !session.subagents.some(sub => sub.id === tool.id)) {
    chips.push(`<span class="chip st-stuck" data-key="tool" title="${esc(tool.summary)}"><span class="dot"></span><span class="chip-t">${esc(tool.summary)} · ${elapsed(tool.startedAt, now)}</span></span>`);
  }
  return chips.length ? chips.join('') : '<span class="none">No active sub-agents</span>';
}

/** Activity list, latest first. */
export function feedList(items, limit, now, freshFeed = new Set(), empty = 'No activity yet') {
  if (!items.length) return `<p class="none">${esc(empty)}</p>`;
  const rows = items.slice(0, limit).map(item => `<li class="fi${freshFeed.has(item.id) ? ' is-new' : ''}" data-key="${esc(item.id)}"><span class="fi-t">${ago(item.at, now)}</span><span><span class="fi-u">${esc(item.label)}</span> ${esc(item.text)}</span></li>`);
  return `<ol class="feed2">${rows.join('')}</ol>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-parts.test.mjs`
Expected: PASS, 8 tests. (F2a's `since` is 36 hours before `NOW`, which formats as `1d 12h ago`.)

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/parts.mjs ghcp/plugins/swarm-dashboard/tests/ui-parts.test.mjs
git commit -m "feat(swarm-dashboard): add shared rings, chips, monitor text and feed parts"
```

### Task 4: Header, Needs you and Cards

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/live.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-live.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`esc`, `dur`, `elapsed`, `ago`, `liveTime`, `costHtml`, `costText`), Task 2 (`COUNT_TILES`, `NEED_CLASS`, `NEED_LABELS`, `STAGE_NAMES`, `archivedUnits`, `cardUnits`, `needItems`, `progressPercent`, `sharePercent`, `unitEnd`), Task 3 (`badge`, `bar`, `chipsHtml`, `meter`, `monitorHtml`, `reportClass`, `ring`, `stageTrack`, `stateLineHtml`).
- Produces: `headerHtml(ctx)`, `needsHtml(ctx)`, `cardHtml(unit, ctx)`, `cardsHtml(ctx)`. `ctx` is a RenderContext: `{ snapshot, now, phaseMs, detail, fresh: { feed: Set<feedItemId>, reports: Set<unitId>, chips: Set<subagentId> } }`. Task 5 adds `railHtml`, `activityHtml` and `detailHtml` to the same file.

- [ ] **Step 1: Write the failing test**

`tests/ui-live.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc } from '../ui/format.mjs';
import { cardsHtml, headerHtml, needsHtml } from '../ui/live.mjs';
import { findByLabel } from '../ui/model.mjs';
import { NOW, closedSnapshot, context, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const card = (html, id) => html.split('<article').find(part => part.includes(`data-open="${id}"`));
const cardIds = html => [...html.matchAll(/<article class="b-card[^"]*" data-open="([^"]+)"/g)].map(match => match[1]);

test('a unit whose PR closed without merging stays in PR open with a badge, and its monitor has ended', () => {
  const d5 = card(cardsHtml(context(closedSnapshot())), 'ws-0007-d5');
  assert.match(d5, /<span class="r">PR open<\/span>/);
  assert.match(d5, /<span class="mon mon-ended"><span class="dot"><\/span>ended<span class="badge rp-blocked">closed, not merged<\/span><\/span>/);
  assert.doesNotMatch(card(cardsHtml(context(exampleSnapshot())), 'ws-0007-d5'), /closed, not merged/);
});

test('the header shows the run, its running time, swarm cost and counts by bucket', () => {
  const html = headerHtml(context(exampleSnapshot()));
  assert.match(text(html), /Sample story B Orchestrator · sample-project Running 2d 23h 12m 00s Swarm cost 97,652 cr · ≈\$977/);
  assert.match(html, /<span class="ring st-question" title="SB">/);
  assert.match(html, /data-t="1791809280000" data-f="clock"/);
  const tiles = [...html.matchAll(/<div class="tile st-(\w+)"><span class="v">(\d+)<\/span><span class="k"><span class="dot"><\/span>(\w+)<\/span><\/div>/g)].map(match => match.slice(1));
  assert.deepEqual(tiles, [['busy', '1', 'working'], ['stuck', '1', 'stuck'], ['plan', '2', 'waiting'], ['idle', '1', 'idle'], ['merged', '2', 'done'], ['blocked', '0', 'failed']]);
});

test('a finished run shows how long it ran, with no ticking clock', () => {
  const snapshot = exampleSnapshot();
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: snapshot.run.startedAt + 3600000 });
  const html = headerHtml(context(snapshot));
  assert.match(text(html), /Ran 1h 00m 00s/);
  assert.doesNotMatch(html, /data-f="clock"/);
});

test('Needs you lists each item with its unit and wait time, or says nothing is waiting', () => {
  const snapshot = exampleSnapshot();
  const html = needsHtml(context(snapshot));
  assert.match(text(html), /Needs you 2 waiting, longest first/);
  assert.deepEqual([...html.matchAll(/<div class="need st-(\w+)" data-key="[^"]+">/g)].map(match => match[1]), ['plan', 'pr']);
  assert.ok(html.includes(esc(snapshot.needs[0].text)));
  assert.match(text(html), /Plan to approve .* B2 import · waiting 38m/);
  assert.match(text(html), /PR to approve .* D5 docs · waiting 25m/);
  snapshot.needs = [];
  const empty = needsHtml(context(snapshot));
  assert.match(text(empty), /Needs you Nothing waiting/);
  assert.doesNotMatch(empty, /needs-list/);
});

test('a stalled swarm is the first Needs you item, in stuck colours', () => {
  const snapshot = exampleSnapshot();
  snapshot.run.stalled = { since: NOW - 600000, reason: 'Swarm rule: the orchestrator and every open child are idle, and no monitor is due.' };
  const html = needsHtml(context(snapshot));
  assert.deepEqual([...html.matchAll(/<div class="need st-(\w+)" data-key="[^"]+">/g)].map(match => match[1]), ['stuck', 'plan', 'pr']);
  assert.match(text(html), /Swarm stalled Swarm rule: the orchestrator .* Sample story B · stalled 10m/);
});

test('cards sort by attention, hide archived units and name them in a note', () => {
  const html = cardsHtml(context(exampleSnapshot()));
  assert.deepEqual(cardIds(html), ['ws-0005-i1', 'ws-0004-b2', 'ws-0006-f1', 'ws-0003-b1', 'ws-0007-d5', 'ws-0002-f2a']);
  assert.match(text(html), /Archived and hidden here: B0 schema\. The Board tab shows them\./);
});

test('a card shows state, clock, cost bar, report, progress, stage, monitor and chips', () => {
  const html = card(cardsHtml(context(exampleSnapshot())), 'ws-0003-b1');
  assert.match(html, /class="b-card st-busy" data-open="ws-0003-b1" tabindex="0" role="button" aria-label="Open details for B1 API"/);
  assert.match(text(html), /API Busy · 35m PR #418 Running 1d 20h 03m 00s Cost 24,016 cr · ≈\$240\.16/);
  assert.match(html, /<span class="meter"><i style="width:100%"><\/i><\/span>/);
  assert.match(html, /<div class="b-rep rp-complete"><span class="badge">complete<\/span><span class="b-rep-t" title="Opened PR #418/);
  assert.match(text(html), /Progress 70% Stage In review Monitor missing · no check for 42m code-review 6m/);
});

test('ended, stuck, report-less and task-list-less cards say so', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { report: null, progress: null });
  const html = cardsHtml(context(snapshot));
  const f2a = card(html, 'ws-0002-f2a');
  assert.match(text(f2a), /Ran 23h 50m 00s/);
  assert.doesNotMatch(f2a, /data-f="clock"/);
  assert.match(card(html, 'ws-0005-i1'), /class="chip st-stuck" data-key="tool" title="bash: dotnet test --filter E2E"/);
  const d5 = card(html, 'ws-0007-d5');
  assert.match(text(d5), /No report yet .*Progress No task list/);
  assert.doesNotMatch(d5, /class="bar"/);
});

test('selection, fresh reports and fresh chips are marked; names are escaped', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').name = '<script>alert(1)</script>';
  const html = cardsHtml(context(snapshot, { detail: 'ws-0003-b1', fresh: { feed: new Set(), reports: new Set(['ws-0003-b1']), chips: new Set(['call-b1-8']) } }));
  const b1 = card(html, 'ws-0003-b1');
  assert.match(b1, /class="b-card st-busy is-sel"/);
  assert.match(b1, /class="b-rep rp-complete is-new"/);
  assert.match(b1, /class="chip st-busy is-new"/);
  assert.match(b1, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('a swarm with no active units says so', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = [];
  assert.equal(cardsHtml(context(snapshot)), '<p class="none">No active child sessions.</p>');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-live.test.mjs`
Expected: FAIL with `Cannot find module '.../ui/live.mjs'`.

- [ ] **Step 3: Write `ui/live.mjs`**

```js
import { ago, costHtml, costText, dur, elapsed, esc, liveTime } from './format.mjs';
import {
  COUNT_TILES, NEED_CLASS, NEED_LABELS, STAGE_NAMES, archivedUnits, cardUnits, closedNotMerged, needItems, progressPercent, sharePercent, unitEnd,
} from './model.mjs';
import { badge, bar, chipsHtml, closedBadge, feedList, meter, monitorHtml, reportClass, ring, stageTrack, stateLineHtml } from './parts.mjs';

/**
 * @typedef {{ snapshot: object, now: number, phaseMs: number, detail: string|null,
 *   fresh: { feed: Set<string>, reports: Set<string>, chips: Set<string> } }} RenderContext
 *   fresh holds ids that changed since the previous snapshot: feed item ids, unit ids with a new report, sub-agent ids.
 */

export function headerHtml({ snapshot, now, phaseMs }) {
  const { run, orchestrator, counts, cost } = snapshot;
  const ended = run.lifecycle === 'finished' ? run.finishedAt ?? run.lastActivityAt : null;
  const tiles = COUNT_TILES.map(([bucket, state]) => `<div class="tile st-${state}"><span class="v">${counts[bucket]}</span><span class="k"><span class="dot"></span>${bucket}</span></div>`).join('');
  return `<div class="d-head">`
    + `<div class="d-id">${ring(orchestrator.status, orchestrator.label, phaseMs)}<div class="b-who"><div class="d-name">${esc(run.name)}</div><div class="small muted">Orchestrator${run.project ? ` · ${esc(run.project.name)}` : ''}</div></div></div>`
    + `<div class="d-facts"><div class="kv"><span class="k">${ended ? 'Ran' : 'Running'}</span><span class="v l">${ended ? dur(ended - run.startedAt, 'clock') : liveTime(run.startedAt, now, 'clock')}</span></div>`
    + `<div class="kv"><span class="k">Swarm cost</span><span class="v l">${costHtml(cost.credits, true)}</span></div></div>`
    + `<div class="d-counts" aria-label="Child sessions by state">${tiles}</div></div>`;
}

export function needsHtml({ snapshot, now }) {
  const items = needItems(snapshot);
  const head = `<div class="sec-h"><h3>Needs you</h3><span class="small muted">${items.length ? `${items.length} waiting, longest first` : 'Nothing waiting'}</span></div>`;
  if (!items.length) return `<section class="needs" aria-label="Needs you">${head}</section>`;
  const list = items.map(item => `<div class="need st-${NEED_CLASS[item.kind]}" data-key="${esc(item.id)}"><span class="small need-k"><span class="dot"></span>${NEED_LABELS[item.kind]}</span>`
    + `<span class="need-t" title="${esc(item.text)}">${esc(item.text)}</span>`
    + `<span class="small muted">${esc(item.from)} · ${item.verb} ${elapsed(item.since, now)}</span></div>`).join('');
  return `<section class="needs" aria-label="Needs you">${head}<div class="needs-list">${list}</div></section>`;
}

function reportRow(unit, now, fresh) {
  const report = unit.report;
  if (!report) return '<div class="b-rep"><span class="b-rep-t muted">No report yet</span></div>';
  return `<div class="b-rep ${reportClass(report.status)}${fresh.reports.has(unit.id) ? ' is-new' : ''}">${badge(report.status)}`
    + `<span class="b-rep-t" title="${esc(report.title)}">${esc(report.title)}</span><span class="b-age">${ago(report.at, now)}</span></div>`;
}

export function cardHtml(unit, ctx) {
  const { snapshot, now, phaseMs, detail, fresh } = ctx;
  const end = unitEnd(unit);
  const progress = progressPercent(unit);
  const progressRow = progress === null
    ? '<span class="k">Progress</span><span class="none-r">No task list</span>'
    : `<span class="k">Progress</span>${bar(progress)}<span class="r">${progress}%</span>`;
  return `<article class="b-card st-${unit.status}${detail === unit.id ? ' is-sel' : ''}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(unit.label)} ${esc(unit.name)}">`
    + `<div class="b-head">${ring(unit.status, unit.label, phaseMs)}<div class="b-who st-${unit.status}"><div class="b-name">${esc(unit.name)}</div><div class="b-state">${stateLineHtml(unit, now)}</div></div>${unit.pr ? `<span class="b-pr">PR #${unit.pr.id}</span>` : ''}</div>`
    + `<div class="b-metrics"><span class="k">${end ? 'Ran' : 'Running'}</span><span class="v">${end ? dur(end - unit.startedAt, 'clock') : liveTime(unit.startedAt, now, 'clock')}</span>`
    + `<span class="k">Cost</span><span class="v">${costHtml(unit.cost.credits)}</span><span></span>${meter(sharePercent(unit.cost.credits, snapshot.cost.maxUnitCredits))}</div>`
    + reportRow(unit, now, fresh)
    + `<div class="b-rows st-${unit.status}">${progressRow}<span class="k">Stage</span>${stageTrack(unit.stage)}<span class="r">${STAGE_NAMES[unit.stage]}</span>`
    + `<span class="k">Monitor</span><span class="mon mon-${unit.monitor.state}">${monitorHtml(unit, now)}${closedNotMerged(unit) ? closedBadge : ''}</span></div>`
    + `<div class="chips">${chipsHtml(unit, now, fresh.chips)}</div></article>`;
}

export function cardsHtml(ctx) {
  const units = cardUnits(ctx.snapshot);
  const archived = archivedUnits(ctx.snapshot);
  const grid = units.length ? `<div class="b-grid">${units.map(unit => cardHtml(unit, ctx)).join('')}</div>` : '<p class="none">No active child sessions.</p>';
  const note = archived.length ? `<p class="cards-note">Archived and hidden here: ${archived.map(unit => `${esc(unit.label)} ${esc(unit.name)}`).join(', ')}. The Board tab shows them.</p>` : '';
  return grid + note;
}
```

The `costText`, `feedList` and `elapsed` imports are used by Task 5's additions to this file; keep them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-live.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/live.mjs ghcp/plugins/swarm-dashboard/tests/ui-live.test.mjs
git commit -m "feat(swarm-dashboard): render the header, Needs you and unit cards"
```

### Task 5: Activity rail and detail panel

**Files:**
- Modify: `ghcp/plugins/swarm-dashboard/ui/live.mjs` (append)
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-detail.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `railHtml(ctx)` (Activity rail, 16 items), `activityHtml(ctx)` (narrow-mode Activity tab, 24 items), `detailHtml(unitId, inMain, ctx): string` (`''` for an unknown id; `inMain` true in narrow mode, where it replaces the card list and offers "← Back to cards"; otherwise a close button).

- [ ] **Step 1: Write the failing test**

`tests/ui-detail.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityHtml, detailHtml, railHtml } from '../ui/live.mjs';
import { closedSnapshot, context, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = html => (html.match(/<li class="fi/g) ?? []).length;

test('the rail and the Activity tab list the swarm feed, latest first', () => {
  const snapshot = exampleSnapshot();
  const rail = railHtml(context(snapshot));
  assert.match(text(rail), /^Activity all units, latest first 4m ago SB started explore: map-import-module/);
  assert.equal(items(rail), Math.min(16, snapshot.feed.length));
  const tab = activityHtml(context(snapshot));
  assert.doesNotMatch(tab, /all units, latest first/);
  assert.equal(items(tab), Math.min(24, snapshot.feed.length));
});

test('the detail panel explains a stuck unit', () => {
  const html = detailHtml('ws-0005-i1', false, context(exampleSnapshot()));
  const words = text(html);
  assert.match(html, /<section class="detail" aria-label="Details for I1">/);
  assert.match(html, /<button type="button" class="x" data-close aria-label="Close details">×<\/button>/);
  assert.doesNotMatch(html, /Back to cards/);
  assert.match(words, /I1 integration Stuck · no events 48m/);
  assert.match(words, /Running 9h 05m Cost 9,702 cr · ≈\$97\.02 Progress 56% Stage Coding Model claude-sonnet-5/);
  assert.match(words, /Why this counts as stuck bash has run for 48 min with a limit of 15 min/);
  assert.match(words, /Current activity Doing Running bash: dotnet test --filter E2E Tool call bash: dotnet test --filter E2E · 48m Last event 48m ago/);
  assert.match(words, /Latest report complete 3h ago Contract tests are wired and pass locally\. Starting the end-to-end run next\. Evidence 12 contract tests pass Blockers None reported/);
  assert.match(words, /Sub-agents None in this session/);
  assert.match(words, /PR and monitor No PR yet\. A PR monitor starts when the PR opens\./);
  assert.match(words, /Recent activity No recent activity$/);
});

test('a reason on a unit that is neither stuck nor blocked is a note, not an alarm', () => {
  const snapshot = exampleSnapshot();
  const b1 = snapshot.units.find(unit => unit.label === 'B1');
  Object.assign(b1, { statusDetail: 'slow_model_call', reason: 'Waiting 6m for a model response; it counts as stuck after 10m.' });
  const html = detailHtml(b1.id, false, context(snapshot));
  assert.doesNotMatch(html, /dt-why/);
  assert.match(html, /<span class="k">Note<\/span><span>Waiting 6m for a model response; it counts as stuck after 10m\.<\/span>/);
});

test('the detail panel shows a PR closed without merging with the badge and when it closed', () => {
  const html = detailHtml('ws-0007-d5', false, context(closedSnapshot()));
  assert.match(html, /<span class="k">State<\/span><span class="pr-state"><span class="badge rp-blocked">closed, not merged<\/span><span>/);
  assert.match(text(html), /State closed, not merged 20m ago Reviews review required Monitor ended/);
});

test('the detail panel lists sub-agents, the PR, the monitor and recent activity', () => {
  const html = detailHtml('ws-0003-b1', true, context(exampleSnapshot()));
  const words = text(html);
  assert.match(html, /<button type="button" class="link" data-close>← Back to cards<\/button>/);
  assert.doesNotMatch(html, /class="x"/);
  assert.match(html, /<span class="pill st-busy">running<\/span>/);
  assert.match(words, /task \(sync\) finished claude-haiku-5\.5 · 9m · 30 cr · ≈\$0\.30/);
  assert.match(words, /PR #418 Orders and invoices API State Open since 2h ago Reviews changes requested Monitor missing · no check for 42m Expected a check every 10 min/);
  assert.equal(items(html), 3);
});

test('blocked units, draft PRs and live monitors read correctly', () => {
  const snapshot = exampleSnapshot();
  const f1 = text(detailHtml('ws-0006-f1', false, context(snapshot)));
  assert.match(f1, /Why this counts as blocked It asked the orchestrator for input and has had no reply\./);
  assert.match(f1, /Blockers Needs a decision: reuse DataGrid or build a new table/);
  const d5 = text(detailHtml('ws-0007-d5', false, context(snapshot)));
  assert.match(d5, /State Draft since 5h ago/);
  assert.match(d5, /Monitor alive · last 9m ago · next in 1m Schedule every 10 min/);
  assert.equal(detailHtml('missing', false, context(snapshot)), '');
});

test('long sub-agent lists are capped with a count of the rest', () => {
  const snapshot = exampleSnapshot();
  const b1 = snapshot.units.find(unit => unit.id === 'ws-0003-b1');
  const template = b1.subagents[1];
  b1.subagents = Array.from({ length: 15 }, (_, index) => ({ ...template, id: `call-x-${index}` }));
  const html = detailHtml('ws-0003-b1', false, context(snapshot));
  assert.equal((html.match(/<li class="sa"/g) ?? []).length, 12);
  assert.match(text(html), /3 earlier sub-agents not shown/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-detail.test.mjs`
Expected: FAIL with `does not provide an export named 'activityHtml'`.

- [ ] **Step 3: Append to `ui/live.mjs`**

```js
export const railHtml = ctx => `<section class="rail" aria-label="Activity"><div class="sec-h"><h3>Activity</h3><span class="small muted">all units, latest first</span></div>${feedList(ctx.snapshot.feed, 16, ctx.now, ctx.fresh.feed)}</section>`;
export const activityHtml = ctx => `<section class="rail" aria-label="Activity">${feedList(ctx.snapshot.feed, 24, ctx.now, ctx.fresh.feed)}</section>`;

const SUBAGENT_PILLS = { running: ['busy', 'running'], completed: ['merged', 'finished'], failed: ['blocked', 'failed'], stuck: ['stuck', 'stuck'] };
const SUBAGENT_LIMIT = 12;

/** The engine also gives reasons to units that are fine (a slow model call, a normal stop); only these get the alarm box. */
const WHY_STATUSES = new Set(['stuck', 'blocked']);

function whyHtml(unit) {
  if (!unit.reason || !WHY_STATUSES.has(unit.status)) return '';
  const word = unit.status === 'stuck' ? 'stuck' : unit.statusDetail === 'crashed' ? 'crashed' : unit.statusDetail === 'failed' ? 'failed' : 'blocked';
  return `<div class="dt-why st-${unit.status === 'stuck' ? 'stuck' : 'blocked'}"><h4>Why this counts as ${word}</h4><p>${esc(unit.reason)}</p></div>`;
}

function reportHtml(report, now) {
  if (!report) return '<p class="small muted">No report yet.</p>';
  const list = entries => `<ul class="dt-list">${entries.map(entry => `<li>${esc(entry)}</li>`).join('')}</ul>`;
  const lead = report.summary ?? (report.body ? null : report.title);
  return `<div class="dt-rep-h ${reportClass(report.status)}">${badge(report.status)}<span class="small muted">${ago(report.at, now)}</span></div>`
    + (lead ? `<p class="dt-p">${esc(lead)}</p>` : '')
    + (report.body ? `<p class="dt-p dt-body">${esc(report.body)}</p>` : '')
    + (report.evidence.length ? `<span class="small muted">Evidence</span>${list(report.evidence)}` : '')
    + (report.blockers === null ? '' : `<span class="small muted">Blockers</span>${report.blockers.length ? list(report.blockers) : '<p class="small">None reported</p>'}`);
}

function subagentsHtml(subagents, now) {
  if (!subagents.length) return '<p class="small muted">None in this session</p>';
  const rows = subagents.slice(0, SUBAGENT_LIMIT).map(sub => {
    const [state, word] = SUBAGENT_PILLS[sub.status] ?? ['idle', sub.status];
    const runtime = sub.endedAt ? dur(sub.durationMs ?? sub.endedAt - sub.startedAt) : elapsed(sub.startedAt, now);
    return `<li class="sa" title="${esc(sub.task ?? sub.name)}"><div class="sa-1"><span>${esc(sub.type)}${sub.mode === 'sync' ? ' (sync)' : ''}</span><span class="pill st-${state}">${word}</span></div>`
      + `<div class="sa-2">${esc(sub.model ?? 'model unknown')} · ${runtime} · ${costText(sub.credits)}</div></li>`;
  }).join('');
  const more = subagents.length > SUBAGENT_LIMIT ? `<p class="small muted">${subagents.length - SUBAGENT_LIMIT} earlier sub-agents not shown</p>` : '';
  return `<ul class="sa-list">${rows}</ul>${more}`;
}

function prState(pr, now) {
  if (pr.state === 'merged') return pr.mergedAt ? `Merged ${ago(pr.mergedAt, now)}` : 'Merged';
  if (pr.state === 'closed') return pr.closedAt ? `Closed ${ago(pr.closedAt, now)}` : 'Closed';
  if (pr.state === 'unknown') return 'Not known yet';
  const word = pr.state === 'draft' ? 'Draft' : 'Open';
  return pr.openedAt ? `${word} since ${ago(pr.openedAt, now)}` : word;
}

function prHtml(unit, now) {
  const { pr, monitor } = unit;
  if (!pr) return '<p class="small muted">No PR yet. A PR monitor starts when the PR opens.</p>';
  const state = closedNotMerged(unit)
    ? `<span class="pr-state">${closedBadge}${pr.closedAt ? `<span>${ago(pr.closedAt, now)}</span>` : ''}</span>`
    : `<span>${prState(pr, now)}</span>`;
  return `<div class="dt-kv"><span class="k">PR</span><span>#${pr.id}${pr.title ? ` ${esc(pr.title)}` : ''}</span><span class="k">State</span>${state}`
    + (pr.reviewNote ? `<span class="k">Reviews</span><span>${esc(pr.reviewNote)}</span>` : '')
    + `<span class="k">Monitor</span><span class="mon mon-${monitor.state}">${monitorHtml(unit, now, true)}</span>`
    + (monitor.everyMinutes && monitor.state === 'alive' ? `<span class="k">Schedule</span><span>every ${monitor.everyMinutes} min</span>` : '')
    + (monitor.everyMinutes && monitor.state === 'missing' ? `<span class="k">Expected</span><span>a check every ${monitor.everyMinutes} min</span>` : '')
    + '</div>';
}

/** Details for one unit. In narrow mode (inMain) it replaces the card list and offers a way back. */
export function detailHtml(unitId, inMain, ctx) {
  const { snapshot, now, phaseMs, fresh } = ctx;
  const unit = snapshot.units.find(item => item.id === unitId);
  if (!unit) return '';
  const end = unitEnd(unit);
  const activity = unit.activity;
  const progress = progressPercent(unit);
  const top = `<div class="dt-top">${inMain ? '<button type="button" class="link" data-close>← Back to cards</button>' : ''}`
    + `<div class="b-head">${ring(unit.status, unit.label, phaseMs)}<div class="b-who st-${unit.status}"><div class="b-name">${esc(unit.label)} ${esc(unit.name)}</div><div class="b-state">${stateLineHtml(unit, now)}</div></div>`
    + `${inMain ? '' : '<button type="button" class="x" data-close aria-label="Close details">×</button>'}</div></div>`;
  const facts = `<div class="dt-facts"><div class="kv"><span class="k">${end ? 'Ran' : 'Running'}</span><span class="v">${end ? dur(end - unit.startedAt) : elapsed(unit.startedAt, now)}</span></div>`
    + `<div class="kv"><span class="k">Cost</span><span class="v">${costHtml(unit.cost.credits)}</span></div>`
    + `<div class="kv"><span class="k">Progress</span><span class="v">${progress === null ? 'No task list' : `${progress}%`}</span></div>`
    + `<div class="kv"><span class="k">Stage</span><span class="v">${STAGE_NAMES[unit.stage]}</span></div>`
    + `<div class="kv"><span class="k">Model</span><span class="v">${esc(unit.model ?? 'unknown')}</span></div></div>`;
  const current = `<div class="dt-sec"><h4>Current activity</h4><div class="dt-kv"><span class="k">Doing</span><span>${esc(activity.label)}</span>`
    + (unit.reason && !WHY_STATUSES.has(unit.status) ? `<span class="k">Note</span><span>${esc(unit.reason)}</span>` : '')
    + (activity.tool ? `<span class="k">Tool call</span><span><span class="code">${esc(activity.tool.summary)}</span> · ${elapsed(activity.tool.startedAt, now)}</span>` : '')
    + `<span class="k">Last event</span><span>${activity.lastEventAt ? ago(activity.lastEventAt, now) : 'none yet'}</span></div></div>`;
  return `<section class="detail" aria-label="Details for ${esc(unit.label)}">${top}${facts}${whyHtml(unit)}${current}`
    + `<div class="dt-sec"><h4>Latest report</h4>${reportHtml(unit.report, now)}</div>`
    + `<div class="dt-sec"><h4>Sub-agents</h4>${subagentsHtml(unit.subagents, now)}</div>`
    + `<div class="dt-sec"><h4>PR and monitor</h4>${prHtml(unit, now)}</div>`
    + `<div class="dt-sec"><h4>Recent activity</h4>${feedList(unit.recent, 6, now, fresh.feed, 'No recent activity')}</div></section>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-live.test.mjs tests/ui-detail.test.mjs`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/live.mjs ghcp/plugins/swarm-dashboard/tests/ui-detail.test.mjs
git commit -m "feat(swarm-dashboard): render the activity rail and the unit detail panel"
```

### Task 6: Stylesheet and token lint

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/styles.css`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-styles.test.mjs`

**Interfaces:**
- Consumes: the class names produced by Tasks 3–5 and, later, Tasks 7 and 12–14 (all rules for them are in this file from the start).
- Produces: `ui/styles.css`, served at `/ui/styles.css`. The page root is `<main class="dash" id="dash">`; `html[data-host="canvas"]` switches to the edge-to-edge canvas layout.

The rules are the approved mockup's (`docs/superpowers/specs/assets/2026-10-15-swarm-dashboard-mockup.html`, lines 9–329) with four kinds of change: the mockup's preview chrome (`.mk-*`) is gone; `#r2` scoping is replaced by the page root; the font family comes from the host's `--font-sans`; and rules are added for the approved states and controls that the mockup does not show (`.rp-progress`, `.d-top-r`, `.pick`, `.warn`, `.empty`, `.none-r`, `.chip-t`, `.tx`, `.dt-body`, the `.dt-why` colour variants and the canvas layout).

- [ ] **Step 1: Write the failing test**

`tests/ui-styles.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
const declarations = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map(([, prop, value]) => [prop, value.trim()]);

const TOKENS = {
  '--page': '0.975 0.004 250', '--surface': '0.993 0.002 250', '--sunk': '0.95 0.005 250', '--line': '0.905 0.008 250',
  '--line-2': '0.94 0.006 250', '--ink': '0.30 0.02 255', '--ink-2': '0.48 0.018 255', '--ink-3': '0.55 0.015 255',
  '--meter': '0.80 0.03 250', '--focus': '0.55 0.10 245',
  '--busy': '0.84 0.07 238', '--busy-ink': '0.46 0.09 245', '--busy-soft': '0.955 0.02 238',
  '--idle': '0.87 0.012 250', '--idle-ink': '0.48 0.015 250', '--idle-soft': '0.96 0.004 250',
  '--plan': '0.89 0.08 92', '--plan-ink': '0.47 0.08 75', '--plan-soft': '0.97 0.03 95',
  '--question': '0.85 0.07 300', '--question-ink': '0.47 0.11 300', '--question-soft': '0.965 0.02 300',
  '--stuck': '0.78 0.11 25', '--stuck-ink': '0.49 0.14 27', '--stuck-soft': '0.96 0.025 25',
  '--blocked': '0.85 0.085 62', '--blocked-ink': '0.48 0.10 55', '--blocked-soft': '0.965 0.03 65',
  '--merged': '0.86 0.07 160', '--merged-ink': '0.45 0.08 160', '--merged-soft': '0.965 0.02 160',
  '--archived': '0.91 0.006 250', '--archived-ink': '0.55 0.012 250', '--archived-soft': '0.97 0.003 250',
  '--stg-coding': '0.955 0.025 195', '--stg-pr': '0.925 0.045 188', '--stg-review': '0.895 0.06 178', '--stg-ink': '0.62 0.07 185',
};

test('the palette is the approved OKLCH tokens', () => {
  for (const [name, value] of Object.entries(TOKENS)) assert.ok(css.includes(`${name}: oklch(${value});`), name);
});

test('type uses only the approved sizes, line heights and weights, with no italic, uppercase or letter-spacing', () => {
  for (const [prop, value] of declarations) {
    if (prop === 'font-size') assert.match(value, /^(12|14|18)px$/, `font-size: ${value}`);
    if (prop === 'line-height') assert.match(value, /^(16|20|24)px$/, `line-height: ${value}`);
    if (prop === 'font-weight') assert.match(value, /^(400|500)$/, `font-weight: ${value}`);
    if (prop === 'font' && value !== 'inherit') assert.match(value, /^(400|500) (12|14|18)px\/(16|20|24)px /, `font: ${value}`);
    if (prop === 'font-style') assert.equal(value, 'normal');
    assert.notEqual(prop, 'letter-spacing');
    assert.notEqual(prop, 'text-transform');
  }
  assert.doesNotMatch(css, /italic|uppercase/);
});

test('spacing stays on the 4 px grid', () => {
  const allowed = new Set(['margin-top: 6px']);
  for (const [prop, value] of declarations) {
    if (!/^(gap|row-gap|column-gap|padding(-top|-right|-bottom|-left)?|margin(-top|-right|-bottom|-left)?)$/.test(prop)) continue;
    if (allowed.has(`${prop}: ${value}`)) continue;
    for (const [, number] of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) assert.equal(Number(number) % 4, 0, `${prop}: ${value}`);
  }
});

test('buttons take their colour, type and margin from the page, as the approved mockup renders them', () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
  const buttons = rules.filter(([selector]) => selector !== 'button, select' && (/\bbutton\b/.test(selector) || /(^|[\s,])\.(link|x)(?![\w-])/.test(selector)));
  assert.ok(buttons.length >= 6, `${buttons.length} button rules`);
  for (const [selector, body] of buttons) assert.doesNotMatch(body, /(^|;)\s*(color|font(-[a-z]+)?|line-height|margin(-[a-z]+)?)\s*:/, selector);
});

test('the font comes from the host with the approved fallback, motion stops on request, and nothing loads from outside', () => {
  assert.ok(css.includes('var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif)'));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\* \{ animation: none !important; \}/);
  assert.doesNotMatch(css, /@import|url\((?!#cHatch2\))/);
  assert.match(css, /html\[data-host="canvas"\] \.dash \{/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-styles.test.mjs`
Expected: FAIL with `ENOENT: no such file or directory, open '.../ui/styles.css'`.

- [ ] **Step 3: Write `ui/styles.css`**

```css
/* Swarm dashboard. Values follow the approved mockup and spec section 8; keep them in sync with tests/ui-styles.test.mjs. */
:root {
  color-scheme: light;
  --page: oklch(0.975 0.004 250);
  --surface: oklch(0.993 0.002 250);
  --sunk: oklch(0.95 0.005 250);
  --line: oklch(0.905 0.008 250);
  --line-2: oklch(0.94 0.006 250);
  --ink: oklch(0.30 0.02 255);
  --ink-2: oklch(0.48 0.018 255);
  --ink-3: oklch(0.55 0.015 255);
  --meter: oklch(0.80 0.03 250);
  --focus: oklch(0.55 0.10 245);
  --busy: oklch(0.84 0.07 238);
  --busy-ink: oklch(0.46 0.09 245);
  --busy-soft: oklch(0.955 0.02 238);
  --idle: oklch(0.87 0.012 250);
  --idle-ink: oklch(0.48 0.015 250);
  --idle-soft: oklch(0.96 0.004 250);
  --plan: oklch(0.89 0.08 92);
  --plan-ink: oklch(0.47 0.08 75);
  --plan-soft: oklch(0.97 0.03 95);
  --question: oklch(0.85 0.07 300);
  --question-ink: oklch(0.47 0.11 300);
  --question-soft: oklch(0.965 0.02 300);
  --stuck: oklch(0.78 0.11 25);
  --stuck-ink: oklch(0.49 0.14 27);
  --stuck-soft: oklch(0.96 0.025 25);
  --blocked: oklch(0.85 0.085 62);
  --blocked-ink: oklch(0.48 0.10 55);
  --blocked-soft: oklch(0.965 0.03 65);
  --merged: oklch(0.86 0.07 160);
  --merged-ink: oklch(0.45 0.08 160);
  --merged-soft: oklch(0.965 0.02 160);
  --archived: oklch(0.91 0.006 250);
  --archived-ink: oklch(0.55 0.012 250);
  --archived-soft: oklch(0.97 0.003 250);
  --stg-planned: var(--surface);
  --stg-coding: oklch(0.955 0.025 195);
  --stg-pr: oklch(0.925 0.045 188);
  --stg-review: oklch(0.895 0.06 178);
  --stg-merged: var(--merged);
  --stg-archived: var(--archived);
  --stg-ink: oklch(0.62 0.07 185);
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; }
body { padding: 16px; background: var(--page); color: var(--ink); font: 400 14px/20px var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif); font-variant-numeric: tabular-nums; }
html[data-host="canvas"] body { padding: 0; background: var(--surface); }
h2, h3, h4, p, ol, ul { margin: 0; padding: 0; }
ol, ul { list-style: none; }
h2 { font-size: 18px; line-height: 24px; font-weight: 500; }
h3, h4 { font-size: 14px; line-height: 20px; font-weight: 500; }
/* Buttons take colour, type and margin from the page, as the approved mockup renders them. */
button, select { font: inherit; color: inherit; margin: 0; }
a { color: var(--busy-ink); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* states, report badges and shared pieces */
.st-busy { --c: var(--busy); --c-ink: var(--busy-ink); --c-soft: var(--busy-soft); }
.st-idle { --c: var(--idle); --c-ink: var(--idle-ink); --c-soft: var(--idle-soft); }
.st-plan { --c: var(--plan); --c-ink: var(--plan-ink); --c-soft: var(--plan-soft); }
.st-question { --c: var(--question); --c-ink: var(--question-ink); --c-soft: var(--question-soft); }
.st-stuck { --c: var(--stuck); --c-ink: var(--stuck-ink); --c-soft: var(--stuck-soft); }
.st-blocked { --c: var(--blocked); --c-ink: var(--blocked-ink); --c-soft: var(--blocked-soft); }
.st-merged { --c: var(--merged); --c-ink: var(--merged-ink); --c-soft: var(--merged-soft); }
.st-archived { --c: var(--archived); --c-ink: var(--archived-ink); --c-soft: var(--archived-soft); }
.st-planned { --c: var(--surface); --c-ink: var(--ink-2); --c-soft: var(--surface); }
.st-pr { --c: var(--stg-pr); --c-ink: oklch(0.45 0.07 190); --c-soft: var(--stg-coding); }
.rp-complete { --r: var(--merged-ink); }
.rp-progress { --r: var(--busy-ink); }
.rp-needs { --r: var(--question-ink); }
.rp-blocked { --r: var(--blocked-ink); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--r, var(--c-ink)); flex: none; }
.muted { color: var(--ink-2); }
.small { font-size: 12px; line-height: 16px; }
.warn { color: var(--blocked-ink); }
.usd { font-size: 12px; font-weight: 400; color: var(--ink-2); }
.tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seg { display: inline-flex; gap: 4px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.seg button { height: 28px; padding: 0 12px; border: 0; border-radius: 4px; background: none; cursor: pointer; white-space: nowrap; }
.seg button[aria-pressed="true"] { background: var(--sunk); }
.kv { display: flex; flex-direction: column; min-width: 0; }
.kv .k { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.kv .v { font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap; }
.kv .v.l { font-size: 18px; line-height: 24px; }
.sec-h { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; line-height: 16px; color: var(--ink-2); background: var(--surface); white-space: nowrap; }
.chip .dot { width: 6px; height: 6px; }
.chip-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.chip.st-stuck { border-color: var(--stuck); color: var(--stuck-ink); }
.none { font-size: 12px; line-height: 24px; color: var(--ink-2); }
@keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes flash { from { background: var(--busy-soft); } to { background: transparent; } }
.is-new { animation: fadein .6s cubic-bezier(.25, 1, .5, 1); }

/* dashboard frame */
.dash { container: dash / inline-size; display: flex; flex-direction: column; gap: 16px; max-width: 1920px; min-width: 0; margin: 0 auto; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
html[data-host="canvas"] .dash { min-height: 100vh; border: 0; border-radius: 0; }
.d-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.d-top-r { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 16px; min-width: 0; }
.d-top-r .small { white-space: nowrap; }
.pick { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.pick select { height: 28px; max-width: 240px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; }
.pick select:hover { border-color: var(--ink-3); }
.d-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px 32px; }
.d-id { display: flex; align-items: center; gap: 12px; min-width: 0; }
.d-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.d-facts { display: flex; flex-wrap: wrap; gap: 8px 32px; }
.d-counts { display: grid; grid-template-columns: repeat(6, auto); gap: 8px 24px; }
.tile { display: flex; flex-direction: column; }
.tile .v { font-size: 18px; line-height: 24px; font-weight: 500; }
.tile .k { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; }
.needs { display: flex; flex-direction: column; gap: 8px; }
.needs-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }
.need { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.need-k { display: inline-flex; align-items: center; gap: 4px; color: var(--c-ink); }
.need-t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
.d-body { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
.d-body.has-detail { grid-template-columns: minmax(0, 1fr) 440px; }
.d-body.is-narrow { grid-template-columns: minmax(0, 1fr); }
.d-main { container: main / inline-size; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.d-side { min-width: 0; }
.tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
.tabs button { padding: 4px 12px 8px; border: 0; border-bottom: 2px solid transparent; background: none; cursor: pointer; }
.tabs button[aria-selected="true"] { border-bottom-color: var(--ink); }
@container dash (max-width: 720px) {
  .d-counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .needs-list { grid-template-columns: minmax(0, 1fr); }
}

/* cards */
.b-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(296px, 1fr)); gap: 12px; }
.b-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); cursor: pointer; }
.b-card:hover { border-color: var(--ink-3); }
.b-card.st-plan, .b-card.st-question, .b-card.st-stuck, .b-card.st-blocked { background: var(--c-soft); border-color: var(--c); }
.b-card.is-sel { border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink); }
.b-head { display: flex; align-items: center; gap: 12px; height: 40px; min-width: 0; }
.b-who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.b-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.b-state { font-size: 12px; line-height: 16px; color: var(--c-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.b-pr { font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; }
.ring { position: relative; flex: none; }
.ring svg { display: block; }
.ring .trk { fill: none; stroke: var(--line); stroke-width: 4; }
.ring .arc { fill: none; stroke: var(--c); stroke-width: 4; stroke-linecap: round; }
.ring .arc.spin { transform-origin: 20px 20px; animation: spin 4s linear infinite; }
.ring .arc.stuck { stroke-dasharray: 4 4; stroke-linecap: butt; animation: blink 2.4s ease-in-out infinite; }
.ring-l { position: absolute; left: 5px; top: 12px; width: 30px; font-size: 12px; line-height: 16px; font-weight: 500; color: var(--ink); text-align: center; white-space: nowrap; overflow: hidden; }
.b-metrics { display: grid; grid-template-columns: 56px minmax(0, 1fr); row-gap: 4px; column-gap: 8px; align-items: baseline; }
.b-metrics .k, .b-rows .k { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.b-metrics .v { font-size: 18px; line-height: 24px; font-weight: 500; white-space: nowrap; }
.b-metrics .meter { align-self: center; }
.meter, .bar { height: 4px; border-radius: 2px; background: var(--line-2); overflow: hidden; }
.meter i, .bar i { display: block; height: 100%; border-radius: 2px; }
.meter i { background: var(--meter); }
.bar i { background: var(--c); }
.b-rep { display: flex; align-items: center; gap: 8px; height: 20px; min-width: 0; }
.badge { display: inline-flex; flex: none; height: 20px; padding: 0 8px; border-radius: 4px; font-size: 12px; line-height: 20px; color: var(--r); background: color-mix(in oklch, var(--r) 12%, var(--surface)); }
.b-rep-t { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.b-age { flex: none; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.b-rep.is-new { animation: flash 1.6s cubic-bezier(.25, 1, .5, 1); }
.b-rows { display: grid; grid-template-columns: 56px minmax(0, 1fr) 64px; column-gap: 8px; row-gap: 8px; align-items: center; }
.b-rows .r { font-size: 12px; line-height: 16px; color: var(--ink-2); text-align: right; white-space: nowrap; }
.b-rows .mon, .b-rows .none-r { grid-column: 2 / 4; }
.none-r { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.stage { display: flex; gap: 4px; height: 4px; }
.stage i { flex: 1; border-radius: 2px; background: var(--line-2); }
.stage i.on { background: var(--stg-ink); }
.mon { display: flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mon .badge { margin-left: 4px; }
.mon .dot { width: 6px; height: 6px; }
.mon-alive .dot { background: var(--merged-ink); }
.mon-missing, .mon-paused { color: var(--blocked-ink); }
.mon-missing .dot, .mon-paused .dot { background: var(--blocked-ink); }
.mon-ended .dot, .mon-none .dot { background: var(--line); }
.b-card .chips { height: 24px; overflow: hidden; }
.cards-note { font-size: 12px; line-height: 16px; color: var(--ink-2); }

/* activity rail and feed */
.rail { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
.feed2 { display: flex; flex-direction: column; gap: 8px; }
.fi { display: grid; grid-template-columns: 64px minmax(0, 1fr); column-gap: 8px; font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
.fi-t { color: var(--ink-2); white-space: nowrap; }
.fi-u { font-weight: 500; }
.fi.is-new { animation: flash 1.6s cubic-bezier(.25, 1, .5, 1); }

/* detail panel */
.detail { display: flex; flex-direction: column; gap: 16px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.dt-top { display: flex; flex-direction: column; gap: 12px; }
.x { flex: none; width: 28px; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); cursor: pointer; }
.link { align-self: flex-start; padding: 0; border: 0; background: none; cursor: pointer; }
.dt-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px 16px; }
.dt-facts .v { white-space: normal; }
.dt-sec { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line-2); }
.dt-why { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 8px; background: var(--c-soft); color: var(--c-ink); }
.dt-why p { font-size: 12px; line-height: 16px; }
.dt-kv { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 4px 8px; font-size: 12px; line-height: 16px; }
.dt-kv .k { color: var(--ink-2); }
.dt-kv > span { min-width: 0; overflow-wrap: anywhere; }
.pr-state { display: flex; align-items: center; gap: 8px; }
.code { padding: 0 4px; border-radius: 4px; background: var(--sunk); }
.dt-rep-h { display: flex; align-items: center; gap: 8px; }
.dt-p { font-size: 14px; line-height: 20px; overflow-wrap: anywhere; }
.dt-body { white-space: pre-line; }
.dt-list { display: flex; flex-direction: column; gap: 4px; font-size: 12px; line-height: 16px; }
.dt-list li { display: flex; gap: 8px; overflow-wrap: anywhere; }
.dt-list li::before { content: ""; flex: none; width: 4px; height: 4px; margin-top: 6px; border-radius: 50%; background: var(--ink-3); }
.sa-list { display: flex; flex-direction: column; gap: 8px; }
.sa { display: flex; flex-direction: column; }
.sa-1 { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pill { flex: none; height: 20px; padding: 0 8px; border-radius: 4px; font-size: 12px; line-height: 20px; color: var(--c-ink); background: var(--c-soft); }
.sa-2 { font-size: 12px; line-height: 16px; color: var(--ink-2); overflow-wrap: anywhere; }

/* plan and board */
.legend { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.legend span.note { white-space: normal; }
.sw { display: inline-block; width: 12px; height: 12px; border-radius: 4px; border: 1px solid var(--line); flex: none; }
.stg-planned { background: var(--stg-planned); }
.stg-coding { background: var(--stg-coding); }
.stg-pr { background: var(--stg-pr); }
.stg-review { background: var(--stg-review); }
.stg-merged { background: var(--stg-merged); }
.stg-archived { background: var(--stg-archived); }
.plan-g { position: relative; }
.plan-g svg { position: absolute; left: 0; top: 0; overflow: visible; }
.plan-g path { fill: none; stroke: var(--ink-3); stroke-width: 1; }
.pn { position: absolute; display: flex; flex-direction: column; padding: 12px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.pn.stg-planned { border-style: dashed; border-color: var(--ink-3); }
.pn.can { border-style: solid; border-color: var(--busy-ink); }
.pn[data-open], .pl-row[data-open] { cursor: pointer; }
.pn-1 { display: flex; align-items: center; gap: 8px; font-weight: 500; white-space: nowrap; overflow: hidden; }
.pn-2 { font-size: 12px; line-height: 16px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pn-2 .s { color: var(--c-ink); }
.pn .dot, .pl-row .dot { background: var(--c-ink); }
.pl { display: flex; flex-direction: column; gap: 8px; }
.pl-row { display: flex; flex-direction: column; padding: 12px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; }
.pl-row.stg-planned { border-style: dashed; border-color: var(--ink-3); }
.pl-row.can { border-style: solid; border-color: var(--busy-ink); }
.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; align-items: start; }
.bcol { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.bcol-h { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; }
.bcol-h b { font-weight: 500; color: var(--ink); }
.mc { display: flex; flex-direction: column; padding: 12px; border: 1px solid var(--line); border-radius: 8px; min-width: 0; background: var(--surface); }
.mc[data-open] { cursor: pointer; }
.mc[data-open]:hover { border-color: var(--ink-3); }
.mc.st-plan, .mc.st-question, .mc.st-stuck, .mc.st-blocked { background: var(--c-soft); border-color: var(--c); }
.mc.planned { border-style: dashed; border-color: var(--ink-3); }
.mc.planned.can { border-style: solid; border-color: var(--busy-ink); }
.mc-1 { display: flex; align-items: center; gap: 8px; font-weight: 500; white-space: nowrap; overflow: hidden; }
.mc-2, .mc-3 { font-size: 12px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mc-2 { color: var(--c-ink); }
.mc-3 { color: var(--ink-2); }

/* timeline */
.c { display: flex; flex-direction: column; gap: 12px; }
.c-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.c-bar .seg button { height: 24px; padding: 0 8px; }
.c-keys { display: flex; flex-wrap: wrap; gap: 8px 16px; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.c-keys span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.c-keys svg { overflow: visible; }
.c-rows { display: flex; flex-direction: column; }
.c-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "who sum" "trk trk"; column-gap: 16px; row-gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line-2); }
.c-row.c-axis { grid-template-areas: "trk trk"; padding: 0 0 4px; }
.c-row.c-axis .c-who, .c-row.c-axis .c-sum { display: none; }
.c-row.c-cost { border-bottom: 0; }
@container main (min-width: 760px) {
  .c-row { grid-template-columns: 200px minmax(0, 1fr) 176px; grid-template-areas: "who trk sum"; row-gap: 0; }
  .c-row.c-axis { grid-template-areas: "who trk sum"; }
  .c-row.c-axis .c-who, .c-row.c-axis .c-sum { display: block; }
}
.c-who { grid-area: who; min-width: 0; display: flex; flex-direction: column; }
.c-trk { grid-area: trk; min-width: 0; position: relative; }
.c-trk svg { display: block; overflow: visible; }
.c-sum { grid-area: sum; min-width: 0; display: flex; flex-direction: column; text-align: right; }
@container main (min-width: 760px) {
  .c-sum { text-align: left; }
}
.c-name { display: flex; align-items: center; gap: 8px; height: 20px; font-weight: 500; white-space: nowrap; overflow: hidden; }
.c-name .dot { background: var(--c); }
.c-name .dot.stuck { background: none; border: 1.5px dashed var(--stuck-ink); }
.c-meta { font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-meta .s { color: var(--c-ink); }
.c-rep { height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-rep .dot { margin-right: 8px; vertical-align: 0; }
.c-head { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.c-total { font-size: 18px; line-height: 24px; font-weight: 500; white-space: nowrap; }
.t-busy { fill: var(--busy); }
.t-idle { stroke: var(--idle); stroke-width: 2; }
.t-plan { fill: var(--plan-soft); stroke: var(--plan); stroke-width: 1; }
.t-question { fill: var(--question-soft); stroke: var(--question); stroke-width: 1; }
.t-stuck { fill: url(#cHatch2); stroke: var(--stuck); stroke-width: 1; }
.t-stuck.live { animation: blink 2.4s ease-in-out infinite; }
.t-edge { fill: var(--busy-ink); animation: blink 2s ease-in-out infinite; }
.t-now { stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 2 2; }
.t-sub { fill: var(--idle); }
.t-sub.live { fill: var(--busy-ink); }
.t-mon { stroke: var(--idle-ink); stroke-width: 1; }
.t-axis text { font-size: 12px; fill: var(--ink-2); }
.t-axis line { stroke: var(--line); }
.t-cost { fill: none; stroke: var(--ink-2); stroke-width: 1.5; }

/* history and run summary */
.h-list { display: flex; flex-direction: column; }
.h-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.5fr) minmax(0, .9fr) minmax(0, .8fr) minmax(0, 1.4fr) minmax(0, .8fr); gap: 4px 16px; align-items: baseline; padding: 12px 0; border-bottom: 1px solid var(--line-2); }
.h-row.h-th { padding-top: 0; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.h-row[data-run] { cursor: pointer; }
.h-row[data-run]:hover .h-name { color: var(--busy-ink); }
.h-row > span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.h-name { font-weight: 500; }
.h-run { display: flex; flex-direction: column; }
.h-run > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.h-cell .k { display: none; }
@container dash (max-width: 860px) {
  .h-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .h-row.h-th { display: none; }
  .h-row > span:first-child, .h-row > span:nth-child(2) { grid-column: 1 / -1; }
  .h-cell .k { display: inline; color: var(--ink-2); font-size: 12px; }
}
.run { display: flex; flex-direction: column; gap: 24px; }
.run-answer { display: flex; flex-wrap: wrap; gap: 16px 48px; padding: 16px; border: 1px solid var(--line); border-radius: 8px; }
.run-sub { display: flex; flex-wrap: wrap; gap: 8px 32px; }
.run-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px; align-items: start; }
@container dash (max-width: 960px) {
  .run-grid { grid-template-columns: minmax(0, 1fr); }
}
.sec { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sec > p { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.gantt { display: flex; flex-direction: column; gap: 8px; }
.g-row { display: grid; grid-template-columns: 152px minmax(0, 1fr) 96px; gap: 4px 12px; align-items: center; }
.g-lab { display: flex; flex-direction: column; min-width: 0; }
.g-lab span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-track { position: relative; height: 12px; border-radius: 2px; background: var(--line-2); }
.g-span { position: absolute; top: 0; height: 12px; border-radius: 2px; background: var(--merged); }
.g-span.no { background: var(--blocked); }
.g-busy { position: absolute; top: 4px; height: 4px; border-radius: 2px; background: var(--merged-ink); }
.g-span.no + .g-busy { background: var(--blocked-ink); }
.g-num { font-size: 12px; line-height: 16px; color: var(--ink-2); text-align: right; white-space: nowrap; }
.g-axis { display: grid; grid-template-columns: 152px minmax(0, 1fr) 96px; gap: 12px; }
.g-axis div { position: relative; height: 16px; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.g-axis div span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.g-axis div span:first-child { transform: none; }
.g-axis div span:last-child { transform: translateX(-100%); }
@container dash (max-width: 720px) {
  .g-row, .g-axis { grid-template-columns: minmax(0, 1fr) 96px; }
  .g-row .g-track, .g-axis div:nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
  .g-axis div:first-child, .g-axis div:last-child { display: none; }
}
.hb { display: flex; flex-direction: column; gap: 8px; }
.hb-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; align-items: baseline; }
.hb-row .bar { grid-column: 1 / -1; }
.hb-row .bar i { background: var(--meter); }
.hb-l { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hb-v { font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; text-align: right; }

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-styles.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/styles.css ghcp/plugins/swarm-dashboard/tests/ui-styles.test.mjs
git commit -m "feat(swarm-dashboard): add the dashboard stylesheet from the approved mockup"
```

### Task 7: Page composition and shell

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/app.mjs`
- Create: `ghcp/plugins/swarm-dashboard/ui/index.html`
- Create (temporary stubs, replaced by Tasks 12, 13 and 14): `ghcp/plugins/swarm-dashboard/ui/timeline.mjs`, `ghcp/plugins/swarm-dashboard/ui/plan.mjs`, `ghcp/plugins/swarm-dashboard/ui/history.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-app.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–5; from the stubs: `timelineHtml(ctx, span)`, `boardHtml(ctx)`, `historyHtml(runs)`, `runHtml(run)`.
- Produces: `TABS`, `NARROW_BELOW` (900), `isNarrow(dashWidth): boolean` (`dashWidth` is the `.dash` element's `clientWidth`, padding included), `renderApp(view): string`. `view` (PageView): `{ page: 'live'|'history'|'run', tab, detail, span, narrow, loaded, snapshot, swarms, swarm, runs, run, connection: 'connecting'|'open'|'retrying', demo, now, phaseMs, fresh }`; `swarm` is the swarm the page asked for (null means the server's choice); `runs` is null while loading; `run` is null while loading and `false` when unavailable. Stub contracts that Tasks 12–14 keep: `ui/timeline.mjs` exports `SPANS`, `timelineWindow(snapshot, span, now)`, `timelineHtml(ctx, span)` (root `<div class="c" data-timeline>`), `laneSvg`, `axisSvg`, `costSvg`; `ui/plan.mjs` exports `planFits(snapshot, width)`, `planGraphHtml(snapshot, now)`, `planListHtml(snapshot, now)`, `boardHtml(ctx)` (root `<div class="board">`); `ui/history.mjs` exports `historyHtml(runs)` and `runHtml(run)`.

- [ ] **Step 1: Write the failing test**

`tests/ui-app.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isNarrow, renderApp } from '../ui/app.mjs';
import { NOW, deepFreeze, exampleSnapshot, fixture } from './helpers/ui.mjs';

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: exampleSnapshot(),
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides,
});
const tabs = html => [...html.matchAll(/data-tab="(\w+)" aria-selected="(true|false)"/g)].map(match => `${match[1]}${match[2] === 'true' ? '*' : ''}`);

test('narrow mode starts below 900 px of inner width', () => {
  assert.equal(isNarrow(932), false);
  assert.equal(isNarrow(931), true);
});

test('the wide Live page has the header, Needs you, four tabs and the activity rail', () => {
  const html = renderApp(view());
  assert.match(html, /<button type="button" data-page="live" aria-pressed="true">Live<\/button>/);
  assert.match(html, /class="d-head"/);
  assert.match(html, /aria-label="Needs you"/);
  assert.deepEqual(tabs(html), ['cards*', 'timeline', 'plan', 'board']);
  assert.match(html, /<div class="d-body"><div class="d-main">/);
  assert.match(html, /<aside class="d-side"><section class="rail" aria-label="Activity">/);
  assert.match(html, /<span class="small muted">Watch-only<\/span>/);
});

test('narrow mode adds the Activity tab and drops the rail; the detail panel replaces the cards', () => {
  const narrow = renderApp(view({ narrow: true, tab: 'activity' }));
  assert.deepEqual(tabs(narrow), ['cards', 'activity*', 'timeline', 'plan', 'board']);
  assert.match(narrow, /<div class="d-body is-narrow">/);
  assert.doesNotMatch(narrow, /d-side/);
  const detail = renderApp(view({ narrow: true, detail: 'ws-0005-i1' }));
  assert.doesNotMatch(detail, /role="tablist"/);
  assert.match(detail, /← Back to cards/);
});

test('in wide mode the detail panel takes the rail\'s place', () => {
  const html = renderApp(view({ detail: 'ws-0005-i1' }));
  assert.match(html, /<div class="d-body has-detail">/);
  assert.match(html, /<aside class="d-side"><section class="detail" aria-label="Details for I1">/);
  assert.match(html, /class="b-card st-stuck is-sel"/);
});

test('rendering never changes the snapshot, because the live engine hands out its cached object', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  for (const tab of ['cards', 'activity', 'timeline', 'plan', 'board']) {
    for (const narrow of [false, true]) assert.doesNotThrow(() => renderApp(view({ snapshot, tab, narrow })), `${tab}${narrow ? ', narrow' : ''}`);
  }
  assert.doesNotThrow(() => renderApp(view({ snapshot, detail: 'ws-0005-i1' })));
});

test('each tab renders its view container, and Activity falls back to Cards when wide', () => {
  assert.match(renderApp(view({ tab: 'timeline' })), /data-timeline/);
  assert.match(renderApp(view({ tab: 'plan' })), /<div data-plan data-drawn><\/div>/);
  assert.match(renderApp(view({ tab: 'board' })), /class="board"/);
  assert.deepEqual(tabs(renderApp(view({ tab: 'activity' }))), ['cards*', 'timeline', 'plan', 'board']);
});

test('loading, empty and finished states', () => {
  assert.match(renderApp(view({ loaded: false, snapshot: null })), /Reading Copilot data…/);
  assert.match(renderApp(view({ snapshot: null })), /No swarm yet/);
  const finished = exampleSnapshot();
  Object.assign(finished.run, { lifecycle: 'finished', finishedAt: NOW - 3 * 3600000 });
  const html = renderApp(view({ snapshot: finished }));
  assert.match(html, /No live swarm/);
  assert.match(html, /Sample story B finished <span[^>]*>3h ago<\/span>\. Finished runs are in History\./);
  assert.match(html, /data-run="ws-0000-root"/);
  assert.match(renderApp(view({ snapshot: finished, swarm: 'ws-0000-root' })), /class="d-head"/);
});

test('the top bar shows a swarm picker, connection trouble, data warnings and sample data', () => {
  const swarms = fixture('example-swarms.json');
  swarms[1].lifecycle = 'live';
  assert.match(renderApp(view({ swarms })), /<select data-swarm aria-label="Swarm"><option value="ws-0000-root" selected>Sample story B<\/option><option value="ws-1000-root">Sample story A<\/option><\/select>/);
  assert.doesNotMatch(renderApp(view()), /data-swarm/);
  assert.match(renderApp(view({ connection: 'retrying' })), /<span class="small warn">Disconnected · retrying<\/span>/);
  const warned = exampleSnapshot();
  warned.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: 'gh is not signed in.' });
  assert.match(renderApp(view({ snapshot: warned })), /<span class="small muted" title="pr-lookup: gh is not signed in\.">1 data warning<\/span>/);
  assert.match(renderApp(view({ demo: true })), /Sample data · watch-only/);
});

test('history pages keep the History button pressed', () => {
  assert.match(renderApp(view({ page: 'history' })), /data-page="history" aria-pressed="true"/);
  assert.match(renderApp(view({ page: 'run' })), /data-page="history" aria-pressed="true"/);
});

test('the page shell loads only its own stylesheet and module', () => {
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/ui\/styles\.css">/);
  assert.match(html, /<script type="module" src="\/ui\/main\.mjs"><\/script>/);
  assert.match(html, /<main class="dash" id="dash">/);
  assert.doesNotMatch(html, /https?:\/\//);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-app.test.mjs`
Expected: FAIL with `Cannot find module '.../ui/app.mjs'`.

- [ ] **Step 3: Write the stubs that Tasks 12–14 replace**

`ui/timeline.mjs`:

```js
/** Stub until Task 12 replaces this file with the timeline view. */
export const SPANS = Object.freeze({ '3h': 10800000, '12h': 43200000, run: null });
export const timelineWindow = (snapshot, span, now) => ({ t0: now - (SPANS[span] ?? 43200000), t1: now });
export const timelineHtml = () => '<div class="c" data-timeline><p class="none">The timeline is not built yet.</p></div>';
export const laneSvg = () => '';
export const axisSvg = () => '';
export const costSvg = () => '';
```

`ui/plan.mjs`:

```js
/** Stub until Task 13 replaces this file with the Plan and Board views. */
export const planFits = () => false;
export const planGraphHtml = () => '';
export const planListHtml = () => '<p class="none">The plan is not built yet.</p>';
export const boardHtml = () => '<div class="board"><p class="none">The board is not built yet.</p></div>';
```

`ui/history.mjs`:

```js
/** Stub until Task 14 replaces this file with the History views. */
export const historyHtml = () => '<section class="sec" aria-label="Finished runs"><p class="none">History is not built yet.</p></section>';
export const runHtml = () => '<div class="run"><p class="none">The run summary is not built yet.</p></div>';
```

- [ ] **Step 4: Write `ui/app.mjs`**

```js
import { ago, esc } from './format.mjs';
import { historyHtml, runHtml } from './history.mjs';
import { activityHtml, cardsHtml, detailHtml, headerHtml, needsHtml, railHtml } from './live.mjs';
import { boardHtml } from './plan.mjs';
import { timelineHtml } from './timeline.mjs';

export const TABS = Object.freeze({ cards: 'Cards', activity: 'Activity', timeline: 'Timeline', plan: 'Plan', board: 'Board' });
export const NARROW_BELOW = 900;
/** Narrow (side-panel) mode: the dashboard's inner width, its clientWidth minus 2 × 16 px padding, is under 900 px. */
export const isNarrow = dashWidth => dashWidth - 32 < NARROW_BELOW;

/** The whole dashboard for one PageView (see the Task 7 interface). */
export function renderApp(view) {
  const top = topHtml(view);
  if (view.page === 'history') return top + historyHtml(view.runs);
  if (view.page === 'run') return top + runHtml(view.run);
  return top + liveHtml(view);
}

function topHtml(view) {
  const current = view.page === 'run' ? 'history' : view.page;
  const pages = ['live', 'history'].map(page => `<button type="button" data-page="${page}" aria-pressed="${current === page}">${page === 'live' ? 'Live' : 'History'}</button>`).join('');
  return `<div class="d-top"><div class="seg" role="group" aria-label="Dashboard">${pages}</div><div class="d-top-r">${pickerHtml(view)}${statusHtml(view)}</div></div>`;
}

function pickerHtml(view) {
  const live = view.swarms.filter(swarm => swarm.lifecycle === 'live');
  if (view.page !== 'live' || live.length < 2) return '';
  const current = view.snapshot?.run.id ?? view.swarm;
  const options = live.map(swarm => `<option value="${esc(swarm.id)}"${swarm.id === current ? ' selected' : ''}>${esc(swarm.name)}</option>`).join('');
  return `<label class="pick"><span class="small muted">Swarm</span><select data-swarm aria-label="Swarm">${options}</select></label>`;
}

function statusHtml(view) {
  if (view.connection === 'retrying') return '<span class="small warn">Disconnected · retrying</span>';
  const warnings = (view.snapshot?.diagnostics ?? []).filter(entry => entry.level === 'warn');
  const note = warnings.length
    ? `<span class="small muted" title="${esc(warnings.map(entry => `${entry.source}: ${entry.message}`).join('\n'))}">${warnings.length} data warning${warnings.length === 1 ? '' : 's'}</span>`
    : '';
  return `${note}<span class="small muted">${view.demo ? 'Sample data · watch-only' : 'Watch-only'}</span>`;
}

function liveHtml(view) {
  const { snapshot } = view;
  if (!view.loaded) return '<p class="none">Reading Copilot data…</p>';
  if (!snapshot) return '<div class="empty"><h3>No swarm yet</h3><p class="small muted">A session that starts child sessions shows up here as a swarm.</p></div>';
  if (snapshot.run.lifecycle === 'finished' && !view.swarm) {
    const at = snapshot.run.finishedAt ?? snapshot.run.lastActivityAt;
    return `<div class="empty"><h3>No live swarm</h3><p class="small muted">${esc(snapshot.run.name)} finished ${ago(at, view.now)}. Finished runs are in History.</p>`
      + `<button type="button" class="link" data-run="${esc(snapshot.run.id)}">Open its summary</button></div>`;
  }
  const ctx = { snapshot, now: view.now, phaseMs: view.phaseMs, detail: view.detail, fresh: view.fresh };
  return headerHtml(ctx) + needsHtml(ctx) + bodyHtml(view, ctx);
}

function bodyHtml(view, ctx) {
  const tabs = ['cards', ...(view.narrow ? ['activity'] : []), 'timeline', 'plan', 'board'];
  const tab = tabs.includes(view.tab) ? view.tab : 'cards';
  const main = view.narrow && view.detail
    ? detailHtml(view.detail, true, ctx)
    : `<div class="tabs" role="tablist" aria-label="Live views">${tabs.map(name => `<button type="button" role="tab" data-tab="${name}" aria-selected="${tab === name}">${TABS[name]}</button>`).join('')}</div><div class="tab-body">${tabBody(tab, view, ctx)}</div>`;
  const side = view.narrow ? '' : `<aside class="d-side">${view.detail ? detailHtml(view.detail, false, ctx) : railHtml(ctx)}</aside>`;
  return `<div class="d-body${view.narrow ? ' is-narrow' : view.detail ? ' has-detail' : ''}"><div class="d-main">${main}</div>${side}</div>`;
}

function tabBody(tab, view, ctx) {
  if (tab === 'activity') return activityHtml(ctx);
  if (tab === 'timeline') return timelineHtml(ctx, view.span);
  if (tab === 'plan') return '<div data-plan data-drawn></div>';
  if (tab === 'board') return boardHtml(ctx);
  return cardsHtml(ctx);
}
```

- [ ] **Step 5: Write `ui/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm dashboard</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/ui/styles.css">
<script type="module" src="/ui/main.mjs"></script>
</head>
<body>
<main class="dash" id="dash"><p class="none">Reading Copilot data…</p></main>
</body>
</html>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-app.test.mjs`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui ghcp/plugins/swarm-dashboard/tests/ui-app.test.mjs
git commit -m "feat(swarm-dashboard): compose the Live and History pages"
```

### Task 8: Demo engine and scenarios

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/server/demo-engine.mjs`
- Create: `ghcp/plugins/swarm-dashboard/server/demo-scenarios.mjs`
- Create: `ghcp/plugins/swarm-dashboard/server/engines.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/demo-engine.test.mjs`

**Interfaces:**
- Consumes: `createFakeEngine` (`engine/fake-engine.mjs`), `validate*` (`engine/schema.mjs`, tests), PR 1's fixtures in `tests/fixtures/example-*.json`.
- Produces: `loadFixtures(dir?): { snapshots, swarms, history, summaries }`; `shiftTimes(value, delta)` (moves every epoch-ms field named `at`, `since`, `start`, `end` or `*At`); `simulateStep(snapshot, now, random = Math.random): Snapshot` (pure: returns a changed copy); `createDemoEngine({ scenario = 'example' | 'stress', now = Date.now, simulate = true, random = Math.random, stepMs = 4000, fixtures }): SwarmEngine & { isDemo: true, step() }` (simulation runs only between `start()` and `stop()`); `stressScenario(fixtures)`; `createDefaultEngine(options): SwarmEngine` in `server/engines.mjs` (the demo engine until Task 20).

- [ ] **Step 1: Write the failing test**

`tests/demo-engine.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { createDemoEngine, loadFixtures, shiftTimes, simulateStep } from '../server/demo-engine.mjs';
import { createDefaultEngine } from '../server/engines.mjs';

const seeded = seed => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const example = () => loadFixtures().snapshots[0];

test('times move to the present and durations stay as they are', () => {
  const base = example();
  const shifted = shiftTimes(base, 1000);
  assert.equal(shifted.generatedAt, base.generatedAt + 1000);
  assert.equal(shifted.units[0].timeline.segments[0].start, base.units[0].timeline.segments[0].start + 1000);
  assert.equal(shifted.feed[0].at, base.feed[0].at + 1000);
  assert.equal(shifted.needs[0].since, base.needs[0].since + 1000);
  assert.equal(shifted.units[0].busyMs, base.units[0].busyMs);
  assert.equal(shifted.units[0].monitor.everyMinutes, base.units[0].monitor.everyMinutes);
  assert.deepEqual(validateSnapshot(shifted), []);
});

test('the demo engine serves valid, current data through the engine API', async () => {
  const engine = createDemoEngine({ now: () => T, simulate: false });
  assert.equal(engine.isDemo, true);
  const snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.generatedAt, T);
  assert.deepEqual(engine.listSwarms().flatMap(validateSwarmListItem), []);
  assert.deepEqual((await engine.listHistory()).flatMap(validateRunListItem), []);
  const summary = await engine.getRunSummary('ws-1000-root');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.ok(summary.finishedAt < T);
  assert.equal(await engine.findSwarm('cli-0003-b1'), 'ws-0000-root');
});

test('simulated steps stay valid, add cost and keep feed ids unique', () => {
  const base = example();
  let snapshot = shiftTimes(base, T - base.generatedAt);
  const random = seeded(7);
  for (let step = 1; step <= 40; step += 1) {
    snapshot = simulateStep(snapshot, T + step * 5000, random);
    assert.deepEqual(validateSnapshot(snapshot), [], `step ${step}`);
  }
  assert.ok(snapshot.cost.credits > base.cost.credits);
  assert.equal(snapshot.revision, base.revision + 40);
  assert.equal(new Set(snapshot.feed.map(item => item.id)).size, snapshot.feed.length);
  const series = snapshot.cost.series;
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index].at > series[index - 1].at, 'series times increase');
    assert.ok(series[index].credits >= series[index - 1].credits, 'series is cumulative');
  }
});

test('a due PR monitor check lands in the feed and the unit\'s recent items', () => {
  const base = example();
  const due = base.units.find(unit => unit.label === 'D5').monitor.nextCheckAt + 1000;
  const next = simulateStep(base, due, () => 0.99);
  const d5 = next.units.find(unit => unit.label === 'D5');
  assert.equal(d5.monitor.lastCheckAt, due);
  assert.equal(d5.monitor.nextCheckAt, due + 10 * 60000);
  assert.equal(next.feed[0].kind, 'monitor-check');
  assert.equal(d5.recent[0].id, next.feed[0].id);
});

test('activity is simulated only between start() and stop()', async () => {
  const engine = createDemoEngine({ stepMs: 10, random: seeded(3) });
  const changes = [];
  engine.subscribe(change => changes.push(change));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(changes.length, 0, 'no timers before start()');
  engine.start();
  await new Promise(resolve => setTimeout(resolve, 80));
  engine.stop();
  const seen = changes.length;
  assert.ok(seen >= 2, `saw ${seen} changes`);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(changes.length, seen);
  const still = createDemoEngine({ simulate: false, stepMs: 10 });
  const none = [];
  still.subscribe(change => none.push(change));
  still.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  still.stop();
  assert.equal(none.length, 0);
});

test('the stress scenario is valid and covers every status, a stalled run, a warning and two live swarms', async () => {
  const engine = createDemoEngine({ scenario: 'stress', now: () => T, simulate: false });
  const snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  const statuses = new Set(snapshot.units.map(unit => unit.status));
  for (const status of ['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'archived']) assert.ok(statuses.has(status), status);
  assert.ok(snapshot.run.stalled);
  assert.ok(snapshot.diagnostics.some(entry => entry.level === 'warn'));
  assert.ok(snapshot.units.some(unit => unit.label.length > 4));
  assert.deepEqual(snapshot.units.filter(unit => unit.label.length === 4).map(unit => unit.label), ['C6-1', 'MM-1']);
  const closed = snapshot.units.find(unit => unit.label === 'C6-1');
  assert.deepEqual([closed.stage, closed.closedWithoutMerge, closed.pr.state, closed.monitor.state], ['pr_open', true, 'closed', 'ended']);
  assert.ok(snapshot.units.some(unit => unit.subagents.filter(sub => sub.status === 'running').length >= 6));
  assert.equal(engine.listSwarms().filter(swarm => swarm.lifecycle === 'live').length, 2);
  assert.throws(() => createDemoEngine({ scenario: 'nope' }), /scenario/);
});

test('every reference in a scenario swarm points inside that swarm', async () => {
  for (const scenario of ['example', 'stress']) {
    const engine = createDemoEngine({ scenario, now: () => T, simulate: false });
    for (const { id } of engine.listSwarms()) {
      const snapshot = await engine.getSnapshot(id);
      if (!snapshot) continue;
      const ids = new Set([snapshot.orchestrator.id, ...snapshot.units.map(unit => unit.id)]);
      const refs = [
        ...snapshot.feed.map(item => item.unitId),
        ...snapshot.needs.flatMap(need => [need.fromId, ...need.unitIds]),
        ...snapshot.units.flatMap(unit => [unit.parentId, ...unit.recent.map(item => item.unitId)]),
      ];
      for (const ref of refs) assert.ok(ids.has(ref), `${scenario}, ${id}: ${ref}`);
    }
  }
});

test('the default engine is the demo engine until PR 1\'s engine is in', () => {
  assert.equal(createDefaultEngine({ log: () => {} }).isDemo, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/demo-engine.test.mjs`
Expected: FAIL with `Cannot find module '.../server/demo-engine.mjs'`.

- [ ] **Step 3: Write `server/demo-engine.mjs`**

```js
import { readFileSync } from 'node:fs';
import { createFakeEngine } from '../engine/fake-engine.mjs';
import { stressScenario } from './demo-scenarios.mjs';

const FIXTURES = new URL('../tests/fixtures/', import.meta.url);
const TIME_KEY = /^(at|since|start|end)$|At$/;
const MIN = 60000;
const BUCKET = 5 * MIN;
const SCENARIOS = ['example', 'stress'];
const AGENTS = [['explore', 'gpt-5.4-mini', 'Map the module'], ['task', 'claude-haiku-5.5', 'Run the test suite'], ['code-review', 'claude-sonnet-5', 'Review the diff']];
const REPORTS = ['Review fixes pushed.', 'Tests pass on the branch.', 'Edge cases are covered.', 'Docs updated for the new endpoint.'];
const round1 = value => Math.round(value * 10) / 10;

/** PR 1's synthetic example swarm, swarm list, history and run summary. */
export function loadFixtures(dir = FIXTURES) {
  const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  return {
    snapshots: [read('example-snapshot.json')],
    swarms: read('example-swarms.json'),
    history: read('example-history.json'),
    summaries: [read('example-run-summary.json')],
  };
}

/** A copy with every epoch-millisecond time moved by delta. Durations are never epoch values, so they stay. */
export function shiftTimes(value, delta) {
  if (Array.isArray(value)) return value.map(item => shiftTimes(item, delta));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = TIME_KEY.test(key) && Number.isInteger(item) && item > 1e12 ? item + delta : shiftTimes(item, delta);
  }
  return out;
}

function addFeed(snapshot, session, kind, text, now) {
  const item = { id: `${session.id}:${kind}:demo-${snapshot.revision}`, at: now, unitId: session.id, label: session.label, kind, text };
  snapshot.feed = [item, ...snapshot.feed].slice(0, 200);
  session.recent = [item, ...session.recent].slice(0, 6);
  session.lastEventAt = now;
  session.activity.lastEventAt = now;
}

function addCost(snapshot, session, amount, now) {
  session.cost.credits = round1(session.cost.credits + amount);
  session.cost.calls += 1;
  const cost = snapshot.cost;
  cost.credits = round1(cost.credits + amount);
  cost.usd = Math.round(cost.credits) / 100;
  cost.maxUnitCredits = Math.max(0, ...snapshot.units.map(unit => unit.cost.credits));
  const model = cost.byModel.find(entry => entry.model === session.model);
  if (model) {
    model.credits = round1(model.credits + amount);
    model.calls += 1;
  }
  const bucket = now - (now % BUCKET);
  const last = cost.series[cost.series.length - 1];
  if (last && bucket <= last.at) last.credits = cost.credits;
  else cost.series.push({ at: bucket, credits: cost.credits });
}

function startSubagent(snapshot, session, [type, model, task], now) {
  const id = `demo-call-${snapshot.revision}`;
  session.subagents.unshift({ id, name: task.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type, model, mode: 'background', status: 'running', startedAt: now, endedAt: null, durationMs: null, credits: 0, task });
  session.timeline.subagents.push({ id, start: now, end: null, type });
  addFeed(snapshot, session, 'subagent-start', `started ${type}: ${task.toLowerCase()}`, now);
}

function finishSubagent(snapshot, session, sub, credits, now) {
  Object.assign(sub, { status: 'completed', endedAt: now, durationMs: now - sub.startedAt, credits });
  const running = session.subagents.filter(item => item.status === 'running');
  const done = session.subagents.filter(item => item.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  session.subagents = [...running, ...done];
  const bar = session.timeline.subagents.find(item => item.id === sub.id);
  if (bar) bar.end = now;
  addCost(snapshot, session, credits, now);
  addFeed(snapshot, session, 'subagent-done', `${sub.type} finished`, now);
}

function addReport(snapshot, session, text, now) {
  session.report = { status: 'progress', source: 'contract', at: now, title: text, summary: text, evidence: ['Tests pass on the branch'], blockers: [], body: null, unit: session.label, commit: null };
  if (session.progress && session.progress.done < session.progress.total) session.progress.done += 1;
  session.timeline.marks.push({ at: now, kind: 'report', text, status: 'progress' });
  addFeed(snapshot, session, 'report', `reported progress: ${text}`, now);
}

function checkMonitor(snapshot, unit, now) {
  const monitor = unit.monitor;
  if (monitor.state !== 'alive' || !monitor.nextCheckAt || monitor.nextCheckAt > now) return;
  monitor.lastCheckAt = now;
  monitor.nextCheckAt = now + (monitor.everyMinutes ?? 10) * MIN;
  unit.timeline.marks.push({ at: now, kind: 'monitor', text: 'PR monitor check', status: null });
  addFeed(snapshot, unit, 'monitor-check', 'PR monitor check', now);
}

/** One simulated step: due monitor checks, cost on an active session, and sometimes a sub-agent change or a report. */
export function simulateStep(snapshot, now, random = Math.random) {
  const next = structuredClone(snapshot);
  const pick = list => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  next.generatedAt = now;
  next.revision += 1;
  next.run.lastActivityAt = now;
  for (const unit of next.units) checkMonitor(next, unit, now);
  const active = [next.orchestrator, ...next.units].filter(session => session.status === 'busy' || session.subagents.some(sub => sub.status === 'running'));
  if (!active.length) return next;
  const session = pick(active);
  addCost(next, session, 20 + Math.round(random() * 130), now);
  const running = session.subagents.filter(sub => sub.status === 'running');
  const roll = random();
  if (roll < 0.3 && running.length < 2) startSubagent(next, session, pick(AGENTS), now);
  else if (roll < 0.55 && running.length) finishSubagent(next, session, running[running.length - 1], 30 + Math.round(random() * 400), now);
  else if (roll < 0.7 && session !== next.orchestrator && session.status === 'busy') addReport(next, session, pick(REPORTS), now);
  return next;
}

/**
 * A SwarmEngine over synthetic data with times moved to the present, so clocks and ages look live. It never reads
 * Copilot data. With simulate, start() changes the first swarm every stepMs; stop() ends that.
 */
export function createDemoEngine({ scenario = 'example', now = Date.now, simulate = true, random = Math.random, stepMs = 4000, fixtures = loadFixtures() } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown demo scenario: ${scenario}`);
  const base = scenario === 'stress' ? stressScenario(fixtures) : fixtures;
  const data = shiftTimes(base, now() - base.snapshots[0].generatedAt);
  const fake = createFakeEngine(data);
  let current = data.snapshots[0];
  let timer = null;
  const step = () => {
    current = simulateStep(current, now(), random);
    fake.push(current);
    return current;
  };
  return {
    ...fake,
    isDemo: true,
    step,
    start() {
      if (!simulate || timer) return;
      timer = setInterval(step, stepMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
```

- [ ] **Step 4: Write `server/engines.mjs`**

```js
/**
 * The engine behind the launcher and the canvas. Until PR 1's engine/engine.mjs is on this branch it is the synthetic
 * demo engine; Task 20 switches it to Copilot's data by replacing the export below with:
 *   export { createSwarmEngine as createDefaultEngine } from '../engine/engine.mjs';
 */
export { createDemoEngine as createDefaultEngine } from './demo-engine.mjs';
```

- [ ] **Step 5: Write `server/demo-scenarios.mjs`**

```js
const MIN = 60000;
const round1 = value => Math.round(value * 10) / 10;
const BUCKETS = ['working', 'stuck', 'waiting', 'idle', 'done', 'failed'];
const SEGMENT = { busy: 'busy', idle: 'idle', plan: 'plan', question: 'question', stuck: 'stuck' };
const TYPES = ['explore', 'task', 'code-review', 'rubber-duck', 'research', 'general-purpose'];
/**
 * Extra units for the stress scenario: every status detail, long names and labels (C6-1 fits its ring whole, MM-1 does
 * not), crowded chips, a PR closed without merging and a deep plan.
 */
const EXTRA = [
  { label: 'Q1', name: 'Export format questions for the reporting service, with a name long enough to need an ellipsis', status: 'question', statusDetail: 'waiting_question', bucket: 'waiting', stage: 'pr_open', dependsOn: 'B1' },
  { label: 'S2', name: 'retry loop', status: 'stuck', statusDetail: 'spinning', bucket: 'stuck', reason: 'Spinning rule: 6 failed tool calls within 30 busy minutes.', dependsOn: 'Q1' },
  { label: 'X3', name: 'crashed worker', status: 'blocked', statusDetail: 'crashed', bucket: 'failed', reason: 'Ended rule: the process is gone, with no shutdown event and a turn still open.', alive: false, dependsOn: 'S2' },
  { label: 'P4', name: 'paused monitor', status: 'idle', statusDetail: 'idle', bucket: 'idle', stage: 'in_review', monitor: 'paused', dependsOn: 'X3' },
  { label: 'N5', name: 'no report and no task list', status: 'busy', statusDetail: 'busy', bucket: 'working', report: null, progress: null, dependsOn: 'P4' },
  { label: 'C6', name: 'crowded chips', status: 'busy', statusDetail: 'slow_model_call', bucket: 'working', crowd: 7 },
  { label: 'REPORTING-SERVICE', name: 'a label longer than the ring', status: 'stuck', statusDetail: 'stuck_subagent', bucket: 'stuck', reason: 'Sub-agent rule: code-review has had no events for 14 min (limit 10 min).', stuckSubagent: true },
  { label: 'R8', name: 'blocked report', status: 'blocked', statusDetail: 'blocked', bucket: 'waiting', reportStatus: 'blocked' },
  { label: 'M9', name: 'merged after review', status: 'merged', statusDetail: 'merged', bucket: 'done', stage: 'merged', outcome: 'merged' },
  { label: 'C6-1', name: 'closed without merging', status: 'idle', statusDetail: 'idle', bucket: 'idle', stage: 'pr_open', outcome: 'closed' },
  { label: 'MM-1', name: 'a four-character label too wide for its ring', status: 'idle', statusDetail: 'idle', bucket: 'idle' },
];

function monitorFor(spec, stage, t) {
  if (spec.monitor === 'paused') return { state: 'paused', lastCheckAt: t - 70 * MIN, nextCheckAt: null, everyMinutes: 10, since: t - 50 * MIN };
  if (stage === 'merged' || spec.outcome === 'closed') return { state: 'ended', lastCheckAt: t - 25 * MIN, nextCheckAt: null, everyMinutes: 10, since: null };
  if (stage === 'coding') return { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null };
  return { state: 'alive', lastCheckAt: t - 4 * MIN, nextCheckAt: t + 6 * MIN, everyMinutes: 10, since: null };
}

function subagentsFor(spec, n, t) {
  const make = (k, status, type) => ({
    id: `call-90${n}-${k}`, name: `helper-${k + 1}`, type, model: 'gpt-5.4-mini', mode: 'background', status,
    startedAt: t - (k + 1) * 3 * MIN, endedAt: null, durationMs: null, credits: 10 + k, task: `Background check ${k + 1}`,
  });
  if (spec.crowd) return Array.from({ length: spec.crowd }, (_, k) => make(k, 'running', TYPES[k % TYPES.length]));
  if (spec.stuckSubagent) return [make(0, 'stuck', 'code-review')];
  return [];
}

function stressUnit(template, spec, index, t, parentId) {
  const n = String(index + 1).padStart(2, '0');
  const unit = structuredClone(template);
  const stage = spec.stage ?? 'coding';
  const startedAt = t - (240 + index * 30) * MIN;
  const lastEventAt = t - (1 + index) * MIN;
  const endedAt = spec.outcome ? t - 20 * MIN : spec.alive === false ? lastEventAt : null;
  Object.assign(unit, {
    id: `ws-90${n}-stress`, label: spec.label, name: spec.name, cliSessionIds: [`cli-90${n}-stress`], branch: `feature/stress-${n}`,
    status: spec.status, statusDetail: spec.statusDetail, bucket: spec.bucket, since: t - (5 + index * 7) * MIN, reason: spec.reason ?? null,
    startedAt, endedAt, lastEventAt, alive: spec.alive ?? true, cost: { credits: round1(1500 + index * 2333.3), calls: 100 + index * 10 },
    parentId, depth: 1, stage, closedWithoutMerge: spec.outcome === 'closed', outcome: spec.outcome ?? null, dependsOn: spec.dependsOn ?? null, todoId: null,
  });
  unit.pr = stage === 'coding' ? null : {
    ...template.pr, id: 500 + index, title: `${spec.name} PR`, url: `https://github.com/sample-org/sample-repo/pull/${500 + index}`,
    state: spec.outcome === 'closed' ? 'closed' : stage === 'merged' ? 'merged' : stage === 'pr_open' ? 'draft' : 'open', openedAt: t - 90 * MIN,
    mergedAt: stage === 'merged' ? endedAt : null, closedAt: stage === 'merged' || spec.outcome === 'closed' ? endedAt : null,
  };
  unit.monitor = monitorFor(spec, stage, t);
  unit.report = 'report' in spec ? spec.report : {
    status: spec.reportStatus ?? 'progress', source: 'contract', at: t - (3 + index) * MIN,
    title: `${spec.name}: a progress report long enough to need an ellipsis on a narrow card`, summary: `${spec.name}: work continues on the branch.`,
    evidence: ['Unit tests pass'], blockers: spec.reportStatus === 'blocked' ? ['Waiting for the parent branch to merge'] : [], body: null, unit: spec.label, commit: null,
  };
  if ('progress' in spec) unit.progress = spec.progress;
  unit.subagents = subagentsFor(spec, n, t);
  unit.activity = { label: spec.status === 'busy' ? 'Working on the branch' : 'Waiting', tool: null, lastEventAt };
  unit.timeline = {
    segments: [{ start: startedAt, end: t - 60 * MIN, state: 'busy' }, { start: t - 60 * MIN, end: endedAt, state: SEGMENT[spec.status] ?? 'idle' }],
    subagents: unit.subagents.map(sub => ({ id: sub.id, start: sub.startedAt, end: sub.endedAt, type: sub.type })),
    marks: unit.report ? [{ at: unit.report.at, kind: 'report', text: unit.report.title, status: unit.report.status }] : [],
  };
  unit.recent = [unit.report
    ? { id: `${unit.id}:report:stress`, at: unit.report.at, unitId: unit.id, label: unit.label, kind: 'report', text: `reported ${unit.report.status}: ${unit.report.title}` }
    : { id: `${unit.id}:plan-ok:stress`, at: t - 30 * MIN, unitId: unit.id, label: unit.label, kind: 'plan-ok', text: 'plan approved' }];
  return unit;
}

/**
 * A crowded synthetic swarm for layout checks, built from the example fixtures so it stays inside the schema: every
 * status and status detail, long names and labels, crowded chips, missing reports and task lists, an eight-level plan,
 * a stalled run, a data warning and a second live swarm for the picker.
 */
export function stressScenario(fixtures) {
  const example = fixtures.snapshots[0];
  const snapshot = structuredClone(example);
  const t = snapshot.generatedAt;
  const template = snapshot.units.find(unit => unit.label === 'B1');
  const extra = EXTRA.map((spec, index) => stressUnit(template, spec, index, t, snapshot.orchestrator.id));
  snapshot.units.push(...extra);
  snapshot.planned.push({ label: 'Z10', name: 'final clean-up once everything else has merged', dependsOn: 'N5', canStart: false, waitsOn: 'N5', todoId: null });
  snapshot.needs.push(
    { id: 'stress:need:question', kind: 'question', unitIds: [], labels: [], fromId: snapshot.orchestrator.id, text: 'Should the export keep the old CSV column order for existing users, or move everyone to the new order at once?', since: t - 95 * MIN, tagged: true },
    { id: 'stress:need:pr', kind: 'pr', unitIds: [extra[0].id], labels: [extra[0].label], fromId: snapshot.orchestrator.id, text: 'Publish PR #500 for review?', since: t - 12 * MIN, tagged: true },
  );
  snapshot.needs.sort((a, b) => a.since - b.since);
  snapshot.run.stalled = { since: t - 32 * MIN, reason: 'Swarm rule: the orchestrator and every open child are idle, and no monitor is due.' };
  snapshot.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: 'gh is not signed in, so GitHub PR states are not known.' });
  snapshot.feed = [...extra.flatMap(unit => unit.recent), ...snapshot.feed].sort((a, b) => b.at - a.at).slice(0, 200);
  snapshot.counts = Object.fromEntries(BUCKETS.map(bucket => [bucket, snapshot.units.filter(unit => unit.bucket === bucket).length]));
  const added = round1(extra.reduce((sum, unit) => sum + unit.cost.credits, 0));
  snapshot.cost.credits = round1(snapshot.cost.credits + added);
  snapshot.cost.usd = Math.round(snapshot.cost.credits) / 100;
  snapshot.cost.maxUnitCredits = Math.max(...snapshot.units.map(unit => unit.cost.credits));
  const model = snapshot.cost.byModel.find(entry => entry.model === template.model);
  if (model) model.credits = round1(model.credits + added);
  const last = snapshot.cost.series[snapshot.cost.series.length - 1];
  snapshot.cost.series.push({ at: last.at + 5 * MIN, credits: snapshot.cost.credits });

  // A second live swarm for the picker: the example under new ids everywhere, so every reference stays inside it.
  const other = JSON.parse(JSON.stringify(example).replace(/\b(ws|cli)-0(\d{3})-/g, '$1-8$2-'));
  other.run = { ...other.run, name: 'Sample story C', lastActivityAt: t - 40 * MIN };
  other.orchestrator = { ...other.orchestrator, label: 'SC', name: 'Sample story C' };
  return { snapshots: [snapshot, other], swarms: null, history: fixtures.history, summaries: fixtures.summaries };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/demo-engine.test.mjs`
Expected: PASS, 8 tests. If the stress snapshot fails validation, the validator's message names the field path; fix the scenario, not the schema.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/server ghcp/plugins/swarm-dashboard/tests/demo-engine.test.mjs
git commit -m "feat(swarm-dashboard): add a demo engine with example and stress scenarios"
```

### Task 9: HTTP server, assets and live hub

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/server/assets.mjs`
- Create: `ghcp/plugins/swarm-dashboard/server/hub.mjs`
- Create: `ghcp/plugins/swarm-dashboard/server/http.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/http.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/server.test.mjs`

**Interfaces:**
- Consumes: a `createEngine(): SwarmEngine` factory (the schema's engine API, including `findSwarm`).
- Produces: `loadAssets(dir?): Map<urlPath, { type, body }>` (only `/index.html` and `/ui/<file>` for `.html`, `.css` and `.mjs` files in `ui/`); `createHub({ createEngine, now, intervalMs = 3000, engineIdleMs = 300000, heartbeatMs = 15000, log, onIdle }): { add(req, res, { swarm, session }), withEngine(fn), clientCount(), hasEngine(), close() }`; `APP_ID = 'swarm-dashboard'`; `createDashboardServer({ createEngine, host = '127.0.0.1', port = 0, version, now, log, hub, onIdle }): { listen(): Promise<url>, close(): Promise<void>, url, port, clientCount() }`.
- HTTP API: `GET /` (page), `GET /ui/<file>`, `GET /api/health` → `{ app, version, pid, startedAt }`, `GET /api/events?swarm=<id>|session=<id>` (SSE events `hello` `{ serverNow, demo }`, `swarms` `SwarmListItem[]`, `snapshot` `{ serverNow, snapshot }`), `GET /api/swarms`, `GET /api/snapshot?swarm=<id>`, `GET /api/history`, `GET /api/runs/<id>` (404 when unknown).
- Engine lifetime: created by the first SSE client or API call; `refresh()` once, then `start({ intervalMs })` while a page is connected; `stop()` when the last page leaves; dropped `engineIdleMs` later, which then calls `onIdle()`. A page that asked for no swarm stays on the first swarm it was shown (pinned per connection); a page opened from a session that is in no swarm yet shows the default unpinned and switches to the session's swarm once `findSwarm` finds it (an orchestrator may open the canvas just as it creates its first child).
- `tests/helpers/http.mjs` produces `get(port, path, headers?)` → `{ status, headers, body }`, `openEvents(port, path)` → `{ events, waitFor(predicate, timeoutMs?), close() }`, and `freePort()`.

- [ ] **Step 1: Write the test helper**

`tests/helpers/http.mjs`:

```js
import { createServer, request } from 'node:http';

/** GET with any Host header (fetch forbids setting Host). */
export function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A Server-Sent Events client that collects { event, data } entries. */
export function openEvents(port, path) {
  const events = [];
  let buffer = '';
  const req = request({ host: '127.0.0.1', port, path }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: JSON.parse(data) });
      }
    });
  });
  req.on('error', () => {});
  req.end();
  async function waitFor(predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`no matching event in ${JSON.stringify(events.map(entry => entry.event))}`);
  }
  return { events, waitFor, close: () => req.destroy() };
}

/** A port that was free a moment ago. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 2: Write the failing test**

`tests/server.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../engine/fake-engine.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { loadAssets } from '../server/assets.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { get, openEvents } from './helpers/http.mjs';
import { deepFreeze, exampleSnapshot, fixture } from './helpers/ui.mjs';

function spyEngine() {
  const fake = createFakeEngine({ snapshots: [exampleSnapshot()], swarms: fixture('example-swarms.json'), history: fixture('example-history.json'), summaries: [fixture('example-run-summary.json')] });
  const calls = { created: 0, refresh: 0, start: 0, stop: 0 };
  const engine = { ...fake, async refresh() { calls.refresh += 1; }, start() { calls.start += 1; }, stop() { calls.stop += 1; } };
  return { calls, fake, createEngine: () => { calls.created += 1; return engine; } };
}

async function started(createEngine, options = {}) {
  const server = createDashboardServer({ createEngine, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 }, ...options });
  await server.listen();
  return server;
}

test('only the files in ui/ are served', () => {
  const assets = loadAssets();
  assert.ok(assets.has('/index.html'));
  assert.equal(assets.get('/ui/styles.css').type, 'text/css; charset=utf-8');
  assert.equal(assets.get('/ui/app.mjs').type, 'text/javascript; charset=utf-8');
  for (const path of assets.keys()) assert.match(path, /^\/(index\.html|ui\/[\w.-]+\.(css|mjs|html))$/);
});

test('the page, its assets and health answer only to the dashboard\'s own host', async () => {
  const { createEngine, calls } = spyEngine();
  const server = await started(createEngine);
  try {
    const page = await get(server.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /id="dash"/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(server.port, '/ui/styles.css')).status, 200);
    assert.equal((await get(server.port, '/ui/../engine/schema.mjs')).status, 404);
    assert.equal((await get(server.port, '/engine/schema.mjs')).status, 404);
    const health = JSON.parse((await get(server.port, '/api/health')).body);
    assert.deepEqual({ app: health.app, version: health.version }, { app: 'swarm-dashboard', version: 'test' });
    assert.equal((await get(server.port, '/', { Host: 'evil.example' })).status, 403);
    assert.equal((await get(server.port, '/', { Host: `attacker.example:${server.port}` })).status, 403);
    assert.equal((await get(server.port, '/', { Host: `localhost:${server.port}` })).status, 200);
    assert.equal(calls.created, 0, 'serving the page creates no engine');
  } finally {
    await server.close();
  }
});

test('other methods are refused', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  try {
    const response = await fetch(`${server.url}api/health`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  } finally {
    await server.close();
  }
});

test('API calls create the engine on demand and drop it when idle', async () => {
  const { createEngine, calls } = spyEngine();
  let idle = 0;
  const server = await started(createEngine, { onIdle: () => { idle += 1; } });
  try {
    const history = JSON.parse((await get(server.port, '/api/history')).body);
    assert.equal(history.length, 2);
    assert.equal(calls.created, 1);
    assert.equal(calls.refresh, 1);
    assert.equal(calls.start, 0, 'no polling without a connected page');
    assert.equal(JSON.parse((await get(server.port, '/api/runs/ws-1000-root')).body).id, 'ws-1000-root');
    assert.equal((await get(server.port, '/api/runs/nope')).status, 404);
    const { snapshot } = JSON.parse((await get(server.port, '/api/snapshot')).body);
    assert.equal(snapshot.run.id, 'ws-0000-root');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(idle, 1);
    await get(server.port, '/api/swarms');
    assert.equal(calls.created, 2, 'a new engine after the old one was dropped');
  } finally {
    await server.close();
  }
});

test('a page gets hello, swarms and its snapshot, then pushes only for its swarm', async () => {
  const { createEngine, calls, fake } = spyEngine();
  const server = await started(createEngine);
  const page = openEvents(server.port, '/api/events');
  try {
    const hello = await page.waitFor(entry => entry.event === 'hello');
    assert.equal(hello.data.demo, false);
    assert.equal((await page.waitFor(entry => entry.event === 'swarms')).data.length, 2);
    const first = await page.waitFor(entry => entry.event === 'snapshot');
    assert.deepEqual(validateSnapshot(first.data.snapshot), []);
    assert.equal(calls.start, 1);
    const changed = exampleSnapshot();
    changed.revision += 1;
    changed.run.name = 'Renamed';
    fake.push(changed);
    const second = await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot.revision === changed.revision);
    assert.equal(second.data.snapshot.run.name, 'Renamed');
    const other = exampleSnapshot();
    other.run.id = 'ws-other';
    fake.push(other);
    await page.waitFor(entry => entry.event === 'swarms' && entry.data.some(swarm => swarm.id === 'ws-other'));
    assert.equal(page.events.filter(entry => entry.event === 'snapshot').length, 2);
  } finally {
    page.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.stop >= 1, true, 'polling stops when the last page leaves');
    await server.close();
  }
});

test('a page can ask for a swarm by id or by one of its sessions', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  const byId = openEvents(server.port, '/api/events?swarm=missing');
  const bySession = openEvents(server.port, '/api/events?session=cli-0003-b1');
  try {
    assert.equal((await byId.waitFor(entry => entry.event === 'snapshot')).data.snapshot, null);
    assert.equal((await bySession.waitFor(entry => entry.event === 'snapshot')).data.snapshot.run.id, 'ws-0000-root');
  } finally {
    byId.close();
    bySession.close();
    await server.close();
  }
});

test('the server never changes the snapshot objects the engine hands out', async () => {
  const fake = createFakeEngine({ snapshots: [exampleSnapshot()], swarms: fixture('example-swarms.json') });
  const frozen = deepFreeze(exampleSnapshot());
  const engine = { ...fake, getSnapshot: async () => frozen, findSwarm: async () => frozen.run.id };
  const server = await started(() => engine);
  const page = openEvents(server.port, '/api/events?session=cli-0003-b1');
  try {
    assert.deepEqual((await page.waitFor(entry => entry.event === 'snapshot')).data.snapshot, exampleSnapshot());
    assert.deepEqual(JSON.parse((await get(server.port, '/api/snapshot')).body).snapshot, exampleSnapshot());
  } finally {
    page.close();
    await server.close();
  }
});

test('a page opened from a session outside any swarm follows that session once it joins one', async () => {
  const { createEngine, fake } = spyEngine();
  const server = await started(createEngine);
  const page = openEvents(server.port, '/api/events?session=cli-new');
  try {
    assert.equal((await page.waitFor(entry => entry.event === 'snapshot')).data.snapshot.run.id, 'ws-0000-root');
    const joined = exampleSnapshot();
    joined.run.id = 'ws-new';
    joined.orchestrator.cliSessionIds = ['cli-new'];
    fake.push(joined);
    await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot.run.id === 'ws-new');
  } finally {
    page.close();
    await server.close();
  }
});

test('close ends live connections and frees the port', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  const port = server.port;
  const page = openEvents(port, '/api/events');
  await page.waitFor(entry => entry.event === 'snapshot');
  await server.close();
  await assert.rejects(get(port, '/api/health'));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/server.test.mjs`
Expected: FAIL with `Cannot find module '.../server/assets.mjs'`.

- [ ] **Step 4: Write `server/assets.mjs`**

```js
import { readFileSync, readdirSync } from 'node:fs';

const UI = new URL('../ui/', import.meta.url);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

/** The only files the server serves: index.html at "/" and the other ui/ files under /ui/. Read once at start. */
export function loadAssets(dir = UI) {
  const assets = new Map();
  for (const name of readdirSync(dir).sort()) {
    const type = TYPES[name.slice(name.lastIndexOf('.'))];
    if (!type || !/^[\w.-]+$/.test(name)) continue;
    assets.set(name === 'index.html' ? '/index.html' : `/ui/${name}`, { type, body: readFileSync(new URL(name, dir)) });
  }
  return assets;
}
```

- [ ] **Step 5: Write `server/hub.mjs`**

```js
/**
 * Live page connections (Server-Sent Events) and the engine's lifetime. The engine is created when the first page
 * connects or an API call needs it, polls only while a page is connected, and is dropped engineIdleMs after the last
 * page leaves, so an idle server holds no engine memory. Never writes to stdout.
 */
export function createHub({ createEngine, now = Date.now, intervalMs = 3000, engineIdleMs = 300000, heartbeatMs = 15000, log = () => {}, onIdle = () => {} }) {
  const clients = new Set();
  let engine = null;
  let ready = null;
  let unsubscribe = null;
  let idleTimer = null;
  let heartbeat = null;
  let polling = false;
  let swarmsKey = '';
  const warn = error => log({ level: 'warn', source: 'server', message: error?.message ?? String(error) });

  function acquire() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!engine) {
      engine = createEngine();
      unsubscribe = engine.subscribe(change => { changed(change).catch(warn); });
      ready = Promise.resolve(engine.refresh()).catch(warn);
    }
    const current = engine;
    return ready.then(() => current);
  }

  function startPolling() {
    if (polling || !engine) return;
    polling = true;
    engine.start({ intervalMs });
    heartbeat = setInterval(() => { for (const client of clients) client.res.write(': ping\n\n'); }, heartbeatMs);
    heartbeat.unref?.();
  }

  function scheduleRelease() {
    if (clients.size) return;
    if (polling) {
      engine?.stop();
      polling = false;
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (!engine || idleTimer) return;
    idleTimer = setTimeout(release, engineIdleMs);
    idleTimer.unref?.();
  }

  function release() {
    idleTimer = null;
    if (clients.size || !engine) return;
    engine.stop();
    unsubscribe?.();
    engine = null;
    ready = null;
    unsubscribe = null;
    swarmsKey = '';
    onIdle();
  }

  function send(client, event, data) {
    if (!client.closed) client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function sendSwarms(force, target) {
    if (!engine) return;
    const swarms = engine.listSwarms();
    const key = JSON.stringify(swarms.map(swarm => [swarm.id, swarm.name, swarm.lifecycle]));
    if (!force && key === swarmsKey) return;
    swarmsKey = key;
    for (const client of target ? [target] : clients) send(client, 'swarms', swarms);
  }

  async function push(client) {
    if (client.busy) {
      client.again = true;
      return;
    }
    client.busy = true;
    try {
      do {
        client.again = false;
        const current = engine;
        if (!current || client.closed) return;
        const fromSession = !client.swarm && !client.pinned && client.session ? await current.findSwarm(client.session) : null;
        const snapshot = await current.getSnapshot(client.swarm ?? client.pinned ?? fromSession ?? undefined);
        if (client.closed) return;
        // Pin a page to the swarm it was first shown, so the default does not jump between swarms. A page opened from a
        // session that is in no swarm yet stays unpinned, and follows that session once it joins one.
        if (snapshot && !client.swarm && (fromSession || !client.session)) client.pinned = snapshot.run.id;
        const key = snapshot ? `${snapshot.run.id}#${snapshot.revision}` : 'none';
        if (key !== client.lastKey) {
          client.lastKey = key;
          send(client, 'snapshot', { serverNow: now(), snapshot });
        }
      } while (client.again && !client.closed);
    } catch (error) {
      warn(error);
    } finally {
      client.busy = false;
    }
  }

  async function changed(change) {
    sendSwarms(false);
    for (const client of clients) {
      const shown = client.swarm ?? client.pinned;
      if (!shown || change.swarmIds.includes(shown)) push(client);
    }
  }

  /** Serve one page's event stream. swarm: the swarm it asked for; session: a session whose swarm it wants. */
  async function add(req, res, { swarm = null, session = null } = {}) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const client = { res, swarm, session, pinned: null, lastKey: null, busy: false, again: false, closed: false };
    clients.add(client);
    req.on('close', () => {
      client.closed = true;
      clients.delete(client);
      scheduleRelease();
    });
    const current = await acquire();
    if (client.closed) return;
    send(client, 'hello', { serverNow: now(), demo: Boolean(current.isDemo) });
    startPolling();
    sendSwarms(true, client);
    await push(client);
  }

  /** Run fn with the engine, creating it if needed; an engine with no connected page is dropped later. */
  async function withEngine(fn) {
    const current = await acquire();
    try {
      return await fn(current);
    } finally {
      scheduleRelease();
    }
  }

  function close() {
    for (const client of clients) {
      client.closed = true;
      client.res.end();
    }
    clients.clear();
    clearTimeout(idleTimer);
    clearInterval(heartbeat);
    idleTimer = null;
    heartbeat = null;
    polling = false;
    if (engine) {
      engine.stop();
      unsubscribe?.();
    }
    engine = null;
    ready = null;
  }

  return { add, withEngine, close, clientCount: () => clients.size, hasEngine: () => engine !== null };
}
```

- [ ] **Step 6: Write `server/http.mjs`**

```js
import { createServer } from 'node:http';
import { loadAssets } from './assets.mjs';
import { createHub } from './hub.mjs';

export const APP_ID = 'swarm-dashboard';
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const TEXT = 'text/plain; charset=utf-8';

/**
 * The dashboard's HTTP server: the page, its assets, a JSON API and the live event stream. Loopback only, GET and HEAD
 * only, and only for requests addressed to its own host and port. Writes nothing to stdout or disk.
 */
export function createDashboardServer({ createEngine, host = '127.0.0.1', port = 0, version = '0.0.0', now = Date.now, log = () => {}, hub: hubOptions = {}, onIdle = () => {} }) {
  const assets = loadAssets();
  const hub = createHub({ createEngine, now, log, onIdle, ...hubOptions });
  const startedAt = now();
  let boundPort = null;

  const reply = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...headers });
    res.end(body);
  };
  const json = (res, value) => reply(res, 200, 'application/json; charset=utf-8', JSON.stringify(value), { 'Cache-Control': 'no-store' });

  async function route(req, res) {
    for (const [name, value] of Object.entries(SECURITY)) res.setHeader(name, value);
    if (req.headers.host !== `127.0.0.1:${boundPort}` && req.headers.host !== `localhost:${boundPort}`) return reply(res, 403, TEXT, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, TEXT, 'Method not allowed', { Allow: 'GET, HEAD' });
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const path = url.pathname;
    const param = name => url.searchParams.get(name) || null;
    if (path === '/api/health') return json(res, { app: APP_ID, version, pid: process.pid, startedAt });
    if (path === '/api/events') return hub.add(req, res, { swarm: param('swarm'), session: param('session') });
    if (path === '/api/swarms') return json(res, await hub.withEngine(engine => engine.listSwarms()));
    if (path === '/api/snapshot') return json(res, { serverNow: now(), snapshot: await hub.withEngine(engine => engine.getSnapshot(param('swarm') ?? undefined)) });
    if (path === '/api/history') return json(res, await hub.withEngine(engine => engine.listHistory()));
    if (path.startsWith('/api/runs/')) {
      let id;
      try {
        id = decodeURIComponent(path.slice('/api/runs/'.length));
      } catch {
        return reply(res, 400, TEXT, 'Bad run id');
      }
      const summary = await hub.withEngine(engine => engine.getRunSummary(id));
      return summary ? json(res, summary) : reply(res, 404, TEXT, 'Not found');
    }
    const asset = assets.get(path === '/' ? '/index.html' : path);
    if (asset) return reply(res, 200, asset.type, asset.body, { 'Cache-Control': 'no-cache' });
    return reply(res, 404, TEXT, 'Not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      log({ level: 'warn', source: 'server', message: error.message });
      if (!res.headersSent) reply(res, 500, TEXT, 'Internal error');
      else res.end();
    });
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        const fail = error => {
          server.off('listening', ok);
          reject(error);
        };
        const ok = () => {
          server.off('error', fail);
          resolve();
        };
        server.once('error', fail);
        server.once('listening', ok);
        server.listen(port, host);
      });
      boundPort = server.address().port;
      return `http://127.0.0.1:${boundPort}/`;
    },
    get url() {
      return boundPort === null ? null : `http://127.0.0.1:${boundPort}/`;
    },
    get port() {
      return boundPort;
    },
    clientCount: () => hub.clientCount(),
    async close() {
      hub.close();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
      boundPort = null;
    },
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/server.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 8: Run the whole suite and commit**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass; validation passes.

```bash
git add ghcp/plugins/swarm-dashboard/server ghcp/plugins/swarm-dashboard/tests/helpers/http.mjs ghcp/plugins/swarm-dashboard/tests/server.test.mjs
git commit -m "feat(swarm-dashboard): serve the dashboard with live snapshot updates"
```

### Task 10: Browser glue

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/ui/morph.mjs`
- Create: `ghcp/plugins/swarm-dashboard/ui/main.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-main.test.mjs`

**Interfaces:**
- Consumes: `isNarrow`, `renderApp` (Task 7); `tickText` (Task 1); `shortLabel` (Task 3); `timelineWindow`, `laneSvg`, `axisSvg`, `costSvg` (`ui/timeline.mjs`); `planFits`, `planGraphHtml`, `planListHtml` (`ui/plan.mjs`); the server's `/api/events`, `/api/history` and `/api/runs/<id>`.
- Produces: browser behaviour only. URL parameters: `host=canvas|browser`, `swarm`, `session`, `page=live|history|run`, `tab`, `detail` (unit id), `span=3h|12h|run`, `run` (run id). `localStorage['swarm-dashboard:ui']` keeps `{ tab, span, swarm }`. After every render the page sets `<html data-host data-narrow="0|1" data-ready="0|1">`; `data-ready="1"` means the current page has its data (the layout check waits for it).
- Produces (`ui/morph.mjs`): `morph(target, html)`. Every render, and every timeline and plan drawing, patches the existing DOM instead of replacing it, so updates (about every 3 s while a swarm is live) do not restart animations, reset ticking clocks or the scroll position, or flash items that did not change, and hover, focus, selection and tooltips survive. Siblings match by `data-key`, else `data-id`, `data-open` or `data-run`, else by position and tag; `data-drawn` containers keep their children (main.mjs draws them); `data-phase` elements keep their animation delay unless their class changes or they move; a focused `<select>` (the swarm picker in use) keeps its options and choice until it loses focus, and the page re-renders then. The layout check (Task 16) tests morph in a real browser.
- Produces (behaviour): each snapshot update adds a `performance.measure('swarm-update')` entry covering parsing, rendering and layout (the layout check reports these); a new item's highlight class stays for 1.7 s so a render during its animation does not cut it; a four-character ring label (`.ring-l[data-fit]`) that is wider than its 30 px box is cut with `shortLabel`.

This module touches the DOM, so Node tests only check that it parses and keeps its contract with the server and the layout check; Task 11's preview and Task 16's layout check exercise it in a browser.

- [ ] **Step 1: Write the failing test**

`tests/ui-main.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = name => fileURLToPath(new URL(`../ui/${name}`, import.meta.url));

test('the browser modules parse and import only sibling modules', () => {
  for (const name of ['main.mjs', 'morph.mjs']) {
    const check = spawnSync(process.execPath, ['--check', file(name)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const source = readFileSync(file(name), 'utf8');
    for (const [, specifier] of source.matchAll(/\bfrom\s+'([^']+)'/g)) assert.match(specifier, /^\.\/[\w-]+\.mjs$/);
    assert.doesNotMatch(source, /https?:\/\//);
  }
});

test('the browser module keeps the names the server and the layout check rely on', () => {
  const source = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ["getElementById('dash')", 'new EventSource(', "'hello'", "'swarms'", "'snapshot'", 'dataset.ready', 'dataset.narrow', 'dataset.host', "'/api/history'", '/api/runs/', "'swarm-dashboard:ui'", "'pagehide'", "'swarm-update'"]) {
    assert.ok(source.includes(needle), needle);
  }
});

test('updates patch the page in place instead of replacing it', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  assert.ok(main.includes('morph(dash, renderApp('));
  assert.doesNotMatch(main, /\.innerHTML\s*=/);
  const morph = readFileSync(file('morph.mjs'), 'utf8');
  for (const needle of ["'data-key'", "'data-drawn'", "'data-phase'"]) assert.ok(morph.includes(needle), needle);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-main.test.mjs`
Expected: FAIL; `node --check` reports that `ui/main.mjs` does not exist.

- [ ] **Step 3: Write `ui/morph.mjs`**

```js
/**
 * Make a container's content match new HTML while keeping the nodes that stay, so running animations, hover, focus,
 * text selection and tooltips survive an update and only what changed is touched. Siblings are matched by key
 * (data-key, else data-id, data-open or data-run) and otherwise by position when the tag is the same. Two attributes
 * change the rules: data-drawn marks a container whose content main.mjs draws after rendering, so its children are left
 * alone; data-phase marks an endless animation whose inline delay is kept while the element stays put with the same
 * class, because changing the delay of a running animation makes it jump.
 */
export function morph(target, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  syncChildren(target, template.content, false);
}

function keyOf(node) {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const key = node.getAttribute('data-key') ?? node.getAttribute('data-id') ?? node.getAttribute('data-open') ?? node.getAttribute('data-run');
  return key === null ? null : `${node.nodeName}\n${key}`;
}

function syncChildren(parent, source, moved) {
  const incoming = [...source.childNodes];
  const wanted = new Set(incoming.map(keyOf).filter(key => key !== null));
  const keyed = new Map();
  for (const child of parent.childNodes) {
    const key = keyOf(child);
    if (key !== null && wanted.has(key) && !keyed.has(key)) keyed.set(key, child);
  }
  let cursor = parent.firstChild;
  for (const next of incoming) {
    // Drop keyed nodes that are no longer wanted, so the nodes after them keep their place instead of being moved.
    while (cursor && keyOf(cursor) !== null && keyed.get(keyOf(cursor)) !== cursor) {
      const after = cursor.nextSibling;
      cursor.remove();
      cursor = after;
    }
    const key = keyOf(next);
    let match = null;
    if (key !== null) match = keyed.get(key) ?? null;
    else if (cursor && keyOf(cursor) === null && cursor.nodeName === next.nodeName) match = cursor;
    if (!match) {
      parent.insertBefore(next, cursor);
      continue;
    }
    if (key !== null) keyed.delete(key);
    if (match === cursor) {
      cursor = cursor.nextSibling;
      syncNode(match, next, moved);
    } else {
      // Moving a node restarts its animations, so it takes the new delays.
      parent.insertBefore(match, cursor);
      syncNode(match, next, true);
    }
  }
  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
}

function syncNode(from, to, moved) {
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  syncAttributes(from, to, moved);
  if (from.hasAttribute('data-drawn') && to.hasAttribute('data-drawn')) return;
  if (from.nodeName !== 'SELECT') {
    syncChildren(from, to, moved);
    return;
  }
  // Someone may be choosing in this select right now: leave its options and choice alone until it loses focus.
  if (from === document.activeElement) return;
  // Read the rendered choice before syncing, which moves new options out of `to`.
  const chosen = to.querySelector('option[selected]') ?? to.querySelector('option');
  const value = chosen ? chosen.getAttribute('value') ?? chosen.textContent : null;
  syncChildren(from, to, moved);
  if (value !== null) from.value = value;
}

function syncAttributes(from, to, moved) {
  const keepStyle = !moved && from.hasAttribute('data-phase') && to.hasAttribute('data-phase') && from.getAttribute('class') === to.getAttribute('class');
  for (const { name, value } of [...to.attributes]) {
    if (name === 'style' && keepStyle) continue;
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  for (const { name } of [...from.attributes]) {
    if (!to.hasAttribute(name) && !(name === 'style' && keepStyle)) from.removeAttribute(name);
  }
}
```

- [ ] **Step 4: Write `ui/main.mjs`**

```js
import { isNarrow, renderApp } from './app.mjs';
import { tickText } from './format.mjs';
import { morph } from './morph.mjs';
import { shortLabel } from './parts.mjs';
import { planFits, planGraphHtml, planListHtml } from './plan.mjs';
import { axisSvg, costSvg, laneSvg, timelineWindow } from './timeline.mjs';

const STORE = 'swarm-dashboard:ui';
const TABS = ['cards', 'activity', 'timeline', 'plan', 'board'];
const SPANS = ['3h', '12h', 'run'];
const PAGES = ['live', 'history', 'run'];
const dash = document.getElementById('dash');
const params = new URLSearchParams(location.search);
const choose = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const emptyFresh = () => ({ feed: new Set(), reports: new Set(), chips: new Set() });
/** How long a new item keeps its highlight class, so a render during its animation does not cut it short. */
const FRESH_MS = 1700;

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
const saved = readSaved();
document.documentElement.dataset.host = params.get('host') === 'canvas' ? 'canvas' : 'browser';

const view = {
  page: choose(params.get('page'), PAGES, 'live'),
  tab: choose(params.get('tab') ?? saved.tab, TABS, 'cards'),
  span: choose(params.get('span') ?? saved.span, SPANS, '12h'),
  detail: params.get('detail'),
  runId: params.get('run'),
  swarm: params.get('swarm') ?? (params.get('session') ? null : saved.swarm ?? null),
  session: params.get('session'),
  narrow: false,
  loaded: false,
  snapshot: null,
  swarms: [],
  runs: null,
  run: null,
  connection: 'connecting',
  demo: false,
  fresh: emptyFresh(),
};
if (view.page === 'run' && !view.runId) view.page = 'history';

let offset = 0;
let source = null;
let reconnectTimer = null;
let justConnected = true;
let renderQueued = false;
let lastWidth = 0;
let ticks = 0;
let freshUntil = 0;
let parseMs = null;
let measured = 0;
const now = () => Date.now() + offset;

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ tab: view.tab, span: view.span, swarm: view.swarm }));
  } catch {
    // Storage can be unavailable; the dashboard works without it.
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  source?.close();
  const query = new URLSearchParams();
  if (view.swarm) query.set('swarm', view.swarm);
  else if (view.session) query.set('session', view.session);
  const search = query.toString();
  source = new EventSource(`/api/events${search ? `?${search}` : ''}`);
  source.addEventListener('open', () => {
    justConnected = true;
    view.connection = 'open';
    scheduleRender();
  });
  source.addEventListener('error', () => {
    view.connection = 'retrying';
    scheduleRender();
    if (source.readyState === EventSource.CLOSED) reconnectTimer = setTimeout(connect, 2000);
  });
  source.addEventListener('hello', event => {
    const data = JSON.parse(event.data);
    offset = data.serverNow - Date.now();
    view.demo = Boolean(data.demo);
  });
  source.addEventListener('swarms', event => {
    view.swarms = JSON.parse(event.data);
    scheduleRender();
  });
  source.addEventListener('snapshot', event => {
    const started = performance.now();
    const data = JSON.parse(event.data);
    parseMs = (parseMs ?? 0) + performance.now() - started;
    offset = data.serverNow - Date.now();
    applySnapshot(data.snapshot);
  });
}

function freshKeys(prev, next) {
  const fresh = emptyFresh();
  const feed = new Set(prev.feed.map(item => item.id));
  for (const item of next.feed) if (!feed.has(item.id)) fresh.feed.add(item.id);
  const reports = new Map(prev.units.map(unit => [unit.id, unit.report?.at ?? null]));
  for (const unit of next.units) if (unit.report && reports.get(unit.id) !== unit.report.at) fresh.reports.add(unit.id);
  const chips = new Set([prev.orchestrator, ...prev.units].flatMap(session => session.subagents.map(sub => sub.id)));
  for (const unit of next.units) for (const sub of unit.subagents) if (!chips.has(sub.id)) fresh.chips.add(sub.id);
  return fresh;
}

function applySnapshot(next) {
  const prev = view.snapshot;
  const found = prev && next && prev.run.id === next.run.id && !justConnected ? freshKeys(prev, next) : emptyFresh();
  const t = performance.now();
  const carried = t < freshUntil && !justConnected ? view.fresh : emptyFresh();
  view.fresh = {
    feed: new Set([...carried.feed, ...found.feed]),
    reports: new Set([...carried.reports, ...found.reports]),
    chips: new Set([...carried.chips, ...found.chips]),
  };
  if (found.feed.size || found.reports.size || found.chips.size) freshUntil = t + FRESH_MS;
  justConnected = false;
  view.snapshot = next;
  view.loaded = true;
  if (view.detail && !next?.units.some(unit => unit.id === view.detail)) view.detail = null;
  scheduleRender();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

function focusSelector(el) {
  for (const name of ['open', 'run', 'tab', 'page', 'span']) {
    if (el.dataset[name] !== undefined) return `[data-${name}="${CSS.escape(el.dataset[name])}"]`;
  }
  return null;
}

function isReady() {
  if (view.page === 'history') return view.runs !== null;
  if (view.page === 'run') return view.run !== null;
  return view.loaded;
}

function render() {
  renderQueued = false;
  const started = performance.now();
  const width = dash.clientWidth;
  view.narrow = isNarrow(width);
  if (!view.narrow && view.tab === 'activity') view.tab = 'cards';
  const focused = document.activeElement && dash.contains(document.activeElement) ? focusSelector(document.activeElement) : null;
  const { scrollX, scrollY } = window;
  morph(dash, renderApp({ ...view, now: now(), phaseMs: performance.now() }));
  lastWidth = width;
  afterRender();
  if (focused && !dash.contains(document.activeElement)) dash.querySelector(focused)?.focus({ preventScroll: true });
  window.scrollTo(scrollX, scrollY);
  document.documentElement.dataset.narrow = view.narrow ? '1' : '0';
  document.documentElement.dataset.ready = isReady() ? '1' : '0';
  if (parseMs !== null) {
    // One update's cost, from reading the snapshot to a laid-out page; the layout check reads these entries.
    dash.getBoundingClientRect();
    if (++measured % 200 === 0) performance.clearMeasures('swarm-update');
    performance.measure('swarm-update', { start: started, duration: parseMs + performance.now() - started });
    parseMs = null;
  }
}

function afterRender() {
  if (!view.snapshot || view.page !== 'live') return;
  const timeline = dash.querySelector('[data-timeline]');
  if (timeline) drawTimeline(timeline);
  const plan = dash.querySelector('[data-plan]');
  if (plan) drawPlan(plan);
  for (const box of dash.querySelectorAll('.b-card .chips')) fitChips(box);
  fitRingLabels();
}

function drawTimeline(root) {
  const first = root.querySelector('.c-trk');
  if (!first) return;
  const width = Math.floor(first.getBoundingClientRect().width);
  if (!width) return;
  const t = now();
  const { t0, t1 } = timelineWindow(view.snapshot, view.span, t);
  const phaseMs = performance.now();
  const sessions = new Map([view.snapshot.orchestrator, ...view.snapshot.units].map(session => [session.id, session]));
  morph(root.querySelector('.c-axis .c-trk'), axisSvg(width, t0, t1));
  for (const row of root.querySelectorAll('.c-row[data-id]')) {
    const session = sessions.get(row.dataset.id);
    if (session) morph(row.querySelector('.c-trk'), laneSvg(session, width, t0, t1, t, phaseMs));
  }
  morph(root.querySelector('.c-cost .c-trk'), costSvg(view.snapshot.cost, width, t0, t1, t));
}

function drawPlan(el) {
  const width = Math.floor(el.getBoundingClientRect().width);
  morph(el, planFits(view.snapshot, width) ? planGraphHtml(view.snapshot, now()) : planListHtml(view.snapshot, now()));
}

/** A four-character ring label shows whole only when it fits inside the ring; otherwise it is cut like longer labels. */
function fitRingLabels() {
  for (const label of dash.querySelectorAll('.ring-l[data-fit]')) {
    if (label.scrollWidth > label.clientWidth + 1) label.textContent = shortLabel(label.textContent);
  }
}

/** Hide sub-agent chips that do not fit on the card's single chip row and say how many are hidden. */
function fitChips(box) {
  if (box.scrollHeight <= box.clientHeight + 1) return;
  const chips = [...box.querySelectorAll(':scope > .chip')];
  const more = document.createElement('span');
  more.className = 'chip';
  box.append(more);
  let hidden = 0;
  do {
    hidden += 1;
    chips[chips.length - hidden].hidden = true;
    more.textContent = `+${hidden}`;
  } while (box.scrollHeight > box.clientHeight + 1 && hidden < chips.length);
}

async function loadHistory() {
  view.runs = null;
  scheduleRender();
  try {
    const response = await fetch('/api/history');
    view.runs = response.ok ? await response.json() : [];
  } catch {
    view.runs = [];
  }
  scheduleRender();
}

async function loadRun(id) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    view.run = response.ok ? await response.json() : false;
  } catch {
    view.run = false;
  }
  scheduleRender();
}

function act(target) {
  const el = target.closest('[data-page],[data-tab],[data-span],[data-close],[data-open],[data-run]');
  if (!el || !dash.contains(el)) return;
  if (el.dataset.page) {
    view.page = el.dataset.page;
    view.detail = null;
    if (view.page === 'history') loadHistory();
  } else if (el.dataset.tab) {
    view.tab = el.dataset.tab;
  } else if (el.dataset.span) {
    view.span = el.dataset.span;
  } else if (el.dataset.close !== undefined) {
    const was = view.detail;
    view.detail = null;
    render();
    if (view.narrow && was) dash.querySelector(`[data-open="${CSS.escape(was)}"]`)?.scrollIntoView({ block: 'center' });
    return;
  } else if (el.dataset.open) {
    view.detail = el.dataset.open;
    render();
    if (view.narrow) dash.querySelector('.detail')?.scrollIntoView({ block: 'start' });
    return;
  } else if (el.dataset.run) {
    view.page = 'run';
    view.runId = el.dataset.run;
    view.run = null;
    loadRun(view.runId);
  }
  save();
  render();
}

dash.addEventListener('click', event => act(event.target));
dash.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"][data-open], [role="button"][data-run]')) {
    event.preventDefault();
    act(event.target);
  } else if (event.key === 'Escape' && view.detail) {
    view.detail = null;
    render();
  }
});
dash.addEventListener('change', event => {
  if (!event.target.matches('select[data-swarm]')) return;
  view.swarm = event.target.value;
  view.snapshot = null;
  view.loaded = false;
  view.detail = null;
  save();
  event.target.blur();
  connect();
  render();
});
// morph() leaves the focused swarm picker alone, so bring it up to date once it loses focus.
dash.addEventListener('focusout', event => {
  if (event.target.matches('select[data-swarm]')) scheduleRender();
});
new ResizeObserver(() => {
  if (dash.clientWidth !== lastWidth) scheduleRender();
}).observe(dash);
setInterval(() => {
  const t = now();
  for (const el of dash.querySelectorAll('[data-t]')) {
    const text = tickText(Number(el.dataset.t), el.dataset.f, t);
    if (el.textContent !== text) el.textContent = text;
  }
  ticks += 1;
  if (ticks % 15 === 0 && view.page === 'live' && view.tab === 'timeline' && view.snapshot) {
    const timeline = dash.querySelector('[data-timeline]');
    if (timeline) drawTimeline(timeline);
  }
}, 1000);

// Browsers allow few connections per host, so free the live connection when the page is hidden or cached.
window.addEventListener('pagehide', () => {
  clearTimeout(reconnectTimer);
  source?.close();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) connect();
});

if (view.page === 'history') loadHistory();
if (view.page === 'run') loadRun(view.runId);
connect();
render();
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-main.test.mjs && npm test`
Expected: PASS, 3 tests; the whole suite passes. `morph()` needs a DOM, so its behaviour is tested in a real browser by the layout check (Task 16).

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/morph.mjs ghcp/plugins/swarm-dashboard/ui/main.mjs ghcp/plugins/swarm-dashboard/tests/ui-main.test.mjs
git commit -m "feat(swarm-dashboard): wire the page to live updates, clocks and controls"
```

### Task 11: Fixed port and the standalone launcher

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/server/shared.mjs`
- Create: `ghcp/plugins/swarm-dashboard/scripts/swarm-dashboard.mjs`
- Modify: `ghcp/plugins/swarm-dashboard/package.json` (add the `start` script only)
- Test: `ghcp/plugins/swarm-dashboard/tests/shared.test.mjs`, `ghcp/plugins/swarm-dashboard/tests/launcher.test.mjs`

**Interfaces:**
- Consumes: `APP_ID`, `createDashboardServer` (Task 9), `createDemoEngine` (Task 8), `createDefaultEngine` (Task 8), `freePort` (Task 9 helper).
- Produces: `DEFAULT_PORT = 7927`; `resolvePort(env = process.env): number` (`SWARM_DASHBOARD_PORT`, else 7927; throws on a bad value); `probePort(port, { timeoutMs = 2500 } = {})` → `{ state: 'ours', health } | { state: 'free' } | { state: 'other' } | { state: 'unresponsive' }`; `listenShared({ port, makeServer, probe = probePort, attempts = 3, pauseMs = 300 })` → `{ status: 'started', server } | { status: 'running', health } | { status: 'taken' } | { status: 'unresponsive' }`; the launcher's `USAGE`, `parseArguments(argv, env): { port, demo: null|'example'|'stress', still, help }` and `main(argv, { stdout, stderr, env, signal }): Promise<exitCode>`; `npm start`.

- [ ] **Step 1: Write the failing tests**

`tests/shared.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { DEFAULT_PORT, listenShared, probePort, resolvePort } from '../server/shared.mjs';
import { freePort } from './helpers/http.mjs';

const dashboard = port => createDashboardServer({ createEngine: () => createDemoEngine({ simulate: false }), port, version: 'test' });
const listen = (server, port) => new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const close = server => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

test('the port is 7927 unless SWARM_DASHBOARD_PORT says otherwise', () => {
  assert.equal(DEFAULT_PORT, 7927);
  assert.equal(resolvePort({}), 7927);
  assert.equal(resolvePort({ SWARM_DASHBOARD_PORT: '8123' }), 8123);
  assert.throws(() => resolvePort({ SWARM_DASHBOARD_PORT: 'abc' }), /SWARM_DASHBOARD_PORT/);
  assert.throws(() => resolvePort({ SWARM_DASHBOARD_PORT: '70000' }), /SWARM_DASHBOARD_PORT/);
});

test('the probe tells a free port, our dashboard, another program and a silent listener apart', async () => {
  const port = await freePort();
  assert.deepEqual(await probePort(port), { state: 'free' });
  const ours = dashboard(port);
  await ours.listen();
  try {
    const found = await probePort(port);
    assert.equal(found.state, 'ours');
    assert.equal(found.health.version, 'test');
  } finally {
    await ours.close();
  }
  const other = createServer((req, res) => res.end('hello'));
  await listen(other, port);
  try {
    assert.deepEqual(await probePort(port), { state: 'other' });
  } finally {
    await close(other);
  }
  const sockets = new Set();
  const silent = createTcpServer(socket => sockets.add(socket));
  await listen(silent, port);
  try {
    assert.deepEqual(await probePort(port, { timeoutMs: 200 }), { state: 'unresponsive' });
  } finally {
    // A timed-out fetch leaves its socket open, so close the server's side before closing the server.
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => silent.close(() => resolve()));
  }
});

test('a program holding the port on every address counts as taken, not as a free loopback port', async () => {
  const port = await freePort();
  const other = createServer((req, res) => res.end('hello'));
  await new Promise(resolve => other.listen(port, '0.0.0.0', resolve));
  try {
    assert.deepEqual(await listenShared({ port, makeServer: () => dashboard(port) }), { status: 'taken' });
  } finally {
    await close(other);
  }
});

test('listenShared starts a server, finds a running dashboard, or reports a taken port', async () => {
  const port = await freePort();
  const first = await listenShared({ port, makeServer: () => dashboard(port) });
  assert.equal(first.status, 'started');
  try {
    const second = await listenShared({ port, makeServer: () => dashboard(port) });
    assert.equal(second.status, 'running');
    assert.equal(second.health.app, 'swarm-dashboard');
  } finally {
    await first.server.close();
  }
  const other = createServer((req, res) => res.end('hello'));
  await listen(other, port);
  try {
    assert.deepEqual(await listenShared({ port, makeServer: () => dashboard(port) }), { status: 'taken' });
  } finally {
    await close(other);
  }
});
```

`tests/launcher.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main, parseArguments } from '../scripts/swarm-dashboard.mjs';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { freePort } from './helpers/http.mjs';

const sink = () => {
  const out = { text: '', write(chunk) { out.text += chunk; return true; } };
  return out;
};

test('arguments: port, demo scenario, still and help', () => {
  assert.deepEqual(parseArguments([], {}), { port: 7927, demo: null, still: false, help: false });
  assert.deepEqual(parseArguments(['--port', '8100', '--demo', 'stress', '--still'], {}), { port: 8100, demo: 'stress', still: true, help: false });
  assert.equal(parseArguments(['--demo'], {}).demo, 'example');
  assert.equal(parseArguments(['--port=9001'], {}).port, 9001);
  assert.equal(parseArguments([], { SWARM_DASHBOARD_PORT: '8200' }).port, 8200);
  assert.equal(parseArguments(['--help'], {}).help, true);
  assert.throws(() => parseArguments(['--nope'], {}), /Unknown option/);
  assert.throws(() => parseArguments(['--port', 'x'], {}), /port/);
  assert.throws(() => parseArguments(['--still'], {}), /--still/);
});

test('the launcher serves the dashboard until it is stopped', async () => {
  const port = await freePort();
  const stdout = sink();
  const stop = new AbortController();
  const running = main(['--port', String(port), '--demo', '--still'], { stdout, stderr: sink(), signal: stop.signal });
  const start = Date.now();
  while (!stdout.text.includes('Press Ctrl+C') && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(stdout.text.includes(`Swarm dashboard (sample data: example): http://127.0.0.1:${port}/`), stdout.text);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.app, 'swarm-dashboard');
  stop.abort();
  assert.equal(await running, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

test('a second launch reuses the running dashboard; another program on the port is an error', async () => {
  const port = await freePort();
  const ours = createDashboardServer({ createEngine: () => createDemoEngine({ simulate: false }), port, version: 'test' });
  await ours.listen();
  try {
    const stdout = sink();
    assert.equal(await main(['--port', String(port)], { stdout, stderr: sink() }), 0);
    assert.equal(stdout.text, `The swarm dashboard is already running at http://127.0.0.1:${port}/\n`);
  } finally {
    await ours.close();
  }
  const other = createServer((req, res) => res.end('hello'));
  await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
  try {
    const stderr = sink();
    assert.equal(await main(['--port', String(port)], { stdout: sink(), stderr }), 1);
    assert.ok(stderr.text.includes(`Port ${port} is used by another program. Start with --port <n> or set SWARM_DASHBOARD_PORT.`), stderr.text);
  } finally {
    other.closeAllConnections?.();
    await new Promise(resolve => other.close(() => resolve()));
  }
});

test('bad arguments print the usage and exit 2', async () => {
  const stderr = sink();
  assert.equal(await main(['--port', '0'], { stdout: sink(), stderr }), 2);
  assert.match(stderr.text, /Usage: swarm-dashboard/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/shared.test.mjs tests/launcher.test.mjs`
Expected: FAIL with `Cannot find module '.../server/shared.mjs'` and `.../scripts/swarm-dashboard.mjs`.

- [ ] **Step 3: Write `server/shared.mjs`**

```js
import { APP_ID } from './http.mjs';

/** The dashboard's fixed loopback port (IANA-unassigned, below macOS's ephemeral range). */
export const DEFAULT_PORT = 7927;

export function resolvePort(env = process.env) {
  const raw = env.SWARM_DASHBOARD_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SWARM_DASHBOARD_PORT must be a port number from 1 to 65535, not ${raw}`);
  return port;
}

/**
 * Who holds the port: our dashboard ('ours', with its health answer), nobody ('free'), another program ('other'), or
 * something that accepts connections but does not answer in time ('unresponsive').
 */
export async function probePort(port, { timeoutMs = 2500 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = response.ok ? await response.json().catch(() => null) : null;
    return body && body.app === APP_ID ? { state: 'ours', health: body } : { state: 'other' };
  } catch (error) {
    if ((error?.cause?.code ?? error?.code) === 'ECONNREFUSED') return { state: 'free' };
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { state: 'unresponsive' };
    return { state: 'other' };
  }
}

/**
 * Bind the shared port with a new server, or identify whoever holds it. The OS settles races: a loser gets EADDRINUSE,
 * probes the winner and reuses it if it is a dashboard.
 */
export async function listenShared({ port, makeServer, probe = probePort, attempts = 3, pauseMs = 300 }) {
  // Look before binding: macOS lets a loopback bind succeed beside a program that holds the port on every address.
  const holder = await probe(port);
  if (holder.state === 'ours') return { status: 'running', health: holder.health };
  if (holder.state === 'other') return { status: 'taken' };
  if (holder.state === 'unresponsive') return { status: 'unresponsive' };
  let status = 'taken';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const server = makeServer();
    try {
      await server.listen();
      return { status: 'started', server };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    const found = await probe(port);
    if (found.state === 'ours') return { status: 'running', health: found.health };
    if (found.state === 'other') return { status: 'taken' };
    status = found.state === 'unresponsive' ? 'unresponsive' : 'taken';
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { status };
}
```

- [ ] **Step 4: Write `scripts/swarm-dashboard.mjs`**

```js
#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDefaultEngine } from '../server/engines.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { DEFAULT_PORT, listenShared, resolvePort } from '../server/shared.mjs';

export const USAGE = `Usage: swarm-dashboard [--port <n>] [--demo [example|stress]] [--still]

Serves the swarm dashboard at http://127.0.0.1:<port>/ (default ${DEFAULT_PORT}) for any browser or the
app's browser canvas. Reads Copilot data read-only. Stop it with Ctrl+C.
If the dashboard is already running on the port, prints its address and exits.

  --port <n>       Port to use (default ${DEFAULT_PORT}, or SWARM_DASHBOARD_PORT)
  --demo [name]    Serve a synthetic swarm instead of your data: example (default) or stress
  --still          With --demo: no simulated activity
  --help           Show this help
`;
const SCENARIOS = ['example', 'stress'];

export function parseArguments(argv, env = process.env) {
  const options = { port: null, demo: null, still: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--demo') options.demo = SCENARIOS.includes(argv[index + 1]) ? argv[++index] : 'example';
    else if (arg.startsWith('--demo=')) options.demo = arg.slice('--demo='.length);
    else if (arg === '--still') options.still = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.port === null) options.port = resolvePort(env);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port needs a port number from 1 to 65535');
  if (options.demo !== null && !SCENARIOS.includes(options.demo)) throw new Error('--demo takes example or stress');
  if (options.still && options.demo === null) throw new Error('--still works only with --demo');
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, signal } = {}) {
  let options;
  try {
    options = parseArguments(argv, env);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  const { version } = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  const log = entry => stderr.write(`[${entry.level}] ${entry.source}: ${entry.message}\n`);
  const createEngine = options.demo
    ? () => createDemoEngine({ scenario: options.demo, simulate: !options.still })
    : () => createDefaultEngine({ log });
  const port = options.port;
  const result = await listenShared({ port, makeServer: () => createDashboardServer({ createEngine, port, version, log }) });
  const url = `http://127.0.0.1:${port}/`;
  if (result.status === 'running') {
    stdout.write(`The swarm dashboard is already running at ${url}\n`);
    return 0;
  }
  if (result.status !== 'started') {
    stderr.write(`Port ${port} ${result.status === 'taken' ? 'is used by another program' : 'is in use and not answering'}. Start with --port <n> or set SWARM_DASHBOARD_PORT.\n`);
    return 1;
  }
  stdout.write(`Swarm dashboard${options.demo ? ` (sample data: ${options.demo})` : ''}: ${url}\nPress Ctrl+C to stop.\n`);
  await new Promise(resolve => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    signal?.addEventListener('abort', stop, { once: true });
  });
  await result.server.close();
  return 0;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 5: Add the `start` script**

In `package.json`, add one line after the `validate` script (keep every other line as it is; PR 1 may have added a `snapshot` script, which stays):

```json
    "start": "node scripts/swarm-dashboard.mjs"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/shared.test.mjs tests/launcher.test.mjs && npm test && npm run validate`
Expected: PASS (4 + 4 new tests); the whole suite and validation pass.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/server/shared.mjs ghcp/plugins/swarm-dashboard/scripts/swarm-dashboard.mjs ghcp/plugins/swarm-dashboard/package.json ghcp/plugins/swarm-dashboard/tests/shared.test.mjs ghcp/plugins/swarm-dashboard/tests/launcher.test.mjs
git commit -m "feat(swarm-dashboard): add the standalone launcher on the fixed port"
```

- [ ] **Step 8: Next: Task 20**

Run Task 20 next (see Execution order): it switches the server to PR 1's engine and ends with the early preview on real data.

### Task 12: Timeline

**Files:**
- Replace: `ghcp/plugins/swarm-dashboard/ui/timeline.mjs` (the Task 7 stub)
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-timeline.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`HOUR`, `MIN`, `ago`, `costHtml`, `costText`, `dur`, `elapsed`, `esc`), Task 2 (`REPORT_CLASS`, `TIMELINE_WORDS`, `unitEnd`), Task 3 (`fill`, `phase`).
- Produces (same names as the stub): `SPANS`; `timelineWindow(snapshot, span, now): { t0, t1 }` ('run' starts 20 minutes before the run); `markSvg(mark, x, y)`; `laneSvg(session, width, t0, t1, now, phaseMs = 0)`; `axisSvg(width, t0, t1)`; `costSvg(cost, width, t0, t1, now)`; `timelineHtml(ctx, span)` (rows with empty `.c-trk` cells that `ui/main.mjs` fills after measuring their width).

- [ ] **Step 1: Write the failing test**

`tests/ui-timeline.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, MIN } from '../ui/format.mjs';
import { findByLabel } from '../ui/model.mjs';
import { axisSvg, costSvg, laneSvg, markSvg, timelineHtml, timelineWindow } from '../ui/timeline.mjs';
import { NOW, context, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<title>[^<]*<\/title>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const row = (html, id) => html.split('<div class="c-row').find(part => part.includes(`data-id="${id}"`));

test('the window covers 3 hours, 12 hours or the whole run', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(timelineWindow(snapshot, '3h', NOW), { t0: NOW - 3 * HOUR, t1: NOW });
  assert.deepEqual(timelineWindow(snapshot, '12h', NOW), { t0: NOW - 12 * HOUR, t1: NOW });
  assert.deepEqual(timelineWindow(snapshot, 'run', NOW), { t0: snapshot.run.startedAt - 20 * MIN, t1: NOW });
});

test('one row per session, orchestrator first, with the window buttons, key and cost row', () => {
  const snapshot = exampleSnapshot();
  const html = timelineHtml(context(snapshot), '12h');
  assert.deepEqual([...html.matchAll(/class="c-row st-\w+" data-id="([^"]+)"/g)].map(match => match[1]), [snapshot.orchestrator.id, ...snapshot.units.map(unit => unit.id)]);
  assert.match(html, /<button type="button" data-span="12h" aria-pressed="true">last 12h<\/button>/);
  assert.match(html, /<button type="button" data-span="run" aria-pressed="false">whole run<\/button>/);
  assert.equal((html.match(/<pattern id="cHatch2"/g) ?? []).length, 1);
  assert.match(text(html), /report question plan sent plan approved PR monitor check/);
  assert.match(text(html), /Swarm cost all sessions 97,652 cr · ≈\$977$/);
});

test('rows name the session, its running time or run length, cost and latest report with state', () => {
  const snapshot = exampleSnapshot();
  const html = timelineHtml(context(snapshot), '12h');
  assert.match(text(row(html, snapshot.orchestrator.id)), /Sample story B 2d 23h · 31,532 cr · ≈\$315\.32 Waiting for an answer orchestrator/);
  assert.match(text(row(html, 'ws-0002-f2a')), /F2a tests, part 1 ran 23h 50m · 4,312 cr/);
  assert.match(text(row(html, 'ws-0004-b2')), /The parser is done\. The plan for step 2 is waiting for approval\. 41m ago · waiting on plan 38m/);
  assert.match(text(row(html, 'ws-0007-d5')), /5h ago · idle 9m/);
  assert.match(row(html, 'ws-0005-i1'), /<span class="dot stuck"><\/span>/);
  findByLabel(snapshot, 'B1').report = null;
  assert.match(text(row(timelineHtml(context(snapshot), '12h'), 'ws-0003-b1')), /No report yet/);
});

test('a lane draws busy spans, idle lines, a blinking live stuck span and the tool mark', () => {
  const i1 = findByLabel(exampleSnapshot(), 'I1');
  const svg = laneSvg(i1, 600, NOW - 12 * HOUR, NOW, NOW, 0);
  assert.match(svg, /<rect class="t-busy"/);
  assert.match(svg, /<line class="t-idle"/);
  assert.match(svg, /<rect class="t-stuck live"[^>]*style="animation-delay:-0\.00s"/);
  assert.match(svg, /<title>Tool call started, no events since<\/title>/);
  assert.match(svg, /<line class="t-now" x1="592"/);
});

test('a busy lane has a live edge, running sub-agents, monitor ticks and thinned marks', () => {
  const b1 = findByLabel(exampleSnapshot(), 'B1');
  const svg = laneSvg(b1, 600, NOW - 3 * HOUR, NOW, NOW, 0);
  assert.match(svg, /<rect class="t-edge"/);
  assert.match(svg, /<rect class="t-sub live"/);
  assert.match(svg, /<line class="t-mon"/);
  assert.match(svg, /<title>PR opened<\/title>/);
  assert.doesNotMatch(svg, /<title>Opened PR #418 with 14 endpoints\.<\/title>/, 'a lower-priority mark within 12 px is dropped');
});

test('sub-agent bars use at most three tracks', () => {
  const b1 = findByLabel(exampleSnapshot(), 'B1');
  b1.timeline.subagents = Array.from({ length: 5 }, (_, index) => ({ id: `x${index}`, start: NOW - HOUR, end: null, type: 'task' }));
  const svg = laneSvg(b1, 600, NOW - 3 * HOUR, NOW, NOW, 0);
  assert.equal((svg.match(/class="t-sub/g) ?? []).length, 3);
  assert.match(svg, /^<svg width="600" height="48"/);
});

test('marks follow the mockup shapes and colour reports by status', () => {
  assert.match(markSvg({ kind: 'report', status: 'progress', text: 'x' }, 10, 10), /fill="var\(--busy-ink\)"/);
  assert.match(markSvg({ kind: 'report', status: 'blocked', text: 'x' }, 10, 10), /fill="var\(--blocked-ink\)"/);
  assert.match(markSvg({ kind: 'report', status: 'complete', text: 'x' }, 10, 10), /fill="var\(--merged-ink\)"/);
  assert.match(markSvg({ kind: 'question', status: null, text: '<q>' }, 10, 10), /^<path d="M10 5L15 10L10 15L5 10Z" fill="var\(--question-ink\)".*<title>&lt;q&gt;<\/title>/);
  assert.equal(markSvg({ kind: 'unknown', status: null, text: '' }, 0, 0), '');
});

test('drawing the timeline never changes the snapshot', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  assert.doesNotThrow(() => {
    for (const span of ['3h', '12h', 'run']) {
      const { t0, t1 } = timelineWindow(snapshot, span, NOW);
      timelineHtml(context(snapshot), span);
      axisSvg(600, t0, t1);
      for (const session of [snapshot.orchestrator, ...snapshot.units]) laneSvg(session, 600, t0, t1, NOW);
      costSvg(snapshot.cost, 600, t0, t1, NOW);
    }
  });
});

test('the axis labels "now" and spaced ticks; the cost line runs up to the swarm total', () => {
  const axis = axisSvg(600, NOW - 12 * HOUR, NOW);
  assert.match(axis, />now<\/text>/);
  assert.ok((axis.match(/<line /g) ?? []).length >= 2);
  const snapshot = exampleSnapshot();
  const cost = costSvg(snapshot.cost, 600, NOW - 12 * HOUR, NOW, NOW);
  assert.match(cost, /d="M4\.0 36\.0L/);
  assert.match(cost, /<circle cx="592" cy="4\.0" r="3"/);
  assert.match(costSvg({ ...snapshot.cost, series: [] }, 600, NOW - HOUR, NOW, NOW), /d="M4\.0 36\.0L592\.0 36\.0"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-timeline.test.mjs`
Expected: FAIL (`does not provide an export named 'markSvg'`).

- [ ] **Step 3: Replace `ui/timeline.mjs`**

```js
import { HOUR, MIN, ago, costHtml, costText, dur, elapsed, esc } from './format.mjs';
import { REPORT_CLASS, TIMELINE_WORDS, unitEnd } from './model.mjs';
import { fill, phase } from './parts.mjs';

export const SPANS = Object.freeze({ '3h': 3 * HOUR, '12h': 12 * HOUR, run: null });
const SPAN_LABELS = { '3h': 'last 3h', '12h': 'last 12h', run: 'whole run' };
const PRIORITY = { question: 5, answer: 4, 'plan-req': 4, 'plan-ok': 4, 'pr-merged': 4, archived: 4, 'pr-open': 3, tool: 3, report: 2, 'pr-comment': 1 };
const KEYS = [['report', 'report'], ['question', 'question'], ['plan-req', 'plan sent'], ['plan-ok', 'plan approved'], ['pr-open', 'PR'], ['monitor', 'monitor check']];
const REPORT_INK = { blocked: '--blocked-ink', progress: '--busy-ink', needs_input: '--question-ink' };
const HATCH = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><pattern id="cHatch2" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="var(--stuck-soft)"/><rect width="2" height="4" fill="var(--stuck)"/></pattern></defs></svg>';
const r1 = value => Math.round(value * 10) / 10;
const pad = value => String(value).padStart(2, '0');

export function timelineWindow(snapshot, span, now) {
  const length = SPANS[span];
  return { t0: length ? now - length : snapshot.run.startedAt - 20 * MIN, t1: now };
}

/** One timeline marker centred on (x, y), with the mockup's shapes. */
export function markSvg(mark, x, y) {
  const title = `<title>${esc(mark.text)}</title>`;
  const at = (dx, dy) => `${r1(x + dx)} ${r1(y + dy)}`;
  switch (mark.kind) {
    case 'report': return `<circle cx="${r1(x)}" cy="${r1(y)}" r="4" fill="var(${REPORT_INK[mark.status] ?? '--merged-ink'})" stroke="var(--surface)" stroke-width="1.5">${title}</circle>`;
    case 'question': return `<path d="M${at(0, -5)}L${at(5, 0)}L${at(0, 5)}L${at(-5, 0)}Z" fill="var(--question-ink)" stroke="var(--surface)" stroke-width="1.5">${title}</path>`;
    case 'answer': return `<path d="M${at(0, -4)}L${at(4, 0)}L${at(0, 4)}L${at(-4, 0)}Z" fill="var(--surface)" stroke="var(--question-ink)" stroke-width="1.5">${title}</path>`;
    case 'plan-req': return `<rect x="${r1(x - 3.5)}" y="${r1(y - 3.5)}" width="7" height="7" fill="var(--surface)" stroke="var(--plan-ink)" stroke-width="1.5">${title}</rect>`;
    case 'plan-ok': return `<rect x="${r1(x - 4)}" y="${r1(y - 4)}" width="8" height="8" fill="var(--plan-ink)" stroke="var(--surface)" stroke-width="1">${title}</rect>`;
    case 'pr-open': return `<path d="M${at(-4.5, 4)}L${at(0, -4.5)}L${at(4.5, 4)}Z" fill="var(--ink-2)" stroke="var(--surface)" stroke-width="1">${title}</path>`;
    case 'pr-merged': return `<path d="M${at(-4.5, 4)}L${at(0, -4.5)}L${at(4.5, 4)}Z" fill="var(--merged-ink)" stroke="var(--surface)" stroke-width="1">${title}</path>`;
    case 'archived': return `<circle cx="${r1(x)}" cy="${r1(y)}" r="3.5" fill="var(--surface)" stroke="var(--archived-ink)" stroke-width="1.5">${title}</circle>`;
    case 'pr-comment': return `<rect x="${r1(x - 1)}" y="${r1(y - 5)}" width="2" height="10" fill="var(--ink-2)">${title}</rect>`;
    case 'tool': return `<rect x="${r1(x - 1)}" y="${r1(y - 5)}" width="2" height="10" fill="var(--stuck-ink)">${title}</rect>`;
    case 'monitor': return `<line class="t-mon" x1="${r1(x)}" y1="${r1(y - 3)}" x2="${r1(x)}" y2="${r1(y + 3)}">${title}</line>`;
    default: return '';
  }
}

/** One session's lane: state spans, up to three sub-agent tracks, monitor ticks and thinned markers. */
export function laneSvg(session, width, t0, t1, now, phaseMs = 0) {
  const X0 = 4;
  const X1 = width - 8;
  const k = (X1 - X0) / (t1 - t0);
  const X = t => X0 + (t - t0) * k;
  const { segments, subagents, marks } = session.timeline;
  let spans = '';
  for (const segment of segments) {
    const end = segment.end ?? now;
    if (end <= t0 || segment.start >= t1) continue;
    const x1 = X(Math.max(segment.start, t0));
    const wide = Math.max(1, X(Math.min(end, t1)) - x1);
    const live = segment.end === null;
    if (segment.state === 'idle') spans += `<line class="t-idle" x1="${x1.toFixed(1)}" y1="10" x2="${(x1 + wide).toFixed(1)}" y2="10"/>`;
    else spans += `<rect class="t-${segment.state}${live && segment.state === 'stuck' ? ' live' : ''}" x="${x1.toFixed(1)}" y="5" width="${wide.toFixed(1)}" height="10" rx="2"${live && segment.state === 'stuck' ? ` ${phase(2.4, phaseMs)}` : ''}/>`;
    if (live && segment.state === 'busy') spans += `<rect class="t-edge" x="${(x1 + wide - 2).toFixed(1)}" y="5" width="2" height="10" ${phase(2, phaseMs)}/>`;
  }
  const tracks = [];
  let bars = '';
  for (const bar of subagents.filter(item => (item.end ?? now) > t0 && item.start < t1).sort((a, b) => a.start - b.start)) {
    const x1 = X(Math.max(bar.start, t0));
    const x2 = Math.max(x1 + 2, X(Math.min(bar.end ?? now, t1)));
    let track = tracks.findIndex(end => end + 2 <= x1);
    if (track < 0) {
      if (tracks.length >= 3) continue;
      tracks.push(0);
      track = tracks.length - 1;
    }
    tracks[track] = x2;
    bars += `<rect class="t-sub${bar.end === null ? ' live' : ''}" x="${x1.toFixed(1)}" y="${24 + track * 8}" width="${(x2 - x1).toFixed(1)}" height="4" rx="1"><title>${esc(bar.type)}</title></rect>`;
  }
  let ticks = '';
  const kept = [];
  let last = -99;
  let lastPriority = 0;
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    if (mark.at < t0 || mark.at > t1) continue;
    const x = X(mark.at);
    if (mark.kind === 'monitor') {
      if (k * 10 * MIN >= 4) ticks += markSvg(mark, x, 19);
      continue;
    }
    const priority = PRIORITY[mark.kind] ?? 1;
    if (x - last < 12) {
      if (priority > lastPriority) {
        kept[kept.length - 1] = { mark, x };
        last = x;
        lastPriority = priority;
      }
      continue;
    }
    kept.push({ mark, x });
    last = x;
    lastPriority = priority;
  }
  const height = 20 + (tracks.length ? 4 + tracks.length * 8 : 4);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line class="t-now" x1="${X1}" y1="0" x2="${X1}" y2="${height}"/>${spans}${ticks}${bars}${kept.map(({ mark, x }) => `<g>${markSvg(mark, x, 10)}</g>`).join('')}</svg>`;
}

/** Time axis with local-time ticks that never overlap and stay clear of "now". */
export function axisSvg(width, t0, t1) {
  const X0 = 4;
  const X1 = width - 8;
  const k = (X1 - X0) / (t1 - t0);
  const span = t1 - t0;
  const step = span <= 3 * HOUR ? 30 * MIN : span <= 12 * HOUR ? 2 * HOUR : span <= 72 * HOUR ? 12 * HOUR : 24 * HOUR;
  const offset = new Date(t0).getTimezoneOffset() * MIN;
  let out = `<g class="t-axis"><text x="${X1}" y="12" text-anchor="end">now</text>`;
  let lastEnd = -99;
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t < t1; t += step) {
    const x = X0 + (t - t0) * k;
    const date = new Date(t);
    const label = step >= 12 * HOUR ? `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${pad(date.getHours())}:00` : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const half = (label.length * 7) / 2;
    if (x - half < lastEnd + 8 || x + half > X1 - 36 || x - half < 0) continue;
    out += `<line x1="${x.toFixed(1)}" y1="16" x2="${x.toFixed(1)}" y2="20"/><text x="${x.toFixed(1)}" y="12" text-anchor="middle">${label}</text>`;
    lastEnd = x + half;
  }
  return `<svg width="${width}" height="20" viewBox="0 0 ${width} 20" aria-hidden="true">${out}</g></svg>`;
}

/** Cumulative swarm cost over the window, from the snapshot's 5-minute series, ending at the current total. */
export function costSvg(cost, width, t0, t1, now) {
  const X0 = 4;
  const X1 = width - 8;
  const H = 40;
  const k = (X1 - X0) / (t1 - t0);
  const points = cost.series.filter(point => point.at >= t0 && point.at <= t1).map(point => [point.at, point.credits]);
  const before = cost.series.filter(point => point.at < t0).pop();
  if (before) points.unshift([t0, before.credits]);
  points.push([Math.min(now, t1), cost.credits]);
  if (points.length < 2) points.unshift([t0, points[0][1]]);
  const lo = points[0][1];
  const hi = points[points.length - 1][1];
  const Y = value => H - 4 - (hi === lo ? 0 : ((value - lo) / (hi - lo)) * (H - 8));
  const d = points.map(([t, value], index) => `${index ? 'L' : 'M'}${(X0 + (t - t0) * k).toFixed(1)} ${Y(value).toFixed(1)}`).join('');
  return `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" aria-hidden="true"><path class="t-cost" d="${d}"/><circle cx="${X1}" cy="${Y(hi).toFixed(1)}" r="3" fill="var(--ink-2)"/></svg>`;
}

function whoHtml(session, snapshot, now) {
  const isOrchestrator = session === snapshot.orchestrator;
  const end = isOrchestrator ? null : unitEnd(session);
  const runtime = end ? `ran ${dur(end - session.startedAt)}` : elapsed(session.startedAt, now);
  return `<div class="c-name"><span class="dot${session.status === 'stuck' ? ' stuck' : ''}"></span><span class="tx">${esc(isOrchestrator ? session.name : `${session.label} ${session.name}`)}</span></div>`
    + `<div class="c-meta">${runtime} · ${costText(session.cost.credits)}</div>`;
}

function sumHtml(session, snapshot, now) {
  if (session === snapshot.orchestrator) return `<div class="c-rep">${esc(session.activity.label)}</div><div class="c-meta">orchestrator</div>`;
  const words = TIMELINE_WORDS[session.status];
  const state = words ? `<span class="s">${fill(words, session.since, now)}</span>` : '';
  if (!session.report) return `<div class="c-rep muted">No report yet</div><div class="c-meta">${state || '&nbsp;'}</div>`;
  return `<div class="c-rep rp-${REPORT_CLASS[session.report.status]}"><span class="dot"></span>${esc(session.report.title)}</div>`
    + `<div class="c-meta">${ago(session.report.at, now)}${state ? ` · ${state}` : ''}</div>`;
}

export function timelineHtml(ctx, span) {
  const { snapshot, now } = ctx;
  const sessions = [snapshot.orchestrator, ...snapshot.units];
  const buttons = Object.keys(SPANS).map(key => `<button type="button" data-span="${key}" aria-pressed="${key === span}">${SPAN_LABELS[key]}</button>`).join('');
  const keys = KEYS.map(([kind, label]) => `<span><svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true">${markSvg({ kind, status: 'complete', text: label }, 0, 0)}</svg>${label}</span>`).join('');
  const axis = '<div class="c-row c-axis"><div class="c-who"><span class="c-head">Session</span></div><div class="c-trk" data-drawn></div><div class="c-sum"><span class="c-head">Latest report</span></div></div>';
  const rows = sessions.map(session => `<div class="c-row st-${session.status}" data-id="${esc(session.id)}"><div class="c-who">${whoHtml(session, snapshot, now)}</div><div class="c-trk" data-drawn></div><div class="c-sum">${sumHtml(session, snapshot, now)}</div></div>`).join('');
  const cost = `<div class="c-row c-cost"><div class="c-who"><div class="c-name">Swarm cost</div><div class="c-meta">all sessions</div></div><div class="c-trk" data-drawn></div><div class="c-sum"><span class="c-total">${costHtml(snapshot.cost.credits, true)}</span></div></div>`;
  return `<div class="c" data-timeline><div class="c-bar"><div class="seg" role="group" aria-label="Time window">${buttons}</div><div class="c-keys">${keys}</div></div>${HATCH}<div class="c-rows">${axis}${rows}${cost}</div></div>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-timeline.test.mjs tests/ui-app.test.mjs`
Expected: PASS (9 + 10 tests).

- [ ] **Step 5: Look at it in a browser and commit**

Run `npm start -- --demo`, open `http://127.0.0.1:7927/?tab=timeline` at full width and at 560 px, and compare with the mockup's Timeline (all three windows). Then:

```bash
git add ghcp/plugins/swarm-dashboard/ui/timeline.mjs ghcp/plugins/swarm-dashboard/tests/ui-timeline.test.mjs
git commit -m "feat(swarm-dashboard): add the timeline view"
```

### Task 13: Plan and Board

**Files:**
- Replace: `ghcp/plugins/swarm-dashboard/ui/plan.mjs` (the Task 7 stub)
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-plan.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`costText`, `esc`), Task 2 (`BOARD_WORDS`, `PLAN_WORDS`, `STAGE_CLASS`, `STAGE_NAMES`, `boardColumns`, `findByLabel`, `findPlanned`, `flattenPlan`, `planForest`, `planLayout`), Task 3 (`fill`).
- Produces (same names as the stub): `NODE` (`{ width: 176, height: 62, column: 216, row: 78 }`), `planSize(snapshot): { width, height }`, `planFits(snapshot, width): boolean` (graph when the container is at least `max(824, graph width)` wide, else the indented list), `planGraphHtml(snapshot, now)`, `planListHtml(snapshot, now)`, `boardHtml(ctx)`.

- [ ] **Step 1: Write the failing test**

`tests/ui-plan.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardHtml, planFits, planGraphHtml, planListHtml, planSize } from '../ui/plan.mjs';
import { NOW, closedSnapshot, context, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const node = (html, label) => html.split(/<(?:div|li) class="(?:pn|pl-row) /).find(part => part.includes(`<span class="tx">${label} `));

test('the graph needs 824 px or its own width, whichever is larger', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(planSize(snapshot), { width: 824, height: 452 });
  assert.equal(planFits(snapshot, 824), true);
  assert.equal(planFits(snapshot, 823), false);
  snapshot.planned.push(
    { label: 'Z1', name: 'one', dependsOn: 'I2', canStart: false, waitsOn: 'I2', todoId: null },
    { label: 'Z2', name: 'two', dependsOn: 'Z1', canStart: false, waitsOn: 'Z1', todoId: null },
    { label: 'Z3', name: 'three', dependsOn: 'Z2', canStart: false, waitsOn: 'Z2', todoId: null },
  );
  assert.equal(planSize(snapshot).width, 1472);
  assert.equal(planFits(snapshot, 1000), false);
  assert.equal(planFits(snapshot, 1472), true);
});

test('the graph places stacked branches left to right and links them', () => {
  const html = planGraphHtml(exampleSnapshot(), NOW);
  assert.match(html, /<div class="legend"><span><i class="sw stg-planned"><\/i>Planned<\/span>/);
  assert.match(html, /<div class="plan-g" style="width:824px;height:452px">/);
  assert.equal((html.match(/<div class="pn /g) ?? []).length, 9);
  assert.equal((html.match(/<path /g) ?? []).length, 8);
  assert.match(node(html, 'B0'), /^stg-archived st-archived" style="left:0px;top:215px;width:176px;height:62px" data-open="ws-0001-b0"/);
  assert.match(node(html, 'I2'), /^stg-planned st-planned" style="left:648px;top:78px;width:176px;height:62px">/);
  assert.match(node(html, 'B3'), /^stg-planned st-planned can"/);
  assert.match(text(node(html, 'I1')), /I1 integration Coding · stuck 48m/);
  assert.match(text(node(html, 'I2')), /I2 load tests waits on I1 \(coding\)/);
  assert.match(text(node(html, 'B3')), /B3 export can start now/);
  assert.match(text(node(html, 'B1')), /B1 API In review · busy/);
  assert.match(text(node(html, 'F2a')), /F2a tests, part 1 Merged/);
});

test('the indented list shows the same plan for narrow widths', () => {
  const html = planListHtml(exampleSnapshot(), NOW);
  assert.deepEqual([...html.matchAll(/style="margin-left:(\d+)px"/g)].map(match => Number(match[1])), [0, 16, 16, 32, 48, 32, 32, 16, 16]);
  assert.match(text(node(html, 'F2a')), /F2a tests, part 1 Merged · on B0/);
  assert.match(node(html, 'I1'), /data-open="ws-0005-i1"/);
  assert.doesNotMatch(node(html, 'B3'), /data-open/);
});

test('an empty plan says so', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = [];
  snapshot.planned = [];
  assert.match(planGraphHtml(snapshot, NOW), /No plan yet\./);
  assert.match(planListHtml(snapshot, NOW), /No plan yet\./);
});

test('the plan and the board never change the snapshot', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  assert.doesNotThrow(() => {
    planFits(snapshot, 1200);
    planGraphHtml(snapshot, NOW);
    planListHtml(snapshot, NOW);
    boardHtml(context(snapshot));
  });
});

test('a unit whose PR closed without merging stays in the PR open column with the badge', () => {
  const columns = boardHtml(context(closedSnapshot())).split('<section class="bcol"');
  const prOpen = columns.find(part => part.startsWith(' aria-label="PR open"'));
  assert.match(prOpen, /D5 [^<]*<\/span><\/div><div class="mc-2"><span class="badge rp-blocked">closed, not merged<\/span><\/div>/);
});

test('the board has one column per stage with counts, attention first', () => {
  const snapshot = exampleSnapshot();
  const html = boardHtml(context(snapshot));
  assert.deepEqual([...html.matchAll(/<b>([^<]+)<\/b>(\d+)/g)].map(match => `${match[1]} ${match[2]}`), ['Planned 2', 'Coding 3', 'PR open 1', 'In review 1', 'Merged 1', 'Archived 1']);
  const coding = html.split('<section class="bcol" aria-label="Coding">')[1].split('</section>')[0];
  assert.deepEqual([...coding.matchAll(/data-open="([^"]+)"/g)].map(match => match[1]), ['ws-0005-i1', 'ws-0004-b2', 'ws-0006-f1']);
  assert.match(text(coding), /I1 integration stuck 48m 9,702 cr · ≈\$97\.02/);
  assert.match(html, /<div class="mc planned st-planned can"><div class="mc-1"><span class="tx">B3 export<\/span><\/div><div class="mc-2">can start now<\/div><div class="mc-3">stacks on B1<\/div><\/div>/);
  assert.match(text(html), /I2 load tests waits on I1 stacks on I1/);
  assert.match(text(html), /B0 schema archived 1d 4h ago/);
  snapshot.planned = [];
  assert.match(boardHtml(context(snapshot)), /<b>Planned<\/b>0<\/div><span class="none">None<\/span>/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-plan.test.mjs`
Expected: FAIL (`does not provide an export named 'planSize'`).

- [ ] **Step 3: Replace `ui/plan.mjs`**

```js
import { costText, esc } from './format.mjs';
import {
  BOARD_WORDS, PLAN_WORDS, STAGE_CLASS, STAGE_NAMES, boardColumns, closedNotMerged, findByLabel, findPlanned, flattenPlan, planForest, planLayout,
} from './model.mjs';
import { closedBadge, fill } from './parts.mjs';

/** Plan graph geometry from the mockup: node size, column step and row step in px. */
export const NODE = Object.freeze({ width: 176, height: 62, column: 216, row: 78 });
const LEGEND = ['planned', 'coding', 'pr_open', 'in_review', 'merged', 'archived'];

export function planSize(snapshot) {
  const { rows, maxDepth } = planLayout(planForest(snapshot));
  return { width: maxDepth * NODE.column + NODE.width, height: Math.max(0, rows - 1) * NODE.row + NODE.height };
}
export const planFits = (snapshot, width) => width >= Math.max(824, planSize(snapshot).width);

function legendHtml() {
  const swatches = LEGEND.map(stage => `<span><i class="sw stg-${STAGE_CLASS[stage]}"></i>${STAGE_NAMES[stage]}</span>`).join('');
  return `<div class="legend">${swatches}<span class="note">Solid blue outline: can start now, because its parent branch has a PR open or is merged.</span></div>`;
}

function planLine(node, snapshot, now) {
  if (node.planned) {
    if (node.planned.canStart) return '<span class="s">can start now</span>';
    const label = node.planned.waitsOn ?? node.planned.dependsOn;
    if (!label) return 'planned';
    const target = findByLabel(snapshot, label) ?? (findPlanned(snapshot, label) ? { stage: 'planned' } : null);
    return `waits on ${esc(label)}${target ? ` (${STAGE_NAMES[target.stage].toLowerCase()})` : ''}`;
  }
  const unit = node.unit;
  if (unit.status === 'merged' || unit.status === 'archived') return STAGE_NAMES[unit.stage];
  const words = PLAN_WORDS[unit.status];
  return `${STAGE_NAMES[unit.stage]}${words ? ` · <span class="s">${fill(words, unit.since, now)}</span>` : ''}`;
}

const nodeClass = node => `stg-${STAGE_CLASS[node.stage]} st-${node.status}${node.planned?.canStart ? ' can' : ''}`;
const openAttrs = node => (node.unit ? ` data-open="${esc(node.unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(node.label)}"` : '');
const nameHtml = node => `<div class="pn-1"><span class="dot"></span><span class="tx">${esc(node.label)} ${esc(node.name)}</span></div>`;
const emptyPlan = () => `${legendHtml()}<p class="none">No plan yet.</p>`;

/** Units as a dependency graph of stacked branches, coloured by stage. */
export function planGraphHtml(snapshot, now) {
  const roots = planForest(snapshot);
  if (!roots.length) return emptyPlan();
  const { pos, rows, maxDepth } = planLayout(roots);
  const width = maxDepth * NODE.column + NODE.width;
  const height = Math.max(0, rows - 1) * NODE.row + NODE.height;
  const xy = node => ({ x: pos.get(node).depth * NODE.column, y: Math.round(pos.get(node).row * NODE.row) });
  let paths = '';
  for (const node of pos.keys()) {
    for (const child of node.children) {
      const a = xy(node);
      const b = xy(child);
      const mid = a.x + NODE.width + (NODE.column - NODE.width) / 2;
      paths += `<path d="M${a.x + NODE.width} ${a.y + NODE.height / 2}H${mid}V${b.y + NODE.height / 2}H${b.x}"/>`;
    }
  }
  const nodes = [...pos.keys()].map(node => {
    const { x, y } = xy(node);
    return `<div class="pn ${nodeClass(node)}" style="left:${x}px;top:${y}px;width:${NODE.width}px;height:${NODE.height}px"${openAttrs(node)}>${nameHtml(node)}<div class="pn-2">${planLine(node, snapshot, now)}</div></div>`;
  }).join('');
  return `${legendHtml()}<div class="plan-g" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" aria-hidden="true">${paths}</svg>${nodes}</div>`;
}

/** The same plan as an indented list, for narrow widths and the side panel. */
export function planListHtml(snapshot, now) {
  const rows = flattenPlan(planForest(snapshot));
  if (!rows.length) return emptyPlan();
  const items = rows.map(({ node, depth }) => `<li class="pl-row ${nodeClass(node)}" style="margin-left:${depth * 16}px"${openAttrs(node)}>${nameHtml(node)}<div class="pn-2">${planLine(node, snapshot, now)}${node.dependsOn ? ` · on ${esc(node.dependsOn)}` : ''}</div></li>`);
  return `${legendHtml()}<ol class="pl">${items.join('')}</ol>`;
}

function miniCard(node, now) {
  if (node.planned) {
    const entry = node.planned;
    const waits = entry.waitsOn ?? entry.dependsOn;
    return `<div class="mc planned st-planned${entry.canStart ? ' can' : ''}"><div class="mc-1"><span class="tx">${esc(entry.label)} ${esc(entry.name)}</span></div>`
      + `<div class="mc-2">${entry.canStart ? 'can start now' : waits ? `waits on ${esc(waits)}` : 'not started'}</div>`
      + `<div class="mc-3">${entry.dependsOn ? `stacks on ${esc(entry.dependsOn)}` : 'no parent branch'}</div></div>`;
  }
  const unit = node.unit;
  return `<div class="mc st-${unit.status}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(unit.label)}">`
    + `<div class="mc-1"><span class="dot"></span><span class="tx">${esc(unit.label)} ${esc(unit.name)}</span></div>`
    + `<div class="mc-2">${closedNotMerged(unit) ? closedBadge : fill(BOARD_WORDS[unit.status] ?? unit.status, unit.since, now)}</div><div class="mc-3">${costText(unit.cost.credits)}</div></div>`;
}

/** One column per stage, including planned units. */
export function boardHtml({ snapshot, now }) {
  const columns = boardColumns(snapshot).map(({ stage, nodes }) => `<section class="bcol" aria-label="${STAGE_NAMES[stage]}"><div class="bcol-h"><i class="sw stg-${STAGE_CLASS[stage]}"></i><b>${STAGE_NAMES[stage]}</b>${nodes.length}</div>`
    + `${nodes.map(node => miniCard(node, now)).join('') || '<span class="none">None</span>'}</section>`);
  return `<div class="board">${columns.join('')}</div>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-plan.test.mjs tests/ui-app.test.mjs`
Expected: PASS (7 + 10 tests).

- [ ] **Step 5: Look at it in a browser and commit**

Run `npm start -- --demo`, open `http://127.0.0.1:7927/?tab=plan` and `?tab=board` at 1920, 1280 and 560 px (the example plan shows the graph from 1280 px and the list below that), then repeat with `--demo stress`, whose eight-level plan is wider than any main column and always shows the list. Compare with the mockup's Plan and Board. Then:

```bash
git add ghcp/plugins/swarm-dashboard/ui/plan.mjs ghcp/plugins/swarm-dashboard/tests/ui-plan.test.mjs
git commit -m "feat(swarm-dashboard): add the plan graph and the stage board"
```

### Task 14: History and run summary

**Files:**
- Replace: `ghcp/plugins/swarm-dashboard/ui/history.mjs` (the Task 7 stub)
- Test: `ghcp/plugins/swarm-dashboard/tests/ui-history.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`HOUR`, `costHtml`, `costText`, `count`, `credits`, `dateRange`, `dur`, `esc`, `plural`); `RunListItem` and `RunSummary` from the schema.
- Produces (same names as the stub): `historyHtml(runs)` (`runs` null while loading) and `runHtml(run)` (`run` null while loading, `false` when the engine has no summary). The summary answers time and cost first, then breaks both down by unit, model and sub-agent type, and shows when the first child started (spec call 12).

- [ ] **Step 1: Write the failing test**

`tests/ui-history.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, dateRange } from '../ui/format.mjs';
import { historyHtml, runHtml } from '../ui/history.mjs';
import { fixture } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the history list shows each finished run with time and cost first', () => {
  const runs = fixture('example-history.json');
  const html = historyHtml(runs);
  assert.match(text(html), /^Finished runs 2 runs Run Dates Took Busy Cost Merged/);
  assert.deepEqual([...html.matchAll(/data-run="([^"]+)"/g)].map(match => match[1]), ['ws-1000-root', 'ws-2000-root']);
  assert.ok(text(html).includes(`Sample story A sample-project ${dateRange(runs[0].startedAt, runs[0].finishedAt)} Took 72h 10m Busy 50h 30m 49,160 cr · ≈$492 Merged 3 of 4`));
  assert.ok(text(html).includes('Took 8h 45m Busy — 6,320 cr · ≈$63 Merged —'));
  assert.match(historyHtml(null), /Loading finished runs…/);
  assert.match(text(historyHtml([])), /No finished runs yet A run moves here once nothing has happened in it for 2 hours\./);
});

test('the run summary answers how long it took and what it cost', () => {
  const summary = fixture('example-run-summary.json');
  const html = runHtml(summary);
  const words = text(html);
  assert.match(html, /<button type="button" class="link" data-page="history">← All runs<\/button>/);
  assert.match(words, /Sample story A sample-project · finished/);
  assert.ok(words.includes(`Took, start to finish 72h 10m ${dateRange(summary.startedAt, summary.finishedAt)}`));
  assert.match(words, /Cost 49,160 cr · ≈\$492 orchestrator, 4 children and 23 sub-agents/);
  assert.match(words, /Agent busy time 50h 30m Waiting on you 7h 40m Children 4, 3 merged Sub-agents 23 First child 18m after the start/);
});

test('time by unit draws start-to-finish spans with busy time, and marks units closed without merging', () => {
  const html = runHtml(fixture('example-run-summary.json'));
  assert.equal((html.match(/<div class="g-row">/g) ?? []).length, 5);
  assert.match(text(html), /SA orchestrator busy 19h 24m/);
  assert.match(text(html), /P1 perf busy 5h 12m, not merged/);
  assert.match(html, /<span class="g-span no" style="left:69\.28%;width:22\.17%"><\/span>/);
  assert.match(html, /<span class="g-span" style="left:0\.00%;width:100\.00%"><\/span>/);
  assert.deepEqual([...html.matchAll(/<span style="left:[\d.]+%">(\d+h)<\/span>/g)].map(match => match[1]), ['0h', '12h', '24h', '36h', '48h', '60h', '72h']);
});

test('bars stay inside the track when a unit starts before the run or ends after it', () => {
  const summary = fixture('example-run-summary.json');
  const [orchestrator, first, second] = summary.units;
  const late = { ...first, endedAt: summary.finishedAt + 3 * HOUR };
  const early = { ...second, startedAt: summary.startedAt - HOUR };
  const html = runHtml({ ...summary, units: [orchestrator, late, early] });
  const bars = [...html.matchAll(/class="g-(span|busy)[^"]*" style="left:([\d.]+)%;width:([\d.]+)%"/g)].map(([, kind, left, width]) => ({ kind, left: Number(left), width: Number(width) }));
  assert.equal(bars.length, 6);
  for (const bar of bars) assert.ok(bar.left + bar.width <= 100.005, `${bar.kind} ${bar.left} + ${bar.width}`);
  assert.deepEqual(bars[4], { kind: 'span', left: 0, width: Number((((early.endedAt - summary.startedAt) / summary.tookMs) * 100).toFixed(2)) });
  assert.ok(text(html).includes('A1 model busy 6h 06m 74h 52m'));
});

test('cost breaks down by unit, by model and by sub-agent type', () => {
  const html = runHtml(fixture('example-run-summary.json'));
  const byUnit = html.split('<h3>Cost by unit</h3>')[1].split('</section>')[0];
  assert.deepEqual([...byUnit.matchAll(/<span class="hb-l">([^<]+)<\/span>/g)].map(match => match[1]), ['SA orchestrator', 'A3 API', 'S1 security', 'A1 model', 'P1 perf']);
  assert.match(text(html), /claude-sonnet-5 30,160 cr · ≈\$301\.60 · 5h 00m/);
  assert.match(text(html), /23 runs, 1h 25m, 5,900 cr\. Already included in the unit costs\./);
  assert.match(text(html), /code-review · 9 runs · 0h 45m 4,100 cr · ≈\$41\.00/);
});

test('loading, missing and empty summaries', () => {
  assert.match(runHtml(null), /Loading the run summary…/);
  assert.match(text(runHtml(false)), /← All runs This run's summary is not available\./);
  const summary = { ...fixture('example-run-summary.json'), models: [], subagentTypes: [], firstChildAt: null };
  const words = text(runHtml(summary));
  assert.match(words, /No model calls recorded\./);
  assert.match(words, /No sub-agents in this run\./);
  assert.match(words, /First child none/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-history.test.mjs`
Expected: FAIL (the stub renders "History is not built yet.").

- [ ] **Step 3: Replace `ui/history.mjs`**

```js
import { HOUR, costHtml, costText, count, credits, dateRange, dur, esc, plural } from './format.mjs';

const pct = (value, total) => (total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0).toFixed(2);
const unitName = unit => (unit.isOrchestrator ? `${unit.label} orchestrator` : `${unit.label} ${unit.name}`);

function ticksFor(hours) {
  const step = hours <= 6 ? 1 : hours <= 24 ? 4 : hours <= 96 ? 12 : hours <= 240 ? 24 : 48;
  const ticks = [];
  for (let hour = 0; hour <= hours + 1e-9; hour += step) ticks.push(hour);
  return ticks;
}

function barRows(rows) {
  const max = Math.max(0, ...rows.map(row => row.value));
  return rows.map(row => `<div class="hb-row"><span class="hb-l">${esc(row.label)}</span><span class="hb-v">${row.text}</span><span class="bar"><i style="width:${pct(row.value, max)}%"></i></span></div>`).join('');
}

export function historyHtml(runs) {
  if (runs === null) return '<p class="none">Loading finished runs…</p>';
  if (!runs.length) return '<div class="empty"><h3>No finished runs yet</h3><p class="small muted">A run moves here once nothing has happened in it for 2 hours.</p></div>';
  const rows = runs.map(run => `<div class="h-row" data-run="${esc(run.id)}" tabindex="0" role="button" aria-label="Open the ${esc(run.name)} summary">`
    + `<span class="h-run"><span class="h-name">${esc(run.name)}</span><span class="small muted">${esc(run.project?.name ?? 'no project')}</span></span>`
    + `<span class="small muted">${dateRange(run.startedAt, run.finishedAt)}</span>`
    + `<span class="h-cell"><span class="k">Took </span>${run.tookMs == null ? '—' : dur(run.tookMs, 'hm')}</span>`
    + `<span class="h-cell"><span class="k">Busy </span>${run.busyMs == null ? '—' : dur(run.busyMs, 'hm')}</span>`
    + `<span class="h-cell">${costHtml(run.credits, true)}</span>`
    + `<span class="h-cell"><span class="k">Merged </span>${run.merged == null ? '—' : `${count(run.merged)} of ${count(run.children)}`}</span></div>`).join('');
  return `<section class="sec" aria-label="Finished runs"><div class="sec-h"><h3>Finished runs</h3><span class="small muted">${plural(runs.length, 'run')}</span></div>`
    + `<div class="h-list"><div class="h-row h-th"><span>Run</span><span>Dates</span><span>Took</span><span>Busy</span><span>Cost</span><span>Merged</span></div>${rows}</div></section>`;
}

export function runHtml(run) {
  if (run === null) return '<p class="none">Loading the run summary…</p>';
  const back = '<button type="button" class="link" data-page="history">← All runs</button>';
  if (run === false) return `<div class="run"><div class="sec">${back}<p class="small muted">This run's summary is not available.</p></div></div>`;
  const took = Math.max(run.tookMs, 1);
  const gantt = run.units.map(unit => {
    const start = unit.startedAt - run.startedAt;
    const end = (unit.endedAt ?? run.finishedAt) - run.startedAt;
    // A unit can end after the run's last activity (a PR merged later), so clip its bars to the track.
    const from = Math.min(took, Math.max(0, start));
    const to = Math.min(took, Math.max(from, end));
    const closed = !unit.isOrchestrator && (unit.outcome === 'closed' || unit.outcome === 'failed');
    const note = closed ? (unit.outcome === 'failed' ? ', failed' : ', not merged') : '';
    return `<div class="g-row"><div class="g-lab"><span>${esc(unitName(unit))}</span><span class="small muted">busy ${dur(unit.busyMs, 'hm')}${note}</span></div>`
      + `<div class="g-track"><span class="g-span${closed ? ' no' : ''}" style="left:${pct(from, took)}%;width:${pct(to - from, took)}%"></span>`
      + `<span class="g-busy" style="left:${pct(from, took)}%;width:${pct(Math.min(unit.busyMs, took - from), took)}%"></span></div>`
      + `<span class="g-num">${dur(end - start, 'hm')}</span></div>`;
  }).join('');
  const axis = `<div class="g-axis"><div></div><div>${ticksFor(took / HOUR).map(hour => `<span style="left:${pct(hour * HOUR, took)}%">${hour}h</span>`).join('')}</div><div></div></div>`;
  const units = barRows([...run.units].sort((a, b) => b.credits - a.credits).map(unit => ({ label: unitName(unit), text: costText(unit.credits), value: unit.credits })));
  const models = run.models.length
    ? barRows(run.models.map(model => ({ label: model.model, text: `${costText(model.credits)} · ${dur(model.apiMs, 'hm')}`, value: model.credits })))
    : '<p class="none">No model calls recorded.</p>';
  const total = run.subagentTypes.reduce((sum, type) => ({ runs: sum.runs + type.runs, ms: sum.ms + type.durationMs, credits: sum.credits + type.credits }), { runs: 0, ms: 0, credits: 0 });
  const types = run.subagentTypes.length
    ? barRows(run.subagentTypes.map(type => ({ label: `${type.type} · ${plural(type.runs, 'run')} · ${dur(type.durationMs, 'hm')}`, text: costText(type.credits), value: type.credits })))
    : '<p class="none">No sub-agents in this run.</p>';
  const firstChild = run.firstChildAt ? `${dur(run.firstChildAt - run.startedAt)} after the start` : 'none';
  return `<div class="run"><div class="sec">${back}`
    + `<div class="sec-h"><h3>${esc(run.name)}</h3><span class="small muted">${esc(run.project?.name ?? 'no project')} · finished</span></div>`
    + `<div class="run-answer"><div class="kv"><span class="k">Took, start to finish</span><span class="v l">${dur(run.tookMs, 'hm')}</span><span class="small muted">${dateRange(run.startedAt, run.finishedAt)}</span></div>`
    + `<div class="kv"><span class="k">Cost</span><span class="v l">${costHtml(run.credits, true)}</span><span class="small muted">orchestrator, ${plural(run.children.total, 'child', 'children')} and ${plural(run.subagents, 'sub-agent')}</span></div></div>`
    + `<div class="run-sub"><div class="kv"><span class="k">Agent busy time</span><span class="v">${dur(run.busyMs, 'hm')}</span></div>`
    + `<div class="kv"><span class="k">Waiting on you</span><span class="v">${dur(run.waitingOnUserMs, 'hm')}</span></div>`
    + `<div class="kv"><span class="k">Children</span><span class="v">${count(run.children.total)}, ${count(run.children.merged)} merged</span></div>`
    + `<div class="kv"><span class="k">Sub-agents</span><span class="v">${count(run.subagents)}</span></div>`
    + `<div class="kv"><span class="k">First child</span><span class="v">${firstChild}</span></div></div></div>`
    + `<section class="sec"><h3>Time by unit</h3><p>Light bar: start to finish. Dark line: total busy time, drawn from the start. Peach: closed without merging.</p>${axis}<div class="gantt">${gantt}</div></section>`
    + `<div class="run-grid"><section class="sec"><h3>Cost by unit</h3><div class="hb">${units}</div></section>`
    + `<div class="sec"><section class="sec"><h3>Cost and time by model</h3><div class="hb">${models}</div></section>`
    + `<section class="sec"><h3>Sub-agents by type</h3><p>${plural(total.runs, 'run')}, ${dur(total.ms, 'hm')}, ${credits(total.credits)}. Already included in the unit costs.</p><div class="hb">${types}</div></section></div></div></div>`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ui-history.test.mjs tests/ui-app.test.mjs`
Expected: PASS (6 + 10 tests).

- [ ] **Step 5: Look at it in a browser and commit**

Run `npm start -- --demo`, open `http://127.0.0.1:7927/?page=history` and `?page=run&run=ws-1000-root` at full width and 560 px, and compare with the mockup's History and Run summary. Then:

```bash
git add ghcp/plugins/swarm-dashboard/ui/history.mjs ghcp/plugins/swarm-dashboard/tests/ui-history.test.mjs
git commit -m "feat(swarm-dashboard): add run history and the run summary"
```

### Task 15: Layout audit rules

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/scripts/lib/page-audit.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/page-audit.test.mjs`

**Interfaces:**
- Consumes: nothing (every function is self-contained so its source can run in the browser).
- Produces: `oklchToSrgb(l, c, h)`, `parseColor(text): {r,g,b,a}|null` (accepts `rgb()`, `rgba()`, `oklch()` and `color(srgb …)`, the formats Chrome 155 returns for computed colours, including resolved `color-mix()`), `composite(top, bottom)`, `luminance(color)`, `contrastRatio(a, b)` (WCAG 2), `showsEllipsis(style): boolean` (only block containers draw an ellipsis), `cutsBox(box, area, style): boolean` (an ancestor's hidden overflow cuts the box), `auditPage(options): { checks, issues: [{ rule, target, detail }] }`, `AUDIT_DEFAULTS`, `auditScript(options = AUDIT_DEFAULTS): string` (an expression for `Runtime.evaluate`).
- Rules (issue `rule` names): `overlap` (the visible parts of two boxes that are not nested intersect by more than 0.5 px; content clipped by an `overflow: hidden` ancestor does not count), `spill` (a block's text overflows a visible-overflow box), `clipped` (hidden overflow without an ellipsis that shows; flex and grid containers draw none), `hidden-lines` (a box's hidden overflow hides lines of its text), `cut` (an ancestor's hidden overflow cuts text off: across unless that ancestor shows an ellipsis, and down always), `outside` (text extends past its card, panel or row), `hscroll` (the page scrolls sideways), `font-family`, `font-size`, `line-height`, `font-weight`, `font-style`, `text-transform`, `letter-spacing`, `contrast` (below 4.5:1 against the composited background), `colour` (a computed colour the parser cannot read), `grid` (a padding or gap off the 4 px grid), `padding` (16 or 12 px where the spec says so), `height` (chips 24, badges and pills 20, buttons 28 or 24 in the timeline bar, rings 40, bars 4, history tracks 12).

- [ ] **Step 1: Write the failing test**

`tests/page-audit.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_DEFAULTS, auditScript, composite, contrastRatio, cutsBox, oklchToSrgb, parseColor, showsEllipsis } from '../scripts/lib/page-audit.mjs';

const close = (actual, expected, tolerance = 0.005) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not about ${expected}`);

test('colours parse from the computed formats Chrome returns', () => {
  assert.deepEqual(parseColor('rgb(118, 118, 118)'), { r: 118 / 255, g: 118 / 255, b: 118 / 255, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  const white = parseColor('oklch(1 0 0)');
  close(white.r, 1);
  close(white.g, 1);
  close(white.b, 1);
  assert.equal(parseColor('oklch(0.92784 0.01136 239.2 / 0.5)').a, 0.5);
  assert.equal(parseColor('oklch(50% 0.1 none)').a, 1);
  assert.deepEqual(parseColor('color(srgb 1 0 0)'), { r: 1, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('lab(50 20 30)'), null);
});

test('contrast follows WCAG 2 and reproduces the palette\'s round-2 measurements', () => {
  close(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }), 21);
  close(contrastRatio(parseColor('rgb(118, 118, 118)'), { r: 1, g: 1, b: 1 }), 4.542, 0.01);
  const surface = oklchToSrgb(0.993, 0.002, 250);
  close(contrastRatio(oklchToSrgb(0.30, 0.02, 255), surface), 13.36, 0.05);
  const archived = contrastRatio(oklchToSrgb(0.55, 0.012, 250), surface);
  assert.ok(archived >= 4.5 && archived < 4.9, `archived text on a board card: ${archived}`);
  close(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1, a: 1 }).r, 0.5);
});

test('only block containers show an ellipsis, so text a flex row cuts counts as cut', () => {
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'block' }), true);
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'inline-block' }), true);
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'flex' }), false);
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'inline-grid' }), false);
  assert.equal(showsEllipsis({ textOverflow: 'clip', display: 'block' }), false);
});

test('an ancestor cuts a box across unless it shows an ellipsis, and down always', () => {
  const area = { left: 0, top: 0, right: 100, bottom: 20 };
  const wide = { left: 10, top: 0, right: 160, bottom: 20 };
  const tall = { left: 10, top: 0, right: 90, bottom: 40 };
  const hidden = { overflowX: 'hidden', overflowY: 'hidden', textOverflow: 'clip', display: 'flex' };
  assert.equal(cutsBox(wide, area, hidden), true);
  assert.equal(cutsBox(tall, area, hidden), true);
  assert.equal(cutsBox({ left: 10, top: 0, right: 100.4, bottom: 20.4 }, area, hidden), false);
  const ellipsis = { ...hidden, textOverflow: 'ellipsis', display: 'block' };
  assert.equal(cutsBox(wide, area, ellipsis), false);
  assert.equal(cutsBox(tall, area, ellipsis), true);
  assert.equal(cutsBox(wide, area, { ...hidden, overflowX: 'visible', overflowY: 'visible' }), false);
  assert.equal(cutsBox(wide, area, { ...hidden, overflowX: 'auto' }), false);
  assert.equal(cutsBox(wide, area, { ...hidden, overflowX: 'clip' }), true);
});

test('the audit script is self-contained and carries its options', () => {
  const script = auditScript(AUDIT_DEFAULTS);
  assert.match(script, /^\(\(\) => \{/);
  assert.match(script, /function auditPage\(options\)/);
  assert.match(script, /"minContrast":4\.5/);
  assert.doesNotMatch(script, /\bimport\b|\bexport\b/);
  assert.doesNotThrow(() => new Function(script));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/page-audit.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/lib/page-audit.mjs'`.

- [ ] **Step 3: Write `scripts/lib/page-audit.mjs`**

```js
/**
 * The layout audit that check-layout.mjs runs inside the browser. Every function is self-contained (no imports, no
 * module-level values) because auditScript() sends their source into the page; Node tests import the colour helpers.
 */

/** OKLCH to gamma-encoded sRGB in 0..1 (OKLab matrices by Björn Ottosson), clamped to the sRGB gamut. */
export function oklchToSrgb(l, c, h) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  ];
  const encode = value => {
    const v = Math.min(1, Math.max(0, value));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return { r: encode(linear[0]), g: encode(linear[1]), b: encode(linear[2]) };
}

/** A computed CSS colour as { r, g, b, a } in 0..1, or null when the format is unknown. */
export function parseColor(text) {
  const value = String(text ?? '').trim().toLowerCase();
  const alpha = part => (part === undefined ? 1 : part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part));
  let match = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (match) return { r: match[1] / 255, g: match[2] / 255, b: match[3] / 255, a: alpha(match[4]) };
  match = value.match(/^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)(?:deg)?(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (match) {
    const lightness = match[2] ? parseFloat(match[1]) / 100 : parseFloat(match[1]);
    return { ...oklchToSrgb(lightness, parseFloat(match[3]), match[4] === 'none' ? 0 : parseFloat(match[4])), a: alpha(match[5]) };
  }
  match = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (match) return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha(match[4]) };
  return null;
}

export function composite(top, bottom) {
  const a = top.a ?? 1;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a), a: 1 };
}

export function luminance(color) {
  const linear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

export function contrastRatio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Whether an element shows an ellipsis where it cuts its text: block containers draw one, flex and grid containers do not. */
export function showsEllipsis(style) {
  return style.textOverflow === 'ellipsis' && !/flex|grid/.test(style.display);
}

/** Whether an ancestor that hides its overflow cuts a box: across unless the ancestor shows an ellipsis there, or down. `area` is its padding box. */
export function cutsBox(box, area, style) {
  const hides = value => value === 'hidden' || value === 'clip';
  const across = hides(style.overflowX) && !showsEllipsis(style) && (box.left < area.left - 0.5 || box.right > area.right + 0.5);
  const down = hides(style.overflowY) && (box.top < area.top - 0.5 || box.bottom > area.bottom + 0.5);
  return across || down;
}

/** Check the rendered page under options.root and return { checks, issues }. Runs in the browser. */
export function auditPage(options) {
  const issues = [];
  let checks = 0;
  const root = document.querySelector(options.root);
  if (!root) return { checks: 1, issues: [{ rule: 'root', target: options.root, detail: 'not found' }] };
  const describe = el => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 3 && node !== document.body; node = node.parentElement) {
      const classes = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      parts.unshift(node.tagName.toLowerCase() + (classes ? `.${classes}` : ''));
    }
    const words = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return parts.join(' > ') + (words ? ` "${words}"` : '');
  };
  const report = (rule, el, detail) => issues.push({ rule, target: describe(el), detail });
  const visible = el => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const normalise = family => family.replace(/["'\s]/g, '').toLowerCase();
  const all = [...root.querySelectorAll('*')];
  const html = all.filter(el => !(el instanceof SVGElement));
  const shown = new Set(html.filter(visible));
  const ownText = el => [...el.childNodes].some(node => node.nodeType === 3 && node.nodeValue.trim());
  const texts = html.filter(el => shown.has(el) && ownText(el));
  const svgTexts = all.filter(el => el instanceof SVGTextElement && visible(el));
  const family = normalise(options.fontFamily ?? getComputedStyle(root).fontFamily);

  for (const el of [...texts, ...svgTexts]) {
    const style = getComputedStyle(el);
    checks += 1;
    if (normalise(style.fontFamily) !== family) report('font-family', el, style.fontFamily);
    if (!options.sizes.includes(parseFloat(style.fontSize))) report('font-size', el, style.fontSize);
    if (!(el instanceof SVGElement) && !options.lineHeights.includes(parseFloat(style.lineHeight))) report('line-height', el, style.lineHeight);
    if (!options.weights.includes(Number(style.fontWeight))) report('font-weight', el, style.fontWeight);
    if (style.fontStyle !== 'normal') report('font-style', el, style.fontStyle);
    if (style.textTransform !== 'none') report('text-transform', el, style.textTransform);
    if (style.letterSpacing !== 'normal' && parseFloat(style.letterSpacing) !== 0) report('letter-spacing', el, style.letterSpacing);
  }

  const backgroundOf = el => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const raw = getComputedStyle(node).backgroundColor;
      const colour = parseColor(raw);
      if (!colour) {
        report('colour', node, `cannot read background ${raw}`);
        continue;
      }
      if (colour.a > 0) {
        layers.push(colour);
        if (colour.a >= 1) break;
      }
    }
    let result = { r: 1, g: 1, b: 1, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1) result = composite(layers[index], result);
    return result;
  };
  for (const el of [...texts, ...svgTexts]) {
    const style = getComputedStyle(el);
    const raw = el instanceof SVGElement ? style.fill : style.color;
    const foreground = parseColor(raw);
    checks += 1;
    if (!foreground) {
      report('colour', el, `cannot read ${raw}`);
      continue;
    }
    const background = backgroundOf(el);
    const ratio = contrastRatio(composite(foreground, background), background);
    if (ratio < options.minContrast) report('contrast', el, `${ratio.toFixed(2)}:1`);
  }

  // The part of an element that ancestors clipping their overflow leave visible (ellipsis cells, chip rows).
  const clippedBox = el => {
    let { left, top, right, bottom } = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = node.getBoundingClientRect();
      if (style.overflowX !== 'visible') {
        left = Math.max(left, outer.left);
        right = Math.min(right, outer.right);
      }
      if (style.overflowY !== 'visible') {
        top = Math.max(top, outer.top);
        bottom = Math.min(bottom, outer.bottom);
      }
    }
    return { left, top, right, bottom };
  };
  const atoms = [...new Set([...texts, ...root.querySelectorAll(options.atoms)])].filter(el => !(el instanceof SVGElement) && shown.has(el));
  const boxes = atoms
    .map(el => ({ el, box: clippedBox(el) }))
    .filter(({ box }) => box.right - box.left > 0.5 && box.bottom - box.top > 0.5)
    .sort((a, b) => a.box.top - b.box.top);
  checks += boxes.length;
  for (let i = 0; i < boxes.length; i += 1) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length && boxes[j].box.top < a.box.bottom - 0.5; j += 1) {
      const b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width > 0.5 && height > 0.5) report('overlap', a.el, describe(b.el));
    }
  }

  // The nearest ancestor whose hidden overflow cuts the element's box.
  const cutBy = el => {
    const box = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const outer = node.getBoundingClientRect();
      const left = outer.left + node.clientLeft;
      const top = outer.top + node.clientTop;
      if (cutsBox(box, { left, top, right: left + node.clientWidth, bottom: top + node.clientHeight }, style)) return node;
    }
    return null;
  };
  for (const el of texts) {
    const style = getComputedStyle(el);
    checks += 1;
    if (style.display !== 'inline' && el.scrollWidth > el.clientWidth + 1) {
      if (style.overflowX === 'visible') report('spill', el, `${el.scrollWidth}px of content in ${el.clientWidth}px`);
      else if (!showsEllipsis(style)) report('clipped', el, `${el.scrollWidth}px of content in ${el.clientWidth}px`);
    }
    if (style.display !== 'inline' && style.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 1) report('hidden-lines', el, `${el.scrollHeight}px of lines in ${el.clientHeight}px`);
    const cut = cutBy(el);
    if (cut) report('cut', el, `cut off by ${describe(cut)}`);
    const container = el.parentElement && el.parentElement.closest(options.containers);
    if (container) {
      const box = clippedBox(el);
      const outer = container.getBoundingClientRect();
      if (box.left < outer.left - 0.5 || box.right > outer.right + 0.5) report('outside', el, `extends past ${describe(container)}`);
    }
  }

  checks += 1;
  if (document.documentElement.scrollWidth > window.innerWidth + 1) report('hscroll', document.documentElement, `${document.documentElement.scrollWidth}px wide in a ${window.innerWidth}px window`);

  for (const el of shown) {
    const style = getComputedStyle(el);
    checks += 1;
    for (const prop of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'rowGap', 'columnGap']) {
      const value = parseFloat(style[prop]);
      if (Number.isFinite(value) && Math.abs(value % 4) > 0.01) report('grid', el, `${prop} ${style[prop]}`);
    }
  }
  const matching = selector => [root, ...root.querySelectorAll(selector)].filter(el => el.matches(selector) && (el === root || shown.has(el)));
  for (const [selector, px] of Object.entries(options.padding)) {
    for (const el of matching(selector)) {
      const style = getComputedStyle(el);
      const sides = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat);
      checks += 1;
      if (sides.some(side => side !== px)) report('padding', el, `${sides.join(' ')} instead of ${px}`);
    }
  }
  for (const [selector, px] of Object.entries(options.heights)) {
    for (const el of matching(selector)) {
      const height = el.getBoundingClientRect().height;
      checks += 1;
      if (Math.abs(height - px) > 0.5) report('height', el, `${height.toFixed(1)}px instead of ${px}px`);
    }
  }
  return { checks, issues };
}

export const AUDIT_DEFAULTS = Object.freeze({
  root: '.dash',
  minContrast: 4.5,
  sizes: [12, 14, 18],
  lineHeights: [16, 20, 24],
  weights: [400, 500],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  atoms: '.chip,.badge,.pill,.ring,.meter,.bar,.stage,.sw,button,select,.need,.b-card,.mc,.pn,.pl-row,.tile,.kv,.fi,.h-row,.g-row,.g-track,.hb-row,.c-who,.c-trk,.c-sum,.tabs,.seg',
  containers: '.b-card,.need,.rail,.detail,.mc,.pn,.pl-row,.tile,.h-row,.run-answer,.empty,.dash',
  padding: { '.dash': 16, '.b-card': 16, '.rail': 16, '.detail': 16, '.need': 12, '.pn': 12, '.pl-row': 12, '.mc': 12 },
  heights: {
    '.chip': 24, '.badge': 20, '.pill': 20, '.d-top .seg > button': 28, '.c-bar .seg > button': 24, '.x': 28, '.pick select': 28,
    '.ring': 40, '.meter': 4, '.bar': 4, '.stage': 4, '.g-track': 12,
  },
});

/** The audit as one expression for Runtime.evaluate. */
export function auditScript(options = AUDIT_DEFAULTS) {
  const source = [oklchToSrgb, parseColor, composite, luminance, contrastRatio, showsEllipsis, cutsBox, auditPage].map(fn => fn.toString()).join('\n');
  return `(() => {\n${source}\nreturn auditPage(${JSON.stringify(options)});\n})()`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/page-audit.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/scripts/lib/page-audit.mjs ghcp/plugins/swarm-dashboard/tests/page-audit.test.mjs
git commit -m "test(swarm-dashboard): add the layout audit rules and colour contrast maths"
```

### Task 16: Layout check runner

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/scripts/lib/cdp.mjs`
- Create: `ghcp/plugins/swarm-dashboard/scripts/check-layout.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/fixtures/layout-good.html`, `ghcp/plugins/swarm-dashboard/tests/fixtures/layout-bad.html`
- Modify: `ghcp/plugins/swarm-dashboard/package.json` (add the `check:layout` script only)
- Test: `ghcp/plugins/swarm-dashboard/tests/check-layout.test.mjs`

**Interfaces:**
- Consumes: `createDashboardServer` (Task 9), `createDemoEngine` (Task 8), `AUDIT_DEFAULTS`, `auditScript` (Task 15).
- Produces: `findBrowser(env = process.env): string|null` (`CHROME_PATH`, standard Chrome, Chromium and Edge locations on macOS and Linux, then Playwright's cached Chromium); `launchBrowser(executable): Promise<{ product, send, onEvent, close }>` (headless, DevTools protocol over `--remote-debugging-pipe`, temporary profile removed on close); `openPage(browser): Promise<{ send, errors, goto(url, width, height = 900), evaluate(expression), waitFor(expression, timeoutMs = 8000), screenshot() }>` (reduced motion on; `errors` collects exceptions, console errors and error log entries); `WIDTHS`, `CANVAS_WIDTHS`, `VIEWS`, `SELF_TEST_RULES`, `buildStates({ scenarios, widths, canvasWidths, targets })` (targets: per scenario, an optional swarm to pin, the unit for the detail view and a finished run, either of which may be null to skip those views), `parseArguments(argv)` → `{ scenarios, widths, canvasWidths, screenshots, live, help }`, `describeTimes(durations): string` (`"3 updates; 4.2 ms median, 7.9 ms max"`), `main(argv, { stdout, stderr, env })`; `npm run check:layout [-- --scenario <name> | --live <url>] [-- --width <px>] [-- --screenshots <dir>]`. `--live http://127.0.0.1:<port>/` checks a running dashboard (real data) with the swarm, first unit and latest finished run it shows, prints only counts before the issue list, and refuses `--screenshots`, so it never writes an image of real data.
- Update checks (approved decision 7): after the layout self-test, an update self-test runs `ui/morph.mjs` inside a dashboard page (nodes kept when an item is added at the top, keyed items reused in a new order, text and attributes patched, a running animation's delay kept, a changed or moved one's replaced, drawn containers kept, a select following the rendered choice, and a select in use left alone until it loses focus). After the views, the runner opens the cards view at 1440 px with motion on, waits for 3 live updates (a simulating demo server, or the `--live` dashboard for up to 25 s), and fails if cards were re-created, unchanged activity items were highlighted again, the scroll position moved or a busy ring fell more than 80 ms out of phase. It prints the update times from the page's `swarm-update` measures.

- [ ] **Step 1: Write the failing test**

`tests/check-layout.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_WIDTHS, VIEWS, WIDTHS, buildStates, describeTimes, parseArguments } from '../scripts/check-layout.mjs';
import { findBrowser } from '../scripts/lib/cdp.mjs';

test('every view is checked at the nine widths in the browser layout and three in the canvas layout', () => {
  assert.deepEqual(WIDTHS, [480, 560, 640, 800, 1024, 1280, 1440, 1600, 1920]);
  assert.deepEqual(CANVAS_WIDTHS, [480, 560, 640]);
  assert.deepEqual(VIEWS.map(view => view.name), ['cards', 'detail', 'activity', 'timeline', 'timeline-run', 'plan', 'board', 'history', 'run']);
  const example = buildStates({ scenarios: ['example'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS });
  assert.equal(example.length, (9 + 3) * 9);
  const stress = buildStates({ scenarios: ['stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS });
  assert.equal(stress.length, (9 + 3) * 7, 'history views are checked with the example only');
  const detail = example.find(state => state.view === 'detail' && state.host === 'canvas' && state.width === 560);
  assert.deepEqual(detail.params, { host: 'canvas', detail: 'ws-0005-i1' });
  assert.equal(example.find(state => state.view === 'activity').narrowOnly, true);
});

test('arguments narrow the run to one scenario or width, or ask for screenshots', () => {
  assert.deepEqual(parseArguments([]), { scenarios: ['example', 'stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS, screenshots: null, live: null, help: false });
  assert.deepEqual(parseArguments(['--scenario', 'stress']).scenarios, ['stress']);
  assert.deepEqual(parseArguments(['--width', '560']), { scenarios: ['example', 'stress'], widths: [560], canvasWidths: [560], screenshots: null, live: null, help: false });
  assert.deepEqual(parseArguments(['--width', '1280']).canvasWidths, []);
  assert.equal(parseArguments(['--screenshots', '/tmp/shots']).screenshots, '/tmp/shots');
  assert.throws(() => parseArguments(['--scenario', 'nope']), /scenario/);
  assert.throws(() => parseArguments(['--width', '100']), /width/);
  assert.throws(() => parseArguments(['--nope']), /Unknown option/);
});

test('a running dashboard is checked with the swarm, unit and run it shows', () => {
  const options = parseArguments(['--live', 'http://127.0.0.1:7927']);
  assert.equal(options.live, 'http://127.0.0.1:7927/');
  assert.deepEqual(options.scenarios, ['live']);
  assert.throws(() => parseArguments(['--live', 'https://example.com/']), /--live/);
  assert.throws(() => parseArguments(['--live', 'http://127.0.0.1:7927/', '--scenario', 'stress']), /--live/);
  assert.throws(() => parseArguments(['--live', 'http://127.0.0.1:7927/', '--screenshots', '/tmp/shots']), /--screenshots/);
  const targets = { live: { swarm: 'ws-a', detail: 'ws-b', run: null } };
  const states = buildStates({ scenarios: ['live'], widths: [1280], canvasWidths: [], targets });
  assert.deepEqual(states.map(state => state.view), ['cards', 'detail', 'activity', 'timeline', 'timeline-run', 'plan', 'board']);
  assert.deepEqual(states.find(state => state.view === 'detail').params, { host: 'browser', swarm: 'ws-a', detail: 'ws-b' });
  const empty = buildStates({ scenarios: ['live'], widths: [1280], canvasWidths: [], targets: { live: { swarm: null, detail: null, run: 'ws-r' } } });
  assert.deepEqual(empty.map(state => state.view), ['cards', 'activity', 'timeline', 'timeline-run', 'plan', 'board', 'history', 'run']);
  assert.deepEqual(empty.find(state => state.view === 'run').params, { host: 'browser', page: 'run', run: 'ws-r' });
});

test('update times are reported as a count, a median and a maximum', () => {
  assert.equal(describeTimes([4, 2, 9.25]), '3 updates; 4.0 ms median, 9.3 ms max');
  assert.equal(describeTimes([2, 4]), '2 updates; 3.0 ms median, 4.0 ms max');
  assert.equal(describeTimes([5]), '1 update; 5.0 ms median, 5.0 ms max');
});

test('the browser comes from CHROME_PATH when it is set', () => {
  assert.equal(findBrowser({ CHROME_PATH: process.execPath }), process.execPath);
  assert.equal(findBrowser({ CHROME_PATH: '/no/such/browser' }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/check-layout.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/check-layout.mjs'`.

- [ ] **Step 3: Write `scripts/lib/cdp.mjs`**

```js
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];
const PLAYWRIGHT = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux/chrome',
];

/** A local Chromium-based browser: CHROME_PATH, a standard install, or Playwright's cached Chromium. */
export function findBrowser(env = process.env) {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  for (const cache of [path.join(homedir(), 'Library/Caches/ms-playwright'), path.join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
      for (const relative of PLAYWRIGHT) {
        const full = path.join(cache, dir, relative);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

/**
 * Start the browser headless and speak the DevTools protocol over a pipe (file descriptors 3 and 4), so no WebSocket
 * client or npm package is needed. close() ends the browser and deletes its temporary profile.
 */
export async function launchBrowser(executable) {
  const profile = mkdtempSync(path.join(tmpdir(), 'swarm-layout-'));
  const child = spawn(executable, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const input = child.stdio[3];
  const output = child.stdio[4];
  const pending = new Map();
  const handlers = new Set();
  let buffer = '';
  let nextId = 0;
  const exited = new Promise(resolve => child.once('exit', resolve));
  // If this process ends early (Ctrl+C or an exception), take the browser and its profile with it.
  const cleanUp = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  process.once('exit', cleanUp);
  child.once('exit', () => {
    for (const { reject } of pending.values()) reject(new Error('The browser exited.'));
    pending.clear();
  });
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of handlers) handler(message);
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    input.write(`${JSON.stringify(sessionId ? { id: nextId, method, params, sessionId } : { id: nextId, method, params })}\0`);
  });
  const { product } = await send('Browser.getVersion');
  return {
    product,
    send,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close() {
      await send('Browser.close').catch(() => {});
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      process.off('exit', cleanUp);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** One tab with reduced motion, collecting exceptions, console errors and error log entries in `errors`. */
export async function openPage(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => browser.send(method, params, sessionId);
  const errors = [];
  browser.onEvent(message => {
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
    if (method === 'Log.entryAdded' && params.entry.level === 'error') errors.push(params.entry.text);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const page = {
    send,
    errors,
    async goto(url, width, height = 900) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url });
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    async waitFor(expression, timeoutMs = 8000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await page.evaluate(expression).catch(() => false)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${expression}`);
    },
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      return Buffer.from(data, 'base64');
    },
  };
  return page;
}
```

- [ ] **Step 4: Write the self-test pages**

`tests/fixtures/layout-good.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout check self-test: clean page</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 400 14px/20px system-ui, -apple-system, "Segoe UI", sans-serif; color: #222; background: #fff; }
.dash { display: flex; flex-direction: column; gap: 16px; padding: 16px; border: 1px solid #ddd; }
.b-card { display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px solid #ddd; }
.chip { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; font-size: 12px; line-height: 16px; border: 1px solid #ddd; }
.narrow { width: 120px; }
.cell { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row { display: flex; align-items: center; gap: 8px; overflow: hidden; }
.dot { flex: none; width: 8px; height: 8px; background: #222; }
</style>
</head>
<body>
<main class="dash">
  <article class="b-card"><span>First card</span><span class="chip">explore 3m</span></article>
  <article class="b-card"><span>Second card</span></article>
  <article class="b-card narrow"><div class="cell">A long label with <span>an inline part</span> that ends in an ellipsis</div></article>
  <article class="b-card narrow"><div class="row"><span class="dot"></span><span class="cell">A flex item that ends in an ellipsis</span></div></article>
</main>
</body>
</html>
```

`tests/fixtures/layout-bad.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Layout check self-test: broken page</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 400 14px/20px system-ui, -apple-system, "Segoe UI", sans-serif; color: #222; background: #fff; }
.dash { display: flex; flex-direction: column; gap: 16px; padding: 16px; border: 1px solid #ddd; }
.b-card { display: flex; flex-direction: column; gap: 8px; padding: 16px; border: 1px solid #ddd; background: #fff; }
.overlap { margin-top: -40px; }
.chip { display: inline-flex; align-items: center; height: 30px; padding: 0 8px; font-size: 12px; line-height: 16px; border: 1px solid #ddd; }
.narrow { width: 120px; }
.wide { width: 3000px; height: 4px; }
</style>
</head>
<body>
<main class="dash">
  <article class="b-card"><span>First card</span><span class="chip">explore 3m</span></article>
  <article class="b-card overlap"><span>Second card overlaps the first</span></article>
  <article class="b-card" style="padding: 16px 12px"><span>A card with uneven padding</span></article>
  <p style="font-family: Georgia, serif">Serif text</p>
  <p style="font-size: 13px">Thirteen pixel text</p>
  <p style="font-style: italic">Italic text</p>
  <p style="text-transform: uppercase">Uppercase text</p>
  <p style="font-weight: 700">Bold text</p>
  <p style="letter-spacing: 1px">Spaced text</p>
  <p style="line-height: 18px">Odd line height</p>
  <p style="color: #bbb">Low contrast text</p>
  <p style="color: lab(40 20 30)">A colour the check cannot read</p>
  <div style="display: flex; gap: 6px"><span>Off</span><span>grid</span></div>
  <article class="b-card narrow"><div style="white-space: nowrap">This block of text spills out of its card</div></article>
  <article class="b-card narrow"><div style="display: flex; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">A flex row cuts this text without an ellipsis</div></article>
  <article class="b-card narrow" style="display: block"><span style="white-space: nowrap">This inline text runs past the card edge</span></article>
  <article class="b-card narrow"><div style="height: 20px; overflow: hidden">These words wrap onto lines that the box hides</div></article>
  <article class="b-card narrow"><div style="display: flex; overflow: hidden"><span style="flex: none">Its row cuts this text off</span></div></article>
  <div class="wide"></div>
</main>
</body>
</html>
```

- [ ] **Step 5: Write `scripts/check-layout.mjs`**

```js
#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { findBrowser, launchBrowser, openPage } from './lib/cdp.mjs';
import { AUDIT_DEFAULTS, auditScript } from './lib/page-audit.mjs';

export const WIDTHS = [480, 560, 640, 800, 1024, 1280, 1440, 1600, 1920];
export const CANVAS_WIDTHS = [480, 560, 640];
/** What each scenario shows in the detail and run views; the stress scenario has no history. */
const SCENARIOS = { example: { detail: 'ws-0005-i1', run: 'ws-1000-root' }, stress: { detail: 'ws-9001-stress', run: null } };
/** Every dashboard view as URL parameters. Activity exists only in narrow mode; history views need a finished run. */
export const VIEWS = [
  { name: 'cards', params: {} },
  { name: 'detail', params: { detail: 'DETAIL' } },
  { name: 'activity', params: { tab: 'activity' }, narrowOnly: true },
  { name: 'timeline', params: { tab: 'timeline', span: '12h' } },
  { name: 'timeline-run', params: { tab: 'timeline', span: 'run' } },
  { name: 'plan', params: { tab: 'plan' } },
  { name: 'board', params: { tab: 'board' } },
  { name: 'history', params: { page: 'history' }, history: true },
  { name: 'run', params: { page: 'run', run: 'RUN' }, history: true },
];
export const SELF_TEST_RULES = ['overlap', 'font-family', 'font-size', 'font-style', 'text-transform', 'font-weight', 'letter-spacing', 'line-height', 'contrast', 'colour', 'grid', 'padding', 'height', 'spill', 'clipped', 'hidden-lines', 'cut', 'outside', 'hscroll'];
export const USAGE = `Usage: check-layout [--scenario example|stress | --live <url>] [--width <px>] [--screenshots <dir>]

Checks every dashboard view for overlap, clipped text, type, spacing, sizes, contrast and console errors in a
local headless Chrome, Chromium or Edge (set CHROME_PATH to pick one). It proves its rules on a broken page first,
tests the page's in-place updates, and then watches live updates arrive and reports how long each one takes.
By default it serves the synthetic example and stress swarms itself; --live checks a running dashboard instead
(for example http://127.0.0.1:7927/), whose report quotes your own data: keep it local.
Screenshots of the synthetic swarms, when asked for, are written to <dir> for review; do not commit them.
--live never writes screenshots, because its pages show your own data.
`;

export function parseArguments(argv) {
  const options = { scenarios: ['example', 'stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS, screenshots: null, live: null, help: false };
  let scenarioChosen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--scenario') {
      const name = argv[++index];
      if (!SCENARIOS[name]) throw new Error('--scenario takes example or stress');
      options.scenarios = [name];
      scenarioChosen = true;
    } else if (arg === '--live') {
      let url = null;
      try {
        url = new URL(argv[++index]);
      } catch {
        url = null;
      }
      if (!url || url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('--live takes the address of a dashboard on this machine, such as http://127.0.0.1:7927/');
      options.live = `${url.origin}/`;
    } else if (arg === '--width') {
      const width = Number(argv[++index]);
      if (!Number.isInteger(width) || width < 320) throw new Error('--width takes a width in px of at least 320');
      options.widths = [width];
      options.canvasWidths = CANVAS_WIDTHS.includes(width) ? [width] : [];
    } else if (arg === '--screenshots') {
      options.screenshots = argv[++index];
      if (!options.screenshots) throw new Error('--screenshots takes a folder');
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.live && scenarioChosen) throw new Error('--live checks a running dashboard, so it cannot be combined with --scenario');
  if (options.live && options.screenshots) throw new Error('--live pages show your own data, so it cannot be combined with --screenshots');
  if (options.live) options.scenarios = ['live'];
  return options;
}

/** targets: per scenario, the swarm to pin (optional), the unit for the detail view and the finished run, or null. */
export function buildStates({ scenarios, widths, canvasWidths, targets = SCENARIOS }) {
  const states = [];
  for (const scenario of scenarios) {
    const target = targets[scenario];
    for (const [host, list] of [['browser', widths], ['canvas', canvasWidths]]) {
      for (const width of list) {
        for (const view of VIEWS) {
          if ((view.history && !target.run) || (view.name === 'detail' && !target.detail)) continue;
          const params = { host, ...(target.swarm ? { swarm: target.swarm } : {}), ...view.params };
          if (params.detail === 'DETAIL') params.detail = target.detail;
          if (params.run === 'RUN') params.run = target.run;
          states.push({ scenario, host, width, view: view.name, narrowOnly: Boolean(view.narrowOnly), params });
        }
      }
    }
  }
  return states;
}

/** The swarm, unit and finished run a live dashboard shows by default, and counts to print (no names). */
async function describeLive(base) {
  const read = async route => {
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${route} answered ${response.status}`);
    return response.json();
  };
  try {
    const health = await read('api/health');
    if (health?.app !== 'swarm-dashboard') return null;
    const { snapshot } = await read('api/snapshot');
    const history = await read('api/history');
    const target = {
      swarm: snapshot?.run.id ?? null,
      detail: snapshot ? (snapshot.units[0] ?? snapshot.orchestrator).id : null,
      run: history[0]?.id ?? null,
    };
    const summary = `${snapshot ? `a ${snapshot.run.lifecycle} swarm with ${snapshot.units.length} units` : 'no swarm'}, ${history.length} finished runs`;
    return { target, summary };
  } catch {
    return null;
  }
}

/** "3 updates; 4.2 ms median, 7.9 ms max" for a list of update durations in ms. */
export function describeTimes(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
  return `${sorted.length} update${sorted.length === 1 ? '' : 's'}; ${median.toFixed(1)} ms median, ${sorted[sorted.length - 1].toFixed(1)} ms max`;
}

/** Runs in the page: ui/morph.mjs keeps nodes, moves keyed ones, updates attributes and text, and keeps animation delays. */
async function morphSelfTest() {
  // The page's own module, imported by URL (a variable, so PR 1's import guard does not read it as one of ours).
  const moduleUrl = new URL('/ui/morph.mjs', location.href).href;
  const { morph } = await import(moduleUrl);
  const failures = [];
  const expect = (ok, what) => { if (!ok) failures.push(what); };
  const box = document.createElement('div');
  document.body.append(box);
  try {
    morph(box, '<ul><li data-key="a">A</li><li data-key="b">B</li><li data-key="c">C</li></ul><p class="x" title="t">one</p>');
    const [a, b, c] = box.querySelectorAll('li');
    const p = box.querySelector('p');
    const observer = new MutationObserver(() => {});
    observer.observe(box, { childList: true, subtree: true });
    morph(box, '<ul><li data-key="n">N</li><li data-key="a">A</li><li data-key="b">B2</li><li data-key="c">C</li></ul><p class="y">two</p>');
    const removed = observer.takeRecords().flatMap(record => [...record.removedNodes]).filter(node => node.nodeType === 1);
    observer.disconnect();
    const items = [...box.querySelectorAll('li')];
    expect(items[1] === a && items[2] === b && items[3] === c, 'an item added at the top re-created the items below it');
    expect(removed.length === 0, `adding an item at the top removed ${removed.length} elements`);
    expect(b.textContent === 'B2' && box.querySelector('p') === p && p.className === 'y' && !p.hasAttribute('title') && p.textContent === 'two', 'text and attributes were not updated in place');
    morph(box, '<ul><li data-key="c">C</li><li data-key="a">A</li></ul><p class="y">two</p>');
    const kept = [...box.querySelectorAll('li')];
    expect(kept.length === 2 && kept[0] === c && kept[1] === a, 'reordered items were not reused in their new order');
    morph(box, '<i class="spin" data-phase style="animation-delay:-1s"></i>');
    const spin = box.firstChild;
    morph(box, '<i class="spin" data-phase style="animation-delay:-3s"></i>');
    expect(box.firstChild === spin && spin.getAttribute('style') === 'animation-delay:-1s', 'a running animation was given a new delay');
    morph(box, '<i class="stuck" data-phase style="animation-delay:-2s"></i>');
    expect(spin.getAttribute('style') === 'animation-delay:-2s', 'a changed animation kept its old delay');
    morph(box, '<b data-key="1"></b><b data-key="2"><i class="spin" data-phase style="animation-delay:-1s"></i></b>');
    const moving = box.querySelector('i');
    morph(box, '<b data-key="2"><i class="spin" data-phase style="animation-delay:-3s"></i></b><b data-key="1"></b>');
    expect(box.querySelector('i') === moving && moving.getAttribute('style') === 'animation-delay:-3s', 'a moved animation kept its delay from before the move');
    morph(box, '<div data-drawn></div>');
    box.firstChild.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    morph(box, '<div data-drawn class="z"></div>');
    expect(box.firstChild.className === 'z' && box.firstChild.querySelector('svg') !== null, 'a drawn container lost what was drawn in it');
    morph(box, '<select><option value="a">a</option><option value="b">b</option></select>');
    const select = box.firstChild;
    select.value = 'a';
    morph(box, '<select><option value="a">a</option><option value="b" selected>b</option></select>');
    expect(box.firstChild === select && select.value === 'b', 'a select did not follow the rendered choice');
    select.focus();
    morph(box, '<select><option value="a" selected>a</option><option value="b">b</option><option value="c">c</option></select>');
    expect(select.value === 'b' && select.options.length === 2, 'a select in use was changed under the user');
    select.blur();
    morph(box, '<select><option value="a" selected>a</option><option value="b">b</option><option value="c">c</option></select>');
    expect(select.value === 'a' && select.options.length === 3, 'a select did not catch up after losing focus');
  } finally {
    box.remove();
  }
  return failures;
}

/** Runs in the page before updates arrive: remembers the cards and activity items on screen, and scrolls a little. */
function markPage() {
  window.scrollTo(0, Math.max(0, Math.min(160, document.documentElement.scrollHeight - window.innerHeight)));
  window.swarmCheck = {
    baseline: performance.getEntriesByName('swarm-update').length,
    cards: [...document.querySelectorAll('.b-card')],
    feed: [...document.querySelectorAll('.fi')],
    scrollY: window.scrollY,
  };
}

/** Runs in the page after updates: what they re-created, highlighted again, scrolled or put out of phase, and their times. */
function inspectPage() {
  const state = window.swarmCheck;
  const issues = [];
  const recreated = state.cards.filter(el => !el.isConnected).length;
  if (recreated) issues.push(`${recreated} of ${state.cards.length} cards were re-created`);
  const flashed = state.feed.filter(el => el.isConnected && el.classList.contains('is-new')).length;
  if (flashed) issues.push(`${flashed} activity items that did not change were highlighted again`);
  if (Math.abs(window.scrollY - state.scrollY) > 1) issues.push(`the page scrolled from ${state.scrollY} to ${window.scrollY} px`);
  const now = document.timeline.currentTime;
  for (const arc of document.querySelectorAll('.ring .arc.spin')) {
    const animation = arc.getAnimations()[0];
    if (!animation) continue;
    const off = Math.abs(animation.effect.getComputedTiming().progress - ((now / 1000) % 4) / 4);
    const ms = Math.min(off, 1 - off) * 4000;
    if (ms > 80) issues.push(`a busy ring is ${Math.round(ms)} ms out of phase`);
  }
  const durations = performance.getEntriesByName('swarm-update').slice(state.baseline).map(entry => entry.duration);
  return { issues, durations };
}

/** Open the page with motion on, wait for live updates and inspect what they did; null when none arrived. */
async function watchUpdates(page, url, { updates = 3, timeoutMs = 15000 } = {}) {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  try {
    page.errors.length = 0;
    await page.goto(url, 1440);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
    await page.evaluate(`(${markPage})()`);
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = await page.evaluate("performance.getEntriesByName('swarm-update').length - window.swarmCheck.baseline");
      if (seen >= updates) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!seen) return null;
    const result = await page.evaluate(`(${inspectPage})()`);
    result.issues.push(...page.errors);
    return result;
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  }
}

async function selfTest(page) {
  const problems = [];
  for (const [name, broken] of [['layout-bad.html', true], ['layout-good.html', false]]) {
    const url = new URL(`../tests/fixtures/${name}`, import.meta.url).href;
    await page.goto(url, 800);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
    const { issues } = await page.evaluate(auditScript(AUDIT_DEFAULTS));
    if (broken) {
      const fired = new Set(issues.map(issue => issue.rule));
      for (const rule of SELF_TEST_RULES) if (!fired.has(rule)) problems.push(`${name}: the ${rule} rule did not fire`);
    } else {
      for (const issue of issues) problems.push(`${name}: unexpected ${issue.rule} on ${issue.target} (${issue.detail})`);
    }
  }
  return problems;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  const executable = findBrowser(env);
  if (!executable) {
    stderr.write('No local Chrome, Chromium or Edge was found. Install one or set CHROME_PATH.\n');
    return 2;
  }
  const browser = await launchBrowser(executable);
  const servers = [];
  const interrupt = () => process.exit(130);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    stdout.write(`Browser: ${browser.product}\n`);
    const page = await openPage(browser);
    const problems = await selfTest(page);
    if (problems.length) {
      for (const problem of problems) stderr.write(`self-test: ${problem}\n`);
      return 1;
    }
    stdout.write('Self-test passed: every rule fires on the broken page and none on the clean one.\n');
    const urls = {};
    const targets = { ...SCENARIOS };
    if (options.live) {
      const live = await describeLive(options.live);
      if (!live) {
        stderr.write(`No swarm dashboard answers at ${options.live}\n`);
        return 1;
      }
      urls.live = options.live;
      targets.live = live.target;
      stdout.write(`Live dashboard: ${live.summary}\n`);
    }
    for (const scenario of options.scenarios.filter(name => SCENARIOS[name])) {
      const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario, simulate: false }), port: 0, version: 'layout-check', hub: { engineIdleMs: 600000 } });
      await server.listen();
      servers.push(server);
      urls[scenario] = server.url;
    }
    const first = Object.values(urls)[0];
    const home = `${first}?host=browser`;
    await page.goto(home, 1280);
    await page.waitFor(`location.href === ${JSON.stringify(home)} && document.documentElement.dataset.ready === '1'`);
    const morphFailures = await page.evaluate(`(${morphSelfTest})()`);
    if (morphFailures.length) {
      for (const failure of morphFailures) stderr.write(`update self-test: ${failure}\n`);
      return 1;
    }
    stdout.write('Update self-test passed: in-place rendering keeps nodes, order, animation delays and drawn content.\n');
    if (options.screenshots) mkdirSync(options.screenshots, { recursive: true });
    let views = 0;
    let checks = 0;
    const failures = [];
    for (const state of buildStates({ ...options, targets })) {
      const url = `${urls[state.scenario]}?${new URLSearchParams(state.params)}`;
      page.errors.length = 0;
      await page.goto(url, state.width);
      await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
      await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (state.narrowOnly && await page.evaluate('document.documentElement.dataset.narrow') !== '1') continue;
      const result = await page.evaluate(auditScript(AUDIT_DEFAULTS));
      views += 1;
      checks += result.checks + 1;
      const issues = [...result.issues, ...page.errors.map(message => ({ rule: 'console', target: 'page', detail: message }))];
      if (issues.length) failures.push({ state, issues });
      if (options.screenshots) writeFileSync(path.join(options.screenshots, `${state.scenario}-${state.host}-${state.width}-${state.view}.png`), await page.screenshot());
    }
    const total = failures.reduce((sum, failure) => sum + failure.issues.length, 0);
    stdout.write(`Checked ${views} views (${options.scenarios.join(' and ')}; browser layout at ${options.widths.join(', ')} px; canvas layout at ${options.canvasWidths.join(', ') || 'no'} px): ${checks} checks, ${total} issues.\n`);
    for (const { state, issues } of failures) {
      stderr.write(`\n${state.scenario}, ${state.host} layout, ${state.width} px, ${state.view}:\n`);
      for (const issue of issues.slice(0, 20)) stderr.write(`  ${issue.rule}: ${issue.target} (${issue.detail})\n`);
      if (issues.length > 20) stderr.write(`  and ${issues.length - 20} more\n`);
    }
    let updateIssues = [];
    if (options.live) {
      const watched = await watchUpdates(page, `${options.live}?host=browser`, { timeoutMs: 25000 });
      if (watched) updateIssues = watched.issues;
      stdout.write(watched
        ? `Live updates (live): ${describeTimes(watched.durations)}${watched.issues.length ? '' : '; cards kept, no repeated highlights, scroll kept, busy rings in phase'}.\n`
        : 'Live updates (live): none arrived within 25 s, so the update time was not measured.\n');
    } else {
      const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: true, stepMs: 1000 }), port: 0, version: 'layout-check' });
      await server.listen();
      servers.push(server);
      const watched = await watchUpdates(page, `${server.url}?host=browser`);
      updateIssues = watched ? watched.issues : ['no simulated update arrived within 15 s'];
      if (watched) stdout.write(`Live updates (example, simulated): ${describeTimes(watched.durations)}${watched.issues.length ? '' : '; cards kept, no repeated highlights, scroll kept, busy rings in phase'}.\n`);
    }
    for (const issue of updateIssues) stderr.write(`update: ${issue}\n`);
    return failures.length || updateIssues.length ? 1 : 0;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    for (const server of servers) await server.close();
    await browser.close();
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 6: Add the `check:layout` script**

In `package.json`, add one line after the `start` script:

```json
    "check:layout": "node scripts/check-layout.mjs"
```

- [ ] **Step 7: Run the unit test, then the check**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/check-layout.test.mjs`
Expected: PASS, 5 tests.

Run: `cd ghcp/plugins/swarm-dashboard && npm run check:layout`
Expected: `Self-test passed …`, `Update self-test passed …`, `Checked 182 views … 0 issues.` (the narrow-only Activity view is skipped where the layout is wide), then `Live updates (example, simulated): 3 updates; … ms median, … ms max; cards kept, no repeated highlights, scroll kept, busy rings in phase.` and exit code 0, in about 25 s. When this plan was written, updates took 2.4 ms median and 7.1 ms max. Reverting `render()` to `dash.innerHTML = …` makes the check fail with `6 of 6 cards were re-created`, and dropping morph's delay rule fails the update self-test.

- [ ] **Step 8: Fix what the check finds**

For each reported issue, fix the stylesheet or the view (never the check's thresholds or the spec's tokens), add a Node test where the fix changes markup, and rerun `npm run check:layout -- --width <px>` for the failing width until it is clean, then the full check. Use `-- --screenshots <folder outside the repo>` to look at a failing view. Expect the stress scenario to be where long names, crowded chips and the eight-level plan expose problems. (When this plan was written, the check found one real bug, fixed above: with long report titles the narrow timeline row's `auto` summary column squeezed the name column to nothing; the row is now split 50/50.) Then run `npm test && npm run validate`.

- [ ] **Step 9: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/scripts ghcp/plugins/swarm-dashboard/tests ghcp/plugins/swarm-dashboard/package.json ghcp/plugins/swarm-dashboard/ui
git commit -m "test(swarm-dashboard): check every view's layout headless at every width"
```

### Task 17: Canvas host and extension

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/server/canvas-host.mjs`
- Create: `ghcp/plugins/swarm-dashboard/com.github.copilot/extensions/swarm-dashboard/extension.mjs`
- Create: `ghcp/plugins/swarm-dashboard/com.github.copilot/extensions/swarm-dashboard/copilot-extension.json`
- Test: `ghcp/plugins/swarm-dashboard/tests/canvas.test.mjs`

**Interfaces:**
- Consumes: `createDashboardServer({ createEngine, port, version, log, hub, onIdle })` with `listen()`, `close()` and `clientCount()` (Task 9); `listenShared`, `probePort`, `resolvePort` (Task 11); `createDefaultEngine`, `createDemoEngine` (Task 8); `freePort`, `openEvents` (`tests/helpers/http.mjs`, Task 9); `tempDir` (PR 1's `tests/helpers/temp.mjs`).
- Produces: `CANVAS_TITLE = 'Swarm dashboard'`; `pageUrl(port, { sessionId, input }): string` (`/?host=canvas&swarm=<id>` when `input.swarm` is a non-empty string, else `&session=<sessionId>`); `createCanvasHost({ port, version, createEngine, log, makeServer, probe, watchdogMs = 2000, jitterMs = 1000, graceMs = 300000, random }): { open(ctx): Promise<{ url, title }>, onClose(ctx): void, dispose(): Promise<void>, hosting(): boolean, instanceCount(): number }`. Errors thrown by `open()` carry a `code`: `port_in_use`, or `unavailable` after `dispose()`. The extension module exports `canvasHost` (null when `SWARM_DASHBOARD_PORT` is invalid) and `canvas` for the tests; the runtime ignores exports.
- The canvas: id `swarm-dashboard`, display name `Swarm dashboard`, and an optional input `{ swarm?: string }` with no required fields, so the app can open it without input (spec section 12, item 3). `open()` returns `{ url: 'http://127.0.0.1:<port>/?host=canvas&session=<sessionId>', title: 'Swarm dashboard' }`, or `&swarm=<id>` when the input names a swarm. Errors reach the host as `CanvasError(code, message)`.
- Lifecycle (decision 1): loading the module starts nothing. `open()` binds the port or reuses a dashboard that identifies itself, records the instance (opening the same `instanceId` again only focuses it) and starts the watchdog. The watchdog runs only while this process has an open canvas: every `watchdogMs` plus up to `jitterMs` it probes the port when this process does not host, and binds the port when it is free. `onClose()` of the last instance stops the watchdog and, when this process hosts, closes the server `graceMs` later unless a page is still connected; the hub's `onIdle` (the engine dropped 5 minutes after the last page left) closes it when no canvas is open here. A canvas that reuses a dashboard of another version logs a warning, because an older extension may still host after an update.

- [ ] **Step 1: Write the failing test**

`tests/canvas.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CANVAS_TITLE, createCanvasHost, pageUrl } from '../server/canvas-host.mjs';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { probePort } from '../server/shared.mjs';
import { freePort, openEvents } from './helpers/http.mjs';
import { tempDir } from './helpers/temp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await pause(20);
  }
}
const demo = () => createDemoEngine({ simulate: false });
const host = (port, options = {}) => createCanvasHost({
  port,
  version: 'test',
  createEngine: demo,
  makeServer: ({ onIdle }) => createDashboardServer({ createEngine: demo, port, version: 'test', hub: { engineIdleMs: 60 }, onIdle }),
  watchdogMs: 40,
  jitterMs: 0,
  ...options,
});

test('the page address names the swarm from the input, else the session', () => {
  assert.equal(pageUrl(7927, { sessionId: 'cli-1' }), 'http://127.0.0.1:7927/?host=canvas&session=cli-1');
  assert.equal(pageUrl(7927, { sessionId: 'cli-1', input: { swarm: 'ws-0000-root' } }), 'http://127.0.0.1:7927/?host=canvas&swarm=ws-0000-root');
  assert.equal(pageUrl(7927, { input: { swarm: '  ' } }), 'http://127.0.0.1:7927/?host=canvas');
  assert.equal(pageUrl(7927, { sessionId: 'a b&c' }), 'http://127.0.0.1:7927/?host=canvas&session=a+b%26c');
});

test('nothing starts before a canvas opens', async () => {
  let calls = 0;
  const canvasHost = host(await freePort(), {
    makeServer: () => { calls += 1; },
    probe: async () => { calls += 1; return { state: 'free' }; },
  });
  await pause(100);
  canvasHost.onClose({ instanceId: 'never-opened' });
  await canvasHost.dispose();
  assert.equal(calls, 0);
  assert.equal(canvasHost.hosting(), false);
});

test('the first canvas hosts the server and later canvases reuse it', async () => {
  const port = await freePort();
  const first = host(port);
  const second = host(port);
  try {
    assert.deepEqual(await first.open({ sessionId: 'cli-1', instanceId: 'a' }), { url: `http://127.0.0.1:${port}/?host=canvas&session=cli-1`, title: CANVAS_TITLE });
    assert.equal(first.hosting(), true);
    assert.equal((await probePort(port)).state, 'ours');
    const reused = await second.open({ sessionId: 'cli-2', instanceId: 'b', input: { swarm: 'ws-0000-root' } });
    assert.equal(reused.url, `http://127.0.0.1:${port}/?host=canvas&swarm=ws-0000-root`);
    assert.equal(second.hosting(), false);
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    assert.equal(second.instanceCount(), 1, 'opening the same instance again only focuses it');
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test('a canvas that reuses an older dashboard says so in its log', async () => {
  const port = await freePort();
  const first = host(port);
  const entries = [];
  const second = host(port, { version: 'next', log: entry => entries.push(entry) });
  try {
    await first.open({ sessionId: 'cli-1', instanceId: 'a' });
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    assert.ok(entries.some(entry => entry.level === 'warn' && entry.message.startsWith('version test of the dashboard')), JSON.stringify(entries));
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test('another program on the port makes open() fail with port_in_use', async () => {
  const port = await freePort();
  const other = createServer((req, res) => res.end('hello'));
  await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
  const canvasHost = host(port);
  try {
    await assert.rejects(canvasHost.open({ sessionId: 'cli-1', instanceId: 'a' }), error => error.code === 'port_in_use' && error.message.includes(`Port ${port} is used by another program`));
    assert.equal(canvasHost.instanceCount(), 0);
  } finally {
    await canvasHost.dispose();
    other.closeAllConnections?.();
    await new Promise(resolve => other.close(() => resolve()));
  }
});

test('an open canvas takes the port over when the host goes away', async () => {
  const port = await freePort();
  const first = host(port);
  const second = host(port);
  try {
    await first.open({ sessionId: 'cli-1', instanceId: 'a' });
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    await first.dispose();
    await until(() => second.hosting());
    assert.equal((await probePort(port)).state, 'ours');
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test('a host keeps serving while a page is connected and stops once nothing uses it', async () => {
  const port = await freePort();
  const canvasHost = host(port, { graceMs: 60 });
  try {
    await canvasHost.open({ sessionId: 'cli-0003-b1', instanceId: 'a' });
    const page = openEvents(port, '/api/events?session=cli-0003-b1');
    await page.waitFor(entry => entry.event === 'snapshot');
    canvasHost.onClose({ instanceId: 'a' });
    await pause(200);
    assert.equal(canvasHost.hosting(), true, 'a connected page keeps the server');
    page.close();
    await until(() => !canvasHost.hosting());
    assert.deepEqual(await probePort(port), { state: 'free' });
  } finally {
    await canvasHost.dispose();
  }
});

test('a closed canvas stops watching the shared server', async () => {
  const port = await freePort();
  const first = host(port);
  let probes = 0;
  const second = host(port, { probe: async (...args) => { probes += 1; return probePort(...args); } });
  try {
    await first.open({ sessionId: 'cli-1', instanceId: 'a' });
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    await until(() => probes >= 3);
    second.onClose({ instanceId: 'b' });
    const seen = probes;
    await pause(200);
    assert.ok(probes <= seen + 1, `${probes - seen} probes after the canvas closed`);
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

// A stand-in for the SDK the Copilot runtime provides to extensions.
const SDK_STUB = `export class CanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const createCanvas = ({ open, onClose, ...declaration }) => ({ declaration, open, onClose });
export async function joinSession(config) {
  globalThis.swarmDashboardJoined = config;
  return {};
}
`;

/** Lay out a plugin copy whose extension resolves @github/copilot-sdk/extension to the stub. */
function stagedExtension() {
  const dir = tempDir('swarm-extension-');
  const sdk = path.join(dir, 'node_modules', '@github', 'copilot-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', type: 'module', exports: { './extension': './extension.mjs' } }));
  writeFileSync(path.join(sdk, 'extension.mjs'), SDK_STUB);
  const plugin = path.join(dir, 'plugin');
  const folder = path.join(plugin, 'com.github.copilot', 'extensions', 'swarm-dashboard');
  mkdirSync(folder, { recursive: true });
  copyFileSync(path.join(root, 'com.github.copilot', 'extensions', 'swarm-dashboard', 'extension.mjs'), path.join(folder, 'extension.mjs'));
  copyFileSync(path.join(root, 'plugin.json'), path.join(plugin, 'plugin.json'));
  symlinkSync(path.join(root, 'server'), path.join(plugin, 'server'), 'dir');
  return pathToFileURL(path.join(folder, 'extension.mjs')).href;
}

test('the extension joins with one canvas that opens the shared page', async () => {
  const entry = stagedExtension();
  const port = await freePort();
  process.env.SWARM_DASHBOARD_PORT = String(port);
  const extension = await import(entry);
  try {
    const { canvases } = globalThis.swarmDashboardJoined;
    assert.equal(canvases.length, 1);
    const [canvas] = canvases;
    assert.equal(canvas.declaration.id, 'swarm-dashboard');
    assert.equal(canvas.declaration.displayName, 'Swarm dashboard');
    assert.deepEqual(canvas.declaration.inputSchema.required ?? [], [], 'the input stays optional');
    assert.equal(extension.canvasHost.hosting(), false, 'loading starts nothing');
    const opened = await canvas.open({ sessionId: 'cli-0003-b1', extensionId: 'test', canvasId: 'swarm-dashboard', instanceId: 'one' });
    assert.deepEqual(opened, { url: `http://127.0.0.1:${port}/?host=canvas&session=cli-0003-b1`, title: 'Swarm dashboard' });
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.app, 'swarm-dashboard');
    assert.equal(health.version, JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8')).version);
    assert.match(await (await fetch(opened.url)).text(), /id="dash"/);
    canvas.onClose({ instanceId: 'one' });
  } finally {
    await extension.canvasHost.dispose();
    delete process.env.SWARM_DASHBOARD_PORT;
  }
});

test('a bad SWARM_DASHBOARD_PORT is reported when the canvas opens', async () => {
  process.env.SWARM_DASHBOARD_PORT = 'abc';
  try {
    const extension = await import(`${stagedExtension()}?bad-port`);
    assert.equal(extension.canvasHost, null);
    const [canvas] = globalThis.swarmDashboardJoined.canvases;
    await assert.rejects(canvas.open({ sessionId: 'cli-1', instanceId: 'one' }), error => error.code === 'bad_port' && /SWARM_DASHBOARD_PORT/.test(error.message));
  } finally {
    delete process.env.SWARM_DASHBOARD_PORT;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/canvas.test.mjs`
Expected: FAIL with `Cannot find module '.../server/canvas-host.mjs'`.

- [ ] **Step 3: Write `server/canvas-host.mjs`**

```js
import { createDashboardServer } from './http.mjs';
import { listenShared, probePort } from './shared.mjs';

export const CANVAS_TITLE = 'Swarm dashboard';

/** The page address for one canvas: the swarm named in its input, else the swarm of the session it opened in. */
export function pageUrl(port, { sessionId, input } = {}) {
  const query = new URLSearchParams({ host: 'canvas' });
  const swarm = input && typeof input === 'object' && typeof input.swarm === 'string' ? input.swarm.trim() : '';
  if (swarm) query.set('swarm', swarm);
  else if (sessionId) query.set('session', sessionId);
  return `http://127.0.0.1:${port}/?${query}`;
}

/**
 * The canvas side of the shared dashboard server. Each Copilot session with the plugin enabled runs one extension
 * process, and each process keeps one canvas host. The first canvas opened on the machine binds the fixed port in its
 * own process; later canvases reuse that server once it identifies itself, and while they are open they watch it and
 * take the port over if its host goes away. A hosting process stops serving once it has no open canvas and no page is
 * connected. Nothing starts before the first open(). Never writes to stdout.
 */
export function createCanvasHost({
  port,
  version,
  createEngine,
  log = () => {},
  makeServer = ({ onIdle }) => createDashboardServer({ createEngine, port, version, log, onIdle }),
  probe = probePort,
  watchdogMs = 2000,
  jitterMs = 1000,
  graceMs = 300000,
  random = Math.random,
}) {
  const instances = new Set();
  let server = null;
  let starting = null;
  let watchdog = null;
  let graceTimer = null;
  let lastSeen = null;
  let disposed = false;
  const report = (level, message) => log({ level, source: 'canvas', message });

  function ensureServer() {
    if (server) return Promise.resolve();
    if (!starting) {
      starting = (async () => {
        const result = await listenShared({ port, makeServer: () => makeServer({ onIdle: () => { release().catch(error => report('warn', error.message)); } }), probe });
        if (result.status === 'started') {
          server = result.server;
          report('info', `serving the dashboard at http://127.0.0.1:${port}/`);
        } else if (result.status === 'running') {
          if (result.health.version !== version) report('warn', `version ${result.health.version} of the dashboard serves port ${port}, not ${version}; restart the app or reload extensions everywhere to update it`);
        } else {
          const error = new Error(`Port ${port} ${result.status === 'taken' ? 'is used by another program' : 'is in use and not answering'}. Stop that program, or set SWARM_DASHBOARD_PORT to a free port for the Copilot app and restart it.`);
          error.code = 'port_in_use';
          throw error;
        }
      })().finally(() => { starting = null; });
    }
    return starting;
  }

  /** Close the server this process hosts once no canvas here and no page anywhere uses it. */
  async function release() {
    if (!server || instances.size || server.clientCount()) return;
    const current = server;
    server = null;
    clearTimeout(graceTimer);
    graceTimer = null;
    await current.close();
    report('info', 'stopped serving the dashboard: no canvas or page uses it');
  }

  function scheduleRelease() {
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      release().catch(error => report('warn', error.message));
    }, graceMs);
    graceTimer.unref?.();
  }

  /** While a canvas is open here and another process hosts the server, check on it and take the port if it is free. */
  function watch() {
    if (watchdog || disposed || !instances.size) return;
    const handle = setTimeout(async () => {
      try {
        if (!server && !starting) {
          const found = await probe(port, { timeoutMs: 1500 });
          if (found.state === 'other' && lastSeen !== 'other') report('warn', `port ${port} is now used by another program; open canvases cannot reach the dashboard`);
          lastSeen = found.state;
          if (found.state === 'free' && instances.size && !disposed) await ensureServer();
        }
      } catch (error) {
        report('warn', error.message);
      } finally {
        if (watchdog === handle) {
          watchdog = null;
          watch();
        }
      }
    }, watchdogMs + random() * jitterMs);
    handle.unref?.();
    watchdog = handle;
  }

  function stopWatching() {
    clearTimeout(watchdog);
    watchdog = null;
  }

  return {
    async open(ctx = {}) {
      if (disposed) throw Object.assign(new Error('The swarm dashboard extension is shutting down.'), { code: 'unavailable' });
      await ensureServer();
      instances.add(ctx.instanceId ?? '');
      clearTimeout(graceTimer);
      graceTimer = null;
      watch();
      return { url: pageUrl(port, ctx), title: CANVAS_TITLE };
    },
    onClose(ctx = {}) {
      instances.delete(ctx.instanceId ?? '');
      if (instances.size) return;
      stopWatching();
      if (server) scheduleRelease();
    },
    async dispose() {
      disposed = true;
      instances.clear();
      stopWatching();
      clearTimeout(graceTimer);
      graceTimer = null;
      await starting?.catch(() => {});
      const current = server;
      server = null;
      await current?.close();
    },
    hosting: () => server !== null,
    instanceCount: () => instances.size,
  };
}
```

- [ ] **Step 4: Write the extension and its marker**

`com.github.copilot/extensions/swarm-dashboard/extension.mjs`:

```js
import { readFileSync } from 'node:fs';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import { createCanvasHost } from '../../../server/canvas-host.mjs';
import { createDefaultEngine } from '../../../server/engines.mjs';
import { resolvePort } from '../../../server/shared.mjs';

// The runtime talks JSON-RPC over this process's stdout, so every log line goes to stderr.
const log = entry => process.stderr.write(`swarm-dashboard ${entry.level} ${entry.source}: ${entry.message}\n`);
const { version } = JSON.parse(readFileSync(new URL('../../../plugin.json', import.meta.url), 'utf8'));

let portError = null;
let port = null;
try {
  port = resolvePort();
} catch (error) {
  portError = error;
}

/** Exported for tests; the runtime ignores exports. Starts nothing until a canvas opens. */
export const canvasHost = port === null ? null : createCanvasHost({ port, version, log, createEngine: () => createDefaultEngine({ log }) });

export const canvas = createCanvas({
  id: 'swarm-dashboard',
  displayName: 'Swarm dashboard',
  description: 'Watch an agentic swarm: what each session and sub-agent is doing, its progress and cost, and what needs you.',
  inputSchema: {
    type: 'object',
    properties: {
      swarm: { type: 'string', description: 'Root session id of the swarm to show. Default: the swarm of the session the canvas opens in.' },
    },
    additionalProperties: false,
  },
  async open(ctx) {
    if (portError) throw new CanvasError('bad_port', portError.message);
    try {
      return await canvasHost.open(ctx);
    } catch (error) {
      throw new CanvasError(error.code ?? 'open_failed', error.message);
    }
  },
  onClose(ctx) {
    canvasHost?.onClose(ctx);
  },
});

// When the CLI stops this extension, close the server first, and with it the engine's read-only database connections,
// then end the way the signal would have ended the process.
process.once('SIGTERM', () => {
  Promise.resolve(canvasHost?.dispose()).finally(() => process.kill(process.pid, 'SIGTERM'));
});

await joinSession({ canvases: [canvas] });
```

`com.github.copilot/extensions/swarm-dashboard/copilot-extension.json`:

```json
{ "name": "swarm-dashboard", "version": 1 }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/canvas.test.mjs && npm test && npm run validate`
Expected: PASS, 10 canvas tests; the whole suite and validation pass. The takeover and release tests depend on timers, so run the canvas test five times in a row and expect five passes: `for i in 1 2 3 4 5; do node --test tests/canvas.test.mjs > /dev/null || echo FAILED; done`.

- [ ] **Step 6: Check the canvas host in the real extension runtime (local; installs nothing)**

Extensions run inside the Copilot CLI's own Node (v24.20.0 on the machine this plan was written on), not the system Node. This check runs the canvas host there through the CLI's extension bootstrap, without `joinSession` (which needs a live CLI session) and without installing anything. The paths below are the macOS locations; compare them with a running extension process (`ps -axo pid,command | grep '[e]xtension_bootstrap.mjs'` and the `COPILOT_SDK_PATH` in that process's environment). The bootstrap exits at once unless `COPILOT_EXTENSION_PARENT_PID` is its parent's PID, hence the `bash -c '…; :'` wrapper.

```bash
cd ghcp/plugins/swarm-dashboard
PROBE="$(mktemp -d)/probe.mjs"
cat > "$PROBE" <<'EOF'
import { pathToFileURL } from 'node:url';
import { CanvasError, createCanvas } from '@github/copilot-sdk/extension';
const root = pathToFileURL(`${process.env.PLUGIN_ROOT}/`).href;
const { createCanvasHost } = await import(`${root}server/canvas-host.mjs`);
const { createDemoEngine } = await import(`${root}server/demo-engine.mjs`);
const port = Number(process.env.SWARM_DASHBOARD_PORT);
const host = createCanvasHost({ port, version: 'probe', createEngine: () => createDemoEngine({ simulate: false }) });
const canvas = createCanvas({ id: 'probe', displayName: 'Probe', description: 'Probe', open: ctx => host.open(ctx) });
const opened = await canvas.open({ sessionId: 'cli-0003-b1', instanceId: 'one' });
const events = await fetch(opened.url.replace('/?host=canvas&', '/api/events?'));
const reader = events.body.getReader();
let text = '';
while (!text.includes('event: snapshot')) text += new TextDecoder().decode((await reader.read()).value);
process.stderr.write(`probe: node ${process.version}, CanvasError ${typeof CanvasError}, ${opened.url}, snapshot ${text.includes('"ws-0000-root"')}\n`);
await reader.cancel();
await host.dispose();
process.exit(0);
EOF
export PROBE CLI="$(ls -d ~/Library/Caches/github-copilot-sdk/cli/*/copilot | sort -V | tail -1)" SDK=/Applications/GitHub.app/Contents/Resources/copilot-sdk
bash -c 'COPILOT_EXTENSION_PARENT_PID=$$ COPILOT_SDK_PATH="$SDK" EXTENSION_PATH="$PROBE" PLUGIN_ROOT="$PWD" SWARM_DASHBOARD_PORT=7999 "$CLI" extension_bootstrap.mjs < /dev/null; :' 2>&1 | grep '^probe:'
rm -r "$(dirname "$PROBE")"
```

Expected: `probe: node v24.20.0, CanvasError function, http://127.0.0.1:7999/?host=canvas&session=cli-0003-b1, snapshot true`, and nothing left listening on 7999 (`lsof -nP -iTCP:7999 -sTCP:LISTEN` prints nothing). If the SDK cannot be resolved or the server cannot bind inside the runtime, stop and report it to the coordinator.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/server/canvas-host.mjs ghcp/plugins/swarm-dashboard/com.github.copilot ghcp/plugins/swarm-dashboard/tests/canvas.test.mjs
git commit -m "feat(swarm-dashboard): add the canvas extension on the shared server"
```

- [ ] **Step 8: In-app check in a session-scoped extension (controller)**

The controller runs this in its own session, because it needs that session's extensions and canvases; a sub-agent cannot. Nothing is installed in `~/.copilot/extensions` or from a marketplace. If a session-scoped extension cannot provide the canvas, stop and ask the coordinator: a user-level install needs the owner's approval.

1. Read the `extensions_manage` guide, then scaffold a canvas extension with location `session` and the name `swarm-dashboard-check`. Replace the scaffolded `extension.mjs` with one line that imports this checkout's extension by absolute path, so its `../../../server/` imports resolve inside the checkout: `import '<absolute path of the plugin folder>/com.github.copilot/extensions/swarm-dashboard/extension.mjs';`
2. Reload extensions, check with `extensions_manage` `list` that it is loaded, and open the canvas with `open_canvas` (canvas id `swarm-dashboard`).
3. Check: it opens in the side panel and shows this session's swarm, updates live, and matches the mockup's side-panel layout at the panel's real width. The panel is WebKit, not Chrome: compare the font, the type scale, chips, bars and the SVGs with the mockup. If the preview server from Task 20 holds port 7927, the canvas reuses it (decision 1); restart that server first if UI files changed since it started.
4. Take screenshots of the app window with the canvas open (Cards, Timeline, Plan, Board, a detail panel), keep them in the session's files folder, never in the repository, and note the panel's width in px.
5. Check `lsof -nP -iTCP:7927 -sTCP:LISTEN` shows one listener, and close the canvas.
6. Remove the session extension's folder and reload extensions.

Fix any WebKit-only difference in `ui/styles.css`, rerun `npm run check:layout`, and commit the fix with a test where markup changed. Report the findings, the panel width and the screenshot paths to the coordinator.

### Task 18: Canvas packaging and validation

**Files:**
- Modify: `ghcp/plugins/swarm-dashboard/plugin.json` (add `$schema` and `extensions`)
- Create: `ghcp/plugins/swarm-dashboard/scripts/lib/validate-dashboard.mjs`
- Modify: `ghcp/plugins/swarm-dashboard/scripts/validate-plugin.mjs` (one import, one call)
- Test: `ghcp/plugins/swarm-dashboard/tests/packaging.test.mjs`

**Interfaces:**
- Consumes: every file from Tasks 1–17; PR 1's `validatePlugin(root, repositoryRoot): Promise<string[]>` and its tests.
- Produces: `AGENT_PLUGINS_SCHEMA`, `EXTENSION_DIR = 'com.github.copilot/extensions/swarm-dashboard'`, `DASHBOARD_FILES`, `validateDashboard(root, manifest, pkg): Promise<string[]>`; `validatePlugin` now also returns the dashboard's errors, so `npm run validate` covers them.
- Packaging (spec call 1): `plugin.json` declares `"$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"` and `"extensions": { "com.github.copilot": {} }`, and the extension sits in `com.github.copilot/extensions/swarm-dashboard/` beside `copilot-extension.json`. The CLI's changelog (1.0.96) says Agent Plugins spec plugins "can now ship extensions under a com.github.copilot/extensions/ directory". The plugin declares no `agents` or `skills`, so the schema cannot change how those are read (spec section 12, item 5).
- Guards for this PR's code (PR 1's guard tests cover `engine/` and `scripts/`): code in `server/` and the extension never writes to stdout; `server/`, `ui/` and the extension write no files; `server/` imports only `node:` built-ins and relative modules, `ui/` only relative modules, and the extension adds only `@github/copilot-sdk/extension`; none of them use APIs newer than Node 18; the page loads nothing from other origins, and the server fetches only its own loopback address.

- [ ] **Step 1: Write the failing test**

`tests/packaging.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PLUGINS_SCHEMA, EXTENSION_DIR, validateDashboard } from '../scripts/lib/validate-dashboard.mjs';
import { tempDir } from './helpers/temp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const name = file => path.relative(root, file);
function sources(dir, pattern = /\.mjs$/) {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? sources(full, pattern) : pattern.test(entry) ? [full] : [];
  });
}
const serverFiles = sources(path.join(root, 'server'));
const uiFiles = sources(path.join(root, 'ui'));
const extensionFile = path.join(root, EXTENSION_DIR, 'extension.mjs');

/** A copy of the plugin to break one thing in. */
function sandbox() {
  const dir = path.join(tempDir('swarm-packaging-'), 'swarm-dashboard');
  mkdirSync(dir);
  cpSync(root, dir, { recursive: true });
  return dir;
}
const validate = dir => validateDashboard(dir, JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')), JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')));

test('the plugin declares its canvas the way Copilot discovers it', async () => {
  const manifest = readJson('plugin.json');
  assert.equal(manifest.$schema, AGENT_PLUGINS_SCHEMA);
  assert.deepEqual(manifest.extensions, { 'com.github.copilot': {} });
  assert.deepEqual(readJson(`${EXTENSION_DIR}/copilot-extension.json`), { name: 'swarm-dashboard', version: 1 });
  assert.deepEqual(await validateDashboard(root, manifest, readJson('package.json')), []);
});

test('the validator reports a missing schema, extensions field, command, file or marker', async () => {
  const dir = sandbox();
  const manifest = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  delete manifest.$schema;
  manifest.extensions = 'extensions';
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete pkg.scripts.start;
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  rmSync(path.join(dir, 'ui', 'main.mjs'));
  writeFileSync(path.join(dir, EXTENSION_DIR, 'copilot-extension.json'), '{ "name": "other", "version": 1 }');
  const errors = await validate(dir);
  for (const expected of ['"$schema"', '"extensions"', 'the start command', 'ui/main.mjs: required file is missing', 'copilot-extension.json must be']) {
    assert.ok(errors.some(error => error.includes(expected)), `${expected} in\n${errors.join('\n')}`);
  }
});

test('the validator rejects an extension that writes to stdout or declares no canvas', async () => {
  const dir = sandbox();
  writeFileSync(path.join(dir, EXTENSION_DIR, 'extension.mjs'), "console.log('hello');\n");
  const errors = await validate(dir);
  assert.ok(errors.some(error => error.includes('must join the session with the swarm-dashboard canvas')), errors.join('\n'));
  assert.ok(errors.some(error => error.includes('must not write to stdout')), errors.join('\n'));
});

test('the server and the extension never write to stdout', () => {
  for (const file of [...serverFiles, extensionFile]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.(log|info|debug|dir|table)\(|process\.stdout/, name(file));
  }
});

test('the server, the UI and the extension write no files', () => {
  const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|utimes|utimesSync)\s*\(/;
  for (const file of [...serverFiles, ...uiFiles, extensionFile]) assert.doesNotMatch(readFileSync(file, 'utf8'), writes, name(file));
});

test('the server and the UI import only Node built-ins and their own modules; the extension adds only the SDK', () => {
  const imports = /\bfrom\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g;
  for (const file of [...serverFiles, ...uiFiles, extensionFile]) {
    for (const match of readFileSync(file, 'utf8').matchAll(imports)) {
      const specifier = match[1] ?? match[2];
      const allowed = specifier.startsWith('.') || (!file.startsWith(path.join(root, 'ui')) && specifier.startsWith('node:')) || (file === extensionFile && specifier === '@github/copilot-sdk/extension');
      assert.ok(allowed, `${name(file)} imports ${specifier}`);
    }
  }
});

test('the server, the UI and the extension avoid APIs newer than Node 18', () => {
  const newer = /\.toSorted\(|\.toReversed\(|\.toSpliced\(|Object\.groupBy|Map\.groupBy|Promise\.withResolvers|Array\.fromAsync|\.isSubsetOf\(|\.union\(|\.intersection\(/;
  for (const file of [...serverFiles, ...uiFiles, extensionFile]) assert.doesNotMatch(readFileSync(file, 'utf8'), newer, name(file));
});

test('the page loads nothing from elsewhere and the server only calls itself', () => {
  for (const file of sources(path.join(root, 'ui'), /\.(mjs|css|html)$/)) assert.doesNotMatch(readFileSync(file, 'utf8'), /https?:\/\//, name(file));
  for (const file of serverFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfetch\(([^,)]*)/g)) assert.match(match[1], /^`http:\/\/127\.0\.0\.1:/, `${name(file)}: fetch(${match[1]}`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/packaging.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/lib/validate-dashboard.mjs'`.

- [ ] **Step 3: Write `scripts/lib/validate-dashboard.mjs`**

```js
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const EXTENSION_DIR = 'com.github.copilot/extensions/swarm-dashboard';
export const DASHBOARD_FILES = [
  `${EXTENSION_DIR}/extension.mjs`, `${EXTENSION_DIR}/copilot-extension.json`,
  'server/assets.mjs', 'server/canvas-host.mjs', 'server/demo-engine.mjs', 'server/demo-scenarios.mjs', 'server/engines.mjs',
  'server/http.mjs', 'server/hub.mjs', 'server/shared.mjs',
  'ui/index.html', 'ui/styles.css', 'ui/app.mjs', 'ui/format.mjs', 'ui/history.mjs', 'ui/live.mjs', 'ui/main.mjs', 'ui/model.mjs',
  'ui/morph.mjs', 'ui/parts.mjs', 'ui/plan.mjs', 'ui/timeline.mjs',
  'scripts/swarm-dashboard.mjs', 'scripts/check-layout.mjs', 'scripts/lib/cdp.mjs', 'scripts/lib/page-audit.mjs',
];
const SCRIPTS = { start: 'node scripts/swarm-dashboard.mjs', 'check:layout': 'node scripts/check-layout.mjs' };

/** The dashboard's checks: canvas packaging, UI, server and launcher files, and the two commands. */
export async function validateDashboard(root, manifest, pkg) {
  const errors = [];
  if (manifest.$schema !== AGENT_PLUGINS_SCHEMA) errors.push(`plugin.json must declare "$schema": "${AGENT_PLUGINS_SCHEMA}" so Copilot finds the canvas`);
  const client = manifest.extensions?.['com.github.copilot'];
  if (!client || typeof client !== 'object' || Array.isArray(client)) errors.push('plugin.json must declare "extensions": { "com.github.copilot": {} }');
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (pkg.scripts?.[name] !== command) errors.push(`package.json must expose the ${name} command`);
  }
  for (const file of DASHBOARD_FILES) {
    try {
      await access(path.join(root, file));
    } catch {
      errors.push(`${file}: required file is missing`);
    }
  }
  try {
    const marker = JSON.parse(await readFile(path.join(root, EXTENSION_DIR, 'copilot-extension.json'), 'utf8'));
    if (marker?.name !== 'swarm-dashboard' || marker?.version !== 1) errors.push(`${EXTENSION_DIR}/copilot-extension.json must be { "name": "swarm-dashboard", "version": 1 }`);
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(`${EXTENSION_DIR}/copilot-extension.json: ${error.message}`);
  }
  try {
    const source = await readFile(path.join(root, EXTENSION_DIR, 'extension.mjs'), 'utf8');
    // Match the specifier alone: PR 1's import guard scans scripts/ for import statements and would count a quoted one.
    if (!source.includes("'@github/copilot-sdk/extension'") || !/\bjoinSession\(/.test(source) || !source.includes("id: 'swarm-dashboard'")) {
      errors.push(`${EXTENSION_DIR}/extension.mjs must join the session with the swarm-dashboard canvas`);
    }
    if (/console\.(log|info|debug|dir|table)\(|process\.stdout/.test(source)) errors.push(`${EXTENSION_DIR}/extension.mjs must not write to stdout`);
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(`${EXTENSION_DIR}/extension.mjs: ${error.message}`);
  }
  return errors;
}
```

- [ ] **Step 4: Call it from the shared validator**

The shared validator, `scripts/validate-plugin.mjs`, belongs to PR 1 too, so change only two lines in it and keep everything else as it is.

Add this import after its `node:url` import:

```js
import { validateDashboard } from './lib/validate-dashboard.mjs';
```

Add this call at the end of `validatePlugin`, just before its final `return errors;`:

```js
  errors.push(...await validateDashboard(root, manifest, pkg));
```

- [ ] **Step 5: Declare the canvas in `plugin.json`**

Add `$schema` as the first key and `extensions` as the last, and keep every other field as it is. With PR 1's fields as they were when this plan was written, the file is:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "swarm-dashboard",
  "description": "Watch-only dashboard for agentic swarms in the GitHub Copilot app: sessions, sub-agents, cost, stuck detection and run history.",
  "version": "0.1.0",
  "author": {
    "name": "Nick Sologoub"
  },
  "license": "MIT",
  "keywords": [
    "dashboard",
    "agentic-swarm",
    "orchestration",
    "cost",
    "copilot-app"
  ],
  "category": "development",
  "extensions": {
    "com.github.copilot": {}
  }
}
```

The version stays `0.1.0`, as in `package.json` and the root marketplace entry.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/packaging.test.mjs && npm test && npm run validate`
Expected: PASS, 8 packaging tests; PR 1's validator tests still pass; `Plugin validation passed: manifests, root marketplace entry and required files.`

- [ ] **Step 7: Check that the CLI reads the manifest (read-only; installs nothing)**

Run: `cd ghcp/plugins/swarm-dashboard && copilot --plugin-dir "$PWD" plugin list --json`
Expected: the list includes `{"name": "swarm-dashboard", "version": "0.1.0", "enabled": true, "source": "external", …}`. `--plugin-dir` loads the plugin for this one command only; check that `~/.copilot/config.json` keeps its modification time.

- [ ] **Step 8: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/plugin.json ghcp/plugins/swarm-dashboard/scripts/lib/validate-dashboard.mjs ghcp/plugins/swarm-dashboard/scripts/validate-plugin.mjs ghcp/plugins/swarm-dashboard/tests/packaging.test.mjs
git commit -m "feat(swarm-dashboard): package the canvas and validate the dashboard files"
```

### Task 19: Plugin README and repository docs

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/README.md`
- Modify: `README.md` (repository root): the Plugins table, one paragraph, the install section and the layout tree
- Modify: `.github/copilot-instructions.md`: the plugin list and "Working in this repo"

**Interfaces:**
- Consumes: the commands, port, canvas id and behaviour from Tasks 9–18, and PR 1's snapshot command and history folder.
- Produces: user documentation only. Plain English, no internal names, no local user paths; `~/.copilot/...` paths are the documented Copilot locations.

- [ ] **Step 1: Write the plugin README**

`ghcp/plugins/swarm-dashboard/README.md`:

````markdown
# Swarm dashboard

A watch-only dashboard for agentic swarms in the GitHub Copilot app. A swarm is a session that has started child sessions, such as an orchestrator that hands each unit of work to its own session. The dashboard shows what every session and sub-agent is doing, how far it has got, what it costs and what needs you, so you can follow the work at a glance instead of reading transcripts.

It opens as a canvas in the app's side panel, or in any browser through a small local launcher. It reads Copilot's local data read-only and sends nothing off your machine.

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

`npm start -- --demo` serves a synthetic swarm with simulated activity instead of your data, `--demo stress` a crowded one, and `--still` stops the simulation.

## The port

The dashboard always uses `http://127.0.0.1:7927/`. One dashboard server runs on the machine, shared by every canvas and browser: the first canvas you open, or the launcher, starts it, and everything else reuses it. If the session that hosts it ends, another open canvas takes the port over within a few seconds and the pages reconnect by themselves. A server started by a canvas stops a few minutes after the last canvas closes and no page is connected; the launcher runs until you press Ctrl+C.

If another program already uses port 7927, the launcher says so and exits, and the canvas shows the same error. Use another port with `npm start -- --port <n>`, or set `SWARM_DASHBOARD_PORT` for both the launcher and the environment the Copilot app starts with.

## Privacy and data access

Read-only access. The dashboard reads `~/.copilot/data.db`, `~/.copilot/session-store.db` and the session folders, and never writes to them. Its only writes are run summaries in `~/.copilot/swarm-dashboard/history/`, which keep finished runs in History after logs are cleaned up. SQLite databases are opened read-only. A database in WAL mode that a running Copilot process has open is read through one long-lived read-only connection, opened only when its `-wal` and `-shm` files already exist; while it's open, its lock keeps those files in place. A database that nothing has open is read in immutable mode, which never touches side files. If a database's write-ahead log holds data but its shared-memory file is missing, the dashboard skips that read, keeps the last data it read and shows a warning. One narrow case remains: if the last Copilot process finishes closing a database in the few microseconds between the dashboard's check and SQLite's read lock, SQLite creates an empty `-wal` and `-shm` beside it. No data changes, and the next process that opens the database reuses or removes them.

- From `data.db` it reads named columns only.
- The server listens on 127.0.0.1 only, answers only requests addressed to `127.0.0.1` or `localhost` on its port, and serves only GET and HEAD. The page loads nothing from the internet.
- The only outbound requests are read-only `gh` and `az` queries for the state of the swarm's pull requests, made with your existing CLI login and cached.

## How it decides what is stuck

A session counts as stuck when a model call, tool call or sub-agent has gone quiet for longer than a set limit, when it is busy but has written nothing for 10 minutes, or when it keeps failing or repeating itself; a session waiting for your answer is never stuck. The detail panel names the rule that fired and its numbers. The rules and their limits are in the [design](../../../docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md) (section 9) and the defaults in `engine/config.mjs`. Orchestrators can report status in a fixed format that the dashboard reads exactly (design section 10).

## Commands

Run these from the plugin folder.

| Command | What it does |
| --- | --- |
| `npm start` | Serve the dashboard for browsers (`--port`, `--demo`, `--still`) |
| `npm run snapshot -- --list` | Print the swarms as JSON; `--swarm <id>`, `--history` and `--run <id>` print the rest |
| `npm test` | Run the unit tests |
| `npm run validate` | Check the plugin's manifests, files and marketplace entry |
| `npm run check:layout` | Check every view for overlap, clipped text, type, spacing and contrast at every width, and that live updates leave the page steady, in a local headless Chrome, Chromium or Edge (set `CHROME_PATH` to choose one); `-- --live <url>` checks a running dashboard |

## Troubleshooting

- "Port 7927 is used by another program": see [The port](#the-port).
- "Disconnected · retrying" in a browser: no dashboard server is running. Start the launcher or open the canvas. In the canvas the page recovers by itself within a few seconds; if it does not, close and reopen the canvas.
- Old behaviour after an update: restart the app, or reload extensions in every session, so that no session still serves the previous version. A canvas that finds an older dashboard on the port says so in the extension log.
- Pages that never load: browsers allow about six open connections per site, and each open dashboard page holds one. With more than about six dashboard tabs or canvases open at once, the extra pages wait; close the ones you do not need.
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
````

- [ ] **Step 2: Update the root README**

In the Plugins table, add this row after the `adr-authoring` row:

```markdown
| [`swarm-dashboard`](./ghcp/plugins/swarm-dashboard/README.md) | A **watch-only dashboard** for agentic swarms: one card per child session with its state, progress, cost and anything waiting for you, plus a timeline, plan, board and run history. Opens as a canvas in the Copilot app or in a browser, reads Copilot's local data read-only and sends nothing off the machine. | `copilot plugin install swarm-dashboard@ai-tools` |
```

After the paragraph that starts with "`adr-authoring` is a documentation workflow", add:

```markdown
`swarm-dashboard` is a viewer, not a workflow: it adds a canvas and a local launcher, and no skills or agents. It reads Copilot's local session data, so it shows the swarms that run on the same machine.
```

In the install section, after the paragraph that starts with "Direct installs from a repo, URL or local path", add:

```markdown
The `swarm-dashboard` canvas loads with each session's extensions, so restart your Copilot sessions, or ask Copilot to reload extensions, after installing it.
```

In the repository layout, `adr-authoring/` is the last entry under `plugins/`; `main` has changed this tree since the base branch was cut, so edit whatever is there rather than replacing fixed text. Make `adr-authoring/` a middle entry: change its `└── adr-authoring/` to `├── adr-authoring/`, and in each of its child lines put `│` in place of the first of the four spaces that follow the `plugins/` indent, keeping the comments as they are (for example `            ├── plugin.json` becomes `        │   ├── plugin.json`). Then add this subtree after it, as the new last entry:

```text
        └── swarm-dashboard/
            ├── plugin.json
            ├── package.json
            ├── engine/                ← reads Copilot's local data into swarm snapshots
            ├── server/                ← local server, shared port and canvas host
            ├── ui/                    ← the dashboard page, no build step
            ├── com.github.copilot/    ← the canvas extension
            ├── scripts/               ← launcher, snapshot command, layout check, validator
            └── tests/
```

- [ ] **Step 3: Update `.github/copilot-instructions.md`**

Under **Plugins:**, after the `adr-authoring` bullet, add:

```markdown
- `swarm-dashboard` — watch-only dashboard for agentic swarms, shown as a canvas in the Copilot app or in a browser. Bundles a read-only engine over Copilot's local data (`engine/`), a loopback server shared on port 7927 (`server/`), a no-build UI (`ui/`), the canvas extension (`com.github.copilot/extensions/swarm-dashboard/`), and a launcher, snapshot command and headless layout check (`scripts/`). No skills or agents and no npm dependencies; the layout check needs a local Chrome, Chromium or Edge.
```

Under "Working in this repo", after the bullet that starts with "Plugins **do** have tests", add:

```markdown
- For `swarm-dashboard`, also run `npm run check:layout` from its directory after any change under `ui/`; every view must report 0 issues.
```

- [ ] **Step 4: Check the docs**

Run: `cd ghcp/plugins/swarm-dashboard && ls ../../../docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md engine/config.mjs && npm test && npm run validate`
Expected: both link targets exist (if PR 1's `engine/config.mjs` is not on the branch yet, Task 21 checks it again); tests and validation pass. Read the three documents once more for plain wording, and after staging run `git diff --cached -U0 -- ghcp README.md .github | grep -n -E '/Users/|/home/'`: it prints nothing.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/README.md README.md .github/copilot-instructions.md
git commit -m "docs(swarm-dashboard): document the dashboard, canvas and launcher"
```

### Task 20: Switch to PR 1's engine and send the early preview

**Files:**
- Modify: `ghcp/plugins/swarm-dashboard/server/engines.mjs`
- Modify: `ghcp/plugins/swarm-dashboard/ui/model.mjs` (`unitEnd`)
- Test: `ghcp/plugins/swarm-dashboard/tests/demo-engine.test.mjs`, `ghcp/plugins/swarm-dashboard/tests/ui-model.test.mjs`

**Interfaces:**
- Consumes: PR 1's `createSwarmEngine(options): SwarmEngine` from `engine/engine.mjs` (`options.log` receives diagnostics; finished runs are summarised into `~/.copilot/swarm-dashboard/history`, the engine's one write).
- Produces: `createDefaultEngine === createSwarmEngine`; `unitEnd(session) = session.endedAt ?? null`.

Runs right after Task 11 (see Execution order); the real-data smoke check with `--live` is in Task 21, after the layout check exists.

- [ ] **Step 1: Check that PR 1's engine is on the branch**

Run: `test -f ghcp/plugins/swarm-dashboard/engine/engine.mjs && git log --oneline -1 -- ghcp/plugins/swarm-dashboard/engine/engine.mjs`
Expected: a commit from PR 1. The branch was rebased onto PR 1's finished branch before Task 1. If PR 1 changes again, the coordinator says when to rebase: `git fetch origin && git rebase origin/nicksologoub-microsoft-swarm-data-engine`, keeping both sides of any conflict in the shared files (PR 1's required files and `snapshot` script; this PR's `start` and `check:layout` scripts and its two validator lines), then `npm test && npm run validate` and `git push --force-with-lease` (approved until the pull request opens).

- [ ] **Step 2: Write the failing tests**

In `tests/demo-engine.test.mjs`, add `import { createSwarmEngine } from '../engine/engine.mjs';` to the imports and replace the test `the default engine is the demo engine until PR 1's engine is in` with:

```js
test('the default engine is PR 1\'s engine over Copilot data', () => {
  assert.equal(createDefaultEngine, createSwarmEngine);
});
```

In `tests/ui-model.test.mjs`, replace the test `a unit ends at endedAt, else at its PR outcome when it has one` with:

```js
test('a unit ends at endedAt, which the engine sets from its outcome', () => {
  const snapshot = exampleSnapshot();
  const f2a = findByLabel(snapshot, 'f2a');
  assert.equal(unitEnd(f2a), f2a.endedAt);
  assert.equal(unitEnd({ ...f2a, endedAt: null }), null);
  assert.equal(unitEnd(findByLabel(snapshot, 'B1')), null);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/demo-engine.test.mjs tests/ui-model.test.mjs`
Expected: FAIL in the two replaced tests (the default engine is still the demo engine; `unitEnd` still falls back to the PR's merge time).

- [ ] **Step 4: Switch the engine and drop the fallback**

`server/engines.mjs` becomes:

```js
/** The engine behind the launcher and the canvas: PR 1's engine over Copilot's local data, read-only. */
export { createSwarmEngine as createDefaultEngine } from '../engine/engine.mjs';
```

In `ui/model.mjs`, replace the `unitEnd` function and its comment with:

```js
/** When a unit's work ended (null while it runs): the engine sets endedAt from the unit's outcome time. */
export const unitEnd = session => session.endedAt ?? null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass and validation passes. The suite still reads no Copilot data: the launcher tests use `--demo`, and the reuse and taken-port tests never create an engine (nor will the canvas test of Task 17, which asks only for `/api/health` and the page).

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/server/engines.mjs ghcp/plugins/swarm-dashboard/ui/model.mjs ghcp/plugins/swarm-dashboard/tests/demo-engine.test.mjs ghcp/plugins/swarm-dashboard/tests/ui-model.test.mjs
git commit -m "feat(swarm-dashboard): serve Copilot data through the swarm engine"
```

- [ ] **Step 7: Early preview on real data (controller)**

This reads the owner's Copilot data on this machine only; nothing from it is committed or sent anywhere. Start the launcher from the plugin folder as a detached process, so it outlives the command that starts it: `node scripts/swarm-dashboard.mjs` (port 7927). Then check that it answers:

```bash
curl -s http://127.0.0.1:7927/api/health
curl -s http://127.0.0.1:7927/api/swarms | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const l=JSON.parse(s);console.log(l.length+' swarms, '+l.filter(x=>x.lifecycle==='live').length+' live')})"
```

Expected: `{"app":"swarm-dashboard",…}`, then counts only. Open `http://127.0.0.1:7927/` at full width and at about 560 px and compare Cards, the header, Needs you, the activity rail and the detail panel with the mockup; fix visible differences in `ui/styles.css` or the views (with tests) before going on. Send the coordinator the URL and leave the server running until it says to stop it. The server keeps the UI files it loaded at start, so after later UI tasks restart it with the same command (pages reconnect by themselves) and say so in the next report.

### Task 21: Final verification and handoff

**Files:** none new; fixes go in the task that owns the file.

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence the coordinator needs for review.

- [ ] **Step 1: Run every check**

```bash
cd ghcp/plugins/swarm-dashboard
npm test && npm run validate
npm run check:layout
```

Expected: all tests pass; `Plugin validation passed …`; `Self-test passed …`, `Update self-test passed …`, `Checked 182 views … 0 issues.` (the example and stress scenarios, browser layout at 480–1920 px and canvas layout at 480, 560 and 640 px) and the simulated update times. This PR does not change `.github/plugin/marketplace.json`; if a rebase brought a change to it, also run `npm test && npm run validate` in every other plugin folder under `ghcp/plugins/`.

- [ ] **Step 2: Smoke-test on real data (local only)**

This reads the owner's Copilot data. Nothing from it is committed or sent anywhere: no screenshots, names or ids; only counts go to the coordinator. Use the preview server on 7927 when it is running (restart it first if UI files changed since it started); otherwise start the launcher on a spare port with `npm start -- --port 7932` in a second terminal and use that port below.

```bash
cd ghcp/plugins/swarm-dashboard
npm run check:layout -- --live http://127.0.0.1:7927/
ps -o rss= -p "$(lsof -nP -tiTCP:7927 -sTCP:LISTEN)"
```

Expected: `Live dashboard: a live swarm with N units, M finished runs` (or `a finished swarm` / `no swarm`), `Checked … views … 0 issues.`, then `Live updates (live): 3 updates; … ms median, … ms max; …` while a swarm is live (if none arrives within 25 s, the times are not measured: repeat while a swarm is working). The second command prints the server's resident memory in KB with the engine loaded (PR 1 measured 180–275 MB for one engine). Open the page in a browser and go through Cards, a detail panel, Timeline (12h and whole run), Plan, Board, History and a run summary at full width and at about 560 px. For anything wrong, rebuild the case with synthetic data in `server/demo-scenarios.mjs` (never copy real names or text), fix it with a test, and rerun `npm test` and `npm run check:layout`.

- [ ] **Step 3: Check the README's commands**

Run each command in the plugin README's table once: `npm start -- --demo` (open the page, then Ctrl+C), `npm run snapshot -- --list > /dev/null` (real data; the output is not kept), `npm test`, `npm run validate`, `npm run check:layout -- --width 560`. Each exits 0. If a command is not on the branch yet (PR 1's `snapshot`), say so in the handoff.

- [ ] **Step 4: Check that nothing private is committed**

```bash
BASE=origin/nicksologoub-microsoft-swarm-data-engine
git diff --stat "$BASE"...HEAD -- '*.png' '*.jpg' '*.log' '*.db' '*.jsonl'
git diff "$BASE"...HEAD -- ghcp README.md .github | grep -n -E '/Users/|/home/[a-z]|C:\\Users|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
```

Expected: both print nothing (the plan under `docs/` is left out because it quotes these patterns). Every name, id and text in fixtures and scenarios is synthetic.

- [ ] **Step 5: Hand off**

Push the branch under the coordinator's push rules (as the owner's account, with a token for the push command only; `--force-with-lease` is approved until the pull request opens). Send the coordinator: the commands above and their results; `npm run check:layout` on the example and stress scenarios at every width (its summary lines); the `--live` run against the real engine (counts, issues and update times only); the update time per render on the demo and on real data; the in-app screenshots from Task 17 (paths on this machine, not committed); the public-repo scan from Step 4; and the repository, branch and pushed SHA. Do not open a pull request until the coordinator says so.

## Final review fixes

The whole-branch review after Task 21 found no Critical issue. One fix wave followed, with a scoped re-review; the code then differs from the task code above in these places:

- Swarm choice (decision b): a swarm named in the address always applies; one picked in the picker or remembered from an earlier visit applies only while it is live (`staleChoice` in `ui/app.mjs`, used by `ui/main.mjs`). A page that asked for no swarm follows the default again once its swarm is no longer live while another is (`server/hub.mjs`); session pages keep their session's swarm. The picker also appears when the page shows a swarm that has ended while another is live, and the empty state then says "Swarm finished".
- Server: pages hear `hello` before anything else; a HEAD request for `/api/events` opens no connection; an engine dropped while a read ran is stopped again; tests assert `engine.stop()` on the idle drop, on close and in the canvas host.
- Canvas host: a canvas is counted before its server starts, so a close or `dispose()` during `open()` is not lost, and a server bound by the watchdog after the last close gets its grace timer.
- Sample data never mixes with real data: `/api/health` reports `demo`; the launcher reuses only a dashboard with the same data and otherwise exits 1 with a hint to use `--port`; a canvas refuses a sample-data dashboard on the port.
- Views: the sub-agent pill word is escaped (a test renders every view from hostile text); the header counts are a labelled group; unknown statuses sort last; clocks of a finished run stop at its end (`runEnd`, `unitEnd(session, snapshot)`); an empty report title reads "Untitled report"; the scroll position is restored only when it moved; a slow run summary cannot replace the one shown; `html { scrollbar-gutter: stable; }` keeps classic scrollbars from switching layouts; the history legend names failed units.
- Layout check: the live-update phase opens the page at 1440 × 600, reports re-created activity items, and names any check it could not measure (an error on the synthetic run); `DASHBOARD_FILES` includes the self-test pages.
- Docs: the only network requests are read-only `gh` and `az` queries; the port is 7927 by default; the stalled-child stuck rule; the port and sample-data messages; a demo beside your own dashboard needs `--port`.

## Follow-up after the hand-off

The coordinator's decisions after the hand-off, and the owner's requests after he looked at the preview, were carried out as Tasks 22 to 37, each with a review:

- Task 22: report, activity, question and timeline-mark text is shown as plain text (`plainText` in `ui/format.mjs`). Inline Markdown markers go and the words stay; snake_case, paths, globs, arithmetic, unpaired asterisks and code spans keep their characters, and numbered list markers stay because they carry order. A "Status: <status>." prefix that repeats the report's badge is removed (`withoutStatusPrefix`, `reportTitle`), and a finished sub-agent whose name equals its type is named once (`feedText`). The review round replaced a link pattern that backtracked exponentially on cut-off links.
- Task 23: on the Plan tab, the second line of a unit whose PR closed without merging reads "PR closed, not merged" in the blocked colour. Every `/api/` endpoint refuses requests that another website starts in the browser (`Sec-Fetch-Site` of `cross-site` or `same-site`, or a foreign `Origin`); requests without those headers, such as curl and the probes in Node, stay allowed. The page sets no `frame-ancestors`: it only reads, so there is nothing to clickjack, and a wrong value would break the canvas (comment in `server/http.mjs`).
- Task 24: `npm run check:layout -- --engine webkit` runs the same checks in Playwright's WebKit, the engine of the app's panel, with Playwright installed outside the repository (`PLAYWRIGHT_CORE`); without it the check says why and skips. The review round made each skip message name its cause.
- Task 25: at the bottom of the Cards tab, one muted line, "Archived and hidden sessions are on the Board tab.", replaces the list of archived units, and its "Board tab" link opens the Board. It shows only when the Cards tab leaves something out; the Board shows every unit in its stage column.
- Task 26: the note sits inside the card grid as its last item, so the grid's own gap separates it from the last row of cards, and its box mirrors a card's (`--card-pad` padding inside a transparent `--card-border` border), so its text starts where card text starts, at every width and in the side panel. The layout check's `gap` and `align` rules hold the note to both (`follows` in `scripts/lib/page-audit.mjs`).
- An independent review of the branch found four Medium issues, fixed as Tasks 27 to 30.
- Task 27: the live-update stream waits for 'drain' before it writes to a page again. While a page is behind, it keeps only the newest payload of each event, stamped with the server time when written, and sends that page no heartbeat. It drops a page that stays backed up for 30 s, because an update has been waiting for it all that time; the page reconnects by itself. It serves at most 32 pages; a further page gets 503 and retries. So a page never has more than one frame queued in the server (`server/hub.mjs`).
- Task 28: the port check (`probePort`) does not follow redirects. Only a direct 200 answer from the port it asked counts, so a server that redirects the question counts as another program.
- Task 29: unfinished sub-agent and tool-call times, and Timeline lanes, stop at the end of their session, or of the run once it has finished (`runningFor`, and the `end` argument of `laneSvg`).
- Task 30: History reloads in place, without the loading state, when a swarm starts, finishes or goes away, and after a reconnect. Reloads never overlap (`coalesced` in `ui/app.mjs`). `npm run check:layout` has a History phase that finishes a run and restarts the server, in Chrome and in WebKit.
- Task 31: the orchestrator's one-off sub-agents, which PR 1's contract lists as units of kind `subagent`, show like child sessions. They get a card while they run or are stuck, with Type ("Sub-agent · <type>") and Mode rows in place of Stage and Monitor. A "Sub-agents" Board column ends with "+N earlier sub-agents" for the finished ones the snapshot leaves out. Timeline lanes sit right under the orchestrator for those that overlap the window, with one keyed "+N sub-agents outside this window" row across the full width for the rest; the Timeline renders again every 15 s, so this list follows the window. The detail panel has a "Sub-agent" section, and the done state uses the merged mint with the word "done". The Plan leaves them out, because they have no todo or branch. The orchestrator's lane no longer draws bars for sub-agents that have their own lanes.
- Task 32: the stress scenario adds 25 sub-agent units, for 30 in all, 20 of them finished as the engine lists at most, and counts 41 more as omitted. The layout check has a sub-agent detail view.
- Task 33: these notes, and the README.
- Task 34: the owner asked that a finished sub-agent's card stay a while and then go. It now stays for `SUBAGENT_CARD_GRACE_MS` (10 minutes) after its end, showing how and when it ended, then fades out over `CARD_FADE_MS` while the other cards glide into place. A timer renders at the exact moment, and nothing moves for people who ask for reduced motion. A follow-up that makes it busy brings the card back, and the Board still lists every sub-agent. The stress scenario has two sub-agents in their grace period.
- Task 35: an open page used to keep its JavaScript across a server restart, so a tab left open through an update ran old code against new data. The server now sends a fingerprint of its UI files in `hello` and writes it into the page. A page whose fingerprint differs reloads once, keeping its tab, time window, swarm, History or run summary and open detail in the address. It remembers the attempt in sessionStorage, so it never loops, and it waits while hidden. UI files are served `no-store`. The layout check restarts the server with a new fingerprint to check this, including the no-loop case. A swarm picked in the picker travels through the reload in the tab's sessionStorage, and the reloaded page cleans its address back to the host, session and an addressed swarm. Two servers that alternate fingerprints on one port reload a tab once per swap; each swap needs a server restart, so this cannot loop.
- Task 36: at the owner's request, a card's border shows its kind: `--busy` blue for a one-off sub-agent, `--merged` green for a child session, with a 1 px inset line in the same colour, so the kind reads on tinted cards too, with nothing moved, on the Cards tab and the Board. Status keeps showing through the ring, the state line and the tint, and hover and selection still show over the kind colour. The layout audit's `kind-border` rule checks the colours, using `data-kind`.
- Task 37: in the demo, simulated spending on a sub-agent unit also counts toward the orchestrator's cost, as the contract says, and a test checks after every simulated step that the swarm total equals the orchestrator plus the session units. History also reloads once after the first live update when it has been asked for, which closes the race where a run finished between the first History answer and that update.
- The owner chose the WebKit run (Task 24) instead of the in-app check, so Task 17's step 8 does not run: no session extension is loaded and no screenshots of the panel are taken.
- Decision 4 stands: buttons look as the approved mockup renders them.
- Install layout, from read-only evidence on the build machine: `copilot plugin install` copies the whole plugin folder, and the CLI runs extensions in place, so the extension's `../../../server/` imports stay inside the installed plugin. The first install after merge confirms it.

## Self-review

Spec coverage, by the spec section that sets each requirement:

| Spec | Requirement | Task |
| --- | --- | --- |
| §7 | Header: run, duration, cost, counts; data warning; swarm picker | 4, 7, 10 |
| §7 | Needs you, with a stalled swarm first | 2, 4 |
| §7 | Cards: state line, stage track, progress, report badge, sub-agent chips, cost, archived row | 2, 3, 4, 10 |
| §7 | Activity feed (rail when wide, tab when narrow) | 5, 7 |
| §7 | Detail panel: why stuck, report, sub-agents, PR and monitor, recent activity | 5, 7 |
| §7 | Timeline: 12h and whole run, lanes, sub-agent ticks, cost chart | 12 |
| §7 | Plan graph and list; Board by stage | 2, 13 |
| §7 | History list and run summary, including "First child" | 14 |
| §7 | Side-panel layout below 900 px; canvas edge to edge | 6, 7, 10 |
| §8 | Tokens, type scale, weights, spacing, sizes, motion, reduced motion | 6 |
| §9 call 1 | One no-build server, SSE, standalone launcher, canvas extension, no timers before open, host theme variables | 6, 9, 10, 11, 17, 18 |
| §9 call 8 | 127.0.0.1 only, Host check, nothing sent elsewhere | 9, 18 |
| §9 call 9 | Automated overlap, token and contrast check at nine widths and in the side panel | 15, 16 |
| §9 call 12 | "Took" from the root's creation, busy time beside it, first child | 14 |
| §9 call 13 | Header counts: failed and blocked | 2, 4 |
| §9 call 14 | Synthetic fixtures only | 8, 16, 21 |
| Go-ahead 5 | PR closed without merging: PR open stage and column, badge, monitor ended | 2, 4, 5, 8, 13 |
| Go-ahead 6 | 4-character ring labels whole when they fit, else cut without a trailing separator; stress labels | 3, 6, 8, 10 |
| Go-ahead 7 | Snapshots never changed; in-place updates; update times on demo and real data | 2, 7, 9, 10, 12, 13, 16, 21 |
| §12 items 3, 5, 6, 7, 8, 9, 14, 16, 19 | Optional input; `$schema`; light palette; name and port; 3 s poll and 1 s redraw; test strategy; progress badge; server reuse and taken port; several live swarms | 17; 18; 6; decision 2; 9, 10; 15, 16; 3; 11, 17; 7, 10 |

Items 1, 2, 4, 10–13, 15, 17 and 18 of spec section 12 belong to PR 1's engine. No requirement is without a task.

Placeholder scan: no "TBD", "TODO", "fill in", "similar to Task N" or step without its code. Every code step shows the whole file or the exact lines to change.

Type consistency, checked across tasks: `createDashboardServer({ createEngine, host, port, version, now, log, hub, onIdle })` and its `listen`, `close`, `url`, `port`, `clientCount` (Tasks 9, 11, 16, 17); `createHub` options and `onIdle` (Tasks 9, 17); `listenShared` statuses `started`, `running`, `taken`, `unresponsive` and `probePort` states `ours`, `free`, `other`, `unresponsive` (Tasks 11, 17); `createDefaultEngine` (Tasks 8, 11, 17, 20); `unitEnd` (Tasks 2, 4, 5, 12, 20); `auditScript` and `AUDIT_DEFAULTS` (Tasks 15, 16); `buildStates` targets and `describeTimes` (Task 16); `validateDashboard` (Task 18); `closedNotMerged` (Tasks 2, 4, 5, 13); `closedBadge`, `shortLabel` and `phase` (Tasks 3, 10, 12); `morph` and the `data-key`, `data-drawn` and `data-phase` attributes (Tasks 3, 4, 7, 10, 12, 16); `deepFreeze` and `closedSnapshot` (Tasks 2, 4, 5, 7, 9, 12, 13).

Known limits, also reported to the coordinator:
- The layout check runs in Chrome by default; the app's panel is WebKit. Its WebKit mode (Task 24), which the owner chose instead of Task 17's in-app check, covers the difference, with Playwright installed outside the repository.
- Browsers allow about six open connections per site, and every dashboard page holds one. Pages free theirs when unloaded or kept in the back-forward cache, but more than about six open dashboard pages at once make later ones wait (plugin README, Troubleshooting).
- The extension imports `../../../server/`, which assumes the CLI runs plugin extensions from the installed plugin folder (its changelog and runtime messages point that way). The first install from the marketplace confirms it.
- After an update, a session that still runs the old extension can keep hosting the old server until it ends; a canvas that finds another version on the port logs a warning.

Execution: superpowers:subagent-driven-development, one fresh sub-agent per task and a review between tasks, in the Execution order above. The early preview is the last step of Task 20: the launcher, detached, on `http://127.0.0.1:7927/` with real data.
