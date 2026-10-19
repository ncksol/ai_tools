import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LogEvent {
  type: string;
  timestamp: string;
  agentId?: string;
  data?: Record<string, unknown>;
}

export interface Timing {
  start: string;
  end: string;
  wallMs: number;
  blockedMs: number;
  scoredMs: number;
  askUserCalls: number;
  humanMessages: number;
  questions: number;
  model: string | null;
  effort: string | null;
  copilotVersion: string | null;
  agent: string | null;
  warnings: string[];
}

export interface SessionInfo {
  id: string;
  dir: string;
  repository: string;
  createdAt: string | null;
}

export type Starter = "user" | "session" | "none";

export interface RunSession extends SessionInfo {
  hasLog: boolean;
  startedBy: Starter | null;
  agent: string | null;
}

export class EventLogError extends Error {}

export class SessionChoiceError extends Error {}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const at = (event: LogEvent): number => Date.parse(event.timestamp);
const CROSS_SESSION_TAG = "<cross_session_message";

function isCrossSession(event: LogEvent): boolean {
  const text = event.data?.transformedContent ?? event.data?.content;
  return typeof text === "string" && text.includes(CROSS_SESSION_TAG);
}

const isHuman = (event: LogEvent, answerSource?: string): boolean =>
  event.type === "user.message" &&
  ((answerSource !== undefined && event.data?.source === answerSource) || (!event.data?.source && !isCrossSession(event)));

export function readEventLog(path: string): { events: LogEvent[]; warnings: string[] } {
  if (!existsSync(path)) throw new EventLogError(`No event log at ${path}`);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  const events: LogEvent[] = [];
  const warnings: string[] = [];
  for (let i = 0; i <= last; i++) {
    if (lines[i].trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      // Only an unterminated trailing fragment is a torn write; a complete bad record is an error.
      if (i === last && !text.endsWith("\n")) {
        warnings.push(`Ignored an incomplete last line (line ${i + 1})`);
        continue;
      }
      throw new EventLogError(`Line ${i + 1} of ${path} is not valid JSON`);
    }
    const event = parsed as LogEvent;
    if (typeof event?.type !== "string" || Number.isNaN(Date.parse(event?.timestamp))) {
      throw new EventLogError(`Line ${i + 1} of ${path} has no type or no valid timestamp`);
    }
    events.push(event);
  }
  return { events, warnings };
}

// `endAt` ends the window at a given time instead of the last assistant message. Use it for runs
// that never finished (timeout, stalled). `cutoff` ignores later events in a completed run.
export function computeTiming(events: LogEvent[], opts: { endAt?: number; cutoff?: number; answerSource?: string } = {}): Timing {
  const own = events.filter((event) => !event.agentId && (opts.cutoff === undefined || at(event) <= opts.cutoff));
  const kickoff = own.findIndex((event) => isHuman(event));
  if (kickoff < 0) throw new EventLogError("No kickoff: the session has no human user.message without data.source or a cross-session tag");
  const start = at(own[kickoff]);
  let last = -1;
  if (opts.endAt !== undefined) {
    if (opts.endAt < start) throw new EventLogError("The end time is before the kickoff");
    last = kickoff;
    for (let i = kickoff + 1; i < own.length && at(own[i]) <= opts.endAt; i++) last = i;
  } else {
    const complete = own.findIndex((event, i) => i > kickoff && event.type === "session.task_complete");
    for (let i = complete < 0 ? own.length - 1 : complete; i > kickoff; i--) {
      if (own[i].type === "assistant.message") {
        last = i;
        break;
      }
    }
    if (last < 0) throw new EventLogError("No assistant.message after the kickoff");
  }

  const end = opts.endAt ?? at(own[last]);
  const warnings: string[] = [];
  const completes = new Map<string, LogEvent>();
  for (const event of own) {
    const id = str(event.data?.toolCallId);
    if (event.type === "tool.execution_complete" && id) completes.set(id, event);
  }

  let blockedMs = 0;
  let askUserCalls = 0;
  let humanMessages = 0;
  let lastTurn: LogEvent | null = null;
  for (const event of own.slice(kickoff + 1, last + 1)) {
    if (event.type === "assistant.turn_start" || event.type === "assistant.turn_end") {
      lastTurn = event;
    } else if (event.type === "tool.execution_start" && event.data?.toolName === "ask_user") {
      askUserCalls++;
      const done = completes.get(str(event.data?.toolCallId) ?? "");
      if (done) {
        blockedMs += Math.min(at(done), end) - at(event);
      } else {
        blockedMs += end - at(event);
        warnings.push("An ask_user call has no completion; it counts as blocked until the end");
      }
    } else if (isHuman(event, opts.answerSource)) {
      humanMessages++;
      if (lastTurn?.type === "assistant.turn_end") blockedMs += at(event) - at(lastTurn);
    }
  }

  const session = own.find((event) => event.type === "session.start");
  let model = str(session?.data?.selectedModel);
  let effort = str(session?.data?.reasoningEffort);
  let agent: string | null = null;
  own.forEach((event, i) => {
    if (event.type === "session.model_change") {
      if (i < kickoff) {
        model = str(event.data?.newModel) ?? model;
        effort = str(event.data?.reasoningEffort) ?? effort;
      } else if (i <= last) {
        warnings.push("The session's model changed during the run");
      }
    }
    if (event.type === "subagent.selected" && i <= kickoff) agent = str(event.data?.agentName) ?? agent;
  });

  const wallMs = end - start;
  return {
    start: own[kickoff].timestamp,
    end: opts.endAt === undefined ? own[last].timestamp : new Date(opts.endAt).toISOString(),
    wallMs,
    blockedMs,
    scoredMs: wallMs - blockedMs,
    askUserCalls,
    humanMessages,
    questions: askUserCalls + humanMessages,
    model,
    effort,
    copilotVersion: str(session?.data?.copilotVersion),
    agent,
    warnings,
  };
}

export function yamlScalar(text: string, key: string): string | null {
  const match = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  if (!match) return null;
  return str(match[1].trim().replace(/^(['"])(.*)\1$/, "$2"));
}

export function findRunSessions(stateDir: string, repository: string): SessionInfo[] {
  const found: SessionInfo[] = [];
  for (const id of readdirSync(stateDir)) {
    let text: string;
    try {
      text = readFileSync(join(stateDir, id, "workspace.yaml"), "utf8");
    } catch {
      continue;
    }
    const repo = yamlScalar(text, "repository");
    if (!repo || repo.toLowerCase() !== repository.toLowerCase()) continue;
    found.push({ id, dir: join(stateDir, id), repository: repo, createdAt: yamlScalar(text, "created_at") });
  }
  return found.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

// Finds who sent the session's first message, and the agent selected by then. Message text is only
// checked for the cross-session tag; it is never kept or printed. Unreadable lines are skipped.
export function describeSession(dir: string): Pick<RunSession, "hasLog" | "startedBy" | "agent"> {
  const path = join(dir, "events.jsonl");
  if (!existsSync(path)) return { hasLog: false, startedBy: null, agent: null };
  let agent: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    let event: LogEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object" || event.agentId) continue;
    if (event.type === "subagent.selected") agent = str(event.data?.agentName) ?? agent;
    if (event.type !== "user.message") continue;
    const source = str(event.data?.source);
    if (source?.startsWith("agent-")) return { hasLog: true, startedBy: "session", agent };
    // system, skill-<name> and autopilot messages come from the runtime, not from a sender.
    if (source) continue;
    return { hasLog: true, startedBy: isCrossSession(event) ? "session" : "user", agent };
  }
  return { hasLog: true, startedBy: "none", agent };
}

function sessionStatus(session: RunSession): string {
  if (!session.hasLog) return "no event log";
  if (session.startedBy === "user") return "started by you";
  if (session.startedBy === "session") return "started by another session";
  return "no message yet";
}

// The run's orchestrator session is the one session for the run repo that the user started, which
// rules out sessions that never ran and the orchestrator's child sessions. If the user started
// several, the one whose agent is the variant under test wins. Anything else is left to --session.
export function chooseRunSession(stateDir: string, repository: string, variant: string): { session: RunSession; rule: string } {
  const sessions: RunSession[] = findRunSessions(stateDir, repository).map((info) => ({ ...info, ...describeSession(info.dir) }));
  const byUser = sessions.filter((session) => session.startedBy === "user");
  if (byUser.length === 1) return { session: byUser[0], rule: `the only session for ${repository} that you started` };
  const byAgent = byUser.filter((session) => session.agent === variant);
  if (byAgent.length === 1) {
    return { session: byAgent[0], rule: `the only session for ${repository} that you started with agent ${variant}` };
  }

  const problem =
    sessions.length === 0
      ? `No session in ${stateDir} has repository ${repository}`
      : byUser.length === 0
        ? `None of the ${sessions.length} session(s) for ${repository} was started by you`
        : `${byUser.length} sessions for ${repository} were started by you, and ${byAgent.length === 0 ? "none" : byAgent.length} of them used agent ${variant}`;
  const list = sessions.map(
    (session) => `  ${session.id}  created ${session.createdAt ?? "unknown"}  agent ${session.agent ?? "none"}  ${sessionStatus(session)}`,
  );
  throw new SessionChoiceError(
    [`${problem}, so score can't tell which one is the orchestrator session.`, ...list, "Rerun with --session <id>."].join("\n"),
  );
}
