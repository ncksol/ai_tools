import { coalesced, isNarrow, lifecycleKey, renderApp, staleChoice } from './app.mjs';
import { tickText } from './format.mjs';
import { morph } from './morph.mjs';
import { runEnd, unitEnd } from './model.mjs';
import { shortLabel } from './parts.mjs';
import { planFits, planGraphHtml, planListHtml } from './plan.mjs';
import { axisSvg, costSvg, laneSource, laneSvg, timelineWindow } from './timeline.mjs';

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
const urlSwarm = params.get('swarm');
document.documentElement.dataset.host = params.get('host') === 'canvas' ? 'canvas' : 'browser';

const view = {
  page: choose(params.get('page'), PAGES, 'live'),
  tab: choose(params.get('tab') ?? saved.tab, TABS, 'cards'),
  span: choose(params.get('span') ?? saved.span, SPANS, '12h'),
  detail: params.get('detail'),
  runId: params.get('run'),
  swarm: urlSwarm ?? (params.get('session') ? null : saved.swarm ?? null),
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

// A swarm named in the address always applies; a picked or remembered one only while it is live.
let swarmFromUrl = Boolean(urlSwarm);
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
let lifecycle = null;
let wasOpen = false;
let historyAsked = false;
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
    // After a reconnect the server may know runs that finished meanwhile.
    if (wasOpen && historyAsked) reloadHistory();
    wasOpen = true;
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
    // A run that finishes moves into History, so reload it in place when the swarms' lifecycles change.
    const key = lifecycleKey(view.swarms);
    if (lifecycle !== null && key !== lifecycle && historyAsked) reloadHistory();
    lifecycle = key;
    if (staleChoice(view.swarm, swarmFromUrl, view.swarms)) {
      view.swarm = null;
      view.snapshot = null;
      view.loaded = false;
      view.detail = null;
      save();
      connect();
    }
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
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
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
    if (session) {
      const end = session === view.snapshot.orchestrator ? runEnd(view.snapshot) : unitEnd(session, view.snapshot);
      morph(row.querySelector('.c-trk'), laneSvg(laneSource(session, view.snapshot), width, t0, t1, t, phaseMs, end));
    }
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

/** Load finished runs. Only the first load shows the loading state; later loads replace the list in place. */
const loadHistory = coalesced(async () => {
  try {
    const response = await fetch('/api/history');
    if (response.ok) view.runs = await response.json();
    else if (view.runs === null) view.runs = [];
  } catch {
    if (view.runs === null) view.runs = [];
  }
  scheduleRender();
});

/** Ask for History. Once asked, later triggers reload it, queued behind a first load still in flight. */
function reloadHistory() {
  historyAsked = true;
  loadHistory();
}

async function loadRun(id) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`);
    const run = response.ok ? await response.json() : false;
    // A slow answer for a run the user has left must not replace the one shown.
    if (view.runId === id) view.run = run;
  } catch {
    if (view.runId === id) view.run = false;
  }
  scheduleRender();
}

function act(target) {
  const el = target.closest('[data-page],[data-tab],[data-span],[data-close],[data-open],[data-run]');
  if (!el || !dash.contains(el)) return;
  if (el.dataset.page) {
    view.page = el.dataset.page;
    view.detail = null;
    if (view.page === 'history') reloadHistory();
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
  swarmFromUrl = false;
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
  // A full render, not only a redraw of the lanes: which sub-agent rows exist depends on the window, which moves with now.
  if (ticks % 15 === 0 && view.page === 'live' && view.tab === 'timeline' && view.snapshot) scheduleRender();
}, 1000);

// Browsers allow few connections per host, so free the live connection when the page is unloaded or kept in the back-forward cache.
window.addEventListener('pagehide', () => {
  clearTimeout(reconnectTimer);
  source?.close();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) connect();
});

if (view.page === 'history') reloadHistory();
if (view.page === 'run') loadRun(view.runId);
connect();
render();
