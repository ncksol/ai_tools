// Phone notifications through ntfy, sent by the runner with curl. The topic URL is a secret: it comes
// from an environment variable or a private file outside the repo, goes to curl on stdin, and is
// never logged, stored in batch files or put on a command line.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export interface Notice {
  key: string;
  title: string;
  body: string;
  priority: "low" | "default" | "high";
  tags: string[];
}

export function readNtfyUrl(opts: { envVar: string; urlFile: string; env?: NodeJS.ProcessEnv }): string | null {
  const fromEnv = (opts.env ?? process.env)[opts.envVar]?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(opts.urlFile)) return null;
  const line = readFileSync(opts.urlFile, "utf8")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "" && !entry.startsWith("#"));
  return line && /^https?:\/\//.test(line) ? line : null;
}

export const redact = (text: string, url: string): string => (url ? text.split(url).join("<ntfy-url>") : text);

const configQuote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Sends one notice. Never throws: a failed notification is reported, and the batch carries on.
export function sendNtfy(url: string, notice: Notice, opts: { curl?: string } = {}): Promise<{ ok: boolean; error?: string }> {
  // curl reads the URL and headers from a config on stdin, so the URL is not in the process list.
  const config = [
    `url = ${configQuote(url)}`,
    `header = ${configQuote(`Title: ${notice.title}`)}`,
    `header = ${configQuote(`Priority: ${notice.priority}`)}`,
    ...(notice.tags.length > 0 ? [`header = ${configQuote(`Tags: ${notice.tags.join(",")}`)}`] : []),
    `data-binary = ${configQuote(notice.body)}`,
  ].join("\n");
  const args = ["--fail", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", "15", "--retry", "2", "--retry-max-time", "40", "--config", "-"];
  return new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn(opts.curl ?? "curl", args, { stdio: ["pipe", "ignore", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: redact((error as Error).message, url) });
      return;
    }
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ ok: false, error: redact(error.message, url) }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false, error: redact(stderr.trim() || `curl exited ${code}`, url) }));
    child.stdin.end(config);
  });
}

export interface RunSummaryForNotice {
  index: number;
  total: number;
  variant: string;
  n: number;
  outcome: string;
  minutes: string;
  suite: string;
  prs: string;
  ci: string;
  flags: string[];
}

const flagText = (flags: string[]): string => (flags.length === 0 ? "none" : flags.join(", "));

export const notices = {
  batchStarted: (id: string, plan: string): Notice => ({
    key: "batch-started",
    title: "Eval batch started",
    body: `Batch ${id} started. Plan: ${plan}.`,
    priority: "low",
    tags: ["hourglass_flowing_sand"],
  }),
  selfTest: (id: string, attempt: number, ok: boolean, detail: string): Notice => ({
    key: `selftest-${attempt}`,
    title: ok ? "Eval self-test passed" : "Eval self-test FAILED",
    body: ok ? `Batch ${id}: the self-test passed.` : `Batch ${id}: the self-test failed, so no run starts. ${detail}`,
    priority: ok ? "low" : "high",
    tags: [ok ? "white_check_mark" : "x"],
  }),
  runOutcome: (id: string, run: RunSummaryForNotice): Notice => ({
    key: `run-${run.variant}-${run.n}`,
    title: `Eval run ${run.index}/${run.total}: ${run.outcome}`,
    body: `Batch ${id}, run ${run.index} of ${run.total}: ${run.variant} #${run.n} ${run.outcome} in ${run.minutes} min (suite ${run.suite}, PRs merged ${run.prs}, main CI ${run.ci}). Flags: ${flagText(run.flags)}.`,
    priority: run.outcome === "passed" && run.flags.length === 0 ? "default" : "high",
    tags: [run.outcome === "passed" ? "white_check_mark" : "warning"],
  }),
  runVoid: (id: string, variant: string, n: number, reason: string): Notice => ({
    key: `void-${variant}-${n}`,
    title: "Eval run void",
    body: `Batch ${id}: ${variant} #${n} is void and was not scored: ${reason}`,
    priority: "high",
    tags: ["warning"],
  }),
  failure: (id: string, key: string, detail: string): Notice => ({
    key: `failure-${key}`,
    title: "Eval batch problem",
    body: `Batch ${id}: ${detail}`,
    priority: "high",
    tags: ["warning"],
  }),
  stopped: (id: string, reason: string, reportPath: string): Notice => ({
    key: "batch-stopped",
    title: "Eval batch STOPPED",
    body: `Batch ${id} stopped: ${reason}. Turn Copilot Memory back on at github.com/settings/copilot/features. Report: ${reportPath}`,
    priority: "high",
    tags: ["rotating_light"],
  }),
  lateFlags: (id: string, variant: string, n: number, codes: string[]): Notice => ({
    key: `late-${variant}-${n}-${codes.join(",")}`,
    title: "Eval run: late flags",
    body: `Batch ${id}: ${variant} #${n} got flags after it was scored: ${codes.join(", ")}. Its score and results.csv row are unchanged; see the report.`,
    priority: "high",
    tags: ["warning"],
  }),
  done: (id: string, counts: string, reportPath: string): Notice => ({
    key: "batch-done",
    title: "Eval batch done",
    body: `Batch ${id} done: ${counts}. Turn Copilot Memory back on at github.com/settings/copilot/features. Report: ${reportPath}`,
    priority: "default",
    tags: ["checkered_flag"],
  }),
};
