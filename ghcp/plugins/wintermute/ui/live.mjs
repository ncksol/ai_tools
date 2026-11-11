import { ago, costHtml, costText, dollars, dur, esc, liveTime, plainText, runningFor, timeOfDay } from './format.mjs';
import {
  MODE_WORDS, STAGE_NAMES, activeSubagents, cardZones, closedNotMerged, countTiles, effortOf, finishedOutcome, isSubagent, needMark, nowLine,
  omittedSubagents, orchestratorView, prWords, progressPercent, reportKind, reportTitle, reviewsWords, runClockEnd, runEnd, shortModel, stateWords, unitClockEnd, unitEnd,
} from './model.mjs';
import { CARET, badge, bar, closedBadge, feedList, fill, monitorHtml, outcomeCard, reportClass, ring, stateLineHtml, statusMark, warnMark } from './parts.mjs';

/**
 * @typedef {{ snapshot: object, now: number, phaseMs: number, detail: string|null,
 *   fresh: { feed: Set<string>, reports: Set<string>, chips: Set<string> }, finishedOpen?: boolean, stale?: boolean }} RenderContext
 *   fresh holds ids that changed since the previous snapshot: feed item ids, unit ids with a new report, sub-agent ids.
 *   finishedOpen: the Finished section is open. stale: the page is disconnected, so the data may be out of date.
 */

export function headerHtml({ snapshot, now, phaseMs, stale = false }) {
  const { run, cost } = snapshot;
  const ended = runEnd(snapshot);
  // A live run with nothing active stops its clock at its last activity and says so; it ticks again once work resumes.
  const stopped = runClockEnd(snapshot);
  const clock = stopped === null ? liveTime(run.startedAt, now, 'clock') : dur(stopped - run.startedAt, 'clock');
  const quiet = ended === null && stopped !== null ? `<span class="v-note"> · quiet since ${timeOfDay(stopped)}</span>` : '';
  const view = orchestratorView(snapshot);
  const tiles = countTiles(snapshot).map(({ key, state, count }) => `<div class="tile st-${state}"><span class="v">${count}</span><span class="k"><span class="dot"></span>${key}</span></div>`).join('');
  return `<div class="d-head${stale ? ' is-stale' : ''}">`
    + `<div class="d-id">${statusMark(view.status, view.detail, phaseMs, 44)}<div class="o-who st-${view.status}">`
    + `<div class="o-l1"><span class="d-name" title="${esc(run.name)}">${esc(run.name)}</span><span class="o-role">Orchestrator${run.project ? ` · ${esc(run.project.name)}` : ''}</span></div>`
    + `<div class="o-state">${fill(view.words, view.at, now)}</div>`
    + `<div class="o-now${view.muted ? ' is-muted' : ''}" title="${esc(view.text)}">${esc(view.text)}</div></div></div>`
    + `<div class="d-facts"><div class="kv"><span class="k">${ended ? 'Ran' : 'Running'}</span><span class="v l">${clock}${quiet}</span></div>`
    + `<div class="kv"><span class="k">Swarm cost</span><span class="v l" title="${esc(costText(cost.credits))}">${dollars(cost.credits)}</span></div></div>`
    + `<div class="d-counts" role="group" aria-label="Units by state">${tiles}</div></div>`;
}

/** Line 2's right side: the PR and its state, the PR it reviews, or an orchestrator sub-agent's type. */
function sideHtml(unit) {
  if (isSubagent(unit)) {
    const type = unit.agent?.type ?? 'sub-agent';
    return `<span class="b-tag" title="Orchestrator sub-agent · ${esc(type)} · ${esc(MODE_WORDS[unit.agent?.mode]?.toLowerCase() ?? 'mode unknown')}">${esc(type)}</span>`;
  }
  if (unit.pr) return `<span class="b-pr">${esc(prWords(unit.pr))}</span>`;
  return unit.reviewedPr ? `<span class="b-pr">${esc(reviewsWords(unit.reviewedPr))}</span>` : '';
}

/** The footer: Needs you marker, sub-agent chips and todos on the left; model, effort and cost on the right. */
function footHtml(unit, ctx, end) {
  const { snapshot, now, fresh } = ctx;
  const mark = needMark(unit, snapshot);
  const need = mark
    ? `<span class="b-need" title="${esc(plainText(mark.need.text))}"><span class="b-need-l">${esc(mark.label)}</span><span class="b-need-s" hidden>${esc(mark.short)}</span></span>`
    : '';
  const subs = activeSubagents(unit);
  const chips = subs.map(sub => `<span class="chip st-${sub.status === 'stuck' ? 'stuck' : 'busy'}${fresh.chips.has(sub.id) ? ' is-new' : ''}" data-key="${esc(sub.id)}" title="${esc(sub.task ?? sub.name)}"><span class="dot"></span><span class="chip-t">${esc(sub.type)} ${runningFor(sub.startedAt, end, now)}</span></span>`).join('');
  // The fold (main.mjs) shows "+N" for chips it hides, or this one count chip in place of them all.
  const folds = subs.length
    ? `<span class="b-more" hidden></span><span class="chip b-count st-${subs.some(sub => sub.status === 'stuck') ? 'stuck' : 'busy'}" hidden title="${esc(subs.map(sub => `${sub.type}: ${sub.task ?? sub.name}`).join('\n'))}"><span class="dot"></span><span class="chip-t">${subs.length}</span></span>`
    : '';
  const progress = progressPercent(unit);
  const todos = progress === null ? '' : `<span class="b-prog" title="${unit.progress.done} of ${unit.progress.total} todos done">${bar(progress)}${unit.progress.done}/${unit.progress.total}</span>`;
  const name = shortModel(unit.model);
  const effort = effortOf(unit);
  const model = name ? `<span class="b-model" title="${esc(`Model ${unit.model}${effort ? `, reasoning effort ${effort}` : ''}`)}">${esc(name)}${effort ? ` · ${esc(effort)}` : ''}</span>` : '';
  return `<div class="b-foot">${need}<div class="b-left">${chips}${folds}${todos}</div>`
    + `<div class="b-right">${model}<span class="b-cost" title="${esc(costText(unit.cost.credits))}">${dollars(unit.cost.credits)}</span></div></div>`;
}

/** An active unit's card: head (status mark, label and name, state and PR), the now line and the footer, 162 px high. */
export function cardHtml(unit, ctx) {
  const { snapshot, now, phaseMs, detail, fresh } = ctx;
  // While the run is quiet, or once the unit or the run has ended, its sub-agent clocks stop there.
  const end = unitClockEnd(unit, snapshot);
  const line = nowLine(unit, snapshot);
  const title = `${unit.label} ${unit.name}`;
  return `<article class="b-card st-${unit.status}${detail === unit.id ? ' is-sel' : ''}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(title)}" data-kind="${esc(unit.kind)}">`
    + `<div class="b-head">${statusMark(unit.status, unit.statusDetail, phaseMs)}<div class="b-who st-${unit.status}">`
    + `<div class="b-l1"><span class="b-lab" title="${esc(title)}">${esc(unit.label)}</span><span class="b-name" title="${esc(title)}">${esc(unit.name)}</span>${unit.dataWarning ? warnMark(unit.dataWarning) : ''}</div>`
    + `<div class="b-l2"><span class="b-st">${fill(stateWords(unit), unit.since, now)}</span>${sideHtml(unit)}</div></div></div>`
    + `<div class="b-now${line.muted ? ' is-muted' : ''}${line.at !== undefined && fresh.reports.has(unit.id) ? ' is-new' : ''}" title="${esc(line.text)}">${esc(line.text)}${line.at !== undefined ? `<span class="b-ago"> · ${ago(line.at, now)}</span>` : ''}</div>`
    + footHtml(unit, ctx, end)
    + '</article>';
}

/** The Finished section below the active cards, closed by default; the open state is kept across updates (main.mjs). */
function finishedHtml(units, ctx) {
  if (!units.length) return '';
  const open = Boolean(ctx.finishedOpen);
  return `<section class="b-fin" aria-label="Finished">`
    + `<button type="button" class="b-fin-h" data-finished aria-expanded="${open}">${CARET}<span class="b-fin-t">Finished</span><span class="b-fin-n">${units.length}</span><span class="b-fin-s">stopped, merged, done and failed · latest first</span></button>`
    + (open ? `<div class="b-fin-list">${units.map(unit => outcomeCard(unit, finishedOutcome(unit), ctx)).join('')}</div>` : '')
    + '</section>';
}

export function cardsHtml(ctx) {
  const { active, finished } = cardZones(ctx.snapshot);
  // The Cards tab leaves out archived units, and the snapshot itself leaves out older finished sub-agents; the Board
  // shows those units in Archived and counts the sub-agents left out.
  const hidden = ctx.snapshot.units.length > active.length + finished.length || omittedSubagents(ctx.snapshot) > 0;
  const note = hidden ? '<p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board" data-reveal="archived">Board tab</button>.</p>' : '';
  const grid = active.length ? `<div class="b-grid">${active.map(unit => cardHtml(unit, ctx)).join('')}</div>` : '<p class="none">Nothing is running.</p>';
  return `<div class="b-zone${ctx.stale ? ' is-stale' : ''}">${grid}${finishedHtml(finished, ctx)}${note}</div>`;
}

export const railHtml = ctx => `<section class="rail" aria-label="Activity"><div class="sec-h"><h3>Activity</h3><span class="small muted">all units, latest first</span></div>${feedList(ctx.snapshot.feed, 16, ctx.now, ctx.fresh.feed)}</section>`;
export const activityHtml = ctx => `<section class="rail" aria-label="Activity">${feedList(ctx.snapshot.feed, 24, ctx.now, ctx.fresh.feed)}</section>`;

const SUBAGENT_PILLS = { running: ['busy', 'running'], completed: ['merged', 'finished'], failed: ['blocked', 'failed'], cancelled: ['blocked', 'cancelled'], stuck: ['stuck', 'stuck'] };
const SUBAGENT_LIMIT = 12;

/** The engine also gives reasons to units that are fine (a slow model call, a normal stop); only these get the alarm box. */
const WHY_STATUSES = new Set(['stuck', 'blocked']);

function whyHtml(unit) {
  if (!unit.reason || !WHY_STATUSES.has(unit.status)) return '';
  const word = unit.status === 'stuck' ? 'stuck' : ['crashed', 'failed', 'cancelled'].includes(unit.statusDetail) ? unit.statusDetail : 'blocked';
  return `<div class="dt-why st-${unit.status === 'stuck' ? 'stuck' : 'blocked'}"><h4>Why this counts as ${word}</h4><p>${esc(unit.reason)}</p></div>`;
}

function reportHtml(report, now) {
  if (!report) return '<p class="small muted">No report yet.</p>';
  const list = entries => `<ul class="dt-list">${entries.map(entry => `<li>${esc(plainText(entry))}</li>`).join('')}</ul>`;
  const lead = report.summary ? plainText(report.summary) : report.body ? null : reportTitle(report);
  const kind = reportKind(report);
  return `<div class="dt-rep-h ${reportClass(kind)}">${badge(kind)}<span class="small muted">${ago(report.at, now)}</span></div>`
    + (lead ? `<p class="dt-p">${esc(lead)}</p>` : '')
    + (report.body ? `<p class="dt-p dt-body">${esc(plainText(report.body))}</p>` : '')
    + (report.evidence.length ? `<span class="small muted">Evidence</span>${list(report.evidence)}` : '')
    + (report.blockers === null ? '' : `<span class="small muted">Blockers</span>${report.blockers.length ? list(report.blockers) : '<p class="small">None reported</p>'}`);
}

function subagentsHtml(subagents, now, end) {
  if (!subagents.length) return '<p class="small muted">None in this session</p>';
  const rows = subagents.slice(0, SUBAGENT_LIMIT).map(sub => {
    const [state, word] = SUBAGENT_PILLS[sub.status] ?? ['idle', sub.status];
    const runtime = sub.endedAt ? dur(sub.durationMs ?? sub.endedAt - sub.startedAt) : runningFor(sub.startedAt, end, now);
    return `<li class="sa" title="${esc(sub.task ?? sub.name)}"><div class="sa-1"><span>${esc(sub.type)}${sub.mode === 'sync' ? ' (sync)' : ''}</span><span class="pill st-${state}">${esc(word)}</span></div>`
      + `<div class="sa-2">${esc(sub.model ?? 'model unknown')}${sub.effort ? ` · ${esc(sub.effort)}` : ''} · ${runtime} · ${costText(sub.credits)}</div></li>`;
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
  if (!pr) return unit.reviewedPr ? `<p class="small">Reviews PR #${unit.reviewedPr.id}. No PR of its own.</p>` : '<p class="small muted">No PR yet.</p>';
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

function agentHtml(unit) {
  const agent = unit.agent ?? { type: 'unknown', mode: null };
  return `<div class="dt-sec"><h4>Sub-agent</h4><div class="dt-kv"><span class="k">Type</span><span>${esc(agent.type)}</span>`
    + `<span class="k">Mode</span><span>${MODE_WORDS[agent.mode] ?? 'Unknown'}</span></div></div>`;
}

/** Details for one unit. In narrow mode (inMain) it replaces the card list and offers a way back. */
export function detailHtml(unitId, inMain, ctx) {
  const { snapshot, now, phaseMs, fresh } = ctx;
  const unit = snapshot.units.find(item => item.id === unitId);
  if (!unit) return '';
  const end = unitEnd(unit, snapshot);
  const stopped = unitClockEnd(unit, snapshot);
  const activity = unit.activity;
  const progress = progressPercent(unit);
  const top = `<div class="dt-top">${inMain ? '<button type="button" class="link" data-close>← Back to cards</button>' : ''}`
    + `<div class="b-head">${ring(unit.status, unit.label, phaseMs)}<div class="b-who st-${unit.status}"><div class="b-name">${esc(unit.label)} ${esc(unit.name)}</div><div class="b-state">${stateLineHtml(unit, now)}</div></div>`
    + `${inMain ? '' : '<button type="button" class="x" data-close aria-label="Close details">×</button>'}</div></div>`;
  const facts = `<div class="dt-facts"><div class="kv"><span class="k">${end ? 'Ran' : 'Running'}</span><span class="v">${runningFor(unit.startedAt, stopped, now)}</span></div>`
    + `<div class="kv"><span class="k">Cost</span><span class="v">${costHtml(unit.cost.credits)}</span></div>`
    + `<div class="kv"><span class="k">Progress</span><span class="v">${progress === null ? 'No task list' : `${progress}%`}</span></div>`
    + `<div class="kv"><span class="k">Stage</span><span class="v">${STAGE_NAMES[unit.stage]}</span></div>`
    + `<div class="kv"><span class="k">Model</span><span class="v">${esc(unit.model ?? 'unknown')}${unit.effort ? `<span class="v-note"> · ${esc(unit.effort)}</span>` : ''}</span></div></div>`;
  const current = `<div class="dt-sec"><h4>Current activity</h4><div class="dt-kv"><span class="k">Doing</span><span>${esc(activity.label)}</span>`
    + (unit.reason && !WHY_STATUSES.has(unit.status) ? `<span class="k">Note</span><span>${esc(unit.reason)}</span>` : '')
    + (activity.tool ? `<span class="k">Tool call</span><span><span class="code">${esc(activity.tool.summary)}</span> · ${runningFor(activity.tool.startedAt, stopped, now)}</span>` : '')
    + `<span class="k">Last event</span><span>${activity.lastEventAt ? ago(activity.lastEventAt, now) : 'none yet'}</span></div></div>`;
  return `<section class="detail" aria-label="Details for ${esc(unit.label)}">${top}${facts}${whyHtml(unit)}${current}`
    + `<div class="dt-sec"><h4>Latest report</h4>${reportHtml(unit.report, now)}</div>`
    + `<div class="dt-sec"><h4>Sub-agents</h4>${subagentsHtml(unit.subagents, now, stopped)}</div>`
    + (isSubagent(unit) ? agentHtml(unit) : `<div class="dt-sec"><h4>PR and monitor</h4>${prHtml(unit, now)}</div>`)
    + `<div class="dt-sec"><h4>Recent activity</h4>${feedList(unit.recent, 6, now, fresh.feed, 'No recent activity')}</div></section>`;
}
