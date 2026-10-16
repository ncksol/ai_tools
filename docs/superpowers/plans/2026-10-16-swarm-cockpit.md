# Swarm Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the swarm cockpit to the swarm-dashboard plugin: a second, dark look at the same live swarm, opened in its own browser window, with a live black hole seen through a curved window and the swarm's facts on curved glass panels.

**Architecture:** New files in `ghcp/plugins/swarm-dashboard/ui/` (a page shell, a stylesheet and ES modules), served by the existing local server from the existing live snapshot feed. Pure modules hold the data, the panel HTML, the 3D placement maths, the panel arrangement and the frame pacing, and are tested in Node. A WebGL2 renderer draws the black hole, bloom and room in three passes; the panels are ordinary page elements placed with CSS 3D transforms that share the shader's camera and 60-degree field of view. Small, separate hooks in PR 2's code add the `/cockpit` route, the Cockpit control in the regular view's header, the regular view's answer to the cockpit's clicks, and the cockpit section of the layout check.

**Tech Stack:** Browser ES modules, WebGL2 and GLSL ES 3.00, CSS 3D transforms, Server-Sent Events, `node:test`. No npm dependencies and no build step. Headless Chrome through the DevTools protocol (`scripts/lib/cdp.mjs`) and, optionally, Playwright's WebKit installed outside the repository.

**Spec:** `docs/superpowers/specs/2026-10-16-swarm-cockpit-design.md`. The dashboard design `docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md` still applies in full. Executors read the cockpit design's sections 4 to 9 before starting.

## Global Constraints

- All paths below are relative to `ghcp/plugins/swarm-dashboard/` unless they start with `docs/` or `.github/`. A code block's first line `// <path>` names the file it belongs to and is not part of the file.
- The cockpit is a second page of the same plugin, server and data (design call 1). It reads only `/api/events`; it adds no endpoint, no data source and no write. It is watch-only: no action or command input (design section 3).
- The server's rules stay as they are: loopback only, Host check, GET and HEAD only, `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'`. No inline scripts, no `<style>` blocks, no inline event handlers. The server serves only `.html`, `.css` and `.mjs` files from the top of `ui/`, so every cockpit file lives directly in `ui/` with a `cockpit` prefix, and GLSL lives in `.mjs` modules as strings.
- No runtime npm dependencies, no 3D library, no build step. UI modules import only relative modules (`tests/packaging.test.mjs`). Scripts import only `node:` built-ins and relative modules (`tests/guards.test.mjs`); Playwright is loaded only through `findPlaywright()`.
- No API newer than Node 18 in shipped code (no `toSorted`, `Object.groupBy`, `Promise.withResolvers` and the others listed in `tests/packaging.test.mjs`).
- Do not edit `engine/`. Do not change the snapshot or engine API. Changes to PR 2's files (`server/`, existing `ui/` files, `scripts/check-layout.mjs`, `README.md`) are limited to the hooks listed in Tasks 1, 12 and 13, each in its own commit.
- The owner's rules: nothing overlaps, padding is even, no bold or italic, calm motion, no glow on text (design 6.5 and section 4).
- Type (design call 6): weights 400 and 500 only; no italic, no uppercase transform, no letter-spacing; sentence-case labels. Sizes 12, 14 and 18 px with line heights 16, 20 and 24 px; the only exception is the clock's hours and minutes at 36/40 px (builder decision B2). Monospace only for numbers, labels, times and the clock (class `ck-mono`).
- Spacing on the 4 px grid. Every text keeps a contrast of at least 4.5:1 against its glass over the brightest scene pixel behind it (design call 6).
- Status colours are the approved pastel fills of the regular view, glowing softly on dark glass; idle and archived are dimmed (builder decision B3).
- Quality (design call 5 and decision 9): High is the default; Balanced draws the black hole every second frame and every frame while the pointer moved in the last 1.2 s; the choice is remembered per browser under `localStorage['swarm-dashboard:cockpit']`. A 30 fps cap. The adaptive fallback lowers the black hole's resolution in steps of 0.1 down to 0.5 when the frame rate stays under 90% of the cap. No rendering while the window is hidden; one still frame under "reduce motion".
- The cockpit never runs in the app's side panel (design section 3). In the side panel the Cockpit control shows the cockpit's address with a Copy button instead of opening a window.
- The repository is public: fixtures, screenshots and all committed text are synthetic. Real-data checks stay local and report only counts.
- Nothing from the spike is committed as it is (design call 8). The spike (outside the repository) is a reference that tasks adapt; it is never copied into the repository.
- After any change under the plugin folder run `npm test && npm run validate` from `ghcp/plugins/swarm-dashboard`. After any change under `ui/` also run `npm run check:layout`; every view and every cockpit state must report 0 issues.
- Conventional commit messages, scope `swarm-dashboard`; no `Co-authored-by` trailer or other AI attribution.

## Decisions settled before implementation

Evidence gathered on this machine on 16 October 2026 (Apple M5 Pro, macOS, Chrome 155.0.8059.84, Playwright 1.64.0 with WebKit 27.2). The probes ran against the approved spike, read-only, and were not committed.

### D1. Serving the cockpit under the server's content policy

- `server/assets.mjs` serves every `.html`, `.css` and `.mjs` file at the top of `ui/` under `/ui/<name>`, and `tests/server.test.mjs` requires every asset path to match `/^\/(index\.html|ui\/[\w.-]+\.(css|mjs|html))$/`. So the cockpit's files are `ui/cockpit.html`, `ui/cockpit.css` and `ui/cockpit*.mjs`, served with no change to `assets.mjs`.
- The page's own address `/cockpit` needs one route: `server/http.mjs` maps `/cockpit` to the `/ui/cockpit.html` asset, the way it maps `/` to `/index.html` (Task 1). `/ui/cockpit.html` stays reachable too; it is the same page.
- The shell loads `/ui/cockpit.css` and one module, `/ui/cockpit.mjs`, like `ui/index.html`. Shaders are template strings in `ui/cockpit-shaders.mjs`. The scene is procedural, so the page loads no image, font or worker. Inline `style` attributes and CSSOM writes (`element.style.transform`) are allowed by `style-src 'unsafe-inline'`.
- Probe: the spike, served by a throwaway Node server that sent the dashboard's exact `Content-Security-Policy` header, created its WebGL2 renderer, compiled all five programs and rendered in headless Chrome with no console error and no CSP violation at 13 window sizes.

### D2. WebGL2 in headless browsers, and how the shader is tested

| Engine (headless) | WebGL2 | Renderer | Float render targets | Timer queries | Spike frame, 1440 × 900 @2x | Spike frame, 1920 × 1080 @2x |
| --- | --- | --- | --- | --- | --- | --- |
| Chrome 155 (`--headless=new`, through `scripts/lib/cdp.mjs`) | yes | ANGLE Metal, Apple M5 Pro (the real GPU) | yes | yes (`EXT_disjoint_timer_query_webgl2`) | 7.5 ms median (black hole 6.5, bloom 0.6, final 0.7) | 10.9 ms median |
| WebKit 27.2 (Playwright 1.64.0, cached build 2370) | yes | Apple GPU | yes | no; `performance.now()` has 1 ms steps | 7 ms median | 10 ms median |

Both reproduce the design's measurements (7.9 and 11.8 ms). Decisions:

- `npm test` stays browser-free, as today. Pure modules are tested in Node: the data, the panel HTML, the 3D maths, the arrangement, the frame pacing and the frame analysis (on synthetic frames).
- The shader is tested in the browser by `scripts/check-cockpit.mjs` (Task 8), which `npm run check:layout` also runs (Task 13): every program must compile and link, and a still frame (fixed time, camera at rest) must show the scene's structure, measured by `analyseFrame()`: a black shadow bounded by bright light along the centre column, a peach ceiling line near the top, stars in the upper left, a dark desk at the bottom and a mean brightness in range. The probe compares structure, not pixels, so it holds across GPUs.
- Faithfulness to the approved look is checked once, locally, in Task 8: a still frame of the ported scene and of the spike at the same size, time and camera must differ by less than 0.5/255 on average. While writing this plan the port below matched the spike pixel for pixel in Chrome. That comparison is not committed, because the spike is not in the repository.
- When WebGL2 is missing, the page keeps its panels over a dark CSS backdrop (`html[data-gl="off"]`), and the check covers that state with `?gl=0`.

### D3. The Cockpit control in the app's side panel

- The app shows a canvas as an iframe with no bridge to the host and no host chrome (the app's canvas authoring guide), and the dashboard design records that in the canvas "downloads, print and new windows do not work". The swarm-dashboard plugin is not installed in the app on this machine, so the canvas could not be observed without changing the app's setup.
- So in the canvas (`html[data-host="canvas"]`) the control never calls `window.open`. It shows a row under the top bar with the cockpit's full address (`http://127.0.0.1:<port>/cockpit?swarm=<resolved swarm id>`) and a Copy button. Copy tries `navigator.clipboard.writeText`, then `document.execCommand('copy')` on the selected address, and otherwise leaves the address selected and says "Select the address and copy it".
- The control passes the swarm the page resolved (`snapshot.run.id`), not the canvas address's `session=` (design 9.5).
- In a browser the control opens or focuses a window named `swarm-cockpit` with `popup=yes` and the screen's available size, and names its own window `swarm-dashboard`. If the browser blocks the window, it shows the same address row.
- The check (Task 12) verifies both: in Chrome a click opens a second page at `/cockpit?swarm=…`; with `host=canvas` a click opens nothing and shows the address row.

### D4. The local GPU frame-time test

- `scripts/cockpit-gpu.mjs` (Task 14) is a dev-only command, not part of `npm test`. It serves the synthetic example swarm on a free loopback port, opens `/cockpit?debug=1` in headless Chrome (default) or WebKit (`--engine webkit`), and measures 1440 × 900 and 1920 × 1080 at device pixel ratio 2.
- Each measured frame is forced to finish with a one-pixel `readPixels`, as in the spike's measurement; per-pass times come from the same method on each pass's target. High is measured with the black hole redrawn every frame; Balanced with it redrawn every second frame. It prints the medians, the 90th percentile and the share of a 30 fps frame budget the GPU is busy.
- It fails when WebGL2 is missing, when the renderer is a software one (SwiftShader, llvmpipe or "Software"), or when High's median at 1440 × 900 exceeds 33.3 ms, the 30 fps budget. It reports, and does not judge, heat.

### Builder decisions on the design's open points (section 9)

These change what the owner sees. The coordinator confirmed B1 to B9 on 16 October 2026, with one change to B8: the top line drops "Watch-only", as the regular view's header now does.

- B1. Tiles (design call 3 and 9.1). One tile per child session (all states, including merged and archived) plus a tile per sub-agent unit that is running or stuck, ordered attention first as on Cards. The example swarm already needs 9 tiles and the spike's console holds 8, so tile density follows the count: up to 8 tiles, three-line tiles in 2 rows (as in the spike); 9 to 12, two-line tiles (label and age, then state) in 3 rows; 13 to 16, one-line tiles (label and age) in 4 rows; more than 16, 15 tiles and a last "+N more" tile that opens the Board. The console's height does not change. The footer, which in the spike said "select a session to mark it", gives the counts: "7 child sessions · 2 sub-agents running · 3 finished".
- B2. The clock's hours and minutes stay at 36/40 px, as in the approved spike; its seconds and everything else use 12, 14 and 18 px.
- B3. Status colours on dark glass: the approved pastel fills as text and dot colours, with idle at `oklch(0.80 0.012 250)` and archived at `oklch(0.70 0.008 250)`. The check proves 4.5:1 for every text.
- B4. The status panel shows the regular header's six count buckets (Working, Stuck, Waiting, Idle, Done, Failed) from `snapshot.counts`, instead of the spike's eight raw states, so both views show the same numbers. Tile state words are the Board's short words (Busy, Idle, Plan waiting, Question, Stuck, Blocked, Merged, Done, Archived).
- B5. Times use the regular view's formats: the run timer as "2d 23h 12m 06s", ages as "48m", the next monitor check as a countdown such as "4m".
- B6. Clicks (design call 4 and 9.11). A tile, a "needs you" item, an activity row or a PR row opens that unit's details in the regular window; Cost opens the Timeline tab, Status and "+N more" the Board, the clock and the empty states the Cards tab. The regular window is found by its name and gets the request as a same-origin message, so it does not reload. If it is gone, the cockpit opens a new regular window on that address.
- B7. Minimum window (9.2): 1100 × 800 CSS px, and wide enough for the arrangement: about 1.3 times as wide as tall (1200 × 900 fits; 1100 × 1000 does not, and the spike's own fit failed at 1100 × 900). Every panel keeps 8 design px from the window's side edges at every camera pose, so the camera's drift and parallax (about 50 px at the pointer's corner, more for panels turned far out) never push it off the screen; at rest that puts the panels a little further in than the spike's 40 and 48 px. The gaps between panels are found by bisection, so they are exact and the same on both sides, and a window that fits keeps fitting as it grows (checked over 8,651 sizes). Below that the black hole still renders and a centred note says "Make this window larger to see the cockpit." with a button to open the regular view.
- B8. Quality control (9.4): a small "High · Balanced" switch in the top right corner. The top left line reads "Swarm cockpit", plus "Sample data" with the demo, "Swarm finished" for a finished run and "Disconnected · retrying" when the connection drops. No "Watch-only" label (the owner had it removed from the regular view: "that is not required") and no frame-rate line.
- B9. Panel heights are fixed in CSS (the spike sized its upper panels by content), so the arrangement is pure maths and testable in Node.
- B10. Port, not rewrite (9.7): the shader passes and the arrangement follow the spike's maths with the same constants, restructured into ES modules with named constants. The look must match the spike (D2).
- B11. WebKit specifics (9.8): float render targets work in WebKit 27.2; the renderer still falls back to 8-bit targets without `EXT_color_buffer_float`. Text on 3D panels was crisp in both engines at 1920 × 1080 @2x and 2560 × 1440 @1x (stage scaled up to 1.6), and Chrome and WebKit project the panels to the same pixel rectangles, so no text workaround is planned.

## File structure

New files:

| File | Responsibility |
| --- | --- |
| `ui/cockpit.html` | Page shell: canvas, top line, quality switch, stage with seven panel sections, note. No inline script. |
| `ui/cockpit.css` | Dark-glass tokens, panel chrome and sizes, tiles, rows, motion, the flat audit mode and the no-WebGL backdrop. |
| `ui/cockpit-model.mjs` | Pure data for the panels from a snapshot: tiles, counts, legend, needs, activity, PRs, cost rate, clock and next check. |
| `ui/cockpit-panels.mjs` | Pure HTML for each panel, the top line, the quality switch and the note. |
| `ui/cockpit-space.mjs` | Pure 3D maths shared by CSS and the shader: design space, focal length, matrices, panel and world transforms, projection, camera drift and parallax. |
| `ui/cockpit-fit.mjs` | Pure panel arrangement for a window size, the panel sizes, the minimum window and the overlap rules. |
| `ui/cockpit-quality.mjs` | Pure frame pacing: quality setting and storage, the 30 fps cap, Balanced's black-hole cadence, the adaptive resolution. |
| `ui/cockpit-link.mjs` | The two windows' link: addresses, window names, the Cockpit control's HTML and behaviour, the cockpit's requests and the regular view's answer. |
| `ui/cockpit-shaders.mjs` | GLSL sources and the scene constants. |
| `ui/cockpit-gl.mjs` | The WebGL2 renderer: programs, HDR targets, passes, resize, frame read-back and timing. |
| `ui/cockpit.mjs` | The page: live connection, rendering the panels, arrangement, camera, render loop, quality, clicks, debug hooks. |
| `scripts/lib/cockpit-scene.mjs` | Frame analysis for the shader probe (runs in Node tests and in the page). |
| `scripts/lib/cockpit-check.mjs` | The cockpit's browser checks: scene, arrangement, flat layout audit with scene backdrops, links, regular-view slowdown. |
| `scripts/check-cockpit.mjs` | Command that runs the cockpit checks alone. |
| `scripts/cockpit-gpu.mjs` | Dev-only GPU frame-time test. |
| `tests/cockpit-*.test.mjs` | Node tests, one file per module above. |

Hooks in PR 2's files, each in its own commit:

| File | Hook | Task |
| --- | --- | --- |
| `server/http.mjs` | `/cockpit` serves the `/ui/cockpit.html` asset (3 lines). | 1 |
| `ui/app.mjs` | The top bar renders the Cockpit control and its address row (2 lines). | 12 |
| `ui/main.mjs` | `view.host` and `view.cockpitNote`; the click branches for the control and Copy; the message listener that opens a unit or tab in place (about 25 lines). | 12 |
| `ui/styles.css` | Three rules for the address row. | 12 |
| `scripts/check-layout.mjs` | Runs the cockpit checks after the dashboard's and counts their issues (about 8 lines). | 13 |
| `README.md`, `.github/copilot-instructions.md` | The cockpit's section and the plugin description. | 15 |

---

### Task 1: Page shell and the `/cockpit` route

**Files:**
- Create: `ui/cockpit.html`
- Create: `tests/cockpit-shell.test.mjs`
- Create: `tests/helpers/cockpit.mjs` (values shared by the cockpit's tests; a helper, so importing it runs no tests)
- Modify: `server/http.mjs` (the asset lookup at the end of `route()`)
- Create: `tests/cockpit-server.test.mjs`

**Interfaces:**
- Produces: the panel section ids `ck-clock`, `ck-cost`, `ck-needs`, `ck-status`, `ck-activity`, `ck-units`, `ck-prs`; containers `ck-hud`, `ck-qual`, `ck-stage`, `ck-world`, `ck-note`; canvas `ck-gl`; root `<main class="ck" id="ck">`. Each panel section carries `data-tab`, the regular-view tab its background opens (B6). The page answers at `/cockpit`.

- [ ] **Step 1: Write the failing shell test**

```js
// tests/cockpit-shell.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PANEL_TABS } from './helpers/cockpit.mjs';

const html = readFileSync(new URL('../ui/cockpit.html', import.meta.url), 'utf8');

test('the cockpit shell loads only its own stylesheet and one module, with nothing inline', () => {
  assert.match(html, /<link rel="stylesheet" href="\/ui\/cockpit\.css">/);
  assert.match(html, /<script type="module" src="\/ui\/cockpit\.mjs"><\/script>/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.doesNotMatch(html, /<style\b|\son[a-z]+=|https?:\/\//);
  assert.match(html, /<title>Swarm cockpit<\/title>/);
});

test('the shell has the canvas, the top line, the quality switch, the note and every panel with its tab', () => {
  assert.match(html, /<canvas id="ck-gl" aria-hidden="true"><\/canvas>/);
  assert.match(html, /<main class="ck" id="ck">/);
  for (const id of ['ck-hud', 'ck-qual', 'ck-stage', 'ck-world', 'ck-note']) assert.match(html, new RegExp(`id="${id}"`));
  for (const [id, tab] of Object.entries(PANEL_TABS)) assert.match(html, new RegExp(`<section class="ck-panel [a-z-]+" id="${id}" data-tab="${tab}" aria-label="[A-Z][^"]+"></section>`));
});
```

and the shared values:

```js
// tests/helpers/cockpit.mjs
/** Values shared by the cockpit's tests. A helper, not a test file, so importing it runs no tests. */
export const PANEL_TABS = Object.freeze({ 'ck-clock': 'cards', 'ck-cost': 'timeline', 'ck-needs': 'cards', 'ck-status': 'board', 'ck-activity': 'cards', 'ck-units': 'cards', 'ck-prs': 'board' });
/** Common window sizes the arrangement and the browser check are tested at. */
export const COCKPIT_SIZES = Object.freeze([[1100, 800], [1280, 800], [1440, 900], [1512, 900], [1680, 1050], [1920, 1080], [2560, 1440]]);
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/cockpit-shell.test.mjs`
Expected: FAIL with `ENOENT` for `ui/cockpit.html`.

- [ ] **Step 3: Write the shell**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swarm cockpit</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/ui/cockpit.css">
<script type="module" src="/ui/cockpit.mjs"></script>
</head>
<body>
<canvas id="ck-gl" aria-hidden="true"></canvas>
<main class="ck" id="ck">
<div class="ck-hud" id="ck-hud"></div>
<div class="ck-qual" id="ck-qual" role="group" aria-label="Quality"></div>
<div class="ck-stage" id="ck-stage"><div class="ck-world" id="ck-world">
<section class="ck-panel ck-upper" id="ck-clock" data-tab="cards" aria-label="Clock and run timer"></section>
<section class="ck-panel ck-upper" id="ck-cost" data-tab="timeline" aria-label="Cost"></section>
<section class="ck-panel ck-upper" id="ck-needs" data-tab="cards" aria-label="Needs you"></section>
<section class="ck-panel ck-upper" id="ck-status" data-tab="board" aria-label="Status"></section>
<section class="ck-panel ck-console" id="ck-activity" data-tab="cards" aria-label="Activity"></section>
<section class="ck-panel ck-console" id="ck-units" data-tab="cards" aria-label="Mission control"></section>
<section class="ck-panel ck-console" id="ck-prs" data-tab="board" aria-label="Pull requests"></section>
</div></div>
<div class="ck-note" id="ck-note" hidden></div>
</main>
</body>
</html>
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `node --test tests/cockpit-shell.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit the shell**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit.html ghcp/plugins/swarm-dashboard/tests/cockpit-shell.test.mjs ghcp/plugins/swarm-dashboard/tests/helpers/cockpit.mjs
git commit -m "feat(swarm-dashboard): add the cockpit page shell"
```

- [ ] **Step 6: Write the failing route test**

```js
// tests/cockpit-server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardServer } from '../server/http.mjs';
import { get } from './helpers/http.mjs';

test('the server serves the cockpit at /cockpit with the same headers, and creates no engine for it', async () => {
  let created = 0;
  const server = createDashboardServer({ createEngine: () => { created += 1; throw new Error('no engine'); }, version: 'test' });
  await server.listen();
  try {
    const page = await get(server.port, '/cockpit?swarm=ws-0000-root');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(page.body, /<title>Swarm cockpit<\/title>/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(server.port, '/cockpit/')).status, 404);
    assert.equal((await get(server.port, '/cockpit/x')).status, 404);
    assert.equal((await get(server.port, '/__proto__')).status, 404);
    assert.equal((await get(server.port, '/cockpit', { Host: 'evil.example' })).status, 403);
    assert.equal(created, 0);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `node --test tests/cockpit-server.test.mjs`
Expected: FAIL: `404 !== 200` for `/cockpit`.

- [ ] **Step 8: Add the route (the hook)**

In `server/http.mjs`, under `const TEXT = …`, add:

```js
/** Pages with their own address, and the asset each one serves. */
const PAGES = new Map([['/', '/index.html'], ['/cockpit', '/ui/cockpit.html']]);
```

and replace the asset lookup in `route()`:

```js
    const asset = assets.get(PAGES.get(path) ?? path);
```

- [ ] **Step 9: Run the route test and the server tests**

Run: `node --test tests/cockpit-server.test.mjs tests/server.test.mjs`
Expected: PASS.

- [ ] **Step 10: Commit the hook**

```bash
git add ghcp/plugins/swarm-dashboard/server/http.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-server.test.mjs
git commit -m "feat(swarm-dashboard): serve the cockpit page at /cockpit"
```

---

### Task 2: Cockpit data

**Files:**
- Create: `ui/cockpit-model.mjs`
- Create: `tests/cockpit-model.test.mjs`

**Interfaces:**
- Consumes: `ui/model.mjs` (`STATUS_ORDER`, `COUNT_TILES`, `BOARD_WORDS`, `NEED_LABELS`, `NEED_CLASS`, `needItems`, `feedText`, `findUnit`, `isSubagent`, `omittedSubagents`, `runEnd`, `stateLine`) and `ui/format.mjs` (`HOUR`, `MIN`, `plainText`).
- Produces (all pure, no DOM):
  - `ACTIVITY_ROWS = 9`, `NEED_ROWS = 2`, `PR_ROWS = 4`, `MODEL_ROWS = 4`, `DENSITIES = [{ name: 'full', max: 8 }, { name: 'two', max: 12 }, { name: 'one', max: 16 }]`, `BUCKET_WORDS`.
  - `stateWord(session) → string`, `tileWord(status) → string`.
  - `tileGrid(snapshot) → { density: 'full'|'two'|'one', tiles: Tile[], more: number }`, where `Tile = { id, label, name, status, word, since, attention: boolean, subagent: boolean }`.
  - `unitCounts(snapshot) → { sessions, running, finished }`.
  - `legend(snapshot) → { rows: { bucket, state, word, count }[], live, ended }`.
  - `needRows(snapshot) → { total, rows: { id, kind, state, word, who, text, since, unitId|null }[] }`; `who` is the units' labels, or the orchestrator's label for a need without units (a stalled swarm, a question to the whole swarm).
  - `activityRows(snapshot) → { id, at, label, text, status|null, unitId|null }[]`, oldest first, newest last.
  - `prRows(snapshot) → { rows: { id, unitId, title, who, state, word }[], opened, merged }`.
  - `hourlyRate(series) → number|null`; `costView(snapshot, now = snapshot.generatedAt) → { credits, perHour|null, models: { model, credits, share }[] }`. The rate covers the hour up to `now`: the engine adds a series point only when credits are spent, so the series is carried on flat to `now` first, and a swarm that has stopped spending shows a falling rate, then 0.
  - `clockText(ms) → { hm, s }`, `dateText(ms) → string`, `timeText(ms) → 'HH:MM'`, `nextCheckAt(snapshot) → number|null`, `runLine(snapshot) → string`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DENSITIES, activityRows, clockText, costView, dateText, hourlyRate, legend, needRows, nextCheckAt, prRows, runLine, stateWord, tileGrid, tileWord, timeText, unitCounts,
} from '../ui/cockpit-model.mjs';
import { NOW, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const example = () => deepFreeze(exampleSnapshot());

test('a state word is the regular state line without its time', () => {
  const s = example();
  assert.equal(stateWord(s.orchestrator), 'Waiting on question');
  assert.equal(stateWord(s.units.find(unit => unit.label === 'I1')), 'Stuck · no events');
  assert.equal(stateWord({ status: 'busy', statusDetail: 'busy' }), 'Busy');
  assert.equal(stateWord({ status: 'idle', statusDetail: 'unknown-detail' }), 'Idle');
  assert.deepEqual(['busy', 'plan', 'question', 'merged', 'archived'].map(tileWord), ['Busy', 'Plan waiting', 'Question', 'Merged', 'Archived']);
});

test('tiles are every child session and the running or stuck sub-agents, attention first', () => {
  const grid = tileGrid(example());
  assert.equal(grid.density, 'two');
  assert.equal(grid.more, 0);
  assert.deepEqual(grid.tiles.map(tile => tile.label), ['I1', 'table-research', 'B2', 'F1', 'B1', 'map-import-module', 'D5', 'F2a', 'B0']);
  const stuck = grid.tiles[1];
  assert.deepEqual({ status: stuck.status, word: stuck.word, attention: stuck.attention, subagent: stuck.subagent }, { status: 'stuck', word: 'Stuck', attention: true, subagent: true });
  assert.equal(grid.tiles.find(tile => tile.label === 'B1').attention, false);
});

test('tile density follows the count, and past 16 the last slot counts the rest', () => {
  const s = exampleSnapshot();
  const template = s.units.find(unit => unit.label === 'B1');
  const withSessions = n => ({ ...s, units: Array.from({ length: n }, (_, i) => ({ ...template, id: `u${i}`, label: `U${i}` })) });
  assert.deepEqual(DENSITIES.map(entry => entry.max), [8, 12, 16]);
  assert.equal(tileGrid(withSessions(8)).density, 'full');
  assert.equal(tileGrid(withSessions(12)).density, 'two');
  assert.equal(tileGrid(withSessions(16)).density, 'one');
  const crowded = tileGrid(withSessions(28));
  assert.deepEqual({ density: crowded.density, shown: crowded.tiles.length, more: crowded.more }, { density: 'one', shown: 15, more: 13 });
});

test('the footer counts child sessions, running sub-agents and finished ones, including those the snapshot leaves out', () => {
  assert.deepEqual(unitCounts(example()), { sessions: 7, running: 2, finished: 3 });
  const s = exampleSnapshot();
  s.omittedSubagents = { done: 4, failed: 1 };
  assert.equal(unitCounts(s).finished, 8);
});

test('the legend is the regular header\'s six buckets', () => {
  const view = legend(example());
  assert.deepEqual(view.rows.map(row => [row.word, row.state, row.count]), [['Working', 'busy', 2], ['Stuck', 'stuck', 2], ['Waiting', 'plan', 2], ['Idle', 'idle', 1], ['Done', 'merged', 3], ['Failed', 'blocked', 2]]);
  assert.deepEqual({ live: view.live, ended: view.ended }, { live: 7, ended: 5 });
});

test('needs keep the regular order, name their units by label and point at a unit when there is one', () => {
  const view = needRows(example());
  assert.equal(view.total, 2);
  assert.deepEqual(view.rows.map(row => [row.who, row.word, row.state, row.unitId]), [['B2', 'Plan to approve', 'plan', 'ws-0004-b2'], ['D5', 'PR to approve', 'pr', 'ws-0007-d5']]);
  const s = exampleSnapshot();
  s.run.stalled = { since: NOW - 600000, reason: 'No unit **moved** for 30 minutes' };
  const stalled = needRows(s);
  assert.equal(stalled.total, 3);
  assert.deepEqual([stalled.rows[0].who, stalled.rows[0].word, stalled.rows[0].text, stalled.rows[0].unitId], ['SB', 'Swarm stalled', 'No unit moved for 30 minutes', null]);
});

test('activity shows the nine latest items with the newest last, coloured by their unit', () => {
  const rows = activityRows(example());
  assert.equal(rows.length, 9);
  assert.equal(rows[8].label, 'map-import-module');
  assert.equal(rows[8].text, 'started explore');
  assert.ok(rows.every((row, i) => !i || rows[i - 1].at <= row.at));
  const sb = rows.find(row => row.label === 'SB');
  assert.deepEqual([sb.status, sb.unitId], ['question', null]);
  assert.equal(rows.find(row => row.label === 'B1').unitId, 'ws-0003-b1');
});

test('PRs list open ones first, then merged, with the regular words', () => {
  const view = prRows(example());
  assert.deepEqual(view.rows.map(row => [row.id, row.word, row.state]), [[418, 'In review', 'busy'], [421, 'Draft', 'idle'], [412, 'Merged', 'merged'], [409, 'Merged', 'merged']]);
  assert.deepEqual({ opened: view.opened, merged: view.merged }, { opened: 4, merged: 2 });
  assert.deepEqual([view.rows[0].title, view.rows[0].who, view.rows[0].unitId], ['Orders and invoices API', 'B1 API', 'ws-0003-b1']);
});

test('the hourly rate interpolates the cost series over the last hour', () => {
  const series = [{ at: 0, credits: 0 }, { at: 2 * 3600000, credits: 200 }, { at: 3 * 3600000, credits: 500 }];
  assert.equal(hourlyRate(series), 300);
  assert.equal(hourlyRate([{ at: 0, credits: 10 }, { at: 1800000, credits: 60 }]), 100);
  assert.equal(hourlyRate([{ at: 0, credits: 10 }, { at: 300000, credits: 60 }]), null);
  assert.equal(hourlyRate([]), null);
  const view = costView(example());
  assert.equal(Math.round(view.perHour), 2208, 'the hour up to the snapshot, 5 minutes after the last spend');
  assert.equal(costView(example(), NOW + 3 * 3600000).perHour, 0, 'nothing spent in the last hour');
  assert.equal(Math.round(costView(example(), NOW + 30 * 60000).perHour), Math.round(hourlyRate([...exampleSnapshot().cost.series, { at: NOW + 30 * 60000, credits: 97652.4 }])));
  assert.deepEqual(view.models.map(entry => [entry.model, Number(entry.share.toFixed(3))]), [['claude-sonnet-5', 1], ['claude-opus-4.8', 0.605], ['claude-haiku-5.5', 0.141], ['gpt-5.4-mini', 0.128]]);
  const ended = exampleSnapshot();
  ended.run.lifecycle = 'finished';
  ended.run.finishedAt = NOW;
  assert.equal(costView(ended).perHour, null);
});

test('clock, date, times, the next monitor check and the run line', () => {
  const at = new Date(2026, 9, 16, 9, 6, 2).getTime();
  assert.deepEqual(clockText(at), { hm: '09:06', s: '02' });
  assert.equal(dateText(at), 'Fri 16 October');
  assert.equal(timeText(at), '09:06');
  assert.equal(nextCheckAt(example()), NOW + 60000);
  assert.equal(runLine(example()), 'Sample story B · sample-project');
});
```

The PR order rule: open and draft rows by `openedAt`, newest first, then merged and closed rows by `mergedAt ?? closedAt`, newest first. In the fixture that is #418 (open, in review), #421 (draft), #412 and #409 (merged).

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-model.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-model.mjs'`.

- [ ] **Step 3: Write the module**

```js
// ui/cockpit-model.mjs
/** Data for the cockpit's panels: no HTML and no DOM. Words, orders and counts follow the regular view (model.mjs). */
import { HOUR, MIN, plainText } from './format.mjs';
import { BOARD_WORDS, COUNT_TILES, NEED_CLASS, NEED_LABELS, STATUS_ORDER, feedText, findUnit, isSubagent, needItems, omittedSubagents, runEnd, stateLine } from './model.mjs';

export const ACTIVITY_ROWS = 9;
export const NEED_ROWS = 2;
export const PR_ROWS = 4;
export const MODEL_ROWS = 4;
/** Tile density by count: three-line tiles in 2 rows, two-line in 3, one-line in 4; past 16 the last slot counts the rest. */
export const DENSITIES = Object.freeze([{ name: 'full', max: 8 }, { name: 'two', max: 12 }, { name: 'one', max: 16 }]);
export const BUCKET_WORDS = Object.freeze({ working: 'Working', stuck: 'Stuck', waiting: 'Waiting', idle: 'Idle', done: 'Done', failed: 'Failed' });
const ATTENTION = new Set(['stuck', 'question', 'plan', 'blocked']);
const STATUS_WORDS = { busy: 'Busy', idle: 'Idle', plan: 'Waiting on plan', question: 'Waiting on question', stuck: 'Stuck', blocked: 'Blocked', merged: 'Merged', done: 'Done', archived: 'Archived' };
const PR_STATES = { merged: ['merged', 'Merged'], closed: ['blocked', 'Closed'], draft: ['idle', 'Draft'], unknown: ['idle', 'Not known yet'] };
const DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long' });
const pad = value => String(value).padStart(2, '0');
const oneLine = text => plainText(text).replace(/\s+/g, ' ').trim();
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

/** A session's state line without its time: "Stuck · no events {t}" reads "Stuck · no events". */
export function stateWord(session) {
  const word = stateLine(session).replace(/\s*(?:·\s*)?\{[ta]\}\s*$/, '').trim();
  return word || STATUS_WORDS[session.status] || session.status;
}

/** The Board's short word for a status, without its time: "plan waiting {t}" reads "Plan waiting". */
export const tileWord = status => capital((BOARD_WORDS[status] ?? status).replace(/\s*\{[ta]\}\s*$/, ''));

function tileUnits(snapshot) {
  return snapshot.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => !isSubagent(unit) || unit.status === 'busy' || unit.status === 'stuck')
    .sort((a, b) => (STATUS_ORDER[a.unit.status] ?? 9) - (STATUS_ORDER[b.unit.status] ?? 9) || a.index - b.index)
    .map(({ unit }) => unit);
}

/** Tiles for Mission control (builder decision B1). */
export function tileGrid(snapshot) {
  const units = tileUnits(snapshot);
  const density = DENSITIES.find(entry => units.length <= entry.max) ?? DENSITIES[DENSITIES.length - 1];
  const overflow = units.length > density.max;
  const shown = overflow ? units.slice(0, density.max - 1) : units;
  return {
    density: density.name,
    tiles: shown.map(unit => ({ id: unit.id, label: unit.label, name: unit.name, status: unit.status, word: tileWord(unit.status), since: unit.since, attention: ATTENTION.has(unit.status), subagent: isSubagent(unit) })),
    more: overflow ? units.length - shown.length : 0,
  };
}

export function unitCounts(snapshot) {
  const subagents = snapshot.units.filter(isSubagent);
  const running = subagents.filter(unit => unit.status === 'busy' || unit.status === 'stuck').length;
  return { sessions: snapshot.units.length - subagents.length, running, finished: subagents.length - running + omittedSubagents(snapshot) };
}

export function legend(snapshot) {
  const count = bucket => snapshot.counts[bucket] ?? 0;
  return {
    rows: COUNT_TILES.map(([bucket, state]) => ({ bucket, state, word: BUCKET_WORDS[bucket], count: count(bucket) })),
    live: count('working') + count('stuck') + count('waiting') + count('idle'),
    ended: count('done') + count('failed'),
  };
}

export function needRows(snapshot) {
  const items = needItems(snapshot);
  const byId = new Map(snapshot.needs.map(need => [need.id, need]));
  const rows = items.slice(0, NEED_ROWS).map(item => {
    const need = byId.get(item.id);
    return {
      id: item.id,
      kind: item.kind,
      state: NEED_CLASS[item.kind],
      word: NEED_LABELS[item.kind],
      who: need?.labels.length ? need.labels.join(' ') : snapshot.orchestrator.label,
      text: oneLine(item.text),
      since: item.since,
      unitId: need?.unitIds.find(id => findUnit(snapshot, id)) ?? null,
    };
  });
  return { total: items.length, rows };
}

export function activityRows(snapshot) {
  const sessions = new Map([snapshot.orchestrator, ...snapshot.units].map(session => [session.id, session]));
  return snapshot.feed.slice(0, ACTIVITY_ROWS).reverse().map(item => {
    const session = sessions.get(item.unitId) ?? null;
    return { id: item.id, at: item.at, label: item.label ?? session?.label ?? '', text: oneLine(feedText(item)), status: session?.status ?? null, unitId: session && session !== snapshot.orchestrator ? session.id : null };
  });
}

export function prRows(snapshot) {
  const units = snapshot.units.filter(unit => unit.pr);
  const ended = unit => unit.pr.state === 'merged' || unit.pr.state === 'closed';
  const at = unit => (ended(unit) ? unit.pr.mergedAt ?? unit.pr.closedAt : unit.pr.openedAt) ?? 0;
  const sorted = [...units].sort((a, b) => Number(ended(a)) - Number(ended(b)) || at(b) - at(a));
  const rows = sorted.slice(0, PR_ROWS).map(unit => {
    const [state, word] = PR_STATES[unit.pr.state] ?? ['busy', unit.stage === 'in_review' ? 'In review' : 'Open'];
    return { id: unit.pr.id, unitId: unit.id, title: oneLine(unit.pr.title || `PR #${unit.pr.id}`), who: `${unit.label} ${unit.name}`, state, word };
  });
  return { rows, opened: units.length, merged: units.filter(unit => unit.pr.state === 'merged').length };
}

/** Credits per hour over the last hour of the cost series, or over its whole span when that is shorter but at least 10 minutes. */
export function hourlyRate(series) {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const from = last.at - HOUR;
  if (series[0].at >= from) {
    const span = last.at - series[0].at;
    return span >= 10 * MIN ? ((last.credits - series[0].credits) / span) * HOUR : null;
  }
  const index = series.findIndex(point => point.at > from);
  const a = series[index - 1];
  const b = series[index];
  return last.credits - (a.credits + ((b.credits - a.credits) * (from - a.at)) / (b.at - a.at));
}

/** The series carried on flat to `now`: the engine adds a point only when credits are spent. */
function untilNow(series, credits, now) {
  const last = series[series.length - 1];
  return last && now > last.at ? [...series, { at: now, credits: Math.max(credits, last.credits) }] : series;
}

/** The swarm's cost, with the rate over the hour up to `now`. Sub-agent unit costs are inside the orchestrator's and are never added here. */
export function costView(snapshot, now = snapshot.generatedAt) {
  const { cost } = snapshot;
  const models = [...cost.byModel].sort((a, b) => b.credits - a.credits).slice(0, MODEL_ROWS);
  const max = models.length ? models[0].credits : 0;
  return {
    credits: cost.credits,
    perHour: runEnd(snapshot) === null ? hourlyRate(untilNow(cost.series ?? [], cost.credits, now)) : null,
    models: models.map(entry => ({ model: entry.model, credits: entry.credits, share: max > 0 ? entry.credits / max : 0 })),
  };
}

export function clockText(ms) {
  const date = new Date(ms);
  return { hm: `${pad(date.getHours())}:${pad(date.getMinutes())}`, s: pad(date.getSeconds()) };
}
export const dateText = ms => DATE.format(new Date(ms)).replace(',', '');
export const timeText = ms => clockText(ms).hm;

/** The soonest scheduled PR monitor check, or null. */
export function nextCheckAt(snapshot) {
  const times = snapshot.units.filter(unit => !isSubagent(unit) && unit.monitor?.state === 'alive' && unit.monitor.nextCheckAt).map(unit => unit.monitor.nextCheckAt);
  return times.length ? Math.min(...times) : null;
}

export const runLine = snapshot => `${snapshot.run.name}${snapshot.run.project ? ` · ${snapshot.run.project.name}` : ''}`;
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-model.test.mjs`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-model.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-model.test.mjs
git commit -m "feat(swarm-dashboard): derive the cockpit's panel data from the snapshot"
```

---

### Task 3: 3D space and camera

**Files:**
- Create: `ui/cockpit-space.mjs`
- Create: `tests/cockpit-space.test.mjs`

**Interfaces:**
- Produces:
  - `DESIGN_HEIGHT = 900`, `FOV_Y = Math.PI / 3`, `FOCAL` (≈ 779.42), `STILL_TIME = 37`, `REST = { x: 0, y: 0, yaw: 0, pitch: 0 }`, `CAMERA_LIMITS = { x: 23, y: 14, yaw, pitch }` (radians).
  - `stageFor(width, height) → { width, height, scale, designWidth }`.
  - `multiply(a, b)`, `translate(x, y, z)`, `rotateX(rad)`, `rotateY(rad)` on row-major 4 × 4 arrays.
  - `panelMatrix(placement)`, `panelCss(placement) → string` for `placement = { phi, y, r, tilt, extra }` (degrees and design px).
  - `worldMatrix(cam)`, `worldCss(cam) → string` for `cam = { x, y, yaw, pitch }` (design px and radians).
  - `projectPanel(placement, size, cam, stage) → { left, top, right, bottom }` in window CSS px; `size = { width, height }`.
  - `viewMatrix(yaw, pitch) → Float32Array(9)` (column-major, for the shader).
  - `cameraTarget(seconds, mx, my) → cam`, `easeCamera(cam, target, dt) → cam`, `extremePoses() → cam[]`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-space.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_LIMITS, DESIGN_HEIGHT, FOCAL, REST, cameraTarget, easeCamera, extremePoses, multiply, panelCss, panelMatrix, projectPanel, rotateY, stageFor, translate, viewMatrix, worldCss,
} from '../ui/cockpit-space.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('the design space is 900 px tall with a 60-degree vertical field of view, scaled to the window height', () => {
  close(FOCAL, 450 / Math.tan(Math.PI / 6));
  assert.deepEqual(stageFor(1440, 900), { width: 1440, height: 900, scale: 1, designWidth: 1440 });
  const big = stageFor(1920, 1080);
  close(big.scale, 1.2);
  close(big.designWidth, 1600);
  assert.equal(DESIGN_HEIGHT, 900);
});

test('matrices compose like CSS transform lists, left to right', () => {
  const m = multiply(translate(10, 0, 0), rotateY(Math.PI / 2));
  // rotateY(90deg) takes +x to -z in CSS, then the translation moves x by 10.
  const p = [1, 0, 0];
  const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
  const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
  close(x, 10);
  close(z, -1);
});

test('a panel straight ahead at the focal distance projects at its own size, centred', () => {
  const stage = stageFor(1440, 900);
  const rect = projectPanel({ phi: 0, y: 0, r: FOCAL, tilt: 0 }, { width: 200, height: 100 }, REST, stage);
  close(rect.left, 620, 1e-6);
  close(rect.right, 820, 1e-6);
  close(rect.top, 400, 1e-6);
  close(rect.bottom, 500, 1e-6);
});

test('a panel further away projects smaller, and the stage scale applies last', () => {
  const near = projectPanel({ phi: 0, y: 0, r: 860, tilt: 0 }, { width: 536, height: 252 }, REST, stageFor(1440, 900));
  close(near.right - near.left, (536 * FOCAL) / 860, 1e-6);
  const scaled = projectPanel({ phi: 0, y: 0, r: 860, tilt: 0 }, { width: 536, height: 252 }, REST, stageFor(1920, 1080));
  close(scaled.right - scaled.left, ((536 * FOCAL) / 860) * 1.2, 1e-6);
});

test('the CSS strings carry the same transforms as the matrices', () => {
  assert.equal(panelCss({ phi: 12.5, y: -236, r: 860, tilt: 12, extra: -6 }), `translate3d(0px, 0px, ${FOCAL}px) rotateY(-12.5deg) translate3d(0px, 236px, -860px) rotateY(6deg) rotateX(12deg)`);
  assert.equal(worldCss({ x: 2, y: -3, yaw: 0.01, pitch: -0.02 }), `translate3d(0px, 0px, ${FOCAL}px) rotateX(-0.02rad) rotateY(0.01rad) translate3d(-2px, -3px, ${-FOCAL}px)`);
  const m = panelMatrix({ phi: 0, y: 0, r: 100, tilt: 0 });
  close(m[11], FOCAL - 100);
});

test('the shader view matrix is a rotation, identity at rest', () => {
  assert.deepEqual([...viewMatrix(0, 0)], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const m = viewMatrix(0.02, -0.01);
  const col = i => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
  for (const i of [0, 1, 2]) close(col(i).reduce((sum, v) => sum + v * v, 0), 1, 1e-6);
});

test('the camera drifts calmly within its limits, and eases toward its target', () => {
  for (let t = 0; t < 600; t += 0.5) {
    for (const [mx, my] of [[-1, -1], [1, 1], [0, 0]]) {
      const cam = cameraTarget(t, mx, my);
      assert.ok(Math.abs(cam.x) <= CAMERA_LIMITS.x && Math.abs(cam.y) <= CAMERA_LIMITS.y);
      assert.ok(Math.abs(cam.yaw) <= CAMERA_LIMITS.yaw && Math.abs(cam.pitch) <= CAMERA_LIMITS.pitch);
    }
  }
  const eased = easeCamera(REST, { x: 10, y: 0, yaw: 0, pitch: 0 }, 0.1);
  close(eased.x, 10 * (1 - Math.exp(-0.18)));
  assert.equal(extremePoses().length, 16);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-space.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-space.mjs'`.

- [ ] **Step 3: Write the module**

```js
// ui/cockpit-space.mjs
/**
 * The cockpit's 3D space, shared by the CSS panels and the shader. Design px: the stage is 900 px tall and scales with
 * the window's height; x points right, y down and z toward the viewer, as in CSS. The eye sits FOCAL px in front of the
 * stage, so the stage's perspective and the shader share one 60-degree vertical field of view.
 */
export const DESIGN_HEIGHT = 900;
export const FOV_Y = Math.PI / 3;
export const FOCAL = DESIGN_HEIGHT / 2 / Math.tan(FOV_Y / 2);
/** The scene time of the still frame drawn under "reduce motion" and for checks. */
export const STILL_TIME = 37;
export const REST = Object.freeze({ x: 0, y: 0, yaw: 0, pitch: 0 });
const DEG = Math.PI / 180;
/** The furthest the camera goes: pointer in a corner and every drift term at its peak. */
export const CAMERA_LIMITS = Object.freeze({ x: 23, y: 14, yaw: 0.95 * DEG, pitch: 0.8 * DEG });

export function stageFor(width, height) {
  const scale = height / DESIGN_HEIGHT;
  return { width, height, scale, designWidth: width / scale };
}

// Row-major 4 × 4 matrices; points are columns. multiply(a, b) applies b first, like a CSS transform list "a b".
export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) for (let k = 0; k < 4; k += 1) out[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return out;
}
const chain = (...matrices) => matrices.reduce((acc, m) => multiply(acc, m));
export const translate = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
export function rotateX(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}
export function rotateY(a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1];
}

/** A panel on a cylinder around the eye: turned phi degrees, raised y px, r px away, then turned by extra and tilted back. */
export const panelMatrix = ({ phi, y, r, tilt, extra = 0 }) => chain(translate(0, 0, FOCAL), rotateY(-phi * DEG), translate(0, -y, -r), rotateY(-extra * DEG), rotateX(tilt * DEG));
export const panelCss = ({ phi, y, r, tilt, extra = 0 }) => `translate3d(0px, 0px, ${FOCAL}px) rotateY(${-phi}deg) translate3d(0px, ${-y}px, ${-r}px) rotateY(${-extra}deg) rotateX(${tilt}deg)`;
/** The camera, applied to the whole world: it turns about the eye and moves sideways and up. */
export const worldMatrix = ({ x, y, yaw, pitch }) => chain(translate(0, 0, FOCAL), rotateX(pitch), rotateY(yaw), translate(-x, y, -FOCAL));
export const worldCss = ({ x, y, yaw, pitch }) => `translate3d(0px, 0px, ${FOCAL}px) rotateX(${pitch}rad) rotateY(${yaw}rad) translate3d(${-x}px, ${y}px, ${-FOCAL}px)`;

/** Where a panel lands in the window: the bounding box of its projected corners, as getBoundingClientRect reports it. */
export function projectPanel(placement, size, cam, stage) {
  const m = multiply(worldMatrix(cam), panelMatrix(placement));
  const cx = stage.designWidth / 2;
  const cy = DESIGN_HEIGHT / 2;
  const xs = [];
  const ys = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const px = (u * size.width) / 2;
    const py = (v * size.height) / 2;
    const X = m[0] * px + m[1] * py + m[3];
    const Y = m[4] * px + m[5] * py + m[7];
    const Z = m[8] * px + m[9] * py + m[11];
    const k = FOCAL / (FOCAL - Z);
    xs.push((cx + X * k) * stage.scale);
    ys.push((cy + Y * k) * stage.scale);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** The shader's camera rotation, Ry(yaw) · Rx(pitch), column-major for uniformMatrix3fv. */
export function viewMatrix(yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  return new Float32Array([cy, 0, sy, -sy * sx, cx, cy * sx, -sy * cx, -sx, cy * cx].map(v => (Object.is(v, -0) ? 0 : v)));
}

/** Where the camera drifts at a time (s) with the pointer at (mx, my), each in -1..1: long slow sines plus a slight parallax. */
export function cameraTarget(t, mx, my) {
  return {
    x: mx * 16 + 7 * Math.sin(t * 0.07),
    y: -my * 10 + 4 * Math.sin(t * 0.05 + 1),
    yaw: (mx * 0.7 + 0.25 * Math.sin(t * 0.031)) * DEG,
    pitch: (-my * 0.6 + 0.2 * Math.sin(t * 0.043)) * DEG,
  };
}

export function easeCamera(cam, target, dt) {
  const k = 1 - Math.exp(-dt * 1.8);
  return { x: cam.x + (target.x - cam.x) * k, y: cam.y + (target.y - cam.y) * k, yaw: cam.yaw + (target.yaw - cam.yaw) * k, pitch: cam.pitch + (target.pitch - cam.pitch) * k };
}

/** Every corner of the camera's range, for the arrangement checks. */
export function extremePoses() {
  const poses = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const yaw of [-1, 1]) for (const pitch of [-1, 1]) {
    poses.push({ x: x * CAMERA_LIMITS.x, y: y * CAMERA_LIMITS.y, yaw: yaw * CAMERA_LIMITS.yaw, pitch: pitch * CAMERA_LIMITS.pitch });
  }
  return poses;
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-space.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-space.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-space.test.mjs
git commit -m "feat(swarm-dashboard): add the cockpit's shared 3D space and camera"
```

---

### Task 4: Panel arrangement

**Files:**
- Create: `ui/cockpit-fit.mjs`
- Create: `tests/cockpit-fit.test.mjs`

**Interfaces:**
- Consumes: `REST`, `extremePoses`, `projectPanel`, `stageFor` from `ui/cockpit-space.mjs`; `PANEL_TABS`, `COCKPIT_SIZES` from `tests/helpers/cockpit.mjs` (Task 1).
- Produces:
  - `PANELS` (id → `{ width, height }` in design px; Task 9's CSS must use the same numbers), `MIN_WINDOW = { width: 1100, height: 800 }`, `SPACING`, `TOP_BAND = 48` (window px under the flat top line and quality switch).
  - `fitPanels(width, height) → { stage, fits, reason: null|'small'|'crowded', placements: { [id]: placement }|null, rects: { [id]: rect }|null, problems: string[] }`.
  - `overlapProblems(rects, { width, height, top, edge, clear }) → string[]`, used again by the browser check with DOM rectangles.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-fit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_WINDOW, PANELS, SPACING, TOP_BAND, fitPanels, overlapProblems } from '../ui/cockpit-fit.mjs';
import { COCKPIT_SIZES, PANEL_TABS } from './helpers/cockpit.mjs';

test('every panel in the shell has a fixed size', () => {
  assert.deepEqual(Object.keys(PANELS).sort(), Object.keys(PANEL_TABS).sort());
  assert.deepEqual(MIN_WINDOW, { width: 1100, height: 800 });
});

test('the arrangement fits at common window sizes, with exact gaps that match on both sides', () => {
  for (const [width, height] of COCKPIT_SIZES) {
    const fit = fitPanels(width, height);
    assert.equal(fit.fits, true, `${width} × ${height}: ${fit.problems.join('; ')}`);
    const r = fit.rects;
    const s = fit.stage.scale;
    const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.5, `${width} × ${height}: ${what} is ${got.toFixed(2)} px, not ${want.toFixed(2)}`);
    near((r['ck-units'].left + r['ck-units'].right) / 2, width / 2, "the centre console's middle");
    near(r['ck-activity'].left, width - r['ck-prs'].right, "the left console's margin against the right one's");
    near(r['ck-units'].left - r['ck-activity'].right, SPACING.consoleGap * s, 'the gap left of the centre console');
    near(r['ck-prs'].left - r['ck-units'].right, SPACING.consoleGap * s, 'the gap right of the centre console');
    near(r['ck-activity'].top - r['ck-cost'].bottom, SPACING.upperAbove * s, 'the gap above the activity console');
    near(r['ck-prs'].top - r['ck-status'].bottom, SPACING.upperAbove * s, 'the gap above the PR console');
    near(r['ck-cost'].top - r['ck-clock'].bottom, SPACING.upperGap * s, 'the gap inside the left stack');
    near(r['ck-status'].top - r['ck-needs'].bottom, SPACING.upperGap * s, 'the gap inside the right stack');
    for (const id of ['ck-clock', 'ck-needs']) assert.ok(r[id].top >= TOP_BAND, `${id} stays under the top line`);
  }
});

test('a window that fits keeps fitting as it grows wider', () => {
  for (const height of [800, 900, 1000, 1080, 1200, 1360, 1440, 1600]) {
    let fitted = false;
    for (let width = 1100; width <= 3200; width += 40) {
      const fits = fitPanels(width, height).fits;
      if (fitted) assert.equal(fits, true, `${width} × ${height} stops fitting although a narrower window fits`);
      fitted = fitted || fits;
    }
    const comfortable = Math.max(1100, Math.ceil(height * 1.4));
    assert.equal(fitPanels(comfortable, height).fits, true, `${comfortable} × ${height}`);
  }
});

test('below the minimum window, or too narrow for its height, the cockpit says so instead', () => {
  assert.equal(fitPanels(1099, 800).reason, 'small');
  assert.equal(fitPanels(1280, 799).reason, 'small');
  const narrow = fitPanels(1100, 1000);
  assert.deepEqual([narrow.fits, narrow.reason], [false, 'crowded']);
  assert.ok(narrow.problems.some(problem => problem.includes('ck-activity')));
});

test('overlapProblems reports overlaps, panels off the screen and panels in the top band', () => {
  const rects = { a: { left: 10, top: 60, right: 110, bottom: 160 }, b: { left: 100, top: 100, right: 200, bottom: 200 }, c: { left: 900, top: 20, right: 1100, bottom: 80 } };
  const problems = overlapProblems(rects, { width: 1000, height: 800, top: 48, edge: 8, clear: 8 });
  assert.deepEqual(problems, ['c leaves the screen', 'a overlaps b']);
  assert.deepEqual(overlapProblems({ a: rects.a }, { width: 1000, height: 800, top: 48, edge: 8, clear: 8 }), []);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-fit.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-fit.mjs'`.

- [ ] **Step 3: Write the module**

```js
// ui/cockpit-fit.mjs
/**
 * Where the panels go for a window size. A console arc sits below the window: the units console straight ahead and the
 * activity and PR consoles turned out to each side, at the smallest angle that leaves the console gap. Above each side
 * console a stack of two upper panels is pushed as far out as the window's edge allows. Gaps are found by bisection, so
 * they are exact and match on both sides. Everything is design px, scaled with the stage; the browser check runs
 * overlapProblems() again on the real page.
 */
import { REST, extremePoses, projectPanel, stageFor } from './cockpit-space.mjs';

export const PANELS = Object.freeze({
  'ck-clock': Object.freeze({ width: 280, height: 176 }),
  'ck-cost': Object.freeze({ width: 280, height: 236 }),
  'ck-needs': Object.freeze({ width: 280, height: 172 }),
  'ck-status': Object.freeze({ width: 280, height: 128 }),
  'ck-activity': Object.freeze({ width: 320, height: 252 }),
  'ck-units': Object.freeze({ width: 536, height: 252 }),
  'ck-prs': Object.freeze({ width: 320, height: 252 }),
});
export const MIN_WINDOW = Object.freeze({ width: 1100, height: 800 });
/**
 * Gaps in design px: between consoles; from every panel to the window's side edges at every camera pose (the camera
 * reaches about 50 px at the pointer's corner, more for panels turned far out); above the consoles; inside a stack; and
 * the stacks' top line.
 */
export const SPACING = Object.freeze({ consoleGap: 32, edge: 8, upperAbove: 24, upperGap: 16, top: 64 });
/** Window px under the flat top line and the quality switch (16 px from the top, 24 px tall, 8 px clear). */
export const TOP_BAND = 48;
const CONSOLE = Object.freeze({ r: 860, y: -236, tilt: 12 });
const SIDE = Object.freeze({ tilt: 8, turn: 0.5, rFrom: 940, rTo: 1300, rStep: 40, phiFrom: 14, phiTo: 60 });
const UPPER = Object.freeze({ r: 1180, turn: 0.75, phiFrom: 44, phiTo: 16, yFrom: -300, yTo: 700 });

const POSES = Object.freeze([REST, ...extremePoses()]);
const overlap = (a, b, clear) => a.left < b.right + clear && b.left < a.right + clear && a.top < b.bottom + clear && b.top < a.bottom + clear;

/** Where `ok` turns from false to true in [lo, hi] (ok is false below that point and true from it on); null if ok(hi) is false. */
function firstTrue(lo, hi, ok) {
  if (!ok(hi)) return null;
  if (ok(lo)) return lo;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
/** Where `ok` turns from true to false in [lo, hi]; null if ok(lo) is false. */
function lastTrue(lo, hi, ok) {
  const value = firstTrue(-hi, -lo, x => ok(-x));
  return value === null ? null : -value;
}

/** Panels that leave the screen or enter the top band, then pairs closer than `clear` px. All values are window px. */
export function overlapProblems(rects, { width, height, top, edge, clear }) {
  const entries = Object.entries(rects);
  const problems = [];
  for (const [id, r] of entries) {
    if (r.left < edge || r.right > width - edge || r.bottom > height - edge || r.top < top) problems.push(`${id} leaves the screen`);
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) if (overlap(entries[i][1], entries[j][1], clear)) problems.push(`${entries[i][0]} overlaps ${entries[j][0]}`);
  }
  return problems;
}

export function fitPanels(width, height) {
  const stage = stageFor(width, height);
  if (width < MIN_WINDOW.width || height < MIN_WINDOW.height) return { stage, fits: false, reason: 'small', placements: null, rects: null, problems: [] };
  const s = stage.scale;
  const placements = {};
  const rects = {};
  const put = (id, placement) => {
    placements[id] = placement;
    rects[id] = projectPanel(placement, PANELS[id], REST, stage);
    return rects[id];
  };
  /** A panel's least room to the window's side edge (the left one when sign < 0) over the camera's whole range. */
  const room = (id, placement, sign) => Math.min(...POSES.map(cam => {
    const rect = projectPanel(placement, PANELS[id], cam, stage);
    return sign < 0 ? rect.left : width - rect.right;
  }));
  const problems = [];
  const centre = put('ck-units', { phi: 0, y: CONSOLE.y, r: CONSOLE.r, tilt: CONSOLE.tilt, extra: 0 });
  for (const [id, sign] of [['ck-activity', -1], ['ck-prs', 1]]) {
    const placement = (r, phi) => ({ phi: sign * phi, y: CONSOLE.y, r, tilt: SIDE.tilt, extra: -SIDE.turn * sign * phi });
    const clear = rect => (sign > 0 ? rect.left - centre.right : centre.left - rect.right) >= SPACING.consoleGap * s;
    let done = false;
    for (let r = SIDE.rFrom; r <= SIDE.rTo && !done; r += SIDE.rStep) {
      // The smallest turn that leaves exactly the console gap; further back if the camera could then push it off the screen.
      const phi = firstTrue(SIDE.phiFrom, SIDE.phiTo, value => clear(put(id, placement(r, value))));
      if (phi !== null) {
        put(id, placement(r, phi));
        done = room(id, placement(r, phi), sign) >= SPACING.edge * s;
      }
    }
    if (!done) problems.push(`${id} does not fit beside the centre console`);
  }
  for (const [ids, sign, below] of [[['ck-clock', 'ck-cost'], -1, 'ck-activity'], [['ck-needs', 'ck-status'], 1, 'ck-prs']]) {
    let widest = UPPER.phiFrom;
    let floor = rects[below].top - SPACING.upperAbove * s;
    // The lower panel first, then the one above it.
    for (let k = ids.length - 1; k >= 0; k -= 1) {
      const id = ids[k];
      const placement = (phi, y) => ({ phi: sign * phi, y, r: UPPER.r, tilt: 0, extra: -UPPER.turn * sign * phi });
      const place = (phi, y) => put(id, placement(phi, y));
      // As far out as the camera's range allows and no further out than the panel below, then as low as leaves exactly
      // the gap to the panel below. The camera's reach depends a little on the height, so a second pass checks the turn
      // again at the height the first pass found.
      let phi = null;
      let y = 0;
      for (let pass = 0; pass < 2 && y !== null; pass += 1) {
        const at = y;
        phi = lastTrue(UPPER.phiTo, widest, value => room(id, placement(value, at), sign) >= SPACING.edge * s);
        if (phi === null) break;
        y = firstTrue(UPPER.yFrom, UPPER.yTo, value => place(phi, value).bottom <= floor);
      }
      if (phi === null) {
        problems.push(`${id} does not fit inside the window's edge`);
        break;
      }
      if (y === null) {
        problems.push(`${id} does not fit above ${below}`);
        break;
      }
      widest = phi;
      floor = place(phi, y).top - SPACING.upperGap * s;
    }
  }
  const top = Math.max(SPACING.top * s, TOP_BAND);
  problems.push(...overlapProblems(rects, { width, height, top, edge: 8, clear: 8 * s }));
  // The camera's drift and parallax must never push a panel off the screen, into the top band or into another panel.
  for (const cam of extremePoses()) {
    const moved = Object.fromEntries(Object.entries(placements).map(([id, placement]) => [id, projectPanel(placement, PANELS[id], cam, stage)]));
    for (const problem of overlapProblems(moved, { width, height, top: TOP_BAND, edge: 4 * s, clear: 4 * s })) problems.push(`at the camera's limit, ${problem}`);
  }
  const unique = [...new Set(problems)];
  return { stage, fits: unique.length === 0, reason: unique.length ? 'crowded' : null, placements, rects, problems: unique };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-fit.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-fit.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-fit.test.mjs
git commit -m "feat(swarm-dashboard): arrange the cockpit's panels for each window size"
```

---

### Task 5: Frame pacing and quality

**Files:**
- Create: `ui/cockpit-quality.mjs`
- Create: `tests/cockpit-quality.test.mjs`

**Interfaces:**
- Produces:
  - `FPS_CAP = 30`, `QUALITIES = ['high', 'balanced']`, `STORE_KEY = 'swarm-dashboard:cockpit'`, `POINTER_MS = 1200`, `SCALE_MIN = 0.5`, `SCALE_STEP = 0.1`.
  - `readQuality(getStorage, param) → 'high'|'balanced'`, `saveQuality(getStorage, quality)`; `getStorage` is a function that returns a `Storage` and may throw.
  - `frameDue(now, last) → boolean`, `drawsHole(quality, frame, now, pointerAt) → boolean`, `loopRuns({ hidden, reduced }) → boolean`.
  - `createAdaptive({ cap }) → { scale, frame(intervalMs|null) → number|null, reset() }`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-quality.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FPS_CAP, POINTER_MS, STORE_KEY, createAdaptive, drawsHole, frameDue, loopRuns, readQuality, saveQuality } from '../ui/cockpit-quality.mjs';

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, data };
};

test('High is the default; a saved choice is remembered; the address can override it for checks', () => {
  assert.equal(readQuality(() => memory(), null), 'high');
  assert.equal(readQuality(() => memory({ [STORE_KEY]: '{"quality":"balanced"}' }), null), 'balanced');
  assert.equal(readQuality(() => memory({ [STORE_KEY]: '{"quality":"balanced"}' }), 'high'), 'high');
  assert.equal(readQuality(() => memory({ [STORE_KEY]: 'not json' }), 'ultra'), 'high');
  assert.equal(readQuality(() => { throw new Error('denied'); }, null), 'high');
  const store = memory();
  saveQuality(() => store, 'balanced');
  assert.equal(store.data[STORE_KEY], '{"quality":"balanced"}');
  assert.doesNotThrow(() => saveQuality(() => { throw new Error('denied'); }, 'high'));
});

test('frames are capped at 30 per second', () => {
  assert.equal(FPS_CAP, 30);
  assert.equal(frameDue(1000, null), true);
  assert.equal(frameDue(1031.3, 1000), false);
  assert.equal(frameDue(1031.4, 1000), true);
});

test('High redraws the black hole every frame; Balanced every second frame, and every frame just after the pointer moves', () => {
  assert.equal(drawsHole('high', 1, 0, -Infinity), true);
  assert.equal(drawsHole('balanced', 2, 10000, -Infinity), true);
  assert.equal(drawsHole('balanced', 3, 10000, -Infinity), false);
  assert.equal(drawsHole('balanced', 3, 10000, 10000 - POINTER_MS + 1), true);
  assert.equal(drawsHole('balanced', 3, 10000, 10000 - POINTER_MS), false);
});

test('the loop stops while hidden and under reduced motion', () => {
  assert.equal(loopRuns({ hidden: false, reduced: false }), true);
  assert.equal(loopRuns({ hidden: true, reduced: false }), false);
  assert.equal(loopRuns({ hidden: false, reduced: true }), false);
});

test('the adaptive fallback lowers the resolution in 0.1 steps to 0.5 while the cap is not held, and never during warm-up', () => {
  const slow = createAdaptive();
  const drops = [];
  for (let frame = 1; frame <= 600; frame += 1) {
    const scale = slow.frame(frame === 1 ? null : 50);
    if (scale !== null) drops.push([frame, scale]);
  }
  assert.deepEqual(drops, [[120, 0.9], [180, 0.8], [240, 0.7], [300, 0.6], [360, 0.5]]);
  assert.equal(slow.scale, 0.5);
  const steady = createAdaptive();
  for (let frame = 1; frame <= 600; frame += 1) assert.equal(steady.frame(1000 / 30), null);
  const paused = createAdaptive();
  for (let frame = 1; frame <= 119; frame += 1) paused.frame(50);
  paused.reset();
  assert.equal(paused.frame(50), null, 'a reset needs new samples before the next step');
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-quality.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-quality.mjs'`.

- [ ] **Step 3: Write the module**

```js
// ui/cockpit-quality.mjs
/** How often the cockpit draws, and how much: the quality setting, the frame cap and the adaptive resolution. */
export const FPS_CAP = 30;
export const QUALITIES = Object.freeze(['high', 'balanced']);
export const STORE_KEY = 'swarm-dashboard:cockpit';
/** After the pointer moves, Balanced draws the black hole every frame for this long. */
export const POINTER_MS = 1200;
export const SCALE_MIN = 0.5;
export const SCALE_STEP = 0.1;
const CHECK_EVERY = 30;
const WARM_UP = 90;
const SAMPLES = 60;
const KEEP = 90;

/** The quality to use: a valid one in the address (for checks), else the one remembered in this browser, else High. */
export function readQuality(getStorage, param) {
  if (QUALITIES.includes(param)) return param;
  try {
    const saved = JSON.parse(getStorage().getItem(STORE_KEY) ?? 'null');
    return QUALITIES.includes(saved?.quality) ? saved.quality : 'high';
  } catch {
    return 'high';
  }
}

export function saveQuality(getStorage, quality) {
  try {
    getStorage().setItem(STORE_KEY, JSON.stringify({ quality }));
  } catch {
    // Storage can be unavailable; the choice then lasts until the page closes.
  }
}

/** Whether an animation frame is due under the cap; 2 ms early is fine, because frames land on display refreshes. */
export const frameDue = (now, last) => last === null || now - last >= 1000 / FPS_CAP - 2;

/** Whether a frame redraws the black hole; frames that do not reuse the last one, turned to the current camera. */
export const drawsHole = (quality, frame, now, pointerAt) => quality === 'high' || frame % 2 === 0 || now - pointerAt < POINTER_MS;

export const loopRuns = ({ hidden, reduced }) => !hidden && !reduced;

/** Lowers the black hole's resolution while the frame rate stays under 90% of the cap. frame() returns a new scale or null. */
export function createAdaptive({ cap = FPS_CAP } = {}) {
  let scale = 1;
  let frames = 0;
  const intervals = [];
  return {
    get scale() {
      return scale;
    },
    frame(intervalMs) {
      frames += 1;
      if (intervalMs !== null) {
        intervals.push(intervalMs);
        if (intervals.length > KEEP) intervals.shift();
      }
      if (frames % CHECK_EVERY !== 0 || frames <= WARM_UP || intervals.length < SAMPLES || scale <= SCALE_MIN) return null;
      const fps = 1000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length);
      if (fps >= cap * 0.9) return null;
      scale = Math.max(SCALE_MIN, Math.round((scale - SCALE_STEP) * 100) / 100);
      intervals.length = 0;
      return scale;
    },
    /** After a pause, so time spent hidden does not count as slow frames. */
    reset() {
      intervals.length = 0;
    },
  };
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-quality.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-quality.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-quality.test.mjs
git commit -m "feat(swarm-dashboard): pace the cockpit's frames and remember its quality"
```

---

### Task 6: Panel HTML

Builder decisions B1, B4, B5, B6 and B8 apply (confirmed).

**Files:**
- Create: `ui/cockpit-panels.mjs`
- Create: `tests/cockpit-panels.test.mjs`

**Interfaces:**
- Consumes: Task 2's `ui/cockpit-model.mjs`, Task 5's `QUALITIES`, and `ui/format.mjs` (`count`, `countdown`, `credits`, `dur`, `esc`, `liveTime`, `plural`, `usdRounded`), `ui/model.mjs` (`runEnd`).
- Produces (pure HTML strings; every interactive element is a `<button type="button">`):
  - `clockHtml(snapshot|null, now)`, `costHtml(snapshot|null, now)`, `needsHtml(snapshot|null, now)`, `statusHtml(snapshot|null)`, `activityHtml(snapshot|null)`, `unitsHtml(snapshot|null, now, fresh: Set<unitId>)`, `prsHtml(snapshot|null)`.
  - `hudHtml({ demo, connection, snapshot })`, `qualityHtml(quality)`, `noteHtml()`.
  - Markup contract used by Tasks 9 and 11: `[data-detail]` (a unit id) and `[data-tab]` (a regular-view tab) on click targets; `[data-key]` on list items; `[data-clock="hm"|"s"|"date"]` on the clock's texts; `[data-t]`/`[data-f]` live times from `liveTime()`; `[data-quality]` on the quality buttons; classes `ck-ph`, `ck-t`, `ck-side`, `ck-mono`, `ck-empty`, `ck-tiles d-<density>`, `ck-tile`, `ck-more`, `ck-foot`, `ck-log-window`, `ck-log`, `ck-log-row`, `ck-need`, `ck-leg`, `ck-model`, `ck-bar`, `ck-fill`, `ck-prs`, `ck-pr`, `st-<state>`, `is-attn`, `is-new`, `is-zero`, `is-off`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-panels.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityHtml, clockHtml, costHtml, hudHtml, needsHtml, noteHtml, prsHtml, qualityHtml, statusHtml, unitsHtml } from '../ui/cockpit-panels.mjs';
import { NOW, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const example = () => deepFreeze(exampleSnapshot());
const all = s => [clockHtml(s, NOW), costHtml(s, NOW), needsHtml(s, NOW), statusHtml(s), activityHtml(s), unitsHtml(s, NOW, new Set()), prsHtml(s)].join('');
const countOf = (html, pattern) => [...html.matchAll(pattern)].length;

test('no panel uses bold, italic or inline type styles', () => {
  for (const html of [all(example()), all(null), hudHtml({ demo: true, connection: 'retrying', snapshot: example() }), noteHtml()]) {
    assert.doesNotMatch(html, /<(b|strong|em|i)\b|font-weight|font-style|text-transform/);
  }
});

test('the clock shows the time, the date, the run timer, the next monitor check and the run', () => {
  const html = clockHtml(example(), NOW);
  assert.match(html, /<span class="ck-mono ck-hm" data-clock="hm">\d\d:\d\d<\/span><span class="ck-mono ck-s" data-clock="s">\d\d<\/span>/);
  assert.match(html, /data-clock="date">[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]+</);
  assert.match(html, /<span class="ck-k">Running<\/span><span class="ck-v ck-mono"><span data-t="1791809280000" data-f="clock">/);
  assert.match(html, /<span class="ck-k">Next check<\/span><span class="ck-v ck-mono"><span data-t="1792065660000" data-f="left">1m<\/span>/);
  assert.match(html, /Sample story B · sample-project/);
  assert.match(clockHtml(null, NOW), /<span class="ck-k">Swarm<\/span><span class="ck-v">None yet<\/span>/);
});

test('cost shows credits, dollars, the hourly rate and up to four models as bars', () => {
  const html = costHtml(example(), NOW);
  assert.match(html, /<button type="button" class="ck-t" data-tab="timeline">Cost<\/button><span class="ck-side"><span class="ck-mono">\+2,208 cr\/h<\/span><\/span>/);
  assert.match(costHtml(example(), NOW + 3 * 3600000), /<span class="ck-mono">\+0 cr\/h<\/span>/);
  assert.match(html, /<div class="ck-big ck-mono">97,652 cr<\/div><div class="ck-meta ck-mono">≈\$977 at list price<\/div>/);
  assert.equal(countOf(html, /class="ck-model"/g), 4);
  assert.match(html, /claude-sonnet-5<\/span><span class="ck-mono ck-n">52,100<\/span><span class="ck-bar"><span class="ck-fill" style="--w:1\.0000"><\/span>/);
});

test('needs you lights up, counts and lists the first two, each leading to its unit', () => {
  const html = needsHtml(example(), NOW);
  assert.match(html, /<span class="ck-light"><\/span><button type="button" class="ck-t" data-tab="cards">Needs you<\/button>/);
  assert.match(html, /<span class="ck-side ck-big ck-mono">2<\/span>/);
  assert.match(html, /<button type="button" class="ck-need st-plan" data-detail="ws-0004-b2"><span class="ck-mono ck-lab">B2<\/span><span class="ck-kind">Plan to approve<\/span>/);
  assert.match(html, /class="ck-need st-pr" data-detail="ws-0007-d5"/);
  const quiet = exampleSnapshot();
  quiet.needs = [];
  assert.match(needsHtml(quiet, NOW), /ck-light is-off[\s\S]*<p class="ck-empty">Nothing waiting<\/p>/);
});

test('status shows the six buckets and what is live and ended', () => {
  const html = statusHtml(example());
  assert.equal(countOf(html, /<li class="st-/g), 6);
  assert.match(html, /<li class="st-busy"><span class="ck-dot"><\/span><span class="ck-w">Working<\/span><span class="ck-mono ck-n">2<\/span><\/li>/);
  assert.match(html, /7 live · 5 ended/);
});

test('activity lists nine rows, newest last; rows of units lead to their details', () => {
  const html = activityHtml(example());
  assert.equal(countOf(html, /<li data-key=/g), 9);
  assert.match(html, /<div class="ck-log-window" style="--lab:6ch"><ol class="ck-log">/);
  assert.match(html, /<div class="ck-log-row st-question"><span class="ck-mono ck-time">\d\d:\d\d<\/span><span class="ck-mono ck-lab">SB<\/span>/);
  assert.match(html, /<button type="button" class="ck-log-row st-busy" data-detail="call-root-41">[\s\S]*started explore<\/span><\/button><\/li><\/ol>/);
  assert.match(html, /16 recent events/);
});

test('mission control shows a tile per unit at the density its count needs, the orchestrator and the counts', () => {
  const html = unitsHtml(example(), NOW, new Set(['ws-0005-i1']));
  assert.match(html, /<div class="ck-tiles d-two">/);
  assert.equal(countOf(html, /<button type="button" class="ck-tile /g), 9);
  assert.match(html, /<button type="button" class="ck-tile st-stuck is-attn is-new" data-detail="ws-0005-i1" data-key="ws-0005-i1" title="I1 integration" aria-label="I1 integration, Stuck">/);
  assert.doesNotMatch(html, /class="ck-name"/, 'two-line tiles leave the name to the title');
  assert.match(html, /<span class="ck-side">SB orchestrator · Waiting on question · <span data-t=/);
  assert.match(html, /<p class="ck-foot">7 child sessions · 2 sub-agents running · 3 finished<\/p>/);
  const few = exampleSnapshot();
  few.units = few.units.filter(unit => unit.kind !== 'subagent');
  assert.match(unitsHtml(few, NOW, new Set()), /<div class="ck-tiles d-full">[\s\S]*<span class="ck-name">integration<\/span>/);
  const many = exampleSnapshot();
  many.units = Array.from({ length: 20 }, (_, i) => ({ ...few.units[2], id: `u${i}`, label: `U${i}` }));
  assert.match(unitsHtml(many, NOW, new Set()), /<div class="ck-tiles d-one">[\s\S]*<button type="button" class="ck-tile ck-more" data-tab="board" data-key="more" title="On the Board"><span>\+5 more<\/span><\/button>/);
});

test('pull requests list four rows and the opened and merged counts', () => {
  const html = prsHtml(example());
  assert.equal(countOf(html, /<button type="button" class="ck-pr /g), 4);
  assert.match(html, /<button type="button" class="ck-pr st-busy" data-detail="ws-0003-b1"><span class="ck-mono ck-num">#418<\/span><span class="ck-pr-t"><span class="ck-ttl" title="Orders and invoices API">Orders and invoices API<\/span><span class="ck-sub">B1 API<\/span><\/span><span class="ck-pr-s"><span class="ck-dot"><\/span>In review<\/span><\/button>/);
  assert.match(html, /4 opened · 2 merged/);
});

test('text from the snapshot is escaped', () => {
  const s = exampleSnapshot();
  s.units[2].name = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(unitsHtml(s, NOW, new Set()) + prsHtml(s), /<img/);
});

test('without a swarm every panel says so', () => {
  const html = all(null);
  for (const text of ['None yet', 'No swarm yet', 'Nothing waiting', 'No activity yet', 'No pull requests yet']) assert.ok(html.includes(text), text);
});

test('the top line, the quality switch and the note', () => {
  assert.equal(hudHtml({ demo: false, connection: 'open', snapshot: example() }), '<span>Swarm cockpit</span>');
  const finished = exampleSnapshot();
  finished.run.lifecycle = 'finished';
  assert.equal(hudHtml({ demo: true, connection: 'retrying', snapshot: finished }), '<span>Swarm cockpit · Sample data · Swarm finished</span><span class="ck-warn"> · Disconnected · retrying</span>');
  assert.equal(qualityHtml('balanced'), '<button type="button" data-quality="high" aria-pressed="false">High</button><button type="button" data-quality="balanced" aria-pressed="true">Balanced</button>');
  assert.match(noteHtml(), /Make this window larger to see the cockpit\.[\s\S]*data-tab="cards">Open the regular view<\/button>/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-panels.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-panels.mjs'`.

- [ ] **Step 3: Write the module**

```js
// ui/cockpit-panels.mjs
/** HTML for the cockpit's panels, its top line, its quality switch and its note. Pure: Node tests import it. */
import { count, countdown, credits, dur, esc, liveTime, plural, usdRounded } from './format.mjs';
import { runEnd } from './model.mjs';
import { activityRows, clockText, costView, dateText, legend, needRows, nextCheckAt, prRows, runLine, stateWord, tileGrid, timeText, unitCounts } from './cockpit-model.mjs';
import { QUALITIES } from './cockpit-quality.mjs';

const QUALITY_WORDS = { high: 'High', balanced: 'Balanced' };
/** A panel header: its title, a quiet button that opens a tab of the regular view, and a note on the right. */
const head = (title, tab, side = '') => `<header class="ck-ph"><button type="button" class="ck-t" data-tab="${tab}">${title}</button>${side ? `<span class="ck-side">${side}</span>` : ''}</header>`;
const empty = text => `<p class="ck-empty">${text}</p>`;
const row = (key, value, mono = true) => `<div class="ck-row"><span class="ck-k">${key}</span><span class="ck-v${mono ? ' ck-mono' : ''}">${value}</span></div>`;

export function clockHtml(snapshot, now) {
  const { hm, s } = clockText(now);
  const clock = `<div class="ck-clock"><span class="ck-mono ck-hm" data-clock="hm">${hm}</span><span class="ck-mono ck-s" data-clock="s">${s}</span></div>`
    + `<div class="ck-meta" data-clock="date">${esc(dateText(now))}</div>`;
  if (!snapshot) return clock + row('Swarm', 'None yet', false);
  const end = runEnd(snapshot);
  const next = nextCheckAt(snapshot);
  const line = esc(runLine(snapshot));
  return clock
    + row(end === null ? 'Running' : 'Ran', end === null ? liveTime(snapshot.run.startedAt, now, 'clock') : dur(end - snapshot.run.startedAt, 'clock'))
    + (next === null ? row('Next check', 'None scheduled', false) : row('Next check', countdown(next, now)))
    + `<div class="ck-meta ck-ellipsis" title="${line}">${line}</div>`;
}

export function costHtml(snapshot, now) {
  if (!snapshot) return head('Cost', 'timeline') + empty('No swarm yet');
  const view = costView(snapshot, now);
  const side = view.perHour === null ? '' : `<span class="ck-mono">+${count(Math.round(view.perHour))} cr/h</span>`;
  const models = view.models.map(entry => `<div class="ck-model" data-key="${esc(entry.model)}"><span class="ck-model-n">${esc(entry.model)}</span>`
    + `<span class="ck-mono ck-n">${count(Math.round(entry.credits))}</span><span class="ck-bar"><span class="ck-fill" style="--w:${entry.share.toFixed(4)}"></span></span></div>`).join('');
  return head('Cost', 'timeline', side) + `<div class="ck-big ck-mono">${credits(view.credits)}</div><div class="ck-meta ck-mono">${usdRounded(view.credits)} at list price</div><div class="ck-models">${models}</div>`;
}

export function needsHtml(snapshot, now) {
  const { total, rows } = snapshot ? needRows(snapshot) : { total: 0, rows: [] };
  const header = `<header class="ck-ph"><span class="ck-needs-t"><span class="ck-light${total ? '' : ' is-off'}"></span><button type="button" class="ck-t" data-tab="cards">Needs you</button></span>`
    + `<span class="ck-side ck-big ck-mono">${count(total)}</span></header>`;
  if (!rows.length) return header + empty('Nothing waiting');
  const items = rows.map(item => `<li data-key="${esc(item.id)}"><button type="button" class="ck-need st-${item.state}"${item.unitId ? ` data-detail="${esc(item.unitId)}"` : ''}>`
    + `<span class="ck-mono ck-lab">${esc(item.who)}</span><span class="ck-kind">${esc(item.word)}</span><span class="ck-mono ck-age">${liveTime(item.since, now)}</span>`
    + `<span class="ck-txt" title="${esc(item.text)}">${esc(item.text)}</span></button></li>`).join('');
  return `${header}<ul class="ck-needs">${items}</ul>`;
}

export function statusHtml(snapshot) {
  if (!snapshot) return head('Status', 'board') + empty('No swarm yet');
  const view = legend(snapshot);
  const rows = view.rows.map(item => `<li class="st-${item.state}${item.count ? '' : ' is-zero'}"><span class="ck-dot"></span><span class="ck-w">${item.word}</span><span class="ck-mono ck-n">${count(item.count)}</span></li>`).join('');
  return head('Status', 'board', `<span class="ck-mono">${count(view.live)} live · ${count(view.ended)} ended</span>`) + `<ul class="ck-leg">${rows}</ul>`;
}

export function activityHtml(snapshot) {
  const rows = snapshot ? activityRows(snapshot) : [];
  if (!rows.length) return head('Activity', 'cards') + empty('No activity yet');
  // One label column for every row, as wide as the longest label shown but at most 6 characters of monospace, so one
  // long sub-agent label does not squeeze every row's text.
  const width = Math.min(6, Math.max(2, ...rows.map(item => item.label.length)));
  const items = rows.map(item => {
    const inner = `<span class="ck-mono ck-time">${timeText(item.at)}</span><span class="ck-mono ck-lab">${esc(item.label)}</span><span class="ck-txt" title="${esc(item.text)}">${esc(item.text)}</span>`;
    const cls = `ck-log-row${item.status ? ` st-${item.status}` : ''}`;
    return `<li data-key="${esc(item.id)}">${item.unitId ? `<button type="button" class="${cls}" data-detail="${esc(item.unitId)}">${inner}</button>` : `<div class="${cls}">${inner}</div>`}</li>`;
  }).join('');
  return head('Activity', 'cards', `<span class="ck-mono">${plural(snapshot.feed.length, 'recent event')}</span>`) + `<div class="ck-log-window" style="--lab:${width}ch"><ol class="ck-log">${items}</ol></div>`;
}

function tileHtml(tile, density, now, fresh) {
  const cls = `ck-tile st-${tile.status}${tile.attention ? ' is-attn' : ''}${fresh ? ' is-new' : ''}`;
  const who = `${tile.label} ${tile.name}`;
  return `<button type="button" class="${cls}" data-detail="${esc(tile.id)}" data-key="${esc(tile.id)}" title="${esc(who)}" aria-label="${esc(`${who}, ${tile.word}`)}">`
    + `<span class="ck-id"><span class="ck-dot"></span><span class="ck-mono ck-lab">${esc(tile.label)}</span></span><span class="ck-mono ck-age">${liveTime(tile.since, now)}</span>`
    + (density === 'full' ? `<span class="ck-name">${esc(tile.name)}</span>` : '')
    + (density === 'one' ? '' : `<span class="ck-state">${esc(tile.word)}</span>`)
    + '</button>';
}

export function unitsHtml(snapshot, now, fresh) {
  if (!snapshot) return head('Mission control', 'cards') + empty('No swarm yet');
  const orchestrator = snapshot.orchestrator;
  const side = `${esc(orchestrator.label)} orchestrator · ${esc(stateWord(orchestrator))} · ${liveTime(orchestrator.since, now)}`;
  const grid = tileGrid(snapshot);
  const tiles = grid.tiles.map(tile => tileHtml(tile, grid.density, now, fresh.has(tile.id))).join('')
    + (grid.more ? `<button type="button" class="ck-tile ck-more" data-tab="board" data-key="more" title="On the Board"><span>+${grid.more} more</span></button>` : '');
  const counts = unitCounts(snapshot);
  const foot = `${plural(counts.sessions, 'child session')} · ${plural(counts.running, 'sub-agent')} running · ${count(counts.finished)} finished`;
  return head('Mission control', 'cards', side)
    + (grid.tiles.length ? `<div class="ck-tiles d-${grid.density}">${tiles}</div>` : empty('No child sessions yet'))
    + `<p class="ck-foot">${foot}</p>`;
}

export function prsHtml(snapshot) {
  if (!snapshot) return head('Pull requests', 'board') + empty('No pull requests yet');
  const view = prRows(snapshot);
  const side = `<span class="ck-mono">${count(view.opened)} opened · ${count(view.merged)} merged</span>`;
  if (!view.rows.length) return head('Pull requests', 'board', side) + empty('No pull requests yet');
  const rows = view.rows.map(item => `<li data-key="${esc(item.id)}"><button type="button" class="ck-pr st-${item.state}" data-detail="${esc(item.unitId)}">`
    + `<span class="ck-mono ck-num">#${esc(item.id)}</span><span class="ck-pr-t"><span class="ck-ttl" title="${esc(item.title)}">${esc(item.title)}</span><span class="ck-sub">${esc(item.who)}</span></span>`
    + `<span class="ck-pr-s"><span class="ck-dot"></span>${esc(item.word)}</span></button></li>`).join('');
  return head('Pull requests', 'board', side) + `<ul class="ck-prs">${rows}</ul>`;
}

export function hudHtml({ demo, connection, snapshot }) {
  const parts = ['Swarm cockpit'];
  if (demo) parts.push('Sample data');
  if (snapshot?.run.lifecycle === 'finished') parts.push('Swarm finished');
  return `<span>${parts.join(' · ')}</span>${connection === 'retrying' ? '<span class="ck-warn"> · Disconnected · retrying</span>' : ''}`;
}

export const qualityHtml = quality => QUALITIES.map(name => `<button type="button" data-quality="${name}" aria-pressed="${name === quality}">${QUALITY_WORDS[name]}</button>`).join('');

export const noteHtml = () => '<p>Make this window larger to see the cockpit.</p><p class="ck-dim">It needs at least 1100 × 800, about 1.3 times as wide as it is tall.</p>'
  + '<button type="button" class="ck-t" data-tab="cards">Open the regular view</button>';
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-panels.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-panels.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-panels.test.mjs
git commit -m "feat(swarm-dashboard): render the cockpit's panels"
```

---

### Task 7: Links between the two windows

**Files:**
- Create: `ui/cockpit-link.mjs`
- Create: `tests/cockpit-link.test.mjs`

**Interfaces:**
- Consumes: `esc` from `ui/format.mjs`.
- Produces:
  - `REGULAR_WINDOW = 'swarm-dashboard'`, `COCKPIT_WINDOW = 'swarm-cockpit'`, `SHOW = 'swarm-dashboard:show'`, `TABS = ['cards', 'timeline', 'plan', 'board']`.
  - `cockpitPath(swarm) → '/cockpit?swarm=…'`, `regularPath({ swarm, detail, tab }) → '/?swarm=…&tab=…&detail=…'`.
  - Regular side: `cockpitControlHtml(view)`, `cockpitAddressHtml(note|null)`, `openCockpit(win, { swarm, host }) → null | { url, reason: 'canvas'|'blocked', copied: null }`, `copyAddress(nav, doc, el, url) → Promise<boolean>`, `showRequest(view, data) → null | { reload: path } | { detail, tab }`.
  - Cockpit side: `showInRegular(win, { swarm, detail, tab }) → boolean`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-link.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COCKPIT_WINDOW, REGULAR_WINDOW, SHOW, cockpitAddressHtml, cockpitControlHtml, cockpitPath, copyAddress, openCockpit, regularPath, showInRegular, showRequest,
} from '../ui/cockpit-link.mjs';

const BASE = 'http://127.0.0.1:7927';
function target(href) {
  const t = { focused: false, replaced: null, messages: [], location: { href, replace(url) { t.replaced = url; } }, focus() { t.focused = true; }, postMessage(data, origin) { t.messages.push({ data, origin }); } };
  return t;
}
function page(opened, href = `${BASE}/?host=browser`) {
  const calls = [];
  const win = { name: '', screen: { availWidth: 1512, availHeight: 945 }, location: { href, origin: new URL(href).origin }, open(url, name, features) { calls.push([url, name, features]); return opened; } };
  return { win, calls };
}

test('addresses for the cockpit and for the regular view', () => {
  assert.equal(cockpitPath('ws 1'), '/cockpit?swarm=ws+1');
  assert.equal(regularPath({ swarm: 'ws-1', detail: 'u1', tab: 'board' }), '/?swarm=ws-1&tab=board&detail=u1');
  assert.equal(regularPath({ swarm: 'ws-1', tab: 'nonsense' }), '/?swarm=ws-1');
});

test('the Cockpit control shows on the Live page once a swarm shows', () => {
  const snapshot = { run: { id: 'ws-1' } };
  assert.equal(cockpitControlHtml({ page: 'live', snapshot }), '<div class="seg ck-open"><button type="button" data-cockpit>Cockpit</button></div>');
  assert.equal(cockpitControlHtml({ page: 'history', snapshot }), '');
  assert.equal(cockpitControlHtml({ page: 'live', snapshot: null }), '');
});

test('in the canvas the control returns the address to show and opens nothing', () => {
  const { win, calls } = page(null, `${BASE}/?host=canvas&session=s1`);
  assert.deepEqual(openCockpit(win, { swarm: 'ws-1', host: 'canvas' }), { url: `${BASE}/cockpit?swarm=ws-1`, reason: 'canvas', copied: null });
  assert.deepEqual(calls, []);
  const html = cockpitAddressHtml({ url: `${BASE}/cockpit?swarm=ws-1`, reason: 'canvas', copied: null });
  assert.equal(html, `<div class="ck-addr" role="status"><span class="small muted">Open this address in your browser:</span><span class="code ck-addr-url">${BASE}/cockpit?swarm=ws-1</span><button type="button" class="link" data-cockpit-copy>Copy</button></div>`);
  assert.match(cockpitAddressHtml({ url: 'x', reason: 'blocked', copied: false }), /The browser blocked the new window\. Open this address instead:[\s\S]*<span class="small muted">Select the address and copy it<\/span>/);
  assert.match(cockpitAddressHtml({ url: 'x', reason: 'canvas', copied: true }), /<span class="small muted">Copied<\/span>/);
  assert.equal(cockpitAddressHtml(null), '');
});

test('in a browser the control opens a named window sized to the screen, or reuses it', () => {
  const blank = target('about:blank');
  const fresh = page(blank);
  assert.equal(openCockpit(fresh.win, { swarm: 'ws-1', host: 'browser' }), null);
  assert.equal(fresh.win.name, REGULAR_WINDOW);
  assert.deepEqual(fresh.calls, [['', COCKPIT_WINDOW, 'popup=yes,left=0,top=0,width=1512,height=945']]);
  assert.equal(blank.replaced, `${BASE}/cockpit?swarm=ws-1`);
  assert.equal(blank.focused, true);
  const same = target(`${BASE}/cockpit?swarm=ws-1&quality=high`);
  openCockpit(page(same).win, { swarm: 'ws-1', host: 'browser' });
  assert.deepEqual([same.replaced, same.focused], [null, true]);
  const other = target(`${BASE}/cockpit?swarm=ws-2`);
  openCockpit(page(other).win, { swarm: 'ws-1', host: 'browser' });
  assert.equal(other.replaced, `${BASE}/cockpit?swarm=ws-1`);
  assert.deepEqual(openCockpit(page(null).win, { swarm: 'ws-1', host: 'browser' }), { url: `${BASE}/cockpit?swarm=ws-1`, reason: 'blocked', copied: null });
});

test('copying uses the clipboard, then the selected address, and says when neither works', async () => {
  const selection = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(range) { this.ranges.push(range); } };
  const doc = ok => ({ createRange: () => ({ selectNodeContents(el) { this.el = el; } }), getSelection: () => selection, execCommand: () => ok });
  assert.equal(await copyAddress({ clipboard: { writeText: async () => {} } }, doc(false), {}, 'u'), true);
  assert.equal(await copyAddress({ clipboard: { writeText: async () => { throw new Error('denied'); } } }, doc(true), {}, 'u'), true);
  assert.equal(selection.ranges.length, 1, 'the address stays selected');
  assert.equal(await copyAddress({}, doc(false), {}, 'u'), false);
});

test('the regular view opens what the cockpit asks for in place, or loads the swarm it names', () => {
  const view = { snapshot: { run: { id: 'ws-1' } } };
  assert.equal(showRequest(view, { kind: 'other' }), null);
  assert.equal(showRequest(view, null), null);
  assert.deepEqual(showRequest(view, { kind: SHOW, swarm: 'ws-1', detail: 'u1', tab: 'cards' }), { detail: 'u1', tab: 'cards' });
  assert.deepEqual(showRequest(view, { kind: SHOW, swarm: 'ws-1', detail: null, tab: 'bogus' }), { detail: null, tab: null });
  assert.deepEqual(showRequest(view, { kind: SHOW, swarm: 'ws-2', detail: 'u1', tab: null }), { reload: '/?swarm=ws-2&detail=u1' });
  assert.deepEqual(showRequest({ snapshot: null }, { kind: SHOW, swarm: 'ws-1', detail: null, tab: 'board' }), { reload: '/?swarm=ws-1&tab=board' });
});

test('the cockpit sends its request to the regular window, or opens one when it is gone', () => {
  const regular = target(`${BASE}/?swarm=ws-1`);
  const live = page(regular, `${BASE}/cockpit?swarm=ws-1`);
  assert.equal(showInRegular(live.win, { swarm: 'ws-1', detail: 'u1', tab: null }), true);
  assert.deepEqual(live.calls, [['', REGULAR_WINDOW, undefined]]);
  assert.deepEqual(regular.messages, [{ data: { kind: SHOW, swarm: 'ws-1', detail: 'u1', tab: null }, origin: BASE }]);
  assert.equal(regular.focused, true);
  const blank = target('about:blank');
  showInRegular(page(blank, `${BASE}/cockpit?swarm=ws-1`).win, { swarm: 'ws-1', detail: null, tab: 'board' });
  assert.equal(blank.replaced, `${BASE}/?swarm=ws-1&tab=board`);
  assert.equal(showInRegular(page(null, `${BASE}/cockpit?swarm=ws-1`).win, { swarm: 'ws-1', detail: null, tab: null }), false);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-link.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-link.mjs'`.

- [ ] **Step 3: Write the module**

```js
// ui/cockpit-link.mjs
/**
 * How the regular view and the cockpit reach each other. The regular window names itself REGULAR_WINDOW when it opens
 * the cockpit in a window named COCKPIT_WINDOW; the cockpit finds the regular window by that name and sends it a
 * same-origin message, so it shows a unit's details without reloading. Both windows are in one browsing context group,
 * so a name lookup finds them. The app's side panel cannot open windows: there the control shows the address instead.
 */
import { esc } from './format.mjs';

export const REGULAR_WINDOW = 'swarm-dashboard';
export const COCKPIT_WINDOW = 'swarm-cockpit';
export const SHOW = 'swarm-dashboard:show';
export const TABS = Object.freeze(['cards', 'timeline', 'plan', 'board']);

export const cockpitPath = swarm => `/cockpit?${new URLSearchParams({ swarm })}`;

export function regularPath({ swarm, detail = null, tab = null }) {
  const query = new URLSearchParams();
  if (swarm) query.set('swarm', swarm);
  if (TABS.includes(tab)) query.set('tab', tab);
  if (detail) query.set('detail', detail);
  return `/?${query}`;
}

export const cockpitControlHtml = view => (view.page === 'live' && view.snapshot ? '<div class="seg ck-open"><button type="button" data-cockpit>Cockpit</button></div>' : '');

export function cockpitAddressHtml(note) {
  if (!note) return '';
  const lead = note.reason === 'blocked' ? 'The browser blocked the new window. Open this address instead:' : 'Open this address in your browser:';
  const said = note.copied === true ? 'Copied' : note.copied === false ? 'Select the address and copy it' : '';
  return `<div class="ck-addr" role="status"><span class="small muted">${lead}</span><span class="code ck-addr-url">${esc(note.url)}</span>`
    + `<button type="button" class="link" data-cockpit-copy>Copy</button>${said ? `<span class="small muted">${said}</span>` : ''}</div>`;
}

const hrefOf = win => {
  try {
    return win.location.href;
  } catch {
    return null;
  }
};

/** Open or focus the cockpit for a swarm. Returns the address to show when no window can open, else null. */
export function openCockpit(win, { swarm, host }) {
  const url = new URL(cockpitPath(swarm), win.location.href).href;
  if (host === 'canvas') return { url, reason: 'canvas', copied: null };
  win.name = REGULAR_WINDOW;
  const { availWidth, availHeight } = win.screen;
  const cockpit = win.open('', COCKPIT_WINDOW, `popup=yes,left=0,top=0,width=${availWidth},height=${availHeight}`);
  if (!cockpit) return { url, reason: 'blocked', copied: null };
  const shown = hrefOf(cockpit);
  const same = shown !== null && shown !== 'about:blank' && new URL(shown).pathname === '/cockpit' && new URL(shown).searchParams.get('swarm') === swarm;
  if (!same) cockpit.location.replace(url);
  cockpit.focus();
  return null;
}

/** Copy the address: the clipboard first, then the selected address. Leaves the address selected either way. */
export async function copyAddress(nav, doc, el, url) {
  try {
    await nav.clipboard.writeText(url);
    return true;
  } catch {
    // The clipboard API can be missing or refused inside the app's panel.
  }
  try {
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  }
}

/** What the regular view does with a cockpit's message: open a unit or tab in place, or load the swarm it names. */
export function showRequest(view, data) {
  if (!data || data.kind !== SHOW || typeof data.swarm !== 'string') return null;
  const detail = typeof data.detail === 'string' ? data.detail : null;
  const tab = TABS.includes(data.tab) ? data.tab : null;
  if (view.snapshot?.run.id !== data.swarm) return { reload: regularPath({ swarm: data.swarm, detail, tab }) };
  return { detail, tab };
}

/** From the cockpit: show a unit's details or a tab in the regular window, opening one when it is gone. */
export function showInRegular(win, { swarm, detail = null, tab = null }) {
  const regular = win.open('', REGULAR_WINDOW);
  if (!regular) return false;
  if (hrefOf(regular) === 'about:blank') regular.location.replace(new URL(regularPath({ swarm, detail, tab }), win.location.href).href);
  else regular.postMessage({ kind: SHOW, swarm, detail, tab }, win.location.origin);
  regular.focus();
  return true;
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-link.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-link.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-link.test.mjs
git commit -m "feat(swarm-dashboard): link the regular view and the cockpit windows"
```

---

### Task 8: Black hole and room renderer

**Files:**
- Create: `ui/cockpit-shaders.mjs`
- Create: `ui/cockpit-gl.mjs`
- Create: `scripts/lib/cockpit-scene.mjs`
- Create: `scripts/lib/cockpit-check.mjs`
- Create: `scripts/check-cockpit.mjs`
- Create: `tests/cockpit-scene.test.mjs`

**Interfaces:**
- Consumes: `DESIGN_HEIGHT`, `FOCAL`, `STILL_TIME`, `stageFor`, `viewMatrix` from Task 3; `findBrowser`, `launchBrowser`, `openPage` from `scripts/lib/cdp.mjs`; `findPlaywright`, `launchWebKit`, `openWebKitPage` from `scripts/lib/webkit.mjs`; `createDashboardServer`, `createDemoEngine`.
- Produces:
  - `SCENE` (the scene's constants) and the GLSL strings `VERTEX`, `HOLE`, `PREFILTER`, `DOWN`, `UP`, `FINAL` from `ui/cockpit-shaders.mjs`.
  - `createRenderer(canvas) → { resize(cssWidth, cssHeight, dpr, holeScale) → { holeWidth, holeHeight, width, height, hdr }, render(view, drawHole = true), readFrame() → { width, height, data: Uint8Array (RGBA, top row first) }, sync(), timed(view) → { holeMs, bloomMs, finalMs }, info() → { renderer, hdr, timer }, size() → { width, height, holeWidth, holeHeight } }` from `ui/cockpit-gl.mjs`. It throws `Error('WebGL2 is not available')` or `Error('<pass> shader: <log>')`. `view = { design: [width, height], focal, time, view: Float32Array(9), cam: [x, y, 0], exposure, bloom }`.
  - `analyseFrame(frame) → { mean, shadow, peach, stars, desk }`, `SCENE_LIMITS`, `sceneProblems(metrics, limits) → string[]` from `scripts/lib/cockpit-scene.mjs`.
  - `runCockpitChecks({ page, browser, engine, urls, options, stdout, stderr }) → Promise<{ issues: number }>` and `CHECKS` (an ordered map of check name → function) from `scripts/lib/cockpit-check.mjs`; this task adds the `scene` check.
  - `scripts/check-cockpit.mjs` with `parseArguments(argv)`, `USAGE` and `main(argv, { stdout, stderr, env })`.

- [ ] **Step 1: Write the failing Node tests**

```js
// tests/cockpit-scene.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINAL, HOLE, PREFILTER, SCENE, UP, VERTEX, DOWN } from '../ui/cockpit-shaders.mjs';
import { SCENE_LIMITS, analyseFrame, sceneProblems } from '../scripts/lib/cockpit-scene.mjs';
import { USAGE, parseArguments } from '../scripts/check-cockpit.mjs';

test('every shader is GLSL ES 3.00 with its constants filled in', () => {
  for (const source of [VERTEX, HOLE, PREFILTER, DOWN, UP, FINAL]) {
    assert.match(source, /^#version 300 es\n/);
    assert.doesNotMatch(source, /\$\{|undefined|NaN/);
  }
  for (const source of [HOLE, PREFILTER, DOWN, UP, FINAL]) assert.match(source, /precision highp float;/);
  assert.match(HOLE, /const float R0 = 21\.0;/);
  assert.match(HOLE, /const int MAX_STEPS = 380;/);
  assert.match(HOLE, /abs\(b - 2\.66\) < 0\.22/);
  assert.match(FINAL, /const float RC = 1500\.0;/);
  assert.equal(SCENE.bloomLevels, 6);
});

/** A synthetic frame: dark sky, a peach ceiling arc, stars on the left, a ring and disk around a black shadow, a dark desk. */
function syntheticFrame(width = 240, height = 150) {
  const data = new Uint8Array(width * height * 4);
  const set = (x, y, [r, g, b]) => { const i = (y * width + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) set(x, y, [6, 7, 12]);
  for (let x = 0; x < width; x += 1) set(x, 4 + Math.round(((x - width / 2) / width) ** 2 * 20), [230, 170, 150]);
  for (let k = 0; k < 40; k += 1) set(4 + ((k * 37) % 50), 20 + ((k * 23) % 40), [255, 250, 240]);
  for (let x = 60; x < 180; x += 1) for (let y = 70; y < 80; y += 1) set(x, y, [250, 190, 140]);
  for (let y = 41; y < 70; y += 1) for (let x = 100; x < 140; x += 1) set(x, y, [0, 0, 0]);
  for (let y = 80; y < 110; y += 1) for (let x = 100; x < 140; x += 1) set(x, y, [0, 0, 0]);
  for (let x = 100; x < 140; x += 1) { set(x, 40, [255, 230, 200]); set(x, 110, [255, 230, 200]); }
  return { width, height, data };
}

test('the frame analysis finds the shadow, the ceiling line, the stars and the desk', () => {
  const metrics = analyseFrame(syntheticFrame());
  assert.ok(metrics.shadow > 0.15, `shadow ${metrics.shadow}`);
  assert.ok(metrics.peach > 0.9, `peach ${metrics.peach}`);
  assert.ok(metrics.stars >= 30, `stars ${metrics.stars}`);
  assert.ok(metrics.desk < 0.05, `desk ${metrics.desk}`);
  assert.deepEqual(sceneProblems(metrics, { ...SCENE_LIMITS, mean: [0, 1] }), []);
});

test('a black frame fails every structural check', () => {
  const width = 120;
  const height = 80;
  const problems = sceneProblems(analyseFrame({ width, height, data: new Uint8Array(width * height * 4) }));
  for (const word of ['brightness', 'shadow', 'ceiling', 'stars']) assert.ok(problems.some(problem => problem.includes(word)), `${word} in ${problems.join('; ')}`);
});

test('the cockpit check takes an engine, a check name and a metrics switch', () => {
  assert.deepEqual(parseArguments([]), { engine: 'chrome', only: null, printMetrics: false, help: false });
  assert.deepEqual(parseArguments(['--engine', 'webkit', '--only', 'scene', '--print-metrics']), { engine: 'webkit', only: 'scene', printMetrics: true, help: false });
  assert.throws(() => parseArguments(['--only', 'everything']), /--only takes/);
  assert.match(USAGE, /^Usage: check-cockpit/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-scene.test.mjs`
Expected: FAIL with `Cannot find module '../ui/cockpit-shaders.mjs'`.

- [ ] **Step 3: Write the shaders**

The maths, constants and passes are the approved spike's (`cockpit-spike/gl.js`, design section 7), restructured: constants come from `SCENE`, the unused haze output is gone, and the names are the ones below. Keep every number as written here; Step 9 compares the result with the spike.

```js
// ui/cockpit-shaders.mjs
/**
 * The cockpit's scene in GLSL ES 3.00, drawn in three steps.
 * 1. HOLE, in HDR at the window's device resolution: each pixel traces a light ray around a non-rotating black hole
 *    (the orbit equation u'' + u = 1.5 u², with u = 1/r and a Schwarzschild radius of 1, integrated with RK4 up to
 *    MAX_STEPS steps) and adds the disk at every exact crossing of its plane, so the direct and lensed images appear.
 *    Pixels in the photon-ring band are traced four more times, so the ring stays thin.
 * 2. Bloom: PREFILTER keeps the bright part with a Karis average against fireflies, then DOWN and UP run a six-level chain.
 * 3. FINAL: the room (a cylindrical window with mullions, a dark ceiling with a peach light line, a desk that reflects
 *    the glow), ACES tone mapping, a vignette, sRGB and a one-step dither against banding.
 */
export const SCENE = Object.freeze({
  holeDistance: 21, inclination: 0.145, holePitch: 0.12, roll: -0.06, diskInner: 2.55, diskOuter: 12.5, maxSteps: 380,
  ringImpact: 2.66, ringBand: 0.22, starSpin: 0.0035,
  roomRadius: 1500, ceilingY: 720, deskY: -330, mullionHalf: 11,
  exposure: 0.85, bloom: 0.8, bloomLevels: 6, bloomThreshold: 0.9, bloomKnee: 0.6,
});

/** A GLSL float literal. */
const f = value => (Number.isInteger(value) ? `${value}.0` : String(value));

export const VERTEX = `#version 300 es
const vec2 CORNERS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(CORNERS[gl_VertexID], 0.0, 1.0); }`;

const COMMON = `
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

export const HOLE = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec2 uDesign;
uniform float uFocal;
uniform float uTime;
uniform mat3 uView;
uniform float uPix;
out vec4 outColor;
${COMMON}
const float PI = 3.14159265;
const float R0 = ${f(SCENE.holeDistance)};
const float INCL = ${f(SCENE.inclination)};
const float HOLE_PITCH = ${f(SCENE.holePitch)};
const float ROLL = ${f(SCENE.roll)};
const float RIN = ${f(SCENE.diskInner)};
const float ROUT = ${f(SCENE.diskOuter)};
const int MAX_STEPS = ${SCENE.maxSteps};

float vnoise(vec3 p) {
  vec3 i = floor(p); vec3 w = fract(p);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), g = hash13(i + vec3(1, 0, 1)), h = hash13(i + vec3(0, 1, 1)), k = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

// Value noise periodic in x, so the disk's pattern wraps cleanly around the orbit.
float vnoisePeriodic(vec2 p, float period) {
  vec2 i = floor(p); vec2 w = fract(p);
  vec2 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float i0 = mod(i.x, period), i1 = mod(i.x + 1.0, period);
  float a = hash12(vec2(i0, i.y)), b = hash12(vec2(i1, i.y));
  float c = hash12(vec2(i0, i.y + 1.0)), d = hash12(vec2(i1, i.y + 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Orbit-stretched fbm. An octave fades to its mean once it would alias, and the loop stops when the rest would add only their mean.
const float FBM_TOTAL = 1.0804;
float streaks(float r, float ang, float footprint) {
  float x = fract((ang + 0.35 * log(r)) / 6.2831853);
  float n = 0.0, amp = 0.5, used = 0.0, freq = 3.0, period = 10.0;
  for (int i = 0; i < 6; i++) {
    float cycles = max(freq, period / (6.2831853 * r)) * footprint;
    float detail = 1.0 - smoothstep(0.15, 0.4, cycles);
    if (detail <= 0.0) break;
    n += amp * mix(0.5, vnoisePeriodic(vec2(x * period, r * freq + float(i) * 7.31), period), detail);
    used += amp;
    freq *= 2.1; period *= 2.0; amp *= 0.55;
  }
  return (n + 0.5 * (FBM_TOTAL - used)) / FBM_TOTAL;
}

vec3 diskColor(float t) {
  vec3 c = mix(vec3(1.00, 0.30, 0.10), vec3(1.00, 0.56, 0.28), smoothstep(0.25, 0.6, t));
  c = mix(c, vec3(1.00, 0.80, 0.62), smoothstep(0.6, 1.05, t));
  return mix(c, vec3(0.80, 0.88, 1.00), smoothstep(1.2, 1.9, t));
}

// The disk's colour and opacity where a ray crosses its plane at q, travelling along dir after pathLen of path.
vec4 disk(vec3 q, vec3 dir, float pathLen, float smoothness) {
  float r = length(q.xz);
  if (r < RIN || r > ROUT) return vec4(0.0);
  float ang = atan(q.z, q.x);
  float omega = 0.6 * pow(r, -1.5);
  float period = 120.0;
  float phase = fract(uTime / period);
  float weightA = 1.0 - abs(2.0 * phase - 1.0);
  float footprint = uPix * pathLen / max(abs(dir.y), 0.04);
  float n = 0.5;
  if (smoothness < 0.99) {
    float nA = streaks(r, ang - omega * phase * period, footprint);
    float nB = streaks(r + 5.3, ang - omega * fract(phase + 0.5) * period + 1.7, footprint);
    // Two patterns cross-fade so the turning never repeats visibly; this keeps the contrast steady through the fade.
    n = 0.5 + (mix(nB, nA, weightA) - 0.5) / sqrt(weightA * weightA + (1.0 - weightA) * (1.0 - weightA));
  }
  float inner = smoothstep(RIN, RIN + 0.7, r);
  float outer = 1.0 - smoothstep(5.0, ROUT, r);
  float profile = inner * outer * pow(3.0 / r, 1.5);
  float filament = mix(smoothstep(0.30, 0.80, n), 0.42, smoothness);
  float density = profile * (0.10 + 1.35 * filament);
  vec3 velocity = normalize(vec3(-q.z, 0.0, q.x));
  float beta = min(sqrt(0.5 / max(r - 1.0, 0.5)), 0.62);
  float gamma = inversesqrt(1.0 - beta * beta);
  float doppler = mix(1.0, 1.0 / (gamma * (1.0 - beta * dot(velocity, -dir))), 0.6);
  float shift = doppler * sqrt(max(1.0 - 1.0 / r, 0.05));
  vec3 c = diskColor(pow(3.0 / r, 0.65) * shift) * density * pow(shift, 2.6) * 6.0;
  return vec4(c, clamp(profile * (2.2 + 3.0 * filament), 0.0, 0.985));
}

vec3 rotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z); }

// The ray through a pixel, in the black hole's frame.
vec3 rayDir(vec2 frag) {
  vec2 p = frag / uRes * uDesign - 0.5 * uDesign;
  vec3 rd = uView * normalize(vec3(p, -uFocal));
  float cp = cos(HOLE_PITCH), sp = sin(HOLE_PITCH);
  rd = vec3(rd.x, rd.y * cp + rd.z * sp, -rd.y * sp + rd.z * cp);
  float cr = cos(ROLL), sr = sin(ROLL);
  rd.xy = vec2(cr * rd.x - sr * rd.y, sr * rd.x + cr * rd.y);
  vec3 up = vec3(0.0, cos(INCL), -sin(INCL));
  vec3 fwd = vec3(0.0, -sin(INCL), -cos(INCL));
  return normalize(vec3(1.0, 0.0, 0.0) * rd.x + up * rd.y - fwd * rd.z);
}

// Trace a null geodesic in its orbital plane: u = 1/r, u'' + u = 1.5 u².
void trace(vec3 dir, out vec3 col, out float alpha, out vec3 escapeDir, out float escaped, out float impact) {
  vec3 cam = R0 * vec3(0.0, sin(INCL), cos(INCL));
  vec3 e1 = cam / R0;
  float dr = dot(dir, e1);
  vec3 tv = dir - dr * e1;
  float dt = length(tv);
  vec3 e2 = dt > 1e-6 ? tv / dt : normalize(cross(e1, vec3(1.0, 0.0, 0.0)));
  dt = max(dt, 1e-6);
  impact = R0 * dt;
  float u = 1.0 / R0;
  float du = -u * dr / dt;
  float phi = 0.0;
  float nextCross = mod(atan(-e1.y, e2.y), PI);
  if (nextCross < 1e-4) nextCross += PI;
  col = vec3(0.0); alpha = 0.0; escaped = 0.0;
  float path = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    float h = clamp(0.2 / (1.0 + 12.0 * u), 0.012, 0.2);
    bool crossing = false;
    if (phi + h >= nextCross) { h = max(nextCross - phi, 1e-5); crossing = true; }
    float k1u = du,               k1v = 1.5 * u * u - u;
    float u2 = u + 0.5 * h * k1u, v2 = du + 0.5 * h * k1v;
    float k2u = v2,               k2v = 1.5 * u2 * u2 - u2;
    float u3 = u + 0.5 * h * k2u, v3 = du + 0.5 * h * k2v;
    float k3u = v3,               k3v = 1.5 * u3 * u3 - u3;
    float u4 = u + h * k3u,       v4 = du + h * k3v;
    float k4u = v4,               k4v = 1.5 * u4 * u4 - u4;
    u += h * (k1u + 2.0 * k2u + 2.0 * k3u + k4u) / 6.0;
    du += h * (k1v + 2.0 * k2v + 2.0 * k3v + k4v) / 6.0;
    phi += h;
    if (u >= 1.0) break;
    if (u <= 0.0) { escaped = 1.0; break; }
    float r = 1.0 / u;
    float cph = cos(phi), sph = sin(phi);
    vec3 radial = cph * e1 + sph * e2;
    float drdphi = -du / (u * u);
    path += h * sqrt(r * r + drdphi * drdphi);
    if (crossing) {
      nextCross += PI;
      if (r > RIN && r < ROUT) {
        vec3 tangent = -sph * e1 + cph * e2;
        vec3 travel = normalize(drdphi * radial + r * tangent);
        // Direct images keep the streaks; the photon ring (orbits past about 1.3 half-turns) is smooth.
        vec4 s = disk(r * radial, travel, path, smoothstep(1.3 * PI, 1.7 * PI, phi));
        col += (1.0 - alpha) * s.rgb;
        alpha += (1.0 - alpha) * s.a;
      }
    }
    if (alpha > 0.995) break;
    if (u < 0.035 && du < 0.0) { phi += atan(u, -du); escaped = 1.0; break; }
  }
  escapeDir = cos(phi) * e1 + sin(phi) * e2;
}

// Point stars, measured in screen pixels through the local lensing distortion, so magnified stars stay round.
vec3 starLayer(vec3 d, vec3 dx, vec3 dy, float scale, float threshold, float seed, float bright, float sigma) {
  vec3 id = floor(d * scale);
  float h = hash13(id + seed);
  if (h < threshold) return vec3(0.0);
  vec3 star = (id + 0.5 + (hash33(id + seed + 7.0) - 0.5) * 0.4) / scale;
  vec3 o = normalize(star) - d;
  o -= d * dot(o, d);
  float a = dot(dx, dx), b = dot(dx, dy), c = dot(dy, dy);
  float det = max(a * c - b * b, 1e-30);
  vec2 rhs = vec2(dot(dx, o), dot(dy, o));
  vec2 px = vec2(c * rhs.x - b * rhs.y, a * rhs.y - b * rhs.x) / det;
  float k = pow((h - threshold) / (1.0 - threshold), 4.0);
  vec3 tint = mix(vec3(1.0, 0.86, 0.74), vec3(0.78, 0.86, 1.0), hash13(id + seed + 3.0));
  return tint * bright * k * exp(-dot(px, px) / (2.0 * sigma * sigma));
}

void main() {
  vec3 col, escapeDir; float alpha, escaped, b;
  trace(rayDir(gl_FragCoord.xy), col, alpha, escapeDir, escaped, b);
  // Stars come from the centre sample: derivatives need uniform control flow.
  vec3 d = rotY(escapeDir, uTime * ${f(SCENE.starSpin)});
  vec3 dx = dFdx(d), dy = dFdy(d);
  float area = length(cross(dx, dy));
  float jump = max(length(dx), length(dy));
  vec3 sky = vec3(0.0);
  if (escaped > 0.5 && jump < 25.0 * uPix && area > 1e-14) {
    float magnification = clamp((uPix * uPix) / area, 0.25, 6.0);
    float radiansPerDesignPx = 1.0 / uFocal;
    vec3 stars = starLayer(d, dx, dy, 1.0 / (radiansPerDesignPx * 9.0), 0.955, 0.0, 3.0, 0.65)
               + starLayer(d, dx, dy, 1.0 / (radiansPerDesignPx * 6.0), 0.975, 11.0, 1.6, 0.65)
               + starLayer(d, dx, dy, 1.0 / (radiansPerDesignPx * 4.0), 0.985, 23.0, 0.8, 0.65);
    sky += stars * sqrt(magnification);
    float band = exp(-pow(dot(d, normalize(vec3(0.35, 1.0, 0.25))) * 3.2, 2.0));
    float n = vnoise(d * 3.0) * 0.6 + vnoise(d * 7.0) * 0.4;
    sky += vec3(0.020, 0.024, 0.045) * band * n * n;
    sky += vec3(0.020, 0.012, 0.030) * pow(vnoise(d * 1.7 + 4.0), 3.0);
  }
  if (abs(b - ${f(SCENE.ringImpact)}) < ${f(SCENE.ringBand)}) {
    vec3 sumCol = col; float sumAlpha = alpha; float sumEscaped = escaped;
    vec2 offsets[4] = vec2[4](vec2(0.125, 0.375), vec2(-0.375, 0.125), vec2(-0.125, -0.375), vec2(0.375, -0.125));
    for (int k = 0; k < 4; k++) {
      vec3 c2, e2; float a2, s2, b2;
      trace(rayDir(gl_FragCoord.xy + offsets[k]), c2, a2, e2, s2, b2);
      sumCol += c2; sumAlpha += a2; sumEscaped += s2;
    }
    col = sumCol / 5.0; alpha = sumAlpha / 5.0; escaped = sumEscaped / 5.0;
  }
  outColor = vec4(col + (1.0 - alpha) * escaped * sky, 1.0);
}`;

export const PREFILTER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uThresh;
uniform float uKnee;
out vec4 outColor;
${COMMON}
vec3 bright(vec3 c) {
  float l = lum(c);
  float soft = clamp(l - uThresh + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  return c * max(soft, l - uThresh) / max(l, 1e-4);
}
void main() {
  vec2 uv = gl_FragCoord.xy * 2.0 * uTexel;
  vec3 a = texture(uSrc, uv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uSrc, uv + uTexel * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(uSrc, uv + uTexel * vec2(-1.0, 1.0)).rgb;
  vec3 d = texture(uSrc, uv + uTexel * vec2(1.0, 1.0)).rgb;
  float wa = 1.0 / (1.0 + lum(a)), wb = 1.0 / (1.0 + lum(b)), wc = 1.0 / (1.0 + lum(c)), wd = 1.0 / (1.0 + lum(d));
  outColor = vec4(bright((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd)), 1.0);
}`;

export const DOWN = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform vec2 uDst;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec3 s = texture(uSrc, uv).rgb * 4.0;
  s += texture(uSrc, uv - uTexel).rgb;
  s += texture(uSrc, uv + uTexel).rgb;
  s += texture(uSrc, uv + vec2(uTexel.x, -uTexel.y)).rgb;
  s += texture(uSrc, uv - vec2(uTexel.x, -uTexel.y)).rgb;
  outColor = vec4(s / 8.0, 1.0);
}`;

export const UP = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uAdd;
uniform vec2 uTexel;
uniform vec2 uDst;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uDst;
  vec2 h = uTexel;
  vec3 s = texture(uSrc, uv + vec2(-2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(0.0, 2.0 * h.y)).rgb;
  s += texture(uSrc, uv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(2.0 * h.x, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(0.0, -2.0 * h.y)).rgb;
  s += texture(uSrc, uv + vec2(-h.x, -h.y)).rgb * 2.0;
  outColor = vec4(s / 12.0 + texture(uAdd, uv).rgb, 1.0);
}`;

export const FINAL = `#version 300 es
precision highp float;
uniform sampler2D uHole;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform vec2 uDesign;
uniform float uFocal;
uniform mat3 uView;
uniform mat3 uHoleView;
uniform vec3 uCam;
uniform float uExposure;
uniform float uBloomK;
out vec4 outColor;
${COMMON}
const float RC = ${f(SCENE.roomRadius)};
const float Y_TOP = ${f(SCENE.ceilingY)};
const float Y_DESK = ${f(SCENE.deskY)};
const float MULLION_HALF = ${f(SCENE.mullionHalf)};

vec3 rrtOdt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 c) {
  const mat3 I = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 O = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  return clamp(O * rrtOdt(I * c), 0.0, 1.0);
}
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 tone(vec3 c) { return srgb(aces(c * uExposure)); }
float mullion(float phi) { float a = abs(phi); return min(abs(a - 0.2269), min(abs(a - 0.5760), abs(a - 0.9250))) * RC; }
// A direction in the black hole pass's camera to its texture coordinate, so frames that skip the pass reuse the last one.
vec2 project(vec3 dc) { vec2 p = dc.xy * (uFocal / max(-dc.z, 1e-3)); return (p + 0.5 * uDesign) / uDesign; }
vec3 bloomAt(vec2 uv) { return tone(texture(uBloom, uv).rgb * uBloomK * 2.2); }
float line(float x, float w) { return exp(-(x * x) / (w * w)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * uDesign - 0.5 * uDesign;
  vec3 rd = uView * normalize(vec3(p, -uFocal));
  vec3 ro = uCam;
  vec2 holeUv = project(transpose(uHoleView) * rd);
  float a = dot(rd.xz, rd.xz);
  float b = 2.0 * dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - RC * RC;
  float tWall = (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a);
  float tDesk = rd.y < 0.0 ? (Y_DESK - ro.y) / rd.y : 1e9;
  vec3 bloomLin = texture(uBloom, holeUv).rgb * uBloomK;
  vec3 hole = tone(texture(uHole, holeUv).rgb + bloomLin);
  vec3 glow = tone(bloomLin * 2.2);
  vec3 blue = vec3(0.62, 0.80, 1.0);
  vec3 peach = vec3(1.0, 0.70, 0.60);
  vec3 col;
  if (tDesk < tWall) {
    vec3 h = ro + rd * tDesk;
    float rr = length(h.xz);
    float phi = atan(h.x, -h.z);
    vec2 mirrorUv = project(transpose(uHoleView) * vec3(rd.x, -rd.y, rd.z));
    vec3 reflection = bloomAt(clamp(mirrorUv, 0.0, 1.0)) * 2.6;
    float fresnel = 0.05 + 0.5 * pow(1.0 - abs(rd.y), 6.0);
    float near = smoothstep(RC * 0.35, RC, rr);
    col = vec3(0.012, 0.015, 0.022) + reflection * fresnel * near * 0.9;
    col += vec3(0.05, 0.035, 0.03) * smoothstep(RC * 0.4, RC, rr) * smoothstep(1.3, 0.0, abs(phi));
    col += blue * 0.018 * line(rr - 880.0, 260.0) * smoothstep(1.2, 0.3, abs(phi));
    col += blue * (line(rr - (RC - 10.0), 3.0) * 0.55 + line(rr - (RC - 10.0), 40.0) * 0.06);
    col += blue * (line(rr - 640.0, 2.0) * 0.30 + line(rr - 640.0, 30.0) * 0.03);
    col += vec3(0.05, 0.06, 0.08) * line(mullion(phi) / RC * rr, 1.5) * near;
  } else {
    vec3 h = ro + rd * tWall;
    float phi = atan(h.x, -h.z);
    float y = h.y;
    float md = mullion(phi);
    if (y > Y_TOP) {
      col = mix(vec3(0.034, 0.038, 0.050), vec3(0.012, 0.014, 0.020), clamp((y - Y_TOP) / 220.0, 0.0, 1.0));
      col *= 0.55 + 0.45 * smoothstep(Y_TOP, Y_TOP + 10.0, y);
      col += glow * 0.10;
      col += peach * (line(y - (Y_TOP + 16.0), 2.4) * 0.85 + line(y - (Y_TOP + 16.0), 26.0) * 0.10);
      col += vec3(0.07, 0.08, 0.10) * line(y - (Y_TOP + 70.0), 1.2);
      col += vec3(0.06, 0.07, 0.09) * line(md, 1.4) * step(Y_TOP + 70.0, y);
    } else if (md < MULLION_HALF) {
      float e = md / MULLION_HALF;
      float lit = 0.6 + 0.4 * exp(-abs(y - 250.0) / 500.0);
      col = vec3(0.020, 0.024, 0.034);
      col += vec3(0.070, 0.085, 0.110) * smoothstep(0.55, 0.95, e) * 0.55 * lit;
      col += vec3(0.050, 0.060, 0.080) * line(md, 0.9) * lit;
      col += glow * (0.12 + 0.5 * pow(e, 6.0));
    } else {
      col = hole * (0.82 + 0.18 * smoothstep(MULLION_HALF, MULLION_HALF + 60.0, md));
      col += blue * 0.035 * exp(-(y - Y_DESK) / 140.0);
      col += vec3(0.6, 0.7, 0.9) * 0.012 * line(fract((phi * RC + y * 0.6) / 900.0) - 0.5, 0.08);
      col *= smoothstep(Y_TOP, Y_TOP - 40.0, y) * 0.25 + 0.75;
    }
  }
  vec2 q = uv - 0.5;
  col *= 1.0 - 0.45 * pow(length(q * vec2(1.1, 1.4)), 2.6);
  col += (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 17.31) - 1.0) / 255.0;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;
```

- [ ] **Step 4: Write the renderer**

```js
// ui/cockpit-gl.mjs
/** The WebGL2 renderer for the cockpit's scene: the black hole pass, the bloom chain and the final room pass. */
import { DOWN, FINAL, HOLE, PREFILTER, SCENE, UP, VERTEX } from './cockpit-shaders.mjs';

function compile(gl, type, source, name) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`${name} shader: ${log}`);
  }
  return shader;
}

function program(gl, source, name) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX, `${name} vertex`));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, source, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name} shader: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i += 1) {
    const { name: uniform } = gl.getActiveUniform(p, i);
    uniforms[uniform] = gl.getUniformLocation(p, uniform);
  }
  return { p, u: uniforms };
}

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) throw new Error('WebGL2 is not available');
  // Half-float targets keep the black hole in HDR for bloom and tone mapping; without them, 8-bit targets still work.
  const hdr = Boolean(gl.getExtension('EXT_color_buffer_float'));
  const format = hdr ? gl.RGBA16F : gl.RGBA8;
  const type = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  const programs = { hole: program(gl, HOLE, 'hole'), prefilter: program(gl, PREFILTER, 'prefilter'), down: program(gl, DOWN, 'down'), up: program(gl, UP, 'up'), final: program(gl, FINAL, 'final') };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const levels = SCENE.bloomLevels;
  const targets = { hole: null, down: [], up: [] };
  let width = 0;
  let height = 0;
  let holeView = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  function target(old, w, h) {
    if (old) {
      gl.deleteTexture(old.tex);
      gl.deleteFramebuffer(old.fbo);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, gl.RGBA, type, null);
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  function use(prog, into) {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
    gl.viewport(0, 0, into ? into.w : width, into ? into.h : height);
  }
  function bind(unit, tex, location) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(location, unit);
  }

  function hole(view) {
    const { u } = programs.hole;
    use(programs.hole, targets.hole);
    gl.uniform2f(u.uRes, targets.hole.w, targets.hole.h);
    gl.uniform2f(u.uDesign, view.design[0], view.design[1]);
    gl.uniform1f(u.uFocal, view.focal);
    gl.uniform1f(u.uTime, view.time);
    gl.uniform1f(u.uPix, view.design[1] / targets.hole.h / view.focal);
    gl.uniformMatrix3fv(u.uView, false, view.view);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    holeView = view.view;
  }

  function bloom() {
    use(programs.prefilter, targets.down[0]);
    bind(0, targets.hole.tex, programs.prefilter.u.uSrc);
    gl.uniform2f(programs.prefilter.u.uTexel, 1 / targets.hole.w, 1 / targets.hole.h);
    gl.uniform1f(programs.prefilter.u.uThresh, SCENE.bloomThreshold);
    gl.uniform1f(programs.prefilter.u.uKnee, SCENE.bloomKnee);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    for (let i = 1; i < levels; i += 1) {
      const from = targets.down[i - 1];
      const into = targets.down[i];
      use(programs.down, into);
      bind(0, from.tex, programs.down.u.uSrc);
      gl.uniform2f(programs.down.u.uTexel, 1 / from.w, 1 / from.h);
      gl.uniform2f(programs.down.u.uDst, into.w, into.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    for (let i = levels - 2; i >= 0; i -= 1) {
      const from = i === levels - 2 ? targets.down[levels - 1] : targets.up[i + 1];
      const into = targets.up[i];
      use(programs.up, into);
      bind(0, from.tex, programs.up.u.uSrc);
      bind(1, targets.down[i].tex, programs.up.u.uAdd);
      gl.uniform2f(programs.up.u.uTexel, 1 / from.w, 1 / from.h);
      gl.uniform2f(programs.up.u.uDst, into.w, into.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  function final(view) {
    const { u } = programs.final;
    use(programs.final, null);
    bind(0, targets.hole.tex, u.uHole);
    bind(1, targets.up[0].tex, u.uBloom);
    gl.uniform2f(u.uRes, width, height);
    gl.uniform2f(u.uDesign, view.design[0], view.design[1]);
    gl.uniform1f(u.uFocal, view.focal);
    gl.uniformMatrix3fv(u.uView, false, view.view);
    gl.uniformMatrix3fv(u.uHoleView, false, holeView);
    gl.uniform3f(u.uCam, view.cam[0], view.cam[1], view.cam[2]);
    gl.uniform1f(u.uExposure, view.exposure);
    gl.uniform1f(u.uBloomK, view.bloom / levels);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const pixel = new Uint8Array(4);
  const pixelFloat = new Float32Array(4);
  /** Wait for the GPU: a one-pixel read cannot return before the passes that wrote it have finished. */
  function sync(into = null) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
    if (into && hdr) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixelFloat);
    else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  return {
    resize(cssWidth, cssHeight, dpr, holeScale) {
      width = Math.max(1, Math.min(4096, Math.round(cssWidth * dpr)));
      height = Math.max(1, Math.round((cssHeight * width) / cssWidth));
      canvas.width = width;
      canvas.height = height;
      const hw = Math.max(64, Math.round(width * holeScale));
      const hh = Math.max(36, Math.round(height * holeScale));
      targets.hole = target(targets.hole, hw, hh);
      for (let i = 0; i < levels; i += 1) {
        targets.down[i] = target(targets.down[i], Math.max(1, hw >> (i + 1)), Math.max(1, hh >> (i + 1)));
        if (i < levels - 1) targets.up[i] = target(targets.up[i], Math.max(1, hw >> (i + 1)), Math.max(1, hh >> (i + 1)));
      }
      return { holeWidth: hw, holeHeight: hh, width, height, hdr };
    },
    /** Draw a frame. Without drawHole the last black hole frame is reused, turned to the camera's current view. */
    render(view, drawHole = true) {
      gl.bindVertexArray(vao);
      if (drawHole) {
        hole(view);
        bloom();
      }
      final(view);
    },
    /** The frame just drawn, top row first. Call it in the same task as render(): the drawing buffer is not kept. */
    readFrame() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      const row = width * 4;
      const flipped = new Uint8Array(data.length);
      for (let y = 0; y < height; y += 1) flipped.set(data.subarray((height - 1 - y) * row, (height - y) * row), y * row);
      return { width, height, data: flipped };
    },
    sync: () => sync(null),
    /** Each pass's time in ms, each forced to finish before the next starts. */
    timed(view) {
      gl.bindVertexArray(vao);
      sync(null);
      const t0 = performance.now();
      hole(view);
      sync(targets.hole);
      const t1 = performance.now();
      bloom();
      sync(targets.up[0]);
      const t2 = performance.now();
      final(view);
      sync(null);
      return { holeMs: t1 - t0, bloomMs: t2 - t1, finalMs: performance.now() - t2 };
    },
    info() {
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), hdr, timer: Boolean(gl.getExtension('EXT_disjoint_timer_query_webgl2')) };
    },
    size: () => ({ width, height, holeWidth: targets.hole?.w ?? 0, holeHeight: targets.hole?.h ?? 0 }),
  };
}
```

- [ ] **Step 5: Write the frame analysis**

```js
// scripts/lib/cockpit-scene.mjs
/**
 * Structural checks of a rendered cockpit frame ({ width, height, data } in RGBA, top row first). Self-contained:
 * check-cockpit.mjs sends analyseFrame's source into the page, and Node tests run it on synthetic frames.
 * - mean: average luminance (0..1);
 * - shadow: the longest dark run down the centre column (under 0.15: bloom lifts the shadow above black) that bright light
 *   (over 0.5, the ring and the disk) frames within 3% of the height at both ends, as a share of the height;
 * - peach: the share of columns in the central half with a peach pixel in the top 15% (the ceiling's light line);
 * - stars: small bright points in the upper-left quarter;
 * - desk: average luminance of the bottom-centre block.
 */
export function analyseFrame(frame) {
  const { width, height, data } = frame;
  const lum = (x, y) => {
    const i = (y * width + x) * 4;
    return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  };
  let sum = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    sum += lum(x, y);
    samples += 1;
  }
  const cx = Math.floor(width / 2);
  const reach = Math.max(2, Math.ceil(height * 0.03));
  const lightBetween = (y0, y1) => {
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y += 1) if (lum(cx, y) > 0.5) return true;
    return false;
  };
  let best = 0;
  let run = 0;
  for (let y = Math.floor(height * 0.15); y <= Math.floor(height * 0.7); y += 1) {
    if (y < Math.floor(height * 0.7) && lum(cx, y) < 0.15) {
      run += 1;
    } else {
      if (run > best && lightBetween(y - run - reach, y - run - 1) && lightBetween(y, y + reach)) best = run;
      run = 0;
    }
  }
  let peachColumns = 0;
  const x0 = Math.floor(width * 0.25);
  const x1 = Math.floor(width * 0.75);
  for (let x = x0; x < x1; x += 1) {
    for (let y = 0; y < Math.floor(height * 0.15); y += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b] = [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
      if (r > 0.3 && r > g && g > b && r - b > 0.1) {
        peachColumns += 1;
        break;
      }
    }
  }
  let stars = 0;
  for (let y = 1; y < Math.floor(height * 0.45); y += 1) for (let x = 1; x < Math.floor(width * 0.25); x += 1) {
    const centre = lum(x, y);
    if (centre < 0.25) continue;
    let ring = 0;
    let higher = false;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const value = lum(x + dx, y + dy);
      ring += value;
      if (value > centre) higher = true;
    }
    if (!higher && centre > 2 * (ring / 8)) stars += 1;
  }
  let desk = 0;
  let deskSamples = 0;
  for (let y = Math.floor(height * 0.94); y < height; y += 1) for (let x = Math.floor(width * 0.4); x < Math.floor(width * 0.6); x += 1) {
    desk += lum(x, y);
    deskSamples += 1;
  }
  return { mean: sum / samples, shadow: best / height, peach: peachColumns / (x1 - x0), stars, desk: desk / deskSamples };
}

/**
 * Limits for a still frame at 1440 × 900. Measured on 16 October 2026 in Chrome 155 and WebKit 27.2 (Apple M5 Pro): mean
 * 0.073, shadow 0.13, peach 1, stars 58, desk 0.034. Shadow and peach at 60% of that, stars at half, mean from half to
 * twice, desk at twice.
 */
export const SCENE_LIMITS = Object.freeze({ mean: [0.035, 0.15], shadow: 0.07, peach: 0.6, stars: 29, desk: 0.07 });

export function sceneProblems(metrics, limits = SCENE_LIMITS) {
  const problems = [];
  if (!(metrics.mean >= limits.mean[0] && metrics.mean <= limits.mean[1])) problems.push(`brightness ${metrics.mean.toFixed(3)} is outside ${limits.mean.join('–')}`);
  if (!(metrics.shadow >= limits.shadow)) problems.push(`the shadow down the centre is ${(metrics.shadow * 100).toFixed(1)}% of the height, under ${limits.shadow * 100}%`);
  if (!(metrics.peach >= limits.peach)) problems.push(`the ceiling line shows in ${(metrics.peach * 100).toFixed(0)}% of the central columns, under ${limits.peach * 100}%`);
  if (!(metrics.stars >= limits.stars)) problems.push(`${metrics.stars} stars in the upper left, under ${limits.stars}`);
  if (!(metrics.desk <= limits.desk)) problems.push(`the desk's brightness ${metrics.desk.toFixed(3)} is over ${limits.desk}`);
  return problems;
}
```

- [ ] **Step 6: Write the check library and command (the scene check)**

```js
// scripts/lib/cockpit-check.mjs
import { analyseFrame, sceneProblems } from './cockpit-scene.mjs';

/** Runs in the page: draws a still frame in a full-window canvas from the page's own modules, then a reprojected one. */
async function renderStill(analyse) {
  const load = name => import(new URL(`/ui/${name}`, location.href).href);
  const [gl, space, shaders] = await Promise.all([load('cockpit-gl.mjs'), load('cockpit-space.mjs'), load('cockpit-shaders.mjs')]);
  const canvas = document.createElement('canvas');
  // Sized in px: 100vw leaves out a hidden scrollbar's width, and the canvas would then be scaled.
  canvas.style.cssText = `position:fixed;left:0;top:0;z-index:9;width:${innerWidth}px;height:${innerHeight}px`;
  document.body.append(canvas);
  let renderer;
  try {
    renderer = gl.createRenderer(canvas);
  } catch (error) {
    return { error: error.message };
  }
  renderer.resize(innerWidth, innerHeight, devicePixelRatio || 1, 1);
  const view = (time, yaw) => ({ design: [space.stageFor(innerWidth, innerHeight).designWidth, space.DESIGN_HEIGHT], focal: space.FOCAL, time, view: space.viewMatrix(yaw, 0), cam: [0, 0, 0], exposure: shaders.SCENE.exposure, bloom: shaders.SCENE.bloom });
  renderer.render(view(space.STILL_TIME, 0), true);
  const still = analyse(renderer.readFrame());
  renderer.render(view(space.STILL_TIME, 0.01), false);
  const reused = analyse(renderer.readFrame());
  renderer.render(view(space.STILL_TIME, 0), true);
  return { info: renderer.info(), still, reused };
}

async function checkScene({ page, urls, options, stdout, stderr }) {
  const url = `${Object.values(urls)[0]}?host=browser`;
  await page.goto(url, 1440, 900);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
  const result = await page.evaluate(`(${renderStill})(${analyseFrame})`);
  if (result.error) {
    stderr.write(`scene: ${result.error}\n`);
    return 1;
  }
  const problems = sceneProblems(result.still);
  const drift = Math.abs(result.reused.mean - result.still.mean) / result.still.mean;
  if (drift > 0.25) problems.push(`a frame that reuses the black hole differs in brightness by ${(drift * 100).toFixed(0)}%`);
  if (options.printMetrics) stdout.write(`scene metrics: ${JSON.stringify(result.still)}\n`);
  stdout.write(`Scene (${result.info.renderer}, ${result.info.hdr ? 'HDR' : '8-bit'} targets): ${problems.length ? `${problems.length} problems` : 'shadow, ring, ceiling line, stars and desk in place'}.\n`);
  for (const problem of problems) stderr.write(`scene: ${problem}\n`);
  return problems.length;
}

/** The cockpit's checks in the order they run. Later tasks add layout, links and slowdown. */
export const CHECKS = new Map([['scene', checkScene]]);

export async function runCockpitChecks(context) {
  let issues = 0;
  for (const [name, check] of CHECKS) {
    if (context.options.only && context.options.only !== name) continue;
    issues += await check(context);
  }
  return { issues };
}
```

```js
// scripts/check-cockpit.mjs
#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { findBrowser, launchBrowser, openPage } from './lib/cdp.mjs';
import { CHECKS, runCockpitChecks } from './lib/cockpit-check.mjs';
import { findPlaywright, launchWebKit, openWebKitPage } from './lib/webkit.mjs';

export const USAGE = `Usage: check-cockpit [--engine chrome|webkit] [--only <check>] [--print-metrics]

Checks the swarm cockpit in a local headless Chrome, Chromium or Edge (CHROME_PATH picks one), or in Playwright's
WebKit with --engine webkit (PLAYWRIGHT_CORE, as for check-layout), against the synthetic example swarm.
--only runs one check: ${[...CHECKS.keys()].join(', ')}. --print-metrics prints the scene's measurements.
npm run check:layout runs these checks too.
`;

export function parseArguments(argv) {
  const options = { engine: 'chrome', only: null, printMetrics: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--print-metrics') options.printMetrics = true;
    else if (arg === '--engine') {
      options.engine = argv[++index];
      if (options.engine !== 'chrome' && options.engine !== 'webkit') throw new Error('--engine takes chrome or webkit');
    } else if (arg === '--only') {
      options.only = argv[++index];
      if (!CHECKS.has(options.only)) throw new Error(`--only takes ${[...CHECKS.keys()].join(', ')}`);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
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
  let browser;
  if (options.engine === 'webkit') {
    const entry = findPlaywright(env);
    const launched = entry ? await launchWebKit(entry) : { skip: 'Playwright is not available. Install playwright-core outside this repository and set PLAYWRIGHT_CORE (see the README).' };
    if (launched.skip) {
      stdout.write(`WebKit check skipped: ${launched.skip}\n`);
      return 0;
    }
    browser = launched.browser;
  } else {
    const executable = findBrowser(env);
    if (!executable) {
      stderr.write('No local Chrome, Chromium or Edge was found. Install one or set CHROME_PATH.\n');
      return 2;
    }
    browser = await launchBrowser(executable);
  }
  const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: false }), port: 0, version: 'cockpit-check', hub: { engineIdleMs: 600000 } });
  try {
    await server.listen();
    stdout.write(`Browser: ${browser.product}\n`);
    const page = options.engine === 'webkit' ? await openWebKitPage(browser) : await openPage(browser);
    const { issues } = await runCockpitChecks({ page, browser, engine: options.engine, urls: { example: server.url }, options, stdout, stderr });
    return issues ? 1 : 0;
  } finally {
    await server.close();
    await browser.close();
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 7: Run the Node tests to make sure they pass**

Run: `node --test tests/cockpit-scene.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 8: Run the scene check in both engines**

Run: `node scripts/check-cockpit.mjs --only scene --print-metrics`
Then: `PLAYWRIGHT_CORE=<playwright-core folder outside the repository> node scripts/check-cockpit.mjs --engine webkit --only scene --print-metrics`
Expected: both print `scene metrics: {…}` close to the values in the `SCENE_LIMITS` comment and exit 0. If a metric differs a lot from those values, save a screenshot of the harness outside the repository, look at it, and report it before changing a limit.

- [ ] **Step 9: Compare with the approved spike (local only, not committed)**

With the spike served read-only (its folder is outside the repository), take a screenshot of the spike at 1440 × 900 with reduced motion and its panels hidden by an injected style `.panel, #hud-line { display: none }`, and a screenshot of the harness canvas from Step 8 at the same size, after emptying the page with `document.body.replaceChildren()` (a scrolling page leaves the capture's right edge outside the canvas). Clip both captures to the window. Use a throwaway script outside the repository built on `scripts/lib/cdp.mjs`. Expected: the mean absolute difference over all pixels and channels is under 0.5/255; on 16 October 2026 the port in this plan matched the spike exactly (0/255) in Chrome. Report the value in the task's report. A larger difference means the port changed a number; find it before going on.

- [ ] **Step 10: Run the whole suite and commit**

Run: `npm test && npm run validate`
Expected: PASS.

Review amendments (16 October 2026), applied in a follow-up commit after this task's review:
- Stars are counted only in rows 12% to 45% of the height (below the ceiling's light line) and only as point peaks: a pixel over 0.25 whose eight neighbours are all under 0.8 times its brightness. A synthetic frame without stars must fail the stars check. `SCENE_LIMITS.stars` is half the newly measured count.
- The scene check counts browser errors recorded while it runs.
- The renderer caps both dimensions to the device's texture and viewport limits (and 4096), keeping the aspect ratio; checks each render target's framebuffer status; falls back once from half-float to 8-bit targets; and otherwise throws a clear error.
- Shader curves with reversed edges use `1.0 - smoothstep(low, high, x)`, which GLSL ES defines; the result is the same, and the spike comparison is repeated.
- The reused frame gets the same structural check as the still frame.

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit-shaders.mjs ghcp/plugins/swarm-dashboard/ui/cockpit-gl.mjs ghcp/plugins/swarm-dashboard/scripts/lib/cockpit-scene.mjs ghcp/plugins/swarm-dashboard/scripts/lib/cockpit-check.mjs ghcp/plugins/swarm-dashboard/scripts/check-cockpit.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-scene.test.mjs
git commit -m "feat(swarm-dashboard): draw the cockpit's black hole and room with WebGL2"
```

---

### Task 9: Cockpit styles

Builder decisions B1 to B3, B7 and B8 apply (confirmed). This task sets the look; compare the result with the approved spike's screenshots (`cockpit-hq-1440.png`, `cockpit-hq-1920.png`, outside the repository) once Task 11 renders the page.

**Files:**
- Create: `ui/cockpit.css`
- Create: `tests/cockpit-styles.test.mjs`

**Interfaces:**
- Consumes: the markup contract of Tasks 1 and 6; `PANELS` from Task 4.
- Produces: the page's look; the states `html[data-gl="off"]` (no WebGL2: a dark CSS backdrop whose brightest colour is `rgb(26, 20, 16)`), `html[data-fit="small"|"crowded"]` (panels hidden, note shown), `html[data-flat]` (the layout check's flat arrangement); the glass colour `--glass` as a `background-color`, so the layout audit can composite it.

Rules the CSS keeps (they make the audit's numbers hold):
- Panels draw their 1 px frame with an inset `box-shadow`, not a border, so a panel's content box is exactly its size minus 32 px of padding. Every panel's content adds up to that box: clock 40 + 8 + 16 + 8 + 20 + 8 + 20 + 8 + 16 = 144; cost 20 + 8 + 24 + 8 + 16 + 8 + 120 = 204; needs 20 + 8 + 52 + 8 + 52 = 140; status 20 + 8 + 3 × 20 + 2 × 4 = 96; units 20 + 8 + 168 + 8 + 16 = 220; activity 20 + 8 + 192 = 220; PRs 20 + 8 + 4 × 40 + 3 × 4 = 200 (of 220).
- Tile grids are 168 px tall: full tiles 2 × 80 + 8, two-line tiles 3 × 48 + 2 × 8 (160), one-line tiles 4 × 32 + 3 × 8 (152).
- The activity rows' font is monospace, so the label column's `ch` width matches the monospace labels; the row's text switches back to the sans font.
- The glass is `background-color`; the corner accents and the darkening gradient are `background-image` on top of it.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-styles.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PANELS } from '../ui/cockpit-fit.mjs';

const css = readFileSync(new URL('../ui/cockpit.css', import.meta.url), 'utf8');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
const declarations = rules.flatMap(([selector, body]) => [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/g)].map(([, prop, value]) => [selector, prop, value.trim()]));

test('every panel has the size the arrangement uses, centred on its origin', () => {
  for (const [id, { width, height }] of Object.entries(PANELS)) {
    const body = rules.find(([selector]) => selector === `#${id}`)?.[1];
    assert.ok(body, id);
    assert.match(body, new RegExp(`width: ${width}px; height: ${height}px; left: ${-width / 2}px; top: ${-height / 2}px;`), id);
  }
});

test('type uses the approved sizes and weights; only the clock is larger; no italic, capitals or spacing', () => {
  for (const [selector, prop, value] of declarations) {
    if (prop === 'font-size') assert.ok(['12px', '14px', '18px'].includes(value) || (selector === '.ck-hm' && value === '36px'), `${selector} font-size: ${value}`);
    if (prop === 'line-height') assert.ok(['16px', '20px', '24px'].includes(value) || (selector === '.ck-hm' && value === '40px'), `${selector} line-height: ${value}`);
    if (prop === 'font-weight') assert.match(value, /^(400|500)$/, `${selector} font-weight: ${value}`);
    if (prop === 'font' && value !== 'inherit') assert.match(value, /^(400|500) (12|14|18)px\/(16|20|24)px /, `${selector} font: ${value}`);
    assert.notEqual(prop, 'letter-spacing', selector);
    assert.notEqual(prop, 'text-transform', selector);
    if (prop === 'font-style') assert.equal(value, 'normal', selector);
  }
  assert.doesNotMatch(bare, /italic|uppercase|text-shadow/);
});

test('spacing stays on the 4 px grid', () => {
  for (const [selector, prop, value] of declarations) {
    if (!/^(gap|row-gap|column-gap|padding(-[a-z]+)?|margin(-[a-z]+)?)$/.test(prop)) continue;
    for (const [, number] of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) assert.equal(Number(number) % 4, 0, `${selector} ${prop}: ${value}`);
  }
});

test('the status colours are the approved pastels on dark glass, with idle and archived dimmed', () => {
  for (const [name, value] of Object.entries({ busy: '0.84 0.07 238', idle: '0.80 0.012 250', plan: '0.89 0.08 92', question: '0.85 0.07 300', stuck: '0.78 0.11 25', blocked: '0.85 0.085 62', merged: '0.86 0.07 160', archived: '0.70 0.008 250' })) {
    assert.ok(css.includes(`--${name}: oklch(${value});`), name);
  }
  for (const state of ['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'done', 'archived', 'pr']) assert.match(bare, new RegExp(`\\.st-${state} \\{ --c: var\\(--`), state);
});

test('panels are glass with a drawn frame, motion stops on request, and nothing loads from outside', () => {
  const panel = rules.find(([selector]) => selector === '.ck-panel')[1];
  assert.match(panel, /background-color: var\(--glass\);/);
  assert.match(panel, /box-shadow: inset 0 0 0 1px var\(--line\)/);
  assert.doesNotMatch(panel, /border:/);
  assert.match(bare, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  assert.doesNotMatch(bare, /@import|url\(/);
  for (const state of ['html[data-flat] .ck-panel', 'html[data-gl="off"] body', 'html[data-fit="small"] .ck-stage', '.ck-note[hidden]']) assert.ok(bare.includes(state), state);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-styles.test.mjs`
Expected: FAIL with `ENOENT` for `ui/cockpit.css`.

- [ ] **Step 3: Write the stylesheet**

```css
/* ui/cockpit.css */
:root {
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  /* Text on dark glass. The layout check proves 4.5:1 over the brightest scene pixel behind each panel. */
  --ink: oklch(0.94 0.008 250);
  --ink-2: oklch(0.80 0.016 250);
  --ink-3: oklch(0.72 0.018 250);
  /* The regular view's pastel fills, as text and dot colours on dark glass; idle and archived are dimmed. */
  --busy: oklch(0.84 0.07 238);
  --idle: oklch(0.80 0.012 250);
  --plan: oklch(0.89 0.08 92);
  --question: oklch(0.85 0.07 300);
  --stuck: oklch(0.78 0.11 25);
  --blocked: oklch(0.85 0.085 62);
  --merged: oklch(0.86 0.07 160);
  --archived: oklch(0.70 0.008 250);
  --pr: oklch(0.86 0.06 188);
  --accent: oklch(0.84 0.07 238);
  --glass: rgb(9 13 21 / 0.88);
  --glass-top: rgb(9 13 21 / 0.8);
  --line: rgb(170 196 235 / 0.14);
  --line-2: rgb(170 196 235 / 0.28);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #020306; }
body { color: var(--ink); font: 400 14px/20px var(--sans); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; background: none; border: 0; text-align: inherit; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
ul, ol { list-style: none; }
#ck-gl { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
html[data-gl="off"] #ck-gl { display: none; }
html[data-gl="off"] body { background: radial-gradient(ellipse at 50% 38%, rgb(26 20 16) 0%, rgb(5 7 11) 55%, rgb(2 3 6) 100%); }

.ck { position: fixed; inset: 0; }
.ck-mono { font-family: var(--mono); }
.ck-dim { color: var(--ink-3); }
.ck-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The flat line at the top left, and the quality switch at the top right. */
.ck-hud { position: fixed; left: 24px; top: 16px; height: 24px; padding: 4px 8px; border-radius: 4px; background-color: var(--glass-top); font-size: 12px; line-height: 16px; color: var(--ink-2); white-space: nowrap; pointer-events: none; }
.ck-warn { color: var(--blocked); }
.ck-qual { position: fixed; right: 24px; top: 16px; display: flex; gap: 4px; height: 24px; }
.ck-qual button { height: 24px; padding: 4px 8px; border-radius: 4px; background-color: var(--glass-top); font-size: 12px; line-height: 16px; color: var(--ink-2); }
.ck-qual button[aria-pressed="true"] { color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-2); }

/* The 3D stage: a design space 900 px tall, scaled to the window's height; cockpit.mjs sets its size, perspective and scale. */
.ck-stage { position: fixed; left: 0; top: 0; transform-origin: 0 0; perspective-origin: 50% 50%; }
.ck-world { position: absolute; left: 50%; top: 50%; width: 0; height: 0; transform-style: preserve-3d; }
.ck-panel {
  --acc: color-mix(in oklch, var(--accent) 70%, transparent);
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  overflow: hidden;
  border-radius: 4px;
  background-color: var(--glass);
  background-image:
    linear-gradient(var(--acc), var(--acc)), linear-gradient(var(--acc), var(--acc)), linear-gradient(var(--acc), var(--acc)), linear-gradient(var(--acc), var(--acc)),
    linear-gradient(var(--acc), var(--acc)), linear-gradient(var(--acc), var(--acc)), linear-gradient(var(--acc), var(--acc)), linear-gradient(var(--acc), var(--acc)),
    linear-gradient(180deg, transparent, rgb(2 3 6 / 0.35));
  background-size: 12px 1px, 1px 12px, 12px 1px, 1px 12px, 12px 1px, 1px 12px, 12px 1px, 1px 12px, 100% 100%;
  background-position: left top, left top, right top, right top, left bottom, left bottom, right bottom, right bottom, 0 0;
  background-repeat: no-repeat;
  box-shadow: inset 0 0 0 1px var(--line), 0 0 0 1px rgb(0 0 0 / 0.35), 0 0 32px rgb(120 170 230 / 0.07);
  backface-visibility: hidden;
  cursor: pointer;
}
#ck-clock { width: 280px; height: 176px; left: -140px; top: -88px; }
#ck-cost { width: 280px; height: 236px; left: -140px; top: -118px; }
#ck-needs { width: 280px; height: 172px; left: -140px; top: -86px; --acc: color-mix(in oklch, var(--question) 70%, transparent); }
#ck-status { width: 280px; height: 128px; left: -140px; top: -64px; }
#ck-activity { width: 320px; height: 252px; left: -160px; top: -126px; }
#ck-units { width: 536px; height: 252px; left: -268px; top: -126px; }
#ck-prs { width: 320px; height: 252px; left: -160px; top: -126px; }

.ck-ph { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 20px; min-width: 0; }
.ck-t { flex: none; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.ck-t:hover { color: var(--ink); }
.ck-side { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; color: var(--ink-3); text-align: right; }
.ck-big { font-size: 18px; line-height: 24px; font-weight: 500; color: var(--ink); }
.ck-ph .ck-big { line-height: 20px; }
.ck-meta { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.ck-empty { font-size: 12px; line-height: 16px; color: var(--ink-3); }

/* Clock. */
.ck-clock { display: flex; align-items: baseline; gap: 4px; height: 40px; }
.ck-hm { font-size: 36px; line-height: 40px; font-weight: 400; color: var(--ink); }
.ck-s { font-size: 14px; line-height: 20px; color: var(--ink-3); }
.ck-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; height: 20px; }
.ck-k { font-size: 12px; line-height: 16px; color: var(--ink-2); }
.ck-v { font-size: 14px; line-height: 20px; color: var(--ink); white-space: nowrap; }

/* Cost. */
.ck-models { display: flex; flex-direction: column; gap: 8px; }
.ck-model { display: grid; grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; column-gap: 8px; font-size: 12px; line-height: 16px; }
.ck-model-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.ck-n { color: var(--ink-2); }
.ck-bar { grid-column: 1 / -1; height: 4px; overflow: hidden; border-radius: 4px; background-color: rgb(170 196 235 / 0.1); }
.ck-fill { display: block; height: 100%; border-radius: 4px; background-color: var(--busy); opacity: 0.75; transform: scaleX(var(--w)); transform-origin: 0 50%; transition: transform 1s ease; }

/* Needs you. */
.ck-needs-t { display: inline-flex; flex: none; align-items: center; gap: 8px; }
.ck-light { width: 12px; height: 12px; border-radius: 50%; background-color: var(--question); box-shadow: 0 0 12px 2px color-mix(in oklch, var(--question) 55%, transparent); animation: ck-pulse 3.2s ease-in-out infinite; }
.ck-light.is-off { background-color: var(--archived); box-shadow: none; opacity: 0.6; animation: none; }
.ck-needs { display: flex; flex-direction: column; gap: 8px; }
.ck-need { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: 16px 16px; row-gap: 4px; column-gap: 8px; width: 100%; padding: 8px; border-radius: 4px; background-color: rgb(255 255 255 / 0.035); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 30%, transparent); font-size: 12px; line-height: 16px; }
.ck-need .ck-lab { color: var(--c); }
.ck-kind { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.ck-age { color: var(--ink-3); text-align: right; white-space: nowrap; }
.ck-need .ck-txt { grid-column: 1 / -1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }

/* Status legend. */
.ck-leg { display: grid; grid-template-columns: 1fr 1fr; row-gap: 4px; column-gap: 16px; }
.ck-leg li { display: flex; align-items: center; gap: 8px; height: 20px; font-size: 12px; line-height: 16px; color: var(--ink-2); }
.ck-leg .ck-n { margin-left: auto; color: var(--ink); }
.ck-leg li.is-zero, .ck-leg li.is-zero .ck-n { color: var(--ink-3); }

.ck-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background-color: var(--c); box-shadow: 0 0 8px 1px color-mix(in oklch, var(--c) 50%, transparent); }
.st-busy { --c: var(--busy); }
.st-idle { --c: var(--idle); }
.st-plan { --c: var(--plan); }
.st-question { --c: var(--question); }
.st-stuck { --c: var(--stuck); }
.st-blocked { --c: var(--blocked); }
.st-merged { --c: var(--merged); }
.st-done { --c: var(--merged); }
.st-archived { --c: var(--archived); }
.st-pr { --c: var(--pr); }

/* Activity: newest at the bottom; new rows slide the list up (cockpit.mjs). */
.ck-log-window { display: flex; flex: 1; flex-direction: column; justify-content: flex-end; min-height: 0; overflow: hidden; }
.ck-log { display: flex; flex-direction: column; }
.ck-log-row { display: grid; grid-template-columns: 40px var(--lab) minmax(0, 1fr); column-gap: 8px; width: 100%; height: 20px; font-family: var(--mono); font-size: 12px; line-height: 20px; }
.ck-time { color: var(--ink-3); }
.ck-log-row .ck-lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c, var(--ink-2)); }
.ck-log-row .ck-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--sans); color: var(--ink-2); }
button.ck-log-row:hover .ck-txt { color: var(--ink); }

/* Mission control: tile density follows the count (cockpit-model.mjs). */
.ck-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); align-content: start; gap: 8px; height: 168px; }
.ck-tiles.d-full { grid-auto-rows: 80px; }
.ck-tiles.d-two { grid-auto-rows: 48px; }
.ck-tiles.d-one { grid-auto-rows: 32px; }
.ck-tile { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; min-width: 0; border-radius: 4px; background-color: color-mix(in oklch, var(--c) 7%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 16%, transparent); font-size: 12px; line-height: 16px; transition: box-shadow 0.6s ease, background-color 0.6s ease; }
.d-full > .ck-tile { grid-template-rows: 16px 16px 16px; grid-template-areas: "id age" "name name" "state state"; row-gap: 4px; padding: 12px; }
.d-two > .ck-tile { grid-template-rows: 16px 16px; grid-template-areas: "id age" "state state"; padding: 8px; }
.d-one > .ck-tile { grid-template-rows: 16px; grid-template-areas: "id age"; padding: 8px; }
.ck-tile.is-attn { background-color: color-mix(in oklch, var(--c) 13%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 42%, transparent); }
.ck-tile:hover { box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 60%, transparent); }
.ck-tile.is-new { animation: ck-flash 1.6s cubic-bezier(0.25, 1, 0.5, 1); }
.ck-id { display: flex; grid-area: id; align-items: center; gap: 8px; min-width: 0; }
.ck-tile .ck-lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.ck-tile .ck-age { grid-area: age; color: var(--ink-2); }
.ck-name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
.ck-state { grid-area: state; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c); }
.ck-tile.ck-more { --c: var(--idle); display: flex; align-items: center; color: var(--ink-2); }
.ck-tile.st-busy .ck-dot { animation: ck-breathe 3s ease-in-out infinite; }
.ck-tile.st-stuck .ck-dot { animation: ck-blink 2.4s ease-in-out infinite; }
.ck-foot { height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 16px; color: var(--ink-3); }

/* Pull requests. */
.ck-prs { display: flex; flex-direction: column; gap: 4px; }
.ck-pr { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; column-gap: 8px; width: 100%; height: 40px; padding: 4px 8px; border-radius: 4px; background-color: rgb(255 255 255 / 0.025); font-size: 12px; line-height: 16px; }
.ck-pr:hover, .ck-need:hover { background-color: rgb(255 255 255 / 0.06); }
.ck-num { color: var(--ink); }
.ck-pr-t { display: flex; flex-direction: column; min-width: 0; }
.ck-ttl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.ck-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); }
.ck-pr-s { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; color: var(--c); }

/* Below the minimum window, or too narrow for its height: the scene stays, the panels go, a note says why. */
.ck-note { position: fixed; left: 50%; top: 50%; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; width: 400px; padding: 16px; border-radius: 4px; background-color: var(--glass); box-shadow: inset 0 0 0 1px var(--line); transform: translate(-50%, -50%); }
.ck-note[hidden] { display: none; }
.ck-note p { font-size: 14px; line-height: 20px; }
.ck-note .ck-dim { font-size: 12px; line-height: 16px; }
html[data-fit="small"] .ck-stage, html[data-fit="crowded"] .ck-stage { display: none; }

/* The flat arrangement the layout check audits: the same panels side by side, without 3D. */
html[data-flat] body { overflow: auto; }
html[data-flat] .ck { position: static; display: flex; flex-direction: column; gap: 16px; padding: 16px; }
html[data-flat] .ck-hud, html[data-flat] .ck-qual { position: static; align-self: flex-start; }
html[data-flat] .ck-note { position: static; transform: none; }
html[data-flat] #ck-gl { display: none; }
html[data-flat] .ck-stage { position: static; width: auto !important; height: auto !important; transform: none !important; perspective: none !important; }
html[data-flat] .ck-world { position: static; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 16px; width: auto; height: auto; transform: none !important; }
html[data-flat] .ck-panel { position: relative; left: auto !important; top: auto !important; transform: none !important; }

@keyframes ck-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes ck-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@keyframes ck-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes ck-flash { from { box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 60%, transparent), 0 0 24px color-mix(in oklch, var(--c) 45%, transparent); } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `node --test tests/cockpit-styles.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit.css ghcp/plugins/swarm-dashboard/tests/cockpit-styles.test.mjs
git commit -m "feat(swarm-dashboard): style the cockpit's dark glass panels"
```

---

### Task 10: The cockpit's layout check

The check comes before the page so the page is built against it; it fails until Task 11.

**Files:**
- Modify: `scripts/lib/cockpit-check.mjs` (add the layout and motion checks)
- Modify: `scripts/check-cockpit.mjs` (serve the example and stress swarms; `--screenshots`)
- Create: `tests/cockpit-check.test.mjs`

**Interfaces:**
- Consumes: `auditScript` from `scripts/lib/page-audit.mjs` (unchanged); `PANELS`, `fitPanels`, `overlapProblems` from Task 4; `REST`, `extremePoses` from Task 3; the page's debug hooks from Task 11: `window.cockpitDebug = { fit(), frames(), info(), setCamera(cam), readFrame(), resume(), bench(count, every) }` (present with `?debug=1`), and `html[data-ready="1"]`, `html[data-gl]`, `html[data-fit]`.
- Produces: `COCKPIT_SIZES`, `SMALL_SIZE`, `COCKPIT_AUDIT`, `cockpitIssues(issues)`, `expandAll(rects, px)`, and the `layout` and `motion` entries of `CHECKS`.

How the layout check works, per scenario (example and stress) and window size:
1. Open `/cockpit?debug=1&quality=high` with reduced motion (the camera rests), and wait for `data-ready`.
2. The panels' DOM rectangles must be within 1 px of `fitPanels()`'s, and pass `overlapProblems()` together with the top line and the quality switch. Then at each of the 16 extreme camera poses (`cockpitDebug.setCamera`), again.
3. With the camera back at rest, read the scene's brightest pixel behind each panel, the top line and the quality switch (their rectangles grown by 32 px for the camera's reach).
4. Lay the page out flat (`html[data-flat]`), wrap each of those elements in a block filled with its scene colour, and run the dashboard's own audit (`page-audit.mjs`) with `COCKPIT_AUDIT`: overlap, clipped text, type, the 4 px grid, padding, heights and contrast, now measured against glass over the brightest scene pixel. The audit's single-font rule is relaxed for monospace text in `.ck-mono`, and two extra rules keep 36 px to the clock and monospace to numbers and labels.
5. Also: a 1024 × 700 window shows the note and no panels; `?gl=0` shows the panels over the CSS backdrop (scene colour `rgb(26, 20, 16)`); console errors fail the state.

The motion check (Chrome only): under reduced motion the frame counter does not move for 600 ms; without it, the page draws 20 to 33 frames in a second.

- [ ] **Step 1: Write the failing Node tests**

```js
// tests/cockpit-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, COCKPIT_AUDIT, COCKPIT_SIZES, SMALL_SIZE, cockpitIssues, expandAll } from '../scripts/lib/cockpit-check.mjs';
import { parseArguments } from '../scripts/check-cockpit.mjs';
import { COCKPIT_SIZES as FIT_SIZES } from './helpers/cockpit.mjs';

test('the cockpit is checked at the window sizes the arrangement is tested at, and in a small window', () => {
  assert.deepEqual(COCKPIT_SIZES, FIT_SIZES);
  assert.deepEqual(SMALL_SIZE, [1024, 700]);
  assert.deepEqual([...CHECKS.keys()], ['scene', 'layout', 'motion']);
});

test('the audit uses the approved type scale plus the clock, and even padding for panels and tiles', () => {
  assert.equal(COCKPIT_AUDIT.root, '.ck');
  assert.equal(COCKPIT_AUDIT.minContrast, 4.5);
  assert.deepEqual(COCKPIT_AUDIT.sizes, [12, 14, 18, 36]);
  assert.deepEqual(COCKPIT_AUDIT.weights, [400, 500]);
  assert.deepEqual(COCKPIT_AUDIT.padding, { '.ck-panel': 16, '.d-full > .ck-tile': 12, '.d-two > .ck-tile': 8, '.d-one > .ck-tile': 8, '.ck-need': 8, '.ck-note': 16 });
});

test('monospace is not a font-family issue; everything else is kept', () => {
  const issues = [
    { rule: 'font-family', target: 'span.ck-mono', detail: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
    { rule: 'font-family', target: 'span', detail: 'Georgia, serif' },
    { rule: 'contrast', target: 'span', detail: '3.20:1' },
  ];
  assert.deepEqual(cockpitIssues(issues).map(issue => issue.rule), ['font-family', 'contrast']);
});

test('rectangles grow by the camera\'s reach before the scene is sampled', () => {
  assert.deepEqual(expandAll({ a: { left: 10, top: 20, right: 30, bottom: 40 } }, 32), { a: { left: -22, top: -12, right: 62, bottom: 72 } });
});

test('the command can save screenshots of the synthetic swarms', () => {
  assert.equal(parseArguments(['--screenshots', '/tmp/x']).screenshots, '/tmp/x');
  assert.throws(() => parseArguments(['--screenshots']), /--screenshots takes a folder/);
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-check.test.mjs`
Expected: FAIL: `COCKPIT_AUDIT` is not exported.

- [ ] **Step 3: Add the layout and motion checks**

In `scripts/lib/cockpit-check.mjs`, add these imports at the top:

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fitPanels, overlapProblems } from '../../ui/cockpit-fit.mjs';
import { REST, extremePoses } from '../../ui/cockpit-space.mjs';
import { auditScript } from './page-audit.mjs';
```

and this code above `CHECKS`:

```js
export const COCKPIT_SIZES = Object.freeze([[1100, 800], [1280, 800], [1440, 900], [1512, 900], [1680, 1050], [1920, 1080], [2560, 1440]]);
export const SMALL_SIZE = Object.freeze([1024, 700]);
/** The brightest colour of the CSS backdrop shown without WebGL2 (cockpit.css). */
const NO_GL_BACKDROP = [26, 20, 16];
export const COCKPIT_AUDIT = Object.freeze({
  root: '.ck',
  minContrast: 4.5,
  sizes: [12, 14, 18, 36],
  lineHeights: [16, 20, 24, 40],
  weights: [400, 500],
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
  atoms: '.ck-panel,.ck-tile,.ck-need,.ck-pr,.ck-log-row,.ck-model,.ck-leg li,.ck-row,.ck-dot,.ck-light,.ck-bar,.ck-hud,.ck-qual button,.ck-note button',
  containers: '.ck-panel,.ck-tile,.ck-need,.ck-pr,.ck-log-row,.ck-note,.ck',
  follows: [],
  padding: { '.ck-panel': 16, '.d-full > .ck-tile': 12, '.d-two > .ck-tile': 8, '.d-one > .ck-tile': 8, '.ck-need': 8, '.ck-note': 16 },
  heights: { '.ck-ph': 20, '.ck-hud': 24, '.ck-qual button': 24, '.ck-pr': 40, '.ck-log-row': 20, '.ck-leg li': 20, '.ck-dot': 8, '.ck-light': 12, '.ck-bar': 4, '.d-full > .ck-tile': 80, '.d-two > .ck-tile': 48, '.d-one > .ck-tile': 32 },
});
const MONO = 'ui-monospace,sfmono,menlo,consolas,monospace';
const normalise = family => family.replace(/["'\s]/g, '').toLowerCase();

/** The audit's issues without the single-font rule's complaints about monospace, which cockpitExtras() polices instead. */
export const cockpitIssues = issues => issues.filter(issue => !(issue.rule === 'font-family' && normalise(issue.detail) === MONO));

export const expandAll = (rects, px) => Object.fromEntries(Object.entries(rects).map(([id, r]) => [id, { left: r.left - px, top: r.top - px, right: r.right + px, bottom: r.bottom + px }]));

/** Runs in the page: the visible panels, top line, quality switch and note, in window px. */
function readRects() {
  const out = {};
  for (const el of document.querySelectorAll('.ck-panel, .ck-hud, .ck-qual, .ck-note')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out[el.id] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return out;
}

/** Runs in the page: the brightest scene pixel behind each rectangle, from a still frame at the current camera. */
function sceneBackdrops(rects) {
  const frame = window.cockpitDebug.readFrame();
  const k = frame.width / innerWidth;
  const out = {};
  for (const [id, r] of Object.entries(rects)) {
    let best = [0, 0, 0];
    let top = -1;
    const x0 = Math.max(0, Math.floor(r.left * k));
    const x1 = Math.min(frame.width, Math.ceil(r.right * k));
    const y0 = Math.max(0, Math.floor(r.top * k));
    const y1 = Math.min(frame.height, Math.ceil(r.bottom * k));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const i = (y * frame.width + x) * 4;
      const lum = 0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2];
      if (lum > top) {
        top = lum;
        best = [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
      }
    }
    out[id] = best;
  }
  return out;
}

/** Runs in the page: lay the cockpit out flat and put each element on a block of the scene colour behind it. */
function prepareFlat(backdrops) {
  document.documentElement.dataset.flat = '1';
  for (const [id, [r, g, b]] of Object.entries(backdrops)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const block = document.createElement('div');
    block.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
    el.replaceWith(block);
    block.append(el);
  }
}

/** Runs in the page: 36 px only for the clock, and monospace only in numbers, labels and times. */
function cockpitExtras() {
  const issues = [];
  const probe = document.querySelector('.ck-mono');
  const mono = probe ? getComputedStyle(probe).fontFamily : null;
  for (const el of document.querySelectorAll('.ck *')) {
    if (![...el.childNodes].some(node => node.nodeType === 3 && node.nodeValue.trim())) continue;
    const style = getComputedStyle(el);
    if (parseFloat(style.fontSize) === 36 && !el.matches('.ck-hm')) issues.push({ rule: 'clock-only', target: el.className, detail: '36 px outside the clock' });
    if (mono && style.fontFamily === mono && !el.closest('.ck-mono')) issues.push({ rule: 'mono', target: el.className, detail: 'monospace outside numbers and labels' });
  }
  return issues;
}

/** One cockpit state: open it, check the arrangement in 3D, then audit it flat over its scene colours. */
async function checkState({ page, options }, { url, width, height, expect, label }) {
  page.errors.length = 0;
  await page.goto(url, width, height);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
  const problems = [];
  const shown = await page.evaluate("({ gl: document.documentElement.dataset.gl, fit: document.documentElement.dataset.fit, note: !document.getElementById('ck-note').hidden })");
  if (shown.fit !== expect.fit) problems.push(`the arrangement is ${shown.fit}, not ${expect.fit}`);
  if (shown.gl !== expect.gl) problems.push(`WebGL is ${shown.gl}, not ${expect.gl}`);
  if (shown.note !== (expect.fit !== 'ok')) problems.push(shown.note ? 'the note shows over the panels' : 'the note is missing');
  const rects = await page.evaluate(`(${readRects})()`);
  if (expect.fit === 'ok') {
    const fit = fitPanels(width, height);
    const s = fit.stage.scale;
    for (const [id, want] of Object.entries(fit.rects)) {
      const got = rects[id];
      const off = got ? Math.max(Math.abs(got.left - want.left), Math.abs(got.top - want.top), Math.abs(got.right - want.right), Math.abs(got.bottom - want.bottom)) : Infinity;
      if (off > 1) problems.push(`${id} is ${off.toFixed(1)} px from where the arrangement puts it`);
    }
    problems.push(...overlapProblems(rects, { width, height, top: 0, edge: 8, clear: 8 * s }));
    for (const cam of extremePoses()) {
      await page.evaluate(`cockpitDebug.setCamera(${JSON.stringify(cam)})`);
      const moved = await page.evaluate(`(${readRects})()`);
      problems.push(...overlapProblems(moved, { width, height, top: 0, edge: 0, clear: 4 * s }).map(problem => `at the camera's limit, ${problem}`));
    }
    await page.evaluate(`cockpitDebug.setCamera(${JSON.stringify(REST)})`);
  }
  if (options.screenshots) writeFileSync(path.join(options.screenshots, `${label.replace(/[^\w]+/g, '-')}.png`), await page.screenshot());
  const backdrops = expect.gl === 'off'
    ? Object.fromEntries(Object.keys(rects).map(id => [id, NO_GL_BACKDROP]))
    : await page.evaluate(`(${sceneBackdrops})(${JSON.stringify(expandAll(rects, 32))})`);
  const result = await page.evaluate(`(() => { (${prepareFlat})(${JSON.stringify(backdrops)}); return { audit: ${auditScript(COCKPIT_AUDIT)}, extras: (${cockpitExtras})() }; })()`);
  problems.push(...[...cockpitIssues(result.audit.issues), ...result.extras].map(issue => `${issue.rule}: ${issue.target} (${issue.detail})`));
  problems.push(...page.errors.map(message => `console: ${message}`));
  return { problems: [...new Set(problems)], checks: result.audit.checks };
}

async function checkLayout(context) {
  const { urls, options, stdout, stderr } = context;
  if (options.screenshots) mkdirSync(options.screenshots, { recursive: true });
  let issues = 0;
  let checks = 0;
  const states = [];
  for (const [scenario, base] of Object.entries(urls)) {
    for (const [width, height] of COCKPIT_SIZES) states.push({ label: `${scenario} ${width}x${height}`, url: `${base}cockpit?debug=1&quality=high`, width, height, expect: { fit: 'ok', gl: 'on' } });
    states.push({ label: `${scenario} small`, url: `${base}cockpit?debug=1&quality=high`, width: SMALL_SIZE[0], height: SMALL_SIZE[1], expect: { fit: 'small', gl: 'on' } });
    states.push({ label: `${scenario} no-webgl`, url: `${base}cockpit?debug=1&quality=high&gl=0`, width: 1440, height: 900, expect: { fit: 'ok', gl: 'off' } });
  }
  for (const state of states) {
    const result = await checkState(context, state);
    checks += result.checks;
    issues += result.problems.length;
    if (result.problems.length) {
      stderr.write(`\ncockpit, ${state.label}:\n`);
      for (const problem of result.problems.slice(0, 20)) stderr.write(`  ${problem}\n`);
      if (result.problems.length > 20) stderr.write(`  and ${result.problems.length - 20} more\n`);
    }
  }
  stdout.write(`Cockpit: checked ${states.length} states (${Object.keys(urls).join(' and ')}; ${COCKPIT_SIZES.map(size => size.join(' × ')).join(', ')}; a ${SMALL_SIZE.join(' × ')} window; no WebGL): ${checks} checks, ${issues} issues.\n`);
  return issues;
}

async function framesOver(page, ms) {
  const before = await page.evaluate('cockpitDebug.frames()');
  await new Promise(resolve => setTimeout(resolve, ms));
  return (await page.evaluate('cockpitDebug.frames()')) - before;
}

async function checkMotion({ page, urls, engine, stdout, stderr }) {
  if (engine !== 'chrome') {
    stdout.write('Cockpit motion: measured in Chrome only.\n');
    return 0;
  }
  const url = `${Object.values(urls)[0]}cockpit?debug=1&quality=high`;
  await page.goto(url, 1440, 900);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
  const problems = [];
  const still = await framesOver(page, 600);
  if (still !== 0) problems.push(`under reduced motion the scene drew ${still} frames in 600 ms`);
  await page.setReducedMotion(false);
  let moving = 0;
  try {
    await framesOver(page, 300);
    moving = await framesOver(page, 1000);
  } finally {
    await page.setReducedMotion(true);
  }
  if (moving < 20 || moving > 33) problems.push(`with motion on the scene drew ${moving} frames in a second, outside 20–33`);
  stdout.write(`Cockpit motion: ${problems.length ? `${problems.length} problems` : `still under reduced motion; ${moving} frames a second otherwise`}.\n`);
  for (const problem of problems) stderr.write(`motion: ${problem}\n`);
  return problems.length;
}
```

and replace the `CHECKS` line:

```js
/** The cockpit's checks in the order they run. Tasks 12 and 13 add links and slowdown. */
export const CHECKS = new Map([['scene', checkScene], ['layout', checkLayout], ['motion', checkMotion]]);
```

- [ ] **Step 4: Serve both synthetic swarms and accept `--screenshots`**

In `scripts/check-cockpit.mjs`:
- `parseArguments` starts from `{ engine: 'chrome', only: null, printMetrics: false, screenshots: null, help: false }` and adds:

```js
    else if (arg === '--screenshots') {
      options.screenshots = argv[++index];
      if (!options.screenshots) throw new Error('--screenshots takes a folder');
    }
```

- Update the first Node test of Task 8 in `tests/cockpit-scene.test.mjs` to expect `screenshots: null` in both objects.
- In `USAGE`, add the line: `--screenshots <dir> saves a picture of each state of the synthetic swarms there, for review; do not commit them.`
- In `main`, replace the single server with one per scenario:

```js
  const servers = [];
  const urls = {};
  try {
    for (const scenario of ['example', 'stress']) {
      const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario, simulate: false }), port: 0, version: 'cockpit-check', hub: { engineIdleMs: 600000 } });
      await server.listen();
      servers.push(server);
      urls[scenario] = server.url;
    }
    stdout.write(`Browser: ${browser.product}\n`);
    const page = options.engine === 'webkit' ? await openWebKitPage(browser) : await openPage(browser);
    const { issues } = await runCockpitChecks({ page, browser, engine: options.engine, urls, options, stdout, stderr });
    return issues ? 1 : 0;
  } finally {
    for (const server of servers) await server.close();
    await browser.close();
  }
```

- [ ] **Step 5: Run the Node tests, then the check to see it fail**

Run: `node --test tests/cockpit-check.test.mjs tests/cockpit-scene.test.mjs`
Expected: PASS.
Run: `node scripts/check-cockpit.mjs --only layout`
Expected: FAIL with `Timed out waiting for … dataset.ready === '1'` (the page has no module yet).

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/scripts/lib/cockpit-check.mjs ghcp/plugins/swarm-dashboard/scripts/check-cockpit.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-check.test.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-scene.test.mjs
git commit -m "test(swarm-dashboard): check the cockpit's arrangement, type, spacing and contrast in the browser"
```

---

### Task 11: The cockpit page

**Files:**
- Create: `ui/cockpit.mjs`

**Interfaces:**
- Consumes: everything above: `morph` (`ui/morph.mjs`), `tickText` (`ui/format.mjs`), Tasks 2 to 8.
- Produces: the running page, `html[data-ready|data-gl|data-fit]`, and with `?debug=1` the `window.cockpitDebug` hooks that Tasks 10 and 14 use. Address parameters: `swarm`, `session`, `quality` (`high` or `balanced`, for checks), `gl=0` (no WebGL, for checks), `debug=1`.

- [ ] **Step 1: Run the failing check**

Run: `node scripts/check-cockpit.mjs --only layout`
Expected: FAIL (Task 10, Step 5).

- [ ] **Step 2: Write the page module**

```js
// ui/cockpit.mjs
/**
 * The swarm cockpit: the same live swarm as the regular view, on curved glass panels around a black hole. Watch-only.
 * It reads the live feed like main.mjs, renders the panels with morph(), places them in 3D (cockpit-fit.mjs) and draws
 * the scene with WebGL2 (cockpit-gl.mjs) at most 30 times a second, never while the window is hidden and only once
 * under "reduce motion".
 */
import { createRenderer } from './cockpit-gl.mjs';
import { fitPanels } from './cockpit-fit.mjs';
import { showInRegular } from './cockpit-link.mjs';
import { clockText, dateText } from './cockpit-model.mjs';
import { activityHtml, clockHtml, costHtml, hudHtml, needsHtml, noteHtml, prsHtml, qualityHtml, statusHtml, unitsHtml } from './cockpit-panels.mjs';
import { createAdaptive, drawsHole, frameDue, loopRuns, readQuality, saveQuality } from './cockpit-quality.mjs';
import { SCENE } from './cockpit-shaders.mjs';
import { DESIGN_HEIGHT, FOCAL, REST, STILL_TIME, cameraTarget, easeCamera, panelCss, viewMatrix, worldCss } from './cockpit-space.mjs';
import { tickText } from './format.mjs';
import { morph } from './morph.mjs';

const params = new URLSearchParams(location.search);
const root = document.documentElement;
const $ = id => document.getElementById(id);
const canvas = $('ck-gl');
const stage = $('ck-stage');
const world = $('ck-world');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const storage = () => localStorage;
/** How long a tile whose state changed keeps its highlight, so a render during its animation does not cut it short. */
const FRESH_MS = 1700;
const state = {
  swarm: params.get('swarm'),
  session: params.get('session'),
  snapshot: null,
  offset: 0,
  demo: false,
  connection: 'connecting',
  quality: readQuality(storage, params.get('quality')),
  fresh: new Set(),
  freshUntil: 0,
};
const now = () => Date.now() + state.offset;

let renderer = null;
try {
  if (params.get('gl') === '0') throw new Error('WebGL is turned off in the address');
  renderer = createRenderer(canvas);
  root.dataset.gl = 'on';
} catch (error) {
  root.dataset.gl = 'off';
  console.warn(`The cockpit shows its panels without the black hole: ${error.message}`);
}
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  renderer = null;
  root.dataset.gl = 'off';
});

function renderPanels() {
  const t = now();
  const s = state.snapshot;
  const fresh = performance.now() < state.freshUntil ? state.fresh : new Set();
  morph($('ck-hud'), hudHtml({ demo: state.demo, connection: state.connection, snapshot: s }));
  morph($('ck-qual'), qualityHtml(state.quality));
  morph($('ck-clock'), clockHtml(s, t));
  morph($('ck-cost'), costHtml(s, t));
  morph($('ck-needs'), needsHtml(s, t));
  morph($('ck-status'), statusHtml(s));
  morph($('ck-activity'), activityHtml(s));
  morph($('ck-units'), unitsHtml(s, t, fresh));
  morph($('ck-prs'), prsHtml(s));
}

/** New activity slides the list up by the rows it adds; the Web Animations API leaves the element's style alone for morph(). */
function slideActivity(added) {
  if (!added || reduced.matches) return;
  document.querySelector('#ck-activity .ck-log')?.animate([{ transform: `translateY(${added * 20}px)` }, { transform: 'none' }], { duration: 900, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' });
}

function applySnapshot(next) {
  const prev = state.snapshot;
  const same = Boolean(prev && next && prev.run.id === next.run.id);
  if (same) {
    const before = new Map(prev.units.map(unit => [unit.id, unit.status]));
    const changed = next.units.filter(unit => before.has(unit.id) && before.get(unit.id) !== unit.status).map(unit => unit.id);
    if (changed.length) {
      state.fresh = new Set(changed);
      state.freshUntil = performance.now() + FRESH_MS;
    }
  }
  const seen = new Set((prev?.feed ?? []).map(item => item.id));
  const added = same ? Math.min(9, next.feed.filter(item => !seen.has(item.id)).length) : 0;
  state.snapshot = next;
  renderPanels();
  slideActivity(added);
  root.dataset.ready = '1';
}

function tick() {
  const t = now();
  const { hm, s } = clockText(t);
  for (const [key, text] of [['hm', hm], ['s', s], ['date', dateText(t)]]) {
    const el = document.querySelector(`[data-clock="${key}"]`);
    if (el && el.textContent !== text) el.textContent = text;
  }
  for (const el of document.querySelectorAll('[data-t]')) {
    const text = tickText(Number(el.dataset.t), el.dataset.f, t);
    if (el.textContent !== text) el.textContent = text;
  }
  // The cost rate covers the hour up to now, so it moves even when no snapshot arrives.
  ticks += 1;
  if (ticks % 15 === 0) morph($('ck-cost'), costHtml(state.snapshot, t));
}
let ticks = 0;

let fit = null;
let cam = { ...REST };
const pointer = { x: 0, y: 0, at: -Infinity };
const adaptive = createAdaptive();
let raf = 0;
let last = null;
let frame = 0;
const started = performance.now();
const running = () => loopRuns({ hidden: document.hidden, reduced: reduced.matches });
const sceneView = time => ({ design: [fit.stage.designWidth, DESIGN_HEIGHT], focal: FOCAL, time, view: viewMatrix(cam.yaw, cam.pitch), cam: [cam.x, cam.y, 0], exposure: SCENE.exposure, bloom: SCENE.bloom });

function drawStill() {
  cam = { ...REST };
  world.style.transform = worldCss(cam);
  renderer?.render(sceneView(STILL_TIME), true);
}

function layout() {
  fit = fitPanels(innerWidth, innerHeight);
  stage.style.width = `${fit.stage.designWidth}px`;
  stage.style.height = `${DESIGN_HEIGHT}px`;
  stage.style.perspective = `${FOCAL}px`;
  stage.style.transform = `scale(${fit.stage.scale})`;
  root.dataset.fit = fit.fits ? 'ok' : fit.reason;
  $('ck-note').hidden = fit.fits;
  if (fit.fits) for (const [id, placement] of Object.entries(fit.placements)) $(id).style.transform = panelCss(placement);
  else morph($('ck-note'), noteHtml());
  try {
    renderer?.resize(innerWidth, innerHeight, devicePixelRatio || 1, adaptive.scale);
  } catch (error) {
    // The device refused the render targets: keep the panels on the plain backdrop.
    renderer = null;
    root.dataset.gl = 'off';
    console.warn(`The cockpit shows its panels without the black hole: ${error.message}`);
  }
  if (!running()) drawStill();
}

function step(time) {
  raf = requestAnimationFrame(step);
  if (!frameDue(time, last)) return;
  const interval = last === null ? null : time - last;
  last = time;
  const seconds = (time - started) / 1000 + 20;
  cam = easeCamera(cam, cameraTarget(seconds, pointer.x, pointer.y), interval === null ? 0 : Math.min(0.1, interval / 1000));
  world.style.transform = worldCss(cam);
  renderer?.render(sceneView(seconds), drawsHole(state.quality, frame, time, pointer.at));
  frame += 1;
  if (adaptive.frame(interval) !== null) layout();
}

function start() {
  cancelAnimationFrame(raf);
  if (!running()) {
    drawStill();
    return;
  }
  last = null;
  adaptive.reset();
  raf = requestAnimationFrame(step);
}

let source = null;
let retry = null;
function connect() {
  clearTimeout(retry);
  source?.close();
  const query = new URLSearchParams();
  if (state.swarm) query.set('swarm', state.swarm);
  else if (state.session) query.set('session', state.session);
  const search = query.toString();
  source = new EventSource(`/api/events${search ? `?${search}` : ''}`);
  source.addEventListener('open', () => {
    state.connection = 'open';
    renderPanels();
  });
  source.addEventListener('error', () => {
    state.connection = 'retrying';
    renderPanels();
    if (source.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000);
  });
  source.addEventListener('hello', event => {
    const data = JSON.parse(event.data);
    state.offset = data.serverNow - Date.now();
    state.demo = Boolean(data.demo);
  });
  source.addEventListener('snapshot', event => {
    const data = JSON.parse(event.data);
    state.offset = data.serverNow - Date.now();
    applySnapshot(data.snapshot);
  });
}

$('ck').addEventListener('click', event => {
  const quality = event.target.closest('[data-quality]');
  if (quality) {
    state.quality = quality.dataset.quality;
    saveQuality(storage, state.quality);
    morph($('ck-qual'), qualityHtml(state.quality));
    return;
  }
  if (!event.target.closest('.ck-panel, .ck-note')) return;
  const el = event.target.closest('[data-detail], [data-tab]');
  const detail = el?.dataset.detail ?? null;
  showInRegular(window, { swarm: state.snapshot?.run.id ?? state.swarm, detail, tab: el?.dataset.tab ?? (detail ? null : 'cards') });
});
addEventListener('pointermove', event => {
  if (reduced.matches) return;
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = (event.clientY / innerHeight) * 2 - 1;
  pointer.at = performance.now();
});
root.addEventListener('pointerleave', () => {
  pointer.x = 0;
  pointer.y = 0;
});
let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 120);
});
document.addEventListener('visibilitychange', start);
reduced.addEventListener('change', () => {
  pointer.x = 0;
  pointer.y = 0;
  start();
});
// Browsers allow few connections per site, so free the live connection when the page goes away or into the back-forward cache.
addEventListener('pagehide', () => {
  clearTimeout(retry);
  source?.close();
  cancelAnimationFrame(raf);
});
addEventListener('pageshow', event => {
  if (event.persisted) {
    connect();
    start();
  }
});
setInterval(tick, 1000);

if (params.get('debug') === '1') {
  /** Hooks for the layout check and the GPU test. */
  window.cockpitDebug = {
    fit: () => fit,
    frames: () => frame,
    info: () => renderer?.info() ?? null,
    setCamera(next) {
      cancelAnimationFrame(raf);
      cam = { ...next };
      world.style.transform = worldCss(cam);
      return true;
    },
    readFrame() {
      if (!renderer) return null;
      renderer.render(sceneView(STILL_TIME), true);
      return renderer.readFrame();
    },
    resume: () => start(),
    /** count frames, each forced to finish; every = 2 redraws the black hole every second frame, as Balanced does. */
    bench(count = 30, every = 1) {
      if (!renderer) return null;
      cancelAnimationFrame(raf);
      renderer.sync();
      const times = [];
      for (let i = 0; i < count; i += 1) {
        const t0 = performance.now();
        renderer.render(sceneView(40 + i / 30), i % every === 0);
        renderer.sync();
        times.push(performance.now() - t0);
      }
      const passes = [];
      for (let i = 0; i < Math.min(count, 20); i += 1) passes.push(renderer.timed(sceneView(40 + i / 30)));
      start();
      return { times, passes, info: renderer.info(), size: renderer.size(), dpr: devicePixelRatio };
    },
  };
}

layout();
renderPanels();
connect();
start();
```

- [ ] **Step 3: Run the cockpit checks in Chrome and WebKit**

Run: `node scripts/check-cockpit.mjs`
Then: `PLAYWRIGHT_CORE=<playwright-core folder outside the repository> node scripts/check-cockpit.mjs --engine webkit`
Expected: both exit 0 with `Cockpit: checked 18 states … 0 issues.` and the scene line. Fix the CSS or the page for every issue; never relax `COCKPIT_AUDIT`, `SPACING` or a test to make an issue go away. If a contrast issue needs more opaque glass, raise `--glass` in steps of 0.02 and say so in the report.

- [ ] **Step 4: Look at it next to the spike**

Run: `node scripts/check-cockpit.mjs --only layout --screenshots <folder outside the repository>`
Compare `example-1440x900.png` and `example-1920x1080.png` with the spike's `cockpit-hq-1440.png` and `cockpit-hq-1920.png`. The scene must be the same; the panels the same family (dark glass, corner accents, pastel status colours, curved arrangement), with the differences the builder decisions name. Note in the report anything that looks worse than the spike.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test && npm run validate`
Expected: PASS.

```bash
git add ghcp/plugins/swarm-dashboard/ui/cockpit.mjs
git commit -m "feat(swarm-dashboard): run the cockpit page on the live swarm"
```

- [ ] **Step 6: Early preview**

Run, detached so it outlives the command: `node scripts/swarm-dashboard.mjs --demo example --port 7931`
Check: `curl -s http://127.0.0.1:7931/api/health` answers with `"app":"swarm-dashboard"` and `"demo":"example"`, and `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7931/cockpit` prints `200`. Share `http://127.0.0.1:7931/cockpit` for an early look. Use a port that no other local server uses.

---

### Task 12: The Cockpit control in the regular view

The hooks in `ui/app.mjs`, `ui/main.mjs` and `ui/styles.css` go in one commit of their own; the link check in another.

**Files:**
- Modify: `ui/app.mjs` (`topHtml`)
- Modify: `ui/main.mjs` (the view object, `act()`, the swarm picker's change handler, a message listener)
- Modify: `ui/styles.css` (two rules, after `.pick select:hover`)
- Create: `tests/cockpit-control.test.mjs`
- Modify: `scripts/lib/cockpit-check.mjs` (the `links` check)
- Modify: `tests/cockpit-check.test.mjs` (the check list)

**Interfaces:**
- Consumes: Task 7's `cockpitControlHtml`, `cockpitAddressHtml`, `openCockpit`, `copyAddress`, `showRequest`.
- Produces: `view.host` (`'browser'|'canvas'`) and `view.cockpitNote` (`null` or Task 7's note) in `ui/main.mjs`; the `links` entry of `CHECKS`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-control.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderApp } from '../ui/app.mjs';
import { NOW, exampleSnapshot, fixture } from './helpers/ui.mjs';

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: exampleSnapshot(),
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, host: 'browser', cockpitNote: null, ...overrides,
});
const NOTE = { url: 'http://127.0.0.1:7927/cockpit?swarm=ws-0000-root', reason: 'canvas', copied: null };

test('the Live page\'s top bar ends with the Cockpit control once a swarm shows', () => {
  assert.match(renderApp(view()), /<div class="d-top-r">[\s\S]*<div class="seg ck-open"><button type="button" data-cockpit>Cockpit<\/button><\/div><\/div><\/div>/);
  assert.doesNotMatch(renderApp(view({ page: 'history', runs: [] })), /data-cockpit/);
  assert.doesNotMatch(renderApp(view({ snapshot: null })), /data-cockpit/);
});

test('the cockpit\'s address shows under the top bar on the Live page only', () => {
  assert.match(renderApp(view({ cockpitNote: NOTE })), /<\/div><\/div><div class="ck-addr" role="status">[\s\S]*cockpit\?swarm=ws-0000-root/);
  assert.doesNotMatch(renderApp(view({ page: 'history', runs: [], cockpitNote: NOTE })), /ck-addr/);
});

test('the page wires the control, Copy and the cockpit\'s messages', () => {
  const main = readFileSync(new URL('../ui/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ copyAddress, openCockpit, showRequest \} from '\.\/cockpit-link\.mjs';/);
  assert.match(main, /\[data-cockpit\],\[data-cockpit-copy\]/);
  assert.match(main, /window\.addEventListener\('message', event => \{\n\s+if \(event\.origin !== location\.origin\) return;/);
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\n\.ck-addr \{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; \}\n\.ck-addr-url \{ user-select: all; overflow-wrap: anywhere; \}\n/);
});
```

In `tests/cockpit-check.test.mjs`, change the check list to `['scene', 'layout', 'motion', 'links']`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-control.test.mjs tests/cockpit-check.test.mjs`
Expected: FAIL: no `data-cockpit` in the top bar; the check list lacks `links`.

- [ ] **Step 3: Add the hooks**

`ui/app.mjs`: add `import { cockpitAddressHtml, cockpitControlHtml } from './cockpit-link.mjs';` to the imports, and make `topHtml` end like this:

```js
  return `<div class="d-top"><div class="seg" role="group" aria-label="Dashboard">${pages}</div><div class="d-top-r">${pickerHtml(view)}${statusHtml(view)}${cockpitControlHtml(view)}</div></div>`
    + (view.page === 'live' ? cockpitAddressHtml(view.cockpitNote ?? null) : '');
```

`ui/main.mjs`:
- Add `import { copyAddress, openCockpit, showRequest } from './cockpit-link.mjs';` to the imports.
- In the `view` object, after `fresh: emptyFresh(),`, add `host: document.documentElement.dataset.host,` and `cockpitNote: null,`.
- In `act()`, extend the selector to `'[data-page],[data-tab],[data-span],[data-close],[data-open],[data-run],[data-cockpit],[data-cockpit-copy]'` and add after the `data-run` branch:

```js
  } else if (el.dataset.cockpit !== undefined) {
    view.cockpitNote = view.snapshot ? openCockpit(window, { swarm: view.snapshot.run.id, host: view.host }) : null;
  } else if (el.dataset.cockpitCopy !== undefined) {
    const note = view.cockpitNote;
    if (note) {
      copyAddress(navigator, document, dash.querySelector('.ck-addr-url'), note.url).then(copied => {
        if (view.cockpitNote !== note) return;
        view.cockpitNote = { ...note, copied };
        render();
      });
    }
    return;
```

- In the `select[data-swarm]` change handler, after `view.detail = null;`, add `view.cockpitNote = null;`.
- Before the `pagehide` listener, add:

```js
// The cockpit asks this window to show a unit's details or a tab, in place; a request for another swarm loads its address.
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  const request = showRequest(view, event.data);
  if (!request) return;
  if (request.reload) {
    location.assign(request.reload);
    return;
  }
  view.page = 'live';
  if (request.tab) view.tab = request.tab;
  view.detail = request.detail && view.snapshot.units.some(unit => unit.id === request.detail) ? request.detail : null;
  save();
  render();
  if (view.narrow && view.detail) dash.querySelector('.detail')?.scrollIntoView({ block: 'start' });
});
```

`ui/styles.css`, after the `.pick select:hover` rule:

```css
.ck-addr { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.ck-addr-url { user-select: all; overflow-wrap: anywhere; }
```

- [ ] **Step 4: Run the Node tests and the dashboard's layout check**

Run: `node --test tests/cockpit-control.test.mjs tests/ui-app.test.mjs tests/ui-styles.test.mjs && npm run check:layout`
Expected: the Node tests pass (the `links` check-list test still fails until Step 6); the layout check reports 0 issues at every width, including the canvas widths 480, 560 and 640, with the Cockpit control in the top bar.

- [ ] **Step 5: Commit the hooks**

```bash
git add ghcp/plugins/swarm-dashboard/ui/app.mjs ghcp/plugins/swarm-dashboard/ui/main.mjs ghcp/plugins/swarm-dashboard/ui/styles.css ghcp/plugins/swarm-dashboard/tests/cockpit-control.test.mjs
git commit -m "feat(swarm-dashboard): open the cockpit from the regular view's top bar"
```

- [ ] **Step 6: Add the link check**

In `scripts/lib/cockpit-check.mjs`, above `CHECKS`:

```js
async function waitForTarget(browser, known, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await browser.send('Target.getTargets');
    const found = targetInfos.find(info => !known.has(info.targetId) && accept(info));
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}

/** Chrome only: the control opens the cockpit on the shown swarm; a tile opens its unit in the regular window, in place; the canvas shows the address. */
async function checkLinks({ page, browser, urls, engine, stdout, stderr }) {
  if (engine !== 'chrome' || !urls.example) {
    stdout.write('Cockpit links: checked in Chrome, on the synthetic swarm.\n');
    return 0;
  }
  const problems = [];
  const regular = `${urls.example}?host=browser&swarm=ws-0000-root`;
  await page.goto(regular, 1440, 900);
  await page.waitFor(`location.href === ${JSON.stringify(regular)} && document.documentElement.dataset.ready === '1' && document.querySelector('[data-cockpit]') !== null`);
  await page.evaluate('window.swarmKept = true');
  const known = new Set((await browser.send('Target.getTargets')).targetInfos.map(info => info.targetId));
  await page.send('Runtime.evaluate', { expression: "document.querySelector('[data-cockpit]').click()", userGesture: true });
  const opened = await waitForTarget(browser, known, info => info.type === 'page' && info.url.includes('/cockpit?'), 5000);
  if (!opened) {
    problems.push('the Cockpit control opened no window');
  } else {
    if (new URL(opened.url).searchParams.get('swarm') !== 'ws-0000-root') problems.push(`the cockpit opened at ${opened.url}`);
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: opened.targetId, flatten: true });
    const inCockpit = async (expression, userGesture = false) => (await browser.send('Runtime.evaluate', { expression, returnByValue: true, userGesture }, sessionId)).result.value;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && await inCockpit("document.querySelector('.ck-tile[data-detail=\"ws-0005-i1\"]') !== null") !== true) await new Promise(resolve => setTimeout(resolve, 100));
    await inCockpit("document.querySelector('.ck-tile[data-detail=\"ws-0005-i1\"]').click()", true);
    try {
      await page.waitFor("document.querySelector('.detail[aria-label=\"Details for I1\"]') !== null && window.swarmKept === true", 5000);
    } catch {
      problems.push('a tile in the cockpit did not open its details in the regular window in place');
    }
    await browser.send('Target.closeTarget', { targetId: opened.targetId });
  }
  const canvas = `${urls.example}?host=canvas&swarm=ws-0000-root`;
  await page.goto(canvas, 480, 900);
  await page.waitFor(`location.href === ${JSON.stringify(canvas)} && document.documentElement.dataset.ready === '1' && document.querySelector('[data-cockpit]') !== null`);
  const before = new Set((await browser.send('Target.getTargets')).targetInfos.map(info => info.targetId));
  await page.send('Runtime.evaluate', { expression: "document.querySelector('[data-cockpit]').click()", userGesture: true });
  try {
    await page.waitFor("(document.querySelector('.ck-addr-url')?.textContent ?? '').endsWith('/cockpit?swarm=ws-0000-root')", 3000);
  } catch {
    problems.push('in the canvas the control did not show the cockpit\'s address');
  }
  if (await waitForTarget(browser, before, info => info.type === 'page', 500)) problems.push('in the canvas the control opened a window');
  stdout.write(`Cockpit links: ${problems.length ? `${problems.length} problems` : 'the control opens the cockpit on the shown swarm, a tile opens its details in place, and the canvas shows the address'}.\n`);
  for (const problem of problems) stderr.write(`links: ${problem}\n`);
  return problems.length;
}
```

and change `CHECKS` to:

```js
/** The cockpit's checks in the order they run. Task 13 adds slowdown. */
export const CHECKS = new Map([['scene', checkScene], ['layout', checkLayout], ['motion', checkMotion], ['links', checkLinks]]);
```

- [ ] **Step 7: Run the tests and the check**

Run: `node --test tests/cockpit-check.test.mjs && node scripts/check-cockpit.mjs --only links`
Expected: PASS, and `Cockpit links: the control opens the cockpit on the shown swarm, a tile opens its details in place, and the canvas shows the address.`

- [ ] **Step 8: Check focus in real windows (manual, after a heads-up)**

Headless browsers cannot show whether a window comes to the front. This step opens windows on the owner's screen: stop and send the coordinator a heads-up first, and run it only when the coordinator says the moment is right. Then run `node scripts/swarm-dashboard.mjs --demo example --port 7931` if it is not already running, open `http://127.0.0.1:7931/` in Chrome and in Safari, click Cockpit, then click a tile in the cockpit. Expected: the cockpit opens as its own window; the tile brings the regular window to the front with that unit's details. Report what each browser did. If a browser does not bring the window forward, report it; do not work around it.

- [ ] **Step 9: Commit the check**

```bash
git add ghcp/plugins/swarm-dashboard/scripts/lib/cockpit-check.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-check.test.mjs
git commit -m "test(swarm-dashboard): check the links between the regular view and the cockpit"
```

---

### Task 13: The layout check runs the cockpit's checks, and the regular view stays fast

**Files:**
- Modify: `scripts/check-layout.mjs` (import, `USAGE`, the end of `main`)
- Modify: `scripts/lib/cockpit-check.mjs` (the `slowdown` check)
- Modify: `tests/cockpit-check.test.mjs`

**Interfaces:**
- Consumes: `runCockpitChecks` (Task 8), `createDashboardServer`, `createDemoEngine`.
- Produces: `npm run check:layout` covers the cockpit; the `slowdown` entry of `CHECKS`.

- [ ] **Step 1: Write the failing test**

In `tests/cockpit-check.test.mjs`, change the check list to `['scene', 'layout', 'motion', 'links', 'slowdown']`, and add:

```js
test('the layout check runs the cockpit\'s checks after the dashboard\'s', () => {
  const source = readFileSync(new URL('../scripts/check-layout.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{ runCockpitChecks \} from '\.\/lib\/cockpit-check\.mjs';/);
  assert.match(source, /const cockpit = await runCockpitChecks\(/);
  assert.match(source, /historyIssues\.length \|\| cockpit\.issues \? 1 : 0/);
});
```

with `import { readFileSync } from 'node:fs';` at the top of the file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --test tests/cockpit-check.test.mjs`
Expected: FAIL on both tests.

- [ ] **Step 3: Add the slowdown check**

In `scripts/lib/cockpit-check.mjs`, add `import { createDemoEngine } from '../../server/demo-engine.mjs';` and `import { createDashboardServer } from '../../server/http.mjs';` to the imports, and above `CHECKS`:

```js
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Wait for `count` more live updates of the regular page and return their durations in ms. */
async function updateTimes(page, count, timeoutMs) {
  const start = await page.evaluate("performance.getEntriesByName('swarm-update').length");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && await page.evaluate("performance.getEntriesByName('swarm-update').length") < start + count) await new Promise(resolve => setTimeout(resolve, 200));
  return page.evaluate(`performance.getEntriesByName('swarm-update').slice(${start}).map(entry => entry.duration)`);
}

/** Chrome only: the regular view's live updates cost no more with a cockpit window open beside it (anti-goal 5). */
async function checkSlowdown({ page, browser, urls, engine, stdout, stderr }) {
  if (engine !== 'chrome' || !urls.example) {
    stdout.write('Regular view with a cockpit open: measured in Chrome, on the synthetic swarm.\n');
    return 0;
  }
  const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: true, stepMs: 1000 }), port: 0, version: 'cockpit-check' });
  await server.listen();
  const problems = [];
  let cockpit = null;
  try {
    const url = `${server.url}?host=browser`;
    await page.goto(url, 1440, 900);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
    const alone = await updateTimes(page, 6, 20000);
    const known = new Set((await browser.send('Target.getTargets')).targetInfos.map(info => info.targetId));
    await page.send('Runtime.evaluate', { expression: "document.querySelector('[data-cockpit]').click()", userGesture: true });
    cockpit = await waitForTarget(browser, known, info => info.type === 'page' && info.url.includes('/cockpit?'), 5000);
    if (!cockpit) problems.push('the Cockpit control opened no window');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const beside = await updateTimes(page, 6, 20000);
    if (alone.length < 4 || beside.length < 4) {
      problems.push(`too few live updates arrived to compare (${alone.length} and ${beside.length})`);
    } else {
      const [before, after] = [median(alone), median(beside)];
      if (after > before * 1.25 + 2) problems.push(`the regular view's updates took ${after.toFixed(1)} ms with a cockpit open, ${before.toFixed(1)} ms without`);
      stdout.write(`Regular view with a cockpit open: updates ${before.toFixed(1)} ms median alone, ${after.toFixed(1)} ms with the cockpit drawing beside it.\n`);
    }
  } finally {
    if (cockpit) await browser.send('Target.closeTarget', { targetId: cockpit.targetId }).catch(() => {});
    await server.close();
  }
  for (const problem of problems) stderr.write(`slowdown: ${problem}\n`);
  return problems.length;
}
```

and change `CHECKS` to:

```js
/** The cockpit's checks in the order they run. */
export const CHECKS = new Map([['scene', checkScene], ['layout', checkLayout], ['motion', checkMotion], ['links', checkLinks], ['slowdown', checkSlowdown]]);
```

- [ ] **Step 4: Add the hook to the layout check**

In `scripts/check-layout.mjs`:
- Add `import { runCockpitChecks } from './lib/cockpit-check.mjs';` to the imports.
- In `USAGE`, after the sentence that ends `…reports how long each one takes.`, add: `Then it checks the swarm cockpit the same way (see scripts/check-cockpit.mjs).`
- Replace the last line of the `try` block in `main`, `return failures.length || updateIssues.length || historyIssues.length ? 1 : 0;`, with:

```js
    const cockpit = await runCockpitChecks({ page, browser, engine: options.engine, urls, options: { only: null, printMetrics: false, screenshots: options.screenshots }, stdout, stderr });
    return failures.length || updateIssues.length || historyIssues.length || cockpit.issues ? 1 : 0;
```

- [ ] **Step 5: Run the tests and both checks**

Run: `node --test tests/cockpit-check.test.mjs tests/check-layout.test.mjs && npm run check:layout`
Then: `PLAYWRIGHT_CORE=<playwright-core folder outside the repository> npm run check:layout -- --engine webkit`
Expected: PASS; both layout checks end with the cockpit's lines and 0 issues; Chrome prints the slowdown line with both medians.

- [ ] **Step 6: Commit (the check, then the hook)**

```bash
git add ghcp/plugins/swarm-dashboard/scripts/lib/cockpit-check.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-check.test.mjs
git commit -m "test(swarm-dashboard): check that a cockpit window does not slow the regular view"
git add ghcp/plugins/swarm-dashboard/scripts/check-layout.mjs
git commit -m "test(swarm-dashboard): run the cockpit's checks in the layout check"
```

---

### Task 14: The GPU frame-time test

**Files:**
- Create: `scripts/cockpit-gpu.mjs`
- Create: `tests/cockpit-gpu.test.mjs`

**Interfaces:**
- Consumes: `cockpitDebug.bench(count, every)` (Task 11), which returns `{ times: number[], passes: { holeMs, bloomMs, finalMs }[], info, size, dpr }`; `findBrowser`, `launchBrowser`, `openPage`; `findPlaywright`, `launchWebKit`.
- Produces: `parseArguments(argv)`, `summarise(bench)`, `isSoftware(renderer)`, `verdict(results)`, `describe(result)`, `USAGE`, `main()`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/cockpit-gpu.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE, describe, isSoftware, parseArguments, summarise, verdict } from '../scripts/cockpit-gpu.mjs';

const bench = times => ({ times, passes: [{ holeMs: 6, bloomMs: 0.6, finalMs: 0.7 }, { holeMs: 7, bloomMs: 0.6, finalMs: 0.7 }, { holeMs: 6.5, bloomMs: 0.7, finalMs: 0.8 }], info: { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro)', hdr: true }, size: { width: 2880, height: 1800 }, dpr: 2 });

test('arguments pick the engine and the number of frames', () => {
  assert.deepEqual(parseArguments([]), { engine: 'chrome', frames: 30, help: false });
  assert.deepEqual(parseArguments(['--engine', 'webkit', '--frames', '60']), { engine: 'webkit', frames: 60, help: false });
  assert.throws(() => parseArguments(['--frames', '2']), /--frames takes a number from 10 to 300/);
  assert.match(USAGE, /^Usage: cockpit-gpu/);
});

test('a run is summarised by its median, 90th percentile, mean and each pass\'s median', () => {
  const summary = summarise(bench([8, 7, 9, 7.5, 10, 7, 8, 7.2, 7.8, 12]));
  assert.deepEqual(summary, { median: 7.9, p90: 12, mean: 8.35, passes: { holeMs: 6.5, bloomMs: 0.6, finalMs: 0.7 } });
});

test('software renderers are recognised', () => {
  assert.equal(isSoftware('Google SwiftShader'), true);
  assert.equal(isSoftware('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(isSoftware('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro)'), false);
});

test('the test fails without WebGL2, on a software renderer, or when High cannot hold 30 fps at 1440 × 900', () => {
  const ok = { width: 1440, height: 900, renderer: 'Apple GPU', high: { median: 7.5 }, balanced: { mean: 4.2 } };
  assert.deepEqual(verdict([ok]), []);
  assert.match(verdict([{ ...ok, high: { median: 34 } }])[0], /cannot hold 30 frames a second/);
  assert.match(verdict([{ ...ok, renderer: 'Google SwiftShader' }])[0], /software renderer/);
  assert.match(verdict([{ ...ok, renderer: null }])[0], /WebGL2 is not available/);
  assert.deepEqual(verdict([{ ...ok, width: 1920, height: 1080, high: { median: 40 } }]), []);
});

test('each size is described in one line', () => {
  const line = describe({ width: 1440, height: 900, dpr: 2, size: { width: 2880, height: 1800 }, high: { median: 7.5, p90: 10, passes: { holeMs: 6.5, bloomMs: 0.6, finalMs: 0.7 } }, balanced: { mean: 4.2 } });
  assert.equal(line, '1440 × 900 at 2x (2880 × 1800): High 7.5 ms median (90th percentile 10.0 ms), Balanced 4.2 ms a frame on average; black hole 6.5, bloom 0.6, final 0.7 ms. At 30 fps the GPU is busy about 23% of the time on High and 13% on Balanced.');
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `node --test tests/cockpit-gpu.test.mjs`
Expected: FAIL with `Cannot find module '../scripts/cockpit-gpu.mjs'`.

- [ ] **Step 3: Write the command**

```js
// scripts/cockpit-gpu.mjs
#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { findBrowser, launchBrowser, openPage } from './lib/cdp.mjs';
import { findPlaywright, launchWebKit } from './lib/webkit.mjs';

export const SIZES = Object.freeze([[1440, 900], [1920, 1080]]);
const BUDGET_MS = 1000 / 30;
export const USAGE = `Usage: cockpit-gpu [--engine chrome|webkit] [--frames <n>]

Measures the swarm cockpit's GPU time per frame on this machine, at 1440 × 900 and 1920 × 1080 with device pixel
ratio 2, on the synthetic example swarm: High redraws the black hole every frame, Balanced every second frame. Each
frame is forced to finish before it is timed. A dev-only test: it reports the cost, and fails only when WebGL2 is
missing, the renderer is a software one, or High at 1440 × 900 cannot hold 30 frames a second. It cannot measure heat.
--engine webkit uses Playwright's WebKit (set PLAYWRIGHT_CORE, as for check-layout). --frames sets frames per run (30).
`;

export function parseArguments(argv) {
  const options = { engine: 'chrome', frames: 30, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--engine') {
      options.engine = argv[++index];
      if (options.engine !== 'chrome' && options.engine !== 'webkit') throw new Error('--engine takes chrome or webkit');
    } else if (arg === '--frames') {
      options.frames = Number(argv[++index]);
      if (!Number.isInteger(options.frames) || options.frames < 10 || options.frames > 300) throw new Error('--frames takes a number from 10 to 300');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const round = value => Math.round(value * 100) / 100;
const middle = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(half)] : (sorted[half - 1] + sorted[half]) / 2;
};

export function summarise(bench) {
  const sorted = [...bench.times].sort((a, b) => a - b);
  return {
    median: round(middle(bench.times)),
    p90: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]),
    mean: round(bench.times.reduce((sum, value) => sum + value, 0) / bench.times.length),
    passes: { holeMs: round(middle(bench.passes.map(pass => pass.holeMs))), bloomMs: round(middle(bench.passes.map(pass => pass.bloomMs))), finalMs: round(middle(bench.passes.map(pass => pass.finalMs))) },
  };
}

export const isSoftware = renderer => /swiftshader|llvmpipe|software/i.test(renderer ?? '');

export function verdict(results) {
  const problems = [];
  for (const result of results) {
    if (!result.renderer) problems.push(`${result.width} × ${result.height}: WebGL2 is not available`);
    else if (isSoftware(result.renderer)) problems.push(`${result.width} × ${result.height}: ${result.renderer} is a software renderer, so the times say nothing about the GPU`);
    else if (result.width === 1440 && result.height === 900 && result.high.median > BUDGET_MS) problems.push(`High takes ${result.high.median} ms a frame at 1440 × 900, so it cannot hold 30 frames a second`);
  }
  return problems;
}

/** The share of each second the GPU is busy at 30 frames a second, in percent: ms × 30 / 1000 × 100. */
const percent = ms => Math.round(ms * 3);
export function describe(result) {
  const { passes } = result.high;
  return `${result.width} × ${result.height} at ${result.dpr}x (${result.size.width} × ${result.size.height}): High ${result.high.median} ms median (90th percentile ${result.high.p90.toFixed(1)} ms), `
    + `Balanced ${result.balanced.mean} ms a frame on average; black hole ${passes.holeMs}, bloom ${passes.bloomMs}, final ${passes.finalMs} ms. `
    + `At 30 fps the GPU is busy about ${percent(result.high.median)}% of the time on High and ${percent(result.balanced.mean)}% on Balanced.`;
}

/** Open the cockpit at a size with device pixel ratio 2, wait until it is ready, and run fn(evaluate). */
async function atSize(engine, browser, url, [width, height], fn) {
  if (engine === 'webkit') {
    const context = await browser.playwright.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(url);
      // waitForFunction would compile its expression in the page, which the page's CSP refuses; poll instead.
      const deadline = Date.now() + 15000;
      while (await page.evaluate("document.documentElement.dataset.ready === '1'") !== true) {
        if (Date.now() > deadline) throw new Error('The cockpit did not get ready within 15 s');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return await fn(expression => page.evaluate(expression));
    } finally {
      await context.close();
    }
  }
  const page = await openPage(browser);
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await page.send('Page.navigate', { url });
  await page.waitFor("document.documentElement.dataset.ready === '1'", 15000);
  return fn(expression => page.evaluate(expression));
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
  let browser;
  if (options.engine === 'webkit') {
    const entry = findPlaywright(env);
    const launched = entry ? await launchWebKit(entry) : { skip: 'Playwright is not available; set PLAYWRIGHT_CORE (see the README).' };
    if (launched.skip) {
      stderr.write(`${launched.skip}\n`);
      return 2;
    }
    browser = launched.browser;
  } else {
    const executable = findBrowser(env);
    if (!executable) {
      stderr.write('No local Chrome, Chromium or Edge was found. Install one or set CHROME_PATH.\n');
      return 2;
    }
    browser = await launchBrowser(executable);
  }
  const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: false }), port: 0, version: 'cockpit-gpu' });
  try {
    await server.listen();
    const url = `${server.url}cockpit?debug=1&quality=high`;
    const results = [];
    for (const size of SIZES) {
      const result = await atSize(options.engine, browser, url, size, async evaluate => {
        const high = await evaluate(`cockpitDebug.bench(${options.frames}, 1)`);
        const balanced = await evaluate(`cockpitDebug.bench(${options.frames}, 2)`);
        return { high, balanced };
      });
      if (!result.high) {
        results.push({ width: size[0], height: size[1], renderer: null });
        continue;
      }
      results.push({ width: size[0], height: size[1], dpr: result.high.dpr, size: result.high.size, renderer: result.high.info.renderer, hdr: result.high.info.hdr, high: summarise(result.high), balanced: summarise(result.balanced) });
    }
    const first = results.find(result => result.renderer);
    stdout.write(`Browser: ${browser.product}\nRenderer: ${first ? `${first.renderer}, ${first.hdr ? 'HDR' : '8-bit'} targets` : 'none'}\n`);
    for (const result of results.filter(item => item.renderer)) stdout.write(`${describe(result)}\n`);
    const problems = verdict(results);
    for (const problem of problems) stderr.write(`${problem}\n`);
    return problems.length ? 1 : 0;
  } finally {
    await server.close();
    await browser.close();
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 4: Run the tests, then the test itself in both engines**

Run: `node --test tests/cockpit-gpu.test.mjs`
Expected: PASS (5 tests).
Run: `node scripts/cockpit-gpu.mjs` and `PLAYWRIGHT_CORE=<playwright-core folder outside the repository> node scripts/cockpit-gpu.mjs --engine webkit`
Expected: exit 0, a renderer line naming the real GPU, and High medians near the design's 7.9 ms (1440 × 900) and 11.8 ms (1920 × 1080). Put both outputs in the task's report.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test && npm run validate`
Expected: PASS.

```bash
git add ghcp/plugins/swarm-dashboard/scripts/cockpit-gpu.mjs ghcp/plugins/swarm-dashboard/tests/cockpit-gpu.test.mjs
git commit -m "feat(swarm-dashboard): measure the cockpit's GPU time per frame"
```

---

### Task 15: Documentation and the final checks

**Files:**
- Modify: `README.md` (a new section after "Open the dashboard", two rows in "Commands")
- Modify: `.github/copilot-instructions.md` (the `swarm-dashboard` bullet and the layout-check rule)

- [ ] **Step 1: Add the README section**

After the "Open the dashboard" section, add:

```markdown
## The cockpit

The cockpit is a second, dark look at the same swarm: a seat at a mission control desk, looking through a curved window at a black hole, with the swarm on curved glass panels. It shows what the regular view shows, without new data or actions: the clock and run timer, what needs you, a tile per child session and per running sub-agent, the activity, the cost and the pull requests. Click a panel to see the details in the regular view.

Open it with **Cockpit** in the top bar of the Live page. It opens in its own browser window on the swarm you are watching, at `http://127.0.0.1:<port>/cockpit?swarm=<root session id>`. The app's canvas cannot open windows, so there the button shows the address and a Copy button instead.

- Quality: **High** (the default) draws the black hole on every frame, at most 30 frames a second. **Balanced** draws it on every second frame, and on every frame while the pointer moves. The choice is kept in the browser. High keeps the GPU busy about a quarter of the time on an Apple M5 Pro and may make a fanless laptop warm.
- The cockpit stops drawing while its window is hidden, shows one still frame when the system asks to reduce motion, and lowers the black hole's resolution when frames run late.
- It needs a window of at least 1100 × 800, about 1.3 times as wide as it is tall, and WebGL2. Without WebGL2 it shows the panels on a plain dark background.
```

In the Commands table, after the `npm run check:layout` row, add:

```markdown
| `node scripts/check-cockpit.mjs` | Run only the cockpit's checks: the scene, the panels' arrangement, type, spacing and contrast, motion, the links between the windows and the regular view's speed (`--engine webkit`, `--only <check>`, `--screenshots <dir>`); `npm run check:layout` runs them too |
| `node scripts/cockpit-gpu.mjs` | Measure the cockpit's GPU time per frame on this machine for High and Balanced (`--engine webkit`) |
```

- [ ] **Step 2: Update the repository instructions**

In `.github/copilot-instructions.md`, in the `swarm-dashboard` bullet, change "a no-build UI (`ui/`)" to "a no-build UI (`ui/`) with a regular view and a WebGL2 cockpit view", and "a launcher, snapshot command and headless layout check (`scripts/`)" to "a launcher, snapshot command, headless layout check and dev-only GPU frame-time test (`scripts/`)". In the "Working in this repo" rule for `swarm-dashboard`, change "every view must report 0 issues" to "every view and every cockpit state must report 0 issues".

- [ ] **Step 3: Validate the documentation**

Run: `npm test && npm run validate`
Expected: PASS. Read the changed Markdown once for broken table rows.

- [ ] **Step 4: Commit**

```bash
git add ghcp/plugins/swarm-dashboard/README.md .github/copilot-instructions.md
git commit -m "docs(swarm-dashboard): describe the cockpit and its checks"
```

- [ ] **Step 5: The final checks**

Run, from `ghcp/plugins/swarm-dashboard`:
1. `npm test && npm run validate`: PASS.
2. `npm run check:layout`: 0 issues for every view and cockpit state; the motion, links and slowdown lines.
3. `PLAYWRIGHT_CORE=<playwright-core folder outside the repository> npm run check:layout -- --engine webkit`: 0 issues.
4. `node scripts/cockpit-gpu.mjs`: exit 0; keep the output.
5. A real-data smoke run, kept local: `node scripts/swarm-dashboard.mjs --port 7932`, then `npm run check:layout -- --live http://127.0.0.1:7932/`, then stop the server. Report counts only (states checked, issues), never names or text from the data.

Report the commands, their outcomes, the branch and the pushed commit.

---

## Self-review

Spec coverage (cockpit design, section by section):

| Spec item | Where |
| --- | --- |
| Decision 2, 5: seated view, slow drift, slight parallax, no walking | Task 3 (`cameraTarget`, `easeCamera`), Task 11 (loop, pointer) |
| Decision 5: the black hole is alive, bends light, stars drift | Task 8 (HOLE pass, `uTime`, star spin) |
| Decision 5: clock and run timer; needs you light; a tile per child session in its colour; activity; cost; PRs opened and merged | Tasks 2 and 6 (`clockHtml`, `needsHtml`, `unitsHtml`, `activityHtml`, `costHtml`, `prsHtml`) |
| Decision 5: clicking a panel leads to the details in the regular window | Task 7 (`showInRegular`, `showRequest`), Task 11 (clicks), Task 12 (listener, link check) |
| Decision 5: watch-only; no new dependencies; panels as page elements bent into a curve; GPU-drawn black hole | Global Constraints; Tasks 3, 4, 8, 11 |
| Decision 5, 6 (owner's rules): no overlap, even padding, no bold or italic, calm motion, pastel status colours glowing softly | Task 9 (CSS and its tests), Task 10 (audit, overlap at every camera pose) |
| Decision 5: reduce motion; does not run hot | Task 5 (`loopRuns`, adaptive), Task 11 (still frame, hidden), Task 10 (motion check), Task 14 (cost) |
| Decision 3, 4: a second look in a new window of the same browser; keep the pastel one | Task 1 (route), Task 7 (`openCockpit`), Task 12 (control) |
| Decisions 6, 7, 9: the high-quality spike's look; High by default | Task 8 (port, pixel comparison with the spike), Task 5 (`readQuality` defaults to High) |
| Decision 8: sub-agents share the functionality of child sessions | Task 2 (running and stuck sub-agent tiles, counts), Task 6 |
| Section 4: hidden window, still frame, adaptive resolution, Balanced remembered; no generic LLM look; no clipped text; calm motion; regular view not slower | Tasks 5, 9, 10, 11; Task 13 (slowdown check) |
| Section 5 constraints: server rules, CSP, asset types, live feed, `?detail=`, canvas `host` and `session`, snapshot units and sub-agent costs, canvas is WebKit, no deps, synthetic fixtures, `npm test && npm run validate` | D1; Tasks 1, 2 (`costView` never adds sub-agent costs), 7, 12; Global Constraints |
| Calls 1–9 | 1: Task 1 and Global Constraints; 2: D3, Tasks 7 and 12; 3: B1, Task 2; 4: B6, Tasks 7 and 12; 5: Tasks 5 and 11; 6: Task 9, B2, B3; 7: Tasks 10, 13, 14; 8: B10, Task 8; 9: this plan's process |
| Section 9 open points 1–11 | 1: Task 4; 2: B7; 3: Task 8 (shader unchanged from the approved spike; the adaptive fallback covers slow GPUs); 4: B8; 5: D3; 6: D2, D4; 7: B10; 8: B11; 9: B2; 10: B3; 11: B6 |

Placeholder scan: every code step has its code; the only values decided at run time are the measured numbers that Task 8 Step 8 and Task 14 Step 4 report.

Type consistency: `fitPanels` returns `{ stage, fits, reason, placements, rects, problems }` in Tasks 4, 10 and 11; `cockpitDebug` has `fit`, `frames`, `info`, `setCamera`, `readFrame`, `resume` and `bench` in Task 11, and Tasks 10 and 14 use only those; `createRenderer` returns `resize`, `render`, `readFrame`, `sync`, `timed`, `info`, `size` in Task 8, used by Tasks 8, 10 and 11; `openCockpit` returns `null` or `{ url, reason, copied }`, as `cockpitAddressHtml` and Task 12 expect; `CHECKS` grows `scene` → `layout`, `motion` → `links` → `slowdown`, and `tests/cockpit-check.test.mjs` tracks it.

Validation while writing: on 16 October 2026 the code in Tasks 1 to 14 was applied, step by step, to a scratch copy of the plugin outside the repository and run there:
- `npm test`: 594 tests, all passing except the four that need the repository's root marketplace manifest, which a copy outside the repository cannot reach.
- The ported scene matched the spike pixel for pixel in Chrome (Task 8, Step 9).
- `npm run check:layout` in Chrome 155: 206 dashboard views with the Cockpit control, 284,086 checks, 0 issues; 18 cockpit states, 15,370 checks, 0 issues; 30 frames a second under motion and none under reduced motion; the links check passed; the regular view's updates took 2.2 ms median alone and 1.8 ms with a cockpit drawing beside it.
- The same in WebKit 27.2: 206 views, 0 issues; 18 cockpit states, 0 issues.
- `node scripts/cockpit-gpu.mjs`: High 7.35 ms (1440 × 900) and 10.55 ms (1920 × 1080) in Chrome, 7 and 10 ms in WebKit; Balanced about half.
