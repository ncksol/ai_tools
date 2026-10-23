// Manual, fail-closed cleanup. state.json (via loadState) authorizes runs; discovery is saved only
// by --yes, before the user removes app projects and their database links disappear.
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
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
  workspacesForPath(path: string): string[];
  sessionExists(id: string): boolean;
  sessionRunning(id: string): boolean;
}
export interface CleanupDeps {
  home: string;
  app: CleanupApp;
  now(): string;
  results(config: BatchConfig, state: BatchState, run: RunState): Promise<string | null>;
  authorize(owner: string): Promise<void>;
  repo(repo: string, seed: string): Promise<{ id: number; seedPresent: boolean } | null>;
  deleteRepo(repo: string, id: number, seed: string): Promise<void>;
  exec: typeof run;
  fs?: typeof fs;
}
export interface CleanupItem {
  kind: "batch" | "run" | "token" | "results" | "app-project" | "app-session" | "archive" | "session-state" | "worktree" | "worktree-parent" | "clone" | "kickoff" | "repo";
  target: string;
  status: "present" | "already gone" | "blocked" | "removed" | "archived";
  reason?: string;
  checklist?: boolean;
  action?: boolean;
}
export interface CleanupReport { batch: string; dryRun: boolean; items: CleanupItem[] }
interface JournalEntry {
  at: string;
  action: "inventory" | "archived" | "removed" | "removing" | "lost" | "dropped";
  identity: string;
  inventory?: CleanupInventory;
  kind?: CleanupItem["kind"];
  target?: string;
  source?: string;
  sha256?: string;
}
// The current gh login got a 404: the repo may be gone or just invisible to that login.
export class RepoNotVisible extends Error {
  constructor() { super("repo not found or not visible; absence requires the verified owner's keyring identity with repo scope"); }
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
  config: BatchConfig, state: BatchState, options: { yes?: boolean; force?: boolean; dropped?: string[] }, deps: CleanupDeps,
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
    for (const name of options.dropped ?? []) {
      const run = runs.find(run => run.name === name);
      if (!run) throw new Error(`unknown --dropped run: ${name}`);
      if (!run.row && !run.scoredAt) throw new Error(`--dropped run has no recorded result: ${name}`);
    }
  } catch (error) {
    add("batch", config.dir, "blocked", errorText(error));
    return report;
  }
  const resultHash = (run: RunState) => sha256(JSON.stringify(run.row ?? null));
  const confirmedDrop = (run: RunState) => entries.some(e => e.action === "dropped" &&
    e.identity === runIdentity(run) && e.target === run.name && e.sha256 === resultHash(run));
  const resultBlocks = new Map<string, string>();
  for (const run of runs) {
    if (confirmedDrop(run) || options.dropped?.includes(run.name)) continue;
    let reason: string | null;
    try { reason = await deps.results(config, state, run); }
    catch (error) { reason = errorText(error); }
    if (reason) resultBlocks.set(run.name, reason);
  }
  let globalBlock: string | null = null;
  if (options.yes && runs.some(run => !resultBlocks.has(run.name))) {
    try { await deps.authorize(config.owner); }
    catch (error) { globalBlock = errorText(error); add("token", config.owner, "blocked", globalBlock); }
  }

  for (const run of runs) {
    const identity = runIdentity(run);
    const seed = run.preparedSha ?? run.seedSha;
    try {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(run.variant) || !Number.isSafeInteger(run.n) || run.n < 1 ||
          run.name !== `orch-eval-${run.variant}-${run.n}` || run.repo !== `${config.owner}/${run.name}` ||
          run.repoDir !== join(root, run.name)) throw new Error("recorded owner, run name or clone identity does not match");
      if (!seed || !/^[a-f0-9]{40}$/.test(seed)) throw new Error("missing recorded seed identity; never infer it from the current repo");
    } catch (error) {
      add("run", run.name, "blocked", `cannot be verified; nothing touched: ${errorText(error)}`);
      continue;
    }
    const receipt = (kind: CleanupItem["kind"], target: string, action = "removed") =>
      entries.some(e => e.identity === identity && e.kind === kind && e.target === target && e.action === action);
    const repoRemovedEarlier = !options.yes && receipt("repo", run.repo);
    const archiveRecord = (source: string, dest: string, name: string) => entries.findLast(e =>
      e.action === "archived" && e.identity === identity &&
      (e.source === join(source, name) || (!e.source && e.target === join(dest, `${name}.gz`))));
    let blocked = globalBlock ?? resultBlocks.get(run.name) ?? null;
    if (resultBlocks.has(run.name)) add("results", run.name, "blocked", resultBlocks.get(run.name));
    let remote: { id: number; seedPresent: boolean } | null = null;
    let repoNotVisible = false;
    let inventory: CleanupInventory = { projects: [], worktrees: [], sessions: [], workspaces: [] };
    let discovered = false;
    const saved = entries.filter(e => e.identity === identity && e.action === "inventory").flatMap(e => e.inventory ? [e.inventory] : []);
    try {
      if (options.dropped?.includes(run.name) || confirmedDrop(run)) {
        if (options.yes && !blocked && !confirmedDrop(run)) {
          append({ action: "dropped", identity, kind: "results", target: run.name, sha256: resultHash(run) });
        }
        add("results", run.name, "present", `${confirmedDrop(run) ? "Recorded" : "Preview"} deliberate result drop; results.csv is not edited`);
      }
      if (!repoRemovedEarlier) {
        try {
          remote = await deps.repo(run.repo, seed);
          if (remote && !remote.seedPresent) throw new Error("repo history does not contain the recorded seed");
        } catch (error) {
          // A dry run reads GitHub with the ambient gh login, so its 404 proves nothing either way;
          // --yes rechecks with the owner's verified login.
          if (error instanceof RepoNotVisible && !options.yes) repoNotVisible = true;
          else blocked ??= errorText(error);
        }
      }
      const live = deps.app.inventory(run);
      if (run.projectId && live.projects.length === 0 && saved.length === 0) {
        add("archive", run.name, "already gone", "LOST app discovery: project was removed before inventory was saved; unknown child logs cannot be rediscovered; worktrees are found only through the clone's Git registry. Cleaning only known items.");
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
    const unpackedHash = (path: string): string | null => {
      try { return sha256(gunzipSync(io.readFileSync(path))); } catch { return null; }
    };
    // Never overwrite an existing archive file, even one that does not verify: reuse the name that
    // already holds these logs, otherwise take the first free name.
    const archiveSlot = (dest: string, name: string, hash: string): string => {
      const names = [join(dest, `${name}.gz`), join(dest, `${name}.${hash}.gz`)];
      for (const path of names) {
        const type = pathKind(path, io);
        if (type === "missing" || (type === "file" && unpackedHash(path) === hash)) return path;
      }
      throw new Error(`${names.join(" and ")} already exist and neither holds the current ${name}; cleanup never overwrites an archive. Keep them and the session originals, inspect these files by hand, and keep the project until the logs are archived`);
    };
    // A dry run counts present logs as archived only when a journaled archive of their current
    // content still decompresses to the recorded hash. Otherwise it says what --yes will write.
    const currentArchive = (source: string, dest: string, names: string[]): { verified: boolean; notes: string[] } => {
      const notes: string[] = [];
      let verified = true;
      for (const name of names) {
        const input = join(source, name);
        const type = pathKind(input, io);
        if (type === "missing") continue;
        if (type !== "file") throw new Error(`not a regular log file: ${input}`);
        const hash = sha256(io.readFileSync(input));
        const records = entries.filter(e => e.action === "archived" && e.identity === identity &&
          (e.source === input || (!e.source && e.target === join(dest, `${name}.gz`))));
        if (records.some(e => e.sha256 === hash && e.target && beneath(dest, e.target) &&
            pathKind(e.target, io) === "file" && unpackedHash(e.target) === hash)) continue;
        verified = false;
        const slot = archiveSlot(dest, name, hash);
        const target = records.findLast(e => e.sha256 === hash)?.target;
        if (target) {
          notes.push(beneath(dest, target) && pathKind(target, io) === "file"
            ? `recorded archive ${target} of ${name} does not verify; it is kept unchanged. --yes writes a new verified archive at ${slot}`
            : `recorded archive ${target} of ${name} is missing. --yes archives the current log again at ${slot}`);
        } else if (records.length) {
          notes.push(`archive of ${name} is out of date: the log changed after --yes archived it. Run --yes again to write a new verified archive at ${slot}`);
        }
      }
      return { verified, notes };
    };
    // Archive before app removal destroys histories. Missing originals and backups are reported
    // as lost; an existing but unverified backup blocks deletion.
    const archiveGate = blocked;
    const archives: { item: CleanupItem; source: string; dest: string; names: string[] }[] = [];
    for (const id of inventory.sessions) {
      const source = join(sessionRoot, id);
      const dest = join(config.dir, "sessions", run.name, id);
      const archive = add("archive", source, "present", `Preserve compressed logs in ${dest}`);
      const logs = { item: archive, source, dest, names: ["events.jsonl", "workspace.yaml"] };
      archives.push(logs);
      try {
        if (!safeId(id)) throw new Error("invalid session identity");
        if (archiveGate) throw new Error(archiveGate);
        const sourceKind = pathKind(source, io);
        pathKind(dest, io);
        const eventPath = join(source, "events.jsonl");
        if (pathKind(eventPath, io) === "missing") {
          const recorded = archiveRecord(source, dest, "events.jsonl");
          const copy = recorded?.target ?? join(dest, "events.jsonl.gz");
          if (!beneath(dest, copy)) throw new Error("archive path is outside its session folder");
          if (sourceKind === "missing" && pathKind(copy, io) === "missing") {
            archive.status = "already gone";
            archive.reason = "LOST: session logs are gone and no archive exists; cannot recover them. Continuing known-item cleanup.";
            if (options.yes) append({ action: "lost", identity, kind: "archive", target: source });
            continue;
          }
          if (!recorded || pathKind(copy, io) !== "file" || sha256(gunzipSync(io.readFileSync(copy))) !== recorded.sha256) throw new Error("session event log is missing and no verified archive exists");
          // The verified event archive covers only the missing events.jsonl; other logs still present need their own.
          logs.names = ["workspace.yaml"];
        }
        if (options.yes) {
          io.mkdirSync(dest, { recursive: true, mode: 0o700 });
          // workspace.yaml is useful provenance. session.db is a live SQLite database; copying its
          // main file without its WAL is not a reliable backup, and events.jsonl is the raw evidence.
          for (const name of logs.names) {
            const input = join(source, name);
            if (pathKind(input, io) === "missing") continue;
            if (pathKind(input, io) !== "file") throw new Error(`not a regular log file: ${input}`);
            const data = io.readFileSync(input);
            const hash = sha256(data);
            const output = archiveSlot(dest, name, hash);
            if (pathKind(output, io) === "missing") {
              const temporary = join(dest, `.${name}.${randomUUID()}.tmp`);
              try {
                io.writeFileSync(temporary, gzipSync(data), { mode: 0o600, flag: "wx" });
                if (sha256(gunzipSync(io.readFileSync(temporary))) !== hash) throw new Error("archive verification failed");
                io.renameSync(temporary, output);
              } finally {
                io.rmSync(temporary, { force: true });
              }
            }
            if (pathKind(output, io) !== "file" || sha256(gunzipSync(io.readFileSync(output))) !== hash) throw new Error("archive verification failed");
            append({ action: "archived", identity, kind: "archive", source: input, target: output, sha256: hash });
          }
          archive.status = "archived";
        } else {
          const current = currentArchive(source, dest, logs.names);
          if (current.verified) {
            archive.status = "archived";
            archive.reason = `Verified archive of the current logs in ${dest}`;
          } else if (current.notes.length) {
            archive.reason = `Archive not current: ${current.notes.join("; ")}`;
          }
        }
      } catch (error) { archive.status = "blocked"; archive.reason = errorText(error); blocked ??= archive.reason; }
    }
    // A dry run may give the remove instruction only when an earlier --yes saved everything the
    // app knows now; removing the project erases those links.
    const savedWorktrees = new Set(saved.flatMap(s => s.worktrees));
    const savedSessions = new Set(saved.flatMap(s => s.sessions));
    const discoverySaved = options.yes || (saved.length > 0 &&
      inventory.worktrees.every(path => savedWorktrees.has(path)) && inventory.sessions.every(id => savedSessions.has(id)));
    const archiveBlocked = blocked;
    const sessionLive = (id: string): boolean => {
      if (!safeId(id)) throw new Error("invalid session identity");
      if (deps.app.sessionRunning(id)) return true;
      const source = join(sessionRoot, id);
      return pathKind(source, io) === "directory" && io.readdirSync(source).some(name => {
        const pid = /^inuse\.(\d+)\.lock$/.exec(name)?.[1];
        return pid !== undefined && pidAlive(Number(pid));
      });
    };
    // Decided last, after every other check of this run: a project may be removed only when no run
    // session is running and the final look at its logs still matches the verified archives.
    const projectInstruction = () => {
      if (!projectItems.length || archiveBlocked || !archives.every(a => a.item.status === "archived" || a.item.status === "already gone")) return;
      if (!discoverySaved) {
        if (saved.length) projectItems.forEach((item, i) => { item.reason =
          `KEEP project ${inventory.projects[i].name} (${inventory.projects[i].path}): the app now lists worktrees or sessions that --yes has not saved; run --yes again before removing it.`; });
        return;
      }
      try {
        const running = inventory.sessions.filter(sessionLive);
        const changed = archives.filter(a => a.item.status === "archived" && !currentArchive(a.source, a.dest, a.names).verified);
        for (const a of changed) {
          a.item.status = "present";
          a.item.reason = `Logs changed during this check; run --yes again to archive them in ${a.dest}`;
        }
        for (let i = 0; i < projectItems.length; i++) {
          const project = `project ${inventory.projects[i].name} (${inventory.projects[i].path})`;
          projectItems[i].action = !running.length && !changed.length;
          projectItems[i].reason = running.length
            ? `KEEP ${project}: session ${running.join(", ")} is still running. Stop it, then run --yes again to archive its latest logs before you remove the project.`
            : changed.length
              ? `KEEP ${project}: logs changed during this check. Run --yes again to archive them before you remove the project.`
              : `Available logs archived and verified; remove or retry removing ${project} in the app, then rerun cleanup. This removes its run/child/trust sessions too. This check cannot see later writes: if any of its sessions runs again before you remove the project, run --yes again first.`;
        }
      } catch { /* keep the KEEP line */ }
    };
    let appBlock: string | null = null;
    try {
      if (!discovered) throw new Error(blocked ?? "app inventory could not be read");
      const projects = deps.app.projectsForPath(run.repoDir);
      if (!options.force && (inventory.projects.length || projects.length)) appBlock = "app project still exists; follow its archive-first project checklist (--force overrides only project presence)";
      if (projects.some(id => id !== run.projectId)) throw new Error("another app project uses this clone; identity mismatch");
    } catch (error) { appBlock = errorText(error); }
    blocked ??= appBlock;

    const remove = async (kind: CleanupItem["kind"], target: string, check: () => Promise<"directory" | "file" | "missing">,
      extra: { reason?: string; del?: () => Promise<void> } = {}) => {
      const item = add(kind, target, "present", extra.reason);
      try {
        const type = await check();
        if (type === "missing") {
          item.status = "already gone";
          if (receipt(kind, target)) item.reason = "Removed earlier (matching cleanup receipt)";
          return item;
        }
        if (blocked) throw new Error(blocked);
        if (!options.yes) return item;
        if (!options.force && deps.app.projectsForPath(run.repoDir).length) throw new Error("app project reappeared; stop before deleting disk data");
        await check();
        append({ action: "removing", identity, kind, target });
        if (extra.del) await extra.del();
        else io.rmSync(target, { recursive: type === "directory" });
        append({ action: "removed", identity, kind, target });
        item.status = "removed";
      } catch (error) { item.status = "blocked"; item.reason = errorText(error); blocked ??= item.reason; }
      return item;
    };
    for (const id of inventory.sessions) await remove("session-state", join(sessionRoot, id), async () => {
      if (!safeId(id)) throw new Error("invalid session identity");
      const source = join(sessionRoot, id);
      const type = pathKind(source, io);
      if (type !== "missing") {
        if (type !== "directory") throw new Error("session state is not a folder");
        if (sessionLive(id)) throw new Error("session is still running");
        if (deps.app.sessionExists(id)) throw new Error("app still records this session; keep originals (archiving a session does not delete it)");
        if (options.yes && !blocked) {
          for (const name of ["events.jsonl", "workspace.yaml"]) {
            const input = join(source, name);
            if (pathKind(input, io) === "missing" && name !== "events.jsonl") continue;
            const dest = join(config.dir, "sessions", run.name, id);
            const recorded = archiveRecord(source, dest, name);
            const copy = recorded?.target ?? join(dest, `${name}.gz`);
            if (!beneath(dest, copy)) throw new Error("archive path is outside its session folder");
            if (pathKind(input, io) !== "file" || pathKind(copy, io) !== "file" || !recorded ||
                sha256(io.readFileSync(input)) !== recorded.sha256 || sha256(gunzipSync(io.readFileSync(copy))) !== recorded.sha256) {
              throw new Error("session log changed after archival or archive is not verified");
            }
          }
        }
      }
      return type;
    });
    const cloneFolder = async (): Promise<"directory" | "missing"> => {
      const path = run.repoDir;
      if (path !== join(root, run.name)) throw new Error("folder is outside this run's allowed root");
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
    // Read the clone's Git registry before touching any worktree, so every linked worktree, recorded
    // by the app or not, goes through the same checks. The app can leave worktrees registered in the
    // clone with no app record; deleting the clone would strand them.
    const runWorktrees = join(worktreeRoot, run.name);
    const admins = join(run.repoDir, ".git", "worktrees");
    const byHand = "inspect it and remove it by hand, then rerun cleanup";
    const readRegistry = async (): Promise<Map<string, boolean>> => {
      const linked = new Map<string, boolean>();
      if (pathKind(run.repoDir, io) !== "directory") return linked;
      const listed = await deps.exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: run.repoDir, timeoutMs: 60_000 });
      if (listed.code) throw new Error("git worktree list failed");
      const records = listed.stdout.split("\0\0").map(record => record.split("\0").filter(Boolean)).filter(record => record.length);
      const paths = records.map(record => record[0].startsWith("worktree ") ? record[0].slice("worktree ".length) : "");
      if (paths[0] !== run.repoDir) throw new Error("the clone is not its own main Git worktree");
      for (let i = 1; i < records.length; i++) {
        if (!paths[i]) throw new Error("unexpected git worktree list output");
        linked.set(paths[i], records[i].some(field => field === "locked" || field.startsWith("locked ")));
      }
      return linked;
    };
    let registry = new Map<string, boolean>();
    try { registry = await readRegistry(); }
    catch (error) { blocked ??= `cannot check the clone's linked worktrees: ${errorText(error)}`; }
    const worktreeCheck = async (path: string): Promise<"directory" | "missing"> => {
      const name = `${inventory.worktrees.includes(path) ? "recorded" : "linked"} worktree ${path}`;
      if (!beneath(runWorktrees, path)) throw new Error(`${name} is outside ${runWorktrees}; ${byHand}`);
      const type = pathKind(path, io);
      if (type === "missing") return type;
      if (type !== "directory") throw new Error(`${name} is not a real folder; ${byHand}`);
      const projects = deps.app.projectsForPath(path);
      if (projects.some(id => id !== run.projectId)) throw new Error(`another app project references ${name}; identity mismatch`);
      if (deps.app.workspacesForPath(path).length) throw new Error(`an app workspace still references ${name}; ${byHand}`);
      const dotGit = join(path, ".git");
      const pointer = pathKind(dotGit, io) === "file" ? /^gitdir: ([^\r\n]+)\r?\n?$/.exec(io.readFileSync(dotGit, "utf8"))?.[1] : undefined;
      const gitdir = pointer ? resolve(path, pointer) : "";
      if (!gitdir || !beneath(admins, gitdir)) throw new Error(`${name} does not point into ${admins}; ${byHand}`);
      if (registry.has(path)) {
        if (projects.length && !options.force) throw new Error(`app project still references ${name}`);
        if (pathKind(gitdir, io) !== "directory") throw new Error(`${name} points to a missing Git admin folder ${gitdir}; ${byHand}`);
        if (registry.get(path)) throw new Error(`${name} is locked; ${byHand}`);
      } else {
        // The narrow dangling exception: a saved worktree whose admin folder in this clone is gone.
        if (projects.length) throw new Error(`the app still references ${name}; ${byHand}`);
        if (!saved.some(s => s.worktrees.includes(path)) || pathKind(gitdir, io) !== "missing") throw new Error(`${name} is not a linked worktree of the clone; ${byHand}`);
      }
      if (await cloneFolder() !== "directory") throw new Error(`the clone is gone, so ${name} cannot be verified; ${byHand}`);
      return type;
    };
    const worktreeItems: CleanupItem[] = [];
    const unrecorded = [...registry.keys()].filter(path => !inventory.worktrees.includes(path) && pathKind(path, io) !== "missing");
    for (const path of [...inventory.worktrees, ...unrecorded]) {
      const registered = registry.has(path);
      worktreeItems.push(await remove("worktree", path, () => worktreeCheck(path), registered ? {
        reason: inventory.worktrees.includes(path) ? undefined : "Linked worktree of the clone with no app record; --yes removes it through git before the clone",
        del: async () => {
          const removed = await deps.exec("git", ["worktree", "remove", "--force", path], { cwd: run.repoDir, timeoutMs: 60_000 });
          if (removed.code || pathKind(path, io) !== "missing") throw new Error(`git could not remove linked worktree ${path}; ${byHand}`);
        },
      } : {}));
    }
    // Remove the run's app worktree folder only once nothing is left in it; never sweep contents.
    if (!blocked) {
      try {
        const type = pathKind(runWorktrees, io);
        if (type === "file") throw new Error(`${runWorktrees} is not a folder`);
        if (type === "directory") {
          const pending = new Set(worktreeItems.filter(item => item.status === "present").map(item => item.target));
          const left = io.readdirSync(runWorktrees).filter(name => !pending.has(join(runWorktrees, name)));
          if (left.length) {
            add("worktree-parent", runWorktrees, "present",
              `Kept: not empty after this run's worktrees were removed (contains ${left.slice(0, 3).join(", ")}${left.length > 3 ? ", ..." : ""}); inspect it, delete it by hand if you don't need it, then rerun cleanup`).checklist = true;
          } else if (!options.yes) {
            add("worktree-parent", runWorktrees, "present", pending.size && io.readdirSync(runWorktrees).length
              ? "Empty once this run's worktrees are removed; --yes removes this folder (not recursive)"
              : "Empty; --yes removes this folder (not recursive)");
          } else {
            append({ action: "removing", identity, kind: "worktree-parent", target: runWorktrees });
            io.rmdirSync(runWorktrees);
            append({ action: "removed", identity, kind: "worktree-parent", target: runWorktrees });
            add("worktree-parent", runWorktrees, "removed");
          }
        }
      } catch (error) { add("worktree-parent", runWorktrees, "blocked", errorText(error)); }
    }
    // Read the registry again right before the clone goes: a worktree added since must not be stranded.
    const cloneItem = await remove("clone", run.repoDir, async () => {
      const type = await cloneFolder();
      if (type === "directory") {
        const pending = new Set(worktreeItems.filter(item => item.status === "present").map(item => item.target));
        let now: Map<string, boolean>;
        try { now = await readRegistry(); }
        catch (error) { throw new Error(`cannot check the clone's linked worktrees: ${errorText(error)}`); }
        const left = [...now.keys()].filter(path => !(report.dryRun && pending.has(path)) && pathKind(path, io) !== "missing");
        if (left.length) throw new Error(`linked worktree ${left.join(", ")} still exists; the clone is kept so it is not stranded; ${byHand}`);
      }
      return type;
    });
    await remove("kickoff", `${run.repoDir}.kickoff.md`, async () => {
      if (run.repoDir !== join(root, run.name) || !/^orch-eval-[a-z0-9-]+-\d+$/.test(run.name)) throw new Error("invalid kickoff identity");
      const type = pathKind(`${run.repoDir}.kickoff.md`, io);
      if (type !== "file" && type !== "missing") throw new Error("kickoff is not a regular file");
      // The repo/seed check above and exact generated path bind this file to the recorded run.
      // In a dry run, a clone that --yes will remove first gives the same receipt.
      if (!remote && !receipt("clone", run.repoDir) && !(report.dryRun && cloneItem.status === "present") && type !== "missing") {
        throw new Error("cannot establish kickoff identity without repo or clone removal receipt");
      }
      return type;
    });
    const repoItem = add("repo", run.repo, remote || repoNotVisible ? "present" : "already gone",
      repoRemovedEarlier ? "Removed earlier (matching cleanup receipt; remote not rechecked in this dry run)"
        : repoNotVisible ? "Not visible to the current gh login; --yes rechecks with the owner's login, then deletes the repo or reports it gone" : undefined);
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
    projectInstruction();
  }
  // Self-test projects are permanent (old batches also kept them inside the retained batch folder).
  // They are never disk/repo targets. Only their exact recorded sessions need a manual archive.
  for (const test of state.selftests) {
    if (!test.appSessionId && !test.sessionId) continue;
    const target = test.appSessionId ?? test.sessionId!;
    try {
      const workspace = deps.app.inventory(test).workspaces.find(workspace =>
        test.appSessionId ? workspace.id === test.appSessionId : workspace.sessionId === test.sessionId);
      if (!workspace || workspace.archived) continue;
      add("app-session", target, "present",
        `Archive this self-test session in the app; KEEP project ${test.projectId ?? "(not recorded)"} at ${test.repoDir}`).checklist = true;
    } catch (error) {
      add("app-session", target, "blocked", `Cannot check self-test session: ${errorText(error)}`).checklist = true;
    }
  }
  return report;
}

export function formatCleanup(report: CleanupReport): string {
  const steps: string[] = [];
  const blocks = new Map<string, number>();
  for (const item of report.items) {
    if (item.kind === "app-project" || item.checklist || item.kind === "run" || item.reason?.startsWith("LOST")) {
      steps.push(`- ${item.target}: ${item.reason}`);
    } else if (item.status === "blocked") {
      const reason = item.reason ?? "blocked";
      blocks.set(reason, (blocks.get(reason) ?? 0) + 1);
    }
  }
  for (const [reason, count] of blocks) steps.push(`- ${reason} (${count} item${count === 1 ? "" : "s"}; see inventory above).`);
  // Manual and LOST steps never hide archives or removals that --yes can still do.
  if (report.dryRun && report.items.some(item => item.status === "present" && !item.checklist &&
      item.kind !== "results" && item.kind !== "app-session")) steps.push("- Review the inventory, then rerun this batch with --yes when ready.");
  if (!steps.length) steps.push("- No cleanup actions remain.");
  return [
    `${report.dryRun ? "DRY RUN" : "CLEANUP"} batch ${report.batch}`,
    ...(report.dryRun ? ["Read-only: no archive, journal, app change or deletion. --yes archives evidence before deletion; run it before removing app projects."] : []),
    ...report.items.filter(item => item.kind !== "run" && (report.dryRun || (item.kind !== "app-session" && item.kind !== "app-project")))
      .map(item => `${report.dryRun && item.action ? "ACTION" : item.status.toUpperCase()} ${item.kind} ${item.target}${item.reason ? `: ${item.reason}` : ""}`),
    "Kept: results.csv and its commits, batch folder, self-test projects, active-batch guard.",
    "Deleting a run repo prevents scoring it again. --force bypasses only the app-project-presence check.",
    "", "Next steps:", ...steps,
  ].join("\n");
}
