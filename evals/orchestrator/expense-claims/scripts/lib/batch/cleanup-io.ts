import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { cleanupBatch, formatCleanup, githubSlug, pathKind, type CleanupApp, type CleanupInventory } from "./cleanup.ts";
import { loadConfig, loadState, type BatchConfig, type BatchState } from "./state.ts";
import { withLock, withOsLock } from "./lock.ts";
import { run } from "../proc.ts";
import { parseCsvText, RESULT_COLUMNS, LEGACY_RESULT_COLUMNS } from "../results.ts";
import { KIT_DIR } from "../suite.ts";

// No app mutation seam is implemented: absence of a supported API must not become a database
// write or an internal IPC call. Missing schema/ambiguous data throws and blocks the run.
export function openCleanupApp(path: string): CleanupApp {
  const read = <T>(fn: (db: DatabaseSync) => T): T => {
    if (!existsSync(path)) throw new Error("app database is missing");
    const db = new DatabaseSync(path, { readOnly: true });
    try { return fn(db); }
    finally { db.close(); }
  };
  const column = (db: DatabaseSync, table: string, field: string, where: string, args: string[]): (string | number | null)[] =>
    db.prepare(`SELECT ${field} AS v FROM ${table} WHERE ${where}`).all(...args).map(row => {
      const value = row.v;
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      throw new Error(`unexpected app DB value: ${table}.${field}`);
    });
  const strings = (db: DatabaseSync, table: string, field: string, where: string, args: string[]) =>
    column(db, table, field, where, args).filter((v): v is string => typeof v === "string" && v !== "");
  const cell = (db: DatabaseSync, table: string, field: string, id: string): string | number | null => {
    const values = column(db, table, field, "id = ?", [id]);
    if (values.length > 1) throw new Error(`ambiguous app DB ${table} identity`);
    return values[0] ?? null;
  };
  const linkedSession = (db: DatabaseSync, id: string): boolean =>
    strings(db, "workspaces", "id", "session_id = ?", [id]).length > 0 ||
    strings(db, "workspace_session_aliases", "workspace_id", "session_id = ?", [id]).length > 0;
  return {
    inventory: record => read(db => {
      const out: CleanupInventory = { projects: [], worktrees: [], sessions: [], workspaces: [] };
      const queue: string[] = [];
      if (record.projectId) {
        const path = cell(db, "projects", "main_repo_path", record.projectId);
        if (path !== null) {
          if (typeof path !== "string") throw new Error("invalid app project path");
          out.projects.push({ id: record.projectId, path, name: String(cell(db, "projects", "name", record.projectId) ?? record.projectId) });
        }
        out.worktrees.push(...strings(db, "worktrees", "path", "project_id = ?", [record.projectId]),
          ...strings(db, "reusable_worktree_pool", "path", "project_id = ?", [record.projectId]));
        queue.push(...strings(db, "workspaces", "id", "project_id = ?", [record.projectId]));
      }
      if (record.appSessionId) queue.push(record.appSessionId);
      if (record.sessionId) {
        out.sessions.push(record.sessionId);
        queue.push(...strings(db, "workspaces", "id", "session_id = ?", [record.sessionId]),
          ...strings(db, "workspace_session_aliases", "workspace_id", "session_id = ?", [record.sessionId]));
      }
      const seen = new Set<string>();
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (cell(db, "workspaces", "id", id) === null) continue;
        const sessionId = cell(db, "workspaces", "session_id", id);
        if (sessionId !== null && typeof sessionId !== "string") throw new Error("invalid workspace session id");
        out.workspaces.push({ id, sessionId, archived: cell(db, "workspaces", "archived_at", id) !== null });
        const aliases = strings(db, "workspace_session_aliases", "session_id", "workspace_id = ?", [id]);
        if (sessionId) aliases.push(sessionId);
        out.sessions.push(...aliases);
        for (const parent of [id, ...aliases]) {
          queue.push(...strings(db, "workspaces", "id", "creator_session_id = ? OR coordinating_creator_session_id = ?", [parent, parent]));
        }
      }
      out.sessions = [...new Set(out.sessions)];
      out.worktrees = [...new Set(out.worktrees)];
      return out;
    }),
    projectsForPath: path => read(db => [...new Set([
      ...strings(db, "projects", "id", "main_repo_path = ?", [path]),
      ...strings(db, "project_checkouts", "project_id", "host_id = 'local' AND root_resource_uri IN (?, ?)", [path, pathToFileURL(path).href]),
      ...strings(db, "worktrees", "project_id", "path = ?", [path]),
      ...strings(db, "reusable_worktree_pool", "project_id", "path = ?", [path]),
    ])]),
    workspacesForPath: path => read(db => [...new Set([
      ...strings(db, "workspaces", "id", "source_path = ?", [path]),
      ...strings(db, "workspace_checkout_bindings", "workspace_id", "checkout_path = ?", [path]),
    ])]),
    sessionExists: id => read(db => linkedSession(db, id)),
    sessionRunning: id => read(db => {
      if (!linkedSession(db, id)) return false;
      const value = cell(db, "sessions", "is_running", id);
      if (value !== null && value !== 0 && value !== 1) throw new Error("invalid session running state");
      return value === 1;
    }),
  };
}

export function cleanupGitHub(exec: typeof run = run, environment: NodeJS.ProcessEnv = process.env) {
  const readEnv: NodeJS.ProcessEnv = { ...environment, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" };
  delete readEnv.GH_DEBUG;
  delete readEnv.DEBUG;
  let authorized: { owner: string; token: string; privateRepoAccess: boolean } | null = null;
  // Never propagate a credential-bearing subprocess's output or exception: gh errors may echo
  // headers, and tests deliberately return a token in stderr.
  const command = async (args: string[], env: NodeJS.ProcessEnv = readEnv) => {
    try { return await exec("gh", args, { env, timeoutMs: 60_000 }); }
    catch { throw new Error("GitHub cleanup command could not run (details suppressed to protect credentials)"); }
  };
  const api = (endpoint: string) => command(["api", "--hostname", "github.com", "--method", "GET", endpoint],
    authorized ? { ...readEnv, GH_TOKEN: authorized.token, GITHUB_TOKEN: undefined } : readEnv);
  const metadata = async (repo: string) => {
    if (!/^[a-zA-Z0-9-]+\/orch-eval-[a-z0-9-]+-\d+$/.test(repo)) throw new Error("invalid cleanup repo identity");
    const response = await api(`repos/${repo}`);
    if (response.code !== 0) {
      if (/HTTP 404/.test(response.stderr)) {
        if (authorized?.privateRepoAccess && repo.split("/")[0] === authorized.owner) return null;
        throw new Error("repo not found or not visible; absence requires the verified owner's keyring identity with repo scope");
      }
      if (/HTTP (401|403)/.test(response.stderr)) throw new Error("GitHub access denied; cannot establish repo identity or absence");
      throw new Error("cannot read GitHub repo identity (authentication, network or API failure)");
    }
    let data: unknown;
    try { data = JSON.parse(response.stdout); } catch { throw new Error("invalid GitHub repo response"); }
    if (!data || typeof data !== "object" || !("id" in data) || typeof data.id !== "number" || !Number.isSafeInteger(data.id) ||
        !("full_name" in data) || data.full_name !== repo ||
        !("default_branch" in data) || typeof data.default_branch !== "string") throw new Error("GitHub repo identity does not match");
    return { id: data.id, branch: data.default_branch };
  };
  const inspect = async (repo: string, seed: string) => {
    if (!/^[a-f0-9]{40}$/.test(seed)) throw new Error("missing recorded seed identity");
    const data = await metadata(repo);
    if (!data) return null;
    const response = await api(`repos/${repo}/compare/${seed}...${encodeURIComponent(data.branch)}`);
    if (response.code !== 0) throw new Error("cannot verify recorded seed in GitHub history");
    let comparison: { status?: string; merge_base_commit?: { sha?: string } };
    try { comparison = JSON.parse(response.stdout); } catch { throw new Error("invalid GitHub history response"); }
    return { id: data.id, seedPresent: ["ahead", "identical"].includes(comparison.status ?? "") && comparison.merge_base_commit?.sha === seed };
  };
  return {
    repo: inspect,
    authorize: async (owner: string) => {
      authorized = null;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(owner)) throw new Error("invalid owner");
      const keyringEnv = { ...readEnv };
      delete keyringEnv.GH_TOKEN;
      delete keyringEnv.GITHUB_TOKEN;
      const result = await command(["auth", "token", "--hostname", "github.com", "--user", owner], keyringEnv);
      if (result.code || !result.stdout.trim()) throw new Error("cannot read the batch owner's gh keyring token");
      const token = result.stdout.trim();
      const check = await command(["api", "--hostname", "github.com", "--method", "GET", "user", "--include"], { ...keyringEnv, GH_TOKEN: token });
      if (check.code) throw new Error("cannot verify the owner's delete_repo token");
      const scopes = /^x-oauth-scopes:\s*(.*)$/im.exec(check.stdout)?.[1]?.trim().split(/\s*,\s*/) ?? [];
      const body = check.stdout.split(/\r?\n\r?\n/).at(-1)!;
      let login: unknown;
      try { login = JSON.parse(body).login; } catch { throw new Error("cannot verify the token owner"); }
      if (typeof login !== "string" || login.toLowerCase() !== owner.toLowerCase()) throw new Error("keyring token is not the batch owner's");
      if (!scopes.includes("delete_repo")) throw new Error("owner keyring token lacks delete_repo scope");
      authorized = { owner, token, privateRepoAccess: scopes.includes("repo") };
    },
    deleteRepo: async (repo: string, id: number, seed: string) => {
      if (!authorized || repo.split("/")[0] !== authorized.owner) throw new Error("repo deletion has not been authorized for this owner");
      const current = await inspect(repo, seed);
      if (!current || current.id !== id || !current.seedPresent) throw new Error("repo identity changed before deletion");
      const deleted = await command(["api", "--hostname", "github.com", "--method", "DELETE", `repos/${repo}`],
        { ...readEnv, GH_TOKEN: authorized.token, GITHUB_TOKEN: undefined });
      if (deleted.code) throw new Error("GitHub repo deletion failed (details suppressed to protect credentials)");
    },
  };
}

export async function pushedResults(config: BatchConfig, state: BatchState, branch: string | null, exec: typeof run = run): Promise<string | null> {
  const scored = state.runs.filter(r => r.scoredAt || r.row || r.committed);
  if (!scored.length) return null;
  if (branch && (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch) || branch.includes(".."))) return "invalid results branch recorded in report.md";
  const origin = await exec("git", ["remote", "get-url", "origin"], { cwd: KIT_DIR, timeoutMs: 60_000 });
  const slug = origin.code === 0 ? githubSlug(origin.stdout) : null;
  if (!slug) return "cannot identify this kit's origin";
  const api = (endpoint: string) => exec("gh", ["api", "--hostname", "github.com", "--method", "GET", endpoint], { timeoutMs: 60_000 });
  const checkBranch = async (ref: string): Promise<string | null> => {
    const response = await api(`repos/${slug}/contents/evals/orchestrator/expense-claims/results.csv?ref=${encodeURIComponent(ref)}`);
    if (response.code) return "cannot read results.csv on origin's results branch";
    let file: unknown;
    try { file = JSON.parse(response.stdout); } catch { return "invalid origin results.csv response"; }
    if (!file || typeof file !== "object" || !("encoding" in file) || file.encoding !== "base64" ||
        !("content" in file) || typeof file.content !== "string") return "invalid origin results.csv response";
    const [header, ...rows] = parseCsvText(Buffer.from(file.content, "base64").toString("utf8"));
    if (!header || ![RESULT_COLUMNS.join(","), LEGACY_RESULT_COLUMNS.join(",")].includes(header.join(","))) return "unexpected origin results.csv header";
    const objects = rows.map(row => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ""])));
    for (const run of scored) {
      if (!run.row) return `no recorded result row for ${run.name}; cannot verify origin`;
      const found = objects.some(row => row.repo === run.repo && row.run === String(run.n) &&
        row.note?.split(";").some(part => part.trim() === `batch=${config.id}`) &&
        Object.entries(run.row!).every(([key, value]) => (row[key] ?? "") === value));
      if (!found) return `origin results.csv does not preserve the recorded row for ${run.name}; if you deliberately dropped or edited it, confirm with --dropped ${run.name}`;
    }
    return null;
  };
  const originalFailure = branch ? await checkBranch(branch) : "results branch is not recorded in report.md";
  if (!originalFailure) return null;
  const repository = await api(`repos/${slug}`);
  if (repository.code) return `${originalFailure}; cannot determine origin's default branch`;
  let metadata: unknown;
  try { metadata = JSON.parse(repository.stdout); } catch { return `${originalFailure}; invalid origin repository response`; }
  if (!metadata || typeof metadata !== "object" || !("full_name" in metadata) || metadata.full_name !== slug ||
      !("default_branch" in metadata) || typeof metadata.default_branch !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(metadata.default_branch) || metadata.default_branch.includes("..")) {
    return `${originalFailure}; cannot verify origin's default branch`;
  }
  if (metadata.default_branch === branch) return originalFailure;
  const landedFailure = await checkBranch(metadata.default_branch);
  return landedFailure ? `${originalFailure}; origin default branch: ${landedFailure}` : null;
}

export function selectCleanupBatches(value: string, root: string): string[] {
  if (!value) throw new Error("--batch is required");
  if (value !== "all" && value !== "latest") return [value.includes("/") ? resolve(value) : join(root, value)];
  const dirs = readdirSync(root).filter(name => /^[a-zA-Z0-9-]+$/.test(name) &&
    pathKind(join(root, name)) === "directory" && existsSync(join(root, name, "config.json"))).sort();
  if (value === "latest") {
    if (!dirs.length) throw new Error(`No batches in ${root}`);
    return [join(root, dirs.at(-1)!)];
  }
  return dirs.map(name => join(root, name)).filter(dir => ["done", "stopped"].includes(loadState(dir).phase));
}

export async function cleanupCommand(options: { batch: string; batchesDir: string; yes: boolean; force: boolean; dropped?: string[] }, print: (line: string) => void = console.log): Promise<number> {
  if (options.batch === "all" && options.dropped?.length) throw new Error("--dropped requires one batch, not all");
  let exit = 0;
  for (const dir of selectCleanupBatches(options.batch, options.batchesDir)) {
    const execute = async () => {
      const config = loadConfig(dir);
      if (config.dir !== dir) throw new Error("selected batch folder differs from its recorded path");
      const state = loadState(dir);
      const gh = cleanupGitHub();
      const result = await cleanupBatch(config, state, options, {
        home: homedir(), app: openCleanupApp(config.appDb), now: () => new Date().toISOString(), exec: run, ...gh,
        results: (config, state, record) => {
          const report = join(dir, "report.md");
          pathKind(report);
          const branch = existsSync(report) ? /^results\.csv rows are committed on branch `([^`]+)`/m.exec(readFileSync(report, "utf8"))?.[1] ?? null : null;
          return pushedResults(config, { ...state, runs: [record] }, branch);
        },
      });
      print(formatCleanup(result));
      if (result.items.some(i => i.status === "blocked")) exit = 1;
    };
    if (!options.yes) await execute();
    else {
      // Match the runner's lock order. Dry runs take no file locks (even flock creates a file).
      const config = loadConfig(dir);
      const home = homedir();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(config.id) || dir !== join(home, "orch-evals", "batches", config.id) ||
          config.activeGuard !== join(home, "orch-evals", "active-batch")) throw new Error("unsafe batch/guard path");
      pathKind(dir);
      pathKind(join(dir, "runner.lock"));
      pathKind(`${config.activeGuard}.lock`);
      const opts = { waitMs: 0, sleep: (ms: number) => new Promise<void>(done => setTimeout(done, ms)), now: () => Date.now() };
      await withLock(dir, () => withOsLock(`${config.activeGuard}.lock`, execute,
        { ...opts, busyMessage: "another process holds the active-batch lock" }), opts);
    }
  }
  return exit;
}
