#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { parseTime } from '../engine/time.mjs';

const USAGE = `Usage: swarm-snapshot [--list | --swarm <id> | --history | --run <id>] [options]

Prints the swarm dashboard's data as JSON. Reads Copilot data read-only.

  --list                 Known swarms, live first
  --swarm <id>           One swarm's snapshot (default: the most recently active live swarm)
  --history              Finished runs
  --run <id>             One run's summary
  --copilot-home <dir>   Copilot data folder (default ~/.copilot)
  --history-dir <dir>    Run summary folder (default <copilot-home>/swarm-dashboard/history)
  --persist-history      Write summaries of finished runs (off by default)
  --now <time>           Evaluate at an ISO time or epoch milliseconds
  --no-pr-lookup         Skip the read-only gh and az PR lookups
  --sqlite <backend>     auto, node or cli (default auto)
  --compact              One-line JSON
  --help                 Show this text`;

const VALUE_OPTIONS = new Set(['--swarm', '--run', '--copilot-home', '--history-dir', '--now', '--sqlite']);
const FLAG_OPTIONS = new Set(['--list', '--history', '--persist-history', '--no-pr-lookup', '--compact', '--help']);

class UsageError extends Error {}

const timeOption = value => parseTime(/^\d+$/.test(value) ? Number(value) : value);

export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAG_OPTIONS.has(arg)) {
      options[arg.slice(2)] = true;
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`Option ${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new UsageError(`Unknown option ${arg}`);
    }
  }
  if (['list', 'swarm', 'history', 'run'].filter(key => options[key] !== undefined).length > 1) {
    throw new UsageError('Use only one of --list, --swarm, --history and --run');
  }
  if (options.sqlite !== undefined && !['auto', 'node', 'cli'].includes(options.sqlite)) throw new UsageError('--sqlite must be auto, node or cli');
  if (options.now !== undefined && timeOption(options.now) === null) throw new UsageError('--now must be an ISO time or epoch milliseconds');
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const fixed = options.now === undefined ? null : timeOption(options.now);
  const now = fixed === null ? Date.now : () => fixed;
  const lookup = options['no-pr-lookup'] || options.list || options.history ? null : createPrLookup({ now });
  const engine = createSwarmEngine({
    copilotHome: options['copilot-home'], historyDir: options['history-dir'], persistHistory: Boolean(options['persist-history']),
    now, prLookup: lookup ?? 'off', sqlite: options.sqlite ?? 'auto',
  });
  let result;
  if (options.list) {
    await engine.refresh();
    result = engine.listSwarms();
  } else if (options.history) {
    result = await engine.listHistory();
  } else if (options.run !== undefined) {
    if (lookup) {
      await engine.getSnapshot(options.run);
      await lookup.settle();
      await engine.refresh();
    }
    result = await engine.getRunSummary(options.run);
  } else {
    result = await engine.getSnapshot(options.swarm);
    if (result && lookup) {
      await lookup.settle();
      await engine.refresh();
      result = await engine.getSnapshot(result.run.id);
    }
  }
  for (const item of engine.diagnostics()) if (item.level === 'warn') stderr.write(`warning: ${item.source}: ${item.message}\n`);
  stdout.write(`${JSON.stringify(result ?? null, null, options.compact ? 0 : 2)}\n`);
  if (result === null || result === undefined) {
    stderr.write(options.run !== undefined ? `No run ${options.run}\n` : options.swarm !== undefined ? `No swarm ${options.swarm}\n` : 'No swarm found\n');
    return 1;
  }
  return 0;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
