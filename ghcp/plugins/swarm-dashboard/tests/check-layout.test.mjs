import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CANVAS_WIDTHS, VIEWS, WIDTHS, buildStates, describeTimes, parseArguments } from '../scripts/check-layout.mjs';
import { findBrowser } from '../scripts/lib/cdp.mjs';

test('every view is checked at the nine widths in the browser layout and three in the canvas layout', () => {
  assert.deepEqual(WIDTHS, [480, 560, 640, 800, 1024, 1280, 1440, 1600, 1920]);
  assert.deepEqual(CANVAS_WIDTHS, [480, 560, 640]);
  assert.deepEqual(VIEWS.map(view => view.name), ['cards', 'detail', 'activity', 'timeline', 'timeline-run', 'plan', 'board', 'history', 'run']);
  const example = buildStates({ scenarios: ['example'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS });
  assert.equal(example.length, (9 + 3) * 9);
  const stress = buildStates({ scenarios: ['stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS });
  assert.equal(stress.length, (9 + 3) * 7, 'history views are checked with the example only');
  const detail = example.find(state => state.view === 'detail' && state.host === 'canvas' && state.width === 560);
  assert.deepEqual(detail.params, { host: 'canvas', detail: 'ws-0005-i1' });
  assert.equal(example.find(state => state.view === 'activity').narrowOnly, true);
});

test('arguments narrow the run to one scenario or width, or ask for screenshots', () => {
  assert.deepEqual(parseArguments([]), { scenarios: ['example', 'stress'], widths: WIDTHS, canvasWidths: CANVAS_WIDTHS, screenshots: null, live: null, help: false });
  assert.deepEqual(parseArguments(['--scenario', 'stress']).scenarios, ['stress']);
  assert.deepEqual(parseArguments(['--width', '560']), { scenarios: ['example', 'stress'], widths: [560], canvasWidths: [560], screenshots: null, live: null, help: false });
  assert.deepEqual(parseArguments(['--width', '1280']).canvasWidths, []);
  assert.equal(parseArguments(['--screenshots', '/tmp/shots']).screenshots, '/tmp/shots');
  assert.throws(() => parseArguments(['--scenario', 'nope']), /scenario/);
  assert.throws(() => parseArguments(['--width', '100']), /width/);
  assert.throws(() => parseArguments(['--nope']), /Unknown option/);
});

test('a running dashboard is checked with the swarm, unit and run it shows', () => {
  const options = parseArguments(['--live', 'http://127.0.0.1:7927']);
  assert.equal(options.live, 'http://127.0.0.1:7927/');
  assert.deepEqual(options.scenarios, ['live']);
  assert.throws(() => parseArguments(['--live', 'https://example.com/']), /--live/);
  assert.throws(() => parseArguments(['--live', 'http://127.0.0.1:7927/', '--scenario', 'stress']), /--live/);
  assert.throws(() => parseArguments(['--live', 'http://127.0.0.1:7927/', '--screenshots', '/tmp/shots']), /--screenshots/);
  const targets = { live: { swarm: 'ws-a', detail: 'ws-b', run: null } };
  const states = buildStates({ scenarios: ['live'], widths: [1280], canvasWidths: [], targets });
  assert.deepEqual(states.map(state => state.view), ['cards', 'detail', 'activity', 'timeline', 'timeline-run', 'plan', 'board']);
  assert.deepEqual(states.find(state => state.view === 'detail').params, { host: 'browser', swarm: 'ws-a', detail: 'ws-b' });
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
