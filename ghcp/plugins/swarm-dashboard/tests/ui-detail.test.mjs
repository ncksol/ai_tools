import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityHtml, detailHtml, railHtml } from '../ui/live.mjs';
import { findByLabel } from '../ui/model.mjs';
import { closedSnapshot, context, exampleSnapshot } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const items = html => (html.match(/<li class="fi/g) ?? []).length;

test('the rail and the Activity tab list the swarm feed, latest first', () => {
  const snapshot = exampleSnapshot();
  const rail = railHtml(context(snapshot));
  assert.match(text(rail), /^Activity all units, latest first 4m ago map-import-module started explore 6m ago B1 started code-review: review-pr-418 /);
  assert.equal(items(rail), Math.min(16, snapshot.feed.length));
  const tab = activityHtml(context(snapshot));
  assert.doesNotMatch(tab, /all units, latest first/);
  assert.equal(items(tab), Math.min(24, snapshot.feed.length));
});

test('the detail panel explains a stuck unit', () => {
  const html = detailHtml('ws-0005-i1', false, context(exampleSnapshot()));
  const words = text(html);
  assert.match(html, /<section class="detail" aria-label="Details for I1">/);
  assert.match(html, /<button type="button" class="x" data-close aria-label="Close details">×<\/button>/);
  assert.doesNotMatch(html, /Back to cards/);
  assert.match(words, /I1 integration Stuck · no events 48m/);
  assert.match(words, /Running 9h 05m Cost 9,702 cr · ≈\$97\.02 Progress 56% Stage Coding Model claude-sonnet-5/);
  assert.match(words, /Why this counts as stuck bash has run for 48 min with a limit of 15 min/);
  assert.match(words, /Current activity Doing Running bash: dotnet test --filter E2E Tool call bash: dotnet test --filter E2E · 48m Last event 48m ago/);
  assert.match(words, /Latest report complete 3h ago Contract tests are wired and pass locally\. Starting the end-to-end run next\. Evidence 12 contract tests pass Blockers None reported/);
  assert.match(words, /Sub-agents None in this session/);
  assert.match(words, /PR and monitor No PR yet\. A PR monitor starts when the PR opens\./);
  assert.match(words, /Recent activity No recent activity$/);
});

test('a reason on a unit that is neither stuck nor blocked is a note, not an alarm', () => {
  const snapshot = exampleSnapshot();
  const b1 = snapshot.units.find(unit => unit.label === 'B1');
  Object.assign(b1, { statusDetail: 'slow_model_call', reason: 'Waiting 6m for a model response; it counts as stuck after 10m.' });
  const html = detailHtml(b1.id, false, context(snapshot));
  assert.doesNotMatch(html, /dt-why/);
  assert.match(html, /<span class="k">Note<\/span><span>Waiting 6m for a model response; it counts as stuck after 10m\.<\/span>/);
});

test('the detail panel shows a PR closed without merging with the badge and when it closed', () => {
  const html = detailHtml('ws-0007-d5', false, context(closedSnapshot()));
  assert.match(html, /<span class="k">State<\/span><span class="pr-state"><span class="badge rp-blocked">closed, not merged<\/span><span>/);
  assert.match(text(html), /State closed, not merged 20m ago Reviews review required Monitor ended/);
});

test('the detail panel lists sub-agents, the PR, the monitor and recent activity', () => {
  const html = detailHtml('ws-0003-b1', true, context(exampleSnapshot()));
  const words = text(html);
  assert.match(html, /<button type="button" class="link" data-close>← Back to cards<\/button>/);
  assert.doesNotMatch(html, /class="x"/);
  assert.match(html, /<span class="pill st-busy">running<\/span>/);
  assert.match(words, /task \(sync\) finished claude-haiku-5\.5 · 9m · 30 cr · ≈\$0\.30/);
  assert.match(words, /PR #418 Orders and invoices API State Open since 2h ago Reviews changes requested Monitor missing · no check for 42m Expected a check every 10 min/);
  assert.equal(items(html), 3);
});

test('blocked units, draft PRs and live monitors read correctly', () => {
  const snapshot = exampleSnapshot();
  const f1 = text(detailHtml('ws-0006-f1', false, context(snapshot)));
  assert.match(f1, /Why this counts as blocked It asked the orchestrator for input and has had no reply\./);
  assert.match(f1, /Blockers Needs a decision: reuse DataGrid or build a new table/);
  const d5 = text(detailHtml('ws-0007-d5', false, context(snapshot)));
  assert.match(d5, /State Draft since 5h ago/);
  assert.match(d5, /Monitor alive · last 9m ago · next in 1m Schedule every 10 min/);
  assert.equal(detailHtml('missing', false, context(snapshot)), '');
});

test('long sub-agent lists are capped with a count of the rest', () => {
  const snapshot = exampleSnapshot();
  const b1 = snapshot.units.find(unit => unit.id === 'ws-0003-b1');
  const template = b1.subagents[1];
  b1.subagents = Array.from({ length: 15 }, (_, index) => ({ ...template, id: `call-x-${index}` }));
  const html = detailHtml('ws-0003-b1', false, context(snapshot));
  assert.equal((html.match(/<li class="sa"/g) ?? []).length, 12);
  assert.match(text(html), /3 earlier sub-agents not shown/);
});

test('the detail panel shows report summary, body, evidence and blockers as plain text', () => {
  const snapshot = exampleSnapshot();
  const b1 = snapshot.units.find(unit => unit.id === 'ws-0003-b1');
  Object.assign(b1.report, { summary: '**Short** summary', body: '- **one**\n- `two`', evidence: ['`npm test` passes'], blockers: ['- waiting on **review**'] });
  const html = detailHtml(b1.id, false, context(snapshot));
  const report = html.slice(html.indexOf('<h4>Latest report</h4>'), html.indexOf('<h4>Sub-agents</h4>'));
  assert.match(report, /<p class="dt-p">Short summary<\/p>/);
  assert.match(report, /<p class="dt-p dt-body">one\ntwo<\/p>/);
  assert.match(report, /<li>npm test passes<\/li>/);
  assert.match(report, /<li>waiting on review<\/li>/);
  assert.doesNotMatch(report, /\*\*|`|- /);
});

test('the detail panel\'s latest report shows a replied question as "question" and a replied blocker as "blocker", in grey', () => {
  const latest = html => html.slice(html.indexOf('<h4>Latest report</h4>'), html.indexOf('<h4>Sub-agents</h4>'));
  const snapshot = exampleSnapshot();
  const f1 = findByLabel(snapshot, 'F1');
  const b1 = findByLabel(snapshot, 'B1');
  assert.match(latest(detailHtml(f1.id, false, context(snapshot))), /<div class="dt-rep-h rp-needs"><span class="badge">needs input<\/span>/);
  assert.match(latest(detailHtml(b1.id, false, context(snapshot))), /<div class="dt-rep-h rp-replied"><span class="badge">question<\/span>/);
  f1.report.status = 'blocked';
  b1.report.status = 'blocked';
  assert.match(latest(detailHtml(f1.id, false, context(snapshot))), /<div class="dt-rep-h rp-blocked"><span class="badge">blocked<\/span>/);
  assert.match(latest(detailHtml(b1.id, false, context(snapshot))), /<div class="dt-rep-h rp-replied"><span class="badge">blocker<\/span>/);
});
