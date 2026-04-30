# 🤖 ai_tools

> A growing collection of AI tools, skills, and prompts I've built and want to share.

This repo is where I park the AI-assistant tooling I find genuinely useful day to day — starting with a small set of opinionated **GitHub Copilot CLI skills** for pull request review, and expanding from there.

If something in here saves you ten minutes, it's done its job. ✨

---

## 📚 Table of contents

- [🤖 ai\_tools](#-ai_tools)
  - [📚 Table of contents](#-table-of-contents)
  - [🧰 What's inside today](#-whats-inside-today)
  - [💡 What's a "skill"?](#-whats-a-skill)
  - [📥 Install](#-install)
    - [Option 1: Symlink (recommended — you get updates with `git pull`)](#option-1-symlink-recommended--you-get-updates-with-git-pull)
    - [Option 2: Copy](#option-2-copy)
    - [Option 3: Cherry-pick a single skill](#option-3-cherry-pick-a-single-skill)
  - [▶️ Use the skills](#️-use-the-skills)
  - [🗂 Repository layout](#-repository-layout)
  - [🛠 Authoring conventions](#-authoring-conventions)
  - [📄 License](#-license)

---

## 🧰 What's inside today

| Skill | What it does | When to invoke |
|---|---|---|
| [`strict-code-review`](./ghcp/skills/strict-code-review/SKILL.md) | First-pass strict senior-engineer PR review. Inspection only — no comments posted, no code changed. | "Review this PR: `<url>`" |
| [`analyse-pr-feedback`](./ghcp/skills/analyse-pr-feedback/SKILL.md) | Triages reviewer comments into a decision table (agree / disagree / needs clarification) so you can reply intentionally. | "Analyse the feedback on `<url>`" |
| [`rereview-pr`](./ghcp/skills/rereview-pr/SKILL.md) | Focused **second-pass** review: were the previous findings actually addressed? Is the engineer's pushback valid? | "Re-review `<url>`" |

All three are **provider-neutral** — they work with both **GitHub** and **Azure DevOps** pull requests, and gracefully fall back to local branches or pasted diffs/feedback when remote access isn't available.

All three are **safe by design**: they only inspect and report. They will not edit files, commit, push, post comments, resolve threads, approve, reject, merge, or close the PR.

---

## 💡 What's a "skill"?

A skill is a self-contained markdown prompt that the [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) loads on demand. When the user's intent matches a skill's `description`, the CLI activates it and follows the instructions in its `SKILL.md`.

In practice:

```
~/.copilot/skills/<skill-name>/SKILL.md
```

Each `SKILL.md` is just a markdown file with a small YAML frontmatter block:

```yaml
---
name: my-skill
description: >-
  Use this skill when the user asks to ...
---

# My Skill

You are ...
```

That's the entire contract. The body of the file is the prompt the model executes.

---

## 📥 Install

### Option 1: Symlink (recommended — you get updates with `git pull`)

```bash
git clone https://github.com/ncksol/ai_tools.git ~/src/ai_tools

mkdir -p ~/.copilot/skills
for skill in ~/src/ai_tools/ghcp/skills/*/; do
  ln -sf "$skill" ~/.copilot/skills/"$(basename "$skill")"
done
```

### Option 2: Copy

```bash
git clone https://github.com/ncksol/ai_tools.git
cp -R ai_tools/ghcp/skills/* ~/.copilot/skills/
```

### Option 3: Cherry-pick a single skill

```bash
mkdir -p ~/.copilot/skills/strict-code-review
curl -fsSL https://raw.githubusercontent.com/ncksol/ai_tools/main/ghcp/skills/strict-code-review/SKILL.md \
  -o ~/.copilot/skills/strict-code-review/SKILL.md
```

Restart your Copilot CLI session (or run `/skills` to confirm they show up) and you're done.

---

## ▶️ Use the skills

Once installed, you don't invoke skills by name — you describe what you want and the CLI routes to the best match:

```text
> Review this PR: https://github.com/acme/widgets/pull/482
  → activates strict-code-review

> The reviewer left a bunch of comments on PR 482 — help me triage them
  → activates analyse-pr-feedback

> I pushed fixes for the review comments on PR 482, can you re-review?
  → activates rereview-pr
```

Pasted diffs, local branch names, and Azure DevOps URLs all work too.

---

## 🗂 Repository layout

```
ai_tools/
├── README.md                          ← you are here
├── .github/
│   └── copilot-instructions.md        ← guidance for Copilot working in this repo
└── ghcp/                              ← GitHub Copilot CLI artefacts
    └── skills/
        ├── strict-code-review/
        │   └── SKILL.md
        ├── analyse-pr-feedback/
        │   └── SKILL.md
        └── rereview-pr/
            └── SKILL.md
```

The top-level `ghcp/` namespace leaves room for other Copilot-CLI things later (e.g. `ghcp/agents/`, `ghcp/extensions/`), and for sibling namespaces for other tools — `claude/`, `cursor/`, `prompts/`, etc. — as the collection grows.

---

## 🛠 Authoring conventions

The PR-related skills here all share the same shape so they feel like a coherent set rather than three random prompts. If you're contributing a new skill — or extending an existing one — please keep these in mind:

- **Frontmatter `name` matches the directory name** (kebab-case).
- **`description` is written for the router**, not the human reader. State *exactly when this skill should activate*, including the verbs a user is likely to say.
- **Safety rules up top.** Be explicit about what the skill must NOT do (edit, commit, push, post comments, approve, merge, …). Inspection-only skills are the default here.
- **Provider-neutral** for any PR/repo workflow: support GitHub *and* Azure DevOps, with adapters for local branches and pasted input.
- **Shared severity vocabulary**: `Critical | High | Medium | Low | Info`.
- **Concrete commands, not vibes.** Show the exact `gh` / `az` invocations to use, including the GraphQL query for GitHub review-thread resolution state (REST doesn't expose it reliably).
- **Prescribed output format** — usually a markdown table — so results are skimmable and comparable across runs.
- **Forbid hallucination**: don't invent line numbers, don't claim a command ran when it didn't, don't claim surrounding code was inspected when only the diff was read.

The three existing `SKILL.md` files are the reference; copy their structure when adding a new one.

---

## 📄 License

MIT — do whatever is useful. Attribution is appreciated but not required.
