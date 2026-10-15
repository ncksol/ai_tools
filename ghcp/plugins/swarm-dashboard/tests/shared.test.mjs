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
