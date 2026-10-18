import { dirname, join, resolve } from "node:path";
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
}

export function suiteFile(name: "v1" | Feature): string {
  return join(KIT_DIR, "acceptance", `${name}.test.ts`);
}

export function suiteFiles(features: readonly Feature[]): string[] {
  return [suiteFile("v1"), ...features.map((feature) => suiteFile(feature))];
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

export async function runSuite(appDir: string, files: string[]): Promise<SuiteResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, EXPENSE_APP_DIR: resolve(appDir) };
  // Set by a parent `node --test`; a nested runner would then report to it instead of printing TAP.
  delete env.NODE_TEST_CONTEXT;
  // One file at a time, so two suite processes never race for the same free port.
  const result = await run(process.execPath, suiteArgs(files), { cwd: KIT_DIR, env });
  const summary = parseTap(result.stdout);
  return {
    ...summary,
    ok: result.code === 0 && summary.total > 0 && summary.passed === summary.total,
    exitCode: result.code,
    output: result.stdout + result.stderr,
  };
}
