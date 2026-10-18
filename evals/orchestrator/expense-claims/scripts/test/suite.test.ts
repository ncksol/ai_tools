import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_FEATURES, featureSetName, parseFeatures } from "../lib/features.ts";
import { KIT_DIR, parseTap, suiteFiles } from "../lib/suite.ts";

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
