import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findByLabel } from '../ui/model.mjs';
import { bar, feedList, fill, monitorHtml, phase, ring, shortLabel, stateLineHtml, statusMark, warnMark } from '../ui/parts.mjs';
import { NOW, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, '');

test('rings spin when busy, blink dashed when stuck and lose their arc when archived', () => {
  assert.match(ring('busy', 'B1', 1000), /class="arc spin"[^>]*stroke-dasharray="29\.9 106\.8"[^>]*animation-delay:-1\.00s/);
  assert.match(ring('stuck', 'I1'), /class="arc stuck"/);
  assert.doesNotMatch(ring('archived', 'B0'), /class="arc/);
  assert.match(ring('idle', '<x>'), /&lt;x&gt;/);
  assert.equal(phase(2.4, 3000), 'data-phase style="animation-delay:-0.60s"');
  assert.equal(phase(1.4, 0, 0.4), 'data-phase style="animation-delay:-1.00s"', 'an offset runs behind, as a delay within one period');
});

test('ring labels show up to four characters; a four-character label may still be cut, longer ones are', () => {
  assert.match(ring('idle', 'B1'), /<span class="ring-l">B1<\/span>/);
  assert.match(ring('idle', 'C6-1'), /title="C6-1".*<span class="ring-l" data-fit>C6-1<\/span>/);
  assert.match(ring('idle', 'LONGLABEL'), /title="LONGLABEL".*<span class="ring-l">LON<\/span>/);
  assert.match(ring('idle', 'B2-x1'), /<span class="ring-l">B2<\/span>/);
  assert.equal(shortLabel('C6-1'), 'C6');
  assert.equal(shortLabel('F2a'), 'F2a');
  assert.equal(shortLabel('A_._b'), 'A');
});

test('state lines and word templates insert live times', () => {
  const snapshot = exampleSnapshot();
  assert.equal(text(stateLineHtml(findByLabel(snapshot, 'I1'), NOW)), 'Stuck · no events 48m', 'the detail panel keeps its words');
  assert.equal(text(stateLineHtml(findByLabel(snapshot, 'F2a'), NOW)), 'Merged · 1d 12h ago');
  assert.equal(fill('stuck {t}', NOW - 125000, NOW), `stuck <span data-t="${NOW - 125000}" data-f="short">2m</span>`);
  assert.equal(fill('<b> {a}', NOW, NOW), `&lt;b&gt; <span data-t="${NOW}" data-f="age">just now</span>`);
});

test('a progress bar fills to its share', () => {
  assert.equal(bar(70), '<span class="bar"><i style="width:70%"></i></span>');
});

test('status marks keep the ring\'s motion and show an icon for the state', () => {
  const glyph = (status, detail) => statusMark(status, detail).match(/<g class="g">(.*)<\/g><\/svg>/)[1];
  assert.match(statusMark('busy', 'busy', 1000), /^<span class="mark st-busy"><svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true"><circle class="trk" cx="20" cy="20" r="17"\/><circle class="arc spin"[^>]*stroke-dasharray="29\.9 106\.8"[^>]*animation-delay:-1\.00s/);
  assert.match(statusMark('stuck', 'silent'), /<circle class="arc stuck"/);
  assert.match(statusMark('idle', 'idle', 0, 44), /<svg width="44" height="44"[^>]*><circle class="trk"[^>]*\/><circle class="arc" cx="20" cy="20" r="17"\/>/);
  assert.doesNotMatch(statusMark('archived', 'archived'), /class="arc/);
  assert.match(glyph('busy', 'busy'), /^<g class="g-dots">(<circle [^>]*data-phase[^>]*\/>){3}<\/g>$/);
  const dots = [...statusMark('busy', 'busy', 1000).matchAll(/<circle cx="\d+" cy="20" r="2\.2" data-phase style="animation-delay:(-[\d.]+)s"\/>/g)].map(match => match[1]);
  assert.deepEqual(dots, ['-1.00', '-0.80', '-0.60'], 'each dot runs 0.2 s behind the one before, in phase across renders');
  const icons = [['stuck', 'silent'], ['question', 'waiting_question'], ['plan', 'waiting_plan'], ['blocked', 'blocked'], ['blocked', 'failed'], ['blocked', 'crashed'], ['idle', 'idle'], ['merged', 'merged'], ['done', 'completed']].map(([status, detail]) => glyph(status, detail));
  assert.equal(icons[4], icons[5], 'failed and crashed share the cross');
  assert.equal(icons[7], icons[8], 'merged and done share the tick');
  assert.equal(new Set(icons).size, 7);
  assert.notEqual(icons[3], icons[4], 'blocked has pause bars, failed a cross');
});

test('the warning mark is a solid triangle with a knocked-out "!", and its tooltip says what could not be read', () => {
  const html = warnMark('Its log could not be read at 14:00. <Cost> may be out of date.');
  assert.match(html, /^<span class="b-warn" role="img" aria-label="Some data could not be read" title="Its log could not be read at 14:00\. &lt;Cost&gt; may be out of date\."><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 1\.5 /);
});

test('monitor text covers alive, missing, ended and no PR', () => {
  const snapshot = exampleSnapshot();
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'D5'), NOW)), 'alive · last 9m ago · next in 1m');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'B1'), NOW)), 'missing · no check for 42m');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'F2a'), NOW)), 'ended, PR merged');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'F2a'), NOW, true)), 'ended when the PR merged');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW)), 'no PR yet');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW, true)), 'no PR yet');
  const unwatched = { ...findByLabel(snapshot, 'D5'), monitor: { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null } };
  assert.equal(text(monitorHtml(unwatched, NOW)), 'no monitor');
  assert.equal(text(monitorHtml(unwatched, NOW, true)), 'no monitor');
  const paused = { ...findByLabel(snapshot, 'D5'), monitor: { state: 'paused', lastCheckAt: null, nextCheckAt: null, everyMinutes: 10, since: NOW - 300000 } };
  assert.equal(text(monitorHtml(paused, NOW)), 'paused · 5m');
});

test('feed lists escape text, cap their length and mark new items', () => {
  const snapshot = exampleSnapshot();
  const html = feedList(snapshot.feed, 3, NOW, new Set([snapshot.feed[1].id]));
  assert.equal((html.match(/<li /g) ?? []).length, 3);
  assert.match(html, /<li class="fi" data-key="[^"]+"><span class="fi-t"><span data-t="\d+" data-f="age">4m ago<\/span><\/span><span><span class="fi-u">map-import-module<\/span> started explore<\/span><\/li>/);
  assert.match(html, /<li class="fi is-new" data-key="[^"]+">/);
  assert.match(feedList([{ ...snapshot.feed[0], text: '<img onerror=x>' }], 1, NOW), /&lt;img onerror=x&gt;/);
  assert.equal(feedList([], 6, NOW, new Set(), 'No recent activity'), '<p class="none">No recent activity</p>');
});

test('a finished sub-agent whose name equals its type is named once in the feed', () => {
  const item = { id: 'x:subagent-done:call-1', at: NOW - 60000, unitId: 'x', label: 'SB', kind: 'subagent-done', text: 'explore explore finished' };
  assert.match(feedList([item], 1, NOW), /<span class="fi-u">SB<\/span> explore finished<\/span>/);
});
