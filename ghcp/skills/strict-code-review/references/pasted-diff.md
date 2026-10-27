# Pasted diff adapter

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies.

Use this adapter when the user pastes a diff and no repository access is available.

- Review the pasted diff with "Review flow". The consumers and removals passes can use only what the diff shows.
- There is no base or head commit, no instruction file and no CI result, and no code from the diff runs. In the review record, give `Pasted diff` as the source and `unavailable` for every commit.
- Do not claim to have inspected code outside the diff. Say under `Not verified` that the review is limited to the pasted diff, and name the code outside it that the change depends on.
- Ask for the PR URL or repository access only if the diff is not enough to judge a would-be Must fix or Should fix.
