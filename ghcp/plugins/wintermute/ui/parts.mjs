import { ago, costText, countdown, dollars, elapsed, esc } from './format.mjs';
import { REPORT_CLASS, REPORT_LABELS, feedText, stateLine } from './model.mjs';

const RING = 2 * Math.PI * 17;

/**
 * Attributes for an endless animation that stays in phase across renders: a negative delay from performance.now() at
 * render (phaseMs), less `offset` seconds for an element that runs behind its siblings, and data-phase, which tells
 * morph() to keep the delay of an element whose animation already runs.
 */
export const phase = (seconds, phaseMs, offset = 0) => `data-phase style="animation-delay:-${((((phaseMs / 1000 - offset) % seconds) + seconds) % seconds).toFixed(2)}s"`;

/** The first three characters of a label, without a trailing separator. */
export const shortLabel = label => String(label).slice(0, 3).replace(/[._-]+$/, '');

/** Escape a word template and fill {t} (time in state) and {a} (age) with live times. */
export function fill(template, at, now) {
  return esc(template).replace('{t}', elapsed(at, now)).replace('{a}', ago(at, now));
}

export const CARET = '<svg class="b-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 8 6l-4 3.5z"/></svg>';

/** A shared mini card for finished and archived outcomes, without an active-state tint. */
export function outcomeCard(unit, { words, tone, at }, ctx) {
  const title = `${unit.label} ${unit.name}`;
  return `<div class="mc tone-${tone}${ctx.detail === unit.id ? ' is-sel' : ''}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(title)}" data-kind="${esc(unit.kind)}">`
    + `<div class="mc-1"><span class="dot"></span><span class="tx" title="${esc(title)}">${esc(title)}</span></div>`
    + `<div class="mc-2">${fill(words, at, ctx.now)}</div><div class="mc-3" title="${esc(costText(unit.cost.credits))}">${dollars(unit.cost.credits)}</div></div>`;
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

/** The state icon drawn inside a status mark, in the middle of its 40 × 40 box. */
function glyph(status, detail, phaseMs) {
  if (status === 'busy') return `<g class="g-dots">${[14, 20, 26].map((cx, index) => `<circle cx="${cx}" cy="20" r="2.2" ${phase(1.4, phaseMs, index * 0.2)}/>`).join('')}</g>`;
  if (status === 'stuck') return '<rect x="18.4" y="11.5" width="3.2" height="10" rx="1.6"/><circle cx="20" cy="27" r="1.9"/>';
  if (status === 'question') return '<path class="g-line" d="M16.3 16.4a3.8 3.8 0 1 1 5.6 3.4c-1.2.6-1.9 1.3-1.9 2.6v.6"/><circle cx="20" cy="27.3" r="1.8"/>';
  if (status === 'plan') return '<path class="g-line" d="M14.5 15h11M14.5 20h11M14.5 25h7"/>';
  if (detail === 'failed' || detail === 'crashed') return '<path class="g-line" d="M15.5 15.5l9 9M24.5 15.5l-9 9"/>';
  if (status === 'blocked') return '<rect x="15.5" y="14" width="3.4" height="12" rx="1.2"/><rect x="21.1" y="14" width="3.4" height="12" rx="1.2"/>';
  if (status === 'merged' || status === 'done') return '<path class="g-line" d="M14.5 20.5l3.8 3.8 7.2-8.3"/>';
  return '<path d="M23.2 13.2a7 7 0 1 0 4.6 11.2 6 6 0 0 1-4.6-11.2z"/>';
}

/**
 * The status mark on cards and in the header: the ring in the status colour (spinning while busy, dashed while stuck),
 * with a state icon inside: dots for busy, "!" for stuck, "?" for question, lines for plan, pause bars for blocked, a
 * moon for idle, a tick for merged or done, a cross for failed or crashed. The state is written next to it, so it is
 * hidden from assistive technology.
 */
export function statusMark(status, detail, phaseMs = 0, size = 32) {
  let arc = '';
  if (status === 'busy') arc = `<circle class="arc spin" cx="20" cy="20" r="17" stroke-dasharray="${(RING * 0.28).toFixed(1)} ${RING.toFixed(1)}" ${phase(4, phaseMs)}/>`;
  else if (status === 'stuck') arc = `<circle class="arc stuck" cx="20" cy="20" r="17" ${phase(2.4, phaseMs)}/>`;
  else if (status !== 'archived') arc = '<circle class="arc" cx="20" cy="20" r="17"/>';
  return `<span class="mark st-${status}"><svg width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="17"/>${arc}<g class="g">${glyph(status, detail, phaseMs)}</g></svg></span>`;
}

/** A 16 px solid triangle in the text colour with a knocked-out "!": some of the unit's data could not be read. */
export const warnMark = text => `<span class="b-warn" role="img" aria-label="Some data could not be read" title="${esc(text)}">`
  + '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 1.5 15.2 14.3H.8zM7.2 5.6h1.6v4.6H7.2zM8 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2z"/></svg></span>';

export const badge = status => `<span class="badge">${REPORT_LABELS[status]}</span>`;
export const closedBadge = '<span class="badge rp-blocked">closed, not merged</span>';
export const reportClass = status => `rp-${REPORT_CLASS[status]}`;
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
    return `${dot}missing · ${from ? `no check for ${elapsed(from, now)}` : 'no check, start time not known'}`;
  }
  if (monitor.state === 'paused') return `${dot}paused${monitor.since ? ` · ${elapsed(monitor.since, now)}` : ''}`;
  if (monitor.state === 'ended') {
    const merged = unit.outcome === 'merged' || unit.pr?.state === 'merged';
    return `${dot}${merged ? (long ? 'ended when the PR merged' : 'ended, PR merged') : 'ended'}`;
  }
  return `${dot}${unit.pr ? 'no monitor' : 'no PR yet'}`;
}

/** Activity list, latest first. */
export function feedList(items, limit, now, freshFeed = new Set(), empty = 'No activity yet') {
  if (!items.length) return `<p class="none">${esc(empty)}</p>`;
  const rows = items.slice(0, limit).map(item => `<li class="fi${freshFeed.has(item.id) ? ' is-new' : ''}" data-key="${esc(item.id)}"><span class="fi-t">${ago(item.at, now)}</span><span><span class="fi-u">${esc(item.label)}</span> ${esc(feedText(item))}</span></li>`);
  return `<ol class="feed2">${rows.join('')}</ol>`;
}
