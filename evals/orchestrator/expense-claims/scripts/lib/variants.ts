import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LIVE_VARIANTS = ["orchestrator", "session-orchestrator", "hands-on-orchestrator", "hands-on-session-orchestrator"];

export function variantLabel(agent: string): string {
  const bare = agent.replace(/^wintermute:/, "");
  return LIVE_VARIANTS.includes(bare) ? bare : agent;
}

export function liveAgent(variant: string): string {
  return LIVE_VARIANTS.includes(variant) ? `wintermute:${variant}` : variant;
}

export interface AgentFile {
  file: string;
  sha256: string;
}

export interface VariantDefinition extends AgentFile {
  agent: string;
  revision: string;
  workers: Record<string, AgentFile>;
}

export interface VariantSet {
  id: "review-policy";
  calibration: "all-variants-then-drop-summary";
  path: string;
  variants: Record<string, VariantDefinition>;
}

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const name = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]*$/.test(v);

export function readVariants(path: string): VariantSet {
  path = resolve(path);
  const data = object(JSON.parse(readFileSync(path, "utf8")));
  const entries = object(data?.variants);
  const sharedWorkers = object(data?.workers);
  if (!data || data.id !== "review-policy" || data.calibration !== "all-variants-then-drop-summary" ||
      !entries || Object.keys(entries).length !== 3 || !sharedWorkers) throw new Error(`Invalid A/B/C variant manifest ${path}`);
  const file = (value: Record<string, unknown>, label: string): AgentFile => {
    if (typeof value.file !== "string" || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      throw new Error(`Invalid file/hash for ${label}`);
    }
    const absolute = resolve(dirname(path), value.file);
    if (!existsSync(absolute) || sha(readFileSync(absolute)) !== value.sha256) throw new Error(`${label} snapshot missing or hash mismatch: ${absolute}`);
    return { file: absolute, sha256: value.sha256 };
  };
  const variants: VariantSet["variants"] = {};
  const workers: VariantDefinition["workers"] = {};
  for (const [worker, entry] of Object.entries(sharedWorkers)) {
    const workerFile = object(entry);
    if (!name(worker) || !workerFile) throw new Error(`Invalid shared worker ${worker}`);
    workers[worker] = file(workerFile, worker);
  }
  const aliases = new Set<string>();
  for (const [label, value] of Object.entries(entries)) {
    const variant = object(value);
    if (!name(label) || !variant || !name(variant.agent) || label !== variant.agent || ["orchestrator", "session-orchestrator"].includes(variant.agent) ||
        typeof variant.revision !== "string" || !/^[a-f0-9]{40}$/.test(variant.revision) || aliases.has(variant.agent)) {
      throw new Error(`Invalid variant ${label} in manifest ${path}`);
    }
    aliases.add(variant.agent);
    const source = file(variant, label);
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(source.file, "utf8"))?.[1];
    if (!frontmatter || !frontmatter.split(/\r?\n/).includes(`name: ${variant.agent}`)) throw new Error(`Variant ${label} has the wrong agent name`);
    variants[label] = { ...source, agent: variant.agent, revision: variant.revision, workers };
  }
  return { id: "review-policy", calibration: "all-variants-then-drop-summary", path, variants };
}

export function variantBundle(variant: VariantDefinition): string {
  return sha(JSON.stringify([[variant.agent, variant.sha256], ...Object.entries(variant.workers).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [name, entry.sha256])]));
}

export function verifyVariants(set: VariantSet, agentsDir: string): string[] {
  const problems: string[] = [];
  for (const variant of Object.values(set.variants)) {
    for (const [name, entry] of [[variant.agent, variant] as const, ...Object.entries(variant.workers)]) {
      const path = join(agentsDir, `${name}.agent.md`);
      if (!existsSync(path)) problems.push(`${name} is missing at ${path}; the user must register the eval aliases`);
      else if (sha(readFileSync(path)) !== entry.sha256) problems.push(`${name} installed hash differs from the pinned snapshot`);
    }
  }
  return [...new Set(problems)];
}

export function variantAgents(set: VariantSet): string[] {
  return [...new Set(Object.values(set.variants).flatMap((variant) => [variant.agent, ...Object.keys(variant.workers)]))];
}

export function variantFiles(set: VariantSet): Record<string, string> {
  const files: Record<string, string> = { "variant manifest": set.path };
  for (const [label, variant] of Object.entries(set.variants)) {
    files[`variant ${label}`] = variant.file;
    for (const [name, worker] of Object.entries(variant.workers)) files[`variant ${label} worker ${name}`] = worker.file;
  }
  return files;
}
