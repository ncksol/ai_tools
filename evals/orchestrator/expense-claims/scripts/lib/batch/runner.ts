// The overnight runner's state machine. `next` does every deterministic step itself (new-run,
// watching, score, commits, notifications) and stops only at a step the driver agent must take with
// an app tool or a judgment. `record` takes the result of that step. All state is in the batch
// folder, so any step can be resumed after a crash, a restart or a context compaction.
//
// Exclusive access: every read-modify-write of a batch's state (next, record, stop) holds the batch
// lock; only the batch's owning driver may run next and record; and only one batch is active on the
// machine (the active-batch guard). See lock.ts.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describeSession, type LogEvent } from "../events.ts";
import { ALL_FEATURES, featureSetName, stripFeatures } from "../features.ts";
import { runName } from "../new-run.ts";
import type { ProcResult } from "../proc.ts";
import { readResults } from "../results.ts";
import { liveAgent, variantAgents, variantBundle, variantFiles, verifyVariants } from "../variants.ts";
import { readAnswerSheet, replyFor, rowForQuestion, settleRow, type AnswerRow } from "./answers.ts";
import type { AppDb } from "./appdb.ts";
import { archiveRun, type SessionInventory } from "./archive.ts";
import { openCleanupApp } from "./cleanup-io.ts";
import { scanSession, scanSwarm } from "./hygiene.ts";
import { claimActive, releaseActive } from "./lock.ts";
import { notices, type Notice } from "./notify.ts";
import { computePins, diffPins } from "./pins.ts";
import { calibrationDecision, describePlan, nextRunNumber, planRound, provisionPlan, runRowFor, scoredCount } from "./plan.ts";
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
  PERMISSION_GRACE_MS,
  PERMISSION_VOID,
  permissionBlocks,
  permissionRequests,
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
const TRUST_WAIT_MS = 30 * 60_000;
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
  exec(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<ProcResult>;
  notify(notice: Notice): Promise<{ ok: boolean; error?: string }>;
  appDb: AppDb;
  archiveInventory?: (run: RunState) => SessionInventory;
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
  excludedSessions: Set<string>;
}

export function makeCtx(config: BatchConfig, deps: Deps): Ctx {
  return { config, deps, logs: new LogCache(), index: new SessionIndex(config.stateDir), sheet: readAnswerSheet(join(config.kitDir, "answers.md")), excludedSessions: new Set() };
}

export interface ActionOut {
  batch: string;
  action: PendingAction["kind"] | "wait" | "done";
  id?: string;
  // "self-test" or "run": the self-test has its own completion rule.
  target?: "self-test" | "run" | "batch" | "provision";
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
  log(ctx, `issue ${pending.id} ${kind} for ${target}`);
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
  const run = typeof pending.target === "number" ? state.runs[pending.target] : null;
  const base = {
    batch: ctx.config.id,
    action: pending.kind,
    id: pending.id,
    target: pending.target === "selftest" ? ("self-test" as const) : typeof pending.target === "number" ? ("run" as const) :
      pending.target === "batch" ? ("batch" as const) : ("provision" as const),
    run: run?.key,
    reissued: reissued || undefined,
    dryRun: ctx.config.dryRun || undefined,
  };
  switch (pending.kind) {
    case "create_trust_session":
      return {
        ...base,
        what: "Create this idle child session with exactly these arguments: no kickoff, no agent, no prompt. It exists only so the user can open its view and trust the repository. Never start work or grant trust in it.",
        tool: { name: "create_session", args: p.args as Record<string, unknown> },
        record: [recordCommand(ctx, pending.id, "--session-id <id from the result>"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "archive_trust_session":
      return {
        ...base,
        what: "Archive this idle trust session owned by the driver. The runner has read the user's local trust record. Never archive a run's session or start work here.",
        tool: { name: "archive_session", args: p.args as Record<string, unknown> },
        record: [recordCommand(ctx, pending.id, "--archived"), recordCommand(ctx, pending.id, '--failed "<error>"')],
      };
    case "trust_projects":
      return {
        ...base,
        what: "Show the user every project name and path in details.projects and the deadline. Only the user can trust these repositories in the app. Never grant trust, approve prompts, automate the UI or write app state. Record --listed after displaying the list, then keep calling next; that acknowledges display, NOT trust.",
        details: p,
        record: [recordCommand(ctx, pending.id, "--listed")],
      };
    case "add_repository":
      return {
        ...base,
        what: "Call add_repository with exactly these arguments to register the existing clone. Starting the batch authorised this registration; do not ask for confirmation.",
        tool: { name: "add_repository", args: p.args as Record<string, unknown> },
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
  return id && !ctx.excludedSessions.has(id) && existsSync(eventsPath(ctx.config.stateDir, id)) ? id : null;
}

function resolveSession(ctx: Ctx, appSessionId: string | undefined, candidates: () => SessionMeta[], match: (events: LogEvent[]) => boolean): string | null {
  const fromDb = appSessionId ? ctx.deps.appDb.sessionForWorkspace(appSessionId) : null;
  if (knownSessionDir(ctx, fromDb)) return fromDb;
  const direct = knownSessionDir(ctx, appSessionId);
  if (direct) return direct;
  for (const meta of candidates()) {
    if (ctx.excludedSessions.has(meta.id)) continue;
    const events = ctx.logs.read(eventsPath(ctx.config.stateDir, meta.id));
    if (events.length > 0 && match(events)) return meta.id;
  }
  return null;
}

function runSessionIds(ctx: Ctx, run: RunState): string[] {
  const since = ms(run.startRequestedAt) - minutes(2);
  const ids = new Set(ctx.index.forRepository(run.repo, since).map((meta) => meta.id));
  if (run.sessionId) ids.add(run.sessionId);
  return [...ids].filter((id) => !ctx.excludedSessions.has(id));
}

const readLogs = (ctx: Ctx, ids: string[]) => ids.filter((id) => !ctx.excludedSessions.has(id))
  .map((id) => ({ id, events: ctx.logs.read(eventsPath(ctx.config.stateDir, id)) }));

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
    .filter((row) => !ctx.excludedSessions.has(row.id) && !ctx.excludedSessions.has(row.sessionId ?? ""))
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
    const outcome = runRowFor(rows, run)?.outcome ?? (run.status === "void" ? "void" : "not scored");
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

function actionTarget(state: BatchState, target: PendingAction["target"]): RunState | SelfTestState | undefined {
  if (target === "selftest") return state.selftests.at(-1);
  if (typeof target === "number") return state.runs[target];
  if (target.startsWith("provision:")) return state.provisioned?.[Number(target.slice("provision:".length))];
  return undefined;
}

function reservedRun(ctx: Ctx, state: BatchState, variant: string): RunState {
  const { config } = ctx;
  const n = nextRunNumber(variant, readResults(config.resultsPath), config.runsDir, [...state.runs, ...(state.provisioned ?? [])]);
  const name = runName(variant, n);
  return {
    key: `${variant}#${n}`, variant, n, features: ALL_FEATURES, calibration: false, name,
    repoDir: join(config.runsDir, name), repo: config.dryRun ? name : `${config.owner}/${name}`,
    status: "new", createdAt: iso(ctx.deps.now()), judged: [], answers: [], askAttempts: {}, requestIds: {}, flags: [],
  };
}

function projectAtPath(ctx: Ctx, repoDir: string): string | null | undefined {
  const paths = [...new Set([repoDir, realpathSync(repoDir)])];
  const found = paths.map((path) => ctx.deps.appDb.projectForPath(path));
  const ids = [...new Set(found.filter((id): id is string => typeof id === "string"))];
  return found.includes(undefined) || ids.length > 1 ? undefined : ids[0] ?? null;
}

function registerProject(ctx: Ctx, state: BatchState, target: PendingAction["target"], project: RunState | SelfTestState): StepResult {
  const id = projectAtPath(ctx, project.repoDir);
  if (id === undefined) {
    stopBatch(ctx, state, `cannot uniquely look up project at ${project.repoDir}; refusing to create a duplicate`, true);
    return { progressed: true };
  }
  if (id) {
    project.projectId = id;
    project.status = "project";
    return { progressed: true };
  }
  return { action: issue(ctx, state, "add_repository", target, { args: { path: project.repoDir } }) };
}

async function provisionStep(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const { config } = ctx;
  const block = admissionBlock(ctx, state);
  if (block) {
    stopBatch(ctx, state, block.reason, block.failure);
    return { progressed: true };
  }
  state.provisionPlan ??= config.selfTest.only ? [] : provisionPlan(
    readResults(config.resultsPath), config.variants, config.runsPerVariant, config.parallel ?? 1, config.variantSet,
  );
  state.provisioned ??= [];
  if (config.selfTest.enabled && state.selftests.at(-1)?.status !== "project") return selfTestStep(ctx, state);
  const unfinished = state.provisioned.findIndex((run) => run.status !== "project");
  if (unfinished >= 0) {
    const run = state.provisioned[unfinished];
    if (run.status === "new") return newRepo(ctx, state, run);
    if (run.status === "repo") {
      if (!run.seedSha) {
        const head = await ctx.deps.exec("git", ["rev-parse", "HEAD"], { cwd: run.repoDir, timeoutMs: TIMEOUTS.git });
        if (head.code !== 0) {
          stopBatch(ctx, state, `cannot read provisioned seed for ${run.key}: ${head.stderr.trim()}`, true);
          return { progressed: true };
        }
        run.seedSha = head.stdout.trim();
      }
      return registerProject(ctx, state, `provision:${unfinished}`, run);
    }
    stopBatch(ctx, state, `provisioning ${run.key} failed: ${run.voidReason ?? run.status}`, true);
    return { progressed: true };
  }
  if (state.provisioned.length < state.provisionPlan.length) {
    state.provisioned.push(reservedRun(ctx, state, state.provisionPlan[state.provisioned.length]));
  } else {
    state.trustWait = {};
    state.phase = "trust";
  }
  return { progressed: true };
}

function trustProjects(state: BatchState): { id: string; name: string; path: string }[] {
  return [...state.selftests, ...(state.provisioned ?? [])].filter((p) => p.projectId)
    .map((p) => ({ id: p.projectId!, name: basename(p.repoDir), path: p.repoDir }));
}

function trustBlock(ctx: Ctx, projectId: string | undefined): string | null {
  const trusted = projectId ? ctx.deps.appDb.projectTrusted(projectId) : null;
  if (trusted === true) return null;
  return trusted === false ? `project ${projectId} is not trusted on local; only the user can trust it in the app`
    : `cannot read local project trust for ${projectId ?? "missing project id"}`;
}

async function trustStep(ctx: Ctx, state: BatchState): Promise<StepResult> {
  const block = admissionBlock(ctx, state);
  if (block) {
    stopBatch(ctx, state, block.reason, block.failure);
    return { progressed: true };
  }
  const wait = state.trustWait!;
  const missing = [];
  for (const project of trustProjects(state)) {
    const trusted = ctx.deps.appDb.projectTrusted(project.id);
    if (trusted === null) {
      stopBatch(ctx, state, `cannot read local project trust for ${project.name}; no self-test or eval session starts`, true);
      return { progressed: true };
    }
    if (!trusted) missing.push(project);
  }
  if (missing.length === 0) {
    const toArchive = state.trustSessions?.findIndex((session) => !session.archived) ?? -1;
    if (toArchive >= 0) {
      return { action: issue(ctx, state, "archive_trust_session", "batch", {
        index: toArchive, args: { id: state.trustSessions![toArchive].appSessionId },
      }) };
    }
    wait.completedAt = iso(ctx.deps.now());
    state.phase = ctx.config.selfTest.enabled ? "selftest" : "runs";
    return { progressed: true };
  }
  if (ctx.deps.now() >= ms(wait.deadlineAt)) {
    stopBatch(ctx, state, `project trust was not complete within 30 minutes; no self-test or eval session started (${missing.map((p) => p.name).join(", ")})`, true);
    return { progressed: true };
  }
  state.trustSessions ??= [];
  for (const project of missing) {
    let index = state.trustSessions.findIndex((session) => session.projectId === project.id);
    if (index < 0) {
      index = state.trustSessions.length;
      state.trustSessions.push({ projectId: project.id, name: `Trust ${project.name}` });
    }
    const session = state.trustSessions[index];
    if (!session.appSessionId) return { action: issue(ctx, state, "create_trust_session", "batch", {
      index, args: { project_id: project.id, name: session.name, workspace_type: "branch", coordinate_with_creator: true },
    }) };
  }
  if (!wait.listed) {
    const projects = missing.map((project) => ({
      ...project,
      sessionName: state.trustSessions!.find((session) => session.projectId === project.id)!.name,
      sessionId: state.trustSessions!.find((session) => session.projectId === project.id)!.appSessionId!,
    }));
    const linked = projects.map((project) => ({ ...project, sessionUrl: `ghapp://sessions/${project.sessionId}` }));
    wait.startedAt ??= iso(ctx.deps.now());
    wait.deadlineAt ??= iso(ms(wait.startedAt) + TRUST_WAIT_MS);
    const action = issue(ctx, state, "trust_projects", "batch", { projects: linked, deadline: wait.deadlineAt, timeoutMinutes: 30 });
    await notify(ctx, state, {
      key: "project-trust", title: "Eval projects need trust", priority: "high", tags: ["warning"],
      body: `Batch ${ctx.config.id}: trust these repositories in the app by ${wait.deadlineAt}. Only you can do this; no self-test or eval session starts until every project is trusted.\n` +
        linked.map((p) => `${p.sessionName}: ${p.sessionUrl}\n${p.path}`).join("\n"),
    });
    return { action };
  }
  return {};
}

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
      repoDir: join(config.runsDir, "eval-runner-selftest"),
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
      const gitInTest = (args: string[]) => deps.exec("git", args, { cwd: test.repoDir, timeoutMs: TIMEOUTS.git });
      if (!existsSync(test.repoDir)) {
        mkdirSync(test.repoDir, { recursive: true });
        writeFileSync(join(test.repoDir, "README.md"), "# Eval runner self-test\n\nPermanent local-only project for shell and question checks. Trust it once in the Copilot app. No GitHub remote.\n");
        const ident = ["-c", "user.name=Eval Runner", "-c", "user.email=eval-runner@example.invalid"];
        for (const args of [["init", "-q", "-b", "main"], ["add", "README.md"], [...ident, "commit", "-q", "-m", "Initialize permanent eval self-test project"]]) {
          const result = await gitInTest(args);
          if (result.code !== 0) {
            fail(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
            return { progressed: true };
          }
        }
      }
      for (const [args, expected] of [
        [["rev-parse", "--show-toplevel"], realpathSync(test.repoDir)],
        [["remote"], ""],
        [["status", "--porcelain"], ""],
      ] as [string[], string][]) {
        const result = await gitInTest(args);
        if (result.code !== 0 || result.stdout.trim() !== expected) {
          fail(`permanent self-test repo must be a clean local-only git root: git ${args.join(" ")}: ${result.stderr.trim() || result.stdout.trim()}`);
          return { progressed: true };
        }
      }
      {
        const result = await gitInTest(["rev-parse", "--verify", "HEAD"]);
        if (result.code !== 0) {
          fail(`permanent self-test repo has no commit: ${result.stderr.trim()}`);
          return { progressed: true };
        }
      }
      test.status = "repo";
      return { progressed: true };
    }
    case "repo":
      return registerProject(ctx, state, "selftest", test);
    case "project": {
      const admission = admissionBlock(ctx, state);
      const blocked = admission?.reason ?? trustBlock(ctx, test.projectId);
      if (blocked) { fail(blocked); return { progressed: true }; }
      test.startRequestedAt = iso(now);
      test.status = "starting";
      return { action: issue(ctx, state, "create_session", "selftest", { args: selfTestCreateArgs(ctx, test) }) };
    }
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
  check("project is trusted on local", Boolean(test.projectId && deps.appDb.projectTrusted(test.projectId) === true), `project ${test.projectId ?? "missing"}`);
  check("session runs as the batch owner", account?.toLowerCase() === config.owner.toLowerCase(), `project account ${account ?? "unreadable"}, owner ${config.owner}`);
  // The workspace row may have been written after the session was recorded.
  if (test.appSessionId) test.appSessionId = workspaceIdFor(ctx, test.appSessionId);
  const links = test.appSessionId ? deps.appDb.creatorLinks(test.appSessionId) : null;
  check("session is detached (no creator link)", Boolean(links) && !links!.creator && !links!.coordinator, links ? `creator ${links.creator ?? "none"}, coordinator ${links.coordinator ?? "none"}` : "workspace row unreadable");
  // Every app-database lookup the runner relies on, on this real session and project.
  const problems = deps.appDb.probe();
  if (projectAtPath(ctx, test.repoDir) !== test.projectId) problems.push("project path lookup differs from the self-test project id");
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
  const { config } = ctx;
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
  const reservations = round.map((next) => state.provisioned?.find((slot) =>
    slot.variant === next.variant && slot.status === "project" && !state.runs.some((run) => run.repo === slot.repo)));
  const missing = reservations.findIndex((slot) => !slot);
  if (missing >= 0) {
    stopBatch(ctx, state, `out of trusted projects for ${round[missing].variant}; no project is created during runs`, true);
    return { progressed: true };
  }
  for (const [index, next] of round.entries()) {
    const run: RunState = { ...reservations[index]!, features: next.features, calibration: next.calibration };
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
    variants: config.variantSet ? variantAgents(config.variantSet) : config.variants.map(liveAgent),
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

// Whether a run is scored is decided by its row in results.csv, never by runner state: score
// writes the row before its diagnostics, and the runner records the result only after score returns,
// so a runner that stops in between resumes with its state behind the row.
const rowOf = (ctx: Ctx, run: RunState) => runRowFor(readResults(ctx.config.resultsPath), run);

// The run's end on the log's clock: its final report, or for a timeout or stall the moment the
// runner ended it. That moment is saved once (a state from before it was saved gets it now), so
// later requests never count as before the end, and a scoring hold ends by the end plus the grace.
function runCutoff(run: RunState, now: number): number {
  if (run.endReason === "final" && run.final) return Date.parse(run.final.timestamp);
  run.endAt ??= run.scoredAt ?? iso(now);
  return ms(run.endAt);
}

// The permission check once watching has ended. Whether a prompt came before or after the run's end
// is decided by the request's own timestamp against the cutoff, never by the runner's phase, so a
// child's prompt just before the final report, or one written while the runner was down, still
// voids an unscored run. A run already scored keeps its result. "hold": a request from before the
// end is still within its grace period, so score waits for it.
async function permissionsAfterWatching(ctx: Ctx, state: BatchState, run: RunState, now: number): Promise<"void" | "hold" | "ok"> {
  const logs = readLogs(ctx, runSessionIds(ctx, run));
  const cutoff = runCutoff(run, now);
  const blocks = logs.flatMap((log) => permissionBlocks(log.id, log.events, now));
  const unscored = (run.status === "ending" || run.status === "scoring") && !rowOf(ctx, run);
  const before = blocks.filter((block) => block.request.at <= cutoff);
  if (unscored && before.length > 0) {
    await permissionBlocked(ctx, state, run, before, true);
    return "void";
  }
  const late = unscored ? blocks.filter((block) => block.request.at > cutoff) : blocks;
  if (late.length > 0) await permissionBlocked(ctx, state, run, late, false);
  const waiting = run.status === "scoring" && logs.some((log) => permissionRequests(log.id, log.events).some((request) =>
    !request.decision && request.what !== "ask_user" && request.at <= cutoff && now - request.at < PERMISSION_GRACE_MS));
  return waiting ? "hold" : "ok";
}

// A tool-permission prompt in a run's swarm: nobody can answer it, and every later run would hit
// the same, so no further run starts. A prompt from before the run's end voids an unscored run;
// one from after its end, or found once the run is scored, leaves the result standing.
async function permissionBlocked(ctx: Ctx, state: BatchState, run: RunState, blocks: PermissionBlock[], voidIt: boolean): Promise<void> {
  const at = iso(ctx.deps.now());
  // A run with a row in results.csv is scored, whatever its status says: it is never voided.
  if (voidIt && rowOf(ctx, run)) voidIt = false;
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
  return run.prompt ?? readFileSync(join(config.runsDir, `${run.name}.kickoff.md`), "utf8").trimEnd();
}

// Before the first session, replace only the fresh seed's spec and root commit to match new-run
// for these features. The exact original SHA guards the run-repo push; never rewrite a run's work.
async function prepareRun(ctx: Ctx, run: RunState): Promise<string | null> {
  if (run.prepared) return null;
  const { config, deps } = ctx;
  const gitInRun = (args: string[]) => deps.exec("git", args, { cwd: run.repoDir, timeoutMs: TIMEOUTS.git });
  const full = readFileSync(join(config.kitDir, "seed/docs/spec-v2.md"), "utf8");
  const expected = run.features.length === ALL_FEATURES.length ? full : stripFeatures(full, run.features);
  const path = join(run.repoDir, "docs/spec-v2.md");
  const current = readFileSync(path, "utf8");
  const history = await gitInRun(["log", "--format=%s"]);
  const branch = await gitInRun(["branch", "--show-current"]);
  if (!run.seedSha || history.code !== 0 || history.stdout.trim() !== "Seed v1" ||
      branch.code !== 0 || branch.stdout.trim() !== "main") return "provisioned repo no longer has its single Seed v1 commit on main";
  const diff = await gitInRun(["diff", "--name-only", run.seedSha, "HEAD"]);
  if (diff.code !== 0 || (diff.stdout.trim() !== "" && diff.stdout.trim() !== "docs/spec-v2.md")) {
    return "provisioned repo has changes beyond the selected feature spec";
  }
  const status = await gitInRun(["status", "--porcelain"]);
  if (status.code !== 0) return `cannot inspect provisioned repo: ${status.stderr.trim()}`;
  const changed = status.stdout.trimEnd();
  if ((changed !== "" && (changed !== " M docs/spec-v2.md" || current !== expected)) ||
      (current !== full && current !== expected)) return "provisioned repo changed outside the runner; refusing to overwrite it";
  const head = await gitInRun(["show", "HEAD:docs/spec-v2.md"]);
  if (head.code !== 0 || (head.stdout !== full && head.stdout !== expected)) return "provisioned spec differs from the seed";
  if (current !== expected) writeFileSync(path, expected);
  if (head.stdout !== expected) {
    const commit = await gitInRun(["commit", "--amend", "--only", "-m", "Seed v1", "--", "docs/spec-v2.md"]);
    if (commit.code !== 0) return `setting run features failed: ${commit.stderr.trim()}`;
  }
  if (!config.dryRun && expected !== full) {
    const headSha = await gitInRun(["rev-parse", "HEAD"]);
    const remote = await gitInRun(["ls-remote", "--heads", "origin", "main"]);
    if (headSha.code !== 0 || remote.code !== 0) return `cannot verify run seed before push: ${headSha.stderr || remote.stderr}`;
    const remoteSha = remote.stdout.trim().split(/\s+/)[0];
    if (remoteSha !== headSha.stdout.trim()) {
      if (remoteSha !== run.seedSha) return "run repo main changed since provisioning; refusing to overwrite it";
      const push = await gitInRun(["push", `--force-with-lease=refs/heads/main:${run.seedSha}`, "origin", "HEAD:refs/heads/main"]);
      if (push.code !== 0) return `pushing run features failed: ${push.stderr.trim()}`;
    }
  }
  const prepared = await gitInRun(["rev-parse", "HEAD"]);
  if (prepared.code !== 0) return `cannot record prepared seed: ${prepared.stderr.trim()}`;
  run.preparedSha = prepared.stdout.trim();
  run.prompt = readFileSync(join(config.kitDir, "kickoff.md"), "utf8").trimEnd();
  run.prepared = true;
  return null;
}

async function pruneSeedHistory(ctx: Ctx, run: RunState): Promise<string | null> {
  if (run.features.length === ALL_FEATURES.length) return null;
  if (!existsSync(run.repoDir)) return "run clone is missing; refusing seed cleanup";
  const root = realpathSync(run.repoDir);
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir) || !lstatSync(gitDir).isDirectory()) return "run clone has no private .git directory; refusing seed cleanup";
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE"]) delete env[key];
  const gitInRun = (args: string[]) => ctx.deps.exec("git", ["--git-dir", gitDir, "--work-tree", root, ...args], {
    cwd: root, env, timeoutMs: TIMEOUTS.git,
  });
  const top = await gitInRun(["rev-parse", "--show-toplevel"]);
  const common = await gitInRun(["rev-parse", "--git-common-dir"]);
  if (top.code !== 0 || top.stdout.trim() !== root || common.code !== 0 || common.stdout.trim() !== gitDir) {
    return "seed cleanup repository differs from the run clone";
  }
  const head = await gitInRun(["rev-parse", "HEAD"]);
  if (!run.preparedSha || head.code !== 0 || head.stdout.trim() !== run.preparedSha) return "seed HEAD differs from the saved prepared commit; refusing cleanup";
  const worktrees = await gitInRun(["worktree", "list", "--porcelain"]);
  if (worktrees.code !== 0 || worktrees.stdout.split("\n").filter((line) => line.startsWith("worktree ")).length !== 1) {
    return "cannot prune the unused seed while linked worktrees exist or cannot be checked";
  }
  const status = await gitInRun(["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim() !== "") return "the prepared seed must be clean before history cleanup";
  if (!ctx.config.dryRun) {
    const remote = await gitInRun(["ls-remote", "--heads", "origin", "main"]);
    if (remote.code !== 0) return `cannot verify prepared seed before cleanup: ${remote.stderr}`;
    const preparedSha = run.preparedSha;
    if (remote.stdout.trim().split(/\s+/)[0] !== preparedSha) return "remote main no longer matches the prepared seed; refusing cleanup";
    const ref = "refs/remotes/origin/main";
    const tracking = await gitInRun(["rev-parse", "--verify", ref]);
    if (tracking.code !== 0) return `cannot read seed tracking ref: ${tracking.stderr.trim()}`;
    const previousSha = tracking.stdout.trim();
    if (previousSha !== preparedSha) {
      if (previousSha !== run.seedSha) return "local origin/main differs from both the provisioned and prepared seed; refusing cleanup";
      const updated = await gitInRun(["update-ref", ref, preparedSha, previousSha]);
      if (updated.code !== 0) return `reconciling seed tracking ref failed: ${updated.stderr.trim()}`;
    }
  }
  for (const args of [["reflog", "expire", "--expire=now", "--all"], ["gc", "--prune=now"]]) {
    const result = await gitInRun(args);
    if (result.code !== 0) return `removing obsolete seed history failed: git ${args.join(" ")}: ${result.stderr.trim()}`;
  }
  const history = await gitInRun(["rev-list", "--all", "--reflog", "--count"]);
  if (history.code !== 0 || history.stdout.trim() !== "1") return "unused seed still has history beyond its single prepared commit";
  return null;
}

function runCreateArgs(ctx: Ctx, run: RunState): Record<string, unknown> {
  const { config } = ctx;
  return {
    project_id: run.projectId,
    workspace_type: "worktree",
    detached: true,
    coordinate_with_creator: false,
    kickoff: { prompt: kickoffPrompt(config, run), agent: config.variantSet?.variants[run.variant].agent ?? liveAgent(run.variant), model: config.model, reasoning_effort: config.effort, context_tier: config.contextTier, mode: "interactive" },
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
    if (orch.agent !== (config.variantSet?.variants[run.variant].agent ?? liveAgent(run.variant))) wrong.push(`agent ${orch.agent ?? "none"}`);
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
  findAnswerSource(ctx, run, events);

  const session = run.appSessionId ?? run.sessionId;
  const kickoffMs = ms(run.kickoffAt);
  const limitMs = minutes(config.timeoutMin);
  if (blocks.length > 0) {
    // The run's end decides whether a prompt voids it: a final report written before the first
    // blocking request (and within the time limit) is judged first. If it is the report, the run
    // ends there and permissionsAfterWatching sorts the prompts by their timestamps.
    const firstRequestAt = Math.min(...blocks.map((block) => block.request.at));
    const earlier = orch.messages.filter((message) => message.at < firstRequestAt && message.at - kickoffMs <= limitMs);
    const unjudged = earlier.slice(-3).filter((message) => !run.judged.includes(message.messageId));
    if (unjudged.length > 0) {
      return {
        action: judgeAction(ctx, state, index, session, {
          messages: unjudged,
          swarmQuiet: since(now, swarm.lastActivityAt) >= config.swarmSettleSec * 1000,
          reason: "a tool-permission prompt appeared after these messages; a final report among them is the run's end, and a prompt after it doesn't void the run",
        }),
      };
    }
    await permissionBlocked(ctx, state, run, blocks, true);
    return { progressed: true };
  }
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
    run.endAt = at;
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

function archiveScoredRun(ctx: Ctx, run: RunState): void {
  const failures: string[] = [];
  let inventory: SessionInventory | null = null;
  try {
    inventory = ctx.deps.archiveInventory
      ? ctx.deps.archiveInventory(run) : openCleanupApp(ctx.config.appDb).inventory(run);
    if (run.projectId && !inventory.projects.length) throw new Error("app project is missing; descendant discovery may be incomplete");
    for (const project of inventory.projects) {
      if (project.id !== run.projectId || project.path !== run.repoDir) throw new Error("app project identity/path mismatch");
    }
  } catch (error) {
    inventory = null;
    failures.push(`discovery: ${error instanceof Error ? error.message : "app inventory failed"}`);
  }
  try {
    failures.push(...archiveRun(ctx.config, run, inventory, runSessionIds(ctx, run), () => iso(ctx.deps.now())));
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "archive failed");
  }
  if (failures.length) {
    for (const failure of failures) addFlag(run, "archive-failed", failure, iso(ctx.deps.now()));
    log(ctx, `${run.key} archive failed: ${failures.join("; ")}`);
  } else log(ctx, `${run.key} logs archived in ${join(ctx.config.dir, "sessions", run.name)}`);
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

// The run's row is already in results.csv, saved by a score the runner didn't see finish. It is
// the result: adopted as it is, never scored again and never removed.
function adoptRow(ctx: Ctx, state: BatchState, run: RunState, row: Record<string, string>): void {
  const at = iso(ctx.deps.now());
  run.row = { ...row };
  run.scoredAt ??= at;
  state.scoreFailures = 0;
  addFlag(run, "score-warning", "score saved this run's row before the runner recorded it (the runner stopped meanwhile); the row was adopted as it is, and its diagnostics may be incomplete", at);
  run.status = "scored";
  log(ctx, `${run.key} adopted its results.csv row: ${row.outcome} ${row.minutes} min`);
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
// Runs whose watching has ended but whose swarm is still checked for permission prompts.
const AFTER_WATCHING = new Set(["ending", "scoring", "scored", "settling", "stopping", "draining"]);

// A stop that is already known without the full admission checks.
function knownStop(state: BatchState): Stop | null {
  return firstStop(
    state.halt,
    state.fatal ? { reason: state.fatal, failure: true } : null,
    state.stopRequested ? { reason: "you asked the batch to stop", failure: false } : null,
  );
}

// The swarms of runs that have ended are still checked for permission prompts until the batch
// finishes. Such a prompt keeps the run's result, but no further run starts. Watched: every done
// run, scored or not (score may have failed), and any run with a row whatever its status. The row
// decides whether a run is scored, not whether its swarm is watched. Void runs without a row are
// skipped: a permission void has already stopped the batch.
async function watchFinishedSwarms(ctx: Ctx, state: BatchState): Promise<void> {
  const rows = readResults(ctx.config.resultsPath);
  const finished = state.runs.filter((run, index) => !state.active.includes(index) && run.sessionId && run.startRequestedAt &&
    (run.status === "done" || runRowFor(rows, run)));
  if (finished.length === 0) return;
  const now = ctx.deps.now();
  // One scan of the session folders for every finished run.
  const recent = ctx.index.recent(Math.min(...finished.map((run) => ms(run.startRequestedAt) - minutes(2))));
  for (const run of finished) {
    const ids = new Set(recent.filter((meta) => meta.repository?.toLowerCase() === run.repo.toLowerCase()).map((meta) => meta.id));
    ids.add(run.sessionId!);
    const known = new Set(run.flags.filter((flag) => flag.code === "permission-prompt").map((flag) => flag.detail));
    const fresh = readLogs(ctx, [...ids])
      .flatMap((log) => permissionBlocks(log.id, log.events, now))
      .filter((block) => !known.has(describePermissionBlock(block)));
    if (fresh.length > 0) await permissionBlocked(ctx, state, run, fresh, false);
  }
}

// Steps every run of the round until one needs the driver. Once a stop is known, the round's runs
// that haven't started are void; the others finish first.
async function runsStep(ctx: Ctx, state: BatchState): Promise<StepResult> {
  await watchFinishedSwarms(ctx, state);
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
    if (before === "scoring" && result.progressed) return { progressed: true };
  }
  return { progressed };
}

async function runStep(ctx: Ctx, state: BatchState, index: number): Promise<StepResult> {
  const { config, deps } = ctx;
  const run = state.runs[index];
  const now = deps.now();
  if (AFTER_WATCHING.has(run.status) && !run.voidReason) {
    const verdict = await permissionsAfterWatching(ctx, state, run, now);
    if (verdict === "void") return { progressed: true };
    if (verdict === "hold") return {};
  }
  switch (run.status) {
    case "new":
    case "repo":
      voidRun(ctx, state, run, "out of trusted projects: this run was not provisioned before the batch started", false);
      stopBatch(ctx, state, run.voidReason!, true);
      return { progressed: true };
    case "project": {
      // The last runner-controlled point before a run starts: check stops and pins again.
      const block = firstStop(state.halt, admissionBlock(ctx, state));
      if (block) {
        voidRun(ctx, state, run, `not started: ${block.reason}`, false);
        stopBatch(ctx, state, block.reason, block.failure);
        return { progressed: true };
      }
      const blocked = trustBlock(ctx, run.projectId);
      const wasPrepared = run.prepared;
      const preparationError = blocked ?? await prepareRun(ctx, run);
      // Persist preparation before pruning: a restart must not need the removed seed object.
      if (!preparationError && !wasPrepared) return { progressed: true };
      const cleanupError = preparationError ?? await pruneSeedHistory(ctx, run);
      // Trust is read again after preparation and cleanup, immediately before create_session.
      const failure = cleanupError ?? trustBlock(ctx, run.projectId);
      if (failure) {
        voidRun(ctx, state, run, `not started: ${failure}`, false);
        stopBatch(ctx, state, failure, true);
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
    case "scoring": {
      const row = rowOf(ctx, run);
      if (row) adoptRow(ctx, state, run, row);
      else await scoreRun(ctx, state, run);
      archiveScoredRun(ctx, run);
      return { progressed: true };
    }
    case "scored": {
      const saved = rowOf(ctx, run);
      if (saved) run.row ??= { ...saved };
      if (saved && !run.committed) {
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
  if (state.phase === "provisioning" || state.phase === "trust") {
    const stop = admissionBlock(ctx, state);
    const expired = state.phase === "trust" && now >= ms(state.trustWait?.deadlineAt) &&
      trustProjects(state).some((project) => ctx.deps.appDb.projectTrusted(project.id) !== true);
    if (stop || expired) {
      state.pending = null;
      stopBatch(ctx, state, stop?.reason ?? "project trust was not complete within 30 minutes; no self-test or eval session started", stop?.failure ?? true);
      return "cleared";
    }
  }
  if (pending.kind === "trust_projects") return "emit";
  if (pending.kind === "create_trust_session") {
    const session = state.trustSessions![Number(pending.payload.index)];
    const rows = ctx.deps.appDb.workspaces(session.projectId);
    const found = rows?.find((row) => row.name === session.name && row.createdBy === "agent" &&
      row.createdAt && ms(row.createdAt) >= ms(pending.issuedAt) && !row.archivedAt);
    if (found) {
      session.appSessionId = found.id;
      session.sessionId = found.sessionId ?? undefined;
      state.pending = null;
      return "cleared";
    }
    if (since(now, ms(pending.issuedAt)) < CREATE_RECONCILE_MS) return "hold";
    state.pending = null;
    stopBatch(ctx, state, `idle trust session ${session.name} was not confirmed within 5 minutes; inspect the project before retrying`, true);
    return "cleared";
  }
  if (pending.kind === "archive_trust_session") {
    const session = state.trustSessions![Number(pending.payload.index)];
    const found = ctx.deps.appDb.workspaces(session.projectId)?.find((row) => row.id === session.appSessionId);
    if (found?.archivedAt) {
      session.archived = true;
      state.pending = null;
      return "cleared";
    }
    return "emit";
  }
  const target = actionTarget(state, pending.target);
  if (!target) {
    state.pending = null;
    return "cleared";
  }
  switch (pending.kind) {
    case "add_repository": {
      const existing = projectAtPath(ctx, target.repoDir);
      if (existing === undefined) {
        state.pending = null;
        stopBatch(ctx, state, `cannot uniquely look up project at ${target.repoDir}; refusing to repeat add_repository`, true);
        return "cleared";
      }
      if (existing) {
        target.projectId = existing;
        target.status = "project";
        state.pending = null;
        return "cleared";
      }
      return "emit";
    }
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
  const trust = trustBlock(ctx, target.projectId);
  if (trust) {
    state.pending = null;
    if (selfTest) Object.assign(target, { status: "failed", failure: trust });
    else voidRun(ctx, state, target as RunState, trust, false);
    stopBatch(ctx, state, trust, true);
    return "cleared";
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
  ctx.excludedSessions.clear();
  for (const session of state.trustSessions ?? []) {
    if (session.appSessionId) {
      ctx.excludedSessions.add(session.appSessionId);
      session.sessionId ??= ctx.deps.appDb.sessionForWorkspace(session.appSessionId) ?? undefined;
    }
    if (session.sessionId) {
      ctx.excludedSessions.add(session.sessionId);
      for (const alias of ctx.deps.appDb.sessionAliases(session.sessionId) ?? []) ctx.excludedSessions.add(alias);
    }
  }
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
  if (["provisioning", "trust", "selftest", "runs"].includes(state.phase)) {
    await claimActive(ctx.config.activeGuard, ctx.config.id, ctx.config.dir, iso(now));
    if (!state.caffeinate) ensureAwake(ctx, state);
    if (!state.notified.includes("batch-started")) {
      const { config } = ctx;
      const plan = config.selfTest.only
        ? "self-test only"
        : `provision projects, user trust, ${config.selfTest.enabled ? "self-test, then " : ""}${describePlan(config.variants, config.runsPerVariant, calibrationDecision(readResults(config.resultsPath), config.variants, config.variantSet), config.parallel)}`;
      await notify(ctx, state, notices.batchStarted(config.id, plan));
    }
  }
  let result: StepResult;
  const revalidated = state.pending ? revalidate(ctx, state) : "cleared";
  if (revalidated === "emit") result = { action: render(ctx, state, state.pending!, true) };
  else if (revalidated === "hold") result = {};
  else {
    switch (state.phase) {
      case "provisioning":
        result = await provisionStep(ctx, state);
        break;
      case "trust":
        result = await trustStep(ctx, state);
        break;
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
  listed?: boolean;
  archived?: boolean;
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
  const run = pending.target === "selftest" || pending.target === "batch" ? null : actionTarget(state, pending.target) as RunState;
  let message = "";
  const p = pending.payload;

  switch (pending.kind) {
    case "create_trust_session":
    case "archive_trust_session": {
      const session = state.trustSessions![Number(p.index)];
      if (input.failed || (pending.kind === "create_trust_session" ? !input.sessionId : !input.archived)) {
        const why = `${pending.kind} failed: ${input.failed ?? "missing result"}`;
        stopBatch(ctx, state, why, true);
        message = why;
      } else if (pending.kind === "create_trust_session") {
        session.appSessionId = workspaceIdFor(ctx, input.sessionId!);
        session.sessionId = ctx.deps.appDb.sessionForWorkspace(session.appSessionId) ?? undefined;
        message = `idle trust session ${session.appSessionId} recorded`;
      } else {
        session.archived = true;
        message = `idle trust session ${session.appSessionId} archived`;
      }
      break;
    }
    case "trust_projects":
      if (!input.listed) throw new Error("record --listed only after displaying the trust list; this does not grant trust");
      state.trustWait!.listed = true;
      message = "trust list displayed; waiting for the user's app trust records";
      break;
    case "add_repository":
      if (input.failed || !input.projectId) {
        const why = `add_repository failed: ${input.failed ?? "no project id"}`;
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
