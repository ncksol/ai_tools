// Tool-permission prompts: the self-test proves a session the batch creates can use tools with nobody
// present, and a prompt during a batch voids the run and stops the batch.
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import type { LogEvent } from "../lib/events.ts";
import { calibrationDecision, scoredCount } from "../lib/batch/plan.ts";
import { makeCtx, next, STOP_MESSAGE } from "../lib/batch/runner.ts";
import { saveState } from "../lib/batch/state.ts";
import { actAsDriver } from "../lib/batch/rehearsal.ts";
import { eventsPath, LogCache, PERMISSION_REMEDY } from "../lib/batch/swarm.ts";
import { readResults } from "../lib/results.ts";
import { harness, type Harness } from "./fixtures/batch.ts";

const made: Harness[] = [];
async function make(opts: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(opts);
  made.push(h);
  return h;
}
after(() => {
  for (const h of made) rmSync(h.dir, { recursive: true, force: true });
});

function appendEvent(h: Harness, sessionId: string, type: string, data: Record<string, unknown>, offsetMs = 0): void {
  appendAt(h, sessionId, type, data, h.clock.now + offsetMs);
}

function appendAt(h: Harness, sessionId: string, type: string, data: Record<string, unknown>, atMs: number): void {
  const event: LogEvent = { type, timestamp: new Date(atMs).toISOString(), data };
  appendFileSync(eventsPath(h.config.stateDir, sessionId), JSON.stringify(event) + "\n");
}

const pendingShell = (requestId: string) => ({ requestId, permissionRequest: { kind: "shell", fullCommandText: "npm test" }, agentMode: "interactive", permissionMode: "manual" });

test("the self-test prompt asks for a compound shell command with the nonce marker", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  const action = await h.until((a) => a.action === "create_session");
  const prompt = String((action.tool!.args.kickoff as Record<string, unknown>).prompt);
  const nonce = h.state().selftests[0].nonce;
  assert.match(prompt, new RegExp(`exactly as written: pwd && echo eval-selftest-${nonce}$`, "m"));
  assert.equal((action.tool!.args.kickoff as Record<string, unknown>).agent, undefined, "still the default agent, never an orchestrator");
});

test("a self-test session without allow-all permissions fails fast and stops the batch before any run repo", async () => {
  const h = await make({ scenarios: ["ask-final"], selfTest: true });
  h.app.allowAll = false;
  const started = h.clock.now;
  await h.until(() => false);
  const state = h.state();
  const test = state.selftests[0];
  assert.equal(test.status, "failed");
  assert.match(test.failure!, /^no tool-permission prompt \(allow-all permissions\): session \S+: a shell request for pwd && echo eval-selftest-\S+ has waited for approval since .* \(permission mode manual\)\. /);
  assert.ok(test.failure!.endsWith(PERMISSION_REMEDY));
  assert.ok(h.clock.now - started < 5 * 60_000, `it failed after ${Math.round((h.clock.now - started) / 1000)} s, not at the 20-minute limit`);
  assert.equal(state.runs.length, 0);
  assert.deepEqual(readdirSync(h.config.runsDir), [], "no run repo was created");
  assert.equal(state.phase, "stopped");
  assert.match(state.stopReason!, /^the self-test failed: no tool-permission prompt/);
  assert.match(state.stopReason!, /"Tool permissions" under "Overnight batches" in the kit's README/);
  assert.deepEqual(h.notices.map((n) => n.key), ["batch-started", "selftest-1", "batch-stopped"]);
  assert.match(h.notices[1].body, /Tool permissions/);
  const report = readFileSync(state.reportPath!, "utf8");
  assert.match(report, /## Tool-permission prompts\n\nA tool-permission prompt that nobody could answer stopped this batch\.\n\n- The self-test failed: no tool-permission prompt/);
});

test("a self-test whose prompt someone approved by hand still fails: the runtime was in manual mode", async () => {
  const h = await make({ scenarios: ["ask-final"], selfTest: true });
  await h.until((action, state) => {
    const test = state.selftests[0];
    if (action.action === "judge_idle" && test?.sessionId) {
      appendEvent(h, test.sessionId, "permission.requested", { requestId: "r1", permissionRequest: { kind: "shell", fullCommandText: "pwd && echo x" }, agentMode: "interactive", permissionMode: "manual" }, -60_000);
      appendEvent(h, test.sessionId, "permission.completed", { requestId: "r1", result: { kind: "approved" }, decisionSource: "human_response" }, -50_000);
    }
    return false;
  });
  const test = h.state().selftests[0];
  assert.equal(test.status, "failed");
  const check = test.checks.find((c) => c.name === "no tool-permission prompt (allow-all permissions)")!;
  assert.deepEqual([check.ok, check.detail], [false, "1 permission request(s): 1 in manual mode, 0 pending, 0 denied; first: a shell request for pwd && echo x"]);
  assert.ok(test.checks.find((c) => c.name === "a shell command ran with nobody present")!.ok);
  assert.ok(test.failure!.endsWith(PERMISSION_REMEDY));
  assert.equal(h.state().runs.length, 0);
});

test("a passing self-test ran its shell command and logged no permission request", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  h.config.selfTest.only = true;
  await h.until(() => false);
  const test = h.state().selftests[0];
  assert.equal(test.status, "passed", JSON.stringify(test.checks));
  assert.deepEqual(
    test.checks.filter((c) => /shell|permission/.test(c.name)).map((c) => [c.name, c.ok, c.detail]),
    [
      ["a shell command ran with nobody present", true, `bash completed and printed eval-selftest-${test.nonce}`],
      ["no tool-permission prompt (allow-all permissions)", true, "no permission requests"],
    ],
  );
  assert.ok(!test.checks.some((c) => /auto-approve/.test(c.name)), "the projects.auto_approve check is gone");
});

for (const scenario of ["permission-prompt", "permission-denied"] as const) {
  test(`${scenario}: the run is void, gets the stop message, is never scored or counted, and the batch stops`, async () => {
    const h = await make({ scenarios: [scenario, "ask-final"], runsPerVariant: 2 });
    const sent: string[] = [];
    const done = await h.until((action) => {
      if (action.action === "send_message") sent.push(`${action.what} | ${String(action.tool!.args.message)}`);
      return false;
    });
    assert.equal(done.action, "done");
    const state = h.state();
    assert.equal(state.runs.length, 1, "no further run started");
    const run = state.runs[0];
    assert.equal(run.status, "void");
    assert.match(run.voidReason!, /^blocked by a tool-permission prompt: session \S+/);
    if (scenario === "permission-prompt") assert.match(run.voidReason!, /\(sub-agent sub-agent-1\): a shell request for npm test has waited for approval/);
    else assert.match(run.voidReason!, /was denied at .* because no one could be asked/);
    assert.ok(run.flags.some((f) => f.code === "permission-prompt"));
    assert.deepEqual(sent, [`The run is void and won't be scored. Send this stop message to the run's orchestrator, word for word. | ${STOP_MESSAGE}`]);
    assert.ok(run.stopSentAt);
    assert.equal(h.scoreCalls.length, 0);
    const rows = readResults(h.config.resultsPath);
    assert.equal(rows.length, 0, "a void run has no results.csv row");
    assert.equal(scoredCount(state.runs, rows, "variant-a", run.features), 0);
    assert.deepEqual(calibrationDecision(rows, h.config.variants).pending, ["variant-a"], "calibration still waits for a real run");
    assert.equal(state.phase, "stopped");
    assert.equal(state.failed, true);
    assert.match(state.stopReason!, /^variant-a#1 was blocked by a tool-permission prompt \(/);
    assert.ok(state.stopReason!.endsWith(PERMISSION_REMEDY));
    assert.deepEqual(h.notices.map((n) => n.key), ["batch-started", "failure-permission-prompt", "batch-stopped"]);
    assert.match(h.notices[1].body, /variant-a#1 is void and won't be scored.*No further run starts; the batch stops once the runs in progress end\./);
    const report = readFileSync(state.reportPath!, "utf8");
    assert.match(report, /## Tool-permission prompts/);
    assert.match(report, /- variant-a #1: void, not scored\./);
    assert.match(report, /\| void: blocked by a tool-permission prompt/);
  });
}

test("a prompt in one run of a round voids that run; the other run already in progress finishes and is scored", async () => {
  const h = await make({ scenarios: ["permission-prompt", "ask-final"], variants: ["variant-a", "variant-b"], runsPerVariant: 2, parallel: 2 });
  await h.until(() => false);
  const state = h.state();
  assert.deepEqual(state.runs.map((r) => [r.key, r.status]), [["variant-a#1", "void"], ["variant-b#1", "done"]]);
  assert.deepEqual(readResults(h.config.resultsPath).map((r) => [r.variant, r.outcome]), [["variant-b", "passed"]]);
  assert.equal(state.phase, "stopped");
  assert.match(state.stopReason!, /variant-a#1 was blocked by a tool-permission prompt/);
});

test("a prompt that starts after a run's final report keeps its score but stops the batch", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  let injected = false;
  // Injected while the final report is being judged, timed one second after the report.
  await h.until((action, state) => {
    const run = state.runs[0];
    const final = (action.details?.messages as { text: string; timestamp: string }[] | undefined)?.find((m) => /work is done/.test(m.text));
    if (!injected && action.action === "judge_idle" && final) {
      injected = true;
      appendAt(h, run.sessionId!, "permission.requested", { requestId: "late", permissionRequest: { kind: "custom-tool", toolName: "archive_session" }, agentMode: "interactive", permissionMode: "manual" }, Date.parse(final.timestamp) + 1000);
    }
    return false;
  });
  const state = h.state();
  assert.ok(injected);
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].status, "done");
  assert.equal(readResults(h.config.resultsPath)[0].outcome, "passed");
  assert.equal(state.phase, "stopped");
  assert.match(state.stopReason!, /^variant-a#1's swarm hit a tool-permission prompt after the run ended \(.*archive_session/);
  assert.match(readFileSync(state.reportPath!, "utf8"), /- variant-a #1: its result stands; the prompt came after its end\./);
});

// Finding 1 of the final panel: a runner restarted in "scoring" must check the swarm before scoring.
test("regression: a run persisted in scoring with a prompt that appeared while the runner was down is void, not scored", async () => {
  const h = await make({ scenarios: ["stall", "ask-final"], runsPerVariant: 2 });
  const judge = await h.until((action) => action.action === "judge_idle" && action.target === "run");
  await h.drive(judge);
  // The runner stopped right after it ended the run as stalled, before score ran.
  const state = h.state();
  assert.equal(state.runs[0].status, "running");
  assert.equal(state.pending, null);
  Object.assign(state.runs[0], { status: "scoring", endReason: "stalled" });
  saveState(h.config.dir, state);
  appendEvent(h, state.runs[0].sessionId!, "permission.requested", pendingShell("down"));
  h.clock.now += 31_000;
  const ctx = makeCtx(h.config, h.ctx.deps);
  for (let i = 0; i < 200; i++) {
    const action = await next(ctx, { maxWaitMs: 540_000 });
    if (action.action === "done") break;
    await actAsDriver(ctx, h.app, h.clock, action);
  }
  const after = h.state();
  assert.equal(h.scoreCalls.length, 0, "never scored");
  assert.equal(readResults(h.config.resultsPath).length, 0);
  assert.equal(after.runs[0].status, "void");
  assert.match(after.runs[0].voidReason!, /^blocked by a tool-permission prompt/);
  assert.equal(after.runs.length, 1);
  assert.match(after.stopReason!, /^variant-a#1 was blocked by a tool-permission prompt/);
});

// Finding 2 of the final panel: the run's end is decided by timestamps, not by the runner's phase.
test("regression: a child's prompt one second before the final report voids the run", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  let injected = false;
  await h.until((action) => {
    const final = (action.details?.messages as { text: string; timestamp: string }[] | undefined)?.find((m) => /work is done/.test(m.text));
    if (!injected && action.action === "judge_idle" && final) {
      injected = true;
      const child = [...h.app.sessions.values()][0].children[0];
      appendAt(h, child, "permission.requested", pendingShell("edge"), Date.parse(final.timestamp) - 1000);
    }
    return false;
  });
  const state = h.state();
  assert.ok(injected);
  assert.equal(h.scoreCalls.length, 0, "never scored");
  assert.equal(readResults(h.config.resultsPath).length, 0);
  assert.equal(state.runs[0].status, "void");
  assert.match(state.runs[0].voidReason!, /^blocked by a tool-permission prompt: session child-/);
  assert.match(state.stopReason!, /^variant-a#1 was blocked by a tool-permission prompt/);
});

// Critical review A: a request after the final report, seen when an open judgment is recomputed
// after a restart, must let the earlier final report be judged first, not void the run.
test("regression: after a restart, a final report written before a later prompt is judged first and the run keeps its result", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  const judge = await h.until((action) => action.action === "judge_idle" && /work is done/.test(JSON.stringify(action.details?.messages)));
  const final = (judge.details!.messages as { text: string; timestamp: string }[]).find((m) => /work is done/.test(m.text))!;
  const run = h.state().runs[0];
  // The driver stopped before judging; a prompt starts a second after the report, and the runner
  // comes back after the grace period.
  appendAt(h, run.sessionId!, "permission.requested", pendingShell("after"), Date.parse(final.timestamp) + 1000);
  h.clock.now += 31_000;
  const ctx = makeCtx(h.config, h.ctx.deps);
  const actions: string[] = [];
  for (let i = 0; i < 200; i++) {
    const action = await next(ctx, { maxWaitMs: 540_000 });
    if (action.action === "done") break;
    actions.push(`${action.action} ${String(action.details?.reason ?? "")}`);
    await actAsDriver(ctx, h.app, h.clock, action);
  }
  assert.match(actions[0], /^judge_idle a tool-permission prompt appeared after these messages/);
  const state = h.state();
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].status, "done");
  assert.equal(readResults(h.config.resultsPath)[0].outcome, "passed");
  assert.match(state.stopReason!, /^variant-a#1's swarm hit a tool-permission prompt after the run ended/);
});

// Critical review B: a finished run's swarm is still checked until the batch finishes.
test("regression: a prompt in a finished run's swarm keeps its row but stops further runs", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final", "ask-final"], runsPerVariant: 3 });
  let injected = false;
  await h.until((_, state) => {
    if (!injected && state.runs[0]?.status === "done" && state.runs[1]?.status === "running") {
      injected = true;
      appendEvent(h, state.runs[0].sessionId!, "permission.requested", pendingShell("finished"), -60_000);
    }
    return false;
  });
  const state = h.state();
  assert.ok(injected);
  assert.deepEqual(state.runs.map((r) => r.status), ["done", "done"], "the run in progress finished; no third run started");
  assert.equal(readResults(h.config.resultsPath).length, 2);
  assert.equal(h.scoreCalls.length, 2);
  assert.ok(state.runs[0].flags.some((f) => f.code === "permission-prompt"));
  assert.equal(state.phase, "stopped");
  assert.match(state.stopReason!, /^variant-a#1's swarm hit a tool-permission prompt after the run ended/);
});

// Critical review C: only a shell tool's own output proves the shell ran.
test("regression: a self-test that proved the marker with a non-shell tool fails", async () => {
  const h = await make({ scenarios: [], selfTest: true });
  h.config.selfTest.only = true;
  await h.until((action, state) => {
    const test = state.selftests[0];
    if (action.action === "answer_question" && test?.sessionId) {
      const path = eventsPath(h.config.stateDir, test.sessionId);
      writeFileSync(path, readFileSync(path, "utf8").replace(/"toolName":"bash","toolCallId":"([^"]+)","arguments":\{"command":"[^"]*"\}/, (_m, id) => `"toolName":"view","toolCallId":"${id}","arguments":{"path":"/tmp/eval-selftest-${test.nonce}"}`));
      h.ctx.logs = new LogCache();
    }
    return false;
  });
  const test = h.state().selftests[0];
  assert.equal(test.status, "failed");
  const check = test.checks.find((c) => c.name === "a shell command ran with nobody present")!;
  assert.deepEqual([check.ok, check.detail], [false, `no shell tool call (bash or powershell) ran a command with eval-selftest-${test.nonce}`]);
});

// Re-check MF: the results.csv row is the truth about scoring. score writes its row before its
// diagnostics, so the runner can stop with the row saved but its own state still "scoring".
test("regression: a run whose row score saved before the runner stopped is adopted, not voided, by a later prompt", async () => {
  const h = await make({ scenarios: ["stall", "ask-final"], runsPerVariant: 2 });
  const judge = await h.until((action) => action.action === "judge_idle" && action.target === "run");
  await h.drive(judge);
  const state = h.state();
  Object.assign(state.runs[0], { status: "scoring", endReason: "stalled" });
  saveState(h.config.dir, state);
  const run = state.runs[0];
  // score ran and saved its row; the runner died before it recorded the result.
  await h.ctx.deps.exec(process.execPath, [h.config.scoreScript, "--repo-dir", run.repoDir, "--session", run.sessionId!, "--outcome", "stalled", "--calibration", "yes"]);
  assert.equal(readResults(h.config.resultsPath).length, 1);
  h.clock.now += 60_000;
  appendEvent(h, run.sessionId!, "permission.requested", pendingShell("post-score"));
  h.clock.now += 31_000;
  const ctx = makeCtx(h.config, h.ctx.deps);
  for (let i = 0; i < 200; i++) {
    const action = await next(ctx, { maxWaitMs: 540_000 });
    if (action.action === "done") break;
    await actAsDriver(ctx, h.app, h.clock, action);
  }
  const after = h.state();
  assert.equal(h.scoreCalls.length, 1, "score is not run again");
  const rows = readResults(h.config.resultsPath);
  assert.deepEqual(rows.map((row) => row.outcome), ["stalled"], "the row is kept");
  assert.notEqual(after.runs[0].status, "void");
  assert.equal(after.runs[0].row?.outcome, "stalled");
  assert.ok(after.runs[0].committed, "the adopted row is committed");
  assert.ok(after.runs[0].flags.some((f) => f.code === "score-warning" && /adopted/.test(f.detail)));
  assert.ok(after.runs[0].flags.some((f) => f.code === "permission-prompt"));
  assert.equal(after.runs.length, 1, "no further run starts");
  assert.match(after.stopReason!, /^variant-a#1's swarm hit a tool-permission prompt after the run ended/);
  const report = readFileSync(after.reportPath!, "utf8");
  assert.match(report, /- variant-a #1: its result stands/);
  assert.match(report, /\| stalled \|/);
});

// Critical re-review SF: the scoring hold is bounded. A timeout or stall run's end is saved once, so
// requests that start after it never delay scoring past the end plus the grace period.
test("regression: new permission requests at every poll after a stall don't hold scoring past its end plus 30 seconds", async () => {
  const h = await make({ scenarios: ["stall"], runsPerVariant: 1 });
  const judge = await h.until((action) => action.action === "judge_idle" && action.target === "run");
  await h.drive(judge);
  // A resumed state from before the end time was saved: the runner had ended the run as stalled.
  const state = h.state();
  Object.assign(state.runs[0], { status: "scoring", endReason: "stalled" });
  saveState(h.config.dir, state);
  const session = state.runs[0].sessionId!;
  const resumedAt = h.clock.now;
  let seq = 0;
  // A request that opened just as the run ended: it holds scoring until its 30 seconds pass.
  let open: string | null = "poll-0";
  appendEvent(h, session, "permission.requested", pendingShell(open));
  let scoredAt: number | null = null;
  const sleep = h.ctx.deps.sleep;
  const exec = h.ctx.deps.exec;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    if (args[0] === h.config.scoreScript) scoredAt ??= h.clock.now;
    return exec(cmd, args, opts);
  };
  // Every poll, the last request is approved a millisecond after it started and a new one opens.
  h.ctx.deps.sleep = async (ms) => {
    await sleep(ms);
    if (scoredAt !== null) return;
    if (open) appendEvent(h, session, "permission.completed", { requestId: open, result: { kind: "approved" }, decisionSource: "host_policy" }, -ms + 1);
    open = `poll-${++seq}`;
    appendEvent(h, session, "permission.requested", pendingShell(open));
  };
  const ctx = makeCtx(h.config, h.ctx.deps);
  while (scoredAt === null && h.clock.now - resumedAt < 10 * 60_000) {
    const action = await next(ctx, { maxWaitMs: 60_000 });
    if (action.action === "done") break;
    if (action.action !== "wait") await actAsDriver(ctx, h.app, h.clock, action);
  }
  assert.notEqual(scoredAt, null, "scored");
  assert.ok(scoredAt! - resumedAt <= 30_000 + h.config.pollSec * 1000, `scored ${Math.round((scoredAt! - resumedAt) / 1000)} s after the end`);
  assert.equal(h.state().runs[0].endAt, new Date(resumedAt).toISOString(), "the end is saved once, at the resume");
});

// Critical re-check of 6d00ad0: the row decides whether a run is scored, not whether its swarm is
// watched. A run whose score failed before writing a row ends done without one and is still watched.
test("regression: a prompt in the swarm of a finished run that score failed to score stops the batch", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final", "ask-final"], runsPerVariant: 2 });
  const exec = h.ctx.deps.exec;
  let failed = false;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    if (args[0] === h.config.scoreScript && !failed) {
      failed = true;
      return { code: 1, stdout: "", stderr: "score crashed before writing its row" };
    }
    return exec(cmd, args, opts);
  };
  let injected = false;
  await h.until((_, state) => {
    if (!injected && state.runs[0]?.status === "done" && state.runs[1]?.status === "running") {
      injected = true;
      appendEvent(h, state.runs[0].sessionId!, "permission.requested", pendingShell("unscored"), -60_000);
    }
    return false;
  });
  const state = h.state();
  assert.ok(injected);
  assert.ok(state.runs[0].flags.some((f) => f.code === "score-failed"));
  assert.ok(state.runs[0].flags.some((f) => f.code === "permission-prompt"));
  assert.equal(state.runs.length, 2, "no further run starts");
  assert.equal(state.phase, "stopped");
  assert.match(state.fatal!, /^variant-a#1's swarm hit a tool-permission prompt/);
});
