import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINAL, HOLE, PREFILTER, SCENE, UP, VERTEX, DOWN } from '../ui/cockpit-shaders.mjs';
import { SCENE_LIMITS, analyseFrame, sceneProblems } from '../scripts/lib/cockpit-scene.mjs';
import { USAGE, parseArguments } from '../scripts/check-cockpit.mjs';

test('every shader is GLSL ES 3.00 with its constants filled in', () => {
  for (const source of [VERTEX, HOLE, PREFILTER, DOWN, UP, FINAL]) {
    assert.match(source, /^#version 300 es\n/);
    assert.doesNotMatch(source, /\$\{|undefined|NaN/);
  }
  for (const source of [HOLE, PREFILTER, DOWN, UP, FINAL]) assert.match(source, /precision highp float;/);
  assert.match(HOLE, /const float R0 = 21\.0;/);
  assert.match(HOLE, /const int MAX_STEPS = 380;/);
  assert.match(HOLE, /abs\(b - 2\.66\) < 0\.22/);
  assert.match(FINAL, /const float RC = 1500\.0;/);
  assert.equal(SCENE.bloomLevels, 6);
});

/** A synthetic frame: dark sky, a peach ceiling arc, stars on the left, a ring and disk around a black shadow, a dark desk. */
function syntheticFrame({ width = 240, height = 150, stars = 40 } = {}) {
  const data = new Uint8Array(width * height * 4);
  const set = (x, y, [r, g, b]) => { const i = (y * width + x) * 4; data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) set(x, y, [6, 7, 12]);
  for (let x = 0; x < width; x += 1) set(x, 4 + Math.round(((x - width / 2) / width) ** 2 * 20), [230, 170, 150]);
  for (let k = 0; k < stars; k += 1) set(4 + ((k * 37) % 50), 20 + ((k * 23) % 40), [255, 250, 240]);
  for (let x = 60; x < 180; x += 1) for (let y = 70; y < 80; y += 1) set(x, y, [250, 190, 140]);
  for (let y = 41; y < 70; y += 1) for (let x = 100; x < 140; x += 1) set(x, y, [0, 0, 0]);
  for (let y = 80; y < 110; y += 1) for (let x = 100; x < 140; x += 1) set(x, y, [0, 0, 0]);
  for (let x = 100; x < 140; x += 1) { set(x, 40, [255, 230, 200]); set(x, 110, [255, 230, 200]); }
  return { width, height, data };
}

test('the frame analysis finds the shadow, the ceiling line, the stars and the desk', () => {
  const metrics = analyseFrame(syntheticFrame());
  assert.ok(metrics.shadow > 0.15, `shadow ${metrics.shadow}`);
  assert.ok(metrics.peach > 0.9, `peach ${metrics.peach}`);
  assert.ok(metrics.stars >= 30, `stars ${metrics.stars}`);
  assert.ok(metrics.desk < 0.05, `desk ${metrics.desk}`);
  assert.deepEqual(sceneProblems(metrics, { ...SCENE_LIMITS, mean: [0, 1] }), []);
});

test('a frame without stars fails the stars check, though its ceiling line is bright', () => {
  const metrics = analyseFrame(syntheticFrame({ stars: 0 }));
  assert.equal(metrics.stars, 0);
  const problems = sceneProblems(metrics, { ...SCENE_LIMITS, mean: [0, 1] });
  assert.ok(problems.some(problem => problem.includes('stars')), problems.join('; '));
});

test('a black frame fails every structural check', () => {
  const width = 120;
  const height = 80;
  const problems = sceneProblems(analyseFrame({ width, height, data: new Uint8Array(width * height * 4) }));
  for (const word of ['brightness', 'shadow', 'ceiling', 'stars']) assert.ok(problems.some(problem => problem.includes(word)), `${word} in ${problems.join('; ')}`);
});

test('the cockpit check takes an engine, a check name and a metrics switch', () => {
  assert.deepEqual(parseArguments([]), { engine: 'chrome', only: null, printMetrics: false, help: false });
  assert.deepEqual(parseArguments(['--engine', 'webkit', '--only', 'scene', '--print-metrics']), { engine: 'webkit', only: 'scene', printMetrics: true, help: false });
  assert.throws(() => parseArguments(['--only', 'everything']), /--only takes/);
  assert.match(USAGE, /^Usage: check-cockpit/);
});
