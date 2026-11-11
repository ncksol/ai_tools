import { costText, dollars, esc, plainText, plural } from './format.mjs';
import {
  BOARD_FINISHED_LIMIT, archivedOutcome, boardZones, finishedOutcome, isMergedUnit, isSubagent, needMark, omittedSubagents, prWords, reviewsWords, stateWords,
} from './model.mjs';
import { CARET, fill, outcomeCard, warnMark } from './parts.mjs';

function plannedCard(entry) {
  const waits = entry.waitsOn ?? entry.dependsOn;
  return `<div class="mc planned st-planned${entry.canStart ? ' can' : ''}"><div class="mc-1"><span class="tx">${esc(entry.label)} ${esc(entry.name)}</span></div>`
    + `<div class="mc-2">${entry.canStart ? 'can start now' : waits ? `waits on ${esc(waits)}` : 'not started'}</div>`
    + `<div class="mc-3">${entry.dependsOn ? `stacks on ${esc(entry.dependsOn)}` : 'no parent branch'}</div></div>`;
}

function unitCard(unit, ctx) {
  const title = `${unit.label} ${unit.name}`;
  const mark = needMark(unit, ctx.snapshot);
  const need = mark ? `<span class="mc-need" title="${esc(plainText(mark.need.text))}">${esc(mark.short)}</span>` : '';
  const side = isSubagent(unit) ? esc(unit.agent?.type ?? 'sub-agent') : unit.pr ? esc(prWords(unit.pr))
    : unit.reviewedPr ? esc(reviewsWords(unit.reviewedPr)) : '';
  return `<div class="mc st-${unit.status}${ctx.detail === unit.id ? ' is-sel' : ''}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(title)}" data-kind="${esc(unit.kind)}">`
    + `<div class="mc-1"><span class="dot"></span><span class="tx" title="${esc(title)}">${esc(title)}</span>${unit.dataWarning ? warnMark(unit.dataWarning) : ''}</div>`
    + `<div class="mc-2">${fill(stateWords(unit), unit.since, ctx.now)}</div>`
    + `<div class="mc-3 mc-row"><span class="mc-side">${need}${need && side ? ' · ' : ''}${side}</span>`
    + `<span class="mc-cost" title="${esc(costText(unit.cost.credits))}">${dollars(unit.cost.credits)}</span></div></div>`;
}

const column = (name, count, body, note = '') => `<section class="bcol" aria-label="${name}"><div class="bcol-h"><b>${name}</b>${count}${note}</div>${body}</section>`;

function finishedColumn(units, ctx) {
  const all = Boolean(ctx.finishedAll);
  const shown = all ? units : units.slice(0, BOARD_FINISHED_LIMIT);
  const merged = units.filter(isMergedUnit).length;
  const toggle = units.length > BOARD_FINISHED_LIMIT
    ? `<button type="button" class="link bcol-more" data-showall aria-expanded="${all}">${all ? 'Show fewer' : `Show all ${units.length}`}</button>`
    : '';
  const omitted = omittedSubagents(ctx.snapshot);
  const earlier = omitted ? `<p class="bcol-more">+${plural(omitted, 'earlier sub-agent')}</p>` : '';
  const cards = shown.map(unit => outcomeCard(unit, finishedOutcome(unit), ctx)).join('') || '<span class="none">Nothing has finished yet.</span>';
  return column('Finished', units.length, cards + toggle + earlier, merged ? `<span class="bcol-s">· ${merged} merged</span>` : '');
}

function archivedHtml(units, ctx) {
  if (!units.length) return '';
  const open = Boolean(ctx.archivedOpen);
  const merged = units.filter(isMergedUnit).length;
  return `<section class="b-fin" aria-label="Archived"><button type="button" class="b-fin-h" data-archived aria-expanded="${open}">${CARET}`
    + `<span class="b-fin-t">Archived</span><span class="b-fin-n">${units.length}</span><span class="b-fin-s">${merged ? `· ${merged} merged · ` : ''}latest first</span></button>`
    + (open ? `<div class="b-fin-list">${units.map(unit => outcomeCard(unit, archivedOutcome(unit), ctx)).join('')}</div>` : '')
    + '</section>';
}

/** The Cards tab's groups as columns, with archived history in a closed row below. */
export function boardHtml(ctx) {
  const zones = boardZones(ctx.snapshot);
  const columns = [];
  if (zones.planned.length) columns.push(column('Planned', zones.planned.length, zones.planned.map(plannedCard).join('')));
  columns.push(column('In progress', zones.progress.length, zones.progress.map(unit => unitCard(unit, ctx)).join('') || '<span class="none">Nothing is running.</span>'));
  if (zones.hasReview) columns.push(column('In review', zones.review.length, zones.review.map(unit => unitCard(unit, ctx)).join('') || '<span class="none">No PR in review.</span>'));
  columns.push(finishedColumn(zones.finished, ctx));
  return `<div class="bd${ctx.stale ? ' is-stale' : ''}"><div class="board">${columns.join('')}</div>${archivedHtml(zones.archived, ctx)}</div>`;
}
