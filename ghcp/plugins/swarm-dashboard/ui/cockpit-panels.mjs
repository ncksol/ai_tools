/** HTML for the cockpit's panels, its top line, its quality switch and its note. Pure: Node tests import it. */
import { count, countdown, credits, dur, esc, liveTime, plural, usdRounded } from './format.mjs';
import { runEnd } from './model.mjs';
import { activityRows, clockText, costView, dateText, legend, needRows, nextCheckAt, prRows, runLine, stateWord, tileGrid, timeText, unitCounts } from './cockpit-model.mjs';
import { QUALITIES } from './cockpit-quality.mjs';

const QUALITY_WORDS = { high: 'High', balanced: 'Balanced' };
/** A panel header: its title, a quiet button that opens a tab of the regular view, and a note on the right. */
const head = (title, tab, side = '') => `<header class="ck-ph"><button type="button" class="ck-t" data-tab="${tab}">${title}</button>${side ? `<span class="ck-side">${side}</span>` : ''}</header>`;
const empty = text => `<p class="ck-empty">${text}</p>`;
const row = (key, value, mono = true) => `<div class="ck-row"><span class="ck-k">${key}</span><span class="ck-v${mono ? ' ck-mono' : ''}">${value}</span></div>`;

export function clockHtml(snapshot, now) {
  const { hm, s } = clockText(now);
  const clock = `<div class="ck-clock"><span class="ck-mono ck-hm" data-clock="hm">${hm}</span><span class="ck-mono ck-s" data-clock="s">${s}</span></div>`
    + `<div class="ck-meta" data-clock="date">${esc(dateText(now))}</div>`;
  if (!snapshot) return clock + row('Swarm', 'None yet', false);
  const end = runEnd(snapshot);
  const next = nextCheckAt(snapshot);
  const line = esc(runLine(snapshot));
  return clock
    + row(end === null ? 'Running' : 'Ran', end === null ? liveTime(snapshot.run.startedAt, now, 'clock') : dur(end - snapshot.run.startedAt, 'clock'))
    + (next === null ? row('Next check', 'None scheduled', false) : row('Next check', countdown(next, now)))
    + `<div class="ck-meta ck-ellipsis" title="${line}">${line}</div>`;
}

export function costHtml(snapshot, now) {
  if (!snapshot) return head('Cost', 'timeline') + empty('No swarm yet');
  const view = costView(snapshot, now);
  const side = view.perHour === null ? '' : `<span class="ck-mono">+${count(Math.round(view.perHour))} cr/h</span>`;
  const models = view.models.map(entry => `<div class="ck-model" data-key="${esc(entry.model)}"><span class="ck-model-n">${esc(entry.model)}</span>`
    + `<span class="ck-mono ck-n">${count(Math.round(entry.credits))}</span><span class="ck-bar"><span class="ck-fill" style="--w:${entry.share.toFixed(4)}"></span></span></div>`).join('');
  return head('Cost', 'timeline', side) + `<div class="ck-big ck-mono">${credits(view.credits)}</div><div class="ck-meta ck-mono">${usdRounded(view.credits)} at list price</div><div class="ck-models">${models}</div>`;
}

export function needsHtml(snapshot, now) {
  const { total, rows } = snapshot ? needRows(snapshot) : { total: 0, rows: [] };
  const header = `<header class="ck-ph"><span class="ck-needs-t"><span class="ck-light${total ? '' : ' is-off'}"></span><button type="button" class="ck-t" data-tab="cards">Needs you</button></span>`
    + `<span class="ck-side ck-big ck-mono">${count(total)}</span></header>`;
  if (!rows.length) return header + empty('Nothing waiting');
  const items = rows.map(item => `<li data-key="${esc(item.id)}"><button type="button" class="ck-need st-${item.state}"${item.unitId ? ` data-detail="${esc(item.unitId)}"` : ''}>`
    + `<span class="ck-mono ck-lab" title="${esc(item.who)}">${esc(item.who)}</span><span class="ck-kind">${esc(item.word)}</span><span class="ck-mono ck-age">${liveTime(item.since, now)}</span>`
    + `<span class="ck-txt" title="${esc(item.text)}">${esc(item.text)}</span></button></li>`).join('');
  return `${header}<ul class="ck-needs">${items}</ul>`;
}

export function statusHtml(snapshot) {
  if (!snapshot) return head('Status', 'board') + empty('No swarm yet');
  const view = legend(snapshot);
  const rows = view.rows.map(item => `<li class="st-${item.state}${item.count ? '' : ' is-zero'}"><span class="ck-dot"></span><span class="ck-w">${item.word}</span><span class="ck-mono ck-n">${count(item.count)}</span></li>`).join('');
  return head('Status', 'board', `<span class="ck-mono">${count(view.live)} live · ${count(view.ended)} ended</span>`) + `<ul class="ck-leg">${rows}</ul>`;
}

export function activityHtml(snapshot) {
  const rows = snapshot ? activityRows(snapshot) : [];
  if (!rows.length) return head('Activity', 'cards') + empty('No activity yet');
  // One label column for every row, as wide as the longest label shown but at most 6 characters of monospace, so one
  // long sub-agent label does not squeeze every row's text.
  const width = Math.min(6, Math.max(2, ...rows.map(item => item.label.length)));
  const items = rows.map(item => {
    const inner = `<span class="ck-mono ck-time">${timeText(item.at)}</span><span class="ck-mono ck-lab" title="${esc(item.label)}">${esc(item.label)}</span><span class="ck-txt" title="${esc(item.text)}">${esc(item.text)}</span>`;
    const cls = `ck-log-row${item.status ? ` st-${item.status}` : ''}`;
    return `<li data-key="${esc(item.id)}">${item.unitId ? `<button type="button" class="${cls}" data-detail="${esc(item.unitId)}">${inner}</button>` : `<div class="${cls}">${inner}</div>`}</li>`;
  }).join('');
  return head('Activity', 'cards', `<span class="ck-mono">${plural(snapshot.feed.length, 'recent event')}</span>`) + `<div class="ck-log-window" style="--lab:${width}ch"><ol class="ck-log">${items}</ol></div>`;
}

function tileHtml(tile, density, now, fresh) {
  const cls = `ck-tile st-${tile.status}${tile.attention ? ' is-attn' : ''}${fresh ? ' is-new' : ''}`;
  const who = `${tile.label} ${tile.name}`;
  return `<button type="button" class="${cls}" data-detail="${esc(tile.id)}" data-key="${esc(tile.id)}" title="${esc(who)}" aria-label="${esc(`${who}, ${tile.word}`)}">`
    + `<span class="ck-id"><span class="ck-dot"></span><span class="ck-mono ck-lab">${esc(tile.label)}</span></span><span class="ck-mono ck-age">${liveTime(tile.since, now)}</span>`
    + (density === 'full' ? `<span class="ck-name">${esc(tile.name)}</span>` : '')
    + (density === 'one' ? '' : `<span class="ck-state">${esc(tile.word)}</span>`)
    + '</button>';
}

export function unitsHtml(snapshot, now, fresh) {
  if (!snapshot) return head('Mission control', 'cards') + empty('No swarm yet');
  const orchestrator = snapshot.orchestrator;
  const side = `${esc(orchestrator.label)} orchestrator · ${esc(stateWord(orchestrator))} · ${liveTime(orchestrator.since, now)}`;
  const grid = tileGrid(snapshot);
  const tiles = grid.tiles.map(tile => tileHtml(tile, grid.density, now, fresh.has(tile.id))).join('')
    + (grid.more ? `<button type="button" class="ck-tile ck-more" data-tab="board" data-key="more" title="On the Board"><span>+${grid.more} more</span></button>` : '');
  const counts = unitCounts(snapshot);
  const foot = `${plural(counts.sessions, 'child session')} · ${plural(counts.running, 'sub-agent')} running · ${count(counts.finished)} finished`;
  return head('Mission control', 'cards', side)
    + (grid.tiles.length ? `<div class="ck-tiles d-${grid.density}">${tiles}</div>` : empty('No child sessions yet'))
    + `<p class="ck-foot">${foot}</p>`;
}

export function prsHtml(snapshot) {
  if (!snapshot) return head('Pull requests', 'board') + empty('No pull requests yet');
  const view = prRows(snapshot);
  const side = `<span class="ck-mono">${count(view.opened)} opened · ${count(view.merged)} merged</span>`;
  if (!view.rows.length) return head('Pull requests', 'board', side) + empty('No pull requests yet');
  const rows = view.rows.map(item => `<li data-key="${esc(item.id)}"><button type="button" class="ck-pr st-${item.state}" data-detail="${esc(item.unitId)}">`
    + `<span class="ck-mono ck-num">#${esc(item.id)}</span><span class="ck-pr-t"><span class="ck-ttl" title="${esc(item.title)}">${esc(item.title)}</span><span class="ck-sub">${esc(item.who)}</span></span>`
    + `<span class="ck-pr-s"><span class="ck-dot"></span>${esc(item.word)}</span></button></li>`).join('');
  return head('Pull requests', 'board', side) + `<ul class="ck-prs">${rows}</ul>`;
}

export function hudHtml({ demo, connection, snapshot }) {
  const parts = ['Swarm cockpit'];
  if (demo) parts.push('Sample data');
  if (snapshot?.run.lifecycle === 'finished') parts.push('Swarm finished');
  return `<span>${parts.join(' · ')}</span>${connection === 'retrying' ? '<span class="ck-warn"> · Disconnected · retrying</span>' : ''}`;
}

export const qualityHtml = quality => QUALITIES.map(name => `<button type="button" data-quality="${name}" aria-pressed="${name === quality}">${QUALITY_WORDS[name]}</button>`).join('');

export const noteHtml = () => '<p>Make this window larger to see the cockpit.</p><p class="ck-dim">It needs at least 1100 × 800, about 1.3 times as wide as it is tall.</p>'
  + '<button type="button" class="ck-t" data-tab="cards">Open the regular view</button>';
