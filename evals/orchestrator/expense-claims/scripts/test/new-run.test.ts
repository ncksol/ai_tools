import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ALL_FEATURES } from "../lib/features.ts";
import { kickoffProblems } from "../lib/kickoff.ts";
import { listSeedFiles, newRun, nextRunNumber, parseRunName, runName } from "../lib/new-run.ts";
import { run, type ProcResult } from "../lib/proc.ts";
import { KIT_DIR } from "../lib/suite.ts";

const seed = join(KIT_DIR, "seed");
let runsDir: string;
before(() => {
  runsDir = mkdtempSync(join(tmpdir(), "orch-eval-test-"));
});
after(() => rmSync(runsDir, { recursive: true, force: true }));

function fakeGh(responses: Record<string, ProcResult>) {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<ProcResult> => {
    calls.push(args);
    return responses[args.slice(0, 2).join(" ")] ?? { code: 0, stdout: "", stderr: "" };
  };
  return { gh, calls };
}
const log = () => {};
const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: "" });

test("runName and parseRunName round-trip", () => {
  assert.equal(runName("session-orchestrator", 2), "orch-eval-session-orchestrator-2");
  assert.deepEqual(parseRunName("orch-eval-session-orchestrator-2"), { variant: "session-orchestrator", n: 2 });
  assert.equal(parseRunName("other"), null);
});

test("nextRunNumber counts existing run folders", () => {
  const dir = mkdtempSync(join(runsDir, "count-"));
  assert.equal(nextRunNumber(dir, "a"), 1);
  for (const name of ["orch-eval-a-1", "orch-eval-a-3", "orch-eval-b-7"]) mkdirSync(join(dir, name));
  assert.equal(nextRunNumber(dir, "a"), 4);
});

test("listSeedFiles lists the seed without junk", () => {
  const files = listSeedFiles(seed);
  for (const f of ["README.md", "docs/spec-v2.md", ".github/workflows/ci.yml", "src/routes.ts"]) assert.ok(files.includes(f), f);
  assert.ok(files.every((f) => !f.includes("node_modules") && !f.includes(".DS_Store")));
});

test("dry run builds a seed-only repo and never calls gh", async () => {
  const { gh, calls } = fakeGh({});
  const result = await newRun({ variant: "t", features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: true }, { gh, log });
  assert.equal(result.repoDir, join(runsDir, "orch-eval-t-1"));
  const tracked = (await run("git", ["ls-files"], { cwd: result.repoDir })).stdout.split("\n").filter(Boolean).sort();
  assert.deepEqual(tracked, listSeedFiles(seed).sort());
  assert.ok(!tracked.some((path) => /^(acceptance|reference|robustness|variants|pricing)\//.test(path)));
  assert.equal((await run("git", ["log", "--format=%s"], { cwd: result.repoDir })).stdout.trim(), "Seed v1");
  assert.equal((await run("git", ["branch", "--show-current"], { cwd: result.repoDir })).stdout.trim(), "main");
  assert.equal(readFileSync(join(result.repoDir, "docs/spec-v2.md"), "utf8"), readFileSync(join(seed, "docs/spec-v2.md"), "utf8"));
  assert.equal(readFileSync(join(runsDir, "orch-eval-t-1.kickoff.md"), "utf8"), readFileSync(join(KIT_DIR, "kickoff.md"), "utf8"));
  assert.equal(calls.length, 0);
});

test("dry run without Summary strips the spec and keeps the kickoff", async () => {
  const { gh } = fakeGh({});
  const result = await newRun({ variant: "ns", features: ["policy", "reports", "import"], owner: "ncksol", runsDir, dryRun: true }, { gh, log });
  const spec = readFileSync(join(result.repoDir, "docs/spec-v2.md"), "utf8");
  assert.ok(!spec.includes("## Feature: Summary"));
  const kickoff = readFileSync(result.kickoffPath, "utf8");
  assert.equal(kickoff, readFileSync(join(KIT_DIR, "kickoff.md"), "utf8"));
  assert.deepEqual(kickoffProblems(kickoff, spec), []);
});

test("a real run stops when the gh account is not the owner", async () => {
  const { gh, calls } = fakeGh({ "api user": ok("someone-else\n") });
  await assert.rejects(
    newRun({ variant: "wrong", features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: false }, { gh, log }),
    /someone-else.*ncksol/,
  );
  assert.ok(!existsSync(join(runsDir, "orch-eval-wrong-1")));
  assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "create"));
});

test("a real run stops when the repo already exists", async () => {
  const { gh, calls } = fakeGh({ "api user": ok("ncksol\n"), "repo view": ok("{}") });
  await assert.rejects(newRun({ variant: "dup", features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: false }, { gh, log }));
  assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "create"));
});

test("a real run creates a private repo and pushes", async () => {
  const { gh, calls } = fakeGh({ "api user": ok("ncksol\n"), "repo view": { code: 1, stdout: "", stderr: "not found" } });
  const result = await newRun({ variant: "t", n: 5, features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: false }, { gh, log });
  assert.deepEqual(calls[calls.length - 1], ["repo", "create", "ncksol/orch-eval-t-5", "--private", "--source", result.repoDir, "--remote", "origin", "--push"]);
});

test("an existing run folder is never overwritten", async () => {
  mkdirSync(join(runsDir, "orch-eval-t-9"));
  const { gh } = fakeGh({});
  await assert.rejects(newRun({ variant: "t", n: 9, features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: true }, { gh, log }));
});

test("an invalid run number is rejected before any side effect", async () => {
  for (const n of [NaN, -1, 1.5]) {
    const { gh, calls } = fakeGh({});
    await assert.rejects(newRun({ variant: "badn", n, features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: false }, { gh, log }), /positive integer/);
    assert.equal(calls.length, 0);
  }
  assert.deepEqual(readdirSync(runsDir).filter((e) => e.startsWith("orch-eval-badn")), []);
});

test("a destination that appears during the gh checks is never overwritten", async () => {
  const repoDir = join(runsDir, "orch-eval-race-1");
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<ProcResult> => {
    calls.push(args);
    if (args[0] === "api") {
      mkdirSync(repoDir);
      writeFileSync(join(repoDir, "marker.txt"), "keep");
      return ok("ncksol\n");
    }
    return { code: 1, stdout: "", stderr: "not found" };
  };
  await assert.rejects(newRun({ variant: "race", n: 1, features: ALL_FEATURES, owner: "ncksol", runsDir, dryRun: false }, { gh, log }), /already exists/);
  assert.ok(!calls.some((c) => c[0] === "repo" && c[1] === "create"));
  assert.equal(readFileSync(join(repoDir, "marker.txt"), "utf8"), "keep");
  assert.deepEqual(readdirSync(repoDir), ["marker.txt"]);
});
