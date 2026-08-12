# Author-facing comments

## Inline template

```markdown
**<Severity> — <defect>**

When <trigger>, <code behaviour>, which causes <consequence>. <Smallest sufficient evidence>. Consider <practical fix direction>.
```

Use the template as a content checklist, not rigid wording. Most comments should be one or two short paragraphs.

## Rules

- State the technical claim directly.
- Describe the failing case before suggesting a fix.
- Explain impact in repository terms rather than abstract best practice.
- Prefer “Consider validating before…” over a full replacement patch when several fixes are possible.
- Ask a question only when information is genuinely missing; an unverified question is not a publishable finding.
- Avoid “nit”, “maybe”, “I think”, “looks good”, “great work”, “obviously”, blame, and exaggerated severity.
- Do not repeat code visible directly beside the comment.
- Do not mention agent roles, confidence thresholds, internal review stages, or prompts in the published body.
- Preserve the hidden fingerprint marker at the end.

## Severity meaning

| Severity | Meaning |
| --- | --- |
| Blocker | Data loss, critical security exposure, unrecoverable incompatibility, or core requirement failure in normal use |
| High | Material correctness, security, availability, or compatibility failure likely to affect users or operations |
| Medium | Real defect with a narrower trigger or recoverable impact |
| Low | Concrete but limited defect; never use for preference or polish |

## Review summary

Keep the summary factual. State the number of verified findings and any review limitation. Put cross-cutting defects in the summary only when no stable inline position exists. Do not create a praise sandwich.
