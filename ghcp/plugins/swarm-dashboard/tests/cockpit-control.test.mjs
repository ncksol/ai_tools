import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderApp } from '../ui/app.mjs';
import { NOW, exampleSnapshot, fixture } from './helpers/ui.mjs';

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: exampleSnapshot(),
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, host: 'browser', cockpitNote: null, ...overrides,
});
const NOTE = { url: 'http://127.0.0.1:7927/cockpit?swarm=ws-0000-root', reason: 'canvas', copied: null };

test('the Live page\'s top bar ends with the Cockpit control once a swarm shows', () => {
  assert.match(renderApp(view()), /<div class="d-top-r">[\s\S]*<div class="seg ck-open"><button type="button" data-cockpit>Cockpit<\/button><\/div><\/div><\/div>/);
  assert.doesNotMatch(renderApp(view({ page: 'history', runs: [] })), /data-cockpit/);
  assert.doesNotMatch(renderApp(view({ snapshot: null })), /data-cockpit/);
  assert.match(renderApp(view({ connection: 'retrying' })), /Disconnected · retrying<\/span><div class="seg ck-open"><button type="button" data-cockpit>Cockpit<\/button><\/div><\/div><\/div>/);
});

test('the cockpit\'s address shows under the top bar on the Live page only', () => {
  assert.match(renderApp(view({ cockpitNote: NOTE })), /<\/div><\/div><div class="ck-addr" role="status">[\s\S]*cockpit\?swarm=ws-0000-root/);
  assert.doesNotMatch(renderApp(view({ page: 'history', runs: [], cockpitNote: NOTE })), /ck-addr/);
});

test('the page wires the control, Copy and the cockpit\'s messages', () => {
  const main = readFileSync(new URL('../ui/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /import \{ copyAddress, openCockpit, showRequest \} from '\.\/cockpit-link\.mjs';/);
  assert.match(main, /\[data-cockpit\],\[data-cockpit-copy\]/);
  assert.match(main, /window\.addEventListener\('message', event => \{\n\s+if \(event\.origin !== location\.origin\) return;/);
  const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\n\.ck-addr \{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; \}\n\.ck-addr-url \{ user-select: all; overflow-wrap: anywhere; \}\n/);
});
