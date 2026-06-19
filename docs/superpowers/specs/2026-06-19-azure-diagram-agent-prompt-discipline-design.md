# Azure diagram agent — porting prompt discipline from the web app

- **Date:** 2026-06-19
- **Status:** Approved (design); implementation pending
- **Target file:** `ghcp/agents/azure-arch-diagram.agent.md`
- **Reference system:** `azure-architecture-diagram-builder` web app (local checkout), specifically
  `src/services/blueprintArchitectureAI.ts` and `src/services/azureOpenAI.ts`

## 1. Problem statement

The `azure-arch-diagram` agent generates draw.io (mxGraph) XML directly: the LLM places every
element's absolute `x/y/width/height` itself. The agent's prompt is rich on *render fidelity*
(official Azure2 icon catalog, colour palette, mxGraph syntax, five worked templates) but thin on
*layout and semantic discipline* — its entire layout guidance is one short paragraph (§1.5: "left-to-right,
100–150px spacing, max 15–20 resources") plus a brief checklist.

The web app solves the same "describe an Azure architecture" problem but splits the work oppositely.
It offloads render fidelity to code (an icon map and an SVG/ELK renderer) and spends most of its prompt
budget on layout and semantic correctness. Its **Blueprint mode** is the directly comparable artifact:
the LLM emits **absolute coordinates** into a thin renderer with **no layout engine**
(`blueprintArchitectureAI.ts` header comment: "Phase 1: AI emits absolute coordinates so the renderer is
a thin SVG [renderer]… coordinate quality becomes a bottleneck"). To make unguided coordinate emission
reliable, Blueprint's prompt carries detailed placement, spacing, flow-direction, and edge-budget rules.
The topology generator (`azureOpenAI.ts`) adds further semantic rules (hub-and-spoke monitoring, connection
budgets) that hold even though its layout is deterministic.

Those rules are exactly what the agent under-specifies, and porting them is **prompt-only** — it needs no
layout engine.

## 2. The asymmetry (comparison summary)

| Concern | Web app | Agent (today) |
|---|---|---|
| Icons / colours / valid output | code (icon map, renderer) | prompt — strong (catalog, palette, mxGraph, 5 templates) |
| Coordinate emission by LLM | Blueprint mode, thin renderer, **no layout engine** | core mode — every diagram |
| Tier-based placement (what goes where) | detailed policy A–K | absent |
| Telemetry / identity flow direction | explicit, with anti-patterns | absent |
| Connection budget + hub-and-spoke | explicit | absent |
| Edge-label-aware spacing | quantified (tile-scale math) | one generic "100–150px" line |
| Verb-first short labels | explicit | partial ("2–4 words") |
| Grouping minimums | "one zone is incorrect", 3–5 zones | grouping encouraged, no minimum |

## 3. Goals and non-goals

**Goals**
- Raise the agent's layout and semantic-correctness discipline to the level the web app proved necessary
  for unguided coordinate emission.
- Keep changes prompt-only, high-confidence, and traceable to a web-app source.

**Non-goals (explicit constraints)**
- Do **not** introduce a deterministic layout engine (ELK/dagre), a JSON-spec-then-render pipeline, or any
  post-processing/normalization code. The agent keeps emitting mxGraph XML directly.
- Do **not** rewrite the icon catalog, colour palette, mxGraph syntax reference, or the five worked templates.
- Do **not** add render-fidelity machinery the agent already covers well.

## 4. Structural approach

1. Add one new section, **"Layout & Connection Discipline"**, immediately after §1 (Azure Architecture
   Centre Style Rules) and before §2 (Color Palette). Renumber following sections OR insert as §1.11+
   subsections / a new "§2. Layout & Connection Discipline" with downstream sections bumped — final
   numbering decided during implementation to minimise churn.
2. **Reconcile** the existing thin §1.5 Layout paragraph so its spacing numbers defer to (and don't
   contradict) the new section.
3. **Tighten** the §7 Quality Checklist: extend the "Layout" subsection and add a new "Connections & Flow"
   subsection so every new rule is verifiable.

Alternative considered and rejected: scatter the rules inline into §1.5 and §3.3. Rejected because §3.3 is a
mxGraph *syntax* reference; mixing policy into it muddies a reference section and hides the new discipline.

## 5. Rules to port

Each rule below is high-confidence and layout-engine-free. Numbers given for the agent are translated to its
50×50-icon scale (Blueprint's are calibrated for 180×120 tiles); exact values may be tuned during
implementation, but the **principle** in each rule is fixed.

### A. Tier-based placement policy
- Main data-plane pipeline (entry actor → ingress → processing → primary data sinks) occupies the middle
  horizontal band, flows strictly left→right, and is the visually dominant backbone.
- Control-plane / provisioning / secrets (Key Vault, provisioning services, deployment, Entra ID when used
  for control) sit **above** the pipeline; their edges drop down.
- Observability (Azure Monitor, Log Analytics, Application Insights, Microsoft Sentinel, Defender for Cloud)
  sit **above** the pipeline or in a dedicated side container; their edges are dashed.
- Storage / batch analytics / long-term data sit **below**; their edges come up.
- ML / inference / feedback loops sit adjacent to analytics (bottom-right); feedback edges are visually
  distinct.
- End-user dashboards / web apps sit far-left (if they trigger flow) or far-right (if they consume output),
  not in the middle row.
- On-premises sits on the **left**, entering Azure through an explicit boundary node (ExpressRoute, VPN
  Gateway, Private Link).

### B. Flow-direction correctness
- **Telemetry** flows *from* the emitting service *to* the collection store. Allowed shapes: workloads →
  Log Analytics / Application Insights; Application Insights → Log Analytics; workloads → Azure Monitor
  (platform metrics); Log Analytics → Sentinel / Defender. **Forbidden:** Azure Monitor → Log Analytics;
  every-service → Log Analytics fan-in. Alerting is shown as Azure Monitor → action target (Logic Apps /
  Action Group / Webhook), not Log Analytics → Azure Monitor.
- **Identity / OAuth:** the user's first hop is the application entry point (Front Door, Application Gateway,
  API Management, App Service, Container Apps), not Microsoft Entra ID. The app/ingress then calls Entra ID
  ("Authenticate user" / "Validate token" / "Acquire token"). `user → Entra ID` as a first hop is correct
  only when identity itself is the diagram's subject.
- **Anchor convention:** inputs enter a node from its left or top; outputs leave from its right or bottom.
  Choose `(source, target)` and draw.io anchor fragments so the arrow direction matches flow — e.g.
  left→right `exitX=1;exitY=0.5;entryX=0;entryY=0.5;`, top→bottom `exitX=0.5;exitY=1;entryX=0.5;entryY=0;`.
  (The agent currently gives no exit/entry anchor guidance at all.)

### C. Connection budget + hub-and-spoke
- Include only edges that represent primary data or control flow; omit implicit relationships.
- Monitoring is hub-and-spoke: connect the primary compute service to Azure Monitor, then a single
  Azure Monitor ↔ Log Analytics relationship — do not draw an edge from every service to Log Analytics.
- Show one representative Key Vault edge, not one from every consumer.
- Minimise cross-group edges; prefer connecting services in adjacent groups; avoid canvas-spanning edges
  (add an intermediate hop or move the services closer).
- Target edge count proportional to node count (primary flow only), not an edge from every pair.

### D. Edge-label-aware spacing
- Baseline clear gap between any two 50×50 icons: ≥ ~60–80px.
- When a **labeled** edge connects two icons, leave extra clearance so the mid-edge label does not collide:
  horizontally ≥ ~160px centre-to-centre, vertically ≥ ~120px centre-to-centre.
- Container padding ≥ ~30px around child icons (children use parent-relative coordinates).
- Keep the existing ~200px between separate groups. Reconcile §1.5 so its "100–150px" line is expressed as
  the unlabeled baseline and points to this rule for labeled-edge clearance.

### E. Labels and grouping minimums
- Connection labels are verb-first and short (≤ ~24 characters / 2–4 words): "Send telemetry", "Validate
  token", "Persist result" — not noun-only ("Telemetry") or generic ("Data", "Request").
- A multi-tier system needs ≥ 2 logical containers; a single-group diagram for a multi-service system is
  wrong. Keep ≤ ~6 services per group; place tightly-coupled services in the same group.
- Never invent composite service names ("Azure Workloads", "Logic Apps Playbooks"); use official product
  names. Use "Microsoft Entra ID", never "Azure Active Directory" / "AAD".

### F. Checklist tightening (§7)
- Extend "Layout": tier placement respected; main pipeline left→right and visually dominant; spacing
  prevents label/icon collisions; ≥ 2 labeled containers for multi-tier systems.
- Add "Connections & Flow": arrow anchors align with flow direction; telemetry direction correct
  (no Azure Monitor → Log Analytics, no every-service fan-in); identity flow correct (user → ingress →
  Entra ID); hub-and-spoke for monitoring; one representative Key Vault edge; labels verb-first and short.

## 6. Source mapping (traceability)

| Ported rule | Source |
|---|---|
| A. Tier-based placement | `blueprintArchitectureAI.ts` — "LAYOUT POLICY" A–G, F |
| B. Telemetry direction | `blueprintArchitectureAI.ts` — rule C.1 |
| B. Identity / OAuth direction | `blueprintArchitectureAI.ts` — rule K |
| B. Anchor convention | `blueprintArchitectureAI.ts` — rule H |
| C. Hub-and-spoke monitoring | `azureOpenAI.ts` — topology rule 9 |
| C. Connection budget / implicit-edge omission | `azureOpenAI.ts` — topology rules 10–11 |
| C. Adjacent-zone preference / no canvas-spanning edges | `blueprintArchitectureAI.ts` — rule I |
| D. Edge-label-aware spacing | `blueprintArchitectureAI.ts` — layout rules 2–4 |
| E. Verb-first short labels | `blueprintArchitectureAI.ts` — rule J + content rule 10 |
| E. Grouping minimums | `blueprintArchitectureAI.ts` — content rule 10; `azureOpenAI.ts` — topology rule 1 |
| E. Naming guardrails (no composites, Entra not AAD) | `blueprintArchitectureAI.ts` — content rule 9; `azureOpenAI.ts` — topology rule 3 |

## 7. Insertion points in the agent file

- **New section:** after §1.10 (line ~76), before §2 Color Palette (line ~79).
- **Reconcile §1.5 Layout:** lines ~46–51 (spacing line).
- **Checklist §7 Layout subsection:** lines ~1196–1201; **new "Connections & Flow" subsection** inserted
  after it (~line 1201).

## 8. Acceptance criteria

- The new section exists and contains rules A–E; §1.5 no longer contradicts it; §7 contains the tightened
  Layout items and the new Connections & Flow subsection.
- Frontmatter still parses; `name: azure-arch-diagram` unchanged; the agent still instructs direct mxGraph
  XML generation (no layout-engine / JSON-pipeline language introduced).
- Icon catalog, colour palette, mxGraph syntax reference, and the five templates are unchanged.
- Every ported rule is traceable to the source-mapping table.

## 9. Out of scope / future

- Rewriting template coordinates to exemplify the new spacing (deferred — "comprehensive" option not chosen).
- Porting reference-architecture / validator / deployment-guide prompts.
- Any deterministic layout assistance.
