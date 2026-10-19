// The stubbed rehearsal of a whole batch: the real runner, new-run --dry-run, score and git, with
// the app and the driver agent replaced by FakeApp and a scripted driver on a simulated clock.
// Notifications go to a local HTTP stub, never to ntfy. Nothing reaches GitHub or the real app.
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runProc } from "../proc.ts";
import { KIT_DIR } from "../suite.ts";
import { FakeApp, type Scenario } from "./fake-app.ts";
import { withLock } from "./lock.ts";
import { readNtfyUrl, sendNtfy, type Notice } from "./notify.ts";
import { currentPins, makeCtx, next, record, type ActionOut, type Ctx, type Deps, type RecordInput } from "./runner.ts";
import { initialState, saveConfig, saveState, type BatchConfig } from "./state.ts";

export interface RehearsalResult {
  dir: string;
  config: BatchConfig;
  transcript: string[];
  notifications: { title: string; body: string; priority: string }[];
  final: ActionOut;
  app: FakeApp;
  awake: { started: number; stopped: number };
}

export const REHEARSAL_VARIANTS = ["variant-a", "variant-b"];

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProc("git", ["-c", "user.name=Rehearsal", "-c", "user.email=rehearsal@example.invalid", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// A local stand-in for ntfy that keeps every notification it receives.
export async function startNtfyStub(): Promise<{ url: string; received: { title: string; body: string; priority: string }[]; close: () => Promise<void> }> {
  const received: { title: string; body: string; priority: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ title: String(req.headers.title ?? ""), body, priority: String(req.headers.priority ?? "") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/rehearsal-topic`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export async function rehearse(opts: { scenarios?: Scenario[]; runsPerVariant?: number; log?: (line: string) => void } = {}): Promise<RehearsalResult> {
  const dir = mkdtempSync(join(tmpdir(), "orch-eval-rehearsal-"));
  const runsDir = join(dir, "runs");
  const stateDir = join(dir, "session-state");
  const agentsDir = join(dir, "agents");
  const resultsRepo = join(dir, "ai_tools-checkout");
  for (const path of [runsDir, stateDir, agentsDir, resultsRepo]) mkdirSync(path, { recursive: true });
  for (const variant of REHEARSAL_VARIANTS) writeFileSync(join(agentsDir, `${variant}.agent.md`), `---\ndescription: rehearsal stand-in\n---\nUses ${variant}-worker.\n`);
  for (const variant of REHEARSAL_VARIANTS) writeFileSync(join(agentsDir, `${variant}-worker.agent.md`), "---\ndescription: rehearsal worker\n---\n");
  // The real results.csv, so the calibration rule sees the real history.
  copyFileSync(join(KIT_DIR, "results.csv"), join(resultsRepo, "results.csv"));
  await git(resultsRepo, ["init", "-q", "-b", "driver-branch"]);
  await git(resultsRepo, ["config", "user.name", "Rehearsal"]);
  await git(resultsRepo, ["config", "user.email", "rehearsal@example.invalid"]);
  await git(resultsRepo, ["add", "-A"]);
  await git(resultsRepo, ["commit", "-q", "-m", "Results before the rehearsal"]);
  const appPlist = join(dir, "Info.plist");
  writeFileSync(appPlist, "<plist><dict><key>CFBundleShortVersionString</key>\n<string>1.1.30</string></dict></plist>\n");
  const cliVersionFile = join(dir, "cliVersion.d.ts");
  writeFileSync(cliVersionFile, 'export declare const COPILOT_CLI_VERSION = "1.0.99-2";\n');
  const ntfy = await startNtfyStub();
  const urlFile = join(dir, "ntfy-url");
  writeFileSync(urlFile, `${ntfy.url}\n`);

  // Simulated time starts 12 hours ago, so score's own clock (used for timeout and stalled runs) is
  // never before a kickoff. Those runs' wall minutes are therefore wrong in a rehearsal.
  const clock = { now: Date.now() - 12 * 60 * 60_000 };
  const app = new FakeApp(stateDir, clock, ["selftest", ...(opts.scenarios ?? ["ask-final", "plain-final", "stall", "timeout"])]);
  const config: BatchConfig = {
    id: "rehearsal",
    createdAt: new Date(clock.now).toISOString(),
    dir: join(dir, "batch"),
    variants: REHEARSAL_VARIANTS,
    runsPerVariant: opts.runsPerVariant ?? 2,
    deadline: new Date(clock.now + 10 * 60 * 60_000).toISOString(),
    model: "claude-opus-5.5",
    effort: "max",
    contextTier: "long_context",
    owner: "ncksol",
    runsDir,
    stateDir,
    agentsDir,
    appDb: join(dir, "no-data.db"),
    appPlist,
    cliVersionFile,
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
    selfTest: { enabled: true, only: false, model: "claude-sonnet-5.5", effort: "low", agent: null },
    notify: { urlFile, envVar: "ORCH_EVAL_REHEARSAL_NO_ENV" },
    activeGuard: join(dir, "active-batch.json"),
    keepAwake: true,
    push: false,
    dryRun: true,
    memoryOffConfirmed: true,
  };
  saveConfig(config);
  const state = initialState(currentPins(config), true, new Date(clock.now).toISOString());
  state.resultsBase = (await runProc("git", ["rev-parse", "HEAD"], { cwd: resultsRepo })).stdout.trim();
  saveState(config.dir, state);

  const transcript: string[] = [];
  const say = (line: string) => {
    transcript.push(line);
    opts.log?.(line);
  };
  const awake = { started: 0, stopped: 0 };
  const deps: Deps = {
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      app.tick();
    },
    exec: (cmd, args, execOpts) => runProc(cmd, args, { cwd: execOpts?.cwd, env: childEnv(), timeoutMs: execOpts?.timeoutMs }),
    driverId: "session:rehearsal-driver",
    driverAlive: () => true,
    // The real OS lock, as in a batch.
    lock: (lockDir, fn) => withLock(lockDir, fn, { waitMs: 60_000, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() }),
    notify: async (notice: Notice) => {
      const url = readNtfyUrl({ envVar: config.notify.envVar, urlFile: config.notify.urlFile });
      return url ? sendNtfy(url, notice) : { ok: false, error: "no topic" };
    },
    appDb: app,
    awake: {
      start: () => {
        awake.started++;
        return 424242;
      },
      alive: () => awake.started > awake.stopped,
      stop: () => {
        awake.stopped++;
      },
    },
    log: () => {},
  };
  const ctx: Ctx = makeCtx(config, deps);
  let final: ActionOut | null = null;
  try {
    for (let guard = 0; guard < 2000 && !final; guard++) {
      const action = await next(ctx, { maxWaitMs: 540_000 });
      if (action.action === "done") final = action;
      else await actAsDriver(ctx, app, clock, action, say);
    }
  } finally {
    await ntfy.close();
  }
  if (!final) throw new Error("the rehearsal did not finish");
  return { dir, config, transcript, notifications: ntfy.received, final, app, awake };
}

// The scripted driver: does what the eval-runner agent file says for one action, against FakeApp.
// It follows the same contract as the agent: a fixed answer only when tool.args.answer is present,
// a question-text check before answering, and the self-test's own completion rule. Its judgments
// are simple text rules that fit FakeApp's scripted messages.
export async function actAsDriver(ctx: Ctx, app: FakeApp, clock: { now: number }, action: ActionOut, say: (line: string) => void = () => {}): Promise<void> {
  if (action.action === "wait" || action.action === "done") return;
  say(`[${new Date(clock.now).toISOString().slice(11, 19)}] ${action.action}${action.id ? ` ${action.id}` : ""} (${action.target}${action.run ? ` ${action.run}` : ""}): ${action.what.split(".")[0]}`);
  const act = async (input: Omit<RecordInput, "action">, line: string) => {
    clock.now += 5_000;
    say(`  -> ${line}: ${await record(ctx, { action: action.id!, ...input })}`);
    app.tick();
  };
  const args = action.tool?.args ?? {};
  const details = action.details ?? {};
  switch (action.action) {
    case "create_project":
      await act({ projectId: app.createProject(String(args.path)) }, "create_project");
      break;
    case "create_session":
      await act({ sessionId: app.createSession(args) }, `create_session (agent ${String((args.kickoff as Record<string, unknown>).agent ?? "default")})`);
      break;
    case "lookup_session":
      await act({ sessionId: app.workspaceForSession(String(args.project_session_id)) ?? undefined }, "get_session");
      break;
    case "answer_question": {
      const pending = app.getSession(String(args.project_session_id)).awaiting_input;
      if (!pending) {
        await act({ notPending: true }, "nothing pending");
        break;
      }
      if (pending.question !== details.question || (details.requestId && pending.request_id !== details.requestId)) {
        await act({ failed: "question mismatch" }, "a different question is pending; not answered");
        break;
      }
      const fixed = typeof args.answer === "string";
      const row = fixed ? undefined : /spec|format|semicolon/i.test(String(details.question)) ? 3 : 4;
      const text = fixed ? String(args.answer) : (details.candidates as Record<string, string>)[String(row)];
      app.answer(String(args.project_session_id), pending.request_id, text);
      await act({ answered: fixed, row, requestId: pending.request_id }, `answer_session_input "${text}"`);
      break;
    }
    case "judge_idle": {
      const messages = (details.messages ?? []) as { messageId: string; text: string }[];
      const last = messages[messages.length - 1];
      if (action.target === "self-test") await act({ final: last.messageId }, "judged final (self-test rule)");
      else {
        const final = messages.find((m) => /work is done|final report|I've stopped|I have stopped/i.test(m.text));
        if (final) await act({ final: final.messageId }, "judged final");
        else if (/\?\s*$/.test(last.text)) await act({ question: last.messageId, row: /spec|semicolon|format/i.test(last.text) ? 3 : 4 }, "judged a plain-text question");
        else await act({ neither: true }, "judged neither");
      }
      break;
    }
    case "send_message":
      app.send(String(args.session_id), String(args.message));
      await act({ sent: true }, `send_session_message "${String(args.message)}"`);
      break;
  }
}
