// Manual, fail-closed cleanup. state.json (via loadState) authorizes runs; discovery is saved only
// by --yes, before the user removes app projects and their database links disappear.
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { pidAlive, readGuard } from "./lock.ts";
import type { BatchConfig, BatchState, RunState } from "./state.ts";
import type { run } from "../proc.ts";

export interface CleanupInventory {
  projects: { id: string; path: string; name: string }[];
  worktrees: string[];
  sessions: string[];
  workspaces: { id: string; sessionId: string | null; archived: boolean }[];
}
export interface CleanupApp {
  inventory(run: Pick<RunState, "projectId" | "appSessionId" | "sessionId">): CleanupInventory;
  projectsForPath(path: string): string[];
  sessionExists(id: string): boolean;
  sessionRunning(id: string): boolean;
}
export interface CleanupDeps {
  home: string;
  app: CleanupApp;
  now(): string;
  results(config: BatchConfig, state: BatchState): Promise<string | null>;
  authorize(owner: string): Promise<void>;
  repo(repo: string, seed: string): Promise<{ id: number; seedPresent: boolean } | null>;
  deleteRepo(repo: string, id: number, seed: string): Promise<void>;
  exec: typeof run;
  fs?: typeof fs;
}
export interface CleanupItem {
  kind: "batch" | "token" | "results" | "app-project" | "app-session" | "archive" | "session-state" | "worktree" | "clone" | "kickoff" | "repo";
  target: string;
  status: "present" | "already gone" | "blocked" | "removed" | "archived";
  reason?: string;
  checklist?: boolean;
}
export interface CleanupReport { batch: string; dryRun: boolean; items: CleanupItem[] }
interface JournalEntry {
  at: string;
  action: "inventory" | "archived" | "removed" | "removing" | "lost";
  identity: string;
  inventory?: CleanupInventory;
  kind?: CleanupItem["kind"];
  target?: string;
  sha256?: string;
}
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const safeId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value);
const beneath = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// Reject symlinks in every existing component, including ancestors of a missing target. Never
// follow a dangling link, and distinguish absence from permission/I/O failures.
export function pathKind(path: string, io: typeof fs = fs): "directory" | "file" | "missing" {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("path is not absolute and normalized");
  const parts = path.split(sep).filter(Boolean);
  let current = sep;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat: fs.Stats;
    try { stat = io.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${current}`);
    if (i !== parts.length - 1 && !stat.isDirectory()) throw new Error(`not a directory: ${current}`);
    if (i === parts.length - 1) {
      if (stat.isDirectory()) return "directory";
      if (stat.isFile()) return "file";
      throw new Error(`not a regular file or folder: ${current}`);
    }
  }
  throw new Error("filesystem root is not a cleanup target");
}

export function githubSlug(origin: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(origin.trim());
  return match?.[1] ?? null;
}

function runIdentity(run: RunState): string {
  return sha256(JSON.stringify([run.repo, run.repoDir, run.projectId ?? null, run.preparedSha ?? run.seedSha ?? null]));
}

function recordedRuns(state: BatchState): RunState[] {
  const runs = new Map<string, RunState>();
  for (const run of [...(state.provisioned ?? []), ...state.runs]) {
    const previous = runs.get(run.repo);
    if (previous && ["name", "repoDir", "projectId", "seedSha"].some(key =>
      previous[key as keyof RunState] !== run[key as keyof RunState])) {
      throw new Error(`conflicting recorded identities for ${run.repo}`);
    }
    runs.set(run.repo, run);
  }
  return [...runs.values()];
}

export async function cleanupBatch(
  config: BatchConfig, state: BatchState, options: { yes?: boolean; force?: boolean }, deps: CleanupDeps,
): Promise<CleanupReport> {
  const io = deps.fs ?? fs;
  const report: CleanupReport = { batch: config.id, dryRun: !options.yes, items: [] };
  const add = (kind: CleanupItem["kind"], target: string, status: CleanupItem["status"], reason?: string) => {
    const item: CleanupItem = { kind, target, status, ...(reason ? { reason } : {}) };
    report.items.push(item);
    return item;
  };
  const errorText = (error: unknown) => error instanceof Error ? error.message : "cleanup check failed";
  const root = join(deps.home, "orch-evals");
  const worktreeRoot = join(deps.home, "_src_", "copilot-worktrees");
  const sessionRoot = join(deps.home, ".copilot", "session-state");
  const journal = join(config.dir, "cleanup.jsonl");
  let entries: JournalEntry[] = [];
  const append = (entry: Omit<JournalEntry, "at">) => {
    if (!options.yes) throw new Error("cleanup write attempted in dry run");
    pathKind(journal, io);
    const record = { at: deps.now(), ...entry };
    io.appendFileSync(journal, JSON.stringify(record) + "\n", { mode: 0o600 });
    entries.push(record);
  };
  let runs: RunState[];
  try {
    if (!["done", "stopped"].includes(state.phase) || !state.finishedAt || state.active.length || state.pending) throw new Error("batch has not finished (or still has an active/pending action)");
    if (!safeId(config.id) || !/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(config.owner)) throw new Error("invalid batch or owner identity");
    if (config.dryRun) throw new Error("rehearsal batches are not real cleanup targets");
    if (config.runsDir !== root || config.stateDir !== sessionRoot || config.appDb !== join(deps.home, ".copilot", "data.db") ||
        config.activeGuard !== join(root, "active-batch")) throw new Error("configured paths differ from the allowed home roots");
    if (config.dir !== join(root, "batches", config.id)) throw new Error("batch folder is not the recorded batch under ~/orch-evals/batches");
    pathKind(config.dir, io);
    pathKind(config.activeGuard, io);
    const active = readGuard(config.activeGuard).active;
    if (active) throw new Error(`active-batch guard still names ${active.id}; do not clean while a batch owns the machine`);
    if (pathKind(journal, io) === "file") entries = io.readFileSync(journal, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as JournalEntry);
    runs = recordedRuns(state);
  } catch (error) {
    add("batch", config.dir, "blocked", errorText(error));
    return report;
  }
  let globalBlock: string | null;
  try { globalBlock = await deps.results(config, state); }
  catch (error) { globalBlock = errorText(error); }
  if (globalBlock) add("results", "origin results.csv", "blocked", globalBlock);
  if (options.yes && !globalBlock) {
    try { await deps.authorize(config.owner); }
    catch (error) { globalBlock = errorText(error); add("token", config.owner, "blocked", globalBlock); }
  }

  for (const run of runs) {
    const identity = runIdentity(run);
    const seed = run.preparedSha ?? run.seedSha;
    const receipt = (kind: CleanupItem["kind"], target: string, action = "removed") =>
      entries.some(e => e.identity === identity && e.kind === kind && e.target === target && e.action === action);
    let blocked = globalBlock;
    let remote: { id: number; seedPresent: boolean } | null = null;
    let inventory: CleanupInventory = { projects: [], worktrees: [], sessions: [], workspaces: [] };
    let discovered = false;
    const saved = entries.filter(e => e.identity === identity && e.action === "inventory").flatMap(e => e.inventory ? [e.inventory] : []);
    try {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(run.variant) || !Number.isSafeInteger(run.n) || run.n < 1 ||
          run.name !== `orch-eval-${run.variant}-${run.n}` || run.repo !== `${config.owner}/${run.name}` ||
          run.repoDir !== join(root, run.name)) throw new Error("recorded owner, run name or clone identity does not match");
      if (!seed || !/^[a-f0-9]{40}$/.test(seed)) throw new Error("missing recorded seed identity; never infer it from the current repo");
      remote = await deps.repo(run.repo, seed);
      if (remote && !remote.seedPresent) throw new Error("repo history does not contain the recorded seed");
      const live = deps.app.inventory(run);
      if (run.projectId && live.projects.length === 0 && saved.length === 0) {
        add("archive", run.name, "already gone", "LOST app discovery: project was removed before inventory was saved; unknown child logs/worktrees cannot be rediscovered. Cleaning only known items.");
        if (options.yes && !blocked) append({ action: "lost", identity, kind: "archive", target: run.name });
      }
      for (const project of live.projects) {
        if (project.id !== run.projectId || project.path !== run.repoDir) throw new Error("app project identity/path mismatch");
      }
      inventory = {
        projects: live.projects,
        worktrees: [...new Set([...saved.flatMap(s => s.worktrees), ...live.worktrees])],
        sessions: [...new Set([...saved.flatMap(s => s.sessions), ...live.sessions, ...(run.sessionId ? [run.sessionId] : [])])],
        workspaces: live.workspaces,
      };
      discovered = true;
      if (options.yes && !blocked) append({ action: "inventory", identity, inventory });
    } catch (error) { blocked ??= errorText(error); }
    const projectItems = inventory.projects.map(project => add("app-project", project.id, "blocked",
      `KEEP project ${project.name} (${project.path}): do not remove it until --yes has archived and verified its logs. App removal deletes session histories.`));
    for (const workspace of inventory.workspaces) {
      add("app-session", workspace.id, "present", workspace.sessionId
        ? `Session ${workspace.sessionId}${workspace.archived ? " (archived)" : ""}; included in project removal, no separate action`
        : "Never started: no CLI session/log to copy; included in project removal");
    }
    // Archive all logs before even considering app-side or disk deletion. Missing logs for an
    // actual CLI session are a blocker unless a previous invocation preserved them.
    const archiveGate = blocked;
    for (const id of inventory.sessions) {
      const source = join(sessionRoot, id);
      const dest = join(config.dir, "sessions", run.name, id);
      const archive = add("archive", source, "present", `Preserve compressed logs in ${dest}`);
      try {
        if (!safeId(id)) throw new Error("invalid session identity");
        if (archiveGate) throw new Error(archiveGate);
        const sourceKind = pathKind(source, io);
        pathKind(dest, io);
        const eventPath = join(source, "events.jsonl");
        if (pathKind(eventPath, io) === "missing") {
          const copy = join(dest, "events.jsonl.gz");
          const recorded = entries.findLast(e => e.action === "archived" && e.identity === identity && e.target === copy);
          if (sourceKind === "missing" && pathKind(copy, io) === "missing") {
            archive.status = "already gone";
            archive.reason = "LOST: session logs are gone and no archive exists; cannot recover them. Continuing known-item cleanup.";
            if (options.yes) append({ action: "lost", identity, kind: "archive", target: source });
            continue;
          }
          if (!recorded || pathKind(copy, io) !== "file" || sha256(gunzipSync(io.readFileSync(copy))) !== recorded.sha256) throw new Error("session event log is missing and no verified archive exists");
          archive.status = "archived";
          continue;
        }
        if (options.yes) {
          io.mkdirSync(dest, { recursive: true, mode: 0o700 });
          // workspace.yaml is useful provenance. session.db is a live SQLite database; copying its
          // main file without its WAL is not a reliable backup, and events.jsonl is the raw evidence.
          for (const name of ["events.jsonl", "workspace.yaml"]) {
            const input = join(source, name);
            if (pathKind(input, io) === "missing") continue;
            if (pathKind(input, io) !== "file") throw new Error(`not a regular log file: ${input}`);
            const data = io.readFileSync(input);
            const output = join(dest, `${name}.gz`);
            pathKind(output, io);
            io.writeFileSync(output, gzipSync(data), { mode: 0o600 });
            if (sha256(gunzipSync(io.readFileSync(output))) !== sha256(data)) throw new Error("archive verification failed");
            append({ action: "archived", identity, kind: "archive", target: output, sha256: sha256(data) });
          }
          archive.status = "archived";
        }
      } catch (error) { archive.status = "blocked"; archive.reason = errorText(error); blocked ??= archive.reason; }
    }
    if (options.yes && !blocked) {
      for (let i = 0; i < projectItems.length; i++) {
        const project = inventory.projects[i];
        projectItems[i].reason = `Available logs archived and verified; remove or retry removing project ${project.name} (${project.path}) in the app, then rerun cleanup. This removes its run/child/trust sessions too.`;
      }
    }
    let appBlock: string | null = null;
    try {
      if (!discovered) throw new Error(blocked ?? "app inventory could not be read");
      const projects = deps.app.projectsForPath(run.repoDir);
      if (!options.force && (inventory.projects.length || projects.length)) appBlock = "app project still exists; remove it in the app first (--force overrides only project presence)";
      if (projects.some(id => id !== run.projectId)) throw new Error("another app project uses this clone; identity mismatch");
    } catch (error) { appBlock = errorText(error); }
    blocked ??= appBlock;

    const remove = async (kind: CleanupItem["kind"], target: string, check: () => Promise<"directory" | "file" | "missing">) => {
      const item = add(kind, target, "present");
      try {
        const type = await check();
        if (type === "missing") { item.status = "already gone"; return; }
        if (blocked) throw new Error(blocked);
        if (!options.yes) return;
        if (!options.force && deps.app.projectsForPath(run.repoDir).length) throw new Error("app project reappeared; stop before deleting disk data");
        await check();
        append({ action: "removing", identity, kind, target });
        io.rmSync(target, { recursive: type === "directory" });
        append({ action: "removed", identity, kind, target });
        item.status = "removed";
      } catch (error) { item.status = "blocked"; item.reason = errorText(error); blocked ??= item.reason; }
    };
    for (const id of inventory.sessions) await remove("session-state", join(sessionRoot, id), async () => {
      if (!safeId(id)) throw new Error("invalid session identity");
      const source = join(sessionRoot, id);
      const type = pathKind(source, io);
      if (type !== "missing") {
        if (type !== "directory") throw new Error("session state is not a folder");
        if (deps.app.sessionRunning(id) || io.readdirSync(source).some(name => {
          const pid = /^inuse\.(\d+)\.lock$/.exec(name)?.[1];
          return pid !== undefined && pidAlive(Number(pid));
        })) throw new Error("session is still running");
        if (deps.app.sessionExists(id)) throw new Error("app still records this session; keep originals (archiving a session does not delete it)");
        if (options.yes && !blocked) {
          for (const name of ["events.jsonl", "workspace.yaml"]) {
            const input = join(source, name);
            if (pathKind(input, io) === "missing" && name !== "events.jsonl") continue;
            const copy = join(config.dir, "sessions", run.name, id, `${name}.gz`);
            const recorded = entries.findLast(e => e.action === "archived" && e.identity === identity && e.target === copy);
            if (pathKind(input, io) !== "file" || pathKind(copy, io) !== "file" || !recorded ||
                sha256(io.readFileSync(input)) !== recorded.sha256 || sha256(gunzipSync(io.readFileSync(copy))) !== recorded.sha256) {
              throw new Error("session log changed after archival or archive is not verified");
            }
          }
        }
      }
      return type;
    });
    const gitFolder = async (path: string, worktree: boolean) => {
      if (worktree ? !beneath(join(worktreeRoot, run.name), path) : path !== join(root, run.name)) throw new Error("folder is outside this run's allowed root");
      const type = pathKind(path, io);
      if (type === "missing") return type;
      if (type !== "directory") throw new Error("not a real folder");
      const projects = deps.app.projectsForPath(path);
      if (projects.some(id => id !== run.projectId)) throw new Error("another app project references this folder; identity mismatch");
      if (projects.length && !options.force) throw new Error("app project still references this folder");
      const git = (args: string[]) => deps.exec("git", args, { cwd: path, timeoutMs: 60_000 });
      const top = await git(["rev-parse", "--show-toplevel"]);
      if (top.code || resolve(top.stdout.trim()) !== path) throw new Error("folder is not its own Git worktree");
      const origin = await git(["remote", "get-url", "origin"]);
      if (origin.code || githubSlug(origin.stdout) !== run.repo) throw new Error("folder origin does not match the recorded repo");
      if (!seed || !/^[a-f0-9]{40}$/.test(seed)) throw new Error("missing recorded seed identity");
      const history = await git(["merge-base", "--is-ancestor", seed, "HEAD"]);
      if (history.code) throw new Error("folder history does not contain the recorded seed");
      return type;
    };
    for (const path of inventory.worktrees) await remove("worktree", path, () => gitFolder(path, true));
    await remove("clone", run.repoDir, () => gitFolder(run.repoDir, false));
    await remove("kickoff", `${run.repoDir}.kickoff.md`, async () => {
      if (run.repoDir !== join(root, run.name) || !/^orch-eval-[a-z0-9-]+-\d+$/.test(run.name)) throw new Error("invalid kickoff identity");
      const type = pathKind(`${run.repoDir}.kickoff.md`, io);
      if (type !== "file" && type !== "missing") throw new Error("kickoff is not a regular file");
      // The repo/seed check above and exact generated path bind this file to the recorded run.
      if (!remote && !receipt("clone", run.repoDir) && type !== "missing") throw new Error("cannot establish kickoff identity without repo or clone removal receipt");
      return type;
    });
    const repoItem = add("repo", run.repo, remote ? "present" : "already gone");
    if (blocked) { repoItem.status = "blocked"; repoItem.reason = blocked; }
    else if (options.yes && remote) {
      try {
        if (!options.force && deps.app.projectsForPath(run.repoDir).length) throw new Error("app project reappeared");
        append({ action: "removing", identity, kind: "repo", target: run.repo });
        await deps.deleteRepo(run.repo, remote.id, seed!);
        append({ action: "removed", identity, kind: "repo", target: run.repo });
        repoItem.status = "removed";
      } catch (error) { repoItem.status = "blocked"; repoItem.reason = errorText(error); }
    }
  }
  // Self-test projects are permanent (old batches also kept them inside the retained batch folder).
  // They are never disk/repo targets. Only their exact recorded sessions need a manual archive.
  for (const test of state.selftests) {
    if (!test.appSessionId && !test.sessionId) continue;
    add("app-session", test.appSessionId ?? test.sessionId!, "present",
      `Archive this self-test session in the app; KEEP project ${test.projectId ?? "(not recorded)"} at ${test.repoDir}`).checklist = true;
  }
  return report;
}

export function formatCleanup(report: CleanupReport): string {
  return [
    `${report.dryRun ? "DRY RUN" : "CLEANUP"} batch ${report.batch}`,
    ...(report.dryRun ? ["Read-only: no archive, journal, app change or deletion. --yes archives evidence before deletion; run it before removing app projects."] : []),
    ...report.items.filter(item => report.dryRun || item.kind !== "app-session" || item.checklist)
      .map(item => `${item.status.toUpperCase()} ${item.kind} ${item.target}${item.reason ? `: ${item.reason}` : ""}`),
    "Kept: results.csv and its commits, batch folder, self-test projects, active-batch guard.",
    "Deleting a run repo prevents scoring it again. --force bypasses only the app-project-presence check.",
  ].join("\n");
}
