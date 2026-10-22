import { cockpitAddressHtml, cockpitControlHtml } from './cockpit-link.mjs';
import { ago, esc } from './format.mjs';
import { historyHtml, runHtml } from './history.mjs';
import { activityHtml, cardsHtml, detailHtml, headerHtml, needsHtml, railHtml } from './live.mjs';
import { boardHtml } from './plan.mjs';
import { themeControlHtml } from './theme.mjs';
import { timelineHtml } from './timeline.mjs';

export const TABS = Object.freeze({ cards: 'Cards', activity: 'Activity', timeline: 'Timeline', plan: 'Plan', board: 'Board' });
export const NARROW_BELOW = 900;
/** Narrow (side-panel) mode: the dashboard's inner width, its clientWidth minus 2 × 16 px padding, is under 900 px. */
export const isNarrow = dashWidth => dashWidth - 32 < NARROW_BELOW;
/** A swarm picked in the picker or remembered from an earlier visit applies only while it is live; one named in the address always applies. */
export const staleChoice = (swarm, fromUrl, swarms) => Boolean(swarm) && !fromUrl && !swarms.some(item => item.id === swarm && item.lifecycle === 'live');

/** A key that changes when a swarm starts, finishes or goes away; History lists finished runs, so it may then be stale. */
export const lifecycleKey = swarms => swarms.map(swarm => `${swarm.id}:${swarm.lifecycle}`).sort().join('|');

/** Whether a swarms event should reload History: once it has been asked for, on the first event after load (it may have answered before this state) and whenever a lifecycle changes. */
export const historyReloadWanted = ({ asked, previousKey, key }) => asked && (previousKey === null || key !== previousKey);

/** sessionStorage key: the server UI fingerprint this tab last reloaded for. */
export const RELOAD_KEY = 'swarm-dashboard:reloaded-for';
/** sessionStorage key: a swarm picked in the picker, carried through a self-reload in this tab only. */
export const PICK_KEY = 'swarm-dashboard:picked-swarm';
/** sessionStorage key: set just before a self-reload, so the reloaded page cleans its address. */
export const RESTORED_KEY = 'swarm-dashboard:restored';
/** sessionStorage key: a swarm the page showed by default, carried through a self-reload in this tab only. */
export const SHOWN_KEY = 'swarm-dashboard:shown-swarm';

/**
 * A swarm the page showed by default gives way as a default page does on the server: once it is no longer live while
 * another swarm is. Picked, remembered and addressed swarms keep their own rules (see staleChoice).
 */
export const staleShown = (swarm, swarms) => Boolean(swarm)
  && !swarms.some(item => item.id === swarm && item.lifecycle === 'live')
  && swarms.some(item => item.lifecycle === 'live');

/**
 * The swarm a page that shows the server's default (no swarm asked for, not opened for a session) keeps as shown when it
 * reconnects or reloads: the one on screen, unless it would give way anyway (staleShown).
 */
export function keptDefault({ swarm, session, onScreen, swarms }) {
  if (swarm || session || !onScreen) return null;
  return staleShown(onScreen, swarms) ? null : onScreen;
}

/**
 * What a self-reload carries in this tab's storage. An addressed swarm travels in the address. The page's own swarm,
 * picked or remembered, travels as a pick. Otherwise, on a page not opened for a session, the swarm on screen travels as
 * shown, or the transport swarm the page asks for when nothing is on screen yet, unless it would give way anyway, so the
 * reloaded page asks for it even when the server's default has moved to another swarm. Shown is only ever a transport
 * swarm: the reloaded page stays a default page.
 */
export function reloadCarry({ swarm, fromUrl, session, onScreen, transport, swarms }) {
  if (swarm && fromUrl) return { pick: null, shown: null };
  if (swarm) return { pick: swarm, shown: null };
  return { pick: null, shown: keptDefault({ swarm: null, session, onScreen: onScreen ?? transport, swarms }) };
}
const SEMVER = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/;

function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(SEMVER);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 0 && minor === 0 && patch === 0 && !match[4]) return null;
  return {
    version: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}`,
    nums: [major, minor, patch],
    pre: match[4] ? match[4].split('.') : null,
  };
}

/** Compare two semver strings: -1 when a < b, 0 when equal, 1 when a > b, or null when either is not a comparable version. */
export function compareVersions(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i += 1) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) return ln < rn ? -1 : 1;
    if (ln !== null) return -1;
    if (rn !== null) return 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** Notice shown when a running server is older than the installed plugin that opened the canvas. */
export function versionNotice({ serverVersion, installedVersion } = {}) {
  if (compareVersions(serverVersion, installedVersion) !== -1) return null;
  const running = parseSemver(serverVersion).version;
  const installed = parseSemver(installedVersion).version;
  return {
    running,
    installed,
    text: `Dashboard server v${running} is older than installed plugin v${installed}: to update the dashboard, reload extensions in every session or restart the app; a dashboard started separately in a browser has to be restarted by whoever started it.`,
  };
}

/**
 * What to do once the server's UI fingerprint is known: 'stay', 'wait' (hidden: decide again when visible) or 'reload'.
 * A tab reloads at most once for each new fingerprint, so files that still do not match after a reload cause no loop.
 */
export function reloadDecision({ own, served, attempted, hidden }) {
  if (!own || !served || own === served || attempted === served) return 'stay';
  return hidden ? 'wait' : 'reload';
}
/** The address to reload at: it keeps the host, the session, the plugin version, an addressed swarm, the page, the run, the tab, the time window and the open detail. */
export function reloadSearch(view, params, swarmFromUrl) {
  const next = new URLSearchParams();
  for (const name of ['host', 'session', 'plugin']) if (params.get(name)) next.set(name, params.get(name));
  if (swarmFromUrl && view.swarm) next.set('swarm', view.swarm);
  if (view.page !== 'live') next.set('page', view.page);
  if (view.page === 'run' && view.runId) next.set('run', view.runId);
  next.set('tab', view.tab);
  next.set('span', view.span);
  if (view.detail) next.set('detail', view.detail);
  return next.toString();
}

/** The address after a self-reload: only the host, the session, an addressed swarm and the plugin version, so a later manual reload shows the saved state. */
export function baseSearch(params) {
  const next = new URLSearchParams();
  for (const name of ['host', 'session', 'swarm', 'plugin']) if (params.get(name)) next.set(name, params.get(name));
  return next.toString();
}
/**
 * The page's own swarm at start: one named in the address, else one picked before a self-reload, else none for a page
 * opened for a session (the server picks that session's swarm) or for a page that showed the default before a
 * self-reload (it stays a default page, see startShown), else the one remembered from an earlier visit.
 * Only the first counts as addressed; the others keep the picker's "only while live" rule (see staleChoice). An empty
 * value counts as none, as on the server.
 */
export function startSwarm({ urlSwarm, restoredPick, restoredShown = null, session, savedSwarm }) {
  return urlSwarm || restoredPick || (session || restoredShown ? null : savedSwarm || null);
}
/**
 * The transport swarm a page starts with: the swarm it showed by default before a self-reload, when no address, pick or
 * session decides. The page asks for it on the wire only; it is never the page's own choice, and it gives way as a
 * default page does on the server (see staleShown). An empty value counts as none.
 */
export const startShown = ({ urlSwarm, restoredPick, restoredShown, session }) => (!urlSwarm && !restoredPick && !session ? restoredShown || null : null);

/** Wrap load so that calls never overlap: a call made while one runs makes it run once more afterwards, even if that run failed. */
export function coalesced(load) {
  let running = null;
  let again = false;
  return function run() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await load();
          } catch (error) {
            // A call queued meanwhile still runs; only a failure with nothing queued ends the loop.
            if (!again) throw error;
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/**
 * Bounded retries for a load that can fail. attempt() runs at the start of every load and cancels a pending retry, so a
 * retry never overlaps or follows another attempt; failed() schedules one retry while fewer than `limit` have run since
 * the last success or reset(); succeeded() and reset() restart the budget; stop() cancels. A retry counts when it runs,
 * so a retry cancelled by another attempt does not use up the budget.
 */
export function retryBudget({ limit, delayMs, retry, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let used = 0;
  let timer = null;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const restart = () => {
    cancel();
    used = 0;
  };
  return {
    attempt: cancel,
    failed() {
      cancel();
      if (used >= limit) return;
      timer = setTimer(() => {
        timer = null;
        used += 1;
        retry();
      }, delayMs);
    },
    succeeded: restart,
    reset: restart,
    stop: cancel,
  };
}

/** The whole dashboard for one PageView (see the Task 7 interface). */
export function renderApp(view) {
  const top = topHtml(view);
  if (view.page === 'history') return top + historyHtml(view.runs, view.historyError);
  if (view.page === 'run') return top + runHtml(view.run);
  return top + liveHtml(view);
}

function versionNoticeHtml(view) {
  const notice = versionNotice(view);
  if (!notice) return '';
  return `<div class="v-out" role="status" data-version-notice>${esc(notice.text)}</div>`;
}

function topHtml(view) {
  const current = view.page === 'run' ? 'history' : view.page;
  const pages = ['live', 'history'].map(page => `<button type="button" data-page="${page}" aria-pressed="${current === page}">${page === 'live' ? 'Live' : 'History'}</button>`).join('');
  return `<div class="d-top"><div class="seg" role="group" aria-label="Dashboard">${pages}</div><div class="d-top-r">${pickerHtml(view)}${statusHtml(view)}<div class="d-tools">${cockpitControlHtml(view)}${themeControlHtml(view.theme)}</div></div></div>`
    + versionNoticeHtml(view)
    + (view.page === 'live' ? cockpitAddressHtml(view.cockpitNote ?? null) : '');
}

function pickerHtml(view) {
  if (view.page !== 'live') return '';
  const live = view.swarms.filter(swarm => swarm.lifecycle === 'live');
  const shown = view.snapshot?.run ?? null;
  const shownLive = shown !== null && live.some(swarm => swarm.id === shown.id);
  // There is a choice when two swarms are live, when the page shows a swarm that has ended while another is live, or when
  // it has loaded and shows no swarm while one is live.
  if (live.length < 2 && !(live.length && ((shown && !shownLive) || (view.loaded && !shown)))) return '';
  const current = shown?.id ?? view.swarm;
  const choices = shown && !shownLive ? [shown, ...live] : live;
  // A loaded page that shows none of the choices selects none of them, so the picker never names a swarm that is not shown.
  const none = view.loaded && !choices.some(swarm => swarm.id === current) ? '<option value="" selected disabled>Choose a swarm</option>' : '';
  const options = none + choices.map(swarm => `<option value="${esc(swarm.id)}"${swarm.id === current ? ' selected' : ''}>${esc(swarm.name)}</option>`).join('');
  return `<label class="pick"><span class="small muted">Swarm</span><select data-swarm aria-label="Swarm">${options}</select></label>`;
}

function statusHtml(view) {
  if (view.connection === 'retrying') return '<span class="small warn">Disconnected · retrying</span>';
  const warnings = (view.snapshot?.diagnostics ?? []).filter(entry => entry.level === 'warn');
  const note = warnings.length
    ? `<span class="small muted" title="${esc(warnings.map(entry => `${entry.source}: ${entry.message}`).join('\n'))}">${warnings.length} data warning${warnings.length === 1 ? '' : 's'}</span>`
    : '';
  // Sample data must never pass for real data, so demo mode says so; the dashboard is otherwise unlabelled.
  return `${note}${view.demo ? '<span class="small muted">Sample data</span>' : ''}`;
}

function liveHtml(view) {
  const { snapshot } = view;
  if (!view.loaded) return '<p class="none">Reading Copilot data…</p>';
  if (!snapshot) {
    // A page opened for a session gets no snapshot while that session is in no swarm; a page with a swarm of its own gets
    // none once that swarm has gone.
    if (view.session && !view.swarm) return '<div class="empty"><h3>Not part of a swarm</h3><p class="small muted">This session isn\'t part of a swarm. The page shows its swarm as soon as it joins one.</p></div>';
    return '<div class="empty"><h3>No swarm yet</h3><p class="small muted">A session that starts child sessions shows up here as a swarm.</p></div>';
  }
  if (snapshot.run.lifecycle === 'finished' && !view.swarm) {
    const at = snapshot.run.finishedAt ?? snapshot.run.lastActivityAt;
    const heading = view.swarms.some(swarm => swarm.lifecycle === 'live') ? 'Swarm finished' : 'No live swarm';
    return `<div class="empty"><h3>${heading}</h3><p class="small muted">${esc(snapshot.run.name)} finished ${ago(at, view.now)}. Finished runs are in History.</p>`
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
