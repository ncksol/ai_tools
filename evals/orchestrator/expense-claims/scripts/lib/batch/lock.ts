// Exclusive access for the overnight runner:
// - the batch lock: one process at a time reads and writes a batch's state (next, record, stop);
// - the active-batch guard: one batch at a time on this machine, because runs share the app, the
//   runs folder, results.csv and the account's limits.
//
// Both use a kernel flock(2) on a lock file, held by a small child process (`lockf ... cat`) whose
// stdin this process keeps open. The kernel grants the lock to one holder at a time and releases it
// when the holder exits, crash included: when this process dies, `cat` reads end-of-file and exits.
// So no stale lock ever needs reclaiming, and the lock file's content means nothing.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createRevision, latestRevision, loadState, readRevision } from "./state.ts";

export class LockBusyError extends Error {}
export class ActiveBatchError extends Error {}

// Exit status of lockf(1) and of `flock -E 75` when the lock is held by someone else.
const BUSY_EXIT = 75;

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockCommand(path: string): [string, string[]] {
  const hold = ["/bin/sh", "-c", "echo locked; exec cat"];
  // macOS and the BSDs: lockf(1). -k keeps the file, so every holder locks the same inode.
  if (existsSync("/usr/bin/lockf")) return ["/usr/bin/lockf", ["-k", "-s", "-t", "0", path, ...hold]];
  // Linux (util-linux): flock(1).
  return ["flock", ["-n", "-E", String(BUSY_EXIT), path, ...hold]];
}

export interface HeldLock {
  release(): Promise<void>;
}

// Exit status when the process loses a lock it holds.
export const HOLDER_LOST_EXIT = 70;

// The holder of a lock this process holds has gone, so the lock may already belong to someone else.
// Stop at once: no further protected work, no finally block, no save, no notification.
function holderLost(path: string, detail: string): never {
  try {
    writeSync(2, `eval runner: lost the lock on ${path} (${detail}); stopping at once without saving\n`);
  } catch {
    // stderr is gone; exit anyway
  }
  process.exit(HOLDER_LOST_EXIT);
}

// Takes the lock without waiting. Null if another process holds it.
export function tryOsLock(path: string): Promise<HeldLock | null> {
  const [cmd, args] = lockCommand(path);
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let acquired = false;
    let releasing = false;
    let out = "";
    let err = "";
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    // Ending stdin on a holder that just died must not throw; the exit handler decides what it means.
    child.stdin!.on("error", () => {});
    child.stdout!.on("data", (chunk) => {
      out += chunk;
      if (!settled && out.includes("locked")) {
        settled = true;
        acquired = true;
        resolve({
          release: async () => {
            if (child.exitCode !== null || child.signalCode !== null) holderLost(path, "its holder had already exited at release");
            releasing = true;
            child.stdin!.end();
            await exited;
          },
        });
      }
    });
    child.stderr!.on("data", (chunk) => (err += chunk));
    // After the lock is taken, only one ending is normal: the release ends cat's stdin, cat exits 0 and
    // so does lockf. Any other ending, including one that is only noticed during the release, means
    // the lock may already belong to someone else.
    child.once("error", (error) => {
      if (acquired) holderLost(path, `holder error: ${error.message}`);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (acquired && (!releasing || code !== 0 || signal !== null)) {
        holderLost(path, `holder exited (${signal ?? `code ${code}`})${releasing ? " before its release" : ""}`);
      }
      if (settled) return;
      settled = true;
      if (code === BUSY_EXIT) resolve(null);
      else reject(new Error(`${cmd} exited ${code} while taking ${path}: ${err.trim()}`));
    });
  });
}

export async function withOsLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  opts: { waitMs: number; sleep: (ms: number) => Promise<void>; now: () => number; busyMessage: string },
): Promise<T> {
  const until = opts.now() + opts.waitMs;
  let held = await tryOsLock(path);
  while (!held) {
    if (opts.now() >= until) throw new LockBusyError(opts.busyMessage);
    await opts.sleep(1000);
    held = await tryOsLock(path);
  }
  try {
    return await fn();
  } finally {
    await held.release();
  }
}

export const lockPath = (dir: string): string => join(dir, "runner.lock");

export function withLock<T>(dir: string, fn: () => Promise<T> | T, opts: { waitMs: number; sleep: (ms: number) => Promise<void>; now: () => number }): Promise<T> {
  return withOsLock(lockPath(dir), fn, { ...opts, busyMessage: "Another runner process is working on this batch. Wait for it to finish, then try again." });
}

// For tests: the same exclusion within one process, without spawning lockf for every step.
export function processLock(): <T>(dir: string, fn: () => Promise<T> | T) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(dir: string, fn: () => Promise<T> | T): Promise<T> => {
    const previous = tails.get(dir) ?? Promise.resolve();
    const result = previous.then(() => fn());
    tails.set(dir, result.catch(() => undefined));
    return result;
  };
}

export interface ActiveBatch {
  id: string;
  dir: string;
  claimedAt: string;
}

const canonical = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

// The guard is a revisions folder (see createRevision in state.ts): every claim and every release is a
// new numbered revision, published with link(2) and so complete or absent, never partial. The newest
// revision names the active batch, or none after a release.
interface GuardView {
  revision: number;
  active: ActiveBatch | null;
}

export function readGuard(guard: string): GuardView {
  const revision = latestRevision(guard);
  if (revision === 0) return { revision, active: null };
  const active = (JSON.parse(readRevision(guard, revision)) as { active?: ActiveBatch | null }).active;
  return { revision, active: typeof active?.id === "string" && typeof active?.dir === "string" ? active : null };
}

// Publishes the next guard revision, fenced on the revision read under the guard's lock. Only a
// holder of that lock writes the guard, so if the next revision is already taken, another process
// held the lock meanwhile and this process lost it: stop at once, having written nothing.
function writeGuard(guard: string, lock: string, base: number, active: ActiveBatch | null): void {
  if (!createRevision(guard, base, JSON.stringify({ active }) + "\n")) {
    holderLost(lock, `another process wrote guard revision ${base + 1} after this one read revision ${base}`);
  }
}

const sameBatch = (active: ActiveBatch, id: string, dir: string): boolean => active.id === id && canonical(active.dir) === canonical(dir);

// A batch counts as active until its state says done or stopped, or its folder is gone.
export function batchIsLive(dir: string): boolean {
  if (!existsSync(join(dir, "state.json")) && !existsSync(join(dir, "state"))) return existsSync(join(dir, "config.json"));
  try {
    const phase = loadState(dir).phase;
    return phase !== "done" && phase !== "stopped";
  } catch {
    return true;
  }
}

// The other live batch holding the guard, or null. Read-only, for the preflight.
export function otherActiveBatch(guard: string, id: string, dir: string): ActiveBatch | null {
  const active = readGuard(guard).active;
  return active && !sameBatch(active, id, dir) && batchIsLive(active.dir) ? active : null;
}

const GUARD_LOCK_WAIT_MS = 30_000;
const guardOpts = { waitMs: GUARD_LOCK_WAIT_MS, sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)), now: () => Date.now() };

// Claims the machine for this batch. Every read-decide-write of the guard holds the guard's own
// flock, so two batches can't both decide the machine is free, and every write is fenced on the
// revision read under it (writeGuard), so a process that lost that flock writes nothing.
export async function claimActive(guard: string, id: string, dir: string, now: string): Promise<void> {
  const mine = readGuard(guard).active;
  if (mine && sameBatch(mine, id, dir)) return;
  const lock = `${guard}.lock`;
  await withOsLock(
    lock,
    () => {
      const { revision, active } = readGuard(guard);
      if (active && sameBatch(active, id, dir)) return;
      if (active && batchIsLive(active.dir)) {
        throw new ActiveBatchError(
          `Batch ${active.id} (${active.dir}) is active on this machine. Only one batch runs at a time: stop it (npm run batch -- stop --batch ${active.id}) and let it finish first.`,
        );
      }
      writeGuard(guard, lock, revision, { id, dir: canonical(dir), claimedAt: now });
    },
    { ...guardOpts, busyMessage: "Another process is claiming the machine for a batch. Try again." },
  );
}

export async function releaseActive(guard: string, id: string, dir: string): Promise<void> {
  const mine = readGuard(guard).active;
  if (!mine || !sameBatch(mine, id, dir)) return;
  const lock = `${guard}.lock`;
  await withOsLock(
    lock,
    () => {
      const { revision, active } = readGuard(guard);
      if (active && sameBatch(active, id, dir)) writeGuard(guard, lock, revision, null);
    },
    { ...guardOpts, busyMessage: "Another process is changing the machine's active batch. Try again." },
  );
}
