#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDefaultEngine } from '../server/engines.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { DEFAULT_PORT, listenShared, resolvePort } from '../server/shared.mjs';

export const USAGE = `Usage: swarm-dashboard [--port <n>] [--demo [example|stress]] [--still]

Serves the swarm dashboard at http://127.0.0.1:<port>/ (default ${DEFAULT_PORT}) for any browser or the
app's browser canvas. Reads Copilot data read-only. Stop it with Ctrl+C.
If the dashboard is already running on the port, prints its address and exits.

  --port <n>       Port to use (default ${DEFAULT_PORT}, or SWARM_DASHBOARD_PORT)
  --demo [name]    Serve a synthetic swarm instead of your data: example (default) or stress
  --still          With --demo: no simulated activity
  --help           Show this help
`;
const SCENARIOS = ['example', 'stress'];

export function parseArguments(argv, env = process.env) {
  const options = { port: null, demo: null, still: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--demo') options.demo = SCENARIOS.includes(argv[index + 1]) ? argv[++index] : 'example';
    else if (arg.startsWith('--demo=')) options.demo = arg.slice('--demo='.length);
    else if (arg === '--still') options.still = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.port === null) options.port = resolvePort(env);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port needs a port number from 1 to 65535');
  if (options.demo !== null && !SCENARIOS.includes(options.demo)) throw new Error('--demo takes example or stress');
  if (options.still && options.demo === null) throw new Error('--still works only with --demo');
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, signal } = {}) {
  let options;
  try {
    options = parseArguments(argv, env);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  const { version } = JSON.parse(await readFile(new URL('../plugin.json', import.meta.url), 'utf8'));
  const log = entry => stderr.write(`[${entry.level}] ${entry.source}: ${entry.message}\n`);
  const createEngine = options.demo
    ? () => createDemoEngine({ scenario: options.demo, simulate: !options.still })
    : () => createDefaultEngine({ log });
  const port = options.port;
  const result = await listenShared({ port, makeServer: () => createDashboardServer({ createEngine, port, version, log }) });
  const url = `http://127.0.0.1:${port}/`;
  if (result.status === 'running') {
    stdout.write(`The swarm dashboard is already running at ${url}\n`);
    return 0;
  }
  if (result.status !== 'started') {
    stderr.write(`Port ${port} ${result.status === 'taken' ? 'is used by another program' : 'is in use and not answering'}. Start with --port <n> or set SWARM_DASHBOARD_PORT.\n`);
    return 1;
  }
  stdout.write(`Swarm dashboard${options.demo ? ` (sample data: ${options.demo})` : ''}: ${url}\nPress Ctrl+C to stop.\n`);
  await new Promise(resolve => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    signal?.addEventListener('abort', stop, { once: true });
  });
  await result.server.close();
  return 0;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
