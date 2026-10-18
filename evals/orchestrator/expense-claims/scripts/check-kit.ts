import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ALL_FEATURES, FEATURE_HEADINGS } from "./lib/features.ts";
import { listSeedFiles } from "./lib/new-run.ts";
import { run, type ProcResult } from "./lib/proc.ts";
import { readResults } from "./lib/results.ts";
import { KIT_DIR, runSuite, suiteFile, suiteFiles } from "./lib/suite.ts";

const { values } = parseArgs({ options: { session: { type: "string" } } });

const SEED = join(KIT_DIR, "seed");
const REFERENCE = join(KIT_DIR, "reference");
const FULL_SUITE_TOTAL = 65;
const FORBIDDEN_FILES = new Set(["results.csv", "kickoff.md", "answers.md"]);

type Outcome = { status: "PASS" | "FAIL" | "SKIP"; evidence: string };
const results: { name: string; status: Outcome["status"] }[] = [];

async function check(name: string, body: () => Promise<Outcome>): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await body();
  } catch (error) {
    outcome = { status: "FAIL", evidence: (error as Error).message };
  }
  results.push({ name, status: outcome.status });
  console.log(`${outcome.status} ${name}: ${outcome.evidence}`);
}

const verdict = (ok: boolean, evidence: string): Outcome => ({ status: ok ? "PASS" : "FAIL", evidence });

// Child processes must not report to a parent `node --test` run.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function testCounts(output: string): { pass: number | null; fail: number | null } {
  const count = (label: string) => {
    const match = output.match(new RegExp(`^(?:#|ℹ) ${label} (\\d+)$`, "m"));
    return match ? Number(match[1]) : null;
  };
  return { pass: count("pass"), fail: count("fail") };
}

async function npmTest(dir: string): Promise<Outcome> {
  const result = await run("npm", ["test"], { cwd: dir, env: childEnv() });
  const { pass, fail } = testCounts(result.stdout + result.stderr);
  return verdict(result.code === 0 && pass !== null && pass > 0, `exit ${result.code}, # pass ${pass ?? "?"}, # fail ${fail ?? "?"}`);
}

// Reads one `# <label> N` line of a TAP summary; -1 when it is missing, so no check can pass on it.
function tapCount(output: string, label: string): number {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return match ? Number(match[1]) : -1;
}

const TAP_LABELS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;
type TapCounts = Record<(typeof TAP_LABELS)[number], number>;

function tapCounts(output: string): TapCounts {
  return Object.fromEntries(TAP_LABELS.map((label) => [label, tapCount(output, label)])) as TapCounts;
}

const showCounts = (c: TapCounts): string => TAP_LABELS.map((label) => `${label} ${c[label]}`).join(", ");
const noneOther = (c: TapCounts): boolean => c.cancelled === 0 && c.skipped === 0 && c.todo === 0;
const allPassed = (c: TapCounts): boolean => c.tests > 0 && c.pass === c.tests && c.fail === 0 && noneOther(c);
const allFailed = (c: TapCounts): boolean => c.tests > 0 && c.fail === c.tests && c.pass === 0 && noneOther(c);

async function mustPass(appDir: string, files: string[]): Promise<Outcome> {
  const suite = await runSuite(appDir, files);
  const counts = tapCounts(suite.output);
  const failures = suite.failures.length > 0 ? `; failing: ${suite.failures.join(", ")}` : "";
  return verdict(suite.exitCode === 0 && allPassed(counts), `${showCounts(counts)}${failures}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", ["-c", "user.name=Kit Check", "-c", "user.email=kit-check@example.invalid", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function dryRun(runsDir: string, variant: string, extra: string[]): Promise<{ repoDir: string; kickoffPath: string; result: ProcResult }> {
  const result = await run(process.execPath, ["scripts/new-run.ts", "--variant", variant, "--runs-dir", runsDir, "--dry-run", ...extra], {
    cwd: KIT_DIR,
    env: childEnv(),
  });
  const name = `orch-eval-${variant}-1`;
  return { repoDir: join(runsDir, name), kickoffPath: join(runsDir, `${name}.kickoff.md`), result };
}

async function seedOnly(repoDir: string): Promise<Outcome> {
  const problems: string[] = [];
  const files = (await git(repoDir, ["ls-files"])).split("\n").filter(Boolean).sort();
  const expected = listSeedFiles(SEED);
  if (files.join("\n") !== expected.join("\n")) problems.push(`git ls-files (${files.length}) differs from the seed (${expected.length})`);
  const leaked = files.filter((file) => file.startsWith("acceptance/") || file.startsWith("reference/") || FORBIDDEN_FILES.has(file));
  if (leaked.length > 0) problems.push(`kit-only files: ${leaked.join(", ")}`);
  const subjects = (await git(repoDir, ["log", "--format=%s"])).split("\n").filter(Boolean);
  if (subjects.join("\n") !== "Seed v1") problems.push(`commits: ${JSON.stringify(subjects)}`);
  return problems.length === 0
    ? verdict(true, `${repoDir}: ${files.length} files, all from seed/; one commit "Seed v1"`)
    : verdict(false, `${repoDir}: ${problems.join("; ")}`);
}

const tmp = mkdtempSync(join(tmpdir(), "orch-eval-check-"));
try {
  await check("seed npm test", () => npmTest(SEED));
  await check("reference npm test", () => npmTest(REFERENCE));

  await check("suite passes 100% on the reference", () => mustPass(REFERENCE, suiteFiles(ALL_FEATURES)));
  await check("suite passes on the reference without Summary", () => mustPass(REFERENCE, suiteFiles(["policy", "reports", "import"])));
  await check("v1 regressions pass on the seed", () => mustPass(SEED, [suiteFile("v1")]));

  await check("every v2 test fails on the seed", async () => {
    let ok = true;
    const parts: string[] = [];
    for (const feature of ALL_FEATURES) {
      const counts = tapCounts((await runSuite(SEED, [suiteFile(feature)])).output);
      // A file that fails to load reports one failing test; the reference's count catches that.
      const expected = tapCounts((await runSuite(REFERENCE, [suiteFile(feature)])).output).tests;
      if (!allFailed(counts) || counts.tests !== expected) ok = false;
      parts.push(`${feature} (${showCounts(counts)}; reference runs ${expected})`);
    }
    return verdict(ok, parts.join(", "));
  });

  await check("spec copies match", async () => {
    const spec = readFileSync(join(SEED, "docs", "spec-v2.md"), "utf8");
    const referenceSame = readFileSync(join(REFERENCE, "docs", "spec-v2.md"), "utf8") === spec;
    const kickoffEnds = readFileSync(join(KIT_DIR, "kickoff.md"), "utf8").endsWith("\n---\n\n" + spec);
    return verdict(
      referenceSame && kickoffEnds,
      `reference/docs/spec-v2.md ${referenceSame ? "equals" : "differs from"} seed/docs/spec-v2.md; kickoff.md ${kickoffEnds ? "ends with" : "does not end with"} the spec`,
    );
  });

  await check("new-run --dry-run gives a seed-only repo", async () => {
    const runsDir = join(tmp, "runs-full");
    mkdirSync(runsDir);
    const { repoDir, result } = await dryRun(runsDir, "check", []);
    if (result.code !== 0) return verdict(false, `exit ${result.code}: ${result.stderr.trim()}`);
    return seedOnly(repoDir);
  });

  await check("new-run --dry-run without Summary", async () => {
    const runsDir = join(tmp, "runs-three");
    mkdirSync(runsDir);
    const { repoDir, kickoffPath, result } = await dryRun(runsDir, "check-3", ["--features", "policy,reports,import"]);
    if (result.code !== 0) return verdict(false, `exit ${result.code}: ${result.stderr.trim()}`);
    const seed = await seedOnly(repoDir);
    const heading = FEATURE_HEADINGS.summary;
    const specHas = readFileSync(join(repoDir, "docs", "spec-v2.md"), "utf8").split("\n").some((line) => line.trim() === heading);
    const kickoffHas = existsSync(kickoffPath) && readFileSync(kickoffPath, "utf8").split("\n").some((line) => line.trim() === heading);
    return verdict(
      seed.status === "PASS" && existsSync(kickoffPath) && !specHas && !kickoffHas,
      `${seed.evidence}; spec ${specHas ? "has" : "has no"} "${heading}"; kickoff file ${!existsSync(kickoffPath) ? "missing" : kickoffHas ? "has" : "has no"} "${heading}"`,
    );
  });

  await check("score against a local reference checkout", async () => {
    if (!values.session) return { status: "SKIP", evidence: "needs a real session log; rerun with --session <id>" };
    const repoDir = join(tmp, "orch-eval-check-1");
    cpSync(REFERENCE, repoDir, { recursive: true, filter: (src) => !/[\\/](node_modules|\.DS_Store)$/.test(src) });
    await git(repoDir, ["init", "-q", "-b", "main"]);
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", "Reference"]);
    const resultsPath = join(tmp, "results.csv");
    const result = await run(
      process.execPath,
      ["scripts/score.ts", "--repo-dir", repoDir, "--session", values.session, "--no-github", "--results", resultsPath],
      { cwd: KIT_DIR, env: childEnv() },
    );
    if (result.code !== 0) return verdict(false, `exit ${result.code}: ${(result.stderr || result.stdout).trim()}`);
    const row = readResults(resultsPath).at(-1);
    if (!row) return verdict(false, "score exited 0 but wrote no row");
    const suiteOk = row.suite_passed === String(FULL_SUITE_TOTAL) && row.suite_total === String(FULL_SUITE_TOTAL);
    return verdict(
      suiteOk,
      `suite ${row.suite_passed}/${row.suite_total}, wall_minutes ${row.wall_minutes}, blocked_minutes ${row.blocked_minutes}, minutes ${row.minutes}, questions ${row.questions}`,
    );
  });

  await check("kit tests", () => npmTest(KIT_DIR));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((result) => result.status === "FAIL");
const counts = (status: Outcome["status"]) => results.filter((result) => result.status === status).length;
console.log(`\n${counts("PASS")} passed, ${failed.length} failed, ${counts("SKIP")} skipped`);
process.exitCode = failed.length > 0 ? 1 : 0;
