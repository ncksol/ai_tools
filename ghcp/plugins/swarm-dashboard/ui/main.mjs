import { PICK_KEY, RELOAD_KEY, RESTORED_KEY, SHOWN_KEY, baseSearch, coalesced, historyReloadWanted, isNarrow, keptDefault, lifecycleKey, reloadCarry, reloadDecision, reloadSearch, renderApp, staleChoice, staleShown, startShown, startSwarm } from './app.mjs';
import { tickText } from './format.mjs';
import { morph } from './morph.mjs';
import { nextCardChange, runEnd, unitEnd } from './model.mjs';
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
// An empty parameter is no parameter, as on the server.
const urlSwarm = params.get('swarm') || null;
const urlSession = params.get('session') || null;
/** After a self-reload: the swarm picked or shown by default before it, and whether the address still carries the reload's state. */
let restoredPick = null;
let restoredShown = null;
let restored = false;
try {
  restoredPick = sessionStorage.getItem(PICK_KEY);
  restoredShown = sessionStorage.getItem(SHOWN_KEY);
  restored = sessionStorage.getItem(RESTORED_KEY) === '1';
  sessionStorage.removeItem(PICK_KEY);
  sessionStorage.removeItem(SHOWN_KEY);
  sessionStorage.removeItem(RESTORED_KEY);
} catch {
  // Without sessionStorage there was no self-reload to restore.
}
document.documentElement.dataset.host = params.get('host') === 'canvas' ? 'canvas' : 'browser';

const view = {
  page: choose(params.get('page'), PAGES, 'live'),
  tab: choose(params.get('tab') ?? saved.tab, TABS, 'cards'),
  span: choose(params.get('span') ?? saved.span, SPANS, '12h'),
  detail: params.get('detail'),
  runId: params.get('run'),
  /** The page's own swarm: addressed, picked or remembered. The UI, the picker and save() read only this. */
  swarm: startSwarm({ urlSwarm, restoredPick, restoredShown, session: urlSession, savedSwarm: saved.swarm }),
  session: urlSession,
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
// The self-reload carried the page's state in the address; drop it now, so a later manual reload shows the saved state.
if (restored) history.replaceState(null, '', `${location.pathname}${baseSearch(params) ? `?${baseSearch(params)}` : ''}`);

// A swarm named in the address always applies; a picked or remembered one only while it is live.
let swarmFromUrl = Boolean(urlSwarm);
// The transport swarm: the swarm a page with no swarm of its own showed by default, which it asks for on the wire after a
// self-reload or a reconnect. It is never the page's own choice, so the UI, the picker and save() never see it, and it
// gives way as a default page does on the server. Only connect(), the swarms handler and considerReload use it.
let shownSwarm = startShown({ urlSwarm, restoredPick, restoredShown, session: urlSession });
let offset = 0;
let source = null;
let reconnectTimer = null;
/** Renders when a finished sub-agent's card is due to start its fade or to leave, even if no snapshot arrives. */
let cardTimer = null;
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
/** The UI fingerprint this page was served with, and the one the server now has (from hello). */
const ownUi = document.querySelector('meta[name="swarm-ui"]')?.content || null;
let servedUi = null;
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
  // The server pins a page that asked for no swarm only for one connection, so a page with no swarm of its own asks for
  // the swarm on screen (or, before its first snapshot, the transport swarm it already had) when it connects again,
  // instead of landing on whatever is the default now. That is a transport swarm only: the page stays a default page.
  shownSwarm = view.swarm ? null : keptDefault({ swarm: null, session: view.session, onScreen: view.snapshot?.run.id ?? shownSwarm, swarms: view.swarms });
  const asked = view.swarm || shownSwarm;
  const query = new URLSearchParams();
  if (asked) query.set('swarm', asked);
  else if (view.session) query.set('session', view.session);
  const search = query.toString();
  const own = new EventSource(`/api/events${search ? `?${search}` : ''}`);
  source = own;
  source.addEventListener('open', () => {
    justConnected = true;
    view.connection = 'open';
    // After a reconnect the server may know runs that finished meanwhile.
    if (wasOpen && historyAsked) reloadHistory();
    wasOpen = true;
    scheduleRender();
  });
  source.addEventListener('error', () => {
    // A late error from a connection that has since been replaced must never close the new one.
    if (source !== own) return;
    view.connection = 'retrying';
    // The server may be down or replaced; wait for the next hello before deciding to reload.
    servedUi = null;
    scheduleRender();
    // EventSource's own retry would reuse this connection's address, so reconnect through connect() instead, which asks
    // for the page's current state, after the same 2 s as the server's retry.
    own.close();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  });
  source.addEventListener('hello', event => {
    const data = JSON.parse(event.data);
    offset = data.serverNow - Date.now();
    view.demo = Boolean(data.demo);
    servedUi = data.ui ?? null;
    considerReload();
  });
  source.addEventListener('swarms', event => {
    view.swarms = JSON.parse(event.data);
    // A run that finishes moves into History, so reload it in place when the swarms' lifecycles change,
    // and once on the first event, because History may have answered before this state.
    const key = lifecycleKey(view.swarms);
    if (historyReloadWanted({ asked: historyAsked, previousKey: lifecycle, key })) reloadHistory();
    lifecycle = key;
    if (staleChoice(view.swarm, swarmFromUrl, view.swarms) || (!view.swarm && staleShown(shownSwarm, view.swarms))) {
      view.swarm = null;
      shownSwarm = null;
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

/** Reload once into the new dashboard files, keeping what is on screen; see reloadDecision. */
function considerReload() {
  // Only into a server that is there: a tab that becomes visible while disconnected waits for the next hello.
  if (source?.readyState !== EventSource.OPEN) return;
  let attempted;
  try {
    attempted = sessionStorage.getItem(RELOAD_KEY);
  } catch {
    return; // Without sessionStorage the attempt cannot be remembered, so never reload.
  }
  if (reloadDecision({ own: ownUi, served: servedUi, attempted, hidden: document.visibilityState === 'hidden' }) !== 'reload') return;
  try {
    sessionStorage.setItem(RELOAD_KEY, servedUi);
    // A picked swarm, or the swarm a default page shows, is not written to the address, so carry it in this tab's
    // storage; each tab restores its own. The shown one travels apart, so the reloaded page keeps it a transport swarm.
    const carry = reloadCarry({ swarm: view.swarm, fromUrl: swarmFromUrl, session: view.session, onScreen: view.snapshot?.run.id ?? null, transport: shownSwarm, swarms: view.swarms });
    if (carry.pick) sessionStorage.setItem(PICK_KEY, carry.pick);
    else sessionStorage.removeItem(PICK_KEY);
    if (carry.shown) sessionStorage.setItem(SHOWN_KEY, carry.shown);
    else sessionStorage.removeItem(SHOWN_KEY);
    sessionStorage.setItem(RESTORED_KEY, '1');
  } catch {
    return;
  }
  save();
  history.replaceState(null, '', `${location.pathname}?${reloadSearch(view, params, swarmFromUrl)}`);
  location.reload();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') considerReload();
});

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
  const cards = cardRects();
  morph(dash, renderApp({ ...view, now: now(), phaseMs: performance.now() }));
  lastWidth = width;
  afterRender();
  if (focused && !dash.contains(document.activeElement)) dash.querySelector(focused)?.focus({ preventScroll: true });
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
  glide(cards);
  scheduleCardChange();
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

const gridCards = () => dash.querySelectorAll('.b-grid > .b-card[data-open]');

/** Where each card in the grid is before a render, by its data-open key; empty when nothing will glide. */
function cardRects() {
  const rects = new Map();
  if (view.page !== 'live' || matchMedia('(prefers-reduced-motion: reduce)').matches) return rects;
  for (const el of gridCards()) rects.set(el.dataset.open, el.getBoundingClientRect());
  return rects;
}

/**
 * When a render removed cards from the grid, the cards that stay glide from their old places to their new ones. The Web
 * Animations API sets no inline style, so morph() and later renders leave the glide alone. Both rects include a glide
 * that still runs, so dx and dy hold only the layout change; composite 'add' adds the new glide to the running one
 * instead of replacing it, so the card keeps moving smoothly.
 */
function glide(before) {
  if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const after = new Map([...gridCards()].map(el => [el.dataset.open, el]));
  // Only measure again when a card has gone, so a normal update stays cheap.
  if ([...before.keys()].every(key => after.has(key))) return;
  for (const [key, el] of after) {
    const was = before.get(key);
    if (!was) continue;
    const rect = el.getBoundingClientRect();
    const dx = was.left - rect.left;
    const dy = was.top - rect.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'ease-out', composite: 'add' });
  }
}

/** Render again when a finished sub-agent's card starts to fade or leaves, since no snapshot may arrive then. */
function scheduleCardChange() {
  clearTimeout(cardTimer);
  cardTimer = null;
  if (view.page !== 'live' || !view.snapshot) return;
  const wait = nextCardChange(view.snapshot, now());
  if (wait !== null) cardTimer = setTimeout(scheduleRender, wait + 50);
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
  shownSwarm = null;
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
  clearTimeout(cardTimer);
  source?.close();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) connect();
});

if (view.page === 'history') reloadHistory();
if (view.page === 'run') loadRun(view.runId);
connect();
render();
