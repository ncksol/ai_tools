import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Feature } from "./features.ts";
import { run } from "./proc.ts";

export const KIT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface TapSummary {
  total: number;
  passed: number;
  failed: number;
  failures: string[];
}

export interface SuiteResult extends TapSummary {
  ok: boolean;
  exitCode: number;
  output: string;
  timedOut: boolean; // the run hit its timeoutMs and its process group was stopped
}

export function suiteFile(name: "v1" | Feature): string {
  return join(KIT_DIR, "acceptance", `${name}.test.ts`);
}

export function suiteFiles(features: readonly Feature[]): string[] {
  return [suiteFile("v1"), ...features.map((feature) => suiteFile(feature))];
}

// Features with a hidden robustness file in robustness/: edge cases the acceptance gate leaves out.
const ROBUSTNESS_FEATURES: readonly Feature[] = ["import"];

// Diagnostics have their own short budget; score persists the gate before starting them.
export const ROBUSTNESS_TIMEOUT_MS = 2 * 60_000;

// The robustness files for `features`, in the order given; empty when none of them has one.
// Never part of the gate: these run after scoring.
export function robustnessFiles(features: readonly Feature[]): string[] {
  return features.filter((feature) => ROBUSTNESS_FEATURES.includes(feature)).map((feature) => join(KIT_DIR, "robustness", `${feature}.test.ts`));
}

const posix = (path: string): string => path.split(sep).join("/");

// `files` and every file they import through relative static imports, transitively, as sorted paths
// relative to `root`. Package and node: imports are not followed.
export function robustnessDependencies(files: readonly string[], root: string = KIT_DIR): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    const path = resolve(file);
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["'](\.{1,2}\/[^"']+)["']|^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm)) {
      visit(resolve(dirname(path), match[1] ?? match[2]));
    }
  };
  for (const file of files) visit(file);
  return [...seen].map((path) => posix(relative(root, path))).sort();
}

// Identifies the robustness suite that produced a result: the content of the test files and their
// relative imports (the shared harness), the test runner's arguments and the total budget. Robustness
// counts are comparable only between results with the same value. "" when there are no files.
export function robustnessSha256(files: readonly string[], opts: { timeoutMs?: number; root?: string } = {}): string {
  if (files.length === 0) return "";
  const root = opts.root ?? KIT_DIR;
  const lines = [`runner ${JSON.stringify(suiteArgs([]))}`, `budget-ms ${opts.timeoutMs ?? ROBUSTNESS_TIMEOUT_MS}`];
  for (const path of robustnessDependencies(files, root)) {
    lines.push(`file ${path} ${createHash("sha256").update(readFileSync(join(root, path))).digest("hex")}`);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function count(output: string, label: string): number {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return match ? Number(match[1]) : 0;
}

export function parseTap(output: string): TapSummary {
  const failures = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1].trim());
  return {
    total: count(output, "tests"),
    passed: count(output, "pass"),
    failed: count(output, "fail") + count(output, "cancelled"),
    failures,
  };
}

export function suiteArgs(files: string[]): string[] {
  return ["--test", "--test-concurrency=1", "--test-reporter=tap", "--test-timeout=60000", ...files];
}

// With `timeoutMs`, the suite runs in its own process group (proc.ts `run`), and the whole group,
// including the apps it started, is stopped when the time runs out.
export async function runSuite(appDir: string, files: string[], opts: { timeoutMs?: number } = {}): Promise<SuiteResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, EXPENSE_APP_DIR: resolve(appDir) };
  // Set by a parent `node --test`; a nested runner would then report to it instead of printing TAP.
  delete env.NODE_TEST_CONTEXT;
  // One file at a time, so two suite processes never race for the same free port.
  // Leave time for score's exit cleanup before its own supervisor's five-second shutdown grace ends.
  const result = await run(process.execPath, suiteArgs(files), { cwd: KIT_DIR, env, timeoutMs: opts.timeoutMs, shutdownGraceMs: 1000 });
  const summary = parseTap(result.stdout);
  const timedOut = result.timedOut === true;
  return {
    ...summary,
    ok: !timedOut && result.code === 0 && summary.total > 0 && summary.passed === summary.total,
    exitCode: result.code,
    output: result.stdout + result.stderr,
    timedOut,
  };
}
