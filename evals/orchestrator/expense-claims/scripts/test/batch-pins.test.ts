import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentBundleSha256, agentsToPin, computePins, diffPins, readAgentRevision } from "../lib/batch/pins.ts";

let dir: string;
let agentsDir: string;
let checkout: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "orch-eval-pins-"));
  agentsDir = join(dir, "agents");
  checkout = join(dir, "checkout");
  mkdirSync(agentsDir);
  mkdirSync(checkout);
  writeFileSync(join(checkout, "wintermute-core.agent.md"), "Children run as wintermute-peon.\n");
  writeFileSync(join(checkout, "wintermute-peon.agent.md"), "peon v1\n");
  writeFileSync(join(checkout, "variant-b.agent.md"), "Starts variant-b-worker sub-agents.\n");
  writeFileSync(join(checkout, "variant-b-worker.agent.md"), "worker v1\n");
  writeFileSync(join(checkout, "andrej.agent.md"), "unrelated\n");
  for (const name of ["wintermute-core", "wintermute-peon", "variant-b", "variant-b-worker", "andrej"]) {
    symlinkSync(join(checkout, `${name}.agent.md`), join(agentsDir, `${name}.agent.md`));
  }
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key>\n\t<string>1.1.30</string>\n");
  writeFileSync(join(dir, "cli.d.ts"), 'export declare const COPILOT_CLI_VERSION = "1.0.99-2";\n');
  writeFileSync(join(dir, "kickoff.md"), "kickoff\n");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const pins = () =>
  computePins({ agentsDir, variants: ["wintermute-core", "variant-b"], files: { "kickoff.md": join(dir, "kickoff.md") }, appPlist: join(dir, "Info.plist"), cliVersionFile: join(dir, "cli.d.ts") });

test("the variants and the workers they name are pinned through their symlinks", () => {
  assert.deepEqual(agentsToPin(agentsDir, ["wintermute-core", "variant-b"]).names, ["variant-b", "variant-b-worker", "wintermute-core", "wintermute-peon"]);
  assert.deepEqual(agentsToPin(agentsDir, ["missing"]).missing, ["missing"]);
  const pinned = pins();
  assert.equal(pinned.agents["wintermute-peon"].path, realpathSync(join(checkout, "wintermute-peon.agent.md")));
  assert.equal(pinned.appVersion, "1.1.30");
  assert.equal(pinned.cliVersion, "1.0.99-2");
  assert.deepEqual(diffPins(pinned, pins()), []);
});

test("any change to a pinned agent, its link, the kit files or the versions is drift", () => {
  const before = pins();
  writeFileSync(join(checkout, "wintermute-peon.agent.md"), "peon v2\n");
  assert.deepEqual(diffPins(before, pins()), [`agent wintermute-peon changed (${before.agents["wintermute-peon"].path})`]);

  const second = pins();
  writeFileSync(join(dir, "elsewhere.agent.md"), "elsewhere\n");
  unlinkSync(join(agentsDir, "variant-b-worker.agent.md"));
  symlinkSync(join(dir, "elsewhere.agent.md"), join(agentsDir, "variant-b-worker.agent.md"));
  assert.match(diffPins(second, pins())[0], /^agent variant-b-worker now resolves to /);

  const third = pins();
  writeFileSync(join(dir, "kickoff.md"), "changed\n");
  writeFileSync(join(dir, "Info.plist"), "<key>CFBundleShortVersionString</key><string>1.1.31</string>");
  assert.deepEqual(diffPins(third, pins()), ["kickoff.md changed", "app version 1.1.30 -> 1.1.31"]);
});

test("plugin IDs resolve to bare filenames and pin prefixed workers and their dependencies", () => {
  const plugin = join(dir, "plugin");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "wintermute-core.agent.md"), 'Use kickoff.agent: "wintermute:wintermute-peon". Not other:helper-worker.\n');
  writeFileSync(join(plugin, "wintermute-peon.agent.md"), 'Use wintermute:helper-worker.\n');
  writeFileSync(join(plugin, "helper-worker.agent.md"), "worker\n");
  const options = { agentsDir: plugin, variants: ["wintermute:wintermute-core"], files: {}, appPlist: "", cliVersionFile: "" };
  assert.deepEqual(agentsToPin(plugin, options.variants), {
    names: ["wintermute:helper-worker", "wintermute:wintermute-core", "wintermute:wintermute-peon"], missing: [],
  });
  const before = computePins(options);
  assert.equal(before.agents["wintermute:wintermute-peon"].path, realpathSync(join(plugin, "wintermute-peon.agent.md")));
  writeFileSync(join(plugin, "wintermute-peon.agent.md"), 'Changed; use wintermute:helper-worker.\n');
  assert.match(diffPins(before, computePins(options)).join("; "), /agent wintermute:wintermute-peon changed/);
  unlinkSync(join(plugin, "helper-worker.agent.md"));
  assert.deepEqual(agentsToPin(plugin, options.variants).missing, ["wintermute:helper-worker"]);
  assert.ok(diffPins(before, computePins(options)).includes("agent wintermute:helper-worker is gone"));
  unlinkSync(join(plugin, "wintermute-peon.agent.md"));
  assert.deepEqual(agentsToPin(plugin, options.variants).missing, ["wintermute:wintermute-peon"]);
});

test("names in a different plugin namespace do not pin a local worker", () => {
  const plugin = join(dir, "isolated-plugin");
  mkdirSync(plugin);
  writeFileSync(join(plugin, "wintermute-core.agent.md"), "Do not use other:wintermute-peon or other:helper-worker.\n");
  writeFileSync(join(plugin, "wintermute-peon.agent.md"), "unrelated\n");
  writeFileSync(join(plugin, "helper-worker.agent.md"), "unrelated\n");
  assert.deepEqual(agentsToPin(plugin, ["wintermute:wintermute-core"]), { names: ["wintermute:wintermute-core"], missing: [] });
});

test("agentBundleSha256 hashes sorted [name, sha256] pairs and readAgentRevision resolves clean git checkouts", () => {
  const p = pins();
  assert.equal(p.agentRevision, null);
  const bundle = agentBundleSha256(p.agents);
  assert.match(bundle, /^[a-f0-9]{64}$/);
  const reversed = Object.fromEntries(Object.entries(p.agents).reverse());
  assert.equal(agentBundleSha256(reversed), bundle);

  const repo = join(dir, "git-plugin");
  const repoAgents = join(repo, "ghcp", "plugins", "wintermute", "com.github.copilot", "agents");
  mkdirSync(repoAgents, { recursive: true });
  mkdirSync(join(repo, ".github", "plugin"), { recursive: true });
  writeFileSync(
    join(repo, ".github", "plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: "wintermute", source: "./ghcp/plugins/wintermute" }] }),
  );
  writeFileSync(join(repoAgents, "wintermute-core.agent.md"), "Uses wintermute:wintermute-peon.\n");
  writeFileSync(join(repoAgents, "wintermute-peon.agent.md"), "peon\n");
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) {
    assert.equal(spawnSync("git", args, { cwd: repo }).status, 0);
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();

  const directPins = computePins({ agentsDir: repoAgents, variants: ["wintermute:wintermute-core"], files: {}, appPlist: "", cliVersionFile: "" });
  assert.equal(directPins.agentRevision, head);

  const copilotHome = join(dir, "copilot-home");
  const installed = join(copilotHome, "installed-plugins", "ai-tools", "wintermute", "com.github.copilot", "agents");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "wintermute-core.agent.md"), "Uses wintermute:wintermute-peon.\n");
  writeFileSync(join(installed, "wintermute-peon.agent.md"), "peon\n");
  writeFileSync(
    join(copilotHome, "settings.json"),
    JSON.stringify({ extraKnownMarketplaces: { "ai-tools": { source: { source: "directory", path: repo } } } }),
  );
  const installedPins = computePins({ agentsDir: installed, variants: ["wintermute:wintermute-core"], files: {}, appPlist: "", cliVersionFile: "" });
  assert.equal(installedPins.agentRevision, head);

  writeFileSync(join(repoAgents, "wintermute-peon.agent.md"), "dirty peon\n");
  assert.equal(readAgentRevision(repoAgents, directPins.agents), null);
  assert.equal(readAgentRevision(installed, installedPins.agents), null);
});

