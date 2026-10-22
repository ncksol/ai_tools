// The overnight runner's state machine. `next` does every deterministic step itself (new-run,
// watching, score, commits, notifications) and stops only at a step the driver agent must take with
// an app tool or a judgment. `record` takes the result of that step. All state is in the batch
// folder, so any step can be resumed after a crash, a restart or a context compaction.
//
// Exclusive access: every read-modify-write of a batch's state (next, record, stop) holds the batch
// lock; only the batch's owning driver may run next and record; and only one batch is active on the
// machine (the active-batch guard). See lock.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeSession, type LogEvent } from "../events.ts";
import { featureSetName } from "../features.ts";
import { runName } from "../new-run.ts";
import type { ProcResult } from "../proc.ts";
import { readResults } from "../results.ts";
import { variantAgents, variantBundle, variantFiles, verifyVariants } from "../variants.ts";
import { readAnswerSheet, replyFor, rowForQuestion, settleRow, type AnswerRow } from "./answers.ts";
import type { AppDb } from "./appdb.ts";
import { scanSession, scanSwarm } from "./hygiene.ts";
import { claimActive, releaseActive } from "./lock.ts";
import { notices, type Notice } from "./notify.ts";
import { computePins, diffPins } from "./pins.ts";
import { calibrationDecision, describePlan, nextRunNumber, planRound, runRowFor, scoredCount } from "./plan.ts";
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
  describePermissionBlock,
  eventsPath,
  findReplySource,
  idleCandidate,
  kickoffText,
  LogCache,
  messageArrived,
  orchestratorView,
  PERMISSION_REMEDY,
  PERMISSION_VOID,
  permissionBlocks,
  permissionProblems,
  SessionIndex,
  shellProbe,
  swarmView,
  type MessageView,
  type PermissionBlock,
  type OrchView,
  type SessionMeta,
} from "./swarm.ts";

export const STOP_MESSAGE = "This run is over. Stop all work now: don't start anything new, archive all your child sessions, then end your turn.";
const SHELL_CHECK = "a shell command ran with nobody present";
const PERMISSION_CHECK = "no tool-permission prompt (allow-all permissions)";
const DRIVER_GAP_MS = 10 * 60_000;
// A driver whose liveness can't be checked counts as gone after this long without a call.
const OWNER_SILENT_MS = 15 * 60_000;
const ANSWER_RETRY_MS = 2 * 60_000;
const MAX_ASK_ATTEMPTS = 3;
const MAX_SEND_ATTEMPTS = 3;
// The swarm is quiet after this long without a new event in any of its logs.
const QUIET_MS = 2 * 60_000;
// After a final report is scored, the swarm gets this long to go quiet before the stop message.
const POST_SCORE_SETTLE_MS = 10 * 60_000;
const SELFTEST_MAX_MS = 20 * 60_000;
const MAX_NUMBER_BUMPS = 5;
// An unconfirmed create_session is reconciled against the logs and data.db for this long before
// it may be issued again, and it is issued again at most once.
const CREATE_RECONCILE_MS = 5 * 60_000;
const MAX_CREATE_REISSUES = 1;
const COMMIT_RETRY_MS = 60_000;
const MAX_COMMIT_ATTEMPTS = 3;
const CLOCK_JUMP_MS = 60_000;
export const TIMEOUTS = { git: 2 * 60_000, newRun: 10 * 60_000, score: 30 * 60_000 };

export interface Deps {
  now(): number;
  sleep(ms: number): Promise<void>;
  exec(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<ProcResult>;
  notify(notice: Notice): Promise<{ ok: boolean; error?: string }>;
  appDb: AppDb;
  awake: { start(untilMs: number): number | null; alive(pid: number): boolean; stop(pid: number): void };
  // The calling driver ("session:<id>" for an app session) and whether a driver is still alive
  // (null when that can't be told).
  driverId: string;
  driverAlive(id: string): boolean | null;
  // Runs fn while holding the batch lock: lock.ts withLock (a kernel flock) in the CLI and the
  // rehearsal; tests may pass an in-process lock.
  lock<T>(dir: string, fn: () => Promise<T> | T): Promise<T>;
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
  // "self-test" or "run": the self-test has its own completion rule.
  target?: "self-test" | "run";
  run?: string;
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

export class OwnershipError extends Error {}

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (time: string | undefined): number => (time ? Date.parse(time) : NaN);
const minutes = (value: number): number => value * 60_000;
// Time since `from`, never negative: a clock that jumped back must not look like activity in the future.
const since = (now: number, from: number): number => Math.max(0, now - from);

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

function warn(state: BatchState, warning: string): void {
  if (!state.warnings.includes(warning)) state.warnings.push(warning);
}

function recordCommand(ctx: Ctx, id: string, flags: string): string {
  return `node scripts/batch.ts record --batch ${ctx.config.dir} --action ${id} ${flags}`;
}

function issue(ctx: Ctx, state: BatchState, kind: PendingAction["kind"], target: PendingAction["target"], payload: Record<string, unknown>): ActionOut {
  state.actionSeq++;
  const pending: PendingAction = { id: `a${state.actionSeq}`, kind, target, issuedAt: iso(ctx.deps.now()), payload };
  state.pending = pending;
  log(ctx, `issue ${pending.id} ${kind} for ${target === "selftest" ? "the self-test" : state.runs[target]?.key}`);
  return render(ctx, state, pending, false);
}

const SELFTEST_FINAL_RULE =
  "This is the self-test, not an eval run. Its final message is the response it wrote after its ask_user question was answered: record --final with the id of the latest message. The runner checks the answer itself.";
const RUN_FINAL_RULE =
  "Final report: a message saying the attempt has ended, whether it claims success or reports an honest failure (for example \"I've stopped; import is unfinished\"). The acceptance suite decides passed or gate-failed. Question: it asks the user something and waits for the answer. Neither: progress updates, plans, waiting for child sessions, or anything that says work continues.";
const ROW_RULE =
  "Row 3 if the question is about the spec: what to build, the API's behaviour, data formats, validation, or anything docs/spec-v2.md or the run repo's README could answer. Row 4 for anything else. If it asks several things, row 3 wins if any part is about the spec.";

export function render(ctx: Ctx, state: BatchState, pending: PendingAction, reissued: boolean): ActionOut {
  const p = pending.payload;
  const run = pending.target === "selftest" ? null : state.runs[pending.target];
  const base = {
    batch: ctx.config.id,
    action: pending.kind,
    id: pending.id,
    target: pending.target === "selftest" ? ("self-test" as const) : ("run" as const),
    run: run?.key,
    reissued: reissued || undefined,
    dryRun: ctx.config.dryRun || undefined,
  };
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
        record: [recordCommand(ctx, pending.id, "--session-id <session id from the result>"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "lookup_session":
      return {
        ...base,
        what: "Call get_session with this session id and record the session id it reports.",
        tool: { name: "get_session", args: { project_session_id: p.sessionId } },
        record: [recordCommand(ctx, pending.id, "--session-id <session id>"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "answer_question": {
      // tool.args.answer only ever holds a real reply. Without it, the driver picks a candidate.
      const fixed = typeof p.answer === "string";
      const check =
        "Call get_session(tool.args.project_session_id). Answer only if awaiting_input.question is exactly details.question" +
        (p.requestId ? " and awaiting_input.request_id equals details.requestId" : "") +
        '; otherwise answer nothing and record --failed "question mismatch".';
      return {
        ...base,
        what: fixed
          ? `Answer the open question at once. ${check} Then call answer_session_input with project_session_id, request_id = awaiting_input.request_id, and answer = tool.args.answer, word for word, as free text.`
          : `Answer the open question at once. ${check} tool.args has no answer: choose row 3 or 4 by details.rule, then call answer_session_input with project_session_id, request_id = awaiting_input.request_id, and answer = details.candidates[<row>], word for word, as free text.`,
        tool: { name: "answer_session_input", args: { project_session_id: p.session, ...(fixed ? { answer: p.answer } : {}) } },
        details: {
          question: p.question,
          toolCallId: p.toolCallId,
          requestId: p.requestId ?? null,
          choices: p.choices,
          allowFreeform: p.allowFreeform,
          row: p.row ?? null,
          ...(fixed ? {} : { candidates: p.candidates, rule: ROW_RULE }),
          stop: p.stop ?? false,
        },
        record: [
          recordCommand(ctx, pending.id, `${fixed ? "--answered" : "--row <3|4>"} --request-id <awaiting_input.request_id>`),
          recordCommand(ctx, pending.id, `${fixed ? "--answered" : "--row <3|4>"} --request-id <awaiting_input.request_id> --choice "<choice>"   (only if free text was not allowed and you picked a choice)`),
          recordCommand(ctx, pending.id, "--not-pending   (get_session shows no open question)"),
          recordCommand(ctx, pending.id, '--failed "<error>" --request-id <awaiting_input.request_id>   (the question matched, but answering failed)'),
          recordCommand(ctx, pending.id, '--failed "question mismatch"   (a different question or request_id is pending; nothing was answered)'),
        ],
      };
    }
    case "judge_idle": {
      const selfTest = pending.target === "selftest";
      return {
        ...base,
        what: selfTest
          ? "The self-test session is idle. Apply details.rule: record --final with the latest message's id. Send nothing."
          : "The orchestrator is idle, or its run has reached a limit. Judge its messages by details.rule: one is the final report, the latest is a question, or neither. Only judge; send nothing.",
        details: { messages: p.messages, swarmQuiet: p.swarmQuiet, reason: p.reason, rule: selfTest ? SELFTEST_FINAL_RULE : RUN_FINAL_RULE, ...(selfTest ? {} : { rows: p.rows }) },
        record: selfTest
          ? [recordCommand(ctx, pending.id, "--final <messageId>")]
          : [
              recordCommand(ctx, pending.id, "--final <messageId>"),
              recordCommand(ctx, pending.id, "--question <messageId> [--row <3|4>]   (--row only when the question has no need=plan or need=pr tag)"),
              recordCommand(ctx, pending.id, "--neither"),
            ],
      };
    }
    case "send_message":
      return {
        ...base,
        what: p.stop
          ? run?.voidReason
            ? "The run is void and won't be scored. Send this stop message to the run's orchestrator, word for word."
            : "The run has been scored. Send this stop message to the run's orchestrator, word for word."
          : "Answer the orchestrator's plain-text question: send this reply, word for word, with send_session_message. Send nothing else.",
        tool: { name: "send_session_message", args: { session_id: p.session, message: p.message } },
        record: [recordCommand(ctx, pending.id, "--sent"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
  }
}

// ---------- session lookup ----------

// create_session's result names the Copilot session ID, but data.db keys workspaces by their own ID.
// Either is accepted from the driver; this gives the workspace ID when data.db knows it.
function workspaceIdFor(ctx: Ctx, id: string): string {
  if (ctx.deps.appDb.sessionForWorkspace(id)) return id;
  return ctx.deps.appDb.workspaceForSession(id) ?? id;
}

function knownSessionDir(ctx: Ctx, id: string | undefined | null): string | null {
  return id && existsSync(eventsPath(ctx.config.stateDir, id)) ? id : null;
}

function resolveSession(ctx: Ctx, appSessionId: string | undefined, candidates: () => SessionMeta[], match: (events: LogEvent[]) => boolean): string | null {
  const fromDb = appSessionId ? ctx.deps.appDb.sessionForWorkspace(appSessionId) : null;
  if (knownSessionDir(ctx, fromDb)) return fromDb;
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

// A session the driver created after `issuedAt` but never recorded, found through data.db even
// before its log is written: the newest agent-created workspace in the project.
function createdSinceInDb(ctx: Ctx, projectId: string | undefined, issuedAt: string): { appId: string; sessionId: string | null } | null {
  if (!projectId) return null;
  const rows = ctx.deps.appDb.workspaces(projectId) ?? [];
  const fresh = rows
    .filter((row) => row.createdBy === "agent" && row.createdAt && Date.parse(row.createdAt) >= ms(issuedAt) - 60_000)
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  const row = fresh.at(-1);
  return row ? { appId: row.id, sessionId: row.sessionId } : null;
}

// ---------- shared watch helpers ----------

const settings = (config: BatchConfig) => ({ idleSettleMs: config.idleSettleSec * 1000, swarmSettleMs: config.swarmSettleSec * 1000 });

function judgeAction(
  ctx: Ctx,
  state: BatchState,
  target: PendingAction["target"],
  session: string,
  candidate: { messages: MessageView[]; swarmQuiet: boolean; reason: string },
): ActionOut {
  return issue(ctx, state, "judge_idle", target, {
    session,
    messages: candidate.messages.map((message) => ({ messageId: message.messageId, timestamp: message.timestamp, text: message.text.length > 6000 ? `${message.text.slice(0, 3000)}\n[...]\n${message.text.slice(-3000)}` : message.text })),
    swarmQuiet: candidate.swarmQuiet,
    reason: candidate.reason,
    rows: Object.fromEntries(ctx.sheet.map((row) => [row.row, `${row.type}: ${row.reply}`])),
  });
}

function askAction(ctx: Ctx, state: BatchState, target: PendingAction["target"], session: string, orch: OrchView, requestId: string | undefined, stop = false): ActionOut {
  const ask = orch.openAsk!;
  const common = { session, toolCallId: ask.toolCallId, question: ask.question, choices: ask.choices, allowFreeform: ask.allowFreeform, requestId };
  if (stop) return issue(ctx, state, "answer_question", target, { ...common, answer: STOP_MESSAGE, stop: true });
  const { row, candidates } = rowForQuestion(ask.question);
  return issue(ctx, state, "answer_question", target, {
    ...common,
    ...(row !== null ? { row, answer: replyFor(ctx.sheet, row) } : { candidates: Object.fromEntries(candidates.map((r) => [r, replyFor(ctx.sheet, r)])) }),
  });
}

// ---------- keep-awake ----------

// A batch has no set end, so a round start renews the hold once less than half of it is left.
const AWAKE_HOLD_MS = minutes(24 * 60);

function ensureAwake(ctx: Ctx, state: BatchState): void {
  if (!ctx.config.keepAwake) return;
  const now = ctx.deps.now();
  if (state.caffeinate && ctx.deps.awake.alive(state.caffeinate.pid)) {
    if (ms(state.caffeinate.until) - now > AWAKE_HOLD_MS / 2) return;
    ctx.deps.awake.stop(state.caffeinate.pid);
  }
  const until = now + AWAKE_HOLD_MS;
  const pid = ctx.deps.awake.start(until);
  state.caffeinate = pid ? { pid, until: iso(until) } : null;
  log(ctx, pid ? `caffeinate -is held by pid ${pid} until ${iso(until)}` : "could not start caffeinate");
}

function releaseAwake(ctx: Ctx, state: BatchState): void {
  if (state.caffeinate) ctx.deps.awake.stop(state.caffeinate.pid);
  state.caffeinate = null;
}

// Flag codes a run gained after its outcome notification went out.
function lateFlagCodes(run: RunState): string[] {
  if (!run.notified) return [];
  const sent = new Set(run.notifiedFlags ?? []);
  return [...new Set(run.flags.map((flag) => flag.code))].filter((code) => !sent.has(code));
}

// ---------- phase control ----------

type Stop = { reason: string; failure: boolean };

// The first failure wins, then the first reason.
function firstStop(...stops: (Stop | null | undefined)[]): Stop | null {
  return stops.find((stop) => stop?.failure) ?? stops.find((stop) => stop) ?? null;
}

// While a round has runs, the stop waits for them: no new run starts, and the batch stops when the
// next round would start, after every run of this one has ended.
function stopBatch(ctx: Ctx, state: BatchState, reason: string, failure: boolean): void {
  if (state.phase === "runs" && state.active.length > 0) {
    const halt = firstStop(state.halt, { reason, failure })!;
    if (halt !== state.halt) {
      state.halt = halt;
      const busy = state.active.some((index) => !NOT_STARTED.has(state.runs[index].status) && !["done", "void"].includes(state.runs[index].status));
      log(ctx, `no new run starts: ${reason}${busy ? "; the runs in progress finish first" : ""}`);
    }
    return;
  }
  delete state.halt;
  state.stopReason = reason;
  state.phase = "finishing";
  state.failed = failure;
  log(ctx, `stopping: ${reason}`);
}

async function git(ctx: Ctx, args: string[]): Promise<ProcResult> {
  return ctx.deps.exec("git", args, { cwd: dirname(ctx.config.resultsPath), timeoutMs: TIMEOUTS.git });
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
  const late = state.runs
    .map((run) => ({ run, codes: lateFlagCodes(run) }))
    .filter(({ codes }) => codes.length > 0)
    .map(({ run, codes }) => `${run.key} ${codes.join(",")}`);
  const lateText = late.length > 0 ? `; late flags (after scoring): ${late.join("; ")}` : "";
  await notify(
    ctx,
    state,
    failed ? notices.stopped(ctx.config.id, `${state.stopReason ?? "unknown"}${lateText}`, reportPath) : notices.done(ctx.config.id, `${counts}; ${state.stopReason}${lateText}`, reportPath),
  );
  state.phase = failed ? "stopped" : "done";
  await releaseActive(ctx.config.activeGuard, ctx.config.id, ctx.config.dir);
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

// The checks before a kickoff: at planning time and again just before create_session is issued.
function admissionBlock(ctx: Ctx, state: BatchState): Stop | null {
  if (state.fatal) return { reason: state.fatal, failure: true };
  if (state.stopRequested) return { reason: "you asked the batch to stop", failure: false };
  // A run given up because its create_session was never confirmed must not have started after all.
  for (const run of state.runs) {
    if (!run.unconfirmedSince) continue;
    const late = resolveRunSession(ctx, run) ?? createdSinceInDb(ctx, run.projectId, run.unconfirmedSince)?.appId;
    if (late) {
      state.fatal ??= `a session (${late}) appeared for ${run.key} after it was given up as never started; archive it before starting another batch`;
      return { reason: state.fatal, failure: true };
    }
  }
  if (state.startFailures >= 2) return { reason: "two runs in a row failed to start", failure: true };
  if (state.scoreFailures >= 2) return { reason: "score failed for two runs in a row", failure: true };
  const drift = diffPins(state.pins, currentPins(ctx.config));
  if (drift.length > 0) return { reason: `pinned inputs changed: ${drift.join("; ")}`, failure: true };
  if (ctx.config.variantSet) {
    const mismatches = verifyVariants(ctx.config.variantSet, ctx.config.agentsDir);
    if (mismatches.length > 0) return { reason: `variant registration differs from manifest: ${mismatches.join("; ")}`, failure: true };
  }
  return null;
}

// ---------- self-test ----------

export const selfTestMarker = (nonce: string): string => `eval-selftest-${nonce}`;

// The shell command is compound on purpose: host policy approves some single read-only commands
// (`git status`, `pwd`) even without allow-all permissions, but not this one.
function selfTestPrompt(nonce: string): string {
  return [
    `Eval runner self-test ${nonce}.`,
    `First, run this shell command with your shell tool, exactly as written: pwd && echo ${selfTestMarker(nonce)}`,
    `Then call the ask_user tool exactly once, with the question "[unit=selftest need=plan] Self-test ${nonce}: may I finish?" and the choices ["yes", "no"].`,
    "When it returns, reply with one short line that quotes the answer you got, and stop. Do nothing else: no other tools, files or commands.",
  ].join("\n");
}

function selfTestCreateArgs(ctx: Ctx, test: SelfTestState): Record<string, unknown> {
  const { config } = ctx;
  const kickoff: Record<string, unknown> = { prompt: test.prompt, model: config.selfTest.model, reasoning_effort: config.selfTest.effort, mode: "interactive" };
  if (config.selfTest.agent) kickoff.agent = config.selfTest.agent;
  return { project_id: test.projectId, workspace_type: "worktree", detached: true, coordinate_with_creator: false, kickoff };
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
        const result = await deps.exec("git", args, { cwd: test.repoDir, timeoutMs: TIMEOUTS.git });
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
    case "project":
      test.startRequestedAt = iso(now);
      test.status = "starting";
      return { action: issue(ctx, state, "create_session", "selftest", { args: selfTestCreateArgs(ctx, test) }) };
    case "starting":
      return {};
    case "running": {
      if (since(now, ms(test.startRequestedAt)) > SELFTEST_MAX_MS) {
        fail("it did not finish within 20 minutes");
        return { progressed: true };
      }
      test.sessionId ??= resolveSelfTestSession(ctx, test) ?? undefined;
      if (!test.sessionId) {
        if (since(now, ms(test.lastStartAt ?? test.startRequestedAt)) > minutes(config.sessionAppearMin)) fail("its session never appeared in the session-state folder");
        return { progressed: test.status !== "running" };
      }
      const events = ctx.logs.read(eventsPath(config.stateDir, test.sessionId));
      const blocks = permissionBlocks(test.sessionId, events, now);
      if (blocks.length > 0) {
        fail(`${PERMISSION_CHECK}: ${describePermissionBlock(blocks[0])}. ${PERMISSION_REMEDY}`);
        await notify(ctx, state, notices.selfTest(config.id, state.selftests.length, false, test.failure ?? ""));
        return { progressed: true };
      }
      const orch = orchestratorView(events);
      const session = test.appSessionId ?? test.sessionId;
      if (orch.openAsk) {
        const answered = test.answered?.toolCallId === orch.openAsk.toolCallId;
        if (!answered || (since(now, ms(test.answered!.at)) > ANSWER_RETRY_MS && test.askAttempts < MAX_ASK_ATTEMPTS)) {
          return { action: askAction(ctx, state, "selftest", session, orch, test.requestIds?.[orch.openAsk.toolCallId] ?? (answered ? test.answered!.requestId : undefined)) };
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
      const names = failed.map((check) => check.name).join("; ");
      if (failed.length > 0) fail(failed.some((check) => check.name === PERMISSION_CHECK) ? `${names}. ${PERMISSION_REMEDY}` : names);
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
  check("kickoff text arrived unchanged", kickoffText(orch) === test.prompt, kickoffText(orch) === test.prompt ? "identical" : "differs from what was sent");
  check("model and effort", orch.model === config.selfTest.model && orch.effort === config.selfTest.effort, `session.start: ${orch.model ?? "none"} at ${orch.effort ?? "none"}`);
  const agentOk = config.selfTest.agent
    ? orch.agent === config.selfTest.agent
    : orch.agent === null || !(ORCHESTRATOR_AGENTS.includes(orch.agent) || config.variants.includes(orch.agent) ||
      (config.variantSet && variantAgents(config.variantSet).includes(orch.agent)));
  check("agent", agentOk, `selected: ${orch.agent ?? "the default agent"}`);
  const reply = replyFor(ctx.sheet, 1);
  const answered = orch.askCalls.find((call) => call.completed && call.resultText.includes(reply));
  check("ask_user answered word for word", Boolean(answered), answered ? `got "${reply}"` : `${orch.askCalls.length} ask_user call(s), none completed with "${reply}"`);
  const askDone = answered ? answered.startAt : Infinity;
  check("end detected", Boolean(test.final) && ms(test.final!.timestamp) >= askDone, test.final ? `final message at ${test.final.timestamp}` : "no final message judged");
  // Allow-all permissions leave no permission request in the log at all; a session without them
  // logs each request with permissionMode "manual", and nobody can approve the ones host policy doesn't.
  const probe = shellProbe(events, selfTestMarker(test.nonce));
  check(SHELL_CHECK, probe.ok, probe.detail);
  const permissions = permissionProblems(test.sessionId ?? "missing", events);
  check(PERMISSION_CHECK, permissions.manual === 0 && permissions.pending === 0 && permissions.denied === 0, permissions.detail);
  const account = test.projectId ? deps.appDb.projectAccount(test.projectId) : null;
  check("session runs as the batch owner", account?.toLowerCase() === config.owner.toLowerCase(), `project account ${account ?? "unreadable"}, owner ${config.owner}`);
  // The workspace row may have been written after the session was recorded.
  if (test.appSessionId) test.appSessionId = workspaceIdFor(ctx, test.appSessionId);
  const links = test.appSessionId ? deps.appDb.creatorLinks(test.appSessionId) : null;
  check("session is detached (no creator link)", Boolean(links) && !links!.creator && !links!.coordinator, links ? `creator ${links.creator ?? "none"}, coordinator ${links.coordinator ?? "none"}` : "workspace row unreadable");
  // Every app-database lookup the runner relies on, on this real session and project.
  const problems = deps.appDb.probe();
  const forward = test.appSessionId ? deps.appDb.sessionForWorkspace(test.appSessionId) : null;
  const backward = test.sessionId ? deps.appDb.workspaceForSession(test.sessionId) : null;
  const interruption = test.sessionId ? deps.appDb.interruption(test.sessionId) : null;
  const listed = test.projectId ? (deps.appDb.workspaces(test.projectId) ?? []).some((row) => row.id === test.appSessionId && Boolean(row.createdAt)) : false;
  if (forward !== test.sessionId) problems.push(`workspace -> session gave ${forward ?? "nothing"}`);
  if (backward !== test.appSessionId) problems.push(`session -> workspace gave ${backward ?? "nothing"}`);
  if (interruption?.wasInterrupted !== false) problems.push(`sessions.was_interrupted gave ${interruption ? String(interruption.wasInterrupted) : "nothing"}`);
  if (!listed) problems.push("the project's workspaces don't list the session with its created_at");
  problems.push(...deps.appDb.takeErrors());
  check("app database lookups work", problems.length === 0, problems.length === 0 ? "every query the runner uses answered" : problems.join("; "));
  const memory = scanSession(test.sessionId ?? "missing", events).filter((finding) => finding.code === "memory-loaded");
  check("no memories loaded (Memory is off)", memory.length === 0, memory.length === 0 ? "no <memories> block" : memory.map((finding) => finding.detail).join("; "));
  test.checks = checks;
}

// ---------- runs ----------

function plannedTotal(ctx: Ctx, state: BatchState): number {
  const rows = readResults(ctx.config.resultsPath);
  const decision = calibrationDecision(rows, ctx.config.variants, ctx.config.variantSet, state.policyCalibration);
  const done = state.runs.filter((run) => runRowFor(rows, run)).length;
  const remaining = ctx.config.variants.reduce((sum, variant) => sum + Math.max(0, ctx.config.runsPerVariant - scoredCount(
    state.runs, rows, variant, decision.features,
    ctx.config.variantSet?.variants[variant],
  )), 0);
  return done + remaining + (ctx.config.variantSet ? decision.pending.length : 0);
}

// Plans the next round and starts all of its runs together; called only when no run is active.
async function startNextRound(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const { config, deps } = ctx;
  const now = deps.now();
  const stop = firstStop(state.halt, admissionBlock(ctx, state));
  if (stop) {
    stopBatch(ctx, state, stop.reason, stop.failure);
    return { progressed: true };
  }
  const rows = readResults(config.resultsPath);
  const { round, decision } = planRound(state.runs, rows, config.variants, config.runsPerVariant, config.parallel ?? 1, config.variantSet, state.policyCalibration);
  state.calibration = decision.reason;
  if (config.variantSet && decision.state !== "undecided") {
    state.policyCalibration ??= { dropSummary: decision.state === "drop", reason: decision.reason };
    if (decision.state === "full") {
      stopBatch(ctx, state, `${decision.reason}; stopped before the pilot; user approval is required to change its feature set`, true);
      return { progressed: true };
    }
  }
  if (round.length === 0) {
    stopBatch(ctx, state, "every variant has its scored runs", false);
    return { progressed: true };
  }
  ensureAwake(ctx, state);
  for (const next of round) {
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
      requestIds: {},
      flags: [],
    };
    state.runs.push(run);
    state.active.push(state.runs.length - 1);
    log(ctx, `planned ${run.key} on ${featureSetName(run.features)}${run.calibration ? " (calibration)" : ""}`);
  }
  if (round.length > 1) log(ctx, `round of ${round.length}: ${state.active.map((index) => state.runs[index].key).join(", ")}`);
  return { progressed: true };
}

export function currentPins(config: BatchConfig) {
  const files: Record<string, string> = {
    "kickoff.md": join(config.kitDir, "kickoff.md"), "answers.md": join(config.kitDir, "answers.md"),
    "score.ts": config.scoreScript,
    ...(config.variantSet ? variantFiles(config.variantSet) : {}),
  };
  const addFiles = (relative: string) => {
    const path = join(config.kitDir, relative);
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(relative, entry.name);
      if (entry.isDirectory()) addFiles(next);
      else files[next] = join(config.kitDir, next);
    }
  };
  for (const dir of ["acceptance", "robustness", "pricing", "scripts/lib"]) addFiles(dir);
  return computePins({
    agentsDir: config.agentsDir,
    variants: config.variantSet ? variantAgents(config.variantSet) : config.variants,
    explicitAgents: Boolean(config.variantSet),
    files,
    appPlist: config.appPlist,
    cliVersionFile: config.cliVersionFile,
  });
}

// stopFirst: the run's swarm may still be working, so it gets the stop message and the drain wait
// before it ends as void.
function voidRun(ctx: Ctx, state: BatchState, run: RunState, reason: string, startFailure: boolean, stopFirst = false): void {
  run.status = stopFirst ? "stopping" : "void";
  run.voidReason = reason;
  if (startFailure) {
    state.startFailures++;
    addFlag(run, "start-failed", reason, iso(ctx.deps.now()));
  }
  log(ctx, `${run.key} void: ${reason}${stopFirst ? "; the stop message goes out first" : ""}`);
}

function swarmPermissionBlocks(ctx: Ctx, run: RunState, now: number): PermissionBlock[] {
  return readLogs(ctx, runSessionIds(ctx, run)).flatMap((log) => permissionBlocks(log.id, log.events, now));
}

// A tool-permission prompt in a run's swarm: nobody can answer it, and every later run would hit
// the same, so no further run starts. Before the run's end it voids the run; after its end (a judged
// final report, or scoring) the run's result stands.
async function permissionBlocked(ctx: Ctx, state: BatchState, run: RunState, blocks: PermissionBlock[], voidIt: boolean): Promise<void> {
  const at = iso(ctx.deps.now());
  for (const block of blocks) addFlag(run, "permission-prompt", describePermissionBlock(block), at);
  const first = `${describePermissionBlock(blocks[0])}${blocks.length > 1 ? ` (and ${blocks.length - 1} more)` : ""}`;
  if (voidIt) voidRun(ctx, state, run, `${PERMISSION_VOID}: ${first}`, false, true);
  const cause = voidIt ? `${run.key} was ${PERMISSION_VOID} (${first})` : `${run.key}'s swarm hit a tool-permission prompt after the run ended (${first})`;
  state.fatal ??= `${cause}. ${PERMISSION_REMEDY}`;
  const what = voidIt ? `${run.key} is void and won't be scored: it was ${PERMISSION_VOID} (${first})` : `${cause}; its result stands`;
  await notify(ctx, state, notices.failure(ctx.config.id, "permission-prompt", `${what}. No further run starts; the batch stops once the runs in progress end. ${PERMISSION_REMEDY}.`));
}

// The kickoff exactly as a manual paste delivers it: kickoff.md without its trailing newline (run 1's
// typed kickoff in its event log equals that form).
export function kickoffPrompt(config: BatchConfig, run: RunState): string {
  return readFileSync(join(config.runsDir, `${run.name}.kickoff.md`), "utf8").trimEnd();
}

function runCreateArgs(ctx: Ctx, run: RunState): Record<string, unknown> {
  const { config } = ctx;
  return {
    project_id: run.projectId,
    workspace_type: "worktree",
    detached: true,
    coordinate_with_creator: false,
    kickoff: { prompt: kickoffPrompt(config, run), agent: config.variantSet?.variants[run.variant].agent ?? run.variant, model: config.model, reasoning_effort: config.effort, context_tier: config.contextTier, mode: "interactive" },
  };
}

// A clone that new-run finished before the runner could save it: one "Seed v1" commit, the kickoff
// file, and (unless a dry run) the GitHub remote.
async function finishedClone(ctx: Ctx, run: RunState): Promise<boolean> {
  if (!existsSync(run.repoDir) || !existsSync(join(ctx.config.runsDir, `${run.name}.kickoff.md`))) return false;
  const subjects = await ctx.deps.exec("git", ["log", "--format=%s"], { cwd: run.repoDir, timeoutMs: TIMEOUTS.git });
  if (subjects.code !== 0 || subjects.stdout.trim() !== "Seed v1") return false;
  if (ctx.config.dryRun) return true;
  return (await ctx.deps.exec("git", ["remote", "get-url", "origin"], { cwd: run.repoDir, timeoutMs: TIMEOUTS.git })).code === 0;
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
    const result = await deps.exec(process.execPath, args, { cwd: config.kitDir, timeoutMs: TIMEOUTS.newRun });
    if (result.code === 0) {
      run.status = "repo";
      log(ctx, `new-run ${run.name} ok`);
      return { progressed: true };
    }
    const error = (result.stderr || result.stdout).trim().split("\n").pop() ?? "";
    if (!/already exists/.test(error) || result.timedOut) {
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

function interrupted(ctx: Ctx, run: RunState): string | null {
  if (!run.sessionId) return null;
  const result = ctx.deps.appDb.interruption(run.sessionId);
  return result?.wasInterrupted ? (result.reason ?? "interrupted") : null;
}

async function watchRun(ctx: Ctx, state: BatchState, run: RunState, index: number): Promise<StepResult> {
  const { config, deps } = ctx;
  const now = deps.now();
  run.sessionId ??= resolveRunSession(ctx, run) ?? undefined;
  const waitedMs = since(now, ms(run.lastStartAt ?? run.startRequestedAt));
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
    if (kickoffText(orch) !== kickoffPrompt(config, run)) addFlag(run, "kickoff-text", "the kickoff differs from kickoff.md as a manual paste delivers it", at);
    const wrong: string[] = [];
    if (orch.agent !== (config.variantSet?.variants[run.variant].agent ?? run.variant)) wrong.push(`agent ${orch.agent ?? "none"}`);
    if (orch.model !== config.model) wrong.push(`model ${orch.model ?? "none"}`);
    if (orch.effort !== config.effort) wrong.push(`effort ${orch.effort ?? "none"}`);
    if (orch.contextTier !== config.contextTier) wrong.push(`context tier ${orch.contextTier ?? "none"}`);
    if (wrong.length > 0) addFlag(run, "session-settings", `session.start differs from the request: ${wrong.join(", ")}`, at);
    if (config.variantSet && orch.agent !== run.variant) {
      state.fatal ??= `${run.key} logged agent ${orch.agent ?? "none"}; expected ${run.variant}; no further run may start`;
    }
    log(ctx, `${run.key} kickoff at ${run.kickoffAt} in session ${run.sessionId}`);
  }

  const logs = readLogs(ctx, runSessionIds(ctx, run));
  const swarm = swarmView(logs);
  const blocks = logs.flatMap((log) => permissionBlocks(log.id, log.events, now));
  if (blocks.length > 0) {
    await permissionBlocked(ctx, state, run, blocks, true);
    return { progressed: true };
  }
  findAnswerSource(ctx, run, events);

  const session = run.appSessionId ?? run.sessionId;
  const kickoffMs = ms(run.kickoffAt);
  const limitMs = minutes(config.timeoutMin);
  // As in score: a run is over time only when more than 90 minutes have passed.
  const timedOut = since(now, kickoffMs) > limitMs;
  const ask = orch.openAsk;
  const askAttempt = ask ? run.askAttempts[ask.toolCallId] : undefined;
  const askAnswerable = Boolean(ask) && (!askAttempt || askAttempt.count < MAX_ASK_ATTEMPTS);
  // A pending question means the swarm is waiting on the user, not stalled.
  const stalled = !askAnswerable && since(now, swarm.lastActivityAt) >= minutes(config.stallMin);

  if (timedOut || stalled || run.flags.some((flag) => flag.code === "driver-gap")) {
    const reason = interrupted(ctx, run);
    if (reason) {
      voidRun(ctx, state, run, `the app stopped the run's session (${reason}), for example in a restart or update`, false);
      await notify(ctx, state, notices.runVoid(config.id, run.variant, run.n, run.voidReason!));
      return { progressed: true };
    }
  }
  if (timedOut || stalled) {
    // A final report written in time wins over the limit, however late it is seen: judge it first.
    // Only the latest messages can be the report; older ones are progress the driver needn't revisit.
    const inTime = timedOut ? orch.messages.filter((message) => message.at - kickoffMs <= limitMs) : orch.messages;
    const unjudged = inTime.slice(-3).filter((message) => !run.judged.includes(message.messageId));
    if (unjudged.length > 0) {
      return {
        action: judgeAction(ctx, state, index, session, {
          messages: unjudged,
          swarmQuiet: since(now, swarm.lastActivityAt) >= config.swarmSettleSec * 1000,
          reason: `the run reached its ${timedOut ? "90-minute" : "stall"} limit; a final report among these messages is scored at its own time`,
        }),
      };
    }
    run.endReason = timedOut ? "timeout" : "stalled";
    run.status = "scoring";
    if (stalled) {
      for (const s of swarm.sessions) {
        for (const tool of s.openTools) addFlag(run, "open-tool-at-stall", `session ${s.id}${tool.agentId ? ` (sub-agent ${tool.agentId})` : ""} had an open ${tool.toolName} call since ${iso(tool.at)}; an MCP elicitation or a long silent command may have been waiting`, at);
      }
    }
    log(ctx, `${run.key} ${run.endReason}`);
    return { progressed: true };
  }
  if (ask) {
    if (!askAttempt || (since(now, ms(askAttempt.at)) > ANSWER_RETRY_MS && askAttempt.count < MAX_ASK_ATTEMPTS)) {
      if (askAttempt) addFlag(run, "answer-retry", `ask_user ${ask.toolCallId} was still open ${Math.round(since(now, ms(askAttempt.at)) / 1000)} s after an answer`, at);
      return { action: askAction(ctx, state, index, session, orch, run.requestIds[ask.toolCallId]) };
    }
  }
  if (run.plain && !run.plain.sentAt && run.plain.sendAttempts < MAX_SEND_ATTEMPTS) {
    run.plain.issuedAt ??= at;
    return { action: issue(ctx, state, "send_message", index, { session, message: run.plain.text, stop: false }) };
  }
  const candidate = idleCandidate(orch, swarm, now, run.judged, settings(config));
  if (candidate) return { action: judgeAction(ctx, state, index, session, candidate) };
  return {};
}

// The driver's plain-text reply in the run's log: looked for from when the send action was issued,
// so a late record or a restart can't move the window past it.
function findAnswerSource(ctx: Ctx, run: RunState, events?: LogEvent[]): void {
  if (!run.plain?.sentAt || run.answerSource) return;
  const log = events ?? ctx.logs.read(eventsPath(ctx.config.stateDir, run.sessionId ?? "missing"));
  const found = findReplySource(log, run.plain.text, ms(run.plain.issuedAt ?? run.plain.sentAt) - 5000);
  if (found) {
    run.answerSource = found.source;
    run.plain.deliveredAt = found.timestamp;
    const answer = run.answers.find((a) => a.kind === "plain" && a.ref === run.plain!.messageId);
    if (answer) answer.at = found.timestamp;
  }
}

export function noteFor(config: BatchConfig, run: RunState): string {
  const codes = [...new Set(run.flags.map((flag) => flag.code))];
  return [`batch=${config.id}`, "driver=eval-runner", `memory=${config.memoryOffConfirmed ? "off" : "unconfirmed"}`, ...(config.dryRun ? ["dry-run"] : []), `flags=${codes.join(",") || "none"}`].join("; ");
}

function scanHygiene(ctx: Ctx, run: RunState): void {
  for (const finding of scanSwarm(readLogs(ctx, runSessionIds(ctx, run)))) addFlag(run, finding.code, finding.detail, iso(ctx.deps.now()));
}

async function scoreRun(ctx: Ctx, state: BatchState, run: RunState): Promise<void> {
  const { config, deps } = ctx;
  findAnswerSource(ctx, run);
  if (config.variantSet) {
    const variant = config.variantSet.variants[run.variant];
    const now = currentPins(config);
    if (!run.agentSha256 || !run.agentBundleSha256) addFlag(run, "agent-drift", "registered launch hashes were not recorded; provenance is unavailable", iso(deps.now()));
    else {
      const changed = [variant.agent, ...Object.keys(variant.workers)].filter((name) =>
        now.agents[name]?.sha256 !== (name === variant.agent ? run.agentSha256 : state.pins.agents[name]?.sha256));
      if (changed.length > 0) addFlag(run, "agent-drift", `registered files changed between launch and scoring: ${changed.join(", ")}`, iso(deps.now()));
    }
  }
  if (run.plain?.sentAt && !run.answerSource) addFlag(run, "answer-source-unknown", "the plain-text answer wasn't found in the log, so score counted it as neither a question nor blocked time", iso(deps.now()));
  // Flags known before scoring go into the row's note; later ones stay in the report.
  scanHygiene(ctx, run);
  run.note = noteFor(config, run);
  const args = [config.scoreScript, "--repo-dir", run.repoDir, "--session", run.sessionId ?? "", "--state-dir", config.stateDir, "--results", config.resultsPath, "--note", run.note];
  args.push("--app-db", config.appDb, "--calibration", run.calibration ? "yes" : "no");
  if (config.variantSet && run.agentSha256 && run.agentBundleSha256) {
    const variant = config.variantSet.variants[run.variant];
    args.push("--agent-revision", variant.revision, "--agent-sha256", run.agentSha256, "--agent-bundle-sha256", run.agentBundleSha256);
  }
  if (config.dryRun) args.push("--no-github");
  if (run.endReason === "final" && run.final) args.push("--end-at", run.final.timestamp);
  else args.push("--outcome", run.endReason ?? "stalled");
  if (run.answerSource) args.push("--answer-source", run.answerSource);
  const result = await deps.exec(process.execPath, args, { cwd: config.kitDir, timeoutMs: TIMEOUTS.score });
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
    if (config.variantSet && row.agent !== run.variant) {
      state.fatal ??= `${run.key} logged agent ${row.agent || "none"}; expected ${run.variant}; no further run may start`;
    }
    if (result.code !== 0) addFlag(run, "score-warning", `score exited ${result.code} after saving its gate row; diagnostics may be incomplete (log: ${run.scoreLog})`, run.scoredAt);
  } else {
    state.scoreFailures++;
    addFlag(run, "score-failed", `score exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(-1)[0] ?? ""} (log: ${run.scoreLog})`, run.scoredAt);
  }
  run.status = "scored";
  log(ctx, `${run.key} scored: exit ${result.code}, ${row ? `${row.outcome} ${row.minutes} min` : "no row"}`);
}

async function commitResult(ctx: Ctx, state: BatchState, run: RunState): Promise<string | null> {
  const { config } = ctx;
  const branch = (await git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (!branch || ["main", "master", "HEAD"].includes(branch)) return `the checkout is on "${branch || "unknown"}", and results never go to main`;
  const status = await git(ctx, ["status", "--porcelain", "--", config.resultsPath]);
  if (status.code !== 0) return `git status failed: ${status.stderr.trim()}`;
  if (status.stdout.trim() !== "") {
    const message = `chore(evals): record ${run.variant} run ${run.n} (${run.row?.outcome ?? "not scored"})`;
    const commit = await git(ctx, ["commit", "-q", "-m", message, "--only", "--", config.resultsPath]);
    if (commit.code !== 0) return `git commit failed: ${commit.stderr.trim().split("\n").pop()}`;
  }
  if (config.push) {
    const remote = await git(ctx, ["remote", "get-url", "origin"]);
    if (remote.code !== 0) warn(state, "push skipped: the ai_tools checkout has no origin remote");
    else {
      const push = await git(ctx, ["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
      if (push.code !== 0) warn(state, `push failed after ${run.key}: ${push.stderr.trim().split("\n").pop()}`);
    }
  }
  return null;
}

function swarmQuietFor(ctx: Ctx, run: RunState, now: number): number {
  return since(now, swarmView(readLogs(ctx, runSessionIds(ctx, run))).lastActivityAt);
}

// Runs that haven't asked for their session yet.
const NOT_STARTED = new Set(["new", "repo", "project"]);
// Runs past their end whose swarm is still watched.
const AFTER_END = new Set(["ending", "settling", "stopping", "draining"]);

// A stop that is already known without the full admission checks.
function knownStop(state: BatchState): Stop | null {
  return firstStop(
    state.halt,
    state.fatal ? { reason: state.fatal, failure: true } : null,
    state.stopRequested ? { reason: "you asked the batch to stop", failure: false } : null,
  );
}

// Steps every run of the round until one needs the driver. Once a stop is known, the round's runs
// that haven't started are void; the others finish first.
async function runsStep(ctx: Ctx, state: BatchState): Promise<StepResult> {
  if (state.active.length === 0) return startNextRound(ctx, state);
  // Scored runs go first, so a run's row is committed before another run writes its own.
  const order = [...state.active].sort((a, b) => Number(state.runs[b].status === "scored") - Number(state.runs[a].status === "scored"));
  let progressed = false;
  for (const index of order) {
    const before = state.runs[index].status;
    const stop = knownStop(state);
    if (stop && NOT_STARTED.has(before)) voidRun(ctx, state, state.runs[index], `not started: ${stop.reason}`, false);
    const result = await runStep(ctx, state, index);
    for (const error of ctx.deps.appDb.takeErrors()) {
      addFlag(state.runs[index], "app-db", error, iso(ctx.deps.now()));
      warn(state, `app database: ${error}`);
    }
    if (result.action) return result;
    if (result.progressed) progressed = true;
    if (before === "scoring") return { progressed: true };
  }
  return { progressed };
}

async function runStep(ctx: Ctx, state: BatchState, index: number): Promise<StepResult> {
  const { config, deps } = ctx;
  const run = state.runs[index];
  const now = deps.now();
  if (AFTER_END.has(run.status) && !run.voidReason) {
    const blocks = swarmPermissionBlocks(ctx, run, now);
    if (blocks.length > 0) await permissionBlocked(ctx, state, run, blocks, false);
  }
  switch (run.status) {
    case "new":
      return newRepo(ctx, state, run);
    case "repo":
      return { action: issue(ctx, state, "create_project", index, { args: { path: run.repoDir } }) };
    case "project": {
      // The last runner-controlled point before a run starts: check stops and pins again.
      const block = firstStop(state.halt, admissionBlock(ctx, state));
      if (block) {
        voidRun(ctx, state, run, `not started: ${block.reason}`, false);
        stopBatch(ctx, state, block.reason, block.failure);
        return { progressed: true };
      }
      run.startRequestedAt = iso(now);
      if (config.variantSet) {
        const variant = config.variantSet.variants[run.variant];
        run.agentSha256 = state.pins.agents[variant.agent].sha256;
        run.agentBundleSha256 = variantBundle(variant);
      }
      run.status = "starting";
      return { action: issue(ctx, state, "create_session", index, { args: runCreateArgs(ctx, run) }) };
    }
    case "starting":
      return {};
    case "running":
      return watchRun(ctx, state, run, index);
    case "ending": {
      const quiet = swarmQuietFor(ctx, run, now) >= config.swarmSettleSec * 1000;
      const waited = since(now, ms(run.endingSince));
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
      if (run.row && !run.committed) {
        if (run.lastCommitAttemptAt && since(now, ms(run.lastCommitAttemptAt)) < COMMIT_RETRY_MS) return {};
        const error = await commitResult(ctx, state, run);
        if (error) {
          run.commitAttempts = (run.commitAttempts ?? 0) + 1;
          run.lastCommitAttemptAt = iso(now);
          log(ctx, `${run.key} results commit failed (attempt ${run.commitAttempts}): ${error}`);
          if (run.commitAttempts < MAX_COMMIT_ATTEMPTS) return {};
          addFlag(run, "commit-failed", `results.csv could not be committed after ${run.commitAttempts} attempts: ${error}`, iso(now));
          // Another run of the round may have set the first fatal; this failure still has its own notice and flag.
          const reason = `the results commit for ${run.key} failed ${run.commitAttempts} times (${error}); its row is in results.csv but not committed`;
          state.fatal ??= reason;
          await notify(ctx, state, notices.failure(config.id, `commit-${run.key}`, `${reason}. No further run starts.`));
        } else run.committed = true;
      }
      if (!run.notified) {
        const rows = readResults(config.resultsPath);
        const row = runRowFor(rows, run);
        const done = state.runs.filter((r) => runRowFor(rows, r)).length;
        await notify(
          ctx,
          state,
          notices.runOutcome(config.id, {
            index: done,
            total: Math.max(done, plannedTotal(ctx, state)),
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
        run.notifiedFlags = [...new Set(run.flags.map((flag) => flag.code))];
      }
      if (run.endReason === "final") {
        run.status = "settling";
        run.settlingSince = iso(now);
      } else run.status = "stopping";
      return { progressed: true };
    }
    case "settling": {
      // Scored at the final report, as in a manual run; but the next run starts only on a quiet swarm.
      if (swarmQuietFor(ctx, run, now) >= QUIET_MS) {
        run.status = "done";
        return { progressed: true };
      }
      if (since(now, ms(run.settlingSince)) >= POST_SCORE_SETTLE_MS) {
        addFlag(run, "swarm-not-quiet", `the swarm was still active ${Math.round(POST_SCORE_SETTLE_MS / 60_000)} min after scoring the final report; sent the stop message`, iso(now));
        run.status = "stopping";
        return { progressed: true };
      }
      return {};
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
      if (orch.openAsk) return { action: askAction(ctx, state, index, session, orch, run.requestIds[orch.openAsk.toolCallId], true) };
      return { action: issue(ctx, state, "send_message", index, { session, message: STOP_MESSAGE, stop: true }) };
    }
    case "draining": {
      if (swarmQuietFor(ctx, run, now) >= QUIET_MS) {
        run.status = run.voidReason ? "void" : "done";
        return { progressed: true };
      }
      const waited = since(now, ms(run.drainingSince));
      if (waited >= minutes(config.drainMaxMin)) {
        addFlag(run, "swarm-not-quiet", `the swarm was still active ${Math.round(waited / 60_000)} min after the stop message`, iso(now));
        // Never admit another run next to a busy swarm: stop the batch and list the sessions.
        state.fatal ??= `the swarm of ${run.key} was still active ${Math.round(waited / 60_000)} min after the stop message; archive its sessions (listed in the report)`;
        run.status = run.voidReason ? "void" : "done";
        return { progressed: true };
      }
      return {};
    }
    case "done":
    case "void":
      if (run.status === "done") {
        scanHygiene(ctx, run);
        // Flags found after the outcome notification (cleanup, memory use after scoring) go out as a
        // short follow-up. The score and the row's note stay as they were.
        const late = lateFlagCodes(run);
        if (run.notified && late.length > 0 && late.join(",") !== (run.lateNotified ?? []).join(",")) {
          await notify(ctx, state, notices.lateFlags(config.id, run.variant, run.n, late));
          run.lateNotified = late;
        }
      }
      run.endedAt ??= iso(now);
      state.active = state.active.filter((other) => other !== index);
      return { progressed: true };
  }
}

// ---------- pending actions after a restart ----------

type Revalidated = "emit" | "cleared" | "hold";

function revalidate(ctx: Ctx, state: BatchState): Revalidated {
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
    case "create_session":
      return reconcileCreate(ctx, state, pending, target, now);
    case "send_message": {
      const run = target as RunState;
      const events = ctx.logs.read(eventsPath(ctx.config.stateDir, run.sessionId ?? "missing"));
      if (messageArrived(events, String(pending.payload.message), ms(pending.issuedAt) - 5000)) {
        applySent(run, pending, now);
        state.pending = null;
        return "cleared";
      }
      return "emit";
    }
  }
}

// An issued create_session that was never recorded is uncertain: the driver may have called it.
// Adopt a session found in the logs or data.db; otherwise wait out the reconcile window, then issue
// it again (once) only if the run may still start.
function reconcileCreate(ctx: Ctx, state: BatchState, pending: PendingAction, target: RunState | SelfTestState, now: number): Revalidated {
  const selfTest = pending.target === "selftest";
  let found = selfTest ? resolveSelfTestSession(ctx, target as SelfTestState) : resolveRunSession(ctx, target as RunState);
  let appId = found ? ctx.deps.appDb.workspaceForSession(found) : null;
  // Every attempt counts: look for a session created since the first issue, not the latest.
  const firstIssuedAt = pending.firstIssuedAt ?? pending.issuedAt;
  if (!found) {
    const fromDb = createdSinceInDb(ctx, target.projectId, firstIssuedAt);
    if (fromDb) {
      appId = fromDb.appId;
      found = fromDb.sessionId ?? null;
    }
  }
  if (found || appId) {
    if (found) target.sessionId = found;
    log(ctx, `adopted session ${found ?? appId} created by an unrecorded create_session`);
    state.pending = null;
    target.status = "running";
    if (appId) {
      target.appSessionId = appId;
      return "cleared";
    }
    issue(ctx, state, "lookup_session", pending.target, { sessionId: found });
    return "emit";
  }
  if (since(now, ms(pending.issuedAt)) < CREATE_RECONCILE_MS) return "hold";
  if ((pending.reissues ?? 0) >= MAX_CREATE_REISSUES) {
    state.pending = null;
    const why = "create_session was issued twice and no session appeared";
    if (selfTest) Object.assign(target, { status: "failed", failure: why });
    else {
      voidRun(ctx, state, target as RunState, why, true);
      (target as RunState).unconfirmedSince = firstIssuedAt;
    }
    return "cleared";
  }
  if (!selfTest) {
    const block = firstStop(state.halt, admissionBlock(ctx, state));
    if (block) {
      state.pending = null;
      voidRun(ctx, state, target as RunState, `not started: ${block.reason}`, false);
      stopBatch(ctx, state, block.reason, block.failure);
      return "cleared";
    }
  }
  pending.reissues = (pending.reissues ?? 0) + 1;
  pending.firstIssuedAt = firstIssuedAt;
  pending.issuedAt = iso(now);
  target.lastStartAt = iso(now);
  log(ctx, `reissuing ${pending.id} create_session: no session after ${Math.round(CREATE_RECONCILE_MS / 60_000)} min`);
  return "emit";
}

function applySent(run: RunState, pending: PendingAction, now: number): void {
  if (pending.payload.stop) {
    run.stopSentAt = iso(now);
    return;
  }
  if (run.plain) {
    run.plain.sentAt = iso(now);
    run.plain.issuedAt ??= pending.issuedAt;
    run.answers.push({ kind: "plain", ref: run.plain.messageId, row: run.plain.row, text: run.plain.text, at: iso(now) });
  }
}

// ---------- ownership ----------

function checkOwner(ctx: Ctx, state: BatchState): void {
  const me = ctx.deps.driverId;
  const now = iso(ctx.deps.now());
  const owner = state.owner;
  if (!owner) {
    state.owner = { id: me, since: now, lastSeenAt: now };
    return;
  }
  if (owner.id === me) {
    owner.lastSeenAt = now;
    return;
  }
  const alive = ctx.deps.driverAlive(owner.id);
  const silent = since(ctx.deps.now(), ms(owner.lastSeenAt));
  const gone = alive === false || (alive === null && silent > OWNER_SILENT_MS);
  if (!gone) {
    throw new OwnershipError(
      `Batch ${ctx.config.id} is driven by ${owner.id}, which is still active (last seen ${owner.lastSeenAt}). Only one driver may run a batch. If that driver is really gone, archive its session, or ask the user to run: npm run batch -- take-over --batch ${ctx.config.id}`,
    );
  }
  warn(state, `the driver changed from ${owner.id} to ${me} at ${now}: the first was gone`);
  log(ctx, `driver ${me} took over from ${owner.id} (${alive === false ? "its session's process is gone" : `silent for ${Math.round(silent / 60_000)} min`})`);
  state.owner = { id: me, since: now, lastSeenAt: now };
}

// ---------- public API ----------

const IN_FLIGHT = new Set(["project", "starting", "running", "ending", "scoring", "scored", "settling", "stopping", "draining"]);

export async function step(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const now = ctx.deps.now();
  const active = state.active.map((index) => state.runs[index]);
  if (state.lastHeartbeatAt) {
    const last = ms(state.lastHeartbeatAt);
    if (now < last - CLOCK_JUMP_MS) {
      const detail = `the clock went back ${Math.round((last - now) / 1000)} s (from ${state.lastHeartbeatAt} to ${iso(now)})`;
      for (const run of active) addFlag(run, "clock-jump", detail, iso(now));
      warn(state, detail);
    } else if (now - last > DRIVER_GAP_MS) {
      for (const run of active.filter((r) => IN_FLIGHT.has(r.status))) {
        addFlag(run, "driver-gap", `the driver was away for ${Math.round((now - last) / 60_000)} min (from ${state.lastHeartbeatAt})`, iso(now));
      }
    }
  }
  state.lastHeartbeatAt = iso(now);
  if (state.phase === "selftest" || state.phase === "runs") {
    await claimActive(ctx.config.activeGuard, ctx.config.id, ctx.config.dir, iso(now));
    if (!state.caffeinate) ensureAwake(ctx, state);
    if (!state.notified.includes("batch-started")) {
      const { config } = ctx;
      const plan = config.selfTest.only
        ? "self-test only"
        : `${config.selfTest.enabled ? "self-test, then " : ""}${describePlan(config.variants, config.runsPerVariant, calibrationDecision(readResults(config.resultsPath), config.variants, config.variantSet), config.parallel)}`;
      await notify(ctx, state, notices.batchStarted(config.id, plan));
    }
  }
  let result: StepResult;
  const revalidated = state.pending ? revalidate(ctx, state) : "cleared";
  if (revalidated === "emit") result = { action: render(ctx, state, state.pending!, true) };
  else if (revalidated === "hold") result = {};
  else {
    switch (state.phase) {
      case "selftest":
        result = await selfTestStep(ctx, state);
        break;
      case "runs":
        result = await runsStep(ctx, state);
        break;
      case "finishing":
        result = { action: await finish(ctx, state) };
        break;
      case "done":
      case "stopped":
        result = { action: doneAction(ctx, state) };
        break;
    }
  }
  // Failed app-database queries are flagged, so a schema change can't hide a signal silently. A
  // failure while a run was stepped is flagged on that run (runsStep); any other goes on every
  // active run.
  for (const error of ctx.deps.appDb.takeErrors()) {
    for (const index of state.active) addFlag(state.runs[index], "app-db", error, iso(now));
    warn(state, `app database: ${error}`);
  }
  // Time spent in this step (a score can take many minutes) is not time the driver was away.
  state.lastHeartbeatAt = iso(ctx.deps.now());
  return result;
}

export async function next(ctx: Ctx, opts: { maxWaitMs: number }): Promise<ActionOut> {
  const until = ctx.deps.now() + opts.maxWaitMs;
  for (;;) {
    // The lock is held for one step at a time and released while waiting, so record and stop
    // can take it between polls.
    const result = await ctx.deps.lock(ctx.config.dir, async () => {
      const state = loadState(ctx.config.dir);
      try {
        checkOwner(ctx, state);
        return await step(ctx, state);
      } finally {
        saveState(ctx.config.dir, state);
      }
    });
    if (result.action) return result.action;
    if (result.progressed) continue;
    const left = until - ctx.deps.now();
    if (left <= 0) return { batch: ctx.config.id, action: "wait", what: "Nothing to do yet. Run next again straight away." };
    await ctx.deps.sleep(Math.min(left, ctx.config.pollSec * 1000));
  }
}

export interface RecordInput {
  action: string;
  projectId?: string;
  sessionId?: string;
  row?: number;
  answered?: boolean;
  requestId?: string;
  choice?: string;
  notPending?: boolean;
  final?: string;
  question?: string;
  neither?: boolean;
  sent?: boolean;
  failed?: string;
}

function applyRecord(ctx: Ctx, state: BatchState, input: RecordInput): string {
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
        const appSessionId = workspaceIdFor(ctx, input.sessionId);
        if (test) Object.assign(test, { appSessionId, status: "running" });
        else Object.assign(run!, { appSessionId, status: "running" });
        message = `session ${input.sessionId} recorded`;
      }
      break;
    case "answer_question": {
      const toolCallId = String(p.toolCallId);
      if (input.failed && /mismatch/i.test(input.failed) && run) addFlag(run, "answer-mismatch", `ask_user ${toolCallId}: ${input.failed}`, at);
      if (input.requestId && typeof p.requestId === "string" && input.requestId !== p.requestId) {
        if (run) addFlag(run, "answer-mismatch", `ask_user ${toolCallId}: answered request ${input.requestId}, expected ${String(p.requestId)}`, at);
      }
      if (p.stop) {
        if (input.failed) run!.stopAttempts = (run!.stopAttempts ?? 0) + 1;
        else run!.stopSentAt = at;
        message = input.failed ? "stop answer failed" : "stop answer recorded";
        break;
      }
      // The request_id the driver saw guards every retry of this question, even after a failed
      // attempt; a mismatch's id belongs to another question, so it is never kept.
      const keepId = input.requestId && !input.notPending && !/mismatch/i.test(input.failed ?? "") ? input.requestId : undefined;
      if (test) {
        test.askAttempts++;
        if (keepId) (test.requestIds ??= {})[toolCallId] ??= keepId;
        if (!input.failed && !input.notPending) test.answered = { toolCallId, at, text: String(p.answer ?? ""), requestId: input.requestId };
        message = input.failed ? "answer failed" : "answer recorded";
        break;
      }
      if (keepId) run!.requestIds[toolCallId] ??= keepId;
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
        applySent(run!, pending, now);
        message = "sent";
      }
      break;
  }
  state.recorded = [...state.recorded.slice(-200), pending.id];
  state.pending = null;
  log(ctx, `record ${pending.id} ${pending.kind}: ${message}`);
  return message;
}

export async function record(ctx: Ctx, input: RecordInput): Promise<string> {
  return ctx.deps.lock(ctx.config.dir, () => {
    const state = loadState(ctx.config.dir);
    checkOwner(ctx, state);
    const message = applyRecord(ctx, state, input);
    saveState(ctx.config.dir, state);
    return message;
  });
}

export async function requestStop(ctx: Ctx): Promise<string> {
  return ctx.deps.lock(ctx.config.dir, () => {
    const state = loadState(ctx.config.dir);
    state.stopRequested = true;
    saveState(ctx.config.dir, state);
    return "The batch stops after the runs in progress finish; no new run starts.";
  });
}

// For the user only, when the owning driver is gone but the runner can't tell.
export async function takeOver(ctx: Ctx): Promise<string> {
  return ctx.deps.lock(ctx.config.dir, () => {
    const state = loadState(ctx.config.dir);
    const old = state.owner?.id ?? "none";
    state.owner = null;
    warn(state, `the user released the batch from driver ${old} at ${iso(ctx.deps.now())}`);
    saveState(ctx.config.dir, state);
    return `Released batch ${ctx.config.id} from driver ${old}; the next driver to run next owns it.`;
  });
}

export function statusText(ctx: Ctx): string {
  const state = loadState(ctx.config.dir);
  const rows = readResults(ctx.config.resultsPath);
  const lines = [`Batch ${ctx.config.id}: phase ${state.phase}${state.stopReason ? ` (${state.stopReason})` : ""}`];
  if (state.owner) lines.push(`Driver: ${state.owner.id}, last seen ${state.owner.lastSeenAt}`);
  if (state.fatal) lines.push(`No new run starts: ${state.fatal}`);
  if (state.pending) lines.push(`Pending action: ${state.pending.id} ${state.pending.kind} (issued ${state.pending.issuedAt})`);
  if (state.active.length) lines.push(`Active runs: ${state.active.map((index) => state.runs[index].key).join(", ")}`);
  if (state.halt) lines.push(`No new run starts once the runs in progress end: ${state.halt.reason}`);
  for (const test of state.selftests) lines.push(`Self-test: ${test.status}${test.failure ? ` (${test.failure})` : ""}`);
  for (const run of state.runs) {
    const row = runRowFor(rows, run);
    lines.push(`${run.key} ${featureSetName(run.features)}: ${run.status}${row ? `, ${row.outcome} ${row.minutes} min` : ""}${run.flags.length ? `, flags ${[...new Set(run.flags.map((flag) => flag.code))].join(", ")}` : ""}`);
  }
  if (state.calibration) lines.push(`Calibration: ${state.calibration}`);
  return lines.join("\n");
}
