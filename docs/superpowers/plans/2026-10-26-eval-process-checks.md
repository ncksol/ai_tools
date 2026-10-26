# Eval Process Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each scored run, record in `results.csv` whether the orchestrator followed three of its rules: every helper got a model and an effort, every merged PR got a review from another vendor before it merged, and a claims check named each merged head commit before the merge.

**Architecture:** A new pure module, `scripts/lib/process.ts`, reads the swarm session logs that `collectUsage` already walks (handed over through a new `onSession` callback) and returns counts plus warnings. `score.ts` writes seven new report-only columns, the batch report shows them in a table, and the README defines them. Nothing here changes the gate, minutes, cost or pass rate.

**Tech Stack:** Node.js 24 (local v24.19.0) built-ins only: `node:test`, `node:assert/strict`, `node:fs`, `node:zlib`; TypeScript through Node's type stripping.

**Spec:** No separate spec. "Requirements" below is the spec, and "Background" gives the evidence from the eval logs behind each definition.

**Base:** Written against `main` at `4e50ae4` (#74). Every edit is anchored on exact text. If the kit has changed since, check each anchor before editing.

## Requirements

- **R1.** For a run timed from its log, `score` runs the process checks on the same session logs and the same window it uses for cost: the root session and every discovered descendant, from the kickoff to the cost snapshot.
- **R2.** `results.csv` gets seven columns after `output_tokens_all_models`, in this order: `process_status`, `process_helpers`, `process_helpers_untiered`, `process_merges`, `process_merges_reviewed`, `process_merges_head_known`, `process_merges_claims_checked`. Files with the current 39-column header still read, and upgrade on the next append or replace.
- **R3. Model and effort.** A helper call is a `task`, `create_session`, `open_pr_session` or `open_issue_session` call made by a session's own agent (an event with no `agentId`) in any swarm session. It is untiered when a `task` call lacks `model` or `reasoning_effort`, or a session call lacks `kickoff.model` or `kickoff.reasoning_effort`. A call that failed because its arguments were truncated is not counted.
- **R4. Merges.** A merge is a `bash` call running `gh pr merge` whose result reports exit code 0, in any swarm session. It counts once per PR number. Its PR number comes from the command, its head from `--match-head-commit`, and its time from the completion event.
- **R5. Review by another vendor.** A merge is reviewed when a job that the root session's own agent started is labelled `review`, started before the merge, ran on a model whose vendor differs from the merging session's model, and is linked to the merge. A job is linked when it names the merged unit (the longest matching unit wins), or when its evidence before the merge names the PR number or the merged head.
- **R6. Claims check at the merged head.** A merge with a known head is claims-checked when a job labelled `claims` has evidence before the merge that names that head by a 7 to 40 character prefix.
- **R7. Status.** `process_status` is `incomplete` when the logs leave a gap: a merge with no exit code or no PR number, an author model with no known vendor, or a merge count that differs from a numeric `prs_merged`. It is `unavailable` with manual timing, when the swarm logs weren't read, or when the root log is missing; the six count columns are then blank. Without a numeric `prs_merged` nothing cross-checks the merge count, so a missing owner log can hide a merge. The README states this as a limit.
- **R8.** The checks are report-only. The batch report shows them, and the README and `.github/copilot-instructions.md` describe them.

## Background

A read-only analysis of the archived logs of 27 of the 31 runs in `results.csv` (2026-10-26) found:

- **Event shapes.**
  - Tool calls are `tool.execution_start` events with `data.toolCallId`, `data.toolName` and `data.arguments`, and results are `tool.execution_complete` events with `data.success`, `data.result.content` or `data.error`. Calls made inside a sub-agent carry a top-level `agentId`.
  - `subagent.started` events link a `task` call (`data.toolCallId`) to its sub-agent (`agentId`, `data.model`).
  - A child session's `session.start` gives its model in `data.selectedModel`.
- **Tiers.** `task` calls carry `model` and `reasoning_effort`, and session calls carry `kickoff.model` and `kickoff.reasoning_effort`. Every helper ran the model it requested. The only calls without a tier were 4 `create_session` calls that failed with "Tool call arguments truncated by the model output token limit".
- **Merges.**
  - All 99 merges were owner sessions running `gh pr merge N --squash …` in `bash`. None were made by an orchestrator, and none through an MCP tool. The log merge count matched `prs_merged` in every run.
  - 82 of 99 merges named the head with `--match-head-commit`. The result of a `bash` call ends with `<shellId: N completed with exit code X>`.
- **Jobs.**
  - Sub-agent jobs (`task`) have slug names and readable descriptions, for example `review-policy` / "Critical review of policy unit", `claims-policy` / "Claims check Policy PR #2" and `final-panel-opus`.
  - Child-session jobs have free-form names ("Review: CSV import", "Claims: policy") and a unit label in the brief (`You are unit \`policy-review\`: …`).
  - Re-checks are `write_agent` or `send_session_message` calls that name the new head commit, and background reports come back through `read_agent`.
  - Owners report `swarm-status: <status> unit=<unit> pr=github:<n> …` through `send_session_message`.
- **What can't be checked.** Reviews start before their PR exists, and the logs can't tell a rebase-only push from new code. "Reviewed at the exact merged commit" is therefore not checkable. R5 checks for a review before the merge instead.

## Global Constraints

- **Kit scope.** The kit root is `evals/orchestrator/expense-claims/`. Change only the files listed in the tasks, plus `.github/copilot-instructions.md` in Task 7.
- **Runtime.** Node 24 (local v24.19.0). TypeScript runs through Node's type stripping, with no flags and no build step. Tests use the built-in `node:test` runner. No npm dependencies.
- **TypeScript.**
  - Use erasable TypeScript only: no `enum`, `namespace`, parameter properties, `import x = require()` or `export =`.
  - Relative imports include the `.ts` extension.
  - Type-only imports use `import type { X }` or an inline `type` modifier.
- **Report-only.** Process checks never change `outcome`, `minutes`, cost, pass rate, calibration or which runs enter a median. They never throw out of `score`: a failure becomes a `process:` warning and `process_status=unavailable`.
- **Blank, never zero.** Missing data is blank, never `0`. When `process_status` is `unavailable`, the six count columns are empty.
- **No backfill.** Don't rewrite the committed `results.csv` in this change. The next `score` upgrades its header, and older rows keep blank process columns.
- **Read-only logs.** Files under `~/.copilot/session-state/` and `~/orch-evals/` are read-only. Never copy content from real session logs into the repo, and keep test fixtures synthetic.
- **Batch pins.** Live batches pin `score.ts` and everything under `scripts/lib/`, so any change stops a running batch. Land this only when no batch is running.
- **npm.** Run npm and node commands normally from the kit folder. Never use `env -i` or a scratch `HOME`, which bypass this machine's npm proxy.
- **Commits.** Use conventional commit messages (`feat(evals): …`, `test(evals): …`, `docs(evals): …`), with no `Co-authored-by` trailer or other AI attribution.

## File structure

```text
evals/orchestrator/expense-claims/
  scripts/lib/process.ts            new: labels, parsers and checkProcess (Tasks 3, 4)
  scripts/lib/results.ts            seven new columns; reads and upgrades the 39-column header (Task 1)
  scripts/lib/usage.ts              onSession callback; exports createdSession (Task 2)
  scripts/lib/batch/cleanup-io.ts   accepts every known results header (Task 1)
  scripts/lib/batch/report.ts       "Process checks" table (Task 6)
  scripts/score.ts                  runs the checks and fills the columns (Task 5)
  scripts/test/process.test.ts      new (Tasks 3, 4)
  scripts/test/results.test.ts      header upgrade test (Task 1)
  scripts/test/usage.test.ts        onSession test (Task 2)
  scripts/test/score.test.ts        process columns in the end-to-end run (Task 5)
  scripts/test/batch-rehearsal.test.ts  report heading (Task 6)
  README.md                         columns and "Process checks" (Task 7)
.github/copilot-instructions.md     eval kit description (Task 7)
```

Tasks 1, 2 and 3 are independent. Task 4 needs Tasks 2 and 3. Task 5 needs Tasks 1 and 4. Task 6 needs Task 1. Task 7 needs Task 5. Task 8 runs last.

All commands run from `evals/orchestrator/expense-claims/` unless a step says otherwise.

---

### Task 1: Result columns and header upgrade

**Files:**
- Modify: `evals/orchestrator/expense-claims/scripts/lib/results.ts:10-16,58-74`
- Modify: `evals/orchestrator/expense-claims/scripts/lib/batch/cleanup-io.ts:10,220`
- Test: `evals/orchestrator/expense-claims/scripts/test/results.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `PREVIOUS_RESULT_COLUMNS`: the 39 current columns, `as const`.
  - `RESULT_COLUMNS`: those 39 plus `process_status`, `process_helpers`, `process_helpers_untiered`, `process_merges`, `process_merges_reviewed`, `process_merges_head_known`, `process_merges_claims_checked`.
  - `isResultHeader(header: readonly string[]): boolean`.
  - `ResultRow` now has the seven process keys.

- [ ] **Step 1: Write the failing test**

In `scripts/test/results.test.ts`, replace the import block from `../lib/results.ts` with:

```ts
import {
  appendResult,
  defaultCalibration,
  formatSummary,
  isResultHeader,
  LEGACY_RESULT_COLUMNS,
  median,
  parseCsvText,
  PREVIOUS_RESULT_COLUMNS,
  readResults,
  replaceResult,
  RESULT_COLUMNS,
  summarize,
  toCsvLine,
  type ResultRow,
} from "../lib/results.ts";
```

Add this test directly after the test named "old result files migrate without fabricating missing cost or changing historical outcomes":

```ts
test("files with the 39-column header read, then upgrade with blank process columns", () => {
  const path = join(dir, "previous.csv");
  const old = row({ variant: "old", run: "1", cost_status: "complete", cost_usd: "1.5" });
  writeFileSync(path, `${PREVIOUS_RESULT_COLUMNS.join(",")}\n${toCsvLine(PREVIOUS_RESULT_COLUMNS.map((column) => old[column]))}\n`);
  assert.equal(readResults(path)[0].process_status, "");
  appendResult(path, row({ variant: "new", run: "1", process_status: "complete", process_merges: "3" }));
  assert.equal(readFileSync(path, "utf8").split("\n")[0], RESULT_COLUMNS.join(","));
  assert.deepEqual(
    readResults(path).map((r) => [r.variant, r.cost_usd, r.process_status, r.process_merges]),
    [["old", "1.5", "", ""], ["new", "", "complete", "3"]],
  );
  assert.equal(isResultHeader(PREVIOUS_RESULT_COLUMNS), true);
  assert.equal(isResultHeader(LEGACY_RESULT_COLUMNS), true);
  assert.equal(isResultHeader(RESULT_COLUMNS), true);
  assert.equal(isResultHeader(["a", "b"]), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test/results.test.ts`
Expected: FAIL with `SyntaxError: The requested module '../lib/results.ts' does not provide an export named 'PREVIOUS_RESULT_COLUMNS'` (Node names the first missing export it finds).

- [ ] **Step 3: Write the implementation**

In `scripts/lib/results.ts`, replace the `RESULT_COLUMNS` declaration (lines 10-16) with:

```ts
// The 39 columns from before the process checks. Files with this header still read, and upgrade.
export const PREVIOUS_RESULT_COLUMNS = [
  ...LEGACY_RESULT_COLUMNS,
  "agent_revision", "agent_sha256", "agent_bundle_sha256", "main_sha",
  "robustness_status", "robustness_passed", "robustness_total", "robustness_sha256",
  "cost_status", "cost_usd", "pricing_version", "cost_captured_at",
  "cost_sessions", "usage_records", "input_tokens_all_models", "cache_read_tokens_all_models", "cache_write_tokens_all_models", "output_tokens_all_models",
] as const;
export const RESULT_COLUMNS = [
  ...PREVIOUS_RESULT_COLUMNS,
  "process_status", "process_helpers", "process_helpers_untiered",
  "process_merges", "process_merges_reviewed", "process_merges_head_known", "process_merges_claims_checked",
] as const;
```

Directly below the `export type ResultRow = …;` line, add:

```ts
const OLD_HEADERS = [LEGACY_RESULT_COLUMNS.join(","), PREVIOUS_RESULT_COLUMNS.join(",")];

// Whether `header` is the current header, or an older one that readResults reads and appendResult upgrades.
export const isResultHeader = (header: readonly string[]): boolean =>
  [RESULT_COLUMNS.join(","), ...OLD_HEADERS].includes(header.join(","));
```

In `readResults`, replace:

```ts
  if (!header || ![RESULT_COLUMNS.join(","), LEGACY_RESULT_COLUMNS.join(",")].includes(header.join(","))) {
```

with:

```ts
  if (!header || !isResultHeader(header)) {
```

In `appendResult`, replace:

```ts
  else if (readFileSync(path, "utf8").split(/\r?\n/)[0] === LEGACY_RESULT_COLUMNS.join(",")) {
```

with:

```ts
  else if (OLD_HEADERS.includes(readFileSync(path, "utf8").split(/\r?\n/)[0])) {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/test/results.test.ts`
Expected: PASS; the summary shows `fail 0`.

- [ ] **Step 5: Accept every known header in cleanup**

In `scripts/lib/batch/cleanup-io.ts`, replace line 10:

```ts
import { parseCsvText, RESULT_COLUMNS, LEGACY_RESULT_COLUMNS } from "../results.ts";
```

with:

```ts
import { isResultHeader, parseCsvText } from "../results.ts";
```

and replace line 220:

```ts
    if (!header || ![RESULT_COLUMNS.join(","), LEGACY_RESULT_COLUMNS.join(",")].includes(header.join(","))) return "unexpected origin results.csv header";
```

with:

```ts
    if (!header || !isResultHeader(header)) return "unexpected origin results.csv header";
```

Run: `node --test scripts/test/batch-cleanup-io.test.ts scripts/test/batch-plan.test.ts scripts/test/variants.test.ts`
Expected: PASS; the summary shows `fail 0`. The fixture `scripts/test/fixtures/results-run1.csv` still has the 39-column header and must still read.

- [ ] **Step 6: Commit**

```bash
git add evals/orchestrator/expense-claims/scripts/lib/results.ts evals/orchestrator/expense-claims/scripts/lib/batch/cleanup-io.ts evals/orchestrator/expense-claims/scripts/test/results.test.ts
git commit -m "feat(evals): add process-check result columns and read the 39-column header"
```

---

### Task 2: Hand each swarm log to a caller

**Files:**
- Modify: `evals/orchestrator/expense-claims/scripts/lib/usage.ts` (the `createdSession` declaration, the `collectUsage` options type, and the loop that reads each log)
- Test: `evals/orchestrator/expense-claims/scripts/test/usage.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `collectUsage(opts)` accepts `onSession?: (sessionId: string, events: LogEvent[]) => void`. It is called once for each session whose log was read, with that session's events inside the usage window, in discovery order (root first).
  - `export function createdSession(event: LogEvent): string | null` (unchanged behaviour; now exported).

- [ ] **Step 1: Write the failing test**

In `scripts/test/usage.test.ts`, replace:

```ts
import { readPricing, priceUsage, collectUsage } from "../lib/usage.ts";
```

with:

```ts
import { collectUsage, createdSession, priceUsage, readPricing } from "../lib/usage.ts";
```

Add this test directly after the test named "usage includes root, recursive children and in-log subagents once, not unrelated sessions":

```ts
test("collectUsage hands each session's events inside the window to onSession, once per session", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    writeSession(dir, "root", "test/repo", at, [
      ev("tool.execution_start", 2, { toolName: "create_session", toolCallId: "c1" }),
      ev("tool.execution_complete", 3, { toolCallId: "c1", success: true, result: { content: "Created session 'Child' (id: child) in project 'test'." } }),
      ev("session.usage_record", 4, { usage: usage() }),
      ev("session.usage_record", 30, { usage: usage() }),
    ]);
    writeSession(dir, "child", "test/repo", at, [ev("session.usage_record", 5, { usage: usage() })]);
    const seen: [string, number][] = [];
    collectUsage({
      stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:08:00Z", pricing: pricing(),
      onSession: (id, events) => {
        seen.push([id, events.length]);
      },
    });
    assert.deepEqual(seen, [["root", 3], ["child", 1]]);
    assert.equal(
      createdSession(ev("tool.execution_complete", 3, { result: { content: "Created session 'X' (id: abc-1) in project 'p'." } })),
      "abc-1",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test/usage.test.ts`
Expected: FAIL with `SyntaxError: The requested module '../lib/usage.ts' does not provide an export named 'createdSession'`.

- [ ] **Step 3: Write the implementation**

In `scripts/lib/usage.ts`, change:

```ts
function createdSession(event: LogEvent): string | null {
```

to:

```ts
export function createdSession(event: LogEvent): string | null {
```

In the `collectUsage` options type, add this member after `resolveSession?: (reference: string) => string | null;`:

```ts
  // Receives each session's events inside the window, once per session whose log was read.
  onSession?: (sessionId: string, events: LogEvent[]) => void;
```

In the loop, directly after the `try { … } catch (error) { … continue; }` block that reads the log, and before `if (opts.children) {`, add:

```ts
    opts.onSession?.(id, events);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/test/usage.test.ts`
Expected: PASS; the summary shows `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/scripts/lib/usage.ts evals/orchestrator/expense-claims/scripts/test/usage.test.ts
git commit -m "feat(evals): let collectUsage hand each swarm log to its caller"
```

---

### Task 3: Labels and parsers

**Files:**
- Create: `evals/orchestrator/expense-claims/scripts/lib/process.ts`
- Create: `evals/orchestrator/expense-claims/scripts/test/process.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Vendor = "anthropic" | "openai" | "google"`.
  - `type JobLabel = "claims" | "disagreement" | "panel" | "review" | "other"`.
  - `vendorOf(model: string): Vendor | null`.
  - `unitFromBrief(brief: string): string` (`""` when none).
  - `labelJob(parts: string[], brief: string): JobLabel`.
  - `parseMergeCommand(command: string): { pr: number | null; head: string | null } | null`. The head is lower case, and the result is `null` for a command that isn't `gh pr merge`.
  - `mentionsHead(text: string, head: string): boolean`.
  - `namesUnit(job: { name: string; description: string; unit: string }, unit: string): boolean`.
  - The module-level `norm(value: string): string` is used by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `scripts/test/process.test.ts`:

```ts
// Synthetic inputs only. Never copy anything from a real session log here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { labelJob, mentionsHead, namesUnit, parseMergeCommand, unitFromBrief, vendorOf } from "../lib/process.ts";

test("vendors come from the model family", () => {
  assert.equal(vendorOf("claude-opus-5.5"), "anthropic");
  assert.equal(vendorOf("gpt-6-astra"), "openai");
  assert.equal(vendorOf("gemini-4-argon"), "google");
  assert.equal(vendorOf("auto"), null);
  assert.equal(vendorOf(""), null);
});

test("unit labels come from the brief", () => {
  assert.equal(unitFromBrief("You are unit `policy-review`: a one-off critical code reviewer."), "policy-review");
  assert.equal(unitFromBrief("Unit label: `reports-f1-judge-opus`"), "reports-f1-judge-opus");
  assert.equal(unitFromBrief("Your unit label is `api`."), "api");
  assert.equal(unitFromBrief("No label here."), "");
});

test("jobs are labelled from their name, description and unit, and the first match wins", () => {
  const longReviewBrief = `Role: independent critical code reviewer.${" Context.".repeat(60)} Tiers: Disagreement panel.`;
  const cases: [string[], string, string][] = [
    [["claims-policy", "Claims check Policy PR #2", ""], "", "claims"],
    [["Policy claims check", "", ""], "", "claims"],
    [["Claims: policy", "", ""], "", "claims"],
    [["Check", "", "csv-import-claims"], "", "claims"],
    [["Expense claims recon", "", ""], "", "other"],
    [["dispute-judge-argon", "Disagreement judge (Argon)", ""], "", "disagreement"],
    [["Reports F1 judge (Opus)", "", ""], "An independent judge on a disputed code-review finding.", "disagreement"],
    [["final-panel-opus", "Final panel judge (Opus)", ""], "", "panel"],
    [["review-policy", "Critical review of policy unit", ""], longReviewBrief, "review"],
    [["Review: CSV import", "", "csv-import-review"], "", "review"],
    [["repo-recon", "Summarise repo", ""], "", "other"],
  ];
  for (const [parts, brief, label] of cases) assert.equal(labelJob(parts, brief), label, parts.join(" | "));
});

test("merge commands give the PR number and the head commit when they name them", () => {
  assert.deepEqual(parseMergeCommand("gh pr merge 3 --squash --match-head-commit ABCDEF1234567"), { pr: 3, head: "abcdef1234567" });
  assert.deepEqual(parseMergeCommand("gh pr merge https://github.com/o/r/pull/12 --squash"), { pr: 12, head: null });
  assert.deepEqual(parseMergeCommand("git fetch -q && gh pr merge 4 --squash --delete-branch; echo done"), { pr: 4, head: null });
  assert.deepEqual(parseMergeCommand("gh pr merge --squash"), { pr: null, head: null });
  assert.equal(parseMergeCommand("gh pr view 3 --json state"), null);
});

test("a head commit is found by any 7 to 40 character prefix in the text", () => {
  const head = "1111111aaaaaaa2222222bbbbbbb3333333ccccc";
  assert.equal(mentionsHead("checked at 1111111 on main", head), true);
  assert.equal(mentionsHead(`commit=${head}`, head), true);
  assert.equal(mentionsHead("checked at 111111 (six characters)", head), false);
  assert.equal(mentionsHead("checked at 2222222bbbb", head), false);
});

test("a job names a unit only as whole words", () => {
  const job = (name: string, description = "", unit = "") => ({ name, description, unit });
  assert.equal(namesUnit(job("review-policy"), "policy"), true);
  assert.equal(namesUnit(job("Review: CSV import"), "csv-import"), true);
  assert.equal(namesUnit(job("x", "", "csv-import-review"), "csv-import"), true);
  assert.equal(namesUnit(job("review-policyx"), "policy"), false);
  assert.equal(namesUnit(job("review"), ""), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/process.test.ts`
Expected: FAIL with `Cannot find module` for `../lib/process.ts` (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/process.ts`:

```ts
// Process checks: whether a run followed three of the orchestrator's rules, read from the swarm's
// session logs. They are reported only and never change the gate, minutes, cost or pass rate.
// README "Process checks" has the definitions and their limits.

export type Vendor = "anthropic" | "openai" | "google";
export type JobLabel = "claims" | "disagreement" | "panel" | "review" | "other";

export function vendorOf(model: string): Vendor | null {
  if (/^claude-/i.test(model)) return "anthropic";
  if (/^gpt-/i.test(model)) return "openai";
  if (/^gemini-/i.test(model)) return "google";
  return null;
}

// The unit label a brief gives, for example "You are unit `policy-review`" or "Your unit label is `api`".
export function unitFromBrief(brief: string): string {
  return /\bunit(?: label)?(?: is)?:?\s*`([A-Za-z0-9._-]{1,32})`/i.exec(brief)?.[1] ?? "";
}

// The first match wins. `parts` are the job's name, description and unit label. Only the opening of
// the brief, where it states the job's role, can mark a disagreement judge; a tier table later in a
// brief can't.
export function labelJob(parts: string[], brief: string): JobLabel {
  const any = (pattern: RegExp) => parts.some((part) => pattern.test(part));
  if (any(/claims?[-_ ]?check/i) || any(/^claims\b/i) || any(/[-_]claims$/i)) return "claims";
  if (any(/disagree|dispute/i) || /disputed|disagreement panel/i.test(brief.slice(0, 300))) return "disagreement";
  if (any(/panel|judge/i)) return "panel";
  if (any(/review/i)) return "review";
  return "other";
}

// The PR number and head commit that a `gh pr merge` command names, or null for any other command.
export function parseMergeCommand(command: string): { pr: number | null; head: string | null } | null {
  const merge = /\bgh\s+pr\s+merge\b([^;&|\n]*)/.exec(command);
  if (!merge) return null;
  const rest = merge[1];
  const pr = /^\s+(?:\S*\/pull\/)?#?(\d+)\b/.exec(rest)?.[1] ?? /\/pull\/(\d+)\b/.exec(rest)?.[1];
  const head = /--match-head-commit(?:=|\s+)([0-9a-f]{7,40})\b/i.exec(rest)?.[1];
  return { pr: pr === undefined ? null : Number(pr), head: head === undefined ? null : head.toLowerCase() };
}

// Whether the text names the commit `head` by a 7 to 40 character prefix.
export function mentionsHead(text: string, head: string): boolean {
  return [...text.matchAll(/\b[0-9a-f]{7,40}\b/gi)].some(([token]) => {
    const lower = token.toLowerCase();
    return head.startsWith(lower) || lower.startsWith(head);
  });
}

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Whether the job's name, description or unit label contains `unit` as whole words.
export function namesUnit(job: { name: string; description: string; unit: string }, unit: string): boolean {
  const wanted = norm(unit);
  return wanted !== "" && [job.name, job.description, job.unit].some((part) => `-${norm(part)}-`.includes(`-${wanted}-`));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/process.test.ts`
Expected: PASS; the summary shows `tests 6` and `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/scripts/lib/process.ts evals/orchestrator/expense-claims/scripts/test/process.test.ts
git commit -m "feat(evals): add job labels and merge parsing for process checks"
```

---

### Task 4: `checkProcess`

**Files:**
- Modify: `evals/orchestrator/expense-claims/scripts/lib/process.ts`
- Modify: `evals/orchestrator/expense-claims/scripts/test/process.test.ts`

**Interfaces:**
- Consumes:
  - `createdSession(event: LogEvent): string | null` from `./usage.ts` (Task 2).
  - `type LogEvent` from `./events.ts`.
  - `vendorOf`, `unitFromBrief`, `labelJob`, `parseMergeCommand`, `mentionsHead`, `namesUnit` and `norm` (Task 3).
- Produces:
  - `interface ProcessSummary { status: "complete" | "incomplete" | "unavailable"; helpers: number; untiered: number; merges: number; reviewed: number; headKnown: number; claimsChecked: number; warnings: string[] }`.
  - `unavailableProcess(warning: string): ProcessSummary`.
  - `checkProcess(input: { rootId: string; rootModel: string; sessions: Map<string, LogEvent[]>; githubMerges: number | null }): ProcessSummary`.

- [ ] **Step 1: Write the failing tests**

In `scripts/test/process.test.ts`, replace:

```ts
import { labelJob, mentionsHead, namesUnit, parseMergeCommand, unitFromBrief, vendorOf } from "../lib/process.ts";
```

with:

```ts
import type { LogEvent } from "../lib/events.ts";
import { checkProcess, labelJob, mentionsHead, namesUnit, parseMergeCommand, unitFromBrief, vendorOf } from "../lib/process.ts";
import { ev } from "./fixtures/events.ts";
```

Append to the end of the file:

```ts
const HEAD = "1111111aaaaaaa2222222bbbbbbb3333333ccccc";

const start = (minute: number, callId: string, toolName: string, args: Record<string, unknown>, agentId?: string): LogEvent =>
  ev("tool.execution_start", minute, { toolCallId: callId, toolName, arguments: args }, agentId);
const done = (minute: number, callId: string, content: string): LogEvent =>
  ev("tool.execution_complete", minute, { toolCallId: callId, success: true, result: { content } });
const truncated = (minute: number, callId: string): LogEvent =>
  ev("tool.execution_complete", minute, {
    toolCallId: callId, success: false, error: { message: "Tool call arguments truncated by the model output token limit" },
  });

// A sync task: its sub-agent starts at once and reports a minute later.
function taskJob(minute: number, callId: string, agentId: string, args: Record<string, unknown>, report: string): LogEvent[] {
  return [
    start(minute, callId, "task", args),
    ev("subagent.started", minute, { toolCallId: callId, model: args.model }, agentId),
    done(minute + 1, callId, report),
  ];
}

// An owner session: it reports its unit and PR, then runs one merge command.
function owner(unit: string, pr: number, mergeMinute: number, command: string, exit = 0, model = "claude-opus-5.5"): LogEvent[] {
  return [
    ev("session.start", 1, { selectedModel: model, reasoningEffort: "high" }),
    start(2, `report-${unit}`, "send_session_message", { session_id: "root", message: `swarm-status: progress unit=${unit} pr=github:${pr}\nSummary: PR open.` }),
    done(2, `report-${unit}`, "Sent."),
    start(mergeMinute, `merge-${unit}`, "bash", { command }),
    done(mergeMinute, `merge-${unit}`, `Merged.\n<shellId: 7 completed with exit code ${exit}>`),
  ];
}

interface Overrides {
  reviewModel?: string;
  reviewMinute?: number;
  reviewName?: string;
  reviewDescription?: string;
  claimsText?: string;
  mergeCommand?: string;
}

// A sub-agent-family run that follows the rules: one owner, a review, a claims check, an untiered
// helper and a truncated call that never ran.
function taskSwarm(overrides: Overrides = {}): Map<string, LogEvent[]> {
  const root = [
    start(1, "own-policy", "create_session", { name: "Policy", kickoff: { model: "claude-opus-5.5", reasoning_effort: "high", prompt: "Your unit label is `policy`." } }),
    done(1, "own-policy", "Created session 'Policy' (id: child-policy) in project 'test'."),
    ...taskJob(overrides.reviewMinute ?? 5, "rev", "agent-rev", {
      agent_type: "wintermute:orchestrator-worker",
      name: overrides.reviewName ?? "review-policy",
      description: overrides.reviewDescription ?? "Critical review of policy unit",
      model: overrides.reviewModel ?? "gpt-6-astra",
      reasoning_effort: "xhigh",
      prompt: "Role: independent critical code reviewer.",
    }, "No must-fix findings."),
    ...taskJob(7, "claims", "agent-claims", {
      agent_type: "wintermute:orchestrator-worker",
      name: "claims-policy",
      description: "Claims check Policy PR #1",
      model: "claude-sonnet-5.5",
      reasoning_effort: "low",
      prompt: overrides.claimsText ?? `Role: claims checker. Check commit ${HEAD.slice(0, 12)}.`,
    }, "Claims hold."),
    start(8, "recon", "task", { agent_type: "wintermute:orchestrator-worker", name: "repo-recon", description: "Summarise repo", prompt: "Summarise." }),
    done(9, "recon", "Summary."),
    start(9, "cut", "create_session", {}),
    truncated(9, "cut"),
  ];
  const child = owner("policy", 1, 12, overrides.mergeCommand ?? `gh pr merge 1 --squash --match-head-commit ${HEAD}`);
  return new Map([["root", root], ["child-policy", child]]);
}

const run = (overrides: Overrides = {}, githubMerges: number | null = 1) =>
  checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions: taskSwarm(overrides), githubMerges });

test("a sub-agent-family run that follows the rules passes every check", () => {
  assert.deepEqual(run(), { status: "complete", helpers: 4, untiered: 1, merges: 1, reviewed: 1, headKnown: 1, claimsChecked: 1, warnings: [] });
});

test("a review counts only from another vendor, before the merge, for the merged unit", () => {
  assert.equal(run({ reviewModel: "claude-opus-5.5" }).reviewed, 0, "same vendor as the author");
  assert.equal(run({ reviewMinute: 13 }).reviewed, 0, "started after the merge");
  assert.equal(run({ reviewName: "review-reports", reviewDescription: "Critical review of reports unit" }).reviewed, 0, "another unit");
});

test("a claims check counts only when it named the merged head before the merge", () => {
  assert.equal(run({ claimsText: "Role: claims checker. Check commit 9999999fffffff." }).claimsChecked, 0);
  const noHead = run({ mergeCommand: "gh pr merge 1 --squash" });
  assert.deepEqual([noHead.merges, noHead.headKnown, noHead.claimsChecked, noHead.status], [1, 0, 0, "complete"]);
});

test("failed merges don't count, and gaps in the logs make the result incomplete", () => {
  const afterFailure = taskSwarm();
  afterFailure.set("child-policy", owner("policy", 1, 12, `gh pr merge 1 --squash --match-head-commit ${HEAD}`, 1));
  const failedRun = checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions: afterFailure, githubMerges: 1 });
  assert.deepEqual([failedRun.merges, failedRun.status], [0, "incomplete"]);
  assert.match(failedRun.warnings.join("\n"), /the logs show 0 merges but GitHub shows 1/);

  const noNumber = run({ mergeCommand: "gh pr merge --squash" });
  assert.deepEqual([noNumber.merges, noNumber.status], [1, "incomplete"]);
  assert.match(noNumber.warnings.join("\n"), /names no PR number/);

  const noExit = taskSwarm();
  noExit.set("child-policy", noExit.get("child-policy")!.map((event) =>
    event.type === "tool.execution_complete" && event.data?.toolCallId === "merge-policy"
      ? { ...event, data: { ...event.data, result: { content: "Merged." } } }
      : event));
  const unknownExit = checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions: noExit, githubMerges: null });
  assert.deepEqual([unknownExit.merges, unknownExit.status], [0, "incomplete"]);
  assert.match(unknownExit.warnings.join("\n"), /gh pr merge at .* has no exit code/);

  assert.equal(checkProcess({ rootId: "missing", rootModel: "", sessions: taskSwarm(), githubMerges: null }).status, "unavailable");
});

test("helper calls count in every session's own agent but not in sub-agents, and owners' self-reviews aren't independent", () => {
  const sessions = taskSwarm({ reviewModel: "claude-opus-5.5" });
  sessions.get("child-policy")!.push(
    start(6, "self", "task", { agent_type: "code-review", name: "self-review", model: "gpt-6-astra", reasoning_effort: "high", prompt: "Review my branch." }),
    done(7, "self", "Looks fine."),
    start(6, "inner", "task", { agent_type: "explore", prompt: "Look around." }, "sub-1"),
  );
  const result = checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions, githubMerges: 1 });
  assert.deepEqual([result.helpers, result.untiered, result.reviewed], [5, 1, 0]);
});

test("child-session jobs link through names, unit labels and re-check messages", () => {
  const root = [
    start(1, "own", "create_session", { name: "Policy feature", kickoff: { agent: "wintermute:session-worker", model: "claude-opus-5.5", reasoning_effort: "high", prompt: "Your unit label is `policy`." } }),
    done(1, "own", "Created session 'Policy feature' (id: s-owner) in project 'test'."),
    start(4, "rev", "create_session", { name: "Policy critical review", kickoff: { agent: "wintermute:session-worker", model: "gemini-4-argon", reasoning_effort: "xhigh", prompt: "You are unit `policy-review`: a one-off critical code reviewer." } }),
    done(4, "rev", "Created session 'Policy critical review' (id: s-rev) in project 'test'."),
    start(6, "cl", "create_session", { name: "Claims: policy", kickoff: { agent: "wintermute:session-worker", model: "claude-sonnet-5.5", reasoning_effort: "medium", prompt: "You are unit `policy-claims`: check the owner's claims." } }),
    done(6, "cl", "Created session 'Claims: policy' (id: s-claims) in project 'test'."),
    start(9, "recheck", "send_session_message", { session_id: "s-claims", message: `Re-check PR #1 at ${HEAD.slice(0, 7)}.` }),
    done(9, "recheck", "Sent."),
  ];
  const reviewer = [
    ev("session.start", 4, { selectedModel: "gemini-4-argon", reasoningEffort: "xhigh" }),
    start(8, "rep", "send_session_message", { session_id: "root", message: "swarm-status: complete unit=policy-review pr=github:1\nSummary: No findings." }),
    done(8, "rep", "Sent."),
  ];
  const sessions = new Map<string, LogEvent[]>([
    ["root", root],
    ["s-owner", owner("policy", 1, 12, `gh pr merge 1 --squash --match-head-commit ${HEAD}`)],
    ["s-rev", reviewer],
  ]);
  assert.deepEqual(
    checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions, githubMerges: 1 }),
    { status: "complete", helpers: 3, untiered: 0, merges: 1, reviewed: 1, headKnown: 1, claimsChecked: 1, warnings: [] },
  );
});

test("a job that names several units belongs to the longest, so api-2's review doesn't count for api", () => {
  const root = [
    start(1, "rev2", "task", { name: "review-api-2", description: "Review of api-2", model: "gpt-6-astra", reasoning_effort: "high", prompt: "Review." }),
    done(2, "rev2", "No findings."),
  ];
  const sessions = new Map<string, LogEvent[]>([
    ["root", root],
    ["s-api", owner("api", 1, 10, `gh pr merge 1 --squash --match-head-commit ${HEAD}`)],
    ["s-api-2", owner("api-2", 2, 11, "gh pr merge 2 --squash --match-head-commit 4444444ddddddd")],
  ]);
  const result = checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions, githubMerges: 2 });
  assert.deepEqual([result.merges, result.reviewed], [2, 1]);
});

test("a background claims check is linked through its start notice and read_agent", () => {
  const root = [
    start(3, "bg", "task", { name: "claims-policy", description: "Claims check", model: "claude-sonnet-5.5", reasoning_effort: "low", mode: "background", prompt: "Check the owner's claims." }),
    done(3, "bg", "Agent started in background with agent_id: bg-1."),
    start(9, "read", "read_agent", { agent_id: "bg-1", wait: true }),
    done(10, "read", `Report: tests ran at ${HEAD.slice(0, 10)}.`),
  ];
  const sessions = new Map<string, LogEvent[]>([["root", root], ["s-owner", owner("policy", 1, 12, `gh pr merge 1 --squash --match-head-commit ${HEAD}`)]]);
  assert.equal(checkProcess({ rootId: "root", rootModel: "claude-opus-5.5", sessions, githubMerges: 1 }).claimsChecked, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/test/process.test.ts`
Expected: FAIL with `SyntaxError: The requested module '../lib/process.ts' does not provide an export named 'checkProcess'`.

- [ ] **Step 3: Write the implementation**

At the top of `scripts/lib/process.ts`, directly below the header comment and above `export type Vendor`, add:

```ts
import type { LogEvent } from "./events.ts";
import { createdSession } from "./usage.ts";
```

Append to the end of `scripts/lib/process.ts`:

```ts
export interface ProcessSummary {
  status: "complete" | "incomplete" | "unavailable";
  helpers: number;
  untiered: number;
  merges: number;
  reviewed: number;
  headKnown: number;
  claimsChecked: number;
  warnings: string[];
}

interface Evidence {
  at: number;
  text: string;
}

// A helper job that the root session's own agent started: a task sub-agent or a child session.
interface Job {
  start: number;
  name: string;
  description: string;
  unit: string;
  model: string;
  agentId: string | null;
  sessionId: string | null;
  label: JobLabel;
  // The brief, every message sent to the job and every report from it, each with its time.
  evidence: Evidence[];
}

interface Merge {
  session: string;
  callId: string;
  pr: number | null;
  head: string | null;
  at: number;
}

interface UnitReport {
  unit: string;
  pr: number | null;
}

const SESSION_TOOLS = ["create_session", "open_pr_session", "open_issue_session"];
const STATUS_LINE = /^swarm-status: \S+ unit=([A-Za-z0-9._-]{1,32})(?: pr=(?:github|ado):(\d+))?/gm;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const toolOf = (event: LogEvent): string => str(event.data?.toolName).split(/[./]/).at(-1) ?? "";
const callOf = (event: LogEvent): string => str(event.data?.toolCallId);
const timeOf = (event: LogEvent): number => Date.parse(event.timestamp);
const argsOf = (event: LogEvent): Record<string, unknown> => record(event.data?.arguments) ?? {};
// A call made by the session's own agent, not by one of its sub-agents.
const ownCall = (event: LogEvent): boolean => event.type === "tool.execution_start" && !event.agentId;
const startsHelper = (event: LogEvent): boolean => ownCall(event) && (toolOf(event) === "task" || SESSION_TOOLS.includes(toolOf(event)));
const mentionsPr = (text: string, pr: number): boolean => new RegExp(String.raw`(?:#|\bPR\s*#?\s*|/pull/)${pr}\b`, "i").test(text);

function completions(events: LogEvent[]): Map<string, LogEvent> {
  const byCall = new Map<string, LogEvent>();
  for (const event of events) {
    if (event.type === "tool.execution_complete" && callOf(event) && !byCall.has(callOf(event))) byCall.set(callOf(event), event);
  }
  return byCall;
}

function resultText(event: LogEvent | undefined): string {
  const data = event?.data ?? {};
  const result = record(data.result);
  const error = record(data.error);
  return [str(result?.content), str(result?.detailedContent), str(error?.message), str(data.error)].filter(Boolean).join("\n");
}

export function unavailableProcess(warning: string): ProcessSummary {
  return { status: "unavailable", helpers: 0, untiered: 0, merges: 0, reviewed: 0, headKnown: 0, claimsChecked: 0, warnings: [warning] };
}

function helperCalls(events: LogEvent[]): { helpers: number; untiered: number } {
  const done = completions(events);
  let helpers = 0;
  let untiered = 0;
  for (const event of events) {
    if (!startsHelper(event)) continue;
    const completion = done.get(callOf(event));
    // The model's output limit cut these arguments off, so the call never ran.
    if (completion?.data?.success === false && /arguments truncated/i.test(resultText(completion))) continue;
    const args = argsOf(event);
    const settings = toolOf(event) === "task" ? args : record(args.kickoff) ?? {};
    helpers++;
    if (!str(settings.model) || !str(settings.reasoning_effort)) untiered++;
  }
  return { helpers, untiered };
}

function rootJobs(events: LogEvent[]): Job[] {
  const done = completions(events);
  const started = new Map<string, LogEvent>();
  for (const event of events) {
    if (event.type === "subagent.started" && event.agentId && callOf(event)) started.set(callOf(event), event);
  }
  const jobs: Job[] = [];
  for (const event of events) {
    if (!startsHelper(event)) continue;
    const completion = done.get(callOf(event));
    if (completion?.data?.success === false) continue;
    const task = toolOf(event) === "task";
    const args = argsOf(event);
    const kickoff = record(args.kickoff) ?? {};
    const brief = str(task ? args.prompt : kickoff.prompt);
    const name = str(args.name);
    const description = str(args.description);
    const unit = unitFromBrief(brief);
    const sub = started.get(callOf(event));
    jobs.push({
      start: timeOf(event),
      name,
      description,
      unit,
      model: task ? str(sub?.data?.model) || str(args.model) : str(kickoff.model),
      // A background task's start notice names its sub-agent when no subagent.started event does.
      agentId: task ? sub?.agentId ?? /agent_id:\s*([A-Za-z0-9-]+)/.exec(resultText(completion))?.[1] ?? null : null,
      sessionId: !task && completion ? createdSession(completion) : null,
      label: labelJob([name, description, unit], brief),
      evidence: [
        { at: timeOf(event), text: brief },
        ...(task && completion ? [{ at: timeOf(completion), text: resultText(completion) }] : []),
      ],
    });
  }
  const byAgent = new Map<string, Job>();
  const bySession = new Map<string, Job>();
  for (const job of jobs) {
    if (job.agentId) byAgent.set(job.agentId, job);
    if (job.sessionId) bySession.set(job.sessionId, job);
  }
  for (const event of events) {
    if (ownCall(event)) {
      const args = argsOf(event);
      const tool = toolOf(event);
      if (tool === "write_agent") {
        const targets = [str(args.agent_id), ...(Array.isArray(args.agent_ids) ? args.agent_ids.map(str) : [])];
        for (const target of targets) byAgent.get(target)?.evidence.push({ at: timeOf(event), text: str(args.message) });
      } else if (tool === "send_session_message") {
        bySession.get(str(args.session_id))?.evidence.push({ at: timeOf(event), text: str(args.message) });
      } else if (tool === "read_agent") {
        const completion = done.get(callOf(event));
        const job = byAgent.get(str(args.agent_id));
        if (job && completion) job.evidence.push({ at: timeOf(completion), text: resultText(completion) });
      }
    } else if (event.type === "user.message") {
      const source = str(event.data?.source);
      const job = source.startsWith("agent-") ? bySession.get(source.slice("agent-".length)) : undefined;
      if (job) job.evidence.push({ at: timeOf(event), text: `${str(event.data?.content)}\n${str(event.data?.transformedContent)}` });
    }
  }
  return jobs;
}

function sessionMerges(session: string, events: LogEvent[], warnings: string[]): Merge[] {
  const done = completions(events);
  const merges: Merge[] = [];
  for (const event of events) {
    if (event.type !== "tool.execution_start" || toolOf(event) !== "bash") continue;
    const parsed = parseMergeCommand(str(argsOf(event).command));
    const completion = done.get(callOf(event));
    if (!parsed || !completion || completion.data?.success === false) continue;
    const code = /exit code (-?\d+)/i.exec(resultText(completion))?.[1];
    if (code === undefined) warnings.push(`${session}: gh pr merge at ${event.timestamp} has no exit code`);
    else if (code === "0") merges.push({ session, callId: callOf(event), pr: parsed.pr, head: parsed.head, at: timeOf(completion) });
  }
  return merges;
}

// The swarm-status lines a session sent: its own unit label and, once it has one, its PR.
function reportedUnits(events: LogEvent[]): UnitReport[] {
  const found: UnitReport[] = [];
  for (const event of events) {
    if (!ownCall(event) || toolOf(event) !== "send_session_message") continue;
    for (const match of str(argsOf(event).message).matchAll(STATUS_LINE)) {
      found.push({ unit: match[1], pr: match[2] === undefined ? null : Number(match[2]) });
    }
  }
  return found;
}

export function checkProcess(input: {
  rootId: string;
  rootModel: string;
  sessions: Map<string, LogEvent[]>;
  githubMerges: number | null;
}): ProcessSummary {
  const rootEvents = input.sessions.get(input.rootId);
  if (!rootEvents) return unavailableProcess(`no log for the root session ${input.rootId}`);
  const warnings: string[] = [];
  let helpers = 0;
  let untiered = 0;
  const found: Merge[] = [];
  const reports = new Map<string, UnitReport[]>();
  for (const [session, events] of input.sessions) {
    const calls = helperCalls(events);
    helpers += calls.helpers;
    untiered += calls.untiered;
    found.push(...sessionMerges(session, events, warnings));
    reports.set(session, reportedUnits(events));
  }
  // A retried merge of the same PR counts once.
  const seen = new Set<string>();
  const merges = found.sort((a, b) => a.at - b.at).filter((merge) => {
    const key = merge.pr === null ? `${merge.session}:${merge.callId}` : `#${merge.pr}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // A merged PR's unit is the label its merging session reported; failing that, the shortest label
  // that any report gave the PR.
  const unitByPr = new Map<number, string>();
  for (const list of reports.values()) {
    for (const { unit, pr } of list) {
      if (pr === null) continue;
      const known = unitByPr.get(pr);
      if (known === undefined || unit.length < known.length) unitByPr.set(pr, unit);
    }
  }
  const unitOf = (merge: Merge): string =>
    reports.get(merge.session)?.[0]?.unit ?? (merge.pr === null ? "" : unitByPr.get(merge.pr) ?? "");
  const ownerUnits = [...new Set(merges.map(unitOf).filter((unit) => unit !== ""))];
  const jobs = rootJobs(rootEvents);
  // A job that names several units belongs to the longest, so "review-api-2" isn't api's review.
  const jobUnits = new Map<Job, string[]>();
  for (const job of jobs) {
    const named = ownerUnits.filter((unit) => namesUnit(job, unit));
    const longest = Math.max(0, ...named.map((unit) => norm(unit).length));
    jobUnits.set(job, named.filter((unit) => norm(unit).length === longest));
  }
  let reviewed = 0;
  let headKnown = 0;
  let claimsChecked = 0;
  for (const merge of merges) {
    const what = merge.pr === null ? `the merge at ${new Date(merge.at).toISOString()}` : `PR #${merge.pr}`;
    if (merge.pr === null) warnings.push(`${merge.session}: ${what} names no PR number`);
    const unit = unitOf(merge);
    const authorModel = merge.session === input.rootId
      ? input.rootModel
      : str(input.sessions.get(merge.session)?.find((event) => event.type === "session.start")?.data?.selectedModel);
    const author = vendorOf(authorModel);
    if (author === null) warnings.push(`${merge.session}: the author model "${authorModel}" of ${what} has no known vendor`);
    const before = (job: Job): Evidence[] => job.evidence.filter((item) => item.at < merge.at);
    const linked = (job: Job): boolean =>
      (unit !== "" && jobUnits.get(job)!.includes(unit)) ||
      before(job).some((item) =>
        (merge.pr !== null && mentionsPr(item.text, merge.pr)) || (merge.head !== null && mentionsHead(item.text, merge.head)));
    const reviewer = (job: Job): boolean => {
      const vendor = vendorOf(job.model);
      return job.label === "review" && job.start < merge.at && vendor !== null && vendor !== author && linked(job);
    };
    if (author !== null && jobs.some(reviewer)) reviewed++;
    const head = merge.head;
    if (head !== null) {
      headKnown++;
      if (jobs.some((job) => job.label === "claims" && before(job).some((item) => mentionsHead(item.text, head)))) claimsChecked++;
    }
  }
  if (input.githubMerges !== null && input.githubMerges !== merges.length) {
    warnings.push(`the logs show ${merges.length} merges but GitHub shows ${input.githubMerges}`);
  }
  return {
    status: warnings.length > 0 ? "incomplete" : "complete",
    helpers, untiered, merges: merges.length, reviewed, headKnown, claimsChecked, warnings,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test scripts/test/process.test.ts`
Expected: PASS; the summary shows `tests 14` and `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/scripts/lib/process.ts evals/orchestrator/expense-claims/scripts/test/process.test.ts
git commit -m "feat(evals): check model tiers, cross-vendor reviews and claims checks from swarm logs"
```

---

### Task 5: Run the checks in `score`

**Files:**
- Modify: `evals/orchestrator/expense-claims/scripts/score.ts` (imports, a new helper above `seedFeatures`, and `main()`)
- Test: `evals/orchestrator/expense-claims/scripts/test/score.test.ts:69-136`

**Interfaces:**
- Consumes:
  - `checkProcess`, `unavailableProcess` and `ProcessSummary` (Task 4).
  - `collectUsage`'s `onSession` (Task 2).
  - The `ResultRow` process keys (Task 1).
- Produces: `score` fills the seven process columns and prints each process warning as `Warning: process: <text>`. Like every `score` warning, process warnings also go into `note`, and the batch runner turns those lines into `score-warning` flags.

- [ ] **Step 1: Write the failing test**

In `scripts/test/score.test.ts`, in the test "score times a synthetic session, runs the seed's suite on a fresh clone and appends or replaces a row", replace:

```ts
    ev("tool.execution_start", 2, { toolName: "create_session", toolCallId: "child1" }),
```

with:

```ts
    ev("tool.execution_start", 2, {
      toolName: "create_session", toolCallId: "child1",
      arguments: { name: "one", kickoff: { model: "claude-opus-5.5", reasoning_effort: "high", prompt: "synthetic kickoff" } },
    }),
```

In the same test's `expected` object, add after `output_tokens_all_models: "500",`:

```ts
    process_status: "complete",
    process_helpers: "2",
    process_helpers_untiered: "1",
    process_merges: "0",
    process_merges_reviewed: "0",
    process_merges_head_known: "0",
    process_merges_claims_checked: "0",
```

Directly after the line `for (const [column, value] of Object.entries(expected)) assert.equal(rows[0][column as keyof typeof expected], value, column);`, add:

```ts
  assert.doesNotMatch(ok.stdout, /Warning: process:/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test --test-name-pattern="appends or replaces a row" scripts/test/score.test.ts`
Expected: FAIL with `AssertionError [ERR_ASSERTION]: process_status`. The column exists since Task 1, but `score` leaves it empty.

- [ ] **Step 3: Write the implementation**

In `scripts/score.ts`, replace line 5:

```ts
import { chooseRunSession, computeTiming, EventLogError, readEventLog, SessionChoiceError } from "./lib/events.ts";
```

with:

```ts
import { chooseRunSession, computeTiming, EventLogError, readEventLog, SessionChoiceError, type LogEvent } from "./lib/events.ts";
```

Directly after `import { run } from "./lib/proc.ts";`, add:

```ts
import { checkProcess, unavailableProcess, type ProcessSummary } from "./lib/process.ts";
```

Directly above the comment `// The feature set the run started with: the spec in the run repo's first commit (new-run's "Seed v1").`, add:

```ts
// Process checks read the same swarm logs and window as cost. They never change the gate or minutes.
function processChecks(rootId: string, rootModel: string, swarm: Map<string, LogEvent[]>, prsMerged: string): ProcessSummary | null {
  if (rootId === "manual") return null;
  if (swarm.size === 0) return unavailableProcess("the swarm's logs were not read");
  try {
    return checkProcess({ rootId, rootModel, sessions: swarm, githubMerges: /^\d+$/.test(prsMerged) ? Number(prsMerged) : null });
  } catch (error) {
    return unavailableProcess((error as Error).message);
  }
}

```

In `main()`, replace:

```ts
  const costWarnings: string[] = [];
  const costNotes: string[] = [];
  if (timing.session !== "manual") {
```

with:

```ts
  const costWarnings: string[] = [];
  const costNotes: string[] = [];
  const swarm = new Map<string, LogEvent[]>();
  if (timing.session !== "manual") {
```

In the `collectUsage({ … })` call, replace:

```ts
        stateDir: resolve(values["state-dir"]), rootId: timing.session, start: timing.start, capturedAt, pricing,
        resolveSession: (id: string) => db.sessionForWorkspace(id),
```

with:

```ts
        stateDir: resolve(values["state-dir"]), rootId: timing.session, start: timing.start, capturedAt, pricing,
        onSession: (id: string, events: LogEvent[]) => {
          swarm.set(id, events);
        },
        resolveSession: (id: string) => db.sessionForWorkspace(id),
```

Directly after:

```ts
    const { prsMerged, mainCi } = github ? await githubStats(github, cloneDir, warnings) : { prsMerged: "n/a", mainCi: "n/a" };
```

add:

```ts
    const checks = processChecks(timing.session, timing.model, swarm, prsMerged);
    const processWarnings = (checks?.warnings ?? []).map((warning) => `process: ${warning}`);
    for (const warning of processWarnings) console.log(`Warning: ${warning}`);
    warnings.push(...processWarnings);
    const counted = checks !== null && checks.status !== "unavailable" ? checks : null;
```

In the `row` object, directly after the `output_tokens_all_models: …,` line, add:

```ts
      process_status: checks?.status ?? "unavailable",
      process_helpers: counted ? String(counted.helpers) : "",
      process_helpers_untiered: counted ? String(counted.untiered) : "",
      process_merges: counted ? String(counted.merges) : "",
      process_merges_reviewed: counted ? String(counted.reviewed) : "",
      process_merges_head_known: counted ? String(counted.headKnown) : "",
      process_merges_claims_checked: counted ? String(counted.claimsChecked) : "",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test --test-name-pattern="appends or replaces a row" scripts/test/score.test.ts`
Expected: PASS.

Run: `node --test scripts/test/score.test.ts`
Expected: PASS; the summary shows `fail 0`. Notes are matched by regex, so new `process:` warnings in other synthetic runs don't break those tests. If one does fail, read its assertion before changing anything: a process warning there means the synthetic swarm left a real gap.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/scripts/score.ts evals/orchestrator/expense-claims/scripts/test/score.test.ts
git commit -m "feat(evals): record process checks in results.csv"
```

---

### Task 6: Process checks in the batch report

**Files:**
- Modify: `evals/orchestrator/expense-claims/scripts/lib/batch/report.ts:97`
- Test: `evals/orchestrator/expense-claims/scripts/test/batch-rehearsal.test.ts:67`

**Interfaces:**
- Consumes: the `ResultRow` process keys (Task 1), and the module's existing `cell`, `runLabel` and `runRowFor`.
- Produces: a `## Process checks` section in `report.md`, between `## Robustness and cost` and `## Runs`.

- [ ] **Step 1: Write the failing test**

In `scripts/test/batch-rehearsal.test.ts`, replace:

```ts
  for (const heading of ["## Runs", "## Flags", "## Self-test", "## Summary of results.csv", "## Sessions to archive", "## Repos and folders created", "## Land the results", "## Morning checklist"]) {
```

with:

```ts
  for (const heading of ["## Process checks", "## Runs", "## Flags", "## Self-test", "## Summary of results.csv", "## Sessions to archive", "## Repos and folders created", "## Land the results", "## Morning checklist"]) {
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test/batch-rehearsal.test.ts`
Expected: FAIL with `AssertionError` and message `## Process checks`.

- [ ] **Step 3: Write the implementation**

In `scripts/lib/batch/report.ts`, directly before the line `  out.push("## Runs", "");`, add:

```ts
  out.push("## Process checks", "", "Read from the run's swarm logs; they never change the gate, minutes or cost. A merge counts as reviewed when a review of its unit by another vendor started before it, and as claims-checked when a claims check named its head commit before it. See README \"Process checks\".", "");
  out.push("| Run | Status | Helpers without model or effort | Merges reviewed by another vendor | Claims checks at the merged head |");
  out.push("|---|---|---|---|---|");
  for (const run of state.runs) {
    const row = runRowFor(rows, run);
    if (!row) continue;
    const ratio = (part: string, whole: string) => (whole === "" ? "" : `${part}/${whole}`);
    out.push(`| ${cell(runLabel(run))} | ${cell(row.process_status || "not recorded")} | ${cell(ratio(row.process_helpers_untiered, row.process_helpers))} | ${cell(ratio(row.process_merges_reviewed, row.process_merges))} | ${cell(ratio(row.process_merges_claims_checked, row.process_merges_head_known))} |`);
  }
  out.push("");

```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/test/batch-rehearsal.test.ts`
Expected: PASS; the summary shows `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/scripts/lib/batch/report.ts evals/orchestrator/expense-claims/scripts/test/batch-rehearsal.test.ts
git commit -m "feat(evals): show process checks in the batch report"
```

---

### Task 7: Documentation

**Files:**
- Modify: `evals/orchestrator/expense-claims/README.md:161,163,205`
- Modify: `.github/copilot-instructions.md:54`

**Interfaces:**
- Consumes: the column names and definitions from Tasks 1, 4 and 5.
- Produces: no code.

- [ ] **Step 1: Add the column rows**

In `README.md`, directly after the table row that starts with `| \`cache_read_tokens_all_models\`, \`cache_write_tokens_all_models\`, \`output_tokens_all_models\` |`, add:

```markdown
| `process_status` | `complete`, `incomplete` (a gap in the logs; see [Process checks](#process-checks)) or `unavailable` (manual timing, or the swarm's logs couldn't be read). Never changes `outcome`. |
| `process_helpers` | Calls that start a helper (`task`, `create_session`, `open_pr_session`, `open_issue_session`) made by any swarm session's own agent. Empty when `process_status=unavailable`. |
| `process_helpers_untiered` | Of those, calls with no model or no reasoning effort. |
| `process_merges` | Merges in the logs: `gh pr merge` commands that exited with code 0, one per PR. |
| `process_merges_reviewed` | Merges whose unit had a review from another vendor than the author's, started before the merge. |
| `process_merges_head_known` | Merges whose command named the head commit with `--match-head-commit`. |
| `process_merges_claims_checked` | Of those, merges where a claims check named that commit before the merge. |
```

- [ ] **Step 2: Update the upgrade sentence**

Replace:

```markdown
The scorer can read the old 21-column format and upgrades it on append or replacement.
```

with:

```markdown
The scorer can read the old 21-column and 39-column formats and upgrades them on append or replacement.
```

- [ ] **Step 3: Add the section**

Directly before the line `## Calibration`, add:

```markdown
### Process checks

`score` also checks, from the same logs and the same kickoff-to-snapshot window as cost, whether the run followed three of the orchestrator's rules. The checks are reported only: they never change the gate, minutes, cost, pass rate or calibration. A failure inside them becomes a `process:` warning and `process_status=unavailable`.

- **Model and effort.** Every `task` call, and every `create_session`, `open_pr_session` and `open_issue_session` call, made by a session's own agent anywhere in the swarm must name a model and a reasoning effort: `model` and `reasoning_effort`, or `kickoff.model` and `kickoff.reasoning_effort`. Calls inside sub-agents don't count. A call that failed because the model's output limit truncated its arguments never ran and isn't counted.
- **Review by another vendor.** A merge is a `gh pr merge` command that exited with code 0 in any swarm session, counted once per PR. It counts as reviewed when a job that the top-level orchestrator started is labelled a review, started before the merge, and ran on a model from another vendor than the merging session's model. The job must also be linked to the merged unit. A job is linked when its name, description or unit label names the unit that the merging session reported in its `swarm-status` lines; the longest matching unit wins, so `review-api-2` isn't `api`'s review. It is also linked when its brief, a message to it or its report named the PR number or the merged head commit before the merge.
- **Claims check at the merged head.** When the merge command names the head commit with `--match-head-commit`, the merge counts as claims-checked if a job labelled a claims check had that commit, or a 7-to-40-character prefix of it, in its brief, in a message sent to it, or in its report, before the merge.

Jobs are labelled from their name, description and unit label, and the first match wins:

- **Claims check:** `claims check`, a name starting with `claims`, or a unit label ending in `-claims`.
- **Disagreement judge:** `disagree` or `dispute`, or an opening of the brief that mentions a disputed finding or a disagreement panel.
- **Panel judge:** `panel` or `judge`.
- **Review:** `review`.
- **Other:** anything else.

Only jobs that the top-level orchestrator started count, so an owner's own self-review isn't an independent review. Vendors come from the model name: `claude-*` is Anthropic, `gpt-*` OpenAI and `gemini-*` Google.

`process_status` is `incomplete` when the logs leave a gap: a merge command with no exit code or no PR number, an author model with no known vendor, or a number of merges that differs from `prs_merged`. It is `unavailable` with manual timing, or when the swarm's logs couldn't be read.

Limits:

- **No check at the exact merged commit.** Reviews often end before a rebase or a follow-up push, and the logs can't tell a rebase-only push from new code. So the check needs a review before the merge, not one at its exact head.
- **Unknown heads.** Merges without `--match-head-commit` have no known head. They count in `process_merges` but not in `process_merges_head_known`.
- **Text rules.** Labels and links are text rules. A job whose name says nothing about its role, or an owner whose name looks like a review or claims check, can be labelled wrongly.
- **Auto-merge.** `gh pr merge --auto` only turns on auto-merge. The check uses the command's time, which is earlier than the real merge.
- **No GitHub merge count.** With `--no-github`, or when `prs_merged` is `unknown`, nothing cross-checks the merge count. A missing owner log can then hide a merge without making the status `incomplete`.
- **No backfill.** Rows scored before this change have blank process columns.

```

- [ ] **Step 4: Update the repository instructions**

In `.github/copilot-instructions.md`, replace:

```markdown
with separate robustness and cost measurements
```

with:

```markdown
with separate robustness, cost and process-check measurements
```

and replace:

```markdown
`results.csv` records cost, robustness and their provenance separately from the score.
```

with:

```markdown
`results.csv` records cost, robustness, process checks and their provenance separately from the score.
```

- [ ] **Step 5: Check the edits**

Run: `grep -c "process_" README.md && grep -n "^### Process checks" README.md && grep -o "process-check measurements\|process checks and their provenance" ../../../.github/copilot-instructions.md | wc -l`
Expected:
- The first count is at least 10.
- The section heading appears once, above `## Calibration`.
- The last count is `2`. Both phrases are on the same line, so count matches, not lines.

- [ ] **Step 6: Commit**

```bash
git add evals/orchestrator/expense-claims/README.md .github/copilot-instructions.md
git commit -m "docs(evals): document process checks"
```

---

### Task 8: Check against the archived run logs, then run the kit's checks

**Files:**
- No committed files, except fixes found in Step 3 together with their tests.
- Scratch: `$HOME/process-check-validation`, outside the repo, deleted in Step 4. Use this literal path in every step, because each shell call may start fresh.

**Interfaces:**
- Consumes: everything above.
- Produces: confidence that the checks match real logs, and a clean `npm test` and `npm run check`.

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: the summary shows `fail 0`.

- [ ] **Step 2: Run the checks on the archived logs**

This step only reads the archives. It never writes under `~/orch-evals/` or `~/.copilot/`, and nothing from it goes into the repo. Run these commands in one shell call.

```bash
SCRATCH="$HOME/process-check-validation"
rm -rf "$SCRATCH" && mkdir -p "$SCRATCH"
cat > "$SCRATCH/validate.mts" <<'EOF'
// Scratch only: compares the process checks with the archived eval logs. Never commit it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const [kit, scratch, batches] = process.argv.slice(2);
const load = (path: string) => import(pathToFileURL(join(kit, path)).href);
const { computeTiming, readEventLog } = await load("scripts/lib/events.ts");
const { collectUsage, readPricing } = await load("scripts/lib/usage.ts");
const { checkProcess } = await load("scripts/lib/process.ts");
const { readResults } = await load("scripts/lib/results.ts");
// Folders only: the archives also hold files such as .DS_Store.
const folders = (path: string): string[] =>
  readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const stateDir = join(scratch, "state");
for (const batch of folders(batches)) {
  const sessionsDir = join(batches, batch, "sessions");
  if (!existsSync(sessionsDir)) continue;
  for (const runDir of folders(sessionsDir)) {
    for (const session of folders(join(sessionsDir, runDir))) {
      const gz = join(sessionsDir, runDir, session, "events.jsonl.gz");
      if (!existsSync(gz)) continue;
      mkdirSync(join(stateDir, session), { recursive: true });
      writeFileSync(join(stateDir, session, "events.jsonl"), gunzipSync(readFileSync(gz)));
    }
  }
}
const pricing = readPricing(join(kit, "pricing", "2026-10-20.json"));
for (const row of readResults(join(kit, "results.csv"))) {
  const label = `${row.variant}-${row.run}`;
  const rootLog = join(stateDir, row.session, "events.jsonl");
  if (!existsSync(rootLog)) {
    console.log(`${label}: no archived log`);
    continue;
  }
  try {
    const start = computeTiming(readEventLog(rootLog).events).start;
    const sessions = new Map();
    collectUsage({
      stateDir, rootId: row.session, start, capturedAt: row.cost_captured_at || "2100-01-01T00:00:00.000Z", pricing,
      onSession: (id: string, events: unknown[]) => {
        sessions.set(id, events);
      },
    });
    const r = checkProcess({ rootId: row.session, rootModel: row.model, sessions, githubMerges: /^\d+$/.test(row.prs_merged) ? Number(row.prs_merged) : null });
    console.log(`${label}: ${r.status} helpers=${r.helpers} untiered=${r.untiered} merges=${r.merges} reviewed=${r.reviewed} head_known=${r.headKnown} claims_checked=${r.claimsChecked}${r.warnings.length ? ` | ${r.warnings.join("; ")}` : ""}`);
  } catch (error) {
    console.log(`${label}: error ${(error as Error).message}`);
  }
}
EOF
node "$SCRATCH/validate.mts" "$PWD" "$SCRATCH" "$HOME/orch-evals/batches"
```

Expected, from the separate log analysis:
- Four runs print `no archived log`: `orchestrator-1`, `hands-on-session-orchestrator-8`, `session-orchestrator-8` and `hands-on-orchestrator-8`.
- Every other run prints `complete untiered=0`, with `reviewed` equal to `merges` and `claims_checked` equal to `head_known`.
- `helpers`, `merges` and `head_known` match this table:

| Run | helpers | merges | head_known |
|---|---|---|---|
| orchestrator-5 | 14 | 3 | 2 |
| orchestrator-6 | 15 | 3 | 2 |
| orchestrator-7 | 13 | 3 | 3 |
| orchestrator-8 | 15 | 4 | 3 |
| orchestrator-9 | 14 | 3 | 2 |
| orchestrator-10 | 14 | 3 | 3 |
| hands-on-orchestrator-5 | 18 | 6 | 6 |
| hands-on-orchestrator-6 | 15 | 3 | 2 |
| hands-on-orchestrator-7 | 15 | 3 | 3 |
| hands-on-orchestrator-9 | 15 | 4 | 3 |
| hands-on-orchestrator-10 | 13 | 3 | 3 |
| hands-on-orchestrator-11 | 15 | 5 | 4 |
| hands-on-orchestrator-12 | 12 | 3 | 2 |
| session-orchestrator-5 | 15 | 4 | 4 |
| session-orchestrator-6 | 11 | 5 | 4 |
| session-orchestrator-7 | 16 | 4 | 4 |
| session-orchestrator-9 | 14 | 4 | 4 |
| session-orchestrator-10 | 14 | 4 | 4 |
| session-orchestrator-11 | 13 | 3 | 3 |
| session-orchestrator-12 | 12 | 3 | 3 |
| hands-on-session-orchestrator-5 | 17 | 5 | 4 |
| hands-on-session-orchestrator-6 | 11 | 3 | 3 |
| hands-on-session-orchestrator-7 | 11 | 3 | 1 |
| hands-on-session-orchestrator-9 | 15 | 4 | 2 |
| hands-on-session-orchestrator-10 | 11 | 3 | 2 |
| hands-on-session-orchestrator-11 | 12 | 3 | 3 |
| hands-on-session-orchestrator-12 | 10 | 5 | 3 |

These numbers come from an earlier analysis that used slightly different rules. Treat them as a cross-check, not as ground truth.

- [ ] **Step 3: Resolve every difference**

For each run that differs from Step 2's expectations:

1. Read that run's logs in the scratch folder, read-only, and find the event behind the difference.
2. If the code is wrong, write a failing synthetic test in `scripts/test/process.test.ts` that reproduces the event shape, without copying log text. Then fix `scripts/lib/process.ts` and run `node --test scripts/test/process.test.ts` until it passes.
3. If the expectation is wrong (the rule is right and the earlier analysis counted differently), note the reason, and add a bullet to the README "Process checks" limits if users need to know it.
4. Rerun the Step 2 command until every row is explained.

Commit any fixes with their tests:

```bash
git add evals/orchestrator/expense-claims/scripts/lib/process.ts evals/orchestrator/expense-claims/scripts/test/process.test.ts evals/orchestrator/expense-claims/README.md
git commit -m "fix(evals): <what the archived logs showed>"
```

- [ ] **Step 4: Delete the scratch folder**

Run: `rm -rf "$HOME/process-check-validation"`
Expected: the folder is gone, and `git status --short` shows nothing from it.

- [ ] **Step 5: Run the kit's checks**

Run: `npm test && npm run check`
Expected: the test summary shows `fail 0`, then one `PASS` line per check (the real-log score check prints `SKIP`), and no `FAIL` lines.

---

## Out of scope

These would make the checks stronger, but each changes something other than the kit's scoring:

- **Job tags.** Have the orchestrators put a fixed tag in every job's name or brief, and in every re-check message. For example: `[job=review unit=<unit> pr=<n> commit=<sha>]`. Labels and links would then be exact. This changes the wintermute prompts and needs a plugin version bump.
- **Merge rule.** Always merge with `--match-head-commit`, so that every merge has a known head.
- **Push rule.** Print the pushed commit after every push. That is a first step towards checking reviews at the merged commit.
- **Archives.** Keep each run's `session.db` (the orchestrator's `child_notes` verdicts) in the batch archive, and fix the archive step that lost three run-8 logs.
- **More rules.** Check the final panel (two judges from two vendors on the last PR) and the claims check on `main` after the last merge. The log analysis found both detectable.
