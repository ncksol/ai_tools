# Retire the base orchestrator agents from wintermute

## Intent

The `wintermute` plugin is being prepared for release, and the release will ship a single orchestrator variant. As a step towards that, remove the two non-hands-on variants, `orchestrator` and `session-orchestrator`, completely. Nothing that ships with or carries into the release may mention them. The plugin must keep working.

## Goals

- Delete `com.github.copilot/agents/orchestrator.agent.md` and `com.github.copilot/agents/session-orchestrator.agent.md`.
- Remove every mention of the two agents (bare names, `wintermute:` IDs, file names) from release-facing and live files.
- `hands-on-orchestrator` and `hands-on-session-orchestrator` become the only orchestrators. Their names and IDs stay as they are.
- The plugin's tests and validation, and the eval kit's tests and checks, pass.

## Non-goals

- Renaming the hands-on agents. Do any rename once the final single variant is chosen.
- Removing a hands-on variant. That is a later step.
- Supporting past runs. The user doesn't care about history: the dashboard need not recognise old sessions that ran the retired agents.

## Anti-goals

- A deprecation stub, a hidden copy, or a compatibility alias for either agent. Each leaves a trace.
- Editing historical records.

## Constraints

- Leave historical records as they are: past `CHANGELOG.md` entries, `evals/orchestrator/expense-claims/results.csv` rows, everything under `docs/superpowers/`, and the pinned A/B/C snapshots in `evals/orchestrator/expense-claims/variants/`.
- `orchestrator-worker` and `session-worker` stay. `hands-on-orchestrator` uses `orchestrator-worker`; `hands-on-session-orchestrator` uses `session-worker`.
- "The orchestrator" as a role word (the agent a worker reports to) is not a mention of the retired agent. Only the agent names, IDs and file names count.
- Plugin release rules apply: `npm run release:bump -- minor` (removing agents is an incompatible change, so 0.3.4 → 0.4.0), a CHANGELOG entry for the new version, and `npm test && npm run validate` from `ghcp/plugins/wintermute/`. Eval kit changes need `npm test && npm run check` from `evals/orchestrator/expense-claims/`.
- The two hands-on files keep their shared text word for word the same, and `hands-on-session-orchestrator`'s report-format block stays word for word the one in `session-worker.agent.md`.

## Approaches

- **A. Delete and scrub, keep the hands-on names (chosen).** Delete the two files and remove every live mention. Agent IDs that users and the eval kit already use don't change. The user picked this.
- **B. Delete, then rename the hands-on pair to the freed names.** Cleaner names, but the freed IDs would return with different behaviour, every hands-on ID would change, and a later move to one variant would probably mean renaming again. Rejected.
- **Deprecation stub.** Rejected: it leaves a trace.

## Decided

- Remove both names, bare and `wintermute:`, from the dashboard's `ORCHESTRATOR_AGENT_NAMES` / `ORCHESTRATOR_AGENTS` in `engine/model/forest.mjs`, with no history fallback.
- Change dashboard tests, fixtures (including `tests/fixtures/example-snapshot.json`) and demo scenarios that use `orchestrator` or `session-orchestrator` as an agent name to a hands-on name.
- In the hands-on prompts, drop mentions of the retired agents, for example the memory-naming rule that lists the other orchestrators, and any "derived from" wording.
- `session-worker`'s description and body name `hands-on-session-orchestrator` as the agent it serves, not `session-orchestrator`.
- Update `plugin.json` description or keywords if they name the retired agents, the plugin README (agent table, "four orchestrators"), `scripts/lib/validate-package.mjs` and `tests/validate-plugin.test.mjs`.
- Outside the plugin: `.github/copilot-instructions.md` (agent list and the "stay in step" rules, which now cover only the two hands-on files plus the session-worker report block), the root `README.md`, `ghcp/agents/eval-runner.agent.md`, and the eval kit: `LIVE_VARIANTS` in `scripts/lib/variants.ts`, its README and its tests.
- The new CHANGELOG entry says, under "Removed", that the two agents are gone and that users should switch to the hands-on variants.

## Builder's calls

- How to reword each mention, as long as the meaning of the remaining rules doesn't change.
- Which hands-on name each test fixture uses.
- Whether the alias-name guard in `variants.ts` (`["orchestrator", "session-orchestrator"].includes(variant.agent)`) is dropped or kept under a neutral form. Pinned A/B/C snapshots must still load either way.
- Making sure old `results.csv` rows whose variant is no longer live still parse and don't break the batch planner or preflight.
