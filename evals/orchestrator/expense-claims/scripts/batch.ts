// The overnight runner's command line. See README "Overnight batches".
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { openAppDb, noAppDb } from "./lib/batch/appdb.ts";
import { pidAlive } from "./lib/batch/lock.ts";
import { notices, readNtfyUrl, sendNtfy } from "./lib/batch/notify.ts";
import { describePlan, calibrationDecision } from "./lib/batch/plan.ts";
import { formatChecks, MANUAL_STEPS, runPreflight } from "./lib/batch/preflight.ts";
import { rehearse } from "./lib/batch/rehearsal.ts";
import { buildReport } from "./lib/batch/report.ts";
import { currentPins, makeCtx, next, record, requestStop, statusText, takeOver, type Deps, type RecordInput } from "./lib/batch/runner.ts";
import {
  batchId,
  defaultPaths,
  initialState,
  loadConfig,
  loadState,
  nextLocalTime,
  NTFY_ENV_VAR,
  saveConfig,
  saveState,
  validateConfig,
  type BatchConfig,
} from "./lib/batch/state.ts";
import { run } from "./lib/proc.ts";
import { readResults } from "./lib/results.ts";
import { KIT_DIR } from "./lib/suite.ts";

const USAGE = `Usage (from evals/orchestrator/expense-claims):
  npm run batch -- init [--variants a,b] [--runs 3] [--deadline 07:00] [--memory-off] [--self-test-only] [options]
  npm run batch -- next --batch <id|path|latest> [--max-wait 420]
  npm run batch -- record --batch <id|path|latest> --action <id> <result flags>
  npm run batch -- status|stop|report --batch <id|path|latest>
  npm run batch -- take-over --batch <id|path|latest>   (you only: release a batch whose driver is gone)
  npm run batch -- alert --batch <id|path|latest> --message <text>
  npm run batch -- notify-test
  npm run batch -- rehearse

init options: --model claude-opus-5.5 --effort max --context-tier long_context --owner ncksol
  --self-test-model claude-sonnet-5.5 --self-test-effort low --self-test-agent <name>
  --runs-dir <dir> --batches-dir <dir> --no-push --dry-run (tests only; never drive it with app tools)
record flags: --project-id <id> | --session-id <id> | --answered | --row <n> [--request-id <id>] [--choice <text>] | --not-pending
  | --final <messageId> | --question <messageId> [--row <n>] | --neither | --sent | --failed <error>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    batch: { type: "string" },
    "batches-dir": { type: "string", default: defaultPaths().batchesDir },
    "max-wait": { type: "string", default: "420" },
    // init
    variants: { type: "string", default: "orchestrator,session-orchestrator" },
    runs: { type: "string", default: "3" },
    deadline: { type: "string", default: "07:00" },
    model: { type: "string", default: "claude-opus-5.5" },
    effort: { type: "string", default: "max" },
    "context-tier": { type: "string", default: "long_context" },
    owner: { type: "string", default: "ncksol" },
    "runs-dir": { type: "string", default: defaultPaths().runsDir },
    "state-dir": { type: "string", default: defaultPaths().stateDir },
    "agents-dir": { type: "string", default: defaultPaths().agentsDir },
    "app-db": { type: "string", default: defaultPaths().appDb },
    results: { type: "string", default: defaultPaths().resultsPath },
    "ntfy-url-file": { type: "string", default: defaultPaths().ntfyUrlFile },
    "self-test-only": { type: "boolean", default: false },
    "self-test-model": { type: "string", default: "claude-sonnet-5.5" },
    "self-test-effort": { type: "string", default: "low" },
    "self-test-agent": { type: "string" },
    "memory-off": { type: "boolean", default: false },
    "no-push": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    id: { type: "string" },
    // record
    action: { type: "string" },
    "project-id": { type: "string" },
    "session-id": { type: "string" },
    answered: { type: "boolean", default: false },
    "request-id": { type: "string" },
    row: { type: "string" },
    choice: { type: "string" },
    "not-pending": { type: "boolean", default: false },
    final: { type: "string" },
    question: { type: "string" },
    neither: { type: "boolean", default: false },
    sent: { type: "boolean", default: false },
    failed: { type: "string" },
    message: { type: "string" },
  },
});

class UsageError extends Error {}

function resolveBatchDir(): string {
  const value = values.batch;
  if (!value) throw new UsageError("--batch is required");
  if (value === "latest") {
    const root = values["batches-dir"];
    const dirs = existsSync(root) ? readdirSync(root).filter((name) => existsSync(join(root, name, "config.json"))) : [];
    if (dirs.length === 0) throw new Error(`No batches in ${root}`);
    return join(root, dirs.sort((a, b) => statSync(join(root, a)).mtimeMs - statSync(join(root, b)).mtimeMs).at(-1)!);
  }
  if (value.includes("/")) return resolve(value);
  return join(values["batches-dir"], value);
}

function realDeps(config: BatchConfig): Deps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    exec: (cmd, args, opts) => run(cmd, args, { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs }),
    driverId: process.env.COPILOT_AGENT_SESSION_ID ? `session:${process.env.COPILOT_AGENT_SESSION_ID}` : "local",
    // An app session's CLI holds inuse.<pid>.lock in its session folder while it runs.
    driverAlive: (id) => {
      const match = /^session:(.+)$/.exec(id);
      if (!match) return null;
      const dir = join(config.stateDir, match[1]);
      if (!existsSync(dir)) return null;
      return readdirSync(dir).some((name) => {
        const pid = /^inuse\.(\d+)\.lock$/.exec(name)?.[1];
        return pid !== undefined && pidAlive(Number(pid));
      });
    },
    notify: async (notice) => {
      const url = readNtfyUrl({ envVar: config.notify.envVar, urlFile: config.notify.urlFile });
      return url ? sendNtfy(url, notice) : { ok: false, error: "no ntfy topic configured" };
    },
    appDb: config.dryRun ? noAppDb : openAppDb(config.appDb),
    awake: {
      // A detached caffeinate with a time limit, so it outlives this short-lived process but not the night.
      start: (untilMs) => {
        const seconds = Math.max(60, Math.round((untilMs - Date.now()) / 1000));
        const child = spawn("/usr/bin/caffeinate", ["-i", "-s", "-t", String(seconds)], { detached: true, stdio: "ignore" });
        child.unref();
        return child.pid ?? null;
      },
      alive: (pid) => {
        const ps = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
        return ps.status === 0 && ps.stdout.includes("caffeinate");
      },
      stop: (pid) => {
        const ps = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
        if (ps.status === 0 && ps.stdout.includes("caffeinate")) process.kill(pid, "SIGTERM");
      },
    },
    log: (line) => console.error(line),
  };
}

async function confirmMemoryOff(): Promise<boolean> {
  if (values["memory-off"]) return true;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question("Is Copilot Memory turned off at https://github.com/settings/copilot/features? Type yes to confirm: ");
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

async function init(): Promise<number> {
  const now = new Date();
  const paths = defaultPaths();
  const variants = values["self-test-only"] ? [] : values.variants.split(",").map((name) => name.trim()).filter(Boolean);
  const id = values.id ?? batchId(now);
  const dir = join(values["batches-dir"], id);
  if (existsSync(join(dir, "config.json"))) throw new Error(`Batch ${id} already exists at ${dir}`);
  const config: BatchConfig = {
    id,
    createdAt: now.toISOString(),
    dir,
    variants,
    runsPerVariant: Number(values.runs),
    deadline: nextLocalTime(values.deadline, now).toISOString(),
    model: values.model,
    effort: values.effort,
    contextTier: values["context-tier"],
    owner: values.owner,
    runsDir: resolve(values["runs-dir"]),
    stateDir: resolve(values["state-dir"]),
    agentsDir: resolve(values["agents-dir"]),
    appDb: resolve(values["app-db"]),
    appPlist: paths.appPlist,
    cliVersionFile: paths.cliVersionFile,
    resultsPath: resolve(values.results),
    kitDir: KIT_DIR,
    scoreScript: join(KIT_DIR, "scripts", "score.ts"),
    newRunScript: join(KIT_DIR, "scripts", "new-run.ts"),
    timeoutMin: 90,
    stallMin: 15,
    idleSettleSec: 20,
    swarmSettleSec: 60,
    quietWaitMin: 5,
    drainMaxMin: 20,
    sessionAppearMin: 10,
    pollSec: 10,
    minFreeGiB: 20,
    selfTest: { enabled: true, only: values["self-test-only"], model: values["self-test-model"], effort: values["self-test-effort"], agent: values["self-test-agent"] ?? null },
    notify: { urlFile: resolve(values["ntfy-url-file"]), envVar: NTFY_ENV_VAR },
    // Machine-wide for real batches; a dry run (tests) keeps its own guard beside its batches.
    activeGuard: values["dry-run"] ? join(values["batches-dir"], "active-batch.json") : paths.activeGuard,
    keepAwake: !values["dry-run"],
    push: !values["no-push"],
    dryRun: values["dry-run"],
    memoryOffConfirmed: false,
  };
  const problems = validateConfig(config);
  if (problems.length > 0) throw new UsageError(problems.join("; "));
  config.memoryOffConfirmed = await confirmMemoryOff();

  const checks = await runPreflight(config, {
    exec: (cmd, args, opts) => run(cmd, args, { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs }),
    nodeVersion: process.version,
    appDb: config.dryRun ? noAppDb : openAppDb(config.appDb),
  });
  console.log(`Preflight for batch ${id}:\n${formatChecks(checks)}\n`);
  console.log(`One-time manual steps (only you can do these):\n${MANUAL_STEPS.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n`);
  if (checks.some((check) => check.status === "FAIL")) {
    console.log("Preflight failed; no batch was created. Fix the FAIL lines and run init again.");
    return 1;
  }
  saveConfig(config);
  const state = initialState(currentPins(config), config.selfTest.enabled, now.toISOString());
  state.resultsBase = (await run("git", ["rev-parse", "HEAD"], { cwd: dirname(config.resultsPath), timeoutMs: 60_000 })).stdout.trim() || undefined;
  saveState(dir, state);
  const decision = calibrationDecision(readResults(config.resultsPath), config.variants);
  console.log(`Batch ${id} created at ${dir}.`);
  if (!config.selfTest.only) console.log(`Plan: ${describePlan(config.variants, config.runsPerVariant, decision)}. Calibration: ${decision.reason}`);
  console.log(`No new run starts after ${new Date(config.deadline).toString()}.`);
  if (config.dryRun) console.log("\nDRY RUN: for tests only. Never drive this batch with app tools.");
  else {
    console.log(`\nNow start the driver: in the Copilot app, start a new session in your ai_tools project (a worktree, not main),`);
    console.log(`with the agent eval-runner, in autopilot mode, and send:\n\n  Run eval batch ${id}.\n`);
  }
  return 0;
}

function recordInput(): RecordInput {
  if (!values.action) throw new UsageError("--action is required");
  const row = values.row === undefined ? undefined : Number(values.row);
  if (row !== undefined && !(Number.isInteger(row) && row >= 1 && row <= 4)) throw new UsageError("--row must be 1, 2, 3 or 4");
  return {
    action: values.action,
    projectId: values["project-id"],
    sessionId: values["session-id"],
    row,
    answered: values.answered,
    requestId: values["request-id"],
    choice: values.choice,
    notPending: values["not-pending"],
    final: values.final,
    question: values.question,
    neither: values.neither,
    sent: values.sent,
    failed: values.failed,
  };
}

async function main(): Promise<number> {
  const command = positionals[0];
  switch (command) {
    case "init":
      return init();
    case "selftest":
      values["self-test-only"] = true;
      return init();
    case "rehearse": {
      const result = await rehearse({ log: (line) => console.log(line) });
      console.log(`\nNotifications the local stub received:`);
      for (const notice of result.notifications) console.log(`- [${notice.priority}] ${notice.title}: ${notice.body}`);
      console.log(`\n${readFileSync(String(result.final.details?.report), "utf8")}`);
      console.log(`Rehearsal files: ${result.dir}\nNote: score times timeout and stalled runs to the real clock, so their minutes are wrong in a rehearsal.`);
      return 0;
    }
    case "notify-test": {
      const paths = defaultPaths();
      const url = readNtfyUrl({ envVar: NTFY_ENV_VAR, urlFile: resolve(values["ntfy-url-file"] ?? paths.ntfyUrlFile) });
      if (!url) {
        console.error(`No ntfy topic: set $${NTFY_ENV_VAR} or put the topic URL in ${values["ntfy-url-file"]}`);
        return 1;
      }
      const result = await sendNtfy(url, { ...notices.failure("test", "test", "This is a test notification from the eval runner."), title: "Eval runner test" });
      console.log(result.ok ? "Sent. Check your phone." : `Not sent: ${result.error}`);
      return result.ok ? 0 : 1;
    }
    case "alert": {
      // For the driver when the runner itself keeps failing: the runner still sends the notice.
      const config = loadConfig(resolveBatchDir());
      if (!values.message) throw new UsageError("--message is required");
      const result = await realDeps(config).notify(notices.failure(config.id, `alert-${Date.now()}`, values.message));
      console.log(result.ok ? "Alert sent." : `Alert not sent: ${result.error}`);
      return result.ok ? 0 : 1;
    }
    case "next":
    case "record":
    case "status":
    case "stop":
    case "take-over":
    case "report": {
      const config = loadConfig(resolveBatchDir());
      const ctx = makeCtx(config, realDeps(config));
      if (command === "next") {
        const maxWait = Number(values["max-wait"]);
        if (!(maxWait >= 0 && maxWait <= 590)) throw new UsageError("--max-wait must be 0 to 590 seconds");
        const action = await next(ctx, { maxWaitMs: maxWait * 1000 });
        console.log(JSON.stringify(action, null, 2));
      } else if (command === "record") console.log(await record(ctx, recordInput()));
      else if (command === "status") console.log(statusText(ctx));
      else if (command === "stop") console.log(await requestStop(ctx));
      else if (command === "take-over") console.log(await takeOver(ctx));
      else {
        const state = loadState(config.dir);
        const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: KIT_DIR, timeoutMs: 60_000 })).stdout.trim();
        console.log(buildReport(config, state, ctx.deps.appDb, { branch: branch || null, commits: [], pushed: null }));
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error((error as Error).message);
  if (error instanceof UsageError) console.error(USAGE);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
