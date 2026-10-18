import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ALL_FEATURES, stripFeatures, type Feature } from "./features.ts";
import { run, type ProcResult } from "./proc.ts";
import { KIT_DIR } from "./suite.ts";

export const RUN_NAME_PATTERN = /^orch-eval-(.+)-(\d+)$/;
const SKIP = new Set(["node_modules", ".DS_Store"]);

export interface NewRunOptions {
  variant: string;
  n?: number;
  features: Feature[];
  owner: string;
  runsDir: string;
  dryRun: boolean;
}

export interface NewRunDeps {
  gh: (args: string[]) => Promise<ProcResult>;
  log: (line: string) => void;
}

export interface NewRunResult {
  name: string;
  repoDir: string;
  kickoffPath: string;
  files: string[];
}

export function runName(variant: string, n: number): string {
  return `orch-eval-${variant}-${n}`;
}

export function parseRunName(name: string): { variant: string; n: number } | null {
  const match = RUN_NAME_PATTERN.exec(name);
  return match ? { variant: match[1], n: Number(match[2]) } : null;
}

export function nextRunNumber(runsDir: string, variant: string): number {
  if (!existsSync(runsDir)) return 1;
  let max = 0;
  for (const entry of readdirSync(runsDir)) {
    const parsed = parseRunName(entry);
    if (parsed && parsed.variant === variant) max = Math.max(max, parsed.n);
  }
  return max + 1;
}

export function listSeedFiles(seedDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(seedDir, path));
    }
  };
  walk(seedDir);
  return files.sort();
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const result = await run("git", args, { cwd: repoDir });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function newRun(opts: NewRunOptions, deps: NewRunDeps): Promise<NewRunResult> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.variant)) throw new Error(`Variant "${opts.variant}" must be lowercase letters, digits and hyphens`);
  if (opts.n !== undefined && !(Number.isSafeInteger(opts.n) && opts.n > 0)) {
    throw new Error(`Run number "${opts.n}" must be a positive integer`);
  }
  const n = opts.n ?? nextRunNumber(opts.runsDir, opts.variant);
  const name = runName(opts.variant, n);
  const slug = `${opts.owner}/${name}`;
  const repoDir = join(opts.runsDir, name);
  const kickoffPath = join(opts.runsDir, `${name}.kickoff.md`);
  if (existsSync(repoDir)) throw new Error(`${repoDir} already exists`);

  if (opts.dryRun) {
    deps.log(`Dry run: skipping the gh account check and repo creation for ${slug}`);
  } else {
    const who = await deps.gh(["api", "user", "--jq", ".login"]);
    const login = who.stdout.trim();
    if (who.code !== 0 || login.toLowerCase() !== opts.owner.toLowerCase()) {
      throw new Error(`The active gh account is "${login || "unknown"}", not "${opts.owner}". Switch with gh auth switch, or check GH_TOKEN.`);
    }
    const view = await deps.gh(["repo", "view", slug, "--json", "name"]);
    if (view.code === 0) throw new Error(`${slug} already exists on GitHub`);
  }

  const seedDir = join(KIT_DIR, "seed");
  mkdirSync(opts.runsDir, { recursive: true });
  try {
    mkdirSync(repoDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${repoDir} already exists`);
    throw error;
  }
  cpSync(seedDir, repoDir, { recursive: true, filter: (src) => !SKIP.has(src.split(/[\\/]/).pop() ?? "") });
  if (opts.features.length !== ALL_FEATURES.length) {
    const specPath = join(repoDir, "docs", "spec-v2.md");
    writeFileSync(specPath, stripFeatures(readFileSync(specPath, "utf8"), opts.features));
  }
  await git(repoDir, ["init", "-q", "-b", "main"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "Seed v1"]);

  const files = (await git(repoDir, ["ls-files"])).split("\n").filter(Boolean).sort();
  const expected = listSeedFiles(seedDir);
  if (files.join("\n") !== expected.join("\n")) {
    throw new Error(`The run repo's files differ from the seed's:\n${files.join("\n")}`);
  }

  writeFileSync(kickoffPath, stripFeatures(readFileSync(join(KIT_DIR, "kickoff.md"), "utf8"), opts.features));

  if (opts.dryRun) {
    deps.log(`Dry run: would run gh repo create ${slug} --private --source ${repoDir} --remote origin --push`);
  } else {
    const created = await deps.gh(["repo", "create", slug, "--private", "--source", repoDir, "--remote", "origin", "--push"]);
    if (created.code !== 0) throw new Error(`gh repo create failed: ${created.stderr.trim()}`);
  }
  return { name, repoDir, kickoffPath, files };
}
