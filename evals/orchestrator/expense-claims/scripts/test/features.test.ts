import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_FEATURES, detectFeatures, stripFeatures, type Feature } from "../lib/features.ts";
import { listSeedFiles } from "../lib/new-run.ts";
import { KIT_DIR } from "../lib/suite.ts";

const read = (path: string) => readFileSync(join(KIT_DIR, path), "utf8");
const spec = read("seed/docs/spec-v2.md");
const keep: Feature[] = ["policy", "reports", "import"];

test("detectFeatures finds every feature in the spec", () => {
  assert.deepEqual(detectFeatures(spec), ALL_FEATURES);
});

test("stripFeatures keeps everything when all features are kept", () => {
  assert.equal(stripFeatures(spec, ALL_FEATURES), spec);
});

test("stripFeatures drops the Summary section", () => {
  const result = stripFeatures(spec, keep);
  assert.ok(!result.includes("## Feature: Summary"));
  assert.ok(!result.includes("S1."));
  assert.ok(result.includes("## Feature: CSV import"));
  assert.ok(result.includes("I10."));
  assert.ok(result.endsWith("\n") && !result.endsWith("\n\n"));
  assert.deepEqual(detectFeatures(result), keep);
});

test("stripFeatures ignores headings inside code fences", () => {
  const md = "# T\n\n## Feature: Policy\n\n```\n## Feature: Summary\n```\n\n## Feature: Summary\n\ngone\n";
  const result = stripFeatures(md, ["policy"]);
  assert.ok(result.includes("```\n## Feature: Summary\n```"));
  assert.ok(!result.includes("gone"));
});

test("nothing in the seed mentions the hidden suite or the reference", () => {
  const seed = join(KIT_DIR, "seed");
  for (const file of listSeedFiles(seed)) {
    assert.doesNotMatch(readFileSync(join(seed, file), "utf8"), /acceptance|reference implementation|hidden/i, file);
  }
});
