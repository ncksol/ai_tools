// A stand-in for the Copilot app and the driver agent, for the rehearsal and the tests. It writes
// synthetic session logs into a scratch session-state folder on a simulated clock. Nothing here
// talks to the real app, starts an agent or touches GitHub.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LogEvent } from "../events.ts";
import type { AppDb, Interruption, WorkspaceRow } from "./appdb.ts";

export type Scenario =
  | "selftest"
  | "ask-final"
  | "plain-final"
  | "gave-up"
  | "stall"
  | "timeout"
  | "busy-child"
  | "runaway"
  | "timeout-runaway"
  | "permission-prompt"
  | "permission-denied"
  | "silent";

const MIN = 60_000;

interface FakeSession {
  appId: string;
  id: string;
  projectId: string;
  repository: string;
  scenario: Scenario;
  stage: number;
  nextAt: number;
  ask?: { toolCallId: string; requestId: string; question: string };
  children: string[];
  createdAt: string;
  stopped: boolean;
  answered?: string;
  prompt: string;
}

export class FakeApp implements AppDb {
  projects = new Map<string, { path: string; repository: string }>();
  sessions = new Map<string, FakeSession>();
  private seq = 0;
  readonly driverSource = "agent-driver-rehearsal";
  readonly stateDir: string;
  readonly clock: { now: number };
  private scenarios: Scenario[];

  childSessions(sessionId: string): string[] {
    return [...this.sessions.values()].find((session) => session.id === sessionId)?.children ?? [];
  }
  sessionAliases(): string[] { return []; }
  // Every project uses the app's default account.
  account = "ncksol";
  defaultAccount(): string | null { return this.account; }
  projectAccount(projectId: string): string | null { return this.projects.has(projectId) ? this.account : null; }
  // Whether sessions start with allow-all tool permissions. Without them, as for a detached session
  // in app 1.1.30, a shell command that host policy doesn't approve waits for a user.
  allowAll = true;

  constructor(stateDir: string, clock: { now: number }, scenarios: Scenario[]) {
    this.stateDir = stateDir;
    this.clock = clock;
    this.scenarios = scenarios;
    mkdirSync(stateDir, { recursive: true });
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}-${String(this.seq).padStart(4, "0")}`;
  }

  private write(id: string, type: string, data: Record<string, unknown> = {}, agentId?: string): void {
    const event: LogEvent = { type, timestamp: new Date(this.clock.now).toISOString(), data };
    if (agentId) event.agentId = agentId;
    appendFileSync(join(this.stateDir, id, "events.jsonl"), JSON.stringify(event) + "\n");
  }

  private newSessionDir(id: string, repository: string): void {
    mkdirSync(join(this.stateDir, id), { recursive: true });
    writeFileSync(join(this.stateDir, id, "workspace.yaml"), `id: ${id}\nrepository: ${repository}\ncreated_at: ${new Date(this.clock.now).toISOString()}\n`);
  }

  createProject(path: string): string {
    for (const [id, project] of this.projects) if (project.path === path) return id;
    const id = this.id("proj");
    this.projects.set(id, { path, repository: basename(path) });
    return id;
  }

  createSession(args: Record<string, unknown>): string {
    const project = this.projects.get(String(args.project_id));
    if (!project) throw new Error(`no project ${String(args.project_id)}`);
    if (args.detached !== true || args.coordinate_with_creator !== false) throw new Error("a run must be detached and uncoordinated");
    const kickoff = args.kickoff as Record<string, unknown>;
    const scenario = this.scenarios.shift() ?? "silent";
    const appId = this.id("ws");
    const id = this.id("sess");
    this.newSessionDir(id, project.repository);
    this.write(id, "session.start", { selectedModel: kickoff.model, reasoningEffort: kickoff.reasoning_effort, contextTier: kickoff.context_tier, copilotVersion: "rehearsal" });
    if (kickoff.agent) this.write(id, "subagent.selected", { agentName: kickoff.agent });
    this.write(id, "system.message", { role: "system", content: "You are a rehearsal session. No memories." });
    this.write(id, "user.message", { content: kickoff.prompt });
    this.write(id, "assistant.turn_start");
    this.write(id, "session.usage_record", { usage: { model: kickoff.model, inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 100, interactionType: "conversation-agent" } });
    this.sessions.set(appId, {
      appId,
      id,
      projectId: String(args.project_id),
      repository: project.repository,
      scenario,
      stage: 0,
      nextAt: this.clock.now + MIN,
      children: [],
      stopped: false,
      createdAt: new Date(this.clock.now).toISOString(),
      prompt: String(kickoff.prompt ?? ""),
    });
    // As in the app: the result names the Copilot session ID, not the workspace ID.
    return id;
  }

  // The app's session tools accept either the workspace ID or the Copilot session ID.
  private find(anyId: string): FakeSession | undefined {
    return this.sessions.get(anyId) ?? [...this.sessions.values()].find((session) => session.id === anyId);
  }

  getSession(appId: string): { awaiting_input: { request_id: string; question: string } | null } {
    const session = this.find(appId);
    return { awaiting_input: session?.ask ? { request_id: session.ask.requestId, question: session.ask.question } : null };
  }

  answer(appId: string, requestId: string, text: string): void {
    const session = this.find(appId);
    if (!session?.ask || session.ask.requestId !== requestId) throw new Error("no such pending question");
    this.write(session.id, "tool.execution_complete", { toolCallId: session.ask.toolCallId, success: true, result: { content: `The user answered: ${text}` } });
    session.answered = text;
    session.ask = undefined;
    session.nextAt = this.clock.now + 30_000;
  }

  send(appId: string, text: string): void {
    const session = this.find(appId);
    if (!session) throw new Error(`no session ${appId}`);
    this.write(session.id, "user.message", {
      content: text,
      transformedContent: `<cross_session_message>\nfrom_session_id: driver-rehearsal\n\n${text}\n</cross_session_message>`,
      source: this.driverSource,
    });
    if (text.startsWith("This run is over")) session.stopped = true;
    session.answered = text;
    session.nextAt = this.clock.now + 30_000;
  }

  private message(session: FakeSession, text: string, end = true): void {
    this.write(session.id, "assistant.message", { messageId: this.id("msg"), content: text });
    if (end) this.write(session.id, "assistant.turn_end");
  }

  private openAsk(session: FakeSession, question: string): void {
    const toolCallId = this.id("call");
    this.write(session.id, "tool.execution_start", { toolName: "ask_user", toolCallId, arguments: { question, choices: ["yes", "no"] } });
    session.ask = { toolCallId, requestId: this.id("req"), question };
  }

  // A permission request as a session without allow-all logs it; open until something completes it.
  private requestPermission(id: string, toolCallId: string, command: string, agentId?: string): string {
    const requestId = this.id("perm");
    this.write(id, "permission.requested", {
      requestId,
      permissionRequest: { kind: "shell", toolCallId, fullCommandText: command, canOfferSessionApproval: false },
      agentMode: "interactive",
      permissionMode: "manual",
    }, agentId);
    return requestId;
  }

  // A shell call: it completes at once with allow-all permissions, and otherwise waits on a prompt.
  private shell(s: FakeSession, command: string, output: string): boolean {
    const toolCallId = this.id("call");
    this.write(s.id, "tool.execution_start", { toolName: "bash", toolCallId, arguments: { command } });
    if (!this.allowAll) {
      this.requestPermission(s.id, toolCallId, command);
      return false;
    }
    this.write(s.id, "tool.execution_complete", { toolCallId, success: true, result: { content: output } });
    return true;
  }

  private child(session: FakeSession): string {
    const id = this.id("child");
    const toolCallId = this.id("create-child");
    this.write(session.id, "tool.execution_start", { toolName: "create_session", toolCallId });
    this.newSessionDir(id, session.repository);
    this.write(id, "session.start", { selectedModel: "claude-sonnet-5.5", reasoningEffort: "medium" });
    this.write(id, "user.message", { transformedContent: "<cross_session_message>\nchild kickoff\n</cross_session_message>" });
    this.write(id, "session.usage_record", { usage: { model: "claude-sonnet-5.5", inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 100, outputTokens: 100, interactionType: "conversation-agent" } });
    this.write(session.id, "tool.execution_complete", { toolCallId, success: true, result: { content: `Created session 'Synthetic child' (id: ${id}) in project 'rehearsal'.` } });
    session.children.push(id);
    return id;
  }

  // Advances every session's script to the simulated time.
  tick(): void {
    for (const session of this.sessions.values()) {
      while (!session.ask && this.clock.now >= session.nextAt) {
        if (!this.advance(session)) {
          session.nextAt = Infinity;
          break;
        }
      }
    }
  }

  private advance(s: FakeSession): boolean {
    const later = (minutes: number) => (s.nextAt = this.clock.now + minutes * MIN);
    switch (s.scenario) {
      case "selftest":
        if (s.stage === 0) {
          s.stage = 1;
          const command = /exactly as written: (.+)$/m.exec(s.prompt)?.[1] ?? "pwd";
          if (!this.shell(s, command, `/tmp/selftest\n${command.split("echo ").pop()}`)) return false;
          this.openAsk(s, "[unit=selftest need=plan] Self-test: may I finish?");
          return true;
        }
        if (s.stage === 1) {
          s.stage = 2;
          this.message(s, `You answered: ${s.answered}`);
          return false;
        }
        return false;
      case "ask-final":
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "Here is the plan: four units, one per feature.", false);
          this.openAsk(s, "[unit=* need=plan] Approve this split into four units?");
          return true;
        }
        if (s.stage === 1) {
          s.stage = 2;
          this.write(s.id, "assistant.turn_end");
          const child = this.child(s);
          this.write(child, "tool.execution_start", { toolName: "bash", toolCallId: this.id("call") });
          later(12);
          return true;
        }
        if (s.stage === 2) {
          s.stage = 3;
          for (const child of s.children) this.write(child, "assistant.turn_end");
          this.write(s.id, "user.message", { source: "agent-child", transformedContent: "<cross_session_message>\nreport\n</cross_session_message>" });
          this.write(s.id, "assistant.turn_start");
          this.message(s, "All features are merged into main through pull requests and CI on main is green. The work is done.");
          return false;
        }
        return false;
      case "plain-final":
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "The spec doesn't say whether CSV import accepts semicolons. Should I accept them?");
          s.nextAt = Infinity;
          return false;
        }
        if (s.stage === 1 && s.answered) {
          s.stage = 2;
          this.write(s.id, "assistant.turn_start");
          later(8);
          return true;
        }
        if (s.stage === 2) {
          s.stage = 3;
          this.message(s, "Final report: every feature is merged and CI on main is green. The work is done.");
          return false;
        }
        return false;
      case "gave-up":
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "I've stopped. Policy and reports are merged; CSV import is unfinished and its tests fail.");
          return false;
        }
        return false;
      case "busy-child":
      case "runaway":
        // Reports done, but its child keeps working: until the stop message (busy-child) or for good (runaway).
        if (s.stage === 0) {
          s.stage = 1;
          this.child(s);
          this.message(s, "All features are merged into main and CI on main is green. The work is done.");
        }
        if (s.stopped && s.scenario === "busy-child") return false;
        for (const child of s.children) this.write(child, "tool.execution_complete", { toolCallId: this.id("call") });
        later(1);
        return true;
      case "timeout-runaway":
        // Works past the timeout, and its child ignores the stop message.
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "Working on it.");
          this.child(s);
        }
        for (const child of s.children) this.write(child, "tool.execution_complete", { toolCallId: this.id("call") });
        later(1);
        return true;
      case "permission-prompt":
        // A child's sub-agent runs a command nobody approves; the orchestrator waits on the child.
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "Started the units.");
          const child = this.child(s);
          const toolCallId = this.id("call");
          this.write(child, "tool.execution_start", { toolName: "bash", toolCallId, arguments: { command: "npm test" } }, "sub-agent-1");
          this.requestPermission(child, toolCallId, "npm test", "sub-agent-1");
        }
        return false;
      case "permission-denied":
        // In autopilot a session without allow-all denies the request at once and carries on.
        if (s.stage === 0) {
          s.stage = 1;
          const toolCallId = this.id("call");
          this.write(s.id, "tool.execution_start", { toolName: "bash", toolCallId, arguments: { command: "npm test" } });
          const requestId = this.requestPermission(s.id, toolCallId, "npm test");
          this.write(s.id, "permission.completed", { requestId, toolCallId, result: { kind: "denied-no-approval-rule-and-could-not-request-from-user" }, decisionSource: "unattended_fallback" });
          this.write(s.id, "tool.execution_complete", { toolCallId, success: false, result: { content: "Permission denied" } });
          this.message(s, "Working on it.", false);
          later(1);
          return true;
        }
        this.write(s.id, "tool.execution_complete", { toolCallId: this.id("call") });
        later(1);
        return !s.stopped;
      case "stall":
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "Starting the work now.");
          return false;
        }
        return false;
      case "timeout":
        if (s.stopped) {
          this.write(s.id, "assistant.turn_start");
          this.message(s, "Stopped. Child sessions archived.");
          return false;
        }
        if (s.stage === 0) {
          s.stage = 1;
          this.message(s, "Working on it.");
          this.child(s);
        }
        for (const child of s.children) this.write(child, "tool.execution_complete", { toolCallId: this.id("call") });
        later(5);
        return true;
      default:
        return false;
    }
  }

  // AppDb, answered from the fake's own records.
  sessionForWorkspace(appId: string): string | null {
    return this.sessions.get(appId)?.id ?? null;
  }
  workspaceForSession(id: string): string | null {
    for (const session of this.sessions.values()) if (session.id === id) return session.appId;
    return null;
  }
  interrupted = new Set<string>();
  interruption(id: string): Interruption | null {
    return { wasInterrupted: this.interrupted.has(id), reason: this.interrupted.has(id) ? "shutdown" : null };
  }
  probe(): string[] {
    return [];
  }
  takeErrors(): string[] {
    return [];
  }
  workspaces(projectId: string): WorkspaceRow[] | null {
    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId)
      .map((session) => ({ id: session.appId, sessionId: session.id, name: `${session.repository} (${session.scenario})`, archivedAt: null, createdBy: "agent", createdAt: session.createdAt }));
  }
  creatorLinks(appId: string): { creator: string | null; coordinator: string | null; createdBy: string | null } | null {
    return this.sessions.has(appId) ? { creator: null, coordinator: null, createdBy: "agent" } : null;
  }
}
