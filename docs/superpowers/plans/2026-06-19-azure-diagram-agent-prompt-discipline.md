# Azure Diagram Agent — Prompt Discipline Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the `azure-arch-diagram` agent's layout and semantic-correctness discipline by porting prompt-only rules from the `azure-architecture-diagram-builder` web app, without introducing a deterministic layout engine.

**Architecture:** All changes are edits to a single Markdown agent prompt, `ghcp/agents/azure-arch-diagram.agent.md`. We reconcile the thin §1.5 Layout paragraph and add five new subsections (§1.11–§1.15) under the existing §1 "Azure Architecture Centre Style Rules", then tighten the §7 Quality Checklist. Inserting as §1.x subsections (not a new top-level section) avoids renumbering §2–§9; the file's only cross-references are textual ("see Color Palette below", "the quality checklist above") and stay valid.

**Tech Stack:** Markdown agent prompt for the draw.io / mxGraph domain. This repo has **no build, test, or lint** — validation is structural: frontmatter parses, required headings present, forbidden terms absent, and the diff is confined to the intended regions.

## Global Constraints

Copied from the spec (`docs/superpowers/specs/2026-06-19-azure-diagram-agent-prompt-discipline-design.md`). Every task implicitly includes these:

- **No deterministic layout engine.** Do not introduce ELK/dagre, a JSON-spec-then-render pipeline, or any post-processing/normalization. The agent keeps emitting mxGraph XML directly. The words "ELK", "dagre", "layout engine", "deterministic layout" must NOT appear in the file.
- **Do not modify** the icon catalog (§4), the colour palette (§2), the mxGraph syntax reference (§3), or the five worked templates (§5.1–§5.5).
- **Frontmatter unchanged:** `name: azure-arch-diagram` stays; the agent still instructs direct draw.io XML generation.
- **Icon scale is 50×50px.** Spacing numbers in this plan are calibrated to that scale.
- **Commit policy:** NO `Co-authored-by` trailer on any commit (repo + user global policy).
- **Edits confined to §1 (lines ~46–76) and §7 (lines ~1196–1209).** No other region changes.

---

### Task 1: §1 layout overhaul — reconcile §1.5 and add §1.11–§1.15

**Files:**
- Modify: `ghcp/agents/azure-arch-diagram.agent.md:46-51` (reconcile §1.5 Layout)
- Modify: `ghcp/agents/azure-arch-diagram.agent.md:75-77` (insert §1.11–§1.15 after §1.10, before the `---`/`## 2`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: subsection anchors `### 1.11 Tier-Based Placement`, `### 1.12 Connection Flow Direction`, `### 1.13 Anchors & Arrow Direction`, `### 1.14 Connection Budget & Spacing`, `### 1.15 Labels, Grouping & Naming`. Task 2's checklist cross-references these exact headings (§1.11–§1.15).

- [ ] **Step 1: Reconcile §1.5 Layout**

Replace this exact block (lines 46–51):

```markdown
### 1.5 Layout
- **Left-to-right flow** is preferred (users/internet on left, data stores on right)
- Alternative: top-to-bottom for hierarchy/layered diagrams
- Maintain consistent spacing: 100-150px between icons, 200px between groups
- Icon size: **50x50px** for resources (standard), **40x40px** for smaller/secondary items
- Keep diagrams under 15-20 resources for clarity — use layered diagrams for complex systems
```

with:

```markdown
### 1.5 Layout
- **Left-to-right flow** is preferred (users/internet on left, data stores on right)
- Alternative: top-to-bottom for hierarchy/layered diagrams
- Baseline spacing: ≥60–80px clear gap between icons, ~200px between groups. **Labeled edges need extra clearance — see §1.14**
- Icon size: **50x50px** for resources (standard), **40x40px** for smaller/secondary items
- Keep diagrams under 15-20 resources for clarity — use layered diagrams for complex systems
- For the full placement, flow-direction, spacing, and connection-budget rules, follow **§1.11–§1.15** below
```

- [ ] **Step 2: Insert §1.11–§1.15**

After the last line of §1.10 (line 75: `  - **Deployment diagram** → infrastructure mapping`) and before the `---` on line 77, insert a blank line then this exact content:

```markdown

### 1.11 Tier-Based Placement

Place services by role into horizontal bands. The main flow is the backbone; everything else orbits it.

- **Main data-plane pipeline** (entry actor → ingress → processing → primary data sinks) occupies the **middle horizontal band** and flows strictly **left→right**. Make it the visually dominant row.
- **Control-plane, provisioning, and secrets** (Key Vault, provisioning/deployment services, Microsoft Entra ID when used for control) go **above** the pipeline; their edges drop **down** into it.
- **Observability** (Azure Monitor, Log Analytics, Application Insights, Microsoft Sentinel, Microsoft Defender for Cloud) goes **above** the pipeline or in a dedicated container to the side; draw its edges **dashed**.
- **Storage, batch analytics, and long-term data** (Data Lake, Synapse, Cosmos DB, Azure SQL, Blob) go **below** the pipeline; their edges come **up** into it.
- **ML / inference / feedback loops** sit adjacent to analytics (typically **bottom-right**); make feedback edges visually distinct (e.g. curved routing).
- **End-user dashboards and web UIs** go **far-left** if they trigger the flow, or **far-right** if they consume output — never in the middle row.
- **On-premises** sits on the **left**, entering Azure through an explicit boundary node (ExpressRoute, VPN Gateway, or Private Link) before any edge crosses into an Azure container.

### 1.12 Connection Flow Direction

Arrow direction matters more than completeness. These two flows are drawn wrong by default — apply these rules.

- **Telemetry flows from the emitter to the collection store — never the reverse.**
  - Allowed: workload → Log Analytics or Application Insights; Application Insights → Log Analytics; workload → Azure Monitor (platform metrics, label e.g. "Publish metrics"); Log Analytics → Microsoft Sentinel / Defender for Cloud.
  - **Do NOT draw Azure Monitor → Log Analytics** — Azure Monitor reads from Log Analytics, it does not push logs in.
  - **Do NOT fan in** an edge from every service to Log Analytics (use hub-and-spoke — see §1.14).
  - To show alerting, draw an edge **from Azure Monitor to an action target** (Logic Apps, Action Group, Webhook) labeled e.g. "Trigger alert" — not Log Analytics → Azure Monitor.
- **Identity / OAuth: the user's first hop is the application entry point, not the identity provider.**
  - Correct: `user → app ingress` (Front Door / Application Gateway / API Management / App Service / Container Apps), then `app ingress → Microsoft Entra ID` labeled "Authenticate user", "Validate token", or "Acquire token".
  - `user → Microsoft Entra ID` as a first hop is **incorrect** for any web app, API, or enterprise workload.
  - Exception: when identity itself is the diagram's subject (e.g. an Entra ID Conditional Access or B2C onboarding flow), `user → Entra ID` is correct.

### 1.13 Anchors & Arrow Direction

Align each edge's anchors with the flow so arrows leave and enter at the correct side. §3.3 shows edge syntax; add explicit exit/entry anchors:

- Inputs enter a node from its **left** or **top**; outputs leave from its **right** or **bottom**.
- Choose the `(source, target)` order and anchor fragments so the drawn arrow matches the intended direction:
  - Left→right: `exitX=1;exitY=0.5;entryX=0;entryY=0.5;`
  - Top→bottom: `exitX=0.5;exitY=1;entryX=0.5;entryY=0;`
- Append these to the edge `style` (e.g. `...;exitX=1;exitY=0.5;entryX=0;entryY=0.5;`). Omitting anchors lets draw.io pick icon centers, which often routes arrows backwards through other icons.

### 1.14 Connection Budget & Spacing

Fewer, well-placed edges read better than an exhaustive web.

**Connection budget:**
- Draw only edges that represent **primary** data or control flow. Omit implicit relationships.
- **Monitoring is hub-and-spoke:** connect the primary compute service to Azure Monitor, then a **single** Azure Monitor ↔ Log Analytics relationship. Do not connect every service to Log Analytics.
- Show **one representative** Key Vault edge, not one from every consumer.
- **Minimize cross-group edges.** Put tightly-coupled services in the same container. Prefer connecting services in **adjacent** containers; avoid edges that span the whole canvas — add an intermediate hop or move the services closer.

**Spacing (50×50 icons):**
- Keep a **clear gap of ≥60–80px** between any two icons.
- When a **labeled** edge connects two icons, leave extra clearance so the mid-edge label doesn't collide: **≥160px center-to-center horizontally**, **≥120px center-to-center vertically**.
- Give grouping containers **≥30px padding** around their child icons (children use parent-relative coordinates).
- Keep **~200px** between separate groups.

### 1.15 Labels, Grouping & Naming

- **Connection labels are verb-first and short** (≤24 characters, 2–4 words): "Send telemetry", "Validate token", "Persist result". Avoid noun-only ("Telemetry") or generic ("Data", "Request") labels.
- A multi-tier system needs **≥2 labeled containers**; a single-container diagram for a multi-service system is wrong. Keep **≤6 services per container**.
- Use **official Microsoft product names only**. Never invent composite names like "Azure Workloads" or "Logic Apps Playbooks". Use **"Microsoft Entra ID"**, never "Azure Active Directory" or "AAD".
```

- [ ] **Step 3: Validate structure**

Run:

```bash
cd "$(git rev-parse --show-toplevel)"
F=ghcp/agents/azure-arch-diagram.agent.md
echo "--- new subsections (expect 1.11..1.15) ---"; grep -nE "^### 1\.1[1-5] " "$F"
echo "--- §1.5 reconciled (expect cross-ref to §1.11–§1.15) ---"; grep -n "follow \*\*§1.11–§1.15\*\*" "$F"
echo "--- forbidden layout-engine terms (expect 0) ---"; grep -ciE "elk|dagre|layout engine|deterministic layout" "$F"
echo "--- templates + catalog intact (expect 5.1..5.5 and the catalog heading) ---"; grep -nE "^### 5\.[1-5] |^## 4\. Azure2 Icon Library" "$F"
echo "--- frontmatter ---"; python3 - "$F" <<'PY'
import re,sys
t=open(sys.argv[1]).read()
m=re.match(r'^---\n(.*?)\n---\n', t, re.S)
assert m, "frontmatter missing"
body=m.group(1)
try:
    import yaml; d=yaml.safe_load(body); assert d.get('name')=='azure-arch-diagram'; print("frontmatter OK:", d.get('name'))
except ImportError:
    assert 'name: azure-arch-diagram' in body; print("frontmatter OK (no yaml lib)")
PY
echo "--- diff confined to one file ---"; git diff --stat
```

Expected:
- `### 1.11 ` … `### 1.15 ` all present (5 matches).
- §1.5 cross-ref line found.
- Forbidden-terms count is `0`.
- `### 5.1 ` … `### 5.5 ` and `## 4. Azure2 Icon Library` all present (6 matches).
- `frontmatter OK: azure-arch-diagram`.
- `git diff --stat` shows only `ghcp/agents/azure-arch-diagram.agent.md`.

Also eyeball `git diff` and confirm every hunk is within §1.5 (≈line 46) and the §1.10→§2 boundary (≈line 76). If any hunk touches §2–§6 or the §5 templates, revert and redo.

- [ ] **Step 4: Commit**

```bash
git add ghcp/agents/azure-arch-diagram.agent.md
git commit -m "feat(agent): add layout & connection discipline (§1.11–§1.15) and reconcile §1.5"
```

---

### Task 2: §7 Quality Checklist — tighten Layout and add Connections & Flow

**Files:**
- Modify: `ghcp/agents/azure-arch-diagram.agent.md:1196-1201` (extend the "### Layout" checklist subsection)
- Modify: `ghcp/agents/azure-arch-diagram.agent.md:1202-1203` (insert "### Connections & Flow" before "### Accuracy")

**Interfaces:**
- Consumes: subsection anchors §1.11–§1.15 from Task 1 (the checklist items reference them).
- Produces: nothing downstream (final task).

- [ ] **Step 1: Extend the §7 Layout subsection**

Replace this exact block (lines 1196–1201):

```markdown
### Layout
- [ ] Left-to-right or top-to-bottom flow
- [ ] Consistent spacing (100-150px between icons)
- [ ] Logical grouping with labeled containers
- [ ] Not overcrowded (max 15-20 resources per diagram)
- [ ] Title present
```

with:

```markdown
### Layout
- [ ] Tier-based placement: main pipeline in the middle band, control-plane/observability above, storage below (§1.11)
- [ ] Main data-plane flow is left-to-right and visually dominant
- [ ] Spacing prevents label/icon collisions — labeled edges have ≥160px (horizontal) / ≥120px (vertical) between icon centers (§1.14)
- [ ] ≥2 labeled containers for a multi-tier system; ≤6 services per container
- [ ] Not overcrowded (max 15-20 resources per diagram)
- [ ] Title present
```

- [ ] **Step 2: Insert the Connections & Flow subsection**

Immediately after the Layout block from Step 1 and before this existing line (line 1203):

```markdown
### Accuracy
```

insert this exact content (keep one blank line before `### Accuracy`):

```markdown
### Connections & Flow
- [ ] Edge anchors align with flow direction — inputs left/top, outputs right/bottom (§1.13)
- [ ] Telemetry flows emitter → collection store; no Azure Monitor → Log Analytics edge; no every-service fan-in to Log Analytics (§1.12)
- [ ] Identity flow is user → app ingress → Microsoft Entra ID, not user → Entra ID (§1.12)
- [ ] Monitoring uses hub-and-spoke; one representative Key Vault edge (§1.14)
- [ ] Connection labels are verb-first and ≤24 characters (§1.15)
- [ ] Only primary flows drawn; cross-group edges minimized (§1.14)

```

- [ ] **Step 3: Validate**

Run:

```bash
cd "$(git rev-parse --show-toplevel)"
F=ghcp/agents/azure-arch-diagram.agent.md
echo "--- new checklist subsection (expect 1 match) ---"; grep -nE "^### Connections & Flow" "$F"
echo "--- Layout checklist tightened (expect tier-based item) ---"; grep -n "Tier-based placement: main pipeline" "$F"
echo "--- order: Layout, then Connections & Flow, then Accuracy ---"; grep -nE "^### (Layout|Connections & Flow|Accuracy)$" "$F"
echo "--- forbidden terms still 0 ---"; grep -ciE "elk|dagre|layout engine|deterministic layout" "$F"
echo "--- diff confined to one file ---"; git diff --stat
```

Expected:
- `### Connections & Flow` present (1 match).
- Tier-based Layout item present.
- The three headings appear in order: `### Layout`, then `### Connections & Flow`, then `### Accuracy`.
- Forbidden-terms count is `0`.
- `git diff --stat` shows only `ghcp/agents/azure-arch-diagram.agent.md`, and the hunk is around lines ~1196–1209.

- [ ] **Step 4: Commit**

```bash
git add ghcp/agents/azure-arch-diagram.agent.md
git commit -m "feat(agent): tighten layout checklist and add Connections & Flow checks"
```

---

## Acceptance criteria (whole plan)

- New subsections §1.11–§1.15 exist with rules A–E; §1.5 cross-references them and no longer carries contradictory spacing numbers.
- §7 has the tightened Layout items and the new "Connections & Flow" subsection, ordered before "### Accuracy".
- Frontmatter parses; `name: azure-arch-diagram` unchanged; no "ELK"/"dagre"/"layout engine"/"deterministic layout" anywhere in the file.
- Icon catalog (§4), colour palette (§2), mxGraph syntax (§3), and the five templates (§5.1–§5.5) are byte-for-byte unchanged (verify via `git diff` hunk locations).
- Two commits, neither carrying a `Co-authored-by` trailer.
