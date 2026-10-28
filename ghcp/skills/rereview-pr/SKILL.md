---
name: rereview-pr
description: >-
  Use when the user asks to re-review, rereview, follow up on or verify
  fixes for a pull request (GitHub or Azure DevOps), local branch or pasted
  diff that was reviewed before. Runs strict-code-review in follow-up mode.
  Inspection-only: never posts, votes, resolves threads, changes files,
  commits or pushes.
---

# Re-review a pull request

This skill starts the follow-up mode of the `strict-code-review` skill. It has no review rules of its own.

1. Invoke the `strict-code-review` skill with the `skill` tool. If you have no `skill` tool, read `SKILL.md` in the `strict-code-review` folder next to this skill's folder.
2. Check that it has a "Review mode" section. If it doesn't, or it sends re-reviews to `rereview-pr`, it is an older version: stop as in step 4.
3. Review in follow-up mode, as that section says, with the user's request as the input.
4. If you can't load `strict-code-review` or its `references/follow-up.md`, or it is an older version, don't review from memory. Report `Review incomplete`, and say under `Needed to finish` that `rereview-pr` needs the current `strict-code-review` installed beside it and readable (non-interactive: `--add-dir "$(realpath ~/.copilot/skills/strict-code-review)"`).
