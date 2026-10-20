// Regression tests for the findings of the core and fidelity reviews of the overnight runner.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { LogEvent } from "../lib/events.ts";
import { ActiveBatchError } from "../lib/batch/lock.ts";
import { OwnershipError, requestStop, STOP_MESSAGE } from "../lib/batch/runner.ts";
import { eventsPath } from "../lib/batch/swarm.ts";
import { run as runProc } from "../lib/proc.ts";
import { readResults } from "../lib/results.ts";
import { KIT_DIR } from "../lib/suite.ts";
import { harness, type Harness } from "./fixtures/batch.ts";

const MIN = 60_000;
const made: Harness[] = [];
const scratch: string[] = [];
async function make(opts: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(opts);
  made.push(h);
  return h;
}
after(() => {
  for (const h of made) rmSync(h.dir, { recursive: true, force: true });
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

function append(h: Harness, sessionId: string, type: string, data: Record<string, unknown> = {}): LogEvent {
  const event: LogEvent = { type, timestamp: new Date(h.clock.now).toISOString(), data };
  appendFileSync(eventsPath(h.config.stateDir, sessionId), JSON.stringify(event) + "\n");
  return event;
}

function finalMessage(h: Harness, sessionId: string, text: string): LogEvent {
  append(h, sessionId, "assistant.turn_start");
  const event = append(h, sessionId, "assistant.message", { messageId: `m-${h.clock.now}`, content: text });
  append(h, sessionId, "assistant.turn_end");
  return event;
}

const kickoff = (h: Harness, i = 0): number => Date.parse(h.state().runs[i].kickoffAt!);
const session = (h: Harness, i = 0) => [...h.app.sessions.values()][i];

// ---------- H1: exclusive ownership ----------

test("H1: a second batch can't run while another batch is active on the machine", async () => {
  const guardDir = mkdtempSync(join(tmpdir(), "orch-eval-guard-"));
  scratch.push(guardDir);
  const guard = join(guardDir, "active-batch");
  const first = await make({ scenarios: ["ask-final"], activeGuard: guard, id: "first" });
  const second = await make({ scenarios: ["ask-final"], activeGuard: guard, id: "second" });
  assert.equal((await first.next()).action, "create_project");
  await assert.rejects(second.next(), ActiveBatchError);
  await first.until(() => false);
  assert.equal(first.state().phase, "done");
  assert.equal((await second.next()).action, "create_project", "the guard is free once the first batch is done");
});

test("H1: only the owning driver may run next or record; another takes over only once the owner is gone", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const action = await h.next();
  assert.equal(h.state().owner?.id, "session:driver-1");
  h.ctx.deps.driverId = "session:driver-2";
  await assert.rejects(h.next(), OwnershipError);
  await assert.rejects(h.record({ action: action.id!, projectId: "p" }), OwnershipError);
  // Liveness unknown: refused until the owner has been silent for 15 minutes.
  h.alive.set("session:driver-1", null);
  await assert.rejects(h.next(), OwnershipError);
  h.clock.now += 16 * MIN;
  const again = await h.next();
  assert.equal(again.id, action.id, "the new owner gets the pending action");
  assert.equal(h.state().owner?.id, "session:driver-2");
  assert.ok(h.state().warnings.some((w) => /driver changed from session:driver-1 to session:driver-2/.test(w)));
});

test("H1: an unrecorded create_session is reconciled, adopted if it landed, and reissued at most once", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.drive(await h.next()); // create_project
  const create = await h.next();
  assert.equal(create.action, "create_session");
  // The driver dies mid-call; a new driver takes over.
  h.ctx.deps.driverId = "session:driver-2";
  h.alive.set("session:driver-1", false);
  const held = await h.next(60_000);
  assert.equal(held.action, "wait", "not reissued while the first call may still land");
  h.app.createSession(create.tool!.args); // the first driver's call lands after all
  const adopted = await h.next();
  assert.notEqual(adopted.action, "create_session");
  assert.equal(h.state().runs[0].status, "running");
  assert.equal(h.app.sessions.size, 1);

  const k = await make({ scenarios: ["ask-final"] });
  await k.drive(await k.next());
  const first = await k.next();
  assert.equal((await k.next(4 * MIN)).action, "wait");
  k.clock.now += 2 * MIN;
  const reissue = await k.next(0);
  assert.equal(reissue.action, "create_session");
  assert.equal(reissue.id, first.id);
  assert.equal(reissue.reissued, true);
  k.clock.now += 6 * MIN;
  await k.next(0);
  const run = k.state().runs[0];
  assert.equal(run.status, "void");
  assert.match(run.voidReason!, /issued twice/);
  assert.equal(k.app.sessions.size, 0);
});

test("core R2: a session from the first create_session that shows up after the reissue is adopted, not given up", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.drive(await h.next()); // create_project
  assert.equal((await h.next()).action, "create_session");
  const firstIssued = h.clock.now;
  h.clock.now += 6 * MIN;
  const reissue = await h.next(0);
  assert.equal(reissue.reissued, true);
  // The first attempt's workspace, created a second after the first issue, is visible only now.
  const workspaces = h.app.workspaces.bind(h.app);
  h.app.workspaces = (projectId) => [
    ...(workspaces(projectId) ?? []),
    { id: "ws-first", sessionId: null, name: "first attempt", archivedAt: null, createdBy: "agent", createdAt: new Date(firstIssued + 1000).toISOString() },
  ];
  h.clock.now += MIN;
  await h.next(0);
  const run = h.state().runs[0];
  assert.equal(run.status, "running");
  assert.equal(run.appSessionId, "ws-first");
  assert.equal(run.startRequestedAt, new Date(firstIssued).toISOString(), "the search window still starts at the first issue");
});

test("core R2: a session that turns up for a run given up as never started stops the batch", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  await h.drive(await h.next());
  await h.next(); // create_session, never executed or recorded
  const firstIssued = h.clock.now;
  h.clock.now += 6 * MIN;
  assert.equal((await h.next(0)).reissued, true);
  h.clock.now += 6 * MIN;
  const projectAction = await h.next(0); // run 1 is void; run 2 is planned
  assert.equal(h.state().runs[0].status, "void");
  assert.equal(projectAction.action, "create_project");
  const workspaces = h.app.workspaces.bind(h.app);
  const runOneProject = h.state().runs[0].projectId!;
  h.app.workspaces = (projectId) => [
    ...(workspaces(projectId) ?? []),
    ...(projectId === runOneProject ? [{ id: "ws-late", sessionId: null, name: "late", archivedAt: null, createdBy: "agent", createdAt: new Date(firstIssued + 2000).toISOString() }] : []),
  ];
  await h.drive(projectAction);
  const done = await h.next(0);
  assert.equal(done.action, "done");
  assert.equal(h.state().phase, "stopped");
  assert.match(String(done.details?.reason), /appeared for variant-a#1 after it was given up/);
  assert.equal(h.app.sessions.size, 0, "run 2 never started");
});

test("H1: a stop request made while next is running is not lost", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  const sleep = h.ctx.deps.sleep;
  let stopped = false;
  h.ctx.deps.sleep = async (ms) => {
    await sleep(ms);
    if (!stopped && h.state().runs[0]?.status === "running") {
      stopped = true;
      await requestStop(h.ctx);
    }
  };
  const done = await h.until(() => false);
  assert.equal(h.state().stopRequested, true);
  assert.equal(h.state().runs.length, 1);
  assert.match(String(done.details?.reason), /you asked the batch to stop/);
});

// ---------- H2: a timely final report at the cutoff ----------

async function timeoutRunAt(h: Harness, writeAtMs: number, observeAtMs: number): Promise<LogEvent> {
  await h.drive(await h.until((a) => a.action === "judge_idle")); // "Working on it." is neither
  const sid = h.state().runs[0].sessionId!;
  const k = kickoff(h);
  h.clock.now = k + writeAtMs;
  h.app.tick();
  const event = finalMessage(h, sid, "Final report: all features are merged and CI on main is green. The work is done.");
  h.clock.now = k + observeAtMs;
  return event;
}

for (const [label, writeAt, observeAt] of [
  ["at 89:50, seen at 90:01", 89 * MIN + 50_000, 90 * MIN + 1_000],
  ["at exactly 90:00, seen at 90:10", 90 * MIN, 90 * MIN + 10_000],
  ["at 80:00, seen at 110:00 after a driver gap", 80 * MIN, 110 * MIN],
] as const) {
  test(`H2: a final report written ${label} is judged and scored at its own time, not as a timeout`, async () => {
    const h = await make({ scenarios: ["timeout"] });
    const event = await timeoutRunAt(h, writeAt, observeAt);
    const action = await h.next(0);
    assert.equal(action.action, "judge_idle");
    assert.match(String(action.details?.reason), /90-minute limit/);
    await h.drive(action);
    await h.until(() => false);
    const args = h.scoreCalls[0];
    assert.equal(flag(args, "--end-at"), event.timestamp);
    assert.equal(flag(args, "--outcome"), undefined);
    assert.equal(h.state().runs[0].endReason, "final");
  });
}

test("H2: a report written after 90 minutes doesn't count", async () => {
  const h = await make({ scenarios: ["timeout"] });
  await timeoutRunAt(h, 90 * MIN + 5_000, 90 * MIN + 30_000);
  await h.until(() => false);
  assert.equal(flag(h.scoreCalls[0], "--outcome"), "timeout");
});

// ---------- H3 / F2: no next run beside a busy swarm ----------

test("H3: a final report with a busy child is scored at the report; the stop message quiets the swarm before the next run", async () => {
  const h = await make({ scenarios: ["busy-child", "ask-final"], runsPerVariant: 2 });
  const order: string[] = [];
  await h.until((action, state) => {
    if (action.action === "send_message") order.push(`stop after ${state.runs[0].scoredAt ? "scoring" : "NOTHING"}`);
    return false;
  });
  const state = h.state();
  const [first, second] = state.runs;
  assert.ok(flag(h.scoreCalls[0], "--end-at"), "scored at the final report");
  assert.deepEqual(order, ["stop after scoring"]);
  assert.ok(first.flags.some((f) => f.code === "swarm-not-quiet" && /after scoring the final report/.test(f.detail)));
  assert.equal(first.status, "done");
  assert.ok(Date.parse(second.createdAt) > Date.parse(first.stopSentAt!), "the next run started after the swarm went quiet");
  assert.equal(state.phase, "done");
});

for (const scenario of ["runaway", "timeout-runaway"] as const) {
  test(`H3/F2: a swarm still busy after the stop message stops the batch (${scenario})`, async () => {
    const h = await make({ scenarios: [scenario, "ask-final"], runsPerVariant: 2 });
    const done = await h.until(() => false);
    const state = h.state();
    assert.equal(state.phase, "stopped");
    assert.equal(state.runs.length, 1, "no run was admitted beside the busy swarm");
    assert.match(String(done.details?.reason), /still active .* after the stop message/);
    assert.ok(state.runs[0].flags.some((f) => f.code === "swarm-not-quiet"));
    assert.ok(h.notices.some((n) => n.key === "batch-stopped"));
    assert.match(readFileSync(state.reportPath!, "utf8"), /## Sessions to archive[\s\S]*orch-eval-variant-a-1/);
  });
}

// ---------- M1: a pending question isn't a stall; the gap is flagged ----------

test("M1: a question still open after 30 minutes away is answered, and driver-gap shows in the notification and report", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.until((a) => a.action === "answer_question");
  h.clock.now += 30 * MIN;
  h.app.tick();
  const again = await h.next(0);
  assert.equal(again.action, "answer_question");
  await h.drive(again);
  await h.until(() => false);
  const state = h.state();
  assert.equal(flag(h.scoreCalls[0], "--outcome"), undefined);
  assert.ok(state.runs[0].flags.some((f) => f.code === "driver-gap"));
  assert.match(h.notices.find((n) => n.key === "run-variant-a-1")!.body, /driver-gap/);
  assert.match(readFileSync(state.reportPath!, "utf8"), /driver-gap/);
});

// ---------- M2 / F6: deadline and pins just before the kickoff ----------

test("M2: no create_session after the deadline, even when the run was planned before it", async () => {
  const h = await make({ scenarios: ["ask-final"], deadlineMin: 2 });
  const project = await h.next();
  assert.equal(project.action, "create_project");
  h.clock.now += 3 * MIN;
  await h.record({ action: project.id!, projectId: h.app.createProject(String(project.tool!.args.path)) });
  const done = await h.next();
  assert.equal(done.action, "done");
  assert.match(h.state().runs[0].voidReason!, /not started: the deadline/);
  assert.equal(h.state().phase, "done");
  assert.equal(h.app.sessions.size, 0);
});

test("M2: an unconfirmed create_session is not reissued after the deadline", async () => {
  const h = await make({ scenarios: ["ask-final"], deadlineMin: 4 });
  await h.drive(await h.next());
  assert.equal((await h.next()).action, "create_session");
  h.clock.now += 6 * MIN;
  const done = await h.next();
  assert.equal(done.action, "done");
  assert.match(h.state().runs[0].voidReason!, /not started: the deadline/);
  assert.equal(h.app.sessions.size, 0);
});

test("F2: changed pins are checked again just before create_session", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const project = await h.next();
  writeFileSync(join(h.config.agentsDir, "variant-a.agent.md"), "edited after planning\n");
  await h.record({ action: project.id!, projectId: h.app.createProject(String(project.tool!.args.path)) });
  const done = await h.next();
  assert.equal(done.action, "done");
  assert.equal(h.state().phase, "stopped");
  assert.match(String(done.details?.reason), /pinned inputs changed: agent variant-a changed/);
  assert.equal(h.app.sessions.size, 0);
});

// ---------- M3: the answer source is found from the action's issue time ----------

test("M3: a plain-text reply recorded a minute late still gives score its --answer-source", async () => {
  const h = await make({ scenarios: ["plain-final"] });
  const send = await h.until((a) => a.action === "send_message");
  h.app.send(String(send.tool!.args.session_id), String(send.tool!.args.message));
  const deliveredAt = new Date(h.clock.now).toISOString();
  h.clock.now += MIN;
  h.app.tick();
  await h.record({ action: send.id!, sent: true });
  await h.until(() => false);
  const run = h.state().runs[0];
  assert.equal(flag(h.scoreCalls[0], "--answer-source"), h.app.driverSource);
  assert.equal(run.plain?.deliveredAt, deliveredAt);
  assert.ok(!run.flags.some((f) => f.code === "answer-source-unknown"));
});

test("M3: a plain-text reply sent but never recorded is adopted and still attributed", async () => {
  const h = await make({ scenarios: ["plain-final"] });
  const send = await h.until((a) => a.action === "send_message");
  h.app.send(String(send.tool!.args.session_id), String(send.tool!.args.message));
  h.clock.now += MIN;
  h.app.tick();
  await h.until(() => false);
  assert.equal(flag(h.scoreCalls[0], "--answer-source"), h.app.driverSource);
  assert.equal(h.app.sessions.size, 1);
});

// ---------- M4: the results commit ----------

function failCommits(h: Harness, times: number): { attempts: number } {
  const counter = { attempts: 0 };
  const exec = h.ctx.deps.exec;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    if (cmd === "git" && args.includes("commit") && args.includes("--only")) {
      counter.attempts++;
      if (counter.attempts <= times) return { code: 1, stdout: "", stderr: "fatal: Unable to create '.git/index.lock': File exists." };
    }
    return exec(cmd, args, opts);
  };
  return counter;
}

test("M4: a failed results commit is retried before the batch moves on", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  const counter = failCommits(h, 1);
  await h.until(() => false);
  const state = h.state();
  assert.equal(counter.attempts, 3, "one failure, then a commit per run");
  assert.equal(state.runs[0].committed, true);
  assert.equal(state.runs.length, 2);
  const log = await runProc("git", ["log", "--format=%s"], { cwd: h.resultsRepo });
  assert.match(log.stdout, /record variant-a run 1/);
});

test("M4: a results commit that keeps failing stops the batch and notifies", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  const counter = failCommits(h, 99);
  const done = await h.until(() => false);
  const state = h.state();
  assert.equal(counter.attempts, 3);
  assert.equal(state.phase, "stopped");
  assert.equal(state.runs.length, 1);
  assert.match(String(done.details?.reason), /results commit for variant-a#1 failed 3 times/);
  assert.ok(state.runs[0].flags.some((f) => f.code === "commit-failed"));
  assert.ok(h.notices.some((n) => n.key === "failure-commit-variant-a#1"));
});

// ---------- F7 and question checks: the answer contract ----------

function openAsk(h: Harness, question: string): void {
  const s = session(h);
  append(h, s.id, "tool.execution_start", { toolName: "ask_user", toolCallId: "q-untagged", arguments: { question } });
  s.ask = { toolCallId: "q-untagged", requestId: "req-untagged", question };
  s.nextAt = Infinity;
}

test("F7: an untagged question carries no answer in tool.args, only both candidate replies and the rule", async () => {
  const h = await make({ scenarios: ["silent"] });
  await h.until((_, state) => state.runs[0]?.status === "running");
  openAsk(h, "[unit=api need=question] Should amounts be stored as integers?");
  const action = await h.next(0);
  assert.equal(action.action, "answer_question");
  assert.equal("answer" in action.tool!.args, false);
  assert.deepEqual(action.details?.candidates, {
    3: "Follow docs/spec-v2.md. Where it is silent, make a reasonable call and note it in the PR description.",
    4: "Your call. Don't wait for me.",
  });
  assert.match(String(action.details?.rule), /^Row 3 if the question is about the spec/);
  await assert.rejects(h.record({ action: action.id!, answered: true }), /--row 3 or 4/);
  assert.equal(await h.record({ action: action.id!, row: 3, requestId: "req-untagged" }), "answered with row 3");
  assert.equal(h.state().runs[0].requestIds["q-untagged"], "req-untagged");
});

test("F7: a tagged question carries its fixed reply and no candidates", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const action = await h.until((a) => a.action === "answer_question");
  assert.equal(action.tool!.args.answer, "Approved. Go ahead.");
  assert.equal(action.details?.row, 1);
  assert.equal(action.details?.candidates, undefined);
});

test("a different pending question is never answered: the driver records a mismatch", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const action = await h.until((a) => a.action === "answer_question");
  session(h).ask!.question = "[unit=* need=plan] A different question?";
  await h.drive(action);
  assert.ok(session(h).ask, "nothing was answered");
  assert.ok(h.state().runs[0].flags.some((f) => f.code === "answer-mismatch"));
});

test("a retried answer carries the request_id answered before, and a different one is flagged", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const action = await h.until((a) => a.action === "answer_question");
  await h.record({ action: action.id!, answered: true, requestId: "req-first" }); // recorded, but it never landed
  h.clock.now += 3 * MIN;
  const retry = await h.next(0);
  assert.equal(retry.action, "answer_question");
  assert.equal(retry.details?.requestId, "req-first");
  assert.match(retry.what, /request_id equals details\.requestId/);
  await h.record({ action: retry.id!, answered: true, requestId: "req-other" });
  assert.ok(h.state().runs[0].flags.some((f) => f.code === "answer-mismatch" && /req-other, expected req-first/.test(f.detail)));
});

test("R2: a failed answer attempt keeps its request_id, so a retry facing a different request answers nothing", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const first = await h.until((a) => a.action === "answer_question");
  // The driver saw the matching question as request req-first, then answer_session_input failed.
  await h.record({ action: first.id!, failed: "transport error", requestId: "req-first" });
  assert.equal(h.state().runs[0].requestIds[String(first.details?.toolCallId)], "req-first");
  h.clock.now += 3 * MIN;
  const retry = await h.next(0);
  assert.equal(retry.action, "answer_question");
  assert.equal(retry.details?.requestId, "req-first");
  // The app now shows the same question text under another request: the driver must not answer it.
  assert.notEqual(session(h).ask!.requestId, "req-first");
  await h.drive(retry);
  assert.ok(session(h).ask, "nothing was answered");
  assert.ok(h.state().runs[0].flags.some((f) => f.code === "answer-mismatch"));
});

test("R2: the request_id seen on a question mismatch is never kept, because it belongs to another question", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const first = await h.until((a) => a.action === "answer_question");
  await h.record({ action: first.id!, failed: "question mismatch", requestId: "req-of-another-question" });
  assert.equal(h.state().runs[0].requestIds[String(first.details?.toolCallId)], undefined);
});

test("R1: a flag found after scoring reaches a follow-up notification and the final one; the row and score don't change", async () => {
  const h = await make({ scenarios: ["busy-child"] });
  let injected = false;
  await h.until((_, state) => {
    const run = state.runs[0];
    if (!injected && run?.notified && run.sessionId) {
      append(h, run.sessionId, "tool.execution_start", { toolName: "store_memory", toolCallId: "late-mem" });
      injected = true;
    }
    return false;
  });
  assert.ok(injected);
  const outcome = h.notices.find((n) => n.key === "run-variant-a-1")!;
  assert.doesNotMatch(outcome.body, /memory-write/, "the outcome went out before the late flag");
  const late = h.notices.find((n) => n.key.startsWith("late-variant-a-1-"));
  assert.ok(late, h.notices.map((n) => n.key).join(", "));
  assert.match(late!.body, /memory-write/);
  assert.match(late!.body, /score and results\.csv row are unchanged/);
  assert.match(h.notices.find((n) => n.key === "batch-done")!.body, /late flags \(after scoring\): variant-a#1 [^;]*memory-write/);
  assert.equal(h.scoreCalls.length, 1, "never scored again");
  assert.doesNotMatch(readResults(h.config.resultsPath)[0].note, /memory-write/);
  assert.match(readFileSync(h.state().reportPath!, "utf8"), /memory-write: session .*store_memory called/);
});

// ---------- F1: the self-test's completion rule ----------

test("F1: the self-test's judge action says it is the self-test and gives its own completion rule", async () => {
  const h = await make({ scenarios: ["ask-final"], selfTest: true });
  const action = await h.until((a) => a.action === "judge_idle");
  assert.equal(action.target, "self-test");
  assert.match(String(action.details?.rule), /^This is the self-test, not an eval run/);
  assert.equal(action.record?.length, 1);
  assert.match(action.record![0], /--final <messageId>$/);
  await h.drive(action);
  await h.until(() => false);
  assert.equal(h.state().selftests[0].status, "passed");
  const runAction = h.state().runs.length;
  assert.equal(runAction, 1);
});

// ---------- F3: an honest failure report is a final report ----------

test("F3: a report that says the attempt stopped unfinished is scored at its time; the suite decides", async () => {
  const h = await make({ scenarios: ["gave-up"] });
  await h.until(() => false);
  const run = h.state().runs[0];
  const log = readFileSync(eventsPath(h.config.stateDir, run.sessionId!), "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogEvent);
  const report = log.find((e) => e.type === "assistant.message" && /I've stopped/.test(String(e.data?.content)))!;
  assert.equal(flag(h.scoreCalls[0], "--end-at"), report.timestamp);
  assert.equal(flag(h.scoreCalls[0], "--outcome"), undefined);
  assert.equal(run.endReason, "final");
});

// ---------- F5: provenance in the row's note ----------

test("F5: score gets a note with the batch, driver, Memory mode and the flags known before scoring", async () => {
  const h = await make({ scenarios: ["plain-final"] });
  await h.until(() => false);
  const expected = "batch=test-batch; driver=eval-runner; memory=off; dry-run; flags=plain-text-question";
  assert.equal(flag(h.scoreCalls[0], "--note"), expected);
  assert.equal(readResults(h.config.resultsPath)[0].note, expected);
});

// ---------- kickoff bytes ----------

test("the kickoff is kickoff.md without its trailing newline, as a manual paste delivered it", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  const create = await h.until((a) => a.action === "create_session");
  const prompt = (create.tool!.args.kickoff as Record<string, unknown>).prompt;
  const file = readFileSync(join(KIT_DIR, "kickoff.md"), "utf8");
  assert.ok(file.endsWith("\n"));
  assert.equal(prompt, file.trimEnd());
  await h.drive(create);
  await h.until(() => false);
  assert.ok(!h.state().runs[0].flags.some((f) => f.code === "kickoff-text"));
});

// ---------- schema drift, timeouts and clocks ----------

test("app database query failures become app-db flags", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.until((_, state) => state.runs[0]?.status === "running");
  let once = true;
  h.app.takeErrors = () => (once ? ((once = false), ["sessions.was_interrupted: no such column: was_interrupted"]) : []);
  await h.next(0);
  assert.ok(h.state().runs[0].flags.some((f) => f.code === "app-db" && /was_interrupted/.test(f.detail)));
});

test("a score that times out counts as a score failure", async () => {
  const h = await make({ scenarios: ["ask-final", "ask-final"], runsPerVariant: 2 });
  const exec = h.ctx.deps.exec;
  let calls = 0;
  h.ctx.deps.exec = async (cmd, args, opts) => {
    if (args[0] === h.config.scoreScript && calls++ === 0) {
      assert.equal(opts?.timeoutMs, 30 * MIN);
      return { code: 124, stdout: "", stderr: "node timed out after 1800 s", timedOut: true };
    }
    return exec(cmd, args, opts);
  };
  await h.until(() => false);
  const state = h.state();
  assert.ok(state.runs[0].flags.some((f) => f.code === "score-failed" && /timed out/.test(f.detail)));
  assert.equal(state.runs.length, 3, "the unscored run is replaced");
});

test("a clock that jumps back is flagged and makes nothing look stalled or timed out", async () => {
  const h = await make({ scenarios: ["ask-final"] });
  await h.until((a) => a.action === "judge_idle");
  h.clock.now -= 10 * MIN;
  await h.until(() => false);
  const run = h.state().runs[0];
  assert.ok(run.flags.some((f) => f.code === "clock-jump"));
  assert.equal(flag(h.scoreCalls[0], "--outcome"), undefined);
  assert.equal(STOP_MESSAGE.length > 0, true);
});

test("subprocesses with a timeout are stopped with their children", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-eval-proc-"));
  scratch.push(dir);
  const marker = join(dir, "child-survived");
  const started = Date.now();
  const result = await runProc("sh", ["-c", `(sleep 2; touch ${marker}) & sleep 30`], { timeoutMs: 300 });
  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 5000);
  await new Promise((done) => setTimeout(done, 2500));
  assert.equal(existsSync(marker), false, "the child was stopped before it could write");
});
