import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dur, esc } from '../ui/format.mjs';
import { cardHtml, cardsHtml, detailHtml, headerHtml, needsHtml } from '../ui/live.mjs';
import { CARD_FADE_MS, SUBAGENT_CARD_GRACE_MS, findByLabel } from '../ui/model.mjs';
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
  assert.match(html, /<div class="d-counts" role="group" aria-label="Child sessions and sub-agents by state">/);
  assert.match(html, /data-t="1791809280000" data-f="clock"/);
  const tiles = [...html.matchAll(/<div class="tile st-(\w+)"><span class="v">(\d+)<\/span><span class="k"><span class="dot"><\/span>(\w+)<\/span><\/div>/g)].map(match => match.slice(1));
  assert.deepEqual(tiles, [['busy', '2', 'working'], ['stuck', '2', 'stuck'], ['plan', '2', 'waiting'], ['idle', '1', 'idle'], ['merged', '3', 'done'], ['blocked', '2', 'failed']]);
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
  assert.deepEqual(cardIds(html), ['ws-0005-i1', 'call-root-40', 'ws-0004-b2', 'ws-0006-f1', 'ws-0003-b1', 'call-root-41', 'ws-0007-d5', 'ws-0002-f2a']);
  const note = '<p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board">Board tab</button>.</p>';
  assert.ok(html.startsWith('<div class="b-grid">') && html.endsWith(`${note}</div>`), html);
  assert.equal(html.split('class="cards-note"').length, 2, html);
  assert.doesNotMatch(html, /\bB0\b|schema|audit-schema-usage|migrate-fixtures|scan-docs-links/);
});

/** The example without its archived unit and its finished sub-agent units: the Cards tab leaves out no unit. */
function nothingHidden() {
  const snapshot = exampleSnapshot();
  snapshot.units = snapshot.units.filter(unit => unit.status !== 'archived' && !(unit.kind === 'subagent' && !['busy', 'stuck'].includes(unit.status)));
  return snapshot;
}

test('cards show no Board note when nothing is hidden', () => {
  assert.ok(!cardsHtml(context(nothingHidden())).includes('cards-note'));
});

test('cards point to the Board when the snapshot leaves out finished sub-agents, even with no other unit left out', () => {
  const snapshot = nothingHidden();
  snapshot.omittedSubagents = { done: 2, failed: 0 };
  const html = cardsHtml(context(snapshot));
  assert.equal(cardIds(html).length, snapshot.units.length);
  assert.ok(html.endsWith('<p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board">Board tab</button>.</p></div>'), html);
});

test('a sub-agent card shows its type and mode in place of stage and monitor', () => {
  const html = card(cardsHtml(context(exampleSnapshot())), 'call-root-41');
  assert.match(html, /class="b-card st-busy" data-open="call-root-41" tabindex="0" role="button" aria-label="Open details for map-import-module Map the import module"/);
  assert.match(html, /<div class="b-rows st-busy"><span class="k">Progress<\/span><span class="none-r">No task list<\/span><span class="k">Type<\/span><span class="none-r">Sub-agent · explore<\/span><span class="k">Mode<\/span><span class="none-r">Background<\/span><\/div>/);
  assert.doesNotMatch(text(html), /Stage|Monitor/);
  const sync = exampleSnapshot();
  Object.assign(findByLabel(sync, 'table-research').agent, { mode: 'sync', type: '<x>' });
  const research = card(cardsHtml(context(sync)), 'call-root-40');
  assert.match(text(research), /Type Sub-agent · &lt;x&gt; Mode Sync/);
  assert.match(research, /class="b-card st-stuck"/);
});

/** The example with one finished sub-agent unit that ended `ago` ms before NOW, and its card on the Cards tab. */
function finishedCard(label, ago) {
  const snapshot = exampleSnapshot();
  const unit = findByLabel(snapshot, label);
  Object.assign(unit, { endedAt: NOW - ago, since: NOW - ago });
  const html = cardsHtml(context(snapshot));
  return { unit, html, card: card(html, unit.id) };
}
const ringArc = html => html.match(/<circle class="arc[^"]*"[^>]*\/>/)[0];

test('a finished sub-agent keeps its card in its grace period, saying how and when it ended, with a still ring', () => {
  for (const [label, line] of [['audit-schema-usage', 'Done · 3m ago'], ['migrate-fixtures', 'Failed · 3m ago'], ['scan-docs-links', 'Cancelled · 3m ago']]) {
    const { unit, html, card: found } = finishedCard(label, 3 * 60000);
    assert.ok(cardIds(html).includes(unit.id), label);
    assert.equal(text(found.match(/<div class="b-state">(.*?)<\/div>/)[1]), line, label);
    assert.equal(ringArc(found), '<circle class="arc" cx="20" cy="20" r="17"/>', label);
    assert.doesNotMatch(found.slice(0, found.indexOf('>')), /is-leaving|data-phase|animation-delay/, label);
    assert.match(text(found), /Ran \d/, label);
  }
});

test('a finished sub-agent\'s card fades out in the last part of its grace period', () => {
  const left = 400;
  const { unit, card: found } = finishedCard('audit-schema-usage', SUBAGENT_CARD_GRACE_MS - left);
  const start = found.slice(0, found.indexOf('>'));
  assert.match(start, new RegExp(`^ class="b-card st-done is-leaving" data-open="${unit.id}" tabindex="0" role="button" aria-label="[^"]+" data-kind="subagent" data-phase style="animation-delay:-0\\.80s"$`));
  assert.equal(((CARD_FADE_MS - left) / 1000).toFixed(2), '0.80');
  const early = finishedCard('audit-schema-usage', SUBAGENT_CARD_GRACE_MS - CARD_FADE_MS - 1).card;
  assert.doesNotMatch(early.slice(0, early.indexOf('>')), /is-leaving/);
});

test('a finished sub-agent\'s card is gone after its grace period, and the Cards note points to the Board', () => {
  // Only this sub-agent can be left out, so the note shows because its card has gone.
  const snapshot = nothingHidden();
  const unit = findByLabel(exampleSnapshot(), 'audit-schema-usage');
  snapshot.units.push(unit);
  Object.assign(unit, { endedAt: NOW - SUBAGENT_CARD_GRACE_MS + 1000, since: NOW - SUBAGENT_CARD_GRACE_MS + 1000 });
  const before = cardsHtml(context(snapshot));
  assert.ok(cardIds(before).includes(unit.id) && !before.includes('cards-note'), before);
  Object.assign(unit, { endedAt: NOW - SUBAGENT_CARD_GRACE_MS, since: NOW - SUBAGENT_CARD_GRACE_MS });
  const html = cardsHtml(context(snapshot));
  assert.ok(!cardIds(html).includes(unit.id));
  assert.ok(html.endsWith('<p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board">Board tab</button>.</p></div>'), html);
});

test('a session card still shows its stage and monitor rows', () => {
  const html = card(cardsHtml(context(exampleSnapshot())), 'ws-0005-i1');
  assert.match(text(html), /Progress 56% Stage Coding Monitor/);
  assert.doesNotMatch(text(html), /Type|Mode|Sub-agent ·/);
});

test('the detail panel shows a sub-agent\'s type, mode and effort in place of its PR and monitor', () => {
  const snapshot = exampleSnapshot();
  const html = detailHtml('call-root-24', false, context(snapshot));
  const words = text(html);
  assert.match(html, /<section class="detail" aria-label="Details for scan-docs-links">/);
  assert.match(html, /<div class="dt-sec"><h4>Sub-agent<\/h4><div class="dt-kv"><span class="k">Type<\/span><span>orchestrator-worker<\/span><span class="k">Mode<\/span><span>Background<\/span><span class="k">Effort<\/span><span>medium<\/span><\/div><\/div>/);
  assert.doesNotMatch(html, /PR and monitor/);
  assert.match(html, /<div class="dt-why st-blocked"><h4>Why this counts as cancelled<\/h4><p>Cancelled after 12 min\.<\/p><\/div>/);
  assert.match(words, /Stage Sub-agent Model claude-sonnet-5/);
  assert.match(text(detailHtml('call-root-18', false, context(snapshot))), /Sub-agent Type task Mode Background Effort not set/);
  assert.match(text(detailHtml('ws-0005-i1', false, context(snapshot))), /PR and monitor/);
});

test('a card carries its unit\'s kind, so a child session and a one-off sub-agent can look different', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B2').kind = 'chat';
  const html = cardsHtml(context(snapshot));
  const start = id => card(html, id).slice(0, card(html, id).indexOf('>'));
  assert.match(start('ws-0003-b1'), / data-kind="project"/);
  assert.match(start('ws-0004-b2'), / data-kind="chat"/);
  assert.match(start('call-root-41'), / data-kind="subagent"/);
  for (const id of cardIds(html)) assert.equal(start(id).match(/ data-kind="([^"]*)"/)?.[1], snapshot.units.find(unit => unit.id === id).kind, id);
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

test('the detail panel\'s sub-agent list shows a cancelled sub-agent in blocked colours', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  b1.subagents.find(sub => sub.id === 'call-b1-7').status = 'cancelled';
  const row = detailHtml(b1.id, false, context(snapshot)).split('<li class="sa"').find(part => part.includes('<span>task (sync)</span>'));
  assert.match(row, /<span class="pill st-blocked">cancelled<\/span>/);
});

test('a sub-agent unit without agent details reads "unknown" in the detail panel, as on its card', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'map-import-module').agent = null;
  const html = detailHtml('call-root-41', false, context(snapshot));
  assert.match(html, /<h4>Sub-agent<\/h4><div class="dt-kv"><span class="k">Type<\/span><span>unknown<\/span><span class="k">Mode<\/span><span>Unknown<\/span><span class="k">Effort<\/span><span>not set<\/span><\/div>/);
  assert.match(text(card(cardsHtml(context(snapshot)), 'call-root-41')), /Type Sub-agent · unknown Mode Unknown/);
});
