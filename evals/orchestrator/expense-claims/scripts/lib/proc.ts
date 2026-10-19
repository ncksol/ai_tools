import { spawn } from "node:child_process";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export const TIMEOUT_EXIT_CODE = 124;

// With `timeoutMs`, the command runs in its own process group, and the whole group (the command and
// anything it started) is stopped when the time runs out; the result then has exit code 124.
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const grouped = opts.timeoutMs !== undefined;
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: grouped });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = grouped
      ? setTimeout(() => {
          timedOut = true;
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 5000).unref();
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        resolve({ code: TIMEOUT_EXIT_CODE, stdout, stderr: `${stderr}${stderr.endsWith("\n") || stderr === "" ? "" : "\n"}${cmd} timed out after ${Math.ceil(opts.timeoutMs! / 1000)} s`, timedOut: true });
      } else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
