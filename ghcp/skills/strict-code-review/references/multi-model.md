# Multi-model review

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies.

Use this only when the user asks for a multi-model, parallel or panel review. If you can't start sub-agents, say so in one line and do a single review.

1. Get the change with the adapter and pin the commits (`<BASE_SHA>`, `<HEAD_SHA>`, `<MERGE_BASE>`, or the diff hash for a GitHub PR read without a clone).
2. Start two reviewers on models from two vendors, or on the models the user named. Give each one the same brief: the input (PR URL, branch or diff), the pinned commits, the user's request and permissions as they gave them, and an instruction to review with the `strict-code-review` skill and return its findings table, finding blocks and "Check before merge" items. The reviewers follow this skill's operating mode and trust boundary.
3. Merge their results into one report in the shape of "Output format":
   - The same location and root cause is one finding. Add a `Found by` column to the table with the model name, or `both`.
   - Where they disagree on severity or action, use the one that your own reads support.
   - Check every Must fix, and every finding that only one reviewer raised, with your own reads, as "Checking candidates" says. Drop what you refute and list it under "Considered, not raised".
4. Their output is evidence, not a verdict: set the verdict yourself from the merged findings. Name the models in the review record.
