import { ago, costHtml, costText, dur, elapsed, esc, liveTime } from './format.mjs';
import {
  COUNT_TILES, NEED_CLASS, NEED_LABELS, STAGE_NAMES, archivedUnits, cardUnits, closedNotMerged, needItems, progressPercent, sharePercent, unitEnd,
} from './model.mjs';
import { badge, bar, chipsHtml, closedBadge, feedList, meter, monitorHtml, reportClass, ring, stageTrack, stateLineHtml } from './parts.mjs';

/**
 * @typedef {{ snapshot: object, now: number, phaseMs: number, detail: string|null,
 *   fresh: { feed: Set<string>, reports: Set<string>, chips: Set<string> } }} RenderContext
 *   fresh holds ids that changed since the previous snapshot: feed item ids, unit ids with a new report, sub-agent ids.
 */

export function headerHtml({ snapshot, now, phaseMs }) {
  const { run, orchestrator, counts, cost } = snapshot;
  const ended = run.lifecycle === 'finished' ? run.finishedAt ?? run.lastActivityAt : null;
  const tiles = COUNT_TILES.map(([bucket, state]) => `<div class="tile st-${state}"><span class="v">${counts[bucket]}</span><span class="k"><span class="dot"></span>${bucket}</span></div>`).join('');
  return `<div class="d-head">`
    + `<div class="d-id">${ring(orchestrator.status, orchestrator.label, phaseMs)}<div class="b-who"><div class="d-name">${esc(run.name)}</div><div class="small muted">Orchestrator${run.project ? ` · ${esc(run.project.name)}` : ''}</div></div></div>`
    + `<div class="d-facts"><div class="kv"><span class="k">${ended ? 'Ran' : 'Running'}</span><span class="v l">${ended ? dur(ended - run.startedAt, 'clock') : liveTime(run.startedAt, now, 'clock')}</span></div>`
    + `<div class="kv"><span class="k">Swarm cost</span><span class="v l">${costHtml(cost.credits, true)}</span></div></div>`
    + `<div class="d-counts" aria-label="Child sessions by state">${tiles}</div></div>`;
}

export function needsHtml({ snapshot, now }) {
  const items = needItems(snapshot);
  const head = `<div class="sec-h"><h3>Needs you</h3><span class="small muted">${items.length ? `${items.length} waiting, longest first` : 'Nothing waiting'}</span></div>`;
  if (!items.length) return `<section class="needs" aria-label="Needs you">${head}</section>`;
  const list = items.map(item => `<div class="need st-${NEED_CLASS[item.kind]}" data-key="${esc(item.id)}"><span class="small need-k"><span class="dot"></span>${NEED_LABELS[item.kind]}</span>`
    + `<span class="need-t" title="${esc(item.text)}">${esc(item.text)}</span>`
    + `<span class="small muted">${esc(item.from)} · ${item.verb} ${elapsed(item.since, now)}</span></div>`).join('');
  return `<section class="needs" aria-label="Needs you">${head}<div class="needs-list">${list}</div></section>`;
}

function reportRow(unit, now, fresh) {
  const report = unit.report;
  if (!report) return '<div class="b-rep"><span class="b-rep-t muted">No report yet</span></div>';
  return `<div class="b-rep ${reportClass(report.status)}${fresh.reports.has(unit.id) ? ' is-new' : ''}">${badge(report.status)}`
    + `<span class="b-rep-t" title="${esc(report.title)}">${esc(report.title)}</span><span class="b-age">${ago(report.at, now)}</span></div>`;
}

export function cardHtml(unit, ctx) {
  const { snapshot, now, phaseMs, detail, fresh } = ctx;
  const end = unitEnd(unit);
  const progress = progressPercent(unit);
  const progressRow = progress === null
    ? '<span class="k">Progress</span><span class="none-r">No task list</span>'
    : `<span class="k">Progress</span>${bar(progress)}<span class="r">${progress}%</span>`;
  return `<article class="b-card st-${unit.status}${detail === unit.id ? ' is-sel' : ''}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(unit.label)} ${esc(unit.name)}">`
    + `<div class="b-head">${ring(unit.status, unit.label, phaseMs)}<div class="b-who st-${unit.status}"><div class="b-name">${esc(unit.name)}</div><div class="b-state">${stateLineHtml(unit, now)}</div></div>${unit.pr ? `<span class="b-pr">PR #${unit.pr.id}</span>` : ''}</div>`
    + `<div class="b-metrics"><span class="k">${end ? 'Ran' : 'Running'}</span><span class="v">${end ? dur(end - unit.startedAt, 'clock') : liveTime(unit.startedAt, now, 'clock')}</span>`
    + `<span class="k">Cost</span><span class="v">${costHtml(unit.cost.credits)}</span><span></span>${meter(sharePercent(unit.cost.credits, snapshot.cost.maxUnitCredits))}</div>`
    + reportRow(unit, now, fresh)
    + `<div class="b-rows st-${unit.status}">${progressRow}<span class="k">Stage</span>${stageTrack(unit.stage)}<span class="r">${STAGE_NAMES[unit.stage]}</span>`
    + `<span class="k">Monitor</span><span class="mon mon-${unit.monitor.state}">${monitorHtml(unit, now)}${closedNotMerged(unit) ? closedBadge : ''}</span></div>`
    + `<div class="chips">${chipsHtml(unit, now, fresh.chips)}</div></article>`;
}

export function cardsHtml(ctx) {
  const units = cardUnits(ctx.snapshot);
  const archived = archivedUnits(ctx.snapshot);
  const grid = units.length ? `<div class="b-grid">${units.map(unit => cardHtml(unit, ctx)).join('')}</div>` : '<p class="none">No active child sessions.</p>';
  const note = archived.length ? `<p class="cards-note">Archived and hidden here: ${archived.map(unit => `${esc(unit.label)} ${esc(unit.name)}`).join(', ')}. The Board tab shows them.</p>` : '';
  return grid + note;
}
