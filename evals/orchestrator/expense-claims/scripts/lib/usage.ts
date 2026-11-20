import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEventLog, type LogEvent } from "./events.ts";

interface Rate {
  aboveInputTokens: number;
  input: number;
  cachedInput: number;
  cacheWrite: number | null;
  output: number;
  expiresAt?: string;
}

export interface Pricing {
  version: string;
  models: Record<string, Rate[]>;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readPricing(path: string): Pricing {
  const text = readFileSync(path, "utf8");
  const data = object(JSON.parse(text));
  const models = object(data?.models);
  if (!data || typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
      data.currency !== "USD" || data.perTokens !== 1_000_000 || !models || Object.keys(models).length === 0) {
    throw new Error(`Invalid pricing file ${path}`);
  }
  const rates: Record<string, Rate[]> = {};
  const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  for (const [model, tiers] of Object.entries(models)) {
    if (!Array.isArray(tiers) || tiers.length === 0) throw new Error(`No price tiers for ${model}`);
    rates[model] = tiers.map((item, i) => {
      const rate = object(item);
      if (!rate || typeof rate.aboveInputTokens !== "number" || !Number.isSafeInteger(rate.aboveInputTokens) ||
          (i === 0 ? rate.aboveInputTokens !== -1 : rate.aboveInputTokens < 0) ||
          !nonnegative(rate.input) || !nonnegative(rate.cachedInput) || !nonnegative(rate.output) ||
          !(rate.cacheWrite === null || nonnegative(rate.cacheWrite)) ||
          (rate.expiresAt !== undefined && (typeof rate.expiresAt !== "string" || !Number.isFinite(Date.parse(rate.expiresAt))))) {
        throw new Error(`Invalid price tier for ${model}`);
      }
      return {
        aboveInputTokens: rate.aboveInputTokens, input: rate.input, cachedInput: rate.cachedInput,
        cacheWrite: rate.cacheWrite, output: rate.output,
        ...(typeof rate.expiresAt === "string" ? { expiresAt: rate.expiresAt } : {}),
      };
    });
    if (rates[model].some((rate, i, all) => i > 0 && rate.aboveInputTokens <= all[i - 1].aboveInputTokens)) {
      throw new Error(`Unordered price tiers for ${model}`);
    }
  }
  return { version: `${data.date}:${createHash("sha256").update(text).digest("hex")}`, models: rates };
}

const COUNTERS = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"] as const;
export type Tokens = Record<(typeof COUNTERS)[number], number>;
const emptyTokens = (): Tokens => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });

function tokensOf(usage: Record<string, unknown>): Tokens {
  const tokens = emptyTokens();
  for (const key of COUNTERS) {
    const n = usage[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid token counter ${key}`);
    tokens[key] = n;
  }
  if (tokens.inputTokens < tokens.cacheReadTokens + tokens.cacheWriteTokens) {
    throw new Error("Cache token counters exceed inclusive inputTokens");
  }
  return tokens;
}

export function priceUsage(value: unknown, timestamp: string, pricing: Pricing): number {
  const usage = object(value);
  if (!usage) throw new Error("Missing usage counters");
  if (usage.isAuto === true) throw new Error("Auto-routed usage needs its discounted rate; list prices do not apply");
  const tokens = tokensOf(usage);
  const model = typeof usage.model === "string" ? usage.model : "";
  const tiers = pricing.models[model];
  if (!tiers) throw new Error(`No price for model ${model || "(missing)"}`);
  const rate = tiers.findLast((tier) => tokens.inputTokens > tier.aboveInputTokens)!;
  const when = Date.parse(timestamp);
  if (!Number.isFinite(when)) throw new Error("Invalid usage timestamp");
  if (rate.expiresAt && when >= Date.parse(rate.expiresAt)) throw new Error(`Price for ${model} expired at ${rate.expiresAt}`);
  if (rate.cacheWrite === null && tokens.cacheWriteTokens !== 0) throw new Error(`No cache write price for ${model}`);
  const uncached = tokens.inputTokens - tokens.cacheReadTokens - tokens.cacheWriteTokens;
  return (uncached * rate.input + tokens.cacheReadTokens * rate.cachedInput +
    tokens.cacheWriteTokens * (rate.cacheWrite ?? 0) + tokens.outputTokens * rate.output) / 1_000_000;
}

export interface UsageSummary {
  status: "complete" | "incomplete" | "unavailable";
  usd: number | null;
  sessions: number;
  records: number;
  tokens: Tokens;
  warnings: string[];
  // Descendants that never started a CLI session, so cost nothing; they don't make the total incomplete.
  notes: string[];
}

// A create_session that the app reports as failed after it made the session's workspace.
function failedCreation(event: LogEvent): string | null {
  const error = object(event.data?.error);
  const message = typeof error?.message === "string" ? error.message : "";
  return /^Created session [\s\S]*?\(id: ([a-zA-Z0-9-]+)\) but workspace initialization failed/.exec(message)?.[1] ?? null;
}

// Results have used both CLI session ids and app workspace ids across app releases.
function createdSession(event: LogEvent): string | null {
  const result = object(event.data?.result);
  for (const key of ["session_id", "project_session_id"]) if (typeof result?.[key] === "string") return result[key];
  const content = result?.content;
  if (typeof content !== "string") return null;
  return /Created session [\s\S]*?\(id: ([a-zA-Z0-9-]+)\)/.exec(content)?.[1] ??
    /"(?:session_id|project_session_id)"\s*:\s*"([a-zA-Z0-9-]+)"/.exec(content)?.[1] ?? null;
}

export function collectUsage(opts: {
  stateDir: string;
  rootId: string;
  start: string;
  capturedAt: string;
  pricing: Pricing;
  children?: (sessionId: string) => string[];
  aliases?: (sessionId: string) => string[];
  resolveSession?: (reference: string) => string | null;
  // True when the app's records show the workspace never got a CLI session.
  neverStarted?: (reference: string) => boolean;
}): UsageSummary {
  const start = Date.parse(opts.start);
  const end = Date.parse(opts.capturedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Invalid usage snapshot window");
  const warnings: string[] = [];
  const notes = new Set<string>();
  const failedCreations = new Set<string>();
  const seenSessions = new Set<string>();
  const seenUsage = new Set<string>();
  const queue = [opts.rootId];
  let records = 0;
  let usd = 0;
  const tokens = emptyTokens();
  while (queue.length > 0) {
    const reference = queue.shift()!;
    if (!/^[a-zA-Z0-9-]+$/.test(reference)) {
      warnings.push(`Invalid child session reference ${reference}`);
      continue;
    }
    let id = reference;
    if (!existsSync(join(opts.stateDir, id, "events.jsonl"))) {
      const resolved = opts.resolveSession?.(reference) ?? null;
      if (resolved) id = resolved;
      else if (!existsSync(join(opts.stateDir, reference))) {
        let neverStarted = failedCreations.has(reference);
        if (!neverStarted && opts.neverStarted) {
          try {
            neverStarted = opts.neverStarted(reference);
          } catch (error) {
            warnings.push(`${reference}: start check failed: ${(error as Error).message}`);
          }
        }
        if (neverStarted) {
          notes.add(`${reference} never started`);
          continue;
        }
      }
    }
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      warnings.push(`Invalid resolved session id for ${reference}`);
      continue;
    }
    if (seenSessions.has(id)) continue;
    seenSessions.add(id);
    let events: LogEvent[];
    try {
      const log = readEventLog(join(opts.stateDir, id, "events.jsonl"));
      events = log.events.filter((event) => Date.parse(event.timestamp) >= start && Date.parse(event.timestamp) <= end);
      warnings.push(...log.warnings.map((warning) => `${id}: ${warning}`));
    } catch (error) {
      warnings.push(`${id}: ${(error as Error).message}`);
      continue;
    }
    if (opts.children) {
      try {
        queue.push(...opts.children(id));
      } catch (error) {
        warnings.push(`${id}: descendant discovery failed: ${(error as Error).message}`);
      }
    }
    if (opts.aliases) {
      try {
        queue.push(...opts.aliases(id));
      } catch (error) {
        warnings.push(`${id}: alias discovery failed: ${(error as Error).message}`);
      }
    }
    const creations = new Set<string>();
    for (const event of events) {
      const data = event.data ?? {};
      if (event.type === "tool.execution_start" && typeof data.toolName === "string" &&
          ["create_session", "open_pr_session", "open_issue_session", "fork_session"].includes(data.toolName.split(/[./]/).at(-1)!)) {
        if (typeof data.toolCallId === "string") creations.add(data.toolCallId);
        else warnings.push(`${id}: session creation has no call id`);
      }
    }
    let localRecords = 0;
    for (const event of events) {
      const data = event.data ?? {};
      if (event.type === "tool.execution_complete" && typeof data.toolCallId === "string" && creations.delete(data.toolCallId)) {
        if (data.success !== false) {
          const child = createdSession(event);
          if (child) queue.push(child);
          else warnings.push(`${id}: cannot resolve created session for ${data.toolCallId}`);
        } else {
          const failed = failedCreation(event);
          if (failed) failedCreations.add(failed);
        }
      }
      if (event.type !== "session.usage_record") continue;
      const usage = object(data.usage);
      const accounting = object(usage?.accounting);
      const eventId = object(event)?.id;
      const key = typeof accounting?.usageId === "string"
        ? `${String(accounting.sourceSessionId ?? id)}:${accounting.usageId}`
        : typeof eventId === "string" ? `${id}:${eventId}` : null;
      localRecords++;
      if (key && seenUsage.has(key)) continue;
      if (key) seenUsage.add(key);
      try {
        const amount = priceUsage(usage, event.timestamp, opts.pricing);
        const parsed = tokensOf(usage!);
        for (const field of COUNTERS) tokens[field] += parsed[field];
        usd += amount;
        records++;
      } catch (error) {
        warnings.push(`${id}: ${(error as Error).message}`);
      }
    }
    for (const call of creations) warnings.push(`${id}: session creation ${call} has no completion`);
    if (localRecords === 0) warnings.push(`${id}: no usage records in the snapshot`);
  }
  const status = records === 0 ? "unavailable" : warnings.length > 0 ? "incomplete" : "complete";
  return { status, usd: status === "complete" ? Math.round(usd * 1e9) / 1e9 : null, sessions: seenSessions.size, records, tokens, warnings, notes: [...notes] };
}
