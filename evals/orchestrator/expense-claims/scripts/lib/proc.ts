import { spawn } from "node:child_process";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export const TIMEOUT_EXIT_CODE = 124;
// After SIGTERM, how long the process group gets before SIGKILL, and how long SIGKILL gets.
const TERM_GRACE_MS = 5000;
const KILL_GRACE_MS = 5000;
const parentStops = new Set<Promise<void>>();

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

// With `timeoutMs`, the command runs in its own process group. When the time runs out, the group
// gets SIGTERM, then SIGKILL if anything in it is still alive after 5 seconds, and the promise
// settles (exit code 124) only once the group is gone or SIGKILL has been sent and waited for. The
// timers keep the caller alive meanwhile, so a descendant that ignores SIGTERM can't outlive it.
// A process that leaves the group (setsid) is out of reach.
// Parent termination also forwards SIGTERM before escalation, then exits 143/130 after all grouped
// commands stop, running exit cleanup hooks. Nested supervisors need a shorter shutdownGraceMs.
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; shutdownGraceMs?: number } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const grouped = opts.timeoutMs !== undefined;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitCode: number | null = null;
    let closed: () => void = () => {};
    const closedOnce = new Promise<void>((done) => (closed = done));
    let escalation: Promise<string> | null = null;
    let parentStopping = false;

    const onTerm = () => stopWithParent("SIGTERM");
    const onInt = () => stopWithParent("SIGINT");
    function removeSignalHandlers(): void {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
    }
    function stopWithParent(signal: "SIGTERM" | "SIGINT"): void {
      if (parentStopping) return;
      parentStopping = true;
      if (timer) clearTimeout(timer);
      const stopping = (async () => {
        if (child.pid) {
          const pgid = child.pid;
          signalGroup(pgid, "SIGTERM");
          for (const until = Date.now() + (opts.shutdownGraceMs ?? TERM_GRACE_MS); groupAlive(pgid) && Date.now() < until; ) await delay(25);
          if (groupAlive(pgid)) {
            signalGroup(pgid, "SIGKILL");
            for (const until = Date.now() + 1000; groupAlive(pgid) && Date.now() < until; ) await delay(25);
            if (groupAlive(pgid)) process.stderr.write(`Process group ${pgid} was still alive after shutdown SIGKILL\n`);
          }
          await Promise.race([closedOnce, delay(100)]);
        }
        removeSignalHandlers();
      })();
      parentStops.add(stopping);
      void stopping.then(() => {
        parentStops.delete(stopping);
        if (parentStops.size === 0) process.exit(signal === "SIGTERM" ? 143 : 130);
      });
    }
    if (grouped) {
      // An outer supervisor cannot reach this detached group when it terminates our own group.
      process.on("SIGTERM", onTerm);
      process.on("SIGINT", onInt);
    }

    const timer = grouped
      ? setTimeout(() => {
          const pgid = child.pid;
          if (!pgid) return;
          escalation = (async () => {
            signalGroup(pgid, "SIGTERM");
            for (const until = Date.now() + TERM_GRACE_MS; groupAlive(pgid) && Date.now() < until; ) await delay(100);
            if (!groupAlive(pgid)) return "";
            signalGroup(pgid, "SIGKILL");
            for (const until = Date.now() + KILL_GRACE_MS; groupAlive(pgid) && Date.now() < until; ) await delay(100);
            return groupAlive(pgid) ? "; some processes in its group were still alive after SIGKILL" : "; SIGKILL was needed";
          })();
          void settleAfterTimeout(escalation);
        }, opts.timeoutMs)
      : null;

    async function settleAfterTimeout(done: Promise<string>): Promise<void> {
      const note = await done;
      // The pipes close once the group is gone; don't wait forever for a process outside it.
      await Promise.race([closedOnce, delay(2000)]);
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      child.stdout?.destroy();
      child.stderr?.destroy();
      const sep = stderr.endsWith("\n") || stderr === "" ? "" : "\n";
      resolve({ code: TIMEOUT_EXIT_CODE, stdout, stderr: `${stderr}${sep}${cmd} timed out after ${Math.ceil(opts.timeoutMs! / 1000)} s${note}`, timedOut: true });
    }

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (parentStopping) return;
      if (timer) clearTimeout(timer);
      removeSignalHandlers();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      exitCode = code;
      closed();
      if (escalation || parentStopping) return;
      if (timer) clearTimeout(timer);
      removeSignalHandlers();
      if (settled) return;
      settled = true;
      resolve({ code: exitCode ?? 1, stdout, stderr });
    });
  });
}
