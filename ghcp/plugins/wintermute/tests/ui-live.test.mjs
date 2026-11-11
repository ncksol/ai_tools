import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dur, esc } from '../ui/format.mjs';
import { cardHtml, cardsHtml, detailHtml, headerHtml } from '../ui/live.mjs';
import { findByLabel } from '../ui/model.mjs';
import { NOW, closedSnapshot, context, doneSnapshot, exampleSnapshot } from './helpers/ui.mjs';

const pad = value => String(value).padStart(2, '0');
const hm = ms => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const text = html => html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const card = (html, id) => html.split('<article').find(part => part.includes(`data-open="${id}"`))?.split('</article>')[0];
const cardIds = html => [...html.matchAll(/<article class="b-card[^"]*" data-open="([^"]+)"/g)].map(match => match[1]);
const miniIds = html => [...html.matchAll(/<div class="mc tone-\w+[^"]*" data-open="([^"]+)"/g)].map(match => match[1]);
/** A Finished mini card from its tone class to its end, and a card's or mini card's words after its opening tag. */
const mini = (html, id) => html.match(new RegExp(`<div class="mc ([^"]*)" data-open="${id}"[\\s\\S]*?<div class="mc-3"[^>]*>[^<]*</div></div>`))[0].slice('<div class="mc '.length);
const words = part => text(part.slice(part.indexOf('>') + 1));
const open = (snapshot, overrides = {}) => context(snapshot, { finishedOpen: true, ...overrides });
const now = html => text(html.match(/<div class="b-now[^"]*"[^>]*>.*?<\/div>/)[0]);
const NOTE = '<p class="cards-note">Archived and hidden sessions are on the <button type="button" class="link" data-tab="board" data-reveal="archived">Board tab</button>.</p>';

test('a unit whose PR closed without merging is a Finished mini card that says "closed, not merged"', () => {
  const html = cardsHtml(open(closedSnapshot()));
  assert.ok(!cardIds(html).includes('ws-0007-d5'));
  assert.match(words(mini(html, 'ws-0007-d5')), /^D5 docs closed, not merged 20m ago ≈\$31$/);
  assert.match(mini(html, 'ws-0007-d5'), /^tone-off/);
  assert.ok(cardIds(cardsHtml(context(exampleSnapshot()))).includes('ws-0007-d5'));
});

test('a closed one-off job with no PR says "closed", not "closed, not merged"', () => {
  const snapshot = closedSnapshot();
  const d5 = findByLabel(snapshot, 'D5');
  d5.pr = null;
  assert.match(words(mini(cardsHtml(open(snapshot)), d5.id)), /^D5 docs closed 20m ago/);
});

test('the header is the orchestrator\'s card: mark, run name, state, now line, running time, swarm cost and tiles that follow the grid', () => {
  const snapshot = exampleSnapshot();
  const html = headerHtml(context(snapshot));
  assert.match(text(html), /^Sample story B Orchestrator · sample-project Waiting on question · 25m Publish PR #421 for review\? Running 2d 23h 12m 00s Swarm cost ≈\$977 /);
  assert.match(html, /<div class="d-id"><span class="mark st-question"><svg width="44" height="44"/);
  assert.match(html, /<div class="o-who st-question">/);
  assert.match(html, /<span class="v l" title="97,652 cr · ≈\$976\.52">≈\$977<\/span>/);
  assert.match(html, /<div class="d-counts" role="group" aria-label="Units by state">/);
  assert.match(html, /data-t="1791809280000" data-f="clock"/);
  assert.doesNotMatch(html, /ring-l|"SB"/, 'no initials ring');
  const tiles = [...html.matchAll(/<div class="tile st-(\w+)"><span class="v">(\d+)<\/span><span class="k"><span class="dot"><\/span>([\w ]+)<\/span><\/div>/g)].map(match => match.slice(1));
  assert.deepEqual(tiles, [['busy', '2', 'working'], ['stuck', '2', 'stuck'], ['question', '2', 'waiting on you'], ['blocked', '1', 'blocked'], ['idle', '1', 'idle'], ['merged', '4', 'finished']]);
});

test('a stalled swarm is the header\'s state, in stuck colours, with its reason', () => {
  const snapshot = exampleSnapshot();
  snapshot.run.stalled = { since: NOW - 600000, reason: 'Swarm rule: the orchestrator and every open child are idle, and no monitor is due.' };
  const html = headerHtml(context(snapshot));
  assert.match(html, /<span class="mark st-stuck"><svg[^>]*><circle class="trk"[^>]*\/><circle class="arc stuck"/);
  assert.match(text(html), /Sample story B Orchestrator · sample-project Swarm stalled · 10m Swarm rule: the orchestrator and every open child are idle, and no monitor is due\. Running/);
  assert.match(text(html), / 3 waiting on you /);
});

test('an idle orchestrator says what it waits for, muted when nothing is running', () => {
  const snapshot = exampleSnapshot();
  Object.assign(snapshot.orchestrator, { status: 'idle', statusDetail: 'idle', since: NOW - 120000, activity: { label: 'Idle', tool: null, lastEventAt: NOW - 120000 } });
  const html = headerHtml(context(snapshot));
  assert.match(html, /<div class="o-now" title="Waiting for 2 sessions and 2 sub-agents to report; 1 unit waiting on you">/);
  assert.match(html, /<span class="mark st-idle">/);
  snapshot.units = [];
  assert.match(headerHtml(context(snapshot)), /<div class="o-now is-muted" title="Nothing is running\.">Nothing is running\.<\/div>/);
});

test('a finished run shows how long it ran, says the swarm finished, and has no ticking clock', () => {
  const snapshot = exampleSnapshot();
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: snapshot.run.startedAt + 3600000 });
  const html = headerHtml(context(snapshot));
  assert.match(text(html), /Swarm finished · 2d 22h ago Nothing left to run\. Ran 1h 00m 00s/);
  assert.match(html, /<span class="mark st-done">/);
  assert.doesNotMatch(html, /data-f="clock"/);
});

test('a quiet run stops the header clock at its last activity and says since when it has been quiet', () => {
  const snapshot = exampleSnapshot();
  const last = snapshot.run.startedAt + 3600000;
  Object.assign(snapshot.run, { lastActivityAt: last, quietSince: last });
  const html = headerHtml(context(snapshot));
  assert.match(text(html), new RegExp(`Running 1h 00m 00s · quiet since ${hm(last)} Swarm cost`));
  assert.match(html, /<span class="v l">1h 00m 00s<span class="v-note"> · quiet since \d\d:\d\d<\/span><\/span>/);
  assert.doesNotMatch(html, /data-f="clock"/);
  assert.doesNotMatch(text(html), /Ran /);
});

test('an active run\'s header clock ticks and does not say the run is quiet', () => {
  const html = headerHtml(context(exampleSnapshot()));
  assert.equal(exampleSnapshot().run.quietSince, null);
  assert.match(html, /<span class="v l"><span data-t="1791809280000" data-f="clock">/);
  assert.doesNotMatch(html, /quiet/);
});

/**
 * The example with nothing active since `last`: D5 is an idle child that has not ended, and lists a sub-agent that never
 * reported its end (its process is gone, so the engine does not count it as active).
 */
function quietRun() {
  const snapshot = exampleSnapshot();
  const last = NOW - 10 * 60000;
  Object.assign(snapshot.run, { lastActivityAt: last, quietSince: last });
  const d5 = findByLabel(snapshot, 'D5');
  d5.subagents.unshift({ id: 'call-d5-late', name: 'late-check', type: 'explore', model: null, effort: null, mode: 'background', status: 'running', startedAt: last - 5 * 60000, endedAt: null, durationMs: null, credits: 0, task: null });
  return { snapshot, d5, last };
}

test('while a quiet run has nothing active, an idle child\'s sub-agent chip and detail runtimes stay fixed at the run\'s last activity', () => {
  const { snapshot, d5, last } = quietRun();
  assert.equal(d5.endedAt, null);
  const html = card(cardsHtml(context(snapshot)), d5.id);
  assert.match(html, /<span class="chip-t">explore 5m<\/span>/);
  assert.doesNotMatch(html, /data-f="clock"/);
  const detail = detailHtml(d5.id, false, context(snapshot));
  assert.ok(detail.includes(`<span class="k">Running</span><span class="v">${dur(last - d5.startedAt)}</span>`), text(detail));
  assert.match(detail, /<div class="sa-2">model unknown · 5m · 0 cr/);
  assert.doesNotMatch(text(html) + text(detail), /\bRan\b/, 'a quiet run has not finished');
});

test('an idle child\'s sub-agent chip and detail runtimes tick again once the run is active', () => {
  const { snapshot, d5 } = quietRun();
  snapshot.run.quietSince = null;
  const html = card(cardsHtml(context(snapshot)), d5.id);
  assert.match(html, /<span class="chip-t">explore <span data-t="\d+" data-f="short">15m<\/span><\/span>/);
  const detail = detailHtml(d5.id, false, context(snapshot));
  assert.ok(detail.includes(`<span class="k">Running</span><span class="v"><span data-t="${d5.startedAt}" data-f="short">`), text(detail));
  assert.match(detail, /<div class="sa-2">model unknown · <span data-t="\d+" data-f="short">15m<\/span> ·/);
});

test('a now line names a report with a blank title "Untitled report"', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'F1').report.title = '  ';
  assert.equal(now(card(cardsHtml(context(snapshot)), 'ws-0006-f1')), 'Untitled report · 12m ago');
});

test('now lines show report and question text as plain text, without a repeated status', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'F1').report, { title: 'Status: needs input. Wired **all** routes', status: 'needs_input' });
  snapshot.needs[0].text = 'Keep the **v1** format?';
  const html = cardsHtml(context(snapshot));
  assert.equal(now(card(html, 'ws-0006-f1')), 'Wired all routes · 12m ago');
  assert.match(card(html, 'ws-0004-b2'), /<div class="b-now" title="Keep the v1 format\?">Keep the v1 format\?<\/div>/);
  assert.doesNotMatch(html, /\*\*/);
});

test('the active grid sorts by attention; finished units wait in a closed Finished row; archived ones point to the Board', () => {
  const html = cardsHtml(context(exampleSnapshot()));
  assert.deepEqual(cardIds(html), ['ws-0005-i1', 'call-root-40', 'ws-0004-b2', 'ws-0006-f1', 'ws-0003-b1', 'call-root-41', 'ws-0007-d5']);
  assert.ok(html.startsWith('<div class="b-zone"><div class="b-grid">'), html);
  assert.match(html, /<section class="b-fin" aria-label="Finished"><button type="button" class="b-fin-h" data-finished aria-expanded="false"><svg class="b-caret"[^>]*>.*?<\/svg><span class="b-fin-t">Finished<\/span><span class="b-fin-n">4<\/span><span class="b-fin-s">stopped, merged, done and failed · latest first<\/span><\/button><\/section>/);
  assert.deepEqual(miniIds(html), [], 'closed by default');
  assert.ok(html.endsWith(`${NOTE}</div>`), html);
  assert.equal(html.split('class="cards-note"').length, 2, html);
  assert.doesNotMatch(html, /\bB0\b/);
});

test('the open Finished section lists mini cards, latest finish first, with an outcome dot, outcome and age, and dollars', () => {
  const html = cardsHtml(open(exampleSnapshot()));
  assert.match(html, /aria-expanded="true"/);
  assert.deepEqual(miniIds(html), ['ws-0002-f2a', 'call-root-24', 'call-root-18', 'call-root-12']);
  const looks = id => [mini(html, id).match(/^tone-(\w+)/)[1], words(mini(html, id))];
  assert.deepEqual(looks('ws-0002-f2a'), ['ok', 'F2a tests, part 1 merged 1d 12h ago ≈$43']);
  assert.deepEqual(looks('call-root-24'), ['off', 'scan-docs-links Scan the docs for broken links cancelled 2d 13h ago ≈$0.17']);
  assert.deepEqual(looks('call-root-18'), ['bad', 'migrate-fixtures Migrate the test fixtures failed 2d 14h ago ≈$0.38']);
  assert.deepEqual(looks('call-root-12'), ['ok', 'audit-schema-usage Audit where the schema is used done 2d 22h ago ≈$1.40']);
  assert.match(mini(html, 'ws-0002-f2a'), /data-open="ws-0002-f2a" tabindex="0" role="button" aria-label="Open details for F2a tests, part 1" data-kind="project">/);
  assert.match(mini(html, 'ws-0002-f2a'), /<div class="mc-3" title="4,312 cr · ≈\$43\.12">≈\$43<\/div>/);
  assert.doesNotMatch(html.slice(html.indexOf('b-fin-list')), /class="mc st-/, 'no status tint');
});

/** The example without its archived unit and its finished sub-agent units: the Cards tab leaves out no unit. */
function nothingHidden() {
  const snapshot = exampleSnapshot();
  snapshot.units = snapshot.units.filter(unit => unit.status !== 'archived' && !(unit.kind === 'subagent' && !['busy', 'stuck'].includes(unit.status)));
  return snapshot;
}

test('the Cards tab shows no Board note when nothing is hidden', () => {
  assert.ok(!cardsHtml(context(nothingHidden())).includes('cards-note'));
});

test('the Cards tab points to the Board when the snapshot leaves out finished sub-agents, even with no other unit left out', () => {
  const snapshot = nothingHidden();
  snapshot.omittedSubagents = { done: 2, failed: 0 };
  assert.ok(cardsHtml(context(snapshot)).endsWith(`${NOTE}</div>`));
});

test('a sub-agent card shows its type as a tag beside its state, and no stage, monitor, type or mode rows', () => {
  const html = card(cardsHtml(context(exampleSnapshot())), 'call-root-41');
  assert.match(html, /^ class="b-card st-busy" data-open="call-root-41" tabindex="0" role="button" aria-label="Open details for map-import-module Map the import module" data-kind="subagent">/);
  assert.match(html, /<div class="b-l2"><span class="b-st">Busy · <span data-t="\d+" data-f="short">4m<\/span><\/span><span class="b-tag" title="Orchestrator sub-agent · explore · background">explore<\/span><\/div>/);
  assert.match(html, /<span class="b-model" title="Model gpt-5\.4-mini, reasoning effort low">GPT-5\.4 Mini · low<\/span>/);
  assert.doesNotMatch(text(html), /Stage|Monitor|Type|Mode|No task list|No active sub-agents|Running \d/);
  const research = card(cardsHtml(context(exampleSnapshot())), 'call-root-40');
  assert.match(research, /<span class="b-st">Stuck · silent <span[^>]*>15m<\/span><\/span><span class="b-tag" title="Orchestrator sub-agent · research · background">research<\/span>/);
});

test('a finished sub-agent leaves the grid at once for the Finished section', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'map-import-module'), { status: 'done', statusDetail: 'completed', endedAt: NOW - 1000, since: NOW - 1000 });
  const html = cardsHtml(open(snapshot));
  assert.ok(!cardIds(html).includes('call-root-41'));
  assert.equal(miniIds(html)[0], 'call-root-41');
  assert.match(words(mini(html, 'call-root-41')), /^map-import-module Map the import module done just now ≈\$0\.51$/);
});

test('a card carries its unit\'s kind, and every card has the same three rows', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B2').kind = 'chat';
  const html = cardsHtml(context(snapshot));
  const start = id => card(html, id).slice(0, card(html, id).indexOf('>'));
  for (const id of cardIds(html)) {
    assert.equal(start(id).match(/ data-kind="([^"]*)"/)?.[1], snapshot.units.find(unit => unit.id === id).kind, id);
    assert.match(card(html, id), /^[^>]*><div class="b-head">.*<\/div><div class="b-now[^"]*"[^>]*>.*<\/div><div class="b-foot">.*<\/div>$/, id);
  }
});

test('a card shows its mark, label and name, state and PR, now line, sub-agent chips, todos, model and effort, and cost', () => {
  const cards = cardsHtml(context(exampleSnapshot()));
  const html = card(cards, 'ws-0003-b1');
  assert.match(html, /^ class="b-card st-busy" data-open="ws-0003-b1" tabindex="0" role="button" aria-label="Open details for B1 API" data-kind="project">/);
  assert.match(html, /<div class="b-head"><span class="mark st-busy"><svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk"[^>]*\/><circle class="arc spin"[^>]*data-phase[^>]*\/><g class="g"><g class="g-dots">/);
  assert.match(html, /<div class="b-l1"><span class="b-lab" title="B1 API">B1<\/span><span class="b-name" title="B1 API">API<\/span><\/div>/);
  assert.match(words(html), /^B1 API Busy · 35m PR #418 · in review Running edit: src\/api\/orders\.ts code-review 6m 1 7\/10 Sonnet 5 · xhigh ≈\$240$/);
  assert.match(html, /<span class="b-prog" title="7 of 10 todos done"><span class="bar"><i style="width:70%"><\/i><\/span>7\/10<\/span>/);
  assert.match(html, /<span class="b-cost" title="24,016 cr · ≈\$240\.16">≈\$240<\/span>/);
  assert.match(html, /<span class="b-model" title="Model claude-sonnet-5, reasoning effort xhigh">Sonnet 5 · xhigh<\/span>/);
  assert.doesNotMatch(html, /class="badge|class="stage|class="meter|class="mon|b-rep/);
  assert.match(text(card(cards, 'ws-0007-d5')), /Haiku 5\.5 ≈\$31$/, 'no effort: the model alone');
});

test('a card shows cents under $10 and whole dollars from $10, with credits in the tooltip', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  const cost = credits => {
    b1.cost.credits = credits;
    return cardHtml(b1, context(snapshot)).match(/<span class="b-cost" title="([^"]*)">([^<]*)<\/span>/).slice(1);
  };
  assert.deepEqual(cost(860), ['860 cr · ≈$8.60', '≈$8.60']);
  assert.deepEqual(cost(999.4), ['999 cr · ≈$9.99', '≈$9.99']);
  assert.deepEqual(cost(999.6), ['1,000 cr · ≈$10.00', '≈$10']);
  assert.deepEqual(cost(4210.4), ['4,210 cr · ≈$42.10', '≈$42']);
  assert.deepEqual(cost(0), ['0 cr · ≈$0.00', '≈$0.00']);
});

test('a card with no known model shows only its cost', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  b1.model = null;
  const html = cardHtml(b1, context(snapshot));
  assert.doesNotMatch(html, /b-model/);
  assert.match(html, /<div class="b-right"><span class="b-cost"/);
});

test('a stuck card names the cause and the tool call in its now line, with no red tool chip; a card with nothing to say says so, muted', () => {
  const snapshot = exampleSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { report: null, progress: null });
  const html = cardsHtml(context(snapshot));
  const i1 = card(html, 'ws-0005-i1');
  assert.match(words(i1), /^I1 integration Stuck · tool call 48m Running bash: dotnet test --filter E2E 5\/9 Sonnet 5 · medium ≈\$97$/);
  assert.doesNotMatch(i1, /data-key="tool"|class="chip/);
  const d5 = card(html, 'ws-0007-d5');
  assert.match(d5, /<div class="b-now is-muted" title="No report yet">No report yet<\/div>/);
  assert.doesNotMatch(d5, /b-prog/);
});

test('a Needs you item that names a unit marks its footer, with a short label for the fold and the request as its tooltip', () => {
  const html = card(cardsHtml(context(exampleSnapshot())), 'ws-0007-d5');
  assert.match(html, /<div class="b-foot"><span class="b-need" title="Publish PR #421 for review\?"><span class="b-need-l">PR to approve<\/span><span class="b-need-s" hidden>Approve<\/span><\/span><div class="b-left">/);
  assert.doesNotMatch(card(cardsHtml(context(exampleSnapshot())), 'ws-0004-b2'), /b-need/, 'B2 asked its own plan: its now line shows it');
});

test('sub-agent chips come stuck first, with the "+N" and count chips the fold uses, hidden until it does', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  const running = b1.subagents.find(sub => sub.status === 'running');
  b1.subagents.push({ ...running, id: 'call-b1-stuck', type: 'research', status: 'stuck', task: 'Find <past> incidents' });
  const html = cardHtml(b1, context(snapshot));
  const left = html.match(/<div class="b-left">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...left.matchAll(/<span class="chip st-(\w+)" data-key="([^"]+)"/g)].map(match => match.slice(1)), [['stuck', 'call-b1-stuck'], ['busy', 'call-b1-8']]);
  assert.match(left, /<span class="b-more" hidden><\/span><span class="chip b-count st-stuck" hidden title="research: Find &lt;past&gt; incidents\ncode-review: Review PR #418"><span class="dot"><\/span><span class="chip-t">2<\/span><\/span><span class="b-prog"/);
  b1.subagents = [];
  assert.match(cardHtml(b1, context(snapshot)), /<div class="b-left"><span class="b-prog"/, 'no chips: no fold elements');
});

test('a card with incomplete data shows the warning mark with what failed as its tooltip, and nothing else changes', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  const plain = cardHtml(b1, context(snapshot));
  assert.doesNotMatch(plain, /b-warn/);
  b1.dataWarning = 'Its log could not be read at 14:00. Cost & state may be out of date.';
  const html = cardHtml(b1, context(snapshot));
  assert.match(html, /<span class="b-name" title="B1 API">API<\/span><span class="b-warn" role="img" aria-label="Some data could not be read" title="Its log could not be read at 14:00\. Cost &amp; state may be out of date\."><svg width="16" height="16"/);
  assert.equal(html.replace(/<span class="b-warn".*?<\/svg><\/span>/, ''), plain);
});

test('selection, fresh reports and fresh chips are marked; names are escaped', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').name = '<script>alert(1)</script>';
  const html = cardsHtml(context(snapshot, { detail: 'ws-0003-b1', fresh: { feed: new Set(), reports: new Set(['ws-0006-f1', 'ws-0003-b1']), chips: new Set(['call-b1-8']) } }));
  const b1 = card(html, 'ws-0003-b1');
  assert.match(b1, /class="b-card st-busy is-sel"/);
  assert.match(b1, /class="chip st-busy is-new"/);
  assert.match(b1, /<div class="b-now" title=/, 'its now line is not a report, so it does not flash');
  assert.match(card(html, 'ws-0006-f1'), /<div class="b-now is-new" title=/);
  assert.match(b1, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(cardsHtml(open(snapshot, { detail: 'ws-0002-f2a' })), /<div class="mc tone-ok is-sel" data-open="ws-0002-f2a"/);
});

test('a swarm with no active units says nothing is running', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = [];
  assert.equal(cardsHtml(context(snapshot)), '<div class="b-zone"><p class="none">Nothing is running.</p></div>');
});

test('with every unit archived, the Board note follows the empty line', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = snapshot.units.map(unit => ({ ...unit, status: 'archived' }));
  assert.equal(cardsHtml(context(snapshot)), `<div class="b-zone"><p class="none">Nothing is running.</p>${NOTE}</div>`);
});

test('a disconnected page marks the cards and the header as stale', () => {
  const html = cardsHtml(context(exampleSnapshot(), { stale: true }));
  assert.ok(html.startsWith('<div class="b-zone is-stale">'));
  assert.ok(headerHtml(context(exampleSnapshot(), { stale: true })).startsWith('<div class="d-head is-stale">'));
  assert.ok(headerHtml(context(exampleSnapshot())).startsWith('<div class="d-head">'));
});

test('the detail panel shows a sub-agent\'s type and mode, with no Effort row, in place of its PR and monitor', () => {
  const snapshot = exampleSnapshot();
  const html = detailHtml('call-root-24', false, context(snapshot));
  const words = text(html);
  assert.match(html, /<section class="detail" aria-label="Details for scan-docs-links">/);
  assert.match(html, /<div class="dt-sec"><h4>Sub-agent<\/h4><div class="dt-kv"><span class="k">Type<\/span><span>orchestrator-worker<\/span><span class="k">Mode<\/span><span>Background<\/span><\/div><\/div>/);
  assert.doesNotMatch(html, /PR and monitor/);
  assert.match(html, /<div class="dt-why st-blocked"><h4>Why this counts as cancelled<\/h4><p>Cancelled after 12 min\.<\/p><\/div>/);
  assert.match(words, /Stage Sub-agent Model claude-sonnet-5/);
  const unset = text(detailHtml('call-root-18', false, context(snapshot)));
  assert.match(unset, /Sub-agent Type task Mode Background Recent activity/);
  for (const words of [text(html), unset]) assert.doesNotMatch(words, /Effort|not set/);
  assert.match(text(detailHtml('ws-0005-i1', false, context(snapshot))), /PR and monitor/);
});

/** The Model fact of a unit's detail panel, from its key to the end of its value. */
const modelFact = html => html.match(/<span class="k">Model<\/span><span class="v">.*?<\/span><\/div>/)[0];

test('the Model fact shows the effort after the model, muted, and the model only when the effort is null', () => {
  const snapshot = exampleSnapshot();
  const i1 = findByLabel(snapshot, 'I1');
  Object.assign(i1, { model: 'claude-x', effort: 'high' });
  assert.equal(modelFact(detailHtml(i1.id, false, context(snapshot))), '<span class="k">Model</span><span class="v">claude-x<span class="v-note"> · high</span></span></div>');
  i1.effort = null;
  const fact = modelFact(detailHtml(i1.id, false, context(snapshot)));
  assert.equal(fact, '<span class="k">Model</span><span class="v">claude-x</span></div>');
  assert.doesNotMatch(fact, /v-note|unknown|not set/);
  i1.model = null;
  assert.equal(modelFact(detailHtml(i1.id, false, context(snapshot))), '<span class="k">Model</span><span class="v">unknown</span></div>', 'a null model keeps today\'s text');
});

test('a sub-agent unit\'s Model fact shows the effort it ran with', () => {
  const snapshot = exampleSnapshot();
  assert.equal(modelFact(detailHtml('call-root-24', false, context(snapshot))), '<span class="k">Model</span><span class="v">claude-sonnet-5<span class="v-note"> · medium</span></span></div>');
  assert.equal(modelFact(detailHtml('call-root-18', false, context(snapshot))), '<span class="k">Model</span><span class="v">claude-haiku-5.5</span></div>');
});

test('the detail panel\'s sub-agent list reads model · effort · runtime · cost, and model · runtime · cost with no effort', () => {
  const snapshot = exampleSnapshot();
  const b1 = findByLabel(snapshot, 'B1');
  const html = detailHtml(b1.id, false, context(snapshot));
  const second = title => text(html.split('<li class="sa"').find(part => part.includes(`title="${title}"`)).match(/<div class="sa-2">.*?<\/div>/)[0]).split(' · ');
  const [withEffort, without] = [second('Review PR #418'), second('Run the API test suite')];
  assert.deepEqual(withEffort.slice(0, 2), ['claude-sonnet-5', 'high']);
  assert.equal(withEffort.length, 5, withEffort.join(' · '));
  assert.match(withEffort[2], /^\d+m$/);
  assert.match(withEffort[3], /^[\d,.]+ cr$/);
  assert.equal(without[0], 'claude-haiku-5.5');
  assert.equal(without.length, 4, without.join(' · '));
  assert.match(without[1], /^\d+m$/);
  assert.match(without[2], /^[\d,.]+ cr$/);
  assert.doesNotMatch(html.match(/<ul class="sa-list">.*?<\/ul>/)[0], /unknown|not set/);
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
  assert.match(html, /<h4>Sub-agent<\/h4><div class="dt-kv"><span class="k">Type<\/span><span>unknown<\/span><span class="k">Mode<\/span><span>Unknown<\/span><\/div>/);
  assert.doesNotMatch(html, /Effort|not set/);
  assert.match(card(cardsHtml(context(snapshot)), 'call-root-41'), /<span class="b-tag" title="Orchestrator sub-agent · sub-agent · mode unknown">sub-agent<\/span>/);
});

test('a finished reviewer, stopped or not, is a Finished mini card that says "done"', () => {
  const snapshot = doneSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { statusDetail: 'stopped', alive: false });
  const html = cardsHtml(open(snapshot));
  assert.match(words(mini(html, 'ws-0007-d5')), /^D5 docs done 20m ago ≈\$31$/);
  assert.match(mini(html, 'ws-0007-d5'), /^tone-ok/);
});

test('an active reviewer\'s card shows the PR it reviews where its own PR would be', () => {
  const snapshot = doneSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { outcome: null, endedAt: null, status: 'busy', statusDetail: 'busy' });
  // The fixture's "Publish PR #421 for review?" names D5, which has no PR of its own here.
  snapshot.needs = snapshot.needs.filter(need => !need.unitIds.includes('ws-0007-d5'));
  const html = card(cardsHtml(context(snapshot)), 'ws-0007-d5');
  assert.match(html, /<span class="b-pr">reviews PR #418<\/span>/);
  assert.doesNotMatch(html, /PR #421/);
});
