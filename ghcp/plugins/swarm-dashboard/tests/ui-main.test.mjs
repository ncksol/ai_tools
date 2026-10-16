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
