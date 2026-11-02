# Retire the base orchestrator agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `orchestrator` and `session-orchestrator` agents from the `wintermute` plugin, and every live mention of them, without breaking the plugin or the eval kit.

**Architecture:** Delete the two agent files, make the plugin validator reject any agent file it doesn't package (so a stray copy can't come back unnoticed), then scrub names from prompts, dashboard constants, tests, docs, repo instructions and the eval kit. Historical records stay untouched.

**Tech Stack:** Markdown agent prompts; Node 18+ ESM (`node:test`) for the plugin; Node/TypeScript (`node --test`) for the eval kit.

**Spec:** `docs/superpowers/specs/2026-11-02-retire-base-orchestrators-design.md`

## Global Constraints

- The retired agents are `orchestrator` and `session-orchestrator`: their bare names, `wintermute:` IDs and `.agent.md` file names. "The orchestrator" as a role word (the agent a worker reports to), the snapshot schema's `orchestrator` field, and the `orchestrator-worker` agent are not mentions and stay.
- Do not edit historical records: existing `CHANGELOG.md` sections, `evals/orchestrator/expense-claims/results.csv`, anything under `docs/superpowers/` other than this plan and its spec, and the pinned A/B/C files in `evals/orchestrator/expense-claims/variants/` with `variants/review-policy.json`.
- Keep `orchestrator-worker` (used by `hands-on-orchestrator`) and `session-worker` (used by `hands-on-session-orchestrator`). Keep the hands-on agents' names and IDs.
- No deprecation stub, hidden copy or alias of either retired agent.
- Shared text in the two hands-on files stays word for word the same; `hands-on-session-orchestrator`'s report-format block stays word for word the one in `session-worker.agent.md`.
- Plugin version: `npm run release:bump -- minor` (0.3.4 → 0.4.0) from `ghcp/plugins/wintermute/`, which updates `plugin.json`, `package.json` and the root `.github/plugin/marketplace.json` entry together. Fill in the new CHANGELOG section.
- Plugin must stay Node 18 compatible (`tests/guards.test.mjs`).
- Never run `npm` under `env -i` or a scratch `HOME` (it bypasses the `~/.npmrc` proxy).
- Commits: no `Co-authored-by` or other AI attribution trailers.

## Mapping rule for test fixtures

Wherever a test or fixture uses a retired name purely as a sample orchestrator agent, replace it:

| Old | New |
| --- | --- |
| `orchestrator` | `hands-on-orchestrator` |
| `session-orchestrator` | `hands-on-session-orchestrator` |
| `wintermute:orchestrator` | `wintermute:hands-on-orchestrator` |
| `wintermute:session-orchestrator` | `wintermute:hands-on-session-orchestrator` |

Do not touch `orchestrator-worker`, `orchestrator-review-a/b/c`, or `orchestrator` used as a schema field or role word. If a test lists old and hands-on names side by side and the replacement would create a duplicate, delete the old entry instead and adjust any count or expected list.

---

### Task 1: Validator rejects unpackaged agents; delete the two files

**Files:**
- Delete: `ghcp/plugins/wintermute/com.github.copilot/agents/orchestrator.agent.md`
- Delete: `ghcp/plugins/wintermute/com.github.copilot/agents/session-orchestrator.agent.md`
- Modify: `ghcp/plugins/wintermute/scripts/lib/validate-package.mjs:6-8` (`PACKAGED_AGENTS`) and the agent loop near line 85
- Test: `ghcp/plugins/wintermute/tests/validate-plugin.test.mjs`

**Interfaces:**
- Produces: `PACKAGED_AGENTS` = `['hands-on-orchestrator', 'hands-on-session-orchestrator', 'orchestrator-worker', 'session-worker']`. New validator error text: `` `${AGENTS_DIR}/<file>: agent is not packaged` `` for any `*.agent.md` in `com.github.copilot/agents/` whose stem isn't in `PACKAGED_AGENTS`.

- [ ] **Step 1: Write the failing test** — add to `tests/validate-plugin.test.mjs`, using the file's existing `sandbox`, `agentFile`, `validatePlugin`, `cpSync` helpers:

```js
test('an agent file the plugin does not package is reported', async () => {
  const { repo, root } = sandbox();
  cpSync(agentFile(root, 'hands-on-orchestrator'), agentFile(root, 'orchestrator'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/orchestrator.agent.md: agent is not packaged'), errors.join('\n'));
});
```

- [ ] **Step 2: Run it and see it fail**

Run (from `ghcp/plugins/wintermute/`): `node --test tests/validate-plugin.test.mjs`
Expected: the new test FAILS (no such error); others pass.

- [ ] **Step 3: Implement** — in `validate-package.mjs`, set `PACKAGED_AGENTS` to the four names above, and in the function that loops `for (const name of PACKAGED_AGENTS)` (near line 85) add a directory scan, using the module's existing `node:fs/promises` import style:

```js
import { access, readdir, readFile } from 'node:fs/promises';
// ...inside the agent check, after the PACKAGED_AGENTS loop:
for (const entry of (await readdir(path.join(root, AGENTS_DIR))).sort()) {
  if (entry.endsWith('.agent.md') && !PACKAGED_AGENTS.includes(entry.slice(0, -'.agent.md'.length))) {
    errors.push(`${AGENTS_DIR}/${entry}: agent is not packaged`);
  }
}
```

Match the local variable names (`root`, `errors`) to the surrounding function. Then `git rm` the two agent files.

- [ ] **Step 4: Fix the existing tests that used the retired files** in `tests/validate-plugin.test.mjs`:
  - "ships the six orchestrator agents": rename to "ships the four agents" and expect `['hands-on-orchestrator', 'hands-on-session-orchestrator', 'orchestrator-worker', 'session-worker']`.
  - Frontmatter test (lines ~85-90): use `hands-on-orchestrator` instead of `orchestrator` for the `plain` file and its expected error.
  - Bare-worker-ID test (lines ~96-106): use `hands-on-orchestrator` (with `agent_type: "wintermute:orchestrator-worker"`) and `hands-on-session-orchestrator` (with `kickoff.agent: "wintermute:session-worker"`), and update both expected errors to those file names. Keep the `assert.ok(text.includes(from), name)` guard; if a hands-on file doesn't contain the exact `from` string, pick the exact worker-start string that file does contain.
  - Copy-in-`ghcp/agents` test (lines ~112-114): copy `hands-on-orchestrator` instead.
  - Quoted-name tests (lines ~162-170): use `hands-on-orchestrator` (`name: hands-on-orchestrator\n` → `name: "hands-on-orchestrator"\n`).

- [ ] **Step 5: Run and see it pass**

Run: `node --test tests/validate-plugin.test.mjs`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A ghcp/plugins/wintermute/com.github.copilot/agents ghcp/plugins/wintermute/scripts/lib/validate-package.mjs ghcp/plugins/wintermute/tests/validate-plugin.test.mjs
git commit -m "feat(wintermute): remove orchestrator and session-orchestrator agents"
```

---

### Task 2: Scrub the remaining agent prompts

**Files:**
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-orchestrator.agent.md:23`
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-session-orchestrator.agent.md:23`
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/session-worker.agent.md:3,12`

- [ ] **Step 1: Edit line 23 of `hands-on-orchestrator.agent.md`** to:

```markdown
- Name yourself, `hands-on-orchestrator`, in any memory you store about how you work, so that the `hands-on-session-orchestrator` agent doesn't apply it.
```

- [ ] **Step 2: Edit line 23 of `hands-on-session-orchestrator.agent.md`** to:

```markdown
- Name yourself, `hands-on-session-orchestrator`, in any memory you store about how you work, so that the `hands-on-orchestrator` agent doesn't apply it.
```

- [ ] **Step 3: Edit `session-worker.agent.md`.** Line 3:

```yaml
description: Runs one unit of work, an owned branch or PR or a one-off job, as a child session of hands-on-session-orchestrator. Can't start sub-agents or sessions, and asks the orchestrator when it needs another agent.
```

Line 12, first sentence becomes: ``You are a child session of the `hands-on-session-orchestrator` agent.`` Leave the rest of the line as is.

- [ ] **Step 4: Check no mention is left in the agents folder**

Run (repo root): `grep -rnE "(^|[^-])session-orchestrator|\`(wintermute:)?orchestrator\`|\"(wintermute:)?orchestrator\"" ghcp/plugins/wintermute/com.github.copilot/agents`
Expected: no output.

Run (from `ghcp/plugins/wintermute/`): `node --test tests/validate-plugin.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/wintermute/com.github.copilot/agents
git commit -m "docs(wintermute): drop retired agents from the remaining prompts"
```

---

### Task 3: Dashboard stops treating the retired agents as orchestrators

**Files:**
- Modify: `ghcp/plugins/wintermute/engine/model/forest.mjs:8-9`
- Test: `ghcp/plugins/wintermute/tests/swarm-membership.test.mjs`, `tests/subagent-roots.test.mjs`, `tests/canvas-activity.test.mjs`

**Interfaces:**
- Produces: `ORCHESTRATOR_AGENT_NAMES` = `['hands-on-orchestrator', 'hands-on-session-orchestrator']`; `ORCHESTRATOR_AGENTS` = those two plus their `wintermute:` forms (derived as today).

- [ ] **Step 1: Update the test that pins the list first.** In `tests/swarm-membership.test.mjs` around lines 202-203, change the expected list to:

```js
    'hands-on-orchestrator', 'hands-on-session-orchestrator',
    'wintermute:hands-on-orchestrator', 'wintermute:hands-on-session-orchestrator',
```

- [ ] **Step 2: Run it and see it fail**

Run (from `ghcp/plugins/wintermute/`): `node --test tests/swarm-membership.test.mjs`
Expected: FAIL on the list assertion.

- [ ] **Step 3: Implement** in `engine/model/forest.mjs`:

```js
/** The orchestrator agents that follow the swarm dashboard data contract (com.github.copilot/agents/hands-on-orchestrator.agent.md and hands-on-session-orchestrator.agent.md). */
export const ORCHESTRATOR_AGENT_NAMES = Object.freeze(['hands-on-orchestrator', 'hands-on-session-orchestrator']);
```

Rewrite the doc comment on `ORCHESTRATOR_AGENTS` so it no longer promises History support for pre-plugin runs: "The agent IDs that data.db sessions.agent records for those orchestrators: the plugin's `wintermute:<name>`, and the bare `<name>`." Keep the bare names in the array (they're the hands-on names, which a user-level copy could still record).

- [ ] **Step 4: Apply the fixture mapping rule** (see "Mapping rule for test fixtures") to every retired agent name in `tests/swarm-membership.test.mjs`, `tests/subagent-roots.test.mjs` and `tests/canvas-activity.test.mjs`. Find them with:

```bash
grep -nE "'(wintermute:)?(session-)?orchestrator'" ghcp/plugins/wintermute/tests/*.mjs
```

Where a test deliberately pairs an old-name session with a hands-on-name session (for example `subagent-roots.test.mjs:162-167` and `swarm-membership.test.mjs:219-221`, which build `cli-orch`/`cli-hands-on` and `chat-orch`/`chat-hands-on`), read the test's assertions: if it only needs "an orchestrator session", map the name; if mapping creates two identical sessions whose distinction the assertions rely on, remove the old-name session and its expectations. `subagent-roots.test.mjs:28` default `agent = 'orchestrator'` becomes `agent = 'hands-on-orchestrator'`.

- [ ] **Step 5: Run the dashboard tests**

Run: `node --test tests/swarm-membership.test.mjs tests/subagent-roots.test.mjs tests/canvas-activity.test.mjs tests/forest-creator.test.mjs`
Expected: all PASS. Then rerun the grep from Step 4: expected no output.

- [ ] **Step 6: Commit**

```bash
git add ghcp/plugins/wintermute/engine/model/forest.mjs ghcp/plugins/wintermute/tests
git commit -m "feat(wintermute): dashboard recognises only the hands-on orchestrators"
```

---

### Task 4: Plugin README, version bump and CHANGELOG

**Files:**
- Modify: `ghcp/plugins/wintermute/README.md` (lines ~31, ~38, ~45-54, ~58, ~129, ~196)
- Modify via script: `plugin.json`, `package.json`, `.github/plugin/marketplace.json`, `CHANGELOG.md`

- [ ] **Step 1: Edit the README.**
  - "Moving from swarm-dashboard", step 1: replace "Remove the six agents from `~/.copilot/agents/`." with "Remove the old agent files from `~/.copilot/agents/`." Leave the rest of the step.
  - Line ~38, last sentence: drop ", including runs of the agents under their old plain names" so it ends "…so past runs stay in History."
  - Agents table: delete the `orchestrator` and `session-orchestrator` rows and replace the other four with:

```markdown
| `hands-on-orchestrator` | `wintermute:hands-on-orchestrator` | Plans, delegates and tracks multi-PR work. Hands owned work to child sessions and one-off jobs to `orchestrator-worker` sub-agents, may do a quick job itself, and commits small edits on its own session branch. Plans for wall-clock speed. |
| `hands-on-session-orchestrator` | `wintermute:hands-on-session-orchestrator` | Like `hands-on-orchestrator`, but delegates only to child sessions, which run as `session-worker`, and never starts sub-agents. |
| `orchestrator-worker` | `wintermute:orchestrator-worker` | Does one-off jobs for `hands-on-orchestrator`, which starts it through `task`. Hidden from the picker. |
| `session-worker` | `wintermute:session-worker` | The agent every child session of `hands-on-session-orchestrator` runs as. Hidden from the picker. |
```

  - "The four orchestrators are meant to run…" → "The two orchestrators are meant to run…".
  - Line ~58: remove `orchestrator` and `session-orchestrator` from the list of agents named there, keeping the hands-on ones; fix the grammar of the list.
  - Line ~129 `npm run validate` row: "the six agents" → "the four agents".
  - Line ~196 layout row: "The six orchestrator agents" → "The orchestrator agents and their workers".

- [ ] **Step 2: Bump the version**

Run (from `ghcp/plugins/wintermute/`): `npm run release:bump -- minor`
Expected: version 0.4.0 in `plugin.json`, `package.json` and the marketplace entry, and a new `## 0.4.0 — <date>` section with a TODO in `CHANGELOG.md`.

- [ ] **Step 3: Replace the TODO** in the new CHANGELOG section with:

```markdown
### Removed

- The `orchestrator` and `session-orchestrator` agents. Use `hands-on-orchestrator` or `hands-on-session-orchestrator` instead. Sessions that still select a removed agent ID get no agent until they switch.
- The swarm dashboard no longer counts a session as an orchestrator because its agent is one of the removed ones, so their past runs without child sessions no longer show as swarms.
- `npm run validate` now reports any agent file in `com.github.copilot/agents/` that the plugin doesn't package.
```

- [ ] **Step 4: Run the plugin checks**

Run: `npm test && npm run validate`
Expected: all tests PASS; validate reports no errors.

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/wintermute .github/plugin/marketplace.json
git commit -m "chore(wintermute): 0.4.0, document the removed agents"
```

---

### Task 5: Repository docs and the eval-runner agent

**Files:**
- Modify: `.github/copilot-instructions.md:39-45`
- Modify: `README.md:41,71,75-80,298`
- Modify: `ghcp/agents/eval-runner.agent.md:19-20`

- [ ] **Step 1: `.github/copilot-instructions.md`.**
  - Delete the `orchestrator` bullet (line 39) and the `session-orchestrator` bullet (line 41).
  - `orchestrator-worker` bullet: "helper that `orchestrator` and `hands-on-orchestrator` start" → "helper that `hands-on-orchestrator` starts".
  - `hands-on-orchestrator` bullet: start "session-level coordinator for the GitHub Copilot app, selected with `/agent` or the composer, that may do a quick job itself: …". Move into it the facts from the deleted `orchestrator` bullet that still hold for hands-on (keeps plan state and a child-session registry in the session SQL database; sets a model and reasoning effort on every child session and sub-agent from the tier table in its "Models and effort" section, which is the user's model policy). Drop "variant of `orchestrator`" and any "It also has … `orchestrator` doesn't have these rules" sentence.
  - `hands-on-session-orchestrator` bullet: replace "the same change made to `session-orchestrator`, with the same tools added" with "variant of `hands-on-orchestrator` that delegates only to child sessions: owner sessions for owned work, one-off sessions for one-off jobs, all run as `wintermute:session-worker`. Children can't start agents, so it plans all fan-out itself and handles their helper requests". Keep the rest.
  - Replace the "must stay in step" bullet (line 44) with:

```markdown
- The two orchestrator files in `ghcp/plugins/wintermute/com.github.copilot/agents/` must stay in step. Text that both files share stays word for word the same, so apply a change to a shared passage in both. The "Quick jobs you do yourself" section is byte-identical in both and names no agent. `hands-on-orchestrator` follows `hands-on-session-orchestrator` in "Split work for speed" and in the other rules that don't depend on how one-off jobs are delegated: when one of them changes in `hands-on-session-orchestrator`, make the same change in `hands-on-orchestrator`, adapted only where sub-agents and one-off sessions work differently. The report-format block in `hands-on-session-orchestrator` stays word for word the one in `session-worker.agent.md`. Any edit to these four agents is a change to the `wintermute` plugin: bump its version, add a CHANGELOG entry, and run `npm test && npm run validate` from `ghcp/plugins/wintermute/`.
```

  - `session-worker` bullet: "every child of `session-orchestrator` and `hands-on-session-orchestrator`" → "every child of `hands-on-session-orchestrator`"; "Its report block is the one in `session-orchestrator.agent.md`" → "…in `hands-on-session-orchestrator.agent.md`".
  - `wintermute` plugin bullet (line ~50): "the six agents above" → "the four agents above".
  - "Agent file conventions" (line ~124 and nearby): where `orchestrator.agent.md` or `orchestrator`'s list is the example, use `hands-on-orchestrator`. For the `explore` note "with `orchestrator`'s list, only `view`", drop that parenthetical example, since no remaining agent has that list.
  - "When adding a new agent … an agent that belongs to the orchestrator family" stays.

- [ ] **Step 2: Root `README.md`.** Line 41: list four agents (`hands-on-orchestrator`, `hands-on-session-orchestrator`, `orchestrator-worker`, `session-worker`) instead of six. Line 71: "These six agents" → "These four agents". Delete table rows at lines 75 (`orchestrator`) and 77 (`session-orchestrator`). Row 76 (`orchestrator-worker`): "Helper for `hands-on-orchestrator`." Row 78 (`session-worker`): "every child session of `hands-on-session-orchestrator`". Row 79 (`hands-on-orchestrator`): replace "A variant of `orchestrator` that may do" with "Coordinator for multi-PR work in the GitHub Copilot app. Plans, delegates and tracks, and may do". Row 80 (`hands-on-session-orchestrator`): replace "The same change made to `session-orchestrator`:" with "A variant of `hands-on-orchestrator` that delegates only to child sessions:". Line 298: "(the six orchestrator agents)" → "(the orchestrator agents)".

- [ ] **Step 3: `ghcp/agents/eval-runner.agent.md` lines 19-20.** Merge into one bullet:

```markdown
- Never start the `wintermute:hands-on-orchestrator` or `wintermute:hands-on-session-orchestrator` agents, the pinned A/B/C aliases, or any agent, for any other purpose. The self-test uses whatever agent its action names, which is never an orchestrator.
```

Keep the rest of the original line 19 after "for any other purpose." if it says more than the sentence above.

- [ ] **Step 4: Check**

Run (repo root): `grep -nE "(^|[^-])session-orchestrator|\`(wintermute:)?orchestrator\`|orchestrator\.agent\.md|six (orchestrator )?agents" .github/copilot-instructions.md README.md ghcp/agents/eval-runner.agent.md`
Expected: only `hands-on-…` matches (the regex excludes them) — i.e. no output.

- [ ] **Step 5: Commit**

```bash
git add .github/copilot-instructions.md README.md ghcp/agents/eval-runner.agent.md
git commit -m "docs: remove retired orchestrator agents from repo docs"
```

---

### Task 6: Eval kit runs only the hands-on variants

**Files:**
- Modify: `evals/orchestrator/expense-claims/scripts/lib/variants.ts:5,67`
- Modify: `evals/orchestrator/expense-claims/README.md:7,56,146,453`
- Test: `evals/orchestrator/expense-claims/scripts/test/*.ts`, `scripts/test/fixtures/events.ts`

**Interfaces:**
- Produces: `LIVE_VARIANTS = ["hands-on-orchestrator", "hands-on-session-orchestrator"]`. `variantLabel`/`liveAgent` unchanged in shape. Batch default `--variants` (`scripts/batch.ts:64`) follows automatically.

- [ ] **Step 1: Update `scripts/test/variants.test.ts` first** so it expects `LIVE_VARIANTS` to be the two hands-on names, and that `variantLabel("wintermute:orchestrator")` now returns `"wintermute:orchestrator"` unchanged (no longer a live label). Add:

```ts
test("retired base agents are not live variants", () => {
  assert.deepEqual(LIVE_VARIANTS, ["hands-on-orchestrator", "hands-on-session-orchestrator"]);
  assert.equal(variantLabel("wintermute:orchestrator"), "wintermute:orchestrator");
  assert.equal(liveAgent("hands-on-orchestrator"), "wintermute:hands-on-orchestrator");
});
```

(Import `LIVE_VARIANTS`, `variantLabel`, `liveAgent` from `../lib/variants.ts` if the file doesn't already.)

- [ ] **Step 2: Run it and see it fail**

Run (from `evals/orchestrator/expense-claims/`): `node --test scripts/test/variants.test.ts`
Expected: FAIL on `LIVE_VARIANTS`.

- [ ] **Step 3: Implement** in `scripts/lib/variants.ts`:

```ts
export const LIVE_VARIANTS = ["hands-on-orchestrator", "hands-on-session-orchestrator"];
```

Line 67: replace `["orchestrator", "session-orchestrator"].includes(variant.agent)` with `LIVE_VARIANTS.includes(variant.agent)` (an A/B/C alias still must not take a live name).

- [ ] **Step 4: Apply the fixture mapping rule to the other kit tests.** Find mentions with:

```bash
grep -nE "(^|[^-])session-orchestrator|[\"'\`](wintermute:)?orchestrator[\"'\`,]|orchestrator,|orch-eval-orchestrator|orch-eval-session-orchestrator" scripts/test/*.ts scripts/test/fixtures/*.ts
```

Map names, including derived strings such as repo names `orch-eval-orchestrator-<n>` → `orch-eval-hands-on-orchestrator-<n>` and comma lists like `orchestrator,session-orchestrator,hands-on-orchestrator,hands-on-session-orchestrator` → `hands-on-orchestrator,hands-on-session-orchestrator`. Where a test relies on four live variants (round sizes, `--parallel` defaults, counts of planned runs), recompute the expectation for two. Where a test checks that a non-live label passes through unchanged, `orchestrator-review-a` is still the example to use. Leave tests that read `results.csv` rows as they are: those rows are historical data.

- [ ] **Step 5: README.**
  - Line 7: list only `wintermute:hands-on-orchestrator` and `wintermute:hands-on-session-orchestrator`.
  - Line 56: "For a live variant such as `hands-on-orchestrator`, select `wintermute:hands-on-orchestrator`;".
  - Line 146: example label `hands-on-orchestrator`.
  - Line 453 example prompt: "variants hands-on-orchestrator,hands-on-session-orchestrator, 3 runs each."
  - Lines 243-247 (A/B/C section) describe what the pinned snapshots are; leave them.
  - Search the README once more with the Step 4 regex and fix any other live-variant mention the same way.

- [ ] **Step 6: Run the kit checks**

Run: `npm test && npm run check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add evals/orchestrator/expense-claims
git commit -m "feat(evals): live variants are the two hands-on orchestrators"
```

---

### Task 7: Final trace check

- [ ] **Step 1: Search the whole repo outside historical records**

Run (repo root):

```bash
grep -rnIE "(^|[^-])session-orchestrator|[\`'\"](wintermute:)?orchestrator[\`'\"]|(^|[^-])orchestrator\.agent\.md" . \
  --exclude-dir=.git --exclude-dir=node_modules \
  | grep -vE "^\./docs/superpowers/|results\.csv|/variants/(orchestrator-review-|review-policy)|wintermute/CHANGELOG\.md"
```

Expected: no output, except `"orchestrator"` used as the snapshot schema key (for example `tests/fixtures/example-snapshot.json` and `engine/schema.mjs`) and the `orchestrator` keyword in `plugin.json`/`marketplace.json`, which are not agent mentions. Fix anything else.

- [ ] **Step 2: Rerun both suites once**

Run: `(cd ghcp/plugins/wintermute && npm test && npm run validate) && (cd evals/orchestrator/expense-claims && npm test && npm run check)`
Expected: all PASS.

- [ ] **Step 3: Commit any fixes** with `git commit -m "chore: remove remaining mentions of retired orchestrators"` (skip if nothing changed).
