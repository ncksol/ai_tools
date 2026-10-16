import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANVAS_WIDTHS, VIEWS, WIDTHS, buildStates, describeKept, describeTimes, main, parseArguments } from '../scripts/check-layout.mjs';
import { browserArguments, findBrowser } from '../scripts/lib/cdp.mjs';
import { findPlaywright } from '../scripts/lib/webkit.mjs';
import { tempDir } from './helpers/temp.mjs';

const sink = () => {
  const out = { text: '', write(chunk) { out.text += chunk; return true; } };
  return out;
};

test('every view is checked at the nine widths in the browser layout and three in the canvas layout', () => {
  assert.deepEqual(WIDTHS, [480, 560, 640, 800, 1024, 1280, 1440, 1600, 1920]);
  assert.deepEqual(CANVAS_WIDTHS, [480, 560, 640]);
  assert.deepEqual(VIEWS.map(view => view.name), ['cards', 'detail', 'detail-subagent', 'activity', 'timeline', 'timeline-run', 'plan', 'board', 'history', 'run']);
  const example = buildStates({ scenarios: ['example'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS });
  assert.equal(example.length, 120);
  const stress = buildStates({ scenarios: ['stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS });
  assert.equal(stress.length, 108, 'the stress scenario has no finished run, so only its History list is checked, with History failing');
  assert.deepEqual(stress.filter(state => state.view === 'history').length, 12);
  assert.equal(stress.some(state => state.view === 'run'), false);
  assert.deepEqual(stress.find(state => state.view === 'history' && state.host === 'canvas' && state.width === 480).params, { host: 'canvas', page: 'history' });
  const detail = example.find(state => state.view === 'detail' && state.host === 'canvas' && state.width === 560);
  assert.deepEqual(detail.params, { host: 'canvas', detail: 'ws-0005-i1' });
  const subagent = example.find(state => state.view === 'detail-subagent' && state.host === 'canvas' && state.width === 560);
  assert.deepEqual(subagent.params, { host: 'canvas', detail: 'call-root-24' });
  assert.deepEqual(stress.find(state => state.view === 'detail-subagent' && state.host === 'browser' && state.width === 480).params, { host: 'browser', detail: 'call-9101-sub' });
  assert.equal(example.find(state => state.view === 'activity').narrowOnly, true);
});

test('arguments narrow the run to one scenario or width, or ask for screenshots', () => {
  assert.deepEqual(parseArguments([]), { scenarios: ['example', 'stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS, screenshots: null, live: null, engine: 'chrome', help: false });
  assert.deepEqual(parseArguments(['--scenario', 'stress']).scenarios, ['stress']);
  assert.deepEqual(parseArguments(['--width', '560']), { scenarios: ['example', 'stress'], widths: [560], canvasWidths: [560], screenshots: null, live: null, engine: 'chrome', help: false });
  assert.deepEqual(parseArguments(['--width', '1280']).canvasWidths, []);
  assert.equal(parseArguments(['--screenshots', '/tmp/shots']).screenshots, '/tmp/shots');
  assert.throws(() => parseArguments(['--scenario', 'nope']), /scenario/);
  assert.throws(() => parseArguments(['--width', '100']), /width/);
  assert.throws(() => parseArguments(['--nope']), /Unknown option/);
  assert.equal(parseArguments(['--engine', 'webkit']).engine, 'webkit');
  assert.equal(parseArguments(['--engine', 'chrome']).engine, 'chrome');
  assert.throws(() => parseArguments(['--engine', 'safari']), /--engine/);
});

test('a running dashboard is checked with the swarm, unit and run it shows', () => {
  const options = parseArguments(['--live', 'http://127.0.0.1:7927']);
  assert.equal(options.live, 'http://127.0.0.1:7927/');
  assert.deepEqual(options.scenarios, ['live']);
  assert.throws(() => parseArguments(['--live', 'https://example.com/']), /--live/);
  assert.throws(() => parseArguments(['--live', 'http://127.0.0.1:7927/', '--scenario', 'stress']), /--live/);
  assert.throws(() => parseArguments(['--live', 'http://127.0.0.1:7927/', '--screenshots', '/tmp/shots']), /--screenshots/);
  const targets = { live: { swarm: 'ws-a', detail: 'ws-b', subagent: 'call-c', run: null } };
  const states = buildStates({ scenarios: ['live'], widths: [1280], canvasWidths: [], targets });
  assert.deepEqual(states.map(state => state.view), ['cards', 'detail', 'detail-subagent', 'activity', 'timeline', 'timeline-run', 'plan', 'board']);
  assert.deepEqual(states.find(state => state.view === 'detail').params, { host: 'browser', swarm: 'ws-a', detail: 'ws-b' });
  assert.deepEqual(states.find(state => state.view === 'detail-subagent').params, { host: 'browser', swarm: 'ws-a', detail: 'call-c' });
  const empty = buildStates({ scenarios: ['live'], widths: [1280], canvasWidths: [], targets: { live: { swarm: null, detail: null, run: 'ws-r' } } });
  assert.deepEqual(empty.map(state => state.view), ['cards', 'activity', 'timeline', 'timeline-run', 'plan', 'board', 'history', 'run']);
  assert.deepEqual(empty.find(state => state.view === 'run').params, { host: 'browser', page: 'run', run: 'ws-r' });
});

test('update times are reported as a count, a median and a maximum', () => {
  assert.equal(describeTimes([4, 2, 9.25]), '3 updates; 4.0 ms median, 9.3 ms max');
  assert.equal(describeTimes([2, 4]), '2 updates; 3.0 ms median, 4.0 ms max');
  assert.equal(describeTimes([5]), '1 update; 5.0 ms median, 5.0 ms max');
});

test('the browser comes from CHROME_PATH when it is set', () => {
  assert.equal(findBrowser({ CHROME_PATH: process.execPath }), process.execPath);
  assert.equal(findBrowser({ CHROME_PATH: '/no/such/browser' }), null);
});

test('headless Chrome starts with a mock keychain, so the first navigation cannot wait on the macOS keychain', () => {
  const args = browserArguments('/tmp/profile');
  assert.ok(args.includes('--use-mock-keychain'));
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--user-data-dir=/tmp/profile'));
});

test('the live-update line names the checks it measured and those it could not', () => {
  assert.equal(describeKept([]), 'cards kept, no repeated highlights, scroll kept, busy rings in phase');
  assert.equal(describeKept(['scroll', 'busy-ring phase']), 'cards kept, no repeated highlights, not measured: scroll, busy-ring phase');
});

test('Playwright is found only where PLAYWRIGHT_CORE points, or through normal resolution', () => {
  assert.equal(findPlaywright({ PLAYWRIGHT_CORE: '/no/such/folder' }), null);
  const folder = tempDir();
  writeFileSync(path.join(folder, 'index.mjs'), '');
  assert.equal(findPlaywright({ PLAYWRIGHT_CORE: folder }), pathToFileURL(path.join(folder, 'index.mjs')).href);
});

const skipsWith = async (env, expected) => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(await main(['--engine', 'webkit'], { stdout, stderr, env }), 0);
  assert.ok(stdout.text.includes(expected), stdout.text);
  assert.ok(!stdout.text.includes('Browser:'), stdout.text);
  assert.equal(stderr.text, '');
};

test('the WebKit mode skips with a message when Playwright is missing', async () => {
  await skipsWith({}, 'WebKit check skipped: Playwright is not available');
});

test('the WebKit mode names the PLAYWRIGHT_CORE folder that has no index.mjs', async () => {
  const folder = tempDir();
  await skipsWith({ PLAYWRIGHT_CORE: folder }, `WebKit check skipped: PLAYWRIGHT_CORE (${folder}) has no index.mjs. Point it at the playwright-core package folder, …/node_modules/playwright-core.`);
});

test('the WebKit mode says when PLAYWRIGHT_CORE holds a module that is not playwright-core', async () => {
  const folder = tempDir();
  writeFileSync(path.join(folder, 'index.mjs'), 'export const something = 1;\n');
  await skipsWith({ PLAYWRIGHT_CORE: folder }, `WebKit check skipped: ${path.join(folder, 'index.mjs')} is not playwright-core.`);
});

test('the WebKit mode gives the real install command when the WebKit browser is not downloaded', async () => {
  const folder = tempDir();
  writeFileSync(path.join(folder, 'index.mjs'), "export const webkit = { executablePath: () => '/no/such/webkit' };\n");
  await skipsWith({ PLAYWRIGHT_CORE: folder }, `WebKit check skipped: Playwright's WebKit browser is not downloaded. Run: node ${path.join(folder, 'cli.js')} install webkit`);
});
