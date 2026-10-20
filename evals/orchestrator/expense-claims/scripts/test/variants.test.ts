import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readVariants, verifyVariants, variantBundle } from "../lib/variants.ts";
import { planNext } from "../lib/batch/plan.ts";
import type { RunState } from "../lib/batch/state.ts";
import { RESULT_COLUMNS, type ResultRow } from "../lib/results.ts";
import { chooseRunSession } from "../lib/events.ts";
import { ev, writeSession } from "./fixtures/events.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orch-variants-"));
  const agents = join(dir, "installed");
  mkdirSync(agents);
  const variants = Object.fromEntries(["a", "b", "c"].map((label) => {
    const agent = `orchestrator-review-${label}`;
    const text = `---\nname: ${agent}\nuser-invocable: false\n---\nPolicy ${label}; use worker.\n`;
    writeFileSync(join(dir, `${agent}.agent.md`), text);
    writeFileSync(join(agents, `${agent}.agent.md`), text);
    return [agent, { agent, revision: "a".repeat(40), file: `${agent}.agent.md`, sha256: hash(text) }];
  }));
  writeFileSync(join(dir, "worker.agent.md"), "worker\n");
  writeFileSync(join(agents, "worker.agent.md"), "worker\n");
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ id: "review-policy", calibration: "all-variants-then-drop-summary", variants, workers: { worker: { file: "worker.agent.md", sha256: hash("worker\n") } } }));
  return { dir, agents, path };
}

test("variant selection pins aliases and workers independently of the ordinary installed orchestrator", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.agents, "orchestrator.agent.md"), "moving normal agent");
    const set = readVariants(f.path);
    assert.equal(set.variants["orchestrator-review-a"].agent, "orchestrator-review-a");
    assert.deepEqual(verifyVariants(set, f.agents), []);
    const before = variantBundle(set.variants["orchestrator-review-a"]);
    writeFileSync(join(f.agents, "orchestrator.agent.md"), "new normal policy");
    assert.deepEqual(verifyVariants(set, f.agents), []);
    assert.equal(variantBundle(set.variants["orchestrator-review-a"]), before);
    writeFileSync(join(f.agents, "worker.agent.md"), "changed worker\n");
    assert.match(verifyVariants(set, f.agents).join("; "), /worker.*hash/);
    rmSync(join(f.agents, "worker.agent.md"));
    assert.match(verifyVariants(set, f.agents).join("; "), /worker.*missing/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("manifest labels equal file IDs and logged names so session selection can break ties", () => {
  const f = fixture();
  try {
    const set = readVariants(f.path);
    const labels = Object.keys(set.variants);
    for (const [index, label] of labels.entries()) {
      writeSession(f.dir, `session-${index}`, "test/repo", "2026-01-01T10:00:00Z", [
        ev("subagent.selected", 0, { agentName: label }), ev("user.message", 1, { content: "Start" }),
      ]);
    }
    assert.equal(chooseRunSession(f.dir, "test/repo", labels[1]).session.id, "session-1");
    const manifest = JSON.parse(readFileSync(f.path, "utf8"));
    manifest.variants[labels[0]].agent = "orchestrator";
    writeFileSync(f.path, JSON.stringify(manifest));
    assert.throws(() => readVariants(f.path), /Invalid variant/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
test("missing aliases, stale snapshot hashes and malformed manifests stop selection", () => {
  const f = fixture();
  try {
    const set = readVariants(f.path);
    rmSync(join(f.agents, "orchestrator-review-c.agent.md"));
    assert.match(verifyVariants(set, f.agents).join("; "), /orchestrator-review-c.*missing/);
    writeFileSync(join(f.dir, "orchestrator-review-a.agent.md"), "changed");
    assert.throws(() => readVariants(f.path), /hash/);
    writeFileSync(f.path, JSON.stringify({ variants: {} }));
    assert.throws(() => readVariants(f.path), /manifest/i);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("every pinned variant calibrates before Summary drops, regardless of legacy shortcuts", () => {
  const f = fixture();
  try {
    const set = readVariants(f.path);
    const labels = Object.keys(set.variants);
    const row = (variant: string, bundle: string): ResultRow => ({
      ...Object.fromEntries(RESULT_COLUMNS.map((key) => [key, ""])),
      variant, agent_bundle_sha256: bundle, agent_sha256: set.variants[variant]?.sha256 ?? "", run: "1", repo: `o/${variant}`,
      features: "policy+reports+import+summary", calibration: "yes", outcome: "passed", minutes: "65.7",
    }) as ResultRow;
    const rows = [row("old-agent", "")];
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, labels[0]);
    rows.push(row(labels[0], "wrong-bundle"));
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, labels[0]);
    rows.push(row(labels[0], variantBundle(set.variants[labels[0]])));
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, labels[1]);
    rows.push(row(labels[1], variantBundle(set.variants[labels[1]])));
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, labels[2]);
    rows.push(row(labels[2], variantBundle(set.variants[labels[2]])));
    assert.deepEqual(planNext([], rows, labels, 3, set).next, { variant: labels[0], features: ["policy", "reports", "import"], calibration: false });
    const runs: RunState[] = [];
    const order: string[] = [];
    for (let i = 0; i < 9; i++) {
      const next = planNext(runs, rows, labels, 3, set).next!;
      assert.equal(next.calibration, false);
      assert.deepEqual(next.features, ["policy", "reports", "import"]);
      order.push(next.variant);
      const n = i + 2;
      const repo = `o/run-${n}`;
      runs.push({
        key: repo, variant: next.variant, n, features: next.features, calibration: false,
        name: repo, repoDir: f.dir, repo, status: "done", createdAt: "", judged: [], answers: [],
        askAttempts: {}, requestIds: {}, flags: [],
      });
      rows.push({ ...row(next.variant, variantBundle(set.variants[next.variant])), repo, run: String(n),
        features: next.features.join("+"), calibration: "no", outcome: i % 2 ? "passed" : "gate-failed" });
      if (i === 3) assert.equal(planNext([], rows, labels, 3, set).next?.variant, labels[1], "a new batch resumes the same pilot");
    }
    assert.deepEqual(order, [...labels, ...labels, ...labels]);
    assert.equal(planNext(runs, rows, labels, 3, set).next, null, "the pilot stops at three scored attempts per variant");
    assert.equal(planNext([], rows, labels, 3, set).next, null, "another batch cannot repeat a completed pilot");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("fast completed calibrations stop the approved no-Summary pilot instead of silently changing its scope", () => {
  const f = fixture();
  try {
    const set = readVariants(f.path);
    const labels = Object.keys(set.variants);
    const rows = labels.map((variant) => ({
      ...Object.fromEntries(RESULT_COLUMNS.map((key) => [key, ""])),
      variant, agent_sha256: set.variants[variant].sha256, agent_bundle_sha256: variantBundle(set.variants[variant]),
      calibration: "yes", features: "policy+reports+import+summary", outcome: "passed", minutes: "10",
    }) as ResultRow);
    rows.push({ ...rows[0], variant: "legacy", agent_sha256: "", agent_bundle_sha256: "", minutes: "65.7" });
    const result = planNext([], rows, labels, 3, set);
    assert.equal(result.decision.state, "full");
    assert.equal(result.decision.best, 10);
    assert.equal(result.next, null);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
