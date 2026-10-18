// Synthetic event logs for the timing tests. Never copy anything from a real session log here.
import type { LogEvent } from "../../lib/events.ts";

export const BASE = Date.parse("2026-01-01T10:00:00.000Z");
export const MIN = 60_000;

export function ev(type: string, minute: number, data: Record<string, unknown> = {}, agentId?: string): LogEvent {
  const event: LogEvent = { type, timestamp: new Date(BASE + minute * MIN).toISOString(), data };
  if (agentId) event.agentId = agentId;
  return event;
}

export function basic(): LogEvent[] {
  return [
    ev("session.start", 0, { selectedModel: "claude-opus-5.5", reasoningEffort: "max", copilotVersion: "1.0.99-2" }),
    ev("subagent.selected", 0, { agentName: "orchestrator" }),
    ev("user.message", 1),
    ev("assistant.turn_start", 1),
    ev("assistant.message", 2),
    ev("assistant.turn_end", 2),
    ev("user.message", 10, { source: "agent-workspace-1" }),
    ev("assistant.turn_start", 10),
    ev("assistant.message", 21),
    ev("assistant.turn_end", 21),
  ];
}

// Inserts events in time order; events with equal timestamps keep the base log first.
export function withEvents(base: LogEvent[], extra: LogEvent[]): LogEvent[] {
  return [...base, ...extra].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
