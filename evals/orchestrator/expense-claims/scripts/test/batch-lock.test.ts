// The batch lock and the machine guard, with real processes racing for them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ActiveBatchError, claimActive, releaseActive, tryOsLock } from "../lib/batch/lock.ts";
import { run as runProc } from "../lib/proc.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-lock-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const lockModule = new URL("../lib/batch/lock.ts", import.meta.url).href;
const procModule = new URL("../lib/proc.ts", import.meta.url).href;
const node = (script: string) => runProc(process.execPath, ["--input-type=module", "-e", script]);

function liveBatch(name: string): string {
  const batch = join(dir, name);
  mkdirSync(batch, { recursive: true });
  writeFileSync(join(batch, "config.json"), "{}");
  writeFileSync(join(batch, "state.json"), JSON.stringify({ phase: "runs" }));
  return batch;
}

// Child processes start together at `start` and report whether they got the lock while holding it.
function racers(path: string, count: number): Promise<string[]> {
  const start = Date.now() + 1500;
  const script = `import { tryOsLock } from ${JSON.stringify(lockModule)};
while (Date.now() < ${start}) {}
const held = await tryOsLock(${JSON.stringify(path)});
console.log(held ? "got" : "busy");
if (held) { await new Promise((r) => setTimeout(r, 1500)); await held.release(); }`;
  return Promise.all(Array.from({ length: count }, () => node(script))).then((results) => results.map((r) => r.stdout.trim() || r.stderr.trim()).sort());
}

test("only one of six racing processes gets the batch lock", async () => {
  assert.deepEqual(await racers(join(dir, "race.lock"), 6), ["busy", "busy", "busy", "busy", "busy", "got"]);
});

test("a holder killed with SIGKILL leaves nothing stale: the next racers still get exactly one lock", async () => {
  const path = join(dir, "killed.lock");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `import { tryOsLock } from ${JSON.stringify(lockModule)};
const held = await tryOsLock(${JSON.stringify(path)}); console.log(held ? "held" : "busy"); setInterval(() => {}, 1000);`]);
  await new Promise<void>((done) => holder.stdout.on("data", (chunk) => String(chunk).includes("held") && done()));
  assert.equal(await tryOsLock(path), null, "busy while the holder lives");
  holder.kill("SIGKILL");
  await new Promise((done) => holder.once("exit", done));
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(await racers(path, 4), ["busy", "busy", "busy", "got"]);
});

test("an empty or garbled lock file left by a crash doesn't block anyone", async () => {
  for (const content of ["", "0", "12345", "not a pid"]) {
    const path = join(dir, `junk-${content.length}.lock`);
    writeFileSync(path, content);
    const held = await tryOsLock(path);
    assert.ok(held, `content ${JSON.stringify(content)}`);
    assert.equal(await tryOsLock(path), null);
    await held.release();
    assert.ok(existsSync(path), "the file is kept, so every holder locks the same inode");
  }
});

test("a claim being published can't be taken over: the guard's mutex holds a second claimant until it is done", async () => {
  const guard = join(dir, "guard-publish.json");
  const a = liveBatch("batch-a");
  const b = liveBatch("batch-b");
  // Process A takes the guard's mutex, leaves an empty guard file (a half-written claim), waits, then
  // publishes its claim. B tries to claim meanwhile.
  const publisher = spawn(process.execPath, ["--input-type=module", "-e", `import { withOsLock } from ${JSON.stringify(lockModule)};
import { renameSync, writeFileSync } from "node:fs";
await withOsLock(${JSON.stringify(`${guard}.lock`)}, async () => {
  writeFileSync(${JSON.stringify(guard)}, "");
  console.log("publishing");
  await new Promise((r) => setTimeout(r, 1500));
  writeFileSync(${JSON.stringify(`${guard}.tmp`)}, JSON.stringify({ id: "a", dir: ${JSON.stringify(a)}, claimedAt: "t" }));
  renameSync(${JSON.stringify(`${guard}.tmp`)}, ${JSON.stringify(guard)});
}, { waitMs: 5000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), busyMessage: "busy" });`]);
  const exited = new Promise((done) => publisher.once("exit", done));
  await new Promise<void>((done) => publisher.stdout.on("data", (chunk) => String(chunk).includes("publishing") && done()));
  await assert.rejects(claimActive(guard, "b", b, "t"), ActiveBatchError);
  await exited;
  assert.equal(JSON.parse(readFileSync(guard, "utf8")).id, "a");
});

test("two batches claiming the machine at the same moment: exactly one wins", async () => {
  const guard = join(dir, "guard-race.json");
  const batches = [liveBatch("race-1"), liveBatch("race-2"), liveBatch("race-3")];
  const start = Date.now() + 1500;
  const results = await Promise.all(
    batches.map((batch, i) =>
      node(`import { claimActive } from ${JSON.stringify(lockModule)};
while (Date.now() < ${start}) {}
try { await claimActive(${JSON.stringify(guard)}, "race-${i}", ${JSON.stringify(batch)}, "t"); console.log("claimed"); }
catch (error) { console.log(error.constructor.name); }`),
    ),
  );
  assert.deepEqual(results.map((r) => r.stdout.trim()).sort(), ["ActiveBatchError", "ActiveBatchError", "claimed"]);
});

test("the guard knows a batch by its canonical folder and id, not by id alone", async () => {
  const guard = join(dir, "guard-identity.json");
  const first = liveBatch("same-id-1");
  const second = liveBatch("same-id-2");
  await claimActive(guard, "20261019-2200", first, "t");
  await assert.rejects(claimActive(guard, "20261019-2200", second, "t"), ActiveBatchError);
  const link = join(dir, "link-to-same-id-1");
  symlinkSync(first, link);
  await claimActive(guard, "20261019-2200", link, "t");
  await releaseActive(guard, "20261019-2200", second);
  assert.ok(existsSync(guard), "another batch can't release the claim");
  await releaseActive(guard, "20261019-2200", first);
  assert.equal(existsSync(guard), false);
  writeFileSync(join(first, "state.json"), JSON.stringify({ phase: "done" }));
});

test("a timed-out command's descendant that ignores SIGTERM is killed before the caller can exit", async () => {
  const marker = join(dir, "survivor-marker");
  const started = Date.now();
  const caller = await node(`import { run } from ${JSON.stringify(procModule)};
const t = Date.now();
const r = await run("sh", ["-c", "(trap '' TERM; sleep 7; touch ${marker}) </dev/null >/dev/null 2>&1 & sleep 30"], { timeoutMs: 800 });
console.log(JSON.stringify({ code: r.code, ms: Date.now() - t, stderr: r.stderr }));`);
  const result = JSON.parse(caller.stdout.trim()) as { code: number; ms: number; stderr: string };
  assert.equal(result.code, 124);
  assert.ok(result.ms >= 5000, `the caller waited for SIGKILL (${result.ms} ms)`);
  assert.match(result.stderr, /SIGKILL was needed/);
  await new Promise((done) => setTimeout(done, Math.max(0, started + 8500 - Date.now())));
  assert.equal(existsSync(marker), false, "the descendant never finished its work");
});
