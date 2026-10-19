// Batch config and state for the overnight runner. Both live as JSON files in the batch folder
// (outside the repo), so a restarted or compacted driver loses nothing.
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Feature } from "../features.ts";
import { KIT_DIR } from "../suite.ts";

export const ORCHESTRATOR_AGENTS = ["orchestrator", "session-orchestrator"];

export interface BatchConfig {
  id: string;
  createdAt: string;
  dir: string;
  variants: string[];
  runsPerVariant: number;
  // No new run starts at or after this time (ISO).
  deadline: string;
  model: string;
  effort: string;
  contextTier: string;
  owner: string;
  runsDir: string;
  stateDir: string;
  agentsDir: string;
  appDb: string;
  appPlist: string;
  cliVersionFile: string;
  resultsPath: string;
  kitDir: string;
  scoreScript: string;
  newRunScript: string;
  timeoutMin: number;
  stallMin: number;
  idleSettleSec: number;
  swarmSettleSec: number;
  quietWaitMin: number;
  drainMaxMin: number;
  sessionAppearMin: number;
  pollSec: number;
  minFreeGiB: number;
  selfTest: { enabled: boolean; only: boolean; model: string; effort: string; agent: string | null };
  notify: { urlFile: string; envVar: string };
  // The machine-wide file that lets only one batch be active at a time.
  activeGuard: string;
  keepAwake: boolean;
  push: boolean;
  // A dry-run batch never touches GitHub and must never be driven with real app tools.
  dryRun: boolean;
  memoryOffConfirmed: boolean;
}

export type FlagCode =
  | "memory-loaded"
  | "memory-write"
  | "history-query"
  | "plain-text-question"
  | "choice-answer"
  | "answer-retry"
  | "permission-prompt"
  | "open-tool-at-stall"
  | "kickoff-text"
  | "kickoff-shape"
  | "session-settings"
  | "swarm-not-quiet"
  | "driver-gap"
  | "answer-source-unknown"
  | "score-failed"
  | "score-warning"
  | "commit-failed"
  | "app-db"
  | "clock-jump"
  | "answer-mismatch"
  | "start-failed"
  | "send-failed";

export interface Flag {
  code: FlagCode;
  detail: string;
  at: string;
}

export interface Answer {
  kind: "ask_user" | "plain";
  ref: string;
  row: number;
  text: string;
  choice?: string;
  at: string;
}

export interface FinalMessage {
  messageId: string;
  // The exact timestamp string of the message's last event in events.jsonl. Never re-serialized:
  // score --end-at drops events after it, so even a rounded value can lose the final report.
  timestamp: string;
}

export type RunStatus =
  | "new"
  | "repo"
  | "project"
  | "starting"
  | "running"
  | "ending"
  | "scoring"
  | "scored"
  | "settling"
  | "stopping"
  | "draining"
  | "done"
  | "void";

export interface RunState {
  key: string;
  variant: string;
  n: number;
  features: Feature[];
  calibration: boolean;
  name: string;
  repoDir: string;
  repo: string;
  status: RunStatus;
  createdAt: string;
  projectId?: string;
  appSessionId?: string;
  sessionId?: string;
  // When create_session was first issued (the window for finding the session) and last issued.
  startRequestedAt?: string;
  lastStartAt?: string;
  kickoffAt?: string;
  kickoffChecked?: boolean;
  judged: string[];
  answers: Answer[];
  askAttempts: Record<string, { count: number; at: string }>;
  // The request_id the driver answered for each ask_user call, as reported by get_session.
  requestIds: Record<string, string>;
  // issuedAt is when the send action was issued; the reply is looked for from then, not from when
  // the driver recorded it. deliveredAt is the reply's own timestamp in the run's log.
  plain?: { messageId: string; row: number; text: string; issuedAt?: string; sentAt?: string; deliveredAt?: string; sendAttempts: number };
  answerSource?: string;
  final?: FinalMessage;
  endReason?: "final" | "timeout" | "stalled";
  endingSince?: string;
  scoredAt?: string;
  scoreExit?: number;
  scoreLog?: string;
  row?: Record<string, string>;
  note?: string;
  hygieneScanned?: boolean;
  committed?: boolean;
  commitAttempts?: number;
  lastCommitAttemptAt?: string;
  notified?: boolean;
  // The flag codes the run's outcome notification carried; later ones go out as late flags.
  notifiedFlags?: string[];
  lateNotified?: string[];
  settlingSince?: string;
  stopSentAt?: string;
  stopAttempts?: number;
  drainingSince?: string;
  flags: Flag[];
  voidReason?: string;
  // Set when the run was voided because create_session was never confirmed: if its session turns
  // up later, no further run may start beside it.
  unconfirmedSince?: string;
  endedAt?: string;
}

export interface SelfTestState {
  nonce: string;
  repoDir: string;
  prompt: string;
  status: "new" | "repo" | "project" | "starting" | "running" | "verify" | "passed" | "failed";
  createdAt: string;
  projectId?: string;
  appSessionId?: string;
  sessionId?: string;
  startRequestedAt?: string;
  lastStartAt?: string;
  answered?: { toolCallId: string; at: string; text: string; requestId?: string };
  // The request_id the driver saw for each ask_user call, kept even when answering failed.
  requestIds?: Record<string, string>;
  askAttempts: number;
  judged: string[];
  final?: FinalMessage;
  checks: { name: string; ok: boolean; detail: string }[];
  failure?: string;
}

export type ActionKind =
  | "create_project"
  | "create_session"
  | "lookup_session"
  | "answer_question"
  | "judge_idle"
  | "send_message";

export interface PendingAction {
  id: string;
  kind: ActionKind;
  target: "selftest" | number;
  issuedAt: string;
  payload: Record<string, unknown>;
  // How often an unconfirmed create_session was issued again after reconciling found no session.
  reissues?: number;
  // When a create_session was first issued: the lower bound for finding its session across every
  // reissue. issuedAt is when it was last issued.
  firstIssuedAt?: string;
}

export interface Pins {
  agents: Record<string, { path: string; sha256: string }>;
  files: Record<string, string>;
  appVersion: string | null;
  cliVersion: string | null;
}

export interface BatchState {
  // The revision this state was loaded at (0 before the first save). See saveState.
  revision?: number;
  phase: "selftest" | "runs" | "finishing" | "done" | "stopped";
  stopReason?: string;
  // The batch stopped because something went wrong, not because it ran out of work or time.
  failed?: boolean;
  // Set when the batch must start no further run, for example after a results commit failed for good.
  fatal?: string;
  // The driver session that runs this batch. Another driver is refused while this one is alive.
  owner: { id: string; since: string; lastSeenAt: string } | null;
  pins: Pins;
  pending: PendingAction | null;
  actionSeq: number;
  recorded: string[];
  selftests: SelfTestState[];
  runs: RunState[];
  current: number | null;
  startFailures: number;
  scoreFailures: number;
  notified: string[];
  caffeinate: { pid: number; until: string } | null;
  lastHeartbeatAt: string | null;
  stopRequested: boolean;
  calibration: string;
  startedAt: string;
  // The ai_tools commit results.csv was at when the batch started; the report lists commits after it.
  resultsBase?: string;
  finishedAt?: string;
  reportPath?: string;
  warnings: string[];
}

export function defaultPaths() {
  const home = homedir();
  return {
    batchesDir: join(home, "orch-evals", "batches"),
    runsDir: join(home, "orch-evals"),
    stateDir: join(home, ".copilot", "session-state"),
    agentsDir: join(home, ".copilot", "agents"),
    appDb: join(home, ".copilot", "data.db"),
    appPlist: "/Applications/GitHub.app/Contents/Info.plist",
    cliVersionFile: "/Applications/GitHub.app/Contents/Resources/copilot-sdk/cliVersion.d.ts",
    resultsPath: join(KIT_DIR, "results.csv"),
    ntfyUrlFile: join(home, ".config", "orch-evals", "ntfy-url"),
    activeGuard: join(home, "orch-evals", "active-batch.json"),
  };
}

export const NTFY_ENV_VAR = "ORCH_EVAL_NTFY_URL";

// The next time it is hh:mm local time, strictly after `from`.
export function nextLocalTime(hhmm: string, from: Date): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Deadline "${hhmm}" must be HH:MM`);
  const at = new Date(from);
  at.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (at.getTime() <= from.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

export function batchId(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

export function validateConfig(config: BatchConfig): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const variant of config.variants) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(variant)) problems.push(`variant "${variant}" must be lowercase letters, digits and hyphens`);
    if (names.has(variant)) problems.push(`variant "${variant}" is listed twice`);
    names.add(variant);
  }
  if (!config.selfTest.only && config.variants.length === 0) problems.push("no variants");
  if (!Number.isSafeInteger(config.runsPerVariant) || config.runsPerVariant < 1) problems.push("--runs must be a positive integer");
  const agent = config.selfTest.agent;
  if (agent && (ORCHESTRATOR_AGENTS.includes(agent) || config.variants.includes(agent))) {
    problems.push(`the self-test must not use the agent "${agent}": never an orchestrator or a variant under test`);
  }
  if (config.selfTest.only && !config.selfTest.enabled) problems.push("--self-test-only needs the self-test");
  return problems;
}

export const configPath = (dir: string): string => join(dir, "config.json");
export const statePath = (dir: string): string => join(dir, "state.json");

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function saveConfig(config: BatchConfig): void {
  mkdirSync(config.dir, { recursive: true });
  writeJsonAtomic(configPath(config.dir), config);
}

export function loadConfig(dir: string): BatchConfig {
  if (!existsSync(configPath(dir))) throw new Error(`No batch at ${dir} (config.json is missing)`);
  return JSON.parse(readFileSync(configPath(dir), "utf8")) as BatchConfig;
}

export class StaleStateError extends Error {}

// Every saved state is a numbered revision file in state/, and the newest one is the state.
// state.json is a copy of it for people and tools to read, never read back by the runner.
export const revisionsDir = (dir: string): string => join(dir, "state");
const revisionFile = (dir: string, revision: number): string => join(revisionsDir(dir), `${String(revision).padStart(9, "0")}.json`);
const KEEP_REVISIONS = 20;

function latestRevision(dir: string): number {
  let names: string[];
  try {
    names = readdirSync(revisionsDir(dir));
  } catch {
    return 0;
  }
  return names.reduce((max, name) => Math.max(max, Number(/^(\d+)\.json$/.exec(name)?.[1] ?? 0)), 0);
}

// Compare-and-swap: the save creates the next revision's file with link(2), which fails if that
// file already exists. So a save writes only if no other save happened since this state was loaded;
// otherwise it writes nothing and throws StaleStateError. Revision files are numbered without gaps
// and never deleted (old ones are only emptied), so this holds however stale the state is.
export function saveState(dir: string, state: BatchState): void {
  const next = (state.revision ?? 0) + 1;
  mkdirSync(revisionsDir(dir), { recursive: true });
  const tmp = join(revisionsDir(dir), `.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify({ ...state, revision: next }, null, 2) + "\n");
    linkSync(tmp, revisionFile(dir, next));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StaleStateError(`The batch state changed since revision ${next - 1} was read (another process saved it); nothing was written.`);
    }
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
  state.revision = next;
  writeJsonAtomic(statePath(dir), state);
  // Empty, not delete: the file keeps its revision number taken, so a stale save still fails.
  if (next > KEEP_REVISIONS) writeFileSync(revisionFile(dir, next - KEEP_REVISIONS), "");
}

export function loadState(dir: string): BatchState {
  const revision = latestRevision(dir);
  const path = revision > 0 ? revisionFile(dir, revision) : statePath(dir);
  const state = JSON.parse(readFileSync(path, "utf8")) as BatchState;
  state.revision = revision;
  return state;
}

export function initialState(pins: Pins, selfTest: boolean, now: string): BatchState {
  return {
    phase: selfTest ? "selftest" : "runs",
    pins,
    pending: null,
    actionSeq: 0,
    recorded: [],
    selftests: [],
    runs: [],
    current: null,
    startFailures: 0,
    scoreFailures: 0,
    notified: [],
    caffeinate: null,
    lastHeartbeatAt: null,
    stopRequested: false,
    calibration: "",
    startedAt: now,
    warnings: [],
    owner: null,
  };
}

export function addFlag(target: { flags: Flag[] }, code: FlagCode, detail: string, at: string): void {
  if (target.flags.some((flag) => flag.code === code && flag.detail === detail)) return;
  target.flags.push({ code, detail, at });
}
