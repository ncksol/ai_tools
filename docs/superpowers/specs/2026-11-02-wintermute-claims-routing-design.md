# wintermute: route claims checks apart from code reviews (design)

Issue: [#97](https://github.com/ncksol/ai_tools/issues/97). Size: small change, one PR.

## Intent

The orchestrators already require an independent claims check before every merge, publish and "done", at the Claims check row (Sol at `medium`, Opus at `low` if Sol isn't listed). In the C5 run the orchestrator still added "refresh the test and lint claims" to re-checks sent to expensive reviewers, because those reviewers already had the context. That costs reviewer tokens for a cheap job, and it makes the reviewer the claims checker too. Fix the places where the orchestrator chooses the recipient and writes the brief, so that a claims job always goes to its own claims checker.

## Goals

- The orchestrator decides whether each job is a review or a claims check before it chooses who does it. A request that contains both becomes two jobs.
- Every claims check goes to a new one-off claims checker at the Claims check row, with model and effort set on the call: a `wintermute:orchestrator-worker` sub-agent in `hands-on-orchestrator`, a `wintermute:session-worker` one-off session in `hands-on-session-orchestrator`. This applies to later "refresh the claims" requests and to the orchestrator's own units. A model or effort the user named for claims checks overrides the row. The checker never takes a reviewer's model or effort.
- An idle reviewer's context is never a reason to send it a claims job.
- The claims brief gives the scope to check, the repository, the branch, the exact pushed head commit, the target or base, and the evidence needed: tests run at that commit with counts, CI at that commit, and scope against the brief. The existing independence rules stay: its own fresh fetch or worktree, or the PR and CI service, never the owner's worktree.
- Review briefs cover only the review. Reviewers may still run tests, read CI or reproduce failures when a finding needs it.
- When a worker's review brief or follow-up also asks for a claims job, the worker does the review, leaves the claims part undone, and says in its report that the claims job needs a separate claims checker. It doesn't start another agent and doesn't treat the check as passed or not needed.

## Non-goals and anti-goals

- No change to which checks are required or when they run: reviews, review coverage, test coverage, security reviews, final panels and claims checks stay as they are. No check passes on the author's report alone.
- No extra full-suite runs and no evidence-reuse policy.
- Out of scope, as listed in the issue: review-count reductions, batched reviewer findings, nit policy, rebase policy, receipts or caching, model-tier redesign, context handoffs, notifications, cache-keepalive polling, eval instrumentation (#77) and nit or jury policy (#88). PR monitors stay removed (#95, #96).
- The retired base orchestrators stay retired, and no new agent is added.

## Constraints

- Shared passages in the two orchestrator files stay word for word the same; the report block in `hands-on-session-orchestrator` stays identical to `session-worker`'s.
- Node 18 compatible; no npm dependencies.
- Version 0.5.0 → 0.6.0 in `plugin.json`, `package.json` and the root marketplace entry, plus a `CHANGELOG.md` entry.
- `npm test && npm run validate` from `ghcp/plugins/wintermute/`.

## Approaches

- **1. One routing rule in "Evidence and review", plus targeted fixes where the slip happens (chosen).** The "Claims check" bullet becomes the single rule: sort, split, always a new checker, own units and refreshes included, brief contents. The three reuse rules (Split work for speed, Helper requests step 4 in the session variant, Re-checks) each get a short clause that excludes claims jobs and points to the rule. Each worker gets one bullet for a misrouted claims job. Chosen because each place where the orchestrator decides points to one rule, and the diff stays small.
- **2. A new top-level "Claims checks" section.** Same content, easier to find, but it moves shared text in two files that must stay in step, which makes the diff larger for no change in behaviour.
- **3. Patch only the three reuse rules.** Smallest diff, but the brief contents, the own-unit case and the worker case stay unfixed, and the issue rules out "merely adding another copy of the existing rule".

## Decided

- **Prompts**, same edits in both orchestrators, adapted only where sub-agents and sessions differ:
  - "Evidence and review": the Claims check bullet becomes the routing rule above. "Re-checks": a re-check carries only the new diff; claims for that commit go to a new claims checker. The rebase sentence already says "only the claims check"; it now means a new claims checker.
  - "Split work for speed": the "send a follow-up to an idle worker or session that already has the context" rule excludes claims checks.
  - "Helper requests" step 4 (session variant): excludes claims checks.
  - "Models and effort": the Claims check row gets its own name. "A claims check, a review or a judge gets its review row" becomes "a claims check gets the claims check row; a review or a judge gets its review row", and "the last five rows are review rows" becomes four, so the claims row is not called a review row. The row's content stays the same.
  - Own units: the bullet "Start its claims check and its regular or critical review yourself" says the claims check goes to its own claims checker, like a child's.
- **Workers**: `orchestrator-worker` and `session-worker` each get one bullet for Maya's case: do the review; don't do the claims job; report it under Blockers (or Blockers or questions) as a claims job that needs a separate claims checker; don't start another agent and don't count the check as done or not needed. Running tests to establish a review finding is still allowed.
- **Tests** in `tests/agent-prompts.test.mjs`: the routing rule is in both orchestrators word for word; each reuse rule's exclusion is present; the claims brief lists the pushed head; neither orchestrator still calls the claims check row a review row; both workers have the misroute bullet and still allow running tests for a finding. The existing comment that these are static checks of prompt text, not proof of runtime behaviour, stays at the top of the file.
- **Docs**: CHANGELOG entry. `.github/copilot-instructions.md` needs no change: its agent descriptions don't cover claims routing.

## Left to the builder

- Exact wording of each edit, following the repo's plain-English style and keeping shared text identical.
- Test structure and names.
