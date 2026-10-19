import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chooseRunSession, computeTiming, EventLogError, readEventLog, SessionChoiceError } from "./lib/events.ts";
import { detectFeatures, featureSetName, parseFeatures, type Feature } from "./lib/features.ts";
import { parseRunName } from "./lib/new-run.ts";
import { run } from "./lib/proc.ts";
import {
  appendResult,
  defaultCalibration,
  formatSummary,
  readResults,
  replaceResult,
  RESULT_COLUMNS,
  sameRun,
  summarize,
  type ResultRow,
} from "./lib/results.ts";
import { KIT_DIR, runSuite, suiteFiles } from "./lib/suite.ts";

const USAGE = `Usage:
  npm run score -- --repo-dir <run clone> [--session <id>] [--state-dir <dir>] [--variant <name>] [--n <k>]
                   [--features <list>] [--outcome <timeout|stalled>] [--calibration <yes|no>] [--results <csv>]
                   [--no-github] [--start <iso> --end <iso> [--blocked-min <m>] [--questions <n>]] [--note <text>]
                   [--answer-source <value>] [--end-at <iso>] [--replace]
  npm run score -- --summary [--results <csv>]`;
const TIMEOUT_MS = 90 * 60_000;

class UsageError extends Error {}

const { values } = parseArgs({
  options: {
    "repo-dir": { type: "string" },
    session: { type: "string" },
    "state-dir": { type: "string", default: join(homedir(), ".copilot", "session-state") },
    variant: { type: "string" },
    n: { type: "string" },
    features: { type: "string" },
    outcome: { type: "string" },
    calibration: { type: "string" },
    results: { type: "string", default: join(KIT_DIR, "results.csv") },
    "no-github": { type: "boolean", default: false },
    summary: { type: "boolean", default: false },
    start: { type: "string" },
    end: { type: "string" },
    "blocked-min": { type: "string" },
    questions: { type: "string" },
    "answer-source": { type: "string" },
    "end-at": { type: "string" },
    note: { type: "string" },
    replace: { type: "boolean", default: false },
  },
});

const minutes = (ms: number): string => (ms / 60_000).toFixed(1);

function parseTime(value: string, flag: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new UsageError(`${flag} "${value}" is not an ISO 8601 date and time`);
  return ms;
}

function parseCount(value: string, flag: string, integer: boolean): number {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new UsageError(`${flag} "${value}" must be a non-negative ${integer ? "integer" : "number"}`);
  }
  return number;
}

function githubSlug(origin: string): string | null {
  const match = origin.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

interface RunTiming {
  session: string;
  wallMs: number;
  blockedMs: number;
  scoredMs: number;
  questions: number;
  model: string;
  effort: string;
  copilotVersion: string;
  agent: string;
  warnings: string[];
}

function manualTiming(): RunTiming {
  if (!values.end) throw new UsageError("--start needs --end");
  const wallMs = parseTime(values.end, "--end") - parseTime(values.start!, "--start");
  if (wallMs < 0) throw new UsageError("--end is before --start");
  const blockedMs = values["blocked-min"] === undefined ? 0 : parseCount(values["blocked-min"], "--blocked-min", false) * 60_000;
  if (blockedMs > wallMs) throw new UsageError("--blocked-min is longer than the run");
  return {
    session: "manual",
    wallMs,
    blockedMs,
    scoredMs: wallMs - blockedMs,
    questions: values.questions === undefined ? 0 : parseCount(values.questions, "--questions", true),
    model: "",
    effort: "",
    copilotVersion: "",
    agent: "",
    warnings: [],
  };
}

function logTiming(stateDir: string, repository: string, variant: string, endAt: number | undefined, cutoff: number | undefined): RunTiming {
  let id = values.session;
  if (id) {
    console.log(`Session ${id} (from --session)`);
  } else {
    let chosen;
    try {
      chosen = chooseRunSession(stateDir, repository, variant);
    } catch (error) {
      if (error instanceof SessionChoiceError) throw error;
      throw new EventLogError(`Cannot read the session folder ${stateDir} (${(error as Error).message})`);
    }
    id = chosen.session.id;
    console.log(`Session ${id} (${chosen.rule})`);
  }
  const log = readEventLog(join(stateDir, id, "events.jsonl"));
  const timing = computeTiming(log.events, { endAt, cutoff, answerSource: values["answer-source"] });
  console.log(`Agent: ${timing.agent ?? "unknown"}; model: ${timing.model ?? "unknown"}, effort: ${timing.effort ?? "unknown"}`);
  return {
    session: id,
    wallMs: timing.wallMs,
    blockedMs: timing.blockedMs,
    scoredMs: timing.scoredMs,
    questions: timing.questions,
    model: timing.model ?? "",
    effort: timing.effort ?? "",
    copilotVersion: timing.copilotVersion ?? "",
    agent: timing.agent ?? "",
    warnings: [...log.warnings, ...timing.warnings],
  };
}

async function githubStats(slug: string, cloneDir: string, warnings: string[]): Promise<{ prsMerged: string; mainCi: string }> {
  let prsMerged = "unknown";
  const prs = await run("gh", ["pr", "list", "-R", slug, "--state", "merged", "--limit", "200", "--json", "number", "--jq", "length"]);
  if (prs.code === 0) prsMerged = prs.stdout.trim();
  else warnings.push(`gh pr list failed: ${prs.stderr.trim()}`);

  let mainCi = "unknown";
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: cloneDir })).stdout.trim();
  const runs = await run("gh", ["run", "list", "-R", slug, "--branch", "main", "--limit", "20", "--json", "headSha,status,conclusion"]);
  if (runs.code === 0) {
    const list = JSON.parse(runs.stdout) as { headSha: string; status: string; conclusion: string }[];
    const match = list.find((entry) => entry.headSha === head);
    mainCi = !match ? "none" : match.status === "completed" ? match.conclusion || match.status : match.status;
  } else {
    warnings.push(`gh run list failed: ${runs.stderr.trim()}`);
  }
  return { prsMerged, mainCi };
}

// The feature set the run started with: the spec in the run repo's first commit (new-run's "Seed v1").
// The evaluated main can change its own spec, so it must not decide which tests gate it.
async function seedFeatures(repoDir: string): Promise<Feature[] | null> {
  const roots = await run("git", ["-C", repoDir, "rev-list", "--max-parents=0", "HEAD"]);
  const root = roots.code === 0 ? roots.stdout.trim().split("\n").pop() : undefined;
  if (!root) return null;
  const spec = await run("git", ["-C", repoDir, "show", `${root}:docs/spec-v2.md`]);
  return spec.code === 0 ? detectFeatures(spec.stdout) : null;
}

async function main(): Promise<number> {
  const resultsPath = resolve(values.results);
  if (values.summary) {
    console.log(formatSummary(summarize(readResults(resultsPath))));
    return 0;
  }
  if (!values["repo-dir"]) throw new UsageError("--repo-dir is required");
  if (values.outcome !== undefined && !["timeout", "stalled"].includes(values.outcome)) {
    throw new UsageError(`--outcome must be timeout or stalled, not "${values.outcome}"`);
  }
  if (values.calibration !== undefined && !["yes", "no"].includes(values.calibration)) {
    throw new UsageError(`--calibration must be yes or no, not "${values.calibration}"`);
  }
  if (values["answer-source"] !== undefined && values["answer-source"].trim() === "") {
    throw new UsageError("--answer-source must not be empty");
  }
  for (const flag of ["answer-source", "end-at"] as const) {
    if (values.start && values[flag] !== undefined) throw new UsageError(`--${flag} cannot be used with manual timing (--start/--end)`);
  }
  const cutoff = values["end-at"] === undefined ? undefined : parseTime(values["end-at"], "--end-at");

  const repoDir = resolve(values["repo-dir"]);
  const parsed = parseRunName(basename(repoDir));
  const variant = values.variant ?? parsed?.variant;
  const n = values.n === undefined ? parsed?.n : parseCount(values.n, "--n", true);
  if (!variant || n === undefined) {
    throw new UsageError(`Cannot read the variant and run number from "${basename(repoDir)}"; pass --variant and --n`);
  }
  const features = values.features === undefined ? undefined : parseFeatures(values.features);
  const earlier = readResults(resultsPath);

  const origin = await run("git", ["-C", repoDir, "remote", "get-url", "origin"]);
  const slug = origin.code === 0 ? githubSlug(origin.stdout) : null;
  const github = values["no-github"] ? null : slug;
  const repo = slug ?? basename(repoDir);
  const runId = String(n);

  const replaced = earlier.filter((row) => sameRun(row, repo, runId));
  if (replaced.length > 0 && !values.replace) {
    console.error(
      `${resultsPath} already has a row for ${repo} run ${runId}, scored ${replaced[0].date}. To score it again, rerun with --replace; the new row replaces the old one.`,
    );
    return 2;
  }
  const others = earlier.filter((row) => !sameRun(row, repo, runId));
  const seeded = features === undefined ? await seedFeatures(repoDir) : null;

  let timing: RunTiming;
  if (values.start) {
    timing = manualTiming();
  } else {
    const stateDir = resolve(values["state-dir"]);
    try {
      // An unfinished run has no final report: time it to now, when it was found unfinished.
      const endAt = values.outcome === undefined ? undefined : Date.now();
      timing = logTiming(stateDir, slug ?? `local/${basename(repoDir)}`, variant, endAt, values.outcome === undefined ? cutoff : undefined);
    } catch (error) {
      if (error instanceof SessionChoiceError) {
        console.error(error.message);
        return 2;
      }
      if (!(error instanceof EventLogError)) throw error;
      console.error(
        `Could not time the run from the session log: ${error.message}. Time it by hand (README "Manual timing") and rerun with --start, --end, --blocked-min and --questions.`,
      );
      return 2;
    }
  }
  for (const warning of timing.warnings) console.log(`Warning: ${warning}`);

  const tmp = mkdtempSync(join(tmpdir(), "orch-eval-score-"));
  try {
    const cloneDir = join(tmp, "main");
    const clone = github
      ? await run("gh", ["repo", "clone", github, cloneDir, "--", "--branch", "main", "--depth", "1"])
      : await run("git", ["clone", "-q", "--branch", "main", repoDir, cloneDir]);
    if (clone.code !== 0) throw new Error(`Cloning main failed: ${clone.stderr.trim()}`);
    console.log(github ? `Cloned main of ${github}` : `Cloned main of the local repo ${repoDir}`);

    const warnings = [...timing.warnings];
    let runFeatures: Feature[];
    if (features) {
      runFeatures = features;
    } else {
      const mainSpec = join(cloneDir, "docs", "spec-v2.md");
      const onMain = existsSync(mainSpec) ? detectFeatures(readFileSync(mainSpec, "utf8")) : null;
      if (seeded) {
        runFeatures = seeded;
        const mainName = onMain ? featureSetName(onMain) : null;
        if (mainName !== featureSetName(seeded)) {
          warnings.push(`spec on main ${mainName ? `lists ${mainName}` : "is missing"}; scored against the seed's ${featureSetName(seeded)}`);
        }
      } else if (onMain) {
        runFeatures = onMain;
        warnings.push("the run repo's first commit has no docs/spec-v2.md; scored against the spec on main");
      } else {
        throw new Error("Neither the run repo's first commit nor main has docs/spec-v2.md; pass --features");
      }
    }
    for (const warning of warnings.slice(timing.warnings.length)) console.log(`Warning: ${warning}`);
    console.log(`Running the acceptance suite for ${featureSetName(runFeatures)}...`);
    const suite = await runSuite(cloneDir, suiteFiles(runFeatures));
    console.log(`Suite: ${suite.passed}/${suite.total} passed`);
    for (const name of suite.failures) console.log(`FAIL ${name}`);

    const { prsMerged, mainCi } = github ? await githubStats(github, cloneDir, warnings) : { prsMerged: "n/a", mainCi: "n/a" };

    const outcome = values.outcome ?? (timing.wallMs > TIMEOUT_MS ? "timeout" : suite.ok ? "passed" : "gate-failed");
    const calibration = values.calibration ?? defaultCalibration(others, variant, featureSetName(runFeatures));
    const row: ResultRow = {
      date: new Date().toISOString(),
      variant,
      run: runId,
      repo,
      session: timing.session,
      agent: timing.agent,
      features: featureSetName(runFeatures),
      calibration,
      outcome,
      minutes: minutes(timing.scoredMs),
      wall_minutes: minutes(timing.wallMs),
      blocked_minutes: minutes(timing.blockedMs),
      questions: String(timing.questions),
      suite_passed: String(suite.passed),
      suite_total: String(suite.total),
      prs_merged: prsMerged,
      main_ci: mainCi,
      model: timing.model,
      effort: timing.effort,
      copilot_version: timing.copilotVersion,
      note: values.note ?? warnings.join("; "),
    };
    if (replaced.length > 0) replaceResult(resultsPath, repo, runId, row);
    else appendResult(resultsPath, row);

    console.log(`\n${replaced.length > 0 ? "Replaced the earlier row in" : "Appended to"} ${resultsPath}:`);
    for (const column of RESULT_COLUMNS) console.log(`  ${column}: ${row[column]}`);
    console.log(`\n${formatSummary(summarize(readResults(resultsPath)))}`);
    console.log(`\nNow check for user-level memories saved during this run (README "Memory hygiene") and remove eval-related ones.`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error as Error).message);
  if (error instanceof UsageError) console.error(USAGE);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
