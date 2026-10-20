import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("terminating a timeout supervisor also stops its detached process group", { timeout: 15_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "orch-proc-"));
  const pidFile = join(scratch, "child.pid");
  const procUrl = new URL("../lib/proc.ts", import.meta.url).href;
  const childCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const wrapper = spawn(process.execPath, ["--input-type=module", "-e",
    `import { run } from ${JSON.stringify(procUrl)}; await run(process.execPath, ["-e", ${JSON.stringify(childCode)}], { timeoutMs: 60_000 });`,
  ], { stdio: "ignore" });
  const ended = once(wrapper, "exit");
  let pid: number | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    assert.ok(existsSync(pidFile), "child did not start");
    pid = Number(readFileSync(pidFile, "utf8"));
    wrapper.kill("SIGTERM");
    await ended;
    for (let n = 0; n < 40; n++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((done) => setTimeout(done, 25));
    }
    assert.throws(() => process.kill(pid!, 0), { code: "ESRCH" });
  } finally {
    if (pid !== undefined) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    await ended;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("terminating nested supervisors stops the grandchild and runs the middle process exit cleanup", { timeout: 15_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "orch-proc-nested-"));
  const leafPid = join(scratch, "leaf.pid");
  const middlePid = join(scratch, "middle.pid");
  const cleaned = join(scratch, "cleaned");
  const procUrl = new URL("../lib/proc.ts", import.meta.url).href;
  const leaf = `require("node:fs").writeFileSync(${JSON.stringify(leafPid)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  const middle = `import { run } from ${JSON.stringify(procUrl)}; import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(middlePid)}, String(process.pid));
    process.once("exit", () => writeFileSync(${JSON.stringify(cleaned)}, ""));
    await run(process.execPath, ["-e", ${JSON.stringify(leaf)}], { timeoutMs: 60_000, shutdownGraceMs: 1000 });`;
  const wrapper = spawn(process.execPath, ["--input-type=module", "-e",
    `import { run } from ${JSON.stringify(procUrl)}; await run(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(middle)}], { timeoutMs: 60_000 });`,
  ], { stdio: "ignore" });
  const ended = once(wrapper, "exit");
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(leafPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    assert.ok(existsSync(leafPid), "grandchild did not start");
    wrapper.kill("SIGTERM");
    await ended;
    for (const path of [middlePid, leafPid]) {
      const pid = Number(readFileSync(path, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `${path} is still running`);
    }
    assert.ok(existsSync(cleaned), "middle supervisor must be allowed to run its exit cleanup");
  } finally {
    for (const path of [leafPid, middlePid]) {
      if (!existsSync(path)) continue;
      try { process.kill(-Number(readFileSync(path, "utf8")), "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL");
    await ended;
    rmSync(scratch, { recursive: true, force: true });
  }
});
