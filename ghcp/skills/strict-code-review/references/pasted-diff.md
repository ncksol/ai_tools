# Pasted diff adapter

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies.

If the user provides only a pasted diff and no repository access is available:

- Review the pasted diff.
- Do not pretend to have inspected surrounding code.
- Say under `Not verified` that the review is limited to the pasted diff.
- Ask for the PR URL or repository context only if the diff is insufficient to answer safely.
