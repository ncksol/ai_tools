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

test('an unfinished line never keeps more than maxLineBytes, and is skipped once it ends', async () => {
  const file = path.join(dir, 'e.jsonl');
  writeFileSync(file, '{"n":1}\n');
  const tail = createTail(file);
  const options = { chunkSize: 10, maxLineBytes: 32 };
  assert.deepEqual((await collect(tail, options)).received, ['{"n":1}']);
  appendFileSync(file, 'x'.repeat(20));
  let read = await collect(tail, options);
  assert.equal(tail.pendingBytes, 20);
  assert.equal(read.skipped ?? 0, 0);
  for (let i = 0; i < 4; i += 1) {
    appendFileSync(file, 'y'.repeat(25));
    read = await collect(tail, options);
    assert.ok(tail.pendingBytes <= 32, `kept ${tail.pendingBytes} bytes`);
    assert.deepEqual(read.received, []);
    assert.equal(read.skipped ?? 0, 0, 'a line that has not ended is not reported yet');
  }
  appendFileSync(file, 'z'.repeat(5));
  appendFileSync(file, '\n{"n":2}\n{"n":3}\n');
  read = await collect(tail, options);
  assert.deepEqual(read.received, ['{"n":2}', '{"n":3}']);
  assert.equal(read.skipped, 1);
  assert.equal(read.skippedBytes, 20 + 100 + 5 + 1);
  assert.equal(tail.pendingBytes, 0);
});

test('an oversized line that ends inside the same chunk is skipped and the lines around it are kept', async () => {
  const file = path.join(dir, 'f.jsonl');
  writeFileSync(file, `{"n":1}\n${'x'.repeat(100)}\n{"n":2}\n${'y'.repeat(40)}\n{"n":3}\n`);
  const read = await collect(createTail(file), { maxLineBytes: 32 });
  assert.deepEqual(read.received, ['{"n":1}', '{"n":2}', '{"n":3}']);
  assert.equal(read.skipped, 2);
});

test('a line just under the limit, split over many chunks with multi-byte characters, arrives intact', async () => {
  const file = path.join(dir, 'g.jsonl');
  let text = '';
  while (Buffer.byteLength(JSON.stringify({ text })) < 990) text += 'é日🙂';
  const line = JSON.stringify({ text });
  assert.ok(Buffer.byteLength(line) <= 1000 && Buffer.byteLength(line) >= 990);
  writeFileSync(file, `${line}\r\n{"n":2}\n`);
  const tail = createTail(file);
  const read = await collect(tail, { chunkSize: 7, maxLineBytes: 1000 });
  assert.deepEqual(read.received, [line, '{"n":2}']);
  assert.equal(read.skipped ?? 0, 0);
});

test('a reset clears the pending partial line and the skip state', async () => {
  const file = path.join(dir, 'h.jsonl');
  writeFileSync(file, 'x'.repeat(100));
  const tail = createTail(file);
  await collect(tail, { maxLineBytes: 32 });
  assert.equal(tail.pendingBytes, 0);
  writeFileSync(file, '{"n":5}\n');
  const read = await collect(tail, { maxLineBytes: 32 });
  assert.equal(read.reset, true);
  assert.deepEqual(read.received, ['{"n":5}']);
  assert.equal(read.skipped ?? 0, 0);
  writeFileSync(file, '{"n":6');
  await collect(tail, { maxLineBytes: 32 });
  assert.equal(tail.pendingBytes, 6);
  writeFileSync(file, '{}\n');
  const again = await collect(tail, { maxLineBytes: 32 });
  assert.equal(again.reset, true);
  assert.deepEqual(again.received, ['{}']);
  assert.equal(tail.pendingBytes, 0);
});
