import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coalesced, isNarrow, lifecycleKey, renderApp, staleChoice } from '../ui/app.mjs';
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

test('lifecycleKey changes when a swarm starts, finishes or goes away, and not for other changes', () => {
  const a = { id: 'a', lifecycle: 'live', name: 'x' };
  const b = { id: 'b', lifecycle: 'finished' };
  const key = lifecycleKey([a, b]);
  assert.equal(lifecycleKey([b, a]), key);
  assert.notEqual(lifecycleKey([{ ...a, lifecycle: 'finished' }, b]), key);
  assert.notEqual(lifecycleKey([a]), key);
  assert.notEqual(lifecycleKey([a, b, { id: 'c', lifecycle: 'live' }]), key);
  assert.equal(lifecycleKey([{ ...a, name: 'y', lastActivityAt: 5 }, { ...b, lastActivityAt: 6 }]), key);
  assert.equal(typeof lifecycleKey([]), 'string');
});

test('coalesced runs one load at a time and once more if asked again meanwhile', async () => {
  const pending = [];
  let fail = false;
  const load = () => {
    if (fail) return Promise.reject(new Error('down'));
    return new Promise(resolve => pending.push(resolve));
  };
  let calls = 0;
  const run = coalesced(() => {
    calls += 1;
    return load();
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const done = [run(), run(), run()];
  assert.equal(calls, 1);
  pending[0]();
  await tick();
  assert.equal(calls, 2);
  pending[1]();
  await Promise.all(done);
  assert.equal(calls, 2);
  const later = run();
  assert.equal(calls, 3);
  pending[2]();
  await later;
  // A failed load rejects the promise its run() returned, and later runs still load.
  fail = true;
  await assert.rejects(run(), /down/);
  assert.equal(calls, 4);
  fail = false;
  const after = run();
  assert.equal(calls, 5);
  pending[3]();
  await after;
});

test('coalesced still runs a call queued behind a load that rejects', async () => {
  const pending = [];
  let calls = 0;
  const run = coalesced(() => {
    calls += 1;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  const first = run();
  const second = run();
  assert.equal(calls, 1);
  pending[0].reject(new Error('down'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  pending[1].resolve();
  await second;
  await first;
  assert.equal(calls, 2);
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
  const html = renderApp(view({ snapshot: finished, swarms: fixture('example-swarms.json').map(swarm => ({ ...swarm, lifecycle: 'finished' })) }));
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

test('a picked or remembered swarm applies only while it is live; one in the address always applies', () => {
  const swarms = fixture('example-swarms.json');
  assert.equal(staleChoice(null, false, swarms), false);
  assert.equal(staleChoice('ws-0000-root', false, swarms), false);
  assert.equal(staleChoice('ws-1000-root', false, swarms), true, 'finished');
  assert.equal(staleChoice('ws-gone', false, swarms), true, 'gone');
  assert.equal(staleChoice('ws-1000-root', true, swarms), false, 'named in the address');
});

test('the picker appears with two live swarms, or when the page shows an ended swarm while another is live', () => {
  const swarms = fixture('example-swarms.json');
  assert.doesNotMatch(renderApp(view({ swarms })), /data-swarm/, 'one live swarm, shown');
  const both = swarms.map(swarm => ({ ...swarm, lifecycle: 'live' }));
  assert.match(renderApp(view({ swarms: both })), /<option value="ws-0000-root" selected>Sample story B<\/option><option value="ws-1000-root">Sample story A<\/option>/);
  const ended = exampleSnapshot();
  Object.assign(ended.run, { id: 'ws-1000-root', name: 'Sample story A', lifecycle: 'finished', finishedAt: NOW - 3600000 });
  assert.match(renderApp(view({ snapshot: ended, swarm: 'ws-1000-root', swarms })), /<select data-swarm aria-label="Swarm"><option value="ws-1000-root" selected>Sample story A<\/option><option value="ws-0000-root">Sample story B<\/option><\/select>/);
});

test('a finished run says "Swarm finished" while another swarm is live', () => {
  const finished = exampleSnapshot();
  Object.assign(finished.run, { lifecycle: 'finished', finishedAt: NOW - 3600000 });
  const swarms = fixture('example-swarms.json');
  const other = [{ ...swarms[0], id: 'ws-other', name: 'Other' }, { ...swarms[0], lifecycle: 'finished' }];
  assert.match(renderApp(view({ snapshot: finished, swarms: other })), /<h3>Swarm finished<\/h3>/);
  const none = other.map(swarm => ({ ...swarm, lifecycle: 'finished' }));
  assert.match(renderApp(view({ snapshot: finished, swarms: none })), /<h3>No live swarm<\/h3>/);
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
