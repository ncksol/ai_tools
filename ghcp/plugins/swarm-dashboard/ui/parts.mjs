import { ago, countdown, elapsed, esc } from './format.mjs';
import { REPORT_CLASS, REPORT_LABELS, STAGE_NAMES, UNIT_STAGES, stateLine } from './model.mjs';

const RING = 2 * Math.PI * 17;

/**
 * Attributes for an endless animation that stays in phase across renders: a negative delay from performance.now() at
 * render (phaseMs), and data-phase, which tells morph() to keep the delay of an element whose animation already runs.
 */
export const phase = (seconds, phaseMs) => `data-phase style="animation-delay:-${((phaseMs / 1000) % seconds).toFixed(2)}s"`;

/** The first three characters of a label, without a trailing separator. */
export const shortLabel = label => String(label).slice(0, 3).replace(/[._-]+$/, '');

/** Escape a word template and fill {t} (time in state) and {a} (age) with live times. */
export function fill(template, at, now) {
  return esc(template).replace('{t}', elapsed(at, now)).replace('{a}', ago(at, now));
}

/**
 * 40 px status ring around the label; the full label is the tooltip. Labels of up to four characters show whole, and
 * main.mjs cuts a four-character one (data-fit) to shortLabel() when it does not fit inside the ring.
 */
export function ring(status, label, phaseMs = 0) {
  const text = String(label);
  let arc = '';
  if (status === 'busy') arc = `<circle class="arc spin" cx="20" cy="20" r="17" stroke-dasharray="${(RING * 0.28).toFixed(1)} ${RING.toFixed(1)}" ${phase(4, phaseMs)}/>`;
  else if (status === 'stuck') arc = `<circle class="arc stuck" cx="20" cy="20" r="17" ${phase(2.4, phaseMs)}/>`;
  else if (status !== 'archived') arc = '<circle class="arc" cx="20" cy="20" r="17"/>';
  return `<span class="ring st-${status}" title="${esc(text)}"><svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="17"/>${arc}</svg>`
    + `<span class="ring-l"${text.length === 4 ? ' data-fit' : ''}>${esc(text.length <= 4 ? text : shortLabel(text))}</span></span>`;
}

export const stateLineHtml = (session, now) => fill(stateLine(session), session.since, now);

export function stageTrack(stage) {
  const reached = UNIT_STAGES.indexOf(stage);
  return `<span class="stage" role="img" aria-label="Stage: ${esc(STAGE_NAMES[stage] ?? stage)}">${UNIT_STAGES.map((_, index) => `<i${index <= reached ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

export const badge = status => `<span class="badge">${REPORT_LABELS[status]}</span>`;
export const closedBadge = '<span class="badge rp-blocked">closed, not merged</span>';
export const reportClass = status => `rp-${REPORT_CLASS[status]}`;
export const meter = pct => `<span class="meter"><i style="width:${pct}%"></i></span>`;
export const bar = pct => `<span class="bar"><i style="width:${pct}%"></i></span>`;

/** PR monitor state: short on cards, long in the detail panel. */
export function monitorHtml(unit, now, long = false) {
  const monitor = unit.monitor;
  const dot = '<span class="dot"></span>';
  if (monitor.state === 'alive') {
    return `${dot}alive · last ${monitor.lastCheckAt ? ago(monitor.lastCheckAt, now) : 'not yet'}${monitor.nextCheckAt ? ` · next in ${countdown(monitor.nextCheckAt, now)}` : ''}`;
  }
  if (monitor.state === 'missing') {
    const from = monitor.lastCheckAt ?? monitor.since;
    return `${dot}missing · ${from ? `no check for ${elapsed(from, now)}` : 'no check yet'}`;
  }
  if (monitor.state === 'paused') return `${dot}paused${monitor.since ? ` · ${elapsed(monitor.since, now)}` : ''}`;
  if (monitor.state === 'ended') {
    const merged = unit.outcome === 'merged' || unit.pr?.state === 'merged';
    return `${dot}${merged ? (long ? 'ended when the PR merged' : 'ended, PR merged') : 'ended'}`;
  }
  return `${dot}${long ? 'starts when the PR opens' : 'no PR yet'}`;
}

/** Chips for running (or stuck) sub-agents, plus the open tool call of a stuck session. */
export function chipsHtml(session, now, freshChips = new Set()) {
  const chips = session.subagents
    .filter(sub => sub.status === 'running' || sub.status === 'stuck')
    .map(sub => `<span class="chip st-${sub.status === 'stuck' ? 'stuck' : 'busy'}${freshChips.has(sub.id) ? ' is-new' : ''}" data-key="${esc(sub.id)}" title="${esc(sub.task ?? sub.name)}"><span class="dot"></span><span class="chip-t">${esc(sub.type)} ${elapsed(sub.startedAt, now)}</span></span>`);
  const tool = session.activity.tool;
  if (session.status === 'stuck' && tool) {
    chips.push(`<span class="chip st-stuck" data-key="tool" title="${esc(tool.summary)}"><span class="dot"></span><span class="chip-t">${esc(tool.summary)} · ${elapsed(tool.startedAt, now)}</span></span>`);
  }
  return chips.length ? chips.join('') : '<span class="none">No active sub-agents</span>';
}

/** Activity list, latest first. */
export function feedList(items, limit, now, freshFeed = new Set(), empty = 'No activity yet') {
  if (!items.length) return `<p class="none">${esc(empty)}</p>`;
  const rows = items.slice(0, limit).map(item => `<li class="fi${freshFeed.has(item.id) ? ' is-new' : ''}" data-key="${esc(item.id)}"><span class="fi-t">${ago(item.at, now)}</span><span><span class="fi-u">${esc(item.label)}</span> ${esc(item.text)}</span></li>`);
  return `<ol class="feed2">${rows.join('')}</ol>`;
}
