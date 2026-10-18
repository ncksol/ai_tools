import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALL_FEATURES, stripFeatures, type Feature } from "../lib/features.ts";
import { KICKOFF_MAX_CHARS, kickoffProblems } from "../lib/kickoff.ts";
import { KIT_DIR } from "../lib/suite.ts";

const read = (path: string) => readFileSync(join(KIT_DIR, path), "utf8");
const kickoff = read("kickoff.md");
const spec = read("seed/docs/spec-v2.md");
const keep: Feature[] = ["policy", "reports", "import"];

test("kickoff.md passes every kickoff check", () => {
  assert.deepEqual(kickoffProblems(kickoff, spec), []);
  assert.ok(kickoff.length <= KICKOFF_MAX_CHARS);
});

test("kickoff.md passes every kickoff check against the spec without Summary", () => {
  assert.deepEqual(kickoffProblems(kickoff, stripFeatures(spec, keep)), []);
});

test("stripFeatures leaves the kickoff unchanged", () => {
  assert.equal(stripFeatures(kickoff, keep), kickoff);
  assert.equal(stripFeatures(kickoff, ALL_FEATURES), kickoff);
});

test("kickoff.md keeps the advance approvals and the definition of done", () => {
  for (const phrase of [/plan is approved/i, /open pull requests/i, /ready for review/i, /squash-merge/i, /CI is green/i, /every feature in the spec/i, /final report/i]) {
    assert.match(kickoff, phrase);
  }
});

const problem = (text: string, pattern: RegExp) => assert.ok(kickoffProblems(text, spec).some((p) => pattern.test(p)), text);
const base = "Build docs/spec-v2.md.";

test("a kickoff over the length limit fails", () => {
  problem(base + " x".repeat(KICKOFF_MAX_CHARS), /over the \d+ limit/);
});

test("a kickoff without the spec path fails", () => {
  problem("Build the spec.", /does not point at docs\/spec-v2\.md/);
});

test("a kickoff that quotes the spec fails", () => {
  const line = spec.split("\n").find((l) => l.split(/\s+/).length > 12) ?? "";
  problem(`${base} ${line}`, /embeds spec text/);
  problem(`${base}\n\n## General rules`, /markdown heading/);
});

test("a kickoff that names a feature or counts them fails", () => {
  problem(`${base} Start with Policy.`, /names the feature "Policy"/);
  problem(`${base} Do csv import last.`, /names the feature "CSV import"/);
  problem(`${base} Build all four features.`, /feature count/);
  problem(`${base} There are 3 v2 features.`, /feature count/);
});

test("a kickoff that mentions the kit fails", () => {
  for (const text of ["A hidden suite checks it.", "See the reference.", "This is an eval.", "You are scored on time.", "Acceptance tests run later."]) {
    problem(`${base} ${text}`, /mentions the kit/);
  }
});
