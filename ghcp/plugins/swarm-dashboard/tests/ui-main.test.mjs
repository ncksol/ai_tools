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

test('at start-up the page restores a swarm it showed by default, and keeps it temporary', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  for (const needle of ['sessionStorage.getItem(SHOWN_KEY)', 'sessionStorage.removeItem(SHOWN_KEY)', 'startsShown({ urlSwarm, restoredPick, restoredShown, session: params.get(\'session\') })']) assert.ok(main.includes(needle), needle);
  assert.match(main, /startSwarm\(\{ urlSwarm, restoredPick, restoredShown, session: params\.get\('session'\), savedSwarm: saved\.swarm \}\)/);
  const save = main.slice(main.indexOf('function save()'), main.indexOf('\n}\n', main.indexOf('function save()')));
  assert.ok(save.includes('swarm: swarmIsShown ? null : view.swarm'), 'a swarm shown by default is never remembered');
});

test('a swarm shown by default gives way as on the server, and picking a swarm makes it an ordinary pick', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const handler = main.slice(main.indexOf("addEventListener('swarms'"));
  const swarms = handler.slice(0, handler.indexOf('});'));
  assert.ok(swarms.includes('swarmIsShown ? staleShown(view.swarm, view.swarms) : staleChoice(view.swarm, swarmFromUrl, view.swarms)'));
  assert.match(swarms, /swarmIsShown = false;/);
  const picker = main.slice(main.indexOf("addEventListener('change'"));
  const change = picker.slice(0, picker.indexOf('});'));
  assert.match(change, /swarmFromUrl = false;\s*swarmIsShown = false;/);
});

test('the swarms handler reloads History through historyReloadWanted, so the first event after load reloads it too', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const handler = main.slice(main.indexOf("addEventListener('swarms'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.match(body, /historyReloadWanted\(\{ asked: historyAsked, previousKey: lifecycle, key \}\)/);
  assert.ok(body.includes('reloadHistory()'));
});

test('a page showing the default asks for the swarm on screen whenever it connects, as a temporary shown swarm', () => {
  const main = readFileSync(file('main.mjs'), 'utf8');
  const start = main.indexOf('function connect()');
  const body = main.slice(start, main.indexOf('\n}\n', start));
  const at = needle => {
    assert.ok(body.includes(needle), needle);
    return body.indexOf(needle);
  };
  assert.ok(at('keptDefault(') < at('new URLSearchParams()'), 'the swarm on screen is kept before the query is built');
  assert.ok(at('swarmIsShown = true') < at('new URLSearchParams()'), 'the kept swarm is temporary');
  assert.ok(at('swarmIsShown = true') < at('new EventSource('));
  const pageshow = main.slice(main.indexOf("addEventListener('pageshow'"));
  assert.match(pageshow.slice(0, pageshow.indexOf('});')), /connect\(\)/);
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
