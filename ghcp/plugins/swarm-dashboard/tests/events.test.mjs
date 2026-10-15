import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTail, readNewLines } from '../engine/readers/events.mjs';
import { tempDir } from './helpers/temp.mjs';

const dir = tempDir('swarm-events-');

async function collect(tail, options) {
  const received = [];
  const result = await readNewLines(tail, line => received.push(line), options);
  return { received, ...result };
}

test('reads complete lines and holds back a partial last line', async () => {
  const file = path.join(dir, 'a.jsonl');
  writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":');
  const tail = createTail(file);
  let read = await collect(tail);
  assert.deepEqual(read.received, ['{"n":1}', '{"n":2}']);
  assert.equal(read.reset, false);
  appendFileSync(file, '3}\r\n\n');
  read = await collect(tail);
  assert.deepEqual(read.received, ['{"n":3}']);
  read = await collect(tail);
  assert.deepEqual(read, { received: [], missing: false, reset: false, lines: 0, bytes: 0 });
});

test('multi-byte characters split across chunks survive', async () => {
  const file = path.join(dir, 'b.jsonl');
  writeFileSync(file, `${JSON.stringify({ text: 'café – 日本' })}\n`);
  const tail = createTail(file);
  const read = await collect(tail, { chunkSize: 3 });
  assert.deepEqual(read.received.map(line => JSON.parse(line).text), ['café – 日本']);
});

test('a shrunk file restarts from the beginning, calling onReset before any line', async () => {
  const file = path.join(dir, 'c.jsonl');
  writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const tail = createTail(file);
  await collect(tail);
  truncateSync(file, 0);
  appendFileSync(file, '{"n":9}\n');
  const order = [];
  const result = await readNewLines(tail, line => order.push(line), { onReset: () => order.push('reset') });
  assert.equal(result.reset, true);
  assert.deepEqual(order, ['reset', '{"n":9}']);
});

test('a replaced file restarts from the beginning and reports a reset', async () => {
  const file = path.join(dir, 'd.jsonl');
  writeFileSync(file, '{"n":1}\n');
  const tail = createTail(file);
  await collect(tail);
  const replacement = path.join(dir, 'd-new.jsonl');
  writeFileSync(replacement, '{"n":1}\n{"n":2}\n');
  renameSync(replacement, file);
  const read = await collect(tail);
  assert.equal(read.reset, true);
  assert.deepEqual(read.received, ['{"n":1}', '{"n":2}']);
});

test('a missing file reports missing without throwing', async () => {
  const read = await collect(createTail(path.join(dir, 'none.jsonl')));
  assert.equal(read.missing, true);
  assert.deepEqual(read.received, []);
});
