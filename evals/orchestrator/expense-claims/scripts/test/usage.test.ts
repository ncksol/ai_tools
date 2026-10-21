import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPricing, priceUsage, collectUsage } from "../lib/usage.ts";
import { KIT_DIR } from "../lib/suite.ts";
import { ev, writeSession } from "./fixtures/events.ts";

const pricing = () => readPricing(join(KIT_DIR, "pricing", "2026-10-20.json"));
const at = "2026-10-20T12:00:00Z";
const usage = (model = "claude-opus-5.5", extra: Record<string, unknown> = {}) => ({
  model, inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 200, outputTokens: 100,
  interactionType: "conversation-agent", ...extra,
});

test("uncached input excludes both cache categories and legacy cost never contributes", () => {
  // 200*4 + 600*.2 + 200*5 + 100*20 = 3920 microdollars.
  assert.equal(priceUsage(usage(undefined, { cost: 999999 }), at, pricing()), 0.00392);
});

test("Astra and Sol use the high tier only above 272000 inclusive input tokens", () => {
  const cases: [string, number, number][] = [
    ["gpt-6-astra", 272000, 2.725],
    ["gpt-6-astra", 272001, 5.44752],
    ["gpt-6.1-sol", 272000, 0.545],
    ["gpt-6.1-sol", 272001, 1.089504],
  ];
  for (const [model, inputTokens, expected] of cases) {
    assert.equal(priceUsage(usage(model, { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }), at, pricing()), expected);
  }
});

test("Argon promotion expiry is exclusive and unsupported cache writes are not free tokens", () => {
  const u = usage("gemini-4-argon", { cacheWriteTokens: 0 });
  assert.equal(priceUsage(u, "2026-11-30T23:59:59Z", pricing()), 0.00186);
  assert.throws(() => priceUsage(u, "2026-12-01T00:00:00Z", pricing()), /expired/);
  assert.throws(() => priceUsage(usage("gemini-4-argon"), at, pricing()), /cache write/i);
});

test("unknown models and impossible or missing counters fail explicitly", () => {
  assert.throws(() => priceUsage(usage("unknown"), at, pricing()), /price/i);
  assert.throws(() => priceUsage(usage(undefined, { isAuto: true }), at, pricing()), /discounted rate/);
  for (const extra of [{ inputTokens: 799 }, { outputTokens: -1 }, { inputTokens: 1.5 }, { cacheReadTokens: undefined }]) {
    assert.throws(() => priceUsage(usage(undefined, extra), at, pricing()), /token|counter/i);
  }
});

test("usage includes root, recursive children and in-log subagents once, not unrelated sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    const create = (id: string, child: string) => [
      ev("tool.execution_start", 2, { toolName: "create_session", toolCallId: id }),
      ev("tool.execution_complete", 3, { toolCallId: id, success: true, result: { content: `Created session 'Child' (id: ${child}) in project 'test'.` } }),
    ];
    const call = (id: string, minute: number, sub = false) => ({
      ...ev("session.usage_record", minute, { usage: usage(undefined, { interactionType: sub ? "conversation-subagent" : "conversation-agent" }) }),
      id,
    });
    writeSession(dir, "root", "test/repo", at, [...create("c1", "child"), call("u1", 4), call("u2", 5, true)]);
    writeSession(dir, "child", "test/repo", at, [...create("c2", "grandchild"), call("u3", 6), call("u3", 6)]);
    writeSession(dir, "grandchild", "test/repo", at, [call("u4", 7)]);
    writeSession(dir, "stranger", "test/repo", at, [call("u5", 7)]);
    const before = readFileSync(join(dir, "root", "events.jsonl"), "utf8");
    const result = collectUsage({ stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:08:00Z", pricing: pricing() });
    assert.equal(result.status, "complete", result.warnings.join("; "));
    assert.equal(result.usd, 0.01568);
    assert.equal(result.sessions, 3);
    assert.equal(result.records, 4);
    assert.deepEqual(result.tokens, { inputTokens: 4000, cacheReadTokens: 2400, cacheWriteTokens: 800, outputTokens: 400 });
    assert.equal(readFileSync(join(dir, "root", "events.jsonl"), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archived database descendants are included and missing child logs make the total incomplete", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    writeSession(dir, "root", "test/repo", at, [ev("session.usage_record", 4, { usage: usage() })]);
    writeSession(dir, "archived", "test/repo", at, [ev("session.usage_record", 5, { usage: usage() })]);
    const options = { stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:08:00Z", pricing: pricing() };
    const complete = collectUsage({ ...options, children: (id) => id === "root" ? ["archived"] : [] });
    assert.equal(complete.status, "complete");
    assert.equal(complete.usd, 0.00784);
    const incomplete = collectUsage({ ...options, children: (id) => id === "root" ? ["missing"] : [] });
    assert.equal(incomplete.status, "incomplete");
    assert.equal(incomplete.usd, null);
    assert.match(incomplete.warnings.join("; "), /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot includes final-response usage but excludes earlier and later records", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    writeSession(dir, "root", "test/repo", at, [
      ev("session.usage_record", 0, { usage: usage() }),
      ev("assistant.message", 4),
      ev("session.usage_record", 4.1, { usage: usage() }),
      ev("session.usage_record", 6, { usage: usage() }),
    ]);
    const result = collectUsage({ stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:05:00Z", pricing: pricing() });
    assert.equal(result.records, 1);
    assert.equal(result.usd, 0.00392);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session with no usage is unavailable rather than a zero-dollar run", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    writeSession(dir, "root", "test/repo", at, [ev("assistant.message", 4)]);
    const result = collectUsage({ stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:05:00Z", pricing: pricing() });
    assert.equal(result.status, "unavailable");
    assert.equal(result.usd, null);
    assert.match(result.warnings.join("; "), /no usage/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace ids resolve to child logs and mirrored accounting ids are billed only once", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    const shared = usage(undefined, { accounting: { sourceSessionId: "child", usageId: "one-call" } });
    writeSession(dir, "root", "test/repo", at, [
      ev("session.usage_record", 2, { usage: usage() }),
      ev("session.usage_record", 3, { usage: shared }),
    ]);
    writeSession(dir, "child", "test/repo", at, [ev("session.usage_record", 3, { usage: shared })]);
    const result = collectUsage({
      stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:05:00Z", pricing: pricing(),
      children: (id) => id === "root" ? ["workspace"] : [],
      resolveSession: (id) => id === "workspace" ? "child" : null,
    });
    assert.equal(result.status, "complete", result.warnings.join("; "));
    assert.equal(result.sessions, 2);
    assert.equal(result.records, 2);
    assert.equal(result.usd, 0.00784);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown prices, unresolved creations, broken logs and failed discovery never produce a complete dollar total", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    const options = { stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:05:00Z", pricing: pricing() };
    const valid = ev("session.usage_record", 2, { usage: usage() });
    const cases = [
      [valid, ev("session.usage_record", 3, { usage: usage("unknown") })],
      [valid, ev("session.usage_record", 3, { usage: usage(undefined, { isAuto: true }) })],
      [valid, ev("tool.execution_start", 3, { toolName: "create_session", toolCallId: "created" }),
        ev("tool.execution_complete", 4, { toolCallId: "created", success: true, result: { content: "unrecognized result" } })],
      [valid, ev("tool.execution_start", 3, { toolName: "create_session", toolCallId: "pending" })],
    ];
    for (const events of cases) {
      writeSession(dir, "root", "test/repo", at, events);
      const result = collectUsage(options);
      assert.equal(result.status, "incomplete");
      assert.equal(result.usd, null);
      assert.ok(result.warnings.length > 0);
    }
    writeSession(dir, "root", "test/repo", at, [valid]);
    const failedDiscovery = collectUsage({ ...options, children: () => { throw new Error("schema changed"); } });
    assert.equal(failedDiscovery.usd, null);
    assert.match(failedDiscovery.warnings.join("; "), /schema changed/);
    const failedAliases = collectUsage({ ...options, aliases: () => { throw new Error("alias schema changed"); } });
    assert.equal(failedAliases.status, "incomplete");
    assert.equal(failedAliases.usd, null);
    assert.match(failedAliases.warnings.join("; "), /alias discovery failed/);
    const missingAlias = collectUsage({ ...options, aliases: () => ["missing-alias"] });
    assert.equal(missingAlias.status, "incomplete");
    assert.equal(missingAlias.usd, null);
    assert.match(missingAlias.warnings.join("; "), /missing-alias/);
    appendFileSync(join(dir, "root", "events.jsonl"), "{broken}\n");
    const broken = collectUsage(options);
    assert.equal(broken.status, "unavailable");
    assert.equal(broken.usd, null);
    assert.match(broken.warnings.join("; "), /valid JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rotated CLI session logs contribute usage and their descendants without counting mirrors twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  try {
    const shared = usage(undefined, { accounting: { sourceSessionId: "old-root", usageId: "shared" } });
    writeSession(dir, "root", "test/repo", at, [ev("session.usage_record", 2, { usage: shared })]);
    writeSession(dir, "old-root", "test/repo", at, [
      ev("session.usage_record", 2, { usage: shared }), ev("session.usage_record", 3, { usage: usage() }),
    ]);
    writeSession(dir, "old-child", "test/repo", at, [ev("session.usage_record", 4, { usage: usage() })]);
    const result = collectUsage({
      stateDir: dir, rootId: "root", start: "2026-01-01T10:01:00Z", capturedAt: "2026-01-01T10:05:00Z", pricing: pricing(),
      aliases: (id) => id === "root" ? ["old-root"] : id === "old-root" ? ["root"] : [],
      children: (id) => id === "old-root" ? ["old-child"] : [],
    });
    assert.equal(result.status, "complete", result.warnings.join("; "));
    assert.equal(result.records, 3);
    assert.equal(result.sessions, 3);
    assert.equal(result.usd, 0.01176);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("invalid rate files fail rather than selecting implicit prices", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-pricing-"));
  try {
    const path = join(dir, "pricing.json");
    for (const bad of [{}, { date: "2026-10-20", currency: "USD", perTokens: 1_000_000, models: { test: [] } }]) {
      writeFileSync(path, JSON.stringify(bad));
      assert.throws(() => readPricing(path), /pricing|tiers/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
