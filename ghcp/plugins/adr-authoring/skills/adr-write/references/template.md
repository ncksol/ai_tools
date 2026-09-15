# Record template

This anatomy is the plugin's convention, informed by Microsoft's ADR guidance; it
is not an official Microsoft template. Use ATX (`#`) headings and the exact
metadata/level-two heading spelling below. Keep the title and three metadata fields
in the shown order, with only blank lines or comments between them. Deeper headings
are optional within sections. Use fenced code for multiline syntax examples;
single-line code spans can quote literal comment markers or template tokens.

Replace every `{{TOKEN}}` with supported content. Do not include this instruction
page or the surrounding code fence in the output.

```markdown
# {{DECISION_TITLE}}

- Status: {{STATUS}}
- Date: {{DECISION_DATE}}
- Decision owner: {{DECISION_OWNER}}

## Decision

{{CHOICE_AND_SCOPE}}

## Context and decision drivers

{{PROBLEM_CONSTRAINTS_AND_CRITERIA}}

## Options considered

{{ACTUAL_OPTIONS_AND_RELEVANT_COMPARISON}}

## Rationale

{{WHY_THIS_CHOICE_AND_NOT_THE_ALTERNATIVES}}

## Consequences

{{BENEFITS_COSTS_RISKS_AND_OBLIGATIONS}}

## Confidence and reconsideration

{{EXPRESSED_CONFIDENCE_UNCERTAINTY_AND_REVISIT_CONDITIONS}}

## References

{{SUPPORTING_EVIDENCE_AND_RELATED_DECISIONS}}
```

## Filling the fields

| Field | Rule |
|---|---|
| Title | Name the decision, not "Architecture overview". Include a supplied or safely allocated ADR ID when available. |
| Status | Exactly `Proposed`, `Accepted`, or `Superseded`. Default to Proposed; use other states only when explicitly supported. |
| Date | A real `YYYY-MM-DD` decision/proposal date, or `Not provided`. Use today's date for a newly made proposal only when that timing is established. |
| Decision owner | Supplied name or team, or `Not provided`. Never identify the model as the owner. |
| Decision | State the choice and its scope. Identify a proposed recommendation as such. |
| Context and decision drivers | Explain the problem and the constraints/criteria that influence the choice. Do not insert generic background. |
| Options considered | Include only supplied actual alternatives. If none were documented, say so. Recommendation mode can add clearly proposed alternatives, grounded in evidence. |
| Rationale | Connect the choice to the drivers. Missing material rationale is a blocker, not permission to invent it. |
| Consequences | Record supported benefits, downsides, and obligations. Label unconfirmed implications as assumptions or proposals. |
| Confidence and reconsideration | Preserve expressed decision confidence, not an LLM score. If unknown, say "Decision confidence was not provided." Do not invent a review deadline or commitment. |
| References | Cite sources used, preferably near the claims as well. A supplied conversational brief can be described without inventing a file or URL. |

Compare alternatives in a table only when the same meaningful criteria apply.
Do not force empty columns or invented alternatives for symmetry. Every section
needs meaningful content; an explicit, justified unknown is content, a blank or
unresolved template token is not.

Use Markdown links for real files and inspected web sources. Resolve file links
relative to the saved ADR's directory, not this template's directory. A supplied
but unvisited URL may be retained only with a clear "not independently verified"
label; it must not be presented as evidence of an inspection.
