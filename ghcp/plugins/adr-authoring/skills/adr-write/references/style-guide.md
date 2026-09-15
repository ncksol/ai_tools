# ADR writing style

Style profile version: 1.0.0. Official references checked on 2026-09-15.
These are paraphrased writing rules, not copied article content or a claim of
Microsoft endorsement. The template and review limits are plugin conventions.

## Rules

1. Lead with the choice. Put its scope in the same short opening paragraph.
2. Use plain, precise language and active voice. Keep necessary technical terms;
   explain unfamiliar acronyms on first use rather than removing useful precision.
3. Use sentence-case headings without terminal periods. Keep paragraphs short and
   focused on one point.
4. Use neutral architectural prose. Do not turn a decision record into a tutorial,
   sales pitch, or recommendation to an unspecified "you".
5. Prefer concrete mechanisms and supported effects over "robust", "seamless",
   "optimal", "enterprise-grade", or "best practice". A claim needs evidence or a
   clear uncertainty label, not a stronger adjective.
6. Use consistent service names, units, terminology, and tense. Present-tense
   decisions and past-tense accounts of an actual evaluation can coexist.
7. Compare relevant tradeoffs. "Better performance" is not a reason without a
   defined constraint or supplied observation. Do not manufacture measurements.
8. Use lists for genuine lists and tables for comparisons. Avoid deeply nested
   lists, repeated summaries, decorative callouts, and a heading for every sentence.
9. Keep enough detail to recover why the decision was made. Link to longer designs
   rather than copying them into the ADR. There is no word-count target that
   justifies losing rationale or consequences.
10. Preserve disagreement, low confidence, costs, and known limitations. Clarity
    does not mean making a conditional choice sound certain.

## Wording examples

These examples are fictional. The better versions assume their facts are supplied
in the brief; do not reuse the assertions in an unrelated ADR.

| Weak wording | Better wording | Reason |
|---|---|---|
| "Leverage a robust messaging backbone." | "Queue export jobs so the request handler does not wait for export completion." | Names the mechanism and relevant effect. |
| "Active-active is unnecessarily complex." | "The team has not designed cross-region conflict handling. Retain one region while the current restore targets remain acceptable." | Connects the choice to an explicit constraint. |
| "Retention is optimized to ensure compliance." | "The proposed retention period is 30 days. Compliance approval was not provided." | Does not turn a proposal into a legal or approval claim. |
| "It is important to note that there are certain disadvantages." | "This choice adds worker operations and duplicate-job handling." | Names the actual cost instead of announcing a list. |

## Official references

- [Maintain an architecture decision record](https://learn.microsoft.com/en-us/azure/well-architected/architect-role/architecture-decision-record):
  consistent anatomy, explicit rationale and consequences, decision confidence,
  focused records, and preserved history.
- [Top 10 tips for Microsoft style and voice](https://learn.microsoft.com/en-us/style-guide/top-10-tips-style-voice):
  key information first, brevity, everyday language, and sentence-case capitalization.
- [Microsoft's brand voice](https://learn.microsoft.com/en-us/style-guide/brand-voice-above-all-simple-human):
  clear, human language with tone adapted to the context.
- [Headings](https://learn.microsoft.com/en-us/style-guide/scannable-content/headings):
  informative headings, consistent structure, and sentence-case formatting.

Read these as style provenance. Browsing them is not a prerequisite for an offline
ADR, and they do not substantiate technical claims about a user's system.
