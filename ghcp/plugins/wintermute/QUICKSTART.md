# Wintermute quick start

Wintermute is a plugin for the GitHub Copilot app that runs a team of agent sessions for you. You describe the work to one orchestrator agent, `wintermute-core`. It plans the work, hands each part to its own child session, has the results reviewed and checked, and brings you only the decisions that need you. A dashboard shows what every session is doing, what it costs and what waits on you.

## What you need

- The GitHub Copilot app. The orchestrator creates and tracks child sessions with the app's session tools, such as `create_session`, so run it in the app.
- The `copilot` command-line tool, to install the plugin.
- Node.js 18 or later, only if you want the dashboard in a browser. In the app, the dashboard runs on the Node.js that ships with Copilot.
- Optional: the `gh` CLI (or `az` for Azure DevOps), signed in. The dashboard uses it, read-only, to show the state of the swarm's pull requests.

## Install

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install wintermute@ai-tools
```

Then start a new session, or restart the Copilot app, so that the agents and the dashboard load.

## Start a swarm

1. In the Copilot app, start a new session in the repository you want to work on.
2. Before your first message, pick `wintermute-core` as the session's agent: from the composer's **+** menu, or with `/agent`. Its full ID is `wintermute:wintermute-core`.
3. Use Opus 5.5 at `max` reasoning effort for this session. That is the setup the orchestrator is meant for.
4. Describe the work: the goal, the repository, any spec or brief file, and what needs your approval.

Always run `wintermute:wintermute-core` as a top-level session. Never start it as a child of another session or as a sub-agent of another agent: it is the coordinator of its own swarm.

## What happens next

- **A plan.** For substantial work, the orchestrator shows you how it splits the work into units. It waits for your approval when you ask for that, or when something is unclear.
- **Child sessions.** Each unit gets its own child session, which runs as `wintermute:wintermute-peon`. The orchestrator picks each child's model and reasoning effort, runs independent units in parallel, and stacks a unit that builds on another on its parent's branch. Children can't start agents of their own; they ask the orchestrator instead.
- **The dashboard.** When the orchestrator creates its first child session, it opens the swarm dashboard in the app's side panel.
- **Questions for you.** Every question the orchestrator asks starts with a tag that names the units it concerns, for example `[unit=api] ...`, `[unit=api need=pr] ...` for a PR go-ahead, or `[unit=* need=plan] ...` for the whole plan. The dashboard lists open questions as "Needs you".
- **Go-aheads before PRs.** A child asks before it opens a PR, takes one out of draft or merges. The orchestrator brings these to you, unless you have told it to decide.
- **Reviews and checks.** Before a unit merges, a model from another vendor reviews it, and a separate session checks the author's claims (tests, CI, scope) at the pushed commit. Two judges from two vendors check the last PR before it merges.
- **The end.** The orchestrator reports the result, open risks and any skipped reviews, then archives the finished child sessions.

## Open the dashboard

In the app, ask the agent to open the swarm dashboard canvas (canvas id `swarm-dashboard`). It shows the swarm of the session it was opened in.

In a browser, run the launcher from the installed plugin and open the address it prints, `http://127.0.0.1:7927/` by default:

```bash
cd ~/.copilot/installed-plugins/ai-tools/wintermute
npm start
```

To look around before you run a real swarm, `npm start -- --demo` serves a sample swarm instead of your data.

## Update

```bash
copilot plugin update wintermute@ai-tools
```

Then start new sessions to get the updated agents; a running session keeps the agents it started with. To update the dashboard in the app, restart the app, or reload extensions in every open session: a dashboard server that already runs on port 7927 keeps serving the old version. If you started the dashboard with the launcher, stop it with Ctrl+C and run `npm start` again; restarting the app doesn't replace it. `curl -s http://127.0.0.1:7927/api/health` shows the version that serves the port.

## Read more

- [README](README.md): the agents, everything the dashboard shows, how it decides what is stuck, privacy, commands and troubleshooting.
- [CHANGELOG](CHANGELOG.md): what each release contains.
- The agent prompts, [`wintermute-core`](com.github.copilot/agents/wintermute-core.agent.md) and [`wintermute-peon`](com.github.copilot/agents/wintermute-peon.agent.md): the exact rules the agents follow, including the model tiers.
