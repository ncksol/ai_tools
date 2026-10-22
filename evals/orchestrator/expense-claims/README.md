# Orchestrator speed eval: expense claims

This folder is the runbook and the tools for one eval. Run every command below from this folder.

## What this is

This eval compares orchestrator agents on one fixed task. The agents are `ghcp/agents/orchestrator.agent.md`, `ghcp/agents/session-orchestrator.agent.md` and their later versions.

The task is v2 of a small expense-claims API. The orchestrator starts from a working v1 and adds four features: Policy, Reports, CSV import and Summary.

Speed is the score. A hidden acceptance suite is a pass/fail gate, so a fast run that ships broken code doesn't win.

The design, with the reasons behind each rule, is in [the design doc](../../../docs/superpowers/specs/2026-10-18-orchestrator-eval-design.md).

## What's in the kit

| Path | What it is |
|---|---|
| `README.md` | This runbook. |
| `kickoff.md` | The exact first message of every run: a few lines that point at `docs/spec-v2.md` in the run repo. |
| `answers.md` | The answer sheet: the only replies you send during a run. |
| `results.csv` | One row per run, written by `score`. |
| `seed/` | The v1 app, with `docs/spec-v2.md` and CI. This is what a run repo starts from. |
| `reference/` | A full v2 implementation. It only proves that the suite is correct and can pass. |
| `acceptance/` | The hidden black-box acceptance suite, one file for v1 and one per feature. |
| `robustness/` | Hidden edge-case tests, run after scoring, never as the gate. |
| `pricing/2026-10-20.json` | Dated USD-per-million token rates, with model tiers and promotion expiry. |
| `variants/` | Eval-only A/B/C agent snapshots, their shared worker and the hashed `review-policy.json` manifest. Not ordinary agent installation files. |
| `scripts/` | `new-run`, `score`, the acceptance and robustness runners, the kit check, the overnight batch runner (`batch.ts` and `lib/batch/`) and their tests. |
| `package.json` | The npm scripts: `test`, `check`, `new-run`, `score`, `acceptance`, `robustness` and `batch`. |

Only `seed/` goes into a run repo. Never copy `acceptance/`, `reference/`, `robustness/`, pricing or variant manifests into a run repo, paste them into a run session, or mention them in the kickoff.

## Before the first run

You need:

- Node 24.
- `gh`, logged in as the repo owner (`ncksol` by default) with the `repo` scope. Several accounts may be logged in, so `new-run` checks the active account and stops if it isn't the owner. Switch with `gh auth switch`, or check `GH_TOKEN`.
- The Copilot app.
- An orchestrator agent that can read files, for example with a `view` tool. The kickoff doesn't include the spec; it points at `docs/spec-v2.md` in the run repo. An agent that can't read files has to delegate the read, and that time counts in its score.

Choose one model and effort for the orchestrator session, for example Claude Opus 5.5 at max. Use the same model and effort for every run. `score` records them from the session log. Child sessions and sub-agents pick their own models from each agent's tier table; that is part of what the eval tests.

## Run it

1. Create the run repo:

   ```bash
   npm run new-run -- --variant <agent-name>
   ```

   This creates the private repo `ncksol/orch-eval-<variant>-<n>` from `seed/`, with one `Seed v1` commit on `main`. The clone is `~/orch-evals/orch-eval-<variant>-<n>`, and the kickoff file is `~/orch-evals/orch-eval-<variant>-<n>.kickoff.md`. `<n>` is one more than the highest run number of that variant in `~/orch-evals/`. To set it yourself, pass `--n <k>`; it must be a positive whole number. `new-run` never reuses a run folder: it stops if the folder or the GitHub repo already exists. Other flags: `--features` (see [Calibration](#calibration)), `--owner`, `--runs-dir`, and `--dry-run`, which builds the clone and kickoff file locally without touching GitHub.
2. In the Copilot app, add the clone as a project.
3. Start a **new top-level session** in that project with the agent under test, using the held-constant model and effort. **An orchestrator run is always a top-level session. You start it yourself, or the `eval-runner` driver starts it as a detached top-level session in an overnight batch that you launched (see [Overnight batches](#overnight-batches)). Never start one as a child of another session, and never ask any other agent to start one, or start one any other way.**
4. Copy the kickoff, then paste it into the composer as the first message:

   ```bash
   pbcopy < ~/orch-evals/<name>.kickoff.md
   ```

   `<name>` is `orch-eval-<variant>-<n>`. The kickoff is short so that the app takes it as typed text; a long paste becomes an attached file. Don't attach the file or add anything to the message.
5. Answer any question straight away, word for word, from `answers.md`. Send nothing else.
6. After the final report, before you send anything else to the session, run:

   ```bash
   npm run score -- --repo-dir ~/orch-evals/<name>
   ```

   Then commit `results.csv` and follow [Memory hygiene](#memory-hygiene).

## When a run doesn't finish

A run ends without a final report in two ways:

- **Timeout:** there is no final report 90 minutes after the kickoff.
- **Stalled:** the orchestrator and all its child sessions have been idle for 15 minutes, and the work is not done.

Never nudge a run. After the kickoff, the only messages you send are answers from `answers.md`.

Record the run as soon as you see it has ended:

```bash
npm run score -- --repo-dir ~/orch-evals/<name> --outcome timeout
npm run score -- --repo-dir ~/orch-evals/<name> --outcome stalled
```

With `--outcome`, `score` times the run from the kickoff to the moment you run `score`, not to the last message. So run it straight away.

## Scoring

The score is the wall-clock minutes from the kickoff to the final report, minus blocked time. Blocked time is time the run spent waiting for you:

- the duration of every `ask_user` call;
- for each of your messages after the kickoff, the idle time between the orchestrator's previous turn end and your message. In a hands-off run, every such message answers a question asked in plain text.

`score` reads timing from the session's event log. Timing ignores events written by sub-agents; cost includes them. It counts each `ask_user` call and each of your messages after the kickoff as one question. Messages with a `data.source` or a `<cross_session_message` tag in `transformedContent ?? content` are not human messages, even if the tag arrives without a source.

For answers sent by another session, pass `--answer-source <value>`, usually `agent-<answering-session-id>`. Only messages whose `data.source` matches that value exactly count as human answers, including tagged messages. They add to both the question count and blocked time just like typed replies; ordinary typed replies still count. This does not make a session-sent kickoff human. `score` warns if the source matches no messages in the scored run, or if another session sent the first non-runtime message and timing starts at a later human kickoff. Answers delivered through `answer_session_input` already count in the duration of `ask_user` and need no source override.

For a completed run, the end is the last top-level `assistant.message` at or before the last `session.task_complete` after the kickoff inside the scoring window. Earlier completion markers do not hide later coordination work; more than one adds a warning to `note`. Notifications and turns after the last completion do not extend it. If there is no completion marker, the end is the last top-level assistant message.

To limit scoring to the final report you observed, pass the time you saw the report as `--end-at <iso>`, for example `--end-at 2026-10-18T18:43:58.228Z`. When the log has `session.task_complete` events, the cap must be at or after the final marker; a cap inside the final turn can select an earlier completion. Include `Z` or an explicit UTC offset such as `+01:00`; a cap before the kickoff is an error. Events after that time are ignored when finding the end and computing timing; events exactly at the cap are included. The end is still an assistant message, not the cutoff itself. With `--outcome timeout` or `--outcome stalled`, `--end-at` has no effect on timing: the run ends when `score` runs. Both options are for session-log timing and cannot be combined with manual `--start`/`--end`.

The gate: `score` makes a fresh clone of the run repo's `main` and runs the acceptance suite on it. The run must pass 100% of the suite.

Each run gets one outcome:

| Outcome | Meaning |
|---|---|
| `passed` | Final report within 90 minutes, and 100% of the suite passed. |
| `gate-failed` | Final report within 90 minutes, but some suite tests failed. |
| `timeout` | No final report within 90 minutes. `score` also sets this when a final report came more than 90 minutes after the kickoff. |
| `stalled` | Everything was idle for 15 minutes with the work not done. |

Only passed runs enter the time comparison. For each variant, compare the median minutes of its passed runs, and its pass rate. Compare runs only within one feature set and one pinned agent bundle. The summary separates bundles as `variant@<hash-prefix>`; it never pools different revisions under one label. Robustness and cost are separate measurements, not adjustments to the gate or minutes. To print the medians, pass rates and the calibration state:

```bash
npm run score -- --summary
```

`score` appends one row per run to `results.csv`. A run is one repo and run number. If `results.csv` already has a row for it, `score` stops with exit code 2 before it runs anything. To score the run again, for example after a mistake, add `--replace`: the new row then replaces the old one.

| Column | Meaning |
|---|---|
| `date` | When `score` ran (ISO 8601, UTC). |
| `variant` | The agent under test, from the clone's folder name. `--variant` overrides it. |
| `run` | The run number `<n>`. `--n` overrides it. |
| `repo` | The GitHub repo (`owner/name`) from the clone's `origin`, or the folder name if there is no GitHub remote. |
| `session` | The orchestrator session id, or `manual` for [manual timing](#manual-timing). |
| `agent` | The agent the session was started with, from the event log. Empty with manual timing. |
| `features` | The feature set, for example `policy+reports+import+summary`. `score` reads it from `docs/spec-v2.md` in the run repo's first commit, the `Seed v1` commit from `new-run`, so a run can't shrink its own gate. If the spec on `main` lists a different set, `score` says so in `note`. `--features` overrides it. |
| `calibration` | `yes` for the first row of this variant in `results.csv` if the run has the full feature set, otherwise `no`. `--calibration yes\|no` overrides it. |
| `outcome` | `passed`, `gate-failed`, `timeout` or `stalled`. |
| `minutes` | The score: `wall_minutes` minus `blocked_minutes`. |
| `wall_minutes` | Minutes from the kickoff to the final report, or to when `score` ran for `timeout` and `stalled`. |
| `blocked_minutes` | Minutes spent waiting for your answers. |
| `questions` | The number of questions: `ask_user` calls plus your messages after the kickoff. |
| `suite_passed` | Acceptance tests that passed on `main`. |
| `suite_total` | Acceptance tests run for this feature set. |
| `prs_merged` | Merged PRs in the run repo, from `gh`. `n/a` without GitHub (`--no-github` or no GitHub remote); `unknown` if `gh` failed. |
| `main_ci` | The result of the GitHub Actions run for `main`'s head commit, for example `success` or `failure`. `in_progress` or `queued` if it hasn't finished, `none` if there is no run for that commit, `n/a` or `unknown` as for `prs_merged`. |
| `model` | The orchestrator session's model at the kickoff. Empty with manual timing. |
| `effort` | The orchestrator session's reasoning effort at the kickoff. Empty with manual timing. |
| `copilot_version` | The Copilot version that wrote the session log. Empty with manual timing. |
| `note` | `--note`, if given, followed by any warnings from `score`, for example a model change during the run or multiple completion markers. |
| `agent_revision` | Full source commit of the pinned agent. Empty for legacy or unpinned runs. |
| `agent_sha256` | SHA-256 of the registered alias file verified at launch, including its frontmatter. This is file provenance, not proof of loaded prompt bytes, which the event log does not expose. |
| `agent_bundle_sha256` | SHA-256 over the alias name/hash and sorted worker names/hashes. Separates results when an agent or worker changes. |
| `main_sha` | Full commit of the fresh `main` clone used for both suites. |
| `robustness_status` | `passed`, `failed`, `error`, or `not-applicable` when the feature set has no robustness tests. This cannot change `outcome`. |
| `robustness_passed`, `robustness_total` | Passing and total robustness tests. Empty when no suite ran. |
| `robustness_sha256` | SHA-256 of the selected robustness tests, their local dependencies, runner settings and total timeout. Compare counts only within the same hash. |
| `cost_status` | `complete`, `incomplete` (some usable records, but missing data or rates), or `unavailable` (no usable total, including manual timing). |
| `cost_usd` | Whole-swarm token cost in USD, rounded once to nine decimal places. Empty unless `cost_status=complete`; missing data is never reported as $0. |
| `pricing_version` | Pricing date and SHA-256 of the exact price file, separated by `:`. |
| `cost_captured_at` | UTC cutoff captured before cloning or running tests. Usage includes records from kickoff through this instant, inclusive. Empty with manual timing. |
| `cost_sessions` | Distinct root/descendant CLI session logs discovered, including workspace aliases and missing logs when the total is incomplete. |
| `usage_records` | Unique successfully priced usage records. Includes sub-agent calls in parent logs. |
| `input_tokens_all_models` | Inclusive input tokens summed across all models for successfully priced records, including cache reads and writes. |
| `cache_read_tokens_all_models`, `cache_write_tokens_all_models`, `output_tokens_all_models` | Corresponding all-model totals for the same records. With incomplete cost these are partial. These aggregate counters cannot reproduce `cost_usd`: models and context tiers have different rates. |

Commit `results.csv` after each run, so the history across agent versions is kept. The scorer can read the old 21-column format and upgrades it on append or replacement. Historical fields stay unchanged; new fields remain blank rather than being backfilled with guesses.

### Post-score robustness

After the acceptance outcome and timing are fixed, `score` runs `robustness/` on the same fresh clone. Its 12 CSV tests cover lone `\r` in unquoted fields, invalid quoting in data and header rows, and valid quoted fields, line breaks and empty-field controls. These test spec rules that the unchanged acceptance gate did not cover. Failures are recorded in `results.csv` and the batch report; they never change the score, pass rate, or which runs enter the median.

The gate row is saved **before** robustness starts, with `robustness_status=error` and a pending note until diagnostics finish. Robustness has a two-minute total budget; a timeout stops its process group and records `error` with blank counts. If the outer scoring process is interrupted, the saved gate row survives and the runner keeps it rather than voiding the run. Normal completion updates that same row with the diagnostic result. `robustness_sha256` identifies the selected tests, local harness dependencies, runner arguments and timeout; compare robustness counts only within one identity. An interruption before the final update can leave that hash blank. The test-only `ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS` override changes the hash and must not be set for real runs.

Keep these tests hidden exactly like `acceptance/`. Do not give the run their failures or let it repair them before recording its result. There is no AI-auditor alternative in this kit.

To inspect a completed checkout separately:

```bash
npm run robustness -- --app <dir> [--features policy,reports,import] [--verbose]
```

The standalone runner reports counts and exits nonzero on failures or invalid invocation. A feature set without CSV import reports that no robustness tests apply; it does not start an empty test command. This command does not write `results.csv`.

### Whole-swarm cost

The scorer reads `session.usage_record` events from the root and every recursively discovered child's `events.jsonl`. Discovery combines successful session-creation tool results with creator/coordinator links in the read-only app database, including archived children. It also follows `workspace_session_aliases` when a workspace has used several CLI session IDs. It does not count other sessions merely because they use the same repo. `--app-db <path>` and `--state-dir <dir>` override the defaults; the batch passes both explicitly, and tests and rehearsal use scratch paths. If the database is absent, the scorer warns and collects only what the logs reveal: cost is incomplete (or unavailable if no records can be priced), with no dollar total. It cannot prove that aliases or database-only children were included. An unresolved child or broken log also makes the cost incomplete.

Sub-agent calls with `interactionType: conversation-subagent` are already in their parent's log and are included. Accounting usage IDs deduplicate mirrored records; event IDs deduplicate repeated entries within one session. The eval-runner driver and this kit's scripts are outside the run's swarm and are excluded.

For each usage record:

```text
uncached_input = inputTokens - cacheReadTokens - cacheWriteTokens
USD = (uncached_input * input_rate
     + cacheReadTokens * cached_input_rate
     + cacheWriteTokens * cache_write_rate
     + outputTokens * output_rate) / 1,000,000
```

Never use the session log or session store `cost` field: it is a legacy premium-request multiplier, not dollars. Token counters must be present, nonnegative integers, with cache tokens no greater than inclusive input. Missing prices, expired promotions, malformed records and missing logs produce warnings and a blank dollar total. Records with `isAuto: true` are also unpriced: Auto usage had a 10% discount, so this list-price card cannot establish their charge.

Rates live in one dated file, currently `pricing/2026-10-20.json`, with the official pricing source. Astra (and Sol) switch tiers only above 272,000 inclusive input tokens **per record**, not on the swarm's aggregate. Argon's promotional rates are invalid at or after `2026-12-01T00:00:00Z`; do not extend them by assumption. Its cache-write price is unavailable, so a nonzero Argon cache write is unpriceable. To use a later verified rate card, add one dated JSON file and pass `--pricing <file>` when rescoring; update the batch scorer's default before creating a new batch. Existing batch pins stop mid-batch price changes.

The cost cutoff is separate from `--end-at`, which limits timing only. Usage can be written after the final message, so cost captures through the start of scoring. Score promptly, before sending more messages to the run. Timeout and stalled rows include usage up to that snapshot, not later shutdown work. `--replace` takes a new snapshot; retain the recorded cutoff and rate digest when comparing costs.

## Calibration

The first full-feature-set run of each variant is its calibration run; `score` marks it `calibration` = `yes`. When every variant has one, look at the median of all of them (`npm run score -- --summary` prints it):

- **30 minutes or less:** the calibration runs count as scored runs. Carry on with the full feature set.
- **Over 30 minutes:** drop Summary, once, before any scored run. Start every later run with:

  ```bash
  npm run new-run -- --variant <v> --features policy,reports,import
  ```

  This removes Summary from the run repo's spec. The kickoff is the same for every feature set: it names no features and doesn't say how many there are. `score` reads the feature set from the spec in the run repo's first commit, and runs the suite without the Summary tests. A variant whose first run comes after this has no calibration run: that run is a scored run.

The calibration median uses every calibration run of the full feature set. Passed and gate-failed runs count with their minutes. Timeout and stalled runs count as longer than any finished run. Only passed runs enter the per-variant time comparison.

Calibration rows stay in `results.csv`. If Summary was dropped, only the full-feature-set calibration rows are left out of the summary; every other row counts. They are in a different feature set from the scored runs, so they are never compared with them.

### Pinned A/B/C review-policy comparison

The comparison for [#49](https://github.com/ncksol/ai_tools/issues/49) uses three immutable variants, not the moving installed `orchestrator` agent:

| Variant / result label | Policy |
|---|---|
| A / `orchestrator-review-a` | The original `orchestrator` at `a7e3fb04a697745a3cf1cc82137429913bbc0982`. |
| B / `orchestrator-review-b` | The new tiered cross-vendor reviews and final panel at main commit `c7b48ea1f78c702b48646019eb568220d27b74ef` (the squash merge of [#50](https://github.com/ncksol/ai_tools/pull/50)). |
| C / `orchestrator-review-c` | B with Argon at `high` for regular reviews of Opus-written code only. Sonnet routing, critical reviews and final panels remain B. |

All snapshots live in `variants/`, outside `ghcp/agents/`. `variants/review-policy.json` pins their exact bytes. Its three `variants` entries use the alias file ID as both result label and `agent`, and include the full source `revision`, relative `file` path and `sha256`. One root `workers` map pins `orchestrator-worker` for all three; its source is identical in A and B. A and B change only their source frontmatter's `name`. C additionally changes exactly the regular-review tier row and routing sentence. Tests compare normalized source hashes, not moving branch names.

Before a batch, **the user** registers each alias as one file at the top level of `~/.copilot/agents/`: `orchestrator-review-a.agent.md`, `orchestrator-review-b.agent.md` and `orchestrator-review-c.agent.md`. Copy the corresponding files from `variants/`, or link each file individually into a checkout that will not move. Do not link the whole `variants/` folder: folder registration changes agent IDs. Keep each `name` equal to its file ID, its source description unchanged and `disable-model-invocation: true`. Do not add policy or pricing metadata to alias frontmatter or labels. The snapshots omit `user-invocable: false` because its effect on detached top-level `kickoff.agent` has not been verified.

Register only when no batch is active, without replacing the normal `orchestrator` or an existing alias from another batch. The installed `orchestrator-worker` must match the manifest's shared worker hash; a missing or different worker fails preflight. If it is linked into a moving checkout, pulling that checkout during a batch stops the batch. Normal installed `orchestrator` updates alone do not affect manifest batches: they pin only declared aliases and workers, not agent names mentioned in prompt prose. The kit never installs or changes agents. After the pilot and when no batch is active, remove only the three temporary alias files from `~/.copilot/agents/`; retain the normal agents and worker.

The user launches the pilot with:

```bash
npm run batch -- init --variants-file variants/review-policy.json --runs 3 --memory-off
```

`--variants-file` cannot be combined with `--variants` or a self-test-only batch. The batch stores the resolved manifest and pins its bytes and snapshots. At launch it verifies the registered files and records the alias hash and bundle digest. It re-hashes them before scoring and flags `agent-drift` on a mismatch, retaining the launch hashes in the result. These prove registered-file provenance, not which prompt bytes the CLI loaded. The scorer accepts the complete set of `--agent-revision`, `--agent-sha256` and `--agent-bundle-sha256` flags with session-log timing; the batch supplies them automatically.

**Every exact A/B/C bundle must first have a full-feature calibration row; the early shortcut is disabled.** A historical row without matching alias and bundle hashes does not replace A's calibration. Once all three exist, the runner computes the Calibration rule once over **all full-feature calibration rows**, including the historical 65.7-minute row, and freezes that shared decision in batch state before any scored run. If the median exceeds 30 minutes, all variants drop Summary. If it is 30 minutes or less, the runner stops through its normal notification and morning-report path: keeping Summary contradicts the approved pilot, so it requires a user decision rather than silently changing scope. Pinned calibration rows never enter the scored comparison.

Start with three scored attempts per variant after calibration: A1/B1/C1, A2/B2/C2, A3/B3/C3. Failures count toward those three attempts and the pass rate; only passes enter median minutes. A manifest batch's `--runs N` means **N cumulative scored attempts per variant**, matching label, logged agent, alias hash, bundle hash and decided feature set in `results.csv`. A pinned row whose logged agent differs from its label, or is missing, stays in the CSV for diagnosis but contributes to no calibration, calibration median, pilot target or scored comparison. The batch lets that run finish and its swarm drain, then stops through the normal failure notification/report path without starting another run. A second night plans only missing attempts, keeps the prior pilot's feature set and stops at three each, rather than adding another nine runs. Legacy `--variants` batches still count attempts within that batch. After the pilot, the user fixes the total sample size before authorizing a larger `--runs N`. Do not change policies, prices or test suites midway through a batch.

## Manual timing

`score` finds the orchestrator session on its own. Of the sessions in `~/.copilot/session-state/` whose `workspace.yaml` names the run repo, it takes the one you started: it has an `events.jsonl`, and its first message came from you, not from another session. That leaves out sessions that never ran, such as one the app opens when you add the project, and the orchestrator's child sessions, whose kickoff the app marks as sent by another session. If you started more than one, it takes the one whose agent has the variant's name. If that still leaves none or several, `score` stops with exit code 2, lists the sessions with their created time, agent and status, and asks you to pass `--session <id>`. `--session` also overrides the search. The id is the session's folder name in `~/.copilot/session-state/`.

The event log format is internal to Copilot and may change. `score` ignores an unfinished last line in `events.jsonl` (a write still in progress). Any other line it can't read makes it stop with exit code 2 and point here. Then time the run by hand:

1. In the session, find the time you sent the kickoff and the time of the final report. For a timeout or stalled run, use the time you saw it had ended.
2. Add up the minutes the run spent waiting for your answers: from each question to your answer.
3. Count the questions.
4. Run:

   ```bash
   npm run score -- --repo-dir ~/orch-evals/<name> --start <iso> --end <iso> --blocked-min <m> --questions <n>
   ```

   `<iso>` is an ISO 8601 date and time with a time zone, for example `2026-10-18T14:05:00+01:00`. Add `--outcome timeout` or `--outcome stalled` if the run didn't finish. `score` still runs the suite and fills the GitHub columns. Write the model and effort in `--note`, because they can't be read from the log.

## Memory hygiene

An overnight batch runs with Copilot Memory turned off instead; see [Overnight batches](#overnight-batches).

After each run, check your user-level Copilot memories for anything saved during the run that relates to the orchestrator or to this eval, and remove it. User memories carry into later runs and would skew them.

Repo memories don't carry over, because every run uses a new repo.

## Cleaning up

Run repos stay on GitHub until you delete them. Deleting a repo needs a token with the `delete_repo` scope, or the GitHub web UI. The usual `GH_TOKEN` doesn't have that scope, and `gh auth refresh` can't add a scope to a token from the environment, so you need a new token.

Local clones and kickoff files are in `~/orch-evals/`. Delete them when you no longer need them.

## Overnight batches

An overnight batch runs the eval for several agents while you sleep: in rounds of one run per agent, side by side, each run scored and committed as it ends, with phone notifications and a report for the morning. It follows the manual protocol above as closely as the app allows, apart from running agents side by side (see **Order** under [What the runner decides](#what-the-runner-decides)). The other differences are under [What can't be automated](#what-cant-be-automated).

Two parts do the work:

- **The runner**, `npm run batch` (`scripts/batch.ts` and `scripts/lib/batch/`), does every step a script can do. It plans the runs, creates each run repo with `new-run --n <k>`, watches the run's session logs, scores, commits `results.csv`, sends notifications and writes the morning report. The plan and all state are files in `~/orch-evals/batches/<id>/`, so any step can be resumed.
- **The driver** is one app session running the `eval-runner` agent (`ghcp/agents/eval-runner.agent.md`) in autopilot. It makes only the app-tool calls the runner can't make, and a few judgments. It waits inside `node scripts/batch.ts next`, which blocks for up to 7 minutes and returns the next step as JSON, so the driver stays busy and polls nothing through the model.

Only one batch is active on the machine at a time (`~/orch-evals/active-batch/`, whose newest numbered revision names the batch by its folder and id), and only one driver runs a batch: the first driver to call `next` owns it. Another driver is refused while the owner's session is alive, and takes over once it is gone. Every change to a batch's state happens under a kernel lock (`flock`, through `/usr/bin/lockf`) on `runner.lock` in its folder; the kernel releases it when its holder exits, so a crash never leaves a stale lock. The holder has its own process group so a Ctrl-C to the runner's group cannot drop the lock before command cleanup finishes. It still exits on stdin EOF if the runner dies, including SIGKILL. Every command the runner starts (git, `gh`, `new-run`, `score`) has a time limit. When it runs out, the command's whole process group gets SIGTERM, then SIGKILL after 5 seconds if anything in it is still alive, and the call returns only once the group is gone or SIGKILL has been sent and waited for (up to 5 more seconds); the command counts as failed.

### How a run goes

1. The runner creates the run repo with `new-run`, choosing `--n` itself.
2. The driver calls `create_project` with the clone's path, then `create_session` with `detached: true`, `coordinate_with_creator: false`, `workspace_type: "worktree"` and the kickoff: the exact text of `kickoff.md`, the variant as `agent` (or its pinned manifest alias), `claude-opus-5.5` at `max`, `context_tier: "long_context"`, `mode: "interactive"`. The run is a top-level session whose kickoff has no `data.source` and no cross-session tag, so `score` sees it as started by you.
3. Questions:
   - An `ask_user` question is answered at once with `answer_session_input`, as free text, word for word from `answers.md`. A `[unit=… need=plan]` tag means row 1 and `need=pr` row 2, and the action carries that reply. For any other question the action carries the replies of rows 3 and 4, and the driver picks row 3 (about the spec) or row 4. If a prompt allows no free text, the driver picks the closest choice and the run is flagged.
   - The driver answers only the question the runner saw in the log. If `get_session` shows a different question, or a retry shows a different `request_id` from the one seen before (on an answer or a failed attempt), it answers nothing and the run is flagged.
   - A question asked in plain text gets the same reply through `send_session_message`. The run is flagged, and `score --answer-source` is given the reply's `data.source`, read from the run's log, so the answer still counts as a question and as blocked time.
   - The driver never touches the run's child sessions and never sends anything else before the run is scored.
4. The end:
   - **Final report:** when the orchestrator goes idle, the driver judges whether a message is its final report: a message that says the attempt has ended, whether it claims success or reports an honest failure. The acceptance suite then decides between `passed` and `gate-failed`. The runner waits for the whole swarm (the orchestrator and every child session) to go quiet, for at most 5 minutes, then runs `score --end-at <the report's exact timestamp>`.
   - **Timeout:** more than 90 minutes after the kickoff, `score --outcome timeout`. A final report written within the 90 minutes is still judged first and scored at its own time, however late the runner sees it.
   - **Stalled:** 15 minutes without a new event in any of the swarm's logs, `score --outcome stalled`. An open `ask_user` question is not a stall: the swarm is waiting on the user, and that wait is blocked time.
   - **Blocked by a permission prompt:** a tool-permission request anywhere in the swarm, sub-agents included, still waiting for approval after 30 seconds, or one the runtime denied because it could ask no one (`decisionSource: "unattended_fallback"`). Nobody can answer either, so the run is void: it is not scored, gets no row in `results.csv` and counts toward neither its variant's scored runs nor the calibration. It still gets the stop message and the drain wait, so a swarm that is still working stops, and then the batch stops (see **Stopping**). An open `ask_user` question is not a permission prompt. See [Tool permissions](#tool-permissions).
   - Scoring comes first. After a timeout or a stall, and only then, the driver tells the orchestrator to stop all work and archive its child sessions, and the runner waits up to 20 minutes for the swarm to go quiet.
   - The next round starts only when every run of the round has ended on a quiet swarm. After a final report, the runner gives the swarm 10 minutes to go quiet, then sends the same stop message and waits up to 20 minutes more. A swarm that is still busy after the stop message stops the batch once the round's other runs have ended, and the report lists its sessions.
5. Before scoring, the runner checks every log of the swarm for loaded memories, `store_memory`, `vote_memory` and `session_store_sql`, and flags any it finds. It passes `score` a note such as `batch=<id>; driver=eval-runner; memory=off; flags=<codes>`, so the row in `results.csv` records the batch, Memory being off and the flags known before scoring; `score` adds its own warnings after it. Flags found later, for example memory use after scoring, are in the report, a short follow-up notification and the batch's final notification; the row and the score stay as they were, and a run is never scored again for them.
6. The runner commits `results.csv` on the driver's branch (never `main`) and pushes that branch. A commit that fails is tried again; after three failures no further run starts and you are notified. Then it sends the run's outcome to your phone.

### What the runner decides

- **Order:** runs go in rounds. A round has at most one run per variant and at most `--parallel` runs, which defaults to the number of variants. A round's runs start together, and the next round starts only when all of them have ended. The variants with the fewest scored runs go first: in the current batch for legacy `--variants`, or across matching history for `--variants-file`. Ties follow the listed variant order. A run with no row in `results.csv` doesn't count, so a void run is replaced. The defaults are the four orchestrators, `orchestrator`, `session-orchestrator`, `hands-on-orchestrator` and `hands-on-session-orchestrator`, with 3 scored runs each, all four side by side. Runs side by side share the laptop and accounts, which a manual run has to itself (see [Known limits](#known-limits)); `--parallel 1` runs one at a time, as a manual run does.
- **End:** there is no deadline. The batch runs until every variant has its scored runs, it stops early (see **Stopping**), or you run `npm run batch -- stop`. The runner checks for a stop and the pinned inputs again just before it gives the driver a `create_session`, so a run planned before a stop doesn't start after it. Runs in progress finish.
- **Calibration:** the rule in [Calibration](#calibration), applied automatically. For ordinary `--variants` batches, the calibration median uses every full-feature calibration row, plus one run for each batch variant that has no row yet. If the decision is the same whether those missing runs take 0 minutes or never finish, no calibration run is needed. While the decision is open, a round holds only calibration runs, so it is made before any scored run starts. With today's `results.csv` and the four default variants, run 1's 65.7 minutes doesn't decide it, so the first round is the calibration runs of the other three variants. `--variants-file` disables that shortcut and freezes the shared decision after every pinned variant calibrates, as described above.
- **Pinning:** at the start the runner hashes the agent files under test and their workers, resolved through the `~/.copilot/agents` symlinks. Ordinary variants use named-agent discovery; manifest variants use only their explicitly declared aliases and workers. It also pins `kickoff.md`, `answers.md`, the scorer, acceptance and robustness suites, pricing files, script libraries, the manifest and snapshots if selected, and app/CLI versions. If any pinned input changes, no further run starts and the batch stops.
- **Stopping:** the batch stops early after two runs in a row that fail to start, two runs in a row that `score` can't score, a failed self-test, a pinning change, a results commit that keeps failing, a swarm that is still busy after the stop message, or a tool-permission prompt in any run's swarm. It notifies you either way. A stop during a round starts no new run: the round's runs that have started finish, and those that haven't are void, with no notification, and don't count as failed starts. After a permission prompt, the round's other started runs go on as usual: each is scored at its own end, or voided if it hits a prompt too. Whether a prompt came before or after a run's end is decided by the request's own timestamp: a request from before the final report (or, for a timeout or stall, before `score` runs) voids the run, even when it is found later, and the runner checks again just before scoring, also after a restart. If the orchestrator wrote messages before the prompt that haven't been judged, the driver judges them first, so a final report written before the prompt still ends the run there. A prompt that starts after a run's end keeps that run's result but still stops the batch. The runner keeps checking the swarms of finished runs until the batch finishes. The notification and the report's "Tool-permission prompts" section name the run, the request and the remedy.
- **Unconfirmed starts:** if the driver stops after calling `create_session` but before recording it, the runner looks for the session in the logs and `~/.copilot/data.db`, from the time the action was first issued, before doing anything else. It adopts the session if it finds one; otherwise it waits 5 minutes, then gives the action once more if the run may still start. The round's other runs get no actions while it waits. If a session turns up later for a run it gave up on, no further run starts.

Each run's flags are listed in the report and the run's phone notification. A flag doesn't change the run's row in `results.csv`; check flagged runs before you trust their rows.

| Flag | Meaning |
|---|---|
| `memory-loaded`, `memory-write` | A session in the swarm had memories in its prompt, or called `store_memory` or `vote_memory`. Copilot Memory wasn't off. |
| `history-query` | A session called `session_store_sql`, so it could read past sessions. |
| `plain-text-question`, `choice-answer`, `answer-retry` | A question was answered through `send_session_message`, with a choice instead of free text, or needed a second try. |
| `permission-prompt` | A tool-permission request was pending past 30 seconds or denied because no one could be asked. Before the run's end this voids the run; after it, the run's result stands. Either way the batch stops. |
| `open-tool-at-stall` | A tool call was still open when the run stalled, for example an MCP elicitation, which no app tool can answer. |
| `answer-mismatch` | The pending question or its `request_id` differed from the one the runner saw; it wasn't answered. |
| `kickoff-text`, `kickoff-shape`, `session-settings` | The kickoff text, its sender, or the agent, model, effort or context tier differ from what was asked for. The kickoff is compared with `kickoff.md` without its trailing newline, which is what a manual paste delivered in run 1. |
| `agent-drift` | A registered alias or worker no longer matches its launch pin, or launch provenance is missing. The result retains any verified launch hashes; check the run before trusting its comparison group. |
| `swarm-not-quiet` | The swarm was still active when the run was scored, after scoring, or after the stop message. |
| `clock-jump`, `app-db` | The clock went back, or a query of `~/.copilot/data.db` failed. Durations never go negative. |
| `driver-gap` | The driver was away for over 10 minutes during the run. If the app stopped the run's session meanwhile, the run is void instead. |
| `score-failed`, `score-warning`, `commit-failed`, `answer-source-unknown`, `send-failed`, `start-failed` | A step failed, ran out of time or `score` printed a warning; the detail is in the report and in `~/orch-evals/batches/<id>/runs/`. |

### One-time setup

1. Install the driver agent from the root of your main checkout of this repo, like the other agents:

   ```bash
   cd "$(git rev-parse --show-toplevel)"   # the repo root, not the kit folder; run it in your main checkout, not a worktree
   ln -s "$PWD/ghcp/agents/eval-runner.agent.md" ~/.copilot/agents/eval-runner.agent.md
   cd evals/orchestrator/expense-claims   # back to the kit folder for the commands below
   ```

   Run the driver on Claude Opus 5.5 at `high`. It makes only a few calls per run, and its judgments decide answers and end times.
2. Put your ntfy topic URL (the one your mobile-notification skill posts to) in a private file outside the repo:

   ```bash
   mkdir -p ~/.config/orch-evals
   printf '%s\n' 'https://ntfy.sh/<your topic>' > ~/.config/orch-evals/ntfy-url
   chmod 600 ~/.config/orch-evals/ntfy-url
   npm run batch -- notify-test
   ```

   The environment variable `ORCH_EVAL_NTFY_URL` overrides the file, but app sessions may not see variables from your shell. The runner hands the URL to `curl` on stdin and never logs or stores it. Without a topic the batch runs without notifications.
3. Optionally, see the whole flow without the app: `npm run batch -- rehearse` runs a batch of four runs, two at a time, and a self-test in a scratch folder. The app and the driver are replaced by a script, and notifications go to a local stub. It uses the real `new-run --dry-run`, `score` and git, and touches nothing outside the scratch folder. Its deliberately absent scratch app database produces incomplete cost with a warning, not a complete dollar total. `score` times timeout and stalled runs to the real clock, so their minutes are wrong in a rehearsal.

### Starting a batch

1. Do the manual steps. The preflight prints them too:
   - In the Copilot app, make the batch owner (`--owner`, default `ncksol`) the default account. The projects the runner creates have no account of their own, so their sessions run as the default account, with its Memory setting, GitHub access and quota. Switch it back in the morning.
   - Turn Copilot Memory off at https://github.com/settings/copilot/features, signed in as that account.
   - Keep the laptop on AC power with the lid open. Don't log out, restart or quit the app.
   - Defer macOS updates and app updates for the night.
   - Leave nothing else heavy running, and don't use this account's Copilot for other work.
2. In the Copilot app, start a new session in your `ai_tools` project: a worktree on its own branch, not `main`. Select the agent `eval-runner` and autopilot mode, and send something like:

   > Create an overnight eval batch: variants orchestrator,session-orchestrator,hands-on-orchestrator,hands-on-session-orchestrator, 3 runs each. Copilot Memory is off.

   The driver runs `npm run batch -- init` with `--memory-off` only because your message says Memory is off. The preflight checks AC power, free disk space, the `gh` account and its `repo` and `workflow` scopes, API rate limits, Node 24, the app version (1.1.30 or later), every `~/.copilot/data.db` column the runner reads, that the app's default account is the owner, that no other batch is active, that `score` supports the runner, the agents under test, the results branch and git identity, and the notification topic. Any FAIL creates no batch.
3. The batch starts with the self-test. Wait for the "self-test passed" notification, a few minutes later, before you leave. A failed self-test stops the batch.

To create the batch from a terminal instead, run `npm run batch -- init` in the driver's worktree; it asks you to confirm that Memory is off. Then send the driver `Run eval batch <id>.` To resume a stopped driver, for example after an app restart, send a new `eval-runner` session in the same worktree `Resume eval batch <id>.` The new driver takes over once the old driver's session has stopped; if the old session is still open, archive it first. If the runner can't tell whether the old driver is gone, `npm run batch -- take-over --batch <id>` releases the batch; only you run that.

### The self-test

Every batch starts with a self-test, and `npm run batch -- selftest` (or asking the driver for "an eval runner self-test") runs it alone. It takes the whole path with a harmless setup: the default agent on `claude-sonnet-5.5` at `low`, never an orchestrator, in a local scratch git repo with no GitHub remote. It checks:

- `create_project` and a detached `create_session` work;
- the kickoff arrives unchanged, with no `data.source` and no tag, so `score` sees it as started by you;
- the model and effort are the ones asked for;
- a shell command runs with nobody present: the session runs `pwd && echo eval-selftest-<nonce>`, a compound command that host policy doesn't approve on its own, with its shell tool (`bash`, or `powershell` on Windows), and the command completes and prints the marker on a line of its own. Another tool that merely carries the marker doesn't count;
- the session's log has no tool-permission request in manual mode, none pending and none denied. A session with allow-all permissions logs no permission request at all. A request left waiting for 30 seconds fails the self-test at once, without waiting for the 20-minute limit;
- an `ask_user` question is answered word for word with `answer_session_input`;
- the end is detected;
- the session has no creator link;
- the new project runs as the batch owner (its Copilot account, else its GitHub account, else the app's default account, from `~/.copilot/data.db`);
- every `~/.copilot/data.db` lookup the runner uses answers for this session and project;
- no memories were loaded, which shows that Memory is off.

The driver has its own rule for the self-test: the response after the answered question is its final message, whatever it says.

### Tool permissions

A run must use tools with nobody present: no one is awake to approve a prompt, and no app tool can answer one. A session with allow-all permissions logs `session.permissions_changed` with `allowAllPermissions: true` and no permission requests. The app grants allow-all only to sessions in a project whose repository is trusted on this machine: it holds a session in an untrusted project at manual tool approval, whatever permission mode was asked for (its log says "Holding session at manual tool approval until its repository is trusted"). Only a person can trust a repository, in the app; no agent tool can. In manual permission mode, host policy approves some reads and single read-only commands such as `git status` within milliseconds, but a compound command, `npm test` or `archive_session` waits for a user, and in autopilot the runtime denies it (`decisionSource: "unattended_fallback"`). The `auto_approve` flag of a project in `~/.copilot/data.db` doesn't change this.

**Known limitation:** in app 1.1.30, projects created by `create_project` are untrusted, and the app holds their sessions at manual tool approval until someone trusts the repository in the app; no agent tool can grant trust. The runner creates every project with `create_project`, the self-test's included, so until that changes an unattended batch stops at the self-test, which is the intended result: no run repo is created, and the notification and the report say why. Batch 20261021-2217 ran before the self-test checked this: all 15 of its runs waited on prompts until the stall rule ended them. Run 1 worked because its project was added and trusted by hand.

If a prompt appears during a batch anyway, the run is void and the batch stops (see **Blocked by a permission prompt** under [How a run goes](#how-a-run-goes)). Before the next batch, make sure the batch's projects will be trusted, and run the self-test alone (`npm run batch -- selftest`) to confirm it.

### In the morning

1. The batch has no deadline, so it may still be running. `npm run batch -- status --batch <id>` shows where it stands, and `npm run batch -- stop --batch <id>` starts no new run and lets the runs in progress finish. When the batch ends, your phone has the final notification. The report is `~/orch-evals/batches/<id>/report.md`; the driver prints it too.
2. Turn Copilot Memory back on, and switch the app's default account back if you changed it.
3. Archive the sessions the report lists. The driver can't archive detached sessions.
4. Review the flagged runs.
5. Land the results: the report lists the `results.csv` commits on the driver's branch, which the runner pushed. Open a pull request from that branch into `main`.
6. Clean up repos and clones as in [Cleaning up](#cleaning-up).

### Batch commands

| Command | What it does |
|---|---|
| `npm run batch -- init [--variants a,b \| --variants-file <manifest.json>] [--runs 3] [--parallel <n>] [--memory-off]` | Runs the preflight and creates a batch. `--parallel` defaults to the number of variants; `--parallel 1` runs one at a time. Other options: `--model`, `--effort`, `--context-tier`, `--owner`, `--self-test-model`, `--self-test-effort`, `--self-test-agent`, `--runs-dir`, `--batches-dir`, `--no-push`. |
| `npm run batch -- selftest [--memory-off]` | Creates a batch that only runs the self-test. |
| `npm run batch -- next --batch <id>` | The driver's loop: does what it can, then prints the next action as JSON. |
| `npm run batch -- record --batch <id> --action <id> ...` | Records an action's result. |
| `npm run batch -- status --batch <id>` | Shows the batch, its runs and any pending action. |
| `npm run batch -- stop --batch <id>` | Starts no new run; the runs in progress finish. |
| `npm run batch -- take-over --batch <id>` | For you only: releases a batch from a driver that is gone but that the runner can't confirm is gone. |
| `npm run batch -- report --batch <id>` | Prints the report from the current state. |
| `npm run batch -- alert --batch <id> --message <text>` | Sends a problem notification; the driver uses it when the runner keeps failing. |
| `npm run batch -- notify-test` | Sends a test notification. |
| `npm run batch -- rehearse` | Runs a stubbed batch in a scratch folder. |

`--batch` takes a batch id, a path, or `latest`. `init --dry-run` creates a batch that skips GitHub, for tests only: the driver refuses to drive it.

### What can't be automated

| Limit | Workaround |
|---|---|
| Copilot Memory can't be cleaned up between runs: there is no API, only the web settings. | Turn Memory off for the whole batch. The preflight asks you to confirm it, the self-test checks that no memories load, every run is checked for memory use, and the final notification reminds you to turn it back on. Batch results are "Memory off" runs; compare them with manual runs made the same way. |
| The driver can't archive detached sessions (`archive_session` refuses them). | The report lists the sessions to archive. The app's auto-clean also archives them after its set number of days. |
| Tool-permission prompts and MCP elicitations have no answering tool. | Runs need allow-all tool permissions, which sessions in projects that `create_project` makes don't get today, because the app doesn't trust those projects (see [Tool permissions](#tool-permissions)); the self-test checks it with a shell command. A permission prompt during a batch voids the run and stops the batch. An MCP elicitation is flagged, and the stall rule ends the run. |
| A question asked in plain text can only be answered with `send_session_message`, which the orchestrator sees as a message from another session. | The run is flagged. `score --answer-source` still counts the reply as a question and as blocked time. |
| The driver starts the runs, so the app records them as created by an agent. | Nothing reads that in a way that changes the run. The kickoff is otherwise the same as a typed one, and the self-test checks it. |
| An app restart or update stops every session, including the driver and the runs in progress. | The batch waits until you resume the driver, and nothing sends a notification meanwhile: missing run notifications are the sign. On resume, the runner reads `sessions.was_interrupted` in `~/.copilot/data.db` (read-only), voids those runs without scoring them, and later rounds replace them. Defer app updates for the night. |
| Behaviour with the screen locked is unverified. | Keep the lid open and the laptop on AC power. Sessions are background CLI processes, and the runner holds `caffeinate -is` for the whole batch. |
| The end of a run is the driver's judgment of the final report. | `score --end-at` pins the end to the report's exact timestamp, so the time the driver takes doesn't count. Timeout and stalled runs are scored within one poll (10 seconds) of the rule firing, or later while the runner is busy with another run of the round, for example scoring it. That delay adds to the run's minutes, which no time comparison uses. |
| The runner sees a session's log, not whether the session is busy. | Activity is a new event in any of the swarm's logs. A command that writes nothing to the log for 15 minutes while every other session is idle counts as a stall, where by hand you might see a busy session. Such a run gets an `open-tool-at-stall` flag. |

## Known limits

- Runs vary a lot. Three runs per variant may still be noisy.
- GitHub Actions queue time adds noise to merges that wait for CI.
- Batch runs side by side compete for the laptop's CPU, the GitHub account's API limits and Actions runners, and Copilot rate limits, so they may be slower than runs made one at a time. Compare runs made the same way; `--parallel 1` gives one-at-a-time runs.
- The seed app listens on port 3000 when `PORT` isn't set. If agents in two runs side by side start it that way, the second can't bind the port.
- An agent that searches the disk could find this kit in a local checkout of this repo.
- Merge conflicts in `src/routes.ts` and the README are deliberate: every feature adds routes and endpoint rows. They may cost more time than expected.

## Changing the kit

After any change, run from this folder:

```bash
npm test
npm run check
```

`npm run check` runs the kit's local acceptance checks, including the robustness suite on the reference, and prints one `PASS` or `FAIL` line per check. The real-log score check prints `SKIP` unless you run `node scripts/check-kit.ts --session <id>`; the kit tests still exercise scoring with synthetic whole-swarm logs. They also prove that a permissive parser passes all 65 gate tests but fails nine robustness cases without changing its score, and run a fully stubbed 12-attempt A/B/C calibration-and-pilot sequence without real app sessions or GitHub repos.

To run the acceptance suite on an app folder by hand:

```bash
npm run acceptance -- --app <dir> [--features <list>] [--only <v1|feature>] [--verbose]
```

The suite runs its test files one at a time. Each test starts the app on a port that no other process holds on `127.0.0.1`, `::1`, `0.0.0.0` or `::`, and calls it on the loopback address where it answers, so the app may listen on IPv4 or IPv6 loopback. If another process takes that port first, it retries on a new port. The harness has these time budgets, and a test that hits one fails:

- the app gets 10 seconds after start to answer `GET /health`;
- each request gets 30 seconds, including its response body;
- each suite test gets 60 seconds.

If you change `seed/docs/spec-v2.md`:

- copy it to `reference/docs/spec-v2.md` (`npm test` and `npm run check` check that the copies match);
- update the suite and the reference, so that every suite assertion still maps to a statement in the spec or in `seed/README.md`.

Old `results.csv` rows are then not comparable with new ones. Say so in their `note`.

If you change `kickoff.md`, keep it to a few plain-text lines. `npm test` and `npm run check` check that it:

- is at most 800 characters (`KICKOFF_MAX_CHARS` in `scripts/lib/kickoff.ts`);
- points at `docs/spec-v2.md`;
- shares no run of eight words and no whole line with the spec, and has no markdown heading or code fence;
- names no feature and gives no feature count;
- says nothing about the hidden suite, the reference, scoring or the kit.
