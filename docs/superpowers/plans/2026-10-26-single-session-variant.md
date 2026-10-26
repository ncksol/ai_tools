# Single-Session Variant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `single-session` variant to the orchestrator eval kit: one top-level session that does the whole task itself, with no sub-agents or child sessions, run and scored by hand with the existing `new-run` and `score`.

**Architecture:** No kit code changes. `new-run` and `score` already accept any variant label, and `score` ends an unmarked run at its last assistant message. The work is one eval-only agent file in `variants/`, a test that keeps that file honest, and the run instructions.

**Tech Stack:** Node.js 24 built-ins (`node:test`, `node:assert/strict`, `node:fs`); TypeScript through Node's type stripping.

**Spec:** No separate spec. The user chose "manual runs only" on 2026-10-26. Batch-runner support is out of scope; see "Requirements".

**Base:** Written against `main` at `639fd6a` (#76). Every edit is anchored on exact text.

## Requirements

- **R1. The agent.** `variants/single-session.agent.md` defines the agent `single-session`.
  - It works alone. Its `tools` allowlist has no tool that starts or messages sub-agents or sessions.
  - It keeps the tools it needs to build, test, open and merge PRs, and ask the user questions.
  - It sets `disable-model-invocation: true`, so no other agent can start it.
  - It never mentions the eval, its tests, scoring or the kit, because the run can read its own agent prompt.
- **R2. Runs.** A run uses the existing manual flow in README "Run it", with `--variant single-session`, the agent `single-session`, and the same feature set, model and effort as the orchestrator runs it is compared with. The kickoff, answer sheet and scoring are unchanged.
- **R3. Docs.** The README says how to register the agent, run it and read the results, and states the limits. `.github/copilot-instructions.md` mentions the agent.
- **Out of scope:** batch-runner support (the runner looks for agents only in the installed wintermute plugin), a second variant with an independent review, and any change under `scripts/lib/` or to `score.ts`.

## Global Constraints

- **Kit scope.** The kit root is `evals/orchestrator/expense-claims/`. Change only the files listed in the tasks, plus `.github/copilot-instructions.md` in Task 2.
- **Unpinned files only.** Nothing under `scripts/lib/`, `score.ts`, `kickoff.md` or `answers.md` changes, so batch pins are unaffected.
- **No real runs.** Never create a run repo or start a run while implementing. Use `new-run --dry-run` with a scratch `--runs-dir` only.
- **npm.** Run npm normally from the kit folder. Never use `env -i` or a scratch `HOME`, which bypass this machine's npm proxy.
- **Commits.** Use conventional commit messages (`feat(evals): …`, `docs(evals): …`), with no `Co-authored-by` trailer or other AI attribution.

## File structure

```text
evals/orchestrator/expense-claims/
  variants/single-session.agent.md         new: the single-session agent (Task 1)
  scripts/test/single-session.test.ts      new: keeps the agent file honest (Task 1)
  README.md                                kit table, "Run it" step 3, "Single-session baseline" (Task 2)
.github/copilot-instructions.md            `variants/` description (Task 2)
```

Run the tasks in order. All commands run from `evals/orchestrator/expense-claims/`.

---

### Task 1: The agent file and its test

**Files:**
- Create: `evals/orchestrator/expense-claims/variants/single-session.agent.md`
- Create: `evals/orchestrator/expense-claims/scripts/test/single-session.test.ts`

**Interfaces:**
- Consumes: `kickoffProblems(kickoff: string, spec: string): string[]` from `scripts/lib/kickoff.ts`, and `KIT_DIR` from `scripts/lib/suite.ts`.
- Produces: the agent ID `single-session`, used in Task 2's docs.

- [ ] **Step 1: Write the failing test**

Create `scripts/test/single-session.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { kickoffProblems } from "../lib/kickoff.ts";
import { KIT_DIR } from "../lib/suite.ts";

const text = readFileSync(join(KIT_DIR, "variants", "single-session.agent.md"), "utf8");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
const toolsLine = /^tools: (\[.*\])$/m.exec(frontmatter)?.[1];

test("the single-session agent is a top-level agent named for its file", () => {
  assert.match(frontmatter, /^name: single-session$/m);
  assert.match(frontmatter, /^disable-model-invocation: true$/m);
});

test("the single-session agent can't start or message sub-agents or other sessions", () => {
  assert.ok(toolsLine, "tools must be a JSON array on one line");
  const tools = JSON.parse(toolsLine) as string[];
  for (const tool of [
    "task", "read_agent", "write_agent", "list_agents", "run_dynamic_workflow",
    "create_session", "open_pr_session", "open_issue_session", "fork_session", "send_session_message", "manage_agent_merge",
  ]) {
    assert.ok(!tools.includes(tool), tool);
  }
  for (const tool of ["bash", "edit", "create_pull_request", "ask_user"]) assert.ok(tools.includes(tool), tool);
});

test("the single-session agent never mentions the kit", () => {
  assert.deepEqual(kickoffProblems(text, "").filter((problem) => problem.startsWith("mentions the kit")), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/test/single-session.test.ts`
Expected: FAIL with `ENOENT: no such file or directory` for `variants/single-session.agent.md`.

- [ ] **Step 3: Create the agent file**

Create `variants/single-session.agent.md` with exactly this content. The `tools` list is `session-worker`'s verified list (`ghcp/plugins/wintermute/com.github.copilot/agents/session-worker.agent.md`) without its session-coordination tools, plus `ask_user`:

```markdown
---
name: single-session
description: Works alone in one session. Plans, builds, tests and merges the whole task itself, without sub-agents or other sessions.
tools: ["bash", "read_bash", "write_bash", "stop_bash", "list_bash", "view", "create", "edit", "apply_patch", "str_replace_editor", "grep", "rg", "glob", "lexical_code_search", "semantic_code_search", "web_fetch", "web", "github-mcp-server/add_comment_to_pending_review", "github-mcp-server/add_issue_comment", "github-mcp-server/add_reply_to_pull_request_comment", "github-mcp-server/create_branch", "github-mcp-server/create_or_update_file", "github-mcp-server/create_pull_request", "github-mcp-server/create_repository", "github-mcp-server/delete_file", "github-mcp-server/fork_repository", "github-mcp-server/get_commit", "github-mcp-server/get_file_contents", "github-mcp-server/get_label", "github-mcp-server/get_latest_release", "github-mcp-server/get_me", "github-mcp-server/get_release_by_tag", "github-mcp-server/get_tag", "github-mcp-server/get_team_members", "github-mcp-server/get_teams", "github-mcp-server/issue_read", "github-mcp-server/issue_write", "github-mcp-server/list_branches", "github-mcp-server/list_commits", "github-mcp-server/list_issue_types", "github-mcp-server/list_issues", "github-mcp-server/list_pull_requests", "github-mcp-server/list_releases", "github-mcp-server/list_tags", "github-mcp-server/merge_pull_request", "github-mcp-server/pull_request_read", "github-mcp-server/pull_request_review_write", "github-mcp-server/push_files", "github-mcp-server/search_code", "github-mcp-server/search_issues", "github-mcp-server/search_pull_requests", "github-mcp-server/search_repositories", "github-mcp-server/search_users", "github-mcp-server/sub_issue_write", "github-mcp-server/update_pull_request", "github-mcp-server/update_pull_request_branch", "playwright/*", "ask_user", "skill", "sql", "session_store_sql", "store_memory", "vote_memory", "update_todo", "report_intent", "task_complete", "exit_plan_mode", "tool_search_tool", "create_pull_request", "update_pull_request", "get_changes_overview", "rename_branch", "rename_session", "reply_and_resolve_review_thread", "reply_to_review_thread", "reply_to_comment", "add_pr_review_comment", "publish_chat_update", "navigate_to_github_item", "create_issue", "create_issue_artifact"]
include-custom-instructions: true
disable-model-invocation: true
---

# Single session

You work alone in this session. Do the whole task yourself, from reading the code to merging the last pull request: plan it, build it, test it and check your own work here.

You have no tools to start sub-agents or other sessions, and you don't need them.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/test/single-session.test.ts`
Expected: PASS; the summary shows `tests 3` and `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add evals/orchestrator/expense-claims/variants/single-session.agent.md evals/orchestrator/expense-claims/scripts/test/single-session.test.ts
git commit -m "feat(evals): add a single-session baseline agent"
```

---

### Task 2: Run instructions

**Files:**
- Modify: `evals/orchestrator/expense-claims/README.md` (the "What's in the kit" table, "Run it" step 3, and a new section before `## When a run doesn't finish`)
- Modify: `.github/copilot-instructions.md` (the eval kit's `variants/` sentence)

**Interfaces:**
- Consumes: the agent ID `single-session` and the file `variants/single-session.agent.md` (Task 1).
- Produces: no code.

- [ ] **Step 1: Update the kit table**

In `README.md`, replace:

```markdown
| `variants/` | Eval-only A/B/C agent snapshots, their shared worker and the hashed `review-policy.json` manifest. Not ordinary agent installation files. |
```

with:

```markdown
| `variants/` | Eval-only A/B/C agent snapshots, their shared worker, the hashed `review-policy.json` manifest and the `single-session` baseline agent. Not ordinary agent installation files. |
```

- [ ] **Step 2: Name the agent in "Run it" step 3**

In `README.md`, replace:

```markdown
`new-run` prints the exact runtime ID. Pinned A/B/C aliases keep their bare IDs.
```

with:

```markdown
`new-run` prints the exact runtime ID. Pinned A/B/C aliases keep their bare IDs, and so does the single-session baseline, `single-session` (see [Single-session baseline](#single-session-baseline)).
```

- [ ] **Step 3: Add the section**

In `README.md`, directly before the line `## When a run doesn't finish`, add:

````markdown
### Single-session baseline

`variants/single-session.agent.md` is a baseline with no orchestration: one top-level session that plans, builds, tests and merges the whole task itself. It has no tools to start sub-agents or other sessions, so it runs no reviewers, panels or claims checks. It shows whether orchestration pays off at this task's size.

Register it once, from this kit folder, unless `~/.copilot/agents/single-session.agent.md` already exists:

```bash
mkdir -p ~/.copilot/agents
ln -s "$PWD/variants/single-session.agent.md" "$HOME/.copilot/agents/single-session.agent.md"
```

Then follow [Run it](#run-it) with `--variant single-session` and the feature set of the runs you compare it with, for example `npm run new-run -- --variant single-session --features policy,reports,import`. In step 3, select the agent `single-session`, with the same model and effort as those runs. The kickoff, answer sheet and scoring are unchanged, and `npm run score -- --summary` lists the runs under `single-session`.

Limits:

- **Manual runs only.** The overnight batch runner looks for agent files only in the installed wintermute plugin, so it can't run this agent.
- **Not side by side.** Manual runs happen on different days from the orchestrator runs they're compared with, so only large differences in minutes or pass rate mean anything. If the results are close, add batch support and compare the two in the same batch.

````

- [ ] **Step 4: Update the repository instructions**

In `.github/copilot-instructions.md`, replace:

```markdown
`variants/` holds pinned A/B/C alias snapshots and their shared worker, deliberately outside `ghcp/agents/`; only the user registers these files, and the kit never installs them.
```

with:

```markdown
`variants/` holds pinned A/B/C alias snapshots, their shared worker and the `single-session` baseline agent (one session with no sub-agents or child sessions, for manual runs only), deliberately outside `ghcp/agents/`; only the user registers these files, and the kit never installs them.
```

- [ ] **Step 5: Check the edits**

Run: `grep -c "single-session" README.md && grep -c "single-session" ../../../.github/copilot-instructions.md`
Expected: the first count is at least 6, and the second is `1`.

- [ ] **Step 6: Commit**

```bash
git add evals/orchestrator/expense-claims/README.md .github/copilot-instructions.md
git commit -m "docs(evals): document the single-session baseline"
```

---

### Task 3: Verify

**Files:** none changed. Scratch: `$HOME/single-session-dry-run`, deleted in Step 3.

- [ ] **Step 1: Dry-run `new-run` with the new variant**

Run, in one shell call:

```bash
rm -rf "$HOME/single-session-dry-run"
npm run new-run -- --variant single-session --features policy,reports,import --dry-run --runs-dir "$HOME/single-session-dry-run"
```

Expected: it builds `orch-eval-single-session-1` under the scratch folder without touching GitHub, and its next steps say to start a session `with the agent "single-session"`.

- [ ] **Step 2: Run the kit's tests and checks**

Run: `npm test && npm run check`
Expected: the test summary shows `fail 0`, then one `PASS` line per check (the real-log score check prints `SKIP`), and no `FAIL` lines.

- [ ] **Step 3: Delete the scratch folder**

Run: `rm -rf "$HOME/single-session-dry-run"`
Expected: the folder is gone, and `git status --short` shows nothing.

## After merging (the user, not the executor)

Register the agent as README "Single-session baseline" says, and start runs by hand.
