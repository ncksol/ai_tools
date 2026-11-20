import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoolCheck } from '../server/pool-check.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('passedSince holds only once a check that started at or after that time has finished', async () => {
  let finish;
  const check = createPoolCheck({ probe: () => new Promise(resolve => { finish = resolve; }), intervalMs: 5, timeoutMs: 10000 });
  const asked = Date.now();
  check.start();
  try {
    await pause(30);
    assert.equal(check.state(), 'ok');
    assert.equal(check.passedSince(asked), false, 'the first check has not finished');
    finish();
    await pause(30);
    assert.equal(check.passedSince(asked), true);
    assert.equal(check.passedSince(Date.now() + 1000), false, 'no check started after a later time');
  } finally {
    check.stop();
  }
});

test('a check that does not finish in time marks the pool broken once and stops checking', async () => {
  let probes = 0;
  const broken = [];
  const check = createPoolCheck({ probe: () => { probes += 1; return new Promise(() => {}); }, intervalMs: 5, timeoutMs: 20, onBroken: () => broken.push(Date.now()) });
  check.start();
  await pause(120);
  assert.equal(check.state(), 'broken');
  assert.equal(broken.length, 1);
  assert.equal(probes, 1, 'checks never overlap, and none follows a break');
  assert.equal(check.passedSince(0), false);
  check.stop();
});
