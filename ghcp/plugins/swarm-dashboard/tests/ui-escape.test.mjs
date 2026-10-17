import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderApp } from '../ui/app.mjs';
import { esc } from '../ui/format.mjs';
import { historyHtml, runHtml } from '../ui/history.mjs';
import { planGraphHtml, planListHtml } from '../ui/plan.mjs';
import { axisSvg, costSvg, laneSvg, timelineWindow } from '../ui/timeline.mjs';
import { NOW, exampleSnapshot, fixture } from './helpers/ui.mjs';

const MARK = '<x-hostile a="1">"&\'';
/** Free text the engine reads from session files, prompts or PRs; ids, times and enum fields stay as they are. */
const TEXT_KEYS = new Set(['name', 'title', 'summary', 'body', 'type', 'model', 'effort', 'text', 'label', 'labels', 'reason', 'message', 'dependsOn', 'waitsOn', 'evidence', 'blockers']);

/** A copy of value with MARK appended to every string under TEXT_KEYS, string array items included. */
function hostile(value) {
  if (Array.isArray(value)) return value.map(hostile);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (TEXT_KEYS.has(key) && typeof child === 'string') return [key, child + MARK];
    if (TEXT_KEYS.has(key) && Array.isArray(child)) return [key, child.map(item => (typeof item === 'string' ? item + MARK : hostile(item)))];
    return [key, hostile(child)];
  }));
}

function hostileSnapshot() {
  const snapshot = hostile(exampleSnapshot());
  const unit = snapshot.units.find(item => item.subagents.length);
  unit.subagents[0].status = `odd${MARK}`;
  snapshot.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: `gh failed${MARK}` });
  return snapshot;
}

const view = (snapshot, overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot,
  swarms: hostile(fixture('example-swarms.json')).map(swarm => ({ ...swarm, lifecycle: 'live' })), swarm: null, runs: null, run: null,
  connection: 'open', demo: false, now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides,
});

function outputs() {
  const snapshot = hostileSnapshot();
  const out = {};
  for (const tab of ['cards', 'timeline', 'plan', 'board']) out[`live ${tab}`] = renderApp(view(snapshot, { tab }));
  out['live activity, narrow'] = renderApp(view(snapshot, { tab: 'activity', narrow: true }));
  for (const unit of snapshot.units) {
    out[`detail ${unit.id}`] = renderApp(view(snapshot, { detail: unit.id }));
    out[`detail ${unit.id}, narrow`] = renderApp(view(snapshot, { detail: unit.id, narrow: true }));
  }
  out['plan graph'] = planGraphHtml(snapshot, NOW);
  out['plan list'] = planListHtml(snapshot, NOW);
  const { t0, t1 } = timelineWindow(snapshot, 'run', NOW);
  for (const session of [snapshot.orchestrator, ...snapshot.units]) out[`lane ${session.id}`] = laneSvg(session, 600, t0, t1, NOW);
  out.axis = axisSvg(600, t0, t1);
  out.cost = costSvg(snapshot.cost, 600, t0, t1, NOW);
  out.history = historyHtml(hostile(fixture('example-history.json')));
  out.run = runHtml(hostile(fixture('example-run-summary.json')));
  return out;
}

test('text from Copilot data is escaped in every view', () => {
  const out = outputs();
  for (const [name, html] of Object.entries(out)) assert.ok(!html.includes('<x-hostile'), `${name}: ${html.slice(Math.max(0, html.indexOf('<x-hostile') - 120), html.indexOf('<x-hostile') + 40)}`);
  assert.ok(out['live cards'].includes('&lt;x-hostile'), 'the cards show the escaped text');
  assert.ok(out['live cards'].includes('data-swarm'), 'the picker is rendered');
  assert.ok(out[`detail ${hostileSnapshot().units.find(item => item.subagents.length).id}`].includes('odd&lt;x-hostile'), 'the odd sub-agent status is shown, escaped');
  // B1 runs with xhigh, and its code-review sub-agent with high: both efforts show in its detail panel, escaped.
  const b1 = out['detail ws-0003-b1'];
  assert.ok(b1.includes(`<span class="v-note"> · ${esc(`xhigh${MARK}`)}</span>`), 'the unit\'s effort is shown, escaped');
  assert.ok(b1.includes(`claude-sonnet-5${esc(MARK)} · ${esc(`high${MARK}`)} · `), 'the sub-agent\'s effort is shown, escaped');
});
