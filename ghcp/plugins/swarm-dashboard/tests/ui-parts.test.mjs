import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dur } from '../ui/format.mjs';
import { findByLabel } from '../ui/model.mjs';
import { bar, chipsHtml, feedList, fill, meter, monitorHtml, phase, ring, shortLabel, stageTrack, stateLineHtml } from '../ui/parts.mjs';
import { NOW, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, '');

test('rings spin when busy, blink dashed when stuck and lose their arc when archived', () => {
  assert.match(ring('busy', 'B1', 1000), /class="arc spin"[^>]*stroke-dasharray="29\.9 106\.8"[^>]*animation-delay:-1\.00s/);
  assert.match(ring('stuck', 'I1'), /class="arc stuck"/);
  assert.doesNotMatch(ring('archived', 'B0'), /class="arc/);
  assert.match(ring('idle', '<x>'), /&lt;x&gt;/);
  assert.equal(phase(2.4, 3000), 'data-phase style="animation-delay:-0.60s"');
});

test('a stuck sub-agent shows once, not again as the open call that launched it', () => {
  const startedAt = NOW - 15 * 60000;
  const sub = { id: 'call-launch', name: 'map', type: 'explore', status: 'stuck', startedAt, task: 'Map the module' };
  const tool = { id: 'call-launch', name: 'task', summary: 'task: Map the module', startedAt, limitMs: null };
  const html = chipsHtml({ status: 'stuck', subagents: [sub], activity: { label: 'Waiting', tool, lastEventAt: NOW } }, NOW);
  assert.equal((html.match(/class="chip /g) ?? []).length, 1);
  assert.doesNotMatch(html, /data-key="tool"/);
});

test('chip times stop at the session\'s end once it has ended', () => {
  const sub = { id: 'call-sub', name: 'map', type: 'explore', status: 'stuck', startedAt: NOW - 15 * 60000, task: 'Map the module' };
  const tool = { id: 'call-tool', name: 'bash', summary: 'bash: npm test', startedAt: NOW - 5 * 60000, limitMs: null };
  const html = chipsHtml({ status: 'stuck', subagents: [sub], activity: { label: 'Waiting', tool, lastEventAt: NOW } }, NOW + 600000, new Set(), NOW);
  assert.equal(text(html), `explore ${dur(NOW - sub.startedAt)}${tool.summary} · ${dur(NOW - tool.startedAt)}`);
  assert.match(html, /data-key="call-sub"/);
  assert.match(html, /data-key="tool"/);
  assert.doesNotMatch(html, /data-t/);
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
  assert.equal(text(stateLineHtml(findByLabel(snapshot, 'I1'), NOW)), 'Stuck · no events 48m');
  assert.equal(text(stateLineHtml(findByLabel(snapshot, 'F2a'), NOW)), 'Merged · 1d 12h ago');
  assert.equal(fill('stuck {t}', NOW - 125000, NOW), `stuck <span data-t="${NOW - 125000}" data-f="short">2m</span>`);
  assert.equal(fill('<b> {a}', NOW, NOW), `&lt;b&gt; <span data-t="${NOW}" data-f="age">just now</span>`);
});

test('the stage track fills one segment per stage reached', () => {
  const html = stageTrack('in_review');
  assert.equal((html.match(/class="on"/g) ?? []).length, 3);
  assert.match(html, /aria-label="Stage: In review"/);
  assert.equal((stageTrack('archived').match(/class="on"/g) ?? []).length, 5);
  assert.equal(meter(40), '<span class="meter"><i style="width:40%"></i></span>');
  assert.equal(bar(70), '<span class="bar"><i style="width:70%"></i></span>');
});

test('monitor text covers alive, missing, ended and no PR', () => {
  const snapshot = exampleSnapshot();
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'D5'), NOW)), 'alive · last 9m ago · next in 1m');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'B1'), NOW)), 'missing · no check for 42m');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'F2a'), NOW)), 'ended, PR merged');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'F2a'), NOW, true)), 'ended when the PR merged');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW)), 'no PR yet');
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW, true)), 'starts when the PR opens');
  const paused = { ...findByLabel(snapshot, 'D5'), monitor: { state: 'paused', lastCheckAt: null, nextCheckAt: null, everyMinutes: 10, since: NOW - 300000 } };
  assert.equal(text(monitorHtml(paused, NOW)), 'paused · 5m');
});

test('chips show running sub-agents and the open call of a stuck session', () => {
  const snapshot = exampleSnapshot();
  const b1 = chipsHtml(findByLabel(snapshot, 'B1'), NOW, new Set(['call-b1-8']));
  assert.equal(text(b1), 'code-review 6m');
  assert.match(b1, /class="chip st-busy is-new" data-key="call-b1-8" title="Review PR #418"/);
  assert.equal(text(chipsHtml(findByLabel(snapshot, 'I1'), NOW)), 'bash: dotnet test --filter E2E · 48m');
  assert.match(chipsHtml(findByLabel(snapshot, 'I1'), NOW), /class="chip st-stuck"/);
  assert.equal(text(chipsHtml(findByLabel(snapshot, 'D5'), NOW)), 'No active sub-agents');
});

test('feed lists escape text, cap their length and mark new items', () => {
  const snapshot = exampleSnapshot();
  const html = feedList(snapshot.feed, 3, NOW, new Set([snapshot.feed[1].id]));
  assert.equal((html.match(/<li /g) ?? []).length, 3);
  assert.match(html, /<li class="fi" data-key="[^"]+"><span class="fi-t"><span data-t="\d+" data-f="age">4m ago<\/span><\/span><span><span class="fi-u">SB<\/span> started explore: map-import-module<\/span><\/li>/);
  assert.match(html, /<li class="fi is-new" data-key="[^"]+">/);
  assert.match(feedList([{ ...snapshot.feed[0], text: '<img onerror=x>' }], 1, NOW), /&lt;img onerror=x&gt;/);
  assert.equal(feedList([], 6, NOW, new Set(), 'No recent activity'), '<p class="none">No recent activity</p>');
});

test('a finished sub-agent whose name equals its type is named once in the feed', () => {
  const item = { id: 'x:subagent-done:call-1', at: NOW - 60000, unitId: 'x', label: 'SB', kind: 'subagent-done', text: 'explore explore finished' };
  assert.match(feedList([item], 1, NOW), /<span class="fi-u">SB<\/span> explore finished<\/span>/);
});
