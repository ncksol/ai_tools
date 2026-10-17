import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE, describe, isSoftware, parseArguments, summarise, verdict } from '../scripts/cockpit-gpu.mjs';

const bench = times => ({ times, passes: [{ holeMs: 6, bloomMs: 0.6, finalMs: 0.7 }, { holeMs: 7, bloomMs: 0.6, finalMs: 0.7 }, { holeMs: 6.5, bloomMs: 0.7, finalMs: 0.8 }], info: { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro)', hdr: true }, size: { width: 2880, height: 1800 }, dpr: 2 });

test('arguments pick the engine and the number of frames', () => {
  assert.deepEqual(parseArguments([]), { engine: 'chrome', frames: 30, help: false });
  assert.deepEqual(parseArguments(['--engine', 'webkit', '--frames', '60']), { engine: 'webkit', frames: 60, help: false });
  assert.throws(() => parseArguments(['--frames', '2']), /--frames takes a number from 10 to 300/);
  assert.match(USAGE, /^Usage: cockpit-gpu/);
});

test('a run is summarised by its median, 90th percentile, mean and each pass\'s median', () => {
  const summary = summarise(bench([8, 7, 9, 7.5, 10, 7, 8, 7.2, 7.8, 12]));
  assert.deepEqual(summary, { median: 7.9, p90: 12, mean: 8.35, passes: { holeMs: 6.5, bloomMs: 0.6, finalMs: 0.7 } });
});

test('software renderers are recognised', () => {
  assert.equal(isSoftware('Google SwiftShader'), true);
  assert.equal(isSoftware('llvmpipe (LLVM 15.0.7, 256 bits)'), true);
  assert.equal(isSoftware('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro)'), false);
});

test('the test fails without WebGL2, on a software renderer, or when High cannot hold 30 fps at 1440 × 900', () => {
  const ok = { width: 1440, height: 900, renderer: 'Apple GPU', high: { median: 7.5 }, balanced: { mean: 4.2 } };
  assert.deepEqual(verdict([ok]), []);
  assert.match(verdict([{ ...ok, high: { median: 34 } }])[0], /cannot hold 30 frames a second/);
  assert.match(verdict([{ ...ok, renderer: 'Google SwiftShader' }])[0], /software renderer/);
  assert.match(verdict([{ ...ok, renderer: null }])[0], /WebGL2 is not available/);
  assert.deepEqual(verdict([{ ...ok, width: 1920, height: 1080, high: { median: 40 } }]), []);
});

test('each size is described in one line', () => {
  const line = describe({ width: 1440, height: 900, dpr: 2, size: { width: 2880, height: 1800 }, high: { median: 7.5, p90: 10, passes: { holeMs: 6.5, bloomMs: 0.6, finalMs: 0.7 } }, balanced: { mean: 4.2 } });
  assert.equal(line, '1440 × 900 at 2x (2880 × 1800): High 7.5 ms median (90th percentile 10.0 ms), Balanced 4.2 ms a frame on average; black hole 6.5, bloom 0.6, final 0.7 ms. At 30 fps the GPU is busy about 23% of the time on High and 13% on Balanced.');
});
