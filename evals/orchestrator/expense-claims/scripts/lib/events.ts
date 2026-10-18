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

export class EventLogError extends Error {}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const at = (event: LogEvent): number => Date.parse(event.timestamp);
const isHuman = (event: LogEvent): boolean => event.type === "user.message" && !event.data?.source;

export function readEventLog(path: string): { events: LogEvent[]; warnings: string[] } {
  if (!existsSync(path)) throw new EventLogError(`No event log at ${path}`);
  const lines = readFileSync(path, "utf8").split("\n");
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
      if (i === last) {
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

export function computeTiming(events: LogEvent[]): Timing {
  const own = events.filter((event) => !event.agentId);
  const kickoff = own.findIndex(isHuman);
  if (kickoff < 0) throw new EventLogError("No kickoff: the session has no user.message without data.source");
  let last = -1;
  for (let i = own.length - 1; i > kickoff; i--) {
    if (own[i].type === "assistant.message") {
      last = i;
      break;
    }
  }
  if (last < 0) throw new EventLogError("No assistant.message after the kickoff");

  const start = at(own[kickoff]);
  const end = at(own[last]);
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
    } else if (isHuman(event)) {
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
    end: own[last].timestamp,
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
