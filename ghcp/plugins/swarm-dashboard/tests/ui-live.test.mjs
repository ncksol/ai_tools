import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dur, esc } from '../ui/format.mjs';
import { cardHtml, cardsHtml, detailHtml, headerHtml, needsHtml } from '../ui/live.mjs';
import { findByLabel } from '../ui/model.mjs';
import { NOW, closedSnapshot, context, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const card = (html, id) => html.split('<article').find(part => part.includes(`data-open="${id}"`));
const cardIds = html => [...html.matchAll(/<article class="b-card[^"]*" data-open="([^"]+)"/g)].map(match => match[1]);

test('a unit whose PR closed without merging stays in PR open with a badge, and its monitor has ended', () => {
  const d5 = card(cardsHtml(context(closedSnapshot())), 'ws-0007-d5');
  assert.match(d5, /<span class="r">PR open<\/span>/);
  assert.match(d5, /<span class="mon mon-ended"><span class="dot"><\/span>ended<span class="badge rp-blocked">closed, not merged<\/span><\/span>/);
  assert.doesNotMatch(card(cardsHtml(context(exampleSnapshot())), 'ws-0007-d5'), /closed, not merged/);
});

test('the header shows the run, its running time, swarm cost and counts by bucket', () => {
  const html = headerHtml(context(exampleSnapshot()));
  assert.match(text(html), /Sample story B Orchestrator · sample-project Running 2d 23h 12m 00s Swarm cost 97,652 cr · ≈\$977/);
  assert.match(html, /<span class="ring st-question" title="SB">/);
  assert.match(html, /<div class="d-counts" role="group" aria-label="Child sessions by state">/);
  assert.match(html, /data-t="1791809280000" data-f="clock"/);
  const tiles = [...html.matchAll(/<div class="tile st-(\w+)"><span class="v">(\d+)<\/span><span class="k"><span class="dot"><\/span>(\w+)<\/span><\/div>/g)].map(match => match.slice(1));
  assert.deepEqual(tiles, [['busy', '1', 'working'], ['stuck', '1', 'stuck'], ['plan', '2', 'waiting'], ['idle', '1', 'idle'], ['merged', '2', 'done'], ['blocked', '0', 'failed']]);
});

test('a finished run shows how long it ran, with no ticking clock', () => {
  const snapshot = exampleSnapshot();
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: snapshot.run.startedAt + 3600000 });
  const html = headerHtml(context(snapshot));
  assert.match(text(html), /Ran 1h 00m 00s/);
  assert.doesNotMatch(html, /data-f="clock"/);
});

test('a finished run stops the clock of a unit that has no end of its own', () => {
  const snapshot = exampleSnapshot();
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: NOW - 3600000 });
  const b1 = findByLabel(snapshot, 'B1');
  const html = card(cardsHtml(context(snapshot)), b1.id);
  assert.ok(text(html).includes(`Ran ${dur(NOW - 3600000 - b1.startedAt, 'clock')}`), text(html));
  assert.doesNotMatch(html, /data-f="clock"/);
});

test('a card names a report with a blank title "Untitled report"', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').report.title = '  ';
  assert.match(card(cardsHtml(context(snapshot)), 'ws-0003-b1'), /<span class="b-rep-t" title="Untitled report">Untitled report<\/span>/);
});

test('cards and Needs you show report and question text as plain text, without a repeated status', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'B1').report, { title: 'Status: progress. Wired **all** routes', status: 'progress' });
  snapshot.needs[0].text = 'Keep the **v1** format?';
  const b1 = card(cardsHtml(context(snapshot)), 'ws-0003-b1');
  assert.match(b1, /<span class="b-rep-t" title="Wired all routes">Wired all routes<\/span>/);
  assert.doesNotMatch(b1, /\*\*/);
  const needs = needsHtml(context(snapshot));
  assert.match(needs, /<span class="need-t" title="Keep the v1 format\?">Keep the v1 format\?<\/span>/);
  assert.doesNotMatch(needs, /\*\*/);
});

test('Needs you lists each item with its unit and wait time, or says nothing is waiting', () => {
  const snapshot = exampleSnapshot();
  const html = needsHtml(context(snapshot));
  assert.match(text(html), /Needs you 2 waiting, longest first/);
  assert.deepEqual([...html.matchAll(/<div class="need st-(\w+)" data-key="[^"]+">/g)].map(match => match[1]), ['plan', 'pr']);
  assert.ok(html.includes(esc(snapshot.needs[0].text)));
  assert.match(text(html), /Plan to approve .* B2 import · waiting 38m/);
  assert.match(text(html), /PR to approve .* D5 docs · waiting 25m/);
  snapshot.needs = [];
  const empty = needsHtml(context(snapshot));
  assert.match(text(empty), /Needs you Nothing waiting/);
  assert.doesNotMatch(empty, /needs-list/);
});

test('a stalled swarm is the first Needs you item, in stuck colours', () => {
  const snapshot = exampleSnapshot();
  snapshot.run.stalled = { since: NOW - 600000, reason: 'Swarm rule: the orchestrator and every open child are idle, and no monitor is due.' };
  const html = needsHtml(context(snapshot));
  assert.deepEqual([...html.matchAll(/<div class="need st-(\w+)" data-key="[^"]+">/g)].map(match => match[1]), ['stuck', 'plan', 'pr']);
  assert.match(text(html), /Swarm stalled Swarm rule: the orchestrator .* Sample story B · stalled 10m/);
});

test('cards sort by attention, hide archived units and point to the Board for them', () => {
  const html = cardsHtml(context(exampleSnapshot()));
  assert.deepEqual(cardIds(html), ['ws-0005-i1', 'ws-0004-b2', 'ws-0006-f1', 'ws-0003-b1', 'ws-0007-d5', 'ws-0002-f2a']);
  const note = '<p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board">Board tab</button>.</p>';
  assert.ok(html.startsWith('<div class="b-grid">') && html.endsWith(`${note}</div>`), html);
  assert.equal(html.split('class="cards-note"').length, 2, html);
  assert.doesNotMatch(html, /\bB0\b|schema/);
});

test('cards show no Board note when nothing is hidden', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = snapshot.units.filter(unit => unit.status !== 'archived');
  assert.ok(!cardsHtml(context(snapshot)).includes('cards-note'));
});

test('a card shows state, clock, cost bar, report, progress, stage, monitor and chips', () => {
  const html = card(cardsHtml(context(exampleSnapshot())), 'ws-0003-b1');
  assert.match(html, /class="b-card st-busy" data-open="ws-0003-b1" tabindex="0" role="button" aria-label="Open details for B1 API"/);
  assert.match(text(html), /API Busy · 35m PR #418 Running 1d 20h 03m 00s Cost 24,016 cr · ≈\$240\.16/);
  assert.match(html, /<span class="meter"><i style="width:100%"><\/i><\/span>/);
  assert.match(html, /<div class="b-rep rp-complete"><span class="badge">complete<\/span><span class="b-rep-t" title="Opened PR #418/);
  assert.match(text(html), /Progress 70% Stage In review Monitor missing · no check for 42m code-review 6m/);
});

test('ended, stuck, report-less and task-list-less cards say so', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { report: null, progress: null });
  const html = cardsHtml(context(snapshot));
  const f2a = card(html, 'ws-0002-f2a');
  assert.match(text(f2a), /Ran 23h 50m 00s/);
  assert.doesNotMatch(f2a, /data-f="clock"/);
  assert.match(card(html, 'ws-0005-i1'), /class="chip st-stuck" data-key="tool" title="bash: dotnet test --filter E2E"/);
  const d5 = card(html, 'ws-0007-d5');
  assert.match(text(d5), /No report yet .*Progress No task list/);
  assert.doesNotMatch(d5, /class="bar"/);
});

test('selection, fresh reports and fresh chips are marked; names are escaped', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').name = '<script>alert(1)</script>';
  const html = cardsHtml(context(snapshot, { detail: 'ws-0003-b1', fresh: { feed: new Set(), reports: new Set(['ws-0003-b1']), chips: new Set(['call-b1-8']) } }));
  const b1 = card(html, 'ws-0003-b1');
  assert.match(b1, /class="b-card st-busy is-sel"/);
  assert.match(b1, /class="b-rep rp-complete is-new"/);
  assert.match(b1, /class="chip st-busy is-new"/);
  assert.match(b1, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('a swarm with no active units says so', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = [];
  assert.equal(cardsHtml(context(snapshot)), '<p class="none">No active child sessions.</p>');
});

test('with every unit archived, the Board note follows the empty line', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = snapshot.units.map(unit => ({ ...unit, status: 'archived' }));
  assert.equal(cardsHtml(context(snapshot)), '<p class="none">No active child sessions.</p><p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board">Board tab</button>.</p>');
});

const NESTED_AT = NOW + 600000;
/** The Sub-agents row, the Tool call line and the chip for B1's running code-review sub-agent, rendered at NESTED_AT. */
function nestedClocks(snapshot) {
  const b1 = findByLabel(snapshot, 'B1');
  const ctx = context(snapshot, { now: NESTED_AT });
  const detail = detailHtml(b1.id, false, ctx);
  const row = detail.split('<li class="sa"').find(part => part.includes('code-review'));
  const toolFrom = detail.indexOf('Tool call');
  const tool = detail.slice(toolFrom, detail.indexOf('<span class="k">', toolFrom));
  const chip = cardHtml(b1, ctx).split('<span class="chip ').find(part => part.includes('data-key="call-b1-8"'));
  return { row, tool, chip };
}

test('a crashed unit\'s unfinished sub-agent and tool call stop at its end', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  Object.assign(b1, { status: 'blocked', statusDetail: 'crashed', alive: false, endedAt: NOW - 59000 });
  b1.subagents.find(sub => sub.id === 'call-b1-8').startedAt = NOW - 60000;
  assert.equal(b1.activity.tool.startedAt, NOW - 60000);
  const { row, tool, chip } = nestedClocks(snapshot);
  assert.ok(row.includes(` · ${dur(1000)} · `), row);
  assert.doesNotMatch(row, /data-t/);
  assert.ok(tool.includes(` · ${dur(1000)}</span>`), tool);
  assert.doesNotMatch(tool, /data-t/);
  assert.equal(text(chip.slice(chip.indexOf('<span class="chip-t">'))), `code-review ${dur(1000)}`);
  assert.doesNotMatch(chip, /data-t/);
});

test('a finished run stops the nested clocks of units that have no end of their own', () => {
  const snapshot = exampleSnapshot();
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: NOW - 59000 });
  const b1 = findByLabel(snapshot, 'B1');
  assert.equal(b1.endedAt, null);
  b1.subagents.find(sub => sub.id === 'call-b1-8').startedAt = NOW - 60000;
  const { row, tool, chip } = nestedClocks(snapshot);
  assert.ok(row.includes(` · ${dur(1000)} · `), row);
  assert.ok(tool.includes(` · ${dur(1000)}</span>`), tool);
  assert.equal(text(chip.slice(chip.indexOf('<span class="chip-t">'))), `code-review ${dur(1000)}`);
  for (const html of [row, tool, chip]) assert.doesNotMatch(html, /data-t/);
});

test('a running unit\'s sub-agent and tool clocks keep ticking', () => {
  const { row, tool, chip } = nestedClocks(exampleSnapshot());
  for (const html of [row, tool, chip]) assert.match(html, /<span data-t="\d+" data-f="short">/);
});
