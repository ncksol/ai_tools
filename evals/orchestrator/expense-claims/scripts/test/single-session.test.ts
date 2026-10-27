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
  for (const tool of tools) {
    assert.ok(!tool.includes("*") || tool === "playwright/*", tool);
  }
  for (const tool of [
    "task", "read_agent", "write_agent", "list_agents", "run_dynamic_workflow",
    "create_session", "open_pr_session", "open_issue_session", "fork_session", "send_session_message", "manage_agent_merge",
    "read_inbox", "get_session", "save_session_automation", "get_session_automation",
    "manage_event_subscriptions", "list_sessions_and_chats", "answer_session_input",
    "github-mcp-server/assign_copilot_to_issue", "github-mcp-server/request_copilot_review",
  ]) {
    assert.ok(!tools.includes(tool), tool);
  }
  for (const tool of ["bash", "edit", "create_pull_request", "ask_user"]) assert.ok(tools.includes(tool), tool);
});

test("the single-session agent never mentions the kit", () => {
  assert.deepEqual(kickoffProblems(text, "").filter((problem) => problem.startsWith("mentions the kit")), []);
});
