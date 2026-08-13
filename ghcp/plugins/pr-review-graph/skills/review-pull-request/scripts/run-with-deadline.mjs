#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { isMain, parseFlags } from './lib.mjs';

export const TIMEOUT_EXIT_CODE = 124;
const DEFAULT_GRACE_MS = 5000;

/**
 * Race an arbitrary promise against a deadline, for bounding a single in-process async
 * call (e.g. one `execFile` invocation) that has no process tree of its own to kill. On
 * expiry, rejects with an Error carrying `timedOut: true`; the underlying promise, if it
 * later settles, is otherwise ignored. This does not terminate whatever the promise was
 * waiting on — pair it with the callee's own `timeout`/`signal` option when the callee
 * supports one, so the underlying work is also actually cancelled.
 */
export function withDeadline(promise, deadlineMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`timed out after ${deadlineMs}ms`);
      error.timedOut = true;
      reject(error);
    }, deadlineMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Sends `signal` to the whole process group led by `pid`. `detached: true` at spawn time
// makes the child a process-group leader on POSIX, so this reaches every descendant that
// has not called setsid()/setpgid() itself — the shell, and every `az`/`git`/`node`
// process it forked. An already-exited group throws ESRCH, which is not an error here.
function killTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * Run `command` with `args`, killing its entire process tree if it does not exit within
 * `deadlineMs`. Resolves with `{ code, signal, timedOut }` — never rejects for a timeout;
 * only rejects if the command itself could not be spawned (e.g. ENOENT).
 */
export function runWithDeadline({
  command,
  args = [],
  deadlineMs,
  graceMs = DEFAULT_GRACE_MS,
  stdio = 'inherit'
}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('runWithDeadline requires a positive deadlineMs');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let deadlineTimer = null;
    let graceTimer = null;

    const child = spawn(command, args, { stdio, detached: process.platform !== 'win32' });

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      resolve({ code, signal, timedOut });
    });

    deadlineTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (process.platform === 'win32') {
        child.kill();
      } else {
        killTree(child.pid, 'SIGTERM');
        graceTimer = setTimeout(() => {
          if (settled) return;
          killTree(child.pid, 'SIGKILL');
        }, graceMs);
      }
    }, deadlineMs);
  });
}

async function main() {
  const separatorIndex = process.argv.indexOf('--');
  if (separatorIndex < 0 || separatorIndex === process.argv.length - 1) {
    process.stderr.write(
      'Usage: run-with-deadline.mjs --deadline-ms <MS> [--grace-ms <MS>] -- <command> [args...]\n'
    );
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(process.argv.slice(2, separatorIndex));
  const deadlineMs = Number(flags['deadline-ms']);
  const graceMs = flags['grace-ms'] !== undefined ? Number(flags['grace-ms']) : DEFAULT_GRACE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    process.stderr.write('run-with-deadline: --deadline-ms must be a positive number\n');
    process.exitCode = 2;
    return;
  }
  const [command, ...args] = process.argv.slice(separatorIndex + 1);

  let result;
  try {
    result = await runWithDeadline({ command, args, deadlineMs, graceMs });
  } catch (error) {
    process.stderr.write(`run-with-deadline: failed to run ${command}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.timedOut) {
    process.stderr.write(`run-with-deadline: deadline of ${deadlineMs}ms exceeded, terminated process tree\n`);
    process.exitCode = TIMEOUT_EXIT_CODE;
    return;
  }
  if (result.signal) {
    process.stderr.write(`run-with-deadline: ${command} exited via signal ${result.signal}\n`);
    process.exitCode = 128;
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
