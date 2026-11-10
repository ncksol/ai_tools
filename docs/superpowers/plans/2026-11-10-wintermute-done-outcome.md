# wintermute done outcome and reviewed PRs: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finished reviewers and one-off jobs read as "done", and reviewers stop owning the PR they review (issue #112).

**Architecture:** The engine filters out status lines that name another unit's registry PR before `resolvePr` runs, and it keeps that PR in a new unit field, `reviewedPr`. A registry `closed` with no own PR and a `complete` latest report then resolves to the new snapshot outcome `done`. The UI reads `done` and `reviewedPr`. Run summaries record a rules version, so that `isStale` rebuilds summaries saved under the old rules when their logs can still be read.

**Tech Stack:** Node.js ES modules, `node:test`, no dependencies. Every command runs from `ghcp/plugins/wintermute/`.

**Spec:** `docs/superpowers/specs/2026-11-10-wintermute-done-outcome-design.md` (design) and issue #112 (requirements and evidence).

## Global Constraints

- Shipped code stays compatible with Node 18: no Node APIs newer than 18. In tests, don't use `t.after` or `t.before`. `tests/guards.test.mjs` enforces both.
- `SCHEMA_VERSION` stays `1`. Run summaries must match it exactly, so bumping it would drop every saved summary.
- The registry contract stays as it is: a registry row can't record `done`, and the agent prompts don't change.
- The Board card doesn't change here. #111 rebuilds it.
- Release as wintermute 0.9.4 (patch). `plugin.json`, `package.json` and the root `.github/plugin/marketplace.json` all carry the same version, and CHANGELOG.md gets a 0.9.4 section.
- Commits have no `Co-authored-by` trailer and no AI attribution.
- UI and doc text is plain English.

---

### Task 1: Engine — PR ownership and the `done` outcome

**Files:**
- Modify: `engine/schema.mjs` (outcome lists, `UNIT` spec, typedef comments)
- Modify: `engine/model/contract.mjs:1,105` (registry outcomes)
- Modify: `engine/model/stage.mjs` (new `registryPrs`, `splitReviewed`, `resolveOutcome`; `resolvePr` uses a shared `registryRepo`)
- Modify: `engine/model/swarm.mjs:8,252-261,343-434,602` (wire it in, add `reviewedPr`)
- Modify: `tests/fixtures/example-snapshot.json` (`"reviewedPr": null` on every unit)
- Test: `tests/stage.test.mjs`, `tests/swarm.test.mjs`, `tests/contract.test.mjs`, `tests/schema.test.mjs`

**Interfaces:**
- Produces in `engine/schema.mjs`: `REGISTRY_OUTCOMES = ['merged','closed','failed']` and `OUTCOMES = ['merged','closed','failed','done']`.
- Produces in `engine/model/stage.mjs`:
  - `registryPrs(rows: Iterable<RegistryRow>): Map<string, RegistryRow[]>`, keyed `` `${provider}:${id}` ``;
  - `splitReviewed(statusLines, prs, row = null, host = null): { own: StatusLine[], reviewedPr: { provider, id, repo, url } | null }`;
  - `resolveOutcome(recorded: string|null, { pr, report }): string|null`.
- Produces on every snapshot unit: `reviewedPr: { provider: 'ado'|'github', id: number, repo: string|null, url: string|null } | null`. Sub-agent units always have `null`.
- Produces: the unit `outcome` can now be `'done'`, which always comes with `closedWithoutMerge: false`.

- [ ] **Step 1: Write the failing unit tests in `tests/stage.test.mjs`**

Change the import on line 4 to:

```js
import { MENTION_CANDIDATES, deriveMonitor, deriveStage, hostOf, mentionFits, prView, registryPrs, resolveOutcome, resolvePr, splitReviewed } from '../engine/model/stage.mjs';
```

Append:

```js
test('a status-line PR that the registry records for another unit is the PR this unit reviews (issue #112)', () => {
  const host = { provider: 'ado', repo: 'org/project/repo' };
  const owner = { unit: 'api', prProvider: 'ado', prId: 4711, prRepo: 'org/project/repo', prUrl: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4711' };
  const self = { unit: 'ui', prProvider: null, prId: null, prRepo: null, prUrl: null };
  const prs = registryPrs([owner, self]);
  const lines = [{ at: T0 + 2, pr: { provider: 'ado', id: 4711 } }, { at: T0 + 1, pr: { provider: 'ado', id: 9 } }, { at: T0, pr: null }];
  const { own, reviewedPr } = splitReviewed(lines, prs, self, host);
  assert.deepEqual(own, lines.slice(1));
  assert.deepEqual(reviewedPr, { provider: 'ado', id: 4711, repo: 'org/project/repo', url: owner.prUrl });
  assert.equal(resolvePr({ registry: self, statusLines: own, host }).id, 9, 'the next status line is its own PR');
  assert.deepEqual(splitReviewed(lines, prs, owner, host), { own: lines, reviewedPr: null }, 'the owner keeps its own PR');
  assert.equal(splitReviewed(lines, prs, null, host).reviewedPr.id, 4711, 'a unit with no registry row reviews it too');
  assert.deepEqual(splitReviewed(lines, registryPrs([]), self, host), { own: lines, reviewedPr: null }, 'a PR no unit records stays its own');
});

test('a registry closed unit with no PR of its own and a complete latest report is done', () => {
  const complete = { status: 'complete' };
  assert.equal(resolveOutcome('closed', { pr: null, report: complete }), 'done');
  assert.equal(resolveOutcome('closed', { pr: { id: 9 }, report: complete }), 'closed');
  for (const report of [null, { status: 'progress' }, { status: 'blocked' }, { status: 'needs_input' }]) {
    assert.equal(resolveOutcome('closed', { pr: null, report }), 'closed', report?.status ?? 'no report');
  }
  for (const recorded of ['merged', 'failed', null]) assert.equal(resolveOutcome(recorded, { pr: null, report: complete }), recorded);
  assert.deepEqual(deriveStage({ archivedAt: null, outcome: 'done', pr: null }), { stage: 'coding', merged: false, closedWithoutMerge: false });
  assert.deepEqual(deriveStage({ archivedAt: T0, outcome: 'done', pr: null }), { stage: 'archived', merged: false, closedWithoutMerge: false });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `node --test tests/stage.test.mjs`
Expected: FAIL with a SyntaxError, because `registryPrs` is not exported.

- [ ] **Step 3: Implement in `engine/model/stage.mjs`**

Below the `branchName` const, add:

```js
const prKey = pr => `${pr.provider}:${pr.id}`;

/** A registry row's PR repository: its own when valid for its provider, else the host's repository for that provider. */
function registryRepo(row, host) {
  const valid = row.prProvider === 'ado' ? ADO_REPO : row.prProvider === 'github' ? GITHUB_REPO : null;
  if (valid && typeof row.prRepo === 'string' && valid.test(row.prRepo)) return row.prRepo;
  return host?.provider === row.prProvider ? host.repo : null;
}

/** The registry rows that record each PR, keyed `provider:id`. */
export function registryPrs(rows) {
  const prs = new Map();
  for (const row of rows) {
    if (!row.prProvider || !row.prId) continue;
    const key = prKey({ provider: row.prProvider, id: row.prId });
    if (!prs.has(key)) prs.set(key, []);
    prs.get(key).push(row);
  }
  return prs;
}

/**
 * Issue #112: a status line that names a PR the registry records for another unit names the PR this unit reviews, not its
 * own. `own` keeps the other lines, latest first. `reviewedPr` is the latest such PR, with the owner's repository and URL,
 * else null. A PR that no other unit records stays in `own`, and so does one that the unit's own row records.
 */
export function splitReviewed(statusLines, prs, row = null, host = null) {
  const ownerOf = item => {
    const rows = item.pr ? prs.get(prKey(item.pr)) ?? [] : [];
    return rows.includes(row) ? null : rows[0] ?? null;
  };
  const own = [];
  let reviewedPr = null;
  for (const item of statusLines) {
    const owner = ownerOf(item);
    if (!owner) own.push(item);
    else if (!reviewedPr) reviewedPr = { provider: owner.prProvider, id: owner.prId, repo: registryRepo(owner, host), url: owner.prUrl ?? null };
  }
  return { own, reviewedPr };
}

/**
 * The outcome a unit shows (issue #112). A registry `closed` unit with no PR of its own and a `complete` latest report has
 * finished its work: `done`. Every other outcome is shown as recorded.
 */
export function resolveOutcome(recorded, { pr = null, report = null } = {}) {
  return recorded === 'closed' && !pr && report?.status === 'complete' ? 'done' : recorded;
}
```

In `resolvePr`, replace the registry branch:

```js
  if (registry?.prProvider && registry.prId) {
    const valid = registry.prProvider === 'ado' ? ADO_REPO : registry.prProvider === 'github' ? GITHUB_REPO : null;
    const repo = valid && typeof registry.prRepo === 'string' && valid.test(registry.prRepo) ? registry.prRepo : repoFor(registry.prProvider);
    return { provider: registry.prProvider, id: registry.prId, repo, url: registry.prUrl ?? null, source: 'registry', knownAt: firstReported(registry.prProvider, registry.prId) };
  }
```

with:

```js
  if (registry?.prProvider && registry.prId) {
    return { provider: registry.prProvider, id: registry.prId, repo: registryRepo(registry, host), url: registry.prUrl ?? null, source: 'registry', knownAt: firstReported(registry.prProvider, registry.prId) };
  }
```

In the `deriveStage` doc comment, add a last line: ` * A \`done\` outcome is neither merged nor closed without merging, so a done unit is archived once archived, else in its PR stage.`

- [ ] **Step 4: Run the stage tests and confirm they pass**

Run: `node --test tests/stage.test.mjs`
Expected: PASS, including the existing "a registry repository is kept only when it is valid for its provider" test.

- [ ] **Step 5: Write the failing contract and schema tests**

Append to `tests/contract.test.mjs`:

```js
test('a registry row cannot record done, which only the engine infers', () => {
  const row = { unit: 'ui', session_id: 'ws-1', title: 'UI', created_at: '2026-10-15T08:00:00Z', updated_at: '2026-10-15T09:00:00Z', outcome: 'done', ended_at: '2026-10-15T09:00:00Z' };
  const ui = normaliseRegistry([[row]]).units.get('ui');
  assert.deepEqual([ui.outcome, ui.endedAt], [null, null]);
});
```

Append to `tests/schema.test.mjs`:

```js
test('every unit requires a nullable reviewedPr, and done is a unit outcome', () => {
  const snapshot = fixture('example-snapshot.json');
  const unit = snapshot.units.find(item => item.label === 'D5');
  Object.assign(unit, { pr: null, outcome: 'done', reviewedPr: { provider: 'github', id: 418, repo: 'sample-org/sample-repo', url: null } });
  assert.deepEqual(validateSnapshot(snapshot), []);
  unit.reviewedPr = { provider: 'github', id: 418, repo: null, url: null, state: 'open' };
  assert.ok(validateSnapshot(snapshot).some(error => error.endsWith('.reviewedPr.state: unexpected field')));
  delete unit.reviewedPr;
  assert.ok(validateSnapshot(snapshot).some(error => error.endsWith('.reviewedPr: missing')));
});
```

Run: `node --test tests/contract.test.mjs tests/schema.test.mjs`
Expected: FAIL. The contract test gets `'done'` for the outcome, and the schema test reports `reviewedPr: unexpected field` and an `outcome` error.

- [ ] **Step 6: Implement the schema and contract changes**

In `engine/schema.mjs`, replace `export const OUTCOMES = Object.freeze(['merged', 'closed', 'failed']);` with:

```js
/** Outcomes an orchestrator records in its `children` registry (design section 10). */
export const REGISTRY_OUTCOMES = Object.freeze(['merged', 'closed', 'failed']);
/** Outcomes a unit shows: the registry's, plus `done`, which the engine infers for a registry `closed` unit that finished its work (issue #112). */
export const OUTCOMES = Object.freeze([...REGISTRY_OUTCOMES, 'done']);
```

In the `UNIT` spec, after `pr: nullable(PR),` add:

```js
  reviewedPr: nullable({ provider: oneOf(PR_PROVIDERS), id: is.count, repo: OPT_TEXT, url: OPT_TEXT }),
```

In the `UnitView` typedef, change `outcome: 'merged'|'closed'|'failed'|null,` to `outcome: 'merged'|'closed'|'failed'|'done'|null,`. Change `pr: PrView|null, monitor: MonitorView,` to `pr: PrView|null, reviewedPr: { provider: 'ado'|'github', id: number, repo: string|null, url: string|null }|null, monitor: MonitorView,`. Below the existing `` `dependsOn` `` note, add:

```js
 *   `outcome` 'done': the registry says closed, the unit has no PR of its own and its latest report is complete; closedWithoutMerge is false.
 *   `reviewedPr`: the PR its status lines name when the registry records that PR for another unit, as a reviewer's do; `pr` never holds it.
```

In the sub-agent unit comment block, change `` *   pr              null          monitor: `` to `` *   pr, reviewedPr  null          monitor: ``.

In `engine/model/contract.mjs`, change line 1 to import `REGISTRY_OUTCOMES` instead of `OUTCOMES`, and line 105 to:

```js
  const outcome = REGISTRY_OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
```

- [ ] **Step 7: Add `reviewedPr: null` to the fixture**

Run:

```bash
node -e 'const fs=require("fs");const f="tests/fixtures/example-snapshot.json";const out=fs.readFileSync(f,"utf8").split("\n").flatMap(l=>/^      "pr": .*,$/.test(l)?[l,"      \"reviewedPr\": null,"]:[l]);fs.writeFileSync(f,out.join("\n"))' && grep -c '"reviewedPr": null' tests/fixtures/example-snapshot.json
```

Expected: `12` (one per unit).

Run: `node --test tests/contract.test.mjs tests/schema.test.mjs`
Expected: the new tests pass. Snapshot tests that build units in the engine can still fail until Step 9.

- [ ] **Step 8: Write the failing swarm tests in `tests/swarm.test.mjs`**

Replace the test `'a unit that mentions another unit\'s PR and ends with registry outcome closed shows closed, not merged'`. Its last report is now a successful `task_complete`, so the unit is done:

```js
test('a unit that mentions another unit\'s PR and ends with registry outcome closed after a complete report is done', () => {
  const ui = uiOf(mentionsOtherPr(MERGED_BEFORE_START, { finished: true }));
  assert.equal(ui.pr, null);
  assert.equal(ui.outcome, 'done');
  assert.equal(ui.closedWithoutMerge, false);
  assert.equal(ui.stage, 'coding');
  assert.notEqual(ui.status, 'merged');
  assert.equal(ui.endedAt, at(119));
});
```

Below it, add:

```js
/** Issue #112: the ui unit's one report has a status line naming `pr` (or none); with `outcome`, the registry records it ended. */
function reportsPr(pr, { status = 'complete', outcome = null } = {}) {
  const data = input(true);
  const ui = new EventLog(at(6));
  ui.start(); ui.turnStart(); ui.at(at(100));
  ui.report('ws-root', `swarm-status: ${status} unit=ui${pr ? ` pr=${pr}` : ''}\nSummary: UI report.`, status === 'complete' ? 'handoff' : 'progress');
  ui.at(at(101)); ui.turnEnd();
  data.states.set('cli-ui', fold(ui, 'cli-ui'));
  if (outcome) Object.assign(data.sessionDbs.get('cli-root').children.find(item => item.unit === 'ui'), { outcome, ended_at: iso(101), updated_at: iso(101) });
  return data;
}

test('a unit whose status line names another unit\'s registry PR reviews it: pr is null and reviewedPr holds it', () => {
  const snapshot = buildSnapshot(reportsPr('ado:4711'));
  assert.deepEqual(validateSnapshot(snapshot), []);
  const ui = snapshot.units.find(unit => unit.id === 'ws-ui');
  assert.equal(ui.pr, null);
  assert.deepEqual(ui.reviewedPr, { provider: 'ado', id: 4711, repo: 'org/project/repo', url: null });
  assert.equal(ui.stage, 'coding', 'a reviewer is not in review');
  const api = snapshot.units.find(unit => unit.id === 'ws-api');
  assert.deepEqual([api.pr.id, api.pr.source, api.reviewedPr], [4711, 'registry', null]);
});

test('a status-line PR that no other unit records stays the unit\'s own PR', () => {
  const ui = uiOf(reportsPr('ado:4999'));
  assert.deepEqual([ui.pr.id, ui.pr.source, ui.reviewedPr], [4999, 'status_line', null]);
});

test('a registry closed unit is done with no own PR and a complete report, else closed', () => {
  const reviewer = uiOf(reportsPr('ado:4711', { outcome: 'closed' }));
  assert.deepEqual([reviewer.outcome, reviewer.closedWithoutMerge, reviewer.pr, reviewer.reviewedPr.id, reviewer.endedAt], ['done', false, null, 4711, at(101)]);
  const job = uiOf(reportsPr(null, { outcome: 'closed' }));
  assert.deepEqual([job.outcome, job.closedWithoutMerge, job.pr], ['done', false, null]);
  const ownPr = uiOf(reportsPr('ado:4999', { outcome: 'closed' }));
  assert.deepEqual([ownPr.outcome, ownPr.closedWithoutMerge, ownPr.pr.id], ['closed', true, 4999]);
  const unfinished = uiOf(reportsPr(null, { status: 'progress', outcome: 'closed' }));
  assert.deepEqual([unfinished.outcome, unfinished.closedWithoutMerge, unfinished.pr], ['closed', true, null]);
});
```

In the `for (const [name, options, detail] of [...])` list for `'a swarm with only finished units does not stall'`, add this entry after `['closed without a PR', ...]`:

```js
  ['done: closed without a PR after a complete report', { outcome: 'closed' }, 'idle'],
```

Run: `node --test tests/swarm.test.mjs`
Expected: FAIL. The snapshot is missing `reviewedPr`, `ui.pr.id` is 4711 instead of null, and the outcome is `'closed'` instead of `'done'`.

- [ ] **Step 9: Wire the engine in `engine/model/swarm.mjs`**

Change line 8 to:

```js
import { deriveMonitor, deriveStage, hostOf, mentionFits, prView, registryPrs, resolveOutcome, resolvePr, splitReviewed } from './stage.mjs';
```

In `readRegistry`, change the return to:

```js
  return { present: units.size > 0, rows: units, byNode, invalid, prs: registryPrs(units.values()) };
```

In `buildUnit`, replace:

```js
  const identity = resolvePr({
    registry: row, statusLines, createdPr: node.createdPr, mentions: c.all.prMentions, host,
```

with:

```js
  const { own, reviewedPr } = splitReviewed(statusLines, registry.prs, row, host);
  const identity = resolvePr({
    registry: row, statusLines: own, createdPr: node.createdPr, mentions: c.all.prMentions, host,
```

Replace:

```js
  const { stage, merged, closedWithoutMerge } = deriveStage({ archivedAt: node.archivedAt, outcome: row?.outcome ?? null, pr, monitorEver });
```

with:

```js
  const recorded = resolveOutcome(row?.outcome ?? null, { pr, report });
  const { stage, merged, closedWithoutMerge } = deriveStage({ archivedAt: node.archivedAt, outcome: recorded, pr, monitorEver });
```

In the `evaluateStatus({ ... })` call, change `outcome: row?.outcome ?? null,` to `outcome: recorded,`.

Replace:

```js
  const outcome = row?.outcome ?? (merged ? 'merged' : closedWithoutMerge ? 'closed' : evaluation.detail === 'failed' ? 'failed' : null);
```

with:

```js
  const outcome = recorded ?? (merged ? 'merged' : closedWithoutMerge ? 'closed' : evaluation.detail === 'failed' ? 'failed' : null);
```

In the `unit` object, change `closedWithoutMerge, outcome, pr, monitor,` to `closedWithoutMerge, outcome, pr, reviewedPr, monitor,`.

In the sub-agent unit builder (around line 602), change `closedWithoutMerge: false, outcome: null, pr: null,` to `closedWithoutMerge: false, outcome: null, pr: null, reviewedPr: null,`.

- [ ] **Step 10: Run the engine tests and confirm they pass**

Run: `node --test tests/stage.test.mjs tests/swarm.test.mjs tests/contract.test.mjs tests/schema.test.mjs tests/engine.test.mjs tests/demo-engine.test.mjs`
Expected: PASS. The demo units inherit `reviewedPr: null` from the fixture through `structuredClone(template)`. If a demo test fails on `reviewedPr: missing`, add `reviewedPr: null` to the `Object.assign` in `subagentUnit` and `stressUnit` in `server/demo-scenarios.mjs`.

- [ ] **Step 11: Commit**

```bash
git add engine tests/stage.test.mjs tests/swarm.test.mjs tests/contract.test.mjs tests/schema.test.mjs tests/fixtures/example-snapshot.json server/demo-scenarios.mjs
git commit -m "fix(wintermute): reviewers don't own the PR they review; finished closed units are done (#112)"
```

---

### Task 2: History summaries — done count and rebuild under older rules

**Files:**
- Modify: `engine/schema.mjs` (`SUMMARY_RULES`, `RUN_SUMMARY_SPEC`, `RunUnit` and `RunSummary` typedefs)
- Modify: `engine/model/history.mjs:1-3,72-92` (`children.done`, `rules`)
- Modify: `engine/engine.mjs:5,46-69` (`isStale`)
- Test: `tests/history.test.mjs`, `tests/engine.test.mjs`

**Interfaces:**
- Consumes: unit `outcome: 'done'` (Task 1).
- Produces: `SUMMARY_RULES = 2` in `engine/schema.mjs`. `RunSummary.children.done?: number` and `RunSummary.rules?: number` are both optional, so summaries saved before 0.9.4 still validate.

- [ ] **Step 1: Write the failing history tests**

In `tests/history.test.mjs`, change line 5 to `import { SUMMARY_RULES, validateRunSummary } from '../engine/schema.mjs';`. In the first test, change the `summary.children` assertion to:

```js
  assert.deepEqual(summary.children, { total: 7, merged: 2, done: 0, closed: 0, failed: 0, noOutcome: 5 });
```

Append:

```js
test('a run summary counts done units apart from closed ones and records its rules', () => {
  const snapshot = fixture('example-snapshot.json');
  Object.assign(snapshot.units.find(item => item.label === 'D5'), { pr: null, outcome: 'done', closedWithoutMerge: false });
  const summary = summarizeRun(snapshot, { computedAt: COMPUTED });
  assert.deepEqual(validateRunSummary(summary), []);
  assert.deepEqual(summary.children, { total: 7, merged: 2, done: 1, closed: 0, failed: 0, noOutcome: 4 });
  assert.equal(summary.rules, SUMMARY_RULES);
  assert.equal(summary.units.find(item => item.label === 'D5').outcome, 'done');
});

test('a summary saved before done existed still validates', () => {
  const old = summarizeRun(fixture('example-snapshot.json'), { computedAt: COMPUTED });
  delete old.children.done;
  delete old.rules;
  assert.deepEqual(validateRunSummary(old), []);
});
```

Run: `node --test tests/history.test.mjs`
Expected: FAIL. `SUMMARY_RULES` is not exported, and `children` has no `done`.

- [ ] **Step 2: Implement the schema and `summarizeRun` changes**

In `engine/schema.mjs`, below `COST_SOURCE`, add:

```js
/**
 * The rules a run summary was built with. 2 (0.9.4): unit outcome `done`, and reviewers don't own the PR they review
 * (issue #112). A summary without it, or with a lower one, is rebuilt from complete logs (see isStale).
 */
export const SUMMARY_RULES = 2;
```

In `RUN_SUMMARY_SPEC`, change the `children` line to:

```js
  children: { total: is.count, merged: is.count, done: optional(is.count), closed: is.count, failed: is.count, noOutcome: is.count },
```

After `costSource: optional(literal(COST_SOURCE)),`, add `rules: optional(is.count),`.

In the typedefs:
- In `RunUnit`, change `outcome: 'merged'|'closed'|'failed'|null` to `outcome: 'merged'|'closed'|'failed'|'done'|null`.
- Change the `children` property line to `@property {{ total: number, merged: number, done?: number, closed: number, failed: number, noOutcome: number }} children  done: finished work with no PR of its own (absent before 0.9.4); noOutcome: still active, or ended with no PR result known`.
- After the `costSource` property, add `@property {number} [rules]       SUMMARY_RULES when it was built; absent before 0.9.4`.

In `engine/model/history.mjs`, change line 3 to `import { COST_SOURCE, SCHEMA_VERSION, SUMMARY_RULES, validateRunSummary } from '../schema.mjs';`. Change the `children` object to:

```js
    children: {
      total: units.length,
      merged: count(unit => unit.outcome === 'merged'),
      done: count(unit => unit.outcome === 'done'),
      closed: count(unit => unit.outcome === 'closed'),
      failed: count(unit => unit.outcome === 'failed'),
      noOutcome: count(unit => unit.outcome === null),
    },
```

After `costSource: COST_SOURCE,`, add `rules: SUMMARY_RULES,`.

Run: `node --test tests/history.test.mjs`
Expected: PASS.

- [ ] **Step 3: Write the failing engine tests for the rebuild**

In `tests/engine.test.mjs`, change line 9 to `import { SUMMARY_RULES, validateRunListItem, validateRunSummary, validateSnapshot, validateSwarmListItem } from '../engine/schema.mjs';`. After the test `'a summary from session-store.db is kept while a log of its run is missing'`, add:

```js
/** Rewrites the stored summary as 0.9.3 saved it: no rules and no done count. */
function writeOldRulesSummary(stored) {
  const old = readSummary(stored);
  delete old.rules;
  delete old.children.done;
  writeFileSync(stored, `${JSON.stringify(old, null, 2)}\n`);
}

test('a summary saved under older rules is rebuilt from complete logs', async () => {
  const { stored, reopen } = await storedOldRun();
  writeOldRulesSummary(stored);
  const engine = reopen();
  await engine.refresh();
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 1, false], 'listed from the listing until it is rebuilt');
  assert.equal((await engine.getRunSummary('ws-old')).rules, SUMMARY_RULES);
  assert.deepEqual([readSummary(stored).rules, readSummary(stored).children.done], [SUMMARY_RULES, 0], 'the stored summary is replaced');
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 1, true]);
  engine.stop();
});

test('a summary saved under older rules is kept while a log of its run is missing', async () => {
  const { home, stored, reopen } = await storedOldRun();
  writeOldRulesSummary(stored);
  rmSync(path.join(home.stateDir, 'cli-old-child', 'events.jsonl'));
  const before = stat(stored);
  const engine = reopen();
  await engine.refresh();
  assert.deepEqual(await oldItem(engine), [OLD_LAST, 1, true]);
  assert.equal((await engine.getRunSummary('ws-old')).rules, undefined);
  assert.deepEqual(stat(stored), before);
  engine.stop();
});
```

Run: `node --test --test-name-pattern="older rules" tests/engine.test.mjs`
Expected: the first test FAILS (the item is `summarized: true` and the stored summary is not rewritten). The second test passes.

- [ ] **Step 4: Implement `isStale`**

In `engine/engine.mjs`, change line 5 to `import { COST_SOURCE, CREDIT_USD, NANO_AIU_PER_CREDIT, SUMMARY_RULES } from './schema.mjs';`. In `isStale`, after the `oldSource` line, add:

```js
  const oldRules = (stored.rules ?? 1) < SUMMARY_RULES && costsComplete;
```

Change the early return to:

```js
  if (!(oldSource || oldRules || olderWork || swarm.credits > stored.credits || swarm.lastActivityAt > stored.finishedAt + STALE_SLACK_MS)) return false;
```

In the doc comment, change "Complete logs can also correct an older summary downwards: an older cost source (see COST_SOURCE) counted a resumed session's calls again, and a finish time beyond the listing's work time plus the slack can come from app bookkeeping." to "Complete logs can also correct an older summary: an older cost source (see COST_SOURCE) counted a resumed session's calls again, older summary rules (see SUMMARY_RULES) gave outcomes that are wrong today, and a finish time beyond the listing's work time plus the slack can come from app bookkeeping." In the next sentence, change "Both are stale only when" to "Each is stale only when".

- [ ] **Step 5: Run and confirm they pass**

Run: `node --test tests/engine.test.mjs tests/history.test.mjs tests/history-pending.test.mjs tests/schema.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine tests/history.test.mjs tests/engine.test.mjs
git commit -m "fix(wintermute): count done units in run summaries and rebuild summaries saved under older rules (#112)"
```

---

### Task 3: UI words — Finished, card line 2, details, Plan, History, cockpit

**Files:**
- Modify: `shared/unit-state.mjs` (`isFinished`)
- Modify: `ui/model.mjs:153-165,220-224` (`finishedOutcome`, new `reviewsWords`)
- Modify: `ui/live.mjs:1-5,33-41,159-161` (card side, details PR section)
- Modify: `ui/plan.mjs:31-32` (`planLine`)
- Modify: `ui/history.mjs` (the Children line)
- Test: `tests/helpers/ui.mjs`, `tests/ui-model.test.mjs`, `tests/ui-live.test.mjs`, `tests/ui-detail.test.mjs`, `tests/ui-plan.test.mjs`, `tests/ui-history.test.mjs`, `tests/cockpit-model.test.mjs`

**Interfaces:**
- Consumes: `unit.outcome === 'done'` and `unit.reviewedPr` (Task 1), and `run.children.done` (Task 2).
- Produces: `reviewsWords(reviewed: { id: number }): string` in `ui/model.mjs`, which returns `"reviews PR #<id>"`. #111 uses it for the Board.

- [ ] **Step 1: Add the test helper**

Append to `tests/helpers/ui.mjs`:

```js
/** The example with D5 as a finished reviewer: outcome done, no PR of its own, and B1's PR #418 as the one it reviewed. */
export function doneSnapshot() {
  const snapshot = exampleSnapshot();
  const unit = snapshot.units.find(item => item.label === 'D5');
  Object.assign(unit, {
    stage: 'coding', closedWithoutMerge: false, outcome: 'done', endedAt: NOW - 20 * 60000, pr: null,
    reviewedPr: { provider: 'github', id: 418, repo: 'sample-org/sample-repo', url: 'https://github.com/sample-org/sample-repo/pull/418' },
  });
  unit.monitor = { ...unit.monitor, state: 'none', nextCheckAt: null, since: null };
  return snapshot;
}
```

- [ ] **Step 2: Write the failing model tests in `tests/ui-model.test.mjs`**

Add `reviewsWords` to the import list from `'../ui/model.mjs'`, in alphabetical order after `reportTitle`. In the test `'a unit is finished once its work has ended: ...'`, add after the `'PR closed'` assertion:

```js
  assert.equal(isFinished(unitWith({ status: 'busy', statusDetail: 'busy', outcome: 'done' }), none), true, 'done, like closed, even if it turned busy');
```

In the test `'a finished unit reads its outcome and age, ...'`, add after the `'closed, not merged {a}'` assertion:

```js
  assert.deepEqual(outcome({ outcome: 'done' }), ['done {a}', 'ok']);
  assert.deepEqual(outcome({ outcome: 'done', status: 'idle', statusDetail: 'stopped', report: null }), ['done {a}', 'ok'], 'a stopped unit that finished its work');
  assert.equal(finishedOutcome(unitWith({ outcome: 'done', statusDetail: 'stopped', endedAt: NOW - 5000 })).at, NOW - 5000);
```

Append:

```js
test('a reviewed PR reads "reviews PR #<id>"', () => {
  assert.equal(reviewsWords({ provider: 'github', id: 10887, repo: null, url: null }), 'reviews PR #10887');
});
```

Run: `node --test tests/ui-model.test.mjs`
Expected: FAIL. `reviewsWords` is not exported, and a stopped done unit reads `'stopped {a}'`.

- [ ] **Step 3: Implement the model changes**

In `shared/unit-state.mjs`, change `isFinished` to:

```js
/** A unit that goes to the Finished section, unless it has an open question or plan of its own (`asking`). */
export function isFinished(unit, asking) {
  if (asking.has(unit.id)) return false;
  return FINISHED_DETAILS.has(unit.statusDetail) || unit.status === 'merged' || unit.status === 'done' || unit.outcome === 'done'
    || closedNotMerged(unit) || isDone(unit);
}
```

In `ui/model.mjs`, replace the `finishedOutcome` doc comment and function with:

```js
/**
 * A finished unit's outcome in words ({a}: its age) and its tone: ok (green) for merged or done, bad (red) for failed or
 * crashed, off (grey) for stopped, cancelled or closed. Outcome `done` comes before the state words, so a stopped unit that
 * finished its work reads "done". "closed, not merged" only for a unit with a PR of its own.
 */
export function finishedOutcome(unit) {
  if (unit.outcome === 'done') return { words: 'done {a}', tone: 'ok', at: finishedAt(unit) };
  if (closedNotMerged(unit)) return { words: unit.pr ? 'closed, not merged {a}' : 'closed {a}', tone: 'off', at: finishedAt(unit) };
  const [words, tone] = FINISHED_WORDS[unit.statusDetail] ?? (unit.status === 'merged' ? FINISHED_WORDS.merged : FINISHED_WORDS.completed);
  return { words, tone, at: finishedAt(unit) };
}
```

After `prWords`, add:

```js
/** The PR a unit reviews, when its status lines name another unit's PR (issue #112): "reviews PR #10887". */
export const reviewsWords = reviewed => `reviews PR #${reviewed.id}`;
```

Run: `node --test tests/ui-model.test.mjs`
Expected: PASS.

- [ ] **Step 4: Write the failing card, details, Plan, History and cockpit tests**

In `tests/ui-live.test.mjs`, change the helpers import to `import { NOW, closedSnapshot, context, doneSnapshot, exampleSnapshot } from './helpers/ui.mjs';` and append:

```js
test('a finished reviewer, stopped or not, is a Finished mini card that says "done"', () => {
  const snapshot = doneSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { statusDetail: 'stopped', alive: false });
  const html = cardsHtml(open(snapshot));
  assert.match(words(mini(html, 'ws-0007-d5')), /^D5 docs done 20m ago ≈\$31$/);
  assert.match(mini(html, 'ws-0007-d5'), /^tone-ok/);
});

test('an active reviewer\'s card shows the PR it reviews where its own PR would be', () => {
  const snapshot = doneSnapshot();
  Object.assign(findByLabel(snapshot, 'D5'), { outcome: null, endedAt: null, status: 'busy', statusDetail: 'busy' });
  const html = card(cardsHtml(context(snapshot)), 'ws-0007-d5');
  assert.match(html, /<span class="b-pr">reviews PR #418<\/span>/);
  assert.doesNotMatch(html, /PR #421/);
});
```

In `tests/ui-detail.test.mjs`, change the helpers import to `import { closedSnapshot, context, doneSnapshot, exampleSnapshot } from './helpers/ui.mjs';` and append:

```js
test('the detail panel names the PR a reviewer reviews when it has none of its own', () => {
  const words = text(detailHtml('ws-0007-d5', false, context(doneSnapshot())));
  assert.match(words, /PR and monitor Reviews PR #418\. No PR of its own\./);
  assert.doesNotMatch(words, /No PR yet/);
});
```

In `tests/ui-plan.test.mjs`, change the helpers import to `import { NOW, closedSnapshot, context, deepFreeze, doneSnapshot, exampleSnapshot } from './helpers/ui.mjs';` and append:

```js
test('the plan says Done for a unit that finished its work, and closed for a closed unit with no PR', () => {
  const done = doneSnapshot();
  assert.match(node(planGraphHtml(done, NOW), 'D5'), /<div class="pn-2">Done<\/div>/);
  assert.match(node(planListHtml(done, NOW), 'D5'), /<div class="pn-2">Done · on B0<\/div>/);
  assert.doesNotMatch(boardHtml(context(done)), /closed, not merged/);
  const closed = closedSnapshot();
  closed.units.find(unit => unit.label === 'D5').pr = null;
  assert.match(node(planGraphHtml(closed, NOW), 'D5'), /<div class="pn-2"><span class="pr-closed">closed<\/span><\/div>/);
});
```

In `tests/ui-history.test.mjs`, append:

```js
test('the run summary counts done children, and done units are not peach', () => {
  const summary = fixture('example-run-summary.json');
  summary.children = { ...summary.children, closed: 0, done: 1 };
  summary.units[4] = { ...summary.units[4], outcome: 'done' };
  const html = runHtml(summary);
  assert.match(text(html), /Children 4, 3 merged, 1 done Sub-agents/);
  assert.doesNotMatch(html, /g-span no/);
  assert.doesNotMatch(text(html), /not merged/);
});
```

In `tests/cockpit-model.test.mjs`, change the helpers import to `import { NOW, closedSnapshot, deepFreeze, doneSnapshot, exampleSnapshot } from './helpers/ui.mjs';` and append:

```js
test('a done unit\'s tile reads its state, not Closed, and a reviewer has no PR row', () => {
  const done = doneSnapshot();
  const tile = tileGrid(done).tiles.find(item => item.label === 'D5');
  assert.equal(tile.word, tileWord('idle'));
  assert.equal(tileGrid(closedSnapshot()).tiles.find(item => item.label === 'D5').word, 'Closed');
  assert.ok(!prRows(done).rows.some(row => row.unitId === 'ws-0007-d5'));
});
```

In `tests/pr-state.test.mjs`, in the test `'a closed unit shows its outcome on the Board, in Plan and on its cockpit tile, with or without a PR'`, replace `assert.match(row('drop'), /closed, not merged/);` with:

```js
  assert.match(row('drop'), /closed/);
  assert.doesNotMatch(row('drop'), /not merged/, 'Plan says "closed" when there was no PR');
```

Leave the Board assertions in that test as they are: #111 changes the Board.

Run: `node --test tests/ui-live.test.mjs tests/ui-detail.test.mjs tests/ui-plan.test.mjs tests/ui-history.test.mjs tests/cockpit-model.test.mjs tests/pr-state.test.mjs`
Expected: FAIL. The card has no `reviews PR #418`, the details say "No PR yet.", the Plan line reads "Coding · …" and "closed, not merged", and the Children line has no done count. The cockpit test passes already, which confirms that tiles need no change.

- [ ] **Step 5: Implement the UI changes**

In `ui/live.mjs`, add `reviewsWords` to the import from `'./model.mjs'`, in alphabetical order after `reportTitle`. Replace the end of `sideHtml`:

```js
  return unit.pr ? `<span class="b-pr">${esc(prWords(unit.pr))}</span>` : '';
```

with:

```js
  if (unit.pr) return `<span class="b-pr">${esc(prWords(unit.pr))}</span>`;
  return unit.reviewedPr ? `<span class="b-pr">${esc(reviewsWords(unit.reviewedPr))}</span>` : '';
```

Update its doc comment to `/** Line 2's right side: the PR and its state, the PR it reviews, or an orchestrator sub-agent's type. */`.

In `prHtml`, replace `if (!pr) return '<p class="small muted">No PR yet.</p>';` with:

```js
  if (!pr) return unit.reviewedPr ? `<p class="small">Reviews PR #${unit.reviewedPr.id}. No PR of its own.</p>` : '<p class="small muted">No PR yet.</p>';
```

In `ui/plan.mjs` `planLine`, replace:

```js
  if (closedNotMerged(unit)) return `<span class="pr-closed">${unit.pr ? 'PR closed' : 'closed'}, not merged</span>`;
```

with:

```js
  if (unit.outcome === 'done') return 'Done';
  if (closedNotMerged(unit)) return `<span class="pr-closed">${unit.pr ? 'PR closed, not merged' : 'closed'}</span>`;
```

In `ui/history.mjs` `runHtml`, replace:

```js
    + `<div class="kv"><span class="k">Children</span><span class="v">${count(run.children.total)}, ${count(run.children.merged)} merged</span></div>`
```

with:

```js
    + `<div class="kv"><span class="k">Children</span><span class="v">${count(run.children.total)}, ${count(run.children.merged)} merged${run.children.done ? `, ${count(run.children.done)} done` : ''}</span></div>`
```

- [ ] **Step 6: Run the UI tests and confirm they pass**

Run: `node --test tests/ui-*.test.mjs tests/cockpit-*.test.mjs tests/swarm.test.mjs tests/pr-state.test.mjs`
Expected: PASS, including the existing `"closed, not merged"` tests for D5, which still has its own closed PR in `closedSnapshot()`.

- [ ] **Step 7: Commit**

```bash
git add shared ui tests/helpers/ui.mjs tests/ui-model.test.mjs tests/ui-live.test.mjs tests/ui-detail.test.mjs tests/ui-plan.test.mjs tests/ui-history.test.mjs tests/cockpit-model.test.mjs tests/pr-state.test.mjs
git commit -m "fix(wintermute): show done units as done and name the PR a reviewer reviews (#112)"
```

---

### Task 4: Demo, docs, release and real-data check

**Files:**
- Modify: `server/demo-scenarios.mjs:8-31,156-170` (add V2, a done reviewer)
- Modify: `tests/demo-engine.test.mjs:140,176-177`
- Modify: `README.md:65,121`
- Modify: `docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md` (section 9 call 13, section 11 PRs)
- Modify: `plugin.json`, `package.json`, `.github/plugin/marketplace.json` (via `npm run release:bump`), `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing demo test**

In `tests/demo-engine.test.mjs`, change `[22, 30]` to `[23, 30]` on line 140. Replace lines 176-177 with:

```js
  const outcomes = new Set(finished.map(unit => (unit.outcome === 'done' ? 'done' : unit.closedWithoutMerge ? (unit.pr ? 'closed, not merged' : 'closed') : unit.statusDetail)));
  for (const outcome of ['idle', 'stopped', 'merged', 'completed', 'failed', 'crashed', 'cancelled', 'closed', 'closed, not merged', 'done']) assert.ok(outcomes.has(outcome), outcome);
  const v2 = label(stress, 'V2');
  assert.deepEqual([v2.outcome, v2.closedWithoutMerge, v2.pr, v2.reviewedPr.id], ['done', false, null, label(stress, 'P4').pr.id]);
```

Run: `node --test tests/demo-engine.test.mjs`
Expected: FAIL (22 session units, and no `done` outcome).

- [ ] **Step 2: Add V2 to the stress demo**

In `server/demo-scenarios.mjs`, add after the `G4` entry in `EXTRA`:

```js
  { label: 'V2', name: 'review of the paused monitor PR', status: 'idle', statusDetail: 'stopped', bucket: 'idle', alive: false, outcome: 'done', reportStatus: 'complete', reviews: 'P4' },
```

In the `EXTRA` doc comment, change "J8 closed with no PR and T0 stopped with no outcome" to "J8 closed with no PR, T0 stopped with no outcome and V2 is done after reviewing P4's PR".

In `stressUnit`, after `unit.monitor = monitorFor(spec, stage, t);`, add:

```js
  const reviewed = spec.reviews ? EXTRA.findIndex(entry => entry.label === spec.reviews) : -1;
  unit.reviewedPr = reviewed < 0 ? null : { provider: 'github', id: 500 + reviewed, repo: 'sample-org/sample-repo', url: `https://github.com/sample-org/sample-repo/pull/${500 + reviewed}` };
```

(`stressUnit` numbers its PRs `500 + index` by `EXTRA` position, so this is P4's PR.)

Run: `node --test tests/demo-engine.test.mjs`
Expected: PASS.

- [ ] **Step 3: Update the docs**

In `README.md` line 65, change "its state in words, and its PR or, for one of the orchestrator's sub-agents, its type." to "its state in words, and its PR, the PR it reviews ("reviews PR #418") when it has none of its own, or, for one of the orchestrator's sub-agents, its type." On line 121, change "Finished includes stopped, merged, completed, failed, crashed, cancelled or closed work," to "Finished includes stopped, merged, completed, done, failed, crashed, cancelled or closed work (done: the orchestrator closed it after a complete report, and it has no PR of its own),".

In `docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md`, section 9, call 13, replace "a closed or failed unit stays in its PR stage (Coding without a PR); a closed one, with or without a PR, shows the \"closed, not merged\" badge on the Board and in Plan and reads \"Closed\" on its cockpit tile." with:

"a closed or failed unit stays in its PR stage (Coding without a PR). A registry `closed` unit with no PR of its own and a `complete` latest report has finished its work: the snapshot gives it outcome `done` (issue #112), with `closedWithoutMerge` false, so it is placed like a unit with no outcome and reads \"done\" in Finished and \"Done\" in Plan. Any other closed unit shows \"closed, not merged\" with a PR of its own, or \"closed\" without one, and reads \"Closed\" on its cockpit tile. Run summaries count `done` apart from `closed`."

In section 11, after the "PRs:" bullet, add:

"- Reviewed PRs: review and claims-check children name the PR under review in `pr=`. A status-line PR that the registry records for another unit is therefore that unit's PR, not this one's. The dashboard keeps it as `reviewedPr` (\"reviews PR #…\") and leaves `pr` empty (issue #112). A status-line PR that no other unit records stays the unit's own."

- [ ] **Step 4: Bump the version and write the CHANGELOG entry**

Run: `npm run release:bump -- patch`
Expected: `Wintermute 0.9.4: updated all three versions. Finish CHANGELOG.md before publishing.`

In `CHANGELOG.md`, replace the TODO under `## 0.9.4 — 2026-11-10` with:

```markdown
### Fixed

- Finished reviewers, claims checks, research and one-off jobs read as "done", not "closed" or "closed, not merged" (#112). A registry `closed` unit with no PR of its own and a complete latest report gets the new outcome `done`: "done" in Finished, even when it stopped, and "Done" in Plan. History counts it apart from closed units and doesn't mark it in peach. Other closed units read "closed, not merged" with a PR of their own and "closed" without one, in Plan too.
- A unit no longer owns a PR that its status lines name when the registry records that PR for another unit, as a reviewer's do. Its `pr` is empty, the new snapshot field `reviewedPr` holds the PR, and its card and details say "reviews PR #…". It no longer counts as in review. A status-line PR that no other unit records is still the unit's own.
- Run summaries record the rules they were built with. Summaries saved before 0.9.4 are rebuilt when every log of the run can be read; the others are kept as they are.
```

- [ ] **Step 5: Run the full checks**

Run: `npm test && npm run validate && npm run check:layout`
Expected: every test passes, validate reports no problems, and `check:layout` reports 0 issues for every view and cockpit state.

- [ ] **Step 6: Check C5 on real data**

Run:

```bash
node scripts/swarm-snapshot.mjs --swarm 8a7ef112-d37f-46ad-80fc-c3e19130d0b6 --no-pr-lookup --compact > /tmp/c5-after.json && node -e '
const s = require("/tmp/c5-after.json");
const ended = s.units.filter(u => u.outcome === "done" || u.outcome === "closed");
const by = {};
for (const u of ended) { const k = `${u.outcome}/${u.pr ? "own PR" : "no PR"}/${u.reviewedPr ? "reviews" : "-"}`; by[k] = (by[k] || 0) + 1; }
console.log(by);'
```

Expected: no `closed/no PR` units with a complete latest report. Every unit that showed `closed` before has become `done`, apart from units with their own registry PR (1 on 2026-11-10). About 35 `done` units have `reviews` set. Before the fix, the counts were: 66 closed, of which 30 had no PR, 35 held another unit's PR, and 1 had its own registry PR. Report the actual counts.

- [ ] **Step 7: Commit**

```bash
git add server/demo-scenarios.mjs tests/demo-engine.test.mjs README.md CHANGELOG.md plugin.json package.json ../../../.github/plugin/marketplace.json ../../../docs/superpowers/specs/2026-10-15-swarm-dashboard-design.md
git commit -m "wintermute 0.9.4: done outcome and reviewed PRs (#112)"
```
