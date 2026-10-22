import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../engine/fake-engine.mjs';
import { createHub } from '../server/hub.mjs';
import { exampleSnapshot } from './helpers/ui.mjs';

/** A fake page request and response. block(fn) decides which writes the socket takes; drain() empties it. */
function exchange() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  let accept = () => true;
  Object.assign(res, {
    frames: [], status: null, headers: null, ended: false, destroyed: false, writableLength: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    write(text) { this.frames.push(text); const ok = accept(text); if (!ok) this.writableLength += Buffer.byteLength(text); return ok; },
    end(text) { if (text) this.frames.push(text); this.ended = true; },
    destroy() { this.destroyed = true; req.emit('close'); },
  });
  return { req, res, block: fn => { accept = fn; }, drain() { accept = () => true; res.writableLength = 0; res.emit('drain'); } };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const isSnapshot = frame => frame.startsWith('event: snapshot');
const dataOf = frame => JSON.parse(/^data: (.+)$/m.exec(frame)[1]);

async function until(predicate, timeoutMs = 1000) {
  for (let waited = 0; !predicate() && waited < timeoutMs; waited += 2) await wait(2);
  assert.ok(predicate(), 'the condition never held');
}

async function pushRevisions(engine, from, to) {
  for (let i = from; i <= to; i += 1) {
    const next = exampleSnapshot();
    next.revision = i;
    engine.push(next);
    await tick();
  }
}

test('a page that stops reading gets nothing more until it drains, then only the newest snapshot, stamped when written', async () => {
  let clock = 1000;
  const engine = createFakeEngine({ snapshots: [exampleSnapshot()] });
  const hub = createHub({ createEngine: () => engine, now: () => clock, heartbeatMs: 5, engineIdleMs: 10 });
  const page = exchange();
  try {
    page.block(text => !isSnapshot(text));
    hub.add(page.req, page.res);
    await until(() => page.res.frames.some(isSnapshot));
    const blockedAt = page.res.frames.length;
    await pushRevisions(engine, 1, 80);
    await wait(40);
    assert.deepEqual(page.res.frames.slice(blockedAt), [], 'nothing, not even a ping, is written to a page that is behind');

    clock = 2000;
    page.drain();
    await tick();
    const after = page.res.frames.slice(blockedAt);
    assert.ok(isSnapshot(after[0] ?? ''), `the first frame after drain is a snapshot, not ${JSON.stringify(after[0])}`);
    assert.equal(after.filter(isSnapshot).length, 1, 'only the newest snapshot waited');
    const data = dataOf(after[0]);
    assert.equal(data.snapshot.revision, 80);
    assert.equal(data.serverNow, 2000, 'serverNow is the time of writing');

    const drainedAt = page.res.frames.length;
    await until(() => page.res.frames.slice(drainedAt).includes(': ping\n\n'), 40);
  } finally {
    hub.close();
  }
});

test('a page that reads nothing for stallMs is dropped, and the engine is released as for a closed page', async () => {
  const logged = [];
  const engine = createFakeEngine({ snapshots: [exampleSnapshot()] });
  const hub = createHub({ createEngine: () => engine, stallMs: 20, engineIdleMs: 10, heartbeatMs: 1000, log: entry => logged.push(entry) });
  const page = exchange();
  try {
    page.block(text => !isSnapshot(text));
    hub.add(page.req, page.res);
    await until(() => page.res.frames.some(isSnapshot));
    await wait(80);
    assert.equal(page.res.destroyed, true);
    assert.equal(hub.clientCount(), 0);
    assert.deepEqual(logged, [{ level: 'warn', source: 'server', message: 'Dropped a live page that read nothing for 0 s; it reconnects by itself' }]);
    await wait(20);
    assert.equal(hub.hasEngine(), false);
  } finally {
    hub.close();
  }
});

test('pages beyond maxClients are refused with 503 and create no client', async () => {
  const logged = [];
  let created = 0;
  const engine = createFakeEngine({ snapshots: [exampleSnapshot()] });
  const hub = createHub({ createEngine: () => { created += 1; return engine; }, maxClients: 2, heartbeatMs: 1000, engineIdleMs: 10, log: entry => logged.push(entry) });
  const hello = page => page.res.frames.some(frame => frame.startsWith('event: hello'));
  const first = exchange();
  const second = exchange();
  try {
    hub.add(first.req, first.res);
    hub.add(second.req, second.res);
    await until(() => hello(first) && hello(second));

    const refused = exchange();
    await hub.add(refused.req, refused.res);
    assert.equal(refused.res.status, 503);
    assert.equal(refused.res.headers['Retry-After'], '5');
    assert.equal(refused.res.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.equal(refused.res.headers['Cache-Control'], 'no-store');
    assert.equal(refused.res.ended, true);
    assert.deepEqual(refused.res.frames, ['Too many live pages']);
    assert.equal(hub.clientCount(), 2);
    assert.equal(created, 1, 'a refused page creates no engine');

    const again = exchange();
    await hub.add(again.req, again.res);
    assert.equal(again.res.status, 503);
    assert.deepEqual(logged, [{ level: 'warn', source: 'server', message: 'Refused a live page: 2 are already connected' }], 'the refusal is logged once a minute');

    first.req.emit('close');
    const fourth = exchange();
    hub.add(fourth.req, fourth.res);
    assert.equal(fourth.res.status, 200);
    await until(() => hello(fourth));
    assert.equal(hub.clientCount(), 2);
  } finally {
    hub.close();
  }
});

test('a page that keeps reading gets every snapshot and every ping', async () => {
  const engine = createFakeEngine({ snapshots: [exampleSnapshot()] });
  const hub = createHub({ createEngine: () => engine, heartbeatMs: 5, engineIdleMs: 10 });
  const page = exchange();
  try {
    hub.add(page.req, page.res);
    await until(() => page.res.frames.some(isSnapshot));
    const before = page.res.frames.length;
    await pushRevisions(engine, 1, 5);
    await until(() => page.res.frames.slice(before).filter(isSnapshot).length >= 5);
    const revisions = page.res.frames.slice(before).filter(isSnapshot).map(frame => dataOf(frame).snapshot.revision);
    assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
    const pingsAt = page.res.frames.length;
    await until(() => page.res.frames.slice(pingsAt).includes(': ping\n\n'), 40);
  } finally {
    hub.close();
  }
});
