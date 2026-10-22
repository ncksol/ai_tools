import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CANVAS_TITLE, createCanvasHost, pageUrl } from '../server/canvas-host.mjs';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { probePort } from '../server/shared.mjs';
import { freePort, openEvents } from './helpers/http.mjs';
import { tempDir } from './helpers/temp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 3000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await pause(20);
  }
}
const demo = () => createDemoEngine({ simulate: false });
const host = (port, options = {}) => createCanvasHost({
  port,
  version: 'test',
  createEngine: demo,
  makeServer: ({ onIdle }) => createDashboardServer({ createEngine: demo, port, version: 'test', hub: { engineIdleMs: 60 }, onIdle }),
  watchdogMs: 40,
  jitterMs: 0,
  ...options,
});

test('the page address names the swarm from the input, else the session, and carries the plugin version when given', () => {
  assert.equal(pageUrl(7927, { sessionId: 'cli-1' }), 'http://127.0.0.1:7927/?host=canvas&session=cli-1');
  assert.equal(pageUrl(7927, { sessionId: 'cli-1', version: '0.2.0' }), 'http://127.0.0.1:7927/?host=canvas&session=cli-1&plugin=0.2.0');
  assert.equal(pageUrl(7927, { sessionId: 'cli-1', input: { swarm: 'ws-0000-root' }, version: '0.2.0' }), 'http://127.0.0.1:7927/?host=canvas&swarm=ws-0000-root&plugin=0.2.0');
  assert.equal(pageUrl(7927, { input: { swarm: '  ' }, version: '  ' }), 'http://127.0.0.1:7927/?host=canvas');
  assert.equal(pageUrl(7927, { sessionId: 'a b&c' }), 'http://127.0.0.1:7927/?host=canvas&session=a+b%26c');
});

test('nothing starts before a canvas opens', async () => {
  let calls = 0;
  const canvasHost = host(await freePort(), {
    makeServer: () => { calls += 1; },
    probe: async () => { calls += 1; return { state: 'free' }; },
  });
  await pause(100);
  canvasHost.onClose({ instanceId: 'never-opened' });
  await canvasHost.dispose();
  assert.equal(calls, 0);
  assert.equal(canvasHost.hosting(), false);
});

test('the first canvas hosts the server and later canvases reuse it', async () => {
  const port = await freePort();
  const first = host(port);
  const second = host(port);
  try {
    assert.deepEqual(await first.open({ sessionId: 'cli-1', instanceId: 'a' }), { url: `http://127.0.0.1:${port}/?host=canvas&session=cli-1&plugin=test`, title: CANVAS_TITLE });
    assert.equal(first.hosting(), true);
    assert.equal((await probePort(port)).state, 'ours');
    const reused = await second.open({ sessionId: 'cli-2', instanceId: 'b', input: { swarm: 'ws-0000-root' } });
    assert.equal(reused.url, `http://127.0.0.1:${port}/?host=canvas&swarm=ws-0000-root&plugin=test`);
    assert.equal(second.hosting(), false);
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    assert.equal(second.instanceCount(), 1, 'opening the same instance again only focuses it');
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test('a canvas that reuses an older dashboard says so in its log', async () => {
  const port = await freePort();
  const first = host(port);
  const entries = [];
  const second = host(port, { version: 'next', log: entry => entries.push(entry) });
  try {
    await first.open({ sessionId: 'cli-1', instanceId: 'a' });
    const opened = await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    assert.equal(opened.url, `http://127.0.0.1:${port}/?host=canvas&session=cli-2&plugin=next`);
    assert.ok(entries.some(entry => entry.level === 'warn' && entry.message.startsWith('version test of the dashboard')), JSON.stringify(entries));
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

test('another program on the port makes open() fail with port_in_use', async () => {
  const port = await freePort();
  const other = createServer((req, res) => res.end('hello'));
  await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
  const canvasHost = host(port);
  try {
    await assert.rejects(canvasHost.open({ sessionId: 'cli-1', instanceId: 'a' }), error => error.code === 'port_in_use' && error.message.includes(`Port ${port} is used by another program`));
    assert.equal(canvasHost.instanceCount(), 0);
  } finally {
    await canvasHost.dispose();
    other.closeAllConnections?.();
    await new Promise(resolve => other.close(() => resolve()));
  }
});

test('a sample-data dashboard on the port makes open() fail with port_in_use', async () => {
  const port = await freePort();
  const sample = createDashboardServer({ createEngine: demo, port, version: 'test', demo: 'example' });
  await sample.listen();
  const canvasHost = host(port);
  try {
    await assert.rejects(canvasHost.open({ sessionId: 'cli-1', instanceId: 'a' }), error => error.code === 'port_in_use' && error.message.includes('sample data'));
    assert.equal(canvasHost.instanceCount(), 0);
  } finally {
    await canvasHost.dispose();
    await sample.close();
  }
});

test('an open canvas takes the port over when the host goes away', async () => {
  const port = await freePort();
  const first = host(port);
  const second = host(port);
  try {
    await first.open({ sessionId: 'cli-1', instanceId: 'a' });
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    await first.dispose();
    await until(() => second.hosting());
    assert.equal((await probePort(port)).state, 'ours');
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

/** A host whose engines count their stop() calls. */
function countingHost(port, options = {}) {
  const counts = { stops: 0 };
  const createEngine = () => {
    const engine = demo();
    return { ...engine, stop() { counts.stops += 1; engine.stop(); } };
  };
  const canvasHost = host(port, { makeServer: ({ onIdle }) => createDashboardServer({ createEngine, port, version: 'test', hub: { engineIdleMs: 60 }, onIdle }), ...options });
  return { canvasHost, counts };
}

test('a host keeps serving while a page is connected and stops once nothing uses it', async () => {
  const port = await freePort();
  const { canvasHost, counts } = countingHost(port, { graceMs: 60 });
  try {
    await canvasHost.open({ sessionId: 'cli-0003-b1', instanceId: 'a' });
    const page = openEvents(port, '/api/events?session=cli-0003-b1');
    await page.waitFor(entry => entry.event === 'snapshot');
    canvasHost.onClose({ instanceId: 'a' });
    await pause(200);
    assert.equal(canvasHost.hosting(), true, 'a connected page keeps the server');
    page.close();
    await until(() => !canvasHost.hosting());
    assert.deepEqual(await probePort(port), { state: 'free' });
    assert.ok(counts.stops >= 1, 'the engine is stopped once the server has gone');
  } finally {
    await canvasHost.dispose();
  }
});

test('disposing a hosting canvas with a connected page closes the server and stops its engine', async () => {
  const port = await freePort();
  const { canvasHost, counts } = countingHost(port);
  let page = null;
  try {
    await canvasHost.open({ instanceId: 'a' });
    page = openEvents(port, '/api/events');
    await page.waitFor(entry => entry.event === 'snapshot');
    await canvasHost.dispose();
    assert.equal(canvasHost.hosting(), false);
    assert.deepEqual(await probePort(port), { state: 'free' });
    assert.ok(counts.stops >= 1, 'the engine is stopped');
  } finally {
    page?.close();
    await canvasHost.dispose();
  }
});

/** A host whose server waits to bind its port until the test opens the gate. */
function gatedHost(port, options = {}) {
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const makeServer = ({ onIdle }) => {
    const server = createDashboardServer({ createEngine: demo, port, version: 'test', hub: { engineIdleMs: 60 }, onIdle });
    const listen = server.listen;
    server.listen = async () => {
      await gate;
      return listen();
    };
    return server;
  };
  return { canvasHost: host(port, { makeServer, ...options }), openGate };
}

test('a canvas closed while its server starts lets the server go', async () => {
  const port = await freePort();
  const { canvasHost, openGate } = gatedHost(port, { graceMs: 60 });
  try {
    const opening = canvasHost.open({ instanceId: 'a' });
    canvasHost.onClose({ instanceId: 'a' });
    openGate();
    await opening;
    await until(async () => (await probePort(port)).state === 'free');
    assert.equal(canvasHost.hosting(), false);
    assert.equal(canvasHost.instanceCount(), 0);
  } finally {
    openGate();
    await canvasHost.dispose();
  }
});

test('a host disposed while a canvas opens refuses the open and frees the port', async () => {
  const port = await freePort();
  const { canvasHost, openGate } = gatedHost(port);
  try {
    const opening = canvasHost.open({ instanceId: 'a' });
    const disposing = canvasHost.dispose();
    openGate();
    await assert.rejects(opening, error => error.code === 'unavailable');
    await disposing;
    assert.deepEqual(await probePort(port), { state: 'free' });
  } finally {
    openGate();
    await canvasHost.dispose();
  }
});

test('a closed canvas stops watching the shared server', async () => {
  const port = await freePort();
  const first = host(port);
  let probes = 0;
  const second = host(port, { probe: async (...args) => { probes += 1; return probePort(...args); } });
  try {
    await first.open({ sessionId: 'cli-1', instanceId: 'a' });
    await second.open({ sessionId: 'cli-2', instanceId: 'b' });
    await until(() => probes >= 3);
    second.onClose({ instanceId: 'b' });
    const seen = probes;
    await pause(200);
    assert.ok(probes <= seen + 1, `${probes - seen} probes after the canvas closed`);
  } finally {
    await second.dispose();
    await first.dispose();
  }
});

// A stand-in for the SDK the Copilot runtime provides to extensions.
const SDK_STUB = `export class CanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const createCanvas = ({ open, onClose, ...declaration }) => ({ declaration, open, onClose });
export async function joinSession(config) {
  globalThis.swarmDashboardJoined = config;
  return {};
}
`;

/** Lay out a plugin copy whose extension resolves @github/copilot-sdk/extension to the stub. */
function stagedExtension() {
  const dir = tempDir('swarm-extension-');
  const sdk = path.join(dir, 'node_modules', '@github', 'copilot-sdk');
  mkdirSync(sdk, { recursive: true });
  writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@github/copilot-sdk', type: 'module', exports: { './extension': './extension.mjs' } }));
  writeFileSync(path.join(sdk, 'extension.mjs'), SDK_STUB);
  const plugin = path.join(dir, 'plugin');
  const folder = path.join(plugin, 'com.github.copilot', 'extensions', 'swarm-dashboard');
  mkdirSync(folder, { recursive: true });
  copyFileSync(path.join(root, 'com.github.copilot', 'extensions', 'swarm-dashboard', 'extension.mjs'), path.join(folder, 'extension.mjs'));
  copyFileSync(path.join(root, 'plugin.json'), path.join(plugin, 'plugin.json'));
  symlinkSync(path.join(root, 'server'), path.join(plugin, 'server'), 'dir');
  return pathToFileURL(path.join(folder, 'extension.mjs')).href;
}

test('the extension joins with one canvas that opens the shared page', async () => {
  const entry = stagedExtension();
  const port = await freePort();
  process.env.SWARM_DASHBOARD_PORT = String(port);
  const extension = await import(entry);
  try {
    const { canvases } = globalThis.swarmDashboardJoined;
    assert.equal(canvases.length, 1);
    const [canvas] = canvases;
    assert.equal(canvas.declaration.id, 'swarm-dashboard');
    assert.equal(canvas.declaration.displayName, 'Swarm dashboard');
    assert.deepEqual(canvas.declaration.inputSchema.required ?? [], [], 'the input stays optional');
    assert.equal(extension.canvasHost.hosting(), false, 'loading starts nothing');
    const pluginVersion = JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8')).version;
    const opened = await canvas.open({ sessionId: 'cli-0003-b1', extensionId: 'test', canvasId: 'swarm-dashboard', instanceId: 'one' });
    assert.deepEqual(opened, { url: `http://127.0.0.1:${port}/?host=canvas&session=cli-0003-b1&plugin=${pluginVersion}`, title: 'Swarm dashboard' });
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(health.app, 'swarm-dashboard');
    assert.equal(health.version, pluginVersion);
    assert.match(await (await fetch(opened.url)).text(), /id="dash"/);
    canvas.onClose({ instanceId: 'one' });
  } finally {
    await extension.canvasHost.dispose();
    delete process.env.SWARM_DASHBOARD_PORT;
  }
});

test('a bad SWARM_DASHBOARD_PORT is reported when the canvas opens', async () => {
  process.env.SWARM_DASHBOARD_PORT = 'abc';
  try {
    const extension = await import(`${stagedExtension()}?bad-port`);
    assert.equal(extension.canvasHost, null);
    const [canvas] = globalThis.swarmDashboardJoined.canvases;
    await assert.rejects(canvas.open({ sessionId: 'cli-1', instanceId: 'one' }), error => error.code === 'bad_port' && /SWARM_DASHBOARD_PORT/.test(error.message));
  } finally {
    delete process.env.SWARM_DASHBOARD_PORT;
  }
});
