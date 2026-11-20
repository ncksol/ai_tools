import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { DEFAULT_PORT, listenShared, probePort, resolvePort } from '../server/shared.mjs';
import { freePort } from './helpers/http.mjs';

const dashboard = port => createDashboardServer({ createEngine: () => createDemoEngine({ simulate: false }), port, version: 'test' });
const listen = (server, port) => new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const close = server => new Promise(resolve => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

test('the port is 7927 unless SWARM_DASHBOARD_PORT says otherwise', () => {
  assert.equal(DEFAULT_PORT, 7927);
  assert.equal(resolvePort({}), 7927);
  assert.equal(resolvePort({ SWARM_DASHBOARD_PORT: '8123' }), 8123);
  assert.throws(() => resolvePort({ SWARM_DASHBOARD_PORT: 'abc' }), /SWARM_DASHBOARD_PORT/);
  assert.throws(() => resolvePort({ SWARM_DASHBOARD_PORT: '70000' }), /SWARM_DASHBOARD_PORT/);
});

test('the probe tells a free port, our dashboard, another program and a silent listener apart', async () => {
  const port = await freePort();
  assert.deepEqual(await probePort(port), { state: 'free' });
  const ours = dashboard(port);
  await ours.listen();
  try {
    const found = await probePort(port);
    assert.equal(found.state, 'ours');
    assert.equal(found.health.version, 'test');
  } finally {
    await ours.close();
  }
  const other = createServer((req, res) => res.end('hello'));
  await listen(other, port);
  try {
    assert.deepEqual(await probePort(port), { state: 'other' });
  } finally {
    await close(other);
  }
  const sockets = new Set();
  const silent = createTcpServer(socket => sockets.add(socket));
  await listen(silent, port);
  try {
    assert.deepEqual(await probePort(port, { timeoutMs: 200 }), { state: 'unresponsive' });
  } finally {
    // A timed-out fetch leaves its socket open, so close the server's side before closing the server.
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => silent.close(() => resolve()));
  }
});

test('a program holding the port on every address counts as taken, not as a free loopback port', async () => {
  const port = await freePort();
  const other = createServer((req, res) => res.end('hello'));
  await new Promise(resolve => other.listen(port, '0.0.0.0', resolve));
  try {
    assert.deepEqual(await listenShared({ port, makeServer: () => dashboard(port) }), { status: 'taken' });
  } finally {
    await close(other);
  }
});

test('listenShared starts a server, finds a running dashboard, or reports a taken port', async () => {
  const port = await freePort();
  const first = await listenShared({ port, makeServer: () => dashboard(port) });
  assert.equal(first.status, 'started');
  try {
    const second = await listenShared({ port, makeServer: () => dashboard(port) });
    assert.equal(second.status, 'running');
    assert.equal(second.health.app, 'swarm-dashboard');
  } finally {
    await first.server.close();
  }
  const other = createServer((req, res) => res.end('hello'));
  await listen(other, port);
  try {
    assert.deepEqual(await listenShared({ port, makeServer: () => dashboard(port) }), { status: 'taken' });
  } finally {
    await close(other);
  }
});

test('a listener that redirects its health check is another program, and the redirect is not followed', async () => {
  let hits = 0;
  const target = createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'swarm-dashboard', version: 'test' }));
  });
  const targetPort = await freePort();
  await listen(target, targetPort);
  const foreign = createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/api/health` });
    res.end();
  });
  const foreignPort = await freePort();
  await listen(foreign, foreignPort);
  try {
    assert.deepEqual(await probePort(foreignPort), { state: 'other' });
    assert.equal(hits, 0);
    assert.deepEqual(await listenShared({ port: foreignPort, makeServer: () => { throw new Error('must not bind'); } }), { status: 'taken' });
    assert.equal(hits, 0);
    assert.equal((await probePort(targetPort)).state, 'ours');
    assert.equal(hits, 1);
  } finally {
    await close(foreign);
    await close(target);
  }
});

/** A listener that answers the health check as our dashboard with these fields. */
async function holder(port, fields) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app: 'swarm-dashboard', version: 'test', pool: 'ok', refreshStartedAt: null, ...fields }));
  });
  await listen(server, port);
  return server;
}

test('health from a real dashboard reports the pool and its refresh times', async () => {
  const port = await freePort();
  const ours = dashboard(port);
  await ours.listen();
  try {
    const found = await probePort(port);
    assert.equal(found.state, 'ours');
    assert.equal(found.health.pool, 'ok');
    assert.ok('lastRefreshAt' in found.health && 'refreshStartedAt' in found.health);
  } finally {
    await ours.close();
  }
});

test('a dashboard whose pool check failed, or whose refresh has run too long, is not reused', async () => {
  const port = await freePort();
  const cases = [
    [{ pool: 'broken' }, 'broken'],
    [{ refreshStartedAt: Date.now() - 10 * 60000 }, 'stale'],
  ];
  for (const [fields, reason] of cases) {
    const stuck = await holder(port, fields);
    try {
      const found = await probePort(port);
      assert.equal(found.state, 'unresponsive', reason);
      assert.equal(found.reason, reason);
      assert.equal(found.health.app, 'swarm-dashboard');
      const result = await listenShared({ port, makeServer: () => dashboard(port), pauseMs: 10 });
      assert.equal(result.status, 'unresponsive', reason);
      assert.equal(result.reason, reason);
    } finally {
      await close(stuck);
    }
  }
  const busy = await holder(port, { refreshStartedAt: Date.now() - 1000 });
  try {
    assert.equal((await probePort(port)).state, 'ours', 'a refresh that started a moment ago is normal');
  } finally {
    await close(busy);
  }
});

test('listenShared takes the port once a broken dashboard lets it go', async () => {
  const port = await freePort();
  const broken = await holder(port, { pool: 'broken' });
  setTimeout(() => { close(broken); }, 50);
  const result = await listenShared({ port, makeServer: () => dashboard(port), pauseMs: 100, attempts: 10 });
  try {
    assert.equal(result.status, 'started');
  } finally {
    await result.server?.close();
    await close(broken);
  }
});
