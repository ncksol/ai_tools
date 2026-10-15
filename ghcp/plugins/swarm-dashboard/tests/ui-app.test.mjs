import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isNarrow, renderApp } from '../ui/app.mjs';
import { NOW, deepFreeze, exampleSnapshot, fixture } from './helpers/ui.mjs';

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: exampleSnapshot(),
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides,
});
const tabs = html => [...html.matchAll(/data-tab="(\w+)" aria-selected="(true|false)"/g)].map(match => `${match[1]}${match[2] === 'true' ? '*' : ''}`);

test('narrow mode starts below 900 px of inner width', () => {
  assert.equal(isNarrow(932), false);
  assert.equal(isNarrow(931), true);
});

test('the wide Live page has the header, Needs you, four tabs and the activity rail', () => {
  const html = renderApp(view());
  assert.match(html, /<button type="button" data-page="live" aria-pressed="true">Live<\/button>/);
  assert.match(html, /class="d-head"/);
  assert.match(html, /aria-label="Needs you"/);
  assert.deepEqual(tabs(html), ['cards*', 'timeline', 'plan', 'board']);
  assert.match(html, /<div class="d-body"><div class="d-main">/);
  assert.match(html, /<aside class="d-side"><section class="rail" aria-label="Activity">/);
  assert.match(html, /<span class="small muted">Watch-only<\/span>/);
});

test('narrow mode adds the Activity tab and drops the rail; the detail panel replaces the cards', () => {
  const narrow = renderApp(view({ narrow: true, tab: 'activity' }));
  assert.deepEqual(tabs(narrow), ['cards', 'activity*', 'timeline', 'plan', 'board']);
  assert.match(narrow, /<div class="d-body is-narrow">/);
  assert.doesNotMatch(narrow, /d-side/);
  const detail = renderApp(view({ narrow: true, detail: 'ws-0005-i1' }));
  assert.doesNotMatch(detail, /role="tablist"/);
  assert.match(detail, /← Back to cards/);
});

test('in wide mode the detail panel takes the rail\'s place', () => {
  const html = renderApp(view({ detail: 'ws-0005-i1' }));
  assert.match(html, /<div class="d-body has-detail">/);
  assert.match(html, /<aside class="d-side"><section class="detail" aria-label="Details for I1">/);
  assert.match(html, /class="b-card st-stuck is-sel"/);
});

test('rendering never changes the snapshot, because the live engine hands out its cached object', () => {
  const snapshot = deepFreeze(exampleSnapshot());
  for (const tab of ['cards', 'activity', 'timeline', 'plan', 'board']) {
    for (const narrow of [false, true]) assert.doesNotThrow(() => renderApp(view({ snapshot, tab, narrow })), `${tab}${narrow ? ', narrow' : ''}`);
  }
  assert.doesNotThrow(() => renderApp(view({ snapshot, detail: 'ws-0005-i1' })));
});

test('each tab renders its view container, and Activity falls back to Cards when wide', () => {
  assert.match(renderApp(view({ tab: 'timeline' })), /data-timeline/);
  assert.match(renderApp(view({ tab: 'plan' })), /<div data-plan data-drawn><\/div>/);
  assert.match(renderApp(view({ tab: 'board' })), /class="board"/);
  assert.deepEqual(tabs(renderApp(view({ tab: 'activity' }))), ['cards*', 'timeline', 'plan', 'board']);
});

test('loading, empty and finished states', () => {
  assert.match(renderApp(view({ loaded: false, snapshot: null })), /Reading Copilot data…/);
  assert.match(renderApp(view({ snapshot: null })), /No swarm yet/);
  const finished = exampleSnapshot();
  Object.assign(finished.run, { lifecycle: 'finished', finishedAt: NOW - 3 * 3600000 });
  const html = renderApp(view({ snapshot: finished }));
  assert.match(html, /No live swarm/);
  assert.match(html, /Sample story B finished <span[^>]*>3h ago<\/span>\. Finished runs are in History\./);
  assert.match(html, /data-run="ws-0000-root"/);
  assert.match(renderApp(view({ snapshot: finished, swarm: 'ws-0000-root' })), /class="d-head"/);
});

test('the top bar shows a swarm picker, connection trouble, data warnings and sample data', () => {
  const swarms = fixture('example-swarms.json');
  swarms[1].lifecycle = 'live';
  assert.match(renderApp(view({ swarms })), /<select data-swarm aria-label="Swarm"><option value="ws-0000-root" selected>Sample story B<\/option><option value="ws-1000-root">Sample story A<\/option><\/select>/);
  assert.doesNotMatch(renderApp(view()), /data-swarm/);
  assert.match(renderApp(view({ connection: 'retrying' })), /<span class="small warn">Disconnected · retrying<\/span>/);
  const warned = exampleSnapshot();
  warned.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: 'gh is not signed in.' });
  assert.match(renderApp(view({ snapshot: warned })), /<span class="small muted" title="pr-lookup: gh is not signed in\.">1 data warning<\/span>/);
  assert.match(renderApp(view({ demo: true })), /Sample data · watch-only/);
});

test('history pages keep the History button pressed', () => {
  assert.match(renderApp(view({ page: 'history' })), /data-page="history" aria-pressed="true"/);
  assert.match(renderApp(view({ page: 'run' })), /data-page="history" aria-pressed="true"/);
});

test('the page shell loads only its own stylesheet and module', () => {
  const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="\/ui\/styles\.css">/);
  assert.match(html, /<script type="module" src="\/ui\/main\.mjs"><\/script>/);
  assert.match(html, /<main class="dash" id="dash">/);
  assert.doesNotMatch(html, /https?:\/\//);
});
