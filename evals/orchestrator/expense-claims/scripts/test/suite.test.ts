import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TIMEOUTS } from "../lib/batch/runner.ts";
import { ALL_FEATURES, featureSetName, parseFeatures } from "../lib/features.ts";
import {
  KIT_DIR,
  parseTap,
  ROBUSTNESS_TIMEOUT_MS,
  robustnessDependencies,
  robustnessFiles,
  robustnessSha256,
  runSuite,
  suiteArgs,
  suiteFiles,
} from "../lib/suite.ts";

test("parseFeatures keeps canonical order and drops duplicates", () => {
  assert.deepEqual(parseFeatures("summary, policy,policy"), ["policy", "summary"]);
});

test("parseFeatures accepts an empty list", () => {
  assert.deepEqual(parseFeatures(""), []);
});

test("parseFeatures rejects unknown names", () => {
  assert.throws(() => parseFeatures("policy,billing"), /billing/);
});

test("parseFeatures needs policy for reports", () => {
  assert.throws(() => parseFeatures("reports"));
});

test("featureSetName joins with +", () => {
  assert.equal(featureSetName(ALL_FEATURES), "policy+reports+import+summary");
  assert.equal(featureSetName([]), "v1");
});

test("suiteFiles lists v1 then the features", () => {
  assert.deepEqual(suiteFiles(["policy", "summary"]), [
    join(KIT_DIR, "acceptance", "v1.test.ts"),
    join(KIT_DIR, "acceptance", "policy.test.ts"),
    join(KIT_DIR, "acceptance", "summary.test.ts"),
  ]);
  assert.ok(suiteFiles([])[0].startsWith("/"));
  assert.ok(KIT_DIR.endsWith(join("evals", "orchestrator", "expense-claims")));
});

test("suiteArgs runs the files one at a time", () => {
  const args = suiteArgs(["a.test.ts"]);
  assert.ok(args.includes("--test-concurrency=1"), args.join(" "));
  assert.equal(args.at(-1), "a.test.ts");
});

const tap = [
  "TAP version 13",
  "# Subtest: README Endpoints: GET /health returns ok",
  "ok 1 - README Endpoints: GET /health returns ok",
  "  ---",
  "  duration_ms: 12.5",
  "  ...",
  "# Subtest: P1 receipt over 2500",
  "not ok 2 - P1 receipt over 2500",
  "  ---",
  "  duration_ms: 20.1",
  "  ...",
  "# Subtest: P3 weekend",
  "ok 3 - P3 weekend",
  "1..3",
  "# tests 3",
  "# suites 0",
  "# pass 2",
  "# fail 1",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 300.5",
  "",
].join("\n");

test("parseTap reads the summary and failures", () => {
  assert.deepEqual(parseTap(tap), { total: 3, passed: 2, failed: 1, failures: ["P1 receipt over 2500"] });
});

test("robustnessDependencies follows relative imports from the robustness files", () => {
  assert.deepEqual(robustnessDependencies(robustnessFiles(ALL_FEATURES)), ["acceptance/helpers.ts", "robustness/import.test.ts"]);
  assert.deepEqual(robustnessDependencies([]), []);
});

test("robustnessSha256 is stable and changes with a dependency, the runner arguments or the budget", () => {
  const scratch = mkdtempSync(join(tmpdir(), "orch-eval-suite-"));
  try {
    mkdirSync(join(scratch, "robustness"));
    mkdirSync(join(scratch, "acceptance"));
    writeFileSync(join(scratch, "robustness", "import.test.ts"), 'import { x } from "../acceptance/helpers.ts";\nimport "node:test";\n');
    writeFileSync(join(scratch, "acceptance", "helpers.ts"), "export const x = 1;\n");
    const files = [join(scratch, "robustness", "import.test.ts")];
    assert.deepEqual(robustnessDependencies(files, scratch), ["acceptance/helpers.ts", "robustness/import.test.ts"]);
    const first = robustnessSha256(files, { root: scratch });
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(robustnessSha256(files, { root: scratch }), first);
    assert.equal(robustnessSha256(files, { root: scratch, timeoutMs: ROBUSTNESS_TIMEOUT_MS }), first);
    assert.notEqual(robustnessSha256(files, { root: scratch, timeoutMs: 1000 }), first);
    writeFileSync(join(scratch, "acceptance", "helpers.ts"), "export const x = 2;\n");
    assert.notEqual(robustnessSha256(files, { root: scratch }), first);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(robustnessSha256([]), "");
  assert.match(robustnessSha256(robustnessFiles(ALL_FEATURES)), /^[a-f0-9]{64}$/);
});

test("the robustness budget is well inside the batch runner's score budget", () => {
  assert.equal(ROBUSTNESS_TIMEOUT_MS, 2 * 60_000);
  assert.ok(ROBUSTNESS_TIMEOUT_MS * 10 <= TIMEOUTS.score);
});

test("runSuite stops a suite that runs past its budget, with its process group", { timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "orch-eval-suite-"));
  try {
    const pidFile = join(scratch, "pid");
    const hang = join(scratch, "hang.test.ts");
    // A test that starts a grandchild ignoring SIGTERM, then never finishes.
    writeFileSync(
      hang,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'import { test } from "node:test";',
        'test("hangs", async () => {',
        '  const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        "  await new Promise(() => {});",
        "});",
        "",
      ].join("\n"),
    );
    const started = Date.now();
    const result = await runSuite(scratch, [hang], { timeoutMs: 2000 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
