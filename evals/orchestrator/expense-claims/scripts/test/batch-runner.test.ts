import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LogEvent } from "../lib/events.ts";
import { validateConfig } from "../lib/batch/state.ts";
import { STOP_MESSAGE } from "../lib/batch/runner.ts";
import { eventsPath } from "../lib/batch/swarm.ts";
import { run as runProc } from "../lib/proc.ts";
import { readResults } from "../lib/results.ts";
import { FIXTURE_HEADER, harness, type Harness } from "./fixtures/batch.ts";

const made: Harness[] = [];
async function make(opts: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(opts);
  made.push(h);
  return h;
}
after(() => {
  for (const h of made) rmSync(h.dir, { recursive: true, force: true });
});

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function appendEvent(h: Harness, sessionId: string, type: string, data: Record<string, unknown>, agentId?: string): void {
  const event: LogEvent = { type, timestamp: new Date(h.clock.now).toISOString(), data };
  if (agentId) event.agentId = agentId;
  appendFileSync(eventsPath(h.config.stateDir, sessionId), JSON.stringify(event) + "\n");
}

function finalTimestamp(h: Harness, sessionId: string, text: RegExp): string {
  const lines = readFileSync(eventsPath(h.config.stateDir, sessionId), "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEvent);
  return lines.filter((e) => e.type === "assistant.message" && text.test(String(e.data?.content))).at(-1)!.timestamp;
}

test("a run with a question and a final report: answered from the sheet, scored with --end-at at the report's exact time, committed", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const done = await h.until(() => false);
  assert.equal(done.action, "done");
  const state = h.state();
  const run = state.runs[0];
  assert.equal(run.status, "done");
  assert.deepEqual(run.answers.map((a) => [a.kind, a.row, a.text]), [["ask_user", 1, "Approved. Go ahead."]]);
  assert.equal(h.scoreCalls.length, 1);
  const args = h.scoreCalls[0];
  assert.equal(flag(args, "--end-at"), finalTimestamp(h, run.sessionId!, /The work is done/));
  assert.equal(flag(args, "--session"), run.sessionId);
  assert.equal(flag(args, "--outcome"), undefined);
  assert.equal(flag(args, "--answer-source"), undefined, "no plain-text reply, so no --answer-source");
  assert.ok(args.includes("--no-github"));
  const log = await runProc("git", ["log", "--format=%s"], { cwd: h.resultsRepo });
  assert.match(log.stdout, /^chore\(evals\): record variant-a run 1 \(passed\)$/m);
  const body = await runProc("git", ["log", "-1", "--format=%B"], { cwd: h.resultsRepo });
  assert.doesNotMatch(body.stdout, /Co-authored-by/i);
  assert.deepEqual(h.notices.map((n) => n.key), ["batch-started", "run-variant-a-1", "batch-done"]);
  assert.deepEqual(h.awake, { started: 1, stopped: 1 });
  assert.equal(state.phase, "done");
  assert.match(readFileSync(state.reportPath!, "utf8"), /Turn Copilot Memory back on/);
});

test("a plain-text question is answered with send_message, flagged, and its observed source goes to --answer-source", async () => {
  const h = await make({ scenarios: ["plain-final"] });
  const sent: string[] = [];
  await h.until((action) => {
    if (action.action === "send_message") sent.push(String(action.tool!.args.message));
    return false;
  });
  const run = h.state().runs[0];
  assert.deepEqual(sent, ["Follow docs/spec-v2.md. Where it is silent, make a reasonable call and note it in the PR description."]);
  assert.ok(run.flags.some((f) => f.code === "plain-text-question"));
  assert.equal(run.answerSource, h.app.driverSource);
  assert.equal(flag(h.scoreCalls[0], "--answer-source"), h.app.driverSource);
  assert.equal(flag(h.scoreCalls[0], "--end-at"), finalTimestamp(h, run.sessionId!, /Final report/));
});

test("a timeout is scored at 90 minutes with --outcome timeout; only then is the stop message sent, and the swarm drains", async () => {
  const h = await make({ scenarios: ["timeout", "silent"] });
  const order: string[] = [];
  await h.until((action, state) => {
    if (action.action === "send_message") order.push(`send after ${state.runs[0].scoredAt ? "scoring" : "NOTHING"}`);
    return state.runs.length === 2;
  });
  const state = h.state();
  const run = state.runs[0];
  assert.equal(flag(h.scoreCalls[0], "--outcome"), "timeout");
  assert.equal(flag(h.scoreCalls[0], "--end-at"), undefined);
  assert.deepEqual(order, ["send after scoring"]);
  assert.ok(Date.parse(run.scoredAt!) - Date.parse(run.kickoffAt!) >= 90 * 60_000);
  assert.ok(Date.parse(run.scoredAt!) - Date.parse(run.kickoffAt!) < 91 * 60_000, "scored at once");
  assert.ok(run.stopSentAt);
  assert.equal(run.status, "done");
  assert.ok(!run.flags.some((f) => f.code === "swarm-not-quiet"));
  // With no history the timed-out run was a calibration run; an unfinished calibration run drops Summary.
  assert.deepEqual(state.runs[1].features, ["policy", "reports", "import"]);
  assert.equal(state.runs[1].calibration, false);
});

test("a stall is scored after 15 quiet minutes, and open tool calls are flagged as possible prompts", async () => {
  const h = await make({ scenarios: ["stall"] });
  let added = false;
  await h.until((action, state) => {
    const run = state.runs[0];
    if (!added && run?.sessionId && action.action === "judge_idle") {
      appendEvent(h, run.sessionId, "tool.execution_start", { toolName: "github-mcp-server-create_pull_request", toolCallId: "mcp1" }, "sub-9");
      added = true;
    }
    return false;
  });
  const run = h.state().runs[0];
  assert.equal(flag(h.scoreCalls[0], "--outcome"), "stalled");
  const stalledAfter = Date.parse(run.scoredAt!) - Date.parse(run.kickoffAt!);
  assert.ok(stalledAfter >= 15 * 60_000 && stalledAfter < 20 * 60_000, `stalled after ${stalledAfter / 60_000} min`);
  assert.ok(run.flags.some((f) => f.code === "open-tool-at-stall" && /github-mcp-server-create_pull_request/.test(f.detail)));
});

test("a create_session the driver made but never recorded is adopted, not repeated", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  let action = await h.next();
  h.drive(action); // create_project
  action = await h.next();
  assert.equal(action.action, "create_session");
  h.app.createSession(action.tool!.args); // the driver called the tool, then died before recording it
  const again = await h.next();
  assert.notEqual(again.action, "create_session");
  const run = h.state().runs[0];
  assert.equal(run.status, "running");
  assert.equal(run.appSessionId, h.app.workspaceForSession(run.sessionId!));
  assert.equal(h.app.sessions.size, 1);
});

test("a pending action is re-issued until it is recorded; unknown and repeated ids are handled", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const first = await h.next();
  const second = await h.next();
  assert.equal(second.id, first.id);
  assert.equal(second.reissued, true);
  assert.throws(() => h.record({ action: "a99", projectId: "p" }), /not the pending action/);
  assert.match(h.record({ action: first.id!, projectId: h.app.createProject(String(first.tool!.args.path)) }), /recorded/);
  assert.match(h.record({ action: first.id!, projectId: "p" }), /already recorded/);
});

test("the batch resumes from its files: a fresh process picks up where the last one stopped", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  h.drive(await h.next()); // create_project
  h.drive(await h.next()); // create_session
  // A new runner context (new process, empty caches) on the same batch folder.
  const { makeCtx, next } = await import("../lib/batch/runner.ts");
  const ctx2 = makeCtx(h.config, h.ctx.deps);
  const action = await next(ctx2, { maxWaitMs: 540_000 });
  assert.equal(action.action, "answer_question");
  assert.equal(action.details?.row, 1);
});

test("an ask_user without free text: the chosen choice is recorded and the run flagged", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const action = await h.until((a) => a.action === "answer_question");
  h.record({ action: action.id!, answered: true, choice: "yes" });
  const run = h.state().runs[0];
  assert.ok(run.flags.some((f) => f.code === "choice-answer" && /"yes" for row 1/.test(f.detail)));
});

test("memory use and history queries anywhere in the swarm are flagged after scoring", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  let added = false;
  await h.until((action, state) => {
    const run = state.runs[0];
    if (!added && run?.status === "running" && h.app.sessions.size > 0) {
      const child = [...h.app.sessions.values()][0].children[0];
      if (child) {
        appendEvent(h, child, "tool.execution_start", { toolName: "store_memory", toolCallId: "m1" });
        appendEvent(h, child, "tool.execution_start", { toolName: "session_store_sql", toolCallId: "h1" }, "sub-1");
        appendEvent(h, run.sessionId!, "system.message", { content: "<memories>\n## User memories for @x\n- fact\n</memories>" });
        added = true;
      }
    }
    return false;
  });
  const codes = h.state().runs[0].flags.map((f) => f.code).sort();
  assert.deepEqual(codes, ["history-query", "memory-loaded", "memory-write"]);
  assert.deepEqual(h.notices.find((n) => n.key === "run-variant-a-1")!.body.match(/Flags: (.*)\.$/)![1].split(", ").sort(), ["history-query", "memory-loaded", "memory-write"]);
});

test("a driver that was away for over 10 minutes during a run is flagged", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.until((action) => action.action === "answer_question");
  h.clock.now += 25 * 60_000;
  h.app.tick();
  await h.until(() => false);
  assert.ok(h.state().runs[0].flags.some((f) => f.code === "driver-gap"));
});

test("changed agent files stop the batch before the next run", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  await h.until((action) => action.action === "answer_question");
  writeFileSync(join(h.config.agentsDir, "variant-a-worker.agent.md"), "worker, edited mid-batch\n");
  const done = await h.until(() => false);
  const state = h.state();
  assert.equal(state.phase, "stopped");
  assert.equal(state.runs.length, 1);
  assert.match(String(done.details?.reason), /pinned inputs changed: agent variant-a-worker changed/);
  assert.ok(h.notices.some((n) => n.key === "batch-stopped"));
});

test("no new run starts after the deadline", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2, deadlineMin: 10 });
  const done = await h.until(() => false);
  assert.equal(h.state().runs.length, 1);
  assert.match(String(done.details?.reason), /deadline/);
  assert.equal(h.state().phase, "done");
});

test("two runs in a row that fail to start stop the batch", async () => {
  const h = await make({ scenarios: [], runsPerVariant: 3 });
  for (let i = 0; i < 2; i++) {
    const action = await h.next();
    assert.equal(action.action, "create_project");
    h.record({ action: action.id!, failed: "tool not available" });
  }
  const done = await h.next();
  assert.equal(done.action, "done");
  assert.equal(h.state().phase, "stopped");
  assert.deepEqual(h.state().runs.map((r) => [r.n, r.status]), [[1, "void"], [2, "void"]]);
});

test("the self-test runs first, checks the whole path, and its pass lets the runs start", async () => {
  const h = await make({ scenarios: ["ask-final"], selfTest: true });
  await h.until(() => false);
  const state = h.state();
  assert.equal(state.selftests[0].status, "passed");
  assert.ok(state.selftests[0].checks.length >= 9);
  assert.ok(state.selftests[0].checks.every((c) => c.ok), JSON.stringify(state.selftests[0].checks));
  assert.equal(state.runs.length, 1);
  const kickoff = [...h.app.sessions.values()][0];
  assert.equal(kickoff.scenario, "selftest");
});

test("a failed self-test (memories loaded) stops the batch before any run", async () => {
  const h = await make({ scenarios: ["ask-final"], selfTest: true });
  await h.until((action, state) => {
    const test = state.selftests[0];
    if (action.action === "judge_idle" && test?.sessionId) appendEvent(h, test.sessionId, "system.message", { content: "<memories>\n## User memories for @x\n</memories>" });
    return false;
  });
  const state = h.state();
  assert.equal(state.selftests[0].status, "failed");
  assert.match(state.selftests[0].failure!, /no memories loaded/);
  assert.equal(state.runs.length, 0);
  assert.equal(state.phase, "stopped");
  assert.deepEqual(h.notices.map((n) => n.key), ["batch-started", "selftest-1", "batch-stopped"]);
});

test("score warnings become flags; the cross-session kickoff warning flags the kickoff", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const exec = h.ctx.deps.exec;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    const result = await exec(cmd, args, opts);
    if (args[0] === h.config.scoreScript) return { ...result, stdout: "Warning: the first top-level user.message came from another session\nWarning: gh pr list failed: offline\n" };
    return result;
  };
  await h.until(() => false);
  const flags = h.state().runs[0].flags.map((f) => `${f.code}: ${f.detail}`);
  assert.ok(flags.includes("kickoff-shape: score: the first top-level user.message came from another session"));
  assert.ok(flags.includes("score-warning: gh pr list failed: offline"));
});

test("today's results.csv puts every scored run on the three-feature set", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], variants: ["orchestrator", "session-orchestrator"], results: readFileSync(join(process.cwd(), "results.csv"), "utf8") });
  await h.until(() => false);
  const rows = readResults(h.config.resultsPath).slice(1);
  assert.deepEqual(rows.map((r) => [r.variant, r.run, r.features, r.calibration]), [
    ["orchestrator", "2", "policy+reports+import", "no"],
    ["session-orchestrator", "1", "policy+reports+import", "no"],
  ]);
  assert.match(h.state().calibration, /over 30 minutes even if every missing calibration run took 0 minutes/);
  for (const session of h.app.sessions.values()) assert.ok(["orchestrator", "session-orchestrator"].includes(readFileSync(eventsPath(h.config.stateDir, session.id), "utf8").match(/"agentName":"([^"]+)"/)![1]));
});

test("the self-test never uses an orchestrator or a variant under test", () => {
  const base = { variants: ["orchestrator", "session-orchestrator"], runsPerVariant: 3, selfTest: { enabled: true, only: false, model: "m", effort: "low", agent: "orchestrator" } };
  assert.match(validateConfig(base as never).join(), /must not use the agent "orchestrator"/);
  assert.match(validateConfig({ ...base, selfTest: { ...base.selfTest, agent: "session-orchestrator" } } as never).join(), /must not use/);
  assert.deepEqual(validateConfig({ ...base, selfTest: { ...base.selfTest, agent: null } } as never), []);
});

test("an empty results.csv still works", async () => {
  const h = await make({ scenarios: ["ask-final"], results: FIXTURE_HEADER });
  await h.until(() => false);
  assert.equal(readResults(h.config.resultsPath)[0].calibration, "yes");
  assert.equal(STOP_MESSAGE.startsWith("This run is over"), true);
});
