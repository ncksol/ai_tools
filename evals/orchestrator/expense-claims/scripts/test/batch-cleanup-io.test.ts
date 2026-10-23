import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanupGitHub, openCleanupApp, pushedResults, selectCleanupBatches } from "../lib/batch/cleanup-io.ts";
import type { run } from "../lib/proc.ts";
import type { BatchConfig, BatchState } from "../lib/batch/state.ts";
import { RESULT_COLUMNS, toCsvLine } from "../lib/results.ts";

test("delete credential is owner-specific, absent from argv/output, and never used before scope verification", async () => {
  const token = "secret-test-credential";
  const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec: typeof run = async (_cmd, args, opts) => {
    calls.push({ args, env: opts?.env });
    if (args[0] === "auth") return { code: 0, stdout: `${token}\n`, stderr: "" };
    if (args.includes("user")) return { code: 0, stdout: 'HTTP/2.0 200 OK\r\nX-OAuth-Scopes: repo, delete_repo\r\n\r\n{"login":"ncksol"}', stderr: "" };
    if (args.includes("DELETE")) return { code: 0, stdout: "", stderr: "" };
    if (args.some(arg => arg.includes("/compare/"))) return { code: 0, stdout: JSON.stringify({ status: "ahead", merge_base_commit: { sha: "a".repeat(40) } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ id: 42, full_name: "ncksol/orch-eval-a-1", default_branch: "main" }), stderr: "" };
  };
  const gh = cleanupGitHub(exec, { GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient2", GH_DEBUG: "api", PATH: "/bin" });
  await assert.rejects(gh.deleteRepo("ncksol/orch-eval-a-1", 42, "a".repeat(40)), /authoriz/);
  assert.equal(calls.length, 0);
  await gh.authorize("ncksol");
  await gh.deleteRepo("ncksol/orch-eval-a-1", 42, "a".repeat(40));
  assert.deepEqual(calls[0].args, ["auth", "token", "--hostname", "github.com", "--user", "ncksol"]);
  assert.equal(calls[0].env?.GH_TOKEN, undefined);
  assert.equal(calls[0].env?.GITHUB_TOKEN, undefined);
  for (const call of calls) {
    assert.ok(!call.args.join(" ").includes(token));
    assert.equal(call.env?.GH_DEBUG, undefined);
  }
  assert.equal(calls.find(c => c.args.includes("DELETE"))?.env?.GH_TOKEN, token);
  assert.equal(calls.find(c => c.args.some(a => a.includes("/compare/")))?.env?.GH_TOKEN, token);
});

for (const [login, scopes] of [["ncksol", "repo"], ["someone-else", "repo, delete_repo"]]) {
  test(`token ${login}/${scopes} cannot authorize deletion or leak its value`, async () => {
    const exec: typeof run = async (_cmd, args) => args[0] === "auth"
      ? { code: 0, stdout: "secret-test-token", stderr: "" }
      : { code: 0, stdout: `HTTP/2.0 200 OK\r\nX-OAuth-Scopes: ${scopes}\r\n\r\n{"login":"${login}"}`, stderr: "secret-test-token" };
    const gh = cleanupGitHub(exec, {});
    await assert.rejects(gh.authorize("ncksol"), error => error instanceof Error && !error.message.includes("secret-test-token"));
    await assert.rejects(gh.deleteRepo("ncksol/orch-eval-a-1", 42, "a".repeat(40)), /authoriz/);
  });
}

test("a replaced remote repo is not deleted after inventory", async () => {
  let deletes = 0;
  const exec: typeof run = async (_cmd, args) => {
    if (args[0] === "auth") return { code: 0, stdout: "secret", stderr: "" };
    if (args.includes("user")) return { code: 0, stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: delete_repo\n\n{"login":"ncksol"}', stderr: "" };
    if (args.includes("DELETE")) deletes++;
    return { code: 0, stdout: '{"id":999,"full_name":"ncksol/orch-eval-a-1","default_branch":"main"}', stderr: "" };
  };
  const gh = cleanupGitHub(exec, {});
  await gh.authorize("ncksol");
  await assert.rejects(gh.deleteRepo("ncksol/orch-eval-a-1", 42, "a".repeat(40)));
  assert.equal(deletes, 0);
});

test("an ambient 404 is not absence; authorized owner reads can still find and delete the repo", async () => {
  let deleted = 0;
  const exec: typeof run = async (_cmd, args, opts) => {
    if (args[0] === "auth") return { code: 0, stdout: "owner-secret", stderr: "" };
    if (args.includes("user")) return { code: 0, stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: repo, delete_repo\n\n{"login":"ncksol"}', stderr: "" };
    if (opts?.env?.GH_TOKEN !== "owner-secret") return { code: 1, stdout: "", stderr: "HTTP 404" };
    if (args.includes("DELETE")) { deleted++; return { code: 0, stdout: "", stderr: "" }; }
    return { code: 0, stdout: JSON.stringify(args.some(a => a.includes("/compare/"))
      ? { status: "identical", merge_base_commit: { sha: "a".repeat(40) } }
      : { id: 42, full_name: "ncksol/orch-eval-a-1", default_branch: "main" }), stderr: "" };
  };
  const gh = cleanupGitHub(exec, { GH_TOKEN: "unrelated-account" });
  await assert.rejects(gh.repo("ncksol/orch-eval-a-1", "a".repeat(40)), /not found or not visible/);
  await gh.authorize("ncksol");
  assert.deepEqual(await gh.repo("ncksol/orch-eval-a-1", "a".repeat(40)), { id: 42, seedPresent: true });
  await gh.deleteRepo("ncksol/orch-eval-a-1", 42, "a".repeat(40));
  assert.equal(deleted, 1);
});

test("independent guard: GitHub full_name must match the recorded repo", async () => {
  let deleted = false;
  const exec: typeof run = async (_cmd, args) => {
    if (args.includes("DELETE")) deleted = true;
    return { code: 0, stdout: JSON.stringify({ id: 42, full_name: "ncksol/different", default_branch: "main" }), stderr: "" };
  };
  await assert.rejects(cleanupGitHub(exec, {}).repo("ncksol/orch-eval-a-1", "a".repeat(40)), /^Error: GitHub repo identity does not match$/);
  assert.equal(deleted, false);
});

test("even the owner cannot establish private-repo absence without repo scope", async () => {
  const exec: typeof run = async (_cmd, args) => args[0] === "auth" ? { code: 0, stdout: "secret", stderr: "" } :
    args.includes("user") ? { code: 0, stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: delete_repo\n\n{"login":"ncksol"}', stderr: "" } :
      { code: 1, stdout: "", stderr: "HTTP 404" };
  const gh = cleanupGitHub(exec, {});
  await gh.authorize("ncksol");
  await assert.rejects(gh.repo("ncksol/orch-eval-a-1", "a".repeat(40)), /not found or not visible/);
});

for (const status of [401, 403, 404]) {
  test(`owner HTTP ${status} distinguishes absent repos from access errors`, async () => {
    const exec: typeof run = async (_cmd, args) => args[0] === "auth" ? { code: 0, stdout: "secret", stderr: "" } :
      args.includes("user") ? { code: 0, stdout: 'HTTP/2.0 200 OK\nX-OAuth-Scopes: repo, delete_repo\n\n{"login":"ncksol"}', stderr: "" } :
        { code: 1, stdout: "", stderr: `HTTP ${status}` };
    const gh = cleanupGitHub(exec, {});
    await gh.authorize("ncksol");
    if (status === 404) assert.equal(await gh.repo("ncksol/orch-eval-a-1", "a".repeat(40)), null);
    else await assert.rejects(gh.repo("ncksol/orch-eval-a-1", "a".repeat(40)), /access denied/);
  });
}

test("read-only app discovery includes project worktrees, pooled paths, aliases and never-started workspaces", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-db-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "data.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projects(id TEXT, main_repo_path TEXT, name TEXT);
    CREATE TABLE worktrees(id TEXT, project_id TEXT, path TEXT);
    CREATE TABLE reusable_worktree_pool(id TEXT, project_id TEXT, path TEXT);
    CREATE TABLE project_checkouts(project_id TEXT, host_id TEXT, root_resource_uri TEXT);
    CREATE TABLE workspaces(id TEXT, project_id TEXT, session_id TEXT, archived_at TEXT, creator_session_id TEXT, coordinating_creator_session_id TEXT);
    CREATE TABLE workspace_session_aliases(workspace_id TEXT, session_id TEXT);
    CREATE TABLE sessions(id TEXT, is_running INTEGER);
    INSERT INTO projects VALUES('p','/clone','Run');
    INSERT INTO worktrees VALUES('w','p','/worktree');
    INSERT INTO reusable_worktree_pool VALUES('pool','p','/pooled');
    INSERT INTO project_checkouts VALUES('p','local','file:///clone');
    INSERT INTO workspaces VALUES('root','p','cli',NULL,NULL,NULL),('never','p',NULL,NULL,'root',NULL);
    INSERT INTO workspace_session_aliases VALUES('root','old-cli');
    INSERT INTO sessions VALUES('cli',0),('orphan',1);
  `);
  db.close();
  const app = openCleanupApp(path);
  const data = app.inventory({ projectId: "p", appSessionId: "root", sessionId: "cli" });
  assert.deepEqual(data.worktrees.sort(), ["/pooled", "/worktree"]);
  assert.deepEqual(data.sessions.sort(), ["cli", "old-cli"]);
  assert.ok(data.workspaces.some(w => w.id === "never" && w.sessionId === null));
  assert.deepEqual(app.projectsForPath("/clone"), ["p"]);
  assert.equal(app.sessionExists("old-cli"), true, "alias references also protect original logs");
  assert.equal(app.sessionExists("absent"), false);
  assert.equal(app.sessionExists("orphan"), false, "orphan project-session rows survive UI removal");
  assert.equal(app.sessionRunning("orphan"), false, "orphan rows do not establish a live app session");
  assert.equal(app.sessionRunning("cli"), false);
  assert.throws(() => openCleanupApp(join(dir, "absent.db")).inventory({}), /database/);
});

test("results gate checks the remote branch CSV, exact batch marker and every scored row", async () => {
  const state = { runs: [{ scoredAt: "now", repo: "ncksol/orch-eval-a-1", n: 1, row: { repo: "ncksol/orch-eval-a-1", run: "1", outcome: "passed", note: "batch=b1; driver=eval-runner" } }] } as BatchState;
  let marker = "batch=another-batch";
  const exec: typeof run = async (cmd) => {
    if (cmd === "git") return { code: 0, stdout: "https://github.com/ncksol/ai_tools.git\n", stderr: "" };
    const row = { repo: "ncksol/orch-eval-a-1", run: "1", outcome: "passed", note: marker };
    const csv = `${RESULT_COLUMNS.join(",")}\n${toCsvLine(RESULT_COLUMNS.map(k => row[k as keyof typeof row] ?? ""))}\n`;
    return { code: 0, stdout: JSON.stringify({ content: Buffer.from(csv).toString("base64"), encoding: "base64" }), stderr: "" };
  };
  const config = { id: "b1" } as BatchConfig;
  assert.match(await pushedResults(config, state, "driver-branch", exec) ?? "", /origin/);
  marker = "batch=b1; driver=eval-runner";
  assert.equal(await pushedResults(config, state, "driver-branch", exec), null);
  assert.match(await pushedResults(config, state, null, exec) ?? "", /branch/);
});

for (const [name, defaultRows, allowed, branch] of [
  ["deleted results branch and identical landed rows", "identical", true, "driver-branch"],
  ["no remote ref preserves the rows", "missing", false, "driver-branch"],
  ["landed rows differ from the recorded result", "mismatched", false, "driver-branch"],
  ["missing report branch and identical landed rows", "identical", true, null],
] as const) {
  test(`results gate: ${name}`, async () => {
    const row = { repo: "ncksol/orch-eval-a-1", run: "1", outcome: "passed", note: "batch=b1; driver=eval-runner" };
    const state = { runs: [{ scoredAt: "now", repo: row.repo, n: 1, row }] } as BatchState;
    const requested: string[] = [];
    const exec: typeof run = async (cmd, args) => {
      if (cmd === "git") return { code: 0, stdout: "https://github.com/ncksol/ai_tools.git\n", stderr: "" };
      const endpoint = args.at(-1)!;
      requested.push(endpoint);
      if (endpoint.endsWith("?ref=driver-branch")) return { code: 1, stdout: "", stderr: "HTTP 404" };
      if (endpoint === "repos/ncksol/ai_tools") return { code: 0, stdout: '{"full_name":"ncksol/ai_tools","default_branch":"trunk"}', stderr: "" };
      assert.equal(endpoint, "repos/ncksol/ai_tools/contents/evals/orchestrator/expense-claims/results.csv?ref=trunk", "use GitHub's actual default, not a guessed main");
      const remote = { ...row, outcome: defaultRows === "mismatched" ? "failed" : row.outcome };
      const csv = RESULT_COLUMNS.join(",") + "\n" +
        (defaultRows === "missing" ? "" : toCsvLine(RESULT_COLUMNS.map(k => remote[k as keyof typeof remote] ?? "")) + "\n");
      return { code: 0, stdout: JSON.stringify({ content: Buffer.from(csv).toString("base64"), encoding: "base64" }), stderr: "" };
    };
    const result = await pushedResults({ id: "b1" } as BatchConfig, state, branch, exec);
    if (allowed) assert.equal(result, null);
    else assert.match(result ?? "", /origin/);
    assert.deepEqual(requested, [
      ...(branch ? ["repos/ncksol/ai_tools/contents/evals/orchestrator/expense-claims/results.csv?ref=driver-branch"] : []),
      "repos/ncksol/ai_tools",
      "repos/ncksol/ai_tools/contents/evals/orchestrator/expense-claims/results.csv?ref=trunk",
    ]);
  });
}

test("all selects done and stopped batches but never live or manual runs; latest is stable by id", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-select-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [id, phase] of [["20261021-2153", "stopped"], ["20261021-2217", "done"], ["20261022-2121", "runs"]]) {
    const dir = join(root, id);
    mkdirSync(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ id }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ phase }));
  }
  mkdirSync(join(root, "orch-eval-manual-1"));
  assert.deepEqual(selectCleanupBatches("all", root), [join(root, "20261021-2153"), join(root, "20261021-2217")]);
  assert.deepEqual(selectCleanupBatches("latest", root), [join(root, "20261022-2121")]);
});
