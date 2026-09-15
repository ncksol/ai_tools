# Review rubric

Review against the original brief and inspected sources. A fluent draft is not
evidence of correctness. Do not expose this review worksheet inside the ADR.

## Hard gates

| Gate | Pass condition |
|---|---|
| Fidelity | Choice, scope, rationale, status, and known uncertainty match the evidence. |
| Grounding | Every material claim is traceable to supplied or inspected evidence, or clearly labeled as an assumption/proposal. No invented sources, numbers, alternatives, or approval. |
| Completeness | All required sections are meaningful. Material gaps have been resolved; unknown nonblocking metadata is explicit. |
| History and authority | Accepted/superseded content is preserved. Only requested files are written; no application changes, Git operations, or remote publication. |
| Structure | The fixed template passes automated checks, or equivalent manual checks with the lack of execution disclosed. |

Any failing hard gate blocks a "complete" outcome. Do not average it away with
style scores. If a material question cannot be resolved, stop and return it.

## Writing checks

- The opening states the choice and scope without a long introduction.
- The rationale explains the fit to the actual constraints.
- Consequences include supported downsides, not only benefits.
- Wording is neutral, specific, and concise without losing technical precision.
- Headings, terms, and metadata follow the template.
- The record stands alone; supporting designs are linked rather than reproduced.
- References support the claims they accompany; provenance is not implied by a
  plausible URL or a source title alone.

## Revision rule

Run one review after the initial draft. Make at most two revision passes, checking
the affected structure and evidence again after each pass. Stop early if all gates
and writing checks pass. If revision no longer improves the draft or evidence is
missing, return the remaining blocker instead of adding confident filler.

Structural validation checks neither the truth of a claim nor the quality of its
rationale. A same-session review is not an independent evaluation. Do not claim
repeatability from one successful draft; use the plugin's evaluation briefs for
repeated, separately assessed trials.
