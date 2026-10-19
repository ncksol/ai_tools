// Batch config and state for the overnight runner. Both live as JSON files in the batch folder
// (outside the repo), so a restarted or compacted driver loses nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  startRequestedAt?: string;
  kickoffAt?: string;
  kickoffChecked?: boolean;
  judged: string[];
  answers: Answer[];
  askAttempts: Record<string, { count: number; at: string }>;
  plain?: { messageId: string; row: number; text: string; sentAt?: string; sendAttempts: number };
  answerSource?: string;
  final?: FinalMessage;
  endReason?: "final" | "timeout" | "stalled";
  endingSince?: string;
  scoredAt?: string;
  scoreExit?: number;
  scoreLog?: string;
  row?: Record<string, string>;
  committed?: boolean;
  notified?: boolean;
  stopSentAt?: string;
  stopAttempts?: number;
  drainingSince?: string;
  flags: Flag[];
  voidReason?: string;
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
  answered?: { toolCallId: string; at: string; text: string };
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
}

export interface Pins {
  agents: Record<string, { path: string; sha256: string }>;
  files: Record<string, string>;
  appVersion: string | null;
  cliVersion: string | null;
}

export interface BatchState {
  phase: "selftest" | "runs" | "finishing" | "done" | "stopped";
  stopReason?: string;
  // The batch stopped because something went wrong, not because it ran out of work or time.
  failed?: boolean;
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

export function saveState(dir: string, state: BatchState): void {
  writeJsonAtomic(statePath(dir), state);
}

export function loadState(dir: string): BatchState {
  return JSON.parse(readFileSync(statePath(dir), "utf8")) as BatchState;
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
  };
}

export function addFlag(target: { flags: Flag[] }, code: FlagCode, detail: string, at: string): void {
  if (target.flags.some((flag) => flag.code === code && flag.detail === detail)) return;
  target.flags.push({ code, detail, at });
}
