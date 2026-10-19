import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentsToPin, computePins, diffPins } from "../lib/batch/pins.ts";

let dir: string;
let agentsDir: string;
let checkout: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-pins-"));
  agentsDir = join(dir, "agents");
  checkout = join(dir, "checkout");
  mkdirSync(agentsDir);
  mkdirSync(checkout);
  writeFileSync(join(checkout, "orchestrator.agent.md"), "Starts orchestrator-worker sub-agents.\n");
  writeFileSync(join(checkout, "orchestrator-worker.agent.md"), "worker v1\n");
  writeFileSync(join(checkout, "session-orchestrator.agent.md"), "Children run as session-worker.\n");
  writeFileSync(join(checkout, "session-worker.agent.md"), "session worker v1\n");
  writeFileSync(join(checkout, "andrej.agent.md"), "unrelated\n");
  for (const name of ["orchestrator", "orchestrator-worker", "session-orchestrator", "session-worker", "andrej"]) {
    symlinkSync(join(checkout, `${name}.agent.md`), join(agentsDir, `${name}.agent.md`));
  }
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key>\n\t<string>1.1.30</string>\n");
  writeFileSync(join(dir, "cli.d.ts"), 'export declare const COPILOT_CLI_VERSION = "1.0.99-2";\n');
  writeFileSync(join(dir, "kickoff.md"), "kickoff\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const pins = () =>
  computePins({ agentsDir, variants: ["orchestrator", "session-orchestrator"], files: { "kickoff.md": join(dir, "kickoff.md") }, appPlist: join(dir, "Info.plist"), cliVersionFile: join(dir, "cli.d.ts") });

test("the variants and the workers they name are pinned through their symlinks", () => {
  assert.deepEqual(agentsToPin(agentsDir, ["orchestrator", "session-orchestrator"]).names, ["orchestrator", "orchestrator-worker", "session-orchestrator", "session-worker"]);
  assert.deepEqual(agentsToPin(agentsDir, ["missing"]).missing, ["missing"]);
  const pinned = pins();
  assert.equal(pinned.agents["session-worker"].path, realpathSync(join(checkout, "session-worker.agent.md")));
  assert.equal(pinned.appVersion, "1.1.30");
  assert.equal(pinned.cliVersion, "1.0.99-2");
  assert.deepEqual(diffPins(pinned, pins()), []);
});

test("any change to a pinned agent, its link, the kit files or the versions is drift", () => {
  const before = pins();
  writeFileSync(join(checkout, "session-worker.agent.md"), "session worker v2\n");
  assert.deepEqual(diffPins(before, pins()), [`agent session-worker changed (${before.agents["session-worker"].path})`]);

  const second = pins();
  writeFileSync(join(dir, "other-worker.agent.md"), "elsewhere\n");
  unlinkSync(join(agentsDir, "orchestrator-worker.agent.md"));
  symlinkSync(join(dir, "other-worker.agent.md"), join(agentsDir, "orchestrator-worker.agent.md"));
  assert.match(diffPins(second, pins())[0], /^agent orchestrator-worker now resolves to /);

  const third = pins();
  writeFileSync(join(dir, "kickoff.md"), "changed\n");
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.1.31</string>");
  assert.deepEqual(diffPins(third, pins()), ["kickoff.md changed", "app version 1.1.30 -> 1.1.31"]);
});
