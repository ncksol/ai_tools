import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PICK_KEY, RELOAD_KEY, RESTORED_KEY, SHOWN_KEY, baseSearch, coalesced, historyReloadWanted, isNarrow, keptDefault, lifecycleKey, reloadCarry, reloadDecision, reloadSearch, renderApp, retryBudget, staleChoice, staleShown, startShown, startSwarm } from '../ui/app.mjs';
import { NOW, deepFreeze, exampleSnapshot, fixture } from './helpers/ui.mjs';

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: exampleSnapshot(),
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides,
});
const topBar = html => html.match(/<div class="d-top">[\s\S]*?<div class="d-top-r">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
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

test('History reloads on a swarms event only once asked: on the first event after load and when a lifecycle changes', () => {
  for (const [previousKey, key] of [[null, 'a:live'], ['a:live', 'a:live'], ['a:live', 'a:finished']]) {
    assert.equal(historyReloadWanted({ asked: false, previousKey, key }), false);
  }
  assert.equal(historyReloadWanted({ asked: true, previousKey: null, key: 'a:live' }), true);
  assert.equal(historyReloadWanted({ asked: true, previousKey: 'a:live', key: 'a:live' }), false);
  assert.equal(historyReloadWanted({ asked: true, previousKey: 'a:live', key: 'a:finished' }), true);
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

/** A fake timer: set() records a callback, fire() runs one by hand, and pending() lists the ids not yet fired or cleared. */
function fakeTimers() {
  const callbacks = new Map();
  let next = 1;
  return {
    set: (callback, ms) => {
      callbacks.set(next, { callback, ms });
      return next++;
    },
    clear: id => callbacks.delete(id),
    pending: () => [...callbacks.keys()],
    delay: id => callbacks.get(id).ms,
    fire(id) {
      const { callback } = callbacks.get(id);
      callbacks.delete(id);
      callback();
    },
  };
}
const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve));
};

test('a retry budget schedules one retry per failure, three at most, after the delay', () => {
  const timers = fakeTimers();
  let retries = 0;
  const budget = retryBudget({ limit: 3, delayMs: 3000, retry: () => { retries += 1; }, setTimer: timers.set, clearTimer: timers.clear });
  for (let round = 1; round <= 3; round += 1) {
    budget.failed();
    assert.equal(timers.pending().length, 1, `failure ${round} schedules a retry`);
    assert.equal(timers.delay(timers.pending()[0]), 3000);
    timers.fire(timers.pending()[0]);
    assert.equal(retries, round);
  }
  budget.failed();
  assert.deepEqual(timers.pending(), [], 'a fourth failure schedules none');
  assert.equal(retries, 3);
});

test('an attempt cancels a pending retry, so its callback never runs', () => {
  const timers = fakeTimers();
  let retries = 0;
  const budget = retryBudget({ limit: 3, delayMs: 3000, retry: () => { retries += 1; }, setTimer: timers.set, clearTimer: timers.clear });
  budget.failed();
  budget.failed();
  assert.equal(timers.pending().length, 1, 'one timer handle: a second failure replaces the pending retry');
  budget.attempt();
  assert.deepEqual(timers.pending(), []);
  budget.stop();
  assert.equal(retries, 0);
});

test('reset and success restart the budget and cancel a pending retry', () => {
  for (const restart of ['reset', 'succeeded']) {
    const timers = fakeTimers();
    let retries = 0;
    const budget = retryBudget({ limit: 3, delayMs: 3000, retry: () => { retries += 1; }, setTimer: timers.set, clearTimer: timers.clear });
    for (let round = 0; round < 3; round += 1) {
      budget.failed();
      timers.fire(timers.pending()[0]);
    }
    budget.failed();
    assert.deepEqual(timers.pending(), [], `${restart}: the budget is used up`);
    budget[restart]();
    budget.failed();
    assert.equal(timers.pending().length, 1, `${restart} restarts the budget`);
    budget[restart]();
    assert.deepEqual(timers.pending(), [], `${restart} cancels the pending retry`);
    assert.equal(retries, 3);
  }
  const timers = fakeTimers();
  const budget = retryBudget({ limit: 3, delayMs: 3000, retry: () => assert.fail('a stopped retry ran'), setTimer: timers.set, clearTimer: timers.clear });
  budget.failed();
  budget.stop();
  assert.deepEqual(timers.pending(), [], 'stop cancels the pending retry');
});

/** A load wired as History's: coalesced, attempt() first, its outcome settled by hand through answer(ok). */
function retriedLoad(timers) {
  const answers = [];
  let loads = 0;
  let budget = null;
  const load = coalesced(async () => {
    budget.attempt();
    loads += 1;
    if (await new Promise(resolve => answers.push(resolve))) budget.succeeded();
    else budget.failed();
  });
  budget = retryBudget({ limit: 3, delayMs: 3000, retry: () => load(), setTimer: timers.set, clearTimer: timers.clear });
  return { budget, load, loads: () => loads, answer: ok => answers.shift()(ok), waiting: () => answers.length };
}

test('a trigger while a retry is pending makes no extra load: one failure, one trigger that succeeds, two loads', async () => {
  const timers = fakeTimers();
  const history = retriedLoad(timers);
  history.load();
  history.answer(false);
  await flush();
  assert.equal(timers.pending().length, 1, 'the failure left a retry pending');
  // The trigger: reset, then load, while the retry is pending.
  history.budget.reset();
  history.load();
  assert.deepEqual(timers.pending(), [], 'the obsolete retry is cancelled before the triggered load runs');
  history.answer(true);
  await flush();
  assert.equal(history.loads(), 2);
  assert.deepEqual(timers.pending(), []);
  assert.equal(history.waiting(), 0, 'no retry or queued load runs afterwards');
});

test('a retry scheduled by a load that fails while a trigger is queued behind it never runs', async () => {
  const timers = fakeTimers();
  const history = retriedLoad(timers);
  history.load();
  history.budget.reset();
  history.load();
  history.answer(false);
  await flush();
  assert.equal(history.loads(), 2, 'the queued load started');
  assert.deepEqual(timers.pending(), [], 'its attempt cancelled the retry the failure scheduled');
  history.answer(true);
  await flush();
  assert.equal(history.loads(), 2);
  assert.deepEqual(timers.pending(), []);
  assert.equal(history.waiting(), 0);
});

test('after a trigger, at most three automatic retries run, even when a retry comes due during a request', async () => {
  const timers = fakeTimers();
  const history = retriedLoad(timers);
  // A failure leaves a retry pending, then a trigger starts a load.
  history.load();
  history.answer(false);
  await flush();
  history.budget.reset();
  history.load();
  const before = history.loads();
  for (let guard = 0; guard < 20 && history.waiting(); guard += 1) {
    // Any retry still pending comes due while the request is in flight, then again once it has failed.
    for (const id of timers.pending()) timers.fire(id);
    history.answer(false);
    await flush();
    for (const id of timers.pending()) timers.fire(id);
  }
  assert.equal(history.loads() - before, 3, 'three automatic retries after the triggered load');
  assert.deepEqual(timers.pending(), []);
  assert.equal(history.waiting(), 0);
});

test('the wide Live page has the header, Needs you, four tabs and the activity rail', () => {
  const html = renderApp(view());
  assert.match(html, /<button type="button" data-page="live" aria-pressed="true">Live<\/button>/);
  assert.match(html, /class="d-head"/);
  assert.match(html, /aria-label="Needs you"/);
  assert.deepEqual(tabs(html), ['cards*', 'timeline', 'plan', 'board']);
  assert.match(html, /<div class="d-body"><div class="d-main">/);
  assert.match(html, /<aside class="d-side"><section class="rail" aria-label="Activity">/);
  assert.doesNotMatch(topBar(html), /watch-only/i);
  assert.match(topBar(html), /<div class="d-top-r">/);
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
  const retrying = topBar(renderApp(view({ connection: 'retrying' })));
  assert.match(retrying, /Disconnected · retrying/);
  assert.doesNotMatch(retrying, /Watch-only/i);
  const warned = exampleSnapshot();
  warned.diagnostics.push({ level: 'warn', source: 'pr-lookup', message: 'gh is not signed in.' });
  assert.match(renderApp(view({ snapshot: warned })), /<span class="small muted" title="pr-lookup: gh is not signed in\.">1 data warning<\/span>/);
  const demo = renderApp(view({ demo: true }));
  assert.match(demo, /<span class="small muted">Sample data<\/span>/);
  assert.doesNotMatch(demo, /watch-only/i);
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

test('a page reloads once for new dashboard files, waits while hidden, and never loops', () => {
  assert.equal(RELOAD_KEY, 'swarm-dashboard:reloaded-for');
  assert.equal(reloadDecision({ own: 'a', served: 'a', attempted: null, hidden: false }), 'stay');
  // A page served before this feature has no fingerprint of its own; a server without one sends none.
  assert.equal(reloadDecision({ own: null, served: 'b', attempted: null, hidden: false }), 'stay');
  assert.equal(reloadDecision({ own: 'a', served: null, attempted: null, hidden: false }), 'stay');
  assert.equal(reloadDecision({ own: 'a', served: 'b', attempted: null, hidden: false }), 'reload');
  assert.equal(reloadDecision({ own: 'a', served: 'b', attempted: null, hidden: true }), 'wait');
  // A reload that did not take: the page still has the old files and has already tried the new fingerprint.
  assert.equal(reloadDecision({ own: 'a', served: 'b', attempted: 'b', hidden: false }), 'stay');
  assert.equal(reloadDecision({ own: 'a', served: 'b', attempted: 'b', hidden: true }), 'stay');
  // An attempt for an older fingerprint does not block a newer one.
  assert.equal(reloadDecision({ own: 'a', served: 'c', attempted: 'b', hidden: false }), 'reload');
});

test('the reload address keeps the host, session, page, run, tab, time window, open detail and an addressed swarm', () => {
  const base = { page: 'live', tab: 'board', span: '3h', detail: null, runId: null, swarm: 'ws-1' };
  const read = search => Object.fromEntries(new URLSearchParams(search));
  assert.deepEqual(read(reloadSearch(base, new URLSearchParams(''), false)), { tab: 'board', span: '3h' });
  assert.deepEqual(read(reloadSearch({ ...base, detail: 'u-1' }, new URLSearchParams('host=canvas&session=s-1&other=x'), true)), { host: 'canvas', session: 's-1', swarm: 'ws-1', tab: 'board', span: '3h', detail: 'u-1' });
  assert.deepEqual(read(reloadSearch({ ...base, page: 'history' }, new URLSearchParams('host=browser'), false)), { host: 'browser', page: 'history', tab: 'board', span: '3h' });
  assert.deepEqual(read(reloadSearch({ ...base, page: 'run', runId: 'ws-old' }, new URLSearchParams(''), false)), { page: 'run', run: 'ws-old', tab: 'board', span: '3h' });
  assert.equal(new URLSearchParams(reloadSearch({ ...base, swarm: null }, new URLSearchParams(''), true)).has('swarm'), false);
});

test('a page starts on an addressed swarm, then a pick restored after a self-reload, then the session or the remembered swarm', () => {
  assert.equal(PICK_KEY, 'swarm-dashboard:picked-swarm');
  // A canvas opened for a session, whose user picked another live swarm before the reload.
  assert.equal(startSwarm({ urlSwarm: null, restoredPick: 'ws-picked', session: 's-1', savedSwarm: 'ws-saved' }), 'ws-picked');
  assert.equal(startSwarm({ urlSwarm: 'ws-url', restoredPick: 'ws-picked', session: 's-1', savedSwarm: 'ws-saved' }), 'ws-url');
  assert.equal(startSwarm({ urlSwarm: null, restoredPick: null, session: 's-1', savedSwarm: 'ws-saved' }), null);
  assert.equal(startSwarm({ urlSwarm: null, restoredPick: null, session: null, savedSwarm: 'ws-saved' }), 'ws-saved');
  assert.equal(startSwarm({ urlSwarm: null, restoredPick: null, session: null, savedSwarm: null }), null);
});

test('a page that showed the default before a self-reload stays a default page, unless an address or a pick decides', () => {
  assert.equal(SHOWN_KEY, 'swarm-dashboard:shown-swarm');
  // [input, the page's own swarm (startSwarm), the transport swarm it asks for (startShown)]
  const cases = [
    [{ urlSwarm: null, restoredPick: null, restoredShown: 'ws-shown', session: null, savedSwarm: null }, null, 'ws-shown'],
    [{ urlSwarm: null, restoredPick: null, restoredShown: 'ws-shown', session: null, savedSwarm: 'ws-saved' }, null, 'ws-shown'],
    [{ urlSwarm: null, restoredPick: null, restoredShown: 'ws-shown', session: 's-1', savedSwarm: 'ws-saved' }, null, null],
    [{ urlSwarm: 'ws-url', restoredPick: null, restoredShown: 'ws-shown', session: null, savedSwarm: null }, 'ws-url', null],
    [{ urlSwarm: null, restoredPick: 'ws-picked', restoredShown: 'ws-shown', session: null, savedSwarm: null }, 'ws-picked', null],
    [{ urlSwarm: null, restoredPick: null, restoredShown: null, session: null, savedSwarm: 'ws-saved' }, 'ws-saved', null],
    [{ urlSwarm: null, restoredPick: null, restoredShown: null, session: null, savedSwarm: null }, null, null],
  ];
  for (const [input, swarm, shown] of cases) {
    assert.equal(startSwarm(input), swarm, `startSwarm ${JSON.stringify(input)}`);
    assert.equal(startShown(input), shown, `startShown ${JSON.stringify(input)}`);
  }
});

test('an empty swarm, pick, shown swarm, session or remembered swarm counts as none', () => {
  // [input, the page's own swarm (startSwarm), the transport swarm it asks for (startShown)]
  const none = { urlSwarm: null, restoredPick: null, restoredShown: null, session: null, savedSwarm: null };
  const cases = [
    [{ ...none, urlSwarm: '' }, null, null],
    [{ ...none, urlSwarm: '', savedSwarm: 'ws-saved' }, 'ws-saved', null],
    [{ ...none, urlSwarm: '', restoredShown: 'ws-shown', savedSwarm: 'ws-saved' }, null, 'ws-shown'],
    [{ ...none, session: '', savedSwarm: 'ws-saved' }, 'ws-saved', null],
    [{ ...none, session: '', restoredShown: 'ws-shown' }, null, 'ws-shown'],
    [{ ...none, restoredPick: '', savedSwarm: 'ws-saved' }, 'ws-saved', null],
    [{ ...none, restoredPick: '', restoredShown: 'ws-shown' }, null, 'ws-shown'],
    [{ ...none, restoredShown: '', savedSwarm: 'ws-saved' }, 'ws-saved', null],
    [{ ...none, restoredShown: '' }, null, null],
    [{ ...none, savedSwarm: '' }, null, null],
    [{ urlSwarm: '', restoredPick: '', restoredShown: '', session: '', savedSwarm: '' }, null, null],
  ];
  for (const [input, swarm, shown] of cases) {
    assert.equal(startSwarm(input), swarm, `startSwarm ${JSON.stringify(input)}`);
    assert.equal(startShown(input), shown, `startShown ${JSON.stringify(input)}`);
  }
});

test('a swarm shown by default gives way once it is no longer live while another swarm is', () => {
  const swarms = fixture('example-swarms.json');
  const none = swarms.map(swarm => ({ ...swarm, lifecycle: 'finished' }));
  assert.equal(staleShown('ws-0000-root', swarms), false, 'live');
  assert.equal(staleShown('ws-1000-root', swarms), true, 'finished while another is live');
  assert.equal(staleShown('ws-0000-root', none), false, 'finished and nothing live');
  assert.equal(staleShown('ws-gone', swarms), true, 'gone while another is live');
  assert.equal(staleShown(null, swarms), false);
});

test('a self-reload carries a picked swarm as a pick and the swarm a default page shows or asks for as shown', () => {
  const swarms = fixture('example-swarms.json');
  const none = swarms.map(swarm => ({ ...swarm, lifecycle: 'finished' }));
  const base = { swarm: null, fromUrl: false, session: null, onScreen: 'ws-0000-root', transport: null, swarms };
  const nothing = { pick: null, shown: null };
  assert.deepEqual(reloadCarry({ ...base, swarm: 'ws-0000-root', fromUrl: true }), nothing, 'addressed');
  assert.deepEqual(reloadCarry({ ...base, swarm: 'ws-0000-root' }), { pick: 'ws-0000-root', shown: null }, 'own swarm');
  assert.deepEqual(reloadCarry(base), { pick: null, shown: 'ws-0000-root' }, 'default page, live on screen');
  assert.deepEqual(reloadCarry({ ...base, swarms: none }), { pick: null, shown: 'ws-0000-root' }, 'default page, nothing live');
  assert.deepEqual(reloadCarry({ ...base, onScreen: null, transport: 'ws-0000-root' }), { pick: null, shown: 'ws-0000-root' }, 'default page, nothing on screen yet, transport swarm');
  assert.deepEqual(reloadCarry({ ...base, onScreen: 'ws-1000-root' }), nothing, 'default page, no longer live while another is');
  assert.deepEqual(reloadCarry({ ...base, onScreen: null, transport: 'ws-1000-root' }), nothing, 'transport swarm that would give way');
  assert.deepEqual(reloadCarry({ ...base, session: 's-1' }), nothing, 'opened for a session');
  assert.deepEqual(reloadCarry({ ...base, onScreen: null }), nothing, 'no snapshot and no transport swarm');
});

test('a default page keeps the swarm on screen when it connects again, unless that swarm would give way anyway', () => {
  const swarms = fixture('example-swarms.json');
  const none = swarms.map(swarm => ({ ...swarm, lifecycle: 'finished' }));
  const base = { swarm: null, session: null, onScreen: 'ws-0000-root', swarms };
  assert.equal(keptDefault(base), 'ws-0000-root', 'default page, live');
  assert.equal(keptDefault({ ...base, swarms: none }), 'ws-0000-root', 'default page, not live and nothing live');
  assert.equal(keptDefault({ ...base, onScreen: 'ws-1000-root' }), null, 'default page, not live while another is');
  assert.equal(keptDefault({ ...base, session: 's-1' }), null, 'opened for a session');
  assert.equal(keptDefault({ ...base, swarm: 'ws-0000-root' }), null, 'the page\'s own swarm (picked, addressed or remembered)');
  assert.equal(keptDefault({ ...base, swarm: 'ws-1000-root' }), null, 'a different swarm asked for');
  assert.equal(keptDefault({ ...base, onScreen: null }), null, 'no snapshot');
});

test('after a self-reload the address goes back to the host, the session and an addressed swarm', () => {
  assert.equal(RESTORED_KEY, 'swarm-dashboard:restored');
  const read = search => Object.fromEntries(new URLSearchParams(search));
  assert.deepEqual(read(baseSearch(new URLSearchParams('host=canvas&session=s-1&tab=board&span=3h&detail=u-1&page=run&run=ws-old'))), { host: 'canvas', session: 's-1' });
  assert.deepEqual(read(baseSearch(new URLSearchParams('host=browser&swarm=ws-1&tab=plan'))), { host: 'browser', swarm: 'ws-1' });
  assert.equal(baseSearch(new URLSearchParams('tab=board')), '');
});
