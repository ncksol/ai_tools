#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { findBrowser, launchBrowser, openPage } from './lib/cdp.mjs';
import { AUDIT_DEFAULTS, auditScript } from './lib/page-audit.mjs';
import { findPlaywright, launchWebKit, openWebKitPage } from './lib/webkit.mjs';

export const WIDTHS = [480, 560, 640, 800, 1024, 1280, 1440, 1600, 1920];
export const CANVAS_WIDTHS = [480, 560, 640];
/** What each scenario shows in the detail, sub-agent detail and run views; the stress scenario has no history. */
const SCENARIOS = {
  example: { detail: 'ws-0005-i1', subagent: 'call-root-24', run: 'ws-1000-root' },
  stress: { detail: 'ws-9001-stress', subagent: 'call-9101-sub', run: null },
};
/** Every dashboard view as URL parameters. Activity exists only in narrow mode; history views need a finished run. */
export const VIEWS = [
  { name: 'cards', params: {} },
  { name: 'detail', params: { detail: 'DETAIL' } },
  { name: 'detail-subagent', params: { detail: 'SUBAGENT' } },
  { name: 'activity', params: { tab: 'activity' }, narrowOnly: true },
  { name: 'timeline', params: { tab: 'timeline', span: '12h' } },
  { name: 'timeline-run', params: { tab: 'timeline', span: 'run' } },
  { name: 'plan', params: { tab: 'plan' } },
  { name: 'board', params: { tab: 'board' } },
  { name: 'history', params: { page: 'history' }, history: true },
  { name: 'run', params: { page: 'run', run: 'RUN' }, history: true },
];
export const SELF_TEST_RULES = ['overlap', 'font-family', 'font-size', 'font-style', 'text-transform', 'font-weight', 'letter-spacing', 'line-height', 'contrast', 'colour', 'grid', 'padding', 'height', 'spill', 'clipped', 'hidden-lines', 'cut', 'outside', 'gap', 'align', 'kind-border', 'hscroll'];
export const USAGE = `Usage: check-layout [--scenario example|stress | --live <url>] [--width <px>] [--screenshots <dir>] [--engine chrome|webkit]

Checks every dashboard view for overlap, clipped text, type, spacing, sizes, contrast and console errors in a
local headless Chrome, Chromium or Edge (set CHROME_PATH to pick one). It proves its rules on a broken page first,
tests the page's in-place updates, and then watches live updates arrive and reports how long each one takes.
By default it serves the synthetic example and stress swarms itself; --live checks a running dashboard instead
(for example http://127.0.0.1:7927/), whose report quotes your own data: keep it local.
Screenshots of the synthetic swarms, when asked for, are written to <dir> for review; do not commit them.
--live never writes screenshots, because its pages show your own data.
--engine webkit runs the same checks in Playwright's WebKit, the engine of the Copilot app's panel. It needs Playwright installed outside this repository (set PLAYWRIGHT_CORE) and skips when it is missing.
`;

export function parseArguments(argv) {
  const options = { scenarios: ['example', 'stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS, screenshots: null, live: null, engine: 'chrome', help: false };
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
    } else if (arg === '--engine') {
      const engine = argv[++index];
      if (engine !== 'chrome' && engine !== 'webkit') throw new Error('--engine takes chrome or webkit');
      options.engine = engine;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.live && scenarioChosen) throw new Error('--live checks a running dashboard, so it cannot be combined with --scenario');
  if (options.live && options.screenshots) throw new Error('--live pages show your own data, so it cannot be combined with --screenshots');
  if (options.live) options.scenarios = ['live'];
  return options;
}

/** targets: per scenario, the swarm to pin (optional), the units for the detail views and the finished run, or null. */
export function buildStates({ scenarios, widths, canvasWidths, targets = SCENARIOS }) {
  const states = [];
  for (const scenario of scenarios) {
    const target = targets[scenario];
    for (const [host, list] of [['browser', widths], ['canvas', canvasWidths]]) {
      for (const width of list) {
        for (const view of VIEWS) {
          if ((view.history && !target.run) || (view.name === 'detail' && !target.detail) || (view.name === 'detail-subagent' && !target.subagent)) continue;
          const params = { host, ...(target.swarm ? { swarm: target.swarm } : {}), ...view.params };
          if (params.detail === 'DETAIL') params.detail = target.detail;
          if (params.detail === 'SUBAGENT') params.detail = target.subagent;
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
      subagent: snapshot?.units.find(unit => unit.kind === 'subagent')?.id ?? null,
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

const KEPT = [['cards', 'cards kept'], ['activity highlights', 'no repeated highlights'], ['scroll', 'scroll kept'], ['busy-ring phase', 'busy rings in phase']];

/** "cards kept, no repeated highlights, not measured: scroll" for the live-update checks, naming those that had nothing to measure. */
export function describeKept(unmeasured) {
  const parts = KEPT.filter(([name]) => !unmeasured.includes(name)).map(([, text]) => text);
  const missing = KEPT.filter(([name]) => unmeasured.includes(name)).map(([name]) => name);
  if (missing.length) parts.push(`not measured: ${missing.join(', ')}`);
  return parts.join(', ');
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

/** Runs in the page before updates arrive: remembers the cards and activity items on screen, and scrolls a little if it can. */
function markPage() {
  window.scrollTo(0, Math.max(0, Math.min(160, document.documentElement.scrollHeight - window.innerHeight)));
  window.swarmCheck = {
    baseline: performance.getEntriesByName('swarm-update').length,
    cards: [...document.querySelectorAll('.b-card')],
    feed: [...document.querySelectorAll('.fi')],
    scrollY: window.scrollY,
  };
}

/**
 * Runs in the page after updates: what they re-created, highlighted again, scrolled or put out of phase, their times,
 * and which checks had nothing to measure.
 */
function inspectPage() {
  const state = window.swarmCheck;
  const issues = [];
  const unmeasured = [];
  const recreated = state.cards.filter(el => !el.isConnected).length;
  if (recreated) issues.push(`${recreated} of ${state.cards.length} cards were re-created`);
  const keys = new Set([...document.querySelectorAll('.fi')].map(el => el.dataset.key));
  const remade = state.feed.filter(el => !el.isConnected && keys.has(el.dataset.key)).length;
  if (remade) issues.push(`${remade} of ${state.feed.length} activity items were re-created`);
  const flashed = state.feed.filter(el => el.isConnected && el.classList.contains('is-new')).length;
  if (flashed) issues.push(`${flashed} activity items that did not change were highlighted again`);
  if (Math.abs(window.scrollY - state.scrollY) > 1) issues.push(`the page scrolled from ${state.scrollY} to ${window.scrollY} px`);
  const now = document.timeline.currentTime;
  let rings = 0;
  for (const arc of document.querySelectorAll('.ring .arc.spin')) {
    const animation = arc.getAnimations()[0];
    if (!animation) continue;
    rings += 1;
    const off = Math.abs(animation.effect.getComputedTiming().progress - ((now / 1000) % 4) / 4);
    const ms = Math.min(off, 1 - off) * 4000;
    if (ms > 80) issues.push(`a busy ring is ${Math.round(ms)} ms out of phase`);
  }
  if (!state.cards.length) unmeasured.push('cards');
  if (!state.feed.length) unmeasured.push('activity highlights');
  if (state.scrollY === 0) unmeasured.push('scroll');
  if (!rings) unmeasured.push('busy-ring phase');
  const durations = performance.getEntriesByName('swarm-update').slice(state.baseline).map(entry => entry.duration);
  return { issues, durations, unmeasured };
}

/** Open the page with motion on, wait for live updates and inspect what they did; null when none arrived. */
async function watchUpdates(page, url, { updates = 3, timeoutMs = 15000 } = {}) {
  await page.setReducedMotion(false);
  try {
    page.errors.length = 0;
    // 600 px tall, so the example page can scroll.
    await page.goto(url, 1440, 600);
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
    await page.setReducedMotion(true);
  }
}

/** Runs in the page on History: counts any moment it shows its loading state, and the history requests made so far. */
function watchLoading() {
  const state = { loading: 0, requests: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/history')).length };
  const look = () => {
    if (document.documentElement.dataset.ready !== '1' || document.getElementById('dash').textContent.includes('Loading finished runs')) state.loading += 1;
  };
  new MutationObserver(look).observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
  window.swarmHistory = state;
}

/** Wait up to timeoutMs for History to show at least count rows; false when it does not. */
async function waitForRows(page, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate("document.querySelectorAll('.h-row[data-run]').length") >= count) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * Open History on a synthetic server, finish its live run, then restart the server with one more finished run.
 * History must show each new run in place, without its loading state and with one request per refresh.
 */
async function watchHistory(page, servers) {
  const issues = [];
  const started = [];
  const demo = createDemoEngine({ scenario: 'example', simulate: false });
  const history = await demo.listHistory();
  const engine = { ...demo, listHistory: async () => structuredClone(history) };
  const serve = async port => {
    const server = createDashboardServer({ createEngine: () => engine, port, version: 'layout-check', hub: { engineIdleMs: 600000 } });
    started.push(server);
    servers.push(server);
    await server.listen();
    return server;
  };
  try {
    const server = await serve(0);
    const { port } = server;
    const url = `${server.url}?host=browser&page=history`;
    await page.goto(url, 1280);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
    const before = await page.evaluate("document.querySelectorAll('.h-row[data-run]').length");
    await page.evaluate(`(${watchLoading})()`);

    // History is ready before the live connection opens; a push the page never hears of would fail the wait by mistake.
    const connected = Date.now() + 5000;
    while (server.clientCount() < 1 && Date.now() < connected) await new Promise(resolve => setTimeout(resolve, 100));
    if (server.clientCount() < 1) {
      issues.push('the page did not open its live connection within 5 s');
      return { issues, requests: 0 };
    }
    // Let the page handle its first swarms event, so it knows the lifecycles before one changes.
    await new Promise(resolve => setTimeout(resolve, 300));

    const snapshot = await engine.getSnapshot();
    snapshot.run.lifecycle = 'finished';
    snapshot.run.finishedAt = Date.now();
    snapshot.revision += 1;
    history.unshift({ ...history[0], id: snapshot.run.id, name: snapshot.run.name, project: snapshot.run.project, startedAt: snapshot.run.startedAt, finishedAt: snapshot.run.finishedAt });
    engine.push(snapshot);
    if (!await waitForRows(page, before + 1, 8000)) issues.push('History did not show the finished run within 8 s');

    history.unshift({ ...history[0], id: 'ws-history-check', name: 'History check' });
    await server.close();
    let restarted = true;
    try {
      await serve(port);
    } catch (error) {
      restarted = false;
      issues.push(`the restarted server could not listen: ${error.message}`);
    }
    if (restarted && !await waitForRows(page, before + 2, 10000)) issues.push('History did not show the run added while the page was disconnected within 10 s');

    const state = await page.evaluate("({ loading: window.swarmHistory.loading, requests: performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/history')).length - window.swarmHistory.requests })");
    if (state.loading) issues.push('History showed its loading state while refreshing');
    if (state.requests < 2 || state.requests > 4) issues.push(`History made ${state.requests} requests for two refreshes`);
    return { issues, requests: state.requests };
  } finally {
    for (const server of started) {
      await server.close();
      servers.splice(servers.indexOf(server), 1);
    }
  }
}

/** Wait up to timeoutMs for the server to count the page's live connection, then let the page handle what it sent. */
async function waitForClient(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (server.clientCount() < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (server.clientCount() < 1) return false;
  await new Promise(resolve => setTimeout(resolve, 300));
  return true;
}

/**
 * Open the Board with a detail panel on a synthetic server, then restart the server with new dashboard files, twice.
 * The first time the page must reload once and keep the Board tab and the open detail; the second time it has already
 * tried the new files (its sessionStorage says so), so it must not reload again.
 */
async function watchReload(page, servers) {
  const issues = [];
  const started = [];
  const serve = async (port, uiFingerprint) => {
    const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: false }), port, version: 'layout-check', uiFingerprint, hub: { engineIdleMs: 600000 } });
    started.push(server);
    servers.push(server);
    await server.listen();
    return server;
  };
  let port = null;
  // Restart on the same port, as an update does, so the page reconnects by itself.
  const restart = async (server, uiFingerprint) => {
    await server.close();
    try {
      return await serve(port, uiFingerprint);
    } catch (error) {
      issues.push(`the restarted server could not listen: ${error.message}`);
      return null;
    }
  };
  try {
    const first = await serve(0, 'layout-check-a');
    port = first.port;
    const url = `${first.url}?host=browser`;
    await page.goto(url, 1280);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
    await page.evaluate("sessionStorage.removeItem('swarm-dashboard:reloaded-for')");
    if (!await waitForClient(first, 5000)) {
      issues.push('the page did not open its live connection within 5 s');
      return { issues };
    }
    await page.evaluate(`document.querySelector('[data-tab="board"]').click()`);
    await page.waitFor(`document.querySelector('.board .mc[data-open]') !== null`, 5000);
    await page.evaluate(`document.querySelector('.board .mc[data-open]').click()`);
    await page.waitFor(`document.querySelector('.detail .b-name') !== null`, 5000);
    const shown = await page.evaluate(`document.querySelector('.detail .b-name').textContent`);
    await page.evaluate("window.swarmMark = 'a'");

    // New dashboard files: the page reloads once into them, keeping what was on screen.
    const second = await restart(first, 'layout-check-b');
    if (!second) return { issues };
    try {
      await page.waitFor("window.swarmMark === undefined && document.documentElement.dataset.ready === '1'", 15000);
    } catch {
      issues.push('the page did not reload for new dashboard files within 15 s');
      return { issues };
    }
    const after = await page.evaluate(`({
      own: document.querySelector('meta[name="swarm-ui"]')?.content,
      board: document.querySelector('[data-tab="board"]')?.getAttribute('aria-selected') === 'true',
      detail: document.querySelector('.detail .b-name')?.textContent ?? null,
      search: location.search,
      attempted: sessionStorage.getItem('swarm-dashboard:reloaded-for'),
    })`);
    if (after.own !== 'layout-check-b') issues.push(`the reloaded page has the dashboard files ${after.own}, not layout-check-b`);
    if (!after.board) issues.push('the reload lost the Board tab');
    if (after.detail !== shown) issues.push('the reload closed the detail panel');
    if (after.search !== '?host=browser') issues.push(`the reloaded page kept its state in the address: ${after.search}`);
    if (after.attempted !== 'layout-check-b') issues.push(`the page remembered the attempt as ${after.attempted}, not layout-check-b`);
    if (!await waitForClient(second, 5000)) {
      issues.push('the reloaded page did not open its live connection within 5 s');
      return { issues };
    }

    // Files the page has already tried for: they still differ from its own, but it must not reload again.
    await page.evaluate("sessionStorage['swarm-dashboard:reloaded-for'] = 'layout-check-c'; window.swarmMark = 'b'");
    const third = await restart(second, 'layout-check-c');
    if (!third) return { issues };
    if (!await waitForClient(third, 15000)) {
      issues.push('the page did not reconnect to the restarted server within 15 s');
      return { issues };
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (await page.evaluate('window.swarmMark').catch(() => undefined) !== 'b') issues.push('the page reloaded again for a fingerprint it had already tried');
    return { issues };
  } finally {
    for (const server of started) {
      await server.close();
      servers.splice(servers.indexOf(server), 1);
    }
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
  let browser;
  if (options.engine === 'webkit') {
    const entry = findPlaywright(env);
    if (!entry) {
      stdout.write(env.PLAYWRIGHT_CORE
        ? `WebKit check skipped: PLAYWRIGHT_CORE (${env.PLAYWRIGHT_CORE}) has no index.mjs. Point it at the playwright-core package folder, …/node_modules/playwright-core.\n`
        : 'WebKit check skipped: Playwright is not available. Install playwright-core outside this repository and set PLAYWRIGHT_CORE (see the README).\n');
      return 0;
    }
    const launched = await launchWebKit(entry);
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
  const servers = [];
  const interrupt = () => process.exit(130);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    stdout.write(`Browser: ${browser.product}\n`);
    const page = options.engine === 'webkit' ? await openWebKitPage(browser) : await openPage(browser);
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
        ? `Live updates (live): ${describeTimes(watched.durations)}${watched.issues.length ? '' : `; ${describeKept(watched.unmeasured)}`}.\n`
        : 'Live updates (live): none arrived within 25 s, so the update time was not measured.\n');
    } else {
      const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: true, stepMs: 1000 }), port: 0, version: 'layout-check' });
      await server.listen();
      servers.push(server);
      const watched = await watchUpdates(page, `${server.url}?host=browser`);
      updateIssues = watched
        ? [...watched.issues, ...watched.unmeasured.map(name => `${name} could not be measured on the example page`)]
        : ['no simulated update arrived within 15 s'];
      if (watched) stdout.write(`Live updates (example, simulated): ${describeTimes(watched.durations)}${watched.issues.length ? '' : `; ${describeKept(watched.unmeasured)}`}.\n`);
    }
    for (const issue of updateIssues) stderr.write(`update: ${issue}\n`);
    let historyIssues = [];
    if (!options.live) {
      const watchedHistory = await watchHistory(page, servers);
      historyIssues = watchedHistory.issues;
      if (!watchedHistory.issues.length) stdout.write(`History refresh (example, simulated): a finished run and a reconnect each updated History in place; ${watchedHistory.requests} history requests.\n`);
      for (const issue of watchedHistory.issues) stderr.write(`history: ${issue}\n`);
    }
    let reloadIssues = [];
    if (!options.live) {
      reloadIssues = (await watchReload(page, servers)).issues;
      if (!reloadIssues.length) stdout.write('Self-reload (example, simulated): the page reloaded once for new dashboard files, kept the Board tab and the open detail, and did not reload again for files it had already tried.\n');
      for (const issue of reloadIssues) stderr.write(`reload: ${issue}\n`);
    }
    return failures.length || updateIssues.length || historyIssues.length || reloadIssues.length ? 1 : 0;
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
