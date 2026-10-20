import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ALL_FEATURES } from "../lib/features.ts";
import { run } from "../lib/proc.ts";
import { KIT_DIR, robustnessFiles, robustnessSha256, runSuite, suiteFiles } from "../lib/suite.ts";
import { PERMISSIVE_CSV } from "./fixtures/permissive-csv.ts";

const REFERENCE = join(KIT_DIR, "reference");

// Only these fail on the permissive copy; the other robustness tests are controls that it passes.
const PERMISSIVE_FAILURES = [
  "I2 a lone CR in an unquoted field makes its row invalid",
  "I2 a lone CR in an unquoted field of a CRLF file makes its row invalid",
  "I2 a double quote inside an unquoted field makes its row invalid",
  "I2 text after a closing quote makes its row invalid",
  "I2 an unclosed quote runs to the end of the file and its row is invalid",
  "I2 I4 a header with a quote opening inside a name imports nothing",
  "I2 I4 a header with text after a closing quote imports nothing",
  "I2 I4 a header with an unclosed quote imports nothing",
  "I2 I4 a header with a lone CR in a name imports nothing",
];

let scratch: string;
let permissive: string;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "orch-eval-robustness-"));
  permissive = join(scratch, "permissive");
  cpSync(REFERENCE, permissive, { recursive: true });
  writeFileSync(join(permissive, "src", "csv.ts"), PERMISSIVE_CSV);
});

after(() => rmSync(scratch, { recursive: true, force: true }));

function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  return run(process.execPath, ["scripts/robustness.ts", ...args], { cwd: KIT_DIR, env });
}

test("robustnessFiles has a file for import only, and never an acceptance file", () => {
  assert.deepEqual(robustnessFiles(ALL_FEATURES), [join(KIT_DIR, "robustness", "import.test.ts")]);
  assert.deepEqual(robustnessFiles(["import"]), [join(KIT_DIR, "robustness", "import.test.ts")]);
  assert.deepEqual(robustnessFiles(["policy", "reports", "summary"]), []);
  assert.deepEqual(robustnessFiles([]), []);
  const gate = new Set(suiteFiles(ALL_FEATURES));
  assert.ok(robustnessFiles(ALL_FEATURES).every((file) => !gate.has(file)));
});

test("the reference passes every robustness test", { timeout: 120_000 }, async () => {
  const suite = await runSuite(REFERENCE, robustnessFiles(ALL_FEATURES));
  assert.ok(suite.total >= PERMISSIVE_FAILURES.length + 3, suite.output);
  assert.equal(suite.passed, suite.total, suite.output);
  assert.ok(suite.ok, suite.output);
});

test("a permissive copy of the reference passes the gate but fails robustness", { timeout: 300_000 }, async () => {
  const gate = await runSuite(permissive, suiteFiles(ALL_FEATURES));
  assert.ok(gate.total > 0, gate.output);
  assert.ok(gate.ok, `the permissive copy should pass the gate:\n${gate.output}`);

  const suite = await runSuite(permissive, robustnessFiles(ALL_FEATURES));
  assert.equal(suite.ok, false, suite.output);
  assert.deepEqual([...suite.failures].sort(), [...PERMISSIVE_FAILURES].sort(), suite.output);
  assert.equal(suite.passed, suite.total - PERMISSIVE_FAILURES.length, suite.output);
  assert.ok(suite.passed > 0, suite.output);
});

test("the CLI reports passes on the reference and failures on the permissive copy", { timeout: 120_000 }, async () => {
  const good = await cli(["--app", REFERENCE]);
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /^(\d+)\/\1 robustness tests passed$/m);
  assert.ok(good.stdout.startsWith(`Robustness suite sha256: ${robustnessSha256(robustnessFiles(ALL_FEATURES))}\n`), good.stdout);
  assert.doesNotMatch(good.stdout, /^(0\/0|.*acceptance)/m);

  const bad = await cli(["--app", permissive, "--features", "policy,import"]);
  assert.equal(bad.code, 1, bad.stdout + bad.stderr);
  for (const name of PERMISSIVE_FAILURES) assert.ok(bad.stdout.includes(`FAIL ${name}\n`), bad.stdout);
  assert.match(bad.stdout, /^\d+\/\d+ robustness tests passed$/m);
});

test("the CLI runs nothing for features without robustness tests, and checks its arguments", async () => {
  const none = await cli(["--app", REFERENCE, "--features", "policy,summary"]);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.equal(none.stdout, "No robustness tests cover policy+summary\n");

  const noApp = await cli([]);
  assert.equal(noApp.code, 2);
  assert.match(noApp.stderr, /Usage: node scripts\/robustness\.ts --app <dir> \[--features <list>\] \[--verbose\]/);

  const unknown = await cli(["--app", REFERENCE, "--features", "billing"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /billing/);

  const only = await cli(["--app", REFERENCE, "--only", "import"]);
  assert.equal(only.code, 2);

  const badBudget = await cli(["--app", REFERENCE], { ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS: "0" });
  assert.equal(badBudget.code, 2);
  assert.match(badBudget.stderr, /ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS/);
});

test("the CLI stops at its budget and reports an error, not counts", { timeout: 60_000 }, async () => {
  // 1 ms ends the run before any test file can report.
  const result = await cli(["--app", REFERENCE], { ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS: "1" });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Robustness error: stopped after its 1 s budget$/m);
  assert.doesNotMatch(result.stdout, /robustness tests passed/);
});
