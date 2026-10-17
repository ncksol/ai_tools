import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityHtml, clockHtml, costHtml, hudHtml, needsHtml, noteHtml, prsHtml, qualityHtml, statusHtml, unitsHtml } from '../ui/cockpit-panels.mjs';
import { NOW, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const example = () => deepFreeze(exampleSnapshot());
const all = s => [clockHtml(s, NOW), costHtml(s, NOW), needsHtml(s, NOW), statusHtml(s), activityHtml(s), unitsHtml(s, NOW, new Set()), prsHtml(s)].join('');
const countOf = (html, pattern) => [...html.matchAll(pattern)].length;
const tileWidths = html => [...html.matchAll(/class="ck-tile (ck-w[346])\b/g)].map(([, width]) => width);

test('no panel uses bold, italic or inline type styles', () => {
  for (const html of [all(example()), all(null), hudHtml({ demo: true, connection: 'retrying', snapshot: example() }), noteHtml()]) {
    assert.doesNotMatch(html, /<(b|strong|em|i)\b|font-weight|font-style|text-transform/);
  }
});

test('the clock shows the time, the date, the run timer, the next monitor check and the run', () => {
  const html = clockHtml(example(), NOW);
  assert.match(html, /<span class="ck-mono ck-hm" data-clock="hm">\d\d:\d\d<\/span><span class="ck-mono ck-s" data-clock="s">\d\d<\/span>/);
  assert.match(html, /data-clock="date">[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]+</);
  assert.match(html, /<span class="ck-k">Running<\/span><span class="ck-v ck-mono"><span data-t="1791809280000" data-f="clock">/);
  assert.match(html, /<span class="ck-k">Next check<\/span><span class="ck-v ck-mono"><span data-t="1792065660000" data-f="left">1m<\/span>/);
  assert.match(html, /Sample story B · sample-project/);
  assert.match(clockHtml(null, NOW), /<span class="ck-k">Swarm<\/span><span class="ck-v">None yet<\/span>/);
});

test('cost shows credits, dollars, the hourly rate and up to four models as bars', () => {
  const html = costHtml(example(), NOW);
  assert.match(html, /<button type="button" class="ck-t" data-tab="timeline">Cost<\/button><span class="ck-side"><span class="ck-mono">\+2,208 cr\/h<\/span><\/span>/);
  assert.match(costHtml(example(), NOW + 3 * 3600000), /<span class="ck-mono">\+0 cr\/h<\/span>/);
  assert.match(html, /<div class="ck-big ck-mono">97,652 cr<\/div><div class="ck-meta ck-mono">≈\$977 at list price<\/div>/);
  assert.equal(countOf(html, /class="ck-model"/g), 4);
  assert.match(html, /claude-sonnet-5<\/span><span class="ck-mono ck-n">52,100<\/span><span class="ck-bar"><span class="ck-fill" style="--w:1\.0000"><\/span>/);
});

test('needs you lights up, counts and lists the first two, each leading to its unit', () => {
  const html = needsHtml(example(), NOW);
  assert.match(html, /<span class="ck-light"><\/span><button type="button" class="ck-t" data-tab="cards">Needs you<\/button>/);
  assert.match(html, /<span class="ck-side ck-big ck-mono">2<\/span>/);
  assert.match(html, /<button type="button" class="ck-need st-plan" data-detail="ws-0004-b2"><span class="ck-mono ck-lab" title="B2">B2<\/span><span class="ck-kind">Plan to approve<\/span>/);
  assert.match(html, /class="ck-need st-pr" data-detail="ws-0007-d5"/);
  const quiet = exampleSnapshot();
  quiet.needs = [];
  assert.match(needsHtml(quiet, NOW), /ck-light is-off[\s\S]*<p class="ck-empty">Nothing waiting<\/p>/);
});

test('status shows the six buckets and what is live and ended', () => {
  const html = statusHtml(example());
  assert.equal(countOf(html, /<li class="st-/g), 6);
  assert.match(html, /<li class="st-busy"><span class="ck-dot"><\/span><span class="ck-w">Working<\/span><span class="ck-mono ck-n">2<\/span><\/li>/);
  assert.match(html, /7 live · 5 ended/);
});

test('activity lists nine rows, newest last; rows of units lead to their details', () => {
  const html = activityHtml(example());
  assert.equal(countOf(html, /<li data-key=/g), 9);
  assert.match(html, /<div class="ck-log-window" style="--lab:6ch"><ol class="ck-log">/);
  assert.match(html, /<div class="ck-log-row st-question"><span class="ck-mono ck-time">\d\d:\d\d<\/span><span class="ck-mono ck-lab" title="SB">SB<\/span>/);
  assert.match(html, /<button type="button" class="ck-log-row st-busy" data-detail="call-root-41">[\s\S]*started explore<\/span><\/button><\/li><\/ol>/);
  assert.match(html, /16 recent events/);
});

test('mission control shows a tile per unit at the density its count needs, the orchestrator and the counts', () => {
  const html = unitsHtml(example(), NOW, new Set(['ws-0005-i1']));
  assert.match(html, /<div class="ck-tiles d-two">/);
  assert.equal(countOf(html, /<button type="button" class="ck-tile /g), 9);
  assert.match(html, /<button type="button" class="ck-tile ck-w4 st-stuck is-attn is-new" data-detail="ws-0005-i1" data-key="ws-0005-i1" title="I1 integration" aria-label="I1 integration, Stuck">/);
  assert.doesNotMatch(html, /class="ck-name"/, 'two-line tiles leave the name to the title');
  assert.match(html, /<span class="ck-side">SB orchestrator · Waiting on question · <span data-t=/);
  assert.match(html, /<p class="ck-foot">7 child sessions · 2 sub-agents running · 3 finished<\/p>/);
  const few = exampleSnapshot();
  few.units = few.units.filter(unit => unit.kind !== 'subagent');
  assert.match(unitsHtml(few, NOW, new Set()), /<div class="ck-tiles d-full">[\s\S]*<span class="ck-name">integration<\/span>/);
  const many = exampleSnapshot();
  many.units = Array.from({ length: 20 }, (_, i) => ({ ...few.units[2], id: `u${i}`, label: `U${i}` }));
  assert.match(unitsHtml(many, NOW, new Set()), /<div class="ck-tiles d-one">[\s\S]*<button type="button" class="ck-tile ck-w3 ck-more" data-tab="board" data-key="more" title="On the Board"><span>\+5 more<\/span><\/button>/);
});

test('the example has nine third-width tiles across three full rows', () => {
  assert.deepEqual(tileWidths(unitsHtml(example(), NOW, new Set())), [
    'ck-w4', 'ck-w4', 'ck-w4',
    'ck-w4', 'ck-w4', 'ck-w4',
    'ck-w4', 'ck-w4', 'ck-w4',
  ]);
});

test('ten tiles give four quarter-width tiles before six third-width tiles', () => {
  const s = exampleSnapshot();
  s.units = Array.from({ length: 10 }, (_, i) => ({ ...s.units[2], id: `u${i}`, label: `U${i}` }));
  assert.deepEqual(tileWidths(unitsHtml(s, NOW, new Set())), [
    'ck-w3', 'ck-w3', 'ck-w3', 'ck-w3',
    'ck-w4', 'ck-w4', 'ck-w4',
    'ck-w4', 'ck-w4', 'ck-w4',
  ]);
});

test('single rows keep quarter-width tiles and a two-tile final row uses half-width tiles', () => {
  for (const [n, widths] of [
    [1, ['ck-w3']], [2, ['ck-w3', 'ck-w3']], [3, ['ck-w3', 'ck-w3', 'ck-w3']],
    [4, ['ck-w3', 'ck-w3', 'ck-w3', 'ck-w3']],
    [5, ['ck-w4', 'ck-w4', 'ck-w4', 'ck-w6', 'ck-w6']],
  ]) {
    const s = exampleSnapshot();
    s.units = Array.from({ length: n }, (_, i) => ({ ...s.units[2], id: `u${i}`, label: `U${i}` }));
    assert.deepEqual(tileWidths(unitsHtml(s, NOW, new Set())), widths, `${n} tiles`);
  }
});

test('pull requests list four rows and the opened and merged counts', () => {
  const html = prsHtml(example());
  assert.equal(countOf(html, /<button type="button" class="ck-pr /g), 4);
  assert.match(html, /<button type="button" class="ck-pr st-busy" data-detail="ws-0003-b1"><span class="ck-mono ck-num">#418<\/span><span class="ck-pr-t"><span class="ck-ttl" title="Orders and invoices API">Orders and invoices API<\/span><span class="ck-sub">B1 API<\/span><\/span><span class="ck-pr-s"><span class="ck-dot"><\/span>In review<\/span><\/button>/);
  assert.match(html, /4 opened · 2 merged/);
});

test('text from the snapshot is escaped', () => {
  const s = exampleSnapshot();
  s.units[2].name = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(unitsHtml(s, NOW, new Set()) + prsHtml(s), /<img/);
  const labels = exampleSnapshot();
  labels.needs[0].labels = ['"B2<'];
  for (const item of labels.feed) item.label = '"F1<';
  assert.match(needsHtml(labels, NOW), /<span class="ck-mono ck-lab" title="&quot;B2&lt;">&quot;B2&lt;<\/span>/);
  assert.match(activityHtml(labels), /<span class="ck-mono ck-lab" title="&quot;F1&lt;">&quot;F1&lt;<\/span>/);
});

test('without a swarm every panel says so', () => {
  const html = all(null);
  for (const text of ['None yet', 'No swarm yet', 'Nothing waiting', 'No activity yet', 'No pull requests yet']) assert.ok(html.includes(text), text);
});

test('the top line, the quality switch and the note', () => {
  assert.equal(hudHtml({ demo: false, connection: 'open', snapshot: example() }), '<span>Swarm cockpit</span>');
  const finished = exampleSnapshot();
  finished.run.lifecycle = 'finished';
  assert.equal(hudHtml({ demo: true, connection: 'retrying', snapshot: finished }), '<span>Swarm cockpit · Sample data · Swarm finished</span><span class="ck-warn"> · Disconnected · retrying</span>');
  assert.equal(qualityHtml('balanced'), '<button type="button" data-quality="high" aria-pressed="false">High</button><button type="button" data-quality="balanced" aria-pressed="true">Balanced</button>');
  assert.match(noteHtml(), /Make this window larger to see the cockpit\.[\s\S]*data-tab="cards">Open the regular view<\/button>/);
});
