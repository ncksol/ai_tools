// Memory and history checks over a run's logs: the orchestrator, its sub-agents and every child
// session. They only flag; they never touch memories.
import type { LogEvent } from "../events.ts";

export interface HygieneFinding {
  code: "memory-loaded" | "memory-write" | "history-query";
  detail: string;
}

const MEMORY_TOOLS = new Set(["store_memory", "vote_memory"]);
const HISTORY_TOOLS = new Set(["session_store_sql"]);

// The runtime puts loaded memories in a <memories> block of the system message, under headings
// such as "## User memories for @user" or "## Repository memories for `owner/repo`".
export function hasLoadedMemories(systemText: string): boolean {
  const start = systemText.indexOf("<memories>");
  if (start < 0) return false;
  const end = systemText.indexOf("</memories>", start);
  const block = systemText.slice(start, end < 0 ? undefined : end);
  return /^##\s+(User|Repository) memories\b/m.test(block);
}

export function scanSession(sessionId: string, events: LogEvent[]): HygieneFinding[] {
  const counts = new Map<string, { code: HygieneFinding["code"]; n: number }>();
  const bump = (code: HygieneFinding["code"], what: string) => {
    const key = `${code}\u0000${what}`;
    const entry = counts.get(key) ?? { code, n: 0 };
    entry.n++;
    counts.set(key, entry);
  };
  for (const event of events) {
    const who = event.agentId ? `sub-agent ${event.agentId}` : "top level";
    if (event.type === "system.message") {
      const text = event.data?.content;
      if (typeof text === "string" && hasLoadedMemories(text)) bump("memory-loaded", `memories loaded (${who})`);
    }
    if (event.type === "tool.execution_start") {
      const tool = String(event.data?.toolName ?? "");
      if (MEMORY_TOOLS.has(tool)) bump("memory-write", `${tool} called (${who})`);
      if (HISTORY_TOOLS.has(tool)) bump("history-query", `${tool} called (${who})`);
    }
  }
  return [...counts.entries()].map(([key, { code, n }]) => ({ code, detail: `session ${sessionId}: ${key.split("\u0000")[1]}${n > 1 ? ` x${n}` : ""}` }));
}

export function scanSwarm(logs: { id: string; events: LogEvent[] }[]): HygieneFinding[] {
  return logs.flatMap((log) => scanSession(log.id, log.events));
}
