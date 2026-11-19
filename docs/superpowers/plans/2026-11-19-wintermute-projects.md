# Wintermute in Copilot app Projects Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out with a cheap smoke check, and then one paired trial, whether a GitHub Copilot app Project is a good place to run wintermute for repository work that ends in a PR, and give the user a measured go/no-go decision, with a one-PR removal path if the answer is no.

**Architecture:** Phase 1 adds two opt-in prompt skills to the `wintermute` plugin's `skills/` folder, `wintermute-project` for a Project's own coordinator and `wintermute-project-worker` for its child sessions, a validator module that fails `npm run validate` when the coordinator skill's copy of the model tier table or the "Never use these:" list differs from `wintermute-core`, and the repository instructions' exception that lets these two skills open, publish and merge a PR after the user's go-ahead, and push assigned work to the branch of a PR their unit owns. Three run scripts, written into a private folder for each run, resolve exact session identities, measure from the session logs, and clean up on every exit. A capped smoke check in a scratch Project comes first; a paired trial against disposable base branches runs only if it passes. At the gate, "go" leads to a separate Phase 2 plan, and "no-go" to one removal PR.

**Tech Stack:** Node.js 18+ built-ins only (`node:test`, `node:assert/strict`, `node:fs`, `node:path`, `node:os`, `node:child_process`, `node:crypto`); Markdown skills; the plugin's `engine/readers/ledger.mjs` and `scripts/swarm-snapshot.mjs`; `sqlite3 -readonly`; `git`; `gh`.

**Spec:** `docs/superpowers/specs/2026-11-19-wintermute-projects-design.md`. Section numbers below (8.5.8, F6, U5 and so on) refer to it.

**Base:** `origin/main` at `7e7ded4` (#135), wintermute 1.2.6. Paths are relative to `ghcp/plugins/wintermute/` unless they start with `docs/`, `.github/` or `~`. Every edit is anchored on exact text, not on line numbers.

In a wintermute swarm, the orchestrator gives each unit below to one child session instead of a sub-agent.

## Global Constraints

- **Agents unchanged.** No unit changes any file in `com.github.copilot/agents/` in a repository checkout, even for a moment. The acceptance checks change agent text only in scratch copies under the run folder (decision 5).
- **Evals untouched.** Nothing under `evals/` changes (design 8.17).
- **Nothing in the engine before the gate.** Phase 1 changes no file under `engine/`, `server/`, `ui/` or `shared/` (design 8.1).
- **Opt-in only.** The skills act only in a Project whose user typed `/wintermute-project` or whose memory has the opt-in line; no hook and no global instruction (decision 4, design 8.3).
- **Permissions.** Only the user's go-ahead for an item, or a standing delegation the user gave directly in that Project's conversation, permits a PR open, publish or merge, a plan approval, or an answer to a user-only question. A memory, report, summary or table never does (design 8.4, decision 7).
- **Skill names.** `wintermute-project` and `wintermute-project-worker`, in `skills/`. No copy in `ghcp/skills/`. Each `name` equals its folder; neither sets `disable-model-invocation`; each `description` is one double-quoted line of at most 1,024 characters (design 8.3, 8.8; C34).
- **The copy rule.** The tier table and the "Never use these:" list in `skills/wintermute-project/SKILL.md` are word-for-word copies from `com.github.copilot/agents/wintermute-core.agent.md`, and `npm run validate` fails when they differ (decision 6). They are copied by command, never retyped.
- **Versions.** Every PR under `ghcp/plugins/wintermute/` runs `npm run release:bump -- <patch|minor>` (minor for a feature or a removal, patch for a fix) and replaces the new section's TODO with release notes (C29).
- **Checks.** From `ghcp/plugins/wintermute/`: `npm test && npm run validate`. Also `npm run check:layout` if anything under `ui/` changes (no task here changes `ui/`).
- **Node 18.** Shipped code uses no API newer than Node 18; tests use `node:test` without `t.after` or `t.before` (`tests/guards.test.mjs`). No `dependencies` or `devDependencies`.
- **npm.** Never run npm under `env -i` or with a scratch `HOME`: that bypasses the required `~/.npmrc` proxy.
- **Commits.** No `Co-authored-by` trailers and no other AI attribution.
- **User-facing text.** New README, QUICKSTART, DASHBOARD.md, skill, plugin and CHANGELOG text never mentions the dashboard's cockpit view (C33).
- **Runs.** Each smoke check and trial is a run with a unique ID, `wm-smoke-<UTC>` or `wm-trial-<UTC>`, and a private folder `~/wm-runs/<run ID>/`. A run never merges, pushes or opens a PR against `main`. Cleanup deletes only what the run created, under an expected-SHA lease, after the user approved the exact list (design 8.10).
- **Outputs.** Anything that outlives a run goes to the folder that the orchestrator names in the job's kickoff, called `$OUT` below. Only the public findings summary goes into the repository (design 8.12).

## Units

Each unit with a PR is one child session with its own branch and PR, and the gates that `wintermute-core` applies to every unit: its review, its claims check, the final panel for a task's last PR, and the claims check on `main` after the merge. The run units are chains of one-off jobs and user steps with no PR. "Critical" uses the six triggers in "Plan by stage" of `com.github.copilot/agents/wintermute-core.agent.md`.

| Phase | Unit | Scope | Depends on | Critical | Suggested tier | Review and checks |
|---|---|---|---|---|---|---|
| 1 | `projects-skills` | Tasks 1–4: the skill validator, the worker skill, the coordinator skill, README, repository instructions with the PR exception, version and CHANGELOG. One PR. | none | yes: it changes public interfaces (two skills, a child report contract and an instructions rule), and the runs build on it | High: Opus at `xhigh` | A second opinion on the interface (skill names, report and gate contract, opt-in and permission rules) before the PR opens: Astra at `max`. Critical review: Astra at `xhigh`. Claims check: Sol at `medium`. Final panel, as the task's only unit: two judges at the critical levels from the vendors outside Anthropic, Astra at `xhigh` and Carbon at `high`. |
| 1 | `projects-smoke` | Tasks 5–9: plugin update, run preparation, the user's smoke check, collection, measurement and the verdict, the finalizer. No PR. | `projects-skills` merged | no: its verdict is a mechanical output with receipts, which the orchestrator checks (design 8.11) | The run operator: Low, Sol at `medium` | The orchestrator checks the verdict against `measure.json` |
| 1 | `projects-trial` | Tasks 6, 7 and 10–13: run preparation with base branches, the user's paired trial, measurement and findings, the findings check, the gate, the finalizer. No PR. | the smoke check passed and the user agreed to the trial | yes: the gate rests on its findings | The run operator: Low, Sol at `medium`. Task 11: document draft, Opus at `xhigh`. | Task 12: fact-check, Sol at `xhigh` |
| 2b | `projects-remove` | Task 14: remove everything Phase 1 added, revert the instructions exception, and commit the public findings. One PR. Only after a no-go. | the gate | yes: it removes public interfaces | Mid: Opus at `medium`, below the critical default because the change is an exact recipe (design 8.16) | Critical review: Astra at `xhigh`. Claims check: Sol at `medium`. Final panel: Astra at `xhigh` and Carbon at `high`. |
| 2a | `projects-phase2-plan` | Task 15: commit the public findings and write the Phase 2 plan. One PR. Only after a go. | the gate | yes: the Phase 2 units build on it | Document draft: Opus at `xhigh` | Fact-check: Sol at `xhigh`. Regular review of the plan: Astra at `high`. Claims check of its scratch checks: Sol at `medium`. Final panel per `wintermute-core`. |
| 2a | `engine-project-roots` | Design 8.15. Planned in Task 15. | `projects-phase2-plan` | yes: parses outside input | High: Opus at `xhigh` | Critical review: Astra at `xhigh` |
| 2a | `engine-project-results` | Design 8.15. Planned in Task 15. | `projects-phase2-plan` | yes: parses outside input | High: Sol at `max` | Critical review: Opus at `xhigh` |
| 2a | `engine-schedules` | Design 8.15. Planned in Task 15. | `engine-project-roots` | yes: parses outside input | High: Sol at `max` | Critical review: Opus at `xhigh` |
| 2a | `projects-skill-fixes` | Skill changes that the findings list, if any. Planned in Task 15. | `projects-phase2-plan` | yes: the child contract | High: Opus at `xhigh` | Critical review: Astra at `xhigh` |
| 2a | `projects-docs` | Design 8.15. Planned in Task 15. | the engine units and `projects-skill-fixes` | no | Mid: Opus at `medium` | Regular review: Astra at `high` |

Order:

```mermaid
graph LR
  skills[projects-skills] --> smoke[projects-smoke]
  smoke -- pass, and the user agrees --> trial[projects-trial]
  smoke -- fail after the fix round --> remove[projects-remove]
  trial --> gate{gate}
  gate -- no-go --> remove
  gate -- go --> plan2[projects-phase2-plan]
  plan2 --> roots[engine-project-roots]
  plan2 --> results[engine-project-results]
  plan2 --> fixes[projects-skill-fixes]
  roots --> schedules[engine-schedules]
  roots --> docs[projects-docs]
  results --> docs
  schedules --> docs
  fixes --> docs
```

- One fix round in all of Phase 1 (design 8.1): a fit failure caused by the skill text gets one patch PR on the two skills, through the normal gates, and that stage runs again as a new run with a new run ID.
- Only one of `projects-remove` and `projects-phase2-plan` ever runs.

## File structure

| File | Unit | Responsibility |
|---|---|---|
| `scripts/lib/validate-skills.mjs` (create) | `projects-skills` | Checks the two Projects skills, and the coordinator skill's copy of the model policy. |
| `tests/validate-skills.test.mjs` (create) | `projects-skills` | Unit tests for it. |
| `tests/validate-skills-plugin.test.mjs` (create) | `projects-skills` | Proves that `npm run validate` catches drift, on a scratch copy. |
| `scripts/validate-plugin.mjs` (modify: one import, one call) | `projects-skills` | Runs the skill checks in `npm run validate`. |
| `skills/wintermute-project-worker/SKILL.md` (create) | `projects-skills` | The child sessions' rules. |
| `skills/wintermute-project/SKILL.md` (create) | `projects-skills` | The Project coordinator's rules, with the copied tier table and list. |
| `README.md`, `CHANGELOG.md`, `plugin.json`, `package.json`, `.github/plugin/marketplace.json`, `.github/copilot-instructions.md` (modify) | `projects-skills` | Docs, the copy rule, the PR exception and the version. |
| `~/wm-runs/<run ID>/` (outside the repository) | `projects-smoke`, `projects-trial` | `.wm-run-owner`, `run.json`, `wm-collect.mjs`, `wm-measure.mjs`, `wm-finalize.mjs`, `inventory.jsonl`, `ids.json`, `measure.json`, `cleanup-plan.json` and the snapshots. |
| `$OUT/<run ID>-*` | `projects-smoke`, `projects-trial` | The kept evidence, the private findings and the public summary. |
| `docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md` (create) | `projects-remove` or `projects-phase2-plan` | The public findings summary. `<trial date>` is the date of the run it reports, as `YYYY-MM-DD`. |
| `docs/superpowers/plans/<date>-wintermute-projects-phase-2.md` (create) | `projects-phase2-plan` | The Phase 2 plan. `<date>` is the day it is written. |

---

## Phase 1, unit `projects-skills`

Branch from `main`. Commit after each task. After Task 4, push, and hand off with the pushed commit for the second opinion, the critical review and the claims check. The skills are prompts: their checks are the validator (Tasks 1 and 3) and the runs. Each `SKILL.md` follows the repository's skill rules: `name` and `description` frontmatter, an "Operating mode" section, an "Output format" section, and the rules against invented results.

### Task 1: The skill validator

**Files:**
- Create: `scripts/lib/validate-skills.mjs`
- Test: `tests/validate-skills.test.mjs`

**Interfaces:**
- Consumes: `AGENTS_DIR` and `parseAgentFrontmatter(text): { errors: string[], fields: object }` from `scripts/lib/validate-package.mjs` (existing).
- Produces: `SKILLS_DIR = 'skills'`, `COORDINATOR_SKILL = 'wintermute-project'`, `WORKER_SKILL = 'wintermute-project-worker'`, `PROJECT_SKILLS`, `POLICY_AGENT = 'com.github.copilot/agents/wintermute-core.agent.md'`, `POLICY_SECTION = 'Models and effort'`; `headingsOf(text): string[]`; `sectionOf(text, name): string | null`; `tierTable(section): { table: string | null, error: string | null }`; `neverUseList(section): { list: string | null, error: string | null }`; `policyBlocks(text): { table: string | null, neverUse: string | null, errors: string[] }`; `quotedNames(text): string[]`; `validateSkills(root, repositoryRoot): Promise<string[]>`. Task 3 wires `validateSkills` into `scripts/validate-plugin.mjs` and uses `policyBlocks` to copy the blocks.

- [ ] **Step 1: Write the failing tests**

Create `tests/validate-skills.test.mjs`:

````js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COORDINATOR_SKILL, POLICY_AGENT, PROJECT_SKILLS, SKILLS_DIR, WORKER_SKILL,
  headingsOf, neverUseList, policyBlocks, sectionOf, tierTable, validateSkills,
} from '../scripts/lib/validate-skills.mjs';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreText = readFileSync(path.join(pluginRoot, POLICY_AGENT), 'utf8');
const LAST_ITEM = '- A reviewer or fact-checker from the author\'s vendor, unless the user has limited the work to one vendor (see "Evidence and review"). Judges follow the vendor rules of the final panel and the disagreement panel instead.';

/** A fixture SKILL.md; `front` overrides frontmatter fields and `body` replaces the text after the title. */
function skillText(name, { front = {}, body } = {}) {
  const fields = { name, description: `"Fixture ${name} skill."`, ...front };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n# Fixture\n\n${body ?? ''}`;
}

/** A coordinator body with the real policy copy and the sections and labels it refers to. */
function coordinatorBody({ table, neverUse, labels = ['Follow-up jobs', 'Security review'] } = {}) {
  const blocks = policyBlocks(coreText);
  const labelLines = labels.map(label => `- **${label}**: fixture.`).join('\n');
  return `## Models and effort\n\n${table ?? blocks.table}\n\n- Fixture rule.\n\n${neverUse ?? blocks.neverUse}\n\n## Evidence and review\n\n${labelLines}\n`;
}

/** A scratch repository with the plugin's policy agent and fixture skills; `skills` maps a skill name to its text, or null to leave it out. */
function sandbox(skills = {}) {
  const repo = tempDir('swarm-skills-');
  const root = path.join(repo, 'ghcp/plugins/wintermute');
  mkdirSync(path.join(root, path.dirname(POLICY_AGENT)), { recursive: true });
  writeFileSync(path.join(root, POLICY_AGENT), coreText);
  const texts = { [COORDINATOR_SKILL]: skillText(COORDINATOR_SKILL, { body: coordinatorBody() }), [WORKER_SKILL]: skillText(WORKER_SKILL), ...skills };
  for (const name of PROJECT_SKILLS) {
    if (texts[name] === null) continue;
    mkdirSync(path.join(root, SKILLS_DIR, name), { recursive: true });
    writeFileSync(path.join(root, SKILLS_DIR, name, 'SKILL.md'), texts[name]);
  }
  return { repo, root };
}

async function errorsFor(skills, change) {
  const { repo, root } = sandbox(skills);
  if (change) change(repo, root);
  return validateSkills(root, repo);
}

const editCore = edit => (repo, root) => writeFileSync(path.join(root, POLICY_AGENT), edit(coreText));

function assertReported(errors, expected) {
  assert.ok(errors.some(error => error.includes(expected)), `${expected} in\n${errors.join('\n')}`);
}

test('headingsOf and sectionOf read level-two headings outside code fences', () => {
  const text = ['# Title', '## One', 'a', '```', '## Not a heading', '```', '### Three', 'b', '## Two', 'c'].join('\n');
  assert.deepEqual(headingsOf(text), ['One', 'Two']);
  assert.equal(sectionOf(text, 'One'), ['a', '```', '## Not a heading', '```', '### Three', 'b'].join('\n'));
  assert.equal(sectionOf(text, 'Two'), 'c');
  assert.equal(sectionOf(text, 'Missing'), null);
});

test('tierTable takes the one real table outside code fences and rejects anything ambiguous', () => {
  const table = '| A | B |\n|---|---|\n| 1 | 2 |';
  assert.deepEqual(tierTable(`Intro.\n\n${table}\n\nText.`), { table, error: null });
  assert.match(tierTable('```\n| A |\n|---|\n| 1 |\n```').error, /has no table/);
  assert.match(tierTable('| not | a table |\n| just | pipes |').error, /not a table/);
  assert.match(tierTable(`${table}\n\n${table}`).error, /has 2 tables/);
  assert.match(tierTable('| A | B |\n|---|---|\n| 1 | 2 | 3 |').error, /different numbers of columns/);
});

test('neverUseList runs to the end of the section, keeps wrapped and loose items, and rejects other text', () => {
  const list = 'Never use these:\n\n- One.\n- Two,\n  wrapped.\n\n- Three, after a blank line.';
  assert.deepEqual(neverUseList(`Intro.\n\n${list}\n\n`), { list, error: null });
  assert.match(neverUseList(`${list}\n\nA closing paragraph.`).error, /not a list item/);
  assert.match(neverUseList('Never use these:\n\n').error, /no list items/);
  assert.match(neverUseList(`${list}\n\n${list}`).error, /more than one/);
  assert.match(neverUseList('No list here.').error, /has no "Never use these:" line/);
});

test('skills with an exact copy of the model policy pass', async () => {
  assert.deepEqual(await errorsFor(), []);
});

test('a change to the tier table or the list in wintermute-core is reported as drift', async () => {
  const edits = [
    [text => text.replace('| Low |', '| Lowest |'), 'the tier table differs from'],
    [text => text.replace('Never use these:\n\n- ', 'Never use these:\n\n- Haiku at `max`.\n- '), 'the "Never use these:" list differs from'],
    [text => text.replace(LAST_ITEM, `${LAST_ITEM}\n\n- Haiku at \`max\`: added only in wintermute-core, after a blank line.`), 'the "Never use these:" list differs from'],
  ];
  for (const [edit, expected] of edits) assertReported(await errorsFor({}, editCore(edit)), expected);
});

test('text after the list in wintermute-core is reported instead of being left out of the copy', async () => {
  const errors = await errorsFor({}, editCore(text => text.replace(LAST_ITEM, `${LAST_ITEM}\n\nA closing paragraph.`)));
  assertReported(errors, `${POLICY_AGENT}: "## Models and effort" has text after "Never use these:"`);
});

test('a skill without its copy of the table or the list is reported', async () => {
  const noTable = skillText(COORDINATOR_SKILL, { body: coordinatorBody({ table: 'The tiers are in wintermute-core.' }) });
  assertReported(await errorsFor({ [COORDINATOR_SKILL]: noTable }), `${SKILLS_DIR}/${COORDINATOR_SKILL}/SKILL.md: "## Models and effort" has no table`);
  const noList = skillText(COORDINATOR_SKILL, { body: coordinatorBody({ neverUse: 'Avoid weak models.' }) });
  assertReported(await errorsFor({ [COORDINATOR_SKILL]: noList }), `${SKILLS_DIR}/${COORDINATOR_SKILL}/SKILL.md: "## Models and effort" has no "Never use these:" line`);
});

test('a name the copied policy refers to must be a heading or a bold label in the skill', async () => {
  const text = skillText(COORDINATOR_SKILL, { body: coordinatorBody({ labels: ['Follow-up jobs'] }) });
  assertReported(await errorsFor({ [COORDINATOR_SKILL]: text }), 'refers to "Security review"');
});

test('each broken packaging rule is reported', async () => {
  const cases = [
    [{ [WORKER_SKILL]: null }, `${SKILLS_DIR}/${WORKER_SKILL}/SKILL.md: required skill is missing`],
    [{ [WORKER_SKILL]: skillText(WORKER_SKILL, { front: { name: 'other-name' } }) }, 'must match the folder name'],
    [{ [WORKER_SKILL]: skillText(WORKER_SKILL, { front: { 'disable-model-invocation': 'true' } }) }, 'must not set disable-model-invocation'],
    [{ [WORKER_SKILL]: skillText(WORKER_SKILL, { front: { description: `"${'x'.repeat(1025)}"` } }) }, 'description must be at most 1024 characters'],
  ];
  for (const [skills, expected] of cases) assertReported(await errorsFor(skills), expected);
  const copied = await errorsFor({}, repo => mkdirSync(path.join(repo, 'ghcp/skills', WORKER_SKILL), { recursive: true }));
  assertReported(copied, `ghcp/skills/${WORKER_SKILL}: the plugin ships this skill`);
});
````

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/validate-skills.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`, "Cannot find module …/scripts/lib/validate-skills.mjs".

- [ ] **Step 3: Write the validator**

Create `scripts/lib/validate-skills.mjs`:

````js
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTS_DIR, parseAgentFrontmatter } from './validate-package.mjs';

export const SKILLS_DIR = 'skills';
export const COORDINATOR_SKILL = 'wintermute-project';
export const WORKER_SKILL = 'wintermute-project-worker';
export const PROJECT_SKILLS = Object.freeze([COORDINATOR_SKILL, WORKER_SKILL]);
/** The agent whose tier table and "Never use these:" list the coordinator skill copies word for word. */
export const POLICY_AGENT = `${AGENTS_DIR}/wintermute-core.agent.md`;
export const POLICY_SECTION = 'Models and effort';
const NEVER_USE = 'Never use these:';
const FENCE = /^\s*```/;
const HEADING = /^## (.+?)\s*$/;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** The `## ` headings of a Markdown text, outside code fences, in order. */
export function headingsOf(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    const match = fenced ? null : HEADING.exec(line);
    if (match) out.push(match[1]);
  }
  return out;
}

/** The body of the `## <name>` section, up to the next `## ` heading outside a code fence; null when there is none. */
export function sectionOf(text, name) {
  const lines = text.split(/\r?\n/);
  let fenced = false;
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (FENCE.test(lines[index])) {
      fenced = !fenced;
      continue;
    }
    const match = fenced ? null : HEADING.exec(lines[index]);
    if (!match) continue;
    if (start >= 0) return lines.slice(start, index).join('\n');
    if (match[1] === name) start = index + 1;
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}

const columns = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length;

/** The one Markdown table in a section, outside code fences: { table, error }. */
export function tierTable(section) {
  const runs = [];
  let fenced = false;
  let current = null;
  for (const line of section.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      current = null;
    } else if (!fenced && line.startsWith('|')) {
      if (!current) runs.push(current = []);
      current.push(line);
    } else {
      current = null;
    }
  }
  if (runs.length === 0) return { table: null, error: 'has no table' };
  if (runs.length > 1) return { table: null, error: `has ${runs.length} tables; the copy rule needs exactly one` };
  const [rows] = runs;
  if (rows.length < 3 || !SEPARATOR.test(rows[1])) return { table: null, error: 'has lines that start with "|" but are not a table with a header row, a separator row and body rows' };
  if (rows.some(row => columns(row) !== columns(rows[0]))) return { table: null, error: 'has a table whose rows have different numbers of columns' };
  return { table: rows.join('\n'), error: null };
}

/** The "Never use these:" line and everything after it to the end of the section, which must be list items: { list, error }. */
export function neverUseList(section) {
  const lines = section.split(/\r?\n/);
  const start = lines.indexOf(NEVER_USE);
  if (start < 0) return { list: null, error: `has no "${NEVER_USE}" line` };
  if (lines.indexOf(NEVER_USE, start + 1) >= 0) return { list: null, error: `has more than one "${NEVER_USE}" line` };
  let end = lines.length;
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  let items = 0;
  for (const line of lines.slice(start + 1, end)) {
    if (line.trim() === '') continue;
    if (line.startsWith('- ')) {
      items += 1;
    } else if (!(items > 0 && /^\s+\S/.test(line))) {
      return { list: null, error: `has text after "${NEVER_USE}" that is not a list item, so the list's end is unclear: ${JSON.stringify(line.slice(0, 60))}` };
    }
  }
  if (items === 0) return { list: null, error: `has no list items under "${NEVER_USE}"` };
  return { list: lines.slice(start, end).join('\n'), error: null };
}

/** The tier table and the "Never use these:" list of a file's "## Models and effort" section, with any reason they can't be read. */
export function policyBlocks(text) {
  const section = sectionOf(text, POLICY_SECTION);
  if (section === null) return { table: null, neverUse: null, errors: [`has no "## ${POLICY_SECTION}" section`] };
  const table = tierTable(section);
  const list = neverUseList(section);
  return {
    table: table.table,
    neverUse: list.list,
    errors: [table.error, list.error].filter(Boolean).map(error => `"## ${POLICY_SECTION}" ${error}`),
  };
}

/** The capitalised quoted names in a text, such as "Evidence and review": the sections and labels it refers to. */
export function quotedNames(text) {
  return [...new Set([...text.matchAll(/"([A-Z][^"\n]*)"/g)].map(match => match[1]))];
}

const boldLabels = text => [...text.matchAll(/\*\*([^*\n]+)\*\*/g)].map(match => match[1]);

function firstDifferentLine(expected, actual) {
  const left = expected.split('\n');
  const right = actual.split('\n');
  const index = left.findIndex((line, i) => line !== right[i]);
  return (index < 0 ? left.length : index) + 1;
}

/** The Projects skills: present and well formed, with the coordinator's copy of the model policy identical to wintermute-core's. */
export async function validateSkills(root, repositoryRoot) {
  const errors = [];
  let coordinator;
  for (const name of PROJECT_SKILLS) {
    const file = `${SKILLS_DIR}/${name}/SKILL.md`;
    let text;
    try {
      text = await readFile(path.join(root, file), 'utf8');
    } catch (error) {
      errors.push(error.code === 'ENOENT' ? `${file}: required skill is missing` : `${file}: ${error.message}`);
      continue;
    }
    if (name === COORDINATOR_SKILL) coordinator = text;
    const parsed = parseAgentFrontmatter(text);
    for (const error of parsed.errors) errors.push(`${file}: ${error}`);
    if (typeof parsed.fields.name === 'string' && parsed.fields.name !== name) errors.push(`${file}: frontmatter name ${parsed.fields.name} must match the folder name ${name}`);
    if (typeof parsed.fields.description === 'string' && parsed.fields.description.length > 1024) errors.push(`${file}: description must be at most 1024 characters`);
    if (Object.hasOwn(parsed.fields, 'disable-model-invocation')) errors.push(`${file}: must not set disable-model-invocation, because the model loads this skill`);
    try {
      await access(path.join(repositoryRoot, 'ghcp/skills', name));
      errors.push(`ghcp/skills/${name}: the plugin ships this skill, so no copy may stay in ghcp/skills/`);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`ghcp/skills/${name}: ${error.message}`);
    }
  }
  if (coordinator !== undefined) errors.push(...await validatePolicyCopy(root, coordinator));
  return errors;
}

async function validatePolicyCopy(root, skillText) {
  const skillFile = `${SKILLS_DIR}/${COORDINATOR_SKILL}/SKILL.md`;
  let agentText;
  try {
    agentText = await readFile(path.join(root, POLICY_AGENT), 'utf8');
  } catch (error) {
    return [`${POLICY_AGENT}: ${error.message}`];
  }
  const source = policyBlocks(agentText);
  const copy = policyBlocks(skillText);
  const errors = [...source.errors.map(error => `${POLICY_AGENT}: ${error}`), ...copy.errors.map(error => `${skillFile}: ${error}`)];
  for (const [key, label] of [['table', 'tier table'], ['neverUse', '"Never use these:" list']]) {
    if (source[key] !== null && copy[key] !== null && copy[key] !== source[key]) {
      errors.push(`${skillFile}: the ${label} differs from ${POLICY_AGENT} at its line ${firstDifferentLine(source[key], copy[key])}; copy it again word for word`);
    }
  }
  const known = new Set([...headingsOf(skillText), ...boldLabels(skillText)]);
  for (const block of [copy.table, copy.neverUse]) {
    if (block === null) continue;
    for (const name of quotedNames(block)) {
      if (!known.has(name)) errors.push(`${skillFile}: the copied model policy refers to "${name}", which is not a "## " heading or a bold label in the skill`);
    }
  }
  return errors;
}
````

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test tests/validate-skills.test.mjs && npm test`
Expected: the 9 new tests pass, then the whole suite passes with 9 more tests than before this task. `npm run validate` doesn't run the new checks yet: Task 3 wires them in.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/validate-skills.mjs tests/validate-skills.test.mjs
git commit -m "feat(wintermute): validate the Projects skills and their copy of the model policy"
```

### Task 2: The worker skill

**Files:**
- Create: `skills/wintermute-project-worker/SKILL.md`

**Interfaces:**
- Consumes: `validateSkills` (Task 1).
- Produces: the child-side contract that the coordinator skill (Task 3) relies on: the scope check on `<copilot_project_child_session>` plus the coordinator's instruction; permissions only from assignments; separate assignments for a draft, a publish and a merge; two-line handoffs with "Partial:"; `blocked` with `purpose: "error"`; `assignment_id` on every report; result files with commit, commands, exit codes and counts; publishing at review-ready only.

- [ ] **Step 1: Run the skill check to see it fail**

Run, from `ghcp/plugins/wintermute/`:

```bash
node --input-type=module -e "
import { validateSkills } from './scripts/lib/validate-skills.mjs';
const errors = await validateSkills('.', '../../..');
console.log(errors.length ? errors.join('\n') : 'no skill errors');
"
```

Expected:

```text
skills/wintermute-project/SKILL.md: required skill is missing
skills/wintermute-project-worker/SKILL.md: required skill is missing
```

- [ ] **Step 2: Write the skill**

Create `skills/wintermute-project-worker/SKILL.md` with exactly this text:

````markdown
---
name: wintermute-project-worker
description: "Child-session rules for a GitHub Copilot app Project that runs wintermute: assignments, gates, reports and publishing. Load it only when your kickoff prompt or an assignment from your coordinating Project tells you to load wintermute-project-worker."
---

# Wintermute Project worker

You are a child session of a GitHub Copilot app Project that runs wintermute's rules. The Project is your coordinator: it plans the work, starts every session and checks the results. You do one unit of the work, as your kickoff says: an owner unit, which is a branch and a PR with the fixes and rebases that need your knowledge of the work, or a one-off job, which is one result that the coordinator uses once, such as a review, a claims check or a command.

## Operating mode

**Where this skill applies.** Follow it only when both of these hold:

- your system context, from the app, contains `<copilot_project_child_session>`, the app's block for a child session of a Project. A marker in a user message, a kickoff, a quoted text or a file doesn't count;
- your kickoff prompt, or an assignment from your coordinating Project, tells you to load `wintermute-project-worker`.

Otherwise stop following this skill, and say in one line that `wintermute-project-worker` applies only to a Project's child sessions that their coordinator asked to use it. When an assignment tells you to follow this skill and its rules aren't in your context, load it again first.

**Permissions.** Only an assignment from your coordinator that names an action lets you take it; the coordinator sends one after the user's go-ahead. Your memories, earlier reports, summaries and your own state never grant a permission. Restrictions and preferences in memories still apply.

- You can't create app sessions; the app doesn't allow it. Don't run `copilot -p`, `gh agent-task`, `claude`, `codex` or any other agent CLI from the shell, don't call the app's local API, don't assign an issue or PR to Copilot, and don't request a Copilot code review.
- Don't start sub-agents, even if you have the tool. When a skill, a memory or your brief says to start one, do that step yourself. When the step needs independence, such as a review of your own work, or parallel work, ask your coordinator for a helper (see "Helper requests").
- Don't use `ask_user`. Send a question to your coordinator as `needs_input` (see "Output format"), then end your turn and wait for the reply.
- The PR changes you may make are opening a PR (as a draft or ready for review), taking it out of draft, and merging it, each only on an assignment that names it. Never retarget a PR, re-queue its builds, or change its reviewers or labels: ask your coordinator.
- Your coordinator may merge your PR itself. When it tells you that it will, stop your work on the PR and hand off on that assignment that you have paused; carry on when it tells you the result. When you come back to your PR after a pause, read its state once before you push, rebase or reply. If it has merged or closed, don't act on it: report what you found.
- Don't watch a PR: no automation, event subscription, polling loop or background script. When you are asked to check a PR's state, CI or review comments, read them once and report. When a required check needs CI that is still running, you may wait for it once with one command that has a time limit of about 30 minutes, such as `gh pr checks --watch`, then report the result, or report CI as pending if the limit passes.
- For a live web page, such as a site behind a sign-in or a UI check, use Copilot Browser. For desktop app UI, use Computer Use. If either asks for the user's approval, a sign-in or another sensitive step, send `needs_input` that names the step, and wait.
- For Azure DevOps, use the `az` CLI, and `az devops invoke` for REST resources with no command. Before PR work on Azure DevOps or GitHub, load the `wintermute-pr-commands` skill once, and read only the provider reference you need.
- After two failed attempts at the same problem, stop and report `blocked` with your diagnosis.
- A review and a claims check are separate jobs. If you are a reviewer and a message also asks you to confirm the author's claims for a merge, publish or "done", do the review only, and say in your handoff that the claims job needs a separate claims checker. You may still run tests or reproduce a failure when your review needs that to settle a finding.
- A one-off job stays inside its brief. Work only in the repository, branch or folder it names. Don't commit or push. Write files only where the brief says. When the brief says the job is read-only, change no files, branches or anything remote. A one-off job on a PR changes only the PR, through the PR service, and only at the commit the brief names.
- Keep commands, test output, file lists and other detail in your own thread or in your result file. Your reports state outcomes.
- Never invent results, sources, line numbers or command output, and never say that you ran a command or read a file when you didn't. Mark anything you didn't check yourself as unverified.
- At the start, if you have `rename_session`, rename your session so that it starts with your unit label, for example `api: Orders endpoint`. Keep your todos current: the Project's Overview shows them.

## Assignments and gates

Each message from your coordinator that gives you new work, a revision, a rerun or a go-ahead is a new assignment, with its own `assignment_id`. Finish it, hand it off, and wait for the next one.

As the owner of a unit:

1. Implement, test and push to your unit's branch. Hand off with `commit=`. Open no PR in this step.
2. If an assignment authorizes a draft PR for CI, open it as a draft against the target branch your kickoff names, and hand off with `pr=`.
3. For each fix that a review or a claims check asks for: fix, test, push, and hand off with the new `commit=`.
4. On an assignment that authorizes publishing: open the PR ready for review against the target branch, or take your draft out of draft. Publish it (see "Publishing"), and hand off with `pr=`.
5. Merge only on an assignment that tells you to, at the commit it names.

When your work is done and only waits for its review and claims check, which your coordinator starts, hand off. Don't ask for them with `needs_input`, and never ask for a go-ahead with `needs_input`: hand off and wait for the next assignment.

A claims check or a test run that your brief asks for writes a result file in the folder your kickoff names, with the commit (`git rev-parse HEAD`), each command exactly as you ran it, its exit code, and the test counts.

## Output format

Every message to your coordinator is a report, sent with `send_session_message`. Its first line is the status line, with nothing before it:

```text
swarm-status: <status> unit=<unit> pr=<provider>:<id> commit=<sha>
```

- `<status>` is `complete`, `progress`, `needs_input` or `blocked`.
- `unit=` is your unit label from the kickoff, exactly as given.
- `pr=` appears once your unit has a PR, draft or published. `<provider>` is `github` or `ado`, and `<id>` is the GitHub PR number or the Azure DevOps pull request id.
- `commit=` appears when the report is about pushed code: the commit SHA in lowercase hex, 7–40 characters.
- The fields come in this order, separated by single spaces, with no other text and no Markdown on the line.

Set `purpose` from the status: `complete` → `handoff`, `progress` → `progress`, `needs_input` → `needs_input`, and `blocked` → `error`. Set `assignment_id` to the id of the work the report is about, from your kickoff context or from the envelope of the message that gave you the work.

**Handoff.** A handoff reports an assignment's result. It has two lines: the status line, and `Summary:` with one outcome sentence. The sentence may carry one essential link or next action.

```text
swarm-status: complete unit=api pr=github:42 commit=3f9a2c1
Summary: The endpoint and its tests are pushed, and the PR is open for review.
```

- Write no `Evidence:` or `Blockers:` field, and no test counts, commands or file lists.
- When your result is longer than one sentence, such as review findings, research or a claims check's results, write it to a file in the folder your kickoff names, and link it in the sentence as a Markdown link with a short name and the file's full path.
- In a one-off job, also say in the sentence whether your worktree is clean, from `git status --porcelain --untracked-files=all`, for example "…; worktree clean".
- A handoff doesn't close the assignment. If you must report part of a result early, start the sentence with "Partial:", and send the final handoff later with the same `assignment_id`. If your result changes in a material way after a handoff, send another handoff with the same `assignment_id`.

**Question, helper request or blocker.** A question, or a request for a helper, is `needs_input`. A material blocker, including two failed attempts at the same problem or a publish that failed, is `blocked`, sent with `purpose: "error"`. Both have three fields:

```text
swarm-status: needs_input unit=api commit=3f9a2c1
Summary: <what happened, in one or two sentences>
Evidence:
- <what supports it: the commands or checks you ran, and their results>
Blockers:
- <the decision, answer or change you need>
```

Then call `task_complete` if you have it, and wait for the reply.

**Progress.** A `progress` report stays in your own thread; your coordinator never receives it. Send one only as an optional note.

## Helper requests

When you need another agent, send `needs_input` with the request under `Blockers:`:

- the job, and why you need it;
- the inputs: the repository, branch and pushed commit, or absolute paths for a one-off job;
- what to send back;
- whether you can carry on with other work meanwhile.

Then call `task_complete` if you have it, and wait. Your coordinator tells you whether to wait or carry on, and passes you the result.

## Publishing

The app asks you to publish review-ready output in your own thread before you report it. In this Project, review-ready means:

- A PR is review-ready when an assignment authorizes you to publish it, after its review and claims check are clean. Open it ready for review, or take it out of draft, publish it with `publish_chat_update` (attachment `kind: "pr"`), then hand off. A draft PR that you opened for CI is not review-ready: don't publish it.
- A document, or any other file, preview or issue, is review-ready when your coordinator says so in an assignment. Publish it then, with a short human name, and hand off.

Publish each material revision once. If `publish_chat_update` fails, report it as `blocked`. If you don't have the tool, hand off the verified output, linked by its full path, so that your coordinator can publish it. Publish nothing before it is review-ready. Publishing is not approval, and it grants no go-ahead.
````

- [ ] **Step 3: Run the skill check again**

Run the command from Step 1.
Expected: only `skills/wintermute-project/SKILL.md: required skill is missing`.

- [ ] **Step 4: Commit**

```bash
git add skills/wintermute-project-worker/SKILL.md
git commit -m "feat(wintermute): add the wintermute-project-worker skill"
```

### Task 3: The coordinator skill, and the validator wired in

**Files:**
- Create: `skills/wintermute-project/SKILL.md`
- Create: `tests/validate-skills-plugin.test.mjs`
- Modify: `scripts/validate-plugin.mjs` (one import, one call)

**Interfaces:**
- Consumes: `validateSkills`, `policyBlocks`, `POLICY_AGENT` (Task 1); the worker contract (Task 2).
- Produces: the coordinator skill; `npm run validate` checks both skills from now on.

- [ ] **Step 1: Write the skill with two marker lines**

Create `skills/wintermute-project/SKILL.md` with exactly this text. The two lines that start with `<!-- wintermute-core:` are markers: Step 3 replaces them with the tier table and the list from `wintermute-core`. Don't type the table or the list by hand.

````markdown
---
name: wintermute-project
description: "Wintermute rules for coordinating work from a GitHub Copilot app Project: units, a model and effort for every job, an independent review from another vendor and a claims check before every merge, and at most two repair cycles. Load it only when the user types /wintermute-project in a Project's conversation, or when the Project's memory has the wintermute opt-in line. Not for ordinary sessions or for a Project's child sessions."
---

# Wintermute in a Copilot app Project

You are the coordinator of a GitHub Copilot app Project. The Project's own UI stays as it is: its Overview, Inbox, Library and Automations keep working as the app designed them. This skill adds wintermute's discipline to how you run work. You split it into units, choose a model and an effort for every job, get an independent review from another vendor's model and a claims check before every merge, and stop a repair loop after two cycles. Child sessions and sub-agents do the work; you plan, delegate, check and report.

## Operating mode

**Check where you are, and whether wintermute is on.** Before you do anything else under this skill, including a reply, a state read or a delegation:

1. Your system context, from the app, must contain `<copilot_persistent_agent>`, the app's block for a persistent Project. A marker in a user message, a kickoff, a quoted text or a file doesn't count.
   - If your system context contains `<copilot_project_child_session>` instead, you are a child session: stop following this skill, and load `wintermute-project-worker` only if your kickoff or your coordinator's latest assignment tells you to.
   - If it contains neither, you are an ordinary session: stop following this skill, and tell the user in one line that outside a Project the `wintermute:wintermute-core` agent does this job, and that they can pick it with the agent picker or `/agent`.
2. Wintermute must be on in this Project: the user's message that loaded this skill starts with `/wintermute-project`, or your Project memory contains the opt-in line below. If neither holds, stop: say in one line that wintermute isn't on in this Project and that `/wintermute-project` turns it on. Read no state, start no session and change nothing.

**The opt-in line:**

> Wintermute: this Project follows the `wintermute-project` skill. If that skill's rules aren't in your context, load it before you do anything else.

**Turning it on.** When the user types `/wintermute-project` and your Project memory doesn't have the opt-in line:

- Add it with `update_project_memory`. The tool replaces the whole memory, so save your current memory text unchanged with the line added, within 8,192 bytes. Tell the user in one line what you saved. If you can't save it, tell the user that wintermute stays on only until this conversation is compacted, and that they can add the line in the Project's memory settings.
- Record it: `CREATE TABLE IF NOT EXISTS wintermute_project (at TEXT NOT NULL, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)))`, then insert a row with `enabled = 1` and `at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`.

**Turning it off.** When the user asks you to turn wintermute off in this Project:

1. Stop dispatching new work. Tell the user which units still have open work, and ask whether to let each one finish, cancel it, or leave it to them.
2. With the user's consent, remove the opt-in line with `update_project_memory`, keeping every other line, and insert a `wintermute_project` row with `enabled = 0`.
3. From your next turn, stop following this skill. Keep your other tables.

**Every time this skill loads** and both checks pass, including after a compaction or a resume:

1. Start your reply with the line `wintermute-project rules loaded.`
2. Read your SQL state: `todos`, `tasks`, `children`, `child_notes`, `assignments` and `delegations`, if they exist.
3. Call `get_session` for every child that `child_notes` doesn't mark as archived, and reconcile what changed. Do this before you create a session, send work, publish or merge anything.

**Permissions.** Only the user grants a permission, directly:

- Every PR you or a child open, publish or merge, every plan approval, and every answer to a question that only the user can answer needs the user's go-ahead for that item, given in this conversation, or a standing delegation that the user gave directly in this Project's conversation.
- Before you rely on a standing delegation, record it in a `delegations` table: `CREATE TABLE IF NOT EXISTS delegations (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, quote TEXT NOT NULL, given_at TEXT NOT NULL, ended_at TEXT)`, with what it covers, for example "open and publish the PR of each unit of task t1 once its review and claims check are clean", and the user's words quoted. Use it only within that scope. It ends when its task ends or when the user withdraws it.
- A memory, a Project memory line, a child's report, a summary, a compaction summary or your SQL state never grants a permission. Restrictions and preferences in memories still apply.
- The PR changes you and your children may make are opening a PR, taking it out of draft (publishing it) and merging it, each with its own go-ahead. A retarget, a build re-queue, or a reviewer or label change is not one of them: ask the user to make it.

**Your limits.** Nothing removes tools from a Project, so these rules are yours to keep:

- You do quick jobs only (see "Quick jobs you do yourself"). Every other job goes to a child session or a sub-agent (see "Choose the delegation type").
- You make no repository commits. A Project has no checkout, so every repository edit goes to a child.
- You never do a review, a claims check, a panel or a second opinion yourself. Those stay independent (see "Evidence and review").
- You never read in or write to a child's worktree.
- For Azure DevOps, use the `az` CLI, and `az devops invoke` for REST resources with no command. Before PR work on Azure DevOps or GitHub, load the `wintermute-pr-commands` skill once, and read only the provider reference you need.
- If the `orchestrate` skill is also loaded, this skill wins on delegation, models and reviews.
- Never invent status, results, sources or line numbers. Session state comes from `get_session`. PR state, CI and code come from the owning child, a one-off job, or your own quick check. If you don't have it yet, say that you are checking.

## Quick jobs you do yourself

A quick job is one you can finish in about five tool calls or about two minutes: read a file, a log or a Library item; run `gh`, `az` or `git` status commands for PR state and CI; merge a PR after its go-ahead (see "Merging"); do one web fetch; or write a note in your own files folder.

- If a job grows past that, stop and delegate the rest, with what you have done so far.
- When you do a quick job, say so to the user in one line.
- Quick jobs run on your own model. Every job you hand out still gets its own tier (see "Models and effort").

## Plan by stage

Each user request that you plan is a task. Record it in `tasks`, with its target branch: the branch its PRs merge into, `main` unless the user names another. Give each of its units that task in `child_notes`.

Show the user the breakdown before you start substantial work. When the user asks to approve the plan, wait for their approval of that plan before you dispatch anything. Ask for this and every other decision in a way the user can read: with `ask_user`, or, when the user's memories or the Project's memory say that they read questions in chat, as a chat message that starts with the same tag and ends your turn (see "Talking to the user").

- **Research or specification**: split it into independent questions and run them in parallel as one-off jobs. Combine the findings yourself.
- **Implementation**: one owner child per PR-sized unit. Stack a unit that builds on another with `base_branch`, as soon as the parent has pushed its branch.
- **Critical units**: mark a unit critical if it does any of these:
  - parses or validates outside input;
  - touches security, authentication or secrets;
  - handles money, rounding, dates or time zones;
  - handles concurrency, ordering or retries;
  - changes schemas, migrations or public interfaces;
  - is a unit that other units build on.

  Record a one-line reason in `child_notes`. A critical unit runs at the High tier by default and gets a critical review instead of the regular one. Raise a unit to critical later if its child reports unexpected complexity or a review flags it; a unit raised after its regular review also gets a critical review.
- **Investigation or debugging**: give separate hypotheses to separate one-off jobs, and require evidence of the cause before anyone starts a fix.
- **Speed**: plan for wall-clock time. Run independent units in parallel. Put each unit's review and claims check in the plan up front, and the final panel too (see "Evidence and review").

## Choose the delegation type

| Type | Use it for | How |
|---|---|---|
| Owner unit | Work with a branch, a PR or follow-ups | A child session from `create_session`, or from `open_pr_session` or `open_issue_session` for an existing PR or issue. One session, one branch, one PR. |
| One-off job that needs a checkout | A review, a claims check, a panel judge, a verification or a repository command | A child session from `create_session`, with `base_branch` set to the branch under test. |
| One-off job with no checkout | Web research, a summary of a Library file, a plan critique, a second opinion on a document or a fact-check | A `task` sub-agent with `agent_type: "general-purpose"`, and `model` and `reasoning_effort` from "Models and effort". Use `mode: "background"` when it may get a re-check, so that you can send the re-check with `write_agent`. |
| Quick job | See "Quick jobs you do yourself" | You do it. |

For every child session, whether from `create_session`, `open_pr_session` or `open_issue_session`:

- set `project_id` of a repository that this Project has added, for `create_session` (from `list_repositories`, or add the repository first with the app's repository setup);
- set `base_branch` when the unit is stacked or under test, and only to a branch that is already pushed;
- set `kickoff.mode` to `"autopilot"`, or to `"plan"` only when the user asked to approve each unit's approach; never leave it unset;
- set `kickoff.model` and `kickoff.reasoning_effort` from "Models and effort"; never leave them unset;
- set `coordinate_with_creator: true` and `notify_on_idle: "once"`;
- never set `kickoff.agent`. Custom agents don't run in a Project's sessions; the worker skill gives children their rules.

Give each child a unit label (see "State and registry"), and start its session name with it, for example `api: Orders endpoint`. After it starts, check its model and effort with `get_session`; if they differ from what you set, tell the user.

A `task` sub-agent doesn't use the worker skill. Its prompt gives its role, the job and its inputs, its output (a file at an absolute path in your files folder, and a short summary), the evidence to give (sources with links, commands with their results), and that it starts no sub-agents and creates no sessions. Record it in `child_notes` under a label of its own, with kind `sub-agent`, its model and its effort.

- One owner per piece of work. Work that needs the owner's context goes to its owner: fixes, review comments, rebases, PR text and decisions. Never start a second session for owned work, except for the independent checks in "Evidence and review".
- A successful `create_session` doesn't prove that the child started. Confirm it with `get_session` or with its first report.
- If `create_session` fails, it can still leave a session behind. Archive that session, note it in `child_notes`, fix the cause, and try once more as a new unit.
- A child paused on a plan or a question doesn't read messages. Bring it to the user (see "Talking to the user").
- Children don't start sessions or sub-agents. When a workflow needs several agents, you run its fan-out.

**Helper requests.** A child that needs another agent sends you a `needs_input` report with the job under `Blockers:`. Handle it at once, in this order: answer it from your own state when it is a technical question inside the scope the user gave; route owned work to its owner; do it yourself if it is a quick job and not a review, a check, a panel or a second opinion; send it to an idle session that has the context and fits the job's tier and vendor; otherwise start a helper. A request for an independent review or a claims check becomes the unit's planned review or claims check. Tell the child at once whether to wait or carry on, and which unit has the job.

## Merging

Reading PR state, CI and policies is a quick job. Merging after the go-ahead is one too:

- Merge only when the PR's head is the commit at which every check passed (see "Evidence and review"). On GitHub, use `gh pr merge <number> -R <owner>/<repo> --squash --match-head-commit <sha>`; on Azure DevOps, the verified completion command in `wintermute-pr-commands`, after you check the source commit. Never delete the source branch.
- If the target branch has moved since the final panel, size the new integration as a follow-up job before you merge (see "Follow-up jobs").
- If the owner may be working on the PR, tell it, with its current `assignment_id`, that you will merge; wait for its handoff that it has paused, then merge and tell it the result.
- Read the PR back after the merge. Record `merged` only when the provider reports it merged, with its merge commit; a queued merge is not merged yet.
- Nobody watches a PR: no automation, event subscription, polling loop or background script. When you need a PR's state, read it once. When a required check needs CI that is still running, one session may wait for it once, with one command that has a time limit of about 30 minutes, such as `gh pr checks --watch`.

## Models and effort

Choose a model and an effort for every job you hand out: `kickoff.model` and `kickoff.reasoning_effort` for every child session, and `model` and `reasoning_effort` for every `task` call. Never leave them unset: a child would get your own model and effort, which suit coordination, not the job.

The table and the list below are the user's model policy, copied word for word from the `wintermute-core` agent. A model or effort that the user asks for overrides them, but only for the jobs the user named it for.

<!-- wintermute-core: tier table -->

How to apply the table in a Project:

- The table names model families. Use the newest version of each family in the model list of the tool you call. If a family isn't listed, use another family from the same tier, at the level that the row gives that family.
- Sonnet and Opus are Anthropic models, Sol and Astra are OpenAI models, and Argon and Carbon are Google models. The author's vendor is the vendor of the model that wrote the work.
- A child gets the tier of the work it owns. The owner of a PR is Mid, unless its unit is critical (High by default) or the work is harder. A review, a claims check or a judge gets its own row. A plan critique or a second opinion is Max.
- A follow-up job gets the tier or review row of its own scope and risk, not the unit's (see "Follow-up jobs" in "Evidence and review").
- Execution at Max is only for the two roles that the Max row names, and only after the user approves. Ask, tagged with the unit.
- If a one-off job's result is shallow although its brief, context and environment were sound, run it once more one tier up, at most to High, as a new job. A document draft or a fact-check runs again instead at the next level that its own row lists for that model; if the row lists none, treat the result as unverified and find out why. This doesn't apply to a `blocked` or `needs_input` report, a failure with a known cause, or a problem already in a repair cycle.
- You can't change a running child's model. If an owner looks under-tiered, ask the user whether to replace it with a new unit one tier up.
- Record each job's model, effort and a one-line reason in `child_notes`.

<!-- wintermute-core: never-use list -->

## Kickoff prompts and forwarding

Every child session's kickoff prompt:

- starts with this line: ``Load the `wintermute-project-worker` skill now, before anything else, and follow it for this whole session.``
- quotes the user's request verbatim, or the part that applies, and then adds only the context the child needs to work alone;
- gives the child its unit label and the task's target branch, and names what it owns (a branch and a PR, or one job) and what it must leave alone; keeps confirmed decisions apart from suggestions;
- for a Mid-tier implementation unit, includes acceptance tests written from the request;
- passes on the restrictions and preferences in the user's memories and the Project's memory that apply, such as personal skills to use, PR text rules and actions that need approval; never passes on a permission;
- for a one-off job, says that it is a one-off job with no commits or pushes, whether it is read-only, and the absolute path of your files folder for its result file;
- tells an owner that you start its review and claims check when it hands off a pushed commit.

Later messages to a child:

- New work, a revision, a rerun or a go-ahead is a new assignment: send it without `assignment_id`.
- An answer to a child's question, or other context about its current work, carries that work's `assignment_id`.
- Start your own text in every new assignment with: ``Follow the `wintermute-project-worker` skill; load it again if its rules aren't in your context.``
- To pass on the user's own words from a message they typed to you, use `source_user_message` with that message's current `id` and `revision`, so that the app quotes it word for word. An answer from `ask_user` or a plan decision is not such a message: answer the child's pending request with `answer_session_input` or `respond_to_session_plan_v2` and its request ID.
- Put only your own words in `message` and `coordinator_instructions`, never presented as the user's, and never as a permission the user didn't give. If a child needs the user's own words and their source is gone, for example after the app restarted, ask the user to send them again.

## Reports and gates

Children report with `send_session_message`, with a status line and a `purpose`:

| Status line | `purpose` | Reaches you |
|---|---|---|
| `complete` | `handoff` | As a ready result, together with others that arrive close to it |
| `progress` | `progress` | Never: it stays in the child's thread |
| `needs_input` | `needs_input` | At once |
| `blocked` | `error` | At once |

A handoff has two lines: the status line and `Summary:` with one outcome sentence. It keeps `commit=` and `pr=` when they apply. A longer result is in a file that the sentence links. A sentence that starts with "Partial:" is not the final result. `needs_input` and `error` reports also have `Evidence:` and `Blockers:`.

Record every assignment in an `assignments` table, and process each report once:

```sql
CREATE TABLE IF NOT EXISTS assignments (
  assignment_id TEXT PRIMARY KEY,  -- from the create_session or send_session_message result
  unit          TEXT NOT NULL,     -- unit label
  role          TEXT NOT NULL,     -- owner, review, claims, judge, fact-check or another one-off role
  covers        TEXT NOT NULL,     -- what it asks for, in a few words
  commit_sha    TEXT,              -- the commit it is about, when it is about code
  status        TEXT NOT NULL CHECK (status IN ('open', 'partial', 'reported', 'superseded')),
  result        TEXT,              -- the latest outcome sentence, with its link
  created_at    TEXT NOT NULL,     -- ISO 8601, UTC
  updated_at    TEXT NOT NULL      -- ISO 8601, UTC
);
```

- A handoff doesn't close an assignment for the app: the child may send another result with the same `assignment_id`. Apply a result only if it is newer than the one you hold. Ignore a duplicate.
- A verdict counts only for the commit it names. A new commit on a unit supersedes its earlier review, claims check and panel verdicts: mark them `superseded` and size the new check (see "Follow-up jobs").

**Gates.** A unit's work is a chain of assignments:

1. Kickoff: the owner implements, tests and pushes, then hands off with `commit=`. It opens no PR yet.
2. CI that runs only on PRs: if the repository's required checks run only on PRs, get the go-ahead to open a draft PR for CI. With it, send the owner an assignment that authorizes the draft. Without it, the claims check uses local test runs and reports CI as not run.
3. Checks: start the unit's review and its claims check at the pushed commit (see "Evidence and review"), and for the last unit of a task in a repository, the final panel. Each fix they ask for is a new assignment to the owner.
4. Publish: when the review and the claims check are clean at the same commit, get the go-ahead to open the PR ready for review, or to take the draft out of draft. Then send the owner an assignment that authorizes it. The owner publishes the PR to the Inbox and hands off with `pr=`.
5. Merge: when the unit's review, its claims check and, for the last unit of a task, the final panel are all clean at the PR's head, get the go-ahead to merge, and merge the PR yourself (see "Merging").
6. After the task's last merge into its target branch, run a claims check on that branch at the merge commit. A merge into a parent unit's branch doesn't get this check.

**Status checks.** Don't ask a child for a progress report: its reply would never reach you. `notify_on_idle: "once"` sends one idle notice; it doesn't watch the child. When a child is idle and one of its assignments has no final result, check it with `get_session`, then send it a message with that `assignment_id` that asks for its result as a handoff, or its blocker as an error. The app sends "The session finished without sending a handoff." only for an assignment with no report at all; it is not a report: check that child with `get_session`.

**Ending work.** Keep a unit's reviewer and claims checker until the unit merges, and the final panel's judges until the task's last merge, so that they can take re-checks. Archive a child only when it is idle, has no open assignment, PR or automation, and its branch is pushed; tell a busy child to stop first. After the post-merge claims check, archive the task's children. Archive any other one-off session when you have recorded its result and its worktree is clean. Set `outcome` in `children` before you archive, and record each archive in `child_notes`.

## State and registry

Keep your state in your session SQL database with the `sql` tool, not in files.

- `todos` and `todo_deps` hold the plan.
- `tasks` holds one row per task:

  ```sql
  CREATE TABLE IF NOT EXISTS tasks (
    task       TEXT PRIMARY KEY,  -- short id, such as t1
    title      TEXT NOT NULL,     -- a few words that name the user's request
    request    TEXT NOT NULL,     -- the user's request, quoted
    target     TEXT NOT NULL,     -- the branch the task's PRs merge into
    created_at TEXT NOT NULL,     -- ISO 8601, UTC
    ended_at   TEXT               -- ISO 8601, UTC; set after the task's last merge and claims check
  );
  ```

- `children` is the swarm dashboard's registry: one row per child session, not per sub-agent. Create it with this exact definition before you insert the first row:

  ```sql
  CREATE TABLE IF NOT EXISTS children (
    unit        TEXT PRIMARY KEY,  -- unit label
    session_id  TEXT NOT NULL,     -- id returned when the child session was created
    title       TEXT NOT NULL,     -- short human name for the unit
    todo_id     TEXT,              -- the unit's todos.id, when the plan uses todos
    branch      TEXT,              -- the unit's branch
    base_branch TEXT,              -- branch it was created from: a parent unit's branch, or main
    pr_provider TEXT CHECK (pr_provider IN ('ado', 'github')),
    pr_repo     TEXT,              -- GitHub: owner/repo; Azure DevOps: organization/project/repository
    pr_id       INTEGER,           -- Azure DevOps pull request id or GitHub PR number
    pr_url      TEXT,              -- the PR's web URL
    outcome     TEXT CHECK (outcome IN ('merged', 'closed', 'failed')),
    created_at  TEXT NOT NULL,     -- ISO 8601, UTC
    updated_at  TEXT NOT NULL,     -- ISO 8601, UTC; set on every change
    ended_at    TEXT               -- ISO 8601, UTC; set together with outcome
  );
  ```

  Insert a child's row as soon as the child exists. Fill `pr_provider`, `pr_repo`, `pr_id` and `pr_url` as soon as the unit has a PR; take the URL from `get_session` or a quick `gh pr view`. When the unit ends, set `outcome` to `merged`, `closed` or `failed`, with `ended_at`. Write timestamps with `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`, and set `updated_at` on every change. Never delete rows, add columns or use values outside the `CHECK` lists.
- `child_notes` holds everything else per unit, keyed by `unit`: its task, its kind (owner, one-off or sub-agent), its model and effort with a reason, its working status (including `archived`), its last report, every review verdict and claims check result with the commit it applies to, skipped reviews and escalations.
- `assignments`, `delegations` and `wintermute_project`, as above.

**Unit labels.** The dashboard reads them exactly:

- a label is 1–32 characters from `A–Z`, `a–z`, `0–9`, `.`, `_` and `-`;
- it is unique within this Project, across all its tasks, and never reused, even after its child ends; compare with `lower(unit)` before you insert a row;
- a child that takes over a lost or archived child's work is a new unit with a new label, for example `api-2`.

## Evidence and review

- A report of "done" or "tests pass" without evidence is unverified: ask the owner for the evidence. A test run that ran no tests is not evidence.
- **Claims check**: before every merge, every publish, and before you tell the user that repository work is finished, a claims checker confirms the owner's claims at the pushed commit: the tests ran at that commit, with counts; the repository's required checks passed at that commit, or are reported as not run when it has none; and the scope matches the brief. It is a one-off child session at the claims check row, read-only, created with `base_branch` set to the branch, working from its own fresh fetch, and it writes a result file with the commit, each command, its exit code and the counts. Keep it until the unit merges, so that it can check later commits. A reviewer, a judge, the owner or you never does a claims check.
- **Work with no commit**, such as research, a document or a plan, has its evidence in the file itself: the file at an absolute path, its sources with links, and, for a load-bearing document, a fact-check from another vendor. That fact-check is the check before you publish it or call it finished.
- **Regular review**: every unit gets one review before it merges, from one reviewer at the regular review row, never from the author's vendor. Opus- or Sonnet-written code goes to Astra, Astra- or Sol-written code goes to Opus, and Argon- or Carbon-written code can go to either. Scope the brief to the unit's request and its risky code paths, and tell the reviewer to report every finding. Run it as a one-off child session with `base_branch` set to the unit's branch.
- **Critical review**: a critical unit gets a critical review instead, at the critical review row, run the same way.
- **Security review**: a review of security, authentication or secrets uses Astra at `xhigh`, or, for code that an OpenAI model wrote, Opus at `xhigh` (Argon at `high` if Opus refuses, fails or times out).
- **Final panel**: when one unit of a task is left unmerged in a repository, its owner rebases its branch onto the task's target branch, and two judges check its head: how the task's units work together, and whether the request is covered as a whole. If the unit's PR targets another branch, ask the user to retarget it. The judges come from the two vendors that wrote the fewest of this task's units in this repository (Argon and Carbon count together as Google), at the final panel row, at its critical levels if any of those units was critical. They run alongside the unit's own review, as two one-off child sessions with `base_branch` set to the unit's branch. If the task has only one unit in the repository, the panel checks that unit. Units of other tasks don't wait for this panel. A panel finding blocks only if both judges raise it, or if one raises it and the owner or a verifier reproduces it.
- **Disagreement panel**: when a child disputes a finding with evidence, or two agents disagree, two fresh judges decide, at the disagreement panel row. Neither took part in the dispute. One comes from the vendor outside the dispute; the second shares a vendor with one side. If both uphold the finding, it gets fixed; if both reject it, it is dismissed; if they split, the user decides.
- **One vendor**: if the user has limited the work to one vendor, reviewers, judges and second opinions use that vendor, each as a new session, and you say so.
- **Documents**: a load-bearing document, such as a spec or a research brief, gets a drafter at the document draft row and a fact-checker from another vendor at the fact-check row.
- **Findings**: must-fix and should-fix findings block the merge until they are fixed or disproved; nits never block. Give each dismissed finding a one-line reason. Record every verdict in `child_notes`, with the commit it applies to.
- **Follow-up jobs**: size every fix, re-check, rebase and later claims check by its own scope and risk, from the diff at the pushed commit, which you read as a quick job, and from the owner's test evidence.
  - A mechanical change that tests fully cover, such as a rename, a documentation change, or a rebase with no new code and no conflicts resolved by hand, needs no review re-check. It needs no new claims check either when an earlier claims check passed for this unit, the whole change since then is mechanical, it touches no build, CI or test configuration and removes no tests, and the repository's required checks passed at the new head; otherwise the claims check runs again.
  - A small change with real logic gets one reviewer: the unit's idle reviewer if it fits, unless it is Astra, whose re-reads cost the most; otherwise one at the light review row.
  - A significant change gets the unit's original reviewers. A change that meets a critical-unit trigger gets a critical review.
  - When a follow-up needs no re-check or no new claims check, the earlier verdict stands for the new head. Record each choice in `child_notes`, with the commit.
- **Re-checks**: a reviewer who re-checks reviews only the new diff, and runs code only to settle a possible finding. If the last PR changes after the panel, the judges re-check only a change that can affect how the units work together.
- Allow at most two repair cycles on the same problem. If it persists, stop, find out why, and change the plan or bring it to the user. Don't just switch to a stronger model.
- Get a second opinion at the Max tier, from another vendor than the one that did the work, for irreversible actions, public interfaces, schemas or security, or when the user asks.
- A review that the user or the project requires stays open until someone other than the author has done it.

## Talking to the user

- Lead with what needs the user. Say nothing about idle notices, archive confirmations or checks that bring no news.
- Start every question to the user with a tag, one space, then the question: `[unit=<unit>]`, `[unit=<unit> need=pr]` for a PR go-ahead, or `[unit=* need=plan]` for a plan. `unit=` takes one label, several labels separated by commas with no spaces, or `*` for the whole task. Make each question self-contained: what it is about, the evidence, and your recommendation.
- When a child pauses on a plan or a question, answer it yourself only when it is a technical question inside the scope the user already gave, with `answer_session_input`, or `respond_to_session_plan_v2` never with `autopilot_fleet`. Relay every plan approval, permission and choice that only the user can make with `relay_session_input` and the child's pending request ID, and start its context with the tag; the tag is a wintermute convention that the dashboard doesn't read yet. If it returns `outcome: "answered_here"`, the answer already reached the child: don't send it again.
- Children publish their own review-ready output to the Inbox, linked by full path, once per material revision. Tell a child in a new assignment when its document or other output is review-ready, so that it publishes it. If a child has no publish tool, it hands off the verified output and you publish it with its `agent_session_id`. You publish only your own deliverables, and you present several children's outputs by the app's rules: a separate `publish_chat_update` for each producing child's non-PR output, with that child's `agent_session_id`; one update for pull requests, with no top-level `agent_session_id` and `source_session_id` on each PR attachment; and at most six attachments in one update. A successful publish doesn't prove that an Inbox card appeared, and it never grants a go-ahead.
- When the first child of a task exists, check with `list_canvas_capabilities` that the `swarm-dashboard` canvas is installed. If it is, open it once with `open_canvas`: `canvasId: "swarm-dashboard"`, `instanceId: "wintermute-<task>-dashboard"` (for example `wintermute-t1-dashboard`), `input: {}`. If it isn't there or fails to open, tell the user once and carry on.
- Anything the user's memories or the Project's memory say needs approval needs it here too. Pass that on to children.

## Output format

- Before a turn that calls `create_session`, write one short sentence that ends in a colon. After the calls, write one short paragraph, without bullets or session references, that says in a few words what each new session does, with its model and effort. For example: "I started 2 sessions: one writes the test on Opus at medium, and one reviews it on Astra at high."
- When you send new work, a revision or a rerun to existing sessions, write one sentence with the real references inline.
- When a task finishes, report the result, the review and claims check verdicts with their commits, unresolved risks and any skipped review.
- Every question to the user starts with its tag (see "Talking to the user").
````

- [ ] **Step 2: Run the skill check to see the copy is missing**

Run the command from Task 2, Step 1.
Expected:

```text
skills/wintermute-project/SKILL.md: "## Models and effort" has no table
skills/wintermute-project/SKILL.md: "## Models and effort" has no "Never use these:" line
```

- [ ] **Step 3: Copy the table and the list from `wintermute-core`**

Run, from `ghcp/plugins/wintermute/`:

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
import { POLICY_AGENT, policyBlocks } from './scripts/lib/validate-skills.mjs';
const file = 'skills/wintermute-project/SKILL.md';
const { table, neverUse, errors } = policyBlocks(readFileSync(POLICY_AGENT, 'utf8'));
if (errors.length) throw new Error(errors.join('\n'));
const marks = ['<!-- wintermute-core: tier table -->', '<!-- wintermute-core: never-use list -->'];
const text = readFileSync(file, 'utf8');
if (!marks.every(mark => text.split(mark).length === 2)) throw new Error('each marker must appear exactly once');
writeFileSync(file, text.replace(marks[0], () => table).replace(marks[1], () => neverUse));
console.log('Copied the tier table and the never-use list from ' + POLICY_AGENT);
"
```

Expected: `Copied the tier table and the never-use list from com.github.copilot/agents/wintermute-core.agent.md`. Then run the command from Task 2, Step 1 again.
Expected: `no skill errors`.

- [ ] **Step 4: Write the integration test, and see it fail**

Create `tests/validate-skills-plugin.test.mjs`:

````js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { POLICY_AGENT } from '../scripts/lib/validate-skills.mjs';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '../../..');
const LAST_ITEM = '- A reviewer or fact-checker from the author\'s vendor, unless the user has limited the work to one vendor (see "Evidence and review"). Judges follow the vendor rules of the final panel and the disagreement panel instead.';

/** A copy of the plugin and the root marketplace in a scratch repository, with wintermute-core changed by `edit`. */
function sandbox(edit) {
  const repo = tempDir('swarm-skills-plugin-');
  const root = path.join(repo, 'ghcp/plugins/wintermute');
  mkdirSync(path.dirname(root), { recursive: true });
  cpSync(pluginRoot, root, { recursive: true });
  mkdirSync(path.join(repo, '.github/plugin'), { recursive: true });
  cpSync(path.join(repositoryRoot, '.github/plugin/marketplace.json'), path.join(repo, '.github/plugin/marketplace.json'));
  const core = path.join(root, POLICY_AGENT);
  writeFileSync(core, edit(readFileSync(core, 'utf8')));
  return { repo, root };
}

test('npm run validate reports drift between wintermute-core and the wintermute-project skill', async () => {
  const cases = [
    [text => text.replace('| Claims check | Sol at `medium`', '| Claims check | Sol at `high`'), 'the tier table differs from com.github.copilot/agents/wintermute-core.agent.md at its line 9'],
    [text => text.replace(LAST_ITEM, `${LAST_ITEM}\n\n- Haiku at \`max\`: added only in wintermute-core.`), 'the "Never use these:" list differs from'],
  ];
  for (const [edit, expected] of cases) {
    const { repo, root } = sandbox(edit);
    const errors = await validatePlugin(root, repo);
    assert.ok(errors.some(error => error.includes(expected)), `${expected} in\n${errors.join('\n')}`);
  }
});
````

Run: `node --test tests/validate-skills-plugin.test.mjs`
Expected: FAIL: `npm run validate` doesn't run the skill checks yet, so neither drift is reported. The test works on a scratch copy; the real agent file is never touched.

- [ ] **Step 5: Wire the validator into `npm run validate`**

In `scripts/validate-plugin.mjs`, after the line

```js
import { validatePackage } from './lib/validate-package.mjs';
```

add

```js
import { validateSkills } from './lib/validate-skills.mjs';
```

and after the line

```js
  errors.push(...await validateDashboard(root, manifest, pkg));
```

add

```js
  errors.push(...await validateSkills(root, repositoryRoot));
```

Change nothing else in the file, so that a removal is two lines (design 8.8).

- [ ] **Step 6: Run every check**

Run: `node --test tests/validate-skills-plugin.test.mjs && npm test && npm run validate && git status --short com.github.copilot`
Expected: the integration test passes; the suite passes with 10 more tests than before Task 1; validation ends with "Plugin validation passed: manifests, root marketplace entry, packaged agents, CHANGELOG and required files."; and `git status` prints nothing for the agents.

- [ ] **Step 7: Commit**

```bash
git add skills/wintermute-project/SKILL.md tests/validate-skills-plugin.test.mjs scripts/validate-plugin.mjs
git commit -m "feat(wintermute): add the wintermute-project skill and run the skill checks in validate"
```

### Task 4: README, repository instructions, version and CHANGELOG

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `plugin.json`, `package.json`, `.github/plugin/marketplace.json`, `.github/copilot-instructions.md`

**Interfaces:**
- Consumes: the skills (Tasks 2 and 3); decision 7.
- Produces: the next minor version with its CHANGELOG section, and the instructions exception that Task 14 reverts.

- [ ] **Step 1: Point to the new README section**

In `README.md`, under `## What's in the plugin`, after the line

```markdown
- the [swarm dashboard](DASHBOARD.md), which shows what those sessions are doing.
```

add one blank line and then this line:

```markdown
It also has two experimental skills for Copilot app Projects (see [Projects (experimental)](#projects-experimental)).
```

- [ ] **Step 2: Add the README section**

In `README.md`, directly before the line `## The swarm dashboard`, insert exactly this text (it ends with one blank line):

````markdown
## Projects (experimental)

The plugin also has two skills for [Copilot app Projects](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-projects). They are an evaluation of whether a Project is a good place to run wintermute, and they may be removed.

A Project can't run `wintermute-core` as its agent, because the app doesn't allow custom agents in a Project or its sessions. Instead, the `wintermute-project` skill gives the Project's own coordinator the same rules: units, a model and effort for every job, an independent review from another vendor and a claims check before every merge, and at most two repair cycles. Its child sessions load `wintermute-project-worker`, which tells them how to report through the Project. The Project's Overview, Inbox, Library and Automations work as usual.

- **Turn it on** in a Project by typing `/wintermute-project` with your request. The coordinator saves a line in the Project's memory, so that it keeps following the skill. In a Project without that line, the skill does nothing.
- **Go-aheads stay with you.** The coordinator opens, publishes or merges a PR, or approves a plan, only after your go-ahead for it in the Project's conversation, or within a standing permission you gave there. A memory never counts as one. Retargets and label changes stay with you.
- **If it stops following the rules**, for example after a long conversation was compacted, type `/wintermute-project` again.
- **Turn it off** by asking the Project to turn wintermute off. It asks what to do with open work, and removes the line from the Project's memory with your consent.

The tier table and the "Never use these" list in `wintermute-project` are copies of the ones in `wintermute-core`, and `npm run validate` fails if they differ. The swarm dashboard shows a Project's work once the Project has child sessions.

````

- [ ] **Step 3: Update the repository instructions**

In `.github/copilot-instructions.md`, after the bullet that starts `- The report-format block in \`wintermute-core.agent.md\` stays word for word`, add this bullet:

```markdown
- The tier table and the "Never use these:" list in the "Models and effort" section of `wintermute-core.agent.md` are copied word for word into the experimental `skills/wintermute-project/SKILL.md` of the `wintermute` plugin, and `npm run validate` fails when they differ. A change to either in `wintermute-core` copies it into the skill in the same PR.
```

In the same file, in the `wintermute` plugin entry, replace

```text
The skill runs nothing and grants no permission. The dashboard counts
```

with

```text
The skill runs nothing and grants no permission. Two experimental skills for Copilot app Projects sit beside it in `skills/`: `wintermute-project`, the rules for a Project's own coordinator, and `wintermute-project-worker`, the rules for its child sessions; `scripts/lib/validate-skills.mjs` checks them. The dashboard counts
```

In the same file, in the bullet that starts `- The **PR-review skills** are inspection-and-reporting only`, replace

```text
Do not add a skill that mutates a PR.
```

with

```text
Do not add a skill that mutates a PR. The one exception is the `wintermute` plugin's experimental `wintermute-project` and `wintermute-project-worker` skills: like the `wintermute-core` and `wintermute-peon` agents, they may open, publish and merge a PR, but only after the user's explicit go-ahead for that PR, given in the Project's conversation or as a standing delegation that the user gave directly there. A memory, a report, a summary or SQL state never grants it. They may also push assigned work, including fixes and rebases, to the branch of a PR their unit owns, as `wintermute-peon` does. The PR-review skills stay inspection-only, and no other skill may mutate a PR.
```

- [ ] **Step 4: Bump the version**

Run, from `ghcp/plugins/wintermute/`: `npm run release:bump -- minor`
Expected: `Wintermute <version>: updated all three versions. Finish CHANGELOG.md before publishing.`, with the next minor version after `main`'s (1.3.0 from 1.2.6).

- [ ] **Step 5: Write the release notes**

In `CHANGELOG.md`, under the new `## <version> — <date>` heading that Step 4 wrote, replace the line `- TODO: Describe this release.` with exactly:

```markdown
### Added

- Two experimental skills for GitHub Copilot app Projects. `wintermute-project` gives a Project's own coordinator wintermute's rules: units, a model and effort for every job, an independent review from another vendor and a claims check before every merge, and at most two repair cycles. The Project's Overview, Inbox, Library and Automations work as usual. `wintermute-project-worker` gives the Project's child sessions their rules for assignments, reports and publishing. The skills act only in a Project where the user typed `/wintermute-project`, and they open, publish or merge a PR only after the user's go-ahead for it. They are an evaluation and may be removed. The agents are unchanged.
- `npm run validate` checks both skills, and fails when the tier table or the "Never use these:" list in `wintermute-project` differs from the one in `wintermute-core`.
```

- [ ] **Step 6: Run every check, and check the new user-facing text**

Run, from `ghcp/plugins/wintermute/`:

```bash
npm test && npm run validate
! git diff origin/main -U0 -- README.md CHANGELOG.md skills | grep '^+' | grep -qi cockpit && echo "no new cockpit text"
```

Expected: PASS, then `no new cockpit text`.

- [ ] **Step 7: Commit, push and hand off**

```bash
git add README.md CHANGELOG.md plugin.json package.json ../../../.github/plugin/marketplace.json ../../../.github/copilot-instructions.md
git commit -m "docs(wintermute): document the experimental Projects skills and their PR exception; release the next minor version"
git push
```

Hand off with the pushed commit. The orchestrator starts the second opinion, the critical review, the claims check and the final panel at that commit, then brings the PR go-ahead to the user.

---

## Phase 1, units `projects-smoke` and `projects-trial`: running a run

These units are one-off jobs and user steps. They commit nothing to the repository. The orchestrator brings each **USER** step to the user and waits for "done", and gives each job the run ID and `$OUT` in its kickoff. One run operator, a child session at the Low tier with a checkout of `ncksol/ai_tools`, does Tasks 6, 7 and 9 for a run, and the collection at each checkpoint. Every exit from a run, for any reason, goes through Task 7.

Shell variables don't carry over between steps. Each step starts with `RUN=<run ID>; RUN_DIR="$HOME/wm-runs/$RUN"; PLUGIN="$HOME/.copilot/installed-plugins/ai-tools/wintermute"`, with the run ID from Task 6.

### Task 5 (USER): Update the plugin, and confirm what the app loads

**Interfaces:**
- Consumes: the merged `projects-skills` PR.
- Produces: the app running the plugin version with both skills, confirmed in the app.

- [ ] **Step 1 (USER): Update and restart**

In a terminal:

```bash
copilot plugin update wintermute@ai-tools
copilot plugin list
```

Expected: `wintermute@ai-tools` at the version that `projects-skills` released, or a later one that still has both skills. If the list shows another `wintermute` install, a disabled plugin, or a version that removed the skills, stop and tell the orchestrator. Then quit and reopen the GitHub Copilot app.

- [ ] **Step 2 (USER): Confirm in the app**

In the app, open **Customize → Installed**: `wintermute` is enabled at that version. Open the skills list there: `wintermute-project` and `wintermute-project-worker` are listed. Tell the orchestrator the version you saw, and that both skills are listed.

### Task 6: Prepare a run

The run operator does this for every smoke check and every trial, with `MODE` set to `smoke` or `trial` in its kickoff. It writes only in the run folder, and, for a trial, creates the run's two base branches.

**Files (outside the repository):**
- Create: `~/wm-runs/<run ID>/.wm-run-owner`, `run.json`, `wm-collect.mjs`, `wm-measure.mjs`, `wm-finalize.mjs`, `preflight.txt`

**Interfaces:**
- Produces: the run ID, a run folder whose `run.json` names the arms, their markers and base branches, and the caps; the scripts that Tasks 7, 9 and 11 run.

- [ ] **Step 1: Make a fresh run folder, or refuse**

```bash
MODE=<smoke or trial>
RUN="wm-$MODE-$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="$HOME/wm-runs/$RUN"
mkdir -p "$HOME/wm-runs"
if [ -e "$RUN_DIR" ]; then echo "refusing: $RUN_DIR exists"; exit 1; fi
mkdir "$RUN_DIR" && printf '%s\n' "$RUN" > "$RUN_DIR/.wm-run-owner" && echo "$RUN"
```

Expected: the run ID. Report `blocked` on anything else; delete nothing.

- [ ] **Step 2: Write the collector**

Create `$RUN_DIR/wm-collect.mjs`:

````js
#!/usr/bin/env node
// Finds every session, branch and PR of one wintermute Projects run, appends what is new or changed to inventory.jsonl,
// and writes ids.json for the measurement. Read-only outside the run folder. Exits 2 on an ambiguous identity.
// Usage: node wm-collect.mjs --run-dir <dir> [--copilot-home <dir>] [--no-pr-lookup]
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const opts = { 'copilot-home': path.join(homedir(), '.copilot') };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--no-pr-lookup') opts['no-pr-lookup'] = true;
  else opts[argv[index].replace(/^--/, '')] = argv[index += 1];
}
if (!opts['run-dir']) throw new Error('Usage: node wm-collect.mjs --run-dir <dir> [--copilot-home <dir>] [--no-pr-lookup]');
const runDir = path.resolve(opts['run-dir']);
const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
const home = opts['copilot-home'];
const db = path.join(home, 'data.db');
const remoteUrl = run.remote ?? `https://github.com/${run.repo}.git`;
const problems = [];

const quote = value => `'${String(value).replace(/'/g, "''")}'`;
const list = values => values.map(quote).join(', ');
function query(sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
}
function remote(args) {
  try {
    return { ok: true, out: execFileSync(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, error: String(error.stderr || error.message).trim().slice(0, 300) };
  }
}

function firstHumanText(cliId) {
  const file = path.join(home, 'session-state', cliId, 'events.jsonl');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = typeof event.data?.content === 'string' ? event.data.content : '';
    if (event.type === 'user.message' && !event.agentId && !event.data.source && !content.startsWith('<system_notification>')) return content;
  }
  return null;
}

function workspaceOf(sessionId) {
  const rows = query(`SELECT id FROM workspaces WHERE session_id = ${quote(sessionId)} UNION SELECT workspace_id AS id FROM workspace_session_aliases WHERE session_id = ${quote(sessionId)}`);
  if (rows.length > 1) problems.push(`session ${sessionId} maps to ${rows.length} workspaces`);
  return rows[0]?.id ?? null;
}

function cliIdsOf(workspaceId, sessionId) {
  if (!workspaceId) return [sessionId];
  const rows = query(`SELECT session_id FROM workspaces WHERE id = ${quote(workspaceId)} AND session_id IS NOT NULL UNION SELECT session_id FROM workspace_session_aliases WHERE workspace_id = ${quote(workspaceId)}`);
  return [...new Set([sessionId, ...rows.map(row => row.session_id)].filter(Boolean))];
}

function findRoot(arm) {
  let rows;
  if (arm.kind === 'project') {
    rows = query(`SELECT s.id, s.title, s.created_at, s.archived_at FROM persistent_projects p JOIN sessions s ON s.id = p.session_id WHERE s.title = ${quote(arm.title)} AND s.created_at >= ${quote(run.createdAt)}`);
  } else {
    rows = query(`SELECT id, title, created_at, archived_at FROM sessions WHERE agent = 'wintermute:wintermute-core' AND created_at >= ${quote(run.createdAt)}`)
      .filter(row => (firstHumanText(row.id) ?? '').includes(arm.marker));
  }
  if (rows.length > 1) problems.push(`arm ${arm.arm}: ${rows.length} candidate root sessions (${rows.map(row => row.id).join(', ')})`);
  return rows.length === 1 ? rows[0] : null;
}

function children(root, workspaceId, rootCliIds) {
  const found = new Map();
  const add = (sessionId, childWorkspaceId, how) => {
    const key = childWorkspaceId ?? sessionId;
    if (!key) return;
    const entry = found.get(key) ?? { workspaceId: childWorkspaceId ?? null, sessionIds: new Set(), how: new Set() };
    if (sessionId) entry.sessionIds.add(sessionId);
    entry.how.add(how);
    found.set(key, entry);
  };
  const assignments = query(`SELECT id, child_session_id, child_workspace_id, source_tool_call_id, forward_tool_call_id FROM persistent_project_assignments WHERE coordinator_session_id = ${quote(root.id)}`);
  for (const row of assignments) add(row.child_session_id, row.child_workspace_id, 'assignment');
  for (const row of query(`SELECT session_id FROM chat_parent_links WHERE parent_session_id IN (${list(rootCliIds)}) OR coordinating_creator_session_id IN (${list(rootCliIds)})`)) add(row.session_id, null, 'chat link');
  for (const row of query(`SELECT id, session_id FROM workspaces WHERE creator_session_id IN (${list(rootCliIds)}) OR coordinating_creator_session_id IN (${list(rootCliIds)})`)) add(row.session_id, row.id, 'workspace creator');
  if (workspaceId) for (const row of query(`SELECT w.id, w.session_id FROM workspace_parent_links l JOIN workspaces w ON w.id = l.child_workspace_id WHERE l.parent_workspace_id = ${quote(workspaceId)}`)) add(row.session_id, row.id, 'workspace link');
  const out = [];
  for (const entry of found.values()) {
    const ws = entry.workspaceId ? query(`SELECT w.id, w.name, w.branch, w.archived_at, w.created_at, t.path FROM workspaces w LEFT JOIN worktrees t ON t.id = w.worktree_id WHERE w.id = ${quote(entry.workspaceId)}`)[0] : null;
    const firstSession = [...entry.sessionIds][0] ?? ws?.session_id ?? null;
    const cliIds = entry.workspaceId ? cliIdsOf(entry.workspaceId, firstSession) : [...entry.sessionIds];
    const sessions = cliIds.length ? query(`SELECT id, title, archived_at, created_at FROM sessions WHERE id IN (${list(cliIds)})`) : [];
    out.push({
      workspaceId: entry.workspaceId, cliIds, name: ws?.name ?? sessions[0]?.title ?? null, branch: ws?.branch ?? null,
      archivedAt: ws?.archived_at ?? sessions.find(row => row.archived_at)?.archived_at ?? null, createdAt: ws?.created_at ?? sessions[0]?.created_at ?? null,
      worktreePath: ws?.path ?? null, linkedBy: [...entry.how].sort(),
    });
  }
  return { children: out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))), assignments };
}

function branchState(branch) {
  const result = remote(['git', 'ls-remote', '--heads', remoteUrl, `refs/heads/${branch}`]);
  if (!result.ok) return { branch, error: result.error };
  const sha = result.out.trim().split(/\s+/)[0] || null;
  return { branch, sha };
}

function prsFor(flag, value) {
  if (opts['no-pr-lookup']) return [];
  const fields = 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,createdAt,mergedAt,mergeCommit';
  const result = remote(['gh', 'pr', 'list', '-R', run.repo, '--state', 'all', flag, value, '--json', fields]);
  if (!result.ok) {
    problems.push(`gh pr list ${flag} ${value}: ${result.error}`);
    return [];
  }
  return JSON.parse(result.out);
}

const at = new Date().toISOString();
const arms = [];
const branches = new Set((run.baseBranches ?? []).map(base => base.name));
for (const arm of run.arms) {
  const root = findRoot(arm);
  if (!root) {
    arms.push({ arm: arm.arm, kind: arm.kind, resolved: false });
    continue;
  }
  const workspaceId = arm.kind === 'project' ? null : workspaceOf(root.id);
  const coordinatorCliIds = cliIdsOf(workspaceId, root.id);
  const rootRow = workspaceId ? query(`SELECT w.branch, t.path FROM workspaces w LEFT JOIN worktrees t ON t.id = w.worktree_id WHERE w.id = ${quote(workspaceId)}`)[0] : null;
  const rootBranch = rootRow?.branch ?? null;
  const { children: kids, assignments } = children(root, workspaceId, coordinatorCliIds);
  for (const branch of [rootBranch, ...kids.map(kid => kid.branch)]) if (branch) branches.add(branch);
  arms.push({
    arm: arm.arm, kind: arm.kind, resolved: true, rootSessionId: root.id, snapshotId: workspaceId ?? root.id, coordinatorCliIds,
    title: root.title, createdAt: root.created_at, archivedAt: root.archived_at ?? null, rootBranch, rootWorktreePath: rootRow?.path ?? null, children: kids, assignments,
  });
}
const branchStates = [...branches].sort().map(branchState);
const prs = new Map();
for (const branch of branches) for (const pr of prsFor('--head', branch)) prs.set(pr.url, pr);
for (const base of run.baseBranches ?? []) for (const pr of prsFor('--base', base.name)) prs.set(pr.url, pr);

const inventoryFile = path.join(runDir, 'inventory.jsonl');
const last = new Map();
if (existsSync(inventoryFile)) {
  for (const line of readFileSync(inventoryFile, 'utf8').split('\n')) if (line.trim()) {
    const entry = JSON.parse(line);
    last.set(entry.key, JSON.stringify(entry.value));
  }
}
const record = (key, value) => {
  const json = JSON.stringify(value);
  if (last.get(key) === json) return;
  appendFileSync(inventoryFile, `${JSON.stringify({ at, key, value })}\n`);
  last.set(key, json);
};
for (const arm of arms) {
  if (!arm.resolved) continue;
  record(`root:${arm.arm}`, { rootSessionId: arm.rootSessionId, snapshotId: arm.snapshotId, coordinatorCliIds: arm.coordinatorCliIds, title: arm.title, archivedAt: arm.archivedAt, rootBranch: arm.rootBranch });
  for (const kid of arm.children) record(`child:${kid.workspaceId ?? kid.cliIds[0]}`, { arm: arm.arm, ...kid });
}
for (const state of branchStates) record(`branch:${state.branch}`, state);
for (const pr of prs.values()) record(`pr:${pr.url}`, { number: pr.number, state: pr.state, isDraft: pr.isDraft, baseRefName: pr.baseRefName, headRefName: pr.headRefName, headRefOid: pr.headRefOid, mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid ?? null });
for (const problem of problems) record(`problem:${problem}`, { problem });

writeFileSync(path.join(runDir, 'ids.json'), `${JSON.stringify({ runId: run.runId, collectedAt: at, arms, branches: branchStates, prs: [...prs.values()], problems }, null, 2)}\n`);
console.log(`${run.runId}: ${arms.filter(arm => arm.resolved).length}/${arms.length} arms resolved, ${arms.reduce((sum, arm) => sum + (arm.children?.length ?? 0), 0)} children, ${branchStates.length} branches, ${prs.size} PRs, ${problems.length} problems`);
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 2;
}
````

- [ ] **Step 3: Write the measurement script**

Create `$RUN_DIR/wm-measure.mjs`:

````js
#!/usr/bin/env node
// Measures a wintermute Projects smoke check or trial from Copilot's local session logs, using ids.json from wm-collect.mjs.
// Read-only. Writes measure.json in the run folder and prints a summary.
// Usage: node wm-measure.mjs --run-dir <dir> --plugin <path to ghcp/plugins/wintermute> [--copilot-home <dir>]
//        node wm-measure.mjs --self-test --plugin <path to ghcp/plugins/wintermute>
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'READY TO MERGE:';
const READY_LINE = /^READY TO MERGE:\s*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+))/;
const PURPOSE = { complete: 'handoff', progress: 'progress', needs_input: 'needs_input', blocked: 'error' };
const STATE_CHANGING = new Set(['create_session', 'open_pr_session', 'open_issue_session', 'send_session_message', 'task', 'publish_chat_update']);
const SESSION_TOOLS = new Set(['create_session', 'open_pr_session', 'open_issue_session']);
const NANO_AIU_PER_USD = 1e11;
const text = value => (typeof value === 'string' ? value : '');
const iso = ms => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** All events of the given CLI sessions, in time order, with the raw event kept for the ledger. */
function readLogs(home, cliIds) {
  const events = [];
  const missing = [];
  let malformed = 0;
  for (const cli of cliIds) {
    const file = path.join(home, 'session-state', cli, 'events.jsonl');
    if (!existsSync(file)) {
      missing.push(cli);
      continue;
    }
    let order = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      events.push({ raw, cli, order: order += 1, id: raw.id ?? null, type: raw.type, data: raw.data ?? {}, at: Date.parse(raw.timestamp) || 0, agentId: raw.agentId ?? null });
    }
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  return { events, missing, malformed };
}

const own = event => !event.agentId && !event.data.parentToolCallId;
const isHuman = event => event.type === 'user.message' && own(event) && !event.data.source
  && !text(event.data.content).startsWith('<system_notification>')
  && !text(event.data.content).includes('<cross_session_message>') && !text(event.data.transformedContent).includes('<cross_session_message>');

function toolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    if (!own(event)) continue;
    if (event.type === 'tool.execution_start') calls.set(event.data.toolCallId, { start: event, done: calls.get(event.data.toolCallId)?.done ?? null });
    if (event.type === 'tool.execution_complete') {
      const call = calls.get(event.data.toolCallId) ?? { start: null, done: null };
      call.done = event;
      calls.set(event.data.toolCallId, call);
    }
  }
  return [...calls.values()].filter(call => call.start);
}

const okOf = call => Boolean(call.done && call.done.data.success);
const resultOf = call => text(call.done?.data.result?.content);
const errorOf = call => `${text(call.done?.data.error?.message)} ${text(call.done?.data.error?.code)}`.trim();

function statusLine(message) {
  const first = text(message).split(/\r?\n/, 1)[0].trim();
  if (!first.startsWith('swarm-status:')) return { status: null, unit: null, commit: null };
  const [status, ...tokens] = first.slice('swarm-status:'.length).trim().split(/\s+/);
  const field = name => tokens.find(token => token.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  return { status, unit: field('unit'), commit: field('commit') };
}

/** Commands of a shell line, split on &&, ||, ; and newlines, without leading cd steps. */
function commandsOf(line) {
  return text(line).split(/&&|\|\||;|\n/).map(part => part.trim()).filter(part => part && !part.startsWith('cd '));
}

function commandResults(events, calls) {
  const outputs = calls.filter(call => ['bash', 'read_bash'].includes(call.start.data.toolName)).map(call => ({ call, out: resultOf(call) }));
  const status = { test: 'not run', validate: 'not run' };
  const runs = [];
  for (const { call } of outputs) {
    if (call.start.data.toolName !== 'bash') continue;
    const parts = commandsOf(call.start.data.arguments?.command);
    const kinds = [];
    if (parts.some(part => /^npm (test|run test)\b/.test(part))) kinds.push('test');
    if (parts.some(part => /^npm run validate\b/.test(part))) kinds.push('validate');
    if (!kinds.length) continue;
    const denied = call.done?.data.error?.code === 'denied' || /permission denied|denied because|requires approval/i.test(errorOf(call));
    runs.push({ toolCallId: call.start.data.toolCallId, at: iso(call.start.at), kinds, exitCode: call.done?.data.shellExecution?.exitCode ?? null, ok: okOf(call), denied });
    for (const kind of kinds) if (denied && status[kind] === 'not run') status[kind] = 'denied';
  }
  const all = outputs.map(item => item.out).join('\n');
  const passCounts = [...all.matchAll(/ℹ pass (\d+)/g)].map(match => Number(match[1]));
  const failCounts = [...all.matchAll(/ℹ fail (\d+)/g)].map(match => Number(match[1]));
  if (runs.some(run => run.kinds.includes('test') && !run.denied)) {
    if (failCounts.some(count => count > 0) && !(failCounts.at(-1) === 0)) status.test = 'failed';
    else if (passCounts.some(count => count > 0) && failCounts.includes(0)) status.test = 'passed';
    else status.test = 'no result';
  }
  if (runs.some(run => run.kinds.includes('validate') && !run.denied)) {
    if (all.includes('Plugin validation passed')) status.validate = 'passed';
    else if (runs.some(run => run.kinds.includes('validate') && run.exitCode !== null && run.exitCode !== 0)) status.validate = 'failed';
    else status.validate = 'no result';
  }
  return { status, runs, testCounts: passCounts };
}

function costBetween(usageOf, events, from, to) {
  const seen = new Set();
  let window = 0;
  let total = 0;
  for (const event of events) {
    const usage = usageOf(event.raw);
    if (!usage || seen.has(usage.key)) continue;
    seen.add(usage.key);
    total += usage.nanoAiu;
    if (from !== null && to !== null && usage.at !== null && usage.at >= from && usage.at <= to) window += usage.nanoAiu;
  }
  return { windowUsd: from !== null && to !== null ? window / NANO_AIU_PER_USD : null, totalUsd: total / NANO_AIU_PER_USD };
}

function findReady(events, start, prs, baseBranch) {
  const rejected = [];
  for (const event of events) {
    if (!own(event) || start === null || event.at <= start.at) continue;
    let body = null;
    let via = null;
    if (event.type === 'assistant.message') {
      body = text(event.data.content);
      via = 'message';
    } else if (event.type === 'tool.execution_start' && event.data.toolName === 'ask_user') {
      body = text(event.data.arguments?.question).replace(/^\s*\[[^\]\n]*\]\s*/, '');
      via = 'ask_user';
    }
    if (body === null || !body.includes(MARKER)) continue;
    const match = READY_LINE.exec(body.trimStart());
    if (!match) {
      rejected.push({ at: iso(event.at), reason: 'the marker is not at the start, or no PR URL follows it' });
      continue;
    }
    const pr = prs.find(item => item.url === match[1] || item.number === Number(match[2]));
    if (!pr) {
      rejected.push({ at: iso(event.at), reason: `no readback for ${match[1]}` });
      continue;
    }
    if (baseBranch && pr.baseRefName !== baseBranch) {
      rejected.push({ at: iso(event.at), reason: `PR base ${pr.baseRefName} is not ${baseBranch}` });
      continue;
    }
    if (Date.parse(pr.createdAt) > event.at) {
      rejected.push({ at: iso(event.at), reason: 'the PR was created after the message' });
      continue;
    }
    return { ready: { at: event.at, eventId: event.id, via, prUrl: pr.url, headAtReadback: pr.headRefOid }, rejected };
  }
  return { ready: null, rejected };
}

function measureArm(arm, runArm, ids, home, usageOf) {
  const coordinator = readLogs(home, arm.coordinatorCliIds);
  const calls = toolCalls(coordinator.events);
  const human = coordinator.events.filter(isHuman);
  const startEvent = runArm.marker ? human.find(event => text(event.data.content).includes(runArm.marker)) : human[0];
  const start = startEvent ? { at: startEvent.at, eventId: startEvent.id } : null;
  const prs = ids.prs ?? [];
  const { ready, rejected } = findReady(coordinator.events, start, prs, runArm.baseBranch ?? null);
  const coordinatorIds = new Set([arm.rootSessionId, arm.snapshotId, ...arm.coordinatorCliIds]);

  const sessions = calls.filter(call => SESSION_TOOLS.has(call.start.data.toolName)).map(call => {
    const args = call.start.data.arguments ?? {};
    const result = resultOf(call);
    return {
      tool: call.start.data.toolName, toolCallId: call.start.data.toolCallId, at: iso(call.start.at), ok: okOf(call),
      childId: /\((?:id|session_id): ([0-9a-f-]{36})\)/.exec(result)?.[1] ?? null, assignmentId: /Assignment ID: (assignment:[^\s.]+(?:\.[^\s.]+)*)\./.exec(result)?.[1] ?? null,
      requested: { model: args.kickoff?.model ?? null, effort: args.kickoff?.reasoning_effort ?? null, mode: args.kickoff?.mode ?? null, agent: args.kickoff?.agent ?? null },
      coordinate: args.coordinate_with_creator ?? null, notifyOnIdle: args.notify_on_idle ?? null, baseBranch: args.base_branch ?? null,
      kickoffHead: text(args.kickoff?.prompt).slice(0, 400),
    };
  });
  const started = new Map(coordinator.events.filter(event => event.type === 'subagent.started').map(event => [event.data.toolCallId, event.data]));
  const tasks = calls.filter(call => call.start.data.toolName === 'task').map(call => {
    const args = call.start.data.arguments ?? {};
    const run = started.get(call.start.data.toolCallId);
    return { toolCallId: call.start.data.toolCallId, at: iso(call.start.at), requested: { agentType: args.agent_type ?? null, model: args.model ?? null, effort: args.reasoning_effort ?? null, mode: args.mode ?? null }, startedModel: run?.model ?? null, startedAgent: run?.agentName ?? null };
  });
  const inWindow = at => start !== null && at >= start.at && (ready === null || at <= ready.at);
  const answers = [];
  for (const call of calls) {
    const tool = call.start.data.toolName;
    if (!call.done || !['ask_user', 'relay_session_input'].includes(tool) || !inWindow(call.done.at)) continue;
    let answered = false;
    if (tool === 'ask_user') answered = okOf(call) && resultOf(call).startsWith('User responded');
    else {
      try {
        answered = okOf(call) && /^answered/.test(JSON.parse(resultOf(call)).outcome ?? '');
      } catch {
        answered = false;
      }
    }
    answers.push({ tool, toolCallId: call.start.data.toolCallId, at: iso(call.done.at), answered });
  }
  const humanInWindow = human.filter(event => inWindow(event.at));
  let waitMs = 0;
  for (const answer of answers.filter(item => item.answered)) {
    const call = calls.find(item => item.start.data.toolCallId === answer.toolCallId);
    waitMs += call.done.at - call.start.at;
  }
  for (const message of humanInWindow.slice(1)) {
    const asked = coordinator.events.filter(event => own(event) && event.type === 'assistant.message' && event.at < message.at).at(-1);
    if (asked && asked.at >= start.at) waitMs += message.at - asked.at;
  }
  const compactions = coordinator.events.filter(event => event.type === 'session.compaction_complete');
  const manual = compactions.find(event => ready !== null && event.at > ready.at && event.data.success && event.data.outcome === 'applied' && !['threshold', 'model_switch'].includes(event.data.trigger));
  let recovery = null;
  if (manual) {
    const after = coordinator.events.filter(event => event.at > manual.at && own(event));
    const firstChange = after.find(event => event.type === 'tool.execution_start' && (STATE_CHANGING.has(event.data.toolName) || (event.data.toolName === 'bash' && /gh pr merge/.test(text(event.data.arguments?.command)))));
    const before = event => !firstChange || event.at < firstChange.at;
    const callsAfter = calls.filter(call => call.start.at > manual.at && before(call.start));
    const active = (arm.children ?? []).filter(kid => !kid.archivedAt || Date.parse(kid.archivedAt) > manual.at);
    const checked = callsAfter.filter(call => call.start.data.toolName === 'get_session' && okOf(call)).map(call => call.start.data.arguments?.project_session_id);
    recovery = {
      compactionAt: iso(manual.at), trigger: manual.data.trigger ?? null, firstStateChange: firstChange ? { at: iso(firstChange.at), tool: firstChange.data.toolName } : null,
      skillLoads: after.filter(event => event.type === 'skill.invoked' && before(event)).map(event => ({ at: iso(event.at), name: event.data.name, plugin: event.data.pluginName ?? null })),
      sqlReads: callsAfter.filter(call => call.start.data.toolName === 'sql').map(call => ({ at: iso(call.start.at), ok: okOf(call), query: text(call.start.data.arguments?.query).slice(0, 200) })),
      activeChildren: active.map(kid => kid.workspaceId ?? kid.cliIds[0]),
      notChecked: active.filter(kid => !checked.some(id => id === kid.workspaceId || kid.cliIds.includes(id))).map(kid => kid.workspaceId ?? kid.cliIds[0]),
      sessionsCreatedAfter: sessions.filter(item => Date.parse(item.at) > manual.at).map(item => ({ at: item.at, kickoffHead: item.kickoffHead.slice(0, 160) })),
    };
  }

  const assignmentsByChild = new Map();
  for (const row of arm.assignments ?? []) {
    const list = assignmentsByChild.get(row.child_session_id) ?? [];
    list.push(row.id);
    assignmentsByChild.set(row.child_session_id, list);
  }
  const allEvents = [...coordinator.events];
  const children = (arm.children ?? []).map(kid => {
    const log = readLogs(home, kid.cliIds);
    allEvents.push(...log.events);
    const kidCalls = toolCalls(log.events);
    const first = log.events.find(event => event.type === 'session.start');
    const worker = log.events.find(event => own(event) && event.type === 'skill.invoked' && event.data.name === 'wintermute-project-worker');
    const firstWork = log.events.find(event => own(event) && event.type === 'tool.execution_start' && !['skill', 'report_intent'].includes(event.data.toolName));
    const known = new Set(kid.cliIds.flatMap(cli => assignmentsByChild.get(cli) ?? []));
    const request = sessions.find(item => item.childId && (kid.cliIds.includes(item.childId) || item.childId === kid.workspaceId));
    const reports = kidCalls.filter(call => call.start.data.toolName === 'send_session_message').map(call => {
      const args = call.start.data.arguments ?? {};
      const line = statusLine(args.message);
      const lines = text(args.message).split(/\r?\n/).filter(item => item.trim()).length;
      return {
        toolCallId: call.start.data.toolCallId, at: iso(call.start.at), ok: okOf(call), toCoordinator: coordinatorIds.has(args.session_id), ...line,
        purpose: args.purpose ?? null, purposeMatches: line.status !== null && PURPOSE[line.status] === args.purpose,
        assignmentId: args.assignment_id ?? null, assignmentKnown: arm.kind === 'project' ? known.has(args.assignment_id) : null, lines,
        text: ['needs_input', 'blocked'].includes(line.status) ? text(args.message) : text(args.message).slice(0, 300),
      };
    });
    return {
      name: kid.name, workspaceId: kid.workspaceId, cliIds: kid.cliIds, branch: kid.branch, archivedAt: kid.archivedAt, missingLogs: log.missing, malformedLines: log.malformed,
      requested: request?.requested ?? null, assignmentFromCreate: request?.assignmentId ?? null,
      effective: first ? { model: first.data.selectedModel ?? null, effort: first.data.reasoningEffort ?? null } : null,
      workerSkill: worker ? { at: iso(worker.at), plugin: worker.data.pluginName ?? null, source: worker.data.source ?? null } : null,
      firstWork: firstWork ? { at: iso(firstWork.at), tool: firstWork.data.toolName } : null,
      workerSkillFirst: log.events.length === 0 ? null : Boolean(worker) && (!firstWork || worker.at < firstWork.at),
      coordinatorSkillLoaded: log.events.some(event => event.type === 'skill.invoked' && event.data.name === 'wintermute-project'),
      reports, commands: commandResults(log.events, kidCalls),
      publishes: kidCalls.filter(call => call.start.data.toolName === 'publish_chat_update').map(call => ({ at: iso(call.start.at), ok: okOf(call), kinds: (call.start.data.arguments?.attachments ?? []).map(item => item.kind) })),
    };
  });
  const cost = costBetween(usageOf, allEvents, start?.at ?? null, ready?.at ?? null);
  return {
    arm: arm.arm, rootSessionId: arm.rootSessionId, coordinatorCliIds: arm.coordinatorCliIds, missingLogs: coordinator.missing, malformedLines: coordinator.malformed,
    runtimeVersion: coordinator.events.find(event => event.type === 'session.start')?.data.copilotVersion ?? null,
    start: start ? { at: iso(start.at), eventId: start.eventId } : null,
    ready: ready ? { ...ready, at: iso(ready.at) } : null, readyRejected: rejected,
    wallMinutes: start && ready ? (ready.at - start.at) / 60000 : null,
    userWaitMinutes: start && ready ? waitMs / 60000 : null,
    workingMinutes: start && ready ? (ready.at - start.at - waitMs) / 60000 : null,
    costToReadyUsd: cost.windowUsd, totalUsd: cost.totalUsd,
    userActionsToReady: start && ready ? humanInWindow.length + answers.filter(item => item.answered).length : null,
    humanMessages: humanInWindow.map(event => ({ at: iso(event.at), eventId: event.id, head: text(event.data.content).slice(0, 80) })), answers,
    skills: coordinator.events.filter(event => event.type === 'skill.invoked' && own(event)).map(event => ({ at: iso(event.at), name: event.data.name, plugin: event.data.pluginName ?? null, trigger: event.data.trigger ?? null })),
    memorySaves: calls.filter(call => call.start.data.toolName === 'update_project_memory').map(call => ({ at: iso(call.start.at), ok: okOf(call) })),
    rulesLoadedLines: coordinator.events.filter(event => own(event) && event.type === 'assistant.message' && text(event.data.content).trimStart().startsWith('wintermute-project rules loaded.')).map(event => iso(event.at)),
    stateReadsOrChanges: calls.filter(call => STATE_CHANGING.has(call.start.data.toolName) || ['sql', 'get_session'].includes(call.start.data.toolName)).map(call => ({ at: iso(call.start.at), tool: call.start.data.toolName })),
    sessions, tasks,
    publishes: calls.filter(call => call.start.data.toolName === 'publish_chat_update').map(call => ({ at: iso(call.start.at), ok: okOf(call), agentSession: call.start.data.arguments?.agent_session_id ?? null, attachments: (call.start.data.arguments?.attachments ?? []).map(item => ({ kind: item.kind, url: item.url ?? null, source: item.source_session_id ?? null })) })),
    merges: calls.filter(call => call.start.data.toolName === 'bash' && /gh pr merge/.test(text(call.start.data.arguments?.command))).map(call => ({ at: iso(call.start.at), command: text(call.start.data.arguments.command).slice(0, 240), exitCode: call.done?.data.shellExecution?.exitCode ?? null, ok: okOf(call) })),
    compactions: compactions.map(event => ({ at: iso(event.at), trigger: event.data.trigger ?? null, outcome: event.data.outcome ?? null })), recovery, children,
  };
}

/** The worse of two bands: go < decide < no-go < not measured. */
const BANDS = ['go', 'decide', 'no-go', 'not measured'];
const bandOf = ratio => (ratio === null || !Number.isFinite(ratio) ? 'not measured' : ratio <= 1.5 ? 'go' : ratio <= 2 ? 'decide' : 'no-go');
const worse = (a, b) => BANDS[Math.max(BANDS.indexOf(a), BANDS.indexOf(b))];

function smokeVerdict(project, negative, caps) {
  const optInMessage = project.humanMessages[0]?.head.startsWith('/wintermute-project') ?? false;
  const loaded = project.skills.find(skill => skill.name === 'wintermute-project' && skill.plugin === 'wintermute');
  const negLoaded = negative?.skills.find(skill => skill.name === 'wintermute-project');
  const negActed = negLoaded ? negative.stateReadsOrChanges.some(item => Date.parse(item.at) >= Date.parse(negLoaded.at)) || negative.rulesLoadedLines.length > 0 : false;
  const dispatch = project.sessions.find(item => item.ok && item.requested.model && item.requested.effort && !item.requested.agent);
  const child = dispatch ? project.children.find(kid => kid.cliIds.includes(dispatch.childId) || kid.workspaceId === dispatch.childId) : null;
  const handoff = child?.reports.find(report => report.ok && report.toCoordinator && report.status === 'complete' && report.purpose === 'handoff' && report.assignmentId === dispatch.assignmentId);
  const end = handoff ? Date.parse(handoff.at) : null;
  const minutes = project.start && end ? (end - Date.parse(project.start.at)) / 60000 : null;
  const cost = (project.costToHandoffUsd ?? Infinity) + (negative?.totalUsd ?? 0);
  const checks = {
    optIn: negative === null ? 'not measured' : optInMessage && loaded && !(negLoaded && negActed) ? 'pass' : 'fail',
    dispatch: !dispatch || !child ? 'fail' : child.effective === null ? 'not measured' : child.effective.model === dispatch.requested.model && child.effective.effort === dispatch.requested.effort ? 'pass' : 'fail',
    handoff: handoff ? 'pass' : 'fail',
    tests: !child ? 'fail' : child.commands.status.test === 'passed' && child.commands.status.validate === 'passed' ? 'pass' : child.commands.runs.some(run => run.denied) || ['failed'].includes(child.commands.status.test) || ['failed'].includes(child.commands.status.validate) ? 'fail' : 'not measured',
    caps: minutes !== null && minutes <= caps.minutes && cost <= caps.usd ? 'pass' : 'fail',
  };
  return { checks, minutesToHandoff: minutes, totalUsd: cost, negativeLoadedSkill: Boolean(negLoaded), negativeActedAfterLoad: negActed };
}

export async function measure(runDir, home, usageOf) {
  const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const ids = JSON.parse(readFileSync(path.join(runDir, 'ids.json'), 'utf8'));
  const arms = {};
  for (const runArm of run.arms) {
    const arm = ids.arms.find(item => item.arm === runArm.arm);
    arms[runArm.arm] = arm?.resolved ? measureArm(arm, runArm, ids, home, usageOf) : null;
  }
  const out = { runId: run.runId, mode: run.mode, measuredAt: new Date().toISOString(), arms, problems: ids.problems ?? [] };
  if (run.mode === 'smoke' && arms.project) {
    const kidReports = arms.project.children.flatMap(kid => kid.reports).filter(report => report.ok && report.purpose === 'handoff');
    const end = kidReports.length ? Date.parse(kidReports[0].at) : null;
    const events = readLogs(home, [...ids.arms.find(item => item.arm === 'project').coordinatorCliIds, ...ids.arms.find(item => item.arm === 'project').children.flatMap(kid => kid.cliIds)]).events;
    arms.project.costToHandoffUsd = end === null ? null : costBetween(usageOf, events, Date.parse(arms.project.start?.at), end).windowUsd;
    out.smoke = smokeVerdict(arms.project, arms.negative ?? null, run.caps);
  }
  else {
    const project = arms.project;
    const baseline = arms.baseline;
    const ratio = key => (project?.[key] !== null && project?.[key] !== undefined && baseline?.[key] ? project[key] / baseline[key] : null);
    const cost = ratio('costToReadyUsd');
    const wall = ratio('workingMinutes');
    out.comparison = {
      costRatio: cost, workingTimeRatio: wall, wallRatio: ratio('wallMinutes'), f8: worse(bandOf(cost), bandOf(wall)),
      userActionsDifference: project?.userActionsToReady !== null && project?.userActionsToReady !== undefined && baseline?.userActionsToReady !== null && baseline?.userActionsToReady !== undefined ? project.userActionsToReady - baseline.userActionsToReady : null,
    };
    const diff = out.comparison.userActionsDifference;
    out.comparison.f9 = diff === null ? 'not measured' : diff <= 1 ? 'go' : diff === 2 ? 'decide' : 'no-go';
    out.baselineLoadedProjectSkill = baseline ? baseline.skills.some(skill => skill.name === 'wintermute-project') : null;
  }
  writeFileSync(path.join(runDir, 'measure.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** Synthetic logs for the self-test: one Project arm with a child, and a baseline arm. */
function selfTest(usageOf) {
  const home = mkdtempSync(path.join(tmpdir(), 'wm-measure-'));
  const runDir = path.join(home, 'run');
  mkdirSync(runDir);
  const t = minute => new Date(Date.UTC(2026, 10, 20, 10, 0) + minute * 60000).toISOString();
  let n = 0;
  const logs = {};
  const ev = (cli, minute, type, data, extra = {}) => (logs[cli] ??= []).push({ type, id: `e${n += 1}`, timestamp: t(minute), data, ...extra });
  const usage = (cli, minute, usd, id) => ev(cli, minute, 'session.usage_record', { usage: { model: 'claude-opus-5.5', accounting: { usageId: id, sourceSessionId: cli }, copilotUsage: { totalNanoAiu: usd * NANO_AIU_PER_USD } } });
  const tool = (cli, minute, name, args, done, extra = {}) => {
    const id = `call${n += 1}`;
    ev(cli, minute, 'tool.execution_start', { toolCallId: id, toolName: name, arguments: args }, extra);
    if (done) ev(cli, done.minute ?? minute, 'tool.execution_complete', { toolCallId: id, ...done.data }, extra);
    return id;
  };
  const P = 'p-root';
  const C = '11111111-1111-1111-1111-111111111111';
  const B = 'b-root';
  ev(P, 0, 'user.message', { content: '<system_notification>repos</system_notification>' });
  ev(P, 0.2, 'user.message', { content: '/wintermute-project wm-trial-x project: add the test' });
  ev(P, 0.3, 'skill.invoked', { name: 'wintermute-project', pluginName: 'wintermute', trigger: 'user-invoked' });
  ev(P, 1, 'assistant.message', { content: `I will write ${MARKER} https://github.com/o/r/pull/7 when the PR is ready.` });
  ev(P, 1.5, 'assistant.message', { content: `${MARKER} soon` });
  ev(P, 2, 'assistant.message', { content: `${MARKER} https://github.com/o/r/pull/7` }, { agentId: 'sub1' });
  ev(P, 3, 'user.message', { content: 'looks human', transformedContent: '<cross_session_message>from a peer</cross_session_message>' });
  tool(P, 4, 'ask_user', { question: '[unit=* need=plan] Approve?' }, { minute: 5, data: { success: true, result: { content: 'User responded: yes' } } });
  tool(P, 6, 'create_session', { kickoff: { model: 'claude-opus-5.5', reasoning_effort: 'medium', mode: 'autopilot', prompt: 'Load the `wintermute-project-worker` skill now' }, coordinate_with_creator: true, notify_on_idle: 'once' },
    { data: { success: true, result: { content: `Created session 'u1' (id: 11111111-1111-1111-1111-111111111111) in project 'r'. Assignment ID: assignment:${P}:callX.` } } });
  usage(P, 6, 4, 'u-before');
  usage(P, 20.5, 1, 'u-after-ready-same-bucket');
  ev(P, 20, 'assistant.message', { content: `${MARKER} https://github.com/o/r/pull/7` });
  tool(P, 21, 'ask_user', { question: 'Merge?' }, { minute: 22, data: { success: true, result: { content: 'User responded: later' } } });
  ev(P, 25, 'session.compaction_complete', { success: true, outcome: 'applied', trigger: 'threshold' });
  ev(P, 30, 'session.compaction_complete', { success: true, outcome: 'applied', trigger: 'manual' });
  ev(P, 31, 'skill.invoked', { name: 'wintermute-project', pluginName: 'wintermute', trigger: 'agent-invoked' });
  tool(P, 31.5, 'sql', { query: 'SELECT * FROM children' }, { data: { success: true, result: { content: '[]' } } });
  tool(P, 32, 'get_session', { project_session_id: C }, { data: { success: true, result: { content: '{}' } } });
  tool(P, 33, 'bash', { command: 'gh pr merge 7 -R o/r --squash --match-head-commit abc1234' }, { data: { success: true, shellExecution: { exitCode: 0 }, result: { content: '' } } });
  ev(C, 6.5, 'session.start', { selectedModel: 'claude-opus-5.5', reasoningEffort: 'medium' });
  ev(C, 7, 'skill.invoked', { name: 'wintermute-project-worker', pluginName: 'wintermute', source: 'plugin' });
  tool(C, 8, 'bash', { command: 'echo "npm test"' }, { data: { success: true, shellExecution: { exitCode: 0 }, result: { content: 'npm test' } } });
  tool(C, 9, 'bash', { command: 'cd ghcp/plugins/wintermute && npm test 2>&1 | tail -3 && npm run validate' }, { data: { success: true, shellExecution: { exitCode: 0 }, result: { content: 'ℹ pass 1162\nℹ fail 0\nPlugin validation passed: manifests' } } });
  usage(C, 9, 2, 'u-child');
  tool(C, 10, 'send_session_message', { session_id: P, purpose: 'handoff', assignment_id: `assignment:${P}:callX`, message: 'swarm-status: complete unit=u1 commit=abc1234\nSummary: Pushed.' }, { data: { success: true, result: { content: 'saved' } } });
  tool(C, 11, 'send_session_message', { session_id: P, purpose: 'handoff', assignment_id: 'assignment:other:wrong', message: 'swarm-status: complete unit=u1\nSummary: Again.\nEvidence:\n- x' }, { data: { success: true, result: { content: 'saved' } } });
  ev(B, 0, 'user.message', { content: 'wm-trial-x baseline: add the test' });
  tool(B, 10, 'bash', { command: 'npm test' }, { data: { success: false, error: { message: 'Permission denied because no interactive user response was available.', code: 'denied' } } });
  usage(B, 10, 2.5, 'u-base');
  tool(B, 15, 'ask_user', { question: `[unit=t need=pr] ${MARKER} https://github.com/o/r/pull/8 Merge?` }, null);
  for (const [cli, events] of Object.entries(logs)) {
    mkdirSync(path.join(home, 'session-state', cli), { recursive: true });
    writeFileSync(path.join(home, 'session-state', cli, 'events.jsonl'), `${events.map(item => JSON.stringify(item)).join('\n')}\n{broken\n`);
  }
  writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'wm-trial-x', mode: 'trial', arms: [
    { arm: 'project', kind: 'project', marker: 'wm-trial-x project', baseBranch: 'wm-trial-x-project-base' },
    { arm: 'baseline', kind: 'session', marker: 'wm-trial-x baseline', baseBranch: 'wm-trial-x-baseline-base' },
  ] }));
  writeFileSync(path.join(runDir, 'ids.json'), JSON.stringify({ arms: [
    { arm: 'project', kind: 'project', resolved: true, rootSessionId: P, snapshotId: P, coordinatorCliIds: [P], assignments: [{ id: `assignment:${P}:callX`, child_session_id: C }], children: [{ workspaceId: 'w1', cliIds: [C], name: 'u1', archivedAt: null }] },
    { arm: 'baseline', kind: 'session', resolved: true, rootSessionId: B, snapshotId: B, coordinatorCliIds: [B], assignments: [], children: [] },
  ], prs: [
    { url: 'https://github.com/o/r/pull/7', number: 7, baseRefName: 'wm-trial-x-project-base', createdAt: t(15), headRefOid: 'abc1234' },
    { url: 'https://github.com/o/r/pull/8', number: 8, baseRefName: 'wm-trial-x-baseline-base', createdAt: t(12), headRefOid: 'def5678' },
  ] }));
  return measure(runDir, home, usageOf).then(out => {
    const p = out.arms.project;
    const b = out.arms.baseline;
    const kid = p.children[0];
    assert.equal(p.start.at, t(0.2), 'the start is the marked human message, not the app notice');
    assert.equal(p.ready.at, t(20), 'an early echo, a marker without a URL and a sub-agent message are not ready');
    assert.equal(p.readyRejected.length, 2);
    assert.equal(p.wallMinutes, 19.8);
    assert.equal(p.userWaitMinutes, 1, 'the plan question waited one minute for the user');
    assert.equal(p.workingMinutes, 18.8);
    assert.equal(p.costToReadyUsd, 6, 'usage after ready is excluded, even in the same 5-minute bucket');
    assert.equal(p.totalUsd, 7);
    assert.equal(p.userActionsToReady, 2, 'the opt-in prompt and the answered plan question; not the peer message or the later answer');
    assert.equal(p.recovery.trigger, 'manual');
    assert.deepEqual(p.recovery.notChecked, []);
    assert.deepEqual(p.recovery.firstStateChange, { at: t(33), tool: 'bash' }, 'the merge is the first state change after the manual compaction');
    assert.deepEqual(p.recovery.skillLoads.map(item => item.name), ['wintermute-project']);
    assert.equal(p.merges[0].exitCode, 0);
    assert.equal(p.malformedLines, 1);
    assert.equal(kid.workerSkillFirst, true);
    assert.deepEqual(kid.effective, { model: 'claude-opus-5.5', effort: 'medium' });
    assert.deepEqual(kid.requested, kid.effective && { model: 'claude-opus-5.5', effort: 'medium', mode: 'autopilot', agent: null });
    assert.equal(kid.commands.status.test, 'passed', 'the echo is not a test run; the piped run passes on its summary');
    assert.equal(kid.commands.status.validate, 'passed');
    assert.deepEqual(kid.reports.map(report => [report.assignmentKnown, report.purposeMatches, report.lines]), [[true, true, 2], [false, true, 4]]);
    assert.equal(b.ready.via, 'ask_user');
    assert.equal(b.wallMinutes, 15);
    assert.equal(b.costToReadyUsd, 2.5);
    assert.equal(out.comparison.costRatio, 6 / 2.5);
    assert.equal(out.comparison.workingTimeRatio, 18.8 / 15);
    assert.equal(out.comparison.f8, 'no-go');
    assert.equal(out.comparison.userActionsDifference, 1);
    const N = 'n-root';
    ev(N, 0, 'user.message', { content: 'wm-trial-x negative: how would you split this work? Reply with a plan only.' });
    const smokeRun = { runId: 'wm-trial-x', mode: 'smoke', caps: { minutes: 30, usd: 15 }, arms: [
      { arm: 'project', kind: 'project', marker: 'wm-trial-x project' }, { arm: 'negative', kind: 'project', marker: 'wm-trial-x negative' },
    ] };
    const ids = JSON.parse(readFileSync(path.join(runDir, 'ids.json'), 'utf8'));
    ids.arms[1] = { arm: 'negative', kind: 'project', resolved: true, rootSessionId: N, snapshotId: N, coordinatorCliIds: [N], assignments: [], children: [] };
    const write = () => {
      mkdirSync(path.join(home, 'session-state', N), { recursive: true });
      writeFileSync(path.join(home, 'session-state', N, 'events.jsonl'), `${logs[N].map(item => JSON.stringify(item)).join('\n')}\n`);
      writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(smokeRun));
      writeFileSync(path.join(runDir, 'ids.json'), JSON.stringify(ids));
    };
    write();
    return measure(runDir, home, usageOf).then(smoke => {
      assert.deepEqual(smoke.smoke.checks, { optIn: 'pass', dispatch: 'pass', handoff: 'pass', tests: 'pass', caps: 'pass' });
      assert.equal(smoke.smoke.minutesToHandoff, 9.8);
      ev(N, 1, 'skill.invoked', { name: 'wintermute-project', pluginName: 'wintermute', trigger: 'agent-invoked' });
      tool(N, 2, 'sql', { query: 'SELECT * FROM children' }, { data: { success: true, result: { content: '[]' } } });
      write();
      return measure(runDir, home, usageOf);
    }).then(smoke => {
      assert.equal(smoke.smoke.checks.optIn, 'fail', 'a Project that never opted in loaded the skill and read state');
      rmSync(home, { recursive: true, force: true });
      return 'self-test passed';
    });
  });
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const opts = { 'copilot-home': path.join(homedir(), '.copilot') };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--self-test') opts['self-test'] = true;
    else opts[argv[index].replace(/^--/, '')] = argv[index += 1];
  }
  if (!opts.plugin) throw new Error('Missing --plugin <path to ghcp/plugins/wintermute>');
  const { usageOf } = await import(pathToFileURL(path.join(path.resolve(opts.plugin), 'engine/readers/ledger.mjs')).href);
  if (opts['self-test']) console.log(await selfTest(usageOf));
  else {
    const out = await measure(path.resolve(opts['run-dir']), opts['copilot-home'], usageOf);
    console.log(JSON.stringify(out.mode === 'smoke' ? out.smoke : out.comparison, null, 2));
  }
}
````

- [ ] **Step 4: Write the finalizer**

Create `$RUN_DIR/wm-finalize.mjs`:

````js
#!/usr/bin/env node
// The one finalizer for a wintermute Projects run, for every exit: success, abort, timeout, failure or a rerun.
//   plan            lists what the run left (open PRs, branches, sessions, dirty worktrees) in cleanup-plan.json; changes nothing
//   apply           closes the listed PRs and deletes the listed branches, only after the user approved the plan's digest
//   remove-run-dir  removes this run's own folder under ~/wm-runs
// Run node wm-collect.mjs --run-dir <dir> first, so that ids.json is current. Every step can be run again safely.
// Usage: node wm-finalize.mjs plan --run-dir <dir>
//        node wm-finalize.mjs apply --run-dir <dir> --approved <digest>
//        node wm-finalize.mjs remove-run-dir --run-dir <dir>
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let index = 0; index < rest.length; index += 2) opts[rest[index].replace(/^--/, '')] = rest[index + 1];
if (!['plan', 'apply', 'remove-run-dir'].includes(command) || !opts['run-dir']) {
  throw new Error('Usage: node wm-finalize.mjs <plan|apply|remove-run-dir> --run-dir <dir> [--approved <digest>]');
}
const runDir = path.resolve(opts['run-dir']);
const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
const remoteUrl = run.remote ?? `https://github.com/${run.repo}.git`;
const PROTECTED = new Set(['main', 'master', run.defaultBranch ?? 'main']);
const planFile = path.join(runDir, 'cleanup-plan.json');
const at = () => new Date().toISOString();
const log = (key, value) => appendFileSync(path.join(runDir, 'inventory.jsonl'), `${JSON.stringify({ at: at(), key, value })}\n`);
const digestOf = file => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);

function exec(args) {
  try {
    return { ok: true, out: execFileSync(args[0], args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (error) {
    return { ok: false, out: String(error.stderr || error.message).trim().slice(0, 300) };
  }
}

/** A private, empty repository in the run folder: git push needs one, even to delete a remote branch. */
function pushRepo() {
  const dir = path.join(runDir, 'push.git');
  if (!existsSync(dir)) execFileSync('git', ['init', '--quiet', '--bare', dir]);
  return dir;
}

function remoteSha(branch) {
  const result = exec(['git', 'ls-remote', '--heads', remoteUrl, `refs/heads/${branch}`]);
  return result.ok ? { sha: result.out.split(/\s+/)[0] || null } : { error: result.out };
}

function plan() {
  const ids = JSON.parse(readFileSync(path.join(runDir, 'ids.json'), 'utf8'));
  const created = Date.parse(run.createdAt);
  const bases = new Set((run.baseBranches ?? []).map(base => base.name));
  const owned = new Map([...bases].map(name => [name, 'run base branch']));
  const sessions = [];
  const dirty = [];
  const needsUser = [...(ids.problems ?? []).map(problem => `identity: ${problem}`)];
  for (const arm of ids.arms) {
    if (!arm.resolved) {
      needsUser.push(`arm ${arm.arm} was not found; if its session exists, find and clean it by hand`);
      continue;
    }
    if (arm.rootBranch && Date.parse(arm.createdAt) >= created) owned.set(arm.rootBranch, `${arm.arm} root session branch`);
    for (const kid of arm.children) {
      if (kid.branch && Date.parse(kid.createdAt) >= created) owned.set(kid.branch, `${arm.arm} child "${kid.name}"`);
      if (!kid.archivedAt && Date.parse(kid.createdAt) >= created) sessions.push({ arm: arm.arm, name: kid.name, ids: kid.cliIds, order: 1 });
      else if (!kid.archivedAt) needsUser.push(`session "${kid.name}" existed before the run: leave it as it is`);
      if (kid.worktreePath && existsSync(kid.worktreePath)) {
        const status = exec(['git', '-C', kid.worktreePath, 'status', '--porcelain', '--untracked-files=all']);
        if (!status.ok || status.out) dirty.push({ name: kid.name, path: kid.worktreePath, status: status.out.slice(0, 200) });
      }
    }
    if (!arm.archivedAt) sessions.push({ arm: arm.arm, name: arm.title, ids: [arm.rootSessionId], order: 2 });
  }
  const prs = [];
  for (const pr of ids.prs ?? []) {
    const ours = bases.has(pr.baseRefName) || owned.has(pr.headRefName);
    if (!ours) continue;
    if (!bases.has(pr.baseRefName)) {
      needsUser.push(`PR ${pr.url} targets ${pr.baseRefName}, not a run base branch: leave it to the user`);
      owned.delete(pr.headRefName);
      continue;
    }
    if (pr.state === 'OPEN') prs.push({ url: pr.url, expectedHead: pr.headRefOid });
  }
  const branches = [];
  for (const [name, why] of [...owned].sort()) {
    if (PROTECTED.has(name)) {
      needsUser.push(`branch ${name} is protected and is never deleted`);
      continue;
    }
    const state = remoteSha(name);
    if (state.error) needsUser.push(`branch ${name}: ${state.error}`);
    else if (state.sha) branches.push({ name, why, expectedSha: state.sha, order: bases.has(name) ? 2 : 1 });
  }
  branches.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  sessions.sort((a, b) => a.order - b.order);
  writeFileSync(planFile, `${JSON.stringify({ runId: run.runId, plannedAt: at(), prs, branches, sessions, dirty, needsUser }, null, 2)}\n`);
  log('cleanup:planned', { digest: digestOf(planFile), prs: prs.length, branches: branches.length, sessions: sessions.length, dirty: dirty.length });
  console.log(`cleanup plan for ${run.runId}: ${prs.length} PRs to close, ${branches.length} branches to delete, ${sessions.length} sessions to archive in the app, ${dirty.length} dirty worktrees, ${needsUser.length} items for the user`);
  console.log(`digest: ${digestOf(planFile)}`);
}

function apply() {
  if (!existsSync(planFile)) throw new Error('No cleanup-plan.json: run plan first');
  if (opts.approved !== digestOf(planFile)) throw new Error(`refusing: --approved ${opts.approved} is not the digest of the current cleanup-plan.json (${digestOf(planFile)})`);
  const todo = JSON.parse(readFileSync(planFile, 'utf8'));
  for (const pr of todo.prs) {
    const view = exec(['gh', 'pr', 'view', pr.url, '--json', 'state,headRefOid']);
    if (!view.ok) {
      log(`cleanup:pr:${pr.url}`, { result: 'failed to read', detail: view.out });
      continue;
    }
    const now = JSON.parse(view.out);
    if (now.state !== 'OPEN') log(`cleanup:pr:${pr.url}`, { result: `already ${now.state.toLowerCase()}` });
    else if (now.headRefOid !== pr.expectedHead) log(`cleanup:pr:${pr.url}`, { result: 'changed since the plan; left to the user', head: now.headRefOid });
    else {
      const close = exec(['gh', 'pr', 'close', pr.url, '--comment', `Closed by the cleanup of trial run ${run.runId}.`]);
      log(`cleanup:pr:${pr.url}`, { result: close.ok ? 'closed' : 'failed to close', detail: close.ok ? undefined : close.out });
    }
  }
  for (const branch of todo.branches) {
    const state = remoteSha(branch.name);
    if (state.error) {
      log(`cleanup:branch:${branch.name}`, { result: 'failed to read', detail: state.error });
      continue;
    }
    if (!state.sha) {
      log(`cleanup:branch:${branch.name}`, { result: 'already absent' });
      continue;
    }
    if (state.sha !== branch.expectedSha) {
      log(`cleanup:branch:${branch.name}`, { result: 'changed since the plan; left to the user', sha: state.sha });
      continue;
    }
    const push = exec(['git', `--git-dir=${pushRepo()}`, 'push', `--force-with-lease=refs/heads/${branch.name}:${branch.expectedSha}`, remoteUrl, `:refs/heads/${branch.name}`]);
    log(`cleanup:branch:${branch.name}`, { result: push.ok ? 'deleted' : 'refused or failed; left to the user', detail: push.ok ? undefined : push.out });
  }
  const results = readFileSync(path.join(runDir, 'inventory.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.key.startsWith('cleanup:pr:') || entry.key.startsWith('cleanup:branch:'));
  const latest = new Map(results.map(entry => [entry.key, entry.value.result]));
  for (const [key, result] of latest) console.log(`${key.replace('cleanup:', '')}: ${result}`);
}

function removeRunDir() {
  const runsRoot = realpathSync(path.join(homedir(), 'wm-runs'));
  if (lstatSync(runDir).isSymbolicLink()) throw new Error(`refusing: ${runDir} is a symbolic link`);
  const real = realpathSync(runDir);
  if (path.dirname(real) !== runsRoot) throw new Error(`refusing: ${real} is not a direct child of ${runsRoot}`);
  if (path.basename(real) !== run.runId || !/^wm-(smoke|trial)-\d{8}T\d{6}Z$/.test(run.runId)) throw new Error(`refusing: ${real} is not this run's folder`);
  const owner = path.join(real, '.wm-run-owner');
  if (!existsSync(owner) || readFileSync(owner, 'utf8').trim() !== run.runId) throw new Error(`refusing: ${owner} doesn't name ${run.runId}`);
  rmSync(real, { recursive: true });
  console.log(`removed ${real}`);
}

if (command === 'plan') plan();
else if (command === 'apply') apply();
else removeRunDir();
````

- [ ] **Step 5: Check the scripts**

```bash
for script in wm-collect wm-measure wm-finalize; do node --check "$RUN_DIR/$script.mjs" || exit 1; done
node "$RUN_DIR/wm-measure.mjs" --self-test --plugin "$PLUGIN"
```

Expected: `self-test passed`. It checks the measurement rules on synthetic logs: an early `READY TO MERGE:` echo, a marker without a URL and a sub-agent's message are not "ready"; a peer message is not a user action; usage after ready is excluded; a piped test run passes on its summary and an `echo` is not a test run; an unknown `assignment_id` is flagged; the manual compaction is found; the smoke checks pass, and fail when a Project that didn't opt in loads the skill and reads state.

- [ ] **Step 6: Record the preflight**

```bash
{
  echo "run: $RUN"
  echo "app: $(defaults read /Applications/GitHub.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo unknown)"
  echo "copilot cli: $(copilot --version 2>/dev/null | head -1)"
  echo "plugin: $(node -e 'console.log(require(process.argv[1] + "/plugin.json").version)' "$PLUGIN")"
  echo "skills: $(ls "$PLUGIN/skills" | tr '\n' ' ')"
  echo "main: $(git ls-remote https://github.com/ncksol/ai_tools.git refs/heads/main | cut -f1)"
  echo "node: $(node --version); sqlite3: $(sqlite3 --version | cut -d' ' -f1); gh: $(gh --version | head -1)"
  gh auth status 2>&1 | grep -i 'logged in' | head -1
} | tee "$RUN_DIR/preflight.txt"
```

Expected: the skills line lists `wintermute-pr-commands`, `wintermute-project` and `wintermute-project-worker`, and the plugin version matches the one the user saw in Task 5. Anything else: report `blocked`.

- [ ] **Step 7 (smoke only): Write `run.json`**

```bash
cat > "$RUN_DIR/run.json" <<EOF
{
  "runId": "$RUN",
  "mode": "smoke",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "repo": "ncksol/ai_tools",
  "caps": { "minutes": 30, "usd": 12 },
  "arms": [
    { "arm": "project", "kind": "project", "title": "$RUN-project", "marker": "$RUN project:" },
    { "arm": "negative", "kind": "project", "title": "$RUN-negative", "marker": "$RUN negative:" }
  ],
  "baseBranches": []
}
EOF
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("run.json ok")' "$RUN_DIR/run.json"
```

- [ ] **Step 8 (trial only): Check that the task is still open**

Export `main` into a scratch folder in the run folder, make the default task's change there, and run the checks:

```bash
git -C <your checkout> fetch --quiet origin main
mkdir "$RUN_DIR/open-check" && git -C <your checkout> archive origin/main | tar -x -C "$RUN_DIR/open-check"
cd "$RUN_DIR/open-check/ghcp/plugins/wintermute"
node -e 'const fs = require("fs"); const f = "com.github.copilot/agents/wintermute-peon.agent.md"; const t = fs.readFileSync(f, "utf8"); if (!t.includes("swarm-status: <status> unit=<unit>")) process.exit(3); fs.writeFileSync(f, t.replace("swarm-status: <status> unit=<unit>", "swarm-status: <state> unit=<unit>"));' && { npm test > /dev/null 2>&1 && npm run validate > /dev/null 2>&1 && echo "default task is open" || echo "default task is covered"; }
```

Expected: `default task is open`. If it prints "covered", export again into `$RUN_DIR/open-check-spare` and repeat with the spare task's change instead:

```bash
node -e 'const fs = require("fs"); const f = "skills/wintermute-pr-commands/SKILL.md"; const t = fs.readFileSync(f, "utf8"); if (!/^name: wintermute-pr-commands$/m.test(t)) process.exit(3); fs.writeFileSync(f, t.replace(/^name: wintermute-pr-commands\n/m, ""));' && { npm test > /dev/null 2>&1 && npm run validate > /dev/null 2>&1 && echo "spare task is open" || echo "spare task is covered"; }
```

If the `node` command exits with code 3 (the text it changes isn't there), or both tasks are covered, report `needs_input`: the user picks another task (design section 9). Record `default` or `spare` as the task. These exports are scratch copies; your checkout and its branch don't change.

- [ ] **Step 9 (trial only): Create the base branches, and write `run.json`**

From your checkout:

```bash
git fetch --quiet origin main
MAIN=$(git rev-parse origin/main)
for ARM in project baseline; do
  git push --force-with-lease="refs/heads/$RUN-$ARM-base:" origin "$MAIN:refs/heads/$RUN-$ARM-base" || { echo "refusing: $RUN-$ARM-base exists or can't be created"; exit 1; }
done
cat > "$RUN_DIR/run.json" <<EOF
{
  "runId": "$RUN",
  "mode": "trial",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "repo": "ncksol/ai_tools",
  "task": "<default or spare, from Step 8>",
  "caps": { "armMinutes": 120, "armUsd": 60, "totalUsd": 140 },
  "arms": [
    { "arm": "project", "kind": "project", "title": "$RUN-project", "marker": "$RUN project:", "baseBranch": "$RUN-project-base" },
    { "arm": "baseline", "kind": "session", "marker": "$RUN baseline:", "baseBranch": "$RUN-baseline-base" }
  ],
  "baseBranches": [
    { "name": "$RUN-project-base", "createdSha": "$MAIN" },
    { "name": "$RUN-baseline-base", "createdSha": "$MAIN" }
  ]
}
EOF
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("run.json ok")' "$RUN_DIR/run.json"
```

The `--force-with-lease=<ref>:` form creates each branch only if it doesn't exist (C35). Expected: two new branches and `run.json ok`.

- [ ] **Step 10: First collection, and report**

```bash
node "$RUN_DIR/wm-collect.mjs" --run-dir "$RUN_DIR"
```

Expected: `0/2 arms resolved` (no session exists yet) and, for a trial, the two base branches with their SHA in `inventory.jsonl`. Hand off with the run ID and, for a trial, the task (`default` or `spare`).

### Task 7: The finalizer, for every exit

The run operator does this when a run ends for any reason: success, abort, cap, failure, or before a rerun. It is safe to repeat.

- [ ] **Step 1 (USER): Stop the coordinators**

If any coordinator of the run is still working, send it: `Stop: start nothing new, and tell me what is still open.` Wait for its reply, or two minutes.

- [ ] **Step 2: Collect, then plan the cleanup**

```bash
node "$RUN_DIR/wm-collect.mjs" --run-dir "$RUN_DIR"
node "$RUN_DIR/wm-finalize.mjs" plan --run-dir "$RUN_DIR"
cat "$RUN_DIR/cleanup-plan.json"
```

Expected: a summary line and a digest. Report the plan to the orchestrator with its digest: the PRs it would close, the branches it would delete with their SHAs, the sessions to archive, the dirty worktrees, and every item it leaves to the user. A collector exit code of 2 (an ambiguous identity) stops the cleanup until the orchestrator resolves it with the user.

- [ ] **Step 3: Get the user's approval of the exact plan**

The orchestrator asks the user, tagged `[unit=* need=question]`, with the plan's lists and its digest, whether to apply it. A dirty worktree is listed so that the user can keep its work first. On "yes", the orchestrator sends the digest to the operator.

- [ ] **Step 4: Apply the approved plan**

```bash
node "$RUN_DIR/wm-finalize.mjs" apply --run-dir "$RUN_DIR" --approved <digest>
```

Expected: each PR `closed` or `already …`, each branch `deleted` or `already absent`. A line that says "changed" or "failed" is left to the user: report it.

- [ ] **Step 5 (USER): Archive the run's sessions**

In the app, archive each session that the plan lists: the child sessions first, through each one's session menu while its parent is still visible, then the Projects and the baseline session.

- [ ] **Step 6: Confirm, keep the evidence, and remove the run folder**

```bash
node "$RUN_DIR/wm-collect.mjs" --run-dir "$RUN_DIR"
node -e 'const ids = require(process.argv[1] + "/ids.json"); const open = ids.arms.flatMap(a => a.resolved ? [a.archivedAt ? null : a.title, ...a.children.filter(c => !c.archivedAt).map(c => c.name)] : []).filter(Boolean); console.log(open.length ? "not archived: " + open.join(", ") : "all archived")' "$RUN_DIR"
cp "$RUN_DIR/inventory.jsonl" "$OUT/$RUN-inventory.jsonl"
[ -f "$RUN_DIR/measure.json" ] && cp "$RUN_DIR/measure.json" "$OUT/$RUN-measure.json"
```

Expected: `all archived`. Then, only after the findings (Task 9 or Task 11) and their check are complete:

```bash
node "$RUN_DIR/wm-finalize.mjs" remove-run-dir --run-dir "$RUN_DIR"
```

Expected: `removed …`. It refuses a symbolic link, a folder outside `~/wm-runs`, or a folder whose owner file doesn't name the run.

### Task 8 (USER): The smoke check

Caps: 30 minutes from Step 4 to the child's handoff, and $12 (design 8.11). Write notes as you go; Step 8 lists what to send.

- [ ] **Step 1 (USER): Create the opted-in Project**

In the app: **Projects → + → New project**. Name it `<run ID>-project`, add the repository `ncksol/ai_tools`, and choose Claude Opus at `high` in its composer if the app offers a model and effort. Note what the picker shows. Don't send anything yet.

- [ ] **Step 2 (USER): Create the negative Project**

The same way, create `<run ID>-negative` with `ncksol/ai_tools` and the same model. Don't send anything yet.

- [ ] **Step 3 (USER): Check the negative Project (S1)**

Send exactly this to `<run ID>-negative`:

```text
<run ID> negative: Reply with a plan only, and do nothing else. How would you split adding two small test files to ghcp/plugins/wintermute/tests in ncksol/ai_tools into parallel units with child sessions, a reviewer and a claims check? Don't create sessions, edit files, run commands or change memory.
```

Note whether its reply starts with `wintermute-project rules loaded.` (it must not).

- [ ] **Step 4 (USER): Opt in and dispatch one job (S1–S4)**

In `<run ID>-project`, type `/wintermute-project` and note whether the command list shows it. Then send exactly:

```text
/wintermute-project <run ID> project: Start one one-off child session on ncksol/ai_tools. Its job: in ghcp/plugins/wintermute at the current main, run npm test and then npm run validate, write the result file that your rules describe, and hand off. It is read-only: no edits, commits, pushes or PRs. Start no other session and open no PR.
```

Note the time. Tell the orchestrator "smoke started", so that the run operator collects identities.

- [ ] **Step 5 (USER): Watch, without helping**

Send nothing else. Look at the Project's Overview: note what shows under Needs input, Open, Working and Done. Note any command approval the app shows, or a denial a session reports; approve a held command only if it is `npm test` or `npm run validate` in the child's checkout. Note whether you had to open the child's session for anything.

- [ ] **Step 6 (USER): Stop at the cap**

If the Project hasn't reported the child's result 30 minutes after Step 4, send `Stop: start nothing new, and tell me what is still open.` and go to Step 8.

- [ ] **Step 7 (USER): Try `/compact` (observation only)**

After the Project reports the child's result, type `/compact` in `<run ID>-project`. Note whether the app accepted it. If it did, send `What is the state of the smoke task? Don't change anything.` and note whether the reply starts with `wintermute-project rules loaded.`; if it doesn't, send `/wintermute-project` and note that you did.

- [ ] **Step 8 (USER): Tell the orchestrator**

Send the orchestrator this text, filled in:

```text
smoke done
Run ID: <run ID>
Model picker: project <what it showed>; negative <what it showed>
/wintermute-project listed before the first message: <yes or no>
Negative Project's reply started with "wintermute-project rules loaded.": <yes or no>
Overview of the project: <Needs input, Open, Working and Done, and anything confusing>
Command approvals or denials: <none, or each one and where>
I opened the child session: <no, or why>
Result reported at: <time, or "not within 30 minutes">
/compact accepted: <yes or no>; reply started with the loaded line: <yes, no or not tried>; I sent /wintermute-project again: <yes or no>
```

### Task 9: Measure the smoke check, and decide

The run operator does Steps 1–2; the orchestrator does Steps 3–4.

- [ ] **Step 1: Collect and measure**

```bash
node "$RUN_DIR/wm-collect.mjs" --run-dir "$RUN_DIR"
node "$RUN_DIR/wm-measure.mjs" --run-dir "$RUN_DIR" --plugin "$PLUGIN"
```

Expected: both arms resolved, then the smoke checks `optIn`, `dispatch`, `handoff`, `tests` and `caps`, each `pass`, `fail` or `not measured`, with `minutesToHandoff` and `totalUsd`. A collector exit code of 2 stops here: report the ambiguity.

- [ ] **Step 2: Write the smoke record**

Write `$OUT/$RUN-smoke.md` with: the run ID; `preflight.txt`; each check's result with its receipts from `measure.json` (the skill loads, the `create_session` request and the child's `session.start`, the report with its `assignment_id`, the test runs, the minutes and the cost, all unrounded); the user's notes; and the `/compact` observation. Hand off with its path, then run Task 7.

- [ ] **Step 3: Check the verdict against the receipts**

The orchestrator reads `measure.json` and the record, and checks each pass or fail against its receipts as a quick job (design 8.11).

- [ ] **Step 4: Decide the next step**

- All five checks pass: ask the user, tagged `[unit=* need=question]`, with the smoke record and the trial's caps ($60 and 120 minutes per arm, $140 in all), whether to run the paired trial. On "yes", start Task 6 with `MODE=trial`, then Task 10.
- A check fails because of the skill text and Phase 1's fix round is unused: a patch PR on the two skills through the normal gates; after it merges, Tasks 5–9 again with a new run.
- Any other failure, or a second one: bring the no-go to the user with the record, as in Task 13, Step 2.

### Task 10 (USER): The paired trial

Caps: each arm 120 minutes from its prompt or $60; the whole trial $140 (design 8.12). Write notes as you go; Step 10 lists what to send.

- [ ] **Step 1 (USER): Create the Project**

**Projects → + → New project**, named `<run ID>-project`, repository `ncksol/ai_tools`. Choose Claude Opus at `high` if the app offers it, and note what the picker shows. Don't send anything yet.

- [ ] **Step 2 (USER): Prepare the baseline session**

Start a new ordinary session on `ncksol/ai_tools` (not in a Project), in a new worktree. Pick `wintermute-core` in the agent picker, or with `/agent`, and choose Claude Opus at `high`. Note what the pickers show. Don't send anything yet.

- [ ] **Step 3 (USER): Note the approval settings**

Note the app's current settings for command approvals and autopilot permissions, as your app version shows them. Don't change them during the trial.

- [ ] **Step 4 (USER): Send the task to both, within one minute (all)**

The orchestrator tells you the run ID and whether the task is `default` or `spare` (Task 6, Step 8). To the Project, send exactly:

```text
/wintermute-project <run ID> project: In ncksol/ai_tools, add a test to the wintermute plugin (ghcp/plugins/wintermute/) that fails when the "How to report to the orchestrator" text block in com.github.copilot/agents/wintermute-core.agent.md and the one in com.github.copilot/agents/wintermute-peon.agent.md are not word for word the same. The repository instructions require them to match, and no test checks it today. Follow the repository's rules for plugin changes: bump the plugin's patch version with npm run release:bump and write the CHANGELOG entry, and run npm test && npm run validate from the plugin folder. This is a trial run: the task's target branch is <run ID>-project-base, not main. Create every branch from it, open the PR against it, and never push to main or open a PR against main. Show me your plan and wait for my approval before you start. After I approve it, you may open the PR ready for review and publish it on my behalf once its review and claims check are clean, but don't merge it. When the PR is ready to merge, write me a message that starts with "READY TO MERGE:" followed by the PR's URL, and stop.
```

To the baseline session, send the same text with `/wintermute-project <run ID> project:` replaced by `<run ID> baseline:`, and `<run ID>-project-base` replaced by `<run ID>-baseline-base`.

**Spare task** (when the orchestrator says so, or for the rerun after a fix round): in both messages, replace the two sentences that start "In ncksol/ai_tools, add a test" and "The repository instructions require" with: `In ncksol/ai_tools, add a test to the wintermute plugin (ghcp/plugins/wintermute/) that fails when skills/wintermute-pr-commands/SKILL.md has no name or no description in its frontmatter, or when its name differs from its folder name. Its description is a folded YAML block (">-"): the test must read that form without changing the skill. No test or validator checks that skill today.`

Note the time. Tell the orchestrator "trial started", so that the run operator collects identities.

- [ ] **Step 5 (USER): Review each plan (F9, E)**

Each coordinator asks you to approve its plan. Approve a plan if it is a reasonable plan for the task: one unit with a review, a claims check and the final panel, working against its base branch. If not, say what to change, and note it.

- [ ] **Step 6 (USER): Watch, and answer only what you are asked (F5, F7, F9)**

Send nothing else. Answer any question a coordinator asks, and note it. If the app shows a held command, approve it only if it is `npm test`, `npm run validate`, `npm run release:bump` or a `git` or `gh` command on the run's branches, in a trial checkout, and note it; if a child reports a denied command, note it and don't change settings. Look at the Project's Overview (Needs input, Open, Working, Done) and Inbox at least twice, and note what you see and whether you had to open a child session.

- [ ] **Step 7 (USER): Wait for both "READY TO MERGE:" messages, or the caps (F8)**

Note each time and PR URL. If an arm reaches 120 minutes from Step 4, send it `Stop: start nothing new, and tell me what is still open.` and note it as capped. Tell the orchestrator "both ready" (or which one is capped), so that the run operator collects identities.

- [ ] **Step 8 (USER): Compact the Project and ask for its state (F6)**

In the Project, type `/compact`. If the app doesn't accept it, note that and go to Step 9. Otherwise send:

```text
What is the state of the trial task? Don't change anything yet.
```

If the reply doesn't start with `wintermute-project rules loaded.`, send `/wintermute-project` and note that you did.

- [ ] **Step 9 (USER): Check, then merge, in both arms (F3)**

Send to each ready arm:

```text
Before you merge: show me the PR's repository, number, base branch and full head commit, and the review, claims check and final panel results with the commit each one checked. Then wait for my reply.
```

Check that the base branch is that arm's `<run ID>-…-base` branch and that every result is clean at the head commit it shows. If so, send `Merge it.` and note when it reports the merge and the claims check on the base branch. If anything doesn't match, send `Don't merge.` and note why.

- [ ] **Step 10 (USER): Tell the orchestrator**

Send the orchestrator this text, filled in:

```text
trial done
Run ID: <run ID>
Task: default or spare
Pickers: Project <model and effort shown>; baseline <agent, model and effort shown>
Approval settings: <what you noted>
Plan changes I asked for: Project <none or what>; baseline <none or what>
Questions I was asked besides the plan approval: <none, or each question and where>
Command approvals or denials: <none, or each one and where>
Child sessions I opened: <none, or which and why>
Overview: <Needs input, Open, Working and Done; anything confusing>
Inbox: <what appeared, when, and any item shown twice>
Ready: Project <time and URL, or capped>; baseline <time and URL, or capped>
/compact accepted: <yes or no>; reply started with the loaded line: <yes, no or not tried>; I sent /wintermute-project again: <yes or no>
Merge: Project <merged, or not and why>; baseline <merged, or not and why>
```

### Task 11: Measure the trial and write the findings

The document-draft job (Opus at `xhigh`). Read-only, except for the run folder, `$OUT` and its own scratch clones under `$RUN_DIR`.

**Files:**
- Create: `$RUN_DIR/project-snapshot.json`, `$RUN_DIR/baseline-snapshot.json`, `$RUN_DIR/measure.json`, `$RUN_DIR/timelines.json`, `$RUN_DIR/acceptance.txt`
- Create: `$OUT/$RUN-findings-private.md`, `$OUT/$RUN-findings-public.md`

**Interfaces:**
- Consumes: the run folder (Task 6), the user's notes (Task 10, Step 10), the smoke record (Task 9).
- Produces: the private findings with every receipt, and the public summary that a later PR commits.

- [ ] **Step 1: Collect and measure**

```bash
node "$RUN_DIR/wm-collect.mjs" --run-dir "$RUN_DIR"
node "$RUN_DIR/wm-measure.mjs" --run-dir "$RUN_DIR" --plugin "$PLUGIN"
```

Expected: both arms resolved, then the comparison: `costRatio`, `workingTimeRatio`, `wallRatio`, `f8`, `userActionsDifference` and `f9`. A collector exit code of 2 stops here: report the ambiguity.

- [ ] **Step 2: Take the dashboard snapshots (an observation)**

From your checkout's `ghcp/plugins/wintermute/`, with each arm's `snapshotId` from `$RUN_DIR/ids.json`:

```bash
node scripts/swarm-snapshot.mjs --swarm <project snapshotId> --no-pr-lookup > "$RUN_DIR/project-snapshot.json"; echo "project exit $?"
node scripts/swarm-snapshot.mjs --swarm <baseline snapshotId> --no-pr-lookup > "$RUN_DIR/baseline-snapshot.json"; echo "baseline exit $?"
```

Record whether each exits 0 and whether its cost matches `totalUsd` in `measure.json`. Never pass `--persist-history`.

- [ ] **Step 3: Read the PR timelines**

```bash
node -e '
const { execFileSync } = require("child_process");
const dir = process.argv[1];
const ids = require(dir + "/ids.json");
const run = require(dir + "/run.json");
const bases = new Set(run.baseBranches.map(base => base.name));
const out = ids.prs.filter(pr => bases.has(pr.baseRefName)).map(pr => {
  try {
    const pages = JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${run.repo}/issues/${pr.number}/timeline`], { encoding: "utf8" }));
    return { url: pr.url, ok: true, events: pages.flat().filter(e => ["ready_for_review", "convert_to_draft", "merged", "closed", "reopened"].includes(e.event)).map(e => ({ event: e.event, at: e.created_at })) };
  } catch (error) {
    return { url: pr.url, ok: false, error: String(error.message).slice(0, 300) };
  }
});
require("fs").writeFileSync(dir + "/timelines.json", JSON.stringify(out, null, 2) + "\n");
console.log(out.map(t => `${t.url}: ${t.ok ? t.events.map(e => e.event).join(", ") || "no events" : "ERROR " + t.error}`).join("\n"));
' "$RUN_DIR"
```

Expected: one line for each arm's PR. An `ERROR` line makes F3 "not measured" for that arm until it is read again.

- [ ] **Step 4: Run the common acceptance check on both ready heads**

For each arm, with `HEAD` set to the head commit of the PR in its ready message (from `measure.json`, `ready.headAtReadback`, or the PR's commit at the ready time when it changed since):

```bash
ARM=<project or baseline>; HEAD=<full head SHA>
git clone --quiet https://github.com/ncksol/ai_tools.git "$RUN_DIR/accept-$ARM" && cd "$RUN_DIR/accept-$ARM" && git checkout --quiet "$HEAD" && cd ghcp/plugins/wintermute
npm test > /dev/null 2>&1 && echo "$ARM: suite passes at $HEAD" || echo "$ARM: SUITE FAILS at $HEAD"
node -e 'const fs = require("fs"); const f = "com.github.copilot/agents/wintermute-peon.agent.md"; const t = fs.readFileSync(f, "utf8"); if (!t.includes("swarm-status: <status> unit=<unit>")) process.exit(3); fs.writeFileSync(f, t.replace("swarm-status: <status> unit=<unit>", "swarm-status: <state> unit=<unit>"));'
npm test > /dev/null 2>&1 && echo "$ARM: CHANGE NOT CAUGHT" || echo "$ARM: change caught"
```

For the spare task, the change is removing the line `name: wintermute-pr-commands` from `skills/wintermute-pr-commands/SKILL.md` instead. Append each arm's three lines to `$RUN_DIR/acceptance.txt`. The comparison is equivalent (E) only if both arms print "suite passes" and "change caught", started from the same base commit, ran with the same coordinator model, and the user's notes show no plan change that changed the work.

- [ ] **Step 5: Write the private findings**

Create `$OUT/$RUN-findings-private.md` in this form. Fill every result from `measure.json`, `ids.json`, `timelines.json`, `acceptance.txt`, `preflight.txt`, the smoke record and the user's notes. Quote numbers unrounded, with the rounded value beside them. Mark anything without its evidence "not measured", never a pass.

```markdown
# Wintermute in Projects: trial findings (private)

Run: <run ID>, <date>. App: <from preflight>. CLI: <from preflight>. Plugin: <version>. Runtime: <runtimeVersion of each arm>. Task: <default or spare>. Base commit: <createdSha>.
Smoke check: <run ID of the smoke run and its five results>.

## Results

| # | Arm | Result | Receipts |
|---|---|---|---|
| F1 | Project | pass / fail / not measured | <skill loads against each session's first work action; missing logs> |
| F2 | Project | … | <each request, its effective model and effort, its role and tier row; vendors of reviewers and judges> |
| F3 | Project | … | <reports' commits and times, timeline events, merge command and exit code, merge readback, post-merge check> |
| F3 | Baseline | … | <the same> |
| F4 | Project | … | <each report: delivered, assignment known, purpose, lines; each needs_input text> |
| F5 | Project | … | <the user's Overview and Inbox notes; publishes and results> |
| F6 | Project | … | <the recovery block; the user's /compact notes> |
| F7 | Project | … | <test and validate runs of the owner and the claims checker; denials; approvals> |
| F8 | both | Go / User decides / No-go / not measured | <costToReadyUsd, workingMinutes, wallMinutes and userWaitMinutes for each arm; costRatio and workingTimeRatio unrounded> |
| F9 | both | … | <userActionsToReady for each arm and the difference; interventions from the notes> |
| E | both | holds / not comparable | <acceptance.txt; base commit; coordinator models; plan changes> |

## Decision table

<Apply design 8.14: name the state and the criteria that decide it. F10 is asked at the gate.>

## Observations

- U11: <Overview and Inbox items, duplicates>
- U13: <baselineLoadedProjectSkill, and the negative Project in the smoke check>
- U14: <any assignment without a final result after its first, and what the coordinator did>
- U15: <the merge command and its result>
- U16: <the pickers and the effective models>
- Dashboard: <whether each snapshot read the swarm and matched the cost>

## Identities

<the arms' root and child IDs and branches from ids.json, and the PR URLs>
```

- [ ] **Step 6: Write the public summary**

Create `$OUT/$RUN-findings-public.md` from the private findings, with role names (the Project arm, the baseline, the owner, the reviewer, the claims checker, the judges) instead of IDs, and no absolute paths, session or workspace IDs, branch names, prompts, user answers or usernames. Keep each result, its rounded numbers, the decision table's state and the reasons. Check it:

```bash
grep -nE '/Users/|[0-9a-f]{8}-[0-9a-f]{4}-|wm-trial-[0-9]{8}|assignment:' "$OUT/$RUN-findings-public.md" && echo "REMOVE THE LINES ABOVE" || echo "public summary clean"
```

Expected: `public summary clean`. Hand off with both paths, then run Task 7.

### Task 12: Check the findings

One-off job at the fact-check row (Sol at `xhigh`), read-only. Its vendor differs from Task 11's.

- [ ] **Step 1: Check each result against its evidence**

For every row and number in the private findings, check the claim against `measure.json`, `ids.json`, `timelines.json`, `acceptance.txt`, `preflight.txt`, the smoke record and, where a claim needs it, the session logs in `~/.copilot/session-state/<id>/events.jsonl`. Check F2 against the tier table in `com.github.copilot/agents/wintermute-core.agent.md`, and the decision table against design 8.14. Check that the public summary matches the private findings and holds no identifier.

- [ ] **Step 2: Report**

Write each claim's verdict (confirmed, wrong with the right value, or not checkable) to `$OUT/$RUN-findings-check.md`, and hand off with its path. The orchestrator sends any correction to Task 11's session as a new assignment, and runs this check again on the corrected files.

### Task 13: The gate

The orchestrator does this with the user.

- [ ] **Step 1: Ask F10 after showing the measurements**

Ask the user, tagged `[unit=* need=question]`, with the public summary's results and the decision table's state: "For your next repository task that ends in a PR, would you run it in a Project with this skill rather than with `wintermute-core` in an ordinary session? What did you have to click or watch, and did the Project improve on the ordinary session?"

- [ ] **Step 2: Bring the decision to the user**

Ask, tagged `[unit=* need=question]`, with the decision table's outcome and its reasons, and these choices: go (Task 15), no-go (Task 14), or the fix round (only when an F1–F6 failure came from the skill text and Phase 1's fix round is unused). If the user overrides a measured outcome, record it in the private findings as the user's override, with their reason.

- [ ] **Step 3: Act on the answer**

- Go: start Task 15.
- No-go: start Task 14.
- Fix round: a patch PR on the two skills through the normal gates; after it merges, Tasks 5, 6 (`MODE=trial`, a new run) and 10–13 again with the spare task.

---

## Phase 2b, unit `projects-remove` (only after a no-go)

### Task 14: Remove the Projects skills

**Files:**
- Delete: `skills/wintermute-project/`, `skills/wintermute-project-worker/`, `scripts/lib/validate-skills.mjs`, `tests/validate-skills.test.mjs`, `tests/validate-skills-plugin.test.mjs`
- Modify: `scripts/validate-plugin.mjs`, `README.md`, `CHANGELOG.md`, `plugin.json`, `package.json`, `.github/plugin/marketplace.json`, `.github/copilot-instructions.md`
- Create: `docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md`

**Interfaces:**
- Consumes: the checked public summary (Task 12, or the smoke record from Task 9 when the smoke check ended Phase 1) and the gate's no-go.
- Produces: a plugin and repository instructions with no Projects skills and no exception, at the next minor version.

Every command in this task runs from the repository root unless it says otherwise.

- [ ] **Step 1: Delete the files**

```bash
cd "$(git rev-parse --show-toplevel)"
git rm -r -q ghcp/plugins/wintermute/skills/wintermute-project ghcp/plugins/wintermute/skills/wintermute-project-worker ghcp/plugins/wintermute/scripts/lib/validate-skills.mjs ghcp/plugins/wintermute/tests/validate-skills.test.mjs ghcp/plugins/wintermute/tests/validate-skills-plugin.test.mjs
```

- [ ] **Step 2: Remove the validator hook**

In `ghcp/plugins/wintermute/scripts/validate-plugin.mjs`, delete these two lines:

```js
import { validateSkills } from './lib/validate-skills.mjs';
```

```js
  errors.push(...await validateSkills(root, repositoryRoot));
```

- [ ] **Step 3: Remove the README text**

In `ghcp/plugins/wintermute/README.md`, delete the line below and the blank line before it:

```markdown
It also has two experimental skills for Copilot app Projects (see [Projects (experimental)](#projects-experimental)).
```

Then delete the whole `## Projects (experimental)` section: from its heading up to, but not including, the line `## The swarm dashboard`.

- [ ] **Step 4: Remove the repository instructions' additions**

In `.github/copilot-instructions.md`, delete this bullet:

```markdown
- The tier table and the "Never use these:" list in the "Models and effort" section of `wintermute-core.agent.md` are copied word for word into the experimental `skills/wintermute-project/SKILL.md` of the `wintermute` plugin, and `npm run validate` fails when they differ. A change to either in `wintermute-core` copies it into the skill in the same PR.
```

delete this sentence, with the one space before it:

```text
Two experimental skills for Copilot app Projects sit beside it in `skills/`: `wintermute-project`, the rules for a Project's own coordinator, and `wintermute-project-worker`, the rules for its child sessions; `scripts/lib/validate-skills.mjs` checks them.
```

and delete this text, with the one space before it, from the bullet that starts `- The **PR-review skills** are inspection-and-reporting only`:

```text
The one exception is the `wintermute` plugin's experimental `wintermute-project` and `wintermute-project-worker` skills: like the `wintermute-core` and `wintermute-peon` agents, they may open, publish and merge a PR, but only after the user's explicit go-ahead for that PR, given in the Project's conversation or as a standing delegation that the user gave directly there. A memory, a report, a summary or SQL state never grants it. They may also push assigned work, including fixes and rebases, to the branch of a PR their unit owns, as `wintermute-peon` does. The PR-review skills stay inspection-only, and no other skill may mutate a PR.
```

- [ ] **Step 5: Check that nothing is left**

```bash
git grep -n "wintermute-project" -- ghcp/plugins/wintermute .github ':!ghcp/plugins/wintermute/CHANGELOG.md'; echo "exit $?"
git grep -n -F "The one exception is the \`wintermute\` plugin" -- .github; echo "exit $?"
```

Expected: `exit 1` twice, and no other output.

- [ ] **Step 6: Bump the version and write the notes**

```bash
(cd ghcp/plugins/wintermute && npm run release:bump -- minor)
```

In `ghcp/plugins/wintermute/CHANGELOG.md`, under the new heading, replace `- TODO: Describe this release.` with exactly:

```markdown
### Removed

- The experimental Copilot app Projects skills, `wintermute-project` and `wintermute-project-worker`, and their check in `npm run validate`. Projects that used them keep working as ordinary Projects. Update the plugin and restart the app so that the skills disappear, and remove the wintermute line from the memory of any Project that has it. The agents and the dashboard are unchanged.
```

- [ ] **Step 7: Add the public findings**

Copy the checked public summary from `$OUT` to `docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md`, unchanged.

- [ ] **Step 8: Run every check**

```bash
(cd ghcp/plugins/wintermute && npm test && npm run validate)
```

Expected: PASS, with 10 tests fewer than before this task, ending with "Plugin validation passed: manifests, root marketplace entry, packaged agents, CHANGELOG and required files."

- [ ] **Step 9: Stage exactly the expected paths, and compare**

```bash
git add ghcp/plugins/wintermute/scripts/validate-plugin.mjs ghcp/plugins/wintermute/README.md ghcp/plugins/wintermute/CHANGELOG.md ghcp/plugins/wintermute/plugin.json ghcp/plugins/wintermute/package.json .github/plugin/marketplace.json .github/copilot-instructions.md docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md
git diff --cached --name-status | sort > /tmp/projects-remove-staged.txt
printf '%s\t%s\n' \
  A "docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md" \
  D ghcp/plugins/wintermute/scripts/lib/validate-skills.mjs \
  D ghcp/plugins/wintermute/skills/wintermute-project-worker/SKILL.md \
  D ghcp/plugins/wintermute/skills/wintermute-project/SKILL.md \
  D ghcp/plugins/wintermute/tests/validate-skills-plugin.test.mjs \
  D ghcp/plugins/wintermute/tests/validate-skills.test.mjs \
  M .github/copilot-instructions.md \
  M .github/plugin/marketplace.json \
  M ghcp/plugins/wintermute/CHANGELOG.md \
  M ghcp/plugins/wintermute/README.md \
  M ghcp/plugins/wintermute/package.json \
  M ghcp/plugins/wintermute/plugin.json \
  M ghcp/plugins/wintermute/scripts/validate-plugin.mjs \
  | sort > /tmp/projects-remove-expected.txt
diff /tmp/projects-remove-expected.txt /tmp/projects-remove-staged.txt && echo "staged exactly the expected paths"
```

Expected: `staged exactly the expected paths`. Anything else: unstage the extra paths, or report `blocked`.

- [ ] **Step 10: Commit, push and hand off**

```bash
git commit -m "feat(wintermute): remove the experimental Projects skills"
git push
```

Hand off with the pushed commit for the critical review, the claims check and the final panel. After the merge, the user updates the plugin (`copilot plugin update wintermute@ai-tools`), restarts the app, checks in **Customize → Installed** that neither skill is listed, and removes the wintermute line from the memory of any Project that still has it.

---

## Phase 2a (only after a go)

### Task 15: Write the Phase 2 plan

Unit `projects-phase2-plan`: a document unit, drafted at the document draft row, fact-checked by another vendor, and reviewed and checked as a PR.

**Files:**
- Create: `docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md`
- Create: `docs/superpowers/plans/<date>-wintermute-projects-phase-2.md`

**Interfaces:**
- Consumes: design 8.15 and section 10 (U7, U8, U12, U14), the checked findings, and the trial's session logs.
- Produces: the plan for units `engine-project-roots`, `engine-project-results`, `engine-schedules`, `projects-skill-fixes` and `projects-docs`, with the scope, dependencies, critical flags and tiers in this plan's Units table.

- [ ] **Step 1: Commit the public findings**

Copy the checked public summary from `$OUT` to `docs/superpowers/specs/<trial date>-wintermute-projects-trial-findings.md`, unchanged.

- [ ] **Step 2: Build fixtures from an allowlist**

From the trial's logs, take only these event types and fields, and give every ID, path, name and text a synthetic value: `skill.invoked` (`type`, `name`, `pluginName`, `trigger`, `timestamp`); `user.message` with `source: "agent-coordinator-results"` (the record's field names and an invented handoff text); the no-handoff notice, if one arrived; `relay_session_input` start and completion (`request_id`, `context` with an invented tag, the result's `outcome`); and `session_automations` columns, if a schedule ran. Copy no prompt, answer, username or path.

- [ ] **Step 3: Write the plan**

Follow the writing-plans skill: the header with **Spec:** pointing to `docs/superpowers/specs/2026-11-19-wintermute-projects-design.md`; the Global Constraints of this plan that still apply (not "Nothing in the engine before the gate", and not the run rules); file structure; one section per unit with TDD tasks, exact paths, test code and the commands `npm test && npm run validate` from `ghcp/plugins/wintermute/`; a version bump per PR; `projects-docs` after the engine units and `projects-skill-fixes`; and no placeholders. Check every code block in a scratch copy of the plugin outside the repository.

- [ ] **Step 4: Commit, push and hand off**

```bash
git add docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: plan wintermute Projects phase 2 and record the trial findings"
git push
```

Hand off with the pushed commit for the fact-check, the review and the claims check. The user approves the plan before any Phase 2 unit starts.
