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

export const railHtml = ctx => `<section class="rail" aria-label="Activity"><div class="sec-h"><h3>Activity</h3><span class="small muted">all units, latest first</span></div>${feedList(ctx.snapshot.feed, 16, ctx.now, ctx.fresh.feed)}</section>`;
export const activityHtml = ctx => `<section class="rail" aria-label="Activity">${feedList(ctx.snapshot.feed, 24, ctx.now, ctx.fresh.feed)}</section>`;

const SUBAGENT_PILLS = { running: ['busy', 'running'], completed: ['merged', 'finished'], failed: ['blocked', 'failed'], stuck: ['stuck', 'stuck'] };
const SUBAGENT_LIMIT = 12;

/** The engine also gives reasons to units that are fine (a slow model call, a normal stop); only these get the alarm box. */
const WHY_STATUSES = new Set(['stuck', 'blocked']);

function whyHtml(unit) {
  if (!unit.reason || !WHY_STATUSES.has(unit.status)) return '';
  const word = unit.status === 'stuck' ? 'stuck' : unit.statusDetail === 'crashed' ? 'crashed' : unit.statusDetail === 'failed' ? 'failed' : 'blocked';
  return `<div class="dt-why st-${unit.status === 'stuck' ? 'stuck' : 'blocked'}"><h4>Why this counts as ${word}</h4><p>${esc(unit.reason)}</p></div>`;
}

function reportHtml(report, now) {
  if (!report) return '<p class="small muted">No report yet.</p>';
  const list = entries => `<ul class="dt-list">${entries.map(entry => `<li>${esc(entry)}</li>`).join('')}</ul>`;
  const lead = report.summary ?? (report.body ? null : report.title);
  return `<div class="dt-rep-h ${reportClass(report.status)}">${badge(report.status)}<span class="small muted">${ago(report.at, now)}</span></div>`
    + (lead ? `<p class="dt-p">${esc(lead)}</p>` : '')
    + (report.body ? `<p class="dt-p dt-body">${esc(report.body)}</p>` : '')
    + (report.evidence.length ? `<span class="small muted">Evidence</span>${list(report.evidence)}` : '')
    + (report.blockers === null ? '' : `<span class="small muted">Blockers</span>${report.blockers.length ? list(report.blockers) : '<p class="small">None reported</p>'}`);
}

function subagentsHtml(subagents, now) {
  if (!subagents.length) return '<p class="small muted">None in this session</p>';
  const rows = subagents.slice(0, SUBAGENT_LIMIT).map(sub => {
    const [state, word] = SUBAGENT_PILLS[sub.status] ?? ['idle', sub.status];
    const runtime = sub.endedAt ? dur(sub.durationMs ?? sub.endedAt - sub.startedAt) : elapsed(sub.startedAt, now);
    return `<li class="sa" title="${esc(sub.task ?? sub.name)}"><div class="sa-1"><span>${esc(sub.type)}${sub.mode === 'sync' ? ' (sync)' : ''}</span><span class="pill st-${state}">${word}</span></div>`
      + `<div class="sa-2">${esc(sub.model ?? 'model unknown')} · ${runtime} · ${costText(sub.credits)}</div></li>`;
  }).join('');
  const more = subagents.length > SUBAGENT_LIMIT ? `<p class="small muted">${subagents.length - SUBAGENT_LIMIT} earlier sub-agents not shown</p>` : '';
  return `<ul class="sa-list">${rows}</ul>${more}`;
}

function prState(pr, now) {
  if (pr.state === 'merged') return pr.mergedAt ? `Merged ${ago(pr.mergedAt, now)}` : 'Merged';
  if (pr.state === 'closed') return pr.closedAt ? `Closed ${ago(pr.closedAt, now)}` : 'Closed';
  if (pr.state === 'unknown') return 'Not known yet';
  const word = pr.state === 'draft' ? 'Draft' : 'Open';
  return pr.openedAt ? `${word} since ${ago(pr.openedAt, now)}` : word;
}

function prHtml(unit, now) {
  const { pr, monitor } = unit;
  if (!pr) return '<p class="small muted">No PR yet. A PR monitor starts when the PR opens.</p>';
  const state = closedNotMerged(unit)
    ? `<span class="pr-state">${closedBadge}${pr.closedAt ? `<span>${ago(pr.closedAt, now)}</span>` : ''}</span>`
    : `<span>${prState(pr, now)}</span>`;
  return `<div class="dt-kv"><span class="k">PR</span><span>#${pr.id}${pr.title ? ` ${esc(pr.title)}` : ''}</span><span class="k">State</span>${state}`
    + (pr.reviewNote ? `<span class="k">Reviews</span><span>${esc(pr.reviewNote)}</span>` : '')
    + `<span class="k">Monitor</span><span class="mon mon-${monitor.state}">${monitorHtml(unit, now, true)}</span>`
    + (monitor.everyMinutes && monitor.state === 'alive' ? `<span class="k">Schedule</span><span>every ${monitor.everyMinutes} min</span>` : '')
    + (monitor.everyMinutes && monitor.state === 'missing' ? `<span class="k">Expected</span><span>a check every ${monitor.everyMinutes} min</span>` : '')
    + '</div>';
}

/** Details for one unit. In narrow mode (inMain) it replaces the card list and offers a way back. */
export function detailHtml(unitId, inMain, ctx) {
  const { snapshot, now, phaseMs, fresh } = ctx;
  const unit = snapshot.units.find(item => item.id === unitId);
  if (!unit) return '';
  const end = unitEnd(unit);
  const activity = unit.activity;
  const progress = progressPercent(unit);
  const top = `<div class="dt-top">${inMain ? '<button type="button" class="link" data-close>← Back to cards</button>' : ''}`
    + `<div class="b-head">${ring(unit.status, unit.label, phaseMs)}<div class="b-who st-${unit.status}"><div class="b-name">${esc(unit.label)} ${esc(unit.name)}</div><div class="b-state">${stateLineHtml(unit, now)}</div></div>`
    + `${inMain ? '' : '<button type="button" class="x" data-close aria-label="Close details">×</button>'}</div></div>`;
  const facts = `<div class="dt-facts"><div class="kv"><span class="k">${end ? 'Ran' : 'Running'}</span><span class="v">${end ? dur(end - unit.startedAt) : elapsed(unit.startedAt, now)}</span></div>`
    + `<div class="kv"><span class="k">Cost</span><span class="v">${costHtml(unit.cost.credits)}</span></div>`
    + `<div class="kv"><span class="k">Progress</span><span class="v">${progress === null ? 'No task list' : `${progress}%`}</span></div>`
    + `<div class="kv"><span class="k">Stage</span><span class="v">${STAGE_NAMES[unit.stage]}</span></div>`
    + `<div class="kv"><span class="k">Model</span><span class="v">${esc(unit.model ?? 'unknown')}</span></div></div>`;
  const current = `<div class="dt-sec"><h4>Current activity</h4><div class="dt-kv"><span class="k">Doing</span><span>${esc(activity.label)}</span>`
    + (unit.reason && !WHY_STATUSES.has(unit.status) ? `<span class="k">Note</span><span>${esc(unit.reason)}</span>` : '')
    + (activity.tool ? `<span class="k">Tool call</span><span><span class="code">${esc(activity.tool.summary)}</span> · ${elapsed(activity.tool.startedAt, now)}</span>` : '')
    + `<span class="k">Last event</span><span>${activity.lastEventAt ? ago(activity.lastEventAt, now) : 'none yet'}</span></div></div>`;
  return `<section class="detail" aria-label="Details for ${esc(unit.label)}">${top}${facts}${whyHtml(unit)}${current}`
    + `<div class="dt-sec"><h4>Latest report</h4>${reportHtml(unit.report, now)}</div>`
    + `<div class="dt-sec"><h4>Sub-agents</h4>${subagentsHtml(unit.subagents, now)}</div>`
    + `<div class="dt-sec"><h4>PR and monitor</h4>${prHtml(unit, now)}</div>`
    + `<div class="dt-sec"><h4>Recent activity</h4>${feedList(unit.recent, 6, now, fresh.feed, 'No recent activity')}</div></section>`;
}
