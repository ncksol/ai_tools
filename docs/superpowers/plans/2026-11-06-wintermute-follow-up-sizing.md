# wintermute follow-up sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both wintermute orchestrators size every follow-up job (fix, reviewer re-check, panel re-check, claims check, rebase) by its own scope and risk, with a Light review row and a narrow "no separate claims check" case for mechanical follow-ups.

**Architecture:** The deliverables are prompt text in two agent files plus static prompt tests. One new shared bullet, "Follow-up jobs", in "Evidence and review" holds the rule; the existing rules it governs are reworded to point to it. Shared text stays word for word identical in both files, and the tests enforce that.

**Tech Stack:** Markdown agent prompts; Node 18 `node:test` static tests; the plugin's `release:bump` and `validate` scripts.

**Spec:** `docs/superpowers/specs/2026-11-06-wintermute-follow-up-sizing-design.md`

## Global Constraints

- Shared passages in `hands-on-orchestrator.agent.md` and `hands-on-session-orchestrator.agent.md` stay word for word the same. The "Quick jobs you do yourself" section is not touched.
- Worker agents (`session-worker.agent.md`, `orchestrator-worker.agent.md`) and `.github/copilot-instructions.md` are not changed.
- Node 18 compatible: no `t.after`/`t.before` in tests; no npm dependencies.
- Version 0.6.0 → 0.7.0 in `plugin.json`, `package.json` and the root `.github/plugin/marketplace.json`, via `npm run release:bump -- minor`, with a finished `CHANGELOG.md` section.
- `npm test && npm run validate` pass from `ghcp/plugins/wintermute/`.
- Commits carry no `Co-authored-by` trailers or other AI attribution.
- Plain English, roughly B2 level, matching the prompts' existing style.

## File structure

All paths are under `ghcp/plugins/wintermute/` unless they start with `.github/`.

- Modify `com.github.copilot/agents/hands-on-session-orchestrator.agent.md`: the follow-up rule, its pointers, the Light review row and the claims checker reuse.
- Modify `com.github.copilot/agents/hands-on-orchestrator.agent.md`: the same edits, adapted only where sub-agents differ from sessions.
- Modify `tests/agent-prompts.test.mjs`: update the assertions whose wording changes, add assertions for the new rule.
- Modify `plugin.json`, `package.json`, `.github/plugin/marketplace.json`, `CHANGELOG.md`: release 0.7.0.

---

### Task 1: The follow-up rule in both orchestrators, with its tests

**Files:**
- Modify: `ghcp/plugins/wintermute/tests/agent-prompts.test.mjs`
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-session-orchestrator.agent.md` (lines 61, 73, 115, 138–139, 144, 149, 308, 310, 335, 336 at commit `f7c2cac`)
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-orchestrator.agent.md` (lines 61, 73, 123–124, 129, 135, 298, 300, 325, 326 at commit `f7c2cac`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the "Follow-up jobs" bullet, the Light review row and the pointer sentences below, which Task 2's CHANGELOG entry describes.

- [ ] **Step 1: Update the existing test constants**

In `tests/agent-prompts.test.mjs`, replace the second line of the `ROUTING` array:

Old:
```js
  '  - Every claims check goes to a new claims checker at the claims check row, with its model and effort set explicitly. This includes a request to refresh earlier claims, and the claims check of your own unit. Never give a claims check to a reviewer, a judge or any other agent because it already has the context, and never give a claims checker a reviewer\'s model or effort. A model or effort the user named for claims checks overrides the row.',
```

New:
```js
  '  - Every claims check goes to a claims checker at the claims check row, with its model and effort set explicitly: a new one, or the unit\'s idle claims checker from an earlier check of the same unit, which checks the new head from its own fresh fetch. This includes a request to refresh earlier claims, and the claims check of your own unit. Never give a claims check to a reviewer, a judge or any other agent because it already has the context, and never give a claims checker a reviewer\'s model or effort. A model or effort the user named for claims checks overrides the row.',
```

Replace `REUSE_CLAUSE` and `RECHECK_CLAUSE`:

Old:
```js
const REUSE_CLAUSE = 'A claims check never goes to an idle agent because it has the context: start a new claims checker (see "Claims check" in "Evidence and review").';
const RECHECK_CLAUSE = 'A re-check covers only the review of the new diff: the claims check for the new commit goes to a new claims checker (see "Claims check").';
```

New:
```js
const REUSE_CLAUSE = 'A claims check goes only to a claims checker, never to another idle agent because it has the context: start a new one, or use the unit\'s idle claims checker (see "Claims check" in "Evidence and review").';
const RECHECK_CLAUSE = 'A re-check covers only the review of the new diff: the claims check for the new commit goes to a claims checker (see "Claims check"), unless "Follow-up jobs" lets you skip it.';
```

In the test `'the claims check row keeps its models and is no longer called a review row'`, replace:

Old:
```js
    assert.doesNotMatch(text, /last five rows are review rows/, name);
```

New:
```js
    assert.ok(text.includes('- The last five rows are review rows. The claims check row above them is a check, not a review row.'), `${name}: review rows counted without the claims check row`);
```

- [ ] **Step 2: Append the new tests**

Append to the end of `tests/agent-prompts.test.mjs`:

```js
const LIGHT_ROW = '| Light review | Sol at `high`, Sonnet at `xhigh` or Argon at `high`, never from the author\'s vendor | The review of a small follow-up with real logic that meets no critical-unit trigger (see "Follow-up jobs" in "Evidence and review"). Never a unit\'s first review. |';
const FOLLOW_UP_TIER_LINE = '- A follow-up job gets the tier or review row that fits its own scope and risk, not the unit\'s (see "Follow-up jobs" in "Evidence and review"). A small fix in a critical unit doesn\'t get the critical review row, and a risky follow-up in a regular unit can.';
const CRITICAL_POINTER = 'Size each follow-up job on its own (see "Follow-up jobs" in "Evidence and review"): a critical unit\'s follow-ups aren\'t critical by default, and a follow-up that meets a trigger gets critical scrutiny even in a regular unit.';
const CLAIMS_EXCEPTION = 'A follow-up commit may skip its claims check only as "Follow-up jobs" allows.';
const FINDINGS_POINTER = 'That PR is a follow-up: "Follow-up jobs" decides its review, its claims check and whether the panel re-checks it.';

const followUpRule = text => {
  const start = text.indexOf('\n- **Follow-up jobs**:');
  const end = text.indexOf('\n- **Re-checks**:', start);
  return start >= 0 && end > start ? text.slice(start + 1, end) : null;
};

test('both orchestrators have the same Follow-up jobs rule, just before Re-checks', () => {
  const rules = ORCHESTRATORS.map(name => followUpRule(agent(name)));
  for (const [i, rule] of rules.entries()) {
    assert.ok(rule, `${ORCHESTRATORS[i]}: rule before Re-checks`);
    assert.equal(rule.split('\n').filter(l => l.startsWith('- ')).length, 1, `${ORCHESTRATORS[i]}: rule is the bullet right before Re-checks`);
  }
  assert.equal(rules[0], rules[1]);
});

test('the follow-up rule covers every follow-up type, both directions, its safeguards and the recorded reason', () => {
  const rule = followUpRule(agent('hands-on-session-orchestrator'));
  for (const phrase of [
    'fixes, reviewer re-checks, panel re-checks, claims checks and rebases, and any other later job',
    'A follow-up doesn\'t inherit the unit\'s tier, review rows, number of reviewers or critical status.',
    'The owner\'s description alone is not enough to lower the scrutiny',
    'needs no reviewer re-check',
    'gets at most one reviewer',
    'start one at the light review row',
    'gets a critical review of the change',
    'gets more scrutiny than the unit had',
    'The vendor rule, security routing, the claims check rules, required human or project reviews and the user\'s explicit choices apply at whatever level you choose.',
    'Lower the scrutiny only on evidence you state. If unsure, choose the higher level.',
    'in the unit\'s `child_notes` row, or in `own_units` for your own unit',
  ]) assert.ok(rule.includes(phrase), phrase);
});

test('a follow-up skips its claims check only after an earlier pass, on a mechanical diff, with a test job that ran at the exact head', () => {
  const rule = followUpRule(agent('hands-on-session-orchestrator'));
  for (const phrase of [
    'an earlier claims check passed for this unit',
    'touches no build, CI or test configuration and removes or skips no tests',
    'CI\'s test job ran at the exact new head commit and passed, not skipped',
    'Read that CI result yourself as a quick job; this read is not a claims check.',
    'Otherwise the claims check runs.',
  ]) assert.ok(rule.includes(phrase), phrase);
});

test('the light review row sits between the claims check and regular review rows in both orchestrators', () => {
  for (const name of ORCHESTRATORS) {
    const lines = agent(name).split('\n');
    const at = lines.indexOf(CLAIMS_ROW);
    assert.ok(at >= 0, `${name}: claims row`);
    assert.equal(lines[at + 1], LIGHT_ROW, `${name}: light row follows the claims row`);
    assert.ok(lines[at + 2].startsWith('| Regular review |'), `${name}: regular row follows the light row`);
  }
});

test('the rules that follow-ups touch point to Follow-up jobs in both orchestrators', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    const line = start => text.split('\n').find(l => l.startsWith(start)) ?? '';
    assert.ok(line('- **Re-checks**').includes('gets the scrutiny that "Follow-up jobs" sizes for it'), `${name}: re-checks`);
    assert.ok(line('- **Re-checks**').includes('and only when it can affect how units work together or the spec as a whole'), `${name}: panel re-check`);
    assert.ok(line('  Record a one-line reason in the unit').includes(CRITICAL_POINTER), `${name}: critical units`);
    assert.ok(line('- **Claims check**').includes(CLAIMS_EXCEPTION), `${name}: claims check`);
    assert.ok(text.includes(FOLLOW_UP_TIER_LINE), `${name}: models and effort`);
    assert.ok(text.includes(FINDINGS_POINTER), `${name}: fix PR for a panel finding`);
    assert.doesNotMatch(text, /goes back to the same reviewer/, `${name}: old re-check rule removed`);
  }
});

test('each orchestrator keeps a unit\'s claims checker for its later claims checks', () => {
  assert.ok(agent('hands-on-orchestrator').includes('Run it as a one-off, read-only sub-agent. Start it with `mode: "background"`, so that it can take the unit\'s later claims checks.'));
  assert.ok(agent('hands-on-session-orchestrator').includes('created with `base_branch` set to that branch. Keep it until the unit merges, so that it can take the unit\'s later claims checks.'));
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run from `ghcp/plugins/wintermute/`: `node --test tests/agent-prompts.test.mjs`
Expected: FAIL. The failing tests are `both orchestrators have the same claims routing rule under the Claims check bullet`, `reuse of idle agents and re-checks exclude claims checks`, `the claims check row keeps its models and is no longer called a review row`, and all six new tests. The other existing tests pass.

- [ ] **Step 4: Edit `hands-on-session-orchestrator.agent.md`**

Make these edits in `com.github.copilot/agents/hands-on-session-orchestrator.agent.md`.

4a. "Plan by stage" → "Critical units", line 61. Replace:
```
A unit raised after its regular review also gets a critical review.
```
with:
```
A unit raised after its regular review also gets a critical review. Size each follow-up job on its own (see "Follow-up jobs" in "Evidence and review"): a critical unit's follow-ups aren't critical by default, and a follow-up that meets a trigger gets critical scrutiny even in a regular unit.
```

4b. Two occurrences: "Split work for speed" (line 73) and "Helper requests" step 4 (line 115). In each, replace:
```
A claims check never goes to an idle agent because it has the context: start a new claims checker (see "Claims check" in "Evidence and review").
```
with:
```
A claims check goes only to a claims checker, never to another idle agent because it has the context: start a new one, or use the unit's idle claims checker (see "Claims check" in "Evidence and review").
```

4c. "Models and effort" table: insert this line between the `| Claims check |` row (line 138) and the `| Regular review |` row (line 139):
```
| Light review | Sol at `high`, Sonnet at `xhigh` or Argon at `high`, never from the author's vendor | The review of a small follow-up with real logic that meets no critical-unit trigger (see "Follow-up jobs" in "Evidence and review"). Never a unit's first review. |
```

4d. Line 144. Replace:
```
- The last four rows are review rows.
```
with:
```
- The last five rows are review rows.
```

4e. Insert this new bullet directly after the bullet that starts `- A child session gets the tier of the work it owns.` (line 149), before `- A second opinion runs at Max`:
```
- A follow-up job gets the tier or review row that fits its own scope and risk, not the unit's (see "Follow-up jobs" in "Evidence and review"). A small fix in a critical unit doesn't get the critical review row, and a risky follow-up in a regular unit can.
```

4f. "Evidence and review" → "Claims check" bullet, line 308. Replace:
```
Run it as a one-off, read-only session, created with `base_branch` set to that branch.
```
with:
```
Run it as a one-off, read-only session, created with `base_branch` set to that branch. Keep it until the unit merges, so that it can take the unit's later claims checks.
```
In the same bullet, replace:
```
If it cannot reach that commit, report the claim as unverified.
```
with:
```
If it cannot reach that commit, report the claim as unverified. A follow-up commit may skip its claims check only as "Follow-up jobs" allows.
```

4g. The routing sub-bullet under "Claims check", line 310. Replace:
```
  - Every claims check goes to a new claims checker at the claims check row, with its model and effort set explicitly. This includes
```
with:
```
  - Every claims check goes to a claims checker at the claims check row, with its model and effort set explicitly: a new one, or the unit's idle claims checker from an earlier check of the same unit, which checks the new head from its own fresh fetch. This includes
```

4h. "Findings", line 335. Replace:
```
That PR gets its own review, and the panel then re-checks the difference.
```
with:
```
That PR is a follow-up: "Follow-up jobs" decides its review, its claims check and whether the panel re-checks it.
```

4i. Replace the whole "Re-checks" line (line 336):
```
- **Re-checks**: new code after a review, such as a fix or added scope, goes back to the same reviewer, who checks only the new diff. A re-check covers only the review of the new diff: the claims check for the new commit goes to a new claims checker (see "Claims check"). Send it as a follow-up to the reviewer's idle session. A running reviewer's model can't change, so a re-check at a different review row needs a new reviewer. If the last PR changes after the panel, by a fix or by a rebase because something else merged first, the panel re-checks only the new difference. Otherwise, a rebase that adds no new code needs only the claims check.
```
with these lines (the new "Follow-up jobs" bullet, then the new "Re-checks" bullet):
```
- **Follow-up jobs**: size every job that follows earlier work on a unit by its own scope and risk, as you sized the unit when you planned it. This covers fixes, reviewer re-checks, panel re-checks, claims checks and rebases, and any other later job. A follow-up doesn't inherit the unit's tier, review rows, number of reviewers or critical status.
  - Size it from the diff at the pushed commit, read as a quick job from the PR or the pushed branch: the files, the line counts and the change itself, together with the owner's test and CI evidence. The owner's description alone is not enough to lower the scrutiny, and a diff you can't read within a quick job is not mechanical.
  - Use the inputs you use when you plan: how big the change is; what it touches, including stored data and the triggers under "Critical units" in "Plan by stage"; how well tests and CI cover it; and how much judgement it needs.
  - A mechanical change that tests and CI fully cover needs no reviewer re-check: for example a rename, removing dead code or an unused parameter, a test-only change that removes or weakens no test, a documentation change, or a rebase with no new code and no conflicts resolved by hand. It needs no separate claims check either when all of these hold: an earlier claims check passed for this unit; the change since that check touches no build, CI or test configuration and removes or skips no tests; and CI's test job ran at the exact new head commit and passed, not skipped. Read that CI result yourself as a quick job; this read is not a claims check. Otherwise the claims check runs.
  - A small change with real logic that meets no critical-unit trigger gets at most one reviewer. Use the unit's idle reviewer that has the context, unless it is Astra, whose re-reads cost the most; then, or when no reviewer is idle, start one at the light review row. After the final panel, that one reviewer is the unit's reviewer for a change inside the unit, or one judge for a change to how units work together.
  - A change that is significant in its own right gets the unit's original reviewers. A change that meets a critical-unit trigger gets a critical review of the change, routed as "Security review" says for security, authentication or secrets. A follow-up that is larger or riskier than the unit gets more scrutiny than the unit had.
  - A rebase onto code that merged since the last review, or one with conflicts resolved by hand, is sized by what merged or by what the resolution changed.
  - When a follow-up needs no re-check or no separate claims check, the earlier verdict stands for the new head.
  - The vendor rule, security routing, the claims check rules, required human or project reviews and the user's explicit choices apply at whatever level you choose. Lower the scrutiny only on evidence you state. If unsure, choose the higher level.
  - Record one line for each follow-up in the unit's `child_notes` row, or in `own_units` for your own unit: the commit, the scope, the risk and the scrutiny you chose, and the CI run when you skip a separate claims check.
- **Re-checks**: new code after a review, such as a fix or added scope, gets the scrutiny that "Follow-up jobs" sizes for it, from no re-check up to the unit's original reviewers or more. A reviewer who re-checks it checks only the new diff. A re-check covers only the review of the new diff: the claims check for the new commit goes to a claims checker (see "Claims check"), unless "Follow-up jobs" lets you skip it. Send a re-check to the reviewer's idle session when that reviewer fits the level. A running reviewer's model can't change, so a re-check at a different review row needs a new reviewer. If the last PR changes after the panel, by a fix or by a rebase because something else merged first, the judges re-check only the new difference, and only when it can affect how units work together or the spec as a whole; "Follow-up jobs" decides whether that takes one judge or both.
```

- [ ] **Step 5: Edit `hands-on-orchestrator.agent.md`**

Make these edits in `com.github.copilot/agents/hands-on-orchestrator.agent.md`. Text marked "same as 4x" must be copied byte for byte from Step 4.

5a. Line 61: the same replacement as 4a.

5b. "Split work for speed", line 73 (one occurrence in this file): the same replacement as 4b.

5c. Insert the Light review row between the `| Claims check |` row (line 123) and the `| Regular review |` row (line 124): the same line as 4c.

5d. Line 129: the same replacement as 4d.

5e. Insert the 4e bullet directly after the bullet that starts `- A sub-agent gets the tier or review row of its job:` (line 135), before `- A second opinion runs at Max`.

5f. "Claims check" bullet, line 298. Replace:
```
Run it as a one-off, read-only sub-agent.
```
with:
```
Run it as a one-off, read-only sub-agent. Start it with `mode: "background"`, so that it can take the unit's later claims checks.
```
In the same bullet, the same `If it cannot reach that commit…` replacement as 4f.

5g. Routing sub-bullet, line 300: the same replacement as 4g.

5h. "Findings", line 325: the same replacement as 4h.

5i. Replace the whole "Re-checks" line (line 326):
```
- **Re-checks**: new code after a review, such as a fix or added scope, goes back to the same reviewer, who checks only the new diff. A re-check covers only the review of the new diff: the claims check for the new commit goes to a new claims checker (see "Claims check"). Send it to the same worker with `write_agent`. A running reviewer's model can't change, so a re-check at a different review row needs a new reviewer. If the last PR changes after the panel, by a fix or by a rebase because something else merged first, the panel re-checks only the new difference. Otherwise, a rebase that adds no new code needs only the claims check.
```
with the same "Follow-up jobs" bullet as 4i, byte for byte, followed by this "Re-checks" bullet. It differs from 4i only in the sentence about where to send the re-check:
```
- **Re-checks**: new code after a review, such as a fix or added scope, gets the scrutiny that "Follow-up jobs" sizes for it, from no re-check up to the unit's original reviewers or more. A reviewer who re-checks it checks only the new diff. A re-check covers only the review of the new diff: the claims check for the new commit goes to a claims checker (see "Claims check"), unless "Follow-up jobs" lets you skip it. Send a re-check to the reviewer's worker with `write_agent` when that reviewer fits the level. A running reviewer's model can't change, so a re-check at a different review row needs a new reviewer. If the last PR changes after the panel, by a fix or by a rebase because something else merged first, the judges re-check only the new difference, and only when it can affect how units work together or the spec as a whole; "Follow-up jobs" decides whether that takes one judge or both.
```

- [ ] **Step 6: Run the tests to see them pass**

Run from `ghcp/plugins/wintermute/`: `npm test`
Expected: PASS, 0 failures.

Then confirm that the two files still differ only on the lines that differed before. Every changed line was either shared before and stays shared, or already differed (the "Claims check" and "Re-checks" bullets), so the number of differing lines must not change. Run from the repository root:

```bash
A=ghcp/plugins/wintermute/com.github.copilot/agents
before=$(diff <(git show f7c2cac:$A/hands-on-session-orchestrator.agent.md) <(git show f7c2cac:$A/hands-on-orchestrator.agent.md) | grep -c '^[<>]')
after=$(diff $A/hands-on-session-orchestrator.agent.md $A/hands-on-orchestrator.agent.md | grep -c '^[<>]')
echo "$before $after"
```
Expected: the two numbers are equal. A larger second number means shared text has drifted; find and fix the difference.

- [ ] **Step 7: Commit**

```bash
git add ghcp/plugins/wintermute/tests/agent-prompts.test.mjs ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-session-orchestrator.agent.md ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-orchestrator.agent.md
git commit -m "feat(wintermute): size follow-up work by its own scope (#100)"
```

---

### Task 2: Release 0.7.0

**Files:**
- Modify: `ghcp/plugins/wintermute/plugin.json`, `ghcp/plugins/wintermute/package.json`, `.github/plugin/marketplace.json` (by script)
- Modify: `ghcp/plugins/wintermute/CHANGELOG.md`

**Interfaces:**
- Consumes: the rule names and wording from Task 1 ("Follow-up jobs", Light review row).
- Produces: version 0.7.0 in all three files and a finished `## 0.7.0 — <date>` CHANGELOG section.

- [ ] **Step 1: Bump the version**

Run from `ghcp/plugins/wintermute/`: `npm run release:bump -- minor`
Expected: `Wintermute 0.7.0: updated all three versions. Finish CHANGELOG.md before publishing.` `CHANGELOG.md` now has a `## 0.7.0 — <today>` section containing `- TODO: Describe this release.`

- [ ] **Step 2: Write the release notes**

In `CHANGELOG.md`, replace the line `- TODO: Describe this release.` under the 0.7.0 heading with:

```markdown
### Changed

- Follow-up work is sized on its own. `hands-on-orchestrator` and `hands-on-session-orchestrator` have a new "Follow-up jobs" rule in "Evidence and review". Every fix, reviewer re-check, panel re-check, claims check and rebase is sized from the diff at the pushed commit and the owner's test and CI evidence, with the same inputs as planning. It no longer inherits the unit's tier, review rows, reviewer count or critical status. A mechanical change that tests and CI fully cover needs no reviewer re-check. A small change with real logic gets at most one reviewer. A significant change gets the unit's original reviewers, and a change that meets a critical-unit trigger gets a critical review, even in a regular unit. Lower scrutiny needs evidence the orchestrator states; if unsure, it chooses the higher level, and it records one line for each follow-up.
- A mechanical follow-up may skip its separate claims check when an earlier claims check passed for the unit, the change touches no build, CI or test configuration and removes or skips no tests, and CI's test job ran and passed at the exact new head. The orchestrator reads that CI result itself and records it. A unit's first claims check and the claims check on `main` after the last merge always run.
- A new Light review row (Sol at `high`, Sonnet at `xhigh` or Argon at `high`, never from the author's vendor) is only for small follow-ups with real logic and no critical-unit trigger, never for a unit's first review.
- A claims check may go to the unit's own idle claims checker from an earlier check, which the orchestrator now keeps until the unit merges. A claims check still never goes to a reviewer, a judge or any other agent.
- "Re-checks", "Critical units", the fix PR for a panel finding and "Models and effort" point to the new rule. After the final panel, the judges re-check a change only when it can affect how units work together or the spec as a whole.

### Upgrading

- Running sessions keep the prompts they started with.
```

- [ ] **Step 3: Run the tests and the validator**

Run from `ghcp/plugins/wintermute/`: `npm test && npm run validate`
Expected: all tests pass; the validator reports success with version 0.7.0 consistent across `plugin.json`, `package.json` and the marketplace entry, and a finished CHANGELOG section.

- [ ] **Step 4: Commit**

```bash
git add ghcp/plugins/wintermute/plugin.json ghcp/plugins/wintermute/package.json .github/plugin/marketplace.json ghcp/plugins/wintermute/CHANGELOG.md
git commit -m "chore(wintermute): release 0.7.0 (#100)"
```
