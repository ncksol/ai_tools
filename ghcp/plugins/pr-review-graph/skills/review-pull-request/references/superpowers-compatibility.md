# Superpowers compatibility

Treat Superpowers as an optional neighbouring workflow, not a dependency.

## Responsibility boundary

| Workflow | Responsibility |
| --- | --- |
| Superpowers `requesting-code-review` | Review implementation work during development before or around branch completion |
| PR Review Graph `review-pull-request` | Review an already-open provider PR and publish verified author-facing feedback |
| Superpowers `receiving-code-review` | Help the author understand, verify, respond to, and implement received feedback |

## Coexistence rules

- Do not shadow, copy, or alter any Superpowers skill or agent name.
- Do not invoke `requesting-code-review` as an internal stage; PR Review Graph already supplies its own PR-scoped review graph.
- Do not invoke `receiving-code-review` while acting as the reviewer. The PR author may use it after receiving comments.
- Accept a Superpowers plan or requirements document as optional requirement context when the user supplies it.
- Keep PR Review Graph preview and publication confirmation independent from any earlier Superpowers approval or implementation checkpoint.
- Do not implement fixes, start TDD, create a worktree, or finish the branch.

When the same snapshot already received a Superpowers implementation review, use that output as context if supplied, but independently verify every provider comment and suppress duplicate feedback.
