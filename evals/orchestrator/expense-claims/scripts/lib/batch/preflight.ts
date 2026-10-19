// Checks before a batch starts, and the one-time manual steps only the user can do.
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProcResult } from "../proc.ts";
import { readNtfyUrl } from "./notify.ts";
import { agentsToPin, readAppVersion, readCliVersion } from "./pins.ts";
import type { BatchConfig } from "./state.ts";

export interface Check {
  name: string;
  status: "PASS" | "FAIL" | "WARN" | "SKIP";
  detail: string;
}

export interface Host {
  exec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ProcResult>;
  nodeVersion: string;
}

// The app version on which detached top-level runs and answer_session_input were observed.
export const MIN_APP_VERSION = "1.1.30";
const MIN_CORE_REMAINING = 2000;
const MIN_GRAPHQL_REMAINING = 1000;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// score must take --end-at and --answer-source (the score fixes); the runner relies on both.
export function scoreSupportsRunner(scoreScript: string): boolean {
  try {
    const text = readFileSync(scoreScript, "utf8");
    return text.includes('"end-at"') && text.includes('"answer-source"');
  } catch {
    return false;
  }
}

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

export async function runPreflight(config: BatchConfig, host: Host): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });
  const live = !config.dryRun;

  const major = Number(host.nodeVersion.replace(/^v/, "").split(".")[0]);
  add("Node 24 or later", major >= 24 ? "PASS" : "FAIL", `node ${host.nodeVersion}`);

  if (live) {
    const batt = await host.exec("pmset", ["-g", "batt"]);
    const onAc = batt.code === 0 && /AC Power/.test(batt.stdout);
    add("AC power", onAc ? "PASS" : "FAIL", onAc ? "drawing from AC power" : `not on AC power (${(batt.stdout.split("\n")[0] || batt.stderr).trim()})`);
  } else add("AC power", "SKIP", "dry run");

  const diskDir = nearestExisting(config.runsDir);
  const df = await host.exec("df", ["-k", diskDir]);
  const avail = df.code === 0 ? Number(df.stdout.trim().split("\n").pop()?.trim().split(/\s+/)[3]) : NaN;
  const freeGiB = avail / 1024 / 1024;
  add(
    "free disk space",
    Number.isFinite(freeGiB) && freeGiB >= config.minFreeGiB ? "PASS" : "FAIL",
    Number.isFinite(freeGiB) ? `${freeGiB.toFixed(0)} GiB free at ${diskDir} (need ${config.minFreeGiB})` : `df failed: ${df.stderr.trim()}`,
  );

  try {
    accessSync(diskDir, constants.W_OK);
    add("runs folder writable", "PASS", diskDir);
  } catch {
    add("runs folder writable", "FAIL", `${diskDir} is not writable`);
  }

  if (live) {
    const who = await host.exec("gh", ["api", "user", "--jq", ".login"]);
    const login = who.stdout.trim();
    add("gh account", who.code === 0 && login.toLowerCase() === config.owner.toLowerCase() ? "PASS" : "FAIL", who.code === 0 ? `active account ${login}, owner ${config.owner}` : `gh api user failed: ${who.stderr.trim()}`);

    const head = await host.exec("gh", ["api", "-i", "user"]);
    const scopeLine = head.stdout.split("\n").find((line) => /^x-oauth-scopes:/i.test(line));
    if (!scopeLine) {
      add("gh token scopes", "WARN", "no X-OAuth-Scopes header (a fine-grained token?); make sure it can create private repos and push workflow files");
    } else {
      const scopes = scopeLine.replace(/^x-oauth-scopes:/i, "").split(",").map((scope) => scope.trim());
      const missing = ["repo", "workflow"].filter((scope) => !scopes.includes(scope));
      add("gh token scopes", missing.length === 0 ? "PASS" : "FAIL", missing.length === 0 ? `has repo and workflow` : `missing ${missing.join(", ")}`);
    }

    const limits = await host.exec("gh", ["api", "rate_limit", "--jq", "[.resources.core.remaining, .resources.graphql.remaining] | @tsv"]);
    const [core, graphql] = limits.stdout.trim().split(/\s+/).map(Number);
    add(
      "GitHub API rate limits",
      limits.code === 0 && core >= MIN_CORE_REMAINING && graphql >= MIN_GRAPHQL_REMAINING ? "PASS" : "FAIL",
      limits.code === 0 ? `core ${core} left (need ${MIN_CORE_REMAINING}), graphql ${graphql} left (need ${MIN_GRAPHQL_REMAINING})` : `gh api rate_limit failed: ${limits.stderr.trim()}`,
    );

    const app = readAppVersion(config.appPlist);
    add("Copilot app version", app && compareVersions(app, MIN_APP_VERSION) >= 0 ? "PASS" : "FAIL", app ? `${app} (need ${MIN_APP_VERSION} or later)` : `cannot read ${config.appPlist}`);
    const cli = readCliVersion(config.cliVersionFile);
    add("app's Copilot CLI version", cli ? "PASS" : "WARN", cli ?? `cannot read ${config.cliVersionFile}`);
  } else {
    for (const name of ["gh account", "gh token scopes", "GitHub API rate limits", "Copilot app version"]) add(name, "SKIP", "dry run");
  }

  add(
    "score supports the runner",
    scoreSupportsRunner(config.scoreScript) ? "PASS" : "FAIL",
    scoreSupportsRunner(config.scoreScript) ? "score takes --end-at and --answer-source" : `${config.scoreScript} lacks --end-at or --answer-source; merge the score fixes first`,
  );

  if (!config.selfTest.only) {
    const { names, missing } = agentsToPin(config.agentsDir, config.variants);
    add("agents under test installed", missing.length === 0 ? "PASS" : "FAIL", missing.length === 0 ? `pinned: ${names.join(", ")}` : `not in ${config.agentsDir}: ${missing.join(", ")}`);
  }

  add(
    "Copilot Memory is off",
    config.memoryOffConfirmed ? "PASS" : "FAIL",
    config.memoryOffConfirmed ? "confirmed by you (the self-test also checks that no memories load)" : "turn it off at https://github.com/settings/copilot/features, then confirm",
  );

  const kitRepo = dirname(config.resultsPath);
  const branch = (await host.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: kitRepo })).stdout.trim();
  add("results branch", branch && !["main", "master", "HEAD"].includes(branch) ? "PASS" : "FAIL", branch ? `on ${branch}; results.csv commits go here, never to main` : "not a git checkout");
  const dirty = await host.exec("git", ["status", "--porcelain", "--", config.resultsPath], { cwd: kitRepo });
  add("results.csv committed", dirty.code === 0 && dirty.stdout.trim() === "" ? "PASS" : "FAIL", dirty.stdout.trim() === "" ? "no uncommitted changes" : "commit or discard the changes to results.csv first");
  const name = (await host.exec("git", ["config", "user.name"], { cwd: kitRepo })).stdout.trim();
  const email = (await host.exec("git", ["config", "user.email"], { cwd: kitRepo })).stdout.trim();
  add("git identity", name && email ? "PASS" : "FAIL", name && email ? `${name} <${email}>` : "set git user.name and user.email");

  if (config.keepAwake) add("caffeinate", existsSync("/usr/bin/caffeinate") ? "PASS" : "FAIL", "/usr/bin/caffeinate");
  add("app database readable", existsSync(config.appDb) ? "PASS" : "WARN", existsSync(config.appDb) ? `${config.appDb} (read-only)` : `${config.appDb} not found; the self-test can't check auto-approve`);

  const url = readNtfyUrl({ envVar: config.notify.envVar, urlFile: config.notify.urlFile });
  add("notifications", url ? "PASS" : "WARN", url ? "ntfy topic configured" : `no ntfy topic in $${config.notify.envVar} or ${config.notify.urlFile}; no phone notifications`);
  return checks;
}

export const MANUAL_STEPS = [
  "Turn Copilot Memory off at https://github.com/settings/copilot/features (Copilot Memory: Disabled). Turn it back on in the morning.",
  "Keep the laptop on AC power with the lid open. Don't log out, restart or close the Copilot app.",
  "Defer macOS updates for tonight (System Settings > General > Software Update > Automatic Updates) and don't install app updates.",
  "Leave nothing else heavy running, and don't use this account's Copilot for other work while the batch runs.",
  "Check that your phone gets ntfy notifications with the screen locked (npm run batch -- notify-test).",
];

export function formatChecks(checks: Check[]): string {
  return checks.map((check) => `${check.status.padEnd(4)} ${check.name}: ${check.detail}`).join("\n");
}
