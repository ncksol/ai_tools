# wintermute: remove agent-driven PR monitors (design)

Issue: [#95](https://github.com/ncksol/ai_tools/issues/95). Size: small change, one PR.

## Intent

Owner sessions schedule recurring PR-watch automations after they open a PR. Each run spends model tokens in a large session and can wake the coordinator. Remove that behaviour. The dashboard's own PR lookups are ordinary program execution, wake no model, and stay as they are.

## Goals

- No orchestrator or worker prompt tells a session to start, keep or stop a PR monitor, for draft or ready PRs.
- Kickoff briefs and follow-ups can't bring the requirement back, because no source text asks for it.
- After opening a PR, an owner records it, reports, and continues only with assigned work or required review and validation gates.
- One-shot PR reads for an assigned review, status check, publish or merge stay allowed and schedule nothing further.
- The dashboard treats an open PR with no schedule as normal.

## Non-goals and anti-goals

- No replacement watcher: no agent, session automation, shell loop, background script, watch connector or coordinator heartbeat.
- `engine/model/pr-lookup.mjs` and its refresh behaviour are untouched; the dashboard does not become local-only.
- History is not erased: past monitor wakes, schedule saves and timeline ticks still show. A genuinely overdue, explicitly configured schedule still shows as `missing`.
- Out of scope: everything listed under "Out of scope" in the issue. No bulk-stopping of existing sessions or schedules.
- The retired `orchestrator` and `session-orchestrator` agents stay retired.

## Constraints

- The two orchestrator files keep their shared passages word for word in step; the report block in `hands-on-session-orchestrator` stays identical to `session-worker`'s.
- Node 18 compatible; no npm dependencies.
- Plugin version bump in `plugin.json`, `package.json` and the root marketplace entry, plus a `CHANGELOG.md` entry.
- `npm test && npm run validate`, and `npm run check:layout` with 0 issues after the UI copy change.

## Approaches

- **A. Keep the Monitor slot; narrow `missing` (chosen).** `deriveMonitor` reports `missing` only when a configured automation row is overdue. An open PR with no row is `none`, whether or not past wakes or a cleared save exist. Card layout and snapshot schema stay the same. Chosen because it meets the issue with the least UI risk and keeps genuine schedule failures visible.
- **B. Hide the Monitor row unless a schedule ever existed.** Cleaner cards in the new normal case, but cards stop lining up and every view and cockpit state needs layout work.
- **C. Drop the monitor concept from the snapshot.** Ruled out: the issue requires history and existing schedules to stay readable.

## Decided

- **Prompts** (`hands-on-orchestrator`, `hands-on-session-orchestrator`, same edits in both):
  - Routing table: drop "anything that needs monitoring" from the owner/child-session row.
  - On PR publish: check the PR columns are filled; no monitor instruction. Add a rule that the orchestrator never asks an owner to watch a PR, schedule checks, or react to future reviewer activity; one-shot PR reads for assigned work stay allowed.
  - On merge: drop "tell the child to stop its PR monitor"; keep "any Agent merge" and the existing archive conditions (no open work, other PR, automation or active Agent merge).
  - Reporting: drop "monitor runs" from the no-news line, or keep it neutral for existing schedules.
- **`session-worker`**: owner follow-ups no longer list PR monitoring. Add an operating rule: after opening a PR, report and don't create a monitor, automation, subscription or polling loop to watch it; a check you are asked for is one read. Once its PR is open and assigned gates are done, the worker reports `complete` so the dashboard's 30-minute stall rule doesn't fire on a session that is waiting. `save_session_automation` and `manage_event_subscriptions` stay in its `tools` list (user decision); the prompt rule is the guard.
- **`orchestrator-worker`**: no monitor text today; change only if a permissive line is found.
- **Dashboard**:
  - `engine/model/stage.mjs` `deriveMonitor`: with no automation row and the unit not ended, return `none`. Keep `alive`, `paused`, `ended` and overdue-row `missing` as they are.
  - `deriveStage` keeps `monitorEver` for placing a unit with unknown PR state in review, so historical data still places correctly.
  - `ui/parts.mjs` `monitorHtml`: `none` reads "no monitor" (long and short), not "starts when the PR opens" / "no PR yet" wording that promises a monitor. `ui/live.mjs`: "No PR yet." without the monitor promise.
  - `engine/model/status.mjs`: the unit stall rule is unchanged. For the swarm stall rule, a unit waiting on review (latest report `complete`, PR open, no orchestrator reply since) has done its part: it counts like an ended unit for the swarm stall rule, with a draft or a ready PR; run lifecycle and History are unchanged (user decision after the first review: "no swarm unit should be stalled because they are waiting on PR reviews").
- **README**: describe the Monitor slot as showing a configured schedule, if any, and add an upgrade note that updating the plugin doesn't change prompts in running sessions or stop their existing automations.
- **Tests**: dashboard regression tests for `deriveMonitor` (open PR with no row → `none`; overdue row → `missing`; wakes/cleared saves with no row → `none`) and UI copy. Static prompt assertions that no agent file instructs starting or stopping a PR monitor; these check the text only, not runtime behaviour, and the PR says so.

## Left to the builder

- Exact prompt wording, kept in the files' existing style and in step across both orchestrators.
- Which existing tests and fixtures need updating, and where the new assertions live.
- Patch or minor version bump, following the CHANGELOG's existing practice.
- Checking recent session logs for monitor automations as supporting evidence, without changing any app state.
