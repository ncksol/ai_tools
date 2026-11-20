import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('a launch never reuses a dashboard that serves other data', async () => {
  const port = await freePort();
  const mine = createDashboardServer({ createEngine: () => createDemoEngine({ simulate: false }), port, version: 'test' });
  await mine.listen();
  try {
    const stderr = sink();
    assert.equal(await main(['--port', String(port), '--demo'], { stdout: sink(), stderr }), 1);
    assert.ok(stderr.text.includes(`The dashboard with your Copilot data already runs at http://127.0.0.1:${port}/. Add --port <n> to start this one beside it.`), stderr.text);
  } finally {
    await mine.close();
  }
  const sample = createDashboardServer({ createEngine: () => createDemoEngine({ simulate: false }), port, version: 'test', demo: 'example' });
  await sample.listen();
  try {
    const stderr = sink();
    assert.equal(await main(['--port', String(port)], { stdout: sink(), stderr }), 1);
    assert.ok(stderr.text.includes(`A dashboard with sample data (example) already runs at http://127.0.0.1:${port}/. Add --port <n> to start this one beside it.`), stderr.text);
  } finally {
    await sample.close();
  }
});

test('bad arguments print the usage and exit 2', async () => {
  const stderr = sink();
  assert.equal(await main(['--port', '0'], { stdout: sink(), stderr }), 2);
  assert.match(stderr.text, /Usage: swarm-dashboard/);
});

// Runs finish() in a child process, after an optional file system call that never finishes, and reports how it ended.
// stderr 'stuck' takes the note but never reports it written, and 'throws' rejects it.
function finishInChild({ fifo = null, graceMs, stderr: stderrKind = null }) {
  const launcher = new URL('../scripts/swarm-dashboard.mjs', import.meta.url).href;
  const code = `
    import { open } from 'node:fs/promises';
    import { finish } from ${JSON.stringify(launcher)};
    const fifo = ${JSON.stringify(fifo)};
    if (fifo) open(fifo).catch(() => {});
    const stderrs = {
      stuck: { writableNeedDrain: false, write() { return false; } },
      throws: { writableNeedDrain: false, write() { throw new Error('stderr is closed'); } },
    };
    const kind = ${JSON.stringify(stderrKind)};
    finish(1, { graceMs: ${graceMs}, ...(kind ? { stderr: stderrs[kind] } : {}) });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const startedAt = Date.now();
  return new Promise(resolve => {
    const limit = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.on('close', (exitCode, signal) => {
      clearTimeout(limit);
      resolve({ exitCode, signal, stderr, ms: Date.now() - startedAt });
    });
  });
}

test('a failed launcher with nothing left to do exits with code 1', async () => {
  const result = await finishInChild({ graceMs: 5000 });
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.ok(result.ms < 5000, `it exits before the grace period ends (${result.ms} ms)`);
  assert.equal(result.stderr, '');
});

test('a failed launcher held open by a file system call that never finishes ends itself', { skip: process.platform === 'win32' && 'needs a FIFO' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wintermute-finish-'));
  try {
    const fifo = join(dir, 'never-written');
    // Opening a FIFO for reading blocks a libuv worker thread until a writer opens it, and none ever does.
    execFileSync('mkfifo', [fifo]);
    const result = await finishInChild({ fifo, graceMs: 200 });
    assert.equal(result.signal, 'SIGTERM', `it ends itself rather than hanging (exit code ${result.exitCode}, ${result.ms} ms)`);
    assert.match(result.stderr, /could not exit because a file system call is stuck/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed launcher held open by a stuck call ends itself even when its last note cannot be written', { skip: process.platform === 'win32' && 'needs a FIFO' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wintermute-finish-'));
  try {
    for (const stderr of ['stuck', 'throws']) {
      const fifo = join(dir, `never-written-${stderr}`);
      execFileSync('mkfifo', [fifo]);
      const result = await finishInChild({ fifo, graceMs: 200, stderr });
      assert.equal(result.signal, 'SIGTERM', `stderr ${stderr}: it ends itself (exit code ${result.exitCode}, signal ${result.signal}, ${result.ms} ms)`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
