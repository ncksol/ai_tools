// Exclusive access for the overnight runner:
// - the batch lock: one process at a time reads and writes a batch's state (next, record, stop);
// - the active-batch guard: one batch at a time on this machine, because runs share the app, the
//   runs folder, results.csv and the account's limits.
// Both are files created atomically (O_EXCL). A file whose holder is gone is replaced.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export class LockBusyError extends Error {}
export class ActiveBatchError extends Error {}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export const lockPath = (dir: string): string => join(dir, "runner.lock");

// Takes the batch lock if it is free or its holder is gone. False if a live process holds it.
export function tryLock(dir: string): boolean {
  const path = lockPath(dir);
  if (createExclusive(path, String(process.pid))) return true;
  const holder = Number(readText(path)?.trim());
  if (pidAlive(holder)) return false;
  // The holder is gone. Remove its file and race for a fresh one; only one process can win.
  try {
    if (readText(path)?.trim() === String(holder)) unlinkSync(path);
  } catch {
    // someone else removed it first
  }
  return createExclusive(path, String(process.pid));
}

export function unlock(dir: string): void {
  const path = lockPath(dir);
  if (readText(path)?.trim() === String(process.pid)) unlinkSync(path);
}

export async function withLock<T>(
  dir: string,
  fn: () => Promise<T> | T,
  opts: { waitMs: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<T> {
  const until = opts.now() + opts.waitMs;
  while (!tryLock(dir)) {
    if (opts.now() >= until) {
      const holder = readText(lockPath(dir))?.trim();
      throw new LockBusyError(`Another runner process (pid ${holder}) is working on this batch. Wait for it to finish, then try again.`);
    }
    await opts.sleep(1000);
  }
  try {
    return await fn();
  } finally {
    unlock(dir);
  }
}

export interface ActiveBatch {
  id: string;
  dir: string;
  claimedAt: string;
}

function readActive(path: string): ActiveBatch | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as ActiveBatch;
    return typeof value?.id === "string" && typeof value?.dir === "string" ? value : null;
  } catch {
    return null;
  }
}

// A batch counts as active until its state says done or stopped, or its folder is gone.
export function batchIsLive(dir: string): boolean {
  const text = readText(join(dir, "state.json"));
  if (text === null) return existsSync(join(dir, "config.json"));
  try {
    const phase = (JSON.parse(text) as { phase?: string }).phase;
    return phase !== "done" && phase !== "stopped";
  } catch {
    return true;
  }
}

// The other live batch holding the guard, or null.
export function otherActiveBatch(guard: string, id: string): ActiveBatch | null {
  const active = readActive(guard);
  return active && active.id !== id && batchIsLive(active.dir) ? active : null;
}

export function claimActive(guard: string, id: string, dir: string, now: string): void {
  const content = JSON.stringify({ id, dir, claimedAt: now } satisfies ActiveBatch);
  if (createExclusive(guard, content)) return;
  const active = readActive(guard);
  if (active?.id === id) return;
  if (active && batchIsLive(active.dir)) {
    throw new ActiveBatchError(`Batch ${active.id} (${active.dir}) is active on this machine. Only one batch runs at a time: stop it (npm run batch -- stop --batch ${active.id}) and let it finish first.`);
  }
  try {
    unlinkSync(guard);
  } catch {
    // someone else removed it first
  }
  if (!createExclusive(guard, content)) {
    const winner = readActive(guard);
    if (winner?.id !== id) throw new ActiveBatchError(`Batch ${winner?.id ?? "unknown"} claimed this machine first.`);
  }
}

export function releaseActive(guard: string, id: string): void {
  if (readActive(guard)?.id === id) unlinkSync(guard);
}
