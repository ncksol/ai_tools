import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { notices, readNtfyUrl, redact, sendNtfy } from "../lib/batch/notify.ts";
import { startNtfyStub } from "../lib/batch/rehearsal.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-notify-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test("the topic URL comes from the environment first, then the private file", () => {
  const file = join(dir, "ntfy-url");
  writeFileSync(file, "# my topic\n\nhttps://ntfy.example/secret-topic\n");
  assert.equal(readNtfyUrl({ envVar: "X_URL", urlFile: file, env: {} }), "https://ntfy.example/secret-topic");
  assert.equal(readNtfyUrl({ envVar: "X_URL", urlFile: file, env: { X_URL: "https://ntfy.example/env-topic" } }), "https://ntfy.example/env-topic");
  assert.equal(readNtfyUrl({ envVar: "X_URL", urlFile: join(dir, "none"), env: {} }), null);
  writeFileSync(file, "not a url\n");
  assert.equal(readNtfyUrl({ envVar: "X_URL", urlFile: file, env: {} }), null);
});

test("notification text", () => {
  assert.equal(notices.batchStarted("20261019-2200", "orchestrator x3, session-orchestrator x3 on policy+reports+import").body, "Batch 20261019-2200 started. Plan: orchestrator x3, session-orchestrator x3 on policy+reports+import.");
  const passed = notices.runOutcome("b1", { index: 2, total: 6, variant: "session-orchestrator", n: 1, outcome: "passed", minutes: "38.4", suite: "59/59", prs: "3", ci: "success", flags: [] });
  assert.equal(passed.title, "Eval run 2/6: passed");
  assert.equal(passed.body, "Batch b1, run 2 of 6: session-orchestrator #1 passed in 38.4 min (suite 59/59, PRs merged 3, main CI success). Flags: none.");
  assert.equal(passed.priority, "default");
  const flagged = notices.runOutcome("b1", { index: 3, total: 6, variant: "orchestrator", n: 3, outcome: "stalled", minutes: "41.0", suite: "40/59", prs: "1", ci: "failure", flags: ["memory-write", "open-tool-at-stall"] });
  assert.match(flagged.body, /Flags: memory-write, open-tool-at-stall\.$/);
  assert.equal(flagged.priority, "high");
  assert.match(notices.done("b1", "6 run(s)", "/r.md").body, /Turn Copilot Memory back on at github\.com\/settings\/copilot\/features/);
  assert.match(notices.stopped("b1", "pinned inputs changed", "/r.md").body, /Turn Copilot Memory back on/);
  assert.equal(notices.selfTest("b1", 1, false, "no memories loaded").priority, "high");
});

test("sendNtfy posts title, priority, tags and body to the topic (local stub)", async () => {
  const stub = await startNtfyStub();
  try {
    const result = await sendNtfy(stub.url, notices.runVoid("b1", "orchestrator", 4, "create_session failed"));
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(stub.received, [{ title: "Eval run void", priority: "high", body: "Batch b1: orchestrator #4 is void and was not scored: create_session failed" }]);
  } finally {
    await stub.close();
  }
});

test("the URL goes to curl on stdin, never in its arguments, and is redacted from errors", async () => {
  const fake = join(dir, "fake-curl.sh");
  const argsFile = join(dir, "args.txt");
  const stdinFile = join(dir, "stdin.txt");
  writeFileSync(fake, `#!/bin/sh\necho "$@" > ${argsFile}\ncat > ${stdinFile}\necho "curl: (22) The requested URL returned error: 403 for $(grep '^url' ${stdinFile})" >&2\nexit 22\n`);
  chmodSync(fake, 0o755);
  const url = "https://ntfy.example/very-secret-topic";
  const result = await sendNtfy(url, notices.failure("b1", "x", "test"), { curl: fake });
  assert.equal(result.ok, false);
  assert.doesNotMatch(readFileSync(argsFile, "utf8"), /very-secret-topic/);
  assert.match(readFileSync(stdinFile, "utf8"), /^url = "https:\/\/ntfy\.example\/very-secret-topic"$/m);
  assert.doesNotMatch(result.error ?? "", /very-secret-topic/);
  assert.match(result.error ?? "", /<ntfy-url>/);
  assert.equal(redact(`a ${url} b`, url), "a <ntfy-url> b");
});

test("a missing curl is a failed notification, not a crash", async () => {
  const result = await sendNtfy("https://ntfy.example/t", notices.failure("b1", "x", "y"), { curl: join(dir, "no-such-curl") });
  assert.equal(result.ok, false);
});
