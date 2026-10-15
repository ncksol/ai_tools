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
