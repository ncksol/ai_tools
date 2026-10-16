import { HOUR, MIN, ago, costHtml, costText, dur, elapsed, esc, plainText, plural } from './format.mjs';
import { REPORT_CLASS, TIMELINE_WORDS, isSubagent, reportTitle, runEnd, unitEnd, withoutStatusPrefix } from './model.mjs';
import { fill, phase } from './parts.mjs';

export const SPANS = Object.freeze({ '3h': 3 * HOUR, '12h': 12 * HOUR, run: null });
const SPAN_LABELS = { '3h': 'last 3h', '12h': 'last 12h', run: 'whole run' };
const PRIORITY = { question: 5, answer: 4, 'plan-req': 4, 'plan-ok': 4, 'pr-merged': 4, archived: 4, 'pr-open': 3, tool: 3, report: 2, 'pr-comment': 1 };
const KEYS = [['report', 'report'], ['question', 'question'], ['plan-req', 'plan sent'], ['plan-ok', 'plan approved'], ['pr-open', 'PR'], ['monitor', 'monitor check']];
const REPORT_INK = { blocked: '--blocked-ink', progress: '--busy-ink', needs_input: '--question-ink' };
const HATCH = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><pattern id="cHatch2" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="var(--stuck-soft)"/><rect width="2" height="4" fill="var(--stuck)"/></pattern></defs></svg>';
const r1 = value => Math.round(value * 10) / 10;
const pad = value => String(value).padStart(2, '0');

export function timelineWindow(snapshot, span, now) {
  const length = SPANS[span];
  return { t0: length ? now - length : snapshot.run.startedAt - 20 * MIN, t1: now };
}

/** The orchestrator's lane leaves out the bars of sub-agents that have their own lanes; other sessions are unchanged. */
export function laneSource(session, snapshot) {
  if (session !== snapshot.orchestrator) return session;
  const own = new Set(snapshot.units.map(unit => unit.id));
  if (!session.timeline.subagents.some(bar => own.has(bar.id))) return session;
  return { ...session, timeline: { ...session.timeline, subagents: session.timeline.subagents.filter(bar => !own.has(bar.id)) } };
}

/** One timeline marker centred on (x, y), with the mockup's shapes. */
export function markSvg(mark, x, y) {
  const text = plainText(mark.text);
  const shown = (mark.status ? withoutStatusPrefix(text, mark.status) : text).trim() || text;
  const title = `<title>${esc(shown)}</title>`;
  const at = (dx, dy) => `${r1(x + dx)} ${r1(y + dy)}`;
  switch (mark.kind) {
    case 'report': return `<circle cx="${r1(x)}" cy="${r1(y)}" r="4" fill="var(${REPORT_INK[mark.status] ?? '--merged-ink'})" stroke="var(--surface)" stroke-width="1.5">${title}</circle>`;
    case 'question': return `<path d="M${at(0, -5)}L${at(5, 0)}L${at(0, 5)}L${at(-5, 0)}Z" fill="var(--question-ink)" stroke="var(--surface)" stroke-width="1.5">${title}</path>`;
    case 'answer': return `<path d="M${at(0, -4)}L${at(4, 0)}L${at(0, 4)}L${at(-4, 0)}Z" fill="var(--surface)" stroke="var(--question-ink)" stroke-width="1.5">${title}</path>`;
    case 'plan-req': return `<rect x="${r1(x - 3.5)}" y="${r1(y - 3.5)}" width="7" height="7" fill="var(--surface)" stroke="var(--plan-ink)" stroke-width="1.5">${title}</rect>`;
    case 'plan-ok': return `<rect x="${r1(x - 4)}" y="${r1(y - 4)}" width="8" height="8" fill="var(--plan-ink)" stroke="var(--surface)" stroke-width="1">${title}</rect>`;
    case 'pr-open': return `<path d="M${at(-4.5, 4)}L${at(0, -4.5)}L${at(4.5, 4)}Z" fill="var(--ink-2)" stroke="var(--surface)" stroke-width="1">${title}</path>`;
    case 'pr-merged': return `<path d="M${at(-4.5, 4)}L${at(0, -4.5)}L${at(4.5, 4)}Z" fill="var(--merged-ink)" stroke="var(--surface)" stroke-width="1">${title}</path>`;
    case 'archived': return `<circle cx="${r1(x)}" cy="${r1(y)}" r="3.5" fill="var(--surface)" stroke="var(--archived-ink)" stroke-width="1.5">${title}</circle>`;
    case 'pr-comment': return `<rect x="${r1(x - 1)}" y="${r1(y - 5)}" width="2" height="10" fill="var(--ink-2)">${title}</rect>`;
    case 'tool': return `<rect x="${r1(x - 1)}" y="${r1(y - 5)}" width="2" height="10" fill="var(--stuck-ink)">${title}</rect>`;
    case 'monitor': return `<line class="t-mon" x1="${r1(x)}" y1="${r1(y - 3)}" x2="${r1(x)}" y2="${r1(y + 3)}">${title}</line>`;
    default: return '';
  }
}

/**
 * One session's lane: state spans, up to three sub-agent tracks, monitor ticks and thinned markers. `end` is the
 * session's end (null while it runs); after it, open spans and bars stop there and nothing in the lane grows or moves.
 */
export function laneSvg(session, width, t0, t1, now, phaseMs = 0, end = null) {
  const X0 = 4;
  const X1 = width - 8;
  const k = (X1 - X0) / (t1 - t0);
  const X = t => X0 + (t - t0) * k;
  const { segments, subagents, marks } = session.timeline;
  let spans = '';
  for (const segment of segments) {
    const stop = segment.end ?? end ?? now;
    if (stop <= t0 || segment.start >= t1) continue;
    const x1 = X(Math.max(segment.start, t0));
    const wide = Math.max(1, X(Math.min(stop, t1)) - x1);
    const live = segment.end === null && end === null;
    if (segment.state === 'idle') spans += `<line class="t-idle" x1="${x1.toFixed(1)}" y1="10" x2="${(x1 + wide).toFixed(1)}" y2="10"/>`;
    else spans += `<rect class="t-${segment.state}${live && segment.state === 'stuck' ? ' live' : ''}" x="${x1.toFixed(1)}" y="5" width="${wide.toFixed(1)}" height="10" rx="2"${live && segment.state === 'stuck' ? ` ${phase(2.4, phaseMs)}` : ''}/>`;
    if (live && segment.state === 'busy') spans += `<rect class="t-edge" x="${(x1 + wide - 2).toFixed(1)}" y="5" width="2" height="10" ${phase(2, phaseMs)}/>`;
  }
  const tracks = [];
  let bars = '';
  for (const bar of subagents.filter(item => (item.end ?? end ?? now) > t0 && item.start < t1).sort((a, b) => a.start - b.start)) {
    const x1 = X(Math.max(bar.start, t0));
    const x2 = Math.max(x1 + 2, X(Math.min(bar.end ?? end ?? now, t1)));
    let track = tracks.findIndex(right => right + 2 <= x1);
    if (track < 0) {
      if (tracks.length >= 3) continue;
      tracks.push(0);
      track = tracks.length - 1;
    }
    tracks[track] = x2;
    bars += `<rect class="t-sub${bar.end === null && end === null ? ' live' : ''}" x="${x1.toFixed(1)}" y="${24 + track * 8}" width="${(x2 - x1).toFixed(1)}" height="4" rx="1"><title>${esc(bar.type)}</title></rect>`;
  }
  let ticks = '';
  const kept = [];
  let last = -99;
  let lastPriority = 0;
  for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
    if (mark.at < t0 || mark.at > t1) continue;
    const x = X(mark.at);
    if (mark.kind === 'monitor') {
      if (k * 10 * MIN >= 4) ticks += markSvg(mark, x, 19);
      continue;
    }
    const priority = PRIORITY[mark.kind] ?? 1;
    if (x - last < 12) {
      if (priority > lastPriority) {
        kept[kept.length - 1] = { mark, x };
        last = x;
        lastPriority = priority;
      }
      continue;
    }
    kept.push({ mark, x });
    last = x;
    lastPriority = priority;
  }
  const height = 20 + (tracks.length ? 4 + tracks.length * 8 : 4);
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line class="t-now" x1="${X1}" y1="0" x2="${X1}" y2="${height}"/>${spans}${ticks}${bars}${kept.map(({ mark, x }) => `<g>${markSvg(mark, x, 10)}</g>`).join('')}</svg>`;
}

/** Time axis with local-time ticks that never overlap and stay clear of "now". */
export function axisSvg(width, t0, t1) {
  const X0 = 4;
  const X1 = width - 8;
  const k = (X1 - X0) / (t1 - t0);
  const span = t1 - t0;
  const step = span <= 3 * HOUR ? 30 * MIN : span <= 12 * HOUR ? 2 * HOUR : span <= 72 * HOUR ? 12 * HOUR : 24 * HOUR;
  const offset = new Date(t0).getTimezoneOffset() * MIN;
  let out = `<g class="t-axis"><text x="${X1}" y="12" text-anchor="end">now</text>`;
  let lastEnd = -99;
  for (let t = Math.ceil((t0 - offset) / step) * step + offset; t < t1; t += step) {
    const x = X0 + (t - t0) * k;
    const date = new Date(t);
    const label = step >= 12 * HOUR ? `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${pad(date.getHours())}:00` : `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const half = (label.length * 7) / 2;
    if (x - half < lastEnd + 8 || x + half > X1 - 36 || x - half < 0) continue;
    out += `<line x1="${x.toFixed(1)}" y1="16" x2="${x.toFixed(1)}" y2="20"/><text x="${x.toFixed(1)}" y="12" text-anchor="middle">${label}</text>`;
    lastEnd = x + half;
  }
  return `<svg width="${width}" height="20" viewBox="0 0 ${width} 20" aria-hidden="true">${out}</g></svg>`;
}

/** Cumulative swarm cost over the window, from the snapshot's 5-minute series, ending at the current total. */
export function costSvg(cost, width, t0, t1, now) {
  const X0 = 4;
  const X1 = width - 8;
  const H = 40;
  const k = (X1 - X0) / (t1 - t0);
  const points = cost.series.filter(point => point.at >= t0 && point.at <= t1).map(point => [point.at, point.credits]);
  const before = cost.series.filter(point => point.at < t0).pop();
  if (before) points.unshift([t0, before.credits]);
  points.push([Math.min(now, t1), cost.credits]);
  if (points.length < 2) points.unshift([t0, points[0][1]]);
  const lo = points[0][1];
  const hi = points[points.length - 1][1];
  const Y = value => H - 4 - (hi === lo ? 0 : ((value - lo) / (hi - lo)) * (H - 8));
  const d = points.map(([t, value], index) => `${index ? 'L' : 'M'}${(X0 + (t - t0) * k).toFixed(1)} ${Y(value).toFixed(1)}`).join('');
  return `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" aria-hidden="true"><path class="t-cost" d="${d}"/><circle cx="${X1}" cy="${Y(hi).toFixed(1)}" r="3" fill="var(--ink-2)"/></svg>`;
}

function whoHtml(session, snapshot, now) {
  const isOrchestrator = session === snapshot.orchestrator;
  const end = isOrchestrator ? runEnd(snapshot) : unitEnd(session, snapshot);
  const runtime = end ? `ran ${dur(end - session.startedAt)}` : elapsed(session.startedAt, now);
  return `<div class="c-name"><span class="dot${session.status === 'stuck' ? ' stuck' : ''}"></span><span class="tx">${esc(isOrchestrator ? session.name : `${session.label} ${session.name}`)}</span></div>`
    + `<div class="c-meta">${runtime} · ${costText(session.cost.credits)}</div>`;
}

function sumHtml(session, snapshot, now) {
  if (session === snapshot.orchestrator) return `<div class="c-rep">${esc(session.activity.label)}</div><div class="c-meta">orchestrator</div>`;
  const words = TIMELINE_WORDS[session.status];
  const state = words ? `<span class="s">${fill(words, session.since, now)}</span>` : '';
  if (!session.report) return `<div class="c-rep muted">No report yet</div><div class="c-meta">${state || '&nbsp;'}</div>`;
  return `<div class="c-rep rp-${REPORT_CLASS[session.report.status]}"><span class="dot"></span>${esc(reportTitle(session.report))}</div>`
    + `<div class="c-meta">${ago(session.report.at, now)}${state ? ` · ${state}` : ''}</div>`;
}

/**
 * Lanes: the orchestrator, then its one-off sub-agents nested under it (oldest first), then the child sessions in
 * snapshot order. Only sub-agent lanes that overlap the window are drawn; one muted row in their place counts the rest.
 */
export function timelineHtml(ctx, span) {
  const { snapshot, now } = ctx;
  const { t0, t1 } = timelineWindow(snapshot, span, now);
  const subagents = snapshot.units.filter(isSubagent);
  const shown = subagents.filter(unit => unit.startedAt < t1 && (unitEnd(unit, snapshot) ?? now) > t0);
  const hidden = subagents.length - shown.length;
  const sessionRow = (session, extra = '') => `<div class="c-row st-${session.status}${extra}" data-id="${esc(session.id)}"><div class="c-who">${whoHtml(session, snapshot, now)}</div><div class="c-trk" data-drawn></div><div class="c-sum">${sumHtml(session, snapshot, now)}</div></div>`;
  const buttons = Object.keys(SPANS).map(key => `<button type="button" data-span="${key}" aria-pressed="${key === span}">${SPAN_LABELS[key]}</button>`).join('');
  const keys = KEYS.map(([kind, label]) => `<span><svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true">${markSvg({ kind, status: 'complete', text: label }, 0, 0)}</svg>${label}</span>`).join('');
  const axis = '<div class="c-row c-axis"><div class="c-who"><span class="c-head">Session</span></div><div class="c-trk" data-drawn></div><div class="c-sum"><span class="c-head">Latest report</span></div></div>';
  // The muted row holds only its line, across the whole row. Its key keeps the rows after it in place when it comes or
  // goes; it has no data-id, so nothing draws in it.
  const more = hidden ? `<div class="c-row c-more is-sub" data-key="subagents-outside"><div class="c-who"><span class="c-meta">+${plural(hidden, 'sub-agent')} outside this window</span></div></div>` : '';
  const rows = sessionRow(snapshot.orchestrator) + more + shown.map(unit => sessionRow(unit, ' is-sub')).join('')
    + snapshot.units.filter(unit => !isSubagent(unit)).map(unit => sessionRow(unit)).join('');
  const cost = `<div class="c-row c-cost"><div class="c-who"><div class="c-name">Swarm cost</div><div class="c-meta">all sessions</div></div><div class="c-trk" data-drawn></div><div class="c-sum"><span class="c-total">${costHtml(snapshot.cost.credits, true)}</span></div></div>`;
  return `<div class="c" data-timeline><div class="c-bar"><div class="seg" role="group" aria-label="Time window">${buttons}</div><div class="c-keys">${keys}</div></div>${HATCH}<div class="c-rows">${axis}${rows}${cost}</div></div>`;
}
