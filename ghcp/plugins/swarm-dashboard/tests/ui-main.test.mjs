import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = name => fileURLToPath(new URL(`../ui/${name}`, import.meta.url));

test('the browser modules parse and import only sibling modules', () => {
  for (const name of ['main.mjs', 'morph.mjs']) {
    const check = spawnSync(process.execPath, ['--check', file(name)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    const source = readFileSync(file(name), 'utf8');
    for (const [, specifier] of source.matchAll(/\bfrom\s+'([^']+)'/g)) assert.match(specifier, /^\.\/[\w-]+\.mjs$/);
    assert.doesNotMatch(source, /https?:\/\//);
  }
});

test('the browser module keeps the names the server and the layout check rely on', () => {
  const source = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ["getElementById('dash')", 'new EventSource(', "'hello'", "'swarms'", "'snapshot'", 'dataset.ready', 'dataset.narrow', 'dataset.host', "'/api/history'", '/api/runs/', "'swarm-dashboard:ui'", "'pagehide'", "'swarm-update'"]) {
    assert.ok(source.includes(needle), needle);
  }
});

test('updates patch the page in place instead of replacing it', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  assert.ok(main.includes('morph(dash, renderApp('));
  assert.doesNotMatch(main, /\.innerHTML\s*=/);
  const morph = readFileSync(file('morph.mjs'), 'utf8');
  for (const needle of ["'data-key'", "'data-drawn'", "'data-phase'"]) assert.ok(morph.includes(needle), needle);
});

test('every 15 seconds the Timeline renders again, so its rows follow the moving window', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const tick = main.slice(main.indexOf('setInterval('), main.indexOf('}, 1000);'));
  assert.match(tick, /if \(ticks % 15 === 0 && view\.page === 'live' && view\.tab === 'timeline' && view\.snapshot\) scheduleRender\(\);/);
  assert.doesNotMatch(tick, /drawTimeline/);
});

test('a finished sub-agent\'s card fades and leaves on time, and the other cards glide unless motion is reduced', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ['nextCardChange(', 'cardTimer', 'clearTimeout(cardTimer)', '.animate(']) assert.ok(main.includes(needle), needle);
  const glide = main.slice(main.indexOf('function glide'), main.indexOf('\n}\n', main.indexOf('function glide')));
  assert.match(glide, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.ok(glide.includes('.animate('));
  assert.match(glide, /composite: 'add'/, 'a glide adds to one that still runs, so the card does not jump');
  // The helpers only act if render() calls them: its body runs up to the next top-level function.
  const start = main.indexOf('\nfunction render() {');
  const next = main.slice(start + 1).search(/\n(?:async )?function /);
  const render = main.slice(start, next === -1 ? undefined : start + 1 + next);
  for (const call of ['glide(cards);', 'scheduleCardChange();']) assert.ok(render.includes(call), `render() calls ${call}`);
  const pagehide = main.slice(main.indexOf("addEventListener('pagehide'"));
  assert.match(pagehide.slice(0, pagehide.indexOf('});')), /clearTimeout\(cardTimer\)/);
});

test('an open page reloads once into new dashboard files, remembering the attempt and waiting while hidden', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ['function considerReload', 'sessionStorage', 'RELOAD_KEY', 'reloadDecision(', 'reloadSearch(', "'visibilitychange'", 'history.replaceState(', 'location.reload(', 'meta[name="swarm-ui"]']) {
    assert.ok(main.includes(needle), needle);
  }
  const hello = main.slice(main.indexOf("addEventListener('hello'"));
  assert.match(hello.slice(0, hello.indexOf('});')), /considerReload\(\)/);
});

test('the reload records its attempt first, needs an open connection, and gives up whenever storage fails', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const start = main.indexOf('function considerReload');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  const at = needle => {
    assert.ok(body.includes(needle), needle);
    return body.indexOf(needle);
  };
  assert.ok(at('readyState !== EventSource.OPEN) return;') < at('sessionStorage.setItem(RELOAD_KEY'), 'the open-connection guard comes first');
  assert.ok(at('sessionStorage.setItem(RELOAD_KEY') < at('location.reload('), 'the attempt is written before the reload');
  assert.ok(at('PICK_KEY') < at('location.reload('));
  assert.ok(at('reloadCarry(') < at('sessionStorage.setItem(SHOWN_KEY'), 'what to carry is decided before it is written');
  assert.ok(at('sessionStorage.setItem(SHOWN_KEY') < at('location.reload('), 'a swarm shown by default is carried before the reload');
  assert.ok(at('sessionStorage.setItem(RESTORED_KEY') < at('location.reload('));
  const catches = body.match(/catch \{/g) ?? [];
  assert.ok(catches.length >= 2);
  assert.equal((body.match(/catch \{\s*return\b/g) ?? []).length, catches.length, 'every catch returns');
  const error = main.slice(main.indexOf("addEventListener('error'"));
  assert.match(error.slice(0, error.indexOf('});')), /servedUi = null/);
});

test('at start-up the page restores a picked swarm and cleans the address only after a self-reload', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ['startSwarm(', 'baseSearch(', 'sessionStorage.removeItem(PICK_KEY)', 'sessionStorage.removeItem(RESTORED_KEY)']) assert.ok(main.includes(needle), needle);
  assert.match(main, /if \(restored\) history\.replaceState\(/);
});

test('at start-up the page restores a swarm it showed by default as a transport swarm, never as its own choice', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ['sessionStorage.getItem(SHOWN_KEY)', 'sessionStorage.removeItem(SHOWN_KEY)', 'let shownSwarm = startShown({ urlSwarm, restoredPick, restoredShown, session: urlSession });']) assert.ok(main.includes(needle), needle);
  assert.match(main, /startSwarm\(\{ urlSwarm, restoredPick, restoredShown, session: urlSession, savedSwarm: saved\.swarm \}\)/);
  const save = main.slice(main.indexOf('function save()'), main.indexOf('\n}\n', main.indexOf('function save()')));
  assert.ok(save.includes('swarm: view.swarm'), 'save() remembers the page\'s own swarm');
  assert.ok(!save.includes('shownSwarm'), 'a transport swarm is never remembered');
  assert.ok(!main.includes('swarmIsShown'), 'no swarmIsShown is left');
});

test('an empty swarm or session parameter reads as none, as on the server', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  assert.ok(main.includes("const urlSwarm = params.get('swarm') || null;"), 'an empty swarm parameter is no swarm');
  assert.ok(main.includes("const urlSession = params.get('session') || null;"), 'an empty session parameter is no session');
  assert.ok(main.includes('session: urlSession,'), 'the page keeps the normalized session');
  assert.doesNotMatch(main, /params\.get\('(?:swarm|session)'\)(?! \|\| null)/, 'every read of the swarm or session parameter is normalized');
});

test('a transport swarm gives way as on the server, and picking a swarm clears it', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const handler = main.slice(main.indexOf("addEventListener('swarms'"));
  const swarms = handler.slice(0, handler.indexOf('});'));
  assert.ok(swarms.includes('if (staleChoice(view.swarm, swarmFromUrl, view.swarms) || (!view.swarm && staleShown(shownSwarm, view.swarms))) {'));
  const giveWay = swarms.slice(swarms.indexOf('if (staleChoice('));
  assert.ok(giveWay.indexOf('shownSwarm = null;') > -1 && giveWay.indexOf('shownSwarm = null;') < giveWay.indexOf('connect();'), 'giving way clears the transport swarm before reconnecting');
  const picker = main.slice(main.indexOf("addEventListener('change'"));
  const change = picker.slice(0, picker.indexOf('});'));
  assert.match(change, /swarmFromUrl = false;\s*shownSwarm = null;/);
});

test('the swarms handler reloads History through historyReloadWanted, so the first event after load reloads it too', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const handler = main.slice(main.indexOf("addEventListener('swarms'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.match(body, /historyReloadWanted\(\{ asked: historyAsked, previousKey: lifecycle, key \}\)/);
  assert.ok(body.includes('reloadHistory()'));
});

test('a page showing the default asks for the swarm on screen whenever it connects, as a transport swarm only', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const start = main.indexOf('function connect()');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  const at = needle => {
    assert.ok(body.includes(needle), needle);
    return body.indexOf(needle);
  };
  assert.ok(at('shownSwarm = view.swarm ? null : keptDefault(') < at('new URLSearchParams()'), 'the swarm on screen is kept before the query is built');
  assert.ok(at('const asked = view.swarm || shownSwarm;') < at('new EventSource('), 'the page asks for its own swarm, else the transport swarm, and an empty choice never masks it');
  assert.ok(at("if (asked) query.set('swarm', asked);") < at('new EventSource('));
  assert.doesNotMatch(body.slice(0, at('new EventSource(')), /view\.swarm\s*=[^=]/, 'connecting never changes the page\'s own swarm');
  const pageshow = main.slice(main.indexOf("addEventListener('pageshow'"));
  assert.match(pageshow.slice(0, pageshow.indexOf('});')), /connect\(\)/);
});

test('a self-reload carries the transport swarm, and only the page\'s own swarm decides the finished empty state', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const start = main.indexOf('function considerReload');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  assert.ok(body.includes('transport: shownSwarm'), 'considerReload passes the transport swarm');
  const app = readFileSync(file('app.mjs'), 'utf8');
  assert.ok(app.includes("snapshot.run.lifecycle === 'finished' && !view.swarm"), 'liveHtml shows the empty state for a page with no swarm of its own');
});

test('every error reconnects through connect(), and only for the EventSource that is still current', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const handler = main.slice(main.indexOf("addEventListener('error'"));
  const error = handler.slice(0, handler.indexOf('});'));
  const at = needle => {
    assert.ok(error.includes(needle), needle);
    return error.indexOf(needle);
  };
  assert.doesNotMatch(error, /EventSource\.CLOSED/, 'EventSource\'s own retry would reuse the old address');
  assert.match(error, /if \(source !== (\w+)\) return;/, 'a late error from a replaced EventSource is ignored');
  const own = error.match(/if \(source !== (\w+)\) return;/)[1];
  assert.ok(at(`if (source !== ${own}) return;`) < at(`${own}.close()`), 'the guard comes first');
  assert.ok(at(`${own}.close()`) < at('setTimeout(connect, 2000)'));
  assert.ok(at('clearTimeout(reconnectTimer)') < at('setTimeout(connect, 2000)'), 'a pending timer is cleared');
  assert.ok(at('servedUi = null') > -1);
});

test('a failed History load is an error, not an empty History, and is retried a bounded number of times', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const block = (start, end = '\n}\n') => {
    const at = main.indexOf(start);
    assert.ok(at > -1, start);
    return main.slice(at, main.indexOf(end, at));
  };
  assert.doesNotMatch(main, /view\.runs\s*=\s*\[\]/, 'a failure never reads as no finished runs');
  assert.ok(block('const view = {', '\n};\n').includes('historyError: false,'), 'the page starts with no History error');
  const load = block('const loadHistory = coalesced(', '\n});\n');
  assert.ok(load.includes('view.historyError = true;'), 'a failed load is an error');
  assert.ok(load.includes('view.historyError = false;'), 'a successful load clears the error');
  assert.ok(load.indexOf('view.historyError = false;') < load.indexOf('view.historyError = true;'), 'success and failure are separate branches');
  assert.ok(load.includes('historyRetries = 0;'), 'a successful load resets the retry budget');
  assert.ok(load.includes('retryHistory()'), 'a failed load schedules a retry');
  assert.ok(load.includes('scheduleRender()'));
  assert.ok(main.includes('const HISTORY_RETRY_MS = 3000;'));
  assert.ok(main.includes('const HISTORY_RETRIES = 3;'));
  const retry = block('function retryHistory()');
  assert.ok(retry.indexOf('clearTimeout(historyRetryTimer)') < retry.indexOf('setTimeout('), 'one timer: cleared before scheduling');
  assert.ok(retry.includes('if (historyRetries >= HISTORY_RETRIES) return;'), 'the retries are bounded');
  assert.ok(retry.includes('historyRetryTimer = setTimeout(loadHistory, HISTORY_RETRY_MS);'));
  const reload = block('function reloadHistory()');
  assert.ok(reload.includes('historyRetries = 0;'), 'each trigger gets fresh retries');
  assert.ok(block('function isReady()').includes("if (view.page === 'history') return view.runs !== null || view.historyError;"));
  const pagehide = block("window.addEventListener('pagehide'", '});');
  assert.ok(pagehide.includes('clearTimeout(historyRetryTimer)'), 'leaving the page stops the retries');
  const app = readFileSync(file('app.mjs'), 'utf8');
  assert.ok(app.includes('historyHtml(view.runs, view.historyError)'), 'the renderer is told about the error');
});
