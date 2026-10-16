import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { CREDIT_USD as ENGINE_CREDIT_USD } from '../engine/schema.mjs';
import {
  CREDIT_USD, DAY, HOUR, MIN, ago, costHtml, costText, countdown, credits, dateRange, dateTime, dur, elapsed, esc, liveTime,
  plainText, plural, tickText, usd, usdRounded,
} from '../ui/format.mjs';

const span = (days, hours, minutes, seconds = 0) => ((days * 24 + hours) * 60 + minutes) * MIN + seconds * 1000;

test('esc escapes markup for text and attribute values', () => {
  assert.equal(esc('<b title="x">Tom & Jerry\'s</b>'), '&lt;b title=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/b&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(42), '42');
});

test('dur matches the mockup formats', () => {
  assert.equal(dur(span(2, 23, 12, 1), 'clock'), '2d 23h 12m 01s');
  assert.equal(dur(span(0, 9, 5, 1), 'clock'), '9h 05m 01s');
  assert.equal(dur(span(0, 0, 12, 4), 'clock'), '12m 04s');
  assert.equal(dur(span(1, 4, 0), 'age'), '1d 4h ago');
  assert.equal(dur(span(0, 5, 59), 'age'), '5h ago');
  assert.equal(dur(40 * 1000, 'age'), 'just now');
  assert.equal(dur(50 * 1000, 'age'), '1m ago');
  assert.equal(dur(span(3, 0, 10), 'hm'), '72h 10m');
  assert.equal(dur(span(1, 17, 40)), '1d 17h');
  assert.equal(dur(span(0, 5, 0)), '5h 00m');
  assert.equal(dur(span(0, 0, 48, 30)), '48m');
  assert.equal(dur(23 * 1000), '23s');
  assert.equal(dur(-5000), '0s');
});

test('live times carry their start and format so the page can tick them', () => {
  assert.equal(liveTime(1000, 1000 + 35 * MIN), '<span data-t="1000" data-f="short">35m</span>');
  assert.equal(elapsed(0, 2 * HOUR), '<span data-t="0" data-f="short">2h 00m</span>');
  assert.equal(ago(0, 2 * HOUR), '<span data-t="0" data-f="age">2h ago</span>');
  assert.equal(countdown(10 * MIN, 9 * MIN), '<span data-t="600000" data-f="left">1m</span>');
  assert.equal(tickText(10 * MIN, 'left', 9 * MIN + 37 * 1000), '23s');
  assert.equal(tickText(0, 'clock', 61 * 1000), '1m 01s');
});

test('cost shows credits with the list-price dollar estimate', () => {
  assert.equal(CREDIT_USD, ENGINE_CREDIT_USD);
  assert.equal(credits(24016), '24,016 cr');
  assert.equal(credits(97652.4), '97,652 cr');
  assert.equal(credits(0.4), '0.4 cr');
  assert.equal(credits(0), '0 cr');
  assert.equal(usd(9702), '≈$97.02');
  assert.equal(usdRounded(102510), '≈$1,025');
  assert.equal(costText(3058), '3,058 cr · ≈$30.58');
  assert.equal(costHtml(9702), '9,702 cr<span class="usd"> · ≈$97.02</span>');
  assert.equal(costHtml(102510, true), '102,510 cr<span class="usd"> · ≈$1,025</span>');
});

test('dates use local time in the mockup format', () => {
  const start = new Date(2026, 9, 8, 9, 12).getTime();
  assert.equal(dateTime(start), '8 Oct 09:12');
  assert.equal(dateRange(start, start + 3 * DAY + 10 * MIN), '8 Oct 09:12 to 11 Oct 09:22');
  assert.equal(dateRange(start, null), 'from 8 Oct 09:12');
  assert.equal(plural(1, 'run'), '1 run');
  assert.equal(plural(16, 'child', 'children'), '16 children');
  assert.equal(plural(1240, 'sub-agent'), '1,240 sub-agents');
});

const PLAIN = [
  ['**sha** abc123', 'sha abc123'], ['__bold__ text', 'bold text'], ['an *italic* word', 'an italic word'], ['an _italic_ word', 'an italic word'],
  ['**Status:** done.', 'Status: done.'], ['***both***', 'both'], ['Use `npm test` now', 'Use npm test now'], ['see [the PR](https://github.com/o/r/pull/1) now', 'see the PR now'],
  ['## Summary', 'Summary'], ['> quoted', 'quoted'], ['> > nested', 'nested'], ['- item', 'item'], ['* item', 'item'], ['+ item', 'item'], ['  - nested item', 'nested item'], ['1. step one', '1. step one'],
  ['(**bold**)', '(bold)'], ['"*quoted*"', '"quoted"'], ['**done**, then', 'done, then'],
  ['snake_case_name', 'snake_case_name'], ['my_var and other_var', 'my_var and other_var'], ['pkg/__init__.py', 'pkg/__init__.py'], ['__init__.py', '__init__.py'], ['edit __init__.py now', 'edit __init__.py now'],
  ['src/**/*.mjs', 'src/**/*.mjs'], ['**/*.ts', '**/*.ts'], ['*.test.mjs', '*.test.mjs'], ['match *.js and *.mjs files', 'match *.js and *.mjs files'],
  ['2 * 3 * 4', '2 * 3 * 4'], ['2*3*4', '2*3*4'], ['a * b', 'a * b'], ['5* rating', '5* rating'], ['Use the * key', 'Use the * key'], ['*args, **kwargs', '*args, **kwargs'],
  ['run `**/*.ts` here', 'run **/*.ts here'], ['`a_b_c`', 'a_b_c'], ['C:\\Users\\x_y_z', 'C:\\Users\\x_y_z'], ['x = y * (z + 1)', 'x = y * (z + 1)'],
  ['line one\n- **two**\n```\n**kept** in code\n```\nthree', 'line one\ntwo\n**kept** in code\nthree'],
  ['**Updated `config.json`**', 'Updated config.json'], ['**a**...', 'a...'], ['**a**?!', 'a?!'], ['[a](b) [c](d)', 'a c'], ['[x](https://a.b/c_(d))', 'x'],
  ['[x](u "t")', 'x'], ['`**not bold**` stays', '**not bold** stays'], ['see https://x.y/a_b_c', 'see https://x.y/a_b_c'],
];

test('report text loses its Markdown markers and keeps its words', () => {
  for (const [input, expected] of PLAIN) assert.equal(plainText(input), expected, input);
  assert.equal(plainText(null), '');
});

// The engine cuts long titles and feed lines with "…", so links arrive unclosed.
const CUT_OFF = [
  'see [the PR](https://github.com/o/r/pull/1…',
  '[w](https://e.org/wiki/Foo_bar_baz_(b_(c)))',
  'see [the PR](https://github.com/' + 'a'.repeat(180) + '…',
];
// A backtracking regex blocks its thread, so the timing runs in a worker that the test can stop when it times out.
const TIMING = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.url).then(({ plainText }) => {
  parentPort.postMessage(workerData.inputs.map(input => {
    const start = performance.now();
    const out = plainText(input);
    return { input, type: typeof out, ms: performance.now() - start };
  }));
});`;

test('a cut-off link does not stall the page', { timeout: 5000 }, async t => {
  const worker = new Worker(TIMING, { eval: true, workerData: { url: new URL('../ui/format.mjs', import.meta.url).href, inputs: CUT_OFF } });
  worker.unref();
  t.signal.addEventListener('abort', () => worker.terminate());
  const results = await new Promise((resolve, reject) => worker.once('message', resolve).once('error', reject));
  await worker.terminate();
  for (const { input, type, ms } of results) {
    assert.equal(type, 'string', input);
    assert.ok(ms < 50, `${input} took ${ms.toFixed(1)} ms`);
  }
});
