# wintermute: done outcome and reviewed PRs (issue #112)

## Intent

Every label in the dashboard must report the session's real state. Today, finished reviewers, claims checks, research and one-off jobs read as "closed", or as "closed, not merged" when their status lines name the PR they reviewed. Issue #112 has the evidence and the full requirements. The Board rebuild (#111) depends on this change.

## Goals

- A unit whose status lines name a PR that the registry records for another unit does not own that PR. It reviews it.
- A registry `closed` unit that finished its work reads "done".
- Saved History summaries that were built with the old rules are rebuilt when their logs can still be read.

## Non-goals

- The Board card. #111 rebuilds it and adds "reviews PR #…" there. In this change the Board only loses the wrong "closed, not merged" badge on done units.
- The registry contract. It stays as it is. The new rules also cover existing data.
- PRs recorded in the orchestrator's `own_units` table. That table has free-form columns, and only one swarm on disk has rows in it.

## Anti-goals

- Bumping `SCHEMA_VERSION`. Run summaries must match it exactly, so a bump would drop every saved summary, including those whose logs are gone.
- Letting a registry row set `done`. Only the engine infers `done`.

## Approaches

1. **Resolve PR ownership inside `resolvePr` (chosen).** The engine skips foreign PRs before it derives the stage, the monitor and the outcome, so it works each of them out only once.
2. Move PRs after all units are built. This needs the stage, monitor, outcome and waiting state to be derived a second time. Rejected.

For the summary rebuild:

1. **A `rules` version field, built like `costSource` (chosen).** `isStale` already rebuilds a summary with an old cost source only when every log was read in full, and keeps it otherwise.
2. Bump `SCHEMA_VERSION`. Rejected (see Anti-goals).

## Design

### Engine

- **PR ownership.** `resolvePr` gets the PRs that the registry records for other units, matched on provider and id. It skips status lines that name one of them. The latest skipped PR becomes the new unit field `reviewedPr` (`{ provider, id, repo, url } | null`). Its repo and URL come from the owner's registry row. Resolution then continues with the next status line, then the app's PR record (builder's call). A status-line PR that no other unit owns is still the unit's own PR.
- **Outcome.** A registry `closed` resolves, after the PR ownership rule, as follows:

  | Own PR | Latest report | Resolves to |
  |---|---|---|
  | none | `complete` | `done`, `closedWithoutMerge: false` |
  | yes | any | `closed`, read as "closed, not merged" |
  | none | not `complete` | `closed`, read as "closed" |

  `deriveStage` gets the resolved outcome.
- **Schema.** The snapshot outcome list gains `done`. Registry rows keep `merged | closed | failed`. `UNIT` gains a required, nullable `reviewedPr`. `SCHEMA_VERSION` stays 1.
- **History.** `summarizeRun` adds `children.done`, which is optional in the run summary spec so that older summaries still validate. It also adds `rules: 2`. `isStale` treats a summary with a missing or older `rules` like one with an old `costSource`: it is rebuilt when every log was read in full, and kept otherwise.

### UI

- `finishedOutcome` reads `done` as "done {age}" in the ok tone. It checks `done` before the state words, so a stopped unit that finished its work reads "done".
- `isFinished` treats a `done` unit as finished, as `closed` units were before (builder's call).
- The card's line 2 and the details view show "reviews PR #N" when the unit has no PR of its own.
- Plan: "Done" for a done unit. A closed unit with no PR reads "closed", not "closed, not merged".
- History: the "Time by unit" chart puts only `closed` and `failed` units in peach. The run's Children line adds ", N done" (builder's call).
- Cockpit tiles need no change, because `closedNotMerged` is false for done units.

### Other

- The demo gains a done unit.
- Update `tests/fixtures/example-snapshot.json`, the schema docs, and sections 9 (call 13) and 11 (PRs) of `2026-10-15-swarm-dashboard-design.md`.
- Ship it as wintermute 0.9.4 with a CHANGELOG entry.

## Verification

- Add the tests listed in the issue's "Done when".
- Run `npm test && npm run validate` and `npm run check:layout` from `ghcp/plugins/wintermute/`.
- Check on C5's real data that its 65 closed units read "done", apart from any whose own PR closed without merging.
- Shipped code stays compatible with Node 18.

## Left to the builder

Test layout, helper names, the exact wording of the details view's "reviews PR" row, and how the demo shows a done unit.
