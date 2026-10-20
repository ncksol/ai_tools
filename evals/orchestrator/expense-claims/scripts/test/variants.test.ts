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
    return [`review-${label}`, { agent, revision: "a".repeat(40), file: `${agent}.agent.md`, sha256: hash(text), workers: { worker: { file: "worker.agent.md", sha256: hash("worker\n") } } }];
  }));
  writeFileSync(join(dir, "worker.agent.md"), "worker\n");
  writeFileSync(join(agents, "worker.agent.md"), "worker\n");
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ id: "review-policy", calibration: "all-variants-then-drop-summary", variants }));
  return { dir, agents, path };
}

test("variant selection pins aliases and workers independently of the ordinary installed orchestrator", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.agents, "orchestrator.agent.md"), "moving normal agent");
    const set = readVariants(f.path);
    assert.equal(set.variants["review-a"].agent, "orchestrator-review-a");
    assert.deepEqual(verifyVariants(set, f.agents), []);
    const before = variantBundle(set.variants["review-a"]);
    writeFileSync(join(f.agents, "orchestrator.agent.md"), "new normal policy");
    assert.deepEqual(verifyVariants(set, f.agents), []);
    assert.equal(variantBundle(set.variants["review-a"]), before);
    writeFileSync(join(f.agents, "worker.agent.md"), "changed worker\n");
    assert.match(verifyVariants(set, f.agents).join("; "), /worker.*hash/);
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
      variant, agent_bundle_sha256: bundle, run: "1", repo: `o/${variant}`,
      features: "policy+reports+import+summary", calibration: "yes", outcome: "passed", minutes: "65.7",
    }) as ResultRow;
    const rows = [row("old-agent", "")];
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, "review-a");
    rows.push(row("review-a", "wrong-bundle"));
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, "review-a");
    rows.push(row("review-a", variantBundle(set.variants["review-a"])));
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, "review-b");
    rows.push(row("review-b", variantBundle(set.variants["review-b"])));
    assert.equal(planNext([], rows, labels, 3, set).next?.variant, "review-c");
    rows.push(row("review-c", variantBundle(set.variants["review-c"])));
    assert.deepEqual(planNext([], rows, labels, 3, set).next, { variant: "review-a", features: ["policy", "reports", "import"], calibration: false });
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
    }
    assert.deepEqual(order, [...labels, ...labels, ...labels]);
    assert.equal(planNext(runs, rows, labels, 3, set).next, null, "the pilot stops at three scored attempts per variant");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
