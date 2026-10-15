# Swarm Data Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only data engine of the swarm dashboard plugin: readers for Copilot's local data, the swarm model (runs, sessions, sub-agents, reports, questions, stages, PR monitors and cost), stuck detection, the run lifecycle and history store, the orchestrator data-contract parser, and a command that prints a run's state as JSON.

**Architecture:** Plain Node ES modules under `ghcp/plugins/swarm-dashboard/engine/`, with no build step and no npm dependencies. Readers pull raw data strictly read-only: SQLite through `node:sqlite`, falling back to the `sqlite3` CLI, and `events.jsonl` tailed by byte offset. A per-session reducer folds events into compact state; pure model functions derive statuses, stages, monitors and the snapshot; `createSwarmEngine()` polls only after `start()` and notifies subscribers. `engine/schema.mjs` is the contract with PR 2 (server and UI).

**Tech Stack:** Node.js >= 18 built-ins only (`node:test`, `node:fs`, `node:child_process`, optional `node:sqlite`), the macOS `sqlite3` CLI as fallback, and the `gh` and `az` CLIs for read-only PR state.

**Spec:** `docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md` (visual reference: `docs/superpowers/specs/assets/2026-10-15-swarm-dashboard-mockup.html`). Executors read the spec's sections 5, 9, 10 and 11 before starting.

## Global Constraints

- Plugin folder `ghcp/plugins/swarm-dashboard/`, name `swarm-dashboard`, version `0.1.0` in `plugin.json`, `package.json` and its root `.github/plugin/marketplace.json` entry.
- `package.json`: private, `"type": "module"`, `"engines": {"node": ">=18"}`, `npm test` = `node --test tests/*.test.mjs`, `npm run validate` = `node scripts/validate-plugin.mjs`; no `dependencies` or `devDependencies`.
- No `marketplace.json` inside the plugin. The validator checks the plugin's entry in the root manifest, reusing only pr-review-graph's manifest checks.
- Engine and test code run on Node 18.0+: no `Object.groupBy`, `Array.prototype.toSorted`, `Promise.withResolvers`, `fs.glob`, `t.after()` or `mock` from `node:test`. `node:sqlite` is loaded only by `engine/sqlite.mjs`.
- Data access is strictly read-only. Never write to `~/.copilot/data.db`, `~/.copilot/session-store.db` or anything under `~/.copilot/session-state/`. Open SQLite with `readOnly: true` plus `PRAGMA query_only = 1`, or `sqlite3 -readonly`. Open a WAL database whose `-shm` file is missing with the `immutable=1` URI, so the read creates no side files.
- From `data.db` read only named columns; no `SELECT *`; never touch its settings or token columns. Never print or store tokens.
- The engine writes only to its history folder (default `~/.copilot/swarm-dashboard/history/`), and only run summaries without free text (no report bodies, questions, prompts or tool arguments).
- The engine never writes to stdout (a canvas extension's stdout carries JSON-RPC). Only `scripts/swarm-snapshot.mjs` prints JSON to stdout.
- The engine starts no timers until `start()` is called.
- Memory stays bounded: the engine never holds a whole log in memory. It reads `events.jsonl` in 256 KB chunks, keeps only bounded per-session state (`LIMITS`), and keeps copies (`ownString`) of any text it stores from a log line, because a V8 substring can keep its whole parent chunk alive.
- Every fixture is synthetic. Never commit real session data, logs, database extracts, internal names, people's names, Azure DevOps ids, session ids or local user paths.
- Snapshot times are epoch milliseconds (UTC); durations are milliseconds; credits = sum of `total_nano_aiu` / 1e9; dollars = credits × 0.01.
- Parsers accept missing keys and string-typed tool arguments.
- Stuck thresholds are configurable; defaults are design call 3 verbatim: model call 5 min warn, 10 min stuck; bash `initial_wait` + 5 min (10 min without one); `read_bash` delay + 2 min; `read_agent` timeout + 2 min; app, file and search tools 2 min; sub-agent 10 min without events (15 for general-purpose on Opus at max effort); silent busy 10 min; stalled child 30 min; spinning within 30 busy minutes: 5+ failed tool calls, the same tool and arguments 3+ times, 2+ compactions, or a permission denial with `decisionSource: "unattended_fallback"` (builder decision 2 narrows the repeat and compaction checks, pending the coordinator's OK); a run is finished after 2 hours without activity.
- After any change under the plugin folder or to the root manifest, run `npm test && npm run validate` from `ghcp/plugins/swarm-dashboard`. After changing the root manifest, run the same in `ghcp/plugins/pr-review-graph` and `ghcp/plugins/adr-authoring`.
- Conventional commit messages; no `Co-authored-by` trailer or other AI attribution.

## Decisions settled before implementation

### SQLite from the extension runtime (open risks 1 and 2)

Evidence gathered on this machine, read-only, on 15 October 2026:

| Runtime | Node | SQLite | `node:sqlite` |
| --- | --- | --- | --- |
| Copilot CLI 1.0.95-3 binary that runs extensions (`copilot extension_bootstrap.mjs`, a Node SEA) | v24.20.0 | 3.53.4 | Works with `readOnly: true`; no warning |
| nvm default `node` | v24.19.0 | 3.53.3 | Works; no warning |
| nvm v22.16.0 | v22.16.0 | 3.49.1 | Works; prints an ExperimentalWarning on stderr |
| nvm v20.20.2 and `/usr/local/bin/node` v18.11.0 | | | `ERR_UNKNOWN_BUILTIN_MODULE` |
| `/usr/bin/sqlite3` CLI | | 3.51.0 | `-readonly -json` works |

- A probe run through the real extension bootstrap read the live `data.db` and `session-store.db` (WAL, with live writers) with `readOnly: true`: writes were rejected (`attempt to write a readonly database`), the main database files were unchanged, and opening and querying took 4 ms and 31 ms.
- A plain read-only open of a WAL database whose writer has closed (no `-wal`/`-shm` files) creates `-wal` and `-shm` beside it. The `file:...?immutable=1` URI reads it without creating any file, in every runtime above and in the CLI. The CLI cannot open such a file without `immutable=1` (error 14).
- All 85 recent per-session `session.db` files are rollback-journal databases, so read-only opens of them never need side files.

Decision: `engine/sqlite.mjs` uses `node:sqlite` when it loads, otherwise the `sqlite3` CLI (`-readonly -json`, parameters bound as escaped literals). Both open a WAL database without `-shm` through `immutable=1`. This keeps `engines.node` at `>=18` as the spec requires, and `/usr/local/bin/node` on this machine is v18.11.0. Task 17 runs the suite on Node 18 (CLI backend) and Node 24 (`node:sqlite`).

### Other facts that shape the readers

- Extension processes are `copilot extension_bootstrap.mjs` children of the CLI process, with `SESSION_ID` and `COPILOT_EXTENSION_PARENT_PID` set; the CLI's `index.js` imports `preloads/extension_bootstrap.mjs` before any session starts, which then imports `EXTENSION_PATH`.
- `data.db` timestamps are 24-character ISO strings ending in `Z`; `session.db` todo times use SQLite's `YYYY-MM-DD HH:MM:SS` (UTC). `session_automations.session_id` is a CLI session id.
- `chat_parent_links.parent_session_id` resolves through `workspace_session_aliases`. Two project sessions created by chat sessions have only `creator_session_id` (no parent link). The workspace tree is up to two levels deep.
- `worktrees.base_branch` is set for every live worktree. `workspace.yaml` always has `cwd`; `branch`, `host_type` (`ado` or `github`) and `repository` (`org/project/repo` or `owner/repo`) are present only in some sessions, so readers treat them as optional. The file lives in the session's state folder, so it outlasts a deleted worktree.
- Sub-agent events carry `data.parentToolCallId`, and newer ones also a top-level `agentId` (including sub-agent `session.usage_record` and prompt `user.message` lines). `subagent.started` maps that `agentId` to the `task` call.
- The `<cross_session_message>` envelope (fields `from_session_id`, `from_project_session_id`, `from_project_session_name`, `from_display_name`, `source_tool_call_id`, `requested_mode`) is only in `transformedContent`; `content` holds the body. Automation wakes are `user.message` with `source: "system"` and a `<session_automation>` block. `save_session_automation` arguments are `interval`, `every_minutes`, `prompt` and `clear`.
- `az` 2.71 with the azure-devops extension and `gh` 2.102 are installed. Process liveness uses the lock PID plus `ps -o pid=,lstart=`: a lock counts only when its PID started no later than the lock file was written, which rules out reused PIDs without the slower `lsof`.

### Builder decisions on the spec's open points (for the coordinator's OK)

These change what the user sees, so they are listed in the plan summary for approval.

1. **Status mapping (open point 11).** Each session gets a `statusDetail`, a display `status` (one of the eight colours) and a header `bucket`:

   | `statusDetail` | `status` | `bucket` |
   | --- | --- | --- |
   | `busy`, `slow_model_call` (model call 5–10 min) | busy | working |
   | `silent`, `stuck_model_call`, `stuck_tool`, `stuck_subagent`, `spinning`, `stalled` | stuck | stuck |
   | `waiting_question` | question | waiting |
   | `waiting_plan` | plan | waiting |
   | `blocked` (latest report says blocked), `blocked_on_orchestrator` (unanswered `needs_input`) | blocked | waiting |
   | `idle`, `stopped` (clean exit, not archived) | idle | idle |
   | `crashed`, `failed` | blocked | failed |
   | `merged` | merged | done |
   | `archived` | archived | done |

   Precedence: archived, failed, merged, stopped/crashed, waiting, stuck tool, stuck sub-agent, stuck model call, silent, spinning, slow model call, busy, then the idle-only report rules (blocked, blocked on the orchestrator, stalled), then idle.
2. **Spinning refinement (departs from design call 3; needs the coordinator's OK).** Replaying the design's rules over the real sessions on this machine flagged healthy PR monitors: a monitor repeats its routine check on every wake, and its short wakes add little busy time between compactions. Two checks are narrowed:
   - "Same tool and arguments 3+ times" counts identical calls in a row within one prompt. A new user message, automation wake or cross-session message starts a new run. Polling tools (`read_bash`, `read_agent`, `list_agents`, `list_bash`, `get_session`, `get_sessions_status`, `list_sessions_and_chats`, `get_session_automation`) are ignored, because orchestrators call them repeatedly by design. A test, edit, test loop is normal TDD, not spinning.
   - "2+ compactions" counts compactions in the busy window that also fall within the last 30 wall-clock minutes.
   Either narrowing can be dropped on its own: each is one line in `spinningReason` plus its test.
3. **Silent busy** does not fire while an open main tool still has its own time limit (bash with `initial_wait`, `read_bash`, `read_agent`) or while a sync sub-agent runs; those have their own rules.
4. **Stages (open point 12):** planned (plan entry without a session) → coding (no PR) → PR open (draft PR, or PR state unknown and no monitor yet) → in review (published PR, or PR state unknown and a monitor has run) → merged (PR merged or registry outcome `merged`) → archived (workspace archived). A closed or abandoned PR, or registry outcome `closed`/`failed`, sets `closedWithoutMerge`. Pre-PR steps from the reference run (tests paused for review, branch ready, preview ready) are coding; a draft PR is PR open.
5. **PR identity:** registry row → latest contract status line with `pr=` → the app's `created_pr_*` (GitHub) → for Azure DevOps units only, the most-mentioned PR in the unit's reports (`!12345`, `/pullrequest/12345`, `PR #12`), as the design's data notes allow. GitHub units get no mention heuristic: their reports also quote PRs of other repositories, and the app's columns hold their PR. A unit's code host and repository come from its `workspace.yaml` (`host_type`, `repository`), else from the project's GitHub columns. PR state comes from cached read-only `az repos pr show` / `gh pr view` (5-minute TTL; merged and closed are final), else from the app's columns, else unknown. A lookup passes `--organization` or `--repo` from that repository, so it still works after the unit's worktree is deleted; a PR with no known repository is looked up only from its worktree, and only while that exists.
6. **PRs waiting for him (open point 13):** only questions tagged `need=pr`; no guessing from untagged text.
7. **Report badge (open point 14):** `progress` is a valid `ReportStatus`; its colour is PR 2's choice. Untagged messages without `purpose` count as `progress` with source `message`.
8. **Monitor missing (open point 15):** a unit with an open PR (PR open or in review) and no automation is missing since its last check plus one interval, the time the monitor was cleared, or when the PR became known. An automation whose `next_run_at` is more than 5 minutes in the past is missing since `next_run_at`. Paused uses `paused_at`. Merged or archived units show ended (had a PR) or none.
9. **Plan without a registry (open point 17):** a todo maps to a unit when its title or description contains one of the unit's ids. Pending or blocked todos that are not mapped but are connected through `todo_deps` to a mapped todo become planned units. With a registry, `todo_id` decides.
10. **History store (open point 18):** `~/.copilot/swarm-dashboard/history/runs/<root-id>.json`, one `RunSummary` per run, written atomically (temp file and rename). It holds names, ids, times, counts, costs and models only.
11. **Several live swarms (open point 19):** `listSwarms()` lists them live first, then by last activity; `getSnapshot()` without an id returns the most recently active live swarm. The picker is PR 2's.
12. **Swarm roots:** every workspace with children and no parent, plus a chat session that is the parent of chat children or the creator of project sessions without a parent link. Units are all descendants at any depth, with `parentId` and `depth`.
13. **Unit labels:** registry `unit`; otherwise the first word of the session name that contains a digit, starts with a letter and is unique among siblings (for example `b1`), else the initials of its unique words, else `U<n>`. The orchestrator's label is the initials of its name.
14. **`activity_items` is not read.** Open `ask_user` and `exit_plan_mode` calls give exact, timestamped waits; activity items cannot tell when a question was answered.

## File Structure

All paths are under `ghcp/plugins/swarm-dashboard/` unless they start with `.github/` or `docs/`.

| File | Responsibility |
| --- | --- |
| `plugin.json`, `package.json`, `LICENSE` | Plugin manifest, npm scripts, MIT licence |
| `.github/plugin/marketplace.json` (repo root) | Marketplace entry for `swarm-dashboard` 0.1.0 |
| `scripts/validate-plugin.mjs` | Manifest and root-marketplace checks |
| `scripts/swarm-snapshot.mjs` | CLI: prints swarms, a snapshot, history or a run summary as JSON |
| `engine/schema.mjs` | Contract with PR 2: enums, JSDoc typedefs, engine API typedefs, strict validators |
| `engine/fake-engine.mjs` | In-memory engine serving fixtures, for PR 2 development and tests |
| `engine/time.mjs`, `engine/text.mjs` | Time parsing and formatting; one-line text helpers |
| `engine/config.mjs` | Default thresholds and Copilot paths |
| `engine/sqlite.mjs` | Read-only SQLite access: `node:sqlite` or `sqlite3` CLI, open policy |
| `engine/readers/app-db.mjs` | Named-column reads from `data.db` |
| `engine/readers/ledger.mjs` | Incremental cost ledger from `session-store.db` |
| `engine/readers/session-files.mjs` | `workspace.yaml`, lock files and per-session `session.db` |
| `engine/readers/process-probe.mjs` | Process liveness from lock files |
| `engine/readers/events.mjs` | `events.jsonl` tailing by byte offset |
| `engine/model/forest.mjs` | Session tree and swarm roots |
| `engine/model/contract.mjs` | Data-contract parsers (status line, report fields, question tags, registry) |
| `engine/model/session-state.mjs` | Reducer: folds one CLI session's events into compact state |
| `engine/model/messages.mjs` | Reducer part for messages, reports, automations and PR mentions |
| `engine/model/status.mjs` | Stuck detection and status mapping |
| `engine/model/stage.mjs` | PR identity, stage and monitor derivation |
| `engine/model/pr-lookup.mjs` | Cached read-only `gh`/`az` PR state |
| `engine/model/swarm.mjs` | Builds the snapshot from tree, states, ledger, registry and lookups |
| `engine/model/history.mjs` | Run lifecycle, run summaries and the history store |
| `engine/engine.mjs` | `createSwarmEngine()`: refresh, tracking, polling, subscriptions, history |
| `tests/helpers/*.mjs` | Temp dirs, SQLite writer, synthetic Copilot home, event log builder |
| `tests/fixtures/example-*.json` | Synthetic example snapshot, swarm list, history and run summary |
| `tests/*.test.mjs` | One test file per module, plus CLI and guard tests |

---

### Task 1: Plugin skeleton, validator and marketplace entry

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/plugin.json`
- Create: `ghcp/plugins/swarm-dashboard/package.json`
- Create: `ghcp/plugins/swarm-dashboard/LICENSE`
- Create: `ghcp/plugins/swarm-dashboard/scripts/validate-plugin.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/temp.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/validate-plugin.test.mjs`
- Modify: `.github/plugin/marketplace.json` (append one entry to `plugins`)

**Interfaces:**
- Consumes: nothing.
- Produces: `validatePlugin(root: string, repositoryRoot: string): Promise<string[]>`; `REQUIRED_FILES: string[]` (later tasks append to it); `tempDir(prefix?: string): string` (created dirs are removed at process exit).

- [ ] **Step 1: Write the temp-dir helper and the failing validator test**

`tests/helpers/temp.mjs`:

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Create a temporary directory that is removed when the test process exits. */
export function tempDir(prefix = 'swarm-dashboard-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
```

`tests/validate-plugin.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '../../..');

function sandbox() {
  const repo = tempDir('swarm-validate-');
  const root = path.join(repo, 'ghcp/plugins/swarm-dashboard');
  mkdirSync(path.dirname(root), { recursive: true });
  cpSync(pluginRoot, root, { recursive: true });
  mkdirSync(path.join(repo, '.github/plugin'), { recursive: true });
  cpSync(path.join(repositoryRoot, '.github/plugin/marketplace.json'), path.join(repo, '.github/plugin/marketplace.json'));
  return { repo, root };
}

test('the plugin passes validation against the root marketplace', async () => {
  assert.deepEqual(await validatePlugin(pluginRoot, repositoryRoot), []);
});

test('a marketplace version that differs from plugin.json is reported', async () => {
  const { repo, root } = sandbox();
  const file = path.join(repo, '.github/plugin/marketplace.json');
  const marketplace = JSON.parse(readFileSync(file, 'utf8'));
  marketplace.plugins.find(plugin => plugin.name === 'swarm-dashboard').version = '9.9.9';
  writeFileSync(file, JSON.stringify(marketplace));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.includes('must match plugin.json version')), errors.join('\n'));
});

test('a plugin-local marketplace manifest is rejected', async () => {
  const { repo, root } = sandbox();
  writeFileSync(path.join(root, 'marketplace.json'), '{}');
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.includes('plugin-local marketplace manifests are forbidden')), errors.join('\n'));
});

test('package dependencies are rejected', async () => {
  const { repo, root } = sandbox();
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.dependencies = { 'left-pad': '1.0.0' };
  writeFileSync(file, JSON.stringify(pkg));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('the plugin must not require package dependencies'), errors.join('\n'));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/validate-plugin.test.mjs`
Expected: FAIL with `Cannot find module '.../scripts/validate-plugin.mjs'`.

- [ ] **Step 3: Write the manifests, licence and validator**

`plugin.json`:

```json
{
  "name": "swarm-dashboard",
  "description": "Watch-only dashboard for agentic swarms in the GitHub Copilot app: sessions, sub-agents, cost, stuck detection and run history.",
  "version": "0.1.0",
  "author": {
    "name": "Nick Sologoub"
  },
  "license": "MIT",
  "keywords": [
    "dashboard",
    "agentic-swarm",
    "orchestration",
    "cost",
    "copilot-app"
  ],
  "category": "development"
}
```

`package.json`:

```json
{
  "name": "swarm-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate": "node scripts/validate-plugin.mjs"
  }
}
```

`LICENSE`: copy `ghcp/plugins/adr-authoring/LICENSE` byte for byte (`MIT License`, `Copyright (c) 2026 Nick Sologoub`):

```bash
cp ghcp/plugins/adr-authoring/LICENSE ghcp/plugins/swarm-dashboard/LICENSE
```

`scripts/validate-plugin.mjs`:

```js
#!/usr/bin/env node
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'swarm-dashboard';
export const REQUIRED_FILES = ['LICENSE', 'plugin.json', 'package.json', 'scripts/validate-plugin.mjs'];
const TEST_SCRIPT = 'node --test tests/*.test.mjs';
const VALIDATE_SCRIPT = 'node scripts/validate-plugin.mjs';

export async function validatePlugin(root, repositoryRoot) {
  root = path.resolve(root);
  const errors = [];

  async function json(file, base = root) {
    try {
      const value = JSON.parse(await readFile(path.join(base, file), 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${file}: expected a JSON object`);
        return {};
      }
      return value;
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      return {};
    }
  }

  const [manifest, pkg, marketplace] = await Promise.all([
    json('plugin.json'),
    json('package.json'),
    json('.github/plugin/marketplace.json', repositoryRoot),
  ]);
  if (manifest.name !== PLUGIN_NAME || pkg.name !== PLUGIN_NAME) errors.push(`plugin.json and package.json name must be ${PLUGIN_NAME}`);
  if (!/^[a-z0-9-]{1,64}$/.test(manifest.name ?? '')) errors.push('plugin.json name must be kebab-case and at most 64 characters');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) errors.push('plugin.json version must be semantic x.y.z');
  if (pkg.version !== manifest.version) errors.push('package.json version must match plugin.json version');
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) errors.push('plugin.json requires a description');
  if (manifest.license !== 'MIT') errors.push('plugin.json license must be MIT');
  for (const field of ['mcpServers', 'hooks']) {
    if (field in manifest) errors.push(`plugin.json must not declare ${field}`);
  }
  if (pkg.private !== true) errors.push('package.json must be private');
  if (pkg.type !== 'module') errors.push('package.json type must be module');
  if (pkg.engines?.node !== '>=18') errors.push('package.json must declare Node.js >=18');
  if (pkg.scripts?.test !== TEST_SCRIPT || pkg.scripts?.validate !== VALIDATE_SCRIPT) {
    errors.push('package.json must expose the test and validate commands');
  }
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
    errors.push('the plugin must not require package dependencies');
  }

  const entries = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.filter(entry => entry?.name === PLUGIN_NAME)
    : [];
  if (entries.length !== 1) errors.push(`root marketplace must contain exactly one ${PLUGIN_NAME} entry`);
  for (const entry of entries) {
    if (entry.version !== manifest.version) {
      errors.push(`root marketplace version ${entry.version} must match plugin.json version ${manifest.version}`);
    }
    if (typeof entry.source !== 'string' || path.resolve(repositoryRoot, entry.source) !== root) {
      errors.push('root marketplace source must resolve to this plugin directory');
    }
  }
  for (const file of ['marketplace.json', '.github/plugin/marketplace.json']) {
    try {
      await access(path.join(root, file));
      errors.push(`${file}: plugin-local marketplace manifests are forbidden`);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${file}: ${error.message}`);
    }
  }
  for (const file of REQUIRED_FILES) {
    try {
      await access(path.join(root, file));
    } catch {
      errors.push(`${file}: required file is missing`);
    }
  }
  return errors;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = await validatePlugin(root, path.resolve(root, '../../..'));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('Plugin validation passed: manifests, root marketplace entry and required files.');
  }
}
```

In `.github/plugin/marketplace.json`, append this object after the `adr-authoring` entry in `plugins`:

```json
    {
      "name": "swarm-dashboard",
      "description": "Watch-only dashboard for agentic swarms in the GitHub Copilot app: sessions, sub-agents, cost, stuck detection and run history.",
      "version": "0.1.0",
      "source": "./ghcp/plugins/swarm-dashboard",
      "author": {
        "name": "Nick Sologoub"
      },
      "license": "MIT",
      "category": "development",
      "keywords": [
        "dashboard",
        "agentic-swarm",
        "orchestration",
        "cost",
        "copilot-app"
      ]
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: 4 tests pass; `Plugin validation passed: manifests, root marketplace entry and required files.`

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate && cd ../adr-authoring && npm test && npm run validate`
Expected: both plugins pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard .github/plugin/marketplace.json
git commit -m "feat(swarm-dashboard): add plugin skeleton and marketplace entry"
```

### Task 2: Snapshot schema, engine API contract and example fixtures (PR 2 handoff)

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/schema.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/fake-engine.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/fixtures/example-snapshot.json`
- Create: `ghcp/plugins/swarm-dashboard/tests/fixtures/example-swarms.json`
- Create: `ghcp/plugins/swarm-dashboard/tests/fixtures/example-history.json`
- Create: `ghcp/plugins/swarm-dashboard/tests/fixtures/example-run-summary.json`
- Test: `ghcp/plugins/swarm-dashboard/tests/schema.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (the PR 2 contract; changes after this commit need the coordinator's OK): every exported constant below; `validateSnapshot(value): string[]`, `validateSwarmListItem(value): string[]`, `validateRunListItem(value): string[]`, `validateRunSummary(value): string[]` (empty array = valid; strict: unknown fields are errors); `createFakeEngine({ snapshots, swarms?, history?, summaries? }): SwarmEngine & { push(snapshot): void }`; the typedefs `Snapshot`, `SessionView`, `UnitView`, `SwarmListItem`, `RunListItem`, `RunSummary`, `EngineOptions`, `SwarmEngine`, `SnapshotChange`.

- [ ] **Step 1: Write the failing schema test**

`tests/schema.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  COUNT_BUCKETS, DISPLAY_STATES, SCHEMA_VERSION,
  validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem,
} from '../engine/schema.mjs';
import { createFakeEngine } from '../engine/fake-engine.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('the example snapshot matches the schema', () => {
  const snapshot = fixture('example-snapshot.json');
  assert.equal(snapshot.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validateSnapshot(snapshot), []);
});

test('the example swarm list, history and run summary match the schema', () => {
  assert.deepEqual(fixture('example-swarms.json').flatMap(validateSwarmListItem), []);
  assert.deepEqual(fixture('example-history.json').flatMap(validateRunListItem), []);
  assert.deepEqual(validateRunSummary(fixture('example-run-summary.json')), []);
});

test('the example snapshot shows the main states and consistent counts', () => {
  const snapshot = fixture('example-snapshot.json');
  const shown = new Set([snapshot.orchestrator, ...snapshot.units].map(session => session.status));
  for (const state of DISPLAY_STATES) assert.ok(shown.has(state), `example lacks state ${state}`);
  const expected = Object.fromEntries(COUNT_BUCKETS.map(bucket => [bucket, snapshot.units.filter(unit => unit.bucket === bucket).length]));
  assert.deepEqual(snapshot.counts, expected);
  const total = [snapshot.orchestrator, ...snapshot.units].reduce((sum, session) => sum + session.cost.credits, 0);
  assert.equal(Math.round(total * 10) / 10, snapshot.cost.credits);
});

test('the validator reports missing, unexpected and invalid fields with their paths', () => {
  const snapshot = fixture('example-snapshot.json');
  delete snapshot.units[0].stage;
  snapshot.units[1].extra = true;
  snapshot.units[2].status = 'sleeping';
  snapshot.cost.series[0].at = 'yesterday';
  snapshot.needs[0].since = 1.5;
  const errors = validateSnapshot(snapshot);
  assert.ok(errors.includes('snapshot.units[0].stage: missing'), errors.join('\n'));
  assert.ok(errors.includes('snapshot.units[1].extra: unexpected field'), errors.join('\n'));
  assert.ok(errors.some(error => error.startsWith('snapshot.units[2].status: expected one of busy')), errors.join('\n'));
  assert.ok(errors.some(error => error.startsWith('snapshot.cost.series[0].at: invalid value')), errors.join('\n'));
  assert.ok(errors.some(error => error.startsWith('snapshot.needs[0].since: invalid value')), errors.join('\n'));
});

test('the fake engine serves fixtures through the engine API', async () => {
  const snapshot = fixture('example-snapshot.json');
  const history = fixture('example-history.json');
  const summary = fixture('example-run-summary.json');
  const engine = createFakeEngine({ snapshots: [snapshot], swarms: fixture('example-swarms.json'), history, summaries: [summary] });
  assert.equal(engine.listSwarms()[0].id, snapshot.run.id);
  assert.deepEqual(await engine.getSnapshot(), snapshot);
  assert.deepEqual(await engine.getSnapshot(snapshot.run.id), snapshot);
  assert.equal(await engine.getSnapshot('missing'), null);
  const changes = [];
  const unsubscribe = engine.subscribe(change => changes.push(change));
  engine.push({ ...snapshot, revision: snapshot.revision + 1 });
  unsubscribe();
  engine.push(snapshot);
  assert.deepEqual(changes, [{ revision: 1, swarmIds: [snapshot.run.id] }]);
  assert.equal((await engine.listHistory()).length, history.length);
  assert.equal((await engine.getRunSummary(summary.id)).id, summary.id);
  assert.equal(await engine.getRunSummary('missing'), null);
  assert.deepEqual(engine.diagnostics(), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/schema.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/schema.mjs'`.

- [ ] **Step 3: Write `engine/schema.mjs`, part 1 (constants and typedefs)**

```js
/**
 * Snapshot contract between the swarm data engine (PR 1) and the dashboard server and UI (PR 2).
 *
 * - Times are epoch milliseconds (UTC). Durations are milliseconds.
 * - Credits are AI credits: nano-AIU / 1e9. Dollars = credits × CREDIT_USD (list price).
 * - Free text (report bodies, questions, feed text) is for local display only. It never reaches the history store.
 * - Any breaking change bumps SCHEMA_VERSION and needs the coordinator's approval, because PR 2 depends on it.
 */
export const SCHEMA_VERSION = 1;
export const CREDIT_USD = 0.01;
export const NANO_AIU_PER_CREDIT = 1e9;

export const DISPLAY_STATES = Object.freeze(['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'archived']);
export const STATUS_DETAILS = Object.freeze([
  'busy', 'slow_model_call',
  'silent', 'stuck_model_call', 'stuck_tool', 'stuck_subagent', 'spinning', 'stalled',
  'waiting_question', 'waiting_plan',
  'blocked', 'blocked_on_orchestrator',
  'idle', 'stopped',
  'crashed', 'failed',
  'merged', 'archived',
]);
export const COUNT_BUCKETS = Object.freeze(['working', 'stuck', 'waiting', 'idle', 'done', 'failed']);
export const STAGES = Object.freeze(['planned', 'coding', 'pr_open', 'in_review', 'merged', 'archived']);
export const REPORT_STATUSES = Object.freeze(['complete', 'progress', 'needs_input', 'blocked']);
export const REPORT_SOURCES = Object.freeze(['contract', 'purpose', 'message', 'task_complete']);
export const NEED_KINDS = Object.freeze(['question', 'plan', 'pr']);
export const MONITOR_STATES = Object.freeze(['none', 'alive', 'missing', 'paused', 'ended']);
export const PR_PROVIDERS = Object.freeze(['ado', 'github']);
export const PR_STATES = Object.freeze(['draft', 'open', 'merged', 'closed', 'unknown']);
export const PR_SOURCES = Object.freeze(['registry', 'status_line', 'app', 'heuristic']);
export const OUTCOMES = Object.freeze(['merged', 'closed', 'failed']);
export const SEGMENT_STATES = Object.freeze(['busy', 'idle', 'plan', 'question', 'stuck']);
export const MARK_KINDS = Object.freeze(['report', 'question', 'answer', 'plan-req', 'plan-ok', 'pr-open', 'pr-comment', 'pr-merged', 'archived', 'tool', 'monitor']);
export const SUBAGENT_STATUSES = Object.freeze(['running', 'completed', 'failed', 'stuck']);
export const SUBAGENT_MODES = Object.freeze(['sync', 'background']);
export const SESSION_KINDS = Object.freeze(['project', 'chat']);
export const LIFECYCLES = Object.freeze(['live', 'finished']);
export const FEED_KINDS = Object.freeze([
  'report', 'question', 'answer', 'plan-req', 'plan-ok', 'subagent-start', 'subagent-done', 'task-complete',
  'monitor-check', 'monitor-set', 'monitor-cleared', 'pr', 'archived', 'abort', 'error', 'compaction',
]);
export const DIAGNOSTIC_LEVELS = Object.freeze(['info', 'warn']);

/**
 * @typedef {number} EpochMs
 * @typedef {{ id: string, name: string, summary: string, startedAt: EpochMs, limitMs: number|null }} ToolCallView
 *   The open tool call; `limitMs` is the stuck limit for this call, or null when no tool rule applies.
 * @typedef {{ status: 'complete'|'progress'|'needs_input'|'blocked', source: 'contract'|'purpose'|'message'|'task_complete',
 *   at: EpochMs, title: string, summary: string|null, evidence: string[], blockers: string[]|null, body: string|null,
 *   unit: string|null, commit: string|null }} ReportView
 *   `blockers` is null when the report has no Blockers field and [] for "Blockers: none". `body` is free text outside the fields.
 * @typedef {{ id: string, name: string, type: string, model: string|null, mode: 'sync'|'background',
 *   status: 'running'|'completed'|'failed'|'stuck', startedAt: EpochMs, endedAt: EpochMs|null, durationMs: number|null,
 *   credits: number, task: string|null }} SubagentView
 * @typedef {{ start: EpochMs, end: EpochMs|null, state: 'busy'|'idle'|'plan'|'question'|'stuck' }} Segment  end null = ongoing
 * @typedef {{ id: string, start: EpochMs, end: EpochMs|null, type: string }} SubagentBar
 * @typedef {{ at: EpochMs, kind: string, text: string, status: string|null }} Mark  kind is one of MARK_KINDS
 * @typedef {{ segments: Segment[], subagents: SubagentBar[], marks: Mark[] }} Timeline
 *
 * @typedef {object} SessionView  Shared by the orchestrator and every unit.
 * @property {string} id                 Node id: workspace id for project sessions, CLI session id for chats
 * @property {'project'|'chat'} kind
 * @property {string} label              Short label for rings (registry unit label, or derived)
 * @property {string} name
 * @property {string[]} cliSessionIds    Oldest first; the last one is current
 * @property {string|null} branch
 * @property {string|null} model
 * @property {string} status             One of DISPLAY_STATES (colour)
 * @property {string} statusDetail       One of STATUS_DETAILS (detector result)
 * @property {string} bucket             One of COUNT_BUCKETS (header count)
 * @property {EpochMs} since             Start of the current state (for stuck: start of the silence)
 * @property {string|null} reason        Why it is stuck, blocked, stalled or failed: the rule and its numbers
 * @property {EpochMs} startedAt
 * @property {EpochMs|null} endedAt      Archive time, or last event once the process has ended
 * @property {EpochMs|null} lastEventAt
 * @property {number} busyMs             Sum of main-agent turns, including waits on the user
 * @property {number} waitingOnUserMs    Time inside open ask_user and exit_plan_mode calls
 * @property {boolean|null} alive        Process liveness; null when unknown
 * @property {{ credits: number, calls: number }} cost   Sub-agent costs are included
 * @property {{ label: string, tool: ToolCallView|null, lastEventAt: EpochMs|null }} activity
 * @property {ReportView|null} report    Latest report to its parent (always null for the orchestrator)
 * @property {{ done: number, total: number }|null} progress  Own todos; null when it keeps none
 * @property {SubagentView[]} subagents  Running first, then latest first
 * @property {Timeline} timeline
 *
 * @typedef {SessionView & {
 *   parentId: string, depth: number, stage: string, closedWithoutMerge: boolean, outcome: 'merged'|'closed'|'failed'|null,
 *   pr: PrView|null, monitor: MonitorView, dependsOn: string|null, todoId: string|null }} UnitView
 *   `dependsOn` is the label of the unit or planned entry it stacks on.
 * @typedef {{ provider: 'ado'|'github', id: number, repo: string|null, url: string|null, title: string|null,
 *   state: 'draft'|'open'|'merged'|'closed'|'unknown', openedAt: EpochMs|null, mergedAt: EpochMs|null, closedAt: EpochMs|null,
 *   reviewNote: string|null, source: 'registry'|'status_line'|'app'|'heuristic', checkedAt: EpochMs|null }} PrView
 * @typedef {{ state: 'none'|'alive'|'missing'|'paused'|'ended', lastCheckAt: EpochMs|null, nextCheckAt: EpochMs|null,
 *   everyMinutes: number|null, since: EpochMs|null }} MonitorView  `since` is set for missing and paused
 * @typedef {{ label: string, name: string, dependsOn: string|null, canStart: boolean, waitsOn: string|null, todoId: string|null }} PlannedUnit
 * @typedef {{ kind: 'question'|'plan'|'pr', unitIds: string[], labels: string[], fromId: string, text: string,
 *   since: EpochMs, tagged: boolean }} NeedItem  unitIds empty = the whole swarm
 * @typedef {{ at: EpochMs, unitId: string, label: string, kind: string, text: string }} FeedItem  kind is one of FEED_KINDS
 * @typedef {{ level: 'info'|'warn', source: string, message: string }} Diagnostic
 *
 * @typedef {object} Snapshot
 * @property {1} schemaVersion
 * @property {EpochMs} generatedAt
 * @property {number} revision           Per-swarm counter; increases whenever the content changes
 * @property {{ id: string, name: string, project: {id: string, name: string}|null, startedAt: EpochMs, firstChildAt: EpochMs|null,
 *   lastActivityAt: EpochMs, lifecycle: 'live'|'finished', finishedAt: EpochMs|null, stalled: {since: EpochMs, reason: string}|null,
 *   contract: { registry: boolean, statusLines: boolean, questionTags: boolean } }} run
 * @property {SessionView} orchestrator
 * @property {UnitView[]} units          Every descendant session, depth-first by creation time
 * @property {PlannedUnit[]} planned
 * @property {NeedItem[]} needs          Longest wait first
 * @property {FeedItem[]} feed           Latest first, at most 200
 * @property {{ working: number, stuck: number, waiting: number, idle: number, done: number, failed: number }} counts  Units only
 * @property {{ credits: number, usd: number, maxUnitCredits: number,
 *   byModel: { model: string, credits: number, calls: number, apiMs: number }[],
 *   series: { at: EpochMs, credits: number }[] }} cost  series: cumulative credits at 5-minute bucket starts
 * @property {Diagnostic[]} diagnostics
 *
 * @typedef {{ id: string, name: string, project: {id: string, name: string}|null, startedAt: EpochMs, lastActivityAt: EpochMs,
 *   lifecycle: 'live'|'finished', units: number, credits: number, alive: boolean }} SwarmListItem
 * @typedef {{ id: string, name: string, project: {id: string, name: string}|null, startedAt: EpochMs, finishedAt: EpochMs|null,
 *   tookMs: number|null, busyMs: number|null, credits: number, usd: number, children: number, merged: number|null,
 *   summarized: boolean }} RunListItem  summarized false = cheap entry; getRunSummary() computes the full summary
 * @typedef {{ id: string, label: string, name: string, isOrchestrator: boolean, startedAt: EpochMs, endedAt: EpochMs|null,
 *   busyMs: number, credits: number, outcome: 'merged'|'closed'|'failed'|null, merged: boolean }} RunUnit
 * @typedef {object} RunSummary
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} name
 * @property {{id: string, name: string}|null} project
 * @property {EpochMs} startedAt         Creation of the root session (includes any analysis phase)
 * @property {EpochMs|null} firstChildAt
 * @property {EpochMs} finishedAt        Last activity in the run
 * @property {number} tookMs
 * @property {number} busyMs             Sum over all sessions
 * @property {number} waitingOnUserMs    Union of waits on the user across sessions
 * @property {number} credits
 * @property {number} usd
 * @property {{ total: number, merged: number, closed: number, failed: number, noOutcome: number }} children  noOutcome: still active, or ended with no PR result known
 * @property {number} subagents
 * @property {RunUnit[]} units           Orchestrator first
 * @property {{ model: string, credits: number, calls: number, apiMs: number }[]} models
 * @property {{ type: string, runs: number, durationMs: number, credits: number }[]} subagentTypes
 * @property {EpochMs} computedAt
 *
 * @typedef {object} EngineOptions
 * @property {string} [copilotHome]       Default ~/.copilot
 * @property {string} [historyDir]        Default <copilotHome>/swarm-dashboard/history
 * @property {boolean} [persistHistory]   Write summaries of finished runs. Default true
 * @property {() => number} [now]         Clock. Default Date.now
 * @property {object} [thresholds]        Overrides for DEFAULT_THRESHOLDS in engine/config.mjs
 * @property {'auto'|'node'|'cli'} [sqlite]  Default 'auto'
 * @property {'auto'|'off'|object} [prLookup]  Read-only gh/az PR lookups. Default 'auto'
 * @property {(entry: Diagnostic) => void} [log]  Never writes to stdout
 *
 * @typedef {{ revision: number, swarmIds: string[] }} SnapshotChange
 * @typedef {object} SwarmEngine
 * @property {() => Promise<void>} refresh                 Read new data once and rebuild tracked swarms
 * @property {(options?: { intervalMs?: number }) => void} start  Poll every intervalMs (default 3000); no timers before this
 * @property {() => void} stop
 * @property {() => SwarmListItem[]} listSwarms             Live first, then by last activity
 * @property {(swarmId?: string) => Promise<Snapshot|null>} getSnapshot  Default: most recently active live swarm
 * @property {(listener: (change: SnapshotChange) => void) => () => void} subscribe  Returns unsubscribe
 * @property {() => Promise<RunListItem[]>} listHistory
 * @property {(runId: string) => Promise<RunSummary|null>} getRunSummary
 * @property {() => Diagnostic[]} diagnostics
 */
```

- [ ] **Step 4: Write `engine/schema.mjs`, part 2 (strict validators)** — append to the same file:

```js
const KIND = Symbol('kind');
const nullable = spec => ({ [KIND]: 'nullable', spec });
const arrayOf = spec => ({ [KIND]: 'array', spec });
const oneOf = values => ({ [KIND]: 'enum', values });
const literal = value => ({ [KIND]: 'literal', value });
const is = {
  text: value => typeof value === 'string',
  id: value => typeof value === 'string' && value.length > 0,
  number: value => typeof value === 'number' && Number.isFinite(value),
  count: value => Number.isInteger(value) && value >= 0,
  time: value => Number.isInteger(value) && value > 0,
  bool: value => typeof value === 'boolean',
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function preview(value) {
  try {
    return JSON.stringify(value)?.slice(0, 60) ?? String(value);
  } catch {
    return String(value);
  }
}

function check(value, spec, path, errors) {
  if (typeof spec === 'function') {
    if (!spec(value)) errors.push(`${path}: invalid value ${preview(value)}`);
    return;
  }
  switch (spec[KIND]) {
    case 'nullable':
      if (value !== null) check(value, spec.spec, path, errors);
      return;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path}: expected an array`);
      else value.forEach((item, index) => check(item, spec.spec, `${path}[${index}]`, errors));
      return;
    case 'enum':
      if (!spec.values.includes(value)) errors.push(`${path}: expected one of ${spec.values.join(', ')}, got ${preview(value)}`);
      return;
    case 'literal':
      if (value !== spec.value) errors.push(`${path}: expected ${preview(spec.value)}, got ${preview(value)}`);
      return;
    default:
      break;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  for (const key of Object.keys(spec)) {
    if (!own(value, key)) errors.push(`${path}.${key}: missing`);
    else check(value[key], spec[key], `${path}.${key}`, errors);
  }
  for (const key of Object.keys(value)) if (!own(spec, key)) errors.push(`${path}.${key}: unexpected field`);
}

const TIME = is.time;
const OPT_TIME = nullable(is.time);
const OPT_TEXT = nullable(is.text);
const PROJECT = nullable({ id: is.id, name: is.text });
const TOOL_CALL = { id: is.id, name: is.id, summary: is.text, startedAt: TIME, limitMs: nullable(is.count) };
const REPORT = {
  status: oneOf(REPORT_STATUSES), source: oneOf(REPORT_SOURCES), at: TIME, title: is.text,
  summary: OPT_TEXT, evidence: arrayOf(is.text), blockers: nullable(arrayOf(is.text)), body: OPT_TEXT,
  unit: OPT_TEXT, commit: OPT_TEXT,
};
const SUBAGENT = {
  id: is.id, name: is.text, type: is.text, model: OPT_TEXT, mode: oneOf(SUBAGENT_MODES), status: oneOf(SUBAGENT_STATUSES),
  startedAt: TIME, endedAt: OPT_TIME, durationMs: nullable(is.count), credits: is.number, task: OPT_TEXT,
};
const TIMELINE = {
  segments: arrayOf({ start: TIME, end: OPT_TIME, state: oneOf(SEGMENT_STATES) }),
  subagents: arrayOf({ id: is.id, start: TIME, end: OPT_TIME, type: is.text }),
  marks: arrayOf({ at: TIME, kind: oneOf(MARK_KINDS), text: is.text, status: nullable(oneOf(REPORT_STATUSES)) }),
};
const SESSION = {
  id: is.id, kind: oneOf(SESSION_KINDS), label: is.id, name: is.text, cliSessionIds: arrayOf(is.id),
  branch: OPT_TEXT, model: OPT_TEXT,
  status: oneOf(DISPLAY_STATES), statusDetail: oneOf(STATUS_DETAILS), bucket: oneOf(COUNT_BUCKETS), since: TIME, reason: OPT_TEXT,
  startedAt: TIME, endedAt: OPT_TIME, lastEventAt: OPT_TIME, busyMs: is.count, waitingOnUserMs: is.count, alive: nullable(is.bool),
  cost: { credits: is.number, calls: is.count },
  activity: { label: is.text, tool: nullable(TOOL_CALL), lastEventAt: OPT_TIME },
  report: nullable(REPORT),
  progress: nullable({ done: is.count, total: is.count }),
  subagents: arrayOf(SUBAGENT),
  timeline: TIMELINE,
};
const PR = {
  provider: oneOf(PR_PROVIDERS), id: is.count, repo: OPT_TEXT, url: OPT_TEXT, title: OPT_TEXT, state: oneOf(PR_STATES),
  openedAt: OPT_TIME, mergedAt: OPT_TIME, closedAt: OPT_TIME, reviewNote: OPT_TEXT, source: oneOf(PR_SOURCES), checkedAt: OPT_TIME,
};
const UNIT = {
  ...SESSION,
  parentId: is.id, depth: is.count, stage: oneOf(STAGES), closedWithoutMerge: is.bool, outcome: nullable(oneOf(OUTCOMES)),
  pr: nullable(PR),
  monitor: { state: oneOf(MONITOR_STATES), lastCheckAt: OPT_TIME, nextCheckAt: OPT_TIME, everyMinutes: nullable(is.count), since: OPT_TIME },
  dependsOn: OPT_TEXT, todoId: OPT_TEXT,
};
const MODEL_COST = { model: is.id, credits: is.number, calls: is.count, apiMs: is.count };

export const SNAPSHOT_SPEC = Object.freeze({
  schemaVersion: literal(SCHEMA_VERSION), generatedAt: TIME, revision: is.count,
  run: {
    id: is.id, name: is.text, project: PROJECT, startedAt: TIME, firstChildAt: OPT_TIME, lastActivityAt: TIME,
    lifecycle: oneOf(LIFECYCLES), finishedAt: OPT_TIME, stalled: nullable({ since: TIME, reason: is.text }),
    contract: { registry: is.bool, statusLines: is.bool, questionTags: is.bool },
  },
  orchestrator: SESSION,
  units: arrayOf(UNIT),
  planned: arrayOf({ label: is.id, name: is.text, dependsOn: OPT_TEXT, canStart: is.bool, waitsOn: OPT_TEXT, todoId: OPT_TEXT }),
  needs: arrayOf({ kind: oneOf(NEED_KINDS), unitIds: arrayOf(is.id), labels: arrayOf(is.id), fromId: is.id, text: is.text, since: TIME, tagged: is.bool }),
  feed: arrayOf({ at: TIME, unitId: is.id, label: is.id, kind: oneOf(FEED_KINDS), text: is.text }),
  counts: Object.fromEntries(COUNT_BUCKETS.map(bucket => [bucket, is.count])),
  cost: { credits: is.number, usd: is.number, maxUnitCredits: is.number, byModel: arrayOf(MODEL_COST), series: arrayOf({ at: TIME, credits: is.number }) },
  diagnostics: arrayOf({ level: oneOf(DIAGNOSTIC_LEVELS), source: is.id, message: is.text }),
});
export const SWARM_LIST_ITEM_SPEC = Object.freeze({
  id: is.id, name: is.text, project: PROJECT, startedAt: TIME, lastActivityAt: TIME, lifecycle: oneOf(LIFECYCLES),
  units: is.count, credits: is.number, alive: is.bool,
});
export const RUN_LIST_ITEM_SPEC = Object.freeze({
  id: is.id, name: is.text, project: PROJECT, startedAt: TIME, finishedAt: OPT_TIME, tookMs: nullable(is.count),
  busyMs: nullable(is.count), credits: is.number, usd: is.number, children: is.count, merged: nullable(is.count), summarized: is.bool,
});
export const RUN_SUMMARY_SPEC = Object.freeze({
  schemaVersion: literal(SCHEMA_VERSION), id: is.id, name: is.text, project: PROJECT,
  startedAt: TIME, firstChildAt: OPT_TIME, finishedAt: TIME, tookMs: is.count, busyMs: is.count, waitingOnUserMs: is.count,
  credits: is.number, usd: is.number,
  children: { total: is.count, merged: is.count, closed: is.count, failed: is.count, noOutcome: is.count },
  subagents: is.count,
  units: arrayOf({
    id: is.id, label: is.id, name: is.text, isOrchestrator: is.bool, startedAt: TIME, endedAt: OPT_TIME,
    busyMs: is.count, credits: is.number, outcome: nullable(oneOf(OUTCOMES)), merged: is.bool,
  }),
  models: arrayOf(MODEL_COST),
  subagentTypes: arrayOf({ type: is.id, runs: is.count, durationMs: is.count, credits: is.number }),
  computedAt: TIME,
});

const validator = (spec, root) => value => {
  const errors = [];
  check(value, spec, root, errors);
  return errors;
};
export const validateSnapshot = validator(SNAPSHOT_SPEC, 'snapshot');
export const validateSwarmListItem = validator(SWARM_LIST_ITEM_SPEC, 'swarm');
export const validateRunListItem = validator(RUN_LIST_ITEM_SPEC, 'run');
export const validateRunSummary = validator(RUN_SUMMARY_SPEC, 'summary');
```

- [ ] **Step 5: Write `engine/fake-engine.mjs`**

```js
/**
 * In-memory SwarmEngine for server and UI development and tests. It serves fixed snapshots and history
 * through the same API as createSwarmEngine() and never reads Copilot data.
 */
export function createFakeEngine({ snapshots = [], swarms = null, history = [], summaries = [] } = {}) {
  const byId = new Map(snapshots.map(snapshot => [snapshot.run.id, structuredClone(snapshot)]));
  const list = swarms ?? snapshots.map(snapshot => ({
    id: snapshot.run.id, name: snapshot.run.name, project: snapshot.run.project, startedAt: snapshot.run.startedAt,
    lastActivityAt: snapshot.run.lastActivityAt, lifecycle: snapshot.run.lifecycle, units: snapshot.units.length,
    credits: snapshot.cost.credits, alive: snapshot.run.lifecycle === 'live',
  }));
  const listeners = new Set();
  let revision = 0;
  return {
    async refresh() {},
    start() {},
    stop() {},
    listSwarms: () => structuredClone(list),
    async getSnapshot(swarmId) {
      const id = swarmId ?? list.find(swarm => swarm.lifecycle === 'live')?.id ?? list[0]?.id;
      return byId.has(id) ? structuredClone(byId.get(id)) : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listHistory() {
      return structuredClone(history);
    },
    async getRunSummary(runId) {
      const summary = summaries.find(item => item.id === runId);
      return summary ? structuredClone(summary) : null;
    },
    diagnostics: () => [],
    /** Replace one snapshot and notify subscribers, as a real refresh would. */
    push(snapshot) {
      byId.set(snapshot.run.id, structuredClone(snapshot));
      revision += 1;
      for (const listener of listeners) listener({ revision, swarmIds: [snapshot.run.id] });
    },
  };
}
```

- [ ] **Step 6: Write the synthetic example fixtures**

All ids, names, repositories and times are invented. `generatedAt` is 2026-10-15T12:00:00Z. The snapshot shows every display state: question (orchestrator), archived (B0), merged (F2a), busy (B1), plan (B2), stuck (I1), blocked (F1) and idle (D5).

`tests/fixtures/example-snapshot.json` (first half; the second half follows in Step 7 inside the same `units` array):

```json
{
  "schemaVersion": 1,
  "generatedAt": 1792065600000,
  "revision": 42,
  "run": {
    "id": "ws-0000-root",
    "name": "Sample story B",
    "project": { "id": "project-0001", "name": "sample-project" },
    "startedAt": 1791809280000,
    "firstChildAt": 1791814200000,
    "lastActivityAt": 1792065540000,
    "lifecycle": "live",
    "finishedAt": null,
    "stalled": null,
    "contract": { "registry": true, "statusLines": true, "questionTags": true }
  },
  "orchestrator": {
    "id": "ws-0000-root", "kind": "project", "label": "SB", "name": "Sample story B",
    "cliSessionIds": ["cli-0000-analysis", "cli-0000-root"], "branch": "main", "model": "claude-opus-4.8",
    "status": "question", "statusDetail": "waiting_question", "bucket": "waiting", "since": 1792064100000, "reason": null,
    "startedAt": 1791809280000, "endedAt": null, "lastEventAt": 1792065540000,
    "busyMs": 69840000, "waitingOnUserMs": 27600000, "alive": true,
    "cost": { "credits": 31532.4, "calls": 1540 },
    "activity": { "label": "Waiting for an answer", "tool": null, "lastEventAt": 1792065540000 },
    "report": null,
    "progress": { "done": 18, "total": 24 },
    "subagents": [
      { "id": "call-root-41", "name": "map-import-module", "type": "explore", "model": "gpt-5.4-mini", "mode": "background", "status": "running", "startedAt": 1792065360000, "endedAt": null, "durationMs": null, "credits": 51.0, "task": "Map the import module" },
      { "id": "call-root-40", "name": "table-research", "type": "research", "model": "claude-sonnet-5", "mode": "background", "status": "running", "startedAt": 1792065060000, "endedAt": null, "durationMs": null, "credits": 102.0, "task": "DataGrid or a new table" }
    ],
    "timeline": {
      "segments": [
        { "start": 1791809280000, "end": 1791850200000, "state": "busy" },
        { "start": 1791850200000, "end": 1792062000000, "state": "idle" },
        { "start": 1792062000000, "end": 1792064100000, "state": "busy" },
        { "start": 1792064100000, "end": null, "state": "question" }
      ],
      "subagents": [
        { "id": "call-root-40", "start": 1792065060000, "end": null, "type": "research" },
        { "id": "call-root-41", "start": 1792065360000, "end": null, "type": "explore" }
      ],
      "marks": [
        { "at": 1792064100000, "kind": "question", "text": "Publish PR #421 for review?", "status": null }
      ]
    }
  },
  "units": [
    {
      "id": "ws-0001-b0", "kind": "project", "label": "B0", "name": "schema",
      "cliSessionIds": ["cli-0001-b0"], "branch": "feature/b0-schema", "model": "claude-sonnet-5",
      "status": "archived", "statusDetail": "archived", "bucket": "done", "since": 1791964200000, "reason": null,
      "startedAt": 1791814200000, "endedAt": 1791964200000, "lastEventAt": 1791964200000,
      "busyMs": 18000000, "waitingOnUserMs": 0, "alive": false,
      "cost": { "credits": 10912.0, "calls": 820 },
      "activity": { "label": "Archived", "tool": null, "lastEventAt": 1791964200000 },
      "report": { "status": "complete", "source": "contract", "at": 1791963600000, "title": "Schema v3 merged in PR #412. The migration was tested on a copy of staging.", "summary": "Schema v3 merged in PR #412. The migration was tested on a copy of staging.", "evidence": ["Migration ran on a staging copy in 4 min", "PR #412 merged after 2 approvals"], "blockers": [], "body": null, "unit": "B0", "commit": "3f9a2c1" },
      "progress": { "done": 12, "total": 12 },
      "subagents": [
        { "id": "call-b0-7", "name": "staging-run", "type": "task", "model": "claude-haiku-5.5", "mode": "background", "status": "completed", "startedAt": 1791927600000, "endedAt": 1791927840000, "durationMs": 240000, "credits": 260.0, "task": "Run the migration on a staging copy" }
      ],
      "timeline": {
        "segments": [
          { "start": 1791814200000, "end": 1791850200000, "state": "busy" },
          { "start": 1791850200000, "end": 1791964200000, "state": "idle" }
        ],
        "subagents": [{ "id": "call-b0-7", "start": 1791927600000, "end": 1791927840000, "type": "task" }],
        "marks": [
          { "at": 1791939600000, "kind": "pr-open", "text": "PR opened", "status": null },
          { "at": 1791963600000, "kind": "report", "text": "Schema v3 merged in PR #412.", "status": "complete" },
          { "at": 1791963600000, "kind": "pr-merged", "text": "PR merged", "status": null },
          { "at": 1791964200000, "kind": "archived", "text": "Archived", "status": null }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "archived", "closedWithoutMerge": false, "outcome": "merged",
      "pr": { "provider": "github", "id": 412, "repo": "sample-org/sample-repo", "url": "https://github.com/sample-org/sample-repo/pull/412", "title": "Schema v3 migration", "state": "merged", "openedAt": 1791939600000, "mergedAt": 1791963600000, "closedAt": 1791963600000, "reviewNote": "approved", "source": "registry", "checkedAt": 1792065300000 },
      "monitor": { "state": "ended", "lastCheckAt": 1791963000000, "nextCheckAt": null, "everyMinutes": 10, "since": null },
      "dependsOn": null, "todoId": "b0-schema"
    },
    {
      "id": "ws-0002-f2a", "kind": "project", "label": "F2a", "name": "tests, part 1",
      "cliSessionIds": ["cli-0002-f2a"], "branch": "feature/f2a-tests", "model": "claude-haiku-5.5",
      "status": "merged", "statusDetail": "merged", "bucket": "done", "since": 1791936000000, "reason": null,
      "startedAt": 1791850200000, "endedAt": null, "lastEventAt": 1791936600000,
      "busyMs": 10800000, "waitingOnUserMs": 0, "alive": true,
      "cost": { "credits": 4312.0, "calls": 300 },
      "activity": { "label": "Done. PR merged", "tool": null, "lastEventAt": 1791936600000 },
      "report": { "status": "complete", "source": "contract", "at": 1791936000000, "title": "Part 1 of the test harness merged in PR #409.", "summary": "Part 1 of the test harness merged in PR #409.", "evidence": ["PR #409 merged"], "blockers": [], "body": null, "unit": "F2a", "commit": null },
      "progress": { "done": 6, "total": 6 },
      "subagents": [],
      "timeline": {
        "segments": [
          { "start": 1791850200000, "end": 1791861000000, "state": "busy" },
          { "start": 1791861000000, "end": null, "state": "idle" }
        ],
        "subagents": [],
        "marks": [
          { "at": 1791907200000, "kind": "pr-open", "text": "PR opened", "status": null },
          { "at": 1791936000000, "kind": "report", "text": "Part 1 of the test harness merged in PR #409.", "status": "complete" },
          { "at": 1791936000000, "kind": "pr-merged", "text": "PR merged", "status": null }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "merged", "closedWithoutMerge": false, "outcome": "merged",
      "pr": { "provider": "github", "id": 409, "repo": "sample-org/sample-repo", "url": "https://github.com/sample-org/sample-repo/pull/409", "title": "Test harness, part 1", "state": "merged", "openedAt": 1791907200000, "mergedAt": 1791936000000, "closedAt": 1791936000000, "reviewNote": "approved", "source": "registry", "checkedAt": 1792065300000 },
      "monitor": { "state": "ended", "lastCheckAt": 1791935400000, "nextCheckAt": null, "everyMinutes": 10, "since": null },
      "dependsOn": "B0", "todoId": "f2a-tests"
    },
    {
      "id": "ws-0003-b1", "kind": "project", "label": "B1", "name": "API",
      "cliSessionIds": ["cli-0003-b1"], "branch": "feature/b1-api", "model": "claude-sonnet-5",
      "status": "busy", "statusDetail": "busy", "bucket": "working", "since": 1792063500000, "reason": null,
      "startedAt": 1791907020000, "endedAt": null, "lastEventAt": 1792065540000,
      "busyMs": 21600000, "waitingOnUserMs": 0, "alive": true,
      "cost": { "credits": 24016.0, "calls": 1210 },
      "activity": { "label": "Running edit: src/api/orders.ts", "tool": { "id": "call-b1-9", "name": "edit", "summary": "edit: src/api/orders.ts", "startedAt": 1792065540000, "limitMs": 120000 }, "lastEventAt": 1792065540000 },
      "report": { "status": "complete", "source": "contract", "at": 1792058160000, "title": "Opened PR #418 with 14 endpoints. All API tests pass.", "summary": "Opened PR #418 with 14 endpoints. All API tests pass.", "evidence": ["API tests: 212 passed, 0 failed", "PR #418 opened on top of the B0 branch"], "blockers": [], "body": null, "unit": "B1", "commit": "9b1e4d2" },
      "progress": { "done": 7, "total": 10 },
      "subagents": [
        { "id": "call-b1-8", "name": "review-pr-418", "type": "code-review", "model": "claude-sonnet-5", "mode": "background", "status": "running", "startedAt": 1792065240000, "endedAt": null, "durationMs": null, "credits": 85.0, "task": "Review PR #418" },
        { "id": "call-b1-7", "name": "api-tests", "type": "task", "model": "claude-haiku-5.5", "mode": "sync", "status": "completed", "startedAt": 1792056600000, "endedAt": 1792057140000, "durationMs": 540000, "credits": 30.0, "task": "Run the API test suite" }
      ],
      "timeline": {
        "segments": [
          { "start": 1791907020000, "end": 1791921420000, "state": "busy" },
          { "start": 1791921420000, "end": 1792050000000, "state": "idle" },
          { "start": 1792050000000, "end": 1792058160000, "state": "busy" },
          { "start": 1792058160000, "end": 1792063500000, "state": "idle" },
          { "start": 1792063500000, "end": null, "state": "busy" }
        ],
        "subagents": [
          { "id": "call-b1-7", "start": 1792056600000, "end": 1792057140000, "type": "task" },
          { "id": "call-b1-8", "start": 1792065240000, "end": null, "type": "code-review" }
        ],
        "marks": [
          { "at": 1792058040000, "kind": "pr-open", "text": "PR opened", "status": null },
          { "at": 1792058160000, "kind": "report", "text": "Opened PR #418 with 14 endpoints.", "status": "complete" },
          { "at": 1792063080000, "kind": "monitor", "text": "PR monitor check", "status": null }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "in_review", "closedWithoutMerge": false, "outcome": null,
      "pr": { "provider": "github", "id": 418, "repo": "sample-org/sample-repo", "url": "https://github.com/sample-org/sample-repo/pull/418", "title": "Orders and invoices API", "state": "open", "openedAt": 1792058040000, "mergedAt": null, "closedAt": null, "reviewNote": "changes requested", "source": "registry", "checkedAt": 1792065300000 },
      "monitor": { "state": "missing", "lastCheckAt": 1792063080000, "nextCheckAt": 1792063680000, "everyMinutes": 10, "since": 1792063680000 },
      "dependsOn": "B0", "todoId": "b1-api"
    },
```

- [ ] **Step 7: Finish `example-snapshot.json`** — continue the same `units` array and close the document:

```json
    {
      "id": "ws-0004-b2", "kind": "project", "label": "B2", "name": "import",
      "cliSessionIds": ["cli-0004-b2"], "branch": "feature/b2-import", "model": "claude-sonnet-5",
      "status": "plan", "statusDetail": "waiting_plan", "bucket": "waiting", "since": 1792063320000, "reason": null,
      "startedAt": 1792043880000, "endedAt": null, "lastEventAt": 1792063320000,
      "busyMs": 5400000, "waitingOnUserMs": 2280000, "alive": true,
      "cost": { "credits": 5790.0, "calls": 410 },
      "activity": { "label": "Waiting for plan approval", "tool": null, "lastEventAt": 1792063320000 },
      "report": { "status": "complete", "source": "contract", "at": 1792063140000, "title": "The parser is done. The plan for step 2 is waiting for approval.", "summary": "The parser is done. The plan for step 2 is waiting for approval.", "evidence": ["Parser handles CSV and TSV", "18 parser tests pass"], "blockers": ["Plan for step 2 needs approval"], "body": null, "unit": "B2", "commit": null },
      "progress": { "done": 3, "total": 10 },
      "subagents": [
        { "id": "call-b2-1", "name": "find-import-code", "type": "explore", "model": "gpt-5.4-mini", "mode": "background", "status": "completed", "startedAt": 1792044600000, "endedAt": 1792044780000, "durationMs": 180000, "credits": 12.0, "task": "Find existing import code" }
      ],
      "timeline": {
        "segments": [
          { "start": 1792043880000, "end": 1792049400000, "state": "busy" },
          { "start": 1792049400000, "end": 1792060200000, "state": "idle" },
          { "start": 1792060200000, "end": 1792063320000, "state": "busy" },
          { "start": 1792063320000, "end": null, "state": "plan" }
        ],
        "subagents": [{ "id": "call-b2-1", "start": 1792044600000, "end": 1792044780000, "type": "explore" }],
        "marks": [
          { "at": 1792063140000, "kind": "report", "text": "The parser is done.", "status": "complete" },
          { "at": 1792063320000, "kind": "plan-req", "text": "Plan sent for approval", "status": null }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "coding", "closedWithoutMerge": false, "outcome": null,
      "pr": null,
      "monitor": { "state": "none", "lastCheckAt": null, "nextCheckAt": null, "everyMinutes": null, "since": null },
      "dependsOn": "B0", "todoId": "b2-import"
    },
    {
      "id": "ws-0005-i1", "kind": "project", "label": "I1", "name": "integration",
      "cliSessionIds": ["cli-0005-i1"], "branch": "feature/i1-integration", "model": "claude-sonnet-5",
      "status": "stuck", "statusDetail": "stuck_tool", "bucket": "stuck", "since": 1792062720000,
      "reason": "bash has run for 48 min with a limit of 15 min (initial_wait 10 min + 5 min).",
      "startedAt": 1792032900000, "endedAt": null, "lastEventAt": 1792062720000,
      "busyMs": 14400000, "waitingOnUserMs": 0, "alive": true,
      "cost": { "credits": 9702.0, "calls": 640 },
      "activity": { "label": "Running bash: dotnet test --filter E2E", "tool": { "id": "call-i1-4", "name": "bash", "summary": "bash: dotnet test --filter E2E", "startedAt": 1792062720000, "limitMs": 900000 }, "lastEventAt": 1792062720000 },
      "report": { "status": "complete", "source": "contract", "at": 1792054680000, "title": "Contract tests are wired and pass locally. Starting the end-to-end run next.", "summary": "Contract tests are wired and pass locally. Starting the end-to-end run next.", "evidence": ["12 contract tests pass"], "blockers": [], "body": null, "unit": "I1", "commit": null },
      "progress": { "done": 5, "total": 9 },
      "subagents": [],
      "timeline": {
        "segments": [
          { "start": 1792032900000, "end": 1792054680000, "state": "busy" },
          { "start": 1792054680000, "end": 1792058400000, "state": "idle" },
          { "start": 1792058400000, "end": 1792062720000, "state": "busy" },
          { "start": 1792062720000, "end": null, "state": "stuck" }
        ],
        "subagents": [],
        "marks": [
          { "at": 1792054680000, "kind": "report", "text": "Contract tests are wired and pass locally.", "status": "complete" },
          { "at": 1792062720000, "kind": "tool", "text": "Tool call started, no events since", "status": null }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "coding", "closedWithoutMerge": false, "outcome": null,
      "pr": null,
      "monitor": { "state": "none", "lastCheckAt": null, "nextCheckAt": null, "everyMinutes": null, "since": null },
      "dependsOn": "B1", "todoId": "i1-integration"
    },
    {
      "id": "ws-0006-f1", "kind": "project", "label": "F1", "name": "UI",
      "cliSessionIds": ["cli-0006-f1"], "branch": "feature/f1-ui", "model": "claude-sonnet-5",
      "status": "blocked", "statusDetail": "blocked_on_orchestrator", "bucket": "waiting", "since": 1792064880000,
      "reason": "It asked the orchestrator for input and has had no reply.",
      "startedAt": 1792040220000, "endedAt": null, "lastEventAt": 1792064880000,
      "busyMs": 10800000, "waitingOnUserMs": 0, "alive": true,
      "cost": { "credits": 8330.0, "calls": 520 },
      "activity": { "label": "Waiting for the orchestrator", "tool": null, "lastEventAt": 1792064880000 },
      "report": { "status": "needs_input", "source": "contract", "at": 1792064880000, "title": "The results page needs a table: reuse DataGrid, or build a lighter table.", "summary": "The results page needs a table: reuse DataGrid, or build a lighter table.", "evidence": ["DataGrid already supports virtual scroll and sorting", "A new table would cut the bundle by about 40 KB"], "blockers": ["Needs a decision: reuse DataGrid or build a new table"], "body": null, "unit": "F1", "commit": null },
      "progress": { "done": 4, "total": 10 },
      "subagents": [
        { "id": "call-f1-1", "name": "compare-tables", "type": "explore", "model": "gpt-5.4-mini", "mode": "background", "status": "completed", "startedAt": 1792063800000, "endedAt": 1792064040000, "durationMs": 240000, "credits": 12.0, "task": "Compare table components" }
      ],
      "timeline": {
        "segments": [
          { "start": 1792040220000, "end": 1792051200000, "state": "busy" },
          { "start": 1792051200000, "end": 1792062000000, "state": "idle" },
          { "start": 1792062000000, "end": 1792064880000, "state": "busy" },
          { "start": 1792064880000, "end": null, "state": "idle" }
        ],
        "subagents": [{ "id": "call-f1-1", "start": 1792063800000, "end": 1792064040000, "type": "explore" }],
        "marks": [
          { "at": 1792064880000, "kind": "question", "text": "The results page needs a table: reuse DataGrid, or build a lighter table.", "status": "needs_input" }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "coding", "closedWithoutMerge": false, "outcome": null,
      "pr": null,
      "monitor": { "state": "none", "lastCheckAt": null, "nextCheckAt": null, "everyMinutes": null, "since": null },
      "dependsOn": "B1", "todoId": "f1-ui"
    },
    {
      "id": "ws-0007-d5", "kind": "project", "label": "D5", "name": "docs",
      "cliSessionIds": ["cli-0007-d5"], "branch": "feature/d5-docs", "model": "claude-haiku-5.5",
      "status": "idle", "statusDetail": "idle", "bucket": "idle", "since": 1792065060000, "reason": null,
      "startedAt": 1791971400000, "endedAt": null, "lastEventAt": 1792065060000,
      "busyMs": 7200000, "waitingOnUserMs": 0, "alive": true,
      "cost": { "credits": 3058.0, "calls": 260 },
      "activity": { "label": "Idle", "tool": null, "lastEventAt": 1792065060000 },
      "report": { "status": "complete", "source": "contract", "at": 1792047600000, "title": "Opened PR #421 and started a PR monitor. Waiting for review.", "summary": "Opened PR #421 and started a PR monitor. Waiting for review.", "evidence": ["Docs build passes", "PR #421 opened"], "blockers": [], "body": null, "unit": "D5", "commit": "c41d0e7" },
      "progress": { "done": 9, "total": 10 },
      "subagents": [],
      "timeline": {
        "segments": [
          { "start": 1791971400000, "end": 1791985800000, "state": "busy" },
          { "start": 1791985800000, "end": null, "state": "idle" }
        ],
        "subagents": [],
        "marks": [
          { "at": 1792047480000, "kind": "pr-open", "text": "PR opened", "status": null },
          { "at": 1792047600000, "kind": "report", "text": "Opened PR #421 and started a PR monitor.", "status": "complete" },
          { "at": 1792064460000, "kind": "monitor", "text": "PR monitor check", "status": null },
          { "at": 1792065060000, "kind": "monitor", "text": "PR monitor check", "status": null }
        ]
      },
      "parentId": "ws-0000-root", "depth": 1, "stage": "pr_open", "closedWithoutMerge": false, "outcome": null,
      "pr": { "provider": "github", "id": 421, "repo": "sample-org/sample-repo", "url": "https://github.com/sample-org/sample-repo/pull/421", "title": "Docs for the v3 schema", "state": "draft", "openedAt": 1792047480000, "mergedAt": null, "closedAt": null, "reviewNote": "review required", "source": "registry", "checkedAt": 1792065300000 },
      "monitor": { "state": "alive", "lastCheckAt": 1792065060000, "nextCheckAt": 1792065660000, "everyMinutes": 10, "since": null },
      "dependsOn": "B0", "todoId": "d5-docs"
    }
  ],
  "planned": [
    { "label": "B3", "name": "export", "dependsOn": "B1", "canStart": true, "waitsOn": null, "todoId": "b3-export" },
    { "label": "I2", "name": "load tests", "dependsOn": "I1", "canStart": false, "waitsOn": "I1", "todoId": "i2-load-tests" }
  ],
  "needs": [
    { "kind": "plan", "unitIds": ["ws-0004-b2"], "labels": ["B2"], "fromId": "ws-0004-b2", "text": "Step 2 plan: 4 tasks to add XLSX import.", "since": 1792063320000, "tagged": false },
    { "kind": "pr", "unitIds": ["ws-0007-d5"], "labels": ["D5"], "fromId": "ws-0000-root", "text": "Publish PR #421 for review?", "since": 1792064100000, "tagged": true }
  ],
  "feed": [
    { "at": 1792065360000, "unitId": "ws-0000-root", "label": "SB", "kind": "subagent-start", "text": "started explore: map-import-module" },
    { "at": 1792065240000, "unitId": "ws-0003-b1", "label": "B1", "kind": "subagent-start", "text": "started code-review: review-pr-418" },
    { "at": 1792065060000, "unitId": "ws-0007-d5", "label": "D5", "kind": "monitor-check", "text": "PR monitor check" },
    { "at": 1792065060000, "unitId": "ws-0000-root", "label": "SB", "kind": "subagent-start", "text": "started research: table-research" },
    { "at": 1792064880000, "unitId": "ws-0006-f1", "label": "F1", "kind": "report", "text": "reported needs input: The results page needs a table: reuse DataGrid, or build a lighter table." },
    { "at": 1792064100000, "unitId": "ws-0000-root", "label": "SB", "kind": "question", "text": "asked: Publish PR #421 for review?" },
    { "at": 1792063320000, "unitId": "ws-0004-b2", "label": "B2", "kind": "plan-req", "text": "sent a plan for approval" },
    { "at": 1792063140000, "unitId": "ws-0004-b2", "label": "B2", "kind": "report", "text": "reported complete: The parser is done. The plan for step 2 is waiting for approval." },
    { "at": 1792063080000, "unitId": "ws-0003-b1", "label": "B1", "kind": "monitor-check", "text": "PR monitor check" },
    { "at": 1792058160000, "unitId": "ws-0003-b1", "label": "B1", "kind": "report", "text": "reported complete: Opened PR #418 with 14 endpoints. All API tests pass." }
  ],
  "counts": { "working": 1, "stuck": 1, "waiting": 2, "idle": 1, "done": 2, "failed": 0 },
  "cost": {
    "credits": 97652.4, "usd": 976.52, "maxUnitCredits": 24016.0,
    "byModel": [
      { "model": "claude-sonnet-5", "credits": 52100.0, "calls": 3000, "apiMs": 30000000 },
      { "model": "claude-opus-4.8", "credits": 31532.4, "calls": 1540, "apiMs": 22000000 },
      { "model": "claude-haiku-5.5", "credits": 7370.0, "calls": 560, "apiMs": 4000000 },
      { "model": "gpt-5.4-mini", "credits": 6650.0, "calls": 140, "apiMs": 900000 }
    ],
    "series": [
      { "at": 1791809100000, "credits": 40.0 },
      { "at": 1791936000000, "credits": 41000.0 },
      { "at": 1792022300000, "credits": 78000.0 },
      { "at": 1792063500000, "credits": 96100.0 },
      { "at": 1792065300000, "credits": 97652.4 }
    ]
  },
  "diagnostics": [
    { "level": "info", "source": "sqlite", "message": "Reading SQLite through node:sqlite." }
  ]
}
```

`tests/fixtures/example-swarms.json`:

```json
[
  { "id": "ws-0000-root", "name": "Sample story B", "project": { "id": "project-0001", "name": "sample-project" }, "startedAt": 1791809280000, "lastActivityAt": 1792065540000, "lifecycle": "live", "units": 7, "credits": 97652.4, "alive": true },
  { "id": "ws-1000-root", "name": "Sample story A", "project": { "id": "project-0001", "name": "sample-project" }, "startedAt": 1791450720000, "lastActivityAt": 1791710520000, "lifecycle": "finished", "units": 4, "credits": 49160.0, "alive": false }
]
```

`tests/fixtures/example-history.json`:

```json
[
  { "id": "ws-1000-root", "name": "Sample story A", "project": { "id": "project-0001", "name": "sample-project" }, "startedAt": 1791450720000, "finishedAt": 1791710520000, "tookMs": 259800000, "busyMs": 181800000, "credits": 49160.0, "usd": 491.6, "children": 4, "merged": 3, "summarized": true },
  { "id": "ws-2000-root", "name": "Docs sweep", "project": { "id": "project-0001", "name": "sample-project" }, "startedAt": 1790848800000, "finishedAt": 1790880300000, "tookMs": 31500000, "busyMs": null, "credits": 6320.0, "usd": 63.2, "children": 4, "merged": null, "summarized": false }
]
```

`tests/fixtures/example-run-summary.json`:

```json
{
  "schemaVersion": 1,
  "id": "ws-1000-root",
  "name": "Sample story A",
  "project": { "id": "project-0001", "name": "sample-project" },
  "startedAt": 1791450720000,
  "firstChildAt": 1791451800000,
  "finishedAt": 1791710520000,
  "tookMs": 259800000,
  "busyMs": 181800000,
  "waitingOnUserMs": 27600000,
  "credits": 49160.0,
  "usd": 491.6,
  "children": { "total": 4, "merged": 3, "closed": 1, "failed": 0, "noOutcome": 0 },
  "subagents": 23,
  "units": [
    { "id": "ws-1000-root", "label": "SA", "name": "Sample story A", "isOrchestrator": true, "startedAt": 1791450720000, "endedAt": 1791710520000, "busyMs": 69840000, "credits": 18240.0, "outcome": null, "merged": false },
    { "id": "ws-1001-a1", "label": "A1", "name": "model", "isOrchestrator": false, "startedAt": 1791451800000, "endedAt": 1791501120000, "busyMs": 21960000, "credits": 6120.0, "outcome": "merged", "merged": true },
    { "id": "ws-1002-a3", "label": "A3", "name": "API", "isOrchestrator": false, "startedAt": 1791501840000, "endedAt": 1791598320000, "busyMs": 44280000, "credits": 11940.0, "outcome": "merged", "merged": true },
    { "id": "ws-1003-s1", "label": "S1", "name": "security", "isOrchestrator": false, "startedAt": 1791522720000, "endedAt": 1791619920000, "busyMs": 27000000, "credits": 7420.0, "outcome": "merged", "merged": true },
    { "id": "ws-1004-p1", "label": "P1", "name": "perf", "isOrchestrator": false, "startedAt": 1791630720000, "endedAt": 1791688320000, "busyMs": 18720000, "credits": 5440.0, "outcome": "closed", "merged": false }
  ],
  "models": [
    { "model": "claude-sonnet-5", "credits": 30160.0, "calls": 2100, "apiMs": 18000000 },
    { "model": "claude-opus-4.8", "credits": 14000.0, "calls": 900, "apiMs": 8000000 },
    { "model": "gpt-5.5", "credits": 5000.0, "calls": 300, "apiMs": 2000000 }
  ],
  "subagentTypes": [
    { "type": "code-review", "runs": 9, "durationMs": 2700000, "credits": 4100.0 },
    { "type": "task", "runs": 8, "durationMs": 1800000, "credits": 1500.0 },
    { "type": "explore", "runs": 6, "durationMs": 600000, "credits": 300.0 }
  ],
  "computedAt": 1791717720000
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass (validate-plugin and schema); validation passes.

- [ ] **Step 9: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): define snapshot schema and engine API contract"
```

- [ ] **Step 10: Push and hand off the contract**

```bash
git push -u origin HEAD
git rev-parse HEAD
```

Send the coordinator a `progress` report with the pushed SHA and these paths: `engine/schema.mjs`, `engine/fake-engine.mjs`, `tests/fixtures/example-snapshot.json`, `example-swarms.json`, `example-history.json`, `example-run-summary.json`. From here on, any change to them needs the coordinator's OK.

### Task 3: Time, text and config helpers, and read-only SQLite access

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/time.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/text.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/config.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/sqlite.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/sqlite-writer.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/util.test.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/sqlite.test.mjs`

**Interfaces:**
- Consumes: `tempDir()` (Task 1).
- Produces:
  - `time.mjs`: `SECOND`, `MINUTE`, `HOUR`; `parseTime(value): number|null` (ISO 8601, SQLite `YYYY-MM-DD HH:MM:SS` as UTC, or epoch ms); `maxTime(...values): number|null`; `minTime(...values): number|null`; `formatDuration(ms): string` (`"23 min"`, `"2 h 5 min"`).
  - `text.mjs`: `ownString(value: string): string` (a copy that keeps no larger string alive); `oneLine(value, max = 200): string` and `clip(value, max): string|null` (both return owned strings); `firstLine(value): string|null`.
  - `config.mjs`: `DEFAULT_THRESHOLDS` (frozen; keys `modelCallWarnMs`, `modelCallStuckMs`, `bashExtraMs`, `bashDefaultMs`, `readBashExtraMs`, `readAgentExtraMs`, `quickToolMs`, `subagentSilentMs`, `subagentSilentHeavyMs`, `silentBusyMs`, `stalledIdleMs`, `spinningWindowMs`, `spinningFailures`, `spinningRepeats`, `spinningCompactions`, `monitorGraceMs`, `runFinishedAfterMs`); `resolveThresholds(overrides): object`; `copilotPaths(home?): { home, dataDb, storeDb, stateDir, historyDir }`.
  - `sqlite.mjs`: `SqliteUnavailableError`; `loadNodeSqlite(): Promise<module|null>`; `inspectDatabase(file): {sqlite: boolean, wal: boolean}|null`; `openTarget(file): {target: string, immutable: boolean}|null`; `bindLiterals(sql, params): string`; `openReadOnly(file, options?): Promise<Db|null>` where `Db = { backend: 'node'|'cli', immutable: boolean, all(sql, params?): Promise<object[]>, close(): void }` and `options = { backend?: 'auto'|'node'|'cli', sqlite3Path?: string, execFileImpl?: Function }`; `withReadOnly(file, options, fn): Promise<result|null>`; `sqliteBackends(options?): Promise<('node'|'cli')[]>`.
  - `tests/helpers/sqlite-writer.mjs`: `canWriteWithNode: boolean`; `TEST_BACKENDS: ('node'|'cli')[]`; `execSql(file, sql): void` (creates the file); `openWriter(file): DatabaseSync|null` (node:sqlite only).

- [ ] **Step 1: Write the test helper and the failing tests**

`tests/helpers/sqlite-writer.mjs`:

```js
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let nodeSqlite = null;
try {
  nodeSqlite = require('node:sqlite');
} catch {
  nodeSqlite = null;
}

function cliAvailable() {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const canWriteWithNode = Boolean(nodeSqlite);
/** Backends to run reader tests against, known synchronously so tests register without top-level await. */
export const TEST_BACKENDS = Object.freeze([...(nodeSqlite ? ['node'] : []), ...(cliAvailable() ? ['cli'] : [])]);

/** Run SQL against a database file, creating it when missing. Test fixtures only. */
export function execSql(file, sql) {
  if (nodeSqlite) {
    const db = new nodeSqlite.DatabaseSync(file);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    return;
  }
  execFileSync('sqlite3', [file], { input: `${sql};\nPRAGMA wal_checkpoint(TRUNCATE);\n`, stdio: ['pipe', 'ignore', 'inherit'] });
  // Apple's sqlite3 keeps -wal and -shm after it exits (persistent WAL). Once checkpointed, remove them,
  // as node:sqlite does on close, so fixtures look like a database whose writer has closed.
  for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
}

/** Keep a writable connection open, so a WAL database keeps its -wal and -shm files (node:sqlite only). */
export function openWriter(file) {
  return nodeSqlite ? new nodeSqlite.DatabaseSync(file) : null;
}
```

`tests/util.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HOUR, MINUTE, formatDuration, maxTime, minTime, parseTime } from '../engine/time.mjs';
import { clip, firstLine, oneLine, ownString } from '../engine/text.mjs';
import { DEFAULT_THRESHOLDS, copilotPaths, resolveThresholds } from '../engine/config.mjs';

test('parseTime reads ISO, SQLite UTC and epoch values', () => {
  assert.equal(parseTime('2026-10-15T12:00:00.000Z'), 1792065600000);
  assert.equal(parseTime('2026-10-15T13:00:00+01:00'), 1792065600000);
  assert.equal(parseTime('2026-10-15 12:00:00'), 1792065600000);
  assert.equal(parseTime(1792065600000), 1792065600000);
  for (const bad of [null, undefined, '', 'yesterday', Number.NaN, {}]) assert.equal(parseTime(bad), null);
});

test('maxTime and minTime ignore missing values', () => {
  assert.equal(maxTime(null, 5, 9, undefined), 9);
  assert.equal(minTime(null, 5, 9), 5);
  assert.equal(maxTime(null), null);
});

test('formatDuration uses minutes, then hours and minutes', () => {
  assert.equal(formatDuration(23 * MINUTE), '23 min');
  assert.equal(formatDuration(2 * HOUR + 5 * MINUTE), '2 h 5 min');
  assert.equal(formatDuration(2 * HOUR), '2 h');
});

test('text helpers flatten, clip and copy', () => {
  assert.equal(ownString('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(ownString('short'), 'short');
  assert.equal(ownString(''), '');
  assert.equal(oneLine('  a\n  b\tc  '), 'a b c');
  assert.equal(oneLine('abcdef', 4), 'abc…');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip(42, 4), null);
  assert.equal(firstLine('\n\n  first \nsecond'), 'first');
  assert.equal(firstLine(''), null);
});

test('thresholds default to the design values and accept overrides', () => {
  assert.equal(DEFAULT_THRESHOLDS.modelCallStuckMs, 10 * MINUTE);
  assert.equal(DEFAULT_THRESHOLDS.runFinishedAfterMs, 2 * HOUR);
  assert.equal(resolveThresholds({ silentBusyMs: 60_000 }).silentBusyMs, 60_000);
  assert.throws(() => resolveThresholds({ nope: 1 }), /Unknown threshold nope/);
  assert.throws(() => resolveThresholds({ silentBusyMs: -1 }), /non-negative/);
});

test('copilotPaths derives every location from one home', () => {
  const paths = copilotPaths('/home/user/.copilot');
  assert.equal(paths.dataDb, path.join('/home/user/.copilot', 'data.db'));
  assert.equal(paths.historyDir, path.join('/home/user/.copilot', 'swarm-dashboard', 'history'));
});
```

`tests/sqlite.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SqliteUnavailableError, bindLiterals, inspectDatabase, openReadOnly, openTarget, sqliteBackends, withReadOnly,
} from '../engine/sqlite.mjs';
import { TEST_BACKENDS, canWriteWithNode, execSql, openWriter } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';

const dir = tempDir('swarm-sqlite-');
const backends = TEST_BACKENDS;
const rollback = path.join(dir, 'rollback.db');
execSql(rollback, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a''q'), ('b'), ('c');");
const closedWal = path.join(dir, 'closed-wal.db');
execSql(closedWal, "PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('w');");

test('at least one SQLite backend is available, and the engine finds the same ones', async () => {
  assert.ok(backends.length > 0, 'install node:sqlite (Node >= 22.13) or the sqlite3 CLI');
  assert.deepEqual(await sqliteBackends(), [...backends]);
});

test('inspectDatabase recognises missing, non-SQLite, rollback and WAL files', () => {
  const text = path.join(dir, 'text.db');
  writeFileSync(text, 'not a database');
  assert.equal(inspectDatabase(path.join(dir, 'missing.db')), null);
  assert.deepEqual(inspectDatabase(text), { sqlite: false, wal: false });
  assert.deepEqual(inspectDatabase(rollback), { sqlite: true, wal: false });
  assert.deepEqual(inspectDatabase(closedWal), { sqlite: true, wal: true });
});

test('a WAL database without -shm is opened immutable; others by path', () => {
  assert.equal(existsSync(`${closedWal}-shm`), false);
  const wal = openTarget(closedWal);
  assert.equal(wal.immutable, true);
  assert.match(wal.target, /^file:\/\/.*closed-wal\.db\?immutable=1$/);
  assert.deepEqual(openTarget(rollback), { target: rollback, immutable: false });
  assert.equal(openTarget(path.join(dir, 'missing.db')), null);
});

test('bindLiterals escapes strings and checks the parameter count', () => {
  assert.equal(bindLiterals('SELECT ? , ?, ?, ?', ["it's", 7, null, 2n]), "SELECT 'it''s' , 7, NULL, 2");
  assert.throws(() => bindLiterals('SELECT ?', []), /missing parameter/);
  assert.throws(() => bindLiterals('SELECT 1', [1]), /too many parameters/);
  assert.throws(() => bindLiterals('SELECT ?', ['a\u0000b']), /NUL/);
  assert.throws(() => bindLiterals('SELECT ?', [{}]), /unsupported parameter type/);
});

for (const backend of backends) {
  test(`${backend}: reads rows with bound parameters`, async () => {
    const rows = await withReadOnly(rollback, { backend }, db => db.all('SELECT id, v FROM t WHERE id > ? AND v <> ? ORDER BY id', [0, 'c']));
    assert.deepEqual(rows, [{ id: 1, v: "a'q" }, { id: 2, v: 'b' }]);
  });

  test(`${backend}: rejects writes`, async () => {
    const db = await openReadOnly(rollback, { backend });
    try {
      await assert.rejects(db.all("INSERT INTO t (v) VALUES ('x')"));
    } finally {
      db.close();
    }
    const rows = await withReadOnly(rollback, { backend }, db2 => db2.all('SELECT count(*) AS n FROM t'));
    assert.deepEqual(rows, [{ n: 3 }]);
  });

  test(`${backend}: reads a closed WAL database without creating side files`, async () => {
    const rows = await withReadOnly(closedWal, { backend }, db => db.all('SELECT v FROM t'));
    assert.deepEqual(rows, [{ v: 'w' }]);
    assert.equal(existsSync(`${closedWal}-wal`), false);
    assert.equal(existsSync(`${closedWal}-shm`), false);
  });

  test(`${backend}: reads committed rows of a WAL database with a live writer`, { skip: !canWriteWithNode }, async () => {
    const file = path.join(dir, `live-${backend}.db`);
    const writer = openWriter(file);
    try {
      writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('live');");
      assert.equal(openTarget(file).immutable, false);
      const rows = await withReadOnly(file, { backend }, db => db.all('SELECT v FROM t'));
      assert.deepEqual(rows, [{ v: 'live' }]);
    } finally {
      writer.close();
    }
  });

  test(`${backend}: returns null for a missing file without calling the reader`, async () => {
    let called = false;
    const result = await withReadOnly(path.join(dir, 'nope.db'), { backend }, async () => {
      called = true;
    });
    assert.equal(result, null);
    assert.equal(called, false);
  });
}

test('the CLI backend reports a missing sqlite3 binary as SqliteUnavailableError', async () => {
  const db = await openReadOnly(rollback, { backend: 'cli', sqlite3Path: path.join(dir, 'no-such-sqlite3') });
  await assert.rejects(db.all('SELECT 1'), SqliteUnavailableError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/util.test.mjs tests/sqlite.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/time.mjs'` and `.../engine/sqlite.mjs`.

- [ ] **Step 3: Write the helpers**

`engine/time.mjs`:

```js
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** Epoch ms from an ISO 8601 string, an SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS') or a number; otherwise null. */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const plain = SQLITE_UTC.exec(text);
  const ms = Date.parse(plain ? `${plain[1]}T${plain[2]}Z` : text);
  return Number.isFinite(ms) ? ms : null;
}

export function maxTime(...values) {
  let best = null;
  for (const value of values) if (Number.isFinite(value) && (best === null || value > best)) best = value;
  return best;
}

export function minTime(...values) {
  let best = null;
  for (const value of values) if (Number.isFinite(value) && (best === null || value < best)) best = value;
  return best;
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
```

`engine/text.mjs`:

```js
/**
 * A copy of a string that keeps no larger string alive. V8 can represent a substring (from slice, split or a regex
 * match) as a view into its parent, so a short text kept from a log line could pin the whole chunk it was read from.
 * Concatenating forces a flat copy; the slice then refers to that copy only.
 */
export function ownString(value) {
  return value.length ? (' ' + value).slice(1) : value;
}

export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return ownString(text.length > max ? `${text.slice(0, max - 1)}…` : text);
}

export function clip(value, max) {
  if (typeof value !== 'string') return null;
  return ownString(value.length > max ? `${value.slice(0, max - 1)}…` : value);
}

export function firstLine(value) {
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
```

`engine/config.mjs`:

```js
import os from 'node:os';
import path from 'node:path';
import { HOUR, MINUTE } from './time.mjs';

/** Design call 3 thresholds, calibrated on the reference run. All are configurable. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  modelCallWarnMs: 5 * MINUTE,
  modelCallStuckMs: 10 * MINUTE,
  bashExtraMs: 5 * MINUTE,
  bashDefaultMs: 10 * MINUTE,
  readBashExtraMs: 2 * MINUTE,
  readAgentExtraMs: 2 * MINUTE,
  quickToolMs: 2 * MINUTE,
  subagentSilentMs: 10 * MINUTE,
  subagentSilentHeavyMs: 15 * MINUTE,
  silentBusyMs: 10 * MINUTE,
  stalledIdleMs: 30 * MINUTE,
  spinningWindowMs: 30 * MINUTE,
  spinningFailures: 5,
  spinningRepeats: 3,
  spinningCompactions: 2,
  monitorGraceMs: 5 * MINUTE,
  runFinishedAfterMs: 2 * HOUR,
});

export function resolveThresholds(overrides = {}) {
  const result = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in DEFAULT_THRESHOLDS)) throw new Error(`Unknown threshold ${key}`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Threshold ${key} must be a non-negative number`);
    result[key] = value;
  }
  return Object.freeze(result);
}

export function copilotPaths(home = path.join(os.homedir(), '.copilot')) {
  return {
    home,
    dataDb: path.join(home, 'data.db'),
    storeDb: path.join(home, 'session-store.db'),
    stateDir: path.join(home, 'session-state'),
    historyDir: path.join(home, 'swarm-dashboard', 'history'),
  };
}
```

- [ ] **Step 4: Write `engine/sqlite.mjs`**

```js
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAGIC = 'SQLite format 3\u0000';

export class SqliteUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqliteUnavailableError';
  }
}

let nodeSqlite;
/** node:sqlite when this runtime has it (Node >= 22.13 without flags), otherwise null. */
export function loadNodeSqlite() {
  nodeSqlite ??= import('node:sqlite').then(module => module, () => null);
  return nodeSqlite;
}

/** Header check without opening SQLite: null when missing; wal = file format version 2. */
export function inspectDatabase(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const header = Buffer.alloc(100);
    const read = readSync(fd, header, 0, 100, 0);
    if (read < 100 || header.toString('latin1', 0, 16) !== MAGIC) return { sqlite: false, wal: false };
    return { sqlite: true, wal: header[18] === 2 };
  } finally {
    closeSync(fd);
  }
}

/**
 * How to open a database without side effects. A WAL database whose writer has closed has no -shm file; a plain
 * read-only open would create -wal and -shm beside it, so it is read through the immutable=1 URI instead.
 */
export function openTarget(file) {
  const info = inspectDatabase(file);
  if (!info || !info.sqlite) return null;
  if (info.wal && !existsSync(`${file}-shm`)) return { target: `${pathToFileURL(file).href}?immutable=1`, immutable: true };
  return { target: file, immutable: false };
}

/** Replace each ? with an SQL literal. Only for the engine's constant SQL, which has no ? inside string literals. */
export function bindLiterals(sql, params = []) {
  let index = 0;
  const text = sql.replace(/\?/g, () => {
    if (index >= params.length) throw new Error('bindLiterals: missing parameter');
    return toLiteral(params[index++]);
  });
  if (index !== params.length) throw new Error('bindLiterals: too many parameters');
  return text;
}

function toLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('bindLiterals: non-finite number');
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000')) throw new Error('bindLiterals: NUL character in string');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new Error(`bindLiterals: unsupported parameter type ${typeof value}`);
}

function nodeDatabase(sqlite, target, immutable) {
  const db = new sqlite.DatabaseSync(target, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = 1');
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    backend: 'node',
    immutable,
    async all(sql, params = []) {
      return db.prepare(sql).all(...params).map(row => ({ ...row }));
    },
    close() {
      db.close();
    },
  };
}

function cliDatabase(sqlite3Path, target, immutable, execFileImpl) {
  return {
    backend: 'cli',
    immutable,
    all(sql, params = []) {
      let text;
      try {
        text = bindLiterals(sql, params);
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        execFileImpl(
          sqlite3Path,
          ['-readonly', '-json', '-cmd', 'PRAGMA query_only = 1', target, text],
          { maxBuffer: 256 * 1024 * 1024, timeout: 30_000, windowsHide: true },
          (error, stdout, stderr) => {
            if (error) {
              if (error.code === 'ENOENT') reject(new SqliteUnavailableError(`sqlite3 not found: ${sqlite3Path}`));
              else reject(new Error(`sqlite3 failed: ${String(stderr || error.message).trim().slice(0, 300)}`));
              return;
            }
            const out = String(stdout).trim();
            if (!out) {
              resolve([]);
              return;
            }
            try {
              resolve(JSON.parse(out));
            } catch (parseError) {
              reject(new Error(`sqlite3 returned invalid JSON: ${parseError.message}`));
            }
          },
        );
      });
    },
    close() {},
  };
}

/** Open a database read-only. Resolves null when the file is missing or is not SQLite. */
export async function openReadOnly(file, options = {}) {
  const { backend = 'auto', sqlite3Path = 'sqlite3', execFileImpl = execFile } = options;
  const target = openTarget(file);
  if (!target) return null;
  if (backend === 'auto' || backend === 'node') {
    const sqlite = await loadNodeSqlite();
    if (sqlite) return nodeDatabase(sqlite, target.target, target.immutable);
    if (backend === 'node') throw new SqliteUnavailableError('node:sqlite is not available in this Node.js runtime');
  }
  return cliDatabase(sqlite3Path, target.target, target.immutable, execFileImpl);
}

/** Open, run fn(db), always close. Resolves null without calling fn when the database is missing. */
export async function withReadOnly(file, options, fn) {
  const db = await openReadOnly(file, options);
  if (!db) return null;
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

export async function sqliteBackends({ sqlite3Path = 'sqlite3' } = {}) {
  const found = [];
  if (await loadNodeSqlite()) found.push('node');
  const cli = await new Promise(resolve => {
    execFile(sqlite3Path, ['-version'], { timeout: 10_000 }, error => resolve(!error));
  });
  if (cli) found.push('cli');
  return found;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass; on this machine both `node` and `cli` backends run, and the live-writer tests run.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): add read-only SQLite access with CLI fallback"
```

### Task 4: Synthetic Copilot home, app database reader and session tree

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/copilot-home.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/event-log.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/readers/app-db.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/model/forest.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/app-db.test.mjs`

**Interfaces:**
- Consumes: `execSql` (Task 3 helper), `bindLiterals`, `withReadOnly` (Task 3), `parseTime` (Task 3), `tempDir` (Task 1).
- Produces:
  - `CopilotHome` (tests): `root`, `dataDb`, `storeDb`, `stateDir`; methods `dir(cliId)`, `project({id, name, githubOwner?, githubRepo?})`, `workspace({id, projectId?, name, branch?, createdAt, archivedAt?, sessionId?, parentId?, creatorSessionId?, baseBranch?, pr?, isRunning?, model?})`, `alias(sessionId, workspaceId, createdAt)`, `session({id, title?, createdAt, isRunning?, model?, mode?, archivedAt?})`, `chat({id, parentSessionId?, title, createdAt, isRunning?})`, `automation({sessionId, everyMinutes?, lastRunAt?, nextRunAt?, pausedAt?, name?})`, `usage(rows)`, `writeEvents(cliId, events, {append?})` (sets the file's mtime to its last event's time), `sessionDb(cliId, {todos?, deps?, children?})`, `workspaceYaml(cliId, {cwd?, branch?, hostType?, repository?})`, `lock(cliId, pid, mtimeMs?)`. Times are epoch ms.
  - `EventLog` (tests): `t`, `events`; `at(ms)`, `wait(ms)`, `push(type, data, extra)`, `start(model?)`, `resume()`, `turnStart()`, `turnEnd()`, `message()`, `usage(model?, extra?)`, `user(content, data?)`, `tool(name, args) → callId`, `done(callId, {success?, result?, telemetry?})`, `ask(question, choices?) → callId`, `plan(summary) → callId`, `report(sessionId, message, purpose?) → callId`, `subagent({name?, type?, mode?, model?, effort?, agentId?}) → callId`, `sub(callId, type?, data?)`, `subagentDone(callId, {durationMs?, failed?})`, `crossSession({fromSessionId, fromProjectSessionId?, sourceToolCallId?, name?, content})`, `automationWake(prompt?)`, `taskComplete(summary, success?)`, `shutdown()`, `abort()`, `lines(): string`.
  - `app-db.mjs`: `APP_QUERIES` (frozen object of SQL strings); `readAppDb(db): Promise<AppData>` where `AppData = { projects: Map<id,{id,name,githubOwner,githubRepo}>, worktrees: Map<id,{id,branch,baseBranch}>, workspaces: Map<id, Workspace>, parentLinks: {childId,parentId}[], aliases: {sessionId,workspaceId,createdAt}[], chatLinks: {sessionId,parentSessionId}[], sessions: Map<id,{id,title,mode,model,reasoningEffort,isRunning,wasInterrupted,createdAt,archivedAt}>, automations: {sessionId,interval,everyMinutes,lastRunAt,nextRunAt,pausedAt,name}[], diagnostics: Diagnostic[] }` and `Workspace = {id, projectId, worktreeId, name, branch, createdAt, archivedAt, sessionId, creatorSessionId, coordinatingCreatorSessionId, createdPr: {repo, number, url, state, mergedAt}|null}`.
  - `forest.mjs`: `buildForest(app): { nodes: Map<id, Node>, roots: Node[], workspaceOfSession: Map<cliId, workspaceId> }` with `Node = { id, kind: 'project'|'chat', name, projectId, branch, baseBranch, createdAt, archivedAt, cliSessionIds: string[], currentCliSessionId, createdPr, parentId, childIds: string[], depth }`; roots sorted newest first; `descendants(forest, rootId): Node[]` (depth-first, children by creation time); `resolveNodeId(forest, id): string|null`; `treeNodes(forest, rootId): Node[]` (root first, then descendants).

- [ ] **Step 1: Write the synthetic Copilot home builder**

`tests/helpers/copilot-home.mjs`:

```js
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { bindLiterals } from '../../engine/sqlite.mjs';
import { execSql } from './sqlite-writer.mjs';
import { tempDir } from './temp.mjs';

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

const APP_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, github_owner TEXT, github_repo TEXT, main_repo_path TEXT);
CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT, path TEXT, branch TEXT, base_branch TEXT, created_at TEXT);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, worktree_id TEXT, workspace_type TEXT, branch TEXT, name TEXT,
  created_at TEXT, updated_at TEXT, archived_at TEXT, session_id TEXT, created_by TEXT, creator_session_id TEXT,
  coordinating_creator_session_id TEXT, created_pr_repo_full_name TEXT, created_pr_number INTEGER, created_pr_html_url TEXT,
  created_pr_state TEXT, created_pr_merged_at TEXT);
CREATE TABLE workspace_parent_links (child_workspace_id TEXT PRIMARY KEY, parent_workspace_id TEXT, creator_session_id TEXT, created_at TEXT);
CREATE TABLE workspace_session_aliases (session_id TEXT PRIMARY KEY, workspace_id TEXT, created_at TEXT);
CREATE TABLE chat_parent_links (session_id TEXT PRIMARY KEY, parent_session_id TEXT, coordinating_creator_session_id TEXT, notify_creator_on_idle TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, session_type TEXT, mode TEXT, model TEXT, reasoning_effort TEXT,
  is_running INTEGER, was_interrupted INTEGER, created_at TEXT, updated_at TEXT, archived_at TEXT, total_nano_aiu INTEGER);
CREATE TABLE session_automations (session_id TEXT PRIMARY KEY, prompt TEXT, interval TEXT, every_minutes INTEGER, schedule_hour INTEGER,
  schedule_day INTEGER, last_run_at TEXT, next_run_at TEXT, updated_at TEXT, name TEXT, owner_session_id TEXT, paused_at TEXT);
CREATE TABLE settings (id INTEGER PRIMARY KEY, github_token TEXT);
INSERT INTO settings (github_token) VALUES ('fixture-secret-must-never-be-read');
`;

const STORE_SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, turn_index INTEGER, agent_id TEXT,
  parent_tool_call_id TEXT, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, total_nano_aiu INTEGER, duration_ms INTEGER,
  initiator TEXT, created_at TEXT);
CREATE INDEX idx_assistant_usage_events_session ON assistant_usage_events (session_id, id);
`;

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'blocked')),
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS todo_deps (todo_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (todo_id, depends_on));
`;

/** The children registry from the design's section 10, verbatim. */
export const CHILDREN_SCHEMA = `
CREATE TABLE IF NOT EXISTS children (
  unit TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL, todo_id TEXT, branch TEXT, base_branch TEXT,
  pr_provider TEXT CHECK (pr_provider IN ('ado', 'github')), pr_repo TEXT, pr_id INTEGER, pr_url TEXT,
  outcome TEXT CHECK (outcome IN ('merged', 'closed', 'failed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
`;

/** A synthetic ~/.copilot folder. Every value in it is invented for tests. */
export class CopilotHome {
  constructor(root = tempDir('swarm-home-')) {
    this.root = root;
    this.dataDb = path.join(root, 'data.db');
    this.storeDb = path.join(root, 'session-store.db');
    this.stateDir = path.join(root, 'session-state');
    mkdirSync(this.stateDir, { recursive: true });
    execSql(this.dataDb, APP_SCHEMA);
    execSql(this.storeDb, STORE_SCHEMA);
  }

  insert(file, table, row) {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    execSql(file, bindLiterals(sql, keys.map(key => row[key])));
  }

  dir(cliId) {
    const dir = path.join(this.stateDir, cliId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  project({ id, name, githubOwner = null, githubRepo = null }) {
    this.insert(this.dataDb, 'projects', { id, name, github_owner: githubOwner, github_repo: githubRepo, main_repo_path: '/synthetic/repo' });
  }

  workspace({ id, projectId = null, name, branch = null, createdAt, archivedAt = null, sessionId = id, parentId = null,
    creatorSessionId = null, baseBranch = null, pr = null, isRunning = false, model = 'claude-sonnet-5' }) {
    const worktreeId = baseBranch ? `wt-${id}` : null;
    if (worktreeId) {
      this.insert(this.dataDb, 'worktrees', { id: worktreeId, project_id: projectId, path: `/synthetic/worktrees/${id}`, branch, base_branch: baseBranch, created_at: iso(createdAt) });
    }
    this.insert(this.dataDb, 'workspaces', {
      id, project_id: projectId, worktree_id: worktreeId, workspace_type: 'worktree', branch, name,
      created_at: iso(createdAt), updated_at: iso(createdAt), archived_at: iso(archivedAt), session_id: sessionId,
      created_by: parentId || creatorSessionId ? 'agent' : 'user', creator_session_id: creatorSessionId,
      coordinating_creator_session_id: parentId ? creatorSessionId : null,
      created_pr_repo_full_name: pr?.repo ?? null, created_pr_number: pr?.number ?? null, created_pr_html_url: pr?.url ?? null,
      created_pr_state: pr?.state ?? null, created_pr_merged_at: iso(pr?.mergedAt ?? null),
    });
    if (parentId) {
      this.insert(this.dataDb, 'workspace_parent_links', { child_workspace_id: id, parent_workspace_id: parentId, creator_session_id: creatorSessionId, created_at: iso(createdAt) });
    }
    this.alias(sessionId, id, createdAt);
    this.session({ id: sessionId, title: name, createdAt, isRunning, model });
  }

  alias(sessionId, workspaceId, createdAt) {
    this.insert(this.dataDb, 'workspace_session_aliases', { session_id: sessionId, workspace_id: workspaceId, created_at: iso(createdAt) });
  }

  session({ id, title = '', createdAt, isRunning = false, model = null, mode = null, archivedAt = null }) {
    this.insert(this.dataDb, 'sessions', {
      id, title, session_type: 'session', mode, model, reasoning_effort: null, is_running: isRunning ? 1 : 0, was_interrupted: 0,
      created_at: iso(createdAt), updated_at: iso(createdAt), archived_at: iso(archivedAt), total_nano_aiu: 0,
    });
  }

  chat({ id, parentSessionId = null, title, createdAt, isRunning = false }) {
    this.session({ id, title, createdAt, isRunning });
    if (parentSessionId) {
      this.insert(this.dataDb, 'chat_parent_links', { session_id: id, parent_session_id: parentSessionId, coordinating_creator_session_id: parentSessionId, notify_creator_on_idle: 'always' });
    }
  }

  automation({ sessionId, everyMinutes = 10, lastRunAt = null, nextRunAt = null, pausedAt = null, name = 'PR monitor' }) {
    this.insert(this.dataDb, 'session_automations', {
      session_id: sessionId, prompt: 'synthetic monitor prompt', interval: 'minutes', every_minutes: everyMinutes, schedule_hour: null,
      schedule_day: null, last_run_at: iso(lastRunAt), next_run_at: iso(nextRunAt), updated_at: iso(lastRunAt ?? nextRunAt), name,
      owner_session_id: sessionId, paused_at: iso(pausedAt),
    });
  }

  usage(rows) {
    for (const row of rows) {
      this.insert(this.storeDb, 'assistant_usage_events', {
        session_id: row.sessionId, turn_index: 0, agent_id: row.agentId ?? null, parent_tool_call_id: row.parentToolCallId ?? null,
        model: row.model ?? 'claude-sonnet-5', input_tokens: 1000, output_tokens: 100, total_nano_aiu: row.nanoAiu,
        duration_ms: row.durationMs ?? 1000, initiator: row.initiator ?? 'agent', created_at: iso(row.createdAt),
      });
    }
  }

  writeEvents(cliId, events, { append = false } = {}) {
    const file = path.join(this.dir(cliId), 'events.jsonl');
    const text = events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
    (append ? appendFileSync : writeFileSync)(file, text);
    const last = events.length ? Date.parse(events[events.length - 1].timestamp) : Number.NaN;
    if (Number.isFinite(last)) utimesSync(file, last / 1000, last / 1000);
    return file;
  }

  sessionDb(cliId, { todos = [], deps = [], children = null } = {}) {
    const file = path.join(this.dir(cliId), 'session.db');
    execSql(file, SESSION_SCHEMA + (children ? CHILDREN_SCHEMA : ''));
    for (const todo of todos) {
      this.insert(file, 'todos', { id: todo.id, title: todo.title ?? todo.id, description: todo.description ?? null, status: todo.status ?? 'pending' });
    }
    for (const [todoId, dependsOn] of deps) this.insert(file, 'todo_deps', { todo_id: todoId, depends_on: dependsOn });
    for (const row of children ?? []) this.insert(file, 'children', row);
    return file;
  }

  workspaceYaml(cliId, { cwd = '/synthetic/worktree', branch = null, hostType = null, repository = null } = {}) {
    const lines = [`id: ${cliId}`, `cwd: ${cwd}`, branch && `branch: ${branch}`, repository && `repository: ${repository}`, hostType && `host_type: ${hostType}`, 'name: synthetic'];
    writeFileSync(path.join(this.dir(cliId), 'workspace.yaml'), `${lines.filter(Boolean).join('\n')}\n`);
  }

  lock(cliId, pid, mtimeMs = Date.now()) {
    const file = path.join(this.dir(cliId), `inuse.${pid}.lock`);
    writeFileSync(file, String(pid));
    utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
    writeFileSync(path.join(this.dir(cliId), `inuse.${pid}.hold`), '');
  }
}
```

- [ ] **Step 2: Write the event log builder**

`tests/helpers/event-log.mjs` (event shapes follow the spec's section 11; envelope key order matches real logs):

```js
export class EventLog {
  constructor(start) {
    this.t = start;
    this.events = [];
    this.count = 0;
    this.calls = 0;
    this.previous = null;
  }

  at(ms) { this.t = ms; }

  wait(ms) { this.t += ms; }

  push(type, data = {}, extra = {}) {
    const id = `ev-${++this.count}`;
    this.events.push({ type, data, ...extra, id, timestamp: new Date(this.t).toISOString(), parentId: this.previous });
    this.previous = id;
    return id;
  }

  start(model = 'claude-sonnet-5') { return this.push('session.start', { copilotVersion: '1.0.95-3', selectedModel: model }); }

  resume() { return this.push('session.resume', { selectedModel: 'claude-sonnet-5' }); }

  turnStart() { return this.push('assistant.turn_start', { turnId: '0', interactionId: 'interaction' }); }

  turnEnd() { return this.push('assistant.turn_end', { turnId: '0' }); }

  message(content = 'ok') { return this.push('assistant.message', { content, model: 'claude-sonnet-5', toolRequests: [] }); }

  usage(model = 'claude-sonnet-5', extra = {}) { return this.push('session.usage_record', { usage: { model, inputTokens: 10, outputTokens: 2 } }, extra); }

  user(content = 'go', data = {}) { return this.push('user.message', { content, transformedContent: content, ...data }); }

  tool(name, args = {}) {
    const id = `call-${++this.calls}`;
    this.push('tool.execution_start', { toolCallId: id, toolName: name, arguments: args });
    return id;
  }

  done(id, { success = true, result = 'ok', telemetry = null } = {}) {
    return this.push('tool.execution_complete', { toolCallId: id, success, result: { content: result }, ...(telemetry ? { toolTelemetry: telemetry } : {}) });
  }

  ask(question, choices) { return this.tool('ask_user', { question, ...(choices ? { choices } : {}) }); }

  plan(summary) { return this.tool('exit_plan_mode', { summary, recommendedAction: 'autopilot' }); }

  report(sessionId, message, purpose) {
    const id = this.tool('send_session_message', { session_id: sessionId, message, ...(purpose ? { purpose } : {}) });
    this.done(id, { result: 'Message accepted for delivery' });
    return id;
  }

  subagent({ name = 'helper', type = 'general-purpose', mode = 'sync', model = 'claude-sonnet-5', effort, agentId } = {}) {
    const id = this.tool('task', {
      name, agent_type: type, mode, model, description: `${name} work`, prompt: 'synthetic prompt',
      ...(effort ? { reasoning_effort: effort } : {}),
    });
    this.push('subagent.started', { toolCallId: id, agentName: type, agentDisplayName: name, agentType: type, model, executionMode: mode }, agentId ? { agentId } : {});
    if (mode === 'background') this.done(id, { result: 'Agent started in background' });
    return id;
  }

  sub(callId, type = 'assistant.message', data = {}) { return this.push(type, { ...data, parentToolCallId: callId }); }

  subagentDone(callId, { durationMs = 60_000, failed = false } = {}) {
    return this.push(failed ? 'subagent.failed' : 'subagent.completed', { toolCallId: callId, durationMs, totalTokens: 1000, totalToolCalls: 3 });
  }

  crossSession({ fromSessionId, fromProjectSessionId = fromSessionId, sourceToolCallId = 'call-remote', name = 'unit', content }) {
    const envelope = [
      '<cross_session_message>',
      `from_project_session_id: ${fromProjectSessionId}`,
      `from_session_id: ${fromSessionId}`,
      `from_project_session_name: ${name}`,
      `from_display_name: ${name}`,
      `source_tool_call_id: ${sourceToolCallId}`,
      '</cross_session_message>',
    ].join('\n');
    return this.push('user.message', {
      content, transformedContent: `<current_datetime>synthetic</current_datetime>\n\n${envelope}\n${content}`,
      source: `agent-${fromSessionId}`, delivery: 'idle',
    });
  }

  automationWake(prompt = 'Check the PR for new comments') {
    return this.push('user.message', { content: prompt, transformedContent: `<session_automation>\n${prompt}\n</session_automation>`, source: 'system', delivery: 'idle' });
  }

  taskComplete(summary, success = true) { return this.push('session.task_complete', { summary, success }); }

  shutdown() { return this.push('session.shutdown', { shutdownType: 'routine' }); }

  abort() { return this.push('abort', { reason: 'user_initiated' }); }

  lines() { return this.events.map(event => JSON.stringify(event)).join('\n') + '\n'; }
}
```

- [ ] **Step 3: Write the failing reader and tree test**

`tests/app-db.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_QUERIES, readAppDb } from '../engine/readers/app-db.mjs';
import { buildForest, descendants, resolveNodeId, treeNodes } from '../engine/model/forest.mjs';
import { withReadOnly } from '../engine/sqlite.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS } from './helpers/sqlite-writer.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const home = new CopilotHome();
home.project({ id: 'project-1', name: 'sample-project' });
home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root-2', branch: 'story', baseBranch: 'main' });
home.alias('cli-root-1', 'ws-root', T0 - 1000);
home.session({ id: 'cli-root-1', title: 'analysis', createdAt: T0 - 1000 });
home.workspace({ id: 'ws-a', projectId: 'project-1', name: 'Story a1 api', createdAt: T0 + 1000, parentId: 'ws-root', creatorSessionId: 'cli-root-2', branch: 'feature/a1', baseBranch: 'story' });
home.workspace({ id: 'ws-b', projectId: 'project-1', name: 'Story b1 docs', createdAt: T0 + 2000, parentId: 'ws-root', creatorSessionId: 'cli-root-2', archivedAt: T0 + 9000 });
home.workspace({ id: 'ws-c', name: 'Story c1 nested', createdAt: T0 + 3000, parentId: 'ws-a', creatorSessionId: 'ws-a' });
home.chat({ id: 'chat-1', parentSessionId: 'cli-root-2', title: 'Research chat', createdAt: T0 + 4000 });
home.session({ id: 'chat-root', title: 'Chat orchestrator', createdAt: T0 + 5000 });
home.workspace({ id: 'ws-d', name: 'Chat child', createdAt: T0 + 6000, creatorSessionId: 'chat-root' });
home.workspace({ id: 'ws-solo', name: 'Solo', createdAt: T0 + 7000 });
home.automation({ sessionId: 'ws-a', nextRunAt: T0 + 600_000 });

test('the app queries select named columns only and never touch secrets', () => {
  for (const sql of Object.values(APP_QUERIES)) {
    assert.doesNotMatch(sql, /\*/);
    assert.doesNotMatch(sql, /settings|token/i);
  }
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: reads the app database and builds the session tree`, async () => {
    const app = await withReadOnly(home.dataDb, { backend }, readAppDb);
    assert.deepEqual(app.diagnostics, []);
    assert.equal(app.projects.get('project-1').name, 'sample-project');
    assert.equal(app.workspaces.get('ws-b').archivedAt, T0 + 9000);
    assert.deepEqual(app.automations, [{ sessionId: 'ws-a', interval: 'minutes', everyMinutes: 10, lastRunAt: null, nextRunAt: T0 + 600_000, pausedAt: null, name: 'PR monitor' }]);

    const forest = buildForest(app);
    assert.deepEqual(forest.roots.map(root => root.id), ['chat-root', 'ws-root']);
    const root = forest.nodes.get('ws-root');
    assert.deepEqual(root.cliSessionIds, ['cli-root-1', 'cli-root-2']);
    assert.equal(root.currentCliSessionId, 'cli-root-2');
    assert.deepEqual(descendants(forest, 'ws-root').map(node => [node.id, node.depth]), [['ws-a', 1], ['ws-c', 2], ['ws-b', 1], ['chat-1', 1]]);
    assert.deepEqual(treeNodes(forest, 'ws-root').map(node => node.id), ['ws-root', 'ws-a', 'ws-c', 'ws-b', 'chat-1']);
    const chat = forest.nodes.get('chat-1');
    assert.equal(chat.kind, 'chat');
    assert.equal(chat.parentId, 'ws-root');
    assert.equal(chat.name, 'Research chat');
    assert.equal(forest.nodes.get('ws-d').parentId, 'chat-root');
    assert.equal(forest.nodes.get('chat-root').kind, 'chat');
    assert.equal(forest.nodes.get('ws-solo').parentId, null);
    assert.equal(forest.nodes.get('ws-a').baseBranch, 'story');
    assert.equal(forest.nodes.get('ws-a').branch, 'feature/a1');
    assert.equal(resolveNodeId(forest, 'cli-root-1'), 'ws-root');
    assert.equal(resolveNodeId(forest, 'unknown'), null);
  });
}

test('a missing table becomes a warning and an empty list', async () => {
  const db = { all: async sql => { if (sql.includes('session_automations')) throw new Error('no such table: session_automations'); return []; } };
  const app = await readAppDb(db);
  assert.deepEqual(app.automations, []);
  assert.deepEqual(app.diagnostics, [{ level: 'warn', source: 'data.db', message: 'automations: no such table: session_automations' }]);
});

test('parent cycles are broken instead of looping', () => {
  const app = {
    projects: new Map(), worktrees: new Map(), sessions: new Map(), automations: [], chatLinks: [], diagnostics: [],
    aliases: [], parentLinks: [{ childId: 'a', parentId: 'b' }, { childId: 'b', parentId: 'a' }],
    workspaces: new Map(['a', 'b'].map(id => [id, { id, projectId: null, worktreeId: null, name: id, branch: null, createdAt: 1, archivedAt: null, sessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null }])),
  };
  const forest = buildForest(app);
  assert.equal(forest.roots.length, 1);
  assert.equal(descendants(forest, forest.roots[0].id).length, 1);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/app-db.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/readers/app-db.mjs'`.

- [ ] **Step 5: Write `engine/readers/app-db.mjs`**

```js
import { parseTime } from '../time.mjs';

/** Named columns only: data.db also holds a GitHub token column, which the engine never reads. */
export const APP_QUERIES = Object.freeze({
  projects: 'SELECT id, name, github_owner, github_repo FROM projects',
  worktrees: 'SELECT id, branch, base_branch FROM worktrees',
  workspaces: `SELECT id, project_id, worktree_id, name, branch, created_at, archived_at, session_id,
      creator_session_id, coordinating_creator_session_id,
      created_pr_repo_full_name, created_pr_number, created_pr_html_url, created_pr_state, created_pr_merged_at
    FROM workspaces`,
  parentLinks: 'SELECT child_workspace_id, parent_workspace_id FROM workspace_parent_links',
  aliases: 'SELECT session_id, workspace_id, created_at FROM workspace_session_aliases',
  chatLinks: 'SELECT session_id, parent_session_id FROM chat_parent_links',
  sessions: 'SELECT id, title, mode, model, reasoning_effort, is_running, was_interrupted, created_at, archived_at FROM sessions',
  automations: 'SELECT session_id, interval, every_minutes, last_run_at, next_run_at, paused_at, name FROM session_automations',
});

const text = value => (typeof value === 'string' && value.length ? value : null);
const count = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

export async function readAppDb(db) {
  const diagnostics = [];
  const rows = {};
  for (const [key, sql] of Object.entries(APP_QUERIES)) {
    try {
      rows[key] = await db.all(sql);
    } catch (error) {
      rows[key] = [];
      diagnostics.push({ level: 'warn', source: 'data.db', message: `${key}: ${error.message}` });
    }
  }
  return {
    projects: new Map(rows.projects.map(row => [row.id, { id: row.id, name: row.name ?? '', githubOwner: text(row.github_owner), githubRepo: text(row.github_repo) }])),
    worktrees: new Map(rows.worktrees.map(row => [row.id, { id: row.id, branch: text(row.branch), baseBranch: text(row.base_branch) }])),
    workspaces: new Map(rows.workspaces.map(row => [row.id, {
      id: row.id, projectId: text(row.project_id), worktreeId: text(row.worktree_id), name: row.name ?? '', branch: text(row.branch),
      createdAt: parseTime(row.created_at), archivedAt: parseTime(row.archived_at), sessionId: text(row.session_id),
      creatorSessionId: text(row.creator_session_id), coordinatingCreatorSessionId: text(row.coordinating_creator_session_id),
      createdPr: count(row.created_pr_number) === null ? null : {
        repo: text(row.created_pr_repo_full_name), number: count(row.created_pr_number), url: text(row.created_pr_html_url),
        state: text(row.created_pr_state), mergedAt: parseTime(row.created_pr_merged_at),
      },
    }])),
    parentLinks: rows.parentLinks.map(row => ({ childId: row.child_workspace_id, parentId: row.parent_workspace_id })),
    aliases: rows.aliases.map(row => ({ sessionId: row.session_id, workspaceId: row.workspace_id, createdAt: parseTime(row.created_at) })),
    chatLinks: rows.chatLinks.map(row => ({ sessionId: row.session_id, parentSessionId: row.parent_session_id })),
    sessions: new Map(rows.sessions.map(row => [row.id, {
      id: row.id, title: row.title ?? '', mode: text(row.mode), model: text(row.model), reasoningEffort: text(row.reasoning_effort),
      isRunning: Number(row.is_running) === 1, wasInterrupted: Number(row.was_interrupted) === 1,
      createdAt: parseTime(row.created_at), archivedAt: parseTime(row.archived_at),
    }])),
    automations: rows.automations.map(row => ({
      sessionId: row.session_id, interval: text(row.interval), everyMinutes: count(row.every_minutes),
      lastRunAt: parseTime(row.last_run_at), nextRunAt: parseTime(row.next_run_at), pausedAt: parseTime(row.paused_at), name: text(row.name),
    })),
    diagnostics,
  };
}
```

- [ ] **Step 6: Write `engine/model/forest.mjs`**

```js
function makeNode(fields) {
  return { ...fields, currentCliSessionId: fields.cliSessionIds[fields.cliSessionIds.length - 1] ?? null, parentId: null, childIds: [], depth: 0 };
}

/**
 * Session tree. Project sessions nest through workspace_parent_links; chat children through chat_parent_links; a
 * project session created by a chat (which no workspace link can express) nests under that chat. Every node with
 * children and no parent is a swarm root.
 */
export function buildForest(app) {
  const nodes = new Map();
  const workspaceOfSession = new Map();
  const aliasesByWorkspace = new Map();
  for (const alias of [...app.aliases].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    if (!alias.sessionId || !alias.workspaceId) continue;
    workspaceOfSession.set(alias.sessionId, alias.workspaceId);
    if (!aliasesByWorkspace.has(alias.workspaceId)) aliasesByWorkspace.set(alias.workspaceId, []);
    aliasesByWorkspace.get(alias.workspaceId).push(alias.sessionId);
  }
  for (const ws of app.workspaces.values()) {
    const ids = [...(aliasesByWorkspace.get(ws.id) ?? [])];
    if (ws.sessionId) {
      workspaceOfSession.set(ws.sessionId, ws.id);
      const index = ids.indexOf(ws.sessionId);
      if (index >= 0) ids.splice(index, 1);
      ids.push(ws.sessionId);
    }
    const worktree = ws.worktreeId ? app.worktrees.get(ws.worktreeId) ?? null : null;
    nodes.set(ws.id, makeNode({
      id: ws.id, kind: 'project', name: ws.name, projectId: ws.projectId, branch: ws.branch ?? worktree?.branch ?? null,
      baseBranch: worktree?.baseBranch ?? null, createdAt: ws.createdAt, archivedAt: ws.archivedAt, cliSessionIds: ids, createdPr: ws.createdPr,
    }));
  }
  const resolve = id => (!id ? null : nodes.has(id) ? id : workspaceOfSession.get(id) ?? null);
  const chatNode = id => {
    if (!id) return null;
    if (nodes.has(id)) return id;
    const row = app.sessions.get(id);
    if (!row || workspaceOfSession.has(id)) return null;
    nodes.set(id, makeNode({
      id, kind: 'chat', name: row.title, projectId: null, branch: null, baseBranch: null, createdAt: row.createdAt,
      archivedAt: row.archivedAt, cliSessionIds: [id], createdPr: null,
    }));
    return id;
  };
  const link = (childId, parentId) => {
    const child = nodes.get(childId);
    if (child && parentId && childId !== parentId && !child.parentId) child.parentId = parentId;
  };
  for (const item of app.parentLinks) if (nodes.has(item.childId) && nodes.has(item.parentId)) link(item.childId, item.parentId);
  for (const item of app.chatLinks) {
    const child = chatNode(item.sessionId);
    const parent = resolve(item.parentSessionId) ?? chatNode(item.parentSessionId);
    if (child && parent) link(child, parent);
  }
  for (const ws of app.workspaces.values()) {
    if (nodes.get(ws.id).parentId) continue;
    const creator = ws.coordinatingCreatorSessionId ?? ws.creatorSessionId;
    if (!creator || resolve(creator)) continue;
    const parent = chatNode(creator);
    if (parent) link(ws.id, parent);
  }
  for (const node of nodes.values()) {
    const seen = new Set([node.id]);
    for (let cursor = node.parentId; cursor; cursor = nodes.get(cursor)?.parentId ?? null) {
      if (seen.has(cursor)) {
        node.parentId = null;
        break;
      }
      seen.add(cursor);
    }
  }
  for (const node of nodes.values()) if (node.parentId) nodes.get(node.parentId).childIds.push(node.id);
  const byCreated = (a, b) => (nodes.get(a).createdAt ?? 0) - (nodes.get(b).createdAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  for (const node of nodes.values()) node.childIds.sort(byCreated);
  const roots = [...nodes.values()].filter(node => !node.parentId && node.childIds.length > 0);
  for (const root of roots) {
    const stack = [[root.id, 0]];
    while (stack.length) {
      const [id, depth] = stack.pop();
      const node = nodes.get(id);
      node.depth = depth;
      for (const child of node.childIds) stack.push([child, depth + 1]);
    }
  }
  roots.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { nodes, roots, workspaceOfSession };
}

export function descendants(forest, rootId) {
  const out = [];
  const visit = id => {
    for (const child of forest.nodes.get(id)?.childIds ?? []) {
      out.push(forest.nodes.get(child));
      visit(child);
    }
  };
  visit(rootId);
  return out;
}

export function treeNodes(forest, rootId) {
  const root = forest.nodes.get(rootId);
  return root ? [root, ...descendants(forest, rootId)] : [];
}

export function resolveNodeId(forest, id) {
  if (!id) return null;
  if (forest.nodes.has(id)) return id;
  return forest.workspaceOfSession.get(id) ?? null;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass for every available backend.

- [ ] **Step 8: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): read the app database and build the session tree"
```

### Task 5: Cost ledger

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/readers/ledger.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/ledger.test.mjs`

**Interfaces:**
- Consumes: `withReadOnly`, `sqliteBackends` (Task 3), `parseTime` (Task 3), `CopilotHome` (Task 4).
- Produces: `BUCKET_MS` (5 minutes); `LEDGER_SQL`; `createLedger(): Ledger` with `lastId: number`, `apply(rows)`, `session(cliId): Totals|null`, `sumFor(cliIds: string[]): Totals`; `pullLedger(db, ledger, {batch?}): Promise<number>` (rows pulled). `Totals = { nanoAiu, calls, apiMs, firstAt, lastAt, byModel: Map<model, {nanoAiu, calls, apiMs}>, byParentToolCall: Map<toolCallId, {nanoAiu, calls, apiMs}>, buckets: Map<bucketStartMs, nanoAiu> }`. Credits are `nanoAiu / 1e9`; sub-agent rows stay inside session totals.

- [ ] **Step 1: Write the failing test**

`tests/ledger.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET_MS, createLedger, pullLedger } from '../engine/readers/ledger.mjs';
import { withReadOnly } from '../engine/sqlite.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS } from './helpers/sqlite-writer.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const row = (id, sessionId, nano, extra = {}) => ({ id, session_id: sessionId, agent_id: null, parent_tool_call_id: null, model: 'claude-sonnet-5', total_nano_aiu: nano, duration_ms: 1000, created_at: new Date(T0 + id * 60_000).toISOString(), ...extra });

test('apply aggregates per session, model, sub-agent call and 5-minute bucket', () => {
  const ledger = createLedger();
  ledger.apply([
    row(1, 'cli-a', 2e9),
    row(2, 'cli-a', 3e9, { model: 'gpt-5.5', parent_tool_call_id: 'call-7', agent_id: 'agent-7' }),
    row(3, 'cli-b', 1e9, { total_nano_aiu: null }),
    row(9, 'cli-b', 4e9),
  ]);
  const a = ledger.session('cli-a');
  assert.equal(a.nanoAiu, 5e9);
  assert.equal(a.calls, 2);
  assert.equal(a.apiMs, 2000);
  assert.deepEqual(a.byModel.get('gpt-5.5'), { nanoAiu: 3e9, calls: 1, apiMs: 1000 });
  assert.deepEqual(a.byParentToolCall.get('call-7'), { nanoAiu: 3e9, calls: 1, apiMs: 1000 });
  assert.equal(a.firstAt, T0 + 60_000);
  assert.equal(a.lastAt, T0 + 120_000);
  assert.equal(a.buckets.get(Math.floor((T0 + 60_000) / BUCKET_MS) * BUCKET_MS), 5e9);
  assert.equal(ledger.session('cli-b').nanoAiu, 4e9);
  assert.equal(ledger.lastId, 9);
  const both = ledger.sumFor(['cli-a', 'cli-b', 'cli-a', 'missing']);
  assert.equal(both.nanoAiu, 9e9);
  assert.equal(both.calls, 4);
  assert.equal(both.byModel.get('claude-sonnet-5').calls, 3);
});

test('rows at or below the watermark are ignored', () => {
  const ledger = createLedger();
  ledger.apply([row(5, 'cli-a', 1e9)]);
  ledger.apply([row(5, 'cli-a', 1e9), row(4, 'cli-a', 1e9)]);
  assert.equal(ledger.session('cli-a').calls, 1);
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: pullLedger reads incrementally in batches`, async () => {
    const home = new CopilotHome();
    home.usage([
      { sessionId: 'cli-a', nanoAiu: 1e9, createdAt: T0 },
      { sessionId: 'cli-a', nanoAiu: 2e9, createdAt: T0 + 1000, parentToolCallId: 'call-1', agentId: 'agent-1', initiator: 'sub-agent' },
      { sessionId: 'cli-b', nanoAiu: 4e9, createdAt: T0 + 2000 },
    ]);
    const ledger = createLedger();
    assert.equal(await withReadOnly(home.storeDb, { backend }, db => pullLedger(db, ledger, { batch: 2 })), 3);
    assert.equal(ledger.sumFor(['cli-a', 'cli-b']).nanoAiu, 7e9);
    home.usage([{ sessionId: 'cli-a', nanoAiu: 8e9, createdAt: T0 + 3000 }]);
    assert.equal(await withReadOnly(home.storeDb, { backend }, db => pullLedger(db, ledger)), 1);
    assert.equal(ledger.session('cli-a').nanoAiu, 11e9);
    assert.equal(ledger.session('cli-a').byParentToolCall.get('call-1').nanoAiu, 2e9);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/ledger.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/readers/ledger.mjs'`.

- [ ] **Step 3: Write `engine/readers/ledger.mjs`**

```js
import { parseTime } from '../time.mjs';

export const BUCKET_MS = 5 * 60 * 1000;
export const LEDGER_SQL = `SELECT id, session_id, agent_id, parent_tool_call_id, model, total_nano_aiu, duration_ms, created_at
  FROM assistant_usage_events WHERE id > ? ORDER BY id LIMIT ?`;

function emptyTotals() {
  return { nanoAiu: 0, calls: 0, apiMs: 0, firstAt: null, lastAt: null, byModel: new Map(), byParentToolCall: new Map(), buckets: new Map() };
}

function addEntry(map, key, nanoAiu, calls, apiMs) {
  const entry = map.get(key) ?? { nanoAiu: 0, calls: 0, apiMs: 0 };
  entry.nanoAiu += nanoAiu;
  entry.calls += calls;
  entry.apiMs += apiMs;
  map.set(key, entry);
}

/** Per-session cost accumulators fed from assistant_usage_events, one row per model call. */
export function createLedger() {
  const sessions = new Map();
  let lastId = 0;
  return {
    get lastId() {
      return lastId;
    },
    apply(rows) {
      for (const row of rows) {
        const id = Number(row.id);
        if (!Number.isFinite(id) || id <= lastId) continue;
        lastId = id;
        if (!row.session_id) continue;
        const nanoAiu = Number(row.total_nano_aiu) || 0;
        const apiMs = Number(row.duration_ms) || 0;
        const at = parseTime(row.created_at);
        const totals = sessions.get(row.session_id) ?? emptyTotals();
        totals.nanoAiu += nanoAiu;
        totals.calls += 1;
        totals.apiMs += apiMs;
        if (at !== null) {
          if (totals.firstAt === null || at < totals.firstAt) totals.firstAt = at;
          if (totals.lastAt === null || at > totals.lastAt) totals.lastAt = at;
          const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS;
          totals.buckets.set(bucket, (totals.buckets.get(bucket) ?? 0) + nanoAiu);
        }
        addEntry(totals.byModel, row.model || 'unknown', nanoAiu, 1, apiMs);
        if (row.parent_tool_call_id) addEntry(totals.byParentToolCall, row.parent_tool_call_id, nanoAiu, 1, apiMs);
        sessions.set(row.session_id, totals);
      }
    },
    session(id) {
      return sessions.get(id) ?? null;
    },
    sumFor(ids) {
      const total = emptyTotals();
      for (const id of new Set(ids)) {
        const totals = sessions.get(id);
        if (!totals) continue;
        total.nanoAiu += totals.nanoAiu;
        total.calls += totals.calls;
        total.apiMs += totals.apiMs;
        if (totals.firstAt !== null && (total.firstAt === null || totals.firstAt < total.firstAt)) total.firstAt = totals.firstAt;
        if (totals.lastAt !== null && (total.lastAt === null || totals.lastAt > total.lastAt)) total.lastAt = totals.lastAt;
        for (const [key, value] of totals.byModel) addEntry(total.byModel, key, value.nanoAiu, value.calls, value.apiMs);
        for (const [key, value] of totals.byParentToolCall) addEntry(total.byParentToolCall, key, value.nanoAiu, value.calls, value.apiMs);
        for (const [key, value] of totals.buckets) total.buckets.set(key, (total.buckets.get(key) ?? 0) + value);
      }
      return total;
    },
  };
}

/** Pull every row newer than the ledger's watermark. Returns the number of rows read. */
export async function pullLedger(db, ledger, { batch = 20_000 } = {}) {
  let pulled = 0;
  for (;;) {
    const rows = await db.all(LEDGER_SQL, [ledger.lastId, batch]);
    ledger.apply(rows);
    pulled += rows.length;
    if (rows.length < batch) return pulled;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): read the cost ledger incrementally"
```

### Task 6: Session files and process liveness

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/readers/session-files.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/readers/process-probe.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/session-files.test.mjs`

**Interfaces:**
- Consumes: `withReadOnly`, `sqliteBackends` (Task 3); `CopilotHome`, `CHILDREN_SCHEMA` (Task 4).
- Produces:
  - `session-files.mjs`: `readWorkspaceYaml(dir): {cwd, branch, hostType, repository}|null`; `listLocks(dir): {pid, mtimeMs}[]|null` (null when the folder is missing); `SESSION_DB_QUERIES`; `readSessionDb(file, sqliteOptions): Promise<{ todos: {id, title, description, status}[], deps: {todoId, dependsOn}[], children: object[]|null }|null>` (`children` is null when the table is absent or unreadable; raw registry rows otherwise); `createSessionDbCache(read?): (file, sqliteOptions) => Promise<result|null>` (re-reads only when mtime or size changes).
  - `process-probe.mjs`: `parsePsOutput(text): Map<pid, startedAtMs>`; `createProcessProbe({execFileImpl?, kill?, slackMs?}): (locks) => Promise<Map<pid, boolean>>`.

- [ ] **Step 1: Write the failing test**

`tests/session-files.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSessionDbCache, listLocks, readSessionDb, readWorkspaceYaml } from '../engine/readers/session-files.mjs';
import { createProcessProbe, parsePsOutput } from '../engine/readers/process-probe.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS } from './helpers/sqlite-writer.mjs';

const home = new CopilotHome();

test('workspace.yaml gives cwd, branch, code host and repository', () => {
  home.workspaceYaml('cli-1', { cwd: '/synthetic/worktrees/one', branch: 'feature/one', hostType: 'ado', repository: 'org/project/repo' });
  assert.deepEqual(readWorkspaceYaml(home.dir('cli-1')), { cwd: '/synthetic/worktrees/one', branch: 'feature/one', hostType: 'ado', repository: 'org/project/repo' });
  home.workspaceYaml('cli-2', { cwd: "'/synthetic/quoted path'" });
  assert.deepEqual(readWorkspaceYaml(home.dir('cli-2')), { cwd: '/synthetic/quoted path', branch: null, hostType: null, repository: null });
  assert.equal(readWorkspaceYaml(path.join(home.stateDir, 'missing')), null);
});

test('lock files list their PIDs and times', () => {
  home.lock('cli-3', 4242, 1_700_000_000_000);
  writeFileSync(path.join(home.dir('cli-3'), 'inuse.oops.lock'), '');
  assert.deepEqual(listLocks(home.dir('cli-3')), [{ pid: 4242, mtimeMs: 1_700_000_000_000 }]);
  assert.deepEqual(listLocks(home.dir('cli-4')), []);
  assert.equal(listLocks(path.join(home.stateDir, 'missing')), null);
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: session.db gives todos, dependencies and the registry`, async () => {
    const file = home.sessionDb(`cli-db-${backend}`, {
      todos: [{ id: 'a', title: 'First', status: 'done' }, { id: 'b', description: 'Uses ws-123' }],
      deps: [['b', 'a']],
      children: [{ unit: 'api', session_id: 'ws-123', title: 'API', created_at: '2026-10-15T08:00:00Z', updated_at: '2026-10-15T09:00:00Z' }],
    });
    const result = await readSessionDb(file, { backend });
    assert.deepEqual(result.todos, [
      { id: 'a', title: 'First', description: '', status: 'done' },
      { id: 'b', title: 'b', description: 'Uses ws-123', status: 'pending' },
    ]);
    assert.deepEqual(result.deps, [{ todoId: 'b', dependsOn: 'a' }]);
    assert.equal(result.children.length, 1);
    assert.equal(result.children[0].unit, 'api');
    assert.equal(result.children[0].pr_id, null);
  });

  test(`${backend}: a session.db without a registry has children null`, async () => {
    const file = home.sessionDb(`cli-plain-${backend}`, { todos: [] });
    assert.deepEqual(await readSessionDb(file, { backend }), { todos: [], deps: [], children: null });
  });
}

test('the session.db cache re-reads only after a change', async () => {
  const file = home.sessionDb('cli-cache', { todos: [{ id: 'a' }] });
  let reads = 0;
  const get = createSessionDbCache(async () => ({ read: ++reads }));
  assert.deepEqual(await get(file), { read: 1 });
  assert.deepEqual(await get(file), { read: 1 });
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(await get(file), { read: 2 });
  assert.equal(await get(path.join(home.stateDir, 'none', 'session.db')), null);
});

test('parsePsOutput reads PID and start time lines', () => {
  const started = parsePsOutput('  101 Thu Oct 15 09:59:40 2026\n bad line\n202 Thu Oct 15 10:00:00 2026\n');
  assert.equal(started.size, 2);
  assert.equal(started.get(101), new Date(2026, 9, 15, 9, 59, 40).getTime());
});

test('a lock is alive only when its PID exists and started before the lock was written', async () => {
  const lockTime = new Date(2026, 9, 15, 10, 0, 0).getTime();
  const kill = pid => {
    if (pid === 2) {
      const error = new Error('no such process');
      error.code = 'ESRCH';
      throw error;
    }
  };
  const execFileImpl = (command, args, options, callback) => {
    assert.equal(command, 'ps');
    assert.deepEqual(args, ['-o', 'pid=,lstart=', '-p', '1,3']);
    callback(null, '1 Thu Oct 15 09:59:58 2026\n3 Thu Oct 15 11:00:00 2026\n', '');
  };
  const probe = createProcessProbe({ kill, execFileImpl });
  const result = await probe([{ pid: 1, mtimeMs: lockTime }, { pid: 2, mtimeMs: lockTime }, { pid: 3, mtimeMs: lockTime }]);
  assert.deepEqual([...result], [[2, false], [1, true], [3, false]]);
});

test('when ps is unavailable, a signal check decides', async () => {
  const probe = createProcessProbe({ kill: () => {}, execFileImpl: (c, a, o, callback) => callback(Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }), '', '') });
  assert.deepEqual([...(await probe([{ pid: 7, mtimeMs: 0 }]))], [[7, true]]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/session-files.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/readers/session-files.mjs'`.

- [ ] **Step 3: Write `engine/readers/session-files.mjs`**

```js
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { withReadOnly } from '../sqlite.mjs';

export function readWorkspaceYaml(dir) {
  let text;
  try {
    text = readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');
  } catch {
    return null;
  }
  const fields = { cwd: 'cwd', branch: 'branch', host_type: 'hostType', repository: 'repository' };
  const out = { cwd: null, branch: null, hostType: null, repository: null };
  for (const line of text.split(/\r?\n/)) {
    const match = /^(cwd|branch|host_type|repository):[ \t]*(.*)$/.exec(line);
    if (match) out[fields[match[1]]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return out;
}

export function listLocks(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const locks = [];
  for (const name of names) {
    const match = /^inuse\.(\d+)\.lock$/.exec(name);
    if (!match) continue;
    try {
      locks.push({ pid: Number(match[1]), mtimeMs: Math.round(statSync(path.join(dir, name)).mtimeMs) });
    } catch {
      // removed between readdir and stat
    }
  }
  return locks;
}

export const SESSION_DB_QUERIES = Object.freeze({
  todos: 'SELECT id, title, description, status FROM todos',
  deps: 'SELECT todo_id, depends_on FROM todo_deps',
  hasChildren: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'children'",
  children: `SELECT unit, session_id, title, todo_id, branch, base_branch, pr_provider, pr_repo, pr_id, pr_url, outcome,
    created_at, updated_at, ended_at FROM children`,
});

export async function readSessionDb(file, sqliteOptions = {}) {
  return withReadOnly(file, sqliteOptions, async db => {
    const safe = async sql => {
      try {
        return await db.all(sql);
      } catch {
        return null;
      }
    };
    const todos = (await safe(SESSION_DB_QUERIES.todos)) ?? [];
    const deps = (await safe(SESSION_DB_QUERIES.deps)) ?? [];
    const hasChildren = ((await safe(SESSION_DB_QUERIES.hasChildren)) ?? []).length > 0;
    return {
      todos: todos.map(todo => ({
        id: String(todo.id), title: String(todo.title ?? ''), description: typeof todo.description === 'string' ? todo.description : '',
        status: String(todo.status ?? 'pending'),
      })),
      deps: deps.map(dep => ({ todoId: String(dep.todo_id), dependsOn: String(dep.depends_on) })),
      children: hasChildren ? await safe(SESSION_DB_QUERIES.children) : null,
    };
  });
}

export function createSessionDbCache(read = readSessionDb) {
  const cache = new Map();
  return async function get(file, sqliteOptions) {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      cache.delete(file);
      return null;
    }
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.value;
    const value = await read(file, sqliteOptions);
    cache.set(file, { key, value });
    return value;
  };
}
```

- [ ] **Step 4: Write `engine/readers/process-probe.mjs`**

```js
import { execFile } from 'node:child_process';

export function parsePsOutput(text) {
  const started = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const at = Date.parse(match[2]);
    if (Number.isFinite(at)) started.set(Number(match[1]), at);
  }
  return started;
}

/**
 * Liveness of Copilot CLI processes from their inuse.<pid>.lock files. A lock is live when its PID exists, can be
 * signalled by this user, and started no later than the lock file was written, so a reused PID does not count.
 */
export function createProcessProbe({ execFileImpl = execFile, kill = (pid, signal) => process.kill(pid, signal), slackMs = 5000 } = {}) {
  return async function probe(locks) {
    const result = new Map();
    const candidates = [];
    for (const lock of locks) {
      try {
        kill(lock.pid, 0);
        candidates.push(lock);
      } catch {
        result.set(lock.pid, false);
      }
    }
    if (!candidates.length) return result;
    const started = await new Promise(resolve => {
      execFileImpl('ps', ['-o', 'pid=,lstart=', '-p', candidates.map(lock => lock.pid).join(',')],
        { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 },
        (error, stdout) => resolve(error && !String(stdout ?? '').trim() ? null : parsePsOutput(stdout)));
    });
    for (const lock of candidates) {
      if (!started) {
        result.set(lock.pid, true);
        continue;
      }
      const at = started.get(lock.pid);
      result.set(lock.pid, at !== undefined && at <= lock.mtimeMs + slackMs);
    }
    return result;
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): read session files and probe process liveness"
```

### Task 7: Event log tailing

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/readers/events.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/events.test.mjs`

**Interfaces:**
- Consumes: `tempDir` (Task 1); `ownString` (Task 3).
- Produces: `createTail(file): Tail`; `readNewLines(tail, onLine: (line: string) => void, {chunkSize?, onReset?}): Promise<{ missing: boolean, reset: boolean, lines: number, bytes: number }>`. When the file shrank or was replaced, the tail restarts at byte 0, `onReset()` runs before any line is delivered (the caller rebuilds the session state there), and the result has `reset: true`. A trailing line without `\n` is held back until it is complete. Reads use 256 KB chunks by default, so memory stays bounded however large the log is; the held-back partial line is an owned copy.

- [ ] **Step 1: Write the failing test**

`tests/events.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTail, readNewLines } from '../engine/readers/events.mjs';
import { tempDir } from './helpers/temp.mjs';

const dir = tempDir('swarm-events-');

async function collect(tail, options) {
  const received = [];
  const result = await readNewLines(tail, line => received.push(line), options);
  return { received, ...result };
}

test('reads complete lines and holds back a partial last line', async () => {
  const file = path.join(dir, 'a.jsonl');
  writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":');
  const tail = createTail(file);
  let read = await collect(tail);
  assert.deepEqual(read.received, ['{"n":1}', '{"n":2}']);
  assert.equal(read.reset, false);
  appendFileSync(file, '3}\r\n\n');
  read = await collect(tail);
  assert.deepEqual(read.received, ['{"n":3}']);
  read = await collect(tail);
  assert.deepEqual(read, { received: [], missing: false, reset: false, lines: 0, bytes: 0 });
});

test('multi-byte characters split across chunks survive', async () => {
  const file = path.join(dir, 'b.jsonl');
  writeFileSync(file, `${JSON.stringify({ text: 'café – 日本' })}\n`);
  const tail = createTail(file);
  const read = await collect(tail, { chunkSize: 3 });
  assert.deepEqual(read.received.map(line => JSON.parse(line).text), ['café – 日本']);
});

test('a shrunk file restarts from the beginning, calling onReset before any line', async () => {
  const file = path.join(dir, 'c.jsonl');
  writeFileSync(file, '{"n":1}\n{"n":2}\n');
  const tail = createTail(file);
  await collect(tail);
  truncateSync(file, 0);
  appendFileSync(file, '{"n":9}\n');
  const order = [];
  const result = await readNewLines(tail, line => order.push(line), { onReset: () => order.push('reset') });
  assert.equal(result.reset, true);
  assert.deepEqual(order, ['reset', '{"n":9}']);
});

test('a replaced file restarts from the beginning and reports a reset', async () => {
  const file = path.join(dir, 'd.jsonl');
  writeFileSync(file, '{"n":1}\n');
  const tail = createTail(file);
  await collect(tail);
  const replacement = path.join(dir, 'd-new.jsonl');
  writeFileSync(replacement, '{"n":1}\n{"n":2}\n');
  renameSync(replacement, file);
  const read = await collect(tail);
  assert.equal(read.reset, true);
  assert.deepEqual(read.received, ['{"n":1}', '{"n":2}']);
});

test('a missing file reports missing without throwing', async () => {
  const read = await collect(createTail(path.join(dir, 'none.jsonl')));
  assert.equal(read.missing, true);
  assert.deepEqual(read.received, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/events.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/readers/events.mjs'`.

- [ ] **Step 3: Write `engine/readers/events.mjs`**

```js
import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { ownString } from '../text.mjs';

export function createTail(file) {
  return { file, offset: 0, ino: null, remainder: '', decoder: new StringDecoder('utf8') };
}

/**
 * Deliver complete lines appended since the last call, reading by byte offset in fixed-size chunks with async reads, so
 * memory stays bounded however large the log is and large logs do not block the event loop. A file that shrank or was
 * replaced restarts at byte 0 and reports reset.
 */
export async function readNewLines(tail, onLine, { chunkSize = 256 * 1024, onReset = null } = {}) {
  let info;
  try {
    info = await stat(tail.file);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, reset: false, lines: 0, bytes: 0 };
    throw error;
  }
  let reset = false;
  if ((tail.ino !== null && info.ino !== tail.ino) || info.size < tail.offset) {
    tail.offset = 0;
    tail.remainder = '';
    tail.decoder = new StringDecoder('utf8');
    reset = true;
    if (onReset) onReset();
  }
  tail.ino = info.ino;
  if (info.size === tail.offset) return { missing: false, reset, lines: 0, bytes: 0 };
  let lines = 0;
  let bytes = 0;
  const handle = await open(tail.file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkSize, info.size - tail.offset)));
    while (tail.offset < info.size) {
      const length = Math.min(buffer.length, info.size - tail.offset);
      const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
      if (bytesRead <= 0) break;
      tail.offset += bytesRead;
      bytes += bytesRead;
      const parts = (tail.remainder + tail.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      tail.remainder = ownString(parts.pop());
      for (const part of parts) {
        const line = part.endsWith('\r') ? part.slice(0, -1) : part;
        if (!line) continue;
        lines += 1;
        onLine(line);
      }
    }
  } finally {
    await handle.close();
  }
  return { missing: false, reset, lines, bytes };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): tail session event logs by byte offset"
```

### Task 8: Orchestrator data-contract parsers

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/contract.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/contract.test.mjs`

**Interfaces:**
- Consumes: `REPORT_STATUSES`, `PR_PROVIDERS`, `OUTCOMES` (Task 2); `parseTime` (Task 3).
- Produces: `UNIT_LABEL_RE`; `STATUS_LINE_PREFIX = 'swarm-status:'`; `purposeToStatus(purpose): ReportStatus|null`; `parseStatusLine(text): {status, unit, pr: {provider, id}|null, commit: string|null}|null`; `parseReportBody(text): {summary: string|null, evidence: string[], blockers: string[]|null, freeText: string|null}`; `parseQuestionTag(question): {units: string[], need: 'question'|'plan'|'pr', text: string}|null` (`units` is `['*']` for the whole swarm); `normaliseRegistry(rowSets: object[][]): { units: Map<lowercaseLabel, RegistryRow>, invalid: number }` with `RegistryRow = { unit, sessionId, title, todoId, branch, baseBranch, prProvider, prRepo, prId, prUrl, outcome, createdAt, updatedAt, endedAt }`.

Rules come from the spec's section 10: a malformed status line, tag or registry row is ignored (the caller falls back to section 11 heuristics); unknown status-line fields are ignored; an invalid optional field (`pr=`, `commit=`) is dropped while the line still counts; tags are strict (unknown keys make the tag malformed); registry rows from several CLI sessions keep the latest `updated_at` per case-insensitive unit.

- [ ] **Step 1: Write the failing test**

`tests/contract.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseRegistry, parseQuestionTag, parseReportBody, parseStatusLine, purposeToStatus } from '../engine/model/contract.mjs';

const EXAMPLE = [
  'swarm-status: complete unit=api pr=github:42 commit=3f9a2c1',
  'Summary: The endpoint and its tests are done, and a draft PR is open.',
  'Evidence:',
  '- 120 API tests pass',
  '- A second-model review found no issues',
  'Blockers: none',
].join('\n');

test('the spec example status line parses', () => {
  assert.deepEqual(parseStatusLine(EXAMPLE), { status: 'complete', unit: 'api', pr: { provider: 'github', id: 42 }, commit: '3f9a2c1' });
});

test('status line fields may come in any order and unknown fields are ignored', () => {
  assert.deepEqual(parseStatusLine('swarm-status: needs_input commit=abcdef1 extra=1 unit=F2b pr=ado:4711'),
    { status: 'needs_input', unit: 'F2b', pr: { provider: 'ado', id: 4711 }, commit: 'abcdef1' });
});

test('invalid optional fields are dropped; invalid required parts reject the line', () => {
  assert.deepEqual(parseStatusLine('swarm-status: progress unit=api pr=gitlab:4 commit=XYZ'), { status: 'progress', unit: 'api', pr: null, commit: null });
  for (const bad of [
    'swarm-status: done unit=api', 'swarm-status: complete', 'swarm-status: complete unit=bad?label',
    `swarm-status: complete unit=${'x'.repeat(33)}`, 'Swarm-Status: complete unit=api', 'status: complete unit=api', '', null,
  ]) assert.equal(parseStatusLine(bad), null, String(bad));
});

test('purpose maps to report status', () => {
  assert.equal(purposeToStatus('handoff'), 'complete');
  assert.equal(purposeToStatus('progress'), 'progress');
  assert.equal(purposeToStatus('needs_input'), 'needs_input');
  assert.equal(purposeToStatus('error'), 'blocked');
  assert.equal(purposeToStatus(undefined), null);
});

test('report fields parse in one-line and block form', () => {
  const body = EXAMPLE.split('\n').slice(1).join('\n');
  assert.deepEqual(parseReportBody(body), {
    summary: 'The endpoint and its tests are done, and a draft PR is open.',
    evidence: ['120 API tests pass', 'A second-model review found no issues'],
    blockers: [],
    freeText: null,
  });
});

test('text before the first label is free text, labels are case-insensitive, and continuation lines join', () => {
  const body = ['Picked up the review comments.', '', 'SUMMARY:', 'Two fixes pushed.', 'Both small.', 'blockers:', '- Waiting for the parent', '  branch to merge'].join('\n');
  assert.deepEqual(parseReportBody(body), {
    summary: 'Two fixes pushed. Both small.',
    evidence: [],
    blockers: ['Waiting for the parent branch to merge'],
    freeText: 'Picked up the review comments.',
  });
});

test('a body without labels is all free text', () => {
  assert.deepEqual(parseReportBody('Plain update.\nNothing structured.'), { summary: null, evidence: [], blockers: null, freeText: 'Plain update.\nNothing structured.' });
});

test('question tags name units and an optional need', () => {
  assert.deepEqual(parseQuestionTag('[unit=api] Use the new client?'), { units: ['api'], need: 'question', text: 'Use the new client?' });
  assert.deepEqual(parseQuestionTag('[unit=api,F2b need=pr] Merge both PRs?'), { units: ['api', 'F2b'], need: 'pr', text: 'Merge both PRs?' });
  assert.deepEqual(parseQuestionTag('[unit=* need=plan] Approve the plan?'), { units: ['*'], need: 'plan', text: 'Approve the plan?' });
  for (const bad of ['Use the new client?', '[need=pr] Merge?', '[unit=api need=later] Merge?', '[unit=api who=me] Merge?', '[unit=bad label] Merge?', '[unit=api unit=b] Merge?']) {
    assert.equal(parseQuestionTag(bad), null, bad);
  }
});

test('the registry keeps valid rows and the latest update per unit across sessions', () => {
  const base = { session_id: 'ws-1', title: 'API', created_at: '2026-10-15T08:00:00Z', updated_at: '2026-10-15T09:00:00Z' };
  const { units, invalid } = normaliseRegistry([
    [{ ...base, unit: 'api' }, { ...base, unit: 'bad unit' }, { ...base, unit: 'docs', session_id: '' }],
    [{ ...base, unit: 'API', title: 'API v2', updated_at: '2026-10-15T10:00:00Z', pr_provider: 'ado', pr_id: 4711, pr_repo: 'org/project/repo', outcome: 'merged', ended_at: '2026-10-15T10:00:00Z' }],
    [{ ...base, unit: 'web', pr_provider: 'github', pr_id: null, outcome: 'abandoned' }],
  ]);
  assert.equal(invalid, 2);
  assert.deepEqual([...units.keys()], ['api', 'web']);
  const api = units.get('api');
  assert.equal(api.unit, 'API');
  assert.equal(api.title, 'API v2');
  assert.equal(api.prProvider, 'ado');
  assert.equal(api.prId, 4711);
  assert.equal(api.outcome, 'merged');
  assert.equal(api.endedAt, Date.UTC(2026, 9, 15, 10));
  const web = units.get('web');
  assert.equal(web.prProvider, null);
  assert.equal(web.outcome, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/contract.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/model/contract.mjs'`.

- [ ] **Step 3: Write `engine/model/contract.mjs`**

```js
import { OUTCOMES, PR_PROVIDERS, REPORT_STATUSES } from '../schema.mjs';
import { parseTime } from '../time.mjs';

export const UNIT_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const STATUS_LINE_PREFIX = 'swarm-status:';
const PURPOSE_STATUS = { handoff: 'complete', progress: 'progress', needs_input: 'needs_input', error: 'blocked' };
const NEEDS = new Set(['question', 'plan', 'pr']);
const LABEL_RE = /^(summary|evidence|blockers):[ \t]*(.*)$/i;

export function purposeToStatus(purpose) {
  return Object.prototype.hasOwnProperty.call(PURPOSE_STATUS, purpose) ? PURPOSE_STATUS[purpose] : null;
}

/** Contract v1 status line, read from the first line of a report. */
export function parseStatusLine(text) {
  if (typeof text !== 'string') return null;
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (!first.startsWith(STATUS_LINE_PREFIX)) return null;
  const [status, ...tokens] = first.slice(STATUS_LINE_PREFIX.length).trim().split(/\s+/);
  if (!REPORT_STATUSES.includes(status)) return null;
  const fields = new Map();
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0 && !fields.has(token.slice(0, eq))) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const unit = fields.get('unit');
  if (!unit || !UNIT_LABEL_RE.test(unit)) return null;
  const pr = /^(ado|github):([1-9]\d{0,9})$/.exec(fields.get('pr') ?? '');
  const commit = fields.get('commit') ?? '';
  return { status, unit, pr: pr ? { provider: pr[1], id: Number(pr[2]) } : null, commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null };
}

/** Summary, Evidence and Blockers fields; text before the first label is free text. */
export function parseReportBody(text) {
  const sections = new Map();
  const free = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = LABEL_RE.exec(line);
    if (match) {
      const key = match[1].toLowerCase();
      if (!sections.has(key)) sections.set(key, { inline: match[2].trim(), lines: [] });
      current = sections.get(key);
      continue;
    }
    if (current) current.lines.push(line);
    else free.push(line);
  }
  const items = section => {
    if (!section) return [];
    const out = section.inline ? [section.inline] : [];
    for (const raw of section.lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('- ')) out.push(line.slice(2).trim());
      else if (/^\s/.test(raw) && out.length) out[out.length - 1] = `${out[out.length - 1]} ${line}`;
      else out.push(line);
    }
    return out;
  };
  const blockers = items(sections.get('blockers'));
  const freeText = free.join('\n').trim();
  return {
    summary: sections.has('summary') ? items(sections.get('summary')).join(' ').trim() || null : null,
    evidence: items(sections.get('evidence')),
    blockers: !sections.has('blockers') ? null : blockers.length === 1 && /^none\.?$/i.test(blockers[0]) ? [] : blockers,
    freeText: freeText || null,
  };
}

/** "[unit=<unit>[,<unit>...]|* [need=question|plan|pr]] <question>". Strict: anything else is untagged. */
export function parseQuestionTag(question) {
  if (typeof question !== 'string') return null;
  const match = /^\s*\[([^\]\n]*)\]\s*/.exec(question);
  if (!match) return null;
  const fields = new Map();
  for (const token of match[1].trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) return null;
    const key = token.slice(0, eq);
    if (fields.has(key) || (key !== 'unit' && key !== 'need')) return null;
    fields.set(key, token.slice(eq + 1));
  }
  const unit = fields.get('unit');
  if (!unit) return null;
  const units = unit === '*' ? ['*'] : unit.split(',');
  if (unit !== '*' && !units.every(label => UNIT_LABEL_RE.test(label))) return null;
  const need = fields.get('need') ?? 'question';
  if (!NEEDS.has(need)) return null;
  return { units, need, text: question.slice(match[0].length).trim() };
}

const textOrNull = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

function registryRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unit = typeof raw.unit === 'string' ? raw.unit : '';
  const sessionId = textOrNull(raw.session_id);
  const title = textOrNull(raw.title);
  const createdAt = parseTime(raw.created_at);
  const updatedAt = parseTime(raw.updated_at);
  if (!UNIT_LABEL_RE.test(unit) || !sessionId || !title || createdAt === null || updatedAt === null) return null;
  const prId = raw.pr_id === null || raw.pr_id === undefined || raw.pr_id === '' ? null : Number(raw.pr_id);
  const validPr = PR_PROVIDERS.includes(raw.pr_provider) && Number.isInteger(prId) && prId > 0;
  const outcome = OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
  return {
    unit, sessionId, title, todoId: textOrNull(raw.todo_id), branch: textOrNull(raw.branch), baseBranch: textOrNull(raw.base_branch),
    prProvider: validPr ? raw.pr_provider : null, prRepo: textOrNull(raw.pr_repo), prId: validPr ? prId : null, prUrl: textOrNull(raw.pr_url),
    outcome, createdAt, updatedAt, endedAt: outcome ? parseTime(raw.ended_at) : null,
  };
}

/** The `children` registry rows of every CLI session of the orchestrator, merged by unit. */
export function normaliseRegistry(rowSets) {
  const units = new Map();
  let invalid = 0;
  for (const rows of rowSets) {
    for (const raw of rows ?? []) {
      const row = registryRow(raw);
      if (!row) {
        invalid += 1;
        continue;
      }
      const key = row.unit.toLowerCase();
      const previous = units.get(key);
      if (!previous || row.updatedAt > previous.updatedAt) units.set(key, row);
    }
  }
  return { units, invalid };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): parse the orchestrator data contract"
```

### Task 9: Session reducer — activity

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/state-utils.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/model/session-state.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/fold.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/session-state.test.mjs`

**Interfaces:**
- Consumes: `parseTime` (Task 3), `oneLine`, `clip` (Task 3), `EventLog` (Task 4).
- Produces:
  - `state-utils.mjs`: `LIMITS` (`feed` 120, `marks` 400, `sent` 40, `inbound` 80, `taskCompletes` 20, `recent` 200, `spans` 5000, `saves` 50, `wakes` 500); `pushBounded(list, item, max)`; `addFeed(state, at, kind, text)`; `addMark(state, at, kind, text, status = null)`.
  - `tests/helpers/fold.mjs`: `fold(log, id = 'cli-1'): SessionState`.
  - `session-state.mjs`: `SKIP_TYPES`; `createSessionState(cliId): SessionState`; `applyLine(state, line)`; `applyEvent(state, event)`. `SessionState` fields: `id, lines, parseErrors, firstEventAt, lastEventAt, lastEventType, lastMainAt, copilotVersion, model, mode, turn: {startedAt, progressAt}|null, busySince, lastTurnEndAt, busySpans: [start, end][], busyMs, openTools: Map<callId, {id, name, startedAt, args: {summary, mode, initialWait, delay, timeout, wait}}>, waits: Map<callId, {id, kind: 'question'|'plan', text, startedAt}>, waitSpans: [start, end, kind][], waitingMs, subagents: Map<callId, {id, name, type, mode, model, effort, task, launchedAt, startedAt, endedAt, durationMs, status, lastEventAt, agentId}>, agentToTask: Map<agentId, callId>, sent: [], inbound: [], lastInboundAt, lastHumanAt, taskCompletes: [], automation: {saves: [], wakes: []}, shutdownAt, abortAt, lastErrorAt, recent: {failures: number[], calls: {at, name, key, prompt}[], compactions: number[], denials: number[]}, prompts` (main-session user messages so far), `feed: {at, kind, text}[], marks: {at, kind, text, status}[], prMentions: Map`. Task 10 fills `sent`, `inbound`, `taskCompletes`, `automation` and `prMentions`.

Rules: an event with `data.parentToolCallId` or a top-level `agentId` belongs to a sub-agent and only refreshes that sub-agent's `lastEventAt`; a `user.message` whose `source` is `agent-<own id>` is the session's own sub-agent prompt and is ignored. `session.start` and `session.resume` end the previous process's open turn, waits, tools and sub-agents at the last main-agent event; `session.shutdown` does the same at its own time; `abort` ends the turn and sync sub-agents but keeps background ones. Turns less than 5 s apart form one busy period (`busySince`).

- [ ] **Step 1: Write the fold helper and the failing test**

`tests/helpers/fold.mjs` (later test files reuse it):

```js
import { applyLine, createSessionState } from '../../engine/model/session-state.mjs';

/** Fold an EventLog through the reducer, line by line, as the engine does. */
export function fold(log, id = 'cli-1') {
  const state = createSessionState(id);
  for (const line of log.lines().trim().split('\n')) applyLine(state, line);
  return state;
}
```

`tests/session-state.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLine, createSessionState } from '../engine/model/session-state.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

test('main turns add up to busy time and chain into one busy period', () => {
  const log = new EventLog(T0);
  log.start();
  log.turnStart(); log.wait(60_000); log.turnEnd();
  log.wait(2000); log.turnStart(); log.wait(58_000); log.turnEnd();
  log.wait(60_000); log.turnStart();
  const state = fold(log);
  assert.equal(state.busyMs, 118_000);
  assert.deepEqual(state.busySpans, [[T0, T0 + 60_000], [T0 + 62_000, T0 + 120_000]]);
  assert.equal(state.lastTurnEndAt, T0 + 120_000);
  assert.deepEqual(state.turn, { startedAt: T0 + 180_000, progressAt: T0 + 180_000 });
  assert.equal(state.busySince, T0 + 180_000);
  assert.equal(state.model, 'claude-sonnet-5');
  assert.equal(state.copilotVersion, '1.0.95-3');
});

test('open tools, questions and plans are tracked until they complete', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const bash = log.tool('bash', { command: 'npm test', initial_wait: 600, mode: 'sync' });
  const patch = log.tool('apply_patch', '*** Begin Patch\n*** Update File: a.txt');
  const question = log.ask('[unit=api] Ship it?', ['Yes', 'No']);
  let state = fold(log);
  assert.deepEqual([...state.openTools.keys()], [bash, patch, question]);
  assert.deepEqual(state.openTools.get(bash).args, { summary: 'bash: npm test', mode: 'sync', initialWait: 600, delay: null, timeout: null, wait: false });
  assert.equal(state.openTools.get(patch).args.summary, 'apply_patch: *** Begin Patch *** Update File: a.txt');
  assert.deepEqual(state.waits.get(question), { id: question, kind: 'question', text: '[unit=api] Ship it?', startedAt: T0 });
  log.wait(120_000); log.done(question, { result: 'Yes' });
  const plan = log.plan('Two steps');
  log.wait(30_000); log.done(plan, { result: 'Plan approved! Exited plan mode.' });
  state = fold(log);
  assert.equal(state.waits.size, 0);
  assert.equal(state.openTools.has(question), false);
  assert.equal(state.waitingMs, 150_000);
  assert.deepEqual(state.waitSpans, [[T0, T0 + 120_000, 'question'], [T0 + 120_000, T0 + 150_000, 'plan']]);
  assert.deepEqual(state.marks.map(mark => mark.kind), ['question', 'answer', 'plan-req', 'plan-ok']);
  assert.deepEqual(state.feed.map(item => item.kind), ['question', 'answer', 'plan-req', 'plan-ok']);
});

test('sub-agents run from their task call to completion, fed by their own events', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const sync = log.subagent({ name: 'reviewer', type: 'code-review', mode: 'sync', model: 'claude-opus-5', effort: 'max', agentId: 'agent-1' });
  log.wait(60_000); log.sub(sync, 'tool.execution_start', { toolCallId: 'inner-1', toolName: 'view', arguments: { path: 'a' } });
  log.wait(60_000); log.usage('claude-opus-5', { agentId: 'agent-1' });
  log.wait(60_000); log.subagentDone(sync, { durationMs: 180_000 }); log.done(sync, { result: 'done' });
  const background = log.subagent({ name: 'explorer', type: 'explore', mode: 'background', agentId: 'agent-2' });
  const state = fold(log);
  const a = state.subagents.get(sync);
  assert.deepEqual(
    { status: a.status, startedAt: a.startedAt, endedAt: a.endedAt, durationMs: a.durationMs, type: a.type, name: a.name, effort: a.effort, mode: a.mode, lastEventAt: a.lastEventAt },
    { status: 'completed', startedAt: T0, endedAt: T0 + 180_000, durationMs: 180_000, type: 'code-review', name: 'reviewer', effort: 'max', mode: 'sync', lastEventAt: T0 + 180_000 },
  );
  const b = state.subagents.get(background);
  assert.equal(b.status, 'running');
  assert.equal(b.mode, 'background');
  assert.equal(state.agentToTask.get('agent-2'), background);
  assert.deepEqual(state.turn, { startedAt: T0, progressAt: T0 + 180_000 });
  assert.deepEqual(state.feed.map(item => item.text), ['started code-review: reviewer (sync)', 'code-review reviewer finished', 'started explore: explorer']);
});

test('sub-agent prompts and model calls are not main-agent activity', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const call = log.subagent({ agentId: 'agent-9' });
  log.wait(300_000);
  log.push('user.message', { content: 'sub prompt', source: 'agent-cli-1' });
  log.usage('claude-sonnet-5', { agentId: 'agent-9' });
  log.sub(call, 'assistant.message', { content: 'thinking' });
  const state = fold(log);
  assert.equal(state.lastInboundAt, null);
  assert.equal(state.turn.progressAt, T0);
  assert.equal(state.subagents.get(call).lastEventAt, T0 + 300_000);
  assert.equal(state.lastEventAt, T0 + 300_000);
});

test('a resume ends the work of the previous process at its last main event', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.tool('bash', { command: 'sleep 999' });
  log.ask('Still there?');
  const sync = log.subagent({ mode: 'sync' });
  const background = log.subagent({ mode: 'background' });
  log.wait(60_000); log.message();
  log.wait(3_600_000); log.resume();
  const state = fold(log);
  assert.equal(state.turn, null);
  assert.deepEqual(state.busySpans, [[T0, T0 + 60_000]]);
  assert.equal(state.openTools.size, 0);
  assert.equal(state.waits.size, 0);
  assert.deepEqual(state.waitSpans, [[T0, T0 + 60_000, 'question']]);
  assert.equal(state.subagents.get(sync).status, 'failed');
  assert.equal(state.subagents.get(background).status, 'failed');
  assert.equal(state.lastEventType, 'session.resume');
});

test('an abort ends the turn and sync sub-agents but keeps background ones', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  const sync = log.subagent({ mode: 'sync' });
  const background = log.subagent({ mode: 'background' });
  log.wait(900_000); log.abort();
  const state = fold(log);
  assert.equal(state.turn, null);
  assert.equal(state.abortAt, T0 + 900_000);
  assert.equal(state.subagents.get(sync).status, 'failed');
  assert.equal(state.subagents.get(background).status, 'running');
  assert.deepEqual(state.feed.at(-1), { at: T0 + 900_000, kind: 'abort', text: 'turn aborted' });
});

test('a shutdown is the last event and ends open work', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart(); log.wait(10_000); log.shutdown();
  const state = fold(log);
  assert.equal(state.shutdownAt, T0 + 10_000);
  assert.equal(state.lastEventType, 'session.shutdown');
  assert.equal(state.busyMs, 10_000);
});

test('failures, repeated calls, compactions and unattended denials are recorded', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  for (let i = 0; i < 3; i += 1) log.done(log.tool('bash', { command: 'npm test' }), { success: false });
  log.push('session.compaction_complete', { success: true });
  log.push('permission.completed', { decisionSource: 'unattended_fallback', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } });
  log.push('permission.completed', { decisionSource: 'user', result: { kind: 'denied-by-user' } });
  const state = fold(log);
  assert.equal(state.recent.failures.length, 3);
  assert.equal(new Set(state.recent.calls.map(call => call.key)).size, 1);
  assert.equal(state.recent.compactions.length, 1);
  assert.equal(state.recent.denials.length, 1);
});

test('tool calls remember which prompt they answer', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.done(log.tool('bash', { command: 'npm test' }));
  log.automationWake();
  log.done(log.tool('bash', { command: 'npm test' }));
  log.user('Status?');
  log.done(log.tool('bash', { command: 'npm test' }));
  const state = fold(log);
  assert.equal(state.prompts, 2);
  assert.deepEqual(state.recent.calls.map(call => call.prompt), [0, 1, 2]);
});

test('large irrelevant lines only move the clock, and malformed lines are counted', () => {
  const state = createSessionState('cli-1');
  applyLine(state, JSON.stringify({ type: 'session.usage_checkpoint', data: { huge: 'x'.repeat(1000) }, id: 'a', timestamp: new Date(T0).toISOString(), parentId: null }));
  applyLine(state, '{"type":"assistant.turn_start",');
  assert.equal(state.lastEventAt, T0);
  assert.equal(state.lastEventType, 'session.usage_checkpoint');
  assert.equal(state.parseErrors, 1);
  assert.equal(state.lines, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/session-state.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/model/session-state.mjs'`.

- [ ] **Step 3: Write `engine/model/state-utils.mjs`**

```js
import { oneLine } from '../text.mjs';

/** Caps that keep a session's state small however long its log grows. */
export const LIMITS = Object.freeze({ feed: 120, marks: 400, sent: 40, inbound: 80, taskCompletes: 20, recent: 200, spans: 5000, saves: 50, wakes: 500 });

export function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

export function addFeed(state, at, kind, text) {
  pushBounded(state.feed, { at, kind, text: oneLine(text, 200) }, LIMITS.feed);
}

export function addMark(state, at, kind, text, status = null) {
  pushBounded(state.marks, { at, kind, text: oneLine(text, 160), status }, LIMITS.marks);
}
```

- [ ] **Step 4: Write `engine/model/session-state.mjs`**

```js
import { clip, oneLine, ownString } from '../text.mjs';
import { parseTime } from '../time.mjs';
import { LIMITS, addFeed, addMark, pushBounded } from './state-utils.mjs';

/** Large event types the reducer does not need; only their timestamps are read. */
export const SKIP_TYPES = new Set([
  'session.usage_checkpoint', 'system.message', 'skill.context_delivered_ref', 'session.binary_asset',
  'session.workspace_file_changed', 'session.canvas.recorded', 'session.canvas.removed',
]);
/** Each skip type mapped to its own constant: keeping head[1], a slice of the line, would pin the whole read chunk. */
const SKIP_NAMES = new Map([...SKIP_TYPES].map(type => [type, type]));
const WAIT_TOOLS = { ask_user: 'question', exit_plan_mode: 'plan' };
const BUSY_JOIN_MS = 5000;

const argsOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : typeof value === 'string' ? { raw: value } : {});
const numberOrNull = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

export function createSessionState(id) {
  return {
    id, lines: 0, parseErrors: 0, firstEventAt: null, lastEventAt: null, lastEventType: null, lastMainAt: null,
    copilotVersion: null, model: null, mode: null,
    turn: null, busySince: null, lastTurnEndAt: null, busySpans: [], busyMs: 0,
    openTools: new Map(), waits: new Map(), waitSpans: [], waitingMs: 0,
    subagents: new Map(), agentToTask: new Map(),
    sent: [], inbound: [], lastInboundAt: null, lastHumanAt: null, taskCompletes: [],
    automation: { saves: [], wakes: [] },
    shutdownAt: null, abortAt: null, lastErrorAt: null,
    recent: { failures: [], calls: [], compactions: [], denials: [] }, prompts: 0,
    feed: [], marks: [], prMentions: new Map(),
  };
}

export function applyLine(state, line) {
  if (!line) return;
  state.lines += 1;
  const head = /^\{"type":"([^"]+)"/.exec(line);
  const skipped = head ? SKIP_NAMES.get(head[1]) : undefined;
  if (skipped) {
    const at = sniffTimestamp(line);
    if (at !== null) touch(state, at, skipped);
    return;
  }
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    state.parseErrors += 1;
    return;
  }
  if (event && typeof event === 'object' && typeof event.type === 'string') applyEvent(state, event);
}

function sniffTimestamp(line) {
  const key = '"timestamp":"';
  const index = line.lastIndexOf(key);
  if (index < 0) return null;
  const end = line.indexOf('"', index + key.length);
  return end < 0 ? null : parseTime(line.slice(index + key.length, end));
}

function touch(state, at, type) {
  if (state.firstEventAt === null || at < state.firstEventAt) state.firstEventAt = at;
  if (state.lastEventAt === null || at >= state.lastEventAt) {
    state.lastEventAt = at;
    state.lastEventType = type;
  }
}

export function applyEvent(state, event) {
  const at = parseTime(event.timestamp);
  if (at === null) return;
  touch(state, at, event.type);
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  if (event.type.startsWith('subagent.')) {
    onSubagentLifecycle(state, event, data, at);
    return;
  }
  const agentId = event.agentId === undefined || event.agentId === null ? null : String(event.agentId);
  const owner = data.parentToolCallId ?? (agentId ? state.agentToTask.get(agentId) ?? null : null);
  if (owner || agentId) {
    touchSubagent(state, owner, at);
    return;
  }
  if (event.type === 'user.message' && data.source === `agent-${state.id}`) return;
  onMainEvent(state, event.type, data, at);
  state.lastMainAt = at;
}

function onMainEvent(state, type, data, at) {
  switch (type) {
    case 'session.start':
    case 'session.resume':
      endProcess(state, state.lastMainAt ?? at);
      if (typeof data.copilotVersion === 'string') state.copilotVersion = data.copilotVersion;
      if (typeof data.selectedModel === 'string') state.model = data.selectedModel;
      break;
    case 'session.model_change':
      if (typeof data.newModel === 'string') state.model = data.newModel;
      break;
    case 'session.mode_changed':
      if (typeof data.newMode === 'string') state.mode = data.newMode;
      break;
    case 'assistant.turn_start':
      if (!state.turn) {
        const joined = state.busySince !== null && state.lastTurnEndAt !== null && at - state.lastTurnEndAt <= BUSY_JOIN_MS;
        state.busySince = joined ? state.busySince : at;
        state.turn = { startedAt: at, progressAt: at };
      }
      break;
    case 'assistant.turn_end':
      closeTurn(state, at);
      break;
    case 'assistant.message':
      if (state.turn) state.turn.progressAt = at;
      if (typeof data.model === 'string') state.model = data.model;
      break;
    case 'session.usage_record':
      if (state.turn) state.turn.progressAt = at;
      if (typeof data.usage?.model === 'string') state.model = data.usage.model;
      break;
    case 'tool.execution_start':
      onToolStart(state, data, at);
      break;
    case 'tool.execution_complete':
      onToolComplete(state, data, at);
      break;
    case 'user.message':
      state.prompts += 1;
      onUserMessage(state, data, at);
      break;
    case 'session.shutdown':
      state.shutdownAt = at;
      endProcess(state, at);
      break;
    case 'abort':
      state.abortAt = at;
      closeTurn(state, at);
      endOpenWork(state, at, true);
      addFeed(state, at, 'abort', 'turn aborted');
      break;
    case 'session.error':
      state.lastErrorAt = at;
      addFeed(state, at, 'error', `error${typeof data.errorType === 'string' ? `: ${data.errorType}` : ''}`);
      break;
    case 'session.compaction_complete':
      pushBounded(state.recent.compactions, at, LIMITS.recent);
      addFeed(state, at, 'compaction', 'compacted its context');
      break;
    case 'permission.completed':
      if (data.decisionSource === 'unattended_fallback' && /denied/i.test(String(data.result?.kind ?? ''))) {
        pushBounded(state.recent.denials, at, LIMITS.recent);
      }
      break;
    default:
      break;
  }
}

function onUserMessage(state, data, at) {
  state.lastInboundAt = at;
  if (state.turn) state.turn.progressAt = at;
  if (data.source === undefined || data.source === null) state.lastHumanAt = at;
}

function closeTurn(state, at) {
  if (!state.turn) return;
  const end = Math.max(at, state.turn.startedAt);
  pushBounded(state.busySpans, [state.turn.startedAt, end], LIMITS.spans);
  state.busyMs += end - state.turn.startedAt;
  state.turn = null;
  state.lastTurnEndAt = end;
}

function closeWait(state, id, wait, at) {
  state.waits.delete(id);
  const end = Math.max(at, wait.startedAt);
  pushBounded(state.waitSpans, [wait.startedAt, end, wait.kind], LIMITS.spans);
  state.waitingMs += end - wait.startedAt;
}

function finishSubagent(sub, at, status, durationMs) {
  sub.status = status;
  sub.endedAt = Math.max(at, sub.launchedAt);
  sub.durationMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : Math.max(0, sub.endedAt - (sub.startedAt ?? sub.launchedAt));
}

/** Work that cannot outlive the turn or process: open waits, tools and running sub-agents. */
function endOpenWork(state, at, keepBackground) {
  for (const [id, wait] of state.waits) closeWait(state, id, wait, at);
  state.openTools.clear();
  for (const sub of state.subagents.values()) {
    if (sub.status !== 'running' || (keepBackground && sub.mode === 'background')) continue;
    finishSubagent(sub, at, 'failed', null);
  }
}

function endProcess(state, at) {
  closeTurn(state, at);
  endOpenWork(state, at, false);
}

function toolArgs(name, args) {
  const pick = [args.command, args.description, args.path, args.pattern, args.url, args.query, args.name, args.session_id, args.agent_id, args.shellId, args.raw]
    .find(value => typeof value === 'string' && value.trim());
  return {
    summary: oneLine(pick ? `${name}: ${pick}` : name, 160),
    mode: typeof args.mode === 'string' ? args.mode : null,
    initialWait: numberOrNull(args.initial_wait),
    delay: numberOrNull(args.delay),
    timeout: numberOrNull(args.timeout),
    wait: args.wait === true,
  };
}

function callKey(name, raw) {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
  return ownString(`${name}|${text.length}|${text.slice(0, 400)}`);
}

function newSubagent(state, id, at, args) {
  const sub = {
    id,
    name: oneLine(args.name ?? args.description ?? 'sub-agent', 80) || 'sub-agent',
    type: oneLine(args.agent_type ?? 'task', 60) || 'task',
    mode: args.mode === 'background' ? 'background' : 'sync',
    model: typeof args.model === 'string' ? args.model : null,
    effort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : null,
    task: typeof args.description === 'string' ? oneLine(args.description, 200) : null,
    launchedAt: at, startedAt: null, endedAt: null, durationMs: null, status: 'running', lastEventAt: at, agentId: null,
  };
  state.subagents.set(id, sub);
  return sub;
}

function onToolStart(state, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  const name = typeof data.toolName === 'string' ? data.toolName : 'tool';
  const args = argsOf(data.arguments);
  state.openTools.set(id, { id, name, startedAt: at, args: toolArgs(name, args) });
  pushBounded(state.recent.calls, { at, name, key: callKey(name, data.arguments), prompt: state.prompts }, LIMITS.recent);
  const kind = WAIT_TOOLS[name];
  if (kind) {
    const text = clip(String((kind === 'question' ? args.question : args.summary) ?? ''), 2000);
    state.waits.set(id, { id, kind, text, startedAt: at });
    if (kind === 'question') {
      addMark(state, at, 'question', text || 'Question');
      addFeed(state, at, 'question', `asked: ${text}`);
    } else {
      addMark(state, at, 'plan-req', 'Plan sent for approval');
      addFeed(state, at, 'plan-req', 'sent a plan for approval');
    }
  } else if (name === 'task') {
    const sub = newSubagent(state, id, at, args);
    addFeed(state, at, 'subagent-start', `started ${sub.type}: ${sub.name}${sub.mode === 'sync' ? ' (sync)' : ''}`);
  }
}

function resultText(data) {
  const content = data.result?.content;
  return typeof content === 'string' ? content : '';
}

function onToolComplete(state, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  state.openTools.delete(id);
  if (state.turn) state.turn.progressAt = at;
  if (data.success === false) pushBounded(state.recent.failures, at, LIMITS.recent);
  const wait = state.waits.get(id);
  if (wait) {
    closeWait(state, id, wait, at);
    if (wait.kind === 'question') {
      addMark(state, at, 'answer', 'Answer received');
      addFeed(state, at, 'answer', 'got an answer');
    } else if (data.success !== false && /plan approved/i.test(resultText(data))) {
      addMark(state, at, 'plan-ok', 'Plan approved');
      addFeed(state, at, 'plan-ok', 'plan approved');
    }
  }
  const sub = state.subagents.get(id);
  if (sub) {
    const agentId = data.toolTelemetry?.restrictedProperties?.agent_id;
    if (typeof agentId === 'string') {
      sub.agentId = agentId;
      state.agentToTask.set(agentId, id);
    }
    if (sub.status === 'running' && (data.success === false || (sub.mode === 'sync' && sub.startedAt === null))) {
      finishSubagent(sub, at, data.success === false ? 'failed' : 'completed', null);
    }
  }
}

function onSubagentLifecycle(state, event, data, at) {
  const id = typeof data.toolCallId === 'string' ? data.toolCallId : null;
  if (!id) return;
  const sub = state.subagents.get(id) ?? newSubagent(state, id, at, {});
  if (event.agentId !== undefined && event.agentId !== null) {
    sub.agentId = String(event.agentId);
    state.agentToTask.set(sub.agentId, id);
  }
  if (at > sub.lastEventAt) sub.lastEventAt = at;
  if (event.type === 'subagent.started') {
    sub.startedAt = at;
    if (typeof data.model === 'string') sub.model = data.model;
    if (typeof data.agentType === 'string' && data.agentType) sub.type = oneLine(data.agentType, 60);
    if (typeof data.agentDisplayName === 'string' && data.agentDisplayName) sub.name = oneLine(data.agentDisplayName, 80);
    if (data.executionMode === 'background' || data.executionMode === 'sync') sub.mode = data.executionMode;
  } else if ((event.type === 'subagent.completed' || event.type === 'subagent.failed') && sub.status === 'running') {
    finishSubagent(sub, at, event.type === 'subagent.failed' ? 'failed' : 'completed', data.durationMs);
    addFeed(state, at, 'subagent-done', `${sub.type} ${sub.name} ${sub.status === 'failed' ? 'failed' : 'finished'}`);
  }
}

function touchSubagent(state, owner, at) {
  const sub = owner ? state.subagents.get(owner) : null;
  if (sub && at > sub.lastEventAt) sub.lastEventAt = at;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): fold session events into activity state"
```

### Task 10: Session reducer — messages, reports and monitors

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/messages.mjs`
- Modify: `ghcp/plugins/swarm-dashboard/engine/model/session-state.mjs` (imports, `onToolStart`, `onToolComplete`, the `user.message` and `session.task_complete` cases, new `mergeStates`)
- Test: `ghcp/plugins/swarm-dashboard/tests/messages.test.mjs`

**Interfaces:**
- Consumes: Task 9's reducer and `state-utils.mjs`; `fold` (Task 9 helper); `EventLog` (Task 4).
- Produces:
  - `messages.mjs`: `countPrMentions(state, text, at)` (keys `${provider ?? 'any'}::${id}` with provider `ado` or null for a bare `PR #12`, values `{provider, repo: null, id, count, firstAt, lastAt}`); `parseEnvelope(transformed): {fromSessionId, fromProjectSessionId, fromName, sourceToolCallId}|null`; `recordUserMessage(state, data, at)`; `recordToolStart(state, name, args, callId, at)`; `recordToolComplete(state, callId, data)`; `recordTaskComplete(state, data, at)`.
  - Reducer state now fills `sent: {at, toolCallId, target, purpose, message, failed}[]`, `inbound: {at, fromSessionId, fromProjectSessionId, fromName, sourceToolCallId, content}[]`, `taskCompletes: {at, success, summary}[]`, `automation.saves: {at, clear, everyMinutes, target}[]`, `automation.wakes: number[]`, `prMentions`.
  - `session-state.mjs`: `mergeStates(states: SessionState[]): SessionState` — an aggregate of one project session's CLI sessions (sums, concatenated and time-sorted lists, merged mentions, latest `lastEventAt`/`lastEventType`). Its live fields (`turn`, `openTools`, `waits`, `recent`) stay empty; status uses the current CLI session's own state.

- [ ] **Step 1: Write the failing test**

`tests/messages.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from '../engine/model/session-state.mjs';
import { parseEnvelope } from '../engine/model/messages.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

test('reports sent to other sessions keep their purpose, failure and PR mentions', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.report('ws-root', 'Opened PR !4711 for review.\nSee https://dev.azure.com/org/project/_git/repo/pullrequest/4711', 'handoff');
  log.wait(1000);
  const failed = log.tool('send_session_message', { session_id: 'ws-root', message: 'PR #12 is ready' });
  log.done(failed, { success: false });
  const state = fold(log);
  assert.deepEqual(state.sent.map(item => [item.target, item.purpose, item.failed]), [['ws-root', 'handoff', false], ['ws-root', null, true]]);
  assert.ok(state.sent[0].message.startsWith('Opened PR !4711'));
  assert.deepEqual(state.prMentions.get('ado::4711'), { provider: 'ado', repo: null, id: 4711, count: 2, firstAt: T0, lastAt: T0 });
  assert.equal(state.prMentions.get('any::12').count, 1);
});

test('GitHub pull request URLs are not counted', () => {
  const log = new EventLog(T0);
  log.start();
  log.report('ws-root', 'Ready: https://github.com/sample-org/sample-repo/pull/42', 'handoff');
  assert.equal(fold(log).prMentions.size, 0);
});

test('cross-session messages, automation wakes and human messages are told apart', () => {
  const log = new EventLog(T0);
  log.start();
  log.crossSession({ fromSessionId: 'cli-orch', fromProjectSessionId: 'ws-orch', sourceToolCallId: 'call-77', name: 'Sample story', content: 'Go ahead with option A.' });
  log.wait(1000); log.automationWake();
  log.wait(1000); log.user('Status?');
  const state = fold(log);
  assert.deepEqual(state.inbound, [{ at: T0, fromSessionId: 'cli-orch', fromProjectSessionId: 'ws-orch', fromName: 'Sample story', sourceToolCallId: 'call-77', content: 'Go ahead with option A.' }]);
  assert.deepEqual(state.automation.wakes, [T0 + 1000]);
  assert.deepEqual(state.marks.map(mark => mark.kind), ['monitor']);
  assert.equal(state.lastHumanAt, T0 + 2000);
  assert.equal(state.lastInboundAt, T0 + 2000);
});

test('parseEnvelope returns null without an envelope', () => {
  assert.equal(parseEnvelope('plain text'), null);
});

test('monitor schedules and completed tasks are recorded', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart();
  log.done(log.tool('save_session_automation', { interval: 'minutes', every_minutes: 10, prompt: 'Check PR !4321' }));
  log.wait(60_000);
  log.done(log.tool('save_session_automation', { clear: true }));
  log.taskComplete('Merged PR !4321 after review.');
  log.taskComplete('Could not finish.', false);
  const state = fold(log);
  assert.deepEqual(state.automation.saves.map(save => [save.at, save.clear, save.everyMinutes]), [[T0, false, 10], [T0 + 60_000, true, null]]);
  assert.deepEqual(state.taskCompletes.map(task => [task.success, task.summary]), [[true, 'Merged PR !4321 after review.'], [false, 'Could not finish.']]);
  assert.equal(state.prMentions.get('ado::4321').count, 1);
  assert.deepEqual(state.feed.map(item => item.text), ['started a PR monitor (every 10 min)', 'stopped its PR monitor', 'completed a task', 'reported a failed task']);
});

test('mergeStates combines the CLI sessions of one project session', () => {
  const first = new EventLog(T0);
  first.start(); first.turnStart(); first.wait(60_000);
  first.report('ws-root', 'PR !77 opened', 'progress'); first.turnEnd(); first.shutdown();
  const second = new EventLog(T0 + 3_600_000);
  second.start(); second.turnStart(); second.wait(30_000);
  second.report('ws-root', 'PR !77 merged', 'handoff'); second.turnEnd();
  const merged = mergeStates([fold(first, 'cli-a'), fold(second, 'cli-b')]);
  assert.equal(merged.busyMs, 90_000);
  assert.deepEqual(merged.busySpans, [[T0, T0 + 60_000], [T0 + 3_600_000, T0 + 3_630_000]]);
  assert.deepEqual(merged.sent.map(item => item.purpose), ['progress', 'handoff']);
  assert.equal(merged.prMentions.get('ado::77').count, 2);
  assert.equal(merged.lastEventAt, T0 + 3_630_000);
  assert.equal(merged.lastEventType, 'assistant.turn_end');
  assert.equal(merged.shutdownAt, T0 + 60_000);
  assert.equal(merged.turn, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/messages.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/model/messages.mjs'`.

- [ ] **Step 3: Write `engine/model/messages.mjs`**

```js
import { clip, ownString } from '../text.mjs';
import { LIMITS, addFeed, addMark, pushBounded } from './state-utils.mjs';

const PR_PATTERNS = [
  { provider: 'ado', re: /\/pullrequest\/(\d{1,9})\b/gi },
  { provider: 'ado', re: /(?:^|[\s(])!(\d{2,9})\b/gm },
  { provider: null, re: /\bPR\s*#?(\d{1,9})\b/gi },
];

/** Count PR references for the Azure DevOps heuristic: !123 and /pullrequest/123, and a bare "PR #12" (provider unknown). */
export function countPrMentions(state, text, at) {
  if (typeof text !== 'string' || !text) return;
  for (const { provider, re } of PR_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const id = Number(match[1]);
      if (!Number.isInteger(id) || id <= 0) continue;
      const key = `${provider ?? 'any'}::${id}`;
      const entry = state.prMentions.get(key) ?? { provider, repo: null, id, count: 0, firstAt: at, lastAt: at };
      entry.count += 1;
      entry.lastAt = Math.max(entry.lastAt, at);
      state.prMentions.set(key, entry);
    }
  }
}

/** Fields of the app's <cross_session_message> envelope, which lives only in transformedContent. */
export function parseEnvelope(transformed) {
  const start = transformed.indexOf('<cross_session_message>');
  if (start < 0) return null;
  const end = transformed.indexOf('</cross_session_message>', start);
  const block = transformed.slice(start, end < 0 ? undefined : end);
  const field = name => {
    const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(block);
    return match && match[1].trim() ? ownString(match[1].trim()) : null;
  };
  return {
    fromSessionId: field('from_session_id'),
    fromProjectSessionId: field('from_project_session_id'),
    fromName: field('from_project_session_name') ?? field('from_display_name'),
    sourceToolCallId: field('source_tool_call_id'),
  };
}

export function recordUserMessage(state, data, at) {
  state.lastInboundAt = at;
  if (state.turn) state.turn.progressAt = at;
  const transformed = typeof data.transformedContent === 'string' ? data.transformedContent : '';
  if (transformed.includes('<session_automation')) {
    pushBounded(state.automation.wakes, at, LIMITS.wakes);
    addMark(state, at, 'monitor', 'PR monitor check');
    addFeed(state, at, 'monitor-check', 'PR monitor check');
    return;
  }
  const envelope = transformed.includes('<cross_session_message>') ? parseEnvelope(transformed) : null;
  if (envelope) {
    const content = typeof data.content === 'string' ? data.content : '';
    pushBounded(state.inbound, { at, ...envelope, content: clip(content, 8000) ?? '' }, LIMITS.inbound);
    return;
  }
  if (data.source === undefined || data.source === null) state.lastHumanAt = at;
}

export function recordToolStart(state, name, args, callId, at) {
  if (name === 'send_session_message') {
    const message = clip(typeof args.message === 'string' ? args.message : '', 8000) ?? '';
    pushBounded(state.sent, {
      at, toolCallId: callId, target: typeof args.session_id === 'string' ? args.session_id : null,
      purpose: typeof args.purpose === 'string' ? args.purpose : null, message, failed: false,
    }, LIMITS.sent);
    countPrMentions(state, message, at);
  } else if (name === 'save_session_automation') {
    const clear = args.clear === true;
    const minutes = Number(args.every_minutes);
    const everyMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
    pushBounded(state.automation.saves, { at, clear, everyMinutes, target: typeof args.session_id === 'string' ? args.session_id : null }, LIMITS.saves);
    addFeed(state, at, clear ? 'monitor-cleared' : 'monitor-set', clear ? 'stopped its PR monitor' : `started a PR monitor${everyMinutes ? ` (every ${everyMinutes} min)` : ''}`);
  }
}

export function recordToolComplete(state, callId, data) {
  if (data.success !== false) return;
  const entry = state.sent.find(item => item.toolCallId === callId);
  if (entry) entry.failed = true;
}

export function recordTaskComplete(state, data, at) {
  const summary = clip(typeof data.summary === 'string' ? data.summary : '', 4000) ?? '';
  const success = data.success !== false;
  pushBounded(state.taskCompletes, { at, success, summary }, LIMITS.taskCompletes);
  countPrMentions(state, summary, at);
  addFeed(state, at, 'task-complete', success ? 'completed a task' : 'reported a failed task');
}
```

- [ ] **Step 4: Wire the message handlers into the reducer**

In `engine/model/session-state.mjs`:

1. Add after the existing imports:

```js
import { maxTime, minTime } from '../time.mjs';
import { recordTaskComplete, recordToolComplete, recordToolStart, recordUserMessage } from './messages.mjs';
```

(Merge `maxTime, minTime` into the existing `../time.mjs` import line rather than importing the module twice.)

2. Delete the local `onUserMessage` function and change the switch case to:

```js
    case 'user.message':
      state.prompts += 1;
      recordUserMessage(state, data, at);
      break;
    case 'session.task_complete':
      recordTaskComplete(state, data, at);
      break;
```

3. In `onToolStart`, extend the branch chain after the `task` branch:

```js
  } else if (name === 'task') {
    const sub = newSubagent(state, id, at, args);
    addFeed(state, at, 'subagent-start', `started ${sub.type}: ${sub.name}${sub.mode === 'sync' ? ' (sync)' : ''}`);
  } else {
    recordToolStart(state, name, args, id, at);
  }
```

4. In `onToolComplete`, add as the last statement:

```js
  recordToolComplete(state, id, data);
```

5. Append `mergeStates`:

```js
/** Aggregate of one project session's CLI sessions, oldest first. Live fields stay empty. */
export function mergeStates(states) {
  const merged = createSessionState(states.map(state => state.id).join('+') || 'none');
  for (const state of states) {
    merged.lines += state.lines;
    merged.parseErrors += state.parseErrors;
    merged.firstEventAt = minTime(merged.firstEventAt, state.firstEventAt);
    if (state.lastEventAt !== null && (merged.lastEventAt === null || state.lastEventAt >= merged.lastEventAt)) {
      merged.lastEventAt = state.lastEventAt;
      merged.lastEventType = state.lastEventType;
    }
    merged.copilotVersion = state.copilotVersion ?? merged.copilotVersion;
    merged.model = state.model ?? merged.model;
    merged.busyMs += state.busyMs;
    merged.waitingMs += state.waitingMs;
    merged.busySpans.push(...state.busySpans);
    merged.waitSpans.push(...state.waitSpans);
    for (const [id, sub] of state.subagents) merged.subagents.set(id, sub);
    merged.sent.push(...state.sent);
    merged.inbound.push(...state.inbound);
    merged.taskCompletes.push(...state.taskCompletes);
    merged.automation.saves.push(...state.automation.saves);
    merged.automation.wakes.push(...state.automation.wakes);
    merged.feed.push(...state.feed);
    merged.marks.push(...state.marks);
    for (const [key, value] of state.prMentions) {
      const entry = merged.prMentions.get(key);
      merged.prMentions.set(key, entry
        ? { ...entry, count: entry.count + value.count, firstAt: Math.min(entry.firstAt, value.firstAt), lastAt: Math.max(entry.lastAt, value.lastAt) }
        : { ...value });
    }
    merged.lastInboundAt = maxTime(merged.lastInboundAt, state.lastInboundAt);
    merged.lastHumanAt = maxTime(merged.lastHumanAt, state.lastHumanAt);
    merged.lastTurnEndAt = maxTime(merged.lastTurnEndAt, state.lastTurnEndAt);
    merged.shutdownAt = maxTime(merged.shutdownAt, state.shutdownAt);
    merged.abortAt = maxTime(merged.abortAt, state.abortAt);
    merged.lastErrorAt = maxTime(merged.lastErrorAt, state.lastErrorAt);
  }
  const byAt = (a, b) => a.at - b.at;
  for (const list of [merged.sent, merged.inbound, merged.taskCompletes, merged.feed, merged.marks, merged.automation.saves]) list.sort(byAt);
  merged.automation.wakes.sort((a, b) => a - b);
  merged.busySpans.sort((a, b) => a[0] - b[0]);
  merged.waitSpans.sort((a, b) => a[0] - b[0]);
  return merged;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass, including Task 9's reducer tests unchanged.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): record reports, messages and monitors per session"
```

### Task 11: Stuck detection and status mapping

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/status.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/status.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_THRESHOLDS` (Task 3), `STATUS_DETAILS` (Task 2), `formatDuration` (Task 3), reducer state (Tasks 9–10), `fold`, `EventLog`.
- Produces: `ACTIVE_DETAILS: Set<string>` (details that keep a run live); `displayOf(detail): {status, bucket}`; `toolLimitMs(tool, thresholds): number|null`; `subagentLimitMs(sub, thresholds): number`; `busyWindowStart(state, now, windowMs): number`; `toolView(tool, limitMs): ToolCallView`; `evaluateStatus(input): { detail, since, reason, tool, stuckSubagents: Set<callId> }` with `input = { state, alive, archivedAt, merged, mergedAt, outcome, hasRegistry, report: {status, at}|null, parentRepliedAt, monitorDueAt, isRunningFlag, startedAt, now, thresholds }`; `swarmStalled({orchestratorDetail, unitDetails, monitorDue, lastActivityAt}): {since, reason}|null`.

The rule order and the mapping table are in "Builder decisions" item 1. `since` is the start of the current state; for stuck states it is the start of the silence (tool start, last sub-agent event, last model progress or last log line).

- [ ] **Step 1: Write the failing test**

`tests/status.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { STATUS_DETAILS } from '../engine/schema.mjs';
import { busyWindowStart, displayOf, evaluateStatus, swarmStalled, toolLimitMs } from '../engine/model/status.mjs';
import { MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const t = DEFAULT_THRESHOLDS;
const evaluate = (state, now, extra = {}) => evaluateStatus({
  state, alive: true, archivedAt: null, merged: false, mergedAt: null, outcome: null, hasRegistry: false, report: null,
  parentRepliedAt: null, monitorDueAt: null, isRunningFlag: false, startedAt: T0, now, thresholds: t, ...extra,
});
function busyLog() {
  const log = new EventLog(T0);
  log.start();
  log.turnStart();
  return log;
}

test('every status detail maps to a colour and a header bucket', () => {
  for (const detail of STATUS_DETAILS) assert.ok(displayOf(detail).status && displayOf(detail).bucket, detail);
  assert.deepEqual(displayOf('slow_model_call'), { status: 'busy', bucket: 'working' });
  assert.deepEqual(displayOf('stalled'), { status: 'stuck', bucket: 'stuck' });
  assert.deepEqual(displayOf('blocked_on_orchestrator'), { status: 'blocked', bucket: 'waiting' });
  assert.deepEqual(displayOf('crashed'), { status: 'blocked', bucket: 'failed' });
  assert.deepEqual(displayOf('stopped'), { status: 'idle', bucket: 'idle' });
  assert.deepEqual(displayOf('archived'), { status: 'archived', bucket: 'done' });
});

test('ended states come first: archived, failed, merged, stopped, crashed', () => {
  const state = fold(busyLog());
  assert.equal(evaluate(state, T0 + MINUTE, { archivedAt: T0 + 1 }).detail, 'archived');
  assert.equal(evaluate(state, T0 + MINUTE, { outcome: 'failed' }).detail, 'failed');
  const idle = busyLog(); idle.wait(MINUTE); idle.turnEnd();
  assert.equal(evaluate(fold(idle), T0 + 2 * MINUTE, { merged: true, mergedAt: T0 + 30_000 }).detail, 'merged');
  assert.equal(evaluate(state, T0 + MINUTE, { merged: true }).detail, 'busy');
  const stopped = busyLog(); stopped.wait(MINUTE); stopped.shutdown();
  assert.equal(evaluate(fold(stopped), T0 + 2 * MINUTE, { alive: false }).detail, 'stopped');
  const crashed = evaluate(state, T0 + 2 * MINUTE, { alive: false });
  assert.equal(crashed.detail, 'crashed');
  assert.equal(crashed.reason, 'The session process ended without a shutdown event while it was working.');
});

test('an open question or plan is waiting, never stuck, however long it lasts', () => {
  const log = busyLog();
  log.ask('Approve?');
  const result = evaluate(fold(log), T0 + 29 * MINUTE);
  assert.equal(result.detail, 'waiting_question');
  assert.equal(result.since, T0);
  const plan = busyLog();
  plan.plan('Steps');
  assert.equal(evaluate(fold(plan), T0 + 60 * MINUTE).detail, 'waiting_plan');
});

test('a tool past its limit is stuck, and the reason names the rule and its numbers', () => {
  const log = busyLog();
  log.tool('bash', { command: 'dotnet test --filter E2E', initial_wait: 600 });
  const state = fold(log);
  assert.equal(evaluate(state, T0 + 14 * MINUTE).detail, 'busy');
  const stuck = evaluate(state, T0 + 48 * MINUTE);
  assert.equal(stuck.detail, 'stuck_tool');
  assert.equal(stuck.since, T0);
  assert.equal(stuck.reason, 'bash has run for 48 min with a limit of 15 min (initial_wait 10 min + 5 min).');
  assert.deepEqual(stuck.tool, { id: 'call-1', name: 'bash', summary: 'bash: dotnet test --filter E2E', startedAt: T0, limitMs: 15 * MINUTE });
  const plain = busyLog();
  plain.tool('bash', { command: 'sleep 1000' });
  assert.equal(evaluate(fold(plain), T0 + 11 * MINUTE).detail, 'stuck_tool');
  const view = busyLog();
  view.tool('view', { path: 'a.txt' });
  assert.equal(evaluate(fold(view), T0 + 3 * MINUTE).detail, 'stuck_tool');
});

test('tool limits follow the design call', () => {
  const limit = (name, args) => toolLimitMs({ name, args: { initialWait: null, delay: null, timeout: null, wait: false, mode: null, ...args } }, t);
  assert.equal(limit('bash', { initialWait: 600 }), 15 * MINUTE);
  assert.equal(limit('bash', {}), 10 * MINUTE);
  assert.equal(limit('read_bash', { delay: 60 }), 3 * MINUTE);
  assert.equal(limit('read_agent', { timeout: 180 }), 5 * MINUTE);
  assert.equal(limit('create_session', {}), 2 * MINUTE);
  assert.equal(limit('grep', {}), 2 * MINUTE);
  assert.equal(limit('task', {}), null);
  assert.equal(limit('web_fetch', {}), null);
});

test('a sub-agent silent past its limit makes the session stuck', () => {
  const log = busyLog();
  log.subagent({ name: 'reviewer', type: 'code-review' });
  const state = fold(log);
  assert.equal(evaluate(state, T0 + 9 * MINUTE).detail, 'busy');
  const stuck = evaluate(state, T0 + 11 * MINUTE);
  assert.equal(stuck.detail, 'stuck_subagent');
  assert.deepEqual([...stuck.stuckSubagents], ['call-1']);
  assert.equal(stuck.reason, 'Sub-agent reviewer (code-review) has had no events for 11 min; the limit is 10 min.');
  const heavy = busyLog();
  heavy.subagent({ type: 'general-purpose', model: 'claude-opus-5.5', effort: 'max' });
  assert.equal(evaluate(fold(heavy), T0 + 11 * MINUTE).detail, 'busy');
  assert.equal(evaluate(fold(heavy), T0 + 16 * MINUTE).detail, 'stuck_subagent');
});

test('a model call warns after 5 minutes and is stuck after 10', () => {
  const state = fold(busyLog());
  assert.equal(evaluate(state, T0 + 4 * MINUTE).detail, 'busy');
  assert.equal(evaluate(state, T0 + 6 * MINUTE).detail, 'slow_model_call');
  const stuck = evaluate(state, T0 + 11 * MINUTE);
  assert.equal(stuck.detail, 'stuck_model_call');
  assert.equal(stuck.reason, 'No model response for 11 min; the limit is 10 min.');
});

test('silent busy catches a stale busy flag or a tool without its own limit', () => {
  const idle = new EventLog(T0);
  idle.start();
  assert.equal(evaluate(fold(idle), T0 + 11 * MINUTE, { isRunningFlag: true }).detail, 'silent');
  const log = busyLog();
  log.tool('web_fetch', { url: 'https://example.com' });
  const silent = evaluate(fold(log), T0 + 11 * MINUTE);
  assert.equal(silent.detail, 'silent');
  assert.equal(silent.reason, 'Busy, but its log has had no new line for 11 min; the limit is 10 min.');
});

test('spinning: failures, the same call in a row within a prompt, close compactions or an unattended denial', () => {
  const failing = busyLog();
  for (let i = 0; i < 5; i += 1) failing.done(failing.tool('view', { path: `missing-${i}` }), { success: false });
  assert.equal(evaluate(fold(failing), T0 + MINUTE).detail, 'spinning');
  const repeating = busyLog();
  for (let i = 0; i < 3; i += 1) repeating.done(repeating.tool('bash', { command: 'npm test' }));
  const result = evaluate(fold(repeating), T0 + MINUTE);
  assert.equal(result.detail, 'spinning');
  assert.equal(result.reason, 'In its last 30 min of busy time: the same tool call 3 times in a row.');
  const tdd = busyLog();
  for (let i = 0; i < 3; i += 1) {
    tdd.done(tdd.tool('bash', { command: 'npm test' }));
    tdd.done(tdd.tool('edit', { path: 'a.mjs', old_str: `${i}`, new_str: `${i + 1}` }));
  }
  assert.equal(evaluate(fold(tdd), T0 + MINUTE).detail, 'busy');
  const polling = busyLog();
  for (let i = 0; i < 4; i += 1) polling.done(polling.tool('read_agent', { agent_id: 'a', wait: true }));
  assert.equal(evaluate(fold(polling), T0 + MINUTE).detail, 'busy');
  const waking = busyLog();
  for (let i = 0; i < 3; i += 1) {
    waking.automationWake();
    waking.done(waking.tool('bash', { command: 'az repos pr show --id 4711' }));
  }
  assert.equal(evaluate(fold(waking), T0 + MINUTE).detail, 'busy');
  const compacting = busyLog();
  compacting.push('session.compaction_complete', {});
  compacting.push('session.compaction_complete', {});
  const compacted = evaluate(fold(compacting), T0 + MINUTE);
  assert.equal(compacted.detail, 'spinning');
  assert.equal(compacted.reason, 'In its last 30 min of busy time: 2 context compactions within 30 min.');
  const spaced = busyLog();
  spaced.push('session.compaction_complete', {});
  spaced.wait(5 * MINUTE); spaced.turnEnd();
  spaced.wait(60 * MINUTE); spaced.turnStart();
  spaced.push('session.compaction_complete', {});
  assert.equal(evaluate(fold(spaced), T0 + 66 * MINUTE).detail, 'busy');
  const denied = busyLog();
  denied.push('permission.completed', { decisionSource: 'unattended_fallback', result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } });
  assert.equal(evaluate(fold(denied), T0 + MINUTE).detail, 'spinning');
});

test('idle units with unanswered reports are blocked or stalled', () => {
  const log = busyLog();
  log.wait(MINUTE);
  log.turnEnd();
  const state = fold(log);
  const at = T0 + MINUTE;
  assert.equal(evaluate(state, T0 + 2 * MINUTE, { report: { status: 'blocked', at } }).detail, 'blocked');
  assert.equal(evaluate(state, T0 + 2 * MINUTE, { report: { status: 'needs_input', at } }).detail, 'blocked_on_orchestrator');
  assert.equal(evaluate(state, T0 + 2 * MINUTE, { report: { status: 'needs_input', at }, parentRepliedAt: at + 1 }).detail, 'idle');
  const stalled = evaluate(state, T0 + 32 * MINUTE, { report: { status: 'progress', at } });
  assert.equal(stalled.detail, 'stalled');
  assert.equal(stalled.since, T0 + MINUTE);
  assert.equal(evaluate(state, T0 + 32 * MINUTE, { report: { status: 'progress', at }, monitorDueAt: T0 + 35 * MINUTE }).detail, 'idle');
  assert.equal(evaluate(state, T0 + 20 * MINUTE, { report: { status: 'progress', at } }).detail, 'idle');
});

test('a completed task after the last inbound message is not stalled', () => {
  const log = new EventLog(T0);
  log.start(); log.user('Do the work'); log.turnStart(); log.wait(MINUTE); log.taskComplete('Done'); log.turnEnd();
  assert.equal(evaluate(fold(log), T0 + 40 * MINUTE, { report: { status: 'progress', at: T0 + MINUTE } }).detail, 'idle');
});

test('without a registry, a failed last task means failed', () => {
  const log = new EventLog(T0);
  log.start(); log.turnStart(); log.taskComplete('Could not do it', false); log.turnEnd();
  const state = fold(log);
  assert.equal(evaluate(state, T0 + MINUTE).detail, 'failed');
  assert.equal(evaluate(state, T0 + MINUTE, { hasRegistry: true }).detail, 'idle');
});

test('the swarm is stalled when the orchestrator and every open unit are idle and no monitor is due', () => {
  assert.deepEqual(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'archived', 'stalled'], monitorDue: false, lastActivityAt: T0 }),
    { since: T0, reason: 'The orchestrator and every open unit are idle or ended, and no monitor is due.' });
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle', 'busy'], monitorDue: false, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['idle'], monitorDue: true, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'busy', unitDetails: ['idle'], monitorDue: false, lastActivityAt: T0 }), null);
  assert.equal(swarmStalled({ orchestratorDetail: 'idle', unitDetails: ['merged', 'archived'], monitorDue: false, lastActivityAt: T0 }), null);
});

test('busyWindowStart walks back through busy spans', () => {
  const state = { turn: { startedAt: T0 + 100 * MINUTE }, busySpans: [[T0, T0 + 20 * MINUTE], [T0 + 50 * MINUTE, T0 + 60 * MINUTE]] };
  assert.equal(busyWindowStart(state, T0 + 105 * MINUTE, 30 * MINUTE), T0 + 5 * MINUTE);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/status.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/model/status.mjs'`.

- [ ] **Step 3: Write `engine/model/status.mjs`**

```js
import { formatDuration } from '../time.mjs';

/** Details that keep a run live: real work, a hang, or a wait on the user inside an open turn. */
export const ACTIVE_DETAILS = new Set([
  'busy', 'slow_model_call', 'silent', 'stuck_model_call', 'stuck_tool', 'stuck_subagent', 'spinning', 'waiting_question', 'waiting_plan',
]);

const DISPLAY = {
  busy: ['busy', 'working'],
  slow_model_call: ['busy', 'working'],
  silent: ['stuck', 'stuck'],
  stuck_model_call: ['stuck', 'stuck'],
  stuck_tool: ['stuck', 'stuck'],
  stuck_subagent: ['stuck', 'stuck'],
  spinning: ['stuck', 'stuck'],
  stalled: ['stuck', 'stuck'],
  waiting_question: ['question', 'waiting'],
  waiting_plan: ['plan', 'waiting'],
  blocked: ['blocked', 'waiting'],
  blocked_on_orchestrator: ['blocked', 'waiting'],
  idle: ['idle', 'idle'],
  stopped: ['idle', 'idle'],
  crashed: ['blocked', 'failed'],
  failed: ['blocked', 'failed'],
  merged: ['merged', 'done'],
  archived: ['archived', 'done'],
};

export function displayOf(detail) {
  const [status, bucket] = DISPLAY[detail];
  return { status, bucket };
}

const QUICK_TOOLS = new Set([
  'create_session', 'send_session_message', 'get_session', 'get_sessions_status', 'list_sessions_and_chats', 'archive_session',
  'answer_session_input', 'respond_to_session_plan_v2', 'navigate_to', 'open_canvas', 'invoke_canvas_action', 'list_canvas_capabilities',
  'rename_session', 'rename_branch', 'save_session_automation', 'get_session_automation', 'list_projects', 'publish_chat_update',
  'view', 'create', 'edit', 'apply_patch', 'str_replace_editor', 'grep', 'glob', 'rg', 'tool_search_tool', 'sql', 'store_memory', 'vote_memory', 'skill',
]);
const POLLING_TOOLS = new Set(['read_bash', 'read_agent', 'list_agents', 'list_bash', 'get_session', 'get_sessions_status', 'list_sessions_and_chats', 'get_session_automation']);
const IDLE_DETAILS = new Set(['idle', 'stopped', 'crashed', 'failed', 'stalled', 'blocked', 'blocked_on_orchestrator']);

/** The design's tool rule: bash initial_wait + 5 min (10 min without one); read_bash delay + 2 min; read_agent timeout + 2 min; quick tools 2 min. */
export function toolLimitMs(tool, t) {
  const args = tool.args ?? {};
  switch (tool.name) {
    case 'bash':
      if (args.mode === 'async') return t.quickToolMs;
      return args.initialWait > 0 ? args.initialWait * 1000 + t.bashExtraMs : t.bashDefaultMs;
    case 'read_bash':
      return (args.delay > 0 ? args.delay * 1000 : 0) + t.readBashExtraMs;
    case 'read_agent':
      return (args.timeout > 0 ? args.timeout * 1000 : args.wait ? 30_000 : 0) + t.readAgentExtraMs;
    default:
      return QUICK_TOOLS.has(tool.name) ? t.quickToolMs : null;
  }
}

function limitNote(tool, t) {
  const args = tool.args ?? {};
  if (tool.name !== 'bash' || args.mode === 'async') return '';
  return args.initialWait > 0 ? ` (initial_wait ${formatDuration(args.initialWait * 1000)} + ${formatDuration(t.bashExtraMs)})` : ' (no initial_wait)';
}

export function subagentLimitMs(sub, t) {
  const heavy = sub.type === 'general-purpose' && /opus/i.test(sub.model ?? '') && sub.effort === 'max';
  return heavy ? t.subagentSilentHeavyMs : t.subagentSilentMs;
}

export function toolView(tool, limitMs) {
  return { id: tool.id, name: tool.name, summary: tool.args?.summary ?? tool.name, startedAt: tool.startedAt, limitMs: limitMs ?? null };
}

/** Start of the most recent `windowMs` of busy time, counting the open turn up to now. */
export function busyWindowStart(state, now, windowMs) {
  const spans = state.turn ? [...state.busySpans, [state.turn.startedAt, now]] : state.busySpans;
  let remaining = windowMs;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const [start, end] = spans[i];
    if (end - start >= remaining) return end - remaining;
    remaining -= end - start;
  }
  return spans.length ? spans[0][0] : now;
}

function findStuckSubagents(state, now, t) {
  const stuck = new Set();
  if (!state) return stuck;
  for (const sub of state.subagents.values()) {
    if (sub.status === 'running' && now - sub.lastEventAt > subagentLimitMs(sub, t)) stuck.add(sub.id);
  }
  return stuck;
}

function spinningReason(state, now, t) {
  const from = busyWindowStart(state, now, t.spinningWindowMs);
  const inWindow = list => list.filter(at => at >= from).length;
  const failures = inWindow(state.recent.failures);
  if (failures >= t.spinningFailures) return `${failures} failed tool calls`;
  let run = 0;
  let longest = 0;
  let previous = null;
  for (const call of state.recent.calls) {
    if (call.at < from || POLLING_TOOLS.has(call.name)) continue;
    const key = `${call.prompt}:${call.key}`;
    run = key === previous ? run + 1 : 1;
    previous = key;
    longest = Math.max(longest, run);
  }
  if (longest >= t.spinningRepeats) return `the same tool call ${longest} times in a row`;
  const compactions = state.recent.compactions.filter(at => at >= from && now - at <= t.spinningWindowMs).length;
  if (compactions >= t.spinningCompactions) return `${compactions} context compactions within ${formatDuration(t.spinningWindowMs)}`;
  if (inWindow(state.recent.denials) > 0) return 'a permission request denied with no one to ask';
  return null;
}

export function evaluateStatus(input) {
  const { state, alive, archivedAt, now } = input;
  const t = input.thresholds;
  const stuckSubagents = findStuckSubagents(state, now, t);
  const lastAt = state?.lastEventAt ?? input.startedAt;
  const result = (detail, since, reason = null, tool = null) => ({ detail, since: Math.min(since ?? now, now), reason, tool, stuckSubagents });
  const turnOpen = Boolean(state?.turn);
  const lastTask = state?.taskCompletes.length ? state.taskCompletes[state.taskCompletes.length - 1] : null;

  if (archivedAt !== null && archivedAt !== undefined) return result('archived', archivedAt);
  if (input.outcome === 'failed') return result('failed', lastAt, 'The orchestrator recorded this unit as failed.');
  if (input.merged && !turnOpen) return result('merged', input.mergedAt ?? lastAt);
  if (alive === false) {
    if (state?.lastEventType === 'session.shutdown') return result('stopped', state.shutdownAt ?? lastAt, 'The session process exited normally.');
    return result('crashed', lastAt, `The session process ended without a shutdown event${turnOpen || input.isRunningFlag ? ' while it was working' : ''}.`);
  }
  if (!input.hasRegistry && !turnOpen && lastTask && lastTask.success === false) {
    return result('failed', lastTask.at, 'Its last task ended unsuccessfully.');
  }
  if (state && state.waits.size) {
    const wait = [...state.waits.values()].reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
    return result(wait.kind === 'plan' ? 'waiting_plan' : 'waiting_question', wait.startedAt);
  }
  const openTools = state ? [...state.openTools.values()].sort((a, b) => a.startedAt - b.startedAt) : [];
  for (const tool of openTools) {
    const limit = toolLimitMs(tool, t);
    if (limit !== null && now - tool.startedAt > limit) {
      return result('stuck_tool', tool.startedAt,
        `${tool.name} has run for ${formatDuration(now - tool.startedAt)} with a limit of ${formatDuration(limit)}${limitNote(tool, t)}.`,
        toolView(tool, limit));
    }
  }
  if (stuckSubagents.size) {
    const sub = state.subagents.get([...stuckSubagents][0]);
    return result('stuck_subagent', sub.lastEventAt,
      `Sub-agent ${sub.name} (${sub.type}) has had no events for ${formatDuration(now - sub.lastEventAt)}; the limit is ${formatDuration(subagentLimitMs(sub, t))}.`);
  }
  if (turnOpen && !openTools.length && now - state.turn.progressAt >= t.modelCallStuckMs) {
    return result('stuck_model_call', state.turn.progressAt,
      `No model response for ${formatDuration(now - state.turn.progressAt)}; the limit is ${formatDuration(t.modelCallStuckMs)}.`);
  }
  const ownLimit = openTools.some(tool => tool.name === 'task' || toolLimitMs(tool, t) !== null);
  if ((turnOpen || input.isRunningFlag) && !ownLimit && now - lastAt >= t.silentBusyMs) {
    return result('silent', lastAt, `Busy, but its log has had no new line for ${formatDuration(now - lastAt)}; the limit is ${formatDuration(t.silentBusyMs)}.`);
  }
  if (turnOpen) {
    const why = spinningReason(state, now, t);
    if (why) return result('spinning', busyWindowStart(state, now, t.spinningWindowMs), `In its last ${formatDuration(t.spinningWindowMs)} of busy time: ${why}.`);
    const since = state.busySince ?? state.turn.startedAt;
    if (!openTools.length && now - state.turn.progressAt >= t.modelCallWarnMs) {
      return result('slow_model_call', since,
        `Waiting ${formatDuration(now - state.turn.progressAt)} for a model response; it counts as stuck after ${formatDuration(t.modelCallStuckMs)}.`);
    }
    return result('busy', since);
  }
  const idleSince = state?.lastTurnEndAt ?? lastAt;
  const report = input.report;
  const replied = Boolean(report) && input.parentRepliedAt !== null && input.parentRepliedAt !== undefined && input.parentRepliedAt > report.at;
  if (report && !replied && report.status === 'blocked') return result('blocked', report.at, 'Its latest report says it is blocked.');
  if (report && !replied && report.status === 'needs_input') {
    return result('blocked_on_orchestrator', report.at, 'It asked the orchestrator for input and has had no reply.');
  }
  if (report && report.status === 'progress' && now - idleSince >= t.stalledIdleMs) {
    const completed = Boolean(lastTask) && state.lastInboundAt !== null && lastTask.at >= state.lastInboundAt;
    const monitorDue = input.monitorDueAt !== null && input.monitorDueAt !== undefined && input.monitorDueAt > now - t.monitorGraceMs;
    if (!completed && !monitorDue) {
      return result('stalled', idleSince, `Idle for ${formatDuration(now - idleSince)} after a progress report, with no completed task and no monitor due.`);
    }
  }
  return result('idle', idleSince);
}

export function swarmStalled({ orchestratorDetail, unitDetails, monitorDue, lastActivityAt }) {
  if (!IDLE_DETAILS.has(orchestratorDetail) || monitorDue) return null;
  const open = unitDetails.filter(detail => detail !== 'archived' && detail !== 'merged');
  if (!open.length || !open.every(detail => IDLE_DETAILS.has(detail))) return null;
  return { since: lastActivityAt, reason: 'The orchestrator and every open unit are idle or ended, and no monitor is due.' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): detect stuck, waiting and ended sessions"
```

### Task 12: PR identity, stages, monitors and PR state lookups

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/stage.mjs`
- Create: `ghcp/plugins/swarm-dashboard/engine/model/pr-lookup.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/stage.test.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/pr-lookup.test.mjs`

**Interfaces:**
- Consumes: `MINUTE`, `maxTime`, `parseTime` (Task 3); `DEFAULT_THRESHOLDS` (Task 3); registry rows (Task 8); reducer `prMentions`, `automation` (Task 10); app `automations` and `createdPr` (Task 4).
- Produces:
  - `stage.mjs`: `hostOf(workspaceFile, project): {provider: 'ado'|'github'|null, repo}`; `resolvePr({registry, statusLines, createdPr, mentions, host}): {provider, id, repo, url, source, knownAt}|null` (`statusLines` are `{at, pr}` latest first; `repo` falls back to the host's repository when the providers match; the mention heuristic runs only for Azure DevOps hosts); `prView(pr, info, createdPr): PrView` (schema shape); `deriveStage({archivedAt, outcome, pr}): {stage, merged, closedWithoutMerge}` where `pr` is a `PrView` or null and `monitorEver` is a boolean field of the same argument; `deriveMonitor({stage, hasPr, automations, wakes, saves, prKnownAt, now, thresholds}): MonitorView`.
  - `pr-lookup.mjs`: `runCommand(command, args, {cwd, timeoutMs}): Promise<string>`; `prKey(pr)`; `adoArgs(pr)`; `githubArgs(pr)`; `mapAdo(json)`; `mapGithub(json)`; `GITHUB_REPO`, `ADO_REPO` (validation patterns); `createPrLookup({run?, now?, ttlMs?, timeoutMs?, concurrency?, exists?}): { get(pr): Info|null, request(pr, {cwd}), settle(): Promise<void>, errors(): {key, error}[] }` (a PR with a known organisation or repository runs without a working directory; otherwise only in an existing `cwd`) with `Info = {state, title, openedAt, mergedAt, closedAt, reviewNote, url, checkedAt, error}`. Only read-only `az repos pr show` and `gh pr view` run, through `execFile` (no shell), with validated arguments.

- [ ] **Step 1: Write the failing tests**

`tests/stage.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { deriveMonitor, deriveStage, hostOf, prView, resolvePr } from '../engine/model/stage.mjs';
import { MINUTE } from '../engine/time.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const mention = (provider, repo, id, count, at = T0) => [`${provider ?? 'any'}:${repo ?? ''}:${id}`, { provider, repo, id, count, firstAt: at, lastAt: at }];

test('PR identity follows the contract order', () => {
  const registry = { prProvider: 'ado', prId: 4711, prRepo: 'org/project/repo', prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4711' };
  const statusLines = [{ at: T0 + 2, pr: { provider: 'github', id: 7 } }, { at: T0 + 1, pr: { provider: 'github', id: 7 } }];
  const createdPr = { repo: 'sample-org/sample-repo', number: 9, url: 'https://github.com/sample-org/sample-repo/pull/9', state: 'open', mergedAt: null };
  const mentions = new Map([mention('ado', null, 55, 3)]);
  assert.equal(resolvePr({ registry, statusLines, createdPr, mentions }).source, 'registry');
  assert.deepEqual(resolvePr({ statusLines, createdPr, mentions }), { provider: 'github', id: 7, repo: null, url: null, source: 'status_line', knownAt: T0 + 1 });
  assert.deepEqual(resolvePr({ createdPr, mentions }), { provider: 'github', id: 9, repo: 'sample-org/sample-repo', url: createdPr.url, source: 'app', knownAt: null });
  assert.deepEqual(resolvePr({ mentions, host: { provider: 'ado', repo: null } }), { provider: 'ado', id: 55, repo: null, url: null, source: 'heuristic', knownAt: T0 });
  assert.equal(resolvePr({ statusLines, host: { provider: 'github', repo: 'sample-org/sample-repo' } }).repo, 'sample-org/sample-repo');
  assert.equal(resolvePr({}), null);
});

test('the most-mentioned PR is used for Azure DevOps hosts only', () => {
  const mentions = new Map([mention(null, null, 12, 2, T0 + 5), mention('ado', null, 12, 1), mention('ado', null, 3, 2)]);
  assert.deepEqual(resolvePr({ mentions, host: { provider: 'ado', repo: 'org/project/repo' } }),
    { provider: 'ado', id: 12, repo: 'org/project/repo', url: null, source: 'heuristic', knownAt: T0 });
  assert.equal(resolvePr({ mentions, host: { provider: 'github', repo: 'sample-org/sample-repo' } }), null);
  assert.equal(resolvePr({ mentions, host: { provider: null, repo: null } }), null);
});

test('the code host comes from workspace.yaml, else from the project', () => {
  assert.deepEqual(hostOf({ hostType: 'ado', repository: 'org/project/repo' }, null), { provider: 'ado', repo: 'org/project/repo' });
  assert.deepEqual(hostOf({ hostType: 'github', repository: 'sample-org/sample-repo' }, null), { provider: 'github', repo: 'sample-org/sample-repo' });
  assert.deepEqual(hostOf({ hostType: 'ado', repository: '--evil' }, null), { provider: 'ado', repo: null });
  assert.deepEqual(hostOf(null, { githubOwner: 'sample-org', githubRepo: 'sample-repo' }), { provider: 'github', repo: 'sample-org/sample-repo' });
  assert.deepEqual(hostOf({ cwd: '/synthetic/worktree', hostType: null, repository: null }, { githubOwner: null, githubRepo: null }), { provider: 'ado', repo: null });
  assert.deepEqual(hostOf(null, null), { provider: null, repo: null });
});

test('prView prefers looked-up state, then the app columns, else unknown', () => {
  const pr = { provider: 'github', id: 9, repo: 'sample-org/sample-repo', url: 'https://github.com/sample-org/sample-repo/pull/9', source: 'app', knownAt: null };
  const info = { state: 'open', title: 'Add API', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'approved', url: pr.url, checkedAt: T0 + 1, error: null };
  assert.deepEqual(prView(pr, info, null), {
    provider: 'github', id: 9, repo: 'sample-org/sample-repo', url: pr.url, title: 'Add API', state: 'open', openedAt: T0,
    mergedAt: null, closedAt: null, reviewNote: 'approved', source: 'app', checkedAt: T0 + 1,
  });
  const fromApp = prView(pr, { ...info, state: 'unknown' }, { state: 'merged', mergedAt: T0 + 9 });
  assert.equal(fromApp.state, 'merged');
  assert.equal(fromApp.mergedAt, T0 + 9);
  assert.equal(prView({ ...pr, source: 'heuristic' }, null, null).state, 'unknown');
});

test('stages run from coding through review to merged and archived', () => {
  const pr = state => ({ state });
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: null, pr: null }), { stage: 'coding', merged: false, closedWithoutMerge: false });
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('draft') }).stage, 'pr_open');
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('open') }).stage, 'in_review');
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('unknown') }).stage, 'pr_open');
  assert.equal(deriveStage({ archivedAt: null, outcome: null, pr: pr('unknown'), monitorEver: true }).stage, 'in_review');
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: 'merged', pr: pr('unknown') }), { stage: 'merged', merged: true, closedWithoutMerge: false });
  assert.deepEqual(deriveStage({ archivedAt: T0, outcome: null, pr: pr('merged') }), { stage: 'archived', merged: true, closedWithoutMerge: false });
  assert.deepEqual(deriveStage({ archivedAt: T0, outcome: 'closed', pr: null }), { stage: 'archived', merged: false, closedWithoutMerge: true });
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: null, pr: pr('closed') }), { stage: 'pr_open', merged: false, closedWithoutMerge: true });
});

test('monitors are alive, missing, paused, ended or none', () => {
  const base = { hasPr: true, automations: [], wakes: [], saves: [], prKnownAt: T0, now: T0 + 60 * MINUTE, thresholds: DEFAULT_THRESHOLDS };
  const row = { sessionId: 'cli-1', interval: 'minutes', everyMinutes: 10, lastRunAt: T0 + 55 * MINUTE, nextRunAt: T0 + 65 * MINUTE, pausedAt: null, name: 'PR monitor' };
  assert.deepEqual(deriveMonitor({ ...base, stage: 'in_review', automations: [row] }),
    { state: 'alive', lastCheckAt: T0 + 55 * MINUTE, nextCheckAt: T0 + 65 * MINUTE, everyMinutes: 10, since: null });
  assert.deepEqual(deriveMonitor({ ...base, stage: 'in_review', automations: [{ ...row, nextRunAt: T0 + 40 * MINUTE }] }).state, 'missing');
  assert.equal(deriveMonitor({ ...base, stage: 'in_review', automations: [{ ...row, nextRunAt: T0 + 40 * MINUTE }] }).since, T0 + 40 * MINUTE);
  assert.equal(deriveMonitor({ ...base, stage: 'in_review', automations: [{ ...row, nextRunAt: T0 + 57 * MINUTE }] }).state, 'alive');
  assert.deepEqual(deriveMonitor({ ...base, stage: 'pr_open', automations: [{ ...row, pausedAt: T0 + 30 * MINUTE }] }).since, T0 + 30 * MINUTE);
  const missing = deriveMonitor({ ...base, stage: 'in_review', wakes: [T0 + 10 * MINUTE, T0 + 20 * MINUTE], saves: [{ at: T0, clear: false, everyMinutes: 10 }] });
  assert.deepEqual(missing, { state: 'missing', lastCheckAt: T0 + 20 * MINUTE, nextCheckAt: null, everyMinutes: 10, since: T0 + 30 * MINUTE });
  assert.equal(deriveMonitor({ ...base, stage: 'pr_open' }).since, T0);
  assert.equal(deriveMonitor({ ...base, stage: 'coding', hasPr: false }).state, 'none');
  assert.equal(deriveMonitor({ ...base, stage: 'merged' }).state, 'ended');
  assert.equal(deriveMonitor({ ...base, stage: 'archived', hasPr: false }).state, 'none');
});
```

`tests/pr-lookup.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoArgs, createPrLookup, githubArgs, mapAdo, mapGithub, prKey } from '../engine/model/pr-lookup.mjs';
import { MINUTE } from '../engine/time.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);

test('Azure DevOps PR JSON maps to a PR state and review note', () => {
  const base = { pullRequestId: 4711, title: 'Add API', creationDate: '2026-10-15T08:00:00Z', closedDate: null, repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' } };
  assert.deepEqual(mapAdo({ ...base, status: 'active', isDraft: true, reviewers: [] }), {
    state: 'draft', title: 'Add API', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'no approvals yet',
    url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4711',
  });
  assert.equal(mapAdo({ ...base, status: 'active', isDraft: false, reviewers: [{ vote: 10 }, { vote: 5 }] }).reviewNote, '2 approvals');
  assert.equal(mapAdo({ ...base, status: 'active', reviewers: [{ vote: -5 }] }).reviewNote, 'waiting for the author');
  const merged = mapAdo({ ...base, status: 'completed', closedDate: '2026-10-15T09:00:00Z', reviewers: [{ vote: -10 }] });
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedAt, T0 + 60 * MINUTE);
  assert.equal(merged.reviewNote, 'rejected');
  assert.equal(mapAdo({ ...base, status: 'abandoned' }).state, 'closed');
});

test('GitHub PR JSON maps to a PR state and review note', () => {
  assert.deepEqual(mapGithub({ state: 'OPEN', isDraft: false, title: 'Docs', createdAt: '2026-10-15T08:00:00Z', mergedAt: null, closedAt: null, reviewDecision: 'APPROVED', url: 'https://github.com/o/r/pull/3' }), {
    state: 'open', title: 'Docs', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'approved', url: 'https://github.com/o/r/pull/3',
  });
  assert.equal(mapGithub({ state: 'OPEN', isDraft: true }).state, 'draft');
  assert.equal(mapGithub({ state: 'MERGED', mergedAt: '2026-10-15T08:00:00Z' }).mergedAt, T0);
  assert.equal(mapGithub({ state: 'CLOSED' }).state, 'closed');
});

test('arguments are fixed read-only commands with validated values', () => {
  assert.deepEqual(adoArgs({ provider: 'ado', id: 7, repo: 'org/project/repo' }),
    ['repos', 'pr', 'show', '--id', '7', '--output', 'json', '--organization', 'https://dev.azure.com/org', '--detect', 'false']);
  assert.deepEqual(adoArgs({ provider: 'ado', id: 7, repo: null }), ['repos', 'pr', 'show', '--id', '7', '--output', 'json']);
  assert.deepEqual(githubArgs({ provider: 'github', id: 3, repo: 'o/r' }).slice(-2), ['--repo', 'o/r']);
  assert.equal(githubArgs({ provider: 'github', id: 3, repo: '--evil' }).includes('--evil'), false);
});

test('lookups are cached, refreshed after the TTL, final once merged, and failures are kept', async () => {
  let clock = T0;
  const calls = [];
  const replies = [
    JSON.stringify({ state: 'OPEN', isDraft: false, title: 'One' }),
    JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-15T09:00:00Z', title: 'One' }),
  ];
  const run = async (command, args, options) => {
    calls.push([command, args[2], options.cwd]);
    return replies.shift();
  };
  const lookup = createPrLookup({ run, now: () => clock });
  const pr = { provider: 'github', id: 1, repo: 'o/r' };
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).state, 'open');
  assert.equal(lookup.get(pr).checkedAt, T0);
  lookup.request(pr);
  await lookup.settle();
  assert.equal(calls.length, 1);
  clock += 5 * MINUTE;
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).state, 'merged');
  clock += 60 * MINUTE;
  lookup.request(pr);
  await lookup.settle();
  assert.equal(calls.length, 2);
  assert.equal(prKey(pr), 'github:o/r:1');

  const failing = createPrLookup({ run: async () => { throw new Error('gh failed: not logged in'); }, now: () => clock });
  failing.request({ provider: 'github', id: 2, repo: 'o/r' });
  await failing.settle();
  assert.equal(failing.get({ provider: 'github', id: 2, repo: 'o/r' }).state, 'unknown');
  assert.deepEqual(failing.errors(), [{ key: 'github:o/r:2', error: 'gh failed: not logged in' }]);
});

test('a PR without a repository is looked up only from an existing worktree', async () => {
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push([args[4], options.cwd]); return '{"status":"active"}'; },
    exists: dir => dir === '/synthetic/worktree',
  });
  lookup.request({ provider: 'ado', id: 5, repo: null });
  lookup.request({ provider: 'ado', id: 6, repo: null }, { cwd: '/synthetic/worktree' });
  lookup.request({ provider: 'ado', id: 7, repo: null }, { cwd: '/synthetic/gone' });
  lookup.request({ provider: 'ado', id: 8, repo: 'org/project/repo' }, { cwd: '/synthetic/gone' });
  await lookup.settle();
  assert.deepEqual(calls, [['6', '/synthetic/worktree'], ['8', undefined]]);
  assert.equal(lookup.get({ provider: 'ado', id: 7, repo: null }).state, 'unknown');
  assert.match(lookup.get({ provider: 'ado', id: 7, repo: null }).error, /worktree is gone/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/stage.test.mjs tests/pr-lookup.test.mjs`
Expected: FAIL with `Cannot find module` for both modules.

- [ ] **Step 3: Write `engine/model/stage.mjs`**

```js
import { MINUTE, maxTime } from '../time.mjs';
import { ADO_REPO, GITHUB_REPO } from './pr-lookup.mjs';

/** The unit's code host: `workspace.yaml` host_type and repository, else the project's GitHub columns. */
export function hostOf(workspaceFile, project) {
  const repository = workspaceFile?.repository ?? null;
  if (workspaceFile?.hostType === 'ado') return { provider: 'ado', repo: repository && ADO_REPO.test(repository) ? repository : null };
  if (workspaceFile?.hostType === 'github') return { provider: 'github', repo: repository && GITHUB_REPO.test(repository) ? repository : null };
  if (project?.githubOwner && project?.githubRepo) return { provider: 'github', repo: `${project.githubOwner}/${project.githubRepo}` };
  return { provider: project ? 'ado' : null, repo: null };
}

/** Most-mentioned PR in the unit's reports, for Azure DevOps hosts only (design section 12). */
function bestMention(mentions, host) {
  if (host?.provider !== 'ado') return null;
  const totals = new Map();
  for (const mention of mentions.values()) {
    if (mention.provider !== 'ado' && mention.provider !== null) continue;
    const total = totals.get(mention.id) ?? { id: mention.id, count: 0, firstAt: mention.firstAt, lastAt: mention.lastAt };
    total.count += mention.count;
    total.firstAt = Math.min(total.firstAt, mention.firstAt);
    total.lastAt = Math.max(total.lastAt, mention.lastAt);
    totals.set(mention.id, total);
  }
  let best = null;
  for (const total of totals.values()) {
    if (!best || total.count > best.count || (total.count === best.count && total.lastAt > best.lastAt)) best = total;
  }
  return best ? { provider: 'ado', id: best.id, repo: host.repo, knownAt: best.firstAt } : null;
}

/** PR identity: registry row, latest contract status line, the app's PR columns, then the most-mentioned PR. */
export function resolvePr({ registry = null, statusLines = [], createdPr = null, mentions = new Map(), host = null } = {}) {
  const repoFor = provider => (host?.provider === provider ? host.repo : null);
  if (registry?.prProvider && registry.prId) {
    return { provider: registry.prProvider, id: registry.prId, repo: registry.prRepo ?? repoFor(registry.prProvider), url: registry.prUrl ?? null, source: 'registry', knownAt: null };
  }
  const line = statusLines.find(item => item.pr);
  if (line) {
    const same = statusLines.filter(item => item.pr && item.pr.provider === line.pr.provider && item.pr.id === line.pr.id);
    return { provider: line.pr.provider, id: line.pr.id, repo: repoFor(line.pr.provider), url: null, source: 'status_line', knownAt: Math.min(...same.map(item => item.at)) };
  }
  if (createdPr?.number) {
    return { provider: 'github', id: createdPr.number, repo: createdPr.repo ?? repoFor('github'), url: createdPr.url ?? null, source: 'app', knownAt: null };
  }
  const best = bestMention(mentions, host);
  return best ? { ...best, url: null, source: 'heuristic' } : null;
}

export function prView(pr, info, createdPr) {
  let state = info && info.state !== 'unknown' ? info.state : null;
  let mergedAt = info?.mergedAt ?? null;
  if (!state && pr.source === 'app' && createdPr) {
    const raw = String(createdPr.state ?? '').toLowerCase();
    state = createdPr.mergedAt || raw === 'merged' ? 'merged' : raw === 'closed' ? 'closed' : raw === 'draft' ? 'draft' : raw === 'open' ? 'open' : null;
    mergedAt = mergedAt ?? createdPr.mergedAt ?? null;
  }
  return {
    provider: pr.provider, id: pr.id, repo: pr.repo ?? null, url: info?.url ?? pr.url ?? null, title: info?.title ?? null,
    state: state ?? 'unknown', openedAt: info?.openedAt ?? null, mergedAt, closedAt: info?.closedAt ?? null,
    reviewNote: info?.reviewNote ?? null, source: pr.source, checkedAt: info?.checkedAt ?? null,
  };
}

/** coding → PR open → in review → merged → archived (builder decision 4). */
export function deriveStage({ archivedAt = null, outcome = null, pr = null, monitorEver = false }) {
  const merged = outcome === 'merged' || pr?.state === 'merged';
  const closedWithoutMerge = !merged && (outcome === 'closed' || outcome === 'failed' || pr?.state === 'closed');
  let stage;
  if (archivedAt !== null && archivedAt !== undefined) stage = 'archived';
  else if (merged) stage = 'merged';
  else if (!pr) stage = 'coding';
  else if (pr.state === 'open' || (pr.state === 'unknown' && monitorEver)) stage = 'in_review';
  else stage = 'pr_open';
  return { stage, merged, closedWithoutMerge };
}

/** Monitor state from the unit's automation rows and its wake and schedule history (builder decision 8). */
export function deriveMonitor({ stage, hasPr, automations = [], wakes = [], saves = [], prKnownAt = null, now, thresholds }) {
  const lastWake = wakes.length ? wakes[wakes.length - 1] : null;
  const row = [...automations].sort((a, b) => (b.nextRunAt ?? 0) - (a.nextRunAt ?? 0))[0] ?? null;
  const lastSave = saves.length ? saves[saves.length - 1] : null;
  const everyMinutes = row?.everyMinutes ?? (lastSave && !lastSave.clear ? lastSave.everyMinutes : null);
  const lastCheckAt = maxTime(row?.lastRunAt ?? null, lastWake);
  const view = (state, extra = {}) => ({ state, lastCheckAt, nextCheckAt: row?.nextRunAt ?? null, everyMinutes, since: null, ...extra });
  if (stage === 'merged' || stage === 'archived') return view(hasPr ? 'ended' : 'none', { nextCheckAt: null });
  if (row && row.pausedAt !== null && row.pausedAt !== undefined) return view('paused', { since: row.pausedAt });
  if (row) {
    if (row.nextRunAt !== null && row.nextRunAt !== undefined && row.nextRunAt < now - thresholds.monitorGraceMs) return view('missing', { since: row.nextRunAt });
    return view('alive');
  }
  if (stage !== 'pr_open' && stage !== 'in_review') return view('none');
  const expected = (everyMinutes ?? 10) * MINUTE;
  const since = lastWake !== null ? lastWake + expected : lastSave?.clear ? lastSave.at : prKnownAt ?? now;
  return view('missing', { since: Math.min(since, now) });
}
```

- [ ] **Step 4: Write `engine/model/pr-lookup.mjs`**

```js
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { MINUTE, parseTime } from '../time.mjs';

export const GITHUB_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export const ADO_REPO = /^[A-Za-z0-9][\w.-]*\/[^/\r\n]+\/[^/\r\n]+$/;
const ADO_ORG = /^[A-Za-z0-9][\w.-]*$/;
const EMPTY_INFO = Object.freeze({ state: 'unknown', title: null, openedAt: null, mergedAt: null, closedAt: null, reviewNote: null, url: null });

export function runCommand(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`${command} failed: ${String(stderr || error.message).trim().split('\n')[0].slice(0, 200)}`);
        failure.code = error.code;
        reject(failure);
        return;
      }
      resolve(String(stdout));
    });
  });
}

export const prKey = pr => `${pr.provider}:${pr.repo ?? ''}:${pr.id}`;

const adoOrg = pr => {
  const org = pr.repo ? pr.repo.split('/')[0] : null;
  return org && ADO_ORG.test(org) ? org : null;
};

export function adoArgs(pr) {
  const args = ['repos', 'pr', 'show', '--id', String(pr.id), '--output', 'json'];
  const org = adoOrg(pr);
  if (org) args.push('--organization', `https://dev.azure.com/${org}`, '--detect', 'false');
  return args;
}

export function githubArgs(pr) {
  const args = ['pr', 'view', String(pr.id), '--json', 'state,isDraft,title,createdAt,mergedAt,closedAt,reviewDecision,url'];
  if (pr.repo && GITHUB_REPO.test(pr.repo)) args.push('--repo', pr.repo);
  return args;
}

export function mapAdo(json) {
  const status = String(json.status ?? '').toLowerCase();
  const state = status === 'completed' ? 'merged' : status === 'abandoned' ? 'closed' : status === 'active' ? (json.isDraft ? 'draft' : 'open') : 'unknown';
  const votes = Array.isArray(json.reviewers) ? json.reviewers.map(reviewer => Number(reviewer.vote) || 0) : [];
  const approvals = votes.filter(vote => vote >= 5).length;
  const reviewNote = votes.includes(-10) ? 'rejected' : votes.includes(-5) ? 'waiting for the author'
    : approvals ? `${approvals} approval${approvals === 1 ? '' : 's'}` : 'no approvals yet';
  const webUrl = json.repository?.webUrl;
  return {
    state, title: typeof json.title === 'string' ? json.title : null, openedAt: parseTime(json.creationDate),
    mergedAt: state === 'merged' ? parseTime(json.closedDate) : null, closedAt: parseTime(json.closedDate), reviewNote,
    url: typeof webUrl === 'string' && json.pullRequestId ? `${webUrl}/pullrequest/${json.pullRequestId}` : null,
  };
}

export function mapGithub(json) {
  const raw = String(json.state ?? '').toUpperCase();
  const state = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : raw === 'OPEN' ? (json.isDraft ? 'draft' : 'open') : 'unknown';
  const reviewNote = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }[json.reviewDecision] ?? null;
  return {
    state, title: typeof json.title === 'string' ? json.title : null, openedAt: parseTime(json.createdAt),
    mergedAt: parseTime(json.mergedAt), closedAt: parseTime(json.closedAt), reviewNote, url: typeof json.url === 'string' ? json.url : null,
  };
}

/** Cached, read-only PR state through `az repos pr show` and `gh pr view`. Merged and closed results are final. */
export function createPrLookup({ run = runCommand, now = Date.now, ttlMs = 5 * MINUTE, timeoutMs = 20_000, concurrency = 2, exists = existsSync } = {}) {
  const cache = new Map();
  const queue = [];
  const inflight = new Set();
  let active = 0;
  let waiters = [];
  const isFinal = info => info.state === 'merged' || info.state === 'closed';
  const due = key => {
    const info = cache.get(key);
    return !info || (!isFinal(info) && now() - info.checkedAt >= ttlMs);
  };

  async function lookup({ pr, key, cwd }) {
    try {
      if (cwd && !exists(cwd)) throw new Error('its worktree is gone, so its repository is unknown');
      const ado = pr.provider === 'ado';
      const stdout = await run(ado ? 'az' : 'gh', ado ? adoArgs(pr) : githubArgs(pr), { cwd: cwd ?? undefined, timeoutMs });
      cache.set(key, { ...(ado ? mapAdo : mapGithub)(JSON.parse(stdout)), checkedAt: now(), error: null });
    } catch (error) {
      cache.set(key, { ...(cache.get(key) ?? EMPTY_INFO), checkedAt: now(), error: error.message });
    }
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      lookup(job).finally(() => {
        active -= 1;
        inflight.delete(job.key);
        if (queue.length) {
          pump();
        } else if (!active) {
          const list = waiters;
          waiters = [];
          for (const resolve of list) resolve();
        }
      });
    }
  }

  function request(pr, { cwd = null } = {}) {
    if (!pr || !Number.isInteger(pr.id) || pr.id <= 0 || (pr.provider !== 'ado' && pr.provider !== 'github')) return;
    const key = prKey(pr);
    if (inflight.has(key) || !due(key)) return;
    const target = pr.provider === 'ado' ? adoOrg(pr) : pr.repo && GITHUB_REPO.test(pr.repo) ? pr.repo : null;
    if (!target && !cwd) return;
    inflight.add(key);
    queue.push({ pr, key, cwd: target ? null : cwd });
    pump();
  }

  return {
    get: pr => cache.get(prKey(pr)) ?? null,
    request,
    settle: () => (active || queue.length ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve()),
    errors: () => [...cache].filter(([, info]) => info.error).map(([key, info]) => ({ key, error: info.error })),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass. No real `gh` or `az` command runs in tests.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): derive PR identity, stages and monitors"
```

### Task 13: Snapshot assembly

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/swarm.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/swarm.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–12.
- Produces: `buildSnapshot(input): Snapshot` with `input = { forest, rootId, app, states: Map<cliId, SessionState>, alive: Map<cliId, boolean|null>, workspaceFiles: Map<cliId, {cwd, branch, hostType, repository}|null>, ledger, sessionDbs: Map<cliId, {todos, deps, children}|null>, prInfo: (pr, {cwd}) => Info|null, now, thresholds, revision, diagnostics }`; `runLifecycle({lastActivityAt, anyActive, now, thresholds}): {lifecycle, finishedAt}`; `deriveLabels(names: string[]): string[]`; `initials(name): string`; `buildSegments({start, end, now, busy, waits, stuckFrom}): Segment[]`; `reportFromMessage(message, purpose, at): ReportView`.

Assembly rules (spec sections 7, 10 and 11, plus builder decisions):
- The latest report is the latest message a unit sent to its parent (sender side, with `purpose`), else the parent's received copy; a later `session.task_complete` replaces it only when more than 5 minutes newer.
- Registry rows resolve to units through `resolveNodeId` (project session id or CLI session id). Unit `name` is the registry title, else the session name.
- `dependsOn`: the registry `base_branch`, else the worktree's base branch, matched to another unit's branch; else the unit's todo dependency mapped to a unit or planned entry.
- Timeline busy spans closer than 2 minutes merge; waits on the user override busy; a live stuck state paints from `since` to now.
- Feed items come from every session's reducer feed plus one item per report sent to the parent; question text drops its tag; latest first, at most 200.
- `outcome` is the registry outcome, else `merged` (PR merged), `closed` (closed without merging), `failed` (status failed), or null.

- [ ] **Step 1: Write the failing test**

`tests/swarm.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../engine/config.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { createLedger } from '../engine/readers/ledger.mjs';
import { buildForest } from '../engine/model/forest.mjs';
import { buildSegments, buildSnapshot, deriveLabels, runLifecycle } from '../engine/model/swarm.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { fold } from './helpers/fold.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const at = minutes => T0 + minutes * MINUTE;
const iso = minutes => new Date(at(minutes)).toISOString();

function appData() {
  const workspaces = new Map();
  const ws = (id, name, cli, createdAt, extra = {}) => workspaces.set(id, {
    id, projectId: 'project-1', worktreeId: extra.baseBranch ? `wt-${id}` : null, name, branch: extra.branch ?? null, createdAt,
    archivedAt: extra.archivedAt ?? null, sessionId: cli, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null,
  });
  ws('ws-root', 'Sample story', 'cli-root', T0);
  ws('ws-api', 'Sample a1 api', 'cli-api', at(5), { branch: 'feature/api', baseBranch: 'main' });
  ws('ws-ui', 'Sample u1 ui', 'cli-ui', at(6), { branch: 'feature/ui', baseBranch: 'feature/api' });
  ws('ws-docs', 'Sample d1 docs', 'cli-docs', at(7), { branch: 'feature/docs', archivedAt: at(100) });
  return {
    projects: new Map([['project-1', { id: 'project-1', name: 'sample-project', githubOwner: null, githubRepo: null }]]),
    worktrees: new Map([
      ['wt-ws-api', { id: 'wt-ws-api', branch: 'feature/api', baseBranch: 'main' }],
      ['wt-ws-ui', { id: 'wt-ws-ui', branch: 'feature/ui', baseBranch: 'feature/api' }],
    ]),
    workspaces,
    parentLinks: ['ws-api', 'ws-ui', 'ws-docs'].map(childId => ({ childId, parentId: 'ws-root' })),
    aliases: [['cli-root', 'ws-root'], ['cli-api', 'ws-api'], ['cli-ui', 'ws-ui'], ['cli-docs', 'ws-docs']].map(([sessionId, workspaceId]) => ({ sessionId, workspaceId, createdAt: T0 })),
    chatLinks: [],
    sessions: new Map(),
    automations: [{ sessionId: 'cli-api', interval: 'minutes', everyMinutes: 10, lastRunAt: at(110), nextRunAt: at(125), pausedAt: null, name: 'PR monitor' }],
    diagnostics: [],
  };
}

function logs(contract) {
  const root = new EventLog(T0);
  root.start();
  root.at(at(100));
  root.turnStart();
  root.ask(contract ? '[unit=api need=pr] Publish PR !4711?' : 'Publish PR !4711?');

  const api = new EventLog(at(5));
  api.start();
  api.turnStart();
  api.at(at(20));
  const reviewer = api.subagent({ name: 'reviewer', type: 'code-review', mode: 'background', agentId: 'agent-r' });
  api.at(at(25));
  api.subagentDone(reviewer, { durationMs: 5 * MINUTE });
  api.at(at(30));
  api.report('ws-root', contract
    ? 'swarm-status: complete unit=api pr=ado:4711 commit=abc1234\nSummary: API done.\nEvidence:\n- 12 tests pass\nBlockers: none'
    : 'Need a decision before publishing PR !4711.', contract ? 'handoff' : 'needs_input');
  api.at(at(31));
  api.turnEnd();
  api.at(at(110));
  api.automationWake();
  api.turnStart();
  api.at(at(111));
  api.turnEnd();

  const ui = new EventLog(at(6));
  ui.start();
  ui.at(at(60));
  ui.turnStart();
  ui.at(at(90));
  ui.tool('bash', { command: 'npm run e2e', initial_wait: 60 });

  const docs = new EventLog(at(7));
  docs.start();
  docs.turnStart();
  docs.at(at(50));
  docs.turnEnd();
  docs.at(at(95));
  docs.report('ws-root', contract ? 'swarm-status: complete unit=docs pr=ado:4712\nSummary: Docs merged.' : 'Docs merged in PR !4712.', 'handoff');
  docs.at(at(99));
  docs.shutdown();
  return { root, api, ui, docs, reviewer };
}

function input(contract = true) {
  const app = appData();
  const { root, api, ui, docs, reviewer } = logs(contract);
  const ledger = createLedger();
  ledger.apply([
    { id: 1, session_id: 'cli-root', model: 'claude-opus-5.5', total_nano_aiu: 10e9, duration_ms: 1000, created_at: iso(1) },
    { id: 2, session_id: 'cli-api', model: 'gpt-5.5', total_nano_aiu: 20e9, duration_ms: 2000, created_at: iso(20) },
    { id: 3, session_id: 'cli-api', model: 'gpt-5.5', parent_tool_call_id: reviewer, agent_id: 'agent-r', total_nano_aiu: 5e9, duration_ms: 500, created_at: iso(22) },
  ]);
  const row = (unit, sessionId, title, extra = {}) => ({
    unit, session_id: sessionId, title, todo_id: unit, branch: null, base_branch: null, pr_provider: null, pr_repo: null, pr_id: null, pr_url: null,
    outcome: null, created_at: iso(5), updated_at: iso(30), ended_at: null, ...extra,
  });
  const children = contract ? [
    row('api', 'ws-api', 'API', { branch: 'feature/api', base_branch: 'main', pr_provider: 'ado', pr_repo: 'org/project/repo', pr_id: 4711 }),
    row('ui', 'cli-ui', 'UI', { branch: 'feature/ui', base_branch: 'feature/api' }),
    row('docs', 'ws-docs', 'Docs', { outcome: 'merged', ended_at: iso(95), updated_at: iso(100) }),
  ] : null;
  const todos = contract
    ? ['api:in_progress', 'ui:pending', 'docs:done', 'export:pending', 'unrelated:pending'].map(entry => {
      const [id, status] = entry.split(':');
      return { id, title: id[0].toUpperCase() + id.slice(1), description: '', status };
    })
    : [{ id: 'todo-api', title: 'API', description: 'Unit session ws-api', status: 'in_progress' }, { id: 'todo-next', title: 'Next', description: '', status: 'pending' }];
  const deps = contract
    ? [{ todoId: 'ui', dependsOn: 'api' }, { todoId: 'export', dependsOn: 'api' }]
    : [{ todoId: 'todo-next', dependsOn: 'todo-api' }];
  const requests = [];
  return {
    forest: buildForest(app), rootId: 'ws-root', app, ledger, requests,
    states: new Map([['cli-root', fold(root, 'cli-root')], ['cli-api', fold(api, 'cli-api')], ['cli-ui', fold(ui, 'cli-ui')], ['cli-docs', fold(docs, 'cli-docs')]]),
    alive: new Map([['cli-root', true], ['cli-api', true], ['cli-ui', true], ['cli-docs', false]]),
    workspaceFiles: new Map([['cli-api', { cwd: '/synthetic/worktrees/api', branch: 'feature/api', hostType: 'ado', repository: 'org/project/repo' }]]),
    sessionDbs: new Map([['cli-root', { todos, deps, children }]]),
    prInfo: (pr, options) => {
      requests.push({ ...pr, cwd: options.cwd });
      return contract && pr.provider === 'ado' && pr.id === 4711
        ? { state: 'open', title: 'API', openedAt: at(29), mergedAt: null, closedAt: null, reviewNote: '1 approval', url: null, checkedAt: at(115), error: null }
        : null;
    },
    now: at(120), thresholds: DEFAULT_THRESHOLDS, revision: 3, diagnostics: [],
  };
}

test('a contract-following swarm becomes a valid snapshot', () => {
  const data = input(true);
  const snapshot = buildSnapshot(data);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.revision, 3);
  assert.deepEqual(snapshot.run.contract, { registry: true, statusLines: true, questionTags: true });
  assert.equal(snapshot.run.lifecycle, 'live');
  assert.equal(snapshot.run.firstChildAt, at(5));
  assert.equal(snapshot.run.project.name, 'sample-project');
  assert.equal(snapshot.orchestrator.statusDetail, 'waiting_question');
  assert.equal(snapshot.orchestrator.label, 'SS');
  assert.deepEqual(snapshot.units.map(unit => unit.label), ['api', 'ui', 'docs']);
  const [api, ui, docs] = snapshot.units;
  assert.deepEqual({ status: api.status, stage: api.stage, monitor: api.monitor.state, dependsOn: api.dependsOn, todoId: api.todoId, name: api.name },
    { status: 'idle', stage: 'in_review', monitor: 'alive', dependsOn: null, todoId: 'api', name: 'API' });
  assert.deepEqual({ provider: api.pr.provider, id: api.pr.id, repo: api.pr.repo, source: api.pr.source, state: api.pr.state, reviewNote: api.pr.reviewNote },
    { provider: 'ado', id: 4711, repo: 'org/project/repo', source: 'registry', state: 'open', reviewNote: '1 approval' });
  assert.deepEqual(
    { status: api.report.status, source: api.report.source, title: api.report.title, evidence: api.report.evidence, blockers: api.report.blockers, unit: api.report.unit, commit: api.report.commit },
    { status: 'complete', source: 'contract', title: 'API done.', evidence: ['12 tests pass'], blockers: [], unit: 'api', commit: 'abc1234' },
  );
  assert.deepEqual(api.subagents.map(sub => [sub.name, sub.status, sub.credits]), [['reviewer', 'completed', 5]]);
  assert.equal(api.cost.credits, 25);
  assert.deepEqual({ status: ui.status, detail: ui.statusDetail, since: ui.since, dependsOn: ui.dependsOn, stage: ui.stage },
    { status: 'stuck', detail: 'stuck_tool', since: at(90), dependsOn: 'api', stage: 'coding' });
  assert.equal(ui.reason, 'bash has run for 30 min with a limit of 6 min (initial_wait 1 min + 5 min).');
  assert.equal(ui.activity.tool.summary, 'bash: npm run e2e');
  assert.equal(ui.timeline.segments.at(-1).state, 'stuck');
  assert.deepEqual({ status: docs.status, stage: docs.stage, outcome: docs.outcome, monitor: docs.monitor.state, pr: docs.pr.id, alive: docs.alive, endedAt: docs.endedAt },
    { status: 'archived', stage: 'archived', outcome: 'merged', monitor: 'ended', pr: 4712, alive: false, endedAt: at(100) });
  assert.deepEqual(snapshot.planned, [{ label: 'export', name: 'Export', dependsOn: 'api', canStart: true, waitsOn: null, todoId: 'export' }]);
  assert.deepEqual(snapshot.needs, [{ kind: 'pr', unitIds: ['ws-api'], labels: ['api'], fromId: 'ws-root', text: 'Publish PR !4711?', since: at(100), tagged: true }]);
  assert.deepEqual(snapshot.counts, { working: 0, stuck: 1, waiting: 0, idle: 1, done: 1, failed: 0 });
  assert.equal(snapshot.cost.credits, 35);
  assert.equal(snapshot.cost.usd, 0.35);
  assert.equal(snapshot.cost.maxUnitCredits, 25);
  assert.equal(snapshot.cost.series.at(-1).credits, 35);
  assert.ok(snapshot.feed.some(item => item.unitId === 'ws-api' && item.kind === 'report' && item.text === 'reported complete: API done.'));
  assert.ok(snapshot.feed.some(item => item.unitId === 'ws-root' && item.text === 'asked: Publish PR !4711?'));
  assert.ok(snapshot.feed.every((item, index, list) => index === 0 || list[index - 1].at >= item.at));
  assert.ok(data.requests.some(request => request.id === 4711));
});

test('without the contract, heuristics fill in labels, reports, PRs and plan entries', () => {
  const snapshot = buildSnapshot(input(false));
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.deepEqual(snapshot.run.contract, { registry: false, statusLines: false, questionTags: false });
  assert.deepEqual(snapshot.units.map(unit => unit.label), ['a1', 'u1', 'd1']);
  const [api, ui, docs] = snapshot.units;
  assert.equal(api.statusDetail, 'blocked_on_orchestrator');
  assert.deepEqual({ status: api.report.status, source: api.report.source, body: api.report.body },
    { status: 'needs_input', source: 'purpose', body: 'Need a decision before publishing PR !4711.' });
  assert.deepEqual({ provider: api.pr.provider, id: api.pr.id, repo: api.pr.repo, source: api.pr.source, state: api.pr.state },
    { provider: 'ado', id: 4711, repo: 'org/project/repo', source: 'heuristic', state: 'unknown' });
  assert.equal(api.stage, 'in_review');
  assert.equal(api.todoId, 'todo-api');
  assert.equal(ui.dependsOn, 'a1');
  assert.equal(docs.outcome, null);
  assert.deepEqual(snapshot.planned, [{ label: 'todo-next', name: 'Next', dependsOn: 'a1', canStart: true, waitsOn: null, todoId: 'todo-next' }]);
  assert.deepEqual(snapshot.needs.map(need => [need.kind, need.unitIds, need.tagged]), [['question', [], false]]);
  assert.equal(snapshot.counts.waiting, 1);
});

test('a run is finished after two quiet hours with nothing active', () => {
  const thresholds = DEFAULT_THRESHOLDS;
  assert.deepEqual(runLifecycle({ lastActivityAt: T0, anyActive: false, now: T0 + 2 * HOUR, thresholds }), { lifecycle: 'finished', finishedAt: T0 });
  assert.deepEqual(runLifecycle({ lastActivityAt: T0, anyActive: false, now: T0 + 2 * HOUR - 1, thresholds }), { lifecycle: 'live', finishedAt: null });
  assert.deepEqual(runLifecycle({ lastActivityAt: T0, anyActive: true, now: T0 + 5 * HOUR, thresholds }), { lifecycle: 'live', finishedAt: null });
});

test('labels come from unique code-like words, then initials', () => {
  assert.deepEqual(deriveLabels(['Sample a0 parser checks', 'Sample a1 export format', 'Sample release notes', '4711 sample q1 UI checks']), ['a0', 'a1', 'RN', 'q1']);
});

test('timeline segments merge short gaps and show waits and a live stuck tail', () => {
  assert.deepEqual(buildSegments({ start: at(0), end: null, now: at(60), busy: [[at(10), at(20)], [at(21), at(30)]], waits: [[at(25), at(28), 'question']], stuckFrom: at(50) }), [
    { start: at(0), end: at(10), state: 'idle' },
    { start: at(10), end: at(25), state: 'busy' },
    { start: at(25), end: at(28), state: 'question' },
    { start: at(28), end: at(30), state: 'busy' },
    { start: at(30), end: at(50), state: 'idle' },
    { start: at(50), end: null, state: 'stuck' },
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/swarm.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/model/swarm.mjs'`.

- [ ] **Step 3: Write `engine/model/swarm.mjs`, part 1 (helpers)**

```js
import { CREDIT_USD, NANO_AIU_PER_CREDIT, SCHEMA_VERSION } from '../schema.mjs';
import { clip, firstLine, oneLine } from '../text.mjs';
import { MINUTE, maxTime, minTime } from '../time.mjs';
import { UNIT_LABEL_RE, normaliseRegistry, parseQuestionTag, parseReportBody, parseStatusLine, purposeToStatus } from './contract.mjs';
import { descendants, resolveNodeId } from './forest.mjs';
import { mergeStates } from './session-state.mjs';
import { deriveMonitor, deriveStage, hostOf, prView, resolvePr } from './stage.mjs';
import { ACTIVE_DETAILS, displayOf, evaluateStatus, swarmStalled, toolLimitMs, toolView } from './status.mjs';

const SEGMENT_GAP_MS = 2 * MINUTE;
const TASK_OVERRIDE_MS = 5 * MINUTE;
const FEED_LIMIT = 200;
const CODE_WORD = /^[A-Za-z]{1,4}\d[A-Za-z0-9.-]{0,8}$/;
const STARTABLE = new Set(['pr_open', 'in_review', 'merged', 'archived']);
const STATUS_WORDS = { complete: 'complete', progress: 'progress', needs_input: 'needs input', blocked: 'blocked' };

const credits = nanoAiu => Math.round((nanoAiu / NANO_AIU_PER_CREDIT) * 10) / 10;

export function initials(name) {
  return String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || 'O';
}

/** First word with a letter-then-digit code that no sibling shares (b1, F2a), else initials of unique words, else U<n>. */
export function deriveLabels(names) {
  const words = names.map(name => String(name ?? '').split(/\s+/).filter(Boolean));
  const frequency = new Map();
  for (const list of words) for (const word of new Set(list.map(item => item.toLowerCase()))) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return words.map((list, index) => {
    const unique = list.filter(word => frequency.get(word.toLowerCase()) === 1 || names.length === 1);
    const code = unique.find(word => CODE_WORD.test(word));
    if (code) return code;
    const letters = unique.slice(0, 2).map(word => word[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return letters || `U${index + 1}`;
  });
}

export function runLifecycle({ lastActivityAt, anyActive, now, thresholds }) {
  const finished = !anyActive && now - lastActivityAt >= thresholds.runFinishedAfterMs;
  return { lifecycle: finished ? 'finished' : 'live', finishedAt: finished ? lastActivityAt : null };
}

function mergeSpans(spans, gap) {
  const out = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Non-overlapping timeline segments from start to end (or now, with an open last segment). */
export function buildSegments({ start, end = null, now, busy, waits, stuckFrom = null }) {
  const stop = end ?? now;
  if (!(stop > start)) return [];
  const clamp = value => Math.min(Math.max(value, start), stop);
  const merged = mergeSpans(busy, SEGMENT_GAP_MS);
  const points = new Set([start, stop]);
  for (const [s, e] of merged) {
    points.add(clamp(s));
    points.add(clamp(e));
  }
  for (const [s, e] of waits) {
    points.add(clamp(s));
    points.add(clamp(e));
  }
  if (stuckFrom !== null) points.add(clamp(stuckFrom));
  const sorted = [...points].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (e <= s) continue;
    const mid = s + (e - s) / 2;
    const wait = waits.find(([ws, we]) => ws <= mid && mid < we);
    const state = stuckFrom !== null && mid >= stuckFrom ? 'stuck' : wait ? wait[2] : merged.some(([bs, be]) => bs <= mid && mid < be) ? 'busy' : 'idle';
    const last = segments[segments.length - 1];
    if (last && last.state === state) last.end = e;
    else segments.push({ start: s, end: e, state });
  }
  if (end === null && segments.length) segments[segments.length - 1].end = null;
  return segments;
}

function reportFields(text) {
  const fields = parseReportBody(text);
  return {
    title: oneLine(fields.summary ?? firstLine(fields.freeText) ?? '', 160),
    summary: fields.summary, evidence: fields.evidence, blockers: fields.blockers,
    body: fields.freeText ? clip(fields.freeText, 4000) : null,
  };
}

/** A report from a message: contract status line, else the send's purpose, else a plain progress message. */
export function reportFromMessage(message, purpose, at) {
  const text = String(message ?? '');
  const line = parseStatusLine(text);
  const mapped = purposeToStatus(purpose);
  return {
    status: line?.status ?? mapped ?? 'progress',
    source: line ? 'contract' : mapped ? 'purpose' : 'message',
    at,
    ...reportFields(line ? text.split(/\r?\n/).slice(1).join('\n') : text),
    unit: line?.unit ?? null,
    commit: line?.commit ?? null,
  };
}

function reportFromTask(task) {
  return { status: task.success ? 'complete' : 'blocked', source: 'task_complete', at: task.at, ...reportFields(task.summary), unit: null, commit: null };
}

function plannedLabel(todoId) {
  return UNIT_LABEL_RE.test(todoId) ? todoId : String(todoId).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'planned';
}

function activityLabel(detail, tool, current) {
  const fixed = {
    archived: 'Archived', merged: 'Done. PR merged', stopped: 'Stopped', crashed: 'Process ended unexpectedly', failed: 'Failed',
    waiting_question: 'Waiting for an answer', waiting_plan: 'Waiting for plan approval', blocked: 'Blocked',
    blocked_on_orchestrator: 'Waiting for the orchestrator', stalled: 'Stalled after a progress report', idle: 'Idle',
  }[detail];
  if (fixed) return fixed;
  if (tool?.name === 'task') return `Waiting for its ${current?.subagents.get(tool.id)?.type ?? 'sub-agent'} (sync)`;
  return tool ? `Running ${tool.summary}` : 'Thinking';
}

function progressOf(db) {
  if (!db || !db.todos.length) return null;
  return { done: db.todos.filter(todo => todo.status === 'done').length, total: db.todos.length };
}

function subagentViews(all, cost, stuckIds) {
  const running = status => status === 'running' || status === 'stuck';
  return [...all.subagents.values()].map(sub => ({
    id: sub.id, name: sub.name, type: sub.type, model: sub.model, mode: sub.mode,
    status: sub.status === 'running' && stuckIds.has(sub.id) ? 'stuck' : sub.status,
    startedAt: sub.startedAt ?? sub.launchedAt, endedAt: sub.endedAt, durationMs: sub.durationMs,
    credits: credits(cost.byParentToolCall.get(sub.id)?.nanoAiu ?? 0), task: sub.task,
  })).sort((a, b) => Number(running(b.status)) - Number(running(a.status)) || b.startedAt - a.startedAt);
}
```

- [ ] **Step 4: Write `engine/model/swarm.mjs`, part 2 (views and assembly)** — append:

```js
function nodeContext(input, node) {
  const states = node.cliSessionIds.map(id => input.states.get(id)).filter(Boolean);
  const cli = node.currentCliSessionId;
  return {
    node, states, current: cli ? input.states.get(cli) ?? null : null, all: mergeStates(states),
    ids: new Set([node.id, ...node.cliSessionIds]),
    alive: cli ? input.alive.get(cli) ?? null : null,
    sessionRow: cli ? input.app.sessions.get(cli) ?? null : null,
    sessionDb: cli ? input.sessionDbs.get(cli) ?? null : null,
    workspaceFile: cli ? input.workspaceFiles?.get(cli) ?? null : null,
    cwd: cli ? input.workspaceFiles?.get(cli)?.cwd ?? null : null,
    cost: input.ledger.sumFor(node.cliSessionIds),
  };
}

function readRegistry(input, root) {
  const sets = root.cliSessionIds.map(id => input.sessionDbs.get(id)?.children).filter(Array.isArray);
  const { units, invalid } = normaliseRegistry(sets);
  const byNode = new Map();
  for (const row of units.values()) {
    const id = resolveNodeId(input.forest, row.sessionId);
    if (id && id !== root.id) byNode.set(id, row);
  }
  return { present: sets.length > 0, rows: units, byNode, invalid };
}

function assignLabels(root, nodes, registry) {
  const labels = new Map([[root.id, initials(root.name)]]);
  const derived = deriveLabels(nodes.map(node => node.name));
  const used = new Set();
  nodes.forEach((node, index) => {
    const base = registry.byNode.get(node.id)?.unit ?? derived[index];
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n += 1) label = `${base}-${n}`;
    used.add(label.toLowerCase());
    labels.set(node.id, label);
  });
  return labels;
}

function sessionView(input, c, label, evaluation, report, title, extraMarks) {
  const { node, current, all } = c;
  const { now, thresholds } = input;
  const { status, bucket } = displayOf(evaluation.detail);
  const endedAt = node.archivedAt ?? (c.alive === false ? all.lastEventAt : null);
  const startedAt = node.createdAt ?? all.firstEventAt ?? now;
  const openTool = current && current.openTools.size ? [...current.openTools.values()].sort((a, b) => a.startedAt - b.startedAt)[0] : null;
  const tool = evaluation.tool ?? (openTool ? toolView(openTool, toolLimitMs(openTool, thresholds)) : null);
  const openWaits = current ? [...current.waits.values()] : [];
  const busy = [...all.busySpans, ...(current?.turn ? [[current.turn.startedAt, now]] : [])];
  const waits = [...all.waitSpans, ...openWaits.map(wait => [wait.startedAt, now, wait.kind])];
  return {
    id: node.id, kind: node.kind, label, name: title ?? node.name ?? '', cliSessionIds: [...node.cliSessionIds],
    branch: node.branch ?? null, model: current?.model ?? c.sessionRow?.model ?? all.model ?? null,
    status, statusDetail: evaluation.detail, bucket, since: evaluation.since, reason: evaluation.reason,
    startedAt, endedAt, lastEventAt: all.lastEventAt,
    busyMs: Math.max(0, Math.round(all.busyMs + (current?.turn ? now - current.turn.startedAt : 0))),
    waitingOnUserMs: Math.max(0, Math.round(all.waitingMs + openWaits.reduce((sum, wait) => sum + (now - wait.startedAt), 0))),
    alive: c.alive,
    cost: { credits: credits(c.cost.nanoAiu), calls: c.cost.calls },
    activity: { label: activityLabel(evaluation.detail, tool, current), tool, lastEventAt: all.lastEventAt },
    report,
    progress: progressOf(c.sessionDb),
    subagents: subagentViews(all, c.cost, evaluation.stuckSubagents),
    timeline: {
      segments: buildSegments({ start: startedAt, end: endedAt, now, busy, waits, stuckFrom: status === 'stuck' && endedAt === null ? evaluation.since : null }),
      subagents: [...all.subagents.values()].map(sub => ({ id: sub.id, start: sub.startedAt ?? sub.launchedAt, end: sub.endedAt ?? endedAt, type: sub.type })),
      marks: [...all.marks, ...extraMarks].sort((a, b) => a.at - b.at).slice(-400),
    },
  };
}

function buildUnit(input, node, contexts, registry, labels, project, flags, extraFeed) {
  const c = contexts.get(node.id);
  const parent = contexts.get(node.parentId);
  const row = registry.byNode.get(node.id) ?? null;
  const label = labels.get(node.id);
  const sent = c.all.sent.filter(item => !item.failed && item.target && parent.ids.has(item.target))
    .map(item => ({ item, line: parseStatusLine(item.message), view: reportFromMessage(item.message, item.purpose, item.at) }));
  const statusLines = [];
  for (const { item, line, view } of sent) {
    if (line) {
      flags.statusLines = true;
      statusLines.unshift({ at: item.at, pr: line.pr });
    }
    extraFeed.push({ at: item.at, unitId: node.id, label, kind: 'report', text: oneLine(`reported ${STATUS_WORDS[view.status]}: ${view.title}`, 200) });
  }
  let report = sent.length ? sent[sent.length - 1].view : null;
  if (!report) {
    const received = parent.all.inbound.filter(item => c.ids.has(item.fromSessionId) || c.ids.has(item.fromProjectSessionId));
    const last = received[received.length - 1];
    if (last) {
      report = reportFromMessage(last.content, null, last.at);
      if (report.source === 'contract') flags.statusLines = true;
    }
  }
  const lastTask = c.all.taskCompletes[c.all.taskCompletes.length - 1];
  if (lastTask && (!report || lastTask.at > report.at + TASK_OVERRIDE_MS)) report = reportFromTask(lastTask);
  let parentRepliedAt = null;
  for (const item of c.all.inbound) {
    if (parent.ids.has(item.fromSessionId) || parent.ids.has(item.fromProjectSessionId)) parentRepliedAt = maxTime(parentRepliedAt, item.at);
  }

  const host = hostOf(c.workspaceFile, (node.projectId ? input.app.projects.get(node.projectId) : null) ?? project);
  const identity = resolvePr({ registry: row, statusLines, createdPr: node.createdPr, mentions: c.all.prMentions, host });
  const pr = identity ? prView(identity, input.prInfo(identity, { cwd: c.cwd }), node.createdPr) : null;
  const automations = input.app.automations.filter(item => c.ids.has(item.sessionId));
  const monitorEver = automations.length > 0 || c.all.automation.wakes.length > 0 || c.all.automation.saves.some(save => !save.clear);
  const { stage, merged, closedWithoutMerge } = deriveStage({ archivedAt: node.archivedAt, outcome: row?.outcome ?? null, pr, monitorEver });
  const monitor = deriveMonitor({
    stage, hasPr: Boolean(pr), automations, wakes: c.all.automation.wakes, saves: c.all.automation.saves,
    prKnownAt: pr?.openedAt ?? identity?.knownAt ?? null, now: input.now, thresholds: input.thresholds,
  });
  const evaluation = evaluateStatus({
    state: c.current, alive: c.alive, archivedAt: node.archivedAt, merged, mergedAt: pr?.mergedAt ?? row?.endedAt ?? null,
    outcome: row?.outcome ?? null, hasRegistry: registry.present, report: report ? { status: report.status, at: report.at } : null,
    parentRepliedAt, monitorDueAt: monitor.state === 'alive' ? monitor.nextCheckAt : null, isRunningFlag: Boolean(c.sessionRow?.isRunning),
    startedAt: node.createdAt ?? c.all.firstEventAt ?? input.now, now: input.now, thresholds: input.thresholds,
  });

  const marks = sent.map(({ item, view }) => ({ at: item.at, kind: view.status === 'needs_input' ? 'question' : 'report', text: view.title || 'Report', status: view.status }));
  if (pr?.openedAt) marks.push({ at: pr.openedAt, kind: 'pr-open', text: 'PR opened', status: null });
  if (pr?.mergedAt) marks.push({ at: pr.mergedAt, kind: 'pr-merged', text: 'PR merged', status: null });
  if (node.archivedAt) marks.push({ at: node.archivedAt, kind: 'archived', text: 'Archived', status: null });
  if (evaluation.detail === 'stuck_tool' && evaluation.tool) marks.push({ at: evaluation.tool.startedAt, kind: 'tool', text: 'Tool call started, no events since', status: null });

  const outcome = row?.outcome ?? (merged ? 'merged' : closedWithoutMerge ? 'closed' : evaluation.detail === 'failed' ? 'failed' : null);
  return {
    ...sessionView(input, c, label, evaluation, report, row?.title ?? null, marks),
    parentId: node.parentId, depth: node.depth, stage, closedWithoutMerge, outcome, pr, monitor, dependsOn: null, todoId: row?.todoId ?? null,
  };
}

function planFromTodos(db, units, registry) {
  const todos = db?.todos ?? [];
  const todoOfUnit = new Map();
  const unitOfTodo = new Map();
  for (const unit of units) {
    if (unit.todoId && todos.some(todo => todo.id === unit.todoId)) {
      todoOfUnit.set(unit.id, unit.todoId);
      unitOfTodo.set(unit.todoId, unit);
    }
  }
  if (!registry.present) {
    for (const todo of todos) {
      if (unitOfTodo.has(todo.id)) continue;
      const text = `${todo.title}\n${todo.description}`;
      const unit = units.find(item => !todoOfUnit.has(item.id) && (text.includes(item.id) || item.cliSessionIds.some(id => text.includes(id))));
      if (unit) {
        todoOfUnit.set(unit.id, todo.id);
        unitOfTodo.set(todo.id, unit);
      }
    }
  }
  const dependsOn = new Map();
  for (const dep of db?.deps ?? []) {
    if (!dependsOn.has(dep.todoId)) dependsOn.set(dep.todoId, []);
    dependsOn.get(dep.todoId).push(dep.dependsOn);
  }
  const planned = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const todo of todos) {
      if (unitOfTodo.has(todo.id) || planned.has(todo.id) || (todo.status !== 'pending' && todo.status !== 'blocked')) continue;
      if ((dependsOn.get(todo.id) ?? []).some(id => unitOfTodo.has(id) || planned.has(id))) {
        planned.set(todo.id, todo);
        changed = true;
      }
    }
  }
  return { todoOfUnit, unitOfTodo, dependsOn, planned };
}

function firstKnownDependency(plan, todoId) {
  return (plan.dependsOn.get(todoId) ?? []).find(id => plan.unitOfTodo.has(id) || plan.planned.has(id)) ?? null;
}

function assignDependencies(units, nodes, registry, plan) {
  const byBranch = new Map(units.filter(unit => unit.branch).map(unit => [unit.branch, unit]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  for (const unit of units) {
    const base = registry.byNode.get(unit.id)?.baseBranch ?? nodeById.get(unit.id)?.baseBranch ?? null;
    const parentUnit = base ? byBranch.get(base) : null;
    let dependsOn = parentUnit && parentUnit !== unit ? parentUnit.label : null;
    if (!dependsOn) {
      const depId = firstKnownDependency(plan, plan.todoOfUnit.get(unit.id));
      if (depId) dependsOn = plan.unitOfTodo.get(depId)?.label ?? plannedLabel(depId);
    }
    unit.dependsOn = dependsOn;
  }
}

function plannedEntries(plan) {
  return [...plan.planned.values()].map(todo => {
    const depId = firstKnownDependency(plan, todo.id);
    const depUnit = depId ? plan.unitOfTodo.get(depId) ?? null : null;
    const dependsOn = depId ? depUnit?.label ?? plannedLabel(depId) : null;
    const canStart = Boolean(depUnit) && STARTABLE.has(depUnit.stage);
    return { label: plannedLabel(todo.id), name: todo.title, dependsOn, canStart, waitsOn: canStart ? null : dependsOn, todoId: todo.id };
  });
}

function buildNeeds(contexts, rootId, labels, flags) {
  const labelIndex = new Map([...labels].filter(([id]) => id !== rootId).map(([id, label]) => [label.toLowerCase(), id]));
  const needs = [];
  for (const [id, c] of contexts) {
    for (const wait of c.current ? c.current.waits.values() : []) {
      const tag = wait.kind === 'question' ? parseQuestionTag(wait.text) : null;
      if (tag) flags.questionTags = true;
      let unitIds = id === rootId ? [] : [id];
      if (tag && id === rootId && !tag.units.includes('*')) {
        unitIds = [...new Set(tag.units.map(label => labelIndex.get(label.toLowerCase())).filter(Boolean))];
      }
      needs.push({
        kind: wait.kind === 'plan' ? 'plan' : tag?.need ?? 'question', unitIds, labels: unitIds.map(unitId => labels.get(unitId)),
        fromId: id, text: oneLine(tag ? tag.text : wait.text, 300), since: wait.startedAt, tagged: Boolean(tag),
      });
    }
  }
  return needs.sort((a, b) => a.since - b.since);
}

function buildFeed(contexts, labels, extraFeed) {
  const items = [...extraFeed];
  for (const [id, c] of contexts) {
    for (const item of c.all.feed) {
      let text = item.text;
      if (item.kind === 'question' && text.startsWith('asked: ')) text = `asked: ${parseQuestionTag(text.slice(7))?.text ?? text.slice(7)}`;
      items.push({ at: item.at, unitId: id, label: labels.get(id), kind: item.kind, text });
    }
  }
  return items.sort((a, b) => b.at - a.at).slice(0, FEED_LIMIT);
}

function costSummary(ledger, cliIds, units) {
  const totals = ledger.sumFor(cliIds);
  let cumulative = 0;
  const series = [...totals.buckets].sort((a, b) => a[0] - b[0]).map(([at, nanoAiu]) => {
    cumulative += nanoAiu;
    return { at, credits: credits(cumulative) };
  });
  const total = credits(totals.nanoAiu);
  return {
    lastAt: totals.lastAt,
    summary: {
      credits: total, usd: Math.round(total * CREDIT_USD * 100) / 100,
      maxUnitCredits: units.reduce((max, unit) => Math.max(max, unit.cost.credits), 0),
      byModel: [...totals.byModel].map(([model, entry]) => ({ model, credits: credits(entry.nanoAiu), calls: entry.calls, apiMs: Math.round(entry.apiMs) }))
        .sort((a, b) => b.credits - a.credits),
      series,
    },
  };
}

export function buildSnapshot(input) {
  const { forest, rootId, app, now, thresholds } = input;
  const root = forest.nodes.get(rootId);
  const nodes = descendants(forest, rootId);
  const project = root.projectId ? app.projects.get(root.projectId) ?? null : null;
  const contexts = new Map([root, ...nodes].map(node => [node.id, nodeContext(input, node)]));
  const rootContext = contexts.get(root.id);
  const registry = readRegistry(input, root);
  const labels = assignLabels(root, nodes, registry);
  const flags = { statusLines: false, questionTags: false };
  const extraFeed = [];
  const units = nodes.map(node => buildUnit(input, node, contexts, registry, labels, project, flags, extraFeed));
  const plan = planFromTodos(rootContext.sessionDb, units, registry);
  for (const unit of units) unit.todoId = unit.todoId ?? plan.todoOfUnit.get(unit.id) ?? null;
  assignDependencies(units, nodes, registry, plan);

  const evaluation = evaluateStatus({
    state: rootContext.current, alive: rootContext.alive, archivedAt: root.archivedAt, merged: false, mergedAt: null, outcome: null,
    hasRegistry: registry.present, report: null, parentRepliedAt: null, monitorDueAt: null, isRunningFlag: Boolean(rootContext.sessionRow?.isRunning),
    startedAt: root.createdAt ?? rootContext.all.firstEventAt ?? now, now, thresholds,
  });
  const orchestrator = sessionView(input, rootContext, labels.get(root.id), evaluation, null, null, []);
  const needs = buildNeeds(contexts, root.id, labels, flags);
  const { summary: cost, lastAt: lastCostAt } = costSummary(input.ledger, [root, ...nodes].flatMap(node => node.cliSessionIds), units);
  const counts = { working: 0, stuck: 0, waiting: 0, idle: 0, done: 0, failed: 0 };
  for (const unit of units) counts[unit.bucket] += 1;

  const lastActivityAt = maxTime(...[...contexts.values()].map(c => c.all.lastEventAt), lastCostAt) ?? root.createdAt ?? now;
  const anyActive = [orchestrator, ...units].some(session => ACTIVE_DETAILS.has(session.statusDetail));
  const { lifecycle, finishedAt } = runLifecycle({ lastActivityAt, anyActive, now, thresholds });
  const monitorDue = units.some(unit => unit.monitor.state === 'alive') || app.automations.some(item => rootContext.ids.has(item.sessionId)
    && item.pausedAt === null && item.nextRunAt !== null && item.nextRunAt > now - thresholds.monitorGraceMs);
  const stalled = lifecycle === 'live'
    ? swarmStalled({ orchestratorDetail: orchestrator.statusDetail, unitDetails: units.map(unit => unit.statusDetail), monitorDue, lastActivityAt })
    : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    revision: input.revision ?? 0,
    run: {
      id: root.id, name: root.name ?? '', project: project ? { id: project.id, name: project.name } : null,
      startedAt: root.createdAt ?? orchestrator.startedAt, firstChildAt: minTime(...nodes.map(node => node.createdAt)),
      lastActivityAt, lifecycle, finishedAt, stalled,
      contract: { registry: registry.present && registry.rows.size > 0, statusLines: flags.statusLines, questionTags: flags.questionTags },
    },
    orchestrator,
    units,
    planned: plannedEntries(plan),
    needs,
    feed: buildFeed(contexts, labels, extraFeed),
    counts,
    cost,
    diagnostics: input.diagnostics ?? [],
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass; both synthetic swarms validate against `SNAPSHOT_SPEC`.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): assemble swarm snapshots"
```

### Task 14: Run summaries and the history store

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/model/history.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/history.test.mjs`

**Interfaces:**
- Consumes: `SCHEMA_VERSION`, `validateRunSummary` (Task 2); a `Snapshot` (Task 13); `tempDir` (Task 1).
- Produces: `summarizeRun(snapshot, {computedAt}): RunSummary`; `listItemOf(summary): RunListItem`; `createHistoryStore(dir): { dir, get(id): Promise<RunSummary|null>, list(): Promise<RunSummary[]>, put(summary): Promise<void> }`. Files live at `<dir>/runs/<id>.json`; ids must match `^[A-Za-z0-9._-]{1,128}$`; writes go to a temp file in the same folder and are renamed into place; unreadable or invalid files are skipped. `waitingOnUserMs` is the union of all sessions' question and plan segments, so overlapping waits count once.

- [ ] **Step 1: Write the failing test**

`tests/history.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateRunSummary } from '../engine/schema.mjs';
import { createHistoryStore, listItemOf, summarizeRun } from '../engine/model/history.mjs';
import { tempDir } from './helpers/temp.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const COMPUTED = 1792072800000;

test('a run summary answers time and cost first, by unit, model and sub-agent type', () => {
  const snapshot = fixture('example-snapshot.json');
  const summary = summarizeRun(snapshot, { computedAt: COMPUTED });
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(summary.finishedAt, snapshot.run.lastActivityAt);
  assert.equal(summary.tookMs, snapshot.run.lastActivityAt - snapshot.run.startedAt);
  assert.equal(summary.credits, snapshot.cost.credits);
  assert.equal(summary.busyMs, [snapshot.orchestrator, ...snapshot.units].reduce((sum, session) => sum + session.busyMs, 0));
  assert.equal(summary.waitingOnUserMs, 2_220_000);
  assert.deepEqual(summary.children, { total: 7, merged: 2, closed: 0, failed: 0, noOutcome: 5 });
  assert.equal(summary.subagents, 7);
  assert.deepEqual(summary.units[0], {
    id: 'ws-0000-root', label: 'SB', name: 'Sample story B', isOrchestrator: true, startedAt: snapshot.run.startedAt,
    endedAt: snapshot.orchestrator.lastEventAt, busyMs: snapshot.orchestrator.busyMs, credits: 31532.4, outcome: null, merged: false,
  });
  assert.deepEqual(summary.units[1], {
    id: 'ws-0001-b0', label: 'B0', name: 'schema', isOrchestrator: false, startedAt: 1791814200000, endedAt: 1791964200000,
    busyMs: 18000000, credits: 10912, outcome: 'merged', merged: true,
  });
  assert.deepEqual(summary.subagentTypes.map(entry => entry.type), ['task', 'research', 'code-review', 'explore']);
  assert.deepEqual(summary.models, snapshot.cost.byModel);
  assert.deepEqual(listItemOf(summary), {
    id: summary.id, name: summary.name, project: summary.project, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
    tookMs: summary.tookMs, busyMs: summary.busyMs, credits: summary.credits, usd: summary.usd, children: 7, merged: 2, summarized: true,
  });
});

test('a run summary never carries report text, questions or activity', () => {
  const snapshot = fixture('example-snapshot.json');
  const secret = 'sentinel-free-text-4242';
  snapshot.units[3].report.body = secret;
  snapshot.units[3].report.summary = secret;
  snapshot.units[3].activity.label = secret;
  snapshot.units[4].reason = secret;
  snapshot.needs[0].text = secret;
  snapshot.feed[0].text = secret;
  snapshot.orchestrator.timeline.marks[0].text = secret;
  snapshot.units[2].subagents[0].task = secret;
  assert.equal(JSON.stringify(summarizeRun(snapshot, { computedAt: COMPUTED })).includes(secret), false);
});

test('the history store writes atomically, lists newest first and skips bad files', async () => {
  const dir = tempDir('swarm-history-');
  const store = createHistoryStore(dir);
  const older = fixture('example-run-summary.json');
  const newer = { ...older, id: 'ws-3000-root', name: 'Later run', finishedAt: older.finishedAt + 1000 };
  await store.put(older);
  await store.put(newer);
  assert.deepEqual(await store.get(older.id), older);
  assert.deepEqual((await store.list()).map(summary => summary.id), ['ws-3000-root', 'ws-1000-root']);
  assert.deepEqual(readdirSync(path.join(dir, 'runs')).sort(), ['ws-1000-root.json', 'ws-3000-root.json']);
  writeFileSync(path.join(dir, 'runs', 'broken.json'), '{ not json');
  writeFileSync(path.join(dir, 'runs', 'invalid.json'), JSON.stringify({ id: 'invalid' }));
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.get('../escape'), null);
  assert.equal(await store.get('missing'), null);
  await assert.rejects(store.put({ ...older, id: '../escape' }), /Invalid run id/);
  await assert.rejects(store.put({ ...older, credits: 'lots' }), /Invalid run summary/);
});

test('an empty history folder lists nothing', async () => {
  assert.deepEqual(await createHistoryStore(path.join(tempDir('swarm-history-'), 'none')).list(), []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/history.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/model/history.mjs'`.

- [ ] **Step 3: Write `engine/model/history.mjs`**

```js
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, validateRunSummary } from '../schema.mjs';

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const round1 = value => Math.round(value * 10) / 10;

function unionMs(spans) {
  let total = 0;
  let current = null;
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (!current || start > current[1]) {
      if (current) total += current[1] - current[0];
      current = [start, end];
    } else {
      current[1] = Math.max(current[1], end);
    }
  }
  return current ? total + current[1] - current[0] : total;
}

/** Summary of a run for the history view: names, ids, times, counts, costs and models only. */
export function summarizeRun(snapshot, { computedAt }) {
  const { run, orchestrator, units } = snapshot;
  const finishedAt = run.finishedAt ?? run.lastActivityAt;
  const sessions = [orchestrator, ...units];
  const waits = [];
  for (const session of sessions) {
    for (const segment of session.timeline.segments) {
      if (segment.state === 'question' || segment.state === 'plan') waits.push([segment.start, segment.end ?? finishedAt]);
    }
  }
  const types = new Map();
  for (const session of sessions) {
    for (const sub of session.subagents) {
      const entry = types.get(sub.type) ?? { type: sub.type, runs: 0, durationMs: 0, credits: 0 };
      entry.runs += 1;
      entry.durationMs += sub.durationMs ?? 0;
      entry.credits = round1(entry.credits + sub.credits);
      types.set(sub.type, entry);
    }
  }
  const count = predicate => units.filter(predicate).length;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: run.id,
    name: run.name,
    project: run.project ? { id: run.project.id, name: run.project.name } : null,
    startedAt: run.startedAt,
    firstChildAt: run.firstChildAt,
    finishedAt,
    tookMs: Math.max(0, finishedAt - run.startedAt),
    busyMs: sessions.reduce((sum, session) => sum + session.busyMs, 0),
    waitingOnUserMs: unionMs(waits),
    credits: snapshot.cost.credits,
    usd: snapshot.cost.usd,
    children: {
      total: units.length,
      merged: count(unit => unit.outcome === 'merged'),
      closed: count(unit => unit.outcome === 'closed'),
      failed: count(unit => unit.outcome === 'failed'),
      noOutcome: count(unit => unit.outcome === null),
    },
    subagents: sessions.reduce((sum, session) => sum + session.subagents.length, 0),
    units: [
      {
        id: orchestrator.id, label: orchestrator.label, name: orchestrator.name, isOrchestrator: true, startedAt: orchestrator.startedAt,
        endedAt: orchestrator.endedAt ?? orchestrator.lastEventAt, busyMs: orchestrator.busyMs, credits: orchestrator.cost.credits, outcome: null, merged: false,
      },
      ...units.map(unit => ({
        id: unit.id, label: unit.label, name: unit.name, isOrchestrator: false, startedAt: unit.startedAt, endedAt: unit.endedAt ?? unit.lastEventAt,
        busyMs: unit.busyMs, credits: unit.cost.credits, outcome: unit.outcome, merged: unit.outcome === 'merged',
      })),
    ],
    models: snapshot.cost.byModel.map(entry => ({ model: entry.model, credits: entry.credits, calls: entry.calls, apiMs: entry.apiMs })),
    subagentTypes: [...types.values()].sort((a, b) => b.credits - a.credits),
    computedAt,
  };
}

export function listItemOf(summary) {
  return {
    id: summary.id, name: summary.name, project: summary.project, startedAt: summary.startedAt, finishedAt: summary.finishedAt,
    tookMs: summary.tookMs, busyMs: summary.busyMs, credits: summary.credits, usd: summary.usd,
    children: summary.children.total, merged: summary.children.merged, summarized: true,
  };
}

/** The engine's only write target: <dir>/runs/<id>.json, written atomically. */
export function createHistoryStore(dir) {
  const runsDir = path.join(dir, 'runs');
  const fileOf = id => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`Invalid run id ${id}`);
    return path.join(runsDir, `${id}.json`);
  };
  async function get(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    try {
      const value = JSON.parse(await readFile(fileOf(id), 'utf8'));
      return validateRunSummary(value).length ? null : value;
    } catch {
      return null;
    }
  }
  return {
    dir: runsDir,
    get,
    async list() {
      let names;
      try {
        names = await readdir(runsDir);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const summaries = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const summary = await get(name.slice(0, -'.json'.length));
        if (summary) summaries.push(summary);
      }
      return summaries.sort((a, b) => b.finishedAt - a.finishedAt);
    },
    async put(summary) {
      const target = fileOf(summary?.id);
      const errors = validateRunSummary(summary);
      if (errors.length) throw new Error(`Invalid run summary: ${errors[0]}`);
      await mkdir(runsDir, { recursive: true });
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      await rename(temp, target);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): summarise finished runs into a history store"
```

### Task 15: The engine

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/engine/engine.mjs`
- Create: `ghcp/plugins/swarm-dashboard/tests/helpers/scenario.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/engine.test.mjs`

**Interfaces:**
- Consumes: every engine module (Tasks 3–14).
- Produces: `createSwarmEngine(options: EngineOptions & { processProbe?: (locks) => Promise<Map<pid, boolean>> }): SwarmEngine`, exactly the `SwarmEngine` typedef in `engine/schema.mjs` (`refresh`, `start`, `stop`, `listSwarms`, `getSnapshot`, `subscribe`, `listHistory`, `getRunSummary`, `diagnostics`). `processProbe` is a test seam.

Behaviour:
- Creating the engine reads nothing and starts no timers. `refresh()` is single-flight: concurrent calls share one run. `stop()` stops scheduling; a refresh already running still completes.
- Each refresh reads `data.db` and the new ledger rows, lists every swarm cheaply (event log mtimes, ledger, busy flags, liveness only for recent swarms), then fully tracks live swarms plus up to 3 swarms requested through `getSnapshot`/`getRunSummary`.
- Tracking tails each CLI session's `events.jsonl` by offset (rebuilding a session's state on reset), reads `session.db` for the orchestrator's CLI sessions and each unit's current one (cached by mtime and size), probes liveness (cached 15 s), and requests PR states through the lookup.
- A swarm whose content changed gets a new revision; subscribers receive one `{ revision, swarmIds }` per refresh that changed something. A listener that throws does not stop the others.
- A tracked swarm that becomes finished is summarised and written to the history store (unless `persistHistory` is false), once per finish time; it stays finished until its logs change again.
- Errors become diagnostics (`engine.diagnostics()` and the snapshot's `diagnostics`), never exceptions from `refresh()`, and nothing is written to stdout.

- [ ] **Step 1: Write the scenario helper and the failing test**

`tests/helpers/scenario.mjs` (shared with the CLI test in Task 16):

```js
import { HOUR, MINUTE } from '../../engine/time.mjs';
import { CopilotHome } from './copilot-home.mjs';
import { EventLog } from './event-log.mjs';

export const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
export const DAY = 24 * HOUR;
export const at = minutes => T0 + minutes * MINUTE;
export const alwaysAlive = async locks => new Map(locks.map(lock => [lock.pid, true]));

/** A live synthetic swarm (root with an open tagged question, two idle units) and a finished one from 30 days earlier. */
export function scenario() {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root', branch: 'main' });
  home.workspace({ id: 'ws-api', projectId: 'project-1', name: 'Sample a1 api', createdAt: at(5), sessionId: 'cli-api', parentId: 'ws-root', creatorSessionId: 'cli-root', branch: 'feature/api', baseBranch: 'main' });
  home.workspace({ id: 'ws-ui', projectId: 'project-1', name: 'Sample u1 ui', createdAt: at(6), sessionId: 'cli-ui', parentId: 'ws-root', creatorSessionId: 'cli-root', branch: 'feature/ui', baseBranch: 'feature/api' });
  home.workspace({ id: 'ws-old', name: 'Old swarm', createdAt: T0 - 30 * DAY, sessionId: 'cli-old' });
  home.workspace({ id: 'ws-old-child', name: 'Old child', createdAt: T0 - 30 * DAY + MINUTE, sessionId: 'cli-old-child', parentId: 'ws-old', creatorSessionId: 'cli-old' });

  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.wait(MINUTE); root.turnEnd();
  root.at(at(50)); root.turnStart(); root.ask('[unit=a1] Ship the API?');
  home.writeEvents('cli-root', root.events);
  const api = new EventLog(at(5));
  api.start(); api.turnStart(); api.at(at(20));
  api.report('ws-root', 'swarm-status: complete unit=a1\nSummary: API done.', 'handoff');
  api.turnEnd();
  home.writeEvents('cli-api', api.events);
  const ui = new EventLog(at(6));
  ui.start(); ui.turnStart(); ui.at(at(30)); ui.turnEnd();
  home.writeEvents('cli-ui', ui.events);
  const old = new EventLog(T0 - 30 * DAY);
  old.start(); old.turnStart(); old.wait(MINUTE); old.turnEnd();
  home.writeEvents('cli-old', old.events);

  home.usage([{ sessionId: 'cli-root', nanoAiu: 3e9, createdAt: at(1) }, { sessionId: 'cli-api', nanoAiu: 4e9, createdAt: at(20) }]);
  home.lock('cli-root', 101, T0);
  home.lock('cli-api', 102, at(5));
  home.lock('cli-ui', 103, at(6));
  home.sessionDb('cli-api', { todos: [{ id: 'a', status: 'done' }, { id: 'b' }] });
  home.workspaceYaml('cli-api', { cwd: '/synthetic/worktrees/api', branch: 'feature/api' });
  return home;
}
```

`tests/engine.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { alwaysAlive, at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

function fingerprint(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push([path.relative(dir, full), createHash('sha1').update(readFileSync(full)).digest('hex')]);
    }
  };
  walk(dir);
  return out;
}

test('the engine follows a swarm from live to history without writing Copilot data', async () => {
  const home = scenario();
  const before = fingerprint(home.root);
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, now: () => clock, processProbe: alwaysAlive, prLookup: 'off' });

  await engine.refresh();
  const swarms = engine.listSwarms();
  assert.deepEqual(swarms.map(swarm => [swarm.id, swarm.lifecycle, swarm.units]), [['ws-root', 'live', 2], ['ws-old', 'finished', 1]]);
  assert.deepEqual(swarms.flatMap(validateSwarmListItem), []);
  let snapshot = await engine.getSnapshot();
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.run.id, 'ws-root');
  assert.equal(snapshot.orchestrator.statusDetail, 'waiting_question');
  assert.deepEqual(snapshot.units.map(unit => [unit.label, unit.statusDetail]), [['a1', 'idle'], ['u1', 'idle']]);
  assert.deepEqual(snapshot.units[0].progress, { done: 1, total: 2 });
  assert.equal(snapshot.units[0].report.title, 'API done.');
  assert.equal(snapshot.cost.credits, 7);
  assert.deepEqual(snapshot.needs.map(need => need.labels), [['a1']]);
  const firstRevision = snapshot.revision;

  const changes = [];
  engine.subscribe(() => { throw new Error('a broken listener'); });
  engine.subscribe(change => changes.push(change));
  await engine.refresh();
  assert.deepEqual(changes, []);

  const asking = new EventLog(at(61));
  asking.turnStart();
  asking.ask('Which colour?');
  home.writeEvents('cli-ui', asking.events, { append: true });
  clock = at(62);
  await engine.refresh();
  assert.deepEqual(changes.map(change => change.swarmIds), [['ws-root']]);
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.units[1].statusDetail, 'waiting_question');
  assert.ok(snapshot.revision > firstRevision);

  const restart = new EventLog(at(6));
  restart.start();
  home.writeEvents('cli-ui', restart.events);
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.units[1].statusDetail, 'idle');
  assert.equal(snapshot.units[1].lastEventAt, at(6));

  const answered = new EventLog(at(63));
  answered.done('call-1', { result: 'Yes' });
  answered.turnEnd();
  home.writeEvents('cli-root', answered.events, { append: true });
  clock = at(63) + 2 * HOUR + MINUTE;
  await engine.refresh();
  snapshot = await engine.getSnapshot('ws-root');
  assert.equal(snapshot.run.lifecycle, 'finished');
  assert.equal(snapshot.run.finishedAt, at(63));
  assert.ok(existsSync(path.join(historyDir, 'runs', 'ws-root.json')));
  const history = await engine.listHistory();
  assert.deepEqual(history.map(item => [item.id, item.summarized]), [['ws-root', true], ['ws-old', false]]);
  assert.deepEqual(history.flatMap(validateRunListItem), []);
  assert.deepEqual(validateRunSummary(await engine.getRunSummary('ws-root')), []);
  await engine.refresh();
  assert.equal(engine.listSwarms()[0].lifecycle, 'finished');

  const after = new Map(fingerprint(home.root));
  assert.deepEqual([...after.keys()], before.map(([file]) => file));
  for (const [file, hash] of before) if (!file.endsWith('events.jsonl')) assert.equal(after.get(file), hash, file);
});

test('with persistHistory false the engine writes nothing', async () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-engine-'), 'history');
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir, persistHistory: false, now: () => at(60) + 3 * HOUR, processProbe: alwaysAlive, prLookup: 'off' });
  const summary = await engine.getRunSummary('ws-old');
  assert.deepEqual(validateRunSummary(summary), []);
  assert.equal(existsSync(historyDir), false);
});

test('start polls until stop, and creating an engine starts nothing', async () => {
  const home = scenario();
  let clock = at(60);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-engine-'), 'h'), now: () => (clock += 1000), processProbe: alwaysAlive, prLookup: 'off' });
  let seen = 0;
  engine.subscribe(() => { seen += 1; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(seen, 0);
  engine.start({ intervalMs: 20 });
  const deadline = Date.now() + 10_000;
  while (seen < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  engine.stop();
  assert.ok(seen >= 2, `expected repeated refreshes, saw ${seen}`);
  await engine.refresh();
  const after = seen;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(seen, after);
});

test('missing Copilot data degrades to diagnostics', async () => {
  const engine = createSwarmEngine({ copilotHome: tempDir('swarm-empty-'), historyDir: path.join(tempDir('swarm-engine-'), 'h'), prLookup: 'off' });
  await engine.refresh();
  assert.deepEqual(engine.listSwarms(), []);
  assert.equal(await engine.getSnapshot(), null);
  assert.ok(engine.diagnostics().some(item => item.source === 'data.db' && item.level === 'warn'));
});
```

The last lines of the first test check that the engine changed no file in the synthetic home: only the `events.jsonl` files the test itself rewrote differ from `before`, and no file (such as `-wal` or `-shm`) was added.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/engine.test.mjs`
Expected: FAIL with `Cannot find module '.../engine/engine.mjs'`.

- [ ] **Step 3: Write `engine/engine.mjs`**

```js
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { copilotPaths, resolveThresholds } from './config.mjs';
import { CREDIT_USD, NANO_AIU_PER_CREDIT } from './schema.mjs';
import { SqliteUnavailableError, loadNodeSqlite, withReadOnly } from './sqlite.mjs';
import { readAppDb } from './readers/app-db.mjs';
import { createTail, readNewLines } from './readers/events.mjs';
import { createLedger, pullLedger } from './readers/ledger.mjs';
import { createProcessProbe } from './readers/process-probe.mjs';
import { createSessionDbCache, listLocks, readWorkspaceYaml } from './readers/session-files.mjs';
import { buildForest, treeNodes } from './model/forest.mjs';
import { createHistoryStore, listItemOf, summarizeRun } from './model/history.mjs';
import { createPrLookup } from './model/pr-lookup.mjs';
import { applyLine, createSessionState } from './model/session-state.mjs';
import { buildSnapshot } from './model/swarm.mjs';

const LIVENESS_TTL_MS = 15_000;
const EXTRA_TRACKED = 3;
const round1 = value => Math.round(value * 10) / 10;
const shortId = id => String(id).slice(0, 8);

function emptyApp() {
  return { projects: new Map(), worktrees: new Map(), workspaces: new Map(), parentLinks: [], aliases: [], chatLinks: [], sessions: new Map(), automations: [], diagnostics: [] };
}

function sqliteProblem(source, error) {
  return {
    level: 'warn',
    source,
    message: error instanceof SqliteUnavailableError
      ? 'No SQLite reader: use Node.js 22.13 or later, or install the sqlite3 command-line tool.'
      : error.message,
  };
}

function digest(snapshot) {
  return createHash('sha1').update(JSON.stringify({ ...snapshot, generatedAt: 0, revision: 0 })).digest('hex');
}

async function mtimeOf(file) {
  try {
    return Math.round((await stat(file)).mtimeMs);
  } catch {
    return null;
  }
}

const byLifecycleThenActivity = (a, b) => (a.lifecycle === b.lifecycle ? b.lastActivityAt - a.lastActivityAt : a.lifecycle === 'live' ? -1 : 1);

/**
 * The swarm data engine. Strictly read-only towards Copilot data; its only write target is the history folder.
 * @param {import('./schema.mjs').EngineOptions & { processProbe?: (locks: {pid: number, mtimeMs: number}[]) => Promise<Map<number, boolean>> }} options
 * @returns {import('./schema.mjs').SwarmEngine}
 */
export function createSwarmEngine(options = {}) {
  const paths = copilotPaths(options.copilotHome);
  const persist = options.persistHistory ?? true;
  const now = options.now ?? Date.now;
  const thresholds = resolveThresholds(options.thresholds);
  const sqlite = { backend: options.sqlite ?? 'auto' };
  const log = typeof options.log === 'function' ? options.log : () => {};
  const probe = options.processProbe ?? createProcessProbe();
  const lookup = options.prLookup === 'off' ? null
    : options.prLookup && typeof options.prLookup === 'object' ? options.prLookup : createPrLookup({ now });
  const history = createHistoryStore(options.historyDir ?? paths.historyDir);
  const ledger = createLedger();
  const readDb = createSessionDbCache();
  const sessions = new Map();
  const liveness = new Map();
  const snapshots = new Map();
  const cheapLast = new Map();
  const knownFinished = new Map();
  const requested = [];
  const listeners = new Set();
  let app = null;
  let forest = null;
  let swarms = [];
  let diagnostics = [];
  let revision = 0;
  let timer = null;
  let running = null;

  const projectOf = node => {
    const project = node.projectId ? app.projects.get(node.projectId) : null;
    return project ? { id: project.id, name: project.name } : null;
  };

  function notify(change) {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        log({ level: 'warn', source: 'subscriber', message: error.message });
      }
    }
  }

  async function livenessOf(cliId, at) {
    const cached = liveness.get(cliId);
    if (cached && at - cached.checkedAt < LIVENESS_TTL_MS) return cached.value;
    const locks = listLocks(path.join(paths.stateDir, cliId));
    let value = null;
    if (locks && !locks.length) value = false;
    if (locks && locks.length) {
      try {
        value = [...(await probe(locks)).values()].some(Boolean);
      } catch {
        value = null;
      }
    }
    liveness.set(cliId, { value, checkedAt: at });
    return value;
  }

  async function listRoots(at) {
    const items = [];
    for (const root of forest.roots) {
      const nodes = treeNodes(forest, root.id);
      const cliIds = [...new Set(nodes.flatMap(node => node.cliSessionIds))];
      let last = root.createdAt ?? 0;
      for (const cliId of cliIds) last = Math.max(last, (await mtimeOf(path.join(paths.stateDir, cliId, 'events.jsonl'))) ?? 0);
      const totals = ledger.sumFor(cliIds);
      last = Math.max(last, totals.lastAt ?? 0);
      cheapLast.set(root.id, last);
      const runningFlag = cliIds.some(id => app.sessions.get(id)?.isRunning);
      const recent = at - last < thresholds.runFinishedAfterMs;
      let alive = false;
      if (recent || runningFlag) {
        for (const cliId of cliIds) {
          if ((await livenessOf(cliId, at)) === true) {
            alive = true;
            break;
          }
        }
      }
      const tracked = snapshots.get(root.id)?.snapshot ?? null;
      const lifecycle = tracked ? tracked.run.lifecycle
        : knownFinished.get(root.id) === last ? 'finished'
          : recent || (runningFlag && alive) ? 'live' : 'finished';
      const lastActivityAt = tracked?.run.lastActivityAt ?? (last || at);
      items.push({
        id: root.id, name: root.name ?? '', project: projectOf(root), startedAt: root.createdAt || lastActivityAt, lastActivityAt,
        lifecycle, units: nodes.length - 1, credits: round1(totals.nanoAiu / NANO_AIU_PER_CREDIT), alive,
      });
    }
    return items.sort(byLifecycleThenActivity);
  }

  async function tailSession(cliId, diag) {
    let entry = sessions.get(cliId);
    if (!entry) {
      entry = { tail: createTail(path.join(paths.stateDir, cliId, 'events.jsonl')), state: createSessionState(cliId), missing: true };
      sessions.set(cliId, entry);
    }
    try {
      const result = await readNewLines(entry.tail, line => applyLine(entry.state, line), {
        onReset: () => {
          entry.state = createSessionState(cliId);
        },
      });
      entry.missing = result.missing;
    } catch (error) {
      diag.push({ level: 'warn', source: 'events', message: `${shortId(cliId)}: ${error.message}` });
    }
    return entry.missing ? null : entry.state;
  }

  async function buildTracked(rootId, at, diag) {
    const nodes = treeNodes(forest, rootId);
    const states = new Map();
    const alive = new Map();
    const workspaceFiles = new Map();
    for (const cliId of new Set(nodes.flatMap(node => node.cliSessionIds))) {
      const state = await tailSession(cliId, diag);
      if (state) states.set(cliId, state);
      alive.set(cliId, await livenessOf(cliId, at));
      workspaceFiles.set(cliId, readWorkspaceYaml(path.join(paths.stateDir, cliId)));
    }
    const sessionDbs = new Map();
    for (const cliId of new Set([...nodes[0].cliSessionIds, ...nodes.map(node => node.currentCliSessionId).filter(Boolean)])) {
      try {
        sessionDbs.set(cliId, await readDb(path.join(paths.stateDir, cliId, 'session.db'), sqlite));
      } catch (error) {
        diag.push({ level: 'warn', source: 'session.db', message: `${shortId(cliId)}: ${error.message}` });
      }
    }
    return buildSnapshot({
      forest, rootId, app, states, alive, workspaceFiles, ledger, sessionDbs, now: at, thresholds, revision: 0, diagnostics: [...diag],
      prInfo: (pr, { cwd }) => {
        if (!lookup) return null;
        lookup.request(pr, { cwd });
        return lookup.get(pr);
      },
    });
  }

  async function persistFinished(snapshot, diag) {
    if (!persist) return;
    try {
      const stored = await history.get(snapshot.run.id);
      if (stored && stored.finishedAt === snapshot.run.finishedAt && stored.children.total === snapshot.units.length) return;
      await history.put(summarizeRun(snapshot, { computedAt: now() }));
    } catch (error) {
      diag.push({ level: 'warn', source: 'history', message: error.message });
    }
  }

  async function doRefresh() {
    const at = now();
    const diag = [];
    if (sqlite.backend === 'auto') {
      diag.push({ level: 'info', source: 'sqlite', message: (await loadNodeSqlite()) ? 'Reading SQLite through node:sqlite.' : 'Reading SQLite through the sqlite3 command-line tool.' });
    }
    try {
      const data = await withReadOnly(paths.dataDb, sqlite, readAppDb);
      if (data) {
        app = data;
        diag.push(...data.diagnostics);
      } else {
        app = emptyApp();
        diag.push({ level: 'warn', source: 'data.db', message: 'The Copilot app database was not found.' });
      }
    } catch (error) {
      app = app ?? emptyApp();
      diag.push(sqliteProblem('data.db', error));
    }
    forest = buildForest(app);
    try {
      const pulled = await withReadOnly(paths.storeDb, sqlite, db => pullLedger(db, ledger));
      if (pulled === null) diag.push({ level: 'warn', source: 'session-store.db', message: 'The Copilot session store was not found, so costs are unknown.' });
    } catch (error) {
      diag.push(sqliteProblem('session-store.db', error));
    }
    for (const failure of lookup?.errors() ?? []) diag.push({ level: 'info', source: 'pr-lookup', message: `${failure.key}: ${failure.error}` });

    swarms = await listRoots(at);
    const rootIds = new Set(forest.roots.map(root => root.id));
    const tracked = new Set([...swarms.filter(swarm => swarm.lifecycle === 'live').map(swarm => swarm.id), ...requested.filter(id => rootIds.has(id))]);
    const changed = [];
    for (const rootId of tracked) {
      const snapshot = await buildTracked(rootId, at, diag);
      const hash = digest(snapshot);
      const entry = snapshots.get(rootId);
      if (entry && entry.hash === hash) {
        snapshot.revision = entry.revision;
        entry.snapshot = snapshot;
      } else {
        snapshot.revision = (entry?.revision ?? 0) + 1;
        snapshots.set(rootId, { snapshot, hash, revision: snapshot.revision });
        changed.push(rootId);
      }
      if (snapshot.run.lifecycle === 'finished') {
        knownFinished.set(rootId, cheapLast.get(rootId));
        await persistFinished(snapshot, diag);
      } else {
        knownFinished.delete(rootId);
      }
    }
    const keep = new Set();
    for (const rootId of tracked) for (const node of treeNodes(forest, rootId)) for (const cliId of node.cliSessionIds) keep.add(cliId);
    for (const cliId of [...sessions.keys()]) if (!keep.has(cliId)) sessions.delete(cliId);
    for (const rootId of [...snapshots.keys()]) if (!tracked.has(rootId)) snapshots.delete(rootId);
    swarms = swarms.map(item => {
      const entry = snapshots.get(item.id);
      return entry ? { ...item, lifecycle: entry.snapshot.run.lifecycle, lastActivityAt: entry.snapshot.run.lastActivityAt } : item;
    }).sort(byLifecycleThenActivity);

    const previous = new Set(diagnostics.map(item => `${item.source}|${item.message}`));
    for (const item of diag) if (item.level === 'warn' && !previous.has(`${item.source}|${item.message}`)) log(item);
    diagnostics = diag;
    if (changed.length) {
      revision += 1;
      notify({ revision, swarmIds: changed });
    }
  }

  function refresh() {
    if (!running) running = doRefresh().finally(() => { running = null; });
    return running;
  }

  function track(id) {
    const index = requested.indexOf(id);
    if (index >= 0) requested.splice(index, 1);
    requested.unshift(id);
    if (requested.length > EXTRA_TRACKED) requested.length = EXTRA_TRACKED;
  }

  async function getSnapshot(swarmId) {
    if (!forest) await refresh();
    const id = swarmId ?? swarms[0]?.id ?? null;
    if (!id || !forest.roots.some(root => root.id === id)) return null;
    if (!snapshots.has(id)) {
      track(id);
      await refresh();
      if (!snapshots.has(id)) await refresh();
    }
    return snapshots.get(id)?.snapshot ?? null;
  }

  async function listHistory() {
    if (!forest) await refresh();
    const items = new Map();
    for (const summary of await history.list()) items.set(summary.id, listItemOf(summary));
    for (const { snapshot } of snapshots.values()) {
      if (snapshot.run.lifecycle === 'finished' && !items.has(snapshot.run.id)) {
        items.set(snapshot.run.id, listItemOf(summarizeRun(snapshot, { computedAt: now() })));
      }
    }
    for (const swarm of swarms) {
      if (swarm.lifecycle !== 'finished' || items.has(swarm.id)) continue;
      items.set(swarm.id, {
        id: swarm.id, name: swarm.name, project: swarm.project, startedAt: swarm.startedAt, finishedAt: swarm.lastActivityAt,
        tookMs: Math.max(0, swarm.lastActivityAt - swarm.startedAt), busyMs: null, credits: swarm.credits,
        usd: Math.round(swarm.credits * CREDIT_USD * 100) / 100, children: swarm.units, merged: null, summarized: false,
      });
    }
    return [...items.values()].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  }

  async function getRunSummary(runId) {
    const stored = await history.get(runId);
    if (stored) return stored;
    const snapshot = await getSnapshot(runId);
    if (!snapshot) return null;
    const summary = summarizeRun(snapshot, { computedAt: now() });
    if (persist && snapshot.run.lifecycle === 'finished') {
      try {
        await history.put(summary);
      } catch (error) {
        log({ level: 'warn', source: 'history', message: error.message });
      }
    }
    return summary;
  }

  return {
    refresh,
    start({ intervalMs = 3000 } = {}) {
      if (timer) return;
      const tick = async () => {
        try {
          await refresh();
        } catch (error) {
          log({ level: 'warn', source: 'engine', message: error.message });
        }
        if (timer) timer = setTimeout(tick, intervalMs);
      };
      timer = setTimeout(tick, 0);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    listSwarms: () => swarms.map(item => ({ ...item })),
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    listHistory,
    getRunSummary,
    diagnostics: () => diagnostics.map(item => ({ ...item })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass, including the read-only fingerprint check.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): add the polling swarm engine"
```

### Task 16: Snapshot command, guard tests and validator update

**Files:**
- Create: `ghcp/plugins/swarm-dashboard/scripts/swarm-snapshot.mjs`
- Modify: `ghcp/plugins/swarm-dashboard/package.json` (add the `snapshot` script)
- Modify: `ghcp/plugins/swarm-dashboard/scripts/validate-plugin.mjs` (required files, `snapshot` script)
- Test: `ghcp/plugins/swarm-dashboard/tests/snapshot-cli.test.mjs`
- Test: `ghcp/plugins/swarm-dashboard/tests/guards.test.mjs`

**Interfaces:**
- Consumes: `createSwarmEngine` (Task 15), `createPrLookup` (Task 12), `parseTime` (Task 3), `scenario` helpers (Task 15).
- Produces: `parseArguments(argv): object` (throws on bad input); `main(argv, {stdout, stderr}): Promise<exitCode>`; the command `npm run snapshot -- [--list | --swarm <id> | --history | --run <id>] [--copilot-home <dir>] [--history-dir <dir>] [--persist-history] [--now <time>] [--no-pr-lookup] [--sqlite auto|node|cli] [--compact]`. Exit codes: 0 success, 1 nothing found (prints `null`), 2 usage error. Only JSON goes to stdout; warnings go to stderr. It writes nothing unless `--persist-history` is given. `--list` and `--history` never start PR lookups; snapshot and run modes wait for lookups once, then refresh.

- [ ] **Step 1: Write the failing tests**

`tests/snapshot-cli.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';
import { parseArguments } from '../scripts/swarm-snapshot.mjs';
import { at, scenario } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

const script = fileURLToPath(new URL('../scripts/swarm-snapshot.mjs', import.meta.url));
const run = args => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the command prints valid JSON for swarms, snapshots, history and run summaries, and writes nothing', () => {
  const home = scenario();
  const historyDir = path.join(tempDir('swarm-cli-'), 'history');
  const base = ['--copilot-home', home.root, '--history-dir', historyDir, '--now', new Date(at(60)).toISOString(), '--no-pr-lookup'];
  const swarms = JSON.parse(run([...base, '--list']));
  assert.deepEqual(swarms.map(swarm => swarm.id), ['ws-root', 'ws-old']);
  assert.deepEqual(swarms.flatMap(validateSwarmListItem), []);
  const snapshot = JSON.parse(run(base));
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(snapshot.run.id, 'ws-root');
  const compact = run([...base, '--swarm', 'ws-old', '--compact']);
  assert.equal(compact.trim().split('\n').length, 1);
  assert.equal(JSON.parse(compact).run.id, 'ws-old');
  assert.deepEqual(JSON.parse(run([...base, '--history'])).map(item => item.id), ['ws-old']);
  assert.deepEqual(validateRunSummary(JSON.parse(run([...base, '--run', 'ws-old']))), []);
  assert.equal(existsSync(historyDir), false);
});

test('bad options exit 2 and unknown swarms exit 1 with null', () => {
  const bad = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown option --nope/);
  assert.equal(bad.stdout, '');
  const home = scenario();
  const missing = spawnSync(process.execPath, [script, '--copilot-home', home.root, '--swarm', 'nope', '--no-pr-lookup', '--now', String(at(60))], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout.trim(), 'null');
  assert.match(missing.stderr, /No swarm nope/);
});

test('argument parsing rejects conflicting or malformed options', () => {
  assert.throws(() => parseArguments(['--list', '--history']), /only one of/);
  assert.throws(() => parseArguments(['--swarm']), /needs a value/);
  assert.throws(() => parseArguments(['--sqlite', 'mysql']), /auto, node or cli/);
  assert.throws(() => parseArguments(['--now', 'yesterday']), /ISO time or epoch/);
  assert.deepEqual(parseArguments(['--swarm', 'ws-1', '--compact']), { swarm: 'ws-1', compact: true });
});
```

`tests/guards.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.mjs') ? [full] : [];
  });
}
const engineFiles = sources(path.join(root, 'engine'));
const shipped = [...engineFiles, ...sources(path.join(root, 'scripts'))];
const name = file => path.relative(root, file);

test('the engine never writes to stdout', () => {
  for (const file of engineFiles) assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.(log|info|debug|dir|table)\(|process\.stdout/, name(file));
});

test('only the history store writes files', () => {
  const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|utimes|utimesSync)\s*\(/;
  for (const file of engineFiles) {
    if (file.endsWith(path.join('model', 'history.mjs'))) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), writes, name(file));
  }
});

test('SQL selects named columns and never touches secrets', () => {
  for (const file of engineFiles) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/\bSELECT\b|\bFROM\b/.test(line)) continue;
      assert.doesNotMatch(line, /SELECT\s+\*|settings|token/i, `${name(file)}: ${line.trim()}`);
    }
  }
});

test('shipped code imports only Node built-ins and its own modules', () => {
  for (const file of shipped) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
      const specifier = match[1] ?? match[2];
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${name(file)} imports ${specifier}`);
    }
  }
});

test('shipped code avoids APIs newer than Node 18', () => {
  const newer = /\.toSorted\(|\.toReversed\(|\.toSpliced\(|Object\.groupBy|Map\.groupBy|Promise\.withResolvers|Array\.fromAsync|\.isSubsetOf\(|\.union\(|\.intersection\(/;
  for (const file of shipped) assert.doesNotMatch(readFileSync(file, 'utf8'), newer, name(file));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ghcp/plugins/swarm-dashboard && node --test tests/snapshot-cli.test.mjs tests/guards.test.mjs`
Expected: the CLI test fails with `Cannot find module '.../scripts/swarm-snapshot.mjs'`; the guard tests pass already (they check Tasks 2–15).

- [ ] **Step 3: Write `scripts/swarm-snapshot.mjs`**

```js
#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { parseTime } from '../engine/time.mjs';

const USAGE = `Usage: swarm-snapshot [--list | --swarm <id> | --history | --run <id>] [options]

Prints the swarm dashboard's data as JSON. Reads Copilot data read-only.

  --list                 Known swarms, live first
  --swarm <id>           One swarm's snapshot (default: the most recently active live swarm)
  --history              Finished runs
  --run <id>             One run's summary
  --copilot-home <dir>   Copilot data folder (default ~/.copilot)
  --history-dir <dir>    Run summary folder (default <copilot-home>/swarm-dashboard/history)
  --persist-history      Write summaries of finished runs (off by default)
  --now <time>           Evaluate at an ISO time or epoch milliseconds
  --no-pr-lookup         Skip the read-only gh and az PR lookups
  --sqlite <backend>     auto, node or cli (default auto)
  --compact              One-line JSON
  --help                 Show this text`;

const VALUE_OPTIONS = new Set(['--swarm', '--run', '--copilot-home', '--history-dir', '--now', '--sqlite']);
const FLAG_OPTIONS = new Set(['--list', '--history', '--persist-history', '--no-pr-lookup', '--compact', '--help']);

class UsageError extends Error {}

const timeOption = value => parseTime(/^\d+$/.test(value) ? Number(value) : value);

export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAG_OPTIONS.has(arg)) {
      options[arg.slice(2)] = true;
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`Option ${arg} needs a value`);
      options[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new UsageError(`Unknown option ${arg}`);
    }
  }
  if (['list', 'swarm', 'history', 'run'].filter(key => options[key] !== undefined).length > 1) {
    throw new UsageError('Use only one of --list, --swarm, --history and --run');
  }
  if (options.sqlite !== undefined && !['auto', 'node', 'cli'].includes(options.sqlite)) throw new UsageError('--sqlite must be auto, node or cli');
  if (options.now !== undefined && timeOption(options.now) === null) throw new UsageError('--now must be an ISO time or epoch milliseconds');
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const fixed = options.now === undefined ? null : timeOption(options.now);
  const now = fixed === null ? Date.now : () => fixed;
  const lookup = options['no-pr-lookup'] || options.list || options.history ? null : createPrLookup({ now });
  const engine = createSwarmEngine({
    copilotHome: options['copilot-home'], historyDir: options['history-dir'], persistHistory: Boolean(options['persist-history']),
    now, prLookup: lookup ?? 'off', sqlite: options.sqlite ?? 'auto',
  });
  let result;
  if (options.list) {
    await engine.refresh();
    result = engine.listSwarms();
  } else if (options.history) {
    result = await engine.listHistory();
  } else if (options.run !== undefined) {
    if (lookup) {
      await engine.getSnapshot(options.run);
      await lookup.settle();
      await engine.refresh();
    }
    result = await engine.getRunSummary(options.run);
  } else {
    result = await engine.getSnapshot(options.swarm);
    if (result && lookup) {
      await lookup.settle();
      await engine.refresh();
      result = await engine.getSnapshot(result.run.id);
    }
  }
  for (const item of engine.diagnostics()) if (item.level === 'warn') stderr.write(`warning: ${item.source}: ${item.message}\n`);
  stdout.write(`${JSON.stringify(result ?? null, null, options.compact ? 0 : 2)}\n`);
  if (result === null || result === undefined) {
    stderr.write(options.run !== undefined ? `No run ${options.run}\n` : options.swarm !== undefined ? `No swarm ${options.swarm}\n` : 'No swarm found\n');
    return 1;
  }
  return 0;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
```

- [ ] **Step 4: Register the command and require the shipped files**

`package.json` `scripts` becomes:

```json
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate": "node scripts/validate-plugin.mjs",
    "snapshot": "node scripts/swarm-snapshot.mjs"
  }
```

In `scripts/validate-plugin.mjs`, replace `REQUIRED_FILES` and add the `snapshot` script check after the existing `scripts` check:

```js
export const REQUIRED_FILES = [
  'LICENSE', 'plugin.json', 'package.json', 'scripts/validate-plugin.mjs', 'scripts/swarm-snapshot.mjs',
  'engine/schema.mjs', 'engine/fake-engine.mjs', 'engine/engine.mjs', 'engine/config.mjs', 'engine/sqlite.mjs', 'engine/time.mjs', 'engine/text.mjs',
  'engine/readers/app-db.mjs', 'engine/readers/events.mjs', 'engine/readers/ledger.mjs', 'engine/readers/process-probe.mjs', 'engine/readers/session-files.mjs',
  'engine/model/contract.mjs', 'engine/model/forest.mjs', 'engine/model/history.mjs', 'engine/model/messages.mjs', 'engine/model/pr-lookup.mjs',
  'engine/model/session-state.mjs', 'engine/model/stage.mjs', 'engine/model/state-utils.mjs', 'engine/model/status.mjs', 'engine/model/swarm.mjs',
  'tests/fixtures/example-snapshot.json', 'tests/fixtures/example-swarms.json', 'tests/fixtures/example-history.json', 'tests/fixtures/example-run-summary.json',
];
```

```js
  if (pkg.scripts?.snapshot !== 'node scripts/swarm-snapshot.mjs') errors.push('package.json must expose the snapshot command');
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/swarm-dashboard && npm test && npm run validate`
Expected: all tests pass; validation passes with the longer required-file list.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/swarm-dashboard
git commit -m "feat(swarm-dashboard): add the snapshot command and guard tests"
```

### Task 17: Verification, real-data check and handoff

**Files:**
- No repository changes. Everything this task produces stays in a scratch folder outside the repository and is deleted at the end.

**Interfaces:**
- Consumes: the finished plugin (Tasks 1–16).
- Produces: the evidence the coordinator asked for: commands, outcomes, repository, branch and pushed commit SHA.

The real-data check reads the owner's live Copilot data on this machine, read-only. Nothing from it is committed or copied into the repository: not outputs, names, ids, numbers or paths. Report only aggregates to the coordinator.

- [ ] **Step 1: Run every plugin's checks on the default Node**

```bash
for plugin in swarm-dashboard pr-review-graph adr-authoring; do
  (cd ghcp/plugins/$plugin && node --version && npm test && npm run validate) || exit 1
done
```

Expected: all three pass; `swarm-dashboard` runs its reader tests against both the `node` and `cli` SQLite backends.

- [ ] **Step 2: Run the suite on Node 18 (sqlite3 CLI backend)**

```bash
cd ghcp/plugins/swarm-dashboard
NODE18=$(command -v /usr/local/bin/node || true)
"$NODE18" --version
"$NODE18" --test tests/*.test.mjs
"$NODE18" scripts/validate-plugin.mjs
```

Expected: `v18.x`, every test passes (live-writer tests report as skipped because `node:sqlite` is absent), validation passes. If no Node 18 binary exists, record that in the report instead of installing one.

- [ ] **Step 3: Make a scratch folder outside the repository**

```bash
SCRATCH="$HOME/swarm-engine-check-$(date +%s)"
mkdir -p "$SCRATCH"
ls -1 "$HOME/.copilot" | sort > "$SCRATCH/copilot-before.txt"
```

- [ ] **Step 4: List the real swarms (read-only, no PR lookups)**

```bash
cd ghcp/plugins/swarm-dashboard
/usr/bin/time -l node scripts/swarm-snapshot.mjs --list > "$SCRATCH/list.json" 2> "$SCRATCH/list.err"
node -e "const l=require(process.argv[1]); console.log(JSON.stringify({swarms:l.length, live:l.filter(s=>s.lifecycle==='live').length}))" "$SCRATCH/list.json"
tail -n 20 "$SCRATCH/list.err"
```

Expected: exit 0, valid JSON, the swarm count, wall time and peak memory from `/usr/bin/time`.

- [ ] **Step 5: Snapshot the reference run, with read-only PR lookups**

Pick the reference run named in the coordinator's kickoff: the swarm whose root was created on 12 October 2026. It had 16 units when the design was written and may have more now; take the largest swarm started that day.

```bash
ROOT=$(node -e "const l=require(process.argv[1]); const r=l.filter(s=>new Date(s.startedAt).toISOString().startsWith('2026-10-12') && s.units>=16).sort((a,b)=>b.units-a.units)[0]; console.log(r ? r.id : '')" "$SCRATCH/list.json")
test -n "$ROOT"
/usr/bin/time -l node scripts/swarm-snapshot.mjs --swarm "$ROOT" > "$SCRATCH/snapshot.json" 2> "$SCRATCH/snapshot.err"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateSnapshot } from './engine/schema.mjs';
const s = JSON.parse(readFileSync(process.argv[1], 'utf8'));
const tally = pick => s.units.reduce((m, u) => { const k = pick(u); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(JSON.stringify({
  errors: validateSnapshot(s).slice(0, 10), lifecycle: s.run.lifecycle, contract: s.run.contract, units: s.units.length,
  subagents: [s.orchestrator, ...s.units].reduce((n, u) => n + u.subagents.length, 0), credits: s.cost.credits, usd: s.cost.usd,
  counts: s.counts, details: tally(u => u.statusDetail), stages: tally(u => u.stage), monitors: tally(u => u.monitor.state),
  prs: tally(u => u.pr ? u.pr.source + ':' + u.pr.state : 'none'), needs: s.needs.length, planned: s.planned.length,
  feed: s.feed.length, bytes: JSON.stringify(s).length, diagnostics: s.diagnostics.map(d => d.level + ' ' + d.source),
}, null, 2));
" "$SCRATCH/snapshot.json"
tail -n 20 "$SCRATCH/snapshot.err"
```

Expected, compared with the design's section 1 figures for the reference run: no validation errors; at least 16 units; credits of at least 102,510 (the run continued after that figure); about 124 sub-agents plus any started since; archived units shown as archived; no PR lookup diagnostics with `ENOENT` (lookups must not depend on deleted worktrees); time and memory within a few seconds and a few hundred MB for the cold read. Investigate anything that disagrees before reporting; fix engine defects through a new task (test first), not in this step.

- [ ] **Step 6: History and run summary of the reference run**

```bash
node scripts/swarm-snapshot.mjs --history --compact > "$SCRATCH/history.json"
node scripts/swarm-snapshot.mjs --run "$ROOT" > "$SCRATCH/run.json"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateRunSummary } from './engine/schema.mjs';
const r = JSON.parse(readFileSync(process.argv[1], 'utf8'));
console.log(JSON.stringify({ errors: validateRunSummary(r), tookHours: +(r.tookMs / 3.6e6).toFixed(1), busyHours: +(r.busyMs / 3.6e6).toFixed(1), waitingHours: +(r.waitingOnUserMs / 3.6e6).toFixed(1), credits: r.credits, children: r.children, subagents: r.subagents }));
" "$SCRATCH/run.json"
```

Expected: a valid summary; "took" near the design's 72 hours at the time of that figure (or longer if the run continued).

- [ ] **Step 7: Measure memory on the reference run**

The engine runs for hours inside the extension process, so its memory must stay bounded. Measure the first read, then three minutes of incremental refreshes at the default 3-second interval:

```bash
cat > "$SCRATCH/memory.mjs" <<'EOF'
const { createSwarmEngine } = await import(process.env.SWARM_ENGINE_URL);
const mb = bytes => Math.round(bytes / 1048576);
const usage = () => {
  const m = process.memoryUsage();
  return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal) };
};
const engine = createSwarmEngine({ persistHistory: false, prLookup: 'off' });
let started = Date.now();
await engine.refresh();
await engine.getSnapshot(process.env.SWARM_ROOT);
const first = { ms: Date.now() - started, peakRss: mb(process.resourceUsage().maxRSS * 1024), ...usage() };
global.gc();
const firstAfterGc = usage();
const refreshes = [];
for (const end = Date.now() + 180_000; Date.now() < end;) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  started = Date.now();
  await engine.refresh();
  await engine.getSnapshot(process.env.SWARM_ROOT);
  refreshes.push({ ms: Date.now() - started, ...usage() });
}
global.gc();
const times = refreshes.map(item => item.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  first, firstAfterGc, refreshes: refreshes.length, refreshMs: { median: times[times.length >> 1], max: times[times.length - 1] },
  maxRssDuringRefreshes: Math.max(...refreshes.map(item => item.rss)), lastRefresh: refreshes[refreshes.length - 1], afterGc: usage(),
}, null, 2));
process.exit(0);
EOF
SWARM_ENGINE_URL="file://$PWD/engine/engine.mjs" SWARM_ROOT="$ROOT" node --expose-gc "$SCRATCH/memory.mjs"
```

Expected: the heap kept after GC (`firstAfterGc.heapUsed`, `afterGc.heapUsed`) is tens of MB and does not grow between the first read and the end; RSS during refreshes stays below the first-read peak; incremental refreshes take well under a second. Report the first-read peak RSS, steady-state RSS (`maxRssDuringRefreshes` and `lastRefresh.rss`), the heap kept after GC, and refresh times. If the kept heap grows, find what retains it with a heap snapshot and fix it through a new task, test first.

- [ ] **Step 8: Confirm the check wrote nothing**

```bash
ls -1 "$HOME/.copilot" | sort > "$SCRATCH/copilot-after.txt"
diff "$SCRATCH/copilot-before.txt" "$SCRATCH/copilot-after.txt" && echo "no new entries in ~/.copilot"
test ! -e "$HOME/.copilot/swarm-dashboard" && echo "no history folder created"
git status --short
```

Expected: no new entries (the app's own `-wal`/`-shm` files may come and go with its writers; any difference must be explained before reporting), no history folder, and a clean working tree.

- [ ] **Step 9: Smoke-test the engine inside the extension runtime**

The Copilot CLI binary runs extensions as `copilot extension_bootstrap.mjs`; the bootstrap imports `EXTENSION_PATH` when `COPILOT_EXTENSION_PARENT_PID` is the parent's PID. This starts no session.

```bash
cat > "$SCRATCH/sea-smoke.mjs" <<'EOF'
import { writeFileSync } from 'node:fs';
const { createSwarmEngine } = await import(process.env.SWARM_ENGINE_URL);
const started = Date.now();
const engine = createSwarmEngine({ persistHistory: false, prLookup: 'off' });
await engine.refresh();
const snapshot = await engine.getSnapshot(process.env.SWARM_ROOT);
writeFileSync(process.env.SWARM_OUT, JSON.stringify({
  node: process.version, sqlite: engine.diagnostics().filter(d => d.source === 'sqlite').map(d => d.message),
  swarms: engine.listSwarms().length, units: snapshot ? snapshot.units.length : null, ms: Date.now() - started,
}));
process.exit(0);
EOF
CLI="$(ls -td "$HOME"/Library/Caches/github-copilot-sdk/cli/*/ | head -n 1)copilot"
SWARM_ENGINE_URL="file://$PWD/engine/engine.mjs" SWARM_ROOT="$ROOT" SWARM_OUT="$SCRATCH/sea.json" EXTENSION_PATH="$SCRATCH/sea-smoke.mjs" \
  bash -c 'COPILOT_AUTO_UPDATE=false COPILOT_EXTENSION_PARENT_PID=$$ "$0" extension_bootstrap.mjs; true' "$CLI"
cat "$SCRATCH/sea.json"
```

Expected: the runtime's Node version (v24.x), `Reading SQLite through node:sqlite.`, the same unit count as Step 5, and the elapsed time.

- [ ] **Step 10: Push and report**

```bash
git push
git rev-parse HEAD
rm -rf "$SCRATCH"
```

Send the coordinator a `handoff` report: status, a short summary, the commands from Steps 1–9 with their outcomes (test counts, Node versions, timings, memory, aggregate real-data figures, read-only confirmation), the repository (`ncksol/ai_tools`), the branch and the pushed SHA, and any blockers. Do not open a PR.

## Self-review

**Spec coverage.** Each item of the approved PR 1 scope maps to tasks:

| Scope item | Tasks |
| --- | --- |
| Plugin skeleton and marketplace entry | 1, 16 |
| Read-only readers: SQLite access, app database, cost ledger, event logs, session files and liveness | 3, 4, 5, 7, 6 |
| Swarm model: runs and sessions, sub-agents, reports and questions, stages, PR monitors, cost | 4, 9, 10, 12, 13 |
| Stuck detection (design call 3, builder decisions 1–3) | 11 |
| Run lifecycle (design call 12) and history store (design call 7) | 13, 14, 15 |
| Data-contract parser (design section 10) | 8 |
| Command that prints a run's state as JSON | 16 |
| Snapshot schema and engine API for PR 2, pushed before other work | 2 |
| Tests on synthetic data; local-only real-data check | every task; 17 |
| Design document and cleaned mockup | already committed on this branch's base, so they reach `main` with this PR |

Out of scope and left to PR 2: server, UI, canvas extension, launcher, plugin README and repository docs. Orchestrator agent changes are tracked in issue #19.

**Placeholder scan.** No step defers work: every code step holds complete code, and every run step names its command and expected result. Matches for "todo" are the domain term (session todos, `todo_deps`, `todoId`).

**Type consistency.** Interface lines were checked against the code they describe, including the names shared across tasks: `readWorkspaceYaml` returns `{cwd, branch, hostType, repository}`, which `hostOf` reads; `resolvePr` takes a `host`; `SessionState.prompts` and `recent.calls[].prompt` feed `spinningReason`; `RunSummary.children.noOutcome` is the same in the typedef, validator, fixture, summary code and test; `prInfo(pr, {cwd})` matches `createPrLookup().request`.

**Dry run.** All code blocks were extracted into a scratch tree outside the repository and run: 125 tests pass on Node 24.19 and 22.16 (both SQLite backends), the suite passes on Node 18.11 (`sqlite3` CLI backend), and the validator passes. The same code was run read-only against the owner's data on this machine: listing swarms, a snapshot of the reference run with PR lookups, history, a run summary, and the extension-runtime smoke test. Builder decisions 2 and 5, the 256 KB read chunk and `ownString` rest on that run. Its results went to the coordinator and are not recorded here.
