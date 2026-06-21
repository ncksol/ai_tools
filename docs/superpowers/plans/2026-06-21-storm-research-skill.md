# STORM Research Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single auto-routed Copilot CLI skill, `storm-research`, that runs the Stanford STORM method (five expert perspectives → contradiction map → synthesised briefing → peer review), grounded in real web sources, and offers a polished self-contained HTML report.

**Architecture:** One new prompt file, `ghcp/skills/storm-research/SKILL.md`, containing YAML frontmatter, the four-phase prompt body, grounding/output rules, and an embedded self-contained HTML report template. A second change updates `README.md` to list the new skill. No code, no MCP server, no extension.

**Tech Stack:** Markdown + YAML frontmatter (the GitHub Copilot CLI skill format). The embedded report is a single self-contained HTML5 file with inline CSS only. Validation uses Python (already available) and PowerShell `Select-String` — this repo has **no build, test, or lint tooling**, so "tests" here are structural/parse checks, matching the repo convention: *validation = confirm frontmatter parses and structure matches conventions*.

## Global Constraints

- Skill file path: `ghcp/skills/storm-research/SKILL.md`; frontmatter `name:` MUST equal the directory name `storm-research`.
- Always grounded — the skill must instruct use of `web_search`/`web_fetch`; there is NO memory-only mode.
- Always run all four phases end-to-end, in order — NO single-phase mode, NO inter-phase checkpoints.
- Perspectives: canonical five by default (Practitioner, Academic, Skeptic, Economist, Historian); adapt/swap a domain lens when warranted; honour explicit user overrides.
- Anti-hallucination rules are mandatory: never invent sources/URLs/quotes/stats; never claim a search ran when it didn't; label unverifiable claims `[UNVERIFIED]`.
- HTML report: single self-contained `.html` file (inline CSS only, no external assets); offered, never auto-written; default filename `storm-<topic-slug>-YYYY-MM-DD.html` in the current working directory.
- Commit policy for THIS repo: **no `Co-authored-by` trailer** (overrides any global default).
- Do NOT add PR-review scaffolding (GitHub/Azure DevOps provider adapters, merge/approve safety rules, "No code was changed.").
- Operating system is Windows; validation commands below are PowerShell-flavoured.

---

## Task 1: Create the `storm-research` skill file

**Files:**
- Create: `ghcp/skills/storm-research/SKILL.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the skill file at `ghcp/skills/storm-research/SKILL.md` with frontmatter `name: storm-research`, four phase headings (`Phase 1 — Multi-Perspective Scan`, `Phase 2 — Contradiction Map`, `Phase 3 — Synthesis Briefing`, `Phase 4 — Peer Review`), and an embedded `<!DOCTYPE html>` report template. Task 2 (README) references the path `./ghcp/skills/storm-research/SKILL.md`.

- [ ] **Step 1: Create the skill file with full content**

Create `ghcp/skills/storm-research/SKILL.md` with EXACTLY the following content (the outer four-backtick fence is just this plan's wrapper — do not include it in the file; the file's own content starts at `---` and ends after the final reminders):

````markdown
---
name: storm-research
description: >-
  Use this skill when the user asks for deep, thorough, multi-perspective, or balanced research on a
  topic rather than a quick fact — for example "research X deeply", "do a deep dive on X", "STORM this",
  "give me a sourced briefing on X", "research this before I decide / invest / interview / present /
  negotiate", or "what are all the angles on X?". It runs the Stanford STORM method: simulate five expert
  perspectives, map their contradictions, synthesise a sourced briefing, and peer-review the result. Do
  not use it for simple one-off factual lookups.
---

# STORM Research

You are running the **Stanford STORM** research method — *Synthesis of Topic Outlines through Retrieval
and Multi-perspective Question Asking* (Stanford OVAL Lab, NAACL 2024, MIT). Multi-perspective questioning
produces research that is measurably more organised and broader in coverage than a single-prompt answer,
because it deliberately surfaces the blind spots one viewpoint never sees.

Your job: take the user's topic and produce a grounded, multi-angle research briefing by running four
phases end to end, then offer a polished HTML report.

## Operating mode

- **Always grounded.** Use your `web_search` and `web_fetch` tools to find real, current sources. Every
  material factual claim must carry an inline citation (source title + URL). Never run this from memory
  alone.
- **Always run all four phases, in order, in one pass:** Multi-Perspective Scan → Contradiction Map →
  Synthesis Briefing → Peer Review. Do not stop after one phase and do not skip a phase.
- **Research and report only.** Do not modify the user's repository or files, except writing the HTML
  report to disk *after the user accepts the offer*. Do not run destructive commands.
- **Never fabricate.** Do not invent sources, URLs, quotes, statistics, or study results. Do not claim a
  search ran when it did not. If a claim cannot be grounded, label it `[UNVERIFIED]` rather than dropping
  it or dressing it up as fact.

## Inputs

- **Topic** (required) — the subject to research. If the user has not given a clear topic, ask one short
  question to get it before doing anything else.
- **Reader role** (optional) — used to tailor the actionable insight in Phase 3. Infer it from the user's
  phrasing (e.g. "as an investor", "for my interview"). If none is evident, default to "decision-maker".
- **Perspective overrides** (optional) — if the user names the lenses they want, use those instead of the
  defaults.

## Perspectives

Default to these five canonical lenses. Stay in character for each and surface only what that lens reveals:

1. **THE PRACTITIONER** — works with this daily. What do they know that academics miss? What practical
   realities are usually ignored?
2. **THE ACADEMIC** — has studied it for years. What does the peer-reviewed evidence actually say? Where
   does it contradict popular belief?
3. **THE SKEPTIC** — thinks the mainstream view is wrong. What is the strongest counterargument? What
   evidence do proponents conveniently ignore?
4. **THE ECONOMIST** — follows the money. Who profits from the current narrative? What financial
   incentives shape the research?
5. **THE HISTORIAN** — has seen the pattern before. What historical parallels exist? What can we learn
   from how they played out?

**Adapt when the topic clearly warrants it:** swap or add a domain lens that would see something the
canonical five would miss — e.g. *The Regulator* for policy/compliance topics, *The Clinician* for
medical topics, *The End User* for product topics, *The Engineer* for technical-feasibility topics. Keep
five perspectives unless the user asks for more. If the user supplied their own perspectives, use those
and skip the defaults.

## Phase 1 — Multi-Perspective Scan

The heart of the method. Research the topic with your web tools, then for **each** perspective give:

- **Core position** in two sentences.
- **Strongest evidence** supporting their view — with a real, cited source.
- **The one thing** they would tell the reader that no other perspective would.

## Phase 2 — Contradiction Map

Using the perspectives above:

1. Where do two or more perspectives directly contradict each other? List each conflict with the specific
   clashing claims.
2. Which perspective has the strongest evidence? Which the weakest? Why?
3. The one question that, if answered, would resolve the biggest contradiction.
4. What does *every* perspective agree on? (Likely true — even opponents confirm it.)
5. What did *none* of the perspectives address? (The blind spot in the whole field — often the most
   valuable finding.)

## Phase 3 — Synthesis Briefing

Pull the perspectives and the contradiction map into one briefing:

1. **One-paragraph summary** — brief a CEO who has 60 seconds and needs nuance, not just the headline.
2. **Five key findings** — ranked by reliability. For each, note which perspectives support it and which
   challenge it.
3. **The hidden connection** — one non-obvious link between findings that only appears when you look
   across all perspectives.
4. **The actionable insight** — based on all the evidence, what should someone in the reader's role
   actually *do* differently? Be specific.
5. **The frontier question** — the one question that, if answered, would change how we understand this
   topic.

## Phase 4 — Peer Review

STORM's known weakness is that it does not self-critique; source bias and fact misassociation creep in.
Grade your own briefing honestly:

1. **Confidence scores** — rate each of the five key findings 1–10 for reliability and explain each score.
2. **Weakest link** — which claim are you least confident in? What specific information would verify it?
3. **Bias check** — which perspective may be overrepresented in the synthesis? Did one voice dominate?
4. **Missing perspective** — is there a sixth angle that would change the conclusions?
5. **Overall grade** — what grade would a Stanford professor give this briefing, and what would they tell
   you to fix?

## Grounding rules

- Search before and while you write; prefer primary sources, peer-reviewed studies, official data, and
  recent reporting.
- Attach an inline citation (title + URL) to every material factual claim.
- Keep a running list of every source you cite; you will render it in the briefing and the report.
- Label anything you could not verify as `[UNVERIFIED]`.

## Output — chat briefing

Present the full briefing in chat as clean markdown: one clear heading per phase, inline citations next to
claims, and a consolidated **Sources** list at the end. Then offer the HTML report:

> "Want me to save this as a polished HTML report you can open and share?"

## Output — HTML report

Only if the user accepts. Confirm the filename and location first; default to the current working
directory as `storm-<topic-slug>-YYYY-MM-DD.html`. Write a **single self-contained `.html` file**: copy
the template below verbatim and replace every `{{TOKEN}}` with the real content from the briefing you
produced. Repeat the marked blocks (perspective cards, contradiction rows, findings, confidence rows,
sources) as many times as needed. Do not alter the structure or CSS, do not add external assets (no
external fonts, scripts, or stylesheets), and do not invent content the briefing does not contain. For the
confidence badges, use class `b-bad` for scores 1–4, `b-warn` for 5–7, and `b-good` for 8–10.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STORM Research Briefing — {{TOPIC}}</title>
<style>
  :root{
    --ink:#1a1d24; --muted:#5b6472; --line:#e4e7ec; --bg:#f6f7f9;
    --card:#ffffff; --accent:#3b5bdb; --accent-soft:#eef2ff;
    --good:#1f9d55; --warn:#c97a0a; --bad:#d64545;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.65;font-size:16px;}
  .wrap{max-width:800px;margin:0 auto;padding:48px 24px 80px;}
  header.report{border-bottom:3px solid var(--accent);padding-bottom:20px;margin-bottom:8px;}
  .eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);
    font-weight:700;margin:0 0 6px;}
  h1{font-size:30px;line-height:1.2;margin:0 0 12px;}
  .meta{color:var(--muted);font-size:14px;margin:0;}
  .meta b{color:var(--ink);font-weight:600;}
  section.phase{margin-top:40px;}
  h2{font-size:21px;margin:0 0 4px;padding-top:8px;}
  h2 .num{color:var(--accent);font-weight:800;margin-right:8px;}
  .lead{color:var(--muted);font-size:14px;margin:0 0 16px;}
  h3{font-size:16px;margin:24px 0 8px;}
  .cards{display:grid;gap:14px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;}
  .card h4{margin:0 0 8px;font-size:15px;letter-spacing:.02em;text-transform:uppercase;color:var(--accent);}
  .card p{margin:0 0 8px;}
  .card .uniq{background:var(--accent-soft);border-radius:8px;padding:8px 12px;font-size:14px;margin-top:10px;}
  .callout{background:#fff;border-left:4px solid var(--accent);border-radius:8px;padding:14px 18px;
    margin:0 0 16px;box-shadow:0 1px 2px rgba(16,24,40,.04);}
  .action{background:#ecfdf3;border-left:4px solid var(--good);}
  ol.findings{padding-left:0;list-style:none;counter-reset:f;}
  ol.findings>li{background:var(--card);border:1px solid var(--line);border-radius:10px;
    padding:14px 16px 14px 52px;position:relative;margin-bottom:12px;counter-increment:f;}
  ol.findings>li::before{content:counter(f);position:absolute;left:14px;top:14px;width:26px;height:26px;
    border-radius:50%;background:var(--accent);color:#fff;font-weight:700;display:flex;
    align-items:center;justify-content:center;font-size:14px;}
  .badge{display:inline-block;min-width:30px;text-align:center;padding:2px 9px;border-radius:999px;
    color:#fff;font-weight:700;font-size:13px;}
  .b-good{background:var(--good);} .b-warn{background:var(--warn);} .b-bad{background:var(--bad);}
  table{width:100%;border-collapse:collapse;margin:8px 0;font-size:14px;}
  th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;}
  th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;}
  .grade{font-size:34px;font-weight:800;color:var(--accent);}
  a{color:var(--accent);}
  ol.sources{font-size:14px;color:var(--muted);padding-left:22px;}
  ol.sources li{margin-bottom:6px;}
  .unverified{color:var(--bad);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;}
  footer.report{margin-top:48px;padding-top:18px;border-top:1px solid var(--line);
    color:var(--muted);font-size:13px;}
  @media print{body{background:#fff;}.card,ol.findings>li{break-inside:avoid;}.wrap{padding:0;}}
</style>
</head>
<body>
<div class="wrap">
  <header class="report">
    <p class="eyebrow">STORM Research Briefing</p>
    <h1>{{TOPIC}}</h1>
    <p class="meta">Prepared for <b>{{ROLE}}</b> &middot; {{DATE}} &middot; Grounded, multi-perspective analysis<br>
    Method: Stanford STORM (OVAL Lab, NAACL 2024)</p>
  </header>

  <section class="phase">
    <h2><span class="num">1</span>Multi-Perspective Scan</h2>
    <p class="lead">Five expert lenses on the same topic.</p>
    <div class="cards">
      <!-- PERSPECTIVE_CARDS: repeat one .card per perspective -->
      <div class="card">
        <h4>{{PERSPECTIVE_NAME}}</h4>
        <p>{{CORE_POSITION}}</p>
        <p><b>Strongest evidence:</b> {{EVIDENCE}} {{CITATION}}</p>
        <div class="uniq"><b>Only they would say:</b> {{UNIQUE_INSIGHT}}</div>
      </div>
    </div>
  </section>

  <section class="phase">
    <h2><span class="num">2</span>Contradiction Map</h2>
    <p class="lead">Where the perspectives fight — and where they all agree.</p>
    <h3>Direct contradictions</h3>
    <table>
      <thead><tr><th>Conflict</th><th>Clashing claims</th></tr></thead>
      <tbody>
        <!-- CONTRADICTION_ROWS: repeat one tr -->
        <tr><td>{{CONFLICT}}</td><td>{{CLASHING_CLAIMS}}</td></tr>
      </tbody>
    </table>
    <h3>Strongest vs. weakest evidence</h3>
    <p>{{STRONGEST_WEAKEST}}</p>
    <h3>The resolving question</h3>
    <p>{{RESOLVING_QUESTION}}</p>
    <h3>Universal agreement (likely true)</h3>
    <p>{{AGREEMENT}}</p>
    <h3>Field-wide blind spot</h3>
    <p>{{BLIND_SPOT}}</p>
  </section>

  <section class="phase">
    <h2><span class="num">3</span>Synthesis Briefing</h2>
    <div class="callout"><b>60-second summary.</b> {{SUMMARY}}</div>
    <h3>Key findings (ranked by reliability)</h3>
    <ol class="findings">
      <!-- FINDINGS: repeat one li -->
      <li>{{FINDING}}<br><small>Supported by: {{SUPPORT}} &middot; Challenged by: {{CHALLENGE}}</small></li>
    </ol>
    <h3>The hidden connection</h3>
    <p>{{HIDDEN_CONNECTION}}</p>
    <div class="callout action"><b>Actionable insight for {{ROLE}}.</b> {{ACTION}}</div>
    <h3>Frontier question</h3>
    <p>{{FRONTIER}}</p>
  </section>

  <section class="phase">
    <h2><span class="num">4</span>Peer Review</h2>
    <p class="lead">The briefing grades itself — STORM's built-in self-critique.</p>
    <table>
      <thead><tr><th>Finding</th><th>Confidence</th><th>Why</th></tr></thead>
      <tbody>
        <!-- CONFIDENCE_ROWS: badge class b-bad (1-4), b-warn (5-7), b-good (8-10) -->
        <tr><td>{{FINDING_SHORT}}</td><td><span class="badge b-good">{{SCORE}}</span></td><td>{{REASON}}</td></tr>
      </tbody>
    </table>
    <h3>Weakest link</h3>
    <p>{{WEAKEST}}</p>
    <h3>Bias check</h3>
    <p>{{BIAS}}</p>
    <h3>Missing perspective</h3>
    <p>{{MISSING}}</p>
    <h3>Overall grade</h3>
    <p><span class="grade">{{GRADE}}</span><br>{{GRADE_NOTES}}</p>
  </section>

  <section class="phase">
    <h2><span class="num">&sect;</span>Sources</h2>
    <ol class="sources">
      <!-- SOURCES: repeat one li -->
      <li><a href="{{URL}}">{{SOURCE_TITLE}}</a></li>
    </ol>
  </section>

  <footer class="report">
    Generated with the storm-research Copilot skill &middot; STORM method &copy; Stanford OVAL Lab (MIT).
    Claims marked <span class="unverified">unverified</span> were not source-confirmed.
  </footer>
</div>
</body>
</html>
```

## Final reminders

- The goal is genuinely better, blind-spot-resistant research — not impressive-sounding filler.
- No fabricated sources, no invented numbers, no claimed-but-unrun searches.
- Credit the method to Stanford OVAL Lab (STORM, NAACL 2024).
````

- [ ] **Step 2: Verify the frontmatter parses and `name` matches the directory**

Run:

```powershell
python -c "t=open(r'ghcp/skills/storm-research/SKILL.md',encoding='utf-8').read(); p=t.split('---'); assert p[0]=='' , 'must start with ---'; assert 'name: storm-research' in p[1], 'name missing/mismatched'; assert 'description:' in p[1], 'description missing'; print('frontmatter OK')"
```

Expected output: `frontmatter OK`

- [ ] **Step 3: Verify all four phase headings are present**

Run:

```powershell
(Select-String -Path 'ghcp/skills/storm-research/SKILL.md' -Pattern 'Phase 1 — Multi-Perspective Scan','Phase 2 — Contradiction Map','Phase 3 — Synthesis Briefing','Phase 4 — Peer Review').Count
```

Expected output: `4`

- [ ] **Step 4: Verify the embedded HTML report is self-contained (no external assets)**

Run:

```powershell
$ext = Select-String -Path 'ghcp/skills/storm-research/SKILL.md' -Pattern '<script\s+src=','<link[^>]*stylesheet','@import','src\s*=\s*"https?:'
if ($ext) { "FAIL: external asset reference found"; $ext } else { "self-contained OK" }
```

Expected output: `self-contained OK`

(The template's only `http(s)` references are inside `<a href="{{URL}}">` source-citation tokens, which are content links, not assets, and do not match the patterns above.)

- [ ] **Step 5: Verify anti-hallucination and grounding language is present**

Run:

```powershell
(Select-String -Path 'ghcp/skills/storm-research/SKILL.md' -Pattern 'Never fabricate','\[UNVERIFIED\]','web_search','Always grounded').Count
```

Expected output: `4` (or greater)

- [ ] **Step 6: Commit**

```powershell
git add ghcp/skills/storm-research/SKILL.md
git commit -m "feat: add storm-research skill (Stanford STORM, grounded, HTML report)"
```

---

## Task 2: List the new skill in the README

**Files:**
- Modify: `README.md` (Skills table + scoping prose ~lines 34-42; repository-layout tree ~lines 172-179)

**Interfaces:**
- Consumes: the file path `./ghcp/skills/storm-research/SKILL.md` produced by Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the skill row to the Skills table**

In `README.md`, find this line (the `rereview-pr` table row):

```markdown
| [`rereview-pr`](./ghcp/skills/rereview-pr/SKILL.md) | Focused **second-pass** review: were the previous findings actually addressed? Is the engineer's pushback valid? | "Re-review `<url>`" |
```

Add a new row immediately after it:

```markdown
| [`storm-research`](./ghcp/skills/storm-research/SKILL.md) | Runs the Stanford **STORM** research method — five expert perspectives, a contradiction map, a synthesised briefing, and a self-critique — grounded in real web sources. Outputs a chat briefing plus an optional self-contained HTML report. | "Research `<topic>` deeply" / "STORM `<topic>`" |
```

- [ ] **Step 2: Re-scope the "All three…" prose so it stays accurate**

The two sentences below the table currently describe all skills as PR-review skills. Replace this block:

```markdown
All three are **provider-neutral** — they work with both **GitHub** and **Azure DevOps** pull requests, and gracefully fall back to local branches or pasted diffs/feedback when remote access isn't available.

All three are **safe by design**: they only inspect and report. They will not edit files, commit, push, post comments, resolve threads, approve, reject, merge, or close the PR.
```

with:

```markdown
The three PR-review skills (`strict-code-review`, `analyse-pr-feedback`, `rereview-pr`) are **provider-neutral** — they work with both **GitHub** and **Azure DevOps** pull requests, and gracefully fall back to local branches or pasted diffs/feedback when remote access isn't available.

Those three are **safe by design**: they only inspect and report. They will not edit files, commit, push, post comments, resolve threads, approve, reject, merge, or close the PR.

[`storm-research`](./ghcp/skills/storm-research/SKILL.md) is a different kind of skill — grounded research, not code review. It reads from the web and writes to disk only when you explicitly accept its offer to save an HTML report.
```

- [ ] **Step 3: Add the skill to the repository-layout tree**

In the `## 🗂 Repository layout` code block, replace:

```text
    │   └── rereview-pr/
    │       └── SKILL.md
    └── agents/
```

with:

```text
    │   ├── rereview-pr/
    │   │   └── SKILL.md
    │   └── storm-research/
    │       └── SKILL.md
    └── agents/
```

- [ ] **Step 4: Verify both README references resolve and the table row exists**

Run:

```powershell
(Select-String -Path 'README.md' -Pattern '\[`storm-research`\]\(\./ghcp/skills/storm-research/SKILL\.md\)').Count
(Select-String -Path 'README.md' -Pattern '└── storm-research/').Count
Test-Path 'ghcp/skills/storm-research/SKILL.md'
```

Expected output: a count `>= 2` for the first line (table row + the new prose paragraph link), `1` for the tree entry, and `True` for the path.

- [ ] **Step 5: Verify the stale "All three are safe by design" wording is gone**

Run:

```powershell
(Select-String -Path 'README.md' -Pattern 'All three are \*\*safe by design\*\*').Count
```

Expected output: `0`

- [ ] **Step 6: Commit**

```powershell
git add README.md
git commit -m "docs: list storm-research skill in README"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-21-storm-research-skill-design.md`):

- §2 form factor = skill → Task 1 creates `ghcp/skills/storm-research/SKILL.md`. ✓
- §2 always grounded → Operating mode + Grounding rules sections; Step 5 verifies. ✓
- §2 all four phases, no single-phase/checkpoints → four phase sections + "Always run all four phases" rule. ✓
- §2 perspectives (canonical 5 + adapt + override) → Perspectives section. ✓
- §2 role inference, default "decision-maker" → Inputs section. ✓
- §2/§9 chat briefing format → "Output — chat briefing". ✓
- §2/§10 offered HTML report, embedded template, badges, sources, default filename → "Output — HTML report" + template; Step 4 verifies self-contained. ✓
- §11 anti-hallucination → Operating mode + Final reminders; Step 5 verifies. ✓
- §12 README update → Task 2. ✓
- §3 non-goals (no memory-only, no single-phase, no code, no PR scaffolding) → Global Constraints enforce; no such content authored. ✓

No gaps.

**2. Placeholder scan:** The only `{{TOKEN}}` / `<!-- ... -->` markers live *inside the HTML report template*, where they are deliberate fill-in points the skill replaces at runtime — they are required content, not plan placeholders. No `TBD`/`TODO`/"implement later"/"add error handling"/"similar to Task N" anywhere. ✓

**3. Type/string consistency:** Badge classes `b-bad`/`b-warn`/`b-good` defined in the CSS and referenced identically in the Phase-4 instruction and the confidence-row comment. Phase heading strings used in Step 3's check (`Phase 1 — Multi-Perspective Scan`, etc., with an em dash `—`) match the headings written in Step 1. README path `./ghcp/skills/storm-research/SKILL.md` matches the created file path. Default filename pattern `storm-<topic-slug>-YYYY-MM-DD.html` stated once. ✓

> Note for the implementer: the phase headings use an em dash (`—`, U+2014), not a hyphen. Copy them exactly so the Step 3 `Select-String` match returns `4`.
