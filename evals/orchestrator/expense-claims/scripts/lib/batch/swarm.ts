// Reads the run's session logs (the orchestrator and every child) and builds the views the runner
// decides on. Read-only: it never writes to ~/.copilot.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { yamlScalar, type LogEvent } from "../events.ts";

const CROSS_SESSION_TAG = "<cross_session_message";
const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
export const at = (event: LogEvent): number => Date.parse(event.timestamp);

function parseLine(line: string): LogEvent | null {
  if (line.trim() === "") return null;
  try {
    const event = JSON.parse(line) as LogEvent;
    if (typeof event?.type !== "string" || Number.isNaN(Date.parse(event?.timestamp))) return null;
    return event;
  } catch {
    return null;
  }
}

export function parseEvents(text: string): LogEvent[] {
  return text.split("\n").map(parseLine).filter((event): event is LogEvent => event !== null);
}

// Reads events.jsonl files incrementally: only complete lines, and only the bytes added since the
// last read. Unreadable lines are skipped (the runner must not stop on one torn write).
export class LogCache {
  private files = new Map<string, { consumed: number; events: LogEvent[] }>();

  read(path: string): LogEvent[] {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    let entry = this.files.get(path);
    if (!entry || size < entry.consumed) entry = { consumed: 0, events: [] };
    if (size > entry.consumed) {
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - entry.consumed);
        const read = readSync(fd, buffer, 0, buffer.length, entry.consumed);
        const end = buffer.subarray(0, read).lastIndexOf(0x0a);
        if (end >= 0) {
          const fresh = parseEvents(buffer.subarray(0, end).toString("utf8"));
          entry = { consumed: entry.consumed + end + 1, events: entry.events.concat(fresh) };
        }
      } finally {
        closeSync(fd);
      }
    }
    this.files.set(path, entry);
    return entry.events;
  }
}

export interface SessionMeta {
  id: string;
  dir: string;
  repository: string | null;
  createdAt: string | null;
}

// Finds session folders without reading all of ~/.copilot/session-state on every poll: only
// folders whose mtime is at or after `sinceMs` are opened, and each is read once per process.
export class SessionIndex {
  private known = new Map<string, SessionMeta>();
  readonly stateDir: string;
  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  meta(id: string): SessionMeta | null {
    const cached = this.known.get(id);
    if (cached) return cached;
    const dir = join(this.stateDir, id);
    let text: string;
    try {
      text = readFileSync(join(dir, "workspace.yaml"), "utf8");
    } catch {
      return null;
    }
    const meta = { id, dir, repository: yamlScalar(text, "repository"), createdAt: yamlScalar(text, "created_at") };
    this.known.set(id, meta);
    return meta;
  }

  recent(sinceMs: number): SessionMeta[] {
    let names: string[];
    try {
      names = readdirSync(this.stateDir);
    } catch {
      return [];
    }
    const found: SessionMeta[] = [];
    for (const name of names) {
      if (!this.known.has(name)) {
        let mtime: number;
        try {
          const stat = statSync(join(this.stateDir, name));
          if (!stat.isDirectory()) continue;
          mtime = stat.mtimeMs;
        } catch {
          continue;
        }
        if (mtime < sinceMs) continue;
      }
      const meta = this.meta(name);
      if (meta) found.push(meta);
    }
    return found.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  }

  forRepository(repository: string, sinceMs: number): SessionMeta[] {
    return this.recent(sinceMs).filter((meta) => meta.repository?.toLowerCase() === repository.toLowerCase());
  }
}

export const eventsPath = (stateDir: string, id: string): string => join(stateDir, id, "events.jsonl");

const messageText = (event: LogEvent): string => {
  const text = event.data?.content ?? event.data?.transformedContent;
  return typeof text === "string" ? text : "";
};

export interface MessageView {
  messageId: string;
  timestamp: string;
  at: number;
  text: string;
}

export interface OpenAsk {
  toolCallId: string;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  timestamp: string;
}

export interface AskCall {
  toolCallId: string;
  question: string;
  startAt: number;
  completed: boolean;
  resultText: string;
}

export interface OrchView {
  kickoff: LogEvent | null;
  kickoffIndex: number;
  // "user" when the first message has no data.source and no cross-session tag, as score requires.
  startedBy: "user" | "session" | null;
  lastTopAt: number;
  openTurn: boolean;
  openTools: { toolName: string; toolCallId: string; at: number }[];
  openAsk: OpenAsk | null;
  askCalls: AskCall[];
  messages: MessageView[];
  model: string | null;
  effort: string | null;
  contextTier: string | null;
  agent: string | null;
}

export function orchestratorView(events: LogEvent[]): OrchView {
  const own = events.filter((event) => !event.agentId);
  let kickoffIndex = -1;
  let startedBy: OrchView["startedBy"] = null;
  for (let i = 0; i < own.length; i++) {
    const event = own[i];
    if (event.type !== "user.message") continue;
    const source = str(event.data?.source);
    if (source?.startsWith("agent-")) {
      startedBy = "session";
      kickoffIndex = i;
      break;
    }
    if (source) continue;
    const tagged = String(event.data?.transformedContent ?? event.data?.content ?? "").includes(CROSS_SESSION_TAG);
    startedBy = tagged ? "session" : "user";
    kickoffIndex = i;
    break;
  }

  const completes = new Map<string, LogEvent>();
  for (const event of own) {
    const id = str(event.data?.toolCallId);
    if (event.type === "tool.execution_complete" && id) completes.set(id, event);
  }

  let lastStart = -1;
  let lastEnd = -1;
  const openTools: OrchView["openTools"] = [];
  const askCalls: AskCall[] = [];
  let openAsk: OpenAsk | null = null;
  const groups = new Map<string, { parts: { index: number; text: string }[]; last: LogEvent }>();
  let model = null as string | null;
  let effort = null as string | null;
  let contextTier = null as string | null;
  let agent = null as string | null;

  own.forEach((event, i) => {
    const data = event.data ?? {};
    if (event.type === "session.start") {
      model = str(data.selectedModel);
      effort = str(data.reasoningEffort);
      contextTier = str(data.contextTier);
    }
    if (event.type === "session.model_change" && (kickoffIndex < 0 || i < kickoffIndex)) {
      model = str(data.newModel) ?? model;
      effort = str(data.reasoningEffort) ?? effort;
    }
    if (event.type === "subagent.selected" && (kickoffIndex < 0 || i <= kickoffIndex)) agent = str(data.agentName) ?? agent;
    if (event.type === "assistant.turn_start") lastStart = i;
    if (event.type === "assistant.turn_end") lastEnd = i;
    if (event.type === "tool.execution_start") {
      const id = str(data.toolCallId) ?? `idx-${i}`;
      const done = completes.get(id);
      const name = str(data.toolName) ?? "unknown";
      if (name === "ask_user") {
        const args = (data.arguments ?? {}) as Record<string, unknown>;
        const question = typeof args.question === "string" ? args.question : "";
        const result = done ? JSON.stringify(done.data ?? {}) : "";
        askCalls.push({ toolCallId: id, question, startAt: at(event), completed: Boolean(done), resultText: result });
        if (!done) {
          openAsk = {
            toolCallId: id,
            question,
            choices: Array.isArray(args.choices) ? args.choices.map(String) : [],
            allowFreeform: args.allow_freeform !== false,
            timestamp: event.timestamp,
          };
        }
      } else if (!done) {
        openTools.push({ toolName: name, toolCallId: id, at: at(event) });
      }
    }
    if (event.type === "assistant.message" && i > kickoffIndex && kickoffIndex >= 0) {
      const text = typeof data.content === "string" ? data.content : "";
      const id = str(data.messageId) ?? str((event as LogEvent & { id?: string }).id) ?? `idx-${i}`;
      const group = groups.get(id) ?? { parts: [], last: event };
      group.parts.push({ index: typeof data.chunkIndex === "number" ? data.chunkIndex : group.parts.length, text });
      group.last = event;
      groups.set(id, group);
    }
  });

  const messages: MessageView[] = [];
  for (const [messageId, group] of groups) {
    const text = group.parts
      .sort((a, b) => a.index - b.index)
      .map((part) => part.text)
      .join("");
    if (text.trim() === "") continue;
    messages.push({ messageId, timestamp: group.last.timestamp, at: at(group.last), text });
  }
  messages.sort((a, b) => a.at - b.at);

  return {
    kickoff: kickoffIndex >= 0 ? own[kickoffIndex] : null,
    kickoffIndex,
    startedBy,
    lastTopAt: own.reduce((max, event) => Math.max(max, at(event)), 0),
    openTurn: lastStart > lastEnd,
    openTools,
    openAsk,
    askCalls,
    messages,
    model,
    effort,
    contextTier,
    agent,
  };
}

export const kickoffText = (view: OrchView): string => (view.kickoff ? messageText(view.kickoff) : "");

export interface SessionActivity {
  id: string;
  lastAt: number;
  openTools: { toolName: string; agentId: string | null; at: number }[];
  pendingPermissions: number;
  unattendedDenials: number;
}

export function sessionActivity(id: string, events: LogEvent[]): SessionActivity {
  const completed = new Set<string>();
  const permissionsDone = new Set<string>();
  let unattendedDenials = 0;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "tool.execution_complete" && str(data.toolCallId)) completed.add(String(data.toolCallId));
    if (event.type === "permission.completed") {
      if (str(data.requestId)) permissionsDone.add(String(data.requestId));
      if (data.decisionSource === "unattended_fallback") unattendedDenials++;
    }
  }
  let lastAt = 0;
  let pendingPermissions = 0;
  const openTools: SessionActivity["openTools"] = [];
  for (const event of events) {
    const data = event.data ?? {};
    lastAt = Math.max(lastAt, at(event));
    if (event.type === "tool.execution_start" && str(data.toolCallId) && !completed.has(String(data.toolCallId))) {
      openTools.push({ toolName: str(data.toolName) ?? "unknown", agentId: event.agentId ?? null, at: at(event) });
    }
    if (event.type === "permission.requested" && str(data.requestId) && !permissionsDone.has(String(data.requestId))) pendingPermissions++;
  }
  return { id, lastAt, openTools, pendingPermissions, unattendedDenials };
}

export interface SwarmView {
  sessions: SessionActivity[];
  lastActivityAt: number;
}

export function swarmView(logs: { id: string; events: LogEvent[] }[]): SwarmView {
  const sessions = logs.map((log) => sessionActivity(log.id, log.events));
  return { sessions, lastActivityAt: sessions.reduce((max, session) => Math.max(max, session.lastAt), 0) };
}

const QUESTION_HINT = /\?\s*$|\?\s*\n|\b(let me know|please (confirm|approve)|should i|shall i|do you want|would you like|waiting for your)\b/i;
const FINAL_HINT = /\b(done|complete[ds]?|finished|final report|all (?:\w+ ){0,3}merged|work is done)\b/i;

export const looksLikeQuestion = (text: string): boolean => QUESTION_HINT.test(text.slice(-1500));
export const looksLikeFinal = (text: string): boolean => FINAL_HINT.test(text);

export interface IdleSettings {
  idleSettleMs: number;
  swarmSettleMs: number;
}

// The orchestrator has gone idle with messages the driver hasn't judged. Offered when the whole
// swarm is quiet, or sooner when the last message reads like a question or a final report.
export function idleCandidate(
  orch: OrchView,
  swarm: SwarmView,
  now: number,
  judged: readonly string[],
  settings: IdleSettings,
): { messages: MessageView[]; swarmQuiet: boolean; reason: string } | null {
  if (!orch.kickoff || orch.openTurn || orch.openAsk || orch.openTools.length > 0) return null;
  if (now - orch.lastTopAt < settings.idleSettleMs) return null;
  const unjudged = orch.messages.filter((message) => !judged.includes(message.messageId));
  if (unjudged.length === 0) return null;
  const last = unjudged[unjudged.length - 1];
  const swarmQuiet = now - swarm.lastActivityAt >= settings.swarmSettleMs;
  let reason: string;
  if (swarmQuiet) reason = "the whole swarm is quiet";
  else if (looksLikeQuestion(last.text)) reason = "the last message reads like a question";
  else if (looksLikeFinal(last.text)) reason = "the last message reads like a final report";
  else return null;
  return { messages: unjudged.slice(-3), swarmQuiet, reason };
}

// The driver's plain-text reply in the run's log: its data.source, read rather than guessed, and
// its own timestamp.
export function findReplySource(events: LogEvent[], reply: string, sinceMs: number): { source: string; timestamp: string } | null {
  for (const event of events) {
    if (event.agentId || event.type !== "user.message" || at(event) < sinceMs) continue;
    const source = str(event.data?.source);
    if (!source?.startsWith("agent-")) continue;
    const content = `${event.data?.content ?? ""}\n${event.data?.transformedContent ?? ""}`;
    if (content.includes(reply)) return { source, timestamp: event.timestamp };
  }
  return null;
}

// Whether a message with this text reached the session at or after `sinceMs` (used to avoid
// sending a message twice after a driver restart).
export function messageArrived(events: LogEvent[], text: string, sinceMs: number): boolean {
  return events.some(
    (event) =>
      !event.agentId &&
      event.type === "user.message" &&
      at(event) >= sinceMs &&
      `${event.data?.content ?? ""}\n${event.data?.transformedContent ?? ""}`.includes(text),
  );
}
