import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HOUR, MINUTE, formatDuration, maxTime, minTime, parseTime } from '../engine/time.mjs';
import { clip, firstLine, oneLine, ownString } from '../engine/text.mjs';
import { DEFAULT_THRESHOLDS, copilotPaths, resolveThresholds } from '../engine/config.mjs';

test('parseTime reads ISO, SQLite UTC and epoch values', () => {
  assert.equal(parseTime('2026-10-15T12:00:00.000Z'), 1792065600000);
  assert.equal(parseTime('2026-10-15T13:00:00+01:00'), 1792065600000);
  assert.equal(parseTime('2026-10-15 12:00:00'), 1792065600000);
  assert.equal(parseTime(1792065600000), 1792065600000);
  for (const bad of [null, undefined, '', 'yesterday', Number.NaN, {}]) assert.equal(parseTime(bad), null);
});

test('maxTime and minTime ignore missing values', () => {
  assert.equal(maxTime(null, 5, 9, undefined), 9);
  assert.equal(minTime(null, 5, 9), 5);
  assert.equal(maxTime(null), null);
});

test('formatDuration uses minutes, then hours and minutes', () => {
  assert.equal(formatDuration(23 * MINUTE), '23 min');
  assert.equal(formatDuration(2 * HOUR + 5 * MINUTE), '2 h 5 min');
  assert.equal(formatDuration(2 * HOUR), '2 h');
});

test('text helpers flatten, clip and copy', () => {
  assert.equal(ownString('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(ownString('short'), 'short');
  assert.equal(ownString(''), '');
  assert.equal(oneLine('  a\n  b\tc  '), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip(42, 4), null);
  assert.equal(firstLine('\n\n  first \nsecond'), 'first');
  assert.equal(firstLine(''), null);
});

test('thresholds default to the design values and accept overrides', () => {
  assert.equal(DEFAULT_THRESHOLDS.modelCallStuckMs, 10 * MINUTE);
  assert.equal(DEFAULT_THRESHOLDS.runFinishedAfterMs, 2 * HOUR);
  assert.equal(resolveThresholds({ silentBusyMs: 60_000 }).silentBusyMs, 60_000);
  assert.throws(() => resolveThresholds({ nope: 1 }), /Unknown threshold nope/);
  assert.throws(() => resolveThresholds({ silentBusyMs: -1 }), /non-negative/);
});

test('thresholds accept only their own keys, not inherited member names', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.throws(() => resolveThresholds({ [name]: 1 }), new RegExp(`Unknown threshold ${name}$`));
  }
});

test('copilotPaths derives every location from one home', () => {
  const paths = copilotPaths('/home/user/.copilot');
  assert.equal(paths.dataDb, path.join('/home/user/.copilot', 'data.db'));
  assert.equal(paths.historyDir, path.join('/home/user/.copilot', 'swarm-dashboard', 'history'));
});
