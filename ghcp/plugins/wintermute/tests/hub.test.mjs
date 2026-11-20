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
const isHeartbeat = frame => frame.startsWith('event: heartbeat');
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
    assert.deepEqual(page.res.frames.slice(blockedAt), [], 'nothing, not even a heartbeat, is written to a page that is behind');

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
    await until(() => page.res.frames.slice(drainedAt).some(isHeartbeat), 40);
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

test('a page that keeps reading gets every snapshot and every heartbeat', async () => {
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
    const heartbeatsAt = page.res.frames.length;
    await until(() => page.res.frames.slice(heartbeatsAt).some(isHeartbeat), 40);
  } finally {
    hub.close();
  }
});

/** An engine whose refresh never finishes, and whose status says it has been in stage since startedAt (wall-clock ms). */
function stuckEngine(stage, startedAt, counts) {
  const engine = createFakeEngine({ snapshots: [exampleSnapshot()] });
  return {
    ...engine,
    refresh: () => new Promise(() => {}),
    getSnapshot: () => new Promise(() => {}),
    stop() { counts.stops += 1; },
    status: () => ({ stage, refreshStartedAt: startedAt, lastRefreshAt: null }),
  };
}

test('a refresh that runs past the limit while the pool answers is logged with its stage, and the engine is replaced', async () => {
  const logged = [];
  const counts = { stops: 0, starts: 0 };
  const fresh = createFakeEngine({ snapshots: [exampleSnapshot()] });
  const engines = [stuckEngine('costs', Date.now() - 10000, counts), { ...fresh, start() { counts.starts += 1; } }];
  let created = 0;
  const sinceAsked = [];
  const hub = createHub({
    createEngine: () => engines[created++],
    refreshLimitMs: 50, refreshCheckMs: 5, poolPassedSince: since => { sinceAsked.push(since); return true; },
    heartbeatMs: 1000, engineIdleMs: 10, log: entry => logged.push(entry),
  });
  const page = exchange();
  try {
    hub.add(page.req, page.res);
    await until(() => page.res.frames.some(isSnapshot));
    assert.equal(created, 2, 'a second engine was created');
    assert.ok(counts.stops >= 1, 'the stuck engine was stopped');
    assert.ok(counts.starts >= 1, 'the new engine polls, so later refreshes run');
    assert.ok(sinceAsked.length >= 1, 'the pool was asked about the time since the refresh started');
    const warning = logged.find(entry => entry.level === 'warn' && /stuck/.test(entry.message));
    assert.ok(warning, `a warning names the stuck refresh: ${JSON.stringify(logged)}`);
    assert.match(warning.message, /costs/);
    assert.ok(page.res.frames.some(frame => frame.startsWith('event: hello')));
  } finally {
    hub.close();
  }
});

test('a long refresh is not replaced while the pool check has not passed since it started', async () => {
  const counts = { stops: 0 };
  let created = 0;
  const hub = createHub({
    createEngine: () => { created += 1; return stuckEngine('data.db', Date.now() - 10000, counts); },
    refreshLimitMs: 50, refreshCheckMs: 5, poolPassedSince: () => false, heartbeatMs: 1000, engineIdleMs: 10,
  });
  const page = exchange();
  try {
    hub.add(page.req, page.res);
    await wait(80);
    assert.equal(created, 1);
    assert.equal(counts.stops, 0);
    assert.equal(page.res.frames.some(isSnapshot), false);
  } finally {
    hub.close();
  }
});

test('hello carries the poll interval and last refresh, and heartbeats carry the last refresh time', async () => {
  const engine = { ...createFakeEngine({ snapshots: [exampleSnapshot()] }), status: () => ({ stage: null, refreshStartedAt: null, lastRefreshAt: 4242 }) };
  const hub = createHub({ createEngine: () => engine, now: () => 5000, intervalMs: 3000, heartbeatMs: 5, engineIdleMs: 10 });
  const page = exchange();
  try {
    assert.deepEqual(hub.status(), { stage: null, refreshStartedAt: null, lastRefreshAt: null }, 'no engine, no refresh');
    hub.add(page.req, page.res);
    await until(() => page.res.frames.some(isSnapshot));
    const hello = dataOf(page.res.frames.find(frame => frame.startsWith('event: hello')));
    assert.equal(hello.pollMs, 3000);
    assert.equal(hello.refreshedAt, 4242);
    await until(() => page.res.frames.some(isHeartbeat), 200);
    assert.deepEqual(dataOf(page.res.frames.find(isHeartbeat)), { serverNow: 5000, refreshedAt: 4242 });
    assert.deepEqual(hub.status(), { stage: null, refreshStartedAt: null, lastRefreshAt: 4242 });
  } finally {
    hub.close();
  }
});
