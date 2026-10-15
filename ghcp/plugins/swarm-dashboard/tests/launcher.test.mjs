import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main, parseArguments } from '../scripts/swarm-dashboard.mjs';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { freePort } from './helpers/http.mjs';

const sink = () => {
  const out = { text: '', write(chunk) { out.text += chunk; return true; } };
  return out;
};

test('arguments: port, demo scenario, still and help', () => {
  assert.deepEqual(parseArguments([], {}), { port: 7927, demo: null, still: false, help: false });
  assert.deepEqual(parseArguments(['--port', '8100', '--demo', 'stress', '--still'], {}), { port: 8100, demo: 'stress', still: true, help: false });
  assert.equal(parseArguments(['--demo'], {}).demo, 'example');
  assert.equal(parseArguments(['--port=9001'], {}).port, 9001);
  assert.equal(parseArguments([], { SWARM_DASHBOARD_PORT: '8200' }).port, 8200);
  assert.equal(parseArguments(['--help'], {}).help, true);
  assert.throws(() => parseArguments(['--nope'], {}), /Unknown option/);
  assert.throws(() => parseArguments(['--port', 'x'], {}), /port/);
  assert.throws(() => parseArguments(['--still'], {}), /--still/);
});

test('the launcher serves the dashboard until it is stopped', async () => {
  const port = await freePort();
  const stdout = sink();
  const stop = new AbortController();
  const running = main(['--port', String(port), '--demo', '--still'], { stdout, stderr: sink(), signal: stop.signal });
  const start = Date.now();
  while (!stdout.text.includes('Press Ctrl+C') && Date.now() - start < 3000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(stdout.text.includes(`Swarm dashboard (sample data: example): http://127.0.0.1:${port}/`), stdout.text);
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.app, 'swarm-dashboard');
  stop.abort();
  assert.equal(await running, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
});

test('a second launch reuses the running dashboard; another program on the port is an error', async () => {
  const port = await freePort();
  const ours = createDashboardServer({ createEngine: () => createDemoEngine({ simulate: false }), port, version: 'test' });
  await ours.listen();
  try {
    const stdout = sink();
    assert.equal(await main(['--port', String(port)], { stdout, stderr: sink() }), 0);
    assert.equal(stdout.text, `The swarm dashboard is already running at http://127.0.0.1:${port}/\n`);
  } finally {
    await ours.close();
  }
  const other = createServer((req, res) => res.end('hello'));
  await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
  try {
    const stderr = sink();
    assert.equal(await main(['--port', String(port)], { stdout: sink(), stderr }), 1);
    assert.ok(stderr.text.includes(`Port ${port} is used by another program. Start with --port <n> or set SWARM_DASHBOARD_PORT.`), stderr.text);
  } finally {
    other.closeAllConnections?.();
    await new Promise(resolve => other.close(() => resolve()));
  }
});

test('bad arguments print the usage and exit 2', async () => {
  const stderr = sink();
  assert.equal(await main(['--port', '0'], { stdout: sink(), stderr }), 2);
  assert.match(stderr.text, /Usage: swarm-dashboard/);
});
