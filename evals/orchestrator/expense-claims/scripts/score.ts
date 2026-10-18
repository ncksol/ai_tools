import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { computeTiming, EventLogError, findRunSessions, readEventLog } from "./lib/events.ts";
import { detectFeatures, featureSetName, parseFeatures } from "./lib/features.ts";
import { parseRunName } from "./lib/new-run.ts";
import { run } from "./lib/proc.ts";
import { appendResult, formatSummary, readResults, RESULT_COLUMNS, summarize, type ResultRow } from "./lib/results.ts";
import { KIT_DIR, runSuite, suiteFiles } from "./lib/suite.ts";

const USAGE = `Usage:
  npm run score -- --repo-dir <run clone> [--session <id>] [--state-dir <dir>] [--variant <name>] [--n <k>]
                   [--features <list>] [--outcome <timeout|stalled>] [--calibration <yes|no>] [--results <csv>]
                   [--no-github] [--start <iso> --end <iso> [--blocked-min <m>] [--questions <n>]] [--note <text>]
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
    note: { type: "string" },
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

function logTiming(stateDir: string, repository: string, endAt: number | undefined): RunTiming {
  let id = values.session;
  if (id) {
    console.log(`Session ${id} (from --session)`);
  } else {
    let candidates;
    try {
      candidates = findRunSessions(stateDir, repository);
    } catch (error) {
      throw new EventLogError(`Cannot read the session folder ${stateDir} (${(error as Error).message})`);
    }
    if (candidates.length === 0) throw new EventLogError(`No session in ${stateDir} has repository ${repository}`);
    id = candidates[0].id;
    console.log(`Session ${id} (the oldest of ${candidates.length} session(s) for ${repository})`);
  }
  const log = readEventLog(join(stateDir, id, "events.jsonl"));
  const timing = computeTiming(log.events, { endAt });
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

  let timing: RunTiming;
  if (values.start) {
    timing = manualTiming();
  } else {
    const stateDir = resolve(values["state-dir"]);
    try {
      // An unfinished run has no final report: time it to now, when it was found unfinished.
      const endAt = values.outcome === undefined ? undefined : Date.now();
      timing = logTiming(stateDir, slug ?? `local/${basename(repoDir)}`, endAt);
    } catch (error) {
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

    const runFeatures = features ?? detectFeatures(readFileSync(join(cloneDir, "docs", "spec-v2.md"), "utf8"));
    console.log(`Running the acceptance suite for ${featureSetName(runFeatures)}...`);
    const suite = await runSuite(cloneDir, suiteFiles(runFeatures));
    console.log(`Suite: ${suite.passed}/${suite.total} passed`);
    for (const name of suite.failures) console.log(`FAIL ${name}`);

    const warnings = [...timing.warnings];
    const { prsMerged, mainCi } = github ? await githubStats(github, cloneDir, warnings) : { prsMerged: "n/a", mainCi: "n/a" };

    const outcome = values.outcome ?? (timing.wallMs > TIMEOUT_MS ? "timeout" : suite.ok ? "passed" : "gate-failed");
    const calibration = values.calibration ?? (earlier.some((row) => row.variant === variant) ? "no" : "yes");
    const row: ResultRow = {
      date: new Date().toISOString(),
      variant,
      run: String(n),
      repo: slug ?? basename(repoDir),
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
    appendResult(resultsPath, row);

    console.log(`\nAppended to ${resultsPath}:`);
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
