# Review rubric

Review against the original brief and inspected sources. A fluent draft is not
evidence of correctness. Do not expose this review worksheet inside the ADR.

## Hard gates

| Gate | Pass condition |
|---|---|
| Fidelity | Choice, scope, rationale, status, and known uncertainty match the evidence. |
| Grounding | Every material claim is traceable to supplied or inspected evidence, or clearly labeled as an assumption/proposal. No invented sources, numbers, alternatives, or approval. |
| Completeness | All required sections are meaningful. Material gaps have been resolved; unknown nonblocking metadata is explicit. |
| Decision relevance | Each passage helps assess the problem, alternatives, choice, rationale, consequences, or material uncertainty. Supporting context is selected for this decision, not copied because it is available. |
| Audience fit | The stated audience can assess the decision without a project briefing, tutorial, or repeated source-status commentary. Default to project-aware technical reviewers. Necessary definitions and qualifications remain explicit. |
| History and authority | Accepted/superseded content is preserved. Only requested files are written; no application changes, Git operations, or remote publication. |
| Structure | The fixed template passes automated checks, or equivalent manual checks with the lack of execution disclosed. |

Any failing hard gate blocks a "complete" outcome. Do not average it away with
style scores. If a material question cannot be resolved, stop and return it.

For each paragraph, table row, or list item, ask: **If this disappeared, would the
reader lose something necessary to assess the decision?** If not, remove it or
replace the needed reference with a short relevance phrase. Required metadata and
traceable citations still serve a purpose; this is not a word-count test.

Then check the reverse against the sources: did the edit lose a constraint,
alternative, rationale, cost, obligation, or material uncertainty? If so, restore
it. Geography can be irrelevant to one choice and decisive for another. Passing
relevance never excuses failing fidelity or completeness.

## Writing checks

- The opening states the choice and scope without a long introduction.
- The rationale explains the fit to the actual constraints.
- Consequences include supported downsides, not only benefits.
- Wording is neutral, specific, and concise without losing technical precision.
- Headings, terms, and metadata follow the template.
- The reasoning stands alone; project onboarding and supporting designs are linked
  rather than reproduced. Substantial implementation guidance has a durable home;
  creating a companion requires separate authorization.
- Source status is explicit where it changes how a claim should be read. Research
  is not approved scope; an unapproved dependency is not an established capability.
- References support the claims they accompany; provenance is not implied by a
  plausible URL or a source title alone.

## Revision rule

Run one review after the initial draft. Make at most two revision passes, checking
the affected structure and evidence again after each pass. Relevance editing and
sentence polishing share this budget; they are not extra passes. Stop early if all gates
and writing checks pass. If revision no longer improves the draft or evidence is
missing, return the remaining blocker instead of adding confident filler.

Structural validation checks neither the truth of a claim nor the quality of its
rationale. A same-session review is not an independent evaluation. Do not claim
repeatability from one successful draft; use the plugin's evaluation briefs for
repeated, separately assessed trials.
