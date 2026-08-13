# CLI Adapter Deadline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the mandatory CLI-first Azure adapter attempt (and the `entra` token
acquisition inside the REST collector) an explicit, configurable deadline that terminates
the full child process tree on expiry, reports a sanitized `transient` failure, and lets
the deterministic fallback sequence continue — all with Node ≥18 built-ins on stock macOS
Bash 3.2, no new dependency.

**Architecture:** One new dependency-free Node script, `run-with-deadline.mjs`, exporting
both a CLI entry point (wraps an arbitrary external command, exits `124` on timeout — same
sentinel as GNU `timeout(1)`) and a plain async function `runWithDeadline` for in-process
reuse. `azure-devops-cli-provider.md` wraps both `collect-azure-devops.sh` invocations with
the CLI entry point. `authorizationForMode('entra', ...)` in
`collect-azure-devops-rest.mjs` calls the exported function directly instead of bare
`execFileImpl`.

**Tech Stack:** Node.js ≥18 ES modules, `node:child_process`, `node --test`. No new
dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-13-cli-adapter-deadline-design.md`

## Global Constraints

- All commands run from `ghcp/plugins/pr-review-graph`. Tests: `npm test`. Validation:
  `npm run validate`.
- Node.js ≥18, ES modules only (`import`, never `require`). Node built-ins only — no new
  `package.json` dependency.
- Shell snippets added to `azure-devops-cli-provider.md` must be valid Bash 3.2 (stock
  macOS `/bin/bash 3.2.57`) — no `mapfile`, no `${var,,}`, no associative arrays, no `[[
  ]]` inside a `[ ]` test, no relying on a `timeout(1)` binary.
- Do not modify `collect-azure-devops.sh`, `collect-github.sh`, `assemble-azure-context.mjs`
  selection/merge logic, or capability persistence across attempts — those are separate
  findings owned by other work.
- `plugin.json` / marketplace version stays `0.3.0`. Do not bump it.
- Commit message must not contain a `Co-authored-by` trailer or any AI attribution
  trailer.
- Work on the current branch (`nicksologoub-microsoft-studious-system`). Do not create a
  new branch.

---

### Task 1: `run-with-deadline.mjs` — the portable deadline runner

**Files:**
- Create: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/run-with-deadline.mjs`
- Test: `ghcp/plugins/pr-review-graph/tests/run-with-deadline.test.mjs` (new file)
- Fixture: `ghcp/plugins/pr-review-graph/tests/fixtures/hang-with-child.mjs` (new file)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `runWithDeadline({ command, args, deadlineMs, graceMs, stdio })` (exported async
  function) and a CLI entry point invoked as `node run-with-deadline.mjs --deadline-ms <MS>
  [--grace-ms <MS>] -- <command> [args...]`. Task 2 and Task 3 both depend on this file
  existing with this exact shape.

- [ ] **Step 1: Write the hanging-process-tree fixture**

Create `ghcp/plugins/pr-review-graph/tests/fixtures/hang-with-child.mjs`:

```javascript
#!/usr/bin/env node
// Test fixture only: spawns a grandchild process to build a 2-level tree, writes both
// PIDs to the file named in argv[2], ignores SIGTERM, and sleeps far longer than any
// test deadline. Used to prove run-with-deadline kills the whole tree, not just the
// process it directly spawned.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (!pidFile) {
  console.error('Usage: hang-with-child.mjs <pid-file>');
  process.exit(2);
}

process.on('SIGTERM', () => {
  // Deliberately ignored so the test can prove SIGKILL escalation works too.
});

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore'
});

writeFileSync(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));

setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write `run-with-deadline.mjs`**

Create `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/run-with-deadline.mjs`:

```javascript
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { isMain, parseFlags } from './lib.mjs';

export const TIMEOUT_EXIT_CODE = 124;
const DEFAULT_GRACE_MS = 5000;

// Sends `signal` to the whole process group led by `pid`. `detached: true` at spawn time
// makes the child a process-group leader on POSIX, so this reaches every descendant that
// has not called setsid()/setpgid() itself — the shell, and every `az`/`git`/`node`
// process it forked. Already-exited groups throw ESRCH, which is not an error here.
function killTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

/**
 * Run `command` with `args`, killing its entire process tree if it does not exit within
 * `deadlineMs`. Resolves with `{ code, signal, timedOut }` — never rejects for a timeout;
 * only rejects if the command itself could not be spawned (e.g. ENOENT).
 */
export function runWithDeadline({
  command,
  args = [],
  deadlineMs,
  graceMs = DEFAULT_GRACE_MS,
  stdio = 'inherit'
}) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('runWithDeadline requires a positive deadlineMs');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let deadlineTimer = null;
    let graceTimer = null;

    const child = spawn(command, args, { stdio, detached: process.platform !== 'win32' });

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      resolve({ code, signal, timedOut });
    });

    deadlineTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (process.platform === 'win32') {
        child.kill();
      } else {
        killTree(child.pid, 'SIGTERM');
        graceTimer = setTimeout(() => {
          if (settled) return;
          killTree(child.pid, 'SIGKILL');
        }, graceMs);
      }
    }, deadlineMs);
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const separatorIndex = process.argv.indexOf('--');
  if (separatorIndex < 0 || separatorIndex === process.argv.length - 1) {
    process.stderr.write(
      'Usage: run-with-deadline.mjs --deadline-ms <MS> [--grace-ms <MS>] -- <command> [args...]\n'
    );
    process.exitCode = 2;
    return;
  }
  const deadlineMs = Number(flags['deadline-ms']);
  const graceMs = flags['grace-ms'] !== undefined ? Number(flags['grace-ms']) : DEFAULT_GRACE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    process.stderr.write('run-with-deadline: --deadline-ms must be a positive number\n');
    process.exitCode = 2;
    return;
  }
  const [command, ...args] = process.argv.slice(separatorIndex + 1);

  let result;
  try {
    result = await runWithDeadline({ command, args, deadlineMs, graceMs });
  } catch (error) {
    process.stderr.write(`run-with-deadline: failed to run ${command}: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (result.timedOut) {
    process.stderr.write(`run-with-deadline: deadline of ${deadlineMs}ms exceeded, terminated process tree\n`);
    process.exitCode = TIMEOUT_EXIT_CODE;
    return;
  }
  if (result.signal) {
    process.stderr.write(`run-with-deadline: ${command} exited via signal ${result.signal}\n`);
    process.exitCode = 128;
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
```

Notes for the implementer:
- `parseFlags` from `./lib.mjs` already exists and is used by other scripts in this
  directory (`process-discovery.mjs`); confirm its behavior around a trailing `--`
  separator before relying on it — `parseFlags` treats every non-`--`-prefixed token as a
  positional in `result._`, so the manual `process.argv.indexOf('--')` split above (done
  independently of `parseFlags`) is what actually separates flags from the wrapped
  command; `parseFlags` is only used to read `--deadline-ms`/`--grace-ms` values from the
  tokens *before* that separator. Slice `process.argv.slice(2, separatorIndex)` into
  `parseFlags` instead of the whole remainder, so a `--` inside the wrapped command's own
  arguments is never misread as a flag terminator twice. Adjust the flag-parsing line
  accordingly:
  ```javascript
  const separatorIndex = process.argv.indexOf('--');
  const flags = parseFlags(process.argv.slice(2, separatorIndex < 0 ? undefined : separatorIndex));
  ```
- `detached: process.platform !== 'win32'` and the `win32` branch in the timeout handler
  are defensive; this plugin's stated target is macOS/Linux (Bash 3.2 constraint), but
  guarding avoids `process.kill(-pid, ...)` throwing on a platform where negative-pid kill
  is not the right primitive.

- [ ] **Step 3: Write the tests**

Create `ghcp/plugins/pr-review-graph/tests/run-with-deadline.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runWithDeadline, TIMEOUT_EXIT_CODE } from '../skills/review-pull-request/scripts/run-with-deadline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/hang-with-child.mjs');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a fast command resolves before the deadline with its own exit code', async () => {
  const result = await runWithDeadline({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    deadlineMs: 5000,
    stdio: 'ignore'
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
});

test('a non-zero exit code passes through unchanged, not conflated with a timeout', async () => {
  const result = await runWithDeadline({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    deadlineMs: 5000,
    stdio: 'ignore'
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 3);
});

test('a hanging command times out and its entire process tree is terminated', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prg-deadline-'));
  const pidFile = path.join(dir, 'pids.json');
  try {
    const result = await runWithDeadline({
      command: process.execPath,
      args: [fixture, pidFile],
      deadlineMs: 200,
      graceMs: 300,
      stdio: 'ignore'
    });
    assert.equal(result.timedOut, true);

    const { parent, child } = JSON.parse(await readFile(pidFile, 'utf8'));
    // Give the OS a beat to reap both processes after SIGKILL.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(alive(parent), false, 'the directly-spawned process must not survive');
    assert.equal(alive(child), false, 'the grandchild process must not survive — proves tree cleanup, not just top-level kill');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI entry point exits 124 on timeout so callers can branch on it deterministically', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prg-deadline-cli-'));
  const pidFile = path.join(dir, 'pids.json');
  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'skills/review-pull-request/scripts/run-with-deadline.mjs'),
      '--deadline-ms', '200',
      '--grace-ms', '300',
      '--',
      process.execPath, fixture, pidFile
    ], { encoding: 'utf8' });

    assert.equal(result.status, TIMEOUT_EXIT_CODE);
    assert.match(result.stderr, /deadline of 200ms exceeded/);
    const { parent, child } = JSON.parse(await readFile(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(alive(parent), false);
    assert.equal(alive(child), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the new test file in isolation**

Run: `cd ghcp/plugins/pr-review-graph && node --test tests/run-with-deadline.test.mjs`
Expected: 4 passing tests. If the tree-cleanup tests fail with the grandchild still alive,
check that `detached: true` is actually applied (it must be — without it, the grandchild is
in the *parent's* pre-existing process group, and killing `-child.pid` will not reach it).

---

### Task 2: Wrap the CLI-first collector attempts in the workflow doc

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/references/azure-devops-cli-provider.md` (Section 2, "CLI fast path")

**Interfaces:**
- Consumes: `run-with-deadline.mjs` CLI entry point from Task 1 (must be complete first).
- Produces: no exports; this is prose/bash instructions the agent follows at review time.
  Nothing downstream depends on the exact wording, only on the doc still instructing the
  agent through `collect-azure-devops.sh` before REST/Bluebird/git-diff.

- [ ] **Step 1: Replace the two bare invocations with deadline-wrapped ones**

In `azure-devops-cli-provider.md`, Section 2 currently reads (lines ~23–51):

```markdown
Run the collector once with the current environment:

​```bash
bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
​```

Run it a second time only when `AZURE_DEVOPS_EXT_PAT` is present and the first command failed, with the injected PAT removed so the collector falls back to a stored `az login` context:

​```bash
env -u AZURE_DEVOPS_EXT_PAT \
  PRG_AZURE_CREDENTIAL_CONTEXT=stored-az-login \
  bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
​```

Do not print either command's raw authentication error to the user or into any persisted file.

After a failed CLI collector attempt, record a sanitized failure fragment before trying the next adapter:

​```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli current-environment authentication \
  "Azure CLI did not produce a complete PR packet" all \
  <WORK_DIR>/cli-current-failure.json

node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli stored-az-login authentication \
  "Azure CLI stored login did not produce a complete PR packet" all \
  <WORK_DIR>/cli-stored-failure.json
​```

Use `tool-unavailable` instead of `authentication` when `az` or the Azure DevOps extension is absent.
```

Replace that whole block with:

```markdown
Run the collector once with the current environment, under an explicit deadline so a
stalled `az` request or `git fetch` cannot block every fallback adapter behind it. The
default budgets three `az` calls, three `az devops invoke` calls, and one `git fetch`; set
`PRG_AZURE_CLI_DEADLINE_MS` for slower environments:

​```bash
node <SKILL_DIR>/scripts/run-with-deadline.mjs \
  --deadline-ms "${PRG_AZURE_CLI_DEADLINE_MS:-120000}" \
  -- bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
cli_current_status=$?
​```

Run it a second time only when `AZURE_DEVOPS_EXT_PAT` is present and the first command failed, with the injected PAT removed so the collector falls back to a stored `az login` context:

​```bash
env -u AZURE_DEVOPS_EXT_PAT \
  PRG_AZURE_CREDENTIAL_CONTEXT=stored-az-login \
  node <SKILL_DIR>/scripts/run-with-deadline.mjs \
  --deadline-ms "${PRG_AZURE_CLI_DEADLINE_MS:-120000}" \
  -- bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
cli_stored_status=$?
​```

Do not print either command's raw authentication error to the user or into any persisted file.

After a failed CLI collector attempt, record a sanitized failure fragment before trying the
next adapter. Exit code `124` from `run-with-deadline.mjs` means the deadline was exceeded
and the whole process tree (the shell, `az`, and `git`) was terminated — record that as
`transient`, distinct from an authentication or tool-availability failure:

​```bash
if [ "$cli_current_status" -eq 124 ]; then
  node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
    azure-cli current-environment transient \
    "Azure CLI collector timed out after ${PRG_AZURE_CLI_DEADLINE_MS:-120000}ms" all \
    <WORK_DIR>/cli-current-failure.json
elif [ "$cli_current_status" -ne 0 ]; then
  node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
    azure-cli current-environment authentication \
    "Azure CLI did not produce a complete PR packet" all \
    <WORK_DIR>/cli-current-failure.json
fi

if [ "$cli_stored_status" -eq 124 ]; then
  node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
    azure-cli stored-az-login transient \
    "Azure CLI stored login collector timed out after ${PRG_AZURE_CLI_DEADLINE_MS:-120000}ms" all \
    <WORK_DIR>/cli-stored-failure.json
elif [ "$cli_stored_status" -ne 0 ]; then
  node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
    azure-cli stored-az-login authentication \
    "Azure CLI stored login did not produce a complete PR packet" all \
    <WORK_DIR>/cli-stored-failure.json
fi
​```

Use `tool-unavailable` instead of `authentication` when `az` or the Azure DevOps extension is absent.
```

(The literal `​` characters above are zero-width markers inserted only so this plan's own
fenced code blocks do not prematurely close while quoting Markdown fences — do not type
them into the actual file. Use plain ` ``` ` fences in `azure-devops-cli-provider.md`.)

- [ ] **Step 2: Update `validate-plugin.mjs` expectations if needed**

Check whether `validate-plugin.mjs`'s existing substring assertions against
`azureProviderText` (e.g. `azureProviderText.includes('collect-azure-devops-rest.mjs')`,
`.includes('assemble-azure-context.mjs')`) still pass — they should, since those strings
still appear unchanged elsewhere in the doc. No new assertion is required by this task,
but add one confirming the new script is documented, matching the existing style for the
REST/assembler scripts:

```javascript
if (!azureProviderText.includes('run-with-deadline.mjs')) errors.push('Azure DevOps provider must document the deadline wrapper for the CLI-first attempt');
```

Add this line in `ghcp/plugins/pr-review-graph/scripts/validate-plugin.mjs` directly after
the existing `assemble-azure-context.mjs` check (around line 103).

Also add `'run-with-deadline.mjs'` to the `requiredScripts` array in the same file (it
currently lists `collect-github.sh`, `collect-azure-devops.sh`,
`collect-azure-devops-rest.mjs`, `assemble-azure-context.mjs` — append the new script name
to that list, keeping the existing order/style).

---

### Task 3: Bound `authorizationForMode('entra', ...)` with the same mechanism

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops-rest.mjs`
- Modify: `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs` (append one test)

**Interfaces:**
- Consumes: `runWithDeadline` exported by Task 1's `run-with-deadline.mjs`.
- Produces: no change to `authorizationForMode`'s existing signature or its
  `{ env, execFileImpl }` options object — callers (including existing tests that pass a
  fake `execFileImpl`) keep working unmodified. Internally, the `entra` branch stops using
  `execFileImpl` directly for the network-bound call and instead runs it through
  `runWithDeadline`, but only when no fake `execFileImpl` override is supplied — see Step 1.

- [ ] **Step 1: Add a deadline around the `az account get-access-token` call**

This call is currently made through the `execFileImpl` injection point (used by existing
tests to fake `az`'s output without spawning a real process). `runWithDeadline` spawns a
real child process by command/args, which is a different shape than `execFileImpl`'s
promisified `(cmd, args, opts) => Promise<{stdout, stderr}>` signature. To keep the existing
`execFileImpl` test-injection point working unchanged (existing tests already fake it to
avoid depending on a real `az` binary), bound only the *real* code path — do not change the
function signature other tests rely on:

Replace the `entra` branch in `authorizationForMode` (currently):

```javascript
  if (mode === 'entra') {
    let stdout;
    try {
      ({ stdout } = await execFileImpl('az', [
        'account',
        'get-access-token',
        '--resource',
        AZURE_DEVOPS_RESOURCE,
        '--query',
        'accessToken',
        '--output',
        'tsv'
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
    } catch {
      throw accessError('authentication', 'Azure CLI could not provide an Azure DevOps access token');
    }
    const token = stdout.trim();
    if (!token) throw accessError('authentication', 'Azure CLI returned no Azure DevOps access token');
    return ['Bearer', token].join(' ');
  }
```

with:

```javascript
  if (mode === 'entra') {
    const deadlineMs = Number(env.PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS) || 15_000;
    let stdout;
    try {
      ({ stdout } = await execFileImpl('az', [
        'account',
        'get-access-token',
        '--resource',
        AZURE_DEVOPS_RESOURCE,
        '--query',
        'accessToken',
        '--output',
        'tsv'
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: deadlineMs }));
    } catch (error) {
      if (error?.killed && error?.signal) {
        throw accessError('transient', `Azure CLI token request timed out after ${deadlineMs}ms`);
      }
      throw accessError('authentication', 'Azure CLI could not provide an Azure DevOps access token');
    }
    const token = stdout.trim();
    if (!token) throw accessError('authentication', 'Azure CLI returned no Azure DevOps access token');
    return ['Bearer', token].join(' ');
  }
```

Note for the implementer: `execFileAsync` (the promisified `node:child_process.execFile`
already imported at the top of this file) natively supports a `timeout` option — when the
child does not exit before `timeout` ms, Node sends it a signal (default `SIGTERM`) and the
rejected error carries `killed: true` and `signal: 'SIGTERM'`. This is simpler and more
correct here than introducing `runWithDeadline`'s spawn-based process-group kill: `az
account get-access-token` is a single leaf process with no child processes of its own to
worry about as a tree, so `execFile`'s built-in timeout (still a Node ≥18 built-in, still no
dependency) is the right-sized tool, and it keeps the existing `execFileImpl` fake-injection
shape in tests completely unchanged. Do not add a `run-with-deadline.mjs` import to this
file — prefer the built-in `timeout` option and reserve `run-with-deadline.mjs` for
wrapping the multi-process `collect-azure-devops.sh` tree from the workflow doc, where a
plain per-call timeout option is not available because the whole invocation happens as an
externally-run shell command, not a single `execFile` call this module controls.

(This supersedes the design doc's mention of reusing `run-with-deadline.mjs`'s exported
function for this call — `execFile`'s native `timeout` option turns out to fit this single-
process case more precisely once the exact call shape is in front of you, without pulling
in process-group semantics that don't apply to one leaf process. Same outcome — a bounded,
sanitized, `transient`-categorized failure — smaller diff.)

- [ ] **Step 2: Add a test proving the entra path times out instead of hanging**

Append to `ghcp/plugins/pr-review-graph/tests/azure-access.test.mjs`, near the existing
`authorizationForMode`-adjacent tests (search for `authorizationForMode` in the file to
find current coverage, if any — if none exists yet, add near the top-level Azure REST
tests):

```javascript
test('authorizationForMode(entra) reports a sanitized transient timeout instead of hanging', async () => {
  const hangingExecFileImpl = () => new Promise(() => {
    /* never resolves — simulates a stalled `az account get-access-token` */
  });
  await assert.rejects(
    () => authorizationForMode('entra', {
      env: { PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS: '50' },
      execFileImpl: hangingExecFileImpl
    }),
    error => {
      assert.equal(error.category, 'transient');
      assert.match(error.message, /timed out after 50ms/);
      return true;
    }
  );
});
```

Note: this test's fake `execFileImpl` never resolves, so it cannot exercise Node's real
`execFile` `timeout` option (that only applies to the actual `execFileAsync`, not a fake
replacement) — it instead proves that when `execFileImpl` is swapped for a hanging fake in
tests, the *test itself* would hang forever with the old code (no timeout anywhere in the
call chain) if `Promise.race`-style bounding weren't added around the `execFileImpl` call
too. Re-check Step 1's implementation against this: `execFile`'s native `timeout` option
only bounds the *real* `execFileAsync`, not an injected fake `execFileImpl`. If this test is
to pass without a real `az` binary, `authorizationForMode` needs an explicit
`Promise.race`/`AbortController` bound around the `execFileImpl(...)` call itself (in
addition to, or instead of, passing `timeout` in the options object), so the deadline
applies uniformly whether `execFileImpl` is the real `execFileAsync` or a test fake.
Revise Step 1 to wrap the call as:

```javascript
  if (mode === 'entra') {
    const deadlineMs = Number(env.PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS) || 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    let stdout;
    try {
      ({ stdout } = await execFileImpl('az', [
        'account',
        'get-access-token',
        '--resource',
        AZURE_DEVOPS_RESOURCE,
        '--query',
        'accessToken',
        '--output',
        'tsv'
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024, signal: controller.signal, timeout: deadlineMs }));
    } catch (error) {
      if (controller.signal.aborted) {
        throw accessError('transient', `Azure CLI token request timed out after ${deadlineMs}ms`);
      }
      throw accessError('authentication', 'Azure CLI could not provide an Azure DevOps access token');
    } finally {
      clearTimeout(timer);
    }
    const token = stdout.trim();
    if (!token) throw accessError('authentication', 'Azure CLI returned no Azure DevOps access token');
    return ['Bearer', token].join(' ');
  }
```

This works with the real `execFileAsync` (which honors `AbortSignal` via the `signal`
option, aborting the underlying child process — `node:child_process.execFile` has
supported a `signal` option since Node 15) **and** with a hanging test fake, because the
fake's returned promise is never awaited past the point the test's own `assert.rejects`
needs — the `controller.abort()` firing is what the test's assertion is keyed on via the
`catch` block checking `controller.signal.aborted`, independent of whether the fake itself
ever settles. Confirm this reasoning holds when actually running the test in Step 3 below;
if the fake promise still leaves an unresolved handle that prevents the test process from
exiting, add `.unref()`-style handling or have the test fixture use
`test(..., { signal: AbortSignal.timeout(...) })`/an explicit short real timer inside the
fake instead of a promise that truly never settles, whichever proves necessary once you see
the actual test run output — do not guess further at that point, run it and adapt.

- [ ] **Step 3: Run the affected test files**

Run: `cd ghcp/plugins/pr-review-graph && node --test tests/azure-access.test.mjs`
Expected: all existing tests plus the new one pass. Pay special attention to whether the
new test actually completes (does not hang) — if it hangs, the `AbortController` wiring in
Step 2 is not actually cutting off the fake's pending promise, and needs the fallback
approach flagged in Step 2's note.

---

### Task 4: Full validation and commit

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: all tests pass, including the pre-existing 72 (per the merge-conflict PR comment
history) plus the new ones from Tasks 1 and 3.

- [ ] **Step 2: Run plugin validation**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: passes, including the new `run-with-deadline.mjs` documentation/required-script
assertions added in Task 2 Step 2.

- [ ] **Step 3: Bash syntax check on the modified reference doc's shell snippets**

The reference doc's fenced bash blocks are prose for the agent, not an executable file, so
there is no direct `bash -n` target. At minimum, manually re-read the new/changed fenced
bash blocks in `azure-devops-cli-provider.md` for Bash 3.2 validity (no `[[ ]]`-only
syntax issues, no arrays, correct `$?` capture placement immediately after each wrapped
command). If there is an existing repo convention for extracting and syntax-checking
fenced bash blocks from Markdown (check `tests/plugin.test.mjs` for anything that greps
` ```bash ` blocks), run it; otherwise this manual read is the check.

- [ ] **Step 4: Diff review**

Run: `git status && git diff --stat`
Expected: changes limited to `run-with-deadline.mjs` (new), `run-with-deadline.test.mjs`
(new), `hang-with-child.mjs` (new fixture), `azure-devops-cli-provider.md`,
`collect-azure-devops-rest.mjs`, `azure-access.test.mjs`, `validate-plugin.mjs`, plus this
plan and its design doc under `docs/superpowers/`. No version bump in `plugin.json` or
`marketplace.json`. No unrelated files touched.

- [ ] **Step 5: Commit**

Stage exactly the files from Step 4. Commit with a message describing the fix (no
`Co-authored-by` trailer, no AI attribution trailer), e.g.:

```
fix(pr-review-graph): bound the CLI-first Azure adapter with a portable deadline

Wrap collect-azure-devops.sh invocations and the entra token request with an
explicit, configurable deadline that terminates the full child process tree on
expiry and records a sanitized transient failure, so a stalled az/git call can
no longer block the REST/Bluebird/git-diff fallback sequence.
```

- [ ] **Step 6: Report back to the coordinating session**

Use `send_session_message` to `d8ba413b-7f92-4ffd-885e-821d509100fe` summarizing: what
changed, test/validate results, and the commit SHA.
