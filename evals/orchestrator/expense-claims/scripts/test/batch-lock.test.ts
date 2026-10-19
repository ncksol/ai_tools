// The batch lock and the machine guard, with real processes racing for them.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ActiveBatchError, claimActive, HOLDER_LOST_EXIT, releaseActive, tryOsLock, withLock } from "../lib/batch/lock.ts";
import { loadState, saveState, StaleStateError, type BatchState } from "../lib/batch/state.ts";
import { run as runProc } from "../lib/proc.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-lock-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const lockModule = new URL("../lib/batch/lock.ts", import.meta.url).href;
const procModule = new URL("../lib/proc.ts", import.meta.url).href;
const stateModule = new URL("../lib/batch/state.ts", import.meta.url).href;
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

const lockOpts = { waitMs: 10_000, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), now: () => Date.now() };
const fakeState = (marker: string) => ({ phase: "runs", marker }) as unknown as BatchState;

// The pid of a process's child with the given command name, from ps.
async function childOf(parent: number, name: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const ps = await runProc("ps", ["-axo", "pid=,ppid=,comm="]);
    const line = ps.stdout.split("\n").map((l) => l.trim().split(/\s+/)).find((cols) => Number(cols[1]) === parent && (cols[2] ?? "").endsWith(name));
    if (line) return Number(line[0]);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${name} under ${parent}: ${(await runProc("ps", ["-axo", "pid=,ppid=,comm="])).stdout.split("\n").filter((l) => l.includes(String(parent))).join(" / ")}`);
}

test("losing the native lock holder stops the caller at once: it writes nothing and never returns, and a second caller gets the lock", async () => {
  const batch = join(dir, "holder-loss");
  mkdirSync(batch, { recursive: true });
  saveState(batch, fakeState("initial"));
  const caller = spawn(process.execPath, ["--input-type=module", "-e", `import { withLock } from ${JSON.stringify(lockModule)};
import { loadState, saveState } from ${JSON.stringify(stateModule)};
await withLock(${JSON.stringify(batch)}, async () => {
  const state = loadState(${JSON.stringify(batch)});
  console.log("inside");
  await new Promise((r) => setTimeout(r, 3000));
  state.marker = "A";
  saveState(${JSON.stringify(batch)}, state);
  console.log("A wrote");
}, { waitMs: 5000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });
console.log("A returned");`]);
  let out = "";
  let err = "";
  caller.stdout.on("data", (chunk) => (out += chunk));
  caller.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise<number | null>((done) => caller.once("exit", (code) => done(code)));
  await new Promise<void>((done) => caller.stdout.on("data", () => out.includes("inside") && done()));
  // Kill the native holder (cat, under lockf), not the Node caller.
  const lockf = await childOf(caller.pid!, "lockf");
  const cat = await childOf(lockf, "cat");
  process.kill(cat, "SIGKILL");
  await withLock(batch, () => {
    const state = loadState(batch);
    (state as unknown as { marker: string }).marker = "B";
    saveState(batch, state);
  }, lockOpts);
  const code = await exited;
  await new Promise((r) => setTimeout(r, 3500)); // past the moment the first caller would have written
  assert.equal(code, HOLDER_LOST_EXIT);
  assert.match(err, /^eval runner: lost the lock on .*runner\.lock \(holder exited .*\); stopping at once without saving$/m);
  assert.equal(out.trim(), "inside", "no protected write and no return after the loss");
  const state = loadState(batch) as unknown as { marker: string; revision: number };
  assert.equal(state.marker, "B");
  assert.equal(state.revision, 2);
});

test("a normal release never looks like a lost holder", async () => {
  const batch = join(dir, "normal-release");
  mkdirSync(batch, { recursive: true });
  const result = await node(`import { withLock } from ${JSON.stringify(lockModule)};
for (let i = 0; i < 20; i++) await withLock(${JSON.stringify(batch)}, async () => { await new Promise((r) => setTimeout(r, 5)); }, { waitMs: 1000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() });
console.log("done");`);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "done");
  assert.equal(result.stderr, "");
});

test("a save from a stale revision writes nothing", () => {
  const batch = join(dir, "cas");
  mkdirSync(batch, { recursive: true });
  saveState(batch, fakeState("initial"));
  const stale = loadState(batch);
  const fresh = loadState(batch);
  (fresh as unknown as { marker: string }).marker = "fresh";
  saveState(batch, fresh);
  (stale as unknown as { marker: string }).marker = "stale";
  assert.throws(() => saveState(batch, stale), StaleStateError);
  const latest = loadState(batch) as unknown as { marker: string; revision: number };
  assert.equal(latest.marker, "fresh");
  assert.equal(latest.revision, 2);
  assert.equal(JSON.parse(readFileSync(join(batch, "state.json"), "utf8")).marker, "fresh", "the mirror wasn't touched");
  assert.deepEqual(readdirSync(join(batch, "state")).sort(), ["000000001.json", "000000002.json"], "no third revision and no temp file");
});

test("a save from a revision far older than the kept history still writes nothing", () => {
  const batch = join(dir, "cas-old");
  mkdirSync(batch, { recursive: true });
  saveState(batch, fakeState("initial"));
  const stale = loadState(batch);
  for (let i = 0; i < 30; i++) {
    const state = loadState(batch);
    (state as unknown as { marker: string }).marker = `fresh-${i}`;
    saveState(batch, state);
  }
  (stale as unknown as { marker: string }).marker = "stale";
  assert.throws(() => saveState(batch, stale), StaleStateError);
  const latest = loadState(batch) as unknown as { marker: string; revision: number };
  assert.equal(latest.marker, "fresh-29");
  assert.equal(latest.revision, 31);
  assert.equal(readFileSync(join(batch, "state", "000000002.json"), "utf8"), "", "the old revision was emptied, not replaced");
  assert.equal(JSON.parse(readFileSync(join(batch, "state.json"), "utf8")).marker, "fresh-29", "the mirror wasn't touched");
});

test("two processes saving from the same revision at once: exactly one save lands", async () => {
  const batch = join(dir, "cas-race");
  mkdirSync(batch, { recursive: true });
  saveState(batch, fakeState("initial"));
  const start = Date.now() + 1500;
  const results = await Promise.all(
    ["x", "y", "z"].map((marker) =>
      node(`import { loadState, saveState } from ${JSON.stringify(stateModule)};
const state = loadState(${JSON.stringify(batch)});
while (Date.now() < ${start}) {}
state.marker = ${JSON.stringify(marker)};
try { saveState(${JSON.stringify(batch)}, state); console.log("saved"); } catch (error) { console.log(error.constructor.name); }`),
    ),
  );
  assert.deepEqual(results.map((r) => r.stdout.trim()).sort(), ["StaleStateError", "StaleStateError", "saved"]);
  assert.equal(loadState(batch).revision, 2);
});
