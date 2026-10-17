import { execFile } from 'node:child_process';

export function parsePsOutput(text) {
  const started = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const at = Date.parse(match[2]);
    if (Number.isFinite(at)) started.set(Number(match[1]), at);
  }
  return started;
}

/**
 * Liveness of Copilot CLI processes from their inuse.<pid>.lock files. A lock is live when its PID exists, can be
 * signalled by this user, and started no later than the lock file was written, so a reused PID does not count.
 */
export function createProcessProbe({ execFileImpl = execFile, kill = (pid, signal) => process.kill(pid, signal), slackMs = 5000 } = {}) {
  return async function probe(locks) {
    const result = new Map();
    const candidates = [];
    for (const lock of locks) {
      try {
        kill(lock.pid, 0);
        candidates.push(lock);
      } catch {
        result.set(lock.pid, false);
      }
    }
    if (!candidates.length) return result;
    const started = await new Promise(resolve => {
      execFileImpl('ps', ['-o', 'pid=,lstart=', '-p', candidates.map(lock => lock.pid).join(',')],
        { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 },
        (error, stdout) => resolve(error && !String(stdout ?? '').trim() ? null : parsePsOutput(stdout)));
    });
    for (const lock of candidates) {
      if (!started) {
        result.set(lock.pid, true);
        continue;
      }
      const at = started.get(lock.pid);
      result.set(lock.pid, at !== undefined && at <= lock.mtimeMs + slackMs);
    }
    return result;
  };
}
