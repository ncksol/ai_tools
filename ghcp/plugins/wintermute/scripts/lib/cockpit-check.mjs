import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDemoEngine } from '../../server/demo-engine.mjs';
import { createDashboardServer } from '../../server/http.mjs';
import { PANELS, fitPanels, overlapProblems } from '../../ui/cockpit-fit.mjs';
import { STORE_KEY } from '../../ui/cockpit-quality.mjs';
import { REST, extremePoses } from '../../ui/cockpit-space.mjs';
import { auditScript, luminance } from './page-audit.mjs';
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

/** Change the window's size without reloading the page. */
async function setViewport({ page, browser }, width, height) {
  if (page.send) await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  else await browser.playwright.contexts().at(-1).pages().at(-1).setViewportSize({ width, height });
}

/** Runs in the page: lose the cockpit's WebGL context, wait for the page to notice, then restore it and wait for the black hole. */
async function loseAndRestore() {
  const lose = document.getElementById('ck-gl').getContext('webgl2')?.getExtension('WEBGL_lose_context');
  if (!lose) return 'missing';
  const until = async gl => {
    for (let i = 0; i < 100 && document.documentElement.dataset.gl !== gl; i += 1) await new Promise(resolve => setTimeout(resolve, 50));
    return document.documentElement.dataset.gl === gl;
  };
  lose.loseContext();
  if (!(await until('off'))) return 'the page did not notice a lost WebGL context';
  lose.restoreContext();
  if (!(await until('on'))) return 'the black hole did not come back after the WebGL context was restored';
  return 'ok';
}

/** The cockpit page's own frames: right after a resize, and after a lost and restored WebGL context. */
async function checkRecovery(context) {
  const { page, urls } = context;
  const url = `${Object.values(urls)[0]}cockpit?debug=1&quality=high`;
  await page.goto(url, 1440, 900);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
  const problems = [];
  const frameProblems = async (drawHole, when) => {
    const metrics = await page.evaluate(`(() => { const frame = cockpitDebug.readFrame(${drawHole}); return frame && (${analyseFrame})(frame); })()`);
    return metrics ? sceneProblems(metrics).map(problem => `${when}, ${problem}`) : [`${when}, no frame`];
  };
  const stage = "JSON.stringify(cockpitDebug.fit().stage)";
  let lost = 'ok';
  // With motion on a resize draws no still frame, so the next frame that reuses the black hole meets a new, empty target.
  const frames = await page.evaluate('cockpitDebug.frames()');
  await page.setReducedMotion(false);
  try {
    await page.waitFor(`cockpitDebug.frames() > ${frames}`);
    await page.evaluate(`cockpitDebug.setCamera(${JSON.stringify(REST)})`);
    const before = await page.evaluate(stage);
    await setViewport(context, 1280, 800);
    await page.waitFor(`${stage} !== ${JSON.stringify(before)}`);
    problems.push(...await frameProblems(false, 'right after a resize'));
    await setViewport(context, 1440, 900);
    await page.waitFor(`${stage} === ${JSON.stringify(before)}`);
    await page.evaluate('cockpitDebug.resume()');
    lost = await page.evaluate(`(${loseAndRestore})()`);
    if (lost !== 'ok' && lost !== 'missing') problems.push(lost);
    if (lost === 'ok') {
      problems.push(...await frameProblems(true, 'after a lost WebGL context'));
      await page.evaluate('cockpitDebug.resume()');
      if ((await framesOver(page, 500)) === 0) problems.push('after a lost WebGL context no frames are drawn');
    }
  } finally {
    await page.setReducedMotion(true);
  }
  return { problems, skipped: lost === 'missing' };
}

async function checkScene(context) {
  const { page, urls, options, stdout, stderr } = context;
  const url = `${Object.values(urls)[0]}?host=browser`;
  page.errors.length = 0;
  await page.goto(url, 1440, 900);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`);
  const result = await page.evaluate(`(${renderStill})(${analyseFrame})`);
  if (result.error) {
    const errors = consoleProblems(page.errors);
    for (const problem of [result.error, ...errors]) stderr.write(`scene: ${problem}\n`);
    return 1 + errors.length;
  }
  const problems = sceneProblems(result.still);
  const drift = Math.abs(result.reused.mean - result.still.mean) / result.still.mean;
  if (drift > 0.25) problems.push(`a frame that reuses the black hole differs in brightness by ${(drift * 100).toFixed(0)}%`);
  for (const problem of sceneProblems(result.reused)) problems.push(`a frame that reuses the black hole: ${problem}`);
  const recovery = await checkRecovery(context);
  problems.push(...recovery.problems, ...consoleProblems(page.errors));
  if (options.printMetrics) stdout.write(`scene metrics: ${JSON.stringify(result.still)}\n`);
  const after = recovery.skipped ? 'also after a resize (WEBGL_lose_context is missing, so the lost context part is skipped)' : 'also after a resize and a lost WebGL context';
  stdout.write(`Scene (${result.info.renderer}, ${result.info.hdr ? 'HDR' : '8-bit'} targets): ${problems.length ? `${problems.length} problems` : `shadow, ring, ceiling line, stars and desk in place, ${after}`}.\n`);
  for (const problem of problems) stderr.write(`scene: ${problem}\n`);
  return problems.length;
}

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

/** Browser errors as problems: the page wrappers record { message, url }; a plain string is kept as it is. */
export const consoleProblems = errors => errors.map(error => `console: ${typeof error === 'string' ? error : error.message}`);
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
  const linear = value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
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
      const lum = 0.2126 * linear(frame.data[i]) + 0.7152 * linear(frame.data[i + 1]) + 0.0722 * linear(frame.data[i + 2]);
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

/** Runs in the page: 36/40 px only for the clock, and monospace only in numbers, labels and times. */
function cockpitExtras(mono) {
  const issues = [];
  const normalised = family => family.replace(/["'\s]/g, '').toLowerCase();
  for (const el of document.querySelectorAll('.ck *')) {
    if (![...el.childNodes].some(node => node.nodeType === 3 && node.nodeValue.trim())) continue;
    if (el.getClientRects().length === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden') continue;
    if (parseFloat(style.fontSize) === 36 && !el.matches('.ck-hm')) issues.push({ rule: 'clock-only', target: el.className, detail: '36 px outside the clock' });
    if (parseFloat(style.lineHeight) === 40 && !el.matches('.ck-hm')) issues.push({ rule: 'clock-only', target: el.className, detail: '40 px line height outside the clock' });
    if (normalised(style.fontFamily) === mono && !el.closest('.ck-mono')) issues.push({ rule: 'mono', target: el.className, detail: 'monospace outside numbers and labels' });
  }
  return issues;
}

/** One cockpit state: open it, check the arrangement in 3D, then audit it flat over its scene colours. */
async function checkState({ page, options }, { url, width, height, expect, label, texts = [] }) {
  page.errors.length = 0;
  await page.goto(url, width, height);
  await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1'`);
  const problems = [];
  if (texts.length) {
    const content = await page.evaluate("document.querySelector('.ck').textContent");
    for (const text of texts) if (!content.includes(text)) problems.push(`the edge value ${text} did not reach the page`);
  }
  const shown = await page.evaluate("({ gl: document.documentElement.dataset.gl, fit: document.documentElement.dataset.fit, note: !document.getElementById('ck-note').hidden })");
  if (shown.fit !== expect.fit) problems.push(`the arrangement is ${shown.fit}, not ${expect.fit}`);
  if (shown.gl !== expect.gl) problems.push(`WebGL is ${shown.gl}, not ${expect.gl}`);
  if (shown.note !== (expect.fit !== 'ok')) problems.push(shown.note ? 'the note shows over the panels' : 'the note is missing');
  const rects = await page.evaluate(`(${readRects})()`);
  const fit = fitPanels(width, height);
  const s = fit.stage.scale;
  if (expect.fit === 'ok') {
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
  } else {
    for (const id of Object.keys(PANELS)) if (rects[id]) problems.push(`${id} shows although the window is too small`);
  }
  if (options.screenshots) writeFileSync(path.join(options.screenshots, `${label.replace(/[^\w]+/g, '-')}.png`), await page.screenshot());
  const backdrops = expect.gl === 'off'
    ? Object.fromEntries(Object.keys(rects).map(id => [id, NO_GL_BACKDROP]))
    : await page.evaluate(`(${sceneBackdrops})(${JSON.stringify(expandAll(rects, Math.ceil(32 * Math.max(1, s))))})`);
  if (expect.gl === 'on' && Math.max(...Object.values(backdrops).map(([r, g, b]) => luminance({ r: r / 255, g: g / 255, b: b / 255 }))) < 0.01) problems.push('the scene behind the panels is black; the frame was not drawn');
  const result = await page.evaluate(`(() => { (${prepareFlat})(${JSON.stringify(backdrops)}); return { audit: ${auditScript(COCKPIT_AUDIT)}, extras: (${cockpitExtras})(${JSON.stringify(MONO)}) }; })()`);
  problems.push(...[...cockpitIssues(result.audit.issues), ...result.extras].map(issue => `${issue.rule}: ${issue.target} (${issue.detail})`));
  problems.push(...consoleProblems(page.errors));
  return { problems: [...new Set(problems)], checks: result.audit.checks };
}

/** The example swarm with the longest values the cockpit's tightest places must take: a 7-digit PR id and a need naming five units. */
function edgeEngine() {
  const demo = createDemoEngine({ scenario: 'example', simulate: false });
  const stretch = snapshot => {
    if (!snapshot) return snapshot;
    const copy = structuredClone(snapshot);
    const withPr = copy.units.find(unit => unit.pr);
    if (withPr) withPr.pr.id = 1234567;
    if (copy.needs[0]) copy.needs[0].labels = copy.units.slice(0, 5).map(unit => unit.label);
    return copy;
  };
  return { ...demo, getSnapshot: async (...args) => stretch(await demo.getSnapshot(...args)) };
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
  // On the synthetic swarms, also the longest values and the out-of-date notice, at the smallest and a common window size.
  const edge = urls.example ? createDashboardServer({ createEngine: edgeEngine, port: 0, version: '0.1.0', hub: { engineIdleMs: 600000 } }) : null;
  try {
    if (edge) {
      await edge.listen();
      for (const [width, height] of [[1100, 800], [1440, 900]]) states.push({ label: `edge ${width}x${height}`, url: `${edge.url}cockpit?debug=1&quality=high&plugin=0.2.0`, width, height, expect: { fit: 'ok', gl: 'on' }, texts: ['1234567', 'B0 F2a B1 D5 I1', 'Dashboard server v0.1.0 is older than installed plugin v0.2.0'] });
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
  } finally {
    await edge?.close();
  }
  const sources = [...Object.keys(urls), ...(edge ? ['edge values'] : [])].join(', ');
  stdout.write(`Cockpit: checked ${states.length} states (${sources}; ${COCKPIT_SIZES.map(size => size.join(' × ')).join(', ')}; a ${SMALL_SIZE.join(' × ')} window; no WebGL): ${checks} checks, ${issues} issues.\n`);
  return issues;
}

async function framesOver(page, ms) {
  const before = await page.evaluate('cockpitDebug.frames()');
  await new Promise(resolve => setTimeout(resolve, ms));
  return (await page.evaluate('cockpitDebug.frames()')) - before;
}

/** Runs in the page: make the page believe the window is hidden, or visible again, and tell it. */
function setHidden(hidden) {
  if (hidden) {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
  } else {
    delete document.hidden;
    delete document.visibilityState;
  }
  document.dispatchEvent(new Event('visibilitychange'));
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
  const draws = () => page.evaluate('cockpitDebug.draws()');
  const first = await draws();
  if (first !== 1) problems.push(`under reduced motion the page drew ${first} frames at start, not 1`);
  const still = await framesOver(page, 600);
  if (still !== 0) problems.push(`under reduced motion the scene drew ${still} frames in 600 ms`);
  let moving = 0;
  let hidden = false;
  try {
    const before = await draws();
    hidden = true;
    await page.evaluate(`(${setHidden})(true)`);
    await page.setReducedMotion(false);
    await new Promise(resolve => setTimeout(resolve, 600));
    await page.evaluate("dispatchEvent(new Event('resize'))");
    await new Promise(resolve => setTimeout(resolve, 300));
    const drawn = (await draws()) - before;
    if (drawn !== 0) problems.push(`while the window was hidden the page drew ${drawn} frames`);
    hidden = false;
    await page.evaluate(`(${setHidden})(false)`);
    await framesOver(page, 300);
    moving = await framesOver(page, 1000);
  } finally {
    if (hidden) await page.evaluate(`(${setHidden})(false)`);
    await page.setReducedMotion(true);
  }
  if (moving < 20 || moving > 33) problems.push(`with motion on the scene drew ${moving} frames in a second, outside 20–33`);
  stdout.write(`Cockpit motion: ${problems.length ? `${problems.length} problems` : `one still frame under reduced motion, none while hidden; ${moving} frames a second otherwise`}.\n`);
  for (const problem of problems) stderr.write(`motion: ${problem}\n`);
  return problems.length;
}

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

/** Chrome only: links follow the shown swarm, reject unknown units and clear stale canvas addresses. */
async function checkLinks({ page, browser, urls, engine, stdout, stderr }) {
  if (engine !== 'chrome' || !urls.example || !urls.stress) {
    stdout.write('Cockpit links: checked in Chrome, on the synthetic example and stress swarms.\n');
    return 0;
  }
  const problems = [];
  page.errors.length = 0;
  const goRegular = async (url, width = 1440) => {
    await page.goto(url, width, 900);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1' && document.querySelector('[data-cockpit]') !== null`);
  };
  const pick = async swarm => {
    await page.evaluate(`(() => {
      const picker = document.querySelector('select[data-swarm]');
      picker.value = ${JSON.stringify(swarm)};
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await page.waitFor(`document.querySelector('select[data-swarm]')?.value === ${JSON.stringify(swarm)} && document.querySelector('[data-open="${swarm === 'ws-8000-root' ? 'ws-8005-i1' : 'ws-0005-i1'}"]') !== null`);
  };
  const clickControl = () => page.send('Runtime.evaluate', { expression: "document.querySelector('[data-cockpit]').click()", userGesture: true });
  const cockpitTarget = info => info.type === 'page' && info.url.includes('/cockpit?');
  const regular = `${urls.example}?host=browser&swarm=ws-0000-root`;
  await goRegular(regular);
  await page.evaluate(`(() => {
    window.swarmKept = true;
    window.swarmUnknownHandled = false;
    window.addEventListener('message', event => {
      if (event.origin === location.origin && event.data?.kind === 'swarm-dashboard:show' && event.data.detail === 'ws-unknown-unit') window.swarmUnknownHandled = true;
    });
  })()`);
  const known = new Set((await browser.send('Target.getTargets')).targetInfos.map(info => info.targetId));
  let changing;
  try {
    await clickControl();
    const opened = await waitForTarget(browser, known, cockpitTarget, 5000);
    if (!opened) {
      problems.push('the Cockpit control opened no window');
    } else {
      if (new URL(opened.url).searchParams.get('swarm') !== 'ws-0000-root') problems.push(`the cockpit opened at ${opened.url}`);
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: opened.targetId, flatten: true });
      const inCockpit = async (expression, userGesture = false) => {
        const { result, exceptionDetails } = await browser.send('Runtime.evaluate', { expression, returnByValue: true, userGesture }, sessionId);
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
      };
      const tile = "document.querySelector('.ck-tile[data-detail=\"ws-0005-i1\"]')";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !await inCockpit(`${tile} !== null`)) await new Promise(resolve => setTimeout(resolve, 100));
      if (!await inCockpit(`${tile} !== null`)) {
        problems.push('the expected tile I1 never appeared in the cockpit');
      } else {
        await inCockpit(`window.open('', 'swarm-dashboard').postMessage({ kind: 'swarm-dashboard:show', swarm: 'ws-0000-root', detail: 'ws-unknown-unit', tab: null }, location.origin)`, true);
        try {
          await page.waitFor(`window.swarmUnknownHandled === true && window.swarmKept === true && location.href === ${JSON.stringify(regular)} && document.querySelector('.detail') === null`, 5000);
        } catch {
          problems.push('an unknown unit request opened details or navigated the regular window, or was not received');
        }
        await inCockpit(`${tile}.click()`, true);
        try {
          await page.waitFor("document.querySelector('.detail[aria-label=\"Details for I1\"]') !== null && window.swarmKept === true", 5000);
        } catch {
          problems.push('a tile in the cockpit did not open its details in the regular window in place');
        }
      }
      await browser.send('Target.closeTarget', { targetId: opened.targetId });
    }

    // No swarm in the address: the picker, not the URL or the server's default, decides what Cockpit opens.
    await goRegular(`${urls.stress}?host=browser`);
    await pick('ws-8000-root');
    await clickControl();
    const picked = await waitForTarget(browser, known, cockpitTarget, 5000);
    if (!picked) {
      problems.push('the Cockpit control opened no window for the picked swarm');
    } else {
      if (new URL(picked.url).searchParams.get('swarm') !== 'ws-8000-root') problems.push(`the picked swarm's cockpit opened at ${picked.url}`);
      await browser.send('Target.closeTarget', { targetId: picked.targetId });
    }

    await goRegular(`${urls.stress}?host=canvas`, 480);
    await pick('ws-8000-root');
    const before = new Set((await browser.send('Target.getTargets')).targetInfos.map(info => info.targetId));
    await clickControl();
    try {
      await page.waitFor("(document.querySelector('.ck-addr-url')?.textContent ?? '').endsWith('/cockpit?swarm=ws-8000-root')", 3000);
    } catch {
      problems.push('in the canvas the control did not show the picked swarm\'s cockpit address');
    }
    if (await waitForTarget(browser, before, info => info.type === 'page', 500)) problems.push('in the canvas the control opened a window');
    await pick('ws-0000-root');
    if (await page.evaluate("document.querySelector('.ck-addr') !== null")) problems.push('in the canvas picking another swarm kept the old cockpit address');

    // With no picked swarm, the hub moves the page to another live swarm when the shown one finishes.
    const demo = createDemoEngine({ scenario: 'stress', simulate: false });
    changing = createDashboardServer({ createEngine: () => demo, port: 0, version: 'cockpit-check', hub: { engineIdleMs: 600000 } });
    await changing.listen();
    await goRegular(`${changing.url}?host=canvas`, 480);
    await page.waitFor("document.querySelector('[data-open=\"ws-0005-i1\"]') !== null");
    await clickControl();
    await page.waitFor("(document.querySelector('.ck-addr-url')?.textContent ?? '').endsWith('/cockpit?swarm=ws-0000-root')");
    const finished = await demo.getSnapshot('ws-0000-root');
    finished.run.lifecycle = 'finished';
    finished.run.finishedAt = Date.now();
    finished.revision += 1;
    demo.push(finished);
    await page.waitFor("document.querySelector('[data-open=\"ws-8005-i1\"]') !== null");
    try {
      await page.waitFor("document.querySelector('.ck-addr') === null", 3000);
    } catch {
      problems.push('in the canvas an automatic swarm change kept the old cockpit address');
    }
  } catch (error) {
    problems.push(error.message);
  } finally {
    // List again rather than relying on the targets already observed: a popup may have opened late.
    const { targetInfos } = await browser.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    for (const info of targetInfos) {
      if (!known.has(info.targetId) && info.type === 'page') await browser.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
    await page.evaluate("window.name = ''").catch(() => {});
    await page.goto('about:blank', 1440).then(() => page.waitFor("location.href === 'about:blank'")).catch(() => {});
    await changing?.close().catch(() => {});
  }
  problems.push(...consoleProblems(page.errors));
  stdout.write(`Cockpit links: ${problems.length ? `${problems.length} problems` : 'the control opens the cockpit on the picked swarm, a tile opens its details in place, unknown units do not navigate, and in the canvas the address names the shown swarm and clears when it changes'}.\n`);
  for (const problem of problems) stderr.write(`links: ${problem}\n`);
  return problems.length;
}

/** Native pointer clicks in the real 3D layout must reach the quality switch and persist across reloads. */
async function checkQuality({ page, browser, urls, stdout, stderr }) {
  if (!urls.example) {
    stdout.write('Cockpit quality: checked on the synthetic example swarm.\n');
    return 0;
  }
  const problems = [];
  page.errors.length = 0;
  const url = `${urls.example}cockpit?debug=1`;
  const key = JSON.stringify(STORE_KEY);
  const evaluate = expression => bounded(page.evaluate(expression), 5000, 'The quality check');
  const go = async target => {
    await bounded(page.goto(target, 1440, 900), 10000, 'The quality check navigation');
    await bounded(page.waitFor(`location.href === ${JSON.stringify(target)} && document.documentElement.dataset.ready === '1'${target === url ? " && document.documentElement.dataset.fit === 'ok'" : ''}`, 8000), 10000, 'The quality check readiness');
  };
  const state = `({
    high: document.querySelector('[data-quality="high"]')?.getAttribute('aria-pressed'),
    balanced: document.querySelector('[data-quality="balanced"]')?.getAttribute('aria-pressed'),
    saved: JSON.parse(localStorage.getItem(${key}) ?? 'null')?.quality ?? null
  })`;
  const expectQuality = async (quality, when, stored = true) => {
    const want = { high: String(quality === 'high'), balanced: String(quality === 'balanced'), saved: stored ? quality : null };
    const matches = `(() => { const got = ${state}; return ${Object.entries(want).map(([name, value]) => `got.${name} === ${JSON.stringify(value)}`).join(' && ')}; })()`;
    await bounded(page.waitFor(matches, 2000), 4000, 'The quality check state').catch(() => {});
    const got = await evaluate(state);
    for (const [name, value] of Object.entries(want)) {
      if (got[name] !== value) problems.push(`${when}: ${name === 'saved' ? 'stored quality' : `${name} aria-pressed`} is ${JSON.stringify(got[name])}, expected ${JSON.stringify(value)}`);
    }
  };
  const clickQuality = async quality => {
    const { x, y } = await evaluate(`(() => {
      const r = document.querySelector('[data-quality="${quality}"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (page.send) {
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await bounded(page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }), 5000, 'The quality check pointer');
      }
    } else {
      await bounded(browser.playwright.contexts().at(-1).pages().at(-1).mouse.click(x, y), 5000, 'The quality check pointer');
    }
  };
  try {
    // Storage belongs to the origin: clear it there before loading a fresh cockpit without a quality override.
    await go(`${urls.example}?host=browser`);
    await evaluate(`localStorage.removeItem(${key})`);
    await go(url);
    await expectQuality('high', 'at first load', false);
    const hits = await evaluate(`(() => {
      const targets = [...document.querySelectorAll('[data-quality]'), ...['.ck-tile', '#ck-cost', '.ck-need'].map(selector => document.querySelector(selector))];
      return targets.map((element, index) => {
        const label = index < targets.length - 3 ? element.dataset.quality + ' button' : ['console tile', 'Cost panel', 'Needs-you item'][index - (targets.length - 3)];
        if (!element) return { label, reachable: false, hit: 'missing element' };
        const r = element.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { label, reachable: element.contains(hit), hit: hit ? (hit.id ? '#' + hit.id : hit.tagName.toLowerCase() + '.' + [...hit.classList].join('.')) : 'nothing' };
      });
    })()`);
    for (const hit of hits) if (!hit.reachable) problems.push(`${hit.label}'s centre hits ${hit.hit}, not the element or a descendant`);
    for (const quality of ['balanced', 'high']) {
      await clickQuality(quality);
      await expectQuality(quality, `after clicking ${quality}`);
      await go(url);
      await expectQuality(quality, `after reloading ${quality}`);
    }
  } catch (error) {
    problems.push(error.message);
  } finally {
    await evaluate(`localStorage.removeItem(${key})`).catch(error => problems.push(`clearing the stored choice: ${error.message}`));
  }
  problems.push(...consoleProblems(page.errors));
  stdout.write(`Cockpit quality: ${problems.length ? `${problems.length} problems` : 'the High and Balanced buttons take pointer clicks in the 3D layout, and the choice is saved and kept after a reload'}.\n`);
  for (const problem of problems) stderr.write(`quality: ${problem}\n`);
  return problems.length;
}

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A DevTools call that gives up after `ms`, so no wait in the slowdown check depends on the page answering. */
async function bounded(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Close every page target that was not there before and poll (bounded) until they have left Target.getTargets;
 * close any that remain once more and poll again. Returns the new page targets still open (empty when all closed).
 */
async function closeNewPages(browser, known) {
  // List again rather than relying on the targets already observed: a popup may have opened late.
  const fresh = async () => (await bounded(browser.send('Target.getTargets'), 5000, 'Chrome')).targetInfos.filter(info => !known.has(info.targetId) && info.type === 'page');
  let remaining = await fresh();
  for (let round = 0; round < 2 && remaining.length; round += 1) {
    for (const info of remaining) await bounded(browser.send('Target.closeTarget', { targetId: info.targetId }), 5000, 'Chrome').catch(() => {});
    const deadline = Date.now() + 3000;
    while ((remaining = await fresh()).length && Date.now() < deadline) await sleep(100);
  }
  return remaining;
}

const COCKPIT_STATE = `(() => {
  const data = document.documentElement.dataset;
  return { href: location.href, ready: data.ready ?? null, fit: data.fit ?? null, gl: data.gl ?? null, visibility: document.visibilityState, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, draws: window.cockpitDebug?.draws() ?? null };
})()`;

/**
 * Open the cockpit with the regular page's control, size it to 1440 × 900, reload it with debug=1 in the same window,
 * and confirm it is drawing: visible, reduced motion off, and at least 20 draws in a second timed here in Node.
 * Returns a problem, or null when the cockpit is drawing.
 */
async function openDrawingCockpit({ page, browser }, known) {
  await bounded(page.send('Runtime.evaluate', { expression: "document.querySelector('[data-cockpit]').click()", userGesture: true }), 5000, 'The regular page');
  const opened = await waitForTarget(browser, known, info => info.type === 'page' && info.url.includes('/cockpit?'), 5000);
  if (!opened) return 'the Cockpit control opened no window';
  const { sessionId } = await bounded(browser.send('Target.attachToTarget', { targetId: opened.targetId, flatten: true }), 5000, 'The cockpit');
  const send = (method, params) => bounded(browser.send(method, params, sessionId), 5000, `The cockpit (${method})`);
  const read = async () => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression: COCKPIT_STATE, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const url = new URL(opened.url);
  url.searchParams.set('debug', '1');
  await send('Page.navigate', { url: url.href });
  let state = null;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    // Reads fail while the page is between documents; poll again.
    state = await read().catch(() => null);
    if (state?.href === url.href && state.ready === '1' && state.fit === 'ok' && state.gl === 'on') break;
    await sleep(100);
  }
  const missing = state?.href !== url.href ? ['the reload with debug=1'] : [['ready', '1'], ['fit', 'ok'], ['gl', 'on']].filter(([key, want]) => state[key] !== want).map(([key, want]) => `data-${key}="${want}" (got ${state[key] === null ? 'none' : `"${state[key]}"`})`);
  if (missing.length) return `the cockpit at 1440 × 900 did not reach ${missing.join(', ')} within 10 s`;
  if (state.visibility !== 'visible' || state.reduced) return `the cockpit cannot draw (visibility ${state.visibility}, reduced motion ${state.reduced ? 'on' : 'off'}), so the comparison would mean nothing`;
  const before = state.draws;
  await sleep(1000);
  const after = (await read()).draws;
  if (!(after - before >= 20)) return `the cockpit drew ${after - before} frames in a second (at least 20 needed), so the comparison would mean nothing`;
  return null;
}

const msText = value => `${value.toFixed(1)} ms`;

/** Chrome only: the regular view's live updates cost no more with a cockpit window open beside it (anti-goal 5). */
async function checkSlowdown({ page, browser, urls, engine, stdout, stderr }) {
  if (engine !== 'chrome' || !urls.example) {
    stdout.write('Regular view with a cockpit open: measured in Chrome, on the synthetic swarm.\n');
    return 0;
  }
  const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: true, stepMs: 1000 }), port: 0, version: 'cockpit-check' });
  await server.listen();
  const problems = [];
  let known = null;
  let line = null;
  let skipped = false;
  try {
    const url = `${server.url}?host=browser`;
    await page.goto(url, 1440, 900);
    await page.waitFor(`location.href === ${JSON.stringify(url)} && document.documentElement.dataset.ready === '1' && document.querySelector('[data-cockpit]') !== null`);
    known = new Set((await bounded(browser.send('Target.getTargets'), 5000, 'Chrome')).targetInfos.map(info => info.targetId));
    // Warm up, then alone, with the cockpit drawing beside, and alone again (the cockpit closed), so warm-up and drift show.
    await updateTimes(page, 3, 10000);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const alone = await updateTimes(page, 6, 20000);
      const problem = await openDrawingCockpit({ page, browser }, known);
      if (problem) {
        problems.push(problem);
        break;
      }
      const beside = await updateTimes(page, 6, 20000);
      // Measure "alone again" (and any second triple) only once the cockpit has really closed.
      if ((await closeNewPages(browser, known)).length) {
        problems.push('the cockpit window did not close, so the regular view was not measured alone again');
        skipped = true;
        break;
      }
      const again = await updateTimes(page, 6, 20000);
      if (alone.length < 4 || beside.length < 4 || again.length < 4) {
        problems.push(`too few live updates arrived to compare (${alone.length}, ${beside.length} and ${again.length})`);
        break;
      }
      const [first, withCockpit, second] = [median(alone), median(beside), median(again)];
      const medians = `${msText(first)} alone, ${msText(withCockpit)} with the cockpit, ${msText(second)} alone again`;
      if (Math.abs(first - second) > 0.5 * Math.min(first, second) + 2) {
        if (attempt === 2) problems.push(`the regular view's update times drifted too much to compare (${medians}, twice)`);
        continue;
      }
      const baseline = (first + second) / 2;
      if (withCockpit > baseline * 1.25 + 2) problems.push(`the regular view's updates took ${msText(withCockpit)} with a cockpit open, against ${msText(baseline)} alone (${medians})`);
      line = `updates ${msText(first)} median alone, ${msText(withCockpit)} with the cockpit drawing beside it, ${msText(second)} alone again`;
      break;
    }
  } catch (error) {
    problems.push(error.message);
  } finally {
    if (known) await closeNewPages(browser, known).catch(() => {});
    await page.evaluate("window.name = ''").catch(() => {});
    await page.goto('about:blank', 1440).then(() => page.waitFor("location.href === 'about:blank'")).catch(() => {});
    await server.close().catch(() => {});
  }
  const summary = problems.length ? `${problems.length} problems` : line;
  stdout.write(`Regular view with a cockpit open: ${skipped ? `not compared, because the cockpit window did not close (${summary})` : summary}.\n`);
  for (const problem of problems) stderr.write(`slowdown: ${problem}\n`);
  return problems.length;
}

/** The cockpit's checks in the order they run. */
export const CHECKS = new Map([['scene', checkScene], ['layout', checkLayout], ['motion', checkMotion], ['links', checkLinks], ['quality', checkQuality], ['slowdown', checkSlowdown]]);

export async function runCockpitChecks(context) {
  let issues = 0;
  for (const [name, check] of CHECKS) {
    if (context.options.only && context.options.only !== name) continue;
    issues += await check(context);
  }
  return { issues };
}
