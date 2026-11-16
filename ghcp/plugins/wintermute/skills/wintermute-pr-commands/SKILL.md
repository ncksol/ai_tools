---
name: wintermute-pr-commands
description: >-
  Tested command reference for pull request work in wintermute-core and
  wintermute-peon sessions: az CLI reads of Azure DevOps PR state, votes,
  policies, builds, threads, labels and linked work items, the few Azure DevOps
  writes that are verified (thread reply, description, label, completion,
  retarget, work-item state), and gh reads of GitHub PR state, checks and review
  threads. Load once before Azure DevOps or GitHub PR work. Reference only: it
  grants no permission and runs nothing.
---

# Wintermute PR commands

You are reading the index of the tested PR commands for wintermute agents. Read only the provider reference your job needs, once, and keep it in context. Don't load this skill or a reference again for each status check.

## Operating mode

- This skill is a reference. It runs nothing, grants no permission and changes no ownership. Run a write command only when your agent's rules already allow that write: the PR is yours, or the orchestrator gave it to you as a simple PR job, and the go-ahead, review and claims check it needs are done.
- Each command is marked by its evidence. "Ran" marks a read that ran against a real PR. "Verified" marks a write whose result and readback were checked in a real session log. The commands are templates of the commands that ran: only the placeholder values differ.
- An operation listed under "Not verified" has no tested command. If your job needs one, check the command's help first, make the write once, read the result back, and say in your report that the command was untested. Don't replace it with `az rest` or a native PR tool.
- Fill placeholders from the PR URL, the brief, the repository's instructions or a read command. Never guess an ID, an organisation or a state name.
- Organisation and repository rules, such as a merge message format, required work-item states or generated files, come from the target repository's instructions, not from this skill.
- Don't invent output, IDs, states or results. Say that you ran a command only when you ran it.

## References

Resolve each path from this skill's base directory, which the skill loader gives you when it loads this skill.

| Provider | Reference | What it covers |
| --- | --- | --- |
| Azure DevOps | `references/azure-devops.md` | `az` reads of PR state, votes, policies, builds, threads, labels and work items; verified writes; how to read the results; operations with no tested command |
| GitHub | `references/github.md` | `gh` reads of PR state, checks, review threads and changed files; how to read the results. No GitHub writes are verified |

## Output format

This skill produces no output of its own. In your report on a PR job, give the commands you ran with their values filled in, what they returned, and the readback after each write. Mark any command that isn't in a reference as untested.
