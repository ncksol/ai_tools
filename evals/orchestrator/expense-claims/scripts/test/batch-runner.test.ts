import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LogEvent } from "../lib/events.ts";
import { saveState, validateConfig } from "../lib/batch/state.ts";
import { currentPins, requestStop, STOP_MESSAGE } from "../lib/batch/runner.ts";
import { eventsPath } from "../lib/batch/swarm.ts";
import { run as runProc } from "../lib/proc.ts";
import { readResults, replaceResult } from "../lib/results.ts";
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
const policyLabels = ["orchestrator-review-a", "orchestrator-review-b", "orchestrator-review-c"];

function pinPolicy(h: Harness) {
  const variants = Object.fromEntries(h.config.variants.map((agent) => {
    const file = join(h.config.agentsDir, `${agent}.agent.md`);
    const text = `---\nname: ${agent}\n---\nYou are the orchestrator.\n`;
    writeFileSync(file, text);
    return [agent, { agent, revision: "a".repeat(40), file, sha256: createHash("sha256").update(text).digest("hex"), workers: {} }];
  }));
  const path = join(h.dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ id: "review-policy", calibration: "all-variants-then-drop-summary", variants, workers: {} }));
  h.config.variantSet = { id: "review-policy", calibration: "all-variants-then-drop-summary", path, variants };
  saveState(h.config.dir, { ...h.state(), pins: currentPins(h.config) });
  return variants;
}

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

test("an interrupted diagnostic step preserves and commits the already-saved gate result", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const exec = h.ctx.deps.exec;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    const result = await exec(cmd, args, opts);
    if (cmd !== process.execPath || args[0] !== h.config.scoreScript) return result;
    const row = readResults(h.config.resultsPath)[0];
    replaceResult(h.config.resultsPath, row.repo, row.run, { ...row, robustness_status: "error", note: "robustness has not completed" });
    return { code: 124, stdout: "", stderr: "score timed out during robustness", timedOut: true };
  };
  await h.until(() => false);
  const state = h.state();
  assert.equal(state.runs[0].status, "done");
  assert.equal(state.runs[0].row?.outcome, "passed");
  assert.equal(state.runs[0].row?.robustness_status, "error");
  assert.equal(state.scoreFailures, 0);
  assert.equal(state.runs[0].scoreExit, 124);
  assert.ok(state.runs[0].flags.some((flag) => flag.code === "score-warning" && flag.detail.includes("saving its gate row")));
  assert.ok(!state.runs[0].flags.some((flag) => flag.code === "score-failed"));
  const commit = await runProc("git", ["log", "-1", "--format=%s"], { cwd: h.resultsRepo });
  assert.match(commit.stdout, /\(passed\)/);
});

test("the alias file ID, name and result label agree and moving ordinary agents are not pinned", async () => {
  const h = await make({ scenarios: ["silent"], variants: policyLabels });
  pinPolicy(h);
  assert.deepEqual(validateConfig(h.config), []);
  assert.match(validateConfig({ ...h.config, selfTest: { ...h.config.selfTest, agent: "orchestrator-review-a" } }).join(), /must not use/);
  assert.match(validateConfig({ ...h.config, variants: [policyLabels[0]] }).join(), /every label/);
  assert.match(validateConfig({ ...h.config, selfTest: { ...h.config.selfTest, only: true } }).join(), /self-test-only/);
  writeFileSync(join(h.config.agentsDir, "orchestrator.agent.md"), "normal installed orchestrator");
  saveState(h.config.dir, { ...h.state(), pins: currentPins(h.config) });
  writeFileSync(join(h.config.agentsDir, "orchestrator.agent.md"), "ordinary agent changed");
  const action = await h.until((a) => a.action === "create_session");
  assert.equal(action.action, "create_session");
  const kickoff = action.tool!.args.kickoff as Record<string, unknown>;
  assert.equal(kickoff.agent, "orchestrator-review-a");
  assert.equal(action.tool!.args.detached, true);
  assert.equal(h.state().runs[0].calibration, true);
});

test("pinned variants finish all three calibrations and a three-run pilot with matching provenance", async () => {
  const h = await make({ scenarios: Array.from({ length: 12 }, () => "ask-final"), variants: policyLabels, minutes: () => 40 });
  h.config.runsPerVariant = 3;
  const variants = pinPolicy(h);
  await h.until(() => false);
  const rows = readResults(h.config.resultsPath);
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.slice(0, 3).map((row) => [row.variant, row.calibration, row.features]), h.config.variants.map((variant) => [variant, "yes", "policy+reports+import+summary"]));
  assert.deepEqual(rows.slice(3).map((row) => row.variant), [...h.config.variants, ...h.config.variants, ...h.config.variants]);
  assert.ok(rows.slice(3).every((row) => row.calibration === "no" && row.features === "policy+reports+import"));
  assert.ok(rows.every((row) => row.agent_revision === "a".repeat(40) && row.agent_sha256 === variants[row.variant].sha256 && row.agent_bundle_sha256.length === 64));
  assert.ok(h.scoreCalls.every((args) => flag(args, "--app-db") === h.config.appDb));
  assert.equal(h.state().policyCalibration?.dropSummary, true);
  assert.ok(h.state().runs.every((run) => !run.flags.some((flag) => flag.code === "session-settings")));

  const firstNight = readFileSync(h.config.resultsPath, "utf8").split("\n").slice(0, 6).join("\n") + "\n";
  const second = await make({ scenarios: Array.from({ length: 7 }, () => "ask-final"), variants: policyLabels, runsPerVariant: 3, results: firstNight, minutes: () => 40 });
  pinPolicy(second);
  await second.until(() => false);
  assert.equal(second.state().runs.length, 7, "two prior scored attempts leave seven, not nine");
  assert.equal(second.state().runs[0].variant, policyLabels[2]);
  assert.ok(second.state().runs.every((run) => !run.calibration));
  assert.equal(readResults(second.config.resultsPath).length, 12);
});

test("a manifest batch stops after its first wrong-agent run without counting or freezing it", async () => {
  for (const agent of ["orchestrator", ""]) {
    const h = await make({ scenarios: ["ask-final"], variants: policyLabels });
    pinPolicy(h);
    const action = await h.until((a) => a.action === "create_session");
    await h.drive(action);
    const session = [...h.app.sessions.values()][0];
    const path = eventsPath(h.config.stateDir, session.id);
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEvent);
    const changed = events.flatMap((event) => event.type !== "subagent.selected" ? [event] :
      agent ? [{ ...event, data: { ...event.data, agentName: agent } }] : []);
    writeFileSync(path, changed.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await h.until(() => false);
    assert.equal(h.state().runs.length, 1);
    assert.equal(h.state().phase, "stopped");
    assert.equal(h.state().policyCalibration, undefined);
    assert.match(h.state().stopReason!, /logged agent.*expected/);
    assert.equal(readResults(h.config.resultsPath)[0].agent, agent);
    assert.ok(h.notices.some((notice) => notice.key === "batch-stopped"));
  }
});
test("a contradictory calibration decision stops through the usual notification and report path", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final", "ask-final"], variants: policyLabels, runsPerVariant: 3, minutes: () => 10 });
  pinPolicy(h);
  await h.until(() => false);
  assert.equal(h.state().runs.length, 3);
  assert.equal(h.state().policyCalibration?.dropSummary, false);
  assert.equal(h.state().failed, true);
  assert.match(h.state().stopReason!, /conflicts.*no-Summary.*user approval/);
  assert.match(readFileSync(h.state().reportPath!, "utf8"), /conflicts.*no-Summary/);
  assert.ok(h.notices.some((notice) => notice.key === "batch-stopped"));
});

test("a registered alias changed during a run is flagged while the launch hash remains recorded", async () => {
  const h = await make({ scenarios: ["ask-final"], variants: policyLabels });
  const variants = pinPolicy(h);
  await h.until((_, state) => state.runs[0]?.status === "running");
  const original = variants[policyLabels[0]].sha256;
  appendFileSync(variants[policyLabels[0]].file, "changed after launch\n");
  await h.until(() => false);
  const row = readResults(h.config.resultsPath)[0];
  assert.equal(row.agent_sha256, original);
  assert.match(row.note, /agent-drift/);
  assert.ok(h.state().runs[0].flags.some((flag) => flag.code === "agent-drift"));
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
  await h.drive(action); // create_project
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
  await assert.rejects(h.record({ action: "a99", projectId: "p" }), /not the pending action/);
  assert.match(await h.record({ action: first.id!, projectId: h.app.createProject(String(first.tool!.args.path)) }), /recorded/);
  assert.match(await h.record({ action: first.id!, projectId: "p" }), /already recorded/);
});

test("the batch resumes from its files: a fresh process picks up where the last one stopped", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.drive(await h.next()); // create_project
  await h.drive(await h.next()); // create_session
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
  await h.record({ action: action.id!, answered: true, choice: "yes" });
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

test("a run whose session the app stopped (restart or update) is void, not scored, and is replaced", async () => {
  const h = await make({ scenarios: ["timeout", "ask-final"] });
  await h.until((action) => action.action === "judge_idle");
  // The app restarts: the run's session stops, and so does the driver for 40 minutes.
  const session = [...h.app.sessions.values()][0];
  session.stopped = true;
  session.nextAt = Infinity;
  h.app.interrupted.add(session.id);
  h.clock.now += 40 * 60_000;
  await h.until(() => false);
  const state = h.state();
  assert.equal(state.runs[0].status, "void");
  assert.match(state.runs[0].voidReason!, /the app stopped the run's session \(shutdown\)/);
  assert.equal(h.scoreCalls.length, 1, "only the replacement run is scored");
  assert.equal(state.runs[1].status, "done");
  assert.ok(h.notices.some((n) => n.key === "void-variant-a-1"));
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

test("a round start renews the keep-awake hold only when less than half of it is left", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final", "ask-final"], runsPerVariant: 3 });
  let projects = 0;
  await h.until((action) => action.action === "create_project" && ++projects === 2);
  assert.deepEqual(h.awake, { started: 1, stopped: 0 }, "a hold with more than half of it left is kept");
  const state = h.state();
  state.caffeinate!.until = new Date(h.clock.now + 60_000).toISOString();
  saveState(h.config.dir, state);
  await h.until(() => false);
  assert.deepEqual(h.awake, { started: 2, stopped: 2 });
  assert.equal(h.state().runs.length, 3);
  assert.equal(h.state().phase, "done");
});

test("two runs in a row that fail to start stop the batch", async () => {
  const h = await make({ scenarios: [], runsPerVariant: 3 });
  for (let i = 0; i < 2; i++) {
    const action = await h.next();
    assert.equal(action.action, "create_project");
    await h.record({ action: action.id!, failed: "tool not available" });
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

test("a self-test whose project runs as another account stops the batch before any run", async () => {
  const h = await make({ scenarios: ["ask-final"], selfTest: true });
  h.app.account = "someone-else";
  await h.until(() => false);
  const state = h.state();
  assert.equal(state.selftests[0].status, "failed");
  const check = state.selftests[0].checks.find((c) => c.name === "session runs as the batch owner")!;
  assert.equal(check.ok, false);
  assert.equal(check.detail, "project account someone-else, owner ncksol");
  assert.equal(state.runs.length, 0);
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
  for (const agent of ["hands-on-orchestrator", "hands-on-session-orchestrator"]) {
    const config = { ...base, variants: ["variant-a"], selfTest: { ...base.selfTest, agent } };
    assert.match(validateConfig(config as never).join(), new RegExp(`must not use the agent "${agent}"`));
  }
});

test("a self-test session that ran a hands-on orchestrator fails its agent check", async () => {
  for (const agent of ["hands-on-orchestrator", "hands-on-session-orchestrator"]) {
    const h = await make({ scenarios: ["ask-final"], selfTest: true });
    await h.drive(await h.until((a) => a.action === "create_session"));
    const session = [...h.app.sessions.values()][0];
    assert.equal(session.scenario, "selftest");
    const path = eventsPath(h.config.stateDir, session.id);
    const events = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEvent);
    events.splice(1, 0, { type: "subagent.selected", timestamp: events[0].timestamp, data: { agentName: agent } });
    writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    await h.until(() => false);
    const state = h.state();
    assert.equal(state.selftests[0].status, "failed");
    const check = state.selftests[0].checks.find((c) => c.name === "agent")!;
    assert.deepEqual([check.ok, check.detail], [false, `selected: ${agent}`]);
    assert.equal(state.runs.length, 0);
  }
});

test("an empty results.csv still works", async () => {
  const h = await make({ scenarios: ["ask-final"], results: FIXTURE_HEADER });
  await h.until(() => false);
  assert.equal(readResults(h.config.resultsPath)[0].calibration, "yes");
  assert.equal(STOP_MESSAGE.startsWith("This run is over"), true);
});

// ---------- parallel rounds ----------

const PAIR = ["variant-a", "variant-b"];
const bothRunning = (_: unknown, state: { runs: { status: string }[] }) => state.runs.length === 2 && state.runs.every((r) => r.status === "running");

test("a round starts every variant before any is scored and commits each row on its own", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], variants: PAIR, parallel: 2 });
  const starts: { run?: string; scored: number }[] = [];
  await h.until((action) => {
    if (action.action === "create_session") starts.push({ run: action.run, scored: h.scoreCalls.length });
    return false;
  });
  assert.deepEqual(starts, [{ run: "variant-a#1", scored: 0 }, { run: "variant-b#1", scored: 0 }]);
  const state = h.state();
  assert.equal(state.phase, "done");
  assert.deepEqual(state.active, []);
  assert.deepEqual(state.runs.map((r) => [r.key, r.status]), [["variant-a#1", "done"], ["variant-b#1", "done"]]);
  assert.equal(h.scoreCalls.length, 2);
  const commits = (await runProc("git", ["log", "--format=%H %s"], { cwd: h.resultsRepo })).stdout.split("\n").filter((line) => line.includes("chore(evals): record"));
  assert.equal(commits.length, 2);
  for (const commit of commits) {
    const stat = await runProc("git", ["show", "--numstat", "--format=", commit.split(" ")[0], "--", "results.csv"], { cwd: h.resultsRepo });
    assert.match(stat.stdout.trim(), /^1\t0\tresults\.csv$/);
  }
  assert.deepEqual(h.notices.map((n) => n.key).filter((key) => key.startsWith("run-")).sort(), ["run-variant-a-1", "run-variant-b-1"]);
});

test("a stop request lets the round's runs finish and starts no new round", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final", "ask-final", "ask-final"], variants: PAIR, runsPerVariant: 2, parallel: 2 });
  await h.until(bothRunning);
  assert.match(await requestStop(h.ctx), /stops after the runs in progress finish/);
  const done = await h.until(() => false);
  const state = h.state();
  assert.deepEqual(state.runs.map((r) => r.status), ["done", "done"]);
  assert.equal(h.scoreCalls.length, 2);
  assert.equal(state.phase, "done");
  assert.match(String(done.details?.reason), /you asked the batch to stop/);
});

test("changed pinned files mid-round let the round finish, then stop the batch", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final", "ask-final", "ask-final"], variants: PAIR, runsPerVariant: 2, parallel: 2 });
  await h.until(bothRunning);
  writeFileSync(join(h.config.agentsDir, "variant-a-worker.agent.md"), "worker, edited mid-batch\n");
  const done = await h.until(() => false);
  const state = h.state();
  assert.deepEqual(state.runs.map((r) => r.status), ["done", "done"]);
  assert.equal(h.scoreCalls.length, 2);
  assert.equal(state.phase, "stopped");
  assert.match(String(done.details?.reason), /pinned inputs changed: agent variant-a-worker changed/);
});

test("a stop before the round's runs start voids them, with no notice and no start failure", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], variants: PAIR, parallel: 2 });
  await h.until((action) => action.action === "create_project");
  await requestStop(h.ctx);
  const done = await h.until(() => false);
  const state = h.state();
  assert.deepEqual(state.runs.map((r) => r.status), ["void", "void"]);
  for (const run of state.runs) assert.match(run.voidReason!, /^not started: you asked the batch to stop$/);
  assert.equal(h.app.sessions.size, 0);
  assert.equal(state.startFailures, 0);
  assert.equal(h.notices.filter((n) => n.key.startsWith("void-")).length, 0);
  assert.equal(state.phase, "done");
  assert.match(String(done.details?.reason), /you asked the batch to stop/);
});

test("--parallel is a whole number from 1 to the number of variants", () => {
  const base = { variants: PAIR, runsPerVariant: 3, selfTest: { enabled: false, only: false, model: "m", effort: "low", agent: null } };
  for (const parallel of [1, 2]) assert.deepEqual(validateConfig({ ...base, parallel } as never), []);
  for (const parallel of [0, -1, 1.5, Number.NaN]) assert.match(validateConfig({ ...base, parallel } as never).join(), /--parallel must be a positive integer/);
  assert.match(validateConfig({ ...base, parallel: 3 } as never).join(), /--parallel can't be more than the number of variants/);
});

test("a batch saved with one current run loads with that run active", async () => {
  const h = await make({ scenarios: [] });
  for (const [current, active] of [[0, [0]], [null, []]] as const) {
    const legacy: Record<string, unknown> = { ...h.state(), current };
    delete legacy.active;
    saveState(h.config.dir, legacy as never);
    const state = h.state();
    assert.deepEqual(state.active, active);
    assert.equal("current" in state, false);
  }
});
