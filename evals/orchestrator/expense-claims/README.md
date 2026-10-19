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
| `scripts/` | `new-run`, `score`, the acceptance runner, the kit check and their tests. |
| `package.json` | The npm scripts: `test`, `check`, `new-run`, `score` and `acceptance`. |

Only `seed/` goes into a run repo. Never copy `acceptance/` or `reference/` into a run repo, never paste them into a session, and never mention them in the kickoff.

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
3. Start a **new top-level session** in that project with the agent under test, using the held-constant model and effort. **An orchestrator run is always a top-level session that you start. Never start one as a child of another session, and never ask an agent to start one.**
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

`score` reads this from the session's event log. It ignores events written by sub-agents. It counts each `ask_user` call and each of your messages after the kickoff as one question. Messages with a `data.source` or a `<cross_session_message` tag in `transformedContent ?? content` are not human messages, even if the tag arrives without a source.

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

Only passed runs enter the time comparison. For each variant, compare the median minutes of its passed runs, and its pass rate. Compare runs only within one feature set. To print the medians, pass rates and the calibration state:

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

Commit `results.csv` after each run, so the history across agent versions is kept.

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

After each run, check your user-level Copilot memories for anything saved during the run that relates to the orchestrator or to this eval, and remove it. User memories carry into later runs and would skew them.

Repo memories don't carry over, because every run uses a new repo.

## Cleaning up

Run repos stay on GitHub until you delete them. Deleting a repo needs a token with the `delete_repo` scope, or the GitHub web UI. The usual `GH_TOKEN` doesn't have that scope, and `gh auth refresh` can't add a scope to a token from the environment, so you need a new token.

Local clones and kickoff files are in `~/orch-evals/`. Delete them when you no longer need them.

## Known limits

- Runs vary a lot. Three runs per variant may still be noisy.
- GitHub Actions queue time adds noise to merges that wait for CI.
- An agent that searches the disk could find this kit in a local checkout of this repo.
- Merge conflicts in `src/routes.ts` and the README are deliberate: every feature adds routes and endpoint rows. They may cost more time than expected.

## Changing the kit

After any change, run from this folder:

```bash
npm test
npm run check
```

`npm run check` runs the kit's local acceptance checks and prints one `PASS` or `FAIL` line per check. The score check needs a real session log, so it prints `SKIP` unless you run `node scripts/check-kit.ts --session <id>`.

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
