import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { LogEvent } from "../lib/events.ts";
import {
  findReplySource,
  idleCandidate,
  kickoffText,
  LogCache,
  looksLikeFinal,
  looksLikeQuestion,
  messageArrived,
  orchestratorView,
  SessionIndex,
  swarmView,
} from "../lib/batch/swarm.ts";
import { BASE, ev, MIN, writeSession } from "./fixtures/events.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-swarm-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const settle = { idleSettleMs: 20_000, swarmSettleMs: 60_000 };

function run(extra: LogEvent[] = []): LogEvent[] {
  return [
    ev("session.start", 0, { selectedModel: "claude-opus-5.5", reasoningEffort: "max", contextTier: "long_context" }),
    ev("subagent.selected", 0, { agentName: "orchestrator" }),
    ev("user.message", 1, { content: "kickoff text" }),
    ev("assistant.turn_start", 1),
    ...extra,
  ];
}

test("the kickoff, agent, model, effort and context tier are read like score reads them", () => {
  const view = orchestratorView(run([ev("assistant.message", 2, { messageId: "m1", content: "hi" }), ev("assistant.turn_end", 2)]));
  assert.equal(view.startedBy, "user");
  assert.equal(kickoffText(view), "kickoff text");
  assert.deepEqual([view.agent, view.model, view.effort, view.contextTier], ["orchestrator", "claude-opus-5.5", "max", "long_context"]);
  assert.equal(view.openTurn, false);
});

test("a kickoff with a source or a cross-session tag is not the user's", () => {
  const tagged = orchestratorView([ev("user.message", 1, { transformedContent: "<cross_session_message>\nx\n</cross_session_message>" })]);
  assert.equal(tagged.startedBy, "session");
  const sourced = orchestratorView([ev("user.message", 1, { source: "agent-abc", content: "x" })]);
  assert.equal(sourced.startedBy, "session");
  const runtime = orchestratorView([ev("user.message", 0, { source: "system", content: "x" }), ev("user.message", 1, { content: "y" })]);
  assert.equal(runtime.startedBy, "user");
});

test("an open ask_user is found with its question and choices; a completed one is not open", () => {
  const open = orchestratorView(run([ev("tool.execution_start", 3, { toolName: "ask_user", toolCallId: "q1", arguments: { question: "[unit=* need=plan] Approve?", choices: ["yes", "no"] } })]));
  assert.deepEqual(open.openAsk, { toolCallId: "q1", question: "[unit=* need=plan] Approve?", choices: ["yes", "no"], allowFreeform: true, timestamp: new Date(BASE + 3 * MIN).toISOString() });
  const noFree = orchestratorView(run([ev("tool.execution_start", 3, { toolName: "ask_user", toolCallId: "q1", arguments: { question: "Pick", choices: ["a"], allow_freeform: false } })]));
  assert.equal(noFree.openAsk?.allowFreeform, false);
  const done = orchestratorView(
    run([
      ev("tool.execution_start", 3, { toolName: "ask_user", toolCallId: "q1", arguments: { question: "Q" } }),
      ev("tool.execution_complete", 4, { toolCallId: "q1", result: { content: "Approved. Go ahead." } }),
    ]),
  );
  assert.equal(done.openAsk, null);
  assert.equal(done.askCalls[0].completed, true);
  assert.match(done.askCalls[0].resultText, /Approved\. Go ahead\./);
});

test("sub-agent events don't make the orchestrator busy or ask questions", () => {
  const view = orchestratorView(
    run([
      ev("assistant.turn_end", 2),
      ev("assistant.turn_start", 3, {}, "sub1"),
      ev("tool.execution_start", 3, { toolName: "ask_user", toolCallId: "s1", arguments: { question: "?" } }, "sub1"),
    ]),
  );
  assert.equal(view.openTurn, false);
  assert.equal(view.openAsk, null);
});

test("chunked messages are joined and keep the exact timestamp string of their last event", () => {
  const precise = "2026-01-01T10:21:00.1234567Z";
  const events = run([
    ev("assistant.message", 20, { messageId: "m9", content: "All merged. ", chunkIndex: 0 }),
    { type: "assistant.message", timestamp: precise, data: { messageId: "m9", content: "The work is done.", chunkIndex: 1 } },
    ev("assistant.message", 21, { messageId: "m10", content: "" }),
    ev("assistant.turn_end", 21),
  ]);
  const view = orchestratorView(events);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].text, "All merged. The work is done.");
  assert.equal(view.messages[0].timestamp, precise);
});

test("the question and final-report hints", () => {
  assert.equal(looksLikeQuestion("Plan below.\n\nShould I accept semicolons?"), true);
  assert.equal(looksLikeQuestion("Let me know which option you prefer."), true);
  assert.equal(looksLikeQuestion("Working on the policy unit."), false);
  assert.equal(looksLikeFinal("All four PRs are merged and CI is green. The work is done."), true);
  assert.equal(looksLikeFinal("Started the reports unit."), false);
});

test("idle candidates: offered when the swarm is quiet, or sooner for a question or final report", () => {
  const now = BASE + 30 * MIN;
  const events = run([ev("assistant.message", 29, { messageId: "m1", content: "Waiting for the units." }), ev("assistant.turn_end", 29)]);
  const orch = orchestratorView(events);
  const busy = swarmView([{ id: "o", events }, { id: "c", events: [ev("tool.execution_complete", 29.9, { toolCallId: "x" })] }]);
  assert.equal(idleCandidate(orch, busy, now, [], settle), null, "children active, plain status message");
  const quiet = swarmView([{ id: "o", events }]);
  const candidate = idleCandidate(orch, quiet, now, [], settle);
  assert.deepEqual(candidate?.messages.map((m) => m.messageId), ["m1"]);
  assert.equal(candidate?.swarmQuiet, true);
  assert.equal(idleCandidate(orch, quiet, now, ["m1"], settle), null, "already judged");
  assert.equal(idleCandidate(orch, quiet, BASE + 29 * MIN + 10_000, [], settle), null, "not settled yet");

  const asking = run([ev("assistant.message", 29, { messageId: "m2", content: "Should I accept semicolons?" }), ev("assistant.turn_end", 29)]);
  const offer = idleCandidate(orchestratorView(asking), busy, now, [], settle);
  assert.equal(offer?.swarmQuiet, false);
  assert.match(offer?.reason ?? "", /question/);

  const working = run([ev("assistant.message", 29, { messageId: "m3", content: "Done?" }), ev("tool.execution_start", 29, { toolName: "bash", toolCallId: "b1" })]);
  assert.equal(idleCandidate(orchestratorView(working), quiet, now, [], settle), null, "an open tool call means busy");
});

test("swarm activity, open tools and permission prompts across sessions", () => {
  const swarm = swarmView([
    { id: "o", events: [ev("assistant.turn_end", 10)] },
    {
      id: "c1",
      events: [
        ev("tool.execution_start", 12, { toolName: "bash", toolCallId: "b1" }),
        ev("permission.requested", 12, { requestId: "p1" }),
        ev("permission.requested", 12, { requestId: "p2" }),
        ev("permission.completed", 13, { requestId: "p2", decisionSource: "unattended_fallback", result: { kind: "denied" } }),
      ],
    },
  ]);
  assert.equal(swarm.lastActivityAt, BASE + 13 * MIN);
  const child = swarm.sessions.find((s) => s.id === "c1")!;
  assert.deepEqual(child.openTools.map((t) => t.toolName), ["bash"]);
  assert.equal(child.pendingPermissions, 1);
  assert.equal(child.unattendedDenials, 1);
});

test("the driver's reply source is read from the log, not guessed", () => {
  const reply = "Your call. Don't wait for me.";
  const events = run([
    ev("user.message", 5, { source: "agent-child-1", transformedContent: "<cross_session_message>\nreport\n</cross_session_message>" }),
    ev("user.message", 9, { source: "agent-1234abcd", content: reply, transformedContent: `<cross_session_message>\n${reply}\n</cross_session_message>` }),
  ]);
  assert.equal(findReplySource(events, reply, BASE + 8 * MIN), "agent-1234abcd");
  assert.equal(findReplySource(events, reply, BASE + 10 * MIN), null);
  assert.equal(messageArrived(events, reply, BASE + 8 * MIN), true);
  assert.equal(messageArrived(events, "other", BASE), false);
});

test("LogCache reads only complete lines and only new bytes", () => {
  const path = join(dir, "events.jsonl");
  writeFileSync(path, JSON.stringify(ev("session.start", 0)) + "\n" + '{"type":"user.mess');
  const cache = new LogCache();
  assert.equal(cache.read(path).length, 1);
  appendFileSync(path, `age","timestamp":"${new Date(BASE).toISOString()}","data":{}}\nnot json\n`);
  const events = cache.read(path);
  assert.deepEqual(events.map((e) => e.type), ["session.start", "user.message"]);
  assert.equal(cache.read(join(dir, "missing.jsonl")).length, 0);
});

test("SessionIndex finds the run's sessions by repository", () => {
  const stateDir = join(dir, "state");
  writeSession(stateDir, "s1", "ncksol/orch-eval-a-1", "2026-01-01T10:00:00Z", run());
  writeSession(stateDir, "s2", "ncksol/orch-eval-a-1", "2026-01-01T10:05:00Z", null);
  writeSession(stateDir, "s3", "ncksol/other", "2026-01-01T10:05:00Z", null);
  mkdirSync(join(stateDir, "no-yaml"));
  const index = new SessionIndex(stateDir);
  assert.deepEqual(index.forRepository("NCKSOL/orch-eval-a-1", 0).map((m) => m.id), ["s1", "s2"]);
  assert.deepEqual(index.forRepository("ncksol/orch-eval-a-1", Date.now() + 60_000).map((m) => m.id), ["s1", "s2"], "known sessions stay known");
  assert.deepEqual(new SessionIndex(stateDir).forRepository("ncksol/orch-eval-a-1", Date.now() + 60_000), [], "folders older than the window are skipped");
});
