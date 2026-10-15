import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, MIN } from '../ui/format.mjs';
import { findByLabel } from '../ui/model.mjs';
import { axisSvg, costSvg, laneSvg, markSvg, timelineHtml, timelineWindow } from '../ui/timeline.mjs';
import { NOW, context, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<title>[^<]*<\/title>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const row = (html, id) => html.split('<div class="c-row').find(part => part.includes(`data-id="${id}"`));

test('the window covers 3 hours, 12 hours or the whole run', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(timelineWindow(snapshot, '3h', NOW), { t0: NOW - 3 * HOUR, t1: NOW });
  assert.deepEqual(timelineWindow(snapshot, '12h', NOW), { t0: NOW - 12 * HOUR, t1: NOW });
  assert.deepEqual(timelineWindow(snapshot, 'run', NOW), { t0: snapshot.run.startedAt - 20 * MIN, t1: NOW });
});

test('one row per session, orchestrator first, with the window buttons, key and cost row', () => {
  const snapshot = exampleSnapshot();
  const html = timelineHtml(context(snapshot), '12h');
  assert.deepEqual([...html.matchAll(/class="c-row st-\w+" data-id="([^"]+)"/g)].map(match => match[1]), [snapshot.orchestrator.id, ...snapshot.units.map(unit => unit.id)]);
  assert.match(html, /<button type="button" data-span="12h" aria-pressed="true">last 12h<\/button>/);
  assert.match(html, /<button type="button" data-span="run" aria-pressed="false">whole run<\/button>/);
  assert.equal((html.match(/<pattern id="cHatch2"/g) ?? []).length, 1);
  assert.match(text(html), /report question plan sent plan approved PR monitor check/);
  assert.match(text(html), /Swarm cost all sessions 97,652 cr · ≈\$977$/);
});

test('rows name the session, its running time or run length, cost and latest report with state', () => {
  const snapshot = exampleSnapshot();
  const html = timelineHtml(context(snapshot), '12h');
  assert.match(text(row(html, snapshot.orchestrator.id)), /Sample story B 2d 23h · 31,532 cr · ≈\$315\.32 Waiting for an answer orchestrator/);
  assert.match(text(row(html, 'ws-0002-f2a')), /F2a tests, part 1 ran 23h 50m · 4,312 cr/);
  assert.match(text(row(html, 'ws-0004-b2')), /The parser is done\. The plan for step 2 is waiting for approval\. 41m ago · waiting on plan 38m/);
  assert.match(text(row(html, 'ws-0007-d5')), /5h ago · idle 9m/);
  assert.match(row(html, 'ws-0005-i1'), /<span class="dot stuck"><\/span>/);
  findByLabel(snapshot, 'B1').report = null;
  assert.match(text(row(timelineHtml(context(snapshot), '12h'), 'ws-0003-b1')), /No report yet/);
});

test('a blank report title reads "Untitled report", and a finished run stops the orchestrator\'s clock', () => {
  const snapshot = exampleSnapshot();
  findByLabel(snapshot, 'B1').report.title = '  ';
  assert.match(text(row(timelineHtml(context(snapshot), '12h'), 'ws-0003-b1')), /Untitled report/);
  Object.assign(snapshot.run, { lifecycle: 'finished', finishedAt: snapshot.run.startedAt + 2 * HOUR });
  assert.match(text(row(timelineHtml(context(snapshot), '12h'), snapshot.orchestrator.id)), /Sample story B ran 2h 00m ·/);
});

test('a lane draws busy spans, idle lines, a blinking live stuck span and the tool mark', () => {
  const i1 = findByLabel(exampleSnapshot(), 'I1');
  const svg = laneSvg(i1, 600, NOW - 12 * HOUR, NOW, NOW, 0);
  assert.match(svg, /<rect class="t-busy"/);
  assert.match(svg, /<line class="t-idle"/);
  assert.match(svg, /<rect class="t-stuck live"[^>]*style="animation-delay:-0\.00s"/);
  assert.match(svg, /<title>Tool call started, no events since<\/title>/);
  assert.match(svg, /<line class="t-now" x1="592"/);
});

test('a busy lane has a live edge, running sub-agents, monitor ticks and thinned marks', () => {
  const b1 = findByLabel(exampleSnapshot(), 'B1');
  const svg = laneSvg(b1, 600, NOW - 3 * HOUR, NOW, NOW, 0);
  assert.match(svg, /<rect class="t-edge"/);
  assert.match(svg, /<rect class="t-sub live"/);
  assert.match(svg, /<line class="t-mon"/);
  assert.match(svg, /<title>PR opened<\/title>/);
  assert.doesNotMatch(svg, /<title>Opened PR #418 with 14 endpoints\.<\/title>/, 'a lower-priority mark within 12 px is dropped');
});

test('sub-agent bars use at most three tracks', () => {
  const b1 = findByLabel(exampleSnapshot(), 'B1');
  b1.timeline.subagents = Array.from({ length: 5 }, (_, index) => ({ id: `x${index}`, start: NOW - HOUR, end: null, type: 'task' }));
  const svg = laneSvg(b1, 600, NOW - 3 * HOUR, NOW, NOW, 0);
  assert.equal((svg.match(/class="t-sub/g) ?? []).length, 3);
  assert.match(svg, /^<svg width="600" height="48"/);
});

test('marks follow the mockup shapes and colour reports by status', () => {
  assert.match(markSvg({ kind: 'report', status: 'progress', text: 'x' }, 10, 10), /fill="var\(--busy-ink\)"/);
  assert.match(markSvg({ kind: 'report', status: 'blocked', text: 'x' }, 10, 10), /fill="var\(--blocked-ink\)"/);
  assert.match(markSvg({ kind: 'report', status: 'complete', text: 'x' }, 10, 10), /fill="var\(--merged-ink\)"/);
  assert.match(markSvg({ kind: 'question', status: null, text: '<q>' }, 10, 10), /^<path d="M10 5L15 10L10 15L5 10Z" fill="var\(--question-ink\)".*<title>&lt;q&gt;<\/title>/);
  assert.equal(markSvg({ kind: 'unknown', status: null, text: '' }, 0, 0), '');
});

test('drawing the timeline never changes the snapshot', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  assert.doesNotThrow(() => {
    for (const span of ['3h', '12h', 'run']) {
      const { t0, t1 } = timelineWindow(snapshot, span, NOW);
      timelineHtml(context(snapshot), span);
      axisSvg(600, t0, t1);
      for (const session of [snapshot.orchestrator, ...snapshot.units]) laneSvg(session, 600, t0, t1, NOW);
      costSvg(snapshot.cost, 600, t0, t1, NOW);
    }
  });
});

test('the axis labels "now" and spaced ticks; the cost line runs up to the swarm total', () => {
  const axis = axisSvg(600, NOW - 12 * HOUR, NOW);
  assert.match(axis, />now<\/text>/);
  assert.ok((axis.match(/<line /g) ?? []).length >= 2);
  const snapshot = exampleSnapshot();
  const cost = costSvg(snapshot.cost, 600, NOW - 12 * HOUR, NOW, NOW);
  assert.match(cost, /d="M4\.0 36\.0L/);
  assert.match(cost, /<circle cx="592" cy="4\.0" r="3"/);
  assert.match(costSvg({ ...snapshot.cost, series: [] }, 600, NOW - HOUR, NOW, NOW), /d="M4\.0 36\.0L592\.0 36\.0"/);
});
