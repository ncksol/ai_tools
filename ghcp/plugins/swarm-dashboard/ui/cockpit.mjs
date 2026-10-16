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
function withoutGl(error) {
  renderer = null;
  root.dataset.gl = 'off';
  console.warn(`The cockpit shows its panels without the black hole: ${error.message}`);
}
function buildRenderer() {
  try {
    if (params.get('gl') === '0') throw new Error('WebGL is turned off in the address');
    renderer = createRenderer(canvas);
    root.dataset.gl = 'on';
  } catch (error) {
    withoutGl(error);
  }
}
buildRenderer();
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  renderer = null;
  root.dataset.gl = 'off';
});
canvas.addEventListener('webglcontextrestored', () => {
  if (params.get('gl') === '0') return;
  buildRenderer();
  if (!renderer) return;
  layout();
  start();
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
let draws = 0;
const started = performance.now();
const running = () => loopRuns({ hidden: document.hidden, reduced: reduced.matches });
const sceneView = time => ({ design: [fit.stage.designWidth, DESIGN_HEIGHT], focal: FOCAL, time, view: viewMatrix(cam.yaw, cam.pitch), cam: [cam.x, cam.y, 0], exposure: SCENE.exposure, bloom: SCENE.bloom });

function draw(view, drawHole) {
  if (!renderer) return;
  renderer.render(view, drawHole);
  draws += 1;
}

function drawStill() {
  cam = { ...REST };
  world.style.transform = worldCss(cam);
  if (!document.hidden) draw(sceneView(STILL_TIME), true);
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
    withoutGl(error);
  }
}

function step(time) {
  raf = requestAnimationFrame(step);
  if (!frameDue(time, last)) return;
  const interval = last === null ? null : time - last;
  last = time;
  const seconds = (time - started) / 1000 + 20;
  cam = easeCamera(cam, cameraTarget(seconds, pointer.x, pointer.y), interval === null ? 0 : Math.min(0.1, interval / 1000));
  world.style.transform = worldCss(cam);
  draw(sceneView(seconds), drawsHole(state.quality, frame, time, pointer.at));
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
  resizeTimer = setTimeout(() => {
    layout();
    if (!running()) drawStill();
  }, 120);
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
    draws: () => draws,
    info: () => renderer?.info() ?? null,
    setCamera(next) {
      cancelAnimationFrame(raf);
      cam = { ...next };
      world.style.transform = worldCss(cam);
      return true;
    },
    readFrame(drawHole = true) {
      if (!renderer) return null;
      renderer.render(sceneView(STILL_TIME), drawHole);
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
