# Design: Deadline and process-tree cancellation for the CLI-first Azure adapter

**Date:** 2026-08-13
**Status:** approved
**Files:** `run-with-deadline.mjs` (new), `azure-devops-cli-provider.md`, `collect-azure-devops-rest.mjs`, `plugin.test.mjs`

---

## Problem

PR review #4 finding 5 (comment `3777094098` on `azure-devops-cli-provider.md:26`):

> The mandatory CLI-first attempt remains unbounded. Under `azure-devops-cli-provider.md:26`,
> a stalled `az` request or `git fetch` never returns a failure, so REST, Bluebird, and other
> fallback adapters are never attempted and the review hangs until externally terminated.
> Apply an explicit deadline with process-tree cancellation to each adapter attempt, record
> timeout as a sanitized transient failure, and continue the deterministic fallback sequence.

Section 2 of `azure-devops-cli-provider.md` instructs the agent to run
`collect-azure-devops.sh` (twice: once with the current environment, once with a stored
`az login` context). That script shells out to `az repos pr show`, `az repos pr work-item
list`, `az repos pr policy list`, three `az devops invoke` calls, and `git fetch` — any one of
which can hang indefinitely (network stall, credential prompt that never returns on a
non-interactive TTY, DNS timeout with no OS-level bound). Nothing in the script or the
workflow instructions bounds total run time, so a hang blocks every fallback adapter (REST,
Bluebird, local git diff) that depends on the CLI attempt finishing first.

`authorizationForMode('entra', ...)` in `collect-azure-devops-rest.mjs` has the same defect
on a smaller scale: it calls `execFile('az', ['account', 'get-access-token', ...])` with no
timeout, so a stalled `az` invocation there blocks the REST-entra fragment collection.

REST HTTP calls in the same file already bound themselves with
`AbortSignal.timeout(30_000)` per request (with three attempts and backoff) — those are not
in scope for this fix.

---

## Constraints

- Stock macOS ships Bash 3.2 (`/bin/bash`, confirmed `3.2.57(1)-release`). No `mapfile`,
  no `${var,,}`, no associative arrays, and — critically for this fix — **no GNU
  `coreutils timeout`**. macOS does not ship a `timeout(1)` binary at all.
- Node.js `>=18` is already a hard requirement of every collector script. Node built-ins
  only; no new dependency.
- The CLI-first attempt is invoked directly by the agent's bash tool from prose in
  `azure-devops-cli-provider.md` — there is no Node orchestrator already wrapping it that
  we can add a `timeout` option to. The deadline has to be applied from the outside, as a
  wrapper around an arbitrary child command.
- A single `SIGTERM` to the top-level `bash collect-azure-devops.sh` process does not
  reliably stop `az` or `git fetch`: those are already-forked child processes of that shell,
  and a signal delivered to the shell does not propagate to a foreground child it is
  blocked in `wait()` on. The fix must terminate the whole process tree, not just the
  directly-spawned process.

---

## Approach

Add one new script, `run-with-deadline.mjs`, that wraps an arbitrary command with a
deadline and kills the complete process tree on expiry. No shell-level timeout trick is
required because Node's `child_process.spawn` with `{ detached: true }` already gives a
portable, dependency-free way to do this on POSIX:

- On non-Windows platforms, `detached: true` makes the spawned child the leader of a new
  process group (`setpgid(0, 0)`), and every process it forks (bash → az/git/node) inherits
  that same group unless it explicitly changes its own.
- Sending a signal to `-pid` (negative of the group leader's pid) delivers it to every
  process in that group, not just the leader. This is the same mechanism build tools and
  test runners (e.g. Jest's own child-process handling) use for POSIX process-tree
  cancellation, and it needs nothing beyond `node:child_process` and `process.kill`.

### `run-with-deadline.mjs`

CLI usage:

```bash
node <SKILL_DIR>/scripts/run-with-deadline.mjs --deadline-ms <MS> [--grace-ms <MS>] -- <command> [args...]
```

Behavior:

1. Spawn `<command> [args...]` with `stdio: 'inherit'` (so the wrapped script's own stdout
   redirection — e.g. `>"$work_dir/pull-request.json"` inside `collect-azure-devops.sh` —
   keeps working unchanged) and `detached: true`.
2. Start a timer for `--deadline-ms`. If the child exits before the timer fires, clear the
   timer and exit with the child's own exit code (or `128 + signal number` if it died from
   a signal) — the fast success path is untouched.
3. If the timer fires first: send `SIGTERM` to `-child.pid` (the whole process group), then
   wait up to `--grace-ms` (default 5000) for the child to exit. If it is still alive after
   the grace period, send `SIGKILL` to `-child.pid`.
4. Once the child has actually exited, print one diagnostic line to stderr (deadline value
   and which signal was used — no child stdout/stderr content, so nothing the child printed
   can leak through this wrapper's own message) and exit with status `124` — the same
   sentinel GNU `timeout(1)` uses, chosen so callers can `if [ $? -eq 124 ]` without
   inventing a new convention.
5. `--deadline-ms` is required; there is no built-in default inside the script itself —
   callers (the workflow doc) supply the default so it stays visible and greppable in one
   place, with the value itself overridable through an environment variable.

This is a thin, single-purpose wrapper: it knows nothing about Azure, capabilities, or
fragment schemas. It only runs a command, times it, and kills its process tree if needed.

### Workflow changes (`azure-devops-cli-provider.md`)

Section 2 wraps both `collect-azure-devops.sh` invocations:

```bash
node <SKILL_DIR>/scripts/run-with-deadline.mjs \
  --deadline-ms "${PRG_AZURE_CLI_DEADLINE_MS:-120000}" \
  -- bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
cli_current_status=$?
```

(and the equivalent for the stored-az-login attempt, capturing `cli_stored_status`). Default
120000ms (2 minutes) budgets three `az` calls, three `az devops invoke` calls, and one
`git fetch`/`git cat-file` pair with real-world CI latency; `PRG_AZURE_CLI_DEADLINE_MS`
overrides it for slower environments without editing the doc.

The existing failure-fragment step becomes conditional on the captured status, and branches
on the sentinel:

```bash
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
```

Same pattern for the stored-login attempt. This satisfies "record timeout as a sanitized
`transient` failure for only affected capabilities": the CLI-first collector produces one
fragment covering all nine required capabilities in a single pass, so a timeout marks all
nine as `transient`/incomplete — exactly the shape `assemble-azure-context.mjs failure`
already writes with `all`. No new per-capability logic is introduced; that finding belongs
to a different session.

### `authorizationForMode('entra', ...)` in `collect-azure-devops-rest.mjs`

Same defect, smaller blast radius: `execFileImpl('az', ['account', 'get-access-token', ...])`
has no bound. Reuse the tree-killing logic as a small exported JS helper (not the CLI
wrapper — this call is already inside a Node process, so it can use `child_process.spawn`
directly) with the same default/override convention
(`PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS`, default 15000ms — a single token request, much
shorter than the whole collector). On timeout it throws `accessError('transient', ...)`,
which already flows through `failedAzureRestFragment` to mark every REST capability
incomplete with a sanitized message — no changes needed there.

To avoid duplicating the spawn/kill-tree logic in two files, `run-with-deadline.mjs` exports
its core function (`runWithDeadline(command, args, options)`) for this in-process reuse, in
addition to its CLI entry point.

---

## Why this is safe

- `stdio: 'inherit'` means the wrapper does not buffer or transform the child's output —
  `collect-azure-devops.sh`'s own `>` redirections to `$work_dir/*.json` files happen
  exactly as before when the command finishes within the deadline. The fast success path
  adds one extra process (the wrapper) and one `setTimeout`/`clearTimeout` pair; no new
  I/O, no new files.
- Process-group kill is a `kill(2)` semantics detail already relied upon by common tooling;
  it needs no extra permissions beyond what sending a normal signal to a child already
  requires, since the wrapper is the direct parent (and process-group leader owner) of the
  tree it kills.
- `--grace-ms` (default 5000) between `SIGTERM` and `SIGKILL` gives `az`/`git`/`node` a
  chance to unwind (e.g. delete their own temp files) before a hard kill, matching
  `collect-azure-devops.sh`'s own `trap ... EXIT` cleanup pattern used elsewhere in the
  same script for its `mktemp -d` work directory.
- Timeout is reported as `transient` (matching the existing `accessError` category
  vocabulary already used for retryable/network-shaped failures elsewhere in this file),
  which is what makes it retryable in principle and clearly distinct from `authentication`
  or `tool-unavailable`.
- No behavior changes to `assemble-azure-context.mjs`, capability persistence, or any
  cross-attempt result merging — that is explicitly the separate finding another session
  owns.

---

## Tests

New file `tests/run-with-deadline.test.mjs` (mirrors the existing per-concern test file
split, e.g. `azure-access.test.mjs`, `plugin.test.mjs`):

1. **Fast success path** — wrap a quick command (`node -e "process.exit(0)"`) with a long
   deadline; assert it resolves promptly with exit code `0` and no timeout is reported.
2. **Exit code passthrough** — wrap a command that exits non-zero (e.g. `node -e
   "process.exit(3)"`) with a long deadline; assert the wrapper forwards exit code `3`
   unchanged (not `124`).
3. **Timeout with process-tree cleanup** — a small fixture script spawns a further child
   process (building a 2-level tree) and ignores `SIGTERM`, sleeping far longer than the
   test deadline; write both PIDs to a file. Wrap it with a short deadline (e.g. 200ms) and
   a short grace period; assert the wrapper exits `124`, and after it returns, assert
   neither PID is alive any more (`process.kill(pid, 0)` throws `ESRCH`) — proving the
   entire tree was terminated, not just the top-level process.
4. **Timeout diagnostics** — assert the wrapper's stderr on the timeout case names the
   deadline that was exceeded, and does not include the word used for GNU `timeout`'s exit
   code table only incidentally; mainly assert exit code `124` is the distinguishing signal
   callers must check.
5. **`authorizationForMode('entra', ...)` respects a deadline** — a fake `execFileImpl` (or
   fake spawn, depending on final call shape) that never resolves; assert the call rejects
   with `category: 'transient'` within the configured deadline instead of hanging the test
   run indefinitely.

Existing tests in `azure-access.test.mjs` and `plugin.test.mjs` are unaffected: no exported
function signatures they depend on change.

---

## Invariants

- `plugin.json` / marketplace version stays `0.3.0`.
- No new dependency; Node `>=18` built-ins only.
- No changes to per-capability persistence, capability merging, or `assemble-azure-context.mjs`
  selection logic — out of scope for this finding.
- `collect-azure-devops.sh` and `collect-github.sh` themselves are not modified; only the
  workflow doc's invocation of the former gains a wrapper.
- Commit message has no `Co-authored-by` or AI-attribution trailer.
