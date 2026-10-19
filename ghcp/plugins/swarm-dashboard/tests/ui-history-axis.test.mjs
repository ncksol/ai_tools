import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, MIN } from '../ui/format.mjs';
import { runHtml } from '../ui/history.mjs';
import { fixture } from './helpers/ui.mjs';

function axisTicks(tookMs) {
  const summary = fixture('example-run-summary.json');
  const html = runHtml({ ...summary, tookMs, finishedAt: summary.startedAt + tookMs });
  const axis = html.match(/<div class="g-axis"><div><\/div><div>(.*?)<\/div><div><\/div><\/div>/)[1];
  return [...axis.matchAll(/<span style="left:([\d.]+)%">([^<]+)<\/span>/g)].map(([, left, label]) => ({ left: Number(left), label }));
}

const labels = tookMs => axisTicks(tookMs).map(tick => tick.label);

test('a 26-minute run gets a minute axis, not a lone "0h"', () => {
  assert.deepEqual(labels(26 * MIN), ['0m', '5m', '10m', '15m', '20m', '25m']);
});

test('the axis tick units fit the run length', () => {
  assert.deepEqual(labels(45 * 1000), ['0s', '10s', '20s', '30s', '40s']);
  assert.deepEqual(labels(4 * MIN), ['0m', '1m', '2m', '3m', '4m']);
  assert.deepEqual(labels(70 * MIN), ['0m', '15m', '30m', '45m', '1h']);
  assert.deepEqual(labels(150 * MIN), ['0m', '30m', '1h', '1h 30m', '2h', '2h 30m']);
  assert.deepEqual(labels(6 * HOUR), ['0h', '1h', '2h', '3h', '4h', '5h', '6h']);
  assert.deepEqual(labels(20 * HOUR), ['0h', '4h', '8h', '12h', '16h', '20h']);
  assert.deepEqual(labels(72 * HOUR + 10 * MIN), ['0h', '12h', '24h', '36h', '48h', '60h', '72h']);
});

test('every run of a minute or more has at least two ticks, all inside the track', () => {
  for (const tookMs of [MIN, 7 * MIN, 26 * MIN, 59 * MIN, 61 * MIN, 5 * HOUR + 59 * MIN, 30 * HOUR, 300 * HOUR]) {
    const ticks = axisTicks(tookMs);
    assert.ok(ticks.length >= 2 && ticks.length <= 8, `${tookMs}: ${ticks.length} ticks`);
    assert.equal(ticks[0].left, 0);
    for (const tick of ticks) assert.ok(tick.left <= 100, `${tookMs}: ${tick.label} at ${tick.left}%`);
  }
});
