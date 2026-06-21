# STORM research skill — multi-perspective grounded research as a Copilot CLI skill

- **Date:** 2026-06-21
- **Status:** Approved (design); implementation pending
- **Target file:** `ghcp/skills/storm-research/SKILL.md` (new)
- **Reference method:** Stanford OVAL Lab — STORM (Synthesis of Topic Outlines through Retrieval
  and Multi-perspective Question Asking), NAACL 2024, MIT licence
  (<https://github.com/stanford-oval/storm>)
- **Source article:** "The Stanford STORM Method: How to Make Claude Research Like a PhD in Minutes"
  (the 4-prompt adaptation the user asked to turn into a tool)
- **Prior art:** a personal extension `~/.copilot/extensions/storm-research/extension.mjs` already
  implements STORM as a callable tool. It is a *parameterized prompt-template server* (its handler
  returns a templated playbook; it makes no model calls) and lives only in the user's global install,
  not in this repo. This skill re-expresses the same method idiomatically for the `ai_tools` collection.

## 1. Problem statement

The user wants STORM — a multi-perspective research method — as a reusable tool inside GitHub Copilot
CLI, captured in the `ai_tools` repo. The article presents STORM as four prompts a human pastes one at a
time (scan → contradiction map → synthesis → peer review). Pasting prompts by hand is friction and easy to
get wrong or skip a phase. The repo's idiomatic unit for "describe what you want and Copilot does it" is a
**skill** (auto-routed `SKILL.md`), so STORM should be a skill rather than an agent or extension:

- It matches the repo's primary, documented pattern (three existing skills, two agents).
- It auto-routes from natural phrasing ("research X deeply") with no explicit delegation.
- The method is fundamentally a prompt chain, so a markdown prompt captures it with zero code and the best
  repo fit. (The existing extension's handler literally just returns a prompt, confirming this.)

## 2. Design decisions

Settled with the user during brainstorming:

| Decision | Choice |
|---|---|
| Form factor | **Skill** at `ghcp/skills/storm-research/SKILL.md` |
| Grounding | **Always grounded** — real `web_search`/`web_fetch` sources with citations. No memory-only mode. |
| Phase flow | **Always run all 4 phases end-to-end**, in order, one pass. No single-phase mode, no inter-phase checkpoints. |
| Perspectives | **Canonical 5 by default** (Practitioner, Academic, Skeptic, Economist, Historian); swap/add a domain lens when the topic clearly warrants; honour explicit user overrides. |
| Reader role | Inferred from phrasing (e.g. "as an investor"); defaults to "decision-maker"; tailors Phase 3's actionable insight. |
| Primary output | Full briefing in chat as clean markdown (heading per phase, inline citations, sources list). |
| Saved artifact | After the briefing, **offer** to save a polished, self-contained **HTML report**. Nothing written unless the user accepts. |
| HTML approach | **Embed a compact, complete HTML+CSS skeleton in the skill** so every report looks good and is consistent. |

## 3. Goals and non-goals

**Goals**

- A single `SKILL.md` that faithfully runs the 4-phase STORM method, grounded in real sources, and routes
  automatically on deep-research intent.
- Consistent, attractive HTML report output from an embedded template.
- Strong anti-hallucination guardrails appropriate to a grounded research tool.

**Non-goals (explicit constraints)**

- No memory-only / ungrounded mode.
- No single-phase or checkpointed execution.
- No code, MCP server, or extension — this is prompt-only markdown.
- Do **not** force the PR-review skill scaffolding (GitHub/Azure DevOps provider adapters, "No code was
  changed.", merge/approve safety rules) onto this skill — those conventions are specific to the PR skills.
  Carry over only the *general* conventions (see §4).

## 4. Conventions carried over from the repo

From `.github/copilot-instructions.md` and the existing skills, the general (non-PR-specific) conventions
that **do** apply:

- YAML frontmatter with `name:` matching the directory (`storm-research`) and a router-focused
  `description:` stating exactly when to activate.
- Body addressed to the future session ("You are running …"), not human docs.
- An explicit operating-mode / rules section.
- Concrete instructions, not vibes.
- **Forbid hallucination** — the repo's "don't invent line numbers, don't claim a command ran when it
  didn't" becomes "don't invent sources/URLs/quotes/stats, don't claim a search ran when it didn't."
- A prescribed output format.

## 5. Skill structure (`SKILL.md` section outline)

1. **Frontmatter** — `name: storm-research`; router `description` (see §6).
2. **Intro** — "You are running the Stanford STORM research method…" + one-line what-it-is + attribution.
3. **Operating mode / rules** — always grounded; always all 4 phases in order; no fabrication; research/
   reporting only (do not modify the user's repo except writing the report file when the user accepts).
4. **Inputs** — required `topic`; optional reader role; optional perspective overrides. If no topic is
   discernible, ask one question for it.
5. **Perspectives policy** — the canonical 5 with their guiding questions; the adapt/swap rule; the
   override rule.
6. **The 4 phases** — faithful to the article, adapted for grounded execution (see §7).
7. **Grounding rules** — how to search, cite, prefer primary sources, and label unverifiable claims.
8. **Output format** — in-chat markdown briefing (heading per phase, inline citations, sources list).
9. **HTML report** — when/how to offer; the embedded self-contained template; filename/location; what to
   populate.
10. **Anti-hallucination & final reminders.**

## 6. Frontmatter and routing

```yaml
---
name: storm-research
description: >-
  <activates on deep / thorough / multi-perspective / balanced research intent — e.g. "research X
  deeply", "do a deep dive on X", "STORM this topic", "give me a sourced briefing on X", "research this
  before I decide / invest / interview / present". Scoped to substantial research, not casual one-off
  lookups, so it does not hijack quick factual questions.>
---
```

The description must name the verbs/phrases a user is likely to say and explicitly scope to *deep* research
so the router does not over-trigger on every "what is X?".

## 7. The four phases (content spec)

All four run in sequence, grounded, in a single pass. Faithful to the article's prompts.

**Phase 1 — Multi-perspective scan.** Simulate the chosen perspectives (default canonical 5). For each:
core position in 2 sentences; the strongest evidence supporting their view (**with a real cited source**);
the one thing they would tell you that no other perspective would. This is the phase where most web
research happens.

- THE PRACTITIONER (works with this daily): what do they know that academics miss? what practical realities
  are ignored?
- THE ACADEMIC (studied it for years): what does peer-reviewed evidence actually say? where does evidence
  contradict popular belief?
- THE SKEPTIC (thinks the mainstream view is wrong): strongest counterargument? what evidence do proponents
  ignore?
- THE ECONOMIST (follows the money): who profits from the current narrative? what financial incentives
  shape the research?
- THE HISTORIAN (has seen the pattern before): what historical parallels exist? what can we learn from how
  they played out?

**Phase 2 — Contradiction map.** Using the perspectives above: (1) where do two or more directly
contradict, with the specific clashing claims; (2) which perspective has the strongest evidence, which the
weakest, why; (3) the one question that would resolve the biggest contradiction; (4) what every perspective
agrees on (likely true); (5) what none addressed (the field-wide blind spot).

**Phase 3 — Synthesis briefing.** (1) one-paragraph summary for a CEO with 60 seconds who needs nuance;
(2) the 5 key findings ranked by reliability, each noting which perspectives support and which challenge it;
(3) the hidden connection visible only across all perspectives; (4) the actionable insight tailored to the
reader's role; (5) the frontier question that would change everything.

**Phase 4 — Peer review.** (1) confidence scores 1–10 for each key finding, each explained; (2) the weakest
link and what would verify it; (3) bias check — which perspective may be overrepresented; (4) a missing 6th
perspective that could change the conclusions; (5) an overall grade a Stanford professor would give and what
to fix.

## 8. Grounding rules

- Use `web_search`/`web_fetch` to find real, current sources before and while writing; do not rely on memory
  alone for material factual claims.
- Attach an inline citation (source title + URL) to every material factual claim.
- Prefer primary sources, peer-reviewed studies, official data, and recent reporting.
- If a claim cannot be grounded, label it `[UNVERIFIED]` rather than dropping it or dressing it up.
- Maintain a running list of sources to render in the chat briefing and the HTML report.

## 9. Output — chat briefing

Clean markdown. One clear heading per phase. Inline citations next to claims. A consolidated **Sources**
list at the end. After presenting it, offer the HTML report (§10).

## 10. Output — HTML report

When the user accepts the offer, write a **single self-contained `.html` file** (all CSS inline in a
`<style>` block; no external fonts, scripts, or network dependencies) so it renders offline and is easy to
share. Confirm filename and location first; default to the current working directory as
`storm-<topic-slug>-YYYY-MM-DD.html`.

Embedded-template requirements (the skill ships this skeleton so output is consistent):

- **Self-contained:** inline `<style>` only; system font stack; no external assets.
- **Readable layout:** centred content column (~720–820px max width), generous line-height, clear type scale,
  light background with sufficient contrast; print-friendly.
- **Header block:** report title, the topic, the reader role, generation date, and a STORM/Stanford
  attribution line.
- **A section per phase**, in order, with clear headings:
  - Perspectives rendered as cards or a table (name, core position, key evidence, the unique insight).
  - Contradiction map as a readable list/table.
  - Synthesis: summary callout, the ranked findings, the hidden connection, the actionable insight
    (highlighted), the frontier question.
  - Peer review: **colour-coded confidence badges** (1–10, e.g. red/amber/green bands), weakest link, bias
    check, missing perspective, overall grade.
- **Sources section:** numbered, each linked (`<a href>`), matching the inline citations.
- Populated strictly from the briefing actually produced — no placeholder or invented content; `[UNVERIFIED]`
  labels carry through.

## 11. Anti-hallucination and final reminders

- Never fabricate sources, URLs, quotes, statistics, or study results.
- Never claim a web search or fetch ran when it did not.
- Do not present `[UNVERIFIED]` material as established fact.
- Attribute the method to Stanford OVAL Lab (STORM, NAACL 2024).
- The point is genuinely better, blind-spot-resistant research — not impressive-sounding filler.

## 12. Acceptance criteria

- `ghcp/skills/storm-research/SKILL.md` exists; frontmatter parses; `name` matches the directory.
- `description` routes on deep-research intent and is scoped to avoid casual-lookup over-triggering.
- The body specifies: always-grounded execution; all four phases in order; the canonical-5 perspectives with
  adapt/override rules; role inference; the chat briefing format; the offer-to-save flow; and the embedded
  self-contained HTML template with confidence badges and a sources list.
- Anti-hallucination rules are present and explicit.
- No memory-only mode, no single-phase mode, no provider/PR scaffolding, no code/extension.
- README is updated to list the new skill in the Skills table and repository layout (documentation follow-up).

## 13. Out of scope / future

- Single-phase or checkpointed runs (explicitly excluded).
- A memory-only fast mode (explicitly excluded).
- Porting the existing personal extension into `ghcp/extensions/` (a separate decision; not part of this skill).
- PDF export or alternative report themes.
