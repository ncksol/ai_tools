import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How often the dashboard checks that file system calls in its process still finish. */
export const POOL_CHECK_INTERVAL_MS = 10_000;
/** How long one check may take before the process counts as broken. */
export const POOL_CHECK_TIMEOUT_MS = 20_000;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Checks, on a timer, that an asynchronous file system call still finishes. Node runs these calls
 * on the libuv thread pool; when a host process's pool stops working, they never settle, and
 * neither do the refreshes that depend on them. A probe that fails still shows the pool works.
 * A probe that does not settle within `timeoutMs` marks the pool broken: the check stops and
 * `onBroken` runs once. Checks never overlap, and the timers never keep the process alive.
 */
export function createPoolCheck({
  probe = () => fsp.stat(here),
  intervalMs = POOL_CHECK_INTERVAL_MS,
  timeoutMs = POOL_CHECK_TIMEOUT_MS,
  onBroken = () => {},
} = {}) {
  let state = 'ok';
  let running = false;
  let timer = null;
  let limit = null;
  let lastOkStartedAt = null;

  function schedule() {
    if (!running) return;
    timer = setTimeout(check, intervalMs);
    timer.unref?.();
  }

  function check() {
    timer = null;
    if (!running) return;
    const startedAt = Date.now();
    let settled = false;
    limit = setTimeout(() => {
      limit = null;
      if (settled || !running) return;
      state = 'broken';
      running = false;
      onBroken();
    }, timeoutMs);
    limit.unref?.();
    const done = () => {
      if (settled) return;
      settled = true;
      if (limit) clearTimeout(limit);
      limit = null;
      if (!running) return;
      lastOkStartedAt = startedAt;
      schedule();
    };
    let pending;
    try { pending = probe(); } catch { pending = null; }
    Promise.resolve(pending).then(done, done);
  }

  return {
    start() {
      if (running || state === 'broken') return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      if (limit) clearTimeout(limit);
      timer = null;
      limit = null;
    },
    state: () => state,
    /** True when the pool works and a check that started at or after `time` has finished. */
    passedSince: time => state === 'ok' && lastOkStartedAt !== null && lastOkStartedAt >= time,
  };
}
