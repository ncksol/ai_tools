import assert from "node:assert/strict";
import { test } from "node:test";
import { hasLoadedMemories, scanSession, scanSwarm } from "../lib/batch/hygiene.ts";
import { ev } from "./fixtures/events.ts";

const withMemories = [
  "You are a coding agent.",
  "<memories>",
  "Recent memories from earlier interactions appear below.",
  "## Repository memories for `ncksol/orch-eval-orchestrator-2`",
  "**testing**",
  "- Fact: synthetic",
  "## User memories for @someone",
  "</memories>",
].join("\n");

test("a <memories> block with memory headings counts as loaded memories", () => {
  assert.equal(hasLoadedMemories(withMemories), true);
  assert.equal(hasLoadedMemories("Use store_memory to remember facts. <memories> is where they would go."), false);
  assert.equal(hasLoadedMemories("No memory section at all."), false);
});

test("memory loads, memory writes and history queries are flagged in every session and sub-agent", () => {
  const findings = scanSwarm([
    {
      id: "orch",
      events: [
        ev("system.message", 0, { role: "system", content: "Plain system prompt; tools: store_memory, vote_memory." }),
        ev("tool.execution_start", 5, { toolName: "store_memory", toolCallId: "m1" }),
        ev("tool.execution_start", 6, { toolName: "session_store_sql", toolCallId: "h1" }, "sub-1"),
      ],
    },
    {
      id: "child",
      events: [
        ev("system.message", 20, { role: "system", content: withMemories }),
        ev("tool.execution_start", 25, { toolName: "vote_memory", toolCallId: "v1" }),
        ev("tool.execution_start", 26, { toolName: "vote_memory", toolCallId: "v2" }),
        ev("tool.execution_start", 27, { toolName: "bash", toolCallId: "b1" }),
      ],
    },
  ]);
  assert.deepEqual(findings, [
    { code: "memory-write", detail: "session orch: store_memory called (top level)" },
    { code: "history-query", detail: "session orch: session_store_sql called (sub-agent sub-1)" },
    { code: "memory-loaded", detail: "session child: memories loaded (top level)" },
    { code: "memory-write", detail: "session child: vote_memory called (top level) x2" },
  ]);
});

test("a clean session has no findings", () => {
  assert.deepEqual(scanSession("s", [ev("system.message", 0, { content: "no memories" }), ev("tool.execution_start", 1, { toolName: "view" })]), []);
});
