import { ago, esc } from './format.mjs';
import { historyHtml, runHtml } from './history.mjs';
import { activityHtml, cardsHtml, detailHtml, headerHtml, needsHtml, railHtml } from './live.mjs';
import { boardHtml } from './plan.mjs';
import { timelineHtml } from './timeline.mjs';

export const TABS = Object.freeze({ cards: 'Cards', activity: 'Activity', timeline: 'Timeline', plan: 'Plan', board: 'Board' });
export const NARROW_BELOW = 900;
/** Narrow (side-panel) mode: the dashboard's inner width, its clientWidth minus 2 × 16 px padding, is under 900 px. */
export const isNarrow = dashWidth => dashWidth - 32 < NARROW_BELOW;
/** A swarm picked in the picker or remembered from an earlier visit applies only while it is live; one named in the address always applies. */
export const staleChoice = (swarm, fromUrl, swarms) => Boolean(swarm) && !fromUrl && !swarms.some(item => item.id === swarm && item.lifecycle === 'live');

/** A key that changes when a swarm starts, finishes or goes away; History lists finished runs, so it may then be stale. */
export const lifecycleKey = swarms => swarms.map(swarm => `${swarm.id}:${swarm.lifecycle}`).sort().join('|');

/** sessionStorage key: the server UI fingerprint this tab last reloaded for. */
export const RELOAD_KEY = 'swarm-dashboard:reloaded-for';
/**
 * What to do once the server's UI fingerprint is known: 'stay', 'wait' (hidden: decide again when visible) or 'reload'.
 * A tab reloads at most once for each new fingerprint, so files that still do not match after a reload cause no loop.
 */
export function reloadDecision({ own, served, attempted, hidden }) {
  if (!own || !served || own === served || attempted === served) return 'stay';
  return hidden ? 'wait' : 'reload';
}
/** The address to reload at: it keeps the host, the session, an addressed swarm, the page, the run, the tab, the time window and the open detail. */
export function reloadSearch(view, params, swarmFromUrl) {
  const next = new URLSearchParams();
  for (const name of ['host', 'session']) if (params.get(name)) next.set(name, params.get(name));
  if (swarmFromUrl && view.swarm) next.set('swarm', view.swarm);
  if (view.page !== 'live') next.set('page', view.page);
  if (view.page === 'run' && view.runId) next.set('run', view.runId);
  next.set('tab', view.tab);
  next.set('span', view.span);
  if (view.detail) next.set('detail', view.detail);
  return next.toString();
}

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
  if (view.page !== 'live') return '';
  const live = view.swarms.filter(swarm => swarm.lifecycle === 'live');
  const shown = view.snapshot?.run ?? null;
  const shownLive = shown !== null && live.some(swarm => swarm.id === shown.id);
  // There is a choice when two swarms are live, or when the page shows a swarm that has ended while another is live.
  if (live.length < 2 && !(live.length && shown && !shownLive)) return '';
  const current = shown?.id ?? view.swarm;
  const choices = shown && !shownLive ? [shown, ...live] : live;
  const options = choices.map(swarm => `<option value="${esc(swarm.id)}"${swarm.id === current ? ' selected' : ''}>${esc(swarm.name)}</option>`).join('');
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
