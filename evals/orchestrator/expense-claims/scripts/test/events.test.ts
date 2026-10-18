import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  chooseRunSession,
  computeTiming,
  describeSession,
  EventLogError,
  findRunSessions,
  readEventLog,
  SessionChoiceError,
  yamlScalar,
  type LogEvent,
} from "../lib/events.ts";
import { BASE, basic, childLog, ev, MIN, withEvents, writeSession } from "./fixtures/events.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-test-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("wall time runs from the kickoff to the last assistant message", () => {
  const timing = computeTiming(basic());
  assert.equal(timing.wallMs, 20 * MIN);
  assert.equal(timing.blockedMs, 0);
  assert.equal(timing.scoredMs, 20 * MIN);
  assert.equal(timing.questions, 0);
  assert.equal(timing.model, "claude-opus-5.5");
  assert.equal(timing.effort, "max");
  assert.equal(timing.copilotVersion, "1.0.99-2");
  assert.equal(timing.agent, "orchestrator");
  assert.equal(timing.start, "2026-01-01T10:01:00.000Z");
  assert.equal(timing.end, "2026-01-01T10:21:00.000Z");
  assert.deepEqual(timing.warnings, []);
});

test("ask_user time is blocked time", () => {
  const timing = computeTiming(
    withEvents(basic(), [
      ev("tool.execution_start", 3, { toolName: "ask_user", toolCallId: "q1" }),
      ev("tool.execution_complete", 5, { toolCallId: "q1" }),
    ]),
  );
  assert.equal(timing.blockedMs, 2 * MIN);
  assert.equal(timing.askUserCalls, 1);
  assert.equal(timing.questions, 1);
  assert.equal(timing.scoredMs, 18 * MIN);
});

test("an answer to a plain-text question subtracts the idle gap", () => {
  const events = [
    ...basic().slice(0, 8),
    ev("assistant.message", 11),
    ev("assistant.turn_end", 11),
    ev("user.message", 13),
    ev("assistant.turn_start", 13),
    ev("assistant.message", 21),
    ev("assistant.turn_end", 21),
  ];
  const timing = computeTiming(events);
  assert.equal(timing.blockedMs, 2 * MIN);
  assert.equal(timing.humanMessages, 1);
  assert.equal(timing.questions, 1);
});

test("a message sent while a turn runs adds no blocked time", () => {
  const timing = computeTiming(withEvents(basic(), [ev("user.message", 15, { delivery: "steering" })]));
  assert.equal(timing.blockedMs, 0);
  assert.equal(timing.questions, 1);
});

test("sub-agent events are ignored", () => {
  const timing = computeTiming(
    withEvents(basic(), [
      ev("assistant.message", 30, {}, "a1"),
      ev("tool.execution_start", 4, { toolName: "ask_user", toolCallId: "s1" }, "a1"),
      ev("tool.execution_complete", 9, { toolCallId: "s1" }, "a1"),
      ev("user.message", 4, {}, "a1"),
    ]),
  );
  assert.deepEqual(timing, computeTiming(basic()));
});

test("a model change before the kickoff is the held model; after it, a warning", () => {
  const timing = computeTiming(
    withEvents(basic(), [
      ev("session.model_change", 0.5, { newModel: "gpt-6-astra", reasoningEffort: "high" }),
      ev("session.model_change", 12, { newModel: "claude-opus-5.5", reasoningEffort: "max" }),
    ]),
  );
  assert.equal(timing.model, "gpt-6-astra");
  assert.equal(timing.effort, "high");
  assert.equal(timing.warnings.length, 1);
  assert.match(timing.warnings[0], /model/);
});

test("an unanswered ask_user counts until the end, with a warning", () => {
  const timing = computeTiming(withEvents(basic(), [ev("tool.execution_start", 20, { toolName: "ask_user", toolCallId: "q9" })]));
  assert.equal(timing.blockedMs, 1 * MIN);
  assert.equal(timing.warnings.length, 1);
});

test("an unfinished run is timed to the given end, not to its last progress message", () => {
  const events = [
    ev("session.start", 0, { selectedModel: "claude-opus-5.5", reasoningEffort: "max" }),
    ev("user.message", 1),
    ev("assistant.turn_start", 1),
    ev("assistant.message", 2),
    ev("tool.execution_start", 50, { toolName: "ask_user", toolCallId: "q1" }),
  ];
  const endAt = BASE + 95 * MIN;
  const timing = computeTiming(events, { endAt });
  assert.equal(timing.wallMs, 94 * MIN);
  assert.equal(timing.end, new Date(endAt).toISOString());
  assert.equal(timing.blockedMs, 45 * MIN);
  assert.equal(timing.scoredMs, 49 * MIN);
});

test("with an end time, a run with no assistant message is not an error", () => {
  const timing = computeTiming([ev("session.start", 0), ev("user.message", 1)], { endAt: BASE + 91 * MIN });
  assert.equal(timing.wallMs, 90 * MIN);
});

test("an end time before the kickoff is an error", () => {
  assert.throws(() => computeTiming(basic(), { endAt: BASE }), EventLogError);
});

test("no kickoff is an error", () => {
  const events = basic().filter((event) => !(event.type === "user.message" && Object.keys(event.data ?? {}).length === 0));
  assert.throws(() => computeTiming(events), EventLogError);
});

test("no assistant message after the kickoff is an error", () => {
  assert.throws(() => computeTiming([ev("session.start", 0), ev("user.message", 1)]), EventLogError);
});

test("readEventLog tolerates a torn last line", () => {
  const path = join(dir, "torn.jsonl");
  const lines = [ev("session.start", 0), ev("user.message", 1)].map((event) => JSON.stringify(event));
  writeFileSync(path, [...lines, '{"type":"assistant.mess'].join("\n"));
  const { events, warnings } = readEventLog(path);
  assert.equal(events.length, 2);
  assert.equal(warnings.length, 1);
});

test("readEventLog rejects a malformed last line that ends with a newline", () => {
  const path = join(dir, "bad-last.jsonl");
  const lines = [ev("session.start", 0), ev("user.message", 1)].map((event) => JSON.stringify(event));
  writeFileSync(path, [...lines, '{"type":"assistant.mess'].join("\n") + "\n");
  assert.throws(() => readEventLog(path), (error: unknown) => error instanceof EventLogError && /line 3/i.test(error.message));
});

test("readEventLog rejects a bad line in the middle", () => {
  const path = join(dir, "bad.jsonl");
  writeFileSync(path, [JSON.stringify(ev("session.start", 0)), "not json", JSON.stringify(ev("user.message", 1))].join("\n") + "\n");
  assert.throws(() => readEventLog(path), (error: unknown) => error instanceof EventLogError && /line 2/i.test(error.message));
});

test("readEventLog reports a missing file", () => {
  assert.throws(() => readEventLog(join(dir, "nope.jsonl")), EventLogError);
});

test("findRunSessions picks sessions by repository, oldest first", () => {
  const stateDir = join(dir, "state");
  const sessions: Record<string, string | null> = {
    s1: "repository: ncksol/orch-eval-x-1\ncreated_at: 2026-01-01T10:05:00Z\n",
    s2: "repository: ncksol/orch-eval-x-1\ncreated_at: 2026-01-01T10:00:00Z\n",
    s3: "repository: ncksol/ai_tools\ncreated_at: 2026-01-01T09:00:00Z\n",
    s4: null,
  };
  for (const [id, yaml] of Object.entries(sessions)) {
    mkdirSync(join(stateDir, id), { recursive: true });
    if (yaml !== null) writeFileSync(join(stateDir, id, "workspace.yaml"), yaml);
  }
  assert.deepEqual(
    findRunSessions(stateDir, "ncksol/orch-eval-x-1").map((session) => session.id),
    ["s2", "s1"],
  );
});

const REPO = "ncksol/orch-eval-orchestrator-1";

function stateWith(name: string, sessions: [string, string, LogEvent[] | null][]): string {
  const stateDir = join(dir, name);
  for (const [id, createdAt, events] of sessions) writeSession(stateDir, id, REPO, createdAt, events);
  writeSession(stateDir, "other-repo", "ncksol/ai_tools", "2026-01-01T09:00:00Z", basic());
  return stateDir;
}

test("describeSession tells a session the user started from one another session started", () => {
  const stateDir = stateWith("describe", [
    ["user", "2026-01-01T10:00:00Z", basic()],
    ["tagged", "2026-01-01T10:20:00Z", childLog("session-worker")],
    ["from-agent", "2026-01-01T10:20:00Z", [ev("user.message", 21, { source: "agent-workspace-1" })]],
    ["runtime-first", "2026-01-01T10:20:00Z", [ev("user.message", 20, { source: "system" }), ev("user.message", 21)]],
    ["empty-log", "2026-01-01T10:20:00Z", [ev("session.start", 20)]],
    ["no-log", "2026-01-01T09:00:00Z", null],
  ]);
  const describe = (id: string) => describeSession(join(stateDir, id));
  assert.deepEqual(describe("user"), { hasLog: true, startedBy: "user", agent: "orchestrator" });
  assert.deepEqual(describe("tagged"), { hasLog: true, startedBy: "session", agent: "session-worker" });
  assert.deepEqual(describe("from-agent"), { hasLog: true, startedBy: "session", agent: null });
  assert.deepEqual(describe("runtime-first"), { hasLog: true, startedBy: "user", agent: null });
  assert.deepEqual(describe("empty-log"), { hasLog: true, startedBy: "none", agent: null });
  assert.deepEqual(describe("no-log"), { hasLog: false, startedBy: null, agent: null });
});

test("chooseRunSession skips a stray session with no log and the orchestrator's child sessions", () => {
  const stateDir = stateWith("run1-shape", [
    ["stray", "2026-01-01T09:00:00Z", null],
    ["orch", "2026-01-01T10:00:00Z", basic()],
    ["child-1", "2026-01-01T10:20:00Z", childLog()],
    ["child-2", "2026-01-01T10:20:01Z", childLog()],
    ["child-3", "2026-01-01T10:30:00Z", [ev("user.message", 31, { source: "agent-workspace-1" })]],
    ["child-4", "2026-01-01T10:40:00Z", null],
  ]);
  const chosen = chooseRunSession(stateDir, REPO, "orchestrator");
  assert.equal(chosen.session.id, "orch");
  assert.equal(chosen.rule, `the only session for ${REPO} that you started`);
});

test("chooseRunSession stops and lists the sessions when none was started by the user", () => {
  const stateDir = stateWith("none", [
    ["stray", "2026-01-01T09:00:00Z", null],
    ["child-1", "2026-01-01T10:20:00Z", childLog()],
  ]);
  assert.throws(
    () => chooseRunSession(stateDir, REPO, "orchestrator"),
    (error: Error) => {
      assert.ok(error instanceof SessionChoiceError);
      assert.match(error.message, /None of the 2 session\(s\) for ncksol\/orch-eval-orchestrator-1 was started by you/);
      assert.match(error.message, /stray {2}created 2026-01-01T09:00:00Z {2}agent none {2}no event log/);
      assert.match(error.message, /child-1 {2}created 2026-01-01T10:20:00Z {2}agent none {2}started by another session/);
      assert.match(error.message, /Rerun with --session <id>\.$/);
      assert.doesNotMatch(error.message, /other-repo/);
      return true;
    },
  );
  assert.throws(() => chooseRunSession(join(dir, "none"), "ncksol/nothing", "orchestrator"), /No session in .* has repository ncksol\/nothing/);
});

test("chooseRunSession narrows several user-started sessions by the variant's agent, or stops", () => {
  const helper = basic().filter((event) => event.type !== "subagent.selected");
  const stateDir = stateWith("several", [
    ["orch", "2026-01-01T10:00:00Z", basic()],
    ["helper", "2026-01-01T10:05:00Z", helper],
  ]);
  assert.equal(chooseRunSession(stateDir, REPO, "orchestrator").session.id, "orch");
  assert.throws(
    () => chooseRunSession(stateDir, REPO, "session-orchestrator"),
    (error: Error) => {
      assert.ok(error instanceof SessionChoiceError);
      assert.match(error.message, /2 sessions for .* were started by you, and none of them used agent session-orchestrator/);
      assert.match(error.message, /orch {2}created 2026-01-01T10:00:00Z {2}agent orchestrator {2}started by you/);
      assert.match(error.message, /helper {2}created 2026-01-01T10:05:00Z {2}agent none {2}started by you/);
      return true;
    },
  );
  writeSession(stateDir, "orch-again", REPO, "2026-01-01T11:00:00Z", basic());
  assert.throws(() => chooseRunSession(stateDir, REPO, "orchestrator"), /3 sessions .* and 2 of them used agent orchestrator/);
});

test("yamlScalar reads plain and quoted values", () => {
  const text = "a: 1\nrepository: 'o/r'\nname: \"x y\"\n";
  assert.equal(yamlScalar(text, "repository"), "o/r");
  assert.equal(yamlScalar(text, "name"), "x y");
  assert.equal(yamlScalar(text, "missing"), null);
});
