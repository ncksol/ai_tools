// A batch in a scratch folder for the runner tests: FakeApp for the app, a simulated clock, real
// new-run --dry-run and git, and a fake score that records its arguments and appends a row.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FakeApp, type Scenario } from "../../lib/batch/fake-app.ts";
import type { Notice } from "../../lib/batch/notify.ts";
import { processLock } from "../../lib/batch/lock.ts";
import { actAsDriver } from "../../lib/batch/rehearsal.ts";
import { currentPins, makeCtx, next, record, type ActionOut, type Ctx, type Deps, type RecordInput } from "../../lib/batch/runner.ts";
import { initialState, loadState, saveConfig, saveState, type BatchConfig, type BatchState } from "../../lib/batch/state.ts";
import { detectFeatures, featureSetName } from "../../lib/features.ts";
import { parseRunName } from "../../lib/new-run.ts";
import { run as runProc } from "../../lib/proc.ts";
import { appendResult, defaultCalibration, readResults, RESULT_COLUMNS, type ResultRow } from "../../lib/results.ts";
import { KIT_DIR } from "../../lib/suite.ts";

export interface Harness {
  dir: string;
  config: BatchConfig;
  ctx: Ctx;
  clock: { now: number };
  app: FakeApp;
  scoreCalls: string[][];
  notices: Notice[];
  awake: { started: number; stopped: number };
  next(maxWaitMs?: number): Promise<ActionOut>;
  record(input: RecordInput): Promise<string>;
  drive(action: ActionOut): Promise<void>;
  state(): BatchState;
  // Calls next and acts as the driver until `stop` says so or the batch is done.
  until(stop: (action: ActionOut, state: BatchState) => boolean, limit?: number): Promise<ActionOut>;
  resultsRepo: string;
  // Liveness answers for driverAlive, by driver id; missing means alive.
  alive: Map<string, boolean | null>;
}

const HEADER = RESULT_COLUMNS.join(",") + "\n";

function env(): NodeJS.ProcessEnv {
  const copy = { ...process.env };
  delete copy.NODE_TEST_CONTEXT;
  return copy;
}

export async function harness(opts: {
  scenarios: Scenario[];
  variants?: string[];
  runsPerVariant?: number;
  results?: string;
  selfTest?: boolean;
  minutes?: (runName: string) => number;
  deadlineMin?: number;
  activeGuard?: string;
  id?: string;
  runsDir?: string;
}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "orch-eval-runner-"));
  const variants = opts.variants ?? ["variant-a"];
  const runsDir = opts.runsDir ?? join(dir, "runs");
  const stateDir = join(dir, "session-state");
  const agentsDir = join(dir, "agents");
  const resultsRepo = join(dir, "checkout");
  for (const path of [runsDir, stateDir, agentsDir, resultsRepo]) mkdirSync(path, { recursive: true });
  for (const variant of variants) {
    writeFileSync(join(agentsDir, `${variant}.agent.md`), `Uses ${variant}-worker.\n`);
    writeFileSync(join(agentsDir, `${variant}-worker.agent.md`), "worker\n");
  }
  writeFileSync(join(resultsRepo, "results.csv"), opts.results ?? HEADER);
  const git = (args: string[]) => runProc("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: resultsRepo });
  await git(["init", "-q", "-b", "driver"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.invalid"]);
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", "base"]);
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.1.30</string>\n");
  writeFileSync(join(dir, "cli.d.ts"), 'COPILOT_CLI_VERSION = "1.0.99-2"\n');

  const clock = { now: Date.parse("2026-03-01T22:00:00.000Z") };
  const app = new FakeApp(stateDir, clock, [...(opts.selfTest ? (["selftest"] as Scenario[]) : []), ...opts.scenarios]);
  const config: BatchConfig = {
    id: opts.id ?? "test-batch",
    createdAt: new Date(clock.now).toISOString(),
    dir: join(dir, "batch"),
    variants,
    runsPerVariant: opts.runsPerVariant ?? 1,
    deadline: new Date(clock.now + (opts.deadlineMin ?? 600) * 60_000).toISOString(),
    model: "claude-opus-5.5",
    effort: "max",
    contextTier: "long_context",
    owner: "ncksol",
    runsDir,
    stateDir,
    agentsDir,
    appDb: join(dir, "none.db"),
    appPlist: join(dir, "Info.plist"),
    cliVersionFile: join(dir, "cli.d.ts"),
    resultsPath: join(resultsRepo, "results.csv"),
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
    minFreeGiB: 1,
    selfTest: { enabled: Boolean(opts.selfTest), only: false, model: "claude-sonnet-5.5", effort: "low", agent: null },
    notify: { urlFile: join(dir, "none"), envVar: "ORCH_EVAL_TEST_NO_ENV" },
    activeGuard: opts.activeGuard ?? join(dir, "active-batch"),
    keepAwake: true,
    push: false,
    dryRun: true,
    memoryOffConfirmed: true,
  };
  saveConfig(config);
  saveState(config.dir, initialState(currentPins(config), Boolean(opts.selfTest), new Date(clock.now).toISOString()));

  const scoreCalls: string[][] = [];
  const notices: Notice[] = [];
  const awake = { started: 0, stopped: 0 };
  const deps: Deps = {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      app.tick();
    },
    exec: async (cmd, args, execOpts) => {
      if (cmd === process.execPath && args[0] === config.scoreScript) {
        scoreCalls.push(args.slice(1));
        const flag = (name: string) => {
          const i = args.indexOf(name);
          return i < 0 ? undefined : args[i + 1];
        };
        const repoDir = flag("--repo-dir")!;
        const parsed = parseRunName(basename(repoDir))!;
        const features = featureSetName(detectFeatures(readFileSync(join(repoDir, "docs", "spec-v2.md"), "utf8")));
        const rows = readResults(config.resultsPath);
        const outcome = flag("--outcome") ?? "passed";
        const row = Object.fromEntries(RESULT_COLUMNS.map((c) => [c, ""])) as ResultRow;
        appendResult(config.resultsPath, {
          ...row,
          variant: parsed.variant,
          run: String(parsed.n),
          repo: basename(repoDir),
          session: flag("--session") ?? "",
          features,
          calibration: defaultCalibration(rows, parsed.variant, features),
          outcome,
          minutes: (opts.minutes?.(basename(repoDir)) ?? 20).toFixed(1),
          suite_passed: "59",
          suite_total: "59",
          note: flag("--note") ?? "",
        });
        return { code: 0, stdout: "scored", stderr: "" };
      }
      return runProc(cmd, args, { cwd: execOpts?.cwd, env: env(), timeoutMs: execOpts?.timeoutMs });
    },
    driverId: "session:driver-1",
    driverAlive: (id) => (h.alive.has(id) ? h.alive.get(id)! : true),
    // In-process exclusion; the OS lock itself is tested in batch-lock.test.ts.
    lock: processLock(),
    notify: async (notice) => {
      notices.push(notice);
      return { ok: true };
    },
    appDb: app,
    awake: {
      start: () => {
        awake.started++;
        return 4242;
      },
      alive: () => awake.started > awake.stopped,
      stop: () => {
        awake.stopped++;
      },
    },
    log: () => {},
  };
  const ctx = makeCtx(config, deps);
  const h: Harness = {
    dir,
    config,
    ctx,
    clock,
    app,
    scoreCalls,
    notices,
    awake,
    resultsRepo,
    alive: new Map<string, boolean | null>(),
    next: (maxWaitMs = 540_000) => next(ctx, { maxWaitMs }),
    record: (input) => record(ctx, input),
    drive: (action) => actAsDriver(ctx, app, clock, action),
    state: () => loadState(config.dir),
    until: async (stop, limit = 500) => {
      for (let i = 0; i < limit; i++) {
        const action = await h.next();
        if (action.action === "done" || stop(action, h.state())) return action;
        await h.drive(action);
      }
      throw new Error("the batch did not reach the expected point");
    },
  };
  return h;
}

export const FIXTURE_HEADER = HEADER;
