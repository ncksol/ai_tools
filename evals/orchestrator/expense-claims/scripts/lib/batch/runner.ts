// The overnight runner's state machine. `next` does every deterministic step itself (new-run,
// watching, score, commits, notifications) and stops only at a step the driver agent must take with
// an app tool or a judgment. `record` takes the result of that step. All state is in the batch
// folder, so any step can be resumed after a crash, a restart or a context compaction.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeSession } from "../events.ts";
import { featureSetName } from "../features.ts";
import { runName } from "../new-run.ts";
import type { ProcResult } from "../proc.ts";
import { readResults } from "../results.ts";
import { readAnswerSheet, replyFor, rowForQuestion, settleRow, type AnswerRow } from "./answers.ts";
import type { AppDb } from "./appdb.ts";
import { scanSession, scanSwarm } from "./hygiene.ts";
import { notices, type Notice } from "./notify.ts";
import { computePins, diffPins } from "./pins.ts";
import { calibrationDecision, describePlan, nextRunNumber, planNext, runRowFor, scoredCount } from "./plan.ts";
import { buildReport } from "./report.ts";
import {
  addFlag,
  loadState,
  ORCHESTRATOR_AGENTS,
  saveState,
  type BatchConfig,
  type BatchState,
  type PendingAction,
  type RunState,
  type SelfTestState,
} from "./state.ts";
import {
  eventsPath,
  findReplySource,
  idleCandidate,
  kickoffText,
  LogCache,
  messageArrived,
  orchestratorView,
  SessionIndex,
  swarmView,
  type OrchView,
  type SessionMeta,
} from "./swarm.ts";

export const STOP_MESSAGE = "This run is over. Stop all work now: don't start anything new, archive all your child sessions, then end your turn.";
const DRIVER_GAP_MS = 10 * 60_000;
const ANSWER_RETRY_MS = 2 * 60_000;
const MAX_ASK_ATTEMPTS = 3;
const MAX_SEND_ATTEMPTS = 3;
const DRAIN_QUIET_MS = 2 * 60_000;
const SELFTEST_MAX_MS = 20 * 60_000;
const MAX_NUMBER_BUMPS = 5;

export interface Deps {
  now(): number;
  sleep(ms: number): Promise<void>;
  exec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ProcResult>;
  notify(notice: Notice): Promise<{ ok: boolean; error?: string }>;
  appDb: AppDb;
  awake: { start(untilMs: number): number | null; alive(pid: number): boolean; stop(pid: number): void };
  log(line: string): void;
}

export interface Ctx {
  config: BatchConfig;
  deps: Deps;
  logs: LogCache;
  index: SessionIndex;
  sheet: AnswerRow[];
}

export function makeCtx(config: BatchConfig, deps: Deps): Ctx {
  return { config, deps, logs: new LogCache(), index: new SessionIndex(config.stateDir), sheet: readAnswerSheet(join(config.kitDir, "answers.md")) };
}

export interface ActionOut {
  batch: string;
  action: PendingAction["kind"] | "wait" | "done";
  id?: string;
  reissued?: boolean;
  dryRun?: boolean;
  what: string;
  tool?: { name: string; args: Record<string, unknown> };
  details?: Record<string, unknown>;
  record?: string[];
}

interface StepResult {
  action?: ActionOut;
  progressed?: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (time: string | undefined): number => (time ? Date.parse(time) : NaN);
const minutes = (value: number): number => value * 60_000;

function log(ctx: Ctx, line: string): void {
  ctx.deps.log(line);
  try {
    writeFileSync(join(ctx.config.dir, "runner.log"), `${iso(ctx.deps.now())} ${line}\n`, { flag: "a" });
  } catch {
    // the batch folder is gone; nothing to log to
  }
}

async function notify(ctx: Ctx, state: BatchState, notice: Notice): Promise<void> {
  if (state.notified.includes(notice.key)) return;
  state.notified.push(notice.key);
  const result = await ctx.deps.notify(notice);
  log(ctx, `notify ${notice.key}: ${result.ok ? "sent" : `not sent (${result.error})`}`);
}

function recordCommand(ctx: Ctx, id: string, flags: string): string {
  return `node scripts/batch.ts record --batch ${ctx.config.dir} --action ${id} ${flags}`;
}

function issue(ctx: Ctx, state: BatchState, kind: PendingAction["kind"], target: PendingAction["target"], payload: Record<string, unknown>): ActionOut {
  state.actionSeq++;
  const pending: PendingAction = { id: `a${state.actionSeq}`, kind, target, issuedAt: iso(ctx.deps.now()), payload };
  state.pending = pending;
  log(ctx, `issue ${pending.id} ${kind} for ${target === "selftest" ? "the self-test" : state.runs[target]?.key}`);
  return render(ctx, pending, false);
}

export function render(ctx: Ctx, pending: PendingAction, reissued: boolean): ActionOut {
  const p = pending.payload;
  const base = { batch: ctx.config.id, action: pending.kind, id: pending.id, reissued: reissued || undefined, dryRun: ctx.config.dryRun || undefined };
  switch (pending.kind) {
    case "create_project":
      return {
        ...base,
        what: `Call create_project with exactly these arguments. The user authorised creating this project for the batch.`,
        tool: { name: "create_project", args: p.args as Record<string, unknown> },
        record: [recordCommand(ctx, pending.id, "--project-id <id from the result>"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "create_session":
      return {
        ...base,
        what: "Call create_session with exactly these arguments, copied verbatim (the kickoff prompt too). Never start a run any other way.",
        tool: { name: "create_session", args: p.args as Record<string, unknown> },
        record: [recordCommand(ctx, pending.id, "--session-id <project session id from the result>"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "lookup_session":
      return {
        ...base,
        what: "Call get_session with this session id and record the project session id it reports.",
        tool: { name: "get_session", args: { project_session_id: p.sessionId } },
        record: [recordCommand(ctx, pending.id, "--session-id <project session id>"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "answer_question": {
      const fixed = typeof p.answer === "string";
      return {
        ...base,
        what: fixed
          ? `Answer the session's open question at once: get_session(project_session_id) for awaiting_input.request_id, check the question matches, then answer_session_input with the answer below as free text, word for word.`
          : `Judge the open question: row 3 if it is a question about the spec, row 4 for anything else. Then get_session for awaiting_input.request_id and answer_session_input with that row's reply as free text, word for word.`,
        tool: { name: "answer_session_input", args: { project_session_id: p.session, request_id: "<awaiting_input.request_id from get_session>", answer: fixed ? p.answer : "<the chosen row's reply>" } },
        details: { question: p.question, choices: p.choices, allowFreeform: p.allowFreeform, row: p.row ?? null, candidates: p.candidates ?? null, stop: p.stop ?? false },
        record: [
          recordCommand(ctx, pending.id, fixed ? "--answered" : "--row <3|4>"),
          recordCommand(ctx, pending.id, `${fixed ? "--answered" : "--row <3|4>"} --choice "<choice>"   (only if free text was not allowed and you picked a choice)`),
          recordCommand(ctx, pending.id, "--not-pending   (get_session shows no open question)"),
          recordCommand(ctx, pending.id, '--failed "<error>"'),
        ],
      };
    }
    case "judge_idle":
      return {
        ...base,
        what:
          "The orchestrator is idle. Read its latest messages and judge: is one of them its final report (it says the work is done), a question to the user, or neither? Only judge; send nothing.",
        details: { messages: p.messages, swarmQuiet: p.swarmQuiet, reason: p.reason, rows: p.rows },
        record: [
          recordCommand(ctx, pending.id, "--final <messageId>"),
          recordCommand(ctx, pending.id, "--question <messageId> [--row <3|4>]   (--row only when the question has no need=plan or need=pr tag)"),
          recordCommand(ctx, pending.id, "--neither"),
        ],
      };
    case "send_message":
      return {
        ...base,
        what: p.stop
          ? "The run has been scored. Send this stop message to the run's orchestrator, word for word."
          : "Answer the orchestrator's plain-text question: send this reply, word for word, with send_session_message. Send nothing else.",
        tool: { name: "send_session_message", args: { session_id: p.session, message: p.message } },
        record: [recordCommand(ctx, pending.id, "--sent"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
  }
}

// ---------- session lookup ----------

function knownSessionDir(ctx: Ctx, id: string | undefined): string | null {
  return id && existsSync(eventsPath(ctx.config.stateDir, id)) ? id : null;
}

function resolveSession(ctx: Ctx, appSessionId: string | undefined, candidates: () => SessionMeta[], match: (events: ReturnType<LogCache["read"]>) => boolean): string | null {
  const fromDb = appSessionId ? ctx.deps.appDb.sessionForWorkspace(appSessionId) : null;
  if (fromDb && knownSessionDir(ctx, fromDb)) return fromDb;
  const direct = knownSessionDir(ctx, appSessionId);
  if (direct) return direct;
  for (const meta of candidates()) {
    const events = ctx.logs.read(eventsPath(ctx.config.stateDir, meta.id));
    if (events.length > 0 && match(events)) return meta.id;
  }
  return null;
}

function runSessionIds(ctx: Ctx, run: RunState): string[] {
  const since = ms(run.startRequestedAt) - minutes(2);
  const ids = new Set(ctx.index.forRepository(run.repo, since).map((meta) => meta.id));
  if (run.sessionId) ids.add(run.sessionId);
  return [...ids];
}

const readLogs = (ctx: Ctx, ids: string[]) => ids.map((id) => ({ id, events: ctx.logs.read(eventsPath(ctx.config.stateDir, id)) }));

function resolveRunSession(ctx: Ctx, run: RunState): string | null {
  const since = ms(run.startRequestedAt) - minutes(2);
  return resolveSession(
    ctx,
    run.appSessionId,
    () => ctx.index.forRepository(run.repo, since),
    (events) => orchestratorView(events).startedBy === "user",
  );
}

function resolveSelfTestSession(ctx: Ctx, test: SelfTestState): string | null {
  const since = ms(test.startRequestedAt) - minutes(2);
  return resolveSession(
    ctx,
    test.appSessionId,
    () => ctx.index.recent(since),
    (events) => kickoffText(orchestratorView(events)).includes(test.nonce),
  );
}

// ---------- shared watch helpers ----------

const settings = (config: BatchConfig) => ({ idleSettleMs: config.idleSettleSec * 1000, swarmSettleMs: config.swarmSettleSec * 1000 });

function judgeAction(ctx: Ctx, state: BatchState, target: PendingAction["target"], session: string, candidate: NonNullable<ReturnType<typeof idleCandidate>>): ActionOut {
  return issue(ctx, state, "judge_idle", target, {
    session,
    messages: candidate.messages.map((message) => ({ messageId: message.messageId, timestamp: message.timestamp, text: message.text.length > 6000 ? `${message.text.slice(0, 3000)}\n[...]\n${message.text.slice(-3000)}` : message.text })),
    swarmQuiet: candidate.swarmQuiet,
    reason: candidate.reason,
    rows: Object.fromEntries(ctx.sheet.map((row) => [row.row, `${row.type}: ${row.reply}`])),
  });
}

function askAction(ctx: Ctx, state: BatchState, target: PendingAction["target"], session: string, orch: OrchView, stop = false): ActionOut {
  const ask = orch.openAsk!;
  if (stop) {
    return issue(ctx, state, "answer_question", target, { session, toolCallId: ask.toolCallId, question: ask.question, choices: ask.choices, allowFreeform: ask.allowFreeform, answer: STOP_MESSAGE, stop: true });
  }
  const { row, candidates } = rowForQuestion(ask.question);
  return issue(ctx, state, "answer_question", target, {
    session,
    toolCallId: ask.toolCallId,
    question: ask.question,
    choices: ask.choices,
    allowFreeform: ask.allowFreeform,
    ...(row !== null ? { row, answer: replyFor(ctx.sheet, row) } : { candidates: Object.fromEntries(candidates.map((r) => [r, replyFor(ctx.sheet, r)])) }),
  });
}

// ---------- keep-awake ----------

function ensureAwake(ctx: Ctx, state: BatchState): void {
  if (!ctx.config.keepAwake) return;
  if (state.caffeinate && ctx.deps.awake.alive(state.caffeinate.pid)) return;
  const until = Math.min(ms(ctx.config.deadline) + minutes(180), ctx.deps.now() + minutes(24 * 60));
  const pid = ctx.deps.awake.start(until);
  state.caffeinate = pid ? { pid, until: iso(until) } : null;
  log(ctx, pid ? `caffeinate -is held by pid ${pid} until ${iso(until)}` : "could not start caffeinate");
}

function releaseAwake(ctx: Ctx, state: BatchState): void {
  if (state.caffeinate) ctx.deps.awake.stop(state.caffeinate.pid);
  state.caffeinate = null;
}

// ---------- phase control ----------

function stopBatch(ctx: Ctx, state: BatchState, reason: string, failure: boolean): void {
  state.stopReason = reason;
  state.phase = "finishing";
  state.failed = failure;
  log(ctx, `stopping: ${reason}`);
}

async function git(ctx: Ctx, args: string[]): Promise<ProcResult> {
  return ctx.deps.exec("git", args, { cwd: dirname(ctx.config.resultsPath) });
}

async function finish(ctx: Ctx, state: BatchState): Promise<ActionOut> {
  const failed = Boolean(state.failed);
  state.finishedAt = iso(ctx.deps.now());
  const branch = (await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || null;
  const range = state.resultsBase ? [`${state.resultsBase}..HEAD`] : [`--since=${state.startedAt}`];
  const logOut = await git(ctx, ["log", "--format=%h %s", ...range, "--", ctx.config.resultsPath]);
  const commits = logOut.code === 0 ? logOut.stdout.split("\n").filter(Boolean) : [];
  const pushed = ctx.config.push ? !state.warnings.some((warning) => warning.startsWith("push")) && commits.length > 0 : null;
  const reportPath = join(ctx.config.dir, "report.md");
  writeFileSync(reportPath, buildReport(ctx.config, state, ctx.deps.appDb, { branch, commits, pushed }));
  state.reportPath = reportPath;
  releaseAwake(ctx, state);
  const rows = readResults(ctx.config.resultsPath);
  const outcomes = new Map<string, number>();
  for (const run of state.runs) {
    const outcome = run.status === "void" ? "void" : (runRowFor(rows, run)?.outcome ?? "not scored");
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }
  const counts = `${state.runs.length} run(s)${outcomes.size > 0 ? ` (${[...outcomes].map(([k, v]) => `${v} ${k}`).join(", ")})` : ""}`;
  await notify(ctx, state, failed ? notices.stopped(ctx.config.id, state.stopReason ?? "unknown", reportPath) : notices.done(ctx.config.id, `${counts}; ${state.stopReason}`, reportPath));
  state.phase = failed ? "stopped" : "done";
  log(ctx, `batch ${state.phase}: ${state.stopReason}`);
  return doneAction(ctx, state);
}

function doneAction(ctx: Ctx, state: BatchState): ActionOut {
  return {
    batch: ctx.config.id,
    action: "done",
    what: `The batch is ${state.phase === "done" ? "finished" : "stopped"}: ${state.stopReason}. Print the report (cat it), remind the user to turn Copilot Memory back on, then call task_complete.`,
    details: { phase: state.phase, reason: state.stopReason, report: state.reportPath },
  };
}

// ---------- self-test ----------

function selfTestPrompt(nonce: string): string {
  return [
    `Eval runner self-test ${nonce}.`,
    `Call the ask_user tool exactly once, with the question "[unit=selftest need=plan] Self-test ${nonce}: may I finish?" and the choices ["yes", "no"].`,
    "When it returns, reply with one short line that quotes the answer you got, and stop. Do nothing else: no other tools, files or commands.",
  ].join("\n");
}

async function selfTestStep(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const { config, deps } = ctx;
  const now = deps.now();
  let test = state.selftests.at(-1);
  if (test?.status === "passed") {
    if (config.selfTest.only) stopBatch(ctx, state, "the self-test passed (self-test only)", false);
    else state.phase = "runs";
    return { progressed: true };
  }
  if (test?.status === "failed") {
    stopBatch(ctx, state, `the self-test failed: ${test.failure}`, true);
    return { progressed: true };
  }
  if (!test) {
    const nonce = `st${now.toString(36)}`;
    test = {
      nonce,
      repoDir: join(config.dir, `selftest-${state.selftests.length + 1}`, `eval-runner-selftest-${nonce}`),
      prompt: selfTestPrompt(nonce),
      status: "new",
      createdAt: iso(now),
      askAttempts: 0,
      judged: [],
      checks: [],
    };
    state.selftests.push(test);
    return { progressed: true };
  }
  const fail = (why: string) => {
    test!.status = "failed";
    test!.failure = why;
    log(ctx, `self-test failed: ${why}`);
  };
  switch (test.status) {
    case "new": {
      rmSync(test.repoDir, { recursive: true, force: true });
      mkdirSync(test.repoDir, { recursive: true });
      writeFileSync(join(test.repoDir, "README.md"), "# Eval runner self-test\n\nA scratch repo with no remote. Safe to delete.\n");
      const ident = ["-c", "user.name=Eval Runner", "-c", "user.email=eval-runner@example.invalid"];
      for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], [...ident, "commit", "-q", "-m", "Self-test scratch repo"]]) {
        const result = await deps.exec("git", args, { cwd: test.repoDir });
        if (result.code !== 0) {
          fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
          return { progressed: true };
        }
      }
      test.status = "repo";
      return { progressed: true };
    }
    case "repo":
      return { action: issue(ctx, state, "create_project", "selftest", { args: { path: test.repoDir } }) };
    case "project": {
      test.startRequestedAt = iso(now);
      test.status = "starting";
      const kickoff: Record<string, unknown> = { prompt: test.prompt, model: config.selfTest.model, reasoning_effort: config.selfTest.effort, mode: "interactive" };
      if (config.selfTest.agent) kickoff.agent = config.selfTest.agent;
      return {
        action: issue(ctx, state, "create_session", "selftest", {
          args: { project_id: test.projectId, workspace_type: "worktree", detached: true, coordinate_with_creator: false, kickoff },
        }),
      };
    }
    case "starting":
      return {};
    case "running": {
      if (now - ms(test.startRequestedAt) > SELFTEST_MAX_MS) {
        fail("it did not finish within 20 minutes");
        return { progressed: true };
      }
      test.sessionId ??= resolveSelfTestSession(ctx, test) ?? undefined;
      if (!test.sessionId) {
        if (now - ms(test.startRequestedAt) > minutes(config.sessionAppearMin)) fail("its session never appeared in the session-state folder");
        return { progressed: test.status !== "running" };
      }
      const events = ctx.logs.read(eventsPath(config.stateDir, test.sessionId));
      const orch = orchestratorView(events);
      const session = test.appSessionId ?? test.sessionId;
      if (orch.openAsk) {
        if (!test.answered || test.answered.toolCallId !== orch.openAsk.toolCallId || (now - ms(test.answered.at) > ANSWER_RETRY_MS && test.askAttempts < MAX_ASK_ATTEMPTS)) {
          return { action: askAction(ctx, state, "selftest", session, orch) };
        }
        return {};
      }
      const candidate = idleCandidate(orch, swarmView([{ id: test.sessionId, events }]), now, test.judged, settings(config));
      if (candidate) return { action: judgeAction(ctx, state, "selftest", session, candidate) };
      return {};
    }
    case "verify": {
      verifySelfTest(ctx, test);
      const failed = test.checks.filter((check) => !check.ok);
      if (failed.length > 0) fail(failed.map((check) => check.name).join("; "));
      else test.status = "passed";
      await notify(ctx, state, notices.selfTest(config.id, state.selftests.length, test.status === "passed", test.failure ?? ""));
      return { progressed: true };
    }
    default:
      return {};
  }
}

export function verifySelfTest(ctx: Ctx, test: SelfTestState): void {
  const { config, deps } = ctx;
  const checks: SelfTestState["checks"] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const dir = join(config.stateDir, test.sessionId ?? "missing");
  const events = ctx.logs.read(eventsPath(config.stateDir, test.sessionId ?? "missing"));
  const orch = orchestratorView(events);
  const described = describeSession(dir);
  check("kickoff counts as started by the user", described.startedBy === "user" && orch.startedBy === "user", `score sees: ${described.startedBy ?? "no log"}`);
  check("kickoff text arrived unchanged", kickoffText(orch).trim() === test.prompt.trim(), kickoffText(orch).trim() === test.prompt.trim() ? "identical" : "differs from what was sent");
  check("model and effort", orch.model === config.selfTest.model && orch.effort === config.selfTest.effort, `session.start: ${orch.model ?? "none"} at ${orch.effort ?? "none"}`);
  const agentOk = config.selfTest.agent
    ? orch.agent === config.selfTest.agent
    : orch.agent === null || !(ORCHESTRATOR_AGENTS.includes(orch.agent) || config.variants.includes(orch.agent));
  check("agent", agentOk, `selected: ${orch.agent ?? "the default agent"}`);
  const reply = replyFor(ctx.sheet, 1);
  const answered = orch.askCalls.find((call) => call.completed && call.resultText.includes(reply));
  check("ask_user answered word for word", Boolean(answered), answered ? `got "${reply}"` : `${orch.askCalls.length} ask_user call(s), none completed with "${reply}"`);
  const askDone = answered ? answered.startAt : Infinity;
  check("end detected", Boolean(test.final) && ms(test.final!.timestamp) >= askDone, test.final ? `final message at ${test.final.timestamp}` : "no final message judged");
  const autoApprove = test.projectId ? deps.appDb.projectAutoApprove(test.projectId) : null;
  check("new project auto-approves tools", autoApprove === 1, `projects.auto_approve = ${autoApprove ?? "unreadable"}`);
  const links = test.appSessionId ? deps.appDb.creatorLinks(test.appSessionId) : null;
  check("session is detached (no creator link)", Boolean(links) && !links!.creator && !links!.coordinator, links ? `creator ${links.creator ?? "none"}, coordinator ${links.coordinator ?? "none"}` : "workspace row unreadable");
  const memory = scanSession(test.sessionId ?? "missing", events).filter((finding) => finding.code === "memory-loaded");
  check("no memories loaded (Memory is off)", memory.length === 0, memory.length === 0 ? "no <memories> block" : memory.map((finding) => finding.detail).join("; "));
  test.checks = checks;
}

// ---------- runs ----------

function plannedTotal(ctx: Ctx, state: BatchState): number {
  const rows = readResults(ctx.config.resultsPath);
  const decision = calibrationDecision(rows, ctx.config.variants);
  const done = state.runs.filter((run) => runRowFor(rows, run)).length;
  const remaining = ctx.config.variants.reduce((sum, variant) => sum + Math.max(0, ctx.config.runsPerVariant - scoredCount(state.runs, rows, variant, decision.features)), 0);
  return done + remaining;
}

async function startNextRun(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const { config, deps } = ctx;
  const now = deps.now();
  if (state.stopRequested) {
    stopBatch(ctx, state, "you asked the batch to stop", false);
    return { progressed: true };
  }
  if (state.startFailures >= 2) {
    stopBatch(ctx, state, "two runs in a row failed to start", true);
    return { progressed: true };
  }
  if (state.scoreFailures >= 2) {
    stopBatch(ctx, state, "score failed for two runs in a row", true);
    return { progressed: true };
  }
  const drift = diffPins(state.pins, currentPins(config));
  if (drift.length > 0) {
    stopBatch(ctx, state, `pinned inputs changed: ${drift.join("; ")}`, true);
    return { progressed: true };
  }
  if (now >= ms(config.deadline)) {
    stopBatch(ctx, state, `the deadline ${config.deadline} passed`, false);
    return { progressed: true };
  }
  const rows = readResults(config.resultsPath);
  const { next, decision } = planNext(state.runs, rows, config.variants, config.runsPerVariant);
  state.calibration = decision.reason;
  if (!next) {
    stopBatch(ctx, state, "every variant has its scored runs", false);
    return { progressed: true };
  }
  ensureAwake(ctx, state);
  const n = nextRunNumber(next.variant, rows, config.runsDir, state.runs);
  const name = runName(next.variant, n);
  const run: RunState = {
    key: `${next.variant}#${n}`,
    variant: next.variant,
    n,
    features: next.features,
    calibration: next.calibration,
    name,
    repoDir: join(config.runsDir, name),
    repo: config.dryRun ? name : `${config.owner}/${name}`,
    status: "new",
    createdAt: iso(now),
    judged: [],
    answers: [],
    askAttempts: {},
    flags: [],
  };
  state.runs.push(run);
  state.current = state.runs.length - 1;
  log(ctx, `planned ${run.key} on ${featureSetName(run.features)}${run.calibration ? " (calibration)" : ""}`);
  return { progressed: true };
}

export function currentPins(config: BatchConfig) {
  return computePins({
    agentsDir: config.agentsDir,
    variants: config.variants,
    files: { "kickoff.md": join(config.kitDir, "kickoff.md"), "answers.md": join(config.kitDir, "answers.md") },
    appPlist: config.appPlist,
    cliVersionFile: config.cliVersionFile,
  });
}

function voidRun(ctx: Ctx, state: BatchState, run: RunState, reason: string, startFailure: boolean): void {
  run.status = "void";
  run.voidReason = reason;
  if (startFailure) {
    state.startFailures++;
    addFlag(run, "start-failed", reason, iso(ctx.deps.now()));
  }
  log(ctx, `${run.key} void: ${reason}`);
}

// A clone that new-run finished before the runner could save it: one "Seed v1" commit, the kickoff
// file, and (unless a dry run) the GitHub remote.
async function finishedClone(ctx: Ctx, run: RunState): Promise<boolean> {
  if (!existsSync(run.repoDir) || !existsSync(join(ctx.config.runsDir, `${run.name}.kickoff.md`))) return false;
  const subjects = await ctx.deps.exec("git", ["log", "--format=%s"], { cwd: run.repoDir });
  if (subjects.code !== 0 || subjects.stdout.trim() !== "Seed v1") return false;
  if (ctx.config.dryRun) return true;
  return (await ctx.deps.exec("git", ["remote", "get-url", "origin"], { cwd: run.repoDir })).code === 0;
}

async function newRepo(ctx: Ctx, state: BatchState, run: RunState): Promise<StepResult> {
  const { config, deps } = ctx;
  if (await finishedClone(ctx, run)) {
    run.status = "repo";
    log(ctx, `${run.name} was already created; adopted it`);
    return { progressed: true };
  }
  for (let bump = 0; bump <= MAX_NUMBER_BUMPS; bump++) {
    const args = [config.newRunScript, "--variant", run.variant, "--n", String(run.n), "--features", run.features.join(","), "--owner", config.owner, "--runs-dir", config.runsDir];
    if (config.dryRun) args.push("--dry-run");
    const result = await deps.exec(process.execPath, args, { cwd: config.kitDir });
    if (result.code === 0) {
      run.status = "repo";
      log(ctx, `new-run ${run.name} ok`);
      return { progressed: true };
    }
    const error = (result.stderr || result.stdout).trim().split("\n").pop() ?? "";
    if (!/already exists/.test(error)) {
      voidRun(ctx, state, run, `new-run failed: ${error}`, true);
      await notify(ctx, state, notices.runVoid(config.id, run.variant, run.n, run.voidReason!));
      return { progressed: true };
    }
    // The number is taken (an old run repo on GitHub, or a half-made clone): use the next one.
    run.n++;
    run.name = runName(run.variant, run.n);
    run.key = `${run.variant}#${run.n}`;
    run.repoDir = join(config.runsDir, run.name);
    run.repo = config.dryRun ? run.name : `${config.owner}/${run.name}`;
  }
  voidRun(ctx, state, run, "no free run number", true);
  return { progressed: true };
}

async function watchRun(ctx: Ctx, state: BatchState, run: RunState, index: number): Promise<StepResult> {
  const { config, deps } = ctx;
  const now = deps.now();
  run.sessionId ??= resolveRunSession(ctx, run) ?? undefined;
  const waitedMs = now - ms(run.startRequestedAt);
  if (!run.sessionId) {
    if (waitedMs > minutes(config.sessionAppearMin)) {
      voidRun(ctx, state, run, "the run's session never appeared in the session-state folder", true);
      await notify(ctx, state, notices.runVoid(config.id, run.variant, run.n, run.voidReason!));
      return { progressed: true };
    }
    return {};
  }
  const events = ctx.logs.read(eventsPath(config.stateDir, run.sessionId));
  const orch = orchestratorView(events);
  if (!orch.kickoff) {
    if (waitedMs > minutes(config.sessionAppearMin)) {
      voidRun(ctx, state, run, "the run's session has no kickoff message", true);
      await notify(ctx, state, notices.runVoid(config.id, run.variant, run.n, run.voidReason!));
      return { progressed: true };
    }
    return {};
  }
  const at = iso(now);
  if (!run.kickoffChecked) {
    run.kickoffAt = orch.kickoff.timestamp;
    run.kickoffChecked = true;
    state.startFailures = 0;
    if (orch.startedBy !== "user") addFlag(run, "kickoff-shape", "the kickoff carries a data.source or a cross-session tag, so score can't treat it as typed by the user", at);
    const expected = readFileSync(join(config.runsDir, `${run.name}.kickoff.md`), "utf8").trim();
    if (kickoffText(orch).trim() !== expected) addFlag(run, "kickoff-text", "the kickoff differs from kickoff.md", at);
    const wrong: string[] = [];
    if (orch.agent !== run.variant) wrong.push(`agent ${orch.agent ?? "none"}`);
    if (orch.model !== config.model) wrong.push(`model ${orch.model ?? "none"}`);
    if (orch.effort !== config.effort) wrong.push(`effort ${orch.effort ?? "none"}`);
    if (orch.contextTier !== config.contextTier) wrong.push(`context tier ${orch.contextTier ?? "none"}`);
    if (wrong.length > 0) addFlag(run, "session-settings", `session.start differs from the request: ${wrong.join(", ")}`, at);
    log(ctx, `${run.key} kickoff at ${run.kickoffAt} in session ${run.sessionId}`);
  }

  const logs = readLogs(ctx, runSessionIds(ctx, run));
  const swarm = swarmView(logs);
  for (const session of swarm.sessions) {
    if (session.pendingPermissions > 0) addFlag(run, "permission-prompt", `session ${session.id} has a tool-permission prompt no app tool can answer`, at);
    if (session.unattendedDenials > 0) addFlag(run, "permission-prompt", `session ${session.id}: a permission request was denied because no one was there`, at);
  }
  if (run.plain?.sentAt && !run.answerSource) {
    run.answerSource = findReplySource(events, run.plain.text, ms(run.plain.sentAt) - 5000) ?? undefined;
  }

  const session = run.appSessionId ?? run.sessionId;
  const timedOut = now - ms(run.kickoffAt) >= minutes(config.timeoutMin);
  const stalled = now - swarm.lastActivityAt >= minutes(config.stallMin);
  // An app restart or crash stops the run's session; that run is void, not timed out or stalled.
  if (timedOut || stalled || run.flags.some((f) => f.code === "driver-gap")) {
    const settings = ctx.deps.appDb.sessionSettings(run.sessionId);
    if (settings && Number(settings.was_interrupted) === 1) {
      voidRun(ctx, state, run, `the app stopped the run's session (${String(settings.interruption_reason ?? "interrupted")}), for example in a restart or update`, false);
      await notify(ctx, state, notices.runVoid(config.id, run.variant, run.n, run.voidReason!));
      return { progressed: true };
    }
  }
  if (timedOut) {
    run.endReason = "timeout";
    run.status = "scoring";
    log(ctx, `${run.key} timed out`);
    return { progressed: true };
  }
  if (orch.openAsk) {
    const attempt = run.askAttempts[orch.openAsk.toolCallId];
    if (!attempt || (now - ms(attempt.at) > ANSWER_RETRY_MS && attempt.count < MAX_ASK_ATTEMPTS)) {
      if (attempt) addFlag(run, "answer-retry", `ask_user ${orch.openAsk.toolCallId} was still open ${Math.round((now - ms(attempt.at)) / 1000)} s after an answer`, at);
      return { action: askAction(ctx, state, index, session, orch) };
    }
  }
  if (stalled) {
    run.endReason = "stalled";
    run.status = "scoring";
    for (const s of swarm.sessions) {
      for (const tool of s.openTools) addFlag(run, "open-tool-at-stall", `session ${s.id}${tool.agentId ? ` (sub-agent ${tool.agentId})` : ""} had an open ${tool.toolName} call since ${iso(tool.at)}; a permission prompt or elicitation may have been waiting`, at);
    }
    log(ctx, `${run.key} stalled`);
    return { progressed: true };
  }
  if (run.plain && !run.plain.sentAt && run.plain.sendAttempts < MAX_SEND_ATTEMPTS) {
    return { action: issue(ctx, state, "send_message", index, { session, message: run.plain.text, stop: false }) };
  }
  const candidate = idleCandidate(orch, swarm, now, run.judged, settings(config));
  if (candidate) return { action: judgeAction(ctx, state, index, session, candidate) };
  return {};
}

async function scoreRun(ctx: Ctx, state: BatchState, run: RunState): Promise<void> {
  const { config, deps } = ctx;
  if (run.plain?.sentAt && !run.answerSource) {
    const events = ctx.logs.read(eventsPath(config.stateDir, run.sessionId ?? "missing"));
    run.answerSource = findReplySource(events, run.plain.text, ms(run.plain.sentAt) - 5000) ?? undefined;
  }
  const args = [config.scoreScript, "--repo-dir", run.repoDir, "--session", run.sessionId ?? "", "--state-dir", config.stateDir, "--results", config.resultsPath];
  if (config.dryRun) args.push("--no-github");
  if (run.endReason === "final" && run.final) args.push("--end-at", run.final.timestamp);
  else args.push("--outcome", run.endReason ?? "stalled");
  if (run.answerSource) args.push("--answer-source", run.answerSource);
  else if (run.plain?.sentAt) addFlag(run, "answer-source-unknown", "the plain-text answer wasn't found in the log, so score counted it as neither a question nor blocked time", iso(deps.now()));
  const result = await deps.exec(process.execPath, args, { cwd: config.kitDir });
  mkdirSync(join(config.dir, "runs"), { recursive: true });
  run.scoreLog = join(config.dir, "runs", `${run.name}.score.log`);
  writeFileSync(run.scoreLog, `$ node ${args.join(" ")}\nexit ${result.code}\n\n${result.stdout}\n${result.stderr}`);
  run.scoreExit = result.code;
  run.scoredAt = iso(deps.now());
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    const warning = /^Warning: (.*)$/.exec(line.trim())?.[1];
    if (!warning) continue;
    // score --session warns when the first top-level message came from another session.
    if (/another session/i.test(warning)) addFlag(run, "kickoff-shape", `score: ${warning}`, run.scoredAt);
    else addFlag(run, "score-warning", warning, run.scoredAt);
  }
  const row = runRowFor(readResults(config.resultsPath), run);
  if (row) {
    run.row = { ...row };
    state.scoreFailures = 0;
  } else {
    state.scoreFailures++;
    addFlag(run, "score-failed", `score exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? ""} (log: ${run.scoreLog})`, run.scoredAt);
  }
  run.status = "scored";
  log(ctx, `${run.key} scored: exit ${result.code}, ${row ? `${row.outcome} ${row.minutes} min` : "no row"}`);
}

async function commitResult(ctx: Ctx, state: BatchState, run: RunState): Promise<void> {
  const { config } = ctx;
  const branch = (await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (!branch || ["main", "master", "HEAD"].includes(branch)) {
    state.warnings.push(`commit skipped for ${run.key}: the checkout is on "${branch || "unknown"}", and results never go to main`);
    return;
  }
  const status = await git(ctx, ["status", "--porcelain", "--", config.resultsPath]);
  if (status.stdout.trim() !== "") {
    const message = `chore(evals): record ${run.variant} run ${run.n} (${run.row?.outcome ?? "not scored"})`;
    const commit = await git(ctx, ["commit", "-q", "-m", message, "--only", "--", config.resultsPath]);
    if (commit.code !== 0) {
      state.warnings.push(`commit failed for ${run.key}: ${commit.stderr.trim()}`);
      return;
    }
  }
  run.committed = true;
  if (config.push) {
    const remote = await git(ctx, ["remote", "get-url", "origin"]);
    if (remote.code !== 0) {
      state.warnings.push("push skipped: the ai_tools checkout has no origin remote");
      return;
    }
    const push = await git(ctx, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
    if (push.code !== 0) state.warnings.push(`push failed after ${run.key}: ${push.stderr.trim().split("\n").pop()}`);
  }
}

async function runsStep(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const { config, deps } = ctx;
  if (state.current === null) return startNextRun(ctx, state);
  const index = state.current;
  const run = state.runs[index];
  const now = deps.now();
  switch (run.status) {
    case "new":
      return newRepo(ctx, state, run);
    case "repo":
      return { action: issue(ctx, state, "create_project", index, { args: { path: run.repoDir } }) };
    case "project": {
      const kickoff = readFileSync(join(config.runsDir, `${run.name}.kickoff.md`), "utf8").trim();
      run.startRequestedAt = iso(now);
      run.status = "starting";
      return {
        action: issue(ctx, state, "create_session", index, {
          args: {
            project_id: run.projectId,
            workspace_type: "worktree",
            detached: true,
            coordinate_with_creator: false,
            kickoff: { prompt: kickoff, agent: run.variant, model: config.model, reasoning_effort: config.effort, context_tier: config.contextTier, mode: "interactive" },
          },
        }),
      };
    }
    case "starting":
      return {};
    case "running":
      return watchRun(ctx, state, run, index);
    case "ending": {
      const swarm = swarmView(readLogs(ctx, runSessionIds(ctx, run)));
      const quiet = now - swarm.lastActivityAt >= config.swarmSettleSec * 1000;
      const waited = now - ms(run.endingSince);
      if (quiet || waited >= minutes(config.quietWaitMin)) {
        if (!quiet) addFlag(run, "swarm-not-quiet", `scored ${Math.round(waited / 60_000)} min after the final report while the swarm was still active`, iso(now));
        run.status = "scoring";
        return { progressed: true };
      }
      return {};
    }
    case "scoring":
      await scoreRun(ctx, state, run);
      return { progressed: true };
    case "scored": {
      if (!run.notified) {
        for (const finding of scanSwarm(readLogs(ctx, runSessionIds(ctx, run)))) addFlag(run, finding.code, finding.detail, iso(now));
        if (run.row && !run.committed) await commitResult(ctx, state, run);
        const rows = readResults(config.resultsPath);
        const row = runRowFor(rows, run);
        const index1 = state.runs.filter((r) => runRowFor(rows, r)).length;
        await notify(
          ctx,
          state,
          notices.runOutcome(config.id, {
            index: index1,
            total: Math.max(index1, plannedTotal(ctx, state)),
            variant: run.variant,
            n: run.n,
            outcome: row?.outcome ?? "not scored",
            minutes: row?.minutes ?? "-",
            suite: row ? `${row.suite_passed}/${row.suite_total}` : "-",
            prs: row?.prs_merged ?? "-",
            ci: row?.main_ci ?? "-",
            flags: [...new Set(run.flags.map((flag) => flag.code))],
          }),
        );
        run.notified = true;
      }
      run.status = run.endReason === "timeout" || run.endReason === "stalled" ? "stopping" : "done";
      return { progressed: true };
    }
    case "stopping": {
      if (run.stopSentAt || (run.stopAttempts ?? 0) >= MAX_SEND_ATTEMPTS) {
        if (!run.stopSentAt) addFlag(run, "send-failed", "the stop message could not be delivered", iso(now));
        run.status = "draining";
        run.drainingSince = iso(now);
        return { progressed: true };
      }
      const orch = orchestratorView(ctx.logs.read(eventsPath(config.stateDir, run.sessionId ?? "missing")));
      const session = run.appSessionId ?? run.sessionId ?? "";
      if (orch.openAsk) return { action: askAction(ctx, state, index, session, orch, true) };
      return { action: issue(ctx, state, "send_message", index, { session, message: STOP_MESSAGE, stop: true }) };
    }
    case "draining": {
      const swarm = swarmView(readLogs(ctx, runSessionIds(ctx, run)));
      const quiet = now - swarm.lastActivityAt >= DRAIN_QUIET_MS;
      const waited = now - ms(run.drainingSince);
      if (quiet || waited >= minutes(config.drainMaxMin)) {
        if (!quiet) addFlag(run, "swarm-not-quiet", `the swarm was still active ${Math.round(waited / 60_000)} min after the stop message`, iso(now));
        run.status = "done";
        return { progressed: true };
      }
      return {};
    }
    case "done":
    case "void":
      run.endedAt ??= iso(now);
      state.current = null;
      return { progressed: true };
  }
}

// ---------- pending actions after a restart ----------

function revalidate(ctx: Ctx, state: BatchState): "emit" | "cleared" {
  const pending = state.pending!;
  const now = ctx.deps.now();
  const target = pending.target === "selftest" ? state.selftests.at(-1) : state.runs[pending.target];
  if (!target) {
    state.pending = null;
    return "cleared";
  }
  switch (pending.kind) {
    case "create_project":
    case "lookup_session":
      return "emit";
    case "answer_question":
    case "judge_idle":
      // Recomputed from the logs on this poll, so a stale question or message is never re-sent.
      state.pending = null;
      return "cleared";
    case "create_session": {
      // The driver may have created the session and stopped before recording it: adopt it rather
      // than start a second run in the same repo.
      const found = pending.target === "selftest" ? resolveSelfTestSession(ctx, target as SelfTestState) : resolveRunSession(ctx, target as RunState);
      if (!found) return "emit";
      target.sessionId = found;
      const appId = ctx.deps.appDb.workspaceForSession(found);
      log(ctx, `adopted session ${found} created by an unrecorded create_session`);
      if (appId) {
        target.appSessionId = appId;
        target.status = "running";
        state.pending = null;
        return "cleared";
      }
      state.pending = null;
      target.status = "running";
      issue(ctx, state, "lookup_session", pending.target, { sessionId: found });
      return "emit";
    }
    case "send_message": {
      const run = target as RunState;
      const events = ctx.logs.read(eventsPath(ctx.config.stateDir, run.sessionId ?? "missing"));
      if (messageArrived(events, String(pending.payload.message), ms(pending.issuedAt) - 5000)) {
        applySent(ctx, run, pending, now);
        state.pending = null;
        return "cleared";
      }
      return "emit";
    }
  }
}

function applySent(ctx: Ctx, run: RunState, pending: PendingAction, now: number): void {
  if (pending.payload.stop) {
    run.stopSentAt = iso(now);
    return;
  }
  if (run.plain) {
    run.plain.sentAt = iso(now);
    run.answers.push({ kind: "plain", ref: run.plain.messageId, row: run.plain.row, text: run.plain.text, at: iso(now) });
  }
}

// ---------- public API ----------

export async function step(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const now = ctx.deps.now();
  const current = state.current === null ? null : state.runs[state.current];
  if (state.lastHeartbeatAt && current?.status === "running" && now - ms(state.lastHeartbeatAt) > DRIVER_GAP_MS) {
    addFlag(current, "driver-gap", `the driver was away for ${Math.round((now - ms(state.lastHeartbeatAt)) / 60_000)} min (from ${state.lastHeartbeatAt})`, iso(now));
  }
  state.lastHeartbeatAt = iso(now);
  if (state.phase === "selftest" || state.phase === "runs") {
    if (!state.caffeinate) ensureAwake(ctx, state);
    if (!state.notified.includes("batch-started")) {
      const { config } = ctx;
      const plan = config.selfTest.only
        ? "self-test only"
        : `${config.selfTest.enabled ? "self-test, then " : ""}${describePlan(config.variants, config.runsPerVariant, calibrationDecision(readResults(config.resultsPath), config.variants))}`;
      const deadline = new Date(config.deadline).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      await notify(ctx, state, notices.batchStarted(config.id, plan, deadline));
    }
  }
  if (state.pending) {
    if (revalidate(ctx, state) === "emit") return { action: render(ctx, state.pending!, true) };
  }
  switch (state.phase) {
    case "selftest":
      return selfTestStep(ctx, state);
    case "runs":
      return runsStep(ctx, state);
    case "finishing":
      return { action: await finish(ctx, state) };
    case "done":
    case "stopped":
      return { action: doneAction(ctx, state) };
  }
}

function acquireLock(dir: string): () => void {
  const path = join(dir, "runner.lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    let alive = false;
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`Another runner process (pid ${pid}) is working on this batch. Wait for it to return.`);
  }
  writeFileSync(path, String(process.pid));
  return () => rmSync(path, { force: true });
}

export async function next(ctx: Ctx, opts: { maxWaitMs: number }): Promise<ActionOut> {
  const release = acquireLock(ctx.config.dir);
  try {
    const until = ctx.deps.now() + opts.maxWaitMs;
    for (;;) {
      const state = loadState(ctx.config.dir);
      let result: StepResult;
      try {
        result = await step(ctx, state);
      } finally {
        saveState(ctx.config.dir, state);
      }
      if (result.action) return result.action;
      if (result.progressed) continue;
      const left = until - ctx.deps.now();
      if (left <= 0) {
        return { batch: ctx.config.id, action: "wait", what: "Nothing to do yet. Run next again straight away." };
      }
      await ctx.deps.sleep(Math.min(left, ctx.config.pollSec * 1000));
    }
  } finally {
    release();
  }
}

export interface RecordInput {
  action: string;
  projectId?: string;
  sessionId?: string;
  row?: number;
  answered?: boolean;
  choice?: string;
  notPending?: boolean;
  final?: string;
  question?: string;
  neither?: boolean;
  sent?: boolean;
  failed?: string;
}

export function record(ctx: Ctx, input: RecordInput): string {
  const state = loadState(ctx.config.dir);
  const pending = state.pending;
  if (!pending || pending.id !== input.action) {
    if (state.recorded.includes(input.action)) return `Action ${input.action} was already recorded.`;
    throw new Error(`Action ${input.action} is not the pending action${pending ? ` (pending: ${pending.id} ${pending.kind})` : " (nothing is pending)"}. Run next.`);
  }
  const now = ctx.deps.now();
  const at = iso(now);
  const test = pending.target === "selftest" ? state.selftests.at(-1)! : null;
  const run = pending.target === "selftest" ? null : state.runs[pending.target];
  let message = "";
  const p = pending.payload;

  switch (pending.kind) {
    case "create_project":
      if (input.failed || !input.projectId) {
        const why = `create_project failed: ${input.failed ?? "no project id"}`;
        if (test) Object.assign(test, { status: "failed", failure: why });
        else voidRun(ctx, state, run!, why, true);
        message = why;
      } else {
        if (test) Object.assign(test, { projectId: input.projectId, status: "project" });
        else Object.assign(run!, { projectId: input.projectId, status: "project" });
        message = `project ${input.projectId} recorded`;
      }
      break;
    case "create_session":
    case "lookup_session":
      if (input.failed || !input.sessionId) {
        const why = `${pending.kind} failed: ${input.failed ?? "no session id"}`;
        if (test) Object.assign(test, { status: "failed", failure: why });
        else voidRun(ctx, state, run!, why, true);
        message = why;
      } else {
        if (test) Object.assign(test, { appSessionId: input.sessionId, status: "running" });
        else Object.assign(run!, { appSessionId: input.sessionId, status: "running" });
        message = `session ${input.sessionId} recorded`;
      }
      break;
    case "answer_question": {
      const toolCallId = String(p.toolCallId);
      if (p.stop) {
        if (input.failed) run!.stopAttempts = (run!.stopAttempts ?? 0) + 1;
        else run!.stopSentAt = at;
        message = input.failed ? "stop answer failed" : "stop answer recorded";
        break;
      }
      if (test) {
        test.askAttempts++;
        if (!input.failed) test.answered = { toolCallId, at, text: String(p.answer ?? "") };
        message = input.failed ? "answer failed" : "answer recorded";
        break;
      }
      const attempt = run!.askAttempts[toolCallId];
      run!.askAttempts[toolCallId] = { count: (attempt?.count ?? 0) + 1, at };
      if (input.failed) {
        message = `answer failed: ${input.failed}; it is retried in 2 minutes if the question is still open`;
        break;
      }
      if (input.notPending) {
        message = "no open question; the log is checked again";
        break;
      }
      const row = settleRow(String(p.question ?? ""), input.row);
      const text = replyFor(ctx.sheet, row);
      run!.answers.push({ kind: "ask_user", ref: toolCallId, row, text, choice: input.choice, at });
      if (input.choice) addFlag(run!, "choice-answer", `ask_user ${toolCallId} allowed no free text; answered with the choice "${input.choice}" for row ${row}`, at);
      message = `answered with row ${row}`;
      break;
    }
    case "judge_idle": {
      const messages = (p.messages as { messageId: string; timestamp: string; text: string }[]) ?? [];
      const judged = test ? test.judged : run!.judged;
      for (const m of messages) if (!judged.includes(m.messageId)) judged.push(m.messageId);
      if (input.final) {
        const chosen = messages.find((m) => m.messageId === input.final);
        if (!chosen) throw new Error(`--final ${input.final} is not one of the messages shown`);
        const final = { messageId: chosen.messageId, timestamp: chosen.timestamp };
        if (test) Object.assign(test, { final, status: "verify" });
        else Object.assign(run!, { final, endReason: "final", status: "ending", endingSince: at });
        message = `final report ${chosen.messageId} at ${chosen.timestamp}`;
      } else if (input.question) {
        const chosen = messages.find((m) => m.messageId === input.question);
        if (!chosen) throw new Error(`--question ${input.question} is not one of the messages shown`);
        if (test) {
          message = "the self-test asks nothing in plain text; judged as not final";
          break;
        }
        const row = settleRow(chosen.text, input.row);
        run!.plain = { messageId: chosen.messageId, row, text: replyFor(ctx.sheet, row), sendAttempts: 0 };
        addFlag(run!, "plain-text-question", `message ${chosen.messageId} asked in plain text; answered row ${row} with send_session_message`, at);
        message = `plain-text question; row ${row} will be sent`;
      } else if (input.neither) {
        message = "judged: neither final nor a question";
      } else throw new Error("Pass --final <messageId>, --question <messageId> or --neither");
      break;
    }
    case "send_message":
      if (input.failed) {
        if (p.stop) run!.stopAttempts = (run!.stopAttempts ?? 0) + 1;
        else if (run!.plain) run!.plain.sendAttempts++;
        addFlag(run!, "send-failed", `send_session_message failed: ${input.failed}`, at);
        message = "send failed";
      } else {
        applySent(ctx, run!, pending, now);
        message = "sent";
      }
      break;
  }
  state.recorded = [...state.recorded.slice(-200), pending.id];
  state.pending = null;
  saveState(ctx.config.dir, state);
  log(ctx, `record ${pending.id} ${pending.kind}: ${message}`);
  return message;
}

export function requestStop(ctx: Ctx): string {
  const state = loadState(ctx.config.dir);
  state.stopRequested = true;
  saveState(ctx.config.dir, state);
  return "The batch stops after the current run; no new run starts.";
}

export function statusText(ctx: Ctx): string {
  const state = loadState(ctx.config.dir);
  const rows = readResults(ctx.config.resultsPath);
  const lines = [`Batch ${ctx.config.id}: phase ${state.phase}${state.stopReason ? ` (${state.stopReason})` : ""}; deadline ${ctx.config.deadline}`];
  if (state.pending) lines.push(`Pending action: ${state.pending.id} ${state.pending.kind} (issued ${state.pending.issuedAt})`);
  for (const test of state.selftests) lines.push(`Self-test: ${test.status}${test.failure ? ` (${test.failure})` : ""}`);
  for (const run of state.runs) {
    const row = runRowFor(rows, run);
    lines.push(`${run.key} ${featureSetName(run.features)}: ${run.status}${row ? `, ${row.outcome} ${row.minutes} min` : ""}${run.flags.length ? `, flags ${[...new Set(run.flags.map((flag) => flag.code))].join(", ")}` : ""}`);
  }
  if (state.calibration) lines.push(`Calibration: ${state.calibration}`);
  return lines.join("\n");
}
