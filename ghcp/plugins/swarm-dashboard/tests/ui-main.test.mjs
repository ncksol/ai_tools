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
