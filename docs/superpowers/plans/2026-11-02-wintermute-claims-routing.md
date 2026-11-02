# wintermute claims-check routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both wintermute orchestrators send every claims check to its own new claims checker at the Claims check row, never to a reviewer, and make workers hand a misrouted claims job back.

**Architecture:** Prompt-only change. The "Claims check" bullet in "Evidence and review" gets sub-bullets that form the single routing rule, word for word the same in both orchestrators. Short clauses at each place where the orchestrator reuses an idle agent point to that rule. Each worker gets one bullet for a misrouted claims job. Static prompt tests pin the text.

**Tech Stack:** Markdown agent prompts; Node 18 `node:test` tests.

**Spec:** `docs/superpowers/specs/2026-11-02-wintermute-claims-routing-design.md`

## Global Constraints

- Shared passages in `hands-on-orchestrator.agent.md` and `hands-on-session-orchestrator.agent.md` stay word for word the same.
- The report block in `hands-on-session-orchestrator` stays identical to `session-worker`'s. Don't touch it.
- Node 18 compatible: no `t.after`/`t.before` in tests (`tests/guards.test.mjs` enforces this).
- Version 0.5.0 → 0.6.0 via `npm run release:bump -- minor`, plus CHANGELOG notes.
- Run everything from `ghcp/plugins/wintermute/`. Final check: `npm test && npm run validate`.
- No `Co-authored-by` trailers in commits.
- Agent folder below: `A=ghcp/plugins/wintermute/com.github.copilot/agents`.

---

### Task 1: Orchestrator routing rule

**Files:**
- Modify: `$A/hands-on-orchestrator.agent.md` (lines 44, 73, 129, 135, 298, 321)
- Modify: `$A/hands-on-session-orchestrator.agent.md` (lines 44, 73, 115, 144, 149, 308, 331)
- Test: `ghcp/plugins/wintermute/tests/agent-prompts.test.mjs`

**Interfaces:**
- Produces: the constants `ROUTING`, `REUSE_CLAUSE`, `RECHECK_CLAUSE`, `OWN_UNIT_LINE`, `CLAIMS_ROW` in the test file. Task 2 adds its own constants next to them.

- [ ] **Step 1: Write the failing tests.** Append to `tests/agent-prompts.test.mjs`:

```js
const ROUTING = [
  '  - Before you choose who does a job, decide whether it is a review or a claims check. A review looks for defects. A claims check confirms what the owner says it delivered, at the pushed commit; the owner\'s own report is not that proof. If a request asks for both, such as "re-check the fix and refresh the test claims", split it into two jobs: the review part goes to its reviewer, and the claims part goes to a claims checker.',
  '  - Every claims check goes to a new claims checker at the claims check row, with its model and effort set explicitly. This includes a request to refresh earlier claims, and the claims check of your own unit. Never give a claims check to a reviewer, a judge or any other agent because it already has the context, and never give a claims checker a reviewer\'s model or effort. A model or effort the user named for claims checks overrides the row.',
  '  - The claims check brief gives the scope to check, the repo, the branch, the exact pushed head commit, the target or base branch, and the evidence to send back: the tests run at that commit with their counts, CI at that commit, and the scope compared with the brief.',
  '  - A review brief covers only the review. The reviewer may still run tests, read CI or reproduce a failure when it needs that to establish a finding. Those results don\'t count as the claims check.',
  '  - If a reviewer reports that it was sent a claims job, start a claims checker for it. Don\'t count the check as done or as not needed.',
].join('\n');
const REUSE_CLAUSE = 'A claims check never goes to an idle agent because it has the context: start a new claims checker (see "Claims check" in "Evidence and review").';
const RECHECK_CLAUSE = 'A re-check covers only the review of the new diff: the claims check for the new commit goes to a new claims checker (see "Claims check").';
const OWN_UNIT_LINE = '- Start its claims check and its regular or critical review yourself, as separate jobs, as you would for a child\'s unit (see "Evidence and review").';
const CLAIMS_ROW = '| Claims check | Sol at `medium`; Opus at `low` if Sol isn\'t listed | The check before every merge, publish and "done". A check, not a review. |';

test('both orchestrators have the same claims routing rule under the Claims check bullet', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    const at = text.indexOf('- **Claims check**:');
    assert.ok(at >= 0, `${name}: claims bullet`);
    const bulletEnd = text.indexOf('\n', at);
    assert.equal(text.slice(bulletEnd + 1, bulletEnd + 1 + ROUTING.length), ROUTING, `${name}: routing follows the bullet`);
  }
});

test('combined review-and-claims requests are split, and claims refreshes and own units get a new checker', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    assert.match(text, /split it into two jobs/, name);
    assert.match(text, /a request to refresh earlier claims, and the claims check of your own unit/, name);
    assert.ok(text.includes(OWN_UNIT_LINE), `${name}: own-unit line`);
  }
});

test('each orchestrator runs the claims checker as its own delegation type', () => {
  assert.ok(agent('hands-on-orchestrator').includes('Run it as a one-off, read-only sub-agent.'));
  assert.ok(agent('hands-on-orchestrator').includes('Start every sub-agent as `wintermute:orchestrator-worker`.'));
  assert.ok(agent('hands-on-session-orchestrator').includes('Run it as a one-off, read-only session, created with `base_branch` set to that branch.'));
  assert.ok(agent('hands-on-session-orchestrator').includes('Create every child, owner or one-off, with `kickoff.agent: "wintermute:session-worker"`'));
});

test('reuse of idle agents and re-checks exclude claims checks', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    const reuse = text.split('\n').find(l => l.startsWith('- Send a follow-up to an idle '));
    assert.ok(reuse && reuse.includes(REUSE_CLAUSE), `${name}: split-work reuse rule`);
    const recheck = text.split('\n').find(l => l.startsWith('- **Re-checks**'));
    assert.ok(recheck && recheck.includes(RECHECK_CLAUSE), `${name}: re-check rule`);
  }
  const step4 = agent('hands-on-session-orchestrator').split('\n').find(l => l.startsWith('4. If an idle session'));
  assert.ok(step4 && step4.includes(REUSE_CLAUSE), 'helper request step 4');
});

test('the claims check row keeps its models and is no longer called a review row', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    assert.ok(text.includes(CLAIMS_ROW), `${name}: row unchanged`);
    assert.doesNotMatch(text, /last five rows are review rows/, name);
    assert.doesNotMatch(text, /a claims check, a review or a judge gets its review row/, name);
    assert.match(text, /a claims check gets the claims check row, a review or a judge gets its review row/, name);
  }
});
```

- [ ] **Step 2: Run to see them fail.** `cd ghcp/plugins/wintermute && node --test tests/agent-prompts.test.mjs`. Expected: the five new tests fail (except the delegation-type test, which already passes); the four old tests pass.

- [ ] **Step 3: Edit both orchestrators.** In each file, apply these edits. Text in each `new` that is not marked as variant-specific is identical in both files.

  a. Own units (line 44). Replace the start of the line
  `- Start its claims check and its regular or critical review yourself, as you would for a child's unit (see "Evidence and review").`
  with
  `- Start its claims check and its regular or critical review yourself, as separate jobs, as you would for a child's unit (see "Evidence and review").`
  Leave the rest of the line as it is.

  b. Split work for speed (line 73). In `- Send a follow-up to an idle worker …` (sub-agent file) and `- Send a follow-up to an idle session …` (session file), insert `REUSE_CLAUSE` plus a space directly before `You can't change a running`.

  c. Helper requests step 4 (session file only, line 115). Append a space and `REUSE_CLAUSE` to the end of the line.

  d. Models and effort, review-row note (lines 129 / 144). Replace
  `- The last five rows are review rows. "Evidence and review" says when each one runs and which vendors it uses. Any other code review uses the regular review row.`
  with
  `- The last four rows are review rows. The claims check row above them is a check, not a review row. "Evidence and review" says when each of these rows runs and which vendors the review rows use. Any other code review uses the regular review row.`

  e. Models and effort, tier of a job (line 135 sub-agent file, line 149 session file). Replace `a claims check, a review or a judge gets its review row,` with `a claims check gets the claims check row, a review or a judge gets its review row,`.

  f. Evidence and review, Claims check bullet (lines 298 / 308). Keep the bullet line itself unchanged. Directly after it, insert the five `ROUTING` lines exactly as in the test (two-space indent, `- `).

  g. Re-checks (lines 321 / 331). After the sentence ending `who checks only the new diff.`, insert a space and `RECHECK_CLAUSE`.

- [ ] **Step 4: Run tests.** `node --test tests/agent-prompts.test.mjs`. Expected: all pass. Then `git diff --stat` and read the diff of both files side by side to confirm that every inserted passage is identical.

- [ ] **Step 5: Commit.**

```bash
git add ghcp/plugins/wintermute/com.github.copilot/agents/hands-on-*.agent.md ghcp/plugins/wintermute/tests/agent-prompts.test.mjs
git commit -m "feat(wintermute): route claims checks to their own checker (#97)"
```

### Task 2: Worker handling of a misrouted claims job

**Files:**
- Modify: `$A/orchestrator-worker.agent.md` ("Operating mode", after the "Stay inside the brief." bullet)
- Modify: `$A/session-worker.agent.md` ("Operating mode", after the "After two failed attempts" bullet)
- Test: `ghcp/plugins/wintermute/tests/agent-prompts.test.mjs`

**Interfaces:**
- Consumes: the test helpers `agent`, `test`, `assert` already in the file.

- [ ] **Step 1: Write the failing test.** Append:

```js
const MISROUTE_HEAD = '- A claims check is a separate job from a review. If you are a reviewer and your brief or a follow-up also asks you to verify the author\'s claims for a merge, publish or "done", for example "refresh the test and lint claims", do the review and leave the claims job undone.';
const MISROUTE_TAIL = 'Don\'t do the claims job anyway, don\'t count it as done or as not needed, and don\'t start another agent for it. You may still run tests, read CI or reproduce a failure when your review needs that to establish a finding.';

test('both workers hand a misrouted claims job back and keep tests for findings', () => {
  const where = { 'orchestrator-worker': 'Under **Blockers or questions**, say that a claims job was sent to you and needs a separate claims checker.', 'session-worker': 'In your report, under `Blockers:`, say that a claims job was sent to you and needs a separate claims checker.' };
  for (const [name, middle] of Object.entries(where)) {
    assert.ok(agent(name).includes(`${MISROUTE_HEAD} ${middle} ${MISROUTE_TAIL}`), name);
  }
});
```

- [ ] **Step 2: Run to see it fail.** `node --test tests/agent-prompts.test.mjs`. Expected: only the new test fails.

- [ ] **Step 3: Edit the workers.** Insert one bullet, `MISROUTE_HEAD + ' ' + middle + ' ' + MISROUTE_TAIL`, using that worker's `middle` from the test:
  - `orchestrator-worker.agent.md`: as a new bullet after the bullet that starts `- Stay inside the brief.`
  - `session-worker.agent.md`: as a new bullet after `- After two failed attempts at the same problem, stop and report \`blocked\` with your diagnosis.` (the Operating mode bullet, not the one in the report block). Don't edit the report block.

- [ ] **Step 4: Run tests.** `node --test tests/agent-prompts.test.mjs`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add ghcp/plugins/wintermute/com.github.copilot/agents/*-worker.agent.md ghcp/plugins/wintermute/tests/agent-prompts.test.mjs
git commit -m "feat(wintermute): workers hand misrouted claims jobs back (#97)"
```

### Task 3: Release 0.6.0 and full validation

**Files:**
- Modify: `ghcp/plugins/wintermute/plugin.json`, `package.json`, `CHANGELOG.md`, `.github/plugin/marketplace.json` (via `release:bump`)

- [ ] **Step 1: Bump.** `cd ghcp/plugins/wintermute && npm run release:bump -- minor`. Expected: version 0.6.0 in all three files and a new `## 0.6.0 — <date>` CHANGELOG section with a TODO.

- [ ] **Step 2: Write the notes.** Replace the TODO with:

```markdown
### Changed

- Claims checks have their own route. `hands-on-orchestrator` and `hands-on-session-orchestrator` decide whether a job is a review or a claims check before they choose who does it, and split a request that asks for both. Every claims check, including a request to refresh earlier claims and the check of the orchestrator's own unit, goes to a new claims checker at the Claims check row (Sol at `medium`, or Opus at `low` if Sol isn't listed): a `wintermute:orchestrator-worker` sub-agent or a `wintermute:session-worker` one-off session. An idle reviewer's context is no longer a reason to send it a claims job, and the claims check row is no longer called a review row. The claims brief gives the exact pushed head commit and the base branch. Reviewers may still run tests to establish a finding.
- When a worker is asked to do a claims job as part of a review, it does the review, leaves the claims job undone and reports it for a separate claims checker.
- Required reviews, panels, security reviews and claims checks, and when they run, are unchanged.

### Upgrading

- Running sessions keep the prompts they started with.
```

- [ ] **Step 3: Validate.** `npm test && npm run validate`. Expected: all tests pass (the sqlite tests may skip), validate reports no errors.

- [ ] **Step 4: Commit.**

```bash
git add ghcp/plugins/wintermute/plugin.json ghcp/plugins/wintermute/package.json ghcp/plugins/wintermute/CHANGELOG.md .github/plugin/marketplace.json
git commit -m "chore(wintermute): release 0.6.0 (#97)"
```
