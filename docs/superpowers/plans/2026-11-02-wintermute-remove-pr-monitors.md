# wintermute: remove agent-driven PR monitors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop wintermute agents from creating PR-watch automations, and make the dashboard treat an open PR without a schedule as normal.

**Architecture:** Prompt edits in three agent files remove every instruction to start, keep or stop a PR monitor, and add a rule against any replacement watcher. In the dashboard, `deriveMonitor` reports `missing` only for an overdue configured automation row; everything else without a row is `none`. UI copy stops promising a monitor. PR lookups, stage logic and stall rules are unchanged.

**Tech Stack:** Node.js ≥18 ESM, `node:test`, markdown agent prompts.

**Spec:** `docs/superpowers/specs/2026-11-02-wintermute-remove-pr-monitors-design.md` (issue #95)

## Global Constraints

- All work under `ghcp/plugins/wintermute/`; run commands from that directory.
- Node 18 compatible (`tests/guards.test.mjs` enforces it: no `t.after`/`t.before` in tests); no npm dependencies.
- Shared passages of `hands-on-orchestrator.agent.md` and `hands-on-session-orchestrator.agent.md` stay word for word identical; the report block in `hands-on-session-orchestrator` stays identical to `session-worker`'s (this plan doesn't touch the report block).
- Do not modify `engine/model/pr-lookup.mjs`, `engine/model/status.mjs`, `deriveStage`, `server/demo-*.mjs`, or `tests/fixtures/example-snapshot.json`.
- Keep `save_session_automation` and `manage_event_subscriptions` in `session-worker`'s `tools` list (user decision).
- The retired `orchestrator` and `session-orchestrator` agents stay retired.
- Commits: no `Co-authored-by` trailers or AI attribution.
- Final gate: `npm test && npm run validate` and `npm run check:layout` with 0 issues.

---

### Task 1: `deriveMonitor` reports `missing` only for an overdue schedule

**Files:**
- Modify: `engine/model/stage.mjs:1` (import), `engine/model/stage.mjs:125-144` (`deriveMonitor`)
- Modify: `engine/model/swarm.mjs:377-380` (drop `prKnownAt` argument)
- Modify: `engine/schema.mjs:160` (MonitorView comment)
- Test: `tests/stage.test.mjs:114-139`, `tests/pr-state.test.mjs:278-305`

**Interfaces:**
- Produces: `deriveMonitor({ stage, hasPr, closedWithoutMerge = false, automations = [], wakes = [], saves = [], now, thresholds })` → `{ state, lastCheckAt, nextCheckAt, everyMinutes, since }`. `prKnownAt` is removed. `state` is `missing` only when an unpaused automation row has `nextRunAt < now - thresholds.monitorGraceMs`.

- [ ] **Step 1: Update the stage tests to the new rule**

In `tests/stage.test.mjs`, in test `'monitors are alive, missing, paused, ended or none'`, remove `prKnownAt: T0,` from `base` and replace these three lines:

```js
  const missing = deriveMonitor({ ...base, stage: 'in_review', wakes: [T0 + 10 * MINUTE, T0 + 20 * MINUTE], saves: [{ at: T0, clear: false, everyMinutes: 10 }] });
  assert.deepEqual(missing, { state: 'missing', lastCheckAt: T0 + 20 * MINUTE, nextCheckAt: null, everyMinutes: 10, since: T0 + 30 * MINUTE });
  assert.equal(deriveMonitor({ ...base, stage: 'pr_open' }).since, T0);
```

with:

```js
  // Only a configured schedule can be missing. Past wakes or a stopped schedule with no row are history, not a failure.
  const history = deriveMonitor({ ...base, stage: 'in_review', wakes: [T0 + 10 * MINUTE, T0 + 20 * MINUTE], saves: [{ at: T0, clear: false, everyMinutes: 10 }] });
  assert.deepEqual(history, { state: 'none', lastCheckAt: T0 + 20 * MINUTE, nextCheckAt: null, everyMinutes: 10, since: null });
  assert.equal(deriveMonitor({ ...base, stage: 'in_review', saves: [{ at: T0, clear: true, everyMinutes: null }] }).state, 'none');
  assert.deepEqual(deriveMonitor({ ...base, stage: 'pr_open' }), { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null });
  assert.equal(deriveMonitor({ ...base, stage: 'in_review' }).state, 'none');
```

In test `'a PR closed without merge ends its monitor, with no stage change'`, remove `prKnownAt: T0,` from `base` and change the last line to:

```js
  assert.equal(deriveMonitor({ ...base, stage: 'pr_open', closedWithoutMerge: false }).state, 'none');
```

- [ ] **Step 2: Update the PR-state tests**

In `tests/pr-state.test.mjs`, replace the test `'a missing monitor with no known start time has no start time, not now'` with:

```js
test('an open PR with no automation has no monitor, not a missing one', () => {
  const monitor = deriveMonitor({ stage: 'in_review', hasPr: true, now: at(60), thresholds: DEFAULT_THRESHOLDS });
  assert.deepEqual(monitor, { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null });
});
```

Keep `'a missing monitor with no known start time says so instead of "0s"'` unchanged (it tests `monitorHtml` with a hand-built unit).

Replace the test `'a registry PR\'s monitor counts from a real time, or says that none is known'` with:

```js
test('registry PRs without a schedule show no monitor, whatever is known about when they opened', () => {
  const snapshot = buildSnapshot(swarm([
    { id: 'told', row: githubPr(8), log: log => { log.at(at(20)); log.report('ws-root', 'swarm-status: progress unit=told pr=github:8\nSummary: PR open.', 'progress'); } },
    { id: 'quiet', row: githubPr(9) },
    { id: 'looked', row: githubPr(10) },
  ], pr => (pr.id === 10 ? { state: 'open', title: 'Looked', openedAt: at(25), mergedAt: null, closedAt: null, reviewNote: null, url: null, checkedAt: at(55), error: null } : null)));
  assert.deepEqual(validateSnapshot(snapshot), []);
  for (const id of ['told', 'quiet', 'looked']) {
    const unit = unitOf(snapshot, id);
    assert.deepEqual({ state: unit.monitor.state, since: unit.monitor.since }, { state: 'none', since: null }, id);
  }
  assert.equal(unitOf(snapshot, 'looked').stage, 'in_review');
});
```

The `monitorHtml` text for these units is asserted in Task 2.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/stage.test.mjs tests/pr-state.test.mjs`
Expected: FAIL — `missing` returned where `none` is expected.

- [ ] **Step 4: Implement**

In `engine/model/stage.mjs`, change line 1 to `import { maxTime } from '../time.mjs';` (only if `MINUTE` has no other use in the file; check with `grep -n MINUTE engine/model/stage.mjs`). Replace the `deriveMonitor` comment and function with:

```js
/**
 * Monitor state from the unit's automation rows and its wake and schedule history (builder decision 8). Agents no
 * longer start PR monitors, so a unit with no automation row has no monitor (`none`), even with an open PR or past
 * wakes; only a configured schedule that is overdue is `missing`.
 */
export function deriveMonitor({ stage, hasPr, closedWithoutMerge = false, automations = [], wakes = [], saves = [], now, thresholds }) {
  const lastWake = wakes.length ? wakes[wakes.length - 1] : null;
  const row = [...automations].sort((a, b) => (b.nextRunAt ?? 0) - (a.nextRunAt ?? 0))[0] ?? null;
  const lastSave = saves.length ? saves[saves.length - 1] : null;
  const everyMinutes = row?.everyMinutes ?? (lastSave && !lastSave.clear ? lastSave.everyMinutes : null);
  const lastCheckAt = maxTime(row?.lastRunAt ?? null, lastWake);
  const view = (state, extra = {}) => ({ state, lastCheckAt, nextCheckAt: row?.nextRunAt ?? null, everyMinutes, since: null, ...extra });
  if (stage === 'merged' || stage === 'archived' || closedWithoutMerge) return view(hasPr ? 'ended' : 'none', { nextCheckAt: null });
  if (row && row.pausedAt !== null && row.pausedAt !== undefined) return view('paused', { since: row.pausedAt });
  if (row) {
    if (row.nextRunAt !== null && row.nextRunAt !== undefined && row.nextRunAt < now - thresholds.monitorGraceMs) return view('missing', { since: row.nextRunAt });
    return view('alive');
  }
  return view('none');
}
```

In `engine/model/swarm.mjs`, change the `deriveMonitor` call to:

```js
  const monitor = deriveMonitor({
    stage, hasPr: Boolean(pr), closedWithoutMerge, automations, wakes: c.all.automation.wakes, saves: c.all.automation.saves,
    now: input.now, thresholds: input.thresholds,
  });
```

Leave `monitorEver` and `deriveStage` as they are.

In `engine/schema.mjs:160`, change the trailing comment `since` is set for paused, and for missing when its start is known` to `since` is set for paused, and for missing (an overdue configured schedule)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/stage.test.mjs tests/pr-state.test.mjs tests/swarm.test.mjs tests/status.test.mjs tests/schema.test.mjs`
Expected: PASS. If a swarm test expected `missing` for a unit without an automation row, change that expectation to `none` (and nothing else).

- [ ] **Step 6: Commit**

```bash
git add engine/model/stage.mjs engine/model/swarm.mjs engine/schema.mjs tests/stage.test.mjs tests/pr-state.test.mjs tests/swarm.test.mjs
git commit -m "fix(wintermute): an open PR without a schedule has no monitor, not a missing one"
```

---

### Task 2: UI copy stops promising a monitor

**Files:**
- Modify: `ui/parts.mjs:64` (last line of `monitorHtml`)
- Modify: `ui/live.mjs:135`
- Test: `tests/ui-parts.test.mjs:64-74`, `tests/ui-detail.test.mjs:32`, `tests/pr-state.test.mjs` (new test)

**Interfaces:**
- Consumes: Task 1's `monitor.state === 'none'` for open PRs without a schedule.
- Produces: `monitorHtml(unit, now, long)` returns `'no monitor'` text for `state: 'none'` when `unit.pr` is set, and `'no PR yet'` (short and long) when it isn't.

- [ ] **Step 1: Write the failing tests**

In `tests/ui-parts.test.mjs`, test `'monitor text covers alive, missing, ended and no PR'`, change line 71 and add a case after it:

```js
  assert.equal(text(monitorHtml(findByLabel(snapshot, 'I1'), NOW, true)), 'no PR yet');
  const unwatched = { ...findByLabel(snapshot, 'D5'), monitor: { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null } };
  assert.equal(text(monitorHtml(unwatched, NOW)), 'no monitor');
  assert.equal(text(monitorHtml(unwatched, NOW, true)), 'no monitor');
```

(`D5` has a PR in the fixture, since its monitor is alive; confirm `findByLabel(snapshot, 'D5').pr` is non-null.)

In `tests/ui-detail.test.mjs:32`, replace the assertion with:

```js
  assert.match(words, /PR and monitor No PR yet\./);
  assert.doesNotMatch(words, /monitor starts/);
```

In `tests/pr-state.test.mjs`, add after the registry-PR test from Task 1:

```js
test('an open PR without a schedule reads "no monitor", with no warning', () => {
  const unit = { pr: { state: 'open' }, monitor: deriveMonitor({ stage: 'in_review', hasPr: true, now: at(60), thresholds: DEFAULT_THRESHOLDS }) };
  assert.equal(text(monitorHtml(unit, at(60))), 'no monitor');
  assert.doesNotMatch(monitorHtml(unit, at(60), true), /missing|starts when/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ui-parts.test.mjs tests/ui-detail.test.mjs tests/pr-state.test.mjs`
Expected: FAIL on the new `'no monitor'` / `'no PR yet'` (long) and `doesNotMatch(/monitor starts/)` assertions.

- [ ] **Step 3: Implement**

In `ui/parts.mjs`, replace the final line of `monitorHtml`:

```js
  return `${dot}${long ? 'starts when the PR opens' : 'no PR yet'}`;
```

with:

```js
  return `${dot}${unit.pr ? 'no monitor' : 'no PR yet'}`;
```

The `long` parameter stays: other branches use it.

In `ui/live.mjs:135`, replace:

```js
  if (!pr) return '<p class="small muted">No PR yet. A PR monitor starts when the PR opens.</p>';
```

with:

```js
  if (!pr) return '<p class="small muted">No PR yet.</p>';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/ui-parts.test.mjs tests/ui-detail.test.mjs tests/ui-live.test.mjs tests/pr-state.test.mjs tests/cockpit-model.test.mjs tests/cockpit-panels.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the layout check**

Run: `npm run check:layout`
Expected: every view and cockpit state reports 0 issues.

- [ ] **Step 6: Commit**

```bash
git add ui/parts.mjs ui/live.mjs tests/ui-parts.test.mjs tests/ui-detail.test.mjs tests/pr-state.test.mjs
git commit -m "fix(wintermute): dashboard no longer promises a PR monitor"
```

---

### Task 3: Agent prompts no longer start or rely on PR monitors

**Files:**
- Modify: `com.github.copilot/agents/hands-on-orchestrator.agent.md` (lines 82, 243, 329, 332, 337)
- Modify: `com.github.copilot/agents/hands-on-session-orchestrator.agent.md` (lines 82, 255, 339, 343, 348)
- Modify: `com.github.copilot/agents/session-worker.agent.md` (lines 16, 25)
- Create: `tests/agent-prompts.test.mjs`
- `orchestrator-worker.agent.md`: no change (it has no monitor or automation text; re-check with `grep -n -i "monitor\|automation\|poll\|watch" com.github.copilot/agents/orchestrator-worker.agent.md`, and if a line permits watching a PR, apply the same rule as session-worker's and add it to the test).

**Interfaces:**
- Produces: the exact sentences asserted in `tests/agent-prompts.test.mjs` below. Edits in the two orchestrators must be identical.

- [ ] **Step 1: Write the failing prompt test**

Create `tests/agent-prompts.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// These are static checks on prompt text. They show what the agents are told, not what a running session does.

const agent = name => readFileSync(new URL(`../com.github.copilot/agents/${name}.agent.md`, import.meta.url), 'utf8');
const ORCHESTRATORS = ['hands-on-orchestrator', 'hands-on-session-orchestrator'];
const AGENTS = [...ORCHESTRATORS, 'session-worker', 'orchestrator-worker'];

const NO_WATCH_RULE = '- Don\'t have a child watch a PR after it opens or publishes one, draft or ready: no PR monitor, session automation, event subscription, polling loop, background script or heartbeat, and no other agent to do it. The child reports, then goes on only with its assigned work and the required review and validation gates; don\'t keep it alive only to watch a PR. When you or the user need a PR\'s current state, CI or review comments, ask the owner for one check, or read them yourself as a quick job. A check is one read and schedules no other. Nothing reacts to new reviewer activity on its own: when you learn of review comments, send them to the owner as owned work.';
const KICKOFF_LINE = '- tell the child to send you its evidence and wait for your go-ahead before it opens a PR, takes one out of draft, or merges, and to report as soon as it opens a PR, without setting up anything to watch it afterwards;';
const WORKER_RULE = '- After you open a PR, draft or ready, don\'t set up anything to watch it: no PR monitor, session automation, event subscription, polling loop or background script. Report, then go on only with your assigned work and the required review and validation gates, and send `complete` once they are done. When you are asked to check a PR\'s state, CI or review comments, read them once and report; don\'t schedule another check or promise to handle future review comments.';

test('no agent prompt asks for a PR monitor to be started, kept or stopped', () => {
  for (const name of AGENTS) {
    assert.doesNotMatch(agent(name), /start monitoring|stop its PR monitor|PR monitoring|needs monitoring|monitor runs/i, name);
  }
});

test('both orchestrators forbid PR watching with the same words, in the rule and in every kickoff', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    assert.ok(text.includes(NO_WATCH_RULE), `${name}: no-watch rule`);
    assert.ok(text.includes(KICKOFF_LINE), `${name}: kickoff line`);
  }
});

test('session-worker forbids PR watching and keeps one-shot PR checks', () => {
  assert.ok(agent('session-worker').includes(WORKER_RULE));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/agent-prompts.test.mjs`
Expected: FAIL on all three tests.

- [ ] **Step 3: Edit both orchestrators identically**

Apply each edit to **both** `hands-on-orchestrator.agent.md` and `hands-on-session-orchestrator.agent.md`:

1. Routing table row (line 82 in both): replace `a branch or PR (one session = one branch = one PR), anything that needs monitoring, or a workstream the user will come back to.` with `a branch or PR (one session = one branch = one PR), or a workstream the user will come back to.`
2. Kickoff list: replace `- tell the child to send you its evidence and wait for your go-ahead before it opens a PR, takes one out of draft, or merges, and to report as soon as it opens a PR;` with `KICKOFF_LINE` from the test, exactly.
3. Lifecycle: replace `When a child publishes a PR, check that its PR columns are filled, then have the child start monitoring the PR straight away.` with `When a child publishes a PR, check that its PR columns are filled.` Then insert a new bullet directly after that line, with the text of `NO_WATCH_RULE` from the test, exactly.
4. Lifecycle merge bullet: replace `Then tell the child to stop its PR monitor and any Agent merge.` with `Then tell the child to stop any Agent merge.` Leave the rest of the bullet, including the archive conditions, unchanged.
5. Talking to the user: replace `Say nothing about idle notifications or monitor runs that bring no news.` with `Say nothing about idle notifications or scheduled runs that bring no news.`

Then confirm the two files still differ only where they differed before:

```bash
diff com.github.copilot/agents/hands-on-orchestrator.agent.md com.github.copilot/agents/hands-on-session-orchestrator.agent.md > /tmp/after.diff; \
diff <(git show HEAD:./com.github.copilot/agents/hands-on-orchestrator.agent.md) <(git show HEAD:./com.github.copilot/agents/hands-on-session-orchestrator.agent.md) > /tmp/before.diff; \
diff <(grep '^[<>]' /tmp/before.diff) <(grep '^[<>]' /tmp/after.diff)
```

Expected: the final `diff` prints nothing other than lines that differed before (the changed lines must not appear in it).

- [ ] **Step 4: Edit session-worker**

In `session-worker.agent.md`:

1. Line 16: replace `with its follow-ups, such as CI, review comments, rebases and PR monitoring;` with `with its follow-ups, such as CI, review comments and rebases;`
2. Insert a new bullet in "Operating mode" directly after `- Send the orchestrator your evidence and wait for its go-ahead before you open a PR, take one out of draft, or merge. Report as soon as you open a PR.`, with the text of `WORKER_RULE` from the test, exactly.

Do not change the `tools` list or the report-format block.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/agent-prompts.test.mjs tests/validate-plugin.test.mjs tests/packaging.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add com.github.copilot/agents/hands-on-orchestrator.agent.md com.github.copilot/agents/hands-on-session-orchestrator.agent.md com.github.copilot/agents/session-worker.agent.md tests/agent-prompts.test.mjs
git commit -m "feat(wintermute): agents no longer watch PRs after opening them"
```

---

### Task 4: README, release notes and version 0.5.0

**Files:**
- Modify: `README.md:25`, `README.md:68`, `README.md:116`
- Modify (via script): `plugin.json`, `package.json`, `../../../.github/plugin/marketplace.json`, `CHANGELOG.md`

- [ ] **Step 1: Update README**

1. After the paragraph ending at line 25 (`...not through \`git pull\`.`), add a new paragraph:

```markdown
An update doesn't change the prompts of sessions that are already running, and doesn't stop automations those sessions already created. From 0.5.0 the agents no longer start PR monitors; PR-monitor schedules made by older sessions keep running until you stop them in the app or archive their session.
```

2. Line 68: replace `sub-agents, PR and monitor (for a sub-agent: its type, mode and effort), and recent activity.` with `sub-agents, PR and monitor (for a sub-agent: its type, mode and effort), and recent activity. The monitor shows a scheduled automation on the unit, if there is one; agents no longer start PR monitors, so an open PR without one shows "no monitor", which is normal. Only a configured schedule that is overdue shows as missing.`

3. Line 116 stays as is (the stall rule is unchanged; "no monitor due" still describes it).

- [ ] **Step 2: Bump the version**

Run: `npm run release:bump -- minor`
Expected: `plugin.json`, `package.json` and the root marketplace entry read `0.5.0`, and `CHANGELOG.md` has a new `## 0.5.0 — <date>` section with a TODO.

- [ ] **Step 3: Write the release notes**

Replace the TODO in the new `CHANGELOG.md` section with:

```markdown
### Changed

- The agents no longer watch PRs. `hands-on-orchestrator` and `hands-on-session-orchestrator` no longer tell a child to start a PR monitor when it publishes a PR, or to stop one when it merges, and they forbid any replacement: no session automation, event subscription, polling loop, background script, heartbeat or extra agent to watch a PR. `session-worker` has the same rule and sends `complete` once its PR is open and its assigned gates are done. One-shot PR checks for assigned work are unchanged. Nothing reacts to new reviewer activity on its own any more; review comments go to the PR's owner as owned work when the orchestrator learns of them.
- The swarm dashboard shows "no monitor" for an open PR with no schedule, instead of a missing-monitor warning, and no longer says a monitor starts when the PR opens. A configured schedule that is overdue still shows as missing. Live PR lookups and past monitor checks are unchanged.

### Upgrading

- Running sessions keep the prompts they started with, and PR-monitor schedules they already created keep running. Stop those in the app, or archive their session, if you no longer want them.
```

- [ ] **Step 4: Run the full checks**

Run: `npm test && npm run validate && npm run check:layout`
Expected: all tests pass, validation reports no problems, layout check reports 0 issues in every view and cockpit state.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md plugin.json package.json ../../../.github/plugin/marketplace.json
git commit -m "chore(wintermute): release 0.5.0 notes for removing PR monitors"
```

---

## Supporting evidence (not an acceptance gate)

After merging, the absence of new PR-monitor automations can be checked read-only in `~/.copilot/data.db` (automations created by sessions started on 0.5.0). Don't change app state, stop sessions or remove schedules as part of this work.
