import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createDemoEngine } from '../../server/demo-engine.mjs';
import { createDashboardServer } from '../../server/http.mjs';
import { PANELS, fitPanels, overlapProblems } from '../../ui/cockpit-fit.mjs';
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
    const consoleProblems = page.errors.map(message => `console: ${message}`);
    for (const problem of [result.error, ...consoleProblems]) stderr.write(`scene: ${problem}\n`);
    return 1 + consoleProblems.length;
  }
  const problems = sceneProblems(result.still);
  const drift = Math.abs(result.reused.mean - result.still.mean) / result.still.mean;
  if (drift > 0.25) problems.push(`a frame that reuses the black hole differs in brightness by ${(drift * 100).toFixed(0)}%`);
  for (const problem of sceneProblems(result.reused)) problems.push(`a frame that reuses the black hole: ${problem}`);
  const recovery = await checkRecovery(context);
  problems.push(...recovery.problems, ...page.errors.map(message => `console: ${message}`));
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
  problems.push(...page.errors.map(message => `console: ${message}`));
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
  // On the synthetic swarms, also the longest values, at the smallest and a common window size.
  const edge = urls.example ? createDashboardServer({ createEngine: edgeEngine, port: 0, version: 'cockpit-check', hub: { engineIdleMs: 600000 } }) : null;
  try {
    if (edge) {
      await edge.listen();
      for (const [width, height] of [[1100, 800], [1440, 900]]) states.push({ label: `edge ${width}x${height}`, url: `${edge.url}cockpit?debug=1&quality=high`, width, height, expect: { fit: 'ok', gl: 'on' }, texts: ['1234567', 'B0 F2a B1 D5 I1'] });
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

    // A real lifecycle event changes the shown swarm without the picker; its old address must disappear too.
    const demo = createDemoEngine({ scenario: 'stress', simulate: false });
    changing = createDashboardServer({ createEngine: () => demo, port: 0, version: 'cockpit-check', hub: { engineIdleMs: 600000 } });
    await changing.listen();
    await goRegular(`${changing.url}?host=canvas`, 480);
    await pick('ws-8000-root');
    await clickControl();
    await page.waitFor("(document.querySelector('.ck-addr-url')?.textContent ?? '').endsWith('/cockpit?swarm=ws-8000-root')");
    const finished = await demo.getSnapshot('ws-8000-root');
    finished.run.lifecycle = 'finished';
    finished.run.finishedAt = Date.now();
    finished.revision += 1;
    demo.push(finished);
    await page.waitFor("document.querySelector('[data-open=\"ws-0005-i1\"]') !== null");
    try {
      await page.waitFor("document.querySelector('.ck-addr') === null", 3000);
    } catch {
      problems.push('in the canvas an automatic swarm change kept the old cockpit address');
    }
  } catch (error) {
    problems.push(error.message);
  } finally {
    try {
      // List again rather than relying on the targets already observed: a popup may have opened late.
      const { targetInfos } = await browser.send('Target.getTargets');
      for (const info of targetInfos) if (!known.has(info.targetId) && cockpitTarget(info)) await browser.send('Target.closeTarget', { targetId: info.targetId });
    } finally {
      try {
        await page.evaluate("window.name = ''");
      } finally {
        await changing?.close();
      }
    }
  }
  problems.push(...page.errors.map(message => `console: ${message}`));
  stdout.write(`Cockpit links: ${problems.length ? `${problems.length} problems` : 'the control opens the cockpit on the picked swarm, a tile opens its details in place, unknown units do not navigate, and canvas addresses follow picker and automatic swarm changes'}.\n`);
  for (const problem of problems) stderr.write(`links: ${problem}\n`);
  return problems.length;
}

/** The cockpit's checks in the order they run. Task 13 adds slowdown. */
export const CHECKS = new Map([['scene', checkScene], ['layout', checkLayout], ['motion', checkMotion], ['links', checkLinks]]);

export async function runCockpitChecks(context) {
  let issues = 0;
  for (const [name, check] of CHECKS) {
    if (context.options.only && context.options.only !== name) continue;
    issues += await check(context);
  }
  return { issues };
}
