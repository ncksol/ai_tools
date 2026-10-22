# Overnight runner for the orchestrator eval — design

Date: 19 October 2026. Status: built, with pre-provisioning and user trust at batch start. A trusted local project's shell probe has run on the real app; the complete batch and trust on a `create_project`-origin project still need a real start.

## How to read this

Every decision carries one label, as in [the eval's design](2026-10-18-orchestrator-eval-design.md):

- **Decided by the user**: the user's own requirement, or a decision the user approved.
- **Design call**: made on the user's behalf while building, not yet reviewed. Treat as a sound default, not as agreed.

The user's request: "analyse the eval framework in this repo. create a system that I can use to run a full evaluation over multiple different agents over night fully automated without me having to be near the laptop when it is running. it should perform as good as if I was running it manually one by one. if some things are not possible (like memory clean up), find workarounds or tell me"

## Intent

The [orchestrator speed eval](../../../evals/orchestrator/expense-claims/README.md) is run by hand: one run takes about an hour of wall time, and every run needs the user to add a project, start a session, paste the kickoff, answer questions, watch for the end, score and clean up. Several variants with three runs each is a whole day of attention.

The overnight runner does the same protocol unattended: the user starts it before bed and reads a report in the morning. Its results must be as comparable as a manual run's, so every place where automation differs from a manual run is either removed, measured, or flagged and listed.

This supersedes one non-goal of the eval's design ("Automating the Copilot app itself"). The anti-goal stands: an orchestrator run is never a child of another session.

## Goals, non-goals, anti-goals

### Goals

- A full batch over several variants runs with no one at the laptop. **Decided by the user**
- Each run is as close to a manual run as the app allows: the same seed, kickoff, answers, model and effort, held-constant settings, and scoring. **Decided by the user**
- What can't be automated is worked around or reported. **Decided by the user**
- A stopped or compacted driver can resume a batch without losing or repeating steps. **Decided by the user**
- The whole flow can be rehearsed and tested without the app. **Design call**

### Non-goals

- Running variants in parallel. **Decided by the user**
- Cleaning up Copilot Memory between runs. No API exists; Memory is off for the whole batch instead. **Decided by the user**
- Archiving the run sessions or deleting run repos. The driver can't archive detached sessions, and deleting repos needs a scope the token lacks. **Decided by the user**
- Changing how `score` times a run. The score fixes are a separate change; the runner uses their interface. **Decided by the user**

### Anti-goals

- An orchestrator run started as a child session, by `send_session_message`, by the CLI, or in any way other than a detached top-level `create_session` from the runner. **Decided by the user**
- Any message to a run before it is scored, other than the answer sheet's replies: no nudges, status checks or hints. **Decided by the user** One narrow exception, a **Design call** rather than a user decision: a run voided by a tool-permission prompt, which will never be scored, gets the fixed stop message (see "A tool-permission prompt voids the run" under [The end of a run](#the-end-of-a-run)).
- A run's own orchestrator sending notifications or doing batch housekeeping. **Decided by the user**
- The self-test using an orchestrator agent. **Decided by the user**

## Architecture

Two parts: a runner script that holds the plan, the state and every deterministic step, and a driver agent that makes the calls only an app session can make.

- **The driver** is one app session running the custom agent `eval-runner` in autopilot, started by the user in an `ai_tools` worktree. **Decided by the user**
- **The runner** is `npm run batch` in the kit: Node 24 TypeScript with no npm dependencies, like the rest of the kit, in `scripts/batch.ts` and `scripts/lib/batch/`. **Design call**
- All state lives in files in `~/orch-evals/batches/<id>/` (`config.json`, `state.json`, `runner.log`, score logs, the report), written atomically. So context compaction or a driver restart loses nothing. **Decided by the user**; the folder and file layout is a **Design call**.
- The protocol between them is an action loop. **Design call**
  - `next` performs every deterministic step it can. When the next step needs an app tool or a judgment, it prints one JSON action with the exact tool arguments and the `record` commands that fit.
  - The driver does the action and runs `record` with the result.
  - `next` blocks for up to 7 minutes when there is nothing to do, so the driver waits inside a bounded shell call and doesn't poll through the model. **Decided by the user** (the bounded wait), **Design call** (7 minutes, which leaves room in a 10-minute shell call to score a run).
- Every action has an id and is re-issued until it is recorded. A `send_message` that already arrived in the run's log is adopted instead of being sent again. **Design call**
- Exclusive access. **Decided by the user** (after the core review):
  - The batch lock is a kernel `flock` on `runner.lock` in the batch folder, taken by a child process (`/usr/bin/lockf -k -t 0 runner.lock sh -c 'echo locked; exec cat'`, or `flock(1)` on Linux) whose stdin the runner keeps open. The kernel gives it to one holder at a time and releases it when the holder exits, crash included, so no stale lock is ever reclaimed and the file's content means nothing. Every read-modify-write of the state (`next`, `record`, `stop`, `take-over`) holds it; `next` holds it for one step at a time and releases it while it waits, so `record` and `stop` can't be lost. **Decided by the user** (after the core recheck: replaces a file-content protocol whose publication and stale-reclamation windows let two processes both hold the lock)
  - A machine-wide guard (`~/orch-evals/active-batch/`) lets only one batch be active. Its newest numbered revision names the batch by its canonical folder and id, or no batch after a release. Every read-decide-write of it holds the guard's own `flock`, and every claim and release publishes the next revision with `link(2)`, which fails if another process already wrote that revision. So no reader sees a partial claim, and a process that lost the guard's lock writes nothing and stops (exit 70). The preflight fails while another live batch holds it.
  - The batch records its owning driver: the `COPILOT_AGENT_SESSION_ID` of the session that first ran `next`. Another driver is refused while the owner is alive (its session folder has an `inuse.<pid>.lock` with a live pid), and takes over once it is gone. If liveness can't be told, the owner counts as gone after 15 minutes without a call. The user can release a batch with `take-over`.
  - A `create_session` that was issued but never recorded is uncertain: the runner looks for the session in the logs and `data.db` and adopts it. Otherwise it waits 5 minutes, then issues it once more, if the run may still start. The search always starts at the first issue, across every reissue; a separate last-issued time drives the 5-minute wait. If a session turns up later for a run given up as never started, no further run starts. **Decided by the user** (the first-issue window), **Design call** (the 5 minutes, the single reissue, the late-session stop).
- Every subprocess (git, `gh`, `new-run`, `score`) has a time limit and runs in its own process group: 2 minutes for git, 10 for `new-run`, 30 for `score`. When the time runs out, the group gets SIGTERM, then SIGKILL after 5 seconds if anything in it is still alive, and the call returns only once the group is gone or SIGKILL has been sent and waited for; its timers keep the caller alive meanwhile. A process that leaves the group (`setsid`) is out of reach. A timeout is a failure under the stop rules. **Decided by the user** (the limits and the escalation), **Design call** (the values).
- Clock: the runner uses wall-clock time, as the event logs do. A clock that goes back over a minute is flagged, and no duration goes negative. **Decided by the user**
- The driver's `tools` allowlist is the shell tools, `view`, `grep`, `glob`, `create_project`, `create_session`, `archive_session`, `get_session`, `answer_session_input`, `send_session_message`, `report_intent` and `task_complete`: nothing that starts sub-agents and nothing that edits files. **Decided by the user** (the list), **Design call** (the last two). `archive_session` is limited to the driver's own idle trust sessions, never an eval run or its children.

## Decisions

### Provisioning and user trust

**Decided by the user:**

- Trust a batch's projects at the start. After preflight, provision the batch's fresh repos, clones and projects up front; the user trusts them, then the batch runs unattended. Every eval attempt still has a fresh GitHub repo. A pool of trusted projects is out of scope.
- Do not bypass the security check. Only the user grants trust in the app; neither the runner nor the driver writes app state to grant trust or automates the app UI.
- The self-test uses one permanent local-only git project that the user trusts once.
- The project itself has no Trust option. The user directed: "just make the project create small session that does nothing and I will trust it that way". Each untrusted project therefore gets an idle session, without a kickoff. These are children of the driver, not eval runs. The user opens the session's view to trust its repository.

**Design call:**

- Reserve pending calibrations plus the remaining scored targets, in planner order. For pinned variants, matching historical scored rows reduce those targets. When legacy calibration keeps Summary, calibration attempts count toward the targets and some reservations stay unused. No retry pool is added.
- Provision each slot with `new-run` and the full seed spec. Before `create_project`, look up `projects.id` by `main_repo_path`, read-only. A failed or ambiguous lookup stops the batch rather than risking a duplicate. Reconcile a lost creation result through the same lookup.
- Reuse `<runs-dir>/eval-runner-selftest` (normally `~/orch-evals/eval-runner-selftest`). Create a local git repo and one commit only if missing; an existing repo must be a clean git root, have a commit, and have no remote. Never delete or reset it.
- The 30-minute trust window starts when the runner first issues `trust_projects`, after creating every idle trust session. Time spent creating those sessions does not shorten the window. Read `project_host_trust.trusted_config_sha256` and `trusted_config_accepted_at` for `(project_id, host_id='local')` in separate read-only queries. Both must be present. A failed lookup or an expired wait with trust still missing stops before any self-test or eval session starts. Once all projects are trusted, an expired deadline does not cancel pending archival.
- Create one `Trust <project>` idle session per untrusted project, using `workspace_type: "branch"`, `coordinate_with_creator: true`, and no kickoff. Sessions are nested under the driver in the sidebar, not under their projects. The driver and notification list names, `ghapp://sessions/<id>` links and clone paths. `record --listed` acknowledges display only; it never substitutes for a trust row.
- After trust, archive these idle sessions before starting the self-test. If cleanup fails, stop and list leftovers. Persist their app and CLI ids and exclude them, including known aliases, from run discovery, activity, permission and memory scans. They are not descendants of eval runs; `score`'s root-and-descendant cost walk does not include them.
- Use only the provisioned slots. If void or unscored attempts consume a variant's capacity, stop with "out of trusted projects". Never create a project mid-batch. The report lists unused projects and repos for the user to remove or keep.
- Calibration chooses a run's features at launch. If necessary, replace only `docs/spec-v2.md` in the unused seed's root commit, preserving its author and its `Seed v1` subject. The resulting tree and single-commit history match `new-run` for the same features. Push only with a lease on the exact provisioned seed SHA; an unexpected remote change stops the run. Save preparation state after the push, then expire reflogs and prune obsolete seed objects in the run clone before launch, refusing cleanup if linked worktrees exist. This ordering moves `origin/main` off the old seed before pruning and lets a restart resume without the removed object. No repository configuration changes. Snapshot the feature-neutral kickoff at launch. No seed rewrite or pruning happens after a run starts.
- Recheck local trust immediately before issuing or reissuing a self-test or eval `create_session`. The app still decides whether its current configuration is trusted; the shell proof and permission fail-fast checks stay in place.

Observed on app 1.1.30 on 22 October 2026: after the user re-added the permanent project through the app and trusted it from an idle session's view, a new interactive probe logged `allowAllPermissions: true`, ran a compound shell command and logged no permission requests. Trust through a session view on a project made by `create_project` is not yet proven; the first real batch start confirms it, and missing trust stops safely.

### Starting a run

**Decided by the user:**

1. The runner runs `new-run` with an explicit `--n` during up-front provisioning.
2. The driver calls `create_project` with the clone's path only when the read-only lookup finds no project, then follows the user-trust phase above.
3. The driver calls `create_session` with `detached: true`, `coordinate_with_creator: false`, `workspace_type: "worktree"` and a kickoff of: the exact text of `kickoff.md`, the variant as agent, `claude-opus-5.5` at `max`, `context_tier: "long_context"`, `mode: "interactive"`.

Never as a child session, and never with `send_session_message`.

**Design call:**

- `--n` is one more than the highest run number of the variant in `results.csv`, `~/orch-evals/` and the batch. If `new-run` says the number is taken (an old repo on GitHub), the runner tries the next one, up to five times.
- On the first look at a run's log, the runner checks the kickoff:
  - the text equals `kickoff.md`;
  - it has no `data.source` and no cross-session tag;
  - the agent, model, effort and context tier match the request.

  A mismatch is flagged, and so is `score`'s warning that the first message came from another session.
- The kickoff is `kickoff.md` without its trailing newline: run 1's typed kickoff in its event log equals that form, so that is what a manual paste delivers. **Decided by the user** (match a manual paste), **Design call** (the check against run 1's log; no text from it is in the repo).
- The deadline and the pinned inputs are checked again just before a `create_session` is issued or reissued. A session that already exists is adopted and may finish; a run that hasn't started doesn't start after the deadline. **Decided by the user**

### Mode and answers

**Decided by the user:**

- Runs start and stay in interactive mode.
- The driver answers each `ask_user` from `answers.md` with `answer_session_input`: at once, word for word, as free text. `need=plan` is row 1 and `need=pr` row 2; otherwise the driver judges row 3 or 4. If a prompt allows no free text, the driver picks the closest choice and the run is flagged.
- A question asked in plain text is answered with `send_session_message`, and the run is flagged.
- The driver never touches child sessions and sends nothing else before scoring.

**Design call:**

- For a plain-text answer, the runner reads the reply's `data.source` from the run's log and passes that exact value to `score --answer-source`, rather than guessing the driver's id. It passes `--answer-source` only for runs where such a reply was sent.
- An `ask_user` still open 2 minutes after an answer is offered again, up to three times, and flagged.
- `tool.args.answer` only ever holds a real reply: the fixed one for a `need=plan` or `need=pr` question, or the stop message. For any other question it is absent, and the action carries both candidate replies (rows 3 and 4) word for word, with the rule for choosing. The agent file and the rehearsal's scripted driver follow the same contract. **Decided by the user**
- The driver answers only the question the runner saw: if `get_session` shows a different question, or a retry shows a different `request_id` from the one seen before (on an answer or a failed attempt, but never on a mismatch, whose id belongs to another question), it records a failure and the run is flagged. The app's `request_id` couldn't be matched to the log's `toolCallId` from local data, so the runner compares the question text and the driver records the `request_id` it answered. **Decided by the user** (the rule), **Design call** (how it is checked).
- The plain-text reply's source is looked for from when the send action was issued, not from when the driver recorded it, and its own timestamp is kept. **Decided by the user**

### The end of a run

**Decided by the user:**

- When the driver judges that the orchestrator's last message is its final report and the swarm is quiet, the runner scores at once with `--end-at` set to that message's time.
- 90 minutes from the kickoff is a timeout; 15 minutes with no activity anywhere in the swarm is a stall.
- "Final" means the attempt has ended, not that it succeeded. An unambiguous terminal report, an honest failure included, is scored at its timestamp with `--end-at`, and the suite decides between `passed` and `gate-failed`. Only progress and waiting messages are not final. **Decided by the user** (after the fidelity review, replacing an earlier call that a run which gave up ends as `stalled`)
- A final-report candidate whose own timestamp is within 90 minutes is judged before a timeout, whenever it is seen, and the cutoff is `>`, as in `score`. **Decided by the user**
- A pending `ask_user` question is not a stall: the swarm is waiting on the user, which is blocked time. The question is answered even after a long driver gap, and the run's notification and report show the `driver-gap` flag. **Decided by the user** (the core review's M1 was rejected as a defect)
- Score before sending anything else. One narrow exception, a **Design call** rather than a user decision: a run voided by a tool-permission prompt, which will never be scored, gets the fixed stop message (see "A tool-permission prompt voids the run" under [The end of a run](#the-end-of-a-run)).
- Tool-permission prompts and MCP elicitations can't be answered: they are flagged, and the stall rule applies. For tool-permission prompts, the design call "A tool-permission prompt voids the run" below replaces this rule; MCP elicitations keep it.

**Design call:**

- The runner offers the driver a `judge_idle` action when the orchestrator has gone idle with unjudged messages, and either the whole swarm has been quiet for 60 seconds or the last message reads like a question or a final report. This keeps the driver's calls to a few per run.
  - The orchestrator is idle when it has no open turn, no open tool call and no open `ask_user`, and has written nothing for 20 seconds.
  - The swarm is every session whose `workspace.yaml` names the run repo, plus the orchestrator.
  - Interactive sessions log no `session.task_complete`, so the end rests on the driver's judgment.
- The self-test has its own rule: the response written after its answered question is its final message, whatever it says. Actions carry `target` (`self-test` or `run`) so the driver can tell them apart. **Decided by the user**
- `--end-at` gets the exact `timestamp` string of the report's last event in `events.jsonl`, never a re-serialized time: capping even a millisecond early loses the report.
- After a final report, the runner waits up to 5 minutes for the swarm to go quiet, then scores, flagging the run if it didn't.
- When the limit is reached, only the latest three messages are offered for judging, so older progress notes are never revisited.
- Activity is a new event in any of the swarm's logs. At a stall, every open tool call in the swarm is flagged as a possible prompt.
- A tool-permission prompt voids the run. This replaces the stall rule for tool-permission prompts, after batch 20261021-2217, where all 15 runs waited on prompts nobody could answer until the stall rule ended them, and were scored `stalled`. **Design call**
  - The trigger: a `permission.requested` anywhere in the swarm, sub-agents included, with no `permission.completed` after 30 seconds, or a `permission.completed` with `decisionSource: "unattended_fallback"` that isn't an approval. Host-policy decisions complete within milliseconds (at most 66 ms in 377 logged ones), so 30 seconds is far above them and well below the 15-minute stall. A pending `ask_user` is a question, not a prompt, and never counts.
  - The run is void: no `score`, no row in `results.csv`, and it counts toward neither the variant's scored runs nor the calibration. It still gets the stop message and the drain wait, as a scored run does, because a prompt in one child leaves the rest of the swarm working. The stop message's action says the run is void rather than scored. This is the only message a run gets before scoring outside the answer sheet, and only because the run will never be scored; it is an exception to the user's rules "Any message to a run before it is scored…" and "Score before sending anything else", not a user decision.
  - The batch then stops through the fatal path: no further run starts, a notification names the run, the request and the remedy, and the report gets a "Tool-permission prompts" section. The round's other started runs finish as the fatal path lets them; each is voided too if it hits a prompt.
  - Before or after the run's end is decided by the request's own timestamp against the run's cutoff, never by the runner's phase: the final report's timestamp, or for a timeout or stall the moment the runner ended the run, saved once with the run (a state saved before that time existed gets it on resume). The swarm is checked again just before scoring, also after a restart, and scoring waits while a request from before the cutoff is still within its 30 seconds, so the wait ends by the cutoff plus 30 seconds. A request from before the cutoff voids the unscored run; one from after it keeps the run's result, flags it, and stops the batch the same way. Before voiding a running run, any unjudged orchestrator messages written before the first blocking request (within the time limit) are offered for judging, so a final report that came first sets the cutoff. The swarms of finished runs are checked until the batch finishes; a prompt there keeps the run's row and stops the batch.

### After a timeout or a stall

**Decided by the user:** only after scoring, the driver tells the run's orchestrator to stop all work and archive its child sessions. The runner waits, bounded, for the swarm to go quiet before the next run. Leftover sessions are listed in the report.

**Decided by the user** (after both reviews): the next run starts only on a quiet swarm, whatever the run's end.
- A final-report run is still scored at the report, as in a manual run. Afterwards the runner waits up to 10 minutes for 2 quiet minutes. If the swarm is still busy, it sends the same stop message and waits again.
- After a timeout or a stall, the stop message is sent at once after scoring.
- If the swarm is still busy at the end of the drain wait, no further run starts: the batch stops, you are notified, and the report lists the sessions. `swarm-not-quiet` flags the run.

**Design call:**

- The stop message is fixed: "This run is over. Stop all work now: don't start anything new, archive all your child sessions, then end your turn." It is sent as an `ask_user` answer if a question is open, otherwise with `send_session_message`.
- The wait is up to 20 minutes for 2 quiet minutes.

### Order and deadline

**Decided by the user:** one run at a time, alternating variants (A1, B1, A2, B2, …). The defaults are `orchestrator` and `session-orchestrator` with 3 scored runs each, all configurable. No new run starts after the deadline, 07:00 local time by default.

**Design call:**

- "Alternating" means the variant with the fewest scored runs in this batch goes next, ties in the given order. A run with no row in `results.csv` (void, or `score` failed) doesn't count, so it is replaced.
- The batch stops after two start failures in a row or two scoring failures in a row, so a broken setup doesn't spend the night creating repos.

### Calibration

**Decided by the user:**

- The runbook's calibration rule is applied automatically.
- A variant's calibration run is skipped when its result can't change the decision, computed by assuming every missing calibration run takes 0 minutes.
- Today, run 1's 65.7 minutes forces dropping Summary for a two-variant batch, so all scored runs use `--features policy,reports,import`.

**Design call:**

- The decision is fixed when every missing calibration run taking 0 minutes still gives a median over 30 (Summary is dropped), or when every missing run never finishing still gives 30 or less (the full set stays).
- Otherwise the calibration runs come first, in variant order, re-checked before each one.
- `results.ts`'s `summarize()` gives the same answer on the resulting rows.

### Memory and history

**Decided by the user:**

- The user turns Copilot Memory off for the whole batch, and the preflight asks for that confirmation.
- The runner checks every log of the swarm, the orchestrator and every child, for loaded memories, `store_memory` and `vote_memory`, and flags any. It also flags `session_store_sql`.
- The final notification reminds the user to turn Memory back on.

**Design call:**

- Loaded memories are a `<memories>` block with a `## User memories` or `## Repository memories` heading in a `system.message`. Sub-agent events are scanned too.
- The self-test fails if its session loaded memories. That checks Memory is off before the first run, rather than trusting the confirmation alone.

### Pinning

**Decided by the user:** at batch start the runner records hashes of the resolved agent files under test and their workers, and the app and CLI versions. Before each run, it stops the batch if any changed.

**Design call:**

- The workers are every installed agent whose name appears in a variant's file.
- `kickoff.md` and `answers.md` are pinned too.
- The app version comes from `Info.plist`, and the CLI version from the app's bundled `cliVersion.d.ts`.

### Self-test

**Decided by the user:** after provisioning and trust, and on demand as a self-test-only batch, the runner and driver check the whole path with a harmless agent or the default agent on a cheap model, in the permanent local git repo with no GitHub remote. It covers:

- project lookup by path, with `create_project` only when absent;
- a detached `create_session`;
- an `ask_user` that the driver answers;
- end detection;
- the kickoff shape;
- that tools are approved without a prompt. The first version read `projects.auto_approve`, which defaults to 1 and doesn't decide a session's permissions; the check is now the design call below.

A failed self-test stops the batch. It never uses an orchestrator agent.

**Design call:**

- The default agent on `claude-sonnet-5.5` at `low`.
- The question is tagged `need=plan`, so its answer is fixed and can be checked word for word.
- It also checks that the session has no creator link and that no memories loaded.
- It also runs every `data.db` lookup the runner uses against its own session and project, and the column probe below. **Decided by the user** (after the core review)
- `--self-test-agent` can name another agent, but config validation refuses the orchestrators and the variants under test.
- The self-test proves that a session in the permanent project can use tools with nobody present. **Design call**
  - Before its `ask_user`, it runs `pwd && echo eval-selftest-<nonce>`: a compound command, because host policy approves some single read-only commands (`git status`, `pwd`) even without allow-all permissions.
  - It fails if no shell tool call (`bash` or `powershell`) with the marker in its command completed successfully and printed the marker on a line of its own, or if the session's log has any permission request in manual mode (`permissionMode: "manual"`), pending or denied. Sessions with allow-all permissions log no permission request at all: none in 382 such sessions checked.
  - A request still pending after 30 seconds fails it at once, rather than at the 20-minute limit. Like every self-test failure, it stops the batch before any eval session starts; the provisioned repos remain unused. The failure names the cause and points to "Tool permissions" in the README.

### Notifications, keep-awake and preflight

**Decided by the user:**

- The runner sends ntfy notifications with `curl`: batch start, each run's outcome, failures and the final summary. The topic URL comes from a private file or an environment variable outside the repo and is never committed or logged.
- The runner holds a `caffeinate -is` assertion for the whole batch.
- The preflight checks AC power, free disk space, `gh` identity and scopes, API rate limits, Node 24 or later and the app version, and prints the user's one-time manual steps.

**Design call:**

- Notifications:
  - The file is `~/.config/orch-evals/ntfy-url`; `ORCH_EVAL_NTFY_URL` overrides it.
  - The URL reaches `curl` through a config on stdin, so it never appears in a process list, and errors are redacted.
  - A failed notification never blocks the batch.
  - Each notification has a key and is sent at most once, so a resumed batch doesn't repeat them.
- Keep-awake:
  - The runner's processes are short-lived, so it starts a detached `caffeinate -is -t <seconds>` that lasts until 3 hours after the deadline, records its pid, restarts it if it dies, and stops that exact pid at the end.
  - A dry run never starts it.
- Preflight:
  - It also checks that `score` supports `--end-at` and `--answer-source`, that the agents under test are installed, that the checkout isn't on `main`, that `results.csv` has no uncommitted changes, git identity, and the notification topic.
  - The scopes it requires are `repo` and `workflow`, because `new-run` pushes the seed's CI workflow.
  - The minimum app version is 1.1.30, where detached top-level runs and `answer_session_input` were observed.
  - It checks that no other batch is active, and that every `data.db` column the runner reads exists. **Decided by the user**
  - Any FAIL creates no batch.

### Results and the morning report

**Decided by the user:**

- The runner commits `results.csv` after each scored run on the driver's own branch, with no `Co-authored-by` trailer or other AI attribution. It may push that branch, and never pushes to `main`.
- At the end it writes a morning report in the batch folder, outside the repo, and prints it. The report covers outcomes, minutes, flags, leftover sessions to archive, repos created, and how to land the results.

**Design call:**

- The commit uses `git commit --only -- results.csv`, so nothing else the checkout holds is committed.
- Whether a run is scored is decided by its row in `results.csv`, never by the runner's state. `score` writes the row before its diagnostics and the runner saves its state only after `score` returns, so a runner that stopped in between resumes behind the row. It adopts the row as it is (flagged `score-warning`), never scores again, never removes it, and never voids a run that has one; the report and final counts read the row first. **Design call**
- The push is on by default and turned off with `--no-push`.
- The report lists only the commits made since the batch started.
- A results commit that fails is retried up to three times, a minute apart, with the run held until it succeeds. If it still fails, no further run starts, the run's cleanup still happens, and the user is notified. **Decided by the user**
- `score` gets a compact `--note` built from the flags known before scoring, for example `batch=<id>; driver=eval-runner; memory=off; flags=plain-text-question`; `score` appends its own warnings. So the row in `results.csv` carries the batch's provenance and Memory mode. Flags found after scoring stay out of the row: they go into the report, a short follow-up notification for the run, and the batch's final notification, and a run is never scored again for them. **Decided by the user** (after the fidelity review, replacing an earlier call to keep flags out of `results.csv`)

### The app database

**Decided by the user** (after the core review): each column is read with its own query, so a renamed or missing column loses only its own value and can't hide `was_interrupted`. Failed queries become `app-db` flags, and the preflight and the self-test check every column and lookup the runner uses.

### An app restart

**Design call:** if the driver has been away for over 10 minutes, or a run is about to time out or stall, the runner reads `sessions.was_interrupted` for the run's session in `~/.copilot/data.db`, read-only. If the app stopped the session, the run is void: it is not scored, the user is notified, and a replacement run starts.

### Docs

**Decided by the user:**

- The kit's README gets an "Overnight batches" section.
- The rule "never ask an agent to start one", in the README and in `.github/copilot-instructions.md`, now allows detached top-level runs started by `eval-runner` in a batch the user launched, and still forbids child-session runs and runs started any other way.
- The new agent and tooling are added to `.github/copilot-instructions.md`.

## Testing

**Design call:**

- Unit tests cover:
  - the state machine and resuming (adopting an unrecorded session, re-issuing pending actions, a fresh process continuing a batch);
  - answer selection;
  - end, stall and timeout detection on synthetic event logs;
  - the calibration rule;
  - the memory and history flags;
  - pinning drift;
  - notification text, and the URL staying off the command line;
  - the preflight;
  - the command line.
- `batch-lock.test.ts` races real processes for the lock and the guard: six racers, a holder killed with SIGKILL, empty and garbled lock files, a claim held mid-publication, three batches claiming at once, the guard's folder-and-id identity, and a timed-out command whose descendant ignores SIGTERM while its caller tries to exit.
- `batch-regressions.test.ts` turns each scenario from the two reviews into a permanent test: a second batch, a second driver, an unconfirmed `create_session` (including a first attempt that shows up after the reissue, and one that shows up after the run was given up), a stop request during `next`, final reports at 89:50, 90:00 and after a driver gap, busy swarms after a final report and after a timeout, a question left open over a driver gap, the deadline and pins just before a kickoff, late plain-text answers, failing results commits, the answer contract, question mismatches, the self-test rule, an honest failure report, the `--note`, the kickoff bytes, app-database errors, a `score` timeout, a clock going back, and timed-out subprocesses. `batch-appdb.test.ts` runs the database adapter against a real SQLite file with columns missing.
- `FakeApp` (`scripts/lib/batch/fake-app.ts`) stands in for the app. It writes synthetic session logs on a simulated clock, and scripts the scenarios: a question then a final report, a plain-text question, an honest failure report, a busy child after the final report, swarms that ignore the stop message, a stall, a timeout, a sub-agent's pending permission prompt, an unattended permission denial, and the self-test. Its `allowAll` switch starts sessions without allow-all permissions, so the self-test's shell command waits on a prompt. **Design call** (the permission scenarios)
- `batch-permissions.test.ts` covers both permission checks end to end, and `batch-rehearsal.test.ts` rehearses a batch that stops at the self-test and one that stops after a run's prompt. **Design call**
- `batch-pretrust.test.ts` covers full provisioning before launch, read-only trust polling against a synthetic SQLite fixture, timeout, finite capacity, permanent-project reuse and lost-result adoption, idle trust sessions and cleanup, scan exclusions, and launch-time feature setup with the same tree and single-commit history as `new-run`. The rehearsal includes the user-trust step with a fake user; no test touches real app state. **Design call**
- `npm run batch -- rehearse` and its test run a whole batch end to end with the app and driver stubbed:
  - the real `new-run --dry-run`, `score` and acceptance suite;
  - real git commits;
  - real `curl` to a local ntfy stub.

  `score` times timeout and stalled runs to the real clock, so their minutes are wrong in a rehearsal.

## Limits and residual risks

- **Tool permissions:** projects made by `create_project` start untrusted. The user must trust them through their idle sessions at batch start. The runner can read acceptance but cannot grant it or guarantee that the app still accepts the current configuration. Missing trust, a failed shell proof or a tool-permission prompt stops the batch. Session-view trust was verified only on the permanent project the user re-added through the app, not yet on a `create_project`-origin project.

- **An app restart or update** stops every session, including the driver and the run in progress. The run is void, as above. Nothing notifies the user until the driver is resumed, because nothing is running; missing notifications are the sign. The app has no auto-resume, and resuming a run would need a message to it, which counts as a nudge.
- **Plain-text questions:**
  - The reply arrives as a cross-session message, so the orchestrator sees another session, not the user.
  - `score --answer-source` keeps the timing comparable.
  - The run is flagged, because the orchestrator's next step may differ from a manual run.
- **The screen locked:** the behaviour is unverified. Sessions are background CLI processes and `caffeinate` keeps the machine awake, but the user should keep the lid open and the laptop on AC power. Computer use isn't involved: it is blocked for this app.
- **Leftover sessions:** the driver can't archive detached sessions, so each run's orchestrator, any unarchived child and the self-test session stay in the sidebar until the user archives them or the app's auto-clean does.
- **Memory off** changes the condition: batch results are "Memory off" runs, and manual comparisons should be made the same way.
- **Judgments:** the end time and the row for untagged questions depend on the driver's judgment. The runner bounds the effect: `--end-at` pins the end to the report's own timestamp, a report written in time is judged before a timeout, and a wrong "not final" judgment ends as a stall or a timeout.
- **A busy swarm** that ignores the stop message stops the batch for the night. That costs the remaining runs, but never puts two swarms side by side.
- **Activity:** the runner reads logs, not whether a session is busy. A command that writes nothing for 15 minutes while everything else is idle counts as a stall.
- **The app records runs as created by an agent** (`workspaces.created_by`). Nothing found reads it in a way that changes the run.
- **The app's internals:** the event log and `data.db` are internal and may change in an app update. Pinning stops the batch when the app version changes mid-batch. The self-test and the preflight check the path and every `data.db` column the runner reads at the start of each batch.
- **Driver identity:** ownership relies on the app setting `COPILOT_AGENT_SESSION_ID` for a session's shell and keeping `inuse.<pid>.lock` in the session folder while its CLI runs, as observed on app 1.1.30. If either changes, the owner counts as gone after 15 silent minutes.
- **Real-app coverage:** the trusted-project shell probe passed. The first full batch after merge must still confirm trust-session navigation, trust on tool-created projects, cleanup and the complete self-test.
