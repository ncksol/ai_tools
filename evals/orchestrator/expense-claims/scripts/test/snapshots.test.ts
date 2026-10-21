import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIT_DIR } from "../lib/suite.ts";
import { readVariants } from "../lib/variants.ts";

const set = readVariants(join(KIT_DIR, "variants", "review-policy.json"));
const a = set.variants["orchestrator-review-a"];
const b = set.variants["orchestrator-review-b"];
const c = set.variants["orchestrator-review-c"];
const read = (file: string) => readFileSync(file, "utf8");
const originalName = (text: string) => text.replace(/^name: orchestrator-review-[abc]$/m, "name: orchestrator");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test("A and B preserve the immutable source bytes except for the alias name", () => {
  assert.equal(a.revision, "a7e3fb04a697745a3cf1cc82137429913bbc0982");
  assert.equal(b.revision, "c7b48ea1f78c702b48646019eb568220d27b74ef");
  assert.equal(hash(originalName(read(a.file))), "3f9071cd17649bdb3f185c4960f971d9e7a25afd1f36b3613bfc711fd2c7b9c2");
  assert.equal(hash(originalName(read(b.file))), "5132b95e629c9f7e983116782290a14b59ab3c3d73e57d84351cf48295c633b8");
});

test("C changes only the regular-review row and Opus regular-review route from B", () => {
  assert.equal(c.revision, b.revision);
  const text = originalName(read(c.file));
  const restored = text
    .replace("Opus at `xhigh`, Astra at `high` or Argon at `high` (Opus-written code only), never from the author's vendor",
      "Opus at `xhigh` or Astra at `high`, never from the author's vendor")
    .replace("For regular reviews only, Opus-written code goes to Argon at `high`; Sonnet-written code goes to Astra; Astra- or Sol-written code goes to Opus; Argon-written code can go to either Astra or Opus.",
      "Opus- or Sonnet-written code goes to Astra; Astra- or Sol-written code goes to Opus; Argon-written code can go to either.");
  assert.notEqual(text, restored);
  assert.equal(restored, originalName(read(b.file)));
});

test("all aliases retain the source description and invocation boundary and share one worker", () => {
  const descriptions = new Set<string>();
  for (const [label, variant] of Object.entries(set.variants)) {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(read(variant.file))![1];
    assert.match(front, new RegExp(`^name: ${label}$`, "m"));
    assert.match(front, /^disable-model-invocation: true$/m);
    assert.doesNotMatch(front, /^user-invocable:/m, "do not assume hidden aliases support detached top-level launch");
    descriptions.add(front.split("\n").find((line) => line.startsWith("description:"))!);
    assert.deepEqual(Object.keys(variant.workers), ["orchestrator-worker"]);
    assert.equal(variant.workers["orchestrator-worker"].sha256, "ddfb9cad946a04d4a75104578ceac2e0066cdb73dbcc71184da29d2f402bba61");
  }
  assert.equal(descriptions.size, 1);
});
