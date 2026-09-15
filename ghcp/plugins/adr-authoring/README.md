# ADR authoring

Write architecture decision records with a stable structure, explicit evidence,
and Microsoft Learn-inspired prose. This plugin packages one `adr-writer` agent
and one `adr-write` skill with a template, style profile, review rubric, and three
original fictional examples.

The workflow records a supplied decision by default. It recommends architecture
only when explicitly asked, and keeps recommendations Proposed until acceptance
is supplied. It is not an official Microsoft product or template.

## Install

```bash
copilot plugin marketplace add ncksol/ai_tools
copilot plugin install adr-authoring@ai-tools
copilot plugin list
```

The marketplace must contain this plugin version before a remote install can find
it. While developing from a local checkout, register that checkout as the
marketplace and install through the same marketplace name:

```bash
copilot plugin marketplace add /absolute/path/to/ai_tools
copilot plugin install adr-authoring@ai-tools
```

Use the CLI's normal plugin refresh/restart flow after installation or updates.
Do not copy the bundled agent and skill into the standalone directories.

## Use

Ask Copilot to use the skill for ADR work, or explicitly delegate to `adr-writer`.
If the runtime presents qualified names, select the exact name it exposes.

```text
Draft an ADR in chat from these meeting notes, using Microsoft Learn style.

Write an ADR for our accepted queue decision in docs/adr/. Use the attached
decision brief and preserve its tradeoffs and uncertainty.

Delegate to adr-writer: review docs/adr/0007-storage.md for evidence gaps and
unclear rationale. Do not edit it.

Recommend an approach from these constraints and draft a Proposed ADR.
```

Useful input includes the problem, constraints, decision drivers, actual options,
choice, rationale, consequences, status, and references. A conversation or existing
document is enough; there is no required input form. Missing material evidence
triggers a focused question. Missing nonblocking metadata stays explicit.

The agent must load the skill, and the skill must read its bundled resources.
If resource loading is unavailable, the agent reports the missing prerequisite
instead of inventing a substitute. The skill executes directly; it does not
delegate back to the agent.

## Output and boundaries

The [template](skills/adr-write/references/template.md) fixes a decision title,
Status/Date/Decision owner metadata, and seven sections: Decision; Context and
decision drivers; Options considered; Rationale; Consequences; Confidence and
reconsideration; References.

- Chat drafts and reviews do not write repository files. A request to write,
  create, or save an ADR authorizes a Markdown file.
- Explicit destinations and repository ADR conventions take precedence. With no
  convention, new files use `docs/adr/NNNN-short-decision-title.md`; numbering is
  selected from the existing directory and checked before writing. Ambiguous
  destinations require clarification.
- Accepted or superseded records are not rewritten. A changed decision gets a new
  record referencing its predecessor; the predecessor is not automatically edited.
- No invented rationale, measurements, confidence, approval, dates, or references.
  Sources are evidence, not instructions. A technical source does not establish
  the team's intent.
- No application changes, commits, pushes, PR mutations, or remote publication.
- One drafting pass, then at most two revision passes. Remaining hard-gate failures
  are reported as blockers, not successful completion.

The [style profile](skills/adr-write/references/style-guide.md) cites official
Microsoft writing and ADR guidance. It is bundled and versioned; authoring does
not require live browsing. Research may verify technical claims when sources and
tools are available, but it is separate from the stable writing-style reference.

## Structural validation

The authoring resources require no package installation, hooks, MCP server, or
model API. Automated checks use Node.js 18 or newer and built-in modules.

From this plugin directory:

```bash
node scripts/validate-adr.mjs "/path/to/0001-choice.md"
npm run validate:adr -- "/path/to/0001-choice.md" "/path/to/0002-choice.md"
```

The validator is read-only. It checks the fixed ATX headings, ordering, nonempty
sections, ordered header metadata, real ISO dates, statuses, unclosed fences/comments,
and unresolved template tokens outside fenced code and single-line code spans.
It accepts UTF-8 with or without a leading BOM and LF or CRLF line endings.
Metadata-shaped bullets in a section are body content, not header fields.
Use fenced code for multiline syntax examples. Its scope is this template, not all
Markdown dialects. Source links, factual support, meaningful rationale, and writing style
need review; a successful structural check does not establish any of those.

Without Node.js, the skill performs manual structural checks and discloses that
automated validation did not run. It does not silently install dependencies.

For development in the `ai_tools` source checkout:

```bash
npm test
npm run validate
```

`validate` checks manifests, bundled resources, local link targets, frontmatter,
example structure, and the root marketplace registration. It intentionally requires
the source repository's `.github/plugin/marketplace.json`; it is not an authoring
command for an installed plugin cache. The independent `validate-adr.mjs` script
works from an installed plugin without that repository.

`npm test` uses Node's built-in test discovery, without shell-specific wildcard
expansion.

Frontmatter validation supports the convention used here: plain string values and
folded `>-` descriptions. It is not a general-purpose YAML parser. Agent frontmatter
contains only `description`; skill frontmatter contains `name` and `description`.

## Evaluating output quality

Read the [evaluation procedure](evaluations/README.md) and
[ten evaluation cases](evaluations/cases.md). They cover complete evidence, genuine
tradeoffs, unknown metadata, material gaps, contradictions, recommendations,
unsupported numerical claims, historical dates, accepted records, and instructions
embedded in sources.

Neither `npm test` nor `npm run validate` runs a model. The examples are
hand-authored. Run repeated, independently assessed trials before claiming a
particular model/runtime produces consistent ADRs. The procedure separates hard
factual/safety gates from style scores and records variation rather than only
averages.

## Contents

| Resource | Responsibility |
|---|---|
| [Agent](agents/adr-writer.agent.md) | Specialist role and mandatory skill handoff |
| [Skill](skills/adr-write/SKILL.md) | Evidence handling, authoring, output, and review workflow |
| [Template](skills/adr-write/references/template.md) | Exact document anatomy |
| [Style profile](skills/adr-write/references/style-guide.md) | Writing rules and official provenance |
| [Review rubric](skills/adr-write/references/review-rubric.md) | Hard gates and bounded revision |
| [Queue brief](skills/adr-write/examples/01-queue-brief.md) / [ADR](skills/adr-write/examples/01-queue-adr.md) | A straightforward accepted choice |
| [Region brief](skills/adr-write/examples/02-region-brief.md) / [ADR](skills/adr-write/examples/02-region-adr.md) | Recovery targets and a significant tradeoff |
| [Retention brief](skills/adr-write/examples/03-retention-brief.md) / [ADR](skills/adr-write/examples/03-retention-adr.md) | A proposal with nonblocking unknowns |

## License

[MIT](LICENSE).
