import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FPS_CAP, POINTER_MS, STORE_KEY, createAdaptive, drawsHole, frameDue, loopRuns, readQuality, saveQuality } from '../ui/cockpit-quality.mjs';

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = String(value); }, data };
};

test('High is the default; a saved choice is remembered; the address can override it for checks', () => {
  assert.equal(readQuality(() => memory(), null), 'high');
  assert.equal(readQuality(() => memory({ [STORE_KEY]: '{"quality":"balanced"}' }), null), 'balanced');
  assert.equal(readQuality(() => memory({ [STORE_KEY]: '{"quality":"balanced"}' }), 'high'), 'high');
  assert.equal(readQuality(() => memory({ [STORE_KEY]: 'not json' }), 'ultra'), 'high');
  assert.equal(readQuality(() => { throw new Error('denied'); }, null), 'high');
  const store = memory();
  saveQuality(() => store, 'balanced');
  assert.equal(store.data[STORE_KEY], '{"quality":"balanced"}');
  assert.doesNotThrow(() => saveQuality(() => { throw new Error('denied'); }, 'high'));
});

test('frames are capped at 30 per second', () => {
  assert.equal(FPS_CAP, 30);
  assert.equal(frameDue(1000, null), true);
  assert.equal(frameDue(1031.3, 1000), false);
  assert.equal(frameDue(1031.4, 1000), true);
});

test('High redraws the black hole every frame; Balanced every second frame, and every frame just after the pointer moves', () => {
  assert.equal(drawsHole('high', 1, 0, -Infinity), true);
  assert.equal(drawsHole('balanced', 2, 10000, -Infinity), true);
  assert.equal(drawsHole('balanced', 3, 10000, -Infinity), false);
  assert.equal(drawsHole('balanced', 3, 10000, 10000 - POINTER_MS + 1), true);
  assert.equal(drawsHole('balanced', 3, 10000, 10000 - POINTER_MS), false);
});

test('the loop stops while hidden and under reduced motion', () => {
  assert.equal(loopRuns({ hidden: false, reduced: false }), true);
  assert.equal(loopRuns({ hidden: true, reduced: false }), false);
  assert.equal(loopRuns({ hidden: false, reduced: true }), false);
});

test('the adaptive fallback lowers the resolution in 0.1 steps to 0.5 while the cap is not held, and never during warm-up', () => {
  const slow = createAdaptive();
  const drops = [];
  for (let frame = 1; frame <= 600; frame += 1) {
    const scale = slow.frame(frame === 1 ? null : 50);
    if (scale !== null) drops.push([frame, scale]);
  }
  assert.deepEqual(drops, [[120, 0.9], [180, 0.8], [240, 0.7], [300, 0.6], [360, 0.5]]);
  assert.equal(slow.scale, 0.5);
  const steady = createAdaptive();
  for (let frame = 1; frame <= 600; frame += 1) assert.equal(steady.frame(1000 / 30), null);
  const paused = createAdaptive();
  for (let frame = 1; frame <= 119; frame += 1) paused.frame(50);
  paused.reset();
  assert.equal(paused.frame(50), null, 'a reset needs new samples before the next step');
});
