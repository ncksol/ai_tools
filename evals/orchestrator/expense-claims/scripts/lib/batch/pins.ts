// Pins the inputs a batch must not change mid-way: the agent files under test and the agents they
// name (their workers), resolved through symlinks, the kit's kickoff and answer sheet, and the app
// and CLI versions.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Pins } from "./state.ts";

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

export function readAppVersion(plistPath: string): string | null {
  try {
    const text = readFileSync(plistPath, "utf8");
    const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function readCliVersion(path: string): string | null {
  try {
    const match = /COPILOT_CLI_VERSION\s*=\s*"([^"]+)"/.exec(readFileSync(path, "utf8"));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const AGENT_SUFFIX = ".agent.md";

function agentPath(agentsDir: string, name: string): string {
  if (!/^(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Invalid agent ID: ${name}`);
  return join(agentsDir, `${name.slice(name.indexOf(":") + 1)}${AGENT_SUFFIX}`);
}

export function installedAgents(agentsDir: string): string[] {
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((name) => name.endsWith(AGENT_SUFFIX))
    .map((name) => name.slice(0, -AGENT_SUFFIX.length));
}

// Plugin IDs keep their namespace in pins, but their files have bare names inside agentsDir.
export function agentsToPin(agentsDir: string, variants: string[], explicit = false): { names: string[]; missing: string[] } {
  const installed = installedAgents(agentsDir);
  const names = new Set<string>();
  const missing = new Set<string>();
  const visit = (agent: string): void => {
    if (names.has(agent) || missing.has(agent)) return;
    const path = agentPath(agentsDir, agent);
    if (!existsSync(path)) {
      missing.add(agent);
      return;
    }
    names.add(agent);
    if (explicit) return;
    const text = readFileSync(path, "utf8");
    const namespace = agent.includes(":") ? agent.slice(0, agent.indexOf(":") + 1) : "";
    for (const other of installed) {
      const id = `${namespace}${other}`;
      if (new RegExp(`(?<![\\w:-])${id}(?![\\w:-])`).test(text)) visit(id);
    }
    for (const match of text.matchAll(/(?<![\w:-])(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*-worker(?![\w:-])/g)) {
      const worker = match[0];
      if (namespace ? worker.startsWith(namespace) : !worker.includes(":")) visit(worker);
    }
  };
  variants.forEach(visit);
  return { names: [...names].sort(), missing: [...missing].sort() };
}

export function computePins(opts: { agentsDir: string; variants: string[]; explicitAgents?: boolean; files: Record<string, string>; appPlist: string; cliVersionFile: string }): Pins {
  const agents: Pins["agents"] = {};
  const { names } = agentsToPin(opts.agentsDir, opts.variants, opts.explicitAgents);
  for (const name of names) {
    const path = realpathSync(agentPath(opts.agentsDir, name));
    agents[name] = { path, sha256: sha256(path) };
  }
  const files: Pins["files"] = {};
  for (const [label, path] of Object.entries(opts.files)) files[label] = existsSync(path) ? sha256(path) : "missing";
  return { agents, files, appVersion: readAppVersion(opts.appPlist), cliVersion: readCliVersion(opts.cliVersionFile) };
}

export function diffPins(before: Pins, now: Pins): string[] {
  const changes: string[] = [];
  for (const name of new Set([...Object.keys(before.agents), ...Object.keys(now.agents)])) {
    const a = before.agents[name];
    const b = now.agents[name];
    if (!a) changes.push(`agent ${name} is new`);
    else if (!b) changes.push(`agent ${name} is gone`);
    else if (a.path !== b.path) changes.push(`agent ${name} now resolves to ${b.path} (was ${a.path})`);
    else if (a.sha256 !== b.sha256) changes.push(`agent ${name} changed (${a.path})`);
  }
  for (const label of new Set([...Object.keys(before.files), ...Object.keys(now.files)])) {
    if (before.files[label] !== now.files[label]) changes.push(`${label} changed`);
  }
  if (before.appVersion !== now.appVersion) changes.push(`app version ${before.appVersion ?? "unknown"} -> ${now.appVersion ?? "unknown"}`);
  if (before.cliVersion !== now.cliVersion) changes.push(`CLI version ${before.cliVersion ?? "unknown"} -> ${now.cliVersion ?? "unknown"}`);
  return changes;
}
