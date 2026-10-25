// Shared by post-score snapshots and manual cleanup. Receipts retain the original cleanup format.
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { BatchConfig, RunState } from "./state.ts";

export interface SessionInventory {
  projects: { id: string; path: string; name: string }[];
  worktrees: string[];
  sessions: string[];
  workspaces: { id: string; sessionId: string | null; archived: boolean; name?: string }[];
}
export interface ArchiveEntry {
  at: string;
  action: "inventory" | "archived";
  identity: string;
  inventory?: SessionInventory;
  kind?: "archive";
  target?: string;
  source?: string;
  sha256?: string;
}
type Receipt = Omit<ArchiveEntry, "action" | "kind"> & { action: string; kind?: string };
export type LogState = { status: "archived" | "lost"; notes?: undefined } | { status: "pending"; notes: string[] };
const LOG_NAMES = ["events.jsonl", "workspace.yaml"];
const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const safeId = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value);
export const beneath = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// Check ancestors too: a missing leaf under a symlink must never authorize a write or deletion.
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

export function runIdentity(run: RunState): string {
  return sha256(JSON.stringify([run.repo, run.repoDir, run.projectId ?? null, run.preparedSha ?? run.seedSha ?? null]));
}

export function sessionArchives(
  config: Pick<BatchConfig, "dir">, run: RunState, entries: Receipt[],
  append: (entry: Omit<ArchiveEntry, "at">) => void, io: typeof fs = fs,
) {
  const identity = runIdentity(run);
  const unpackedHash = (path: string): string | null => {
    try { return sha256(gunzipSync(io.readFileSync(path))); } catch { return null; }
  };
  const recordsFor = (source: string, dest: string, name: string) => entries.filter(e =>
    e.action === "archived" && e.identity === identity &&
    (e.source === join(source, name) || (!e.source && e.target === join(dest, `${name}.gz`))));
  // Never overwrite any archive, even a damaged one.
  const archiveSlot = (dest: string, name: string, hash: string): string => {
    const names = [join(dest, `${name}.gz`), join(dest, `${name}.${hash}.gz`)];
    for (const path of names) {
      const type = pathKind(path, io);
      if (type === "missing" || (type === "file" && unpackedHash(path) === hash)) return path;
    }
    throw new Error(`${names.join(" and ")} already exist and neither holds the current ${name}; cleanup never overwrites an archive. Keep them and the session originals, inspect these files by hand, and keep the project until the logs are archived`);
  };
  const logState = (source: string, dest: string): LogState => {
    const folder = pathKind(source, io);
    if (folder === "file") throw new Error("session state is not a folder");
    pathKind(dest, io);
    const notes: string[] = [];
    let pending = false;
    for (const name of LOG_NAMES) {
      const input = join(source, name);
      const type = folder === "missing" ? "missing" : pathKind(input, io);
      const records = recordsFor(source, dest, name);
      if (type === "missing") {
        if (name !== "events.jsonl" && records.length === 0) continue;
        const recorded = records.at(-1);
        const copy = recorded?.target ?? join(dest, `${name}.gz`);
        if (!beneath(dest, copy)) throw new Error("archive path is outside its session folder");
        if (folder === "missing" && pathKind(copy, io) === "missing") return { status: "lost" };
        if (!recorded || pathKind(copy, io) !== "file" || unpackedHash(copy) !== recorded.sha256) throw new Error(`${name} is missing and no verified archive exists`);
        continue;
      }
      if (type !== "file") throw new Error(`not a regular log file: ${input}`);
      const hash = sha256(io.readFileSync(input));
      if (records.some(e => e.sha256 === hash && e.target && beneath(dest, e.target) &&
          pathKind(e.target, io) === "file" && unpackedHash(e.target) === hash)) continue;
      pending = true;
      const slot = archiveSlot(dest, name, hash);
      const target = records.findLast(e => e.sha256 === hash)?.target;
      if (target) {
        notes.push(beneath(dest, target) && pathKind(target, io) === "file"
          ? `recorded archive ${target} of ${name} does not verify; it is kept unchanged. --yes writes a new verified archive at ${slot}`
          : `recorded archive ${target} of ${name} is missing. --yes archives the current log again at ${slot}`);
      } else if (records.length) {
        notes.push(`archive of ${name} is out of date: the log changed after it was archived. Run --yes again to write a new verified archive at ${slot}`);
      }
    }
    return pending ? { status: "pending", notes } : { status: "archived" };
  };
  const writeArchives = (source: string, dest: string) => {
    if (pathKind(source, io) !== "directory") return;
    if (!beneath(config.dir, dest)) throw new Error(`archive folder is outside the batch folder: ${dest}`);
    if (pathKind(dest, io) === "file") throw new Error(`archive folder is not a folder: ${dest}`);
    io.mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of LOG_NAMES) {
      const input = join(source, name);
      const type = pathKind(input, io);
      if (type === "missing") continue;
      if (type !== "file") throw new Error(`not a regular log file: ${input}`);
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
      if (pathKind(output, io) !== "file" || unpackedHash(output) !== hash) throw new Error("archive verification failed");
      append({ action: "archived", identity, kind: "archive", source: input, target: output, sha256: hash });
    }
  };
  return { logState, writeArchives };
}

// A separate journal makes a post-score snapshot distinguishable from an authorized cleanup.
// Cleanup reads both journals, including archives written by earlier versions.
export function archiveRun(
  config: Pick<BatchConfig, "dir" | "stateDir">, run: RunState, inventory: SessionInventory | null,
  knownSessions: string[], now: () => string, io: typeof fs = fs,
): string[] {
  if (!safeId(run.name)) throw new Error("invalid run archive identity");
  const journal = join(config.dir, "sessions.jsonl");
  const entries: ArchiveEntry[] = pathKind(journal, io) === "file"
    ? io.readFileSync(journal, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as ArchiveEntry) : [];
  const append = (entry: Omit<ArchiveEntry, "at">) => {
    pathKind(journal, io);
    const record = { at: now(), ...entry };
    io.appendFileSync(journal, JSON.stringify(record) + "\n", { mode: 0o600 });
    entries.push(record);
  };
  const sessions = [...new Set([...(inventory?.sessions ?? []), ...knownSessions, ...(run.sessionId ? [run.sessionId] : [])])];
  if (inventory) append({ action: "inventory", identity: runIdentity(run), inventory: { ...inventory, sessions } });
  const { logState, writeArchives } = sessionArchives(config, run, entries, append, io);
  const failures: string[] = [];
  for (const id of sessions) {
    try {
      if (!safeId(id)) throw new Error("invalid session identity");
      const source = join(config.stateDir, id);
      const dest = join(config.dir, "sessions", run.name, id);
      if (logState(source, dest).status !== "archived") writeArchives(source, dest);
      if (logState(source, dest).status !== "archived") throw new Error("session logs are missing or changed during archival");
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : "archive failed"}`);
    }
  }
  return failures;
}
