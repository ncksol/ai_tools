import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chooseRunSession, computeTiming, EventLogError, readEventLog, SessionChoiceError } from "./lib/events.ts";
import { openAppDb } from "./lib/batch/appdb.ts";
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
import { KIT_DIR, ROBUSTNESS_TIMEOUT_MS, robustnessFiles, robustnessSha256, runSuite, suiteFiles } from "./lib/suite.ts";
import { collectUsage, readPricing, type UsageSummary } from "./lib/usage.ts";
import { variantLabel } from "./lib/variants.ts";

const USAGE = `Usage:
  npm run score -- --repo-dir <run clone> [--session <id>] [--state-dir <dir>] [--variant <name>] [--n <k>]
                   [--features <list>] [--outcome <timeout|stalled>] [--calibration <yes|no>] [--results <csv>]
                   [--no-github] [--start <iso> --end <iso> [--blocked-min <m>] [--questions <n>]] [--note <text>]
                   [--answer-source <value>] [--end-at <iso>] [--replace]
                   [--app-db <path>] [--pricing <json>]
                   [--agent-revision <sha> --agent-sha256 <hash> --agent-bundle-sha256 <hash>]
  npm run score -- --summary [--results <csv>]`;
const TIMEOUT_MS = 90 * 60_000;

// Test-only: a shorter robustness budget, in milliseconds, so tests can show a hung suite being stopped.
function robustnessBudget(): number {
  const value = process.env.ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS;
  if (value === undefined) return ROBUSTNESS_TIMEOUT_MS;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0 || ms > ROBUSTNESS_TIMEOUT_MS) {
    throw new UsageError(`ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS "${value}" must be a positive integer no greater than ${ROBUSTNESS_TIMEOUT_MS}`);
  }
  return ms;
}

class UsageError extends Error {}

const { values } = parseArgs({
  options: {
    "repo-dir": { type: "string" },
    session: { type: "string" },
    "state-dir": { type: "string", default: join(homedir(), ".copilot", "session-state") },
    "app-db": { type: "string", default: join(homedir(), ".copilot", "data.db") },
    pricing: { type: "string", default: join(KIT_DIR, "pricing", "2026-10-20.json") },
    "agent-revision": { type: "string" },
    "agent-sha256": { type: "string" },
    "agent-bundle-sha256": { type: "string" },
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
  if (flag === "--end-at" && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new UsageError("--end-at must include Z or a UTC offset (+/-hh:mm)");
  }
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
  start: string;
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
    start: values.start!,
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
    start: timing.start,
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
  const robustnessTimeoutMs = robustnessBudget();
  const cutoff = values["end-at"] === undefined ? undefined : parseTime(values["end-at"], "--end-at");
  const provenance = ["agent-revision", "agent-sha256", "agent-bundle-sha256"] as const;
  if (provenance.some((key) => values[key] !== undefined)) {
    if (values["agent-revision"] !== undefined && !/^[a-f0-9]{40}$/.test(values["agent-revision"])) {
      throw new UsageError("--agent-revision must be a 40-character lowercase hex git sha");
    }
    for (const key of ["agent-sha256", "agent-bundle-sha256"] as const) {
      if (!/^[a-f0-9]{64}$/.test(values[key] ?? "")) {
        throw new UsageError(`--${key} must be supplied with the other provenance flags and contain its full hash`);
      }
    }
    if (values.start) throw new UsageError("Agent provenance requires session-log timing, not manual timing");
  }

  const repoDir = resolve(values["repo-dir"]);
  const parsed = parseRunName(basename(repoDir));
  const variant = values.variant === undefined ? parsed?.variant : variantLabel(values.variant);
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

  const capturedAt = new Date().toISOString();
  let usage: UsageSummary | null = null;
  let pricingVersion = "";
  const costWarnings: string[] = [];
  if (timing.session !== "manual") {
    try {
      const pricing = readPricing(resolve(values.pricing));
      pricingVersion = pricing.version;
      const db = openAppDb(values["app-db"]);
      usage = collectUsage({
        stateDir: resolve(values["state-dir"]), rootId: timing.session, start: timing.start, capturedAt, pricing,
        resolveSession: (id: string) => db.sessionForWorkspace(id),
        children: (id: string) => {
          const children = db.childSessions(id);
          const errors = db.takeErrors();
          if (children === null || errors.length > 0) throw new Error(errors.join("; ") || "Cannot discover descendant sessions");
          return children;
        },
        aliases: (id: string) => {
          const aliases = db.sessionAliases(id);
          const errors = db.takeErrors();
          if (aliases === null || errors.length > 0) throw new Error(errors.join("; ") || "Cannot discover session aliases");
          return aliases;
        },
      });
      costWarnings.push(...usage.warnings.map((warning) => `cost: ${warning}`));
    } catch (error) {
      costWarnings.push(`cost unavailable: ${(error as Error).message}`);
    }
  }
  for (const warning of costWarnings) console.log(`Warning: ${warning}`);

  const tmp = mkdtempSync(join(tmpdir(), "orch-eval-score-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  process.once("exit", cleanup);
  try {
    const cloneDir = join(tmp, "main");
    const clone = github
      ? await run("gh", ["repo", "clone", github, cloneDir, "--", "--branch", "main", "--depth", "1"])
      : await run("git", ["clone", "-q", "--branch", "main", repoDir, cloneDir]);
    if (clone.code !== 0) throw new Error(`Cloning main failed: ${clone.stderr.trim()}`);
    console.log(github ? `Cloned main of ${github}` : `Cloned main of the local repo ${repoDir}`);

    const warnings = [...timing.warnings, ...costWarnings];
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
    for (const warning of warnings.slice(timing.warnings.length + costWarnings.length)) console.log(`Warning: ${warning}`);
    console.log(`Running the acceptance suite for ${featureSetName(runFeatures)}...`);
    const suite = await runSuite(cloneDir, suiteFiles(runFeatures));
    console.log(`Suite: ${suite.passed}/${suite.total} passed`);
    for (const name of suite.failures) console.log(`FAIL ${name}`);

    const { prsMerged, mainCi } = github ? await githubStats(github, cloneDir, warnings) : { prsMerged: "n/a", mainCi: "n/a" };

    const outcome = values.outcome ?? (timing.wallMs > TIMEOUT_MS ? "timeout" : suite.ok ? "passed" : "gate-failed");
    const calibration = values.calibration ?? defaultCalibration(others, variant, featureSetName(runFeatures));
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: cloneDir });
    if (head.code !== 0) throw new Error(`Cannot identify scored main commit: ${head.stderr.trim()}`);
    const files = robustnessFiles(runFeatures);
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
      agent_revision: values["agent-revision"] ?? "",
      agent_sha256: values["agent-sha256"] ?? "",
      agent_bundle_sha256: values["agent-bundle-sha256"] ?? "",
      main_sha: head.stdout.trim(),
      robustness_status: files.length === 0 ? "not-applicable" : "error",
      robustness_passed: "",
      robustness_total: "",
      robustness_sha256: "",
      cost_status: usage?.status ?? "unavailable",
      cost_usd: usage?.usd == null ? "" : usage.usd.toFixed(9),
      pricing_version: pricingVersion,
      cost_captured_at: timing.session === "manual" ? "" : capturedAt,
      cost_sessions: usage ? String(usage.sessions) : "",
      usage_records: usage ? String(usage.records) : "",
      input_tokens_all_models: usage?.records ? String(usage.tokens.inputTokens) : "",
      cache_read_tokens_all_models: usage?.records ? String(usage.tokens.cacheReadTokens) : "",
      cache_write_tokens_all_models: usage?.records ? String(usage.tokens.cacheWriteTokens) : "",
      output_tokens_all_models: usage?.records ? String(usage.tokens.outputTokens) : "",
      note: [values.note, ...warnings, ...(files.length ? ["robustness has not completed"] : [])].filter(Boolean).join("; "),
    };
    // Persist the gate first: even an outer score timeout during diagnostics must leave a scored row.
    if (replaced.length > 0) replaceResult(resultsPath, repo, runId, row);
    else appendResult(resultsPath, row);

    if (files.length > 0) {
      try {
        row.robustness_sha256 = robustnessSha256(files, { timeoutMs: robustnessTimeoutMs });
        console.log(`Robustness suite sha256: ${row.robustness_sha256}`);
        const robustness = await runSuite(cloneDir, files, { timeoutMs: robustnessTimeoutMs });
        if (robustness.timedOut) {
          const warning = `robustness error: stopped after its ${Math.ceil(robustnessTimeoutMs / 1000)} s budget`;
          warnings.push(warning);
          console.log(`Warning: ${warning}`);
        } else {
          row.robustness_passed = String(robustness.passed);
          row.robustness_total = String(robustness.total);
          row.robustness_status = robustness.ok ? "passed" : robustness.total > 0 ? "failed" : "error";
          console.log(`Robustness (not the gate): ${robustness.passed}/${robustness.total} passed`);
          for (const failure of robustness.failures) console.log(`ROBUSTNESS FAIL ${failure}`);
          if (!robustness.ok) warnings.push(`robustness ${row.robustness_status}: ${robustness.failures.join("; ") || "no passing complete suite"}`);
        }
      } catch (error) {
        const warning = `robustness execution error: ${(error as Error).message}`;
        warnings.push(warning);
        console.log(`Warning: ${warning}`);
      }
      row.note = [values.note, ...warnings].filter(Boolean).join("; ");
      replaceResult(resultsPath, repo, runId, row);
    }

    console.log(`\n${replaced.length > 0 ? "Replaced the earlier row in" : "Appended to"} ${resultsPath}:`);
    for (const column of RESULT_COLUMNS) console.log(`  ${column}: ${row[column]}`);
    console.log(`\n${formatSummary(summarize(readResults(resultsPath)))}`);
    console.log(`\nNow check for user-level memories saved during this run (README "Memory hygiene") and remove eval-related ones.`);
    return 0;
  } finally {
    process.off("exit", cleanup);
    cleanup();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error as Error).message);
  if (error instanceof UsageError) console.error(USAGE);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
