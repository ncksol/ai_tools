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
  alone. If the web tools are unavailable or every search errors, **stop**: tell the user that grounded
  STORM cannot run in this session and ask them to enable web access or paste sources. Do not fall back to
  a memory-only briefing.
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
4. **Missing perspective** — is there a missing angle beyond the perspectives you used (a sixth lens, if
   you used the default five) that would change the conclusions?
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

Only if the user accepts. **Filename:** confirm the filename and location first; default to the current
working directory as `storm-<topic-slug>-YYYY-MM-DD.html`, where `<topic-slug>` is the topic lowercased
with every run of non-alphanumeric characters replaced by a single hyphen, leading/trailing hyphens
trimmed, and the result capped at ~60 characters — so it is always a valid Windows and POSIX filename.
Before writing, check whether the target file already exists; if it does, ask the user whether to
overwrite it or choose a new name rather than silently replacing it.

Write a **single self-contained `.html` file**: copy the template below verbatim and replace every
`{{TOKEN}}` with the real content from the briefing you produced. Repeat the marked blocks (perspective
cards, contradiction rows, findings, confidence rows, sources) as many times as needed. Do not alter the
structure or CSS, do not add external assets (no external fonts, scripts, or stylesheets), and do not
invent content the briefing does not contain.

**Substitution rules:**

- **Confidence badges:** set each finding's `{{BADGE_CLASS}}` token from its score so the colour matches
  the number — `b-bad` for 1–4, `b-warn` for 5–7, `b-good` for 8–10.
- **Perspective count:** set `{{PERSPECTIVE_COUNT}}` to the number of perspectives you actually used; it
  may not be five if the user overrode the lenses.
- **Escaping:** every substituted value comes from research output, so escape it. In text, replace
  `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`; inside attribute values such as `href="{{URL}}"` also replace
  `"`→`&quot;`. Allow only `http:`/`https:` source URLs — drop or plainly label (do not link) any other
  scheme such as `javascript:`.

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
    <p class="lead">{{PERSPECTIVE_COUNT}} expert lenses on the same topic.</p>
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
        <tr><td>{{FINDING_SHORT}}</td><td><span class="badge {{BADGE_CLASS}}">{{SCORE}}</span></td><td>{{REASON}}</td></tr>
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
