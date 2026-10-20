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
