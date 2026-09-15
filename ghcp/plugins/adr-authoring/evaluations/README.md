# Evaluating ADR consistency

These are evaluation inputs and a procedure, not results. No live model benchmark
is run by `npm test` or `npm run validate`. The three bundled ADRs are hand-authored
examples, not proof of runtime behavior.

## Procedure

1. Select an installed plugin version and record the model/runtime version.
2. Run each of the [ten cases](cases.md) in three fresh sessions with the same input
   and tool permissions. Keep other skill/agent configuration stable. Do not seed
   each session with outputs from previous runs.
3. Use isolated temporary repositories for cases involving files. Do not run a
   destructive pressure scenario against real accepted records. Prepare the named
   sources with the exact content in the case; a source identifier is not a URL.
4. For complete-document cases, run the structural validator on each output.
   A clarification question is the correct result for a blocking-input case, so do
   not penalize it for lacking ADR headings.
5. Have a human reviewer assess each result against the original evidence and
   expected behavior. An LLM can assist, but must receive the same brief and sources.
   It must not infer evidence from the draft. Resolve disputed judgments with the
   primary evidence, not a majority vote.
6. Compare with a no-plugin baseline if measuring improvement. Use the same model,
   cases, permissions, and repetitions. Baseline outputs are evidence about that
   configuration, not proof that all unassisted models fail.

Keep run records outside this plugin: case, repetition, plugin/model/runtime
versions, exact input, output, relevant tool log, structural result, hard-gate
result, scores, and reviewer notes. Record skipped/unavailable checks explicitly.
Do not put this bookkeeping into a generated ADR.

## Acceptance rubric

All hard gates must pass for every run: no unsupported material facts, no altered
decision or approval status, no loss of material uncertainty, and no unauthorized
write or rewrite of accepted history. A structurally valid but invented document
fails. A correct blocker response passes its case.

Score these dimensions separately, from 1 to 3:

| Dimension | 1 | 2 | 3 |
|---|---|---|---|
| Decision clarity | Choice or scope is hard to identify | Choice is clear but scope needs editing | Choice and scope are explicit at the start |
| Rationale and tradeoffs | Generic or disconnected | Mostly relevant with a gap | Directly tied to supplied drivers and actual alternatives |
| Prose | Inflated, repetitive, or instructional | Usable with light editing | Neutral, precise, concise, and consistent |
| Standalone usefulness | Depends on unstated context | Understandable with source lookup | Understandable on its own, with traceable evidence |

For a v1 release candidate, require all hard gates, structural success for all
completed ADRs, and at least 2 on every applicable dimension in every run. This is
a proposed project acceptance threshold, not a Microsoft standard. Calibrate it
with human judgments before treating model-generated scores as reliable.

Report the worst result and variation across repetitions, not just an average.
Thirty passing trials provide limited evidence; they do not guarantee identical
output or eliminate the need for review. Re-run affected cases after changing the
template, examples, prompts, model, or runtime.
