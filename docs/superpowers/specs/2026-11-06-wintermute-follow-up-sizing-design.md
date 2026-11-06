# wintermute: size follow-up work by its own scope (design)

Issue: [#100](https://github.com/ncksol/ai_tools/issues/100). Size: small change, one PR.

## Intent

When the orchestrators plan, they size each unit: a tier, critical or not, and a regular or critical review. Everything that follows for that unit (fixes, reviewer re-checks, panel re-checks, claims checks, rebases) then gets the unit's original treatment by default, because no rule says to size it again. In the Lean.UDR C5 run, a two-commit removal of an unused parameter on a critical unit went back to two frontier reviewers and got a fresh claims check. Every follow-up job should be sized from what actually changed, in both directions, with the reason recorded.

Eval runs 13 and 14 show the same pattern. In run 14 a one-line README commit triggered a claims check, two panel judges and the unit's reviewer, and all came back clean. Claims checks cost little money (Sol, $0.17–0.45 per unit with every re-check, 2–3% of a run) but are the last gate before merge. Once sizing drops the reviewer re-check for a mechanical change, the claims check alone sets the delay. Reviews and panels are 29–48% of a run's cost.

## Goals

- One general rule sizes every follow-up job on its own scope and risk, from the same inputs as planning: size of the change, what it touches (the critical-unit triggers, including public contracts, data, security, authentication, secrets, concurrency and migrations), how well tests and CI cover it, and how much judgement it needs. It covers fixes, reviewer re-checks, panel re-checks, claims checks and rebases, and any later follow-up type without further edits.
- Scrutiny scales from none to the original level and above:
  - mechanical and fully covered by tests and CI (rename, dead code or an unused parameter removed, a test-only change that removes or weakens no test, docs, a rebase with no new code): no reviewer re-check, and no separate claims check when the conditions below hold;
  - small, with real logic, meeting no critical-unit trigger: at most one reviewer, which may be a new reviewer at a new Light review row;
  - significant in its own right, or meeting a critical-unit trigger: the original reviewer set, or the critical level;
  - larger or riskier than the original unit: more scrutiny than the unit had.
- A follow-up may skip its separate claims check only when all of these hold:
  - an earlier claims check passed for this unit, at an earlier commit;
  - the change since then is mechanical and touches no build, CI or test configuration, and removes or skips no tests;
  - CI's test job ran, and passed, at the exact new head commit. It did not skip.
  The orchestrator reads that CI result itself as a quick job and records the run and the commit.
- A claims check that does run may go to the unit's idle claims checker from an earlier check, instead of always a new one.
- Downgrades need evidence the orchestrator states. If unsure, choose the higher level. Each decision gets a one-line reason (scope, risk, chosen scrutiny, and the CI run and commit for a skipped claims check) in the unit's notes.

## Non-goals and anti-goals

- No change to how units are sized at planning, or to a unit's first review: the Light review row is only for follow-ups.
- No change to the vendor rule, security routing, required human or project reviews, the user's explicit model choices, or a unit's first claims check. The claims check on `main` after the last merge still always runs.
- Failure, even if it technically works: a skipped claims check on a repository with no CI, or one that relies on a CI run whose test job was skipped; a security, authentication or secrets change re-checked at the Light review row.
- No dashboard contract change and no new agent.

## Constraints

- Shared passages in the two orchestrator files stay word for word the same; the "Quick jobs you do yourself" section stays byte-identical.
- Node 18 compatible; no npm dependencies.
- Version 0.6.0 → 0.7.0 with `npm run release:bump -- minor`, a `CHANGELOG.md` entry, and `npm test && npm run validate` from `ghcp/plugins/wintermute/`.

## Approaches

Placement of the general rule:

- **1. A new "Follow-up jobs" bullet in "Evidence and review", just before "Re-checks", with pointers from the rules it governs (chosen).** Scrutiny, reviews, panels and claims checks all live in that section, so one bullet covers every follow-up type. The existing rules change only to point to it.
- **2. A new top-level section.** Easier to find, but it splits the review rules across two sections that must stay in step in two files.
- **3. An exception in each existing rule.** The issue rules this out.

The two options added during design, both limited to follow-ups:

- **No separate claims check** for mechanical follow-ups under the conditions above (chosen). The alternative was keeping every claims check and only shaping its brief. Rejected because, once the reviewer re-check is gone, the claims check alone holds the merge, and CI at the exact head already gives independent evidence.
- **A Light review row** below Regular review (chosen). The alternative was making the Regular review row the floor. Rejected because a new review of a small change with no idle reviewer, or a re-check on a reused Astra reviewer, costs more than the change needs. The repository has no quality data on the cheaper reviewers (the A/B/C reviewer comparison never ran), so the row is used only for small follow-ups with no critical-unit trigger.

## Decided

- **"Evidence and review"**, both files:
  - New "Follow-up jobs" bullet with the rule, the levels, the claims-check skip conditions, the safeguards, "if unsure, go higher" and the recorded reason.
  - "Claims check": the claims check before a merge or publish may be skipped only as "Follow-up jobs" allows. A claims check goes to a new claims checker or to the unit's idle claims checker. It never goes to a reviewer, a judge or any other agent because that agent has the context. The checker re-checks from a fresh fetch at the exact new head.
  - "Re-checks": new code after a review gets the scrutiny "Follow-up jobs" sizes for it. A reviewer that re-checks it still checks only the new diff. The panel re-checks a change after the panel only when the change can affect how units work together or the spec as a whole. A rebase onto code that merged since the last review, or with conflicts resolved by hand, is sized by what merged or what the resolution changed.
  - "Findings": the fix PR for a panel finding in merged code is a follow-up, sized by "Follow-up jobs".
- **"Models and effort"**, both files: a Light review row: Sol at `high`, Sonnet at `xhigh` or Argon at `high`, never from the author's vendor, for a small follow-up with real logic and no critical-unit trigger, never a unit's first review. The sentence that counts the review rows changes to five, and still says the claims check row is a check, not a review row. One bullet says a follow-up job gets the tier or row that fits its own scope, not the unit's.
- **"Plan by stage" → "Critical units"**: a critical unit's follow-ups aren't critical by default, and a follow-up that meets a trigger gets critical scrutiny even in a regular unit. The unit itself is raised only by the existing rule.
- **Split work for speed** and, in the session variant, **Helper requests** step 4: the claims-check reuse clause allows the unit's own idle claims checker and still excludes every other agent.
- **Tests** in `tests/agent-prompts.test.mjs`: the "Follow-up jobs" bullet and the Light review row are word for word the same in both files; "Re-checks", "Claims check", "Critical units" and "Models and effort" point to "Follow-up jobs"; the skip conditions name the earlier passed claims check, the exact head, and a test job that ran rather than skipped. Existing assertions whose wording changes are updated, including the one that forbade "last five rows are review rows". The note that these are static checks of prompt text stays.
- **Docs**: CHANGELOG entry. Worker agents and `.github/copilot-instructions.md` need no change.

## Calls made during design

- The orchestrator sizes from the diff at the pushed commit (files, line counts, content), read as a quick job, plus the owner's test and CI evidence. The owner's description alone isn't enough to downgrade. A diff it can't read within a quick job isn't mechanical.
- Its CI read for a skipped claims check is a quick job, not a claims check, so "Quick jobs you do yourself" doesn't change.
- For a small follow-up, the one reviewer is the unit's idle reviewer that has the context. A new reviewer at the Light review row replaces it when that reviewer is Astra, or when none is idle. After the panel, the one reviewer is the unit's reviewer for changes inside the unit, or one judge for changes to how units work together.
- A unit's claims checker is kept until the unit merges, like its reviewer, so it can take a later claims check.
- `hands-on-orchestrator` children get the Light review row with the other review rows. Their own optional reviews stay at the Regular review row.

## Left to the builder

- Exact wording of each edit, in the repo's plain-English style, keeping shared text identical.
- Test structure and names.
