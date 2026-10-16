import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardHtml, planFits, planGraphHtml, planListHtml, planSize } from '../ui/plan.mjs';
import { NOW, closedSnapshot, context, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const node = (html, label) => html.split(/<(?:div|li) class="(?:pn|pl-row) /).find(part => part.includes(`<span class="tx">${label} `));

test('the graph needs 824 px or its own width, whichever is larger', () => {
  const snapshot = exampleSnapshot();
  assert.deepEqual(planSize(snapshot), { width: 824, height: 452 });
  assert.equal(planFits(snapshot, 824), true);
  assert.equal(planFits(snapshot, 823), false);
  snapshot.planned.push(
    { label: 'Z1', name: 'one', dependsOn: 'I2', canStart: false, waitsOn: 'I2', todoId: null },
    { label: 'Z2', name: 'two', dependsOn: 'Z1', canStart: false, waitsOn: 'Z1', todoId: null },
    { label: 'Z3', name: 'three', dependsOn: 'Z2', canStart: false, waitsOn: 'Z2', todoId: null },
  );
  assert.equal(planSize(snapshot).width, 1472);
  assert.equal(planFits(snapshot, 1000), false);
  assert.equal(planFits(snapshot, 1472), true);
});

test('the graph places stacked branches left to right and links them', () => {
  const html = planGraphHtml(exampleSnapshot(), NOW);
  assert.match(html, /<div class="legend"><span><i class="sw stg-planned"><\/i>Planned<\/span>/);
  assert.match(html, /<div class="plan-g" style="width:824px;height:452px">/);
  assert.equal((html.match(/<div class="pn /g) ?? []).length, 9);
  assert.equal((html.match(/<path /g) ?? []).length, 8);
  assert.match(node(html, 'B0'), /^stg-archived st-archived" style="left:0px;top:215px;width:176px;height:62px" data-open="ws-0001-b0"/);
  assert.match(node(html, 'I2'), /^stg-planned st-planned" style="left:648px;top:78px;width:176px;height:62px">/);
  assert.match(node(html, 'B3'), /^stg-planned st-planned can"/);
  assert.match(text(node(html, 'I1')), /I1 integration Coding · stuck 48m/);
  assert.match(text(node(html, 'I2')), /I2 load tests waits on I1 \(coding\)/);
  assert.match(text(node(html, 'B3')), /B3 export can start now/);
  assert.match(text(node(html, 'B1')), /B1 API In review · busy/);
  assert.match(text(node(html, 'F2a')), /F2a tests, part 1 Merged/);
});

test('the indented list shows the same plan for narrow widths', () => {
  const html = planListHtml(exampleSnapshot(), NOW);
  assert.deepEqual([...html.matchAll(/style="margin-left:(\d+)px"/g)].map(match => Number(match[1])), [0, 16, 16, 32, 48, 32, 32, 16, 16]);
  assert.match(text(node(html, 'F2a')), /F2a tests, part 1 Merged · on B0/);
  assert.match(node(html, 'I1'), /data-open="ws-0005-i1"/);
  assert.doesNotMatch(node(html, 'B3'), /data-open/);
});

test('an empty plan says so', () => {
  const snapshot = exampleSnapshot();
  snapshot.units = [];
  snapshot.planned = [];
  assert.match(planGraphHtml(snapshot, NOW), /No plan yet\./);
  assert.match(planListHtml(snapshot, NOW), /No plan yet\./);
});

test('the plan and the board never change the snapshot', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  assert.doesNotThrow(() => {
    planFits(snapshot, 1200);
    planGraphHtml(snapshot, NOW);
    planListHtml(snapshot, NOW);
    boardHtml(context(snapshot));
  });
});

test('a unit whose PR closed without merging stays in the PR open column with the badge', () => {
  const columns = boardHtml(context(closedSnapshot())).split('<section class="bcol"');
  const prOpen = columns.find(part => part.startsWith(' aria-label="PR open"'));
  assert.match(prOpen, /D5 [^<]*<\/span><\/div><div class="mc-2"><span class="badge rp-blocked">closed, not merged<\/span><\/div>/);
});

test('the board has one column per stage with counts, attention first', () => {
  const snapshot = exampleSnapshot();
  const html = boardHtml(context(snapshot));
  assert.deepEqual([...html.matchAll(/<b>([^<]+)<\/b>(\d+)/g)].map(match => `${match[1]} ${match[2]}`), ['Planned 2', 'Coding 3', 'PR open 1', 'In review 1', 'Merged 1', 'Archived 1']);
  const coding = html.split('<section class="bcol" aria-label="Coding">')[1].split('</section>')[0];
  assert.deepEqual([...coding.matchAll(/data-open="([^"]+)"/g)].map(match => match[1]), ['ws-0005-i1', 'ws-0004-b2', 'ws-0006-f1']);
  assert.match(text(coding), /I1 integration stuck 48m 9,702 cr · ≈\$97\.02/);
  assert.match(html, /<div class="mc planned st-planned can"><div class="mc-1"><span class="tx">B3 export<\/span><\/div><div class="mc-2">can start now<\/div><div class="mc-3">stacks on B1<\/div><\/div>/);
  assert.match(text(html), /I2 load tests waits on I1 stacks on I1/);
  assert.match(text(html), /B0 schema archived 1d 4h ago/);
  snapshot.planned = [];
  assert.match(boardHtml(context(snapshot)), /<b>Planned<\/b>0<\/div><span class="none">None<\/span>/);
});

test('the plan says a PR closed without merging, in the graph and in the list', () => {
  const snapshot = closedSnapshot();
  const graph = planGraphHtml(snapshot, NOW);
  assert.match(node(graph, 'D5'), /<div class="pn-2"><span class="pr-closed">PR closed, not merged<\/span><\/div>/);
  assert.match(text(node(graph, 'B1')), /B1 API In review · busy/);
  const list = planListHtml(snapshot, NOW);
  assert.match(node(list, 'D5'), /<span class="pr-closed">PR closed, not merged<\/span> · on B0/);
  assert.match(text(node(list, 'B1')), /B1 API In review · busy/);
});
