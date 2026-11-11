import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardHtml } from '../ui/board.mjs';
import { closedSnapshot, context, deepFreeze, doneSnapshot, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const headers = html => [...html.matchAll(/<div class="bcol-h">(.*?)<\/div>/g)].map(match => text(match[1]));
const column = (html, name) => html.split(`<section class="bcol" aria-label="${name}">`)[1]?.split('</section>')[0];
const opened = html => [...html.matchAll(/data-open="([^"]+)"/g)].map(match => match[1]);
/** The text of one card: from its opening tag to the next card, the end of its section or a button. */
function card(html, id) {
  const after = html.split(`data-open="${id}"`)[1];
  return text(after.slice(after.indexOf('>') + 1).split(/<div class="mc |<\/section>|<button/)[0]);
}

test('the Board never changes the snapshot', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  assert.doesNotThrow(() => boardHtml(context(snapshot, { archivedOpen: true, finishedAll: true })));
});

test('the Board groups units as the Cards tab does: planned, in progress, in review and finished, with counts', () => {
  const html = boardHtml(context(exampleSnapshot()));
  assert.deepEqual(headers(html), ['Planned 2', 'In progress 5', 'In review 2', 'Finished 4 · 1 merged']);
  assert.deepEqual(opened(column(html, 'In progress')), ['ws-0005-i1', 'call-root-40', 'ws-0004-b2', 'ws-0006-f1', 'call-root-41']);
  assert.deepEqual(opened(column(html, 'In review')), ['ws-0003-b1', 'ws-0007-d5']);
  assert.deepEqual(opened(column(html, 'Finished')), ['ws-0002-f2a', 'call-root-24', 'call-root-18', 'call-root-12']);
  assert.match(html, /<div class="mc planned st-planned can"><div class="mc-1"><span class="tx">B3 export<\/span><\/div><div class="mc-2">can start now<\/div><div class="mc-3">stacks on B1<\/div><\/div>/);
  assert.match(text(column(html, 'Planned')), /I2 load tests waits on I1 stacks on I1/);
});

test('an active card shows its state in words, its PR or type, a Needs you marker and its cost in dollars', () => {
  const html = boardHtml(context(exampleSnapshot()));
  assert.equal(card(html, 'ws-0005-i1'), 'I1 integration Stuck · tool call 48m ≈$97');
  assert.equal(card(html, 'ws-0003-b1'), 'B1 API Busy · 35m PR #418 · in review ≈$240');
  assert.equal(card(html, 'ws-0007-d5'), 'D5 docs Idle · 9m Approve · PR #421 · draft ≈$31');
  assert.equal(card(html, 'call-root-40'), 'table-research DataGrid or a new table Stuck · silent 15m research ≈$1.02');
  assert.match(html, /<span class="mc-need" title="Publish PR #421 for review\?">Approve<\/span> · PR #421 · draft<\/span><span class="mc-cost" title="3,058 cr · ≈\$30\.58">≈\$31<\/span>/);
  assert.match(html, /<div class="mc st-stuck" data-open="ws-0005-i1" tabindex="0" role="button" aria-label="Open details for I1 integration" data-kind="project">/);
  const reviewer = exampleSnapshot();
  reviewer.units.find(unit => unit.label === 'F1').reviewedPr = { provider: 'github', id: 418, repo: null, url: null };
  assert.equal(card(boardHtml(context(reviewer)), 'ws-0006-f1'), 'F1 UI Blocked on orchestrator · 12m reviews PR #418 ≈$83');
});

test('a selected card is outlined, and a card whose data is incomplete has the warning mark', () => {
  const snapshot = exampleSnapshot();
  snapshot.units.find(unit => unit.label === 'I1').dataWarning = 'Its log could not be read at 14:00. Cost and state may be out of date.';
  const html = boardHtml(context(snapshot, { detail: 'ws-0005-i1' }));
  assert.match(html, /<div class="mc st-stuck is-sel" data-open="ws-0005-i1"/);
  const line1 = html.split('data-open="ws-0005-i1"')[1].split('<div class="mc-2">')[0];
  assert.match(line1, /class="b-warn" role="img" aria-label="Some data could not be read" title="Its log could not be read at 14:00\. Cost and state may be out of date\."/);
});

test('Planned shows only with planned units, and In review only once the swarm has had a PR', () => {
  const snapshot = exampleSnapshot();
  snapshot.planned = [];
  for (const unit of snapshot.units) unit.pr = null;
  assert.deepEqual(headers(boardHtml(context(snapshot))), ['In progress 6', 'Finished 5 · 1 merged']);
});

test('empty columns say so', () => {
  const quiet = exampleSnapshot();
  quiet.units = quiet.units.filter(unit => !['B1', 'D5'].includes(unit.label));
  assert.equal(text(column(boardHtml(context(quiet)), 'In review')), 'In review 0 No PR in review.');
  const empty = exampleSnapshot();
  empty.units = [];
  empty.planned = [];
  assert.equal(text(boardHtml(context(empty))), 'In progress 0 Nothing is running. Finished 0 Nothing has finished yet.');
});

test('Finished shows the latest ten until Show all, then every one; the count of earlier sub-agents comes last', () => {
  const snapshot = exampleSnapshot();
  const f2a = snapshot.units.find(unit => unit.label === 'F2a');
  for (let i = 0; i < 9; i += 1) snapshot.units.push({ ...structuredClone(f2a), id: `extra-${i}`, label: `X${i}`, endedAt: f2a.endedAt - (i + 1) * 60000 });
  snapshot.omittedSubagents = { done: 2, failed: 1 };
  const latest = column(boardHtml(context(snapshot)), 'Finished');
  assert.equal(opened(latest).length, 10);
  assert.ok(latest.endsWith('<button type="button" class="link bcol-more" data-showall aria-expanded="false">Show all 13</button><p class="bcol-more">+3 earlier sub-agents</p>'));
  const every = column(boardHtml(context(snapshot, { finishedAll: true })), 'Finished');
  assert.equal(opened(every).length, 13);
  assert.match(every, /data-showall aria-expanded="true">Show fewer<\/button>/);
});

test('archived units wait under one closed row below the columns, and read as their outcome when it is opened', () => {
  const html = boardHtml(context(exampleSnapshot()));
  const row = html.slice(html.indexOf('<section class="b-fin" aria-label="Archived">'));
  assert.match(row, /^<section class="b-fin" aria-label="Archived"><button type="button" class="b-fin-h" data-archived aria-expanded="false">/);
  assert.equal(text(row), 'Archived 1 1 merged · latest first');
  assert.ok(html.indexOf('aria-label="Archived"') > html.lastIndexOf('<section class="bcol"'));
  const open = boardHtml(context(exampleSnapshot(), { archivedOpen: true }));
  assert.match(open, /data-archived aria-expanded="true"/);
  assert.equal(card(open, 'ws-0001-b0'), 'B0 schema merged 1d 4h ago ≈$109');
  const none = exampleSnapshot();
  none.units = none.units.filter(unit => unit.label !== 'B0');
  assert.doesNotMatch(boardHtml(context(none)), /aria-label="Archived"/);
});

test('a unit whose PR closed without merging is finished and says so', () => {
  const html = boardHtml(context(closedSnapshot()));
  assert.equal(card(html, 'ws-0007-d5'), 'D5 docs closed, not merged 20m ago ≈$31');
  assert.deepEqual(opened(column(html, 'In review')), ['ws-0003-b1']);
});

test('a finished reviewer reads done, not closed without merging', () => {
  const html = boardHtml(context(doneSnapshot()));
  assert.equal(card(html, 'ws-0007-d5'), 'D5 docs done 20m ago ≈$31');
  assert.doesNotMatch(html, /closed, not merged/);
});

test('while the page is disconnected the Board dims', () => {
  assert.ok(boardHtml(context(exampleSnapshot(), { stale: true })).startsWith('<div class="bd is-stale"><div class="board">'));
  assert.ok(boardHtml(context(exampleSnapshot())).startsWith('<div class="bd"><div class="board">'));
});
