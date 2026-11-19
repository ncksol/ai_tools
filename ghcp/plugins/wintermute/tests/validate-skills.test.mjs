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
const policy = policyBlocks(coreText);
const tableRows = policy.table.split('\n');
const listLines = policy.neverUse.split('\n');

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

/** A change that replaces `from` with `to` in the sandbox's wintermute-core, after checking that it really changes the text. */
function editCore(from, to) {
  assert.ok(coreText.includes(from), `fixture text not found in ${POLICY_AGENT}`);
  const changed = coreText.replace(from, to);
  assert.notEqual(changed, coreText, 'the fixture edit changed nothing');
  return (repo, root) => writeFileSync(path.join(root, POLICY_AGENT), changed);
}

/** The tier table with its last row changed in its last cell. */
const changedTable = () => [...tableRows.slice(0, -1), `${tableRows.at(-1).replace(/\|\s*$/, '')} changed only in wintermute-core |`].join('\n');

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

test('a change to the tier table or the list in wintermute-core is reported as drift, at the first line that differs', async () => {
  const differs = (label, line) => `the ${label} differs from ${POLICY_AGENT} at its line ${line}`;
  const edits = [
    [editCore(policy.table, changedTable()), differs('tier table', tableRows.length)],
    [editCore(policy.neverUse, [listLines[0], '- Haiku at `max`.', ...listLines.slice(1)].join('\n')), differs('"Never use these:" list', 2)],
    [editCore(policy.neverUse, `${policy.neverUse}\n\n- Haiku at \`max\`: added only in wintermute-core, after a blank line.`), differs('"Never use these:" list', listLines.length + 1)],
  ];
  for (const [change, expected] of edits) assertReported(await errorsFor({}, change), expected);
});

test('text after the list in wintermute-core is reported instead of being left out of the copy', async () => {
  const errors = await errorsFor({}, editCore(policy.neverUse, `${policy.neverUse}\n\nA closing paragraph.`));
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

test('a second "## Models and effort" section in wintermute-core is reported instead of being ignored', async () => {
  const second = `\n## Models and effort\n\n${changedTable()}\n\n${policy.neverUse}\n`;
  const errors = await errorsFor({}, (repo, root) => writeFileSync(path.join(root, POLICY_AGENT), `${coreText}${second}`));
  assertReported(errors, `${POLICY_AGENT}: has 2 "## Models and effort" sections`);
});

test('a tier table inside a tilde code fence is not read as the table', async () => {
  const errors = await errorsFor({}, editCore(policy.table, `~~~markdown\n${policy.table}\n~~~`));
  assertReported(errors, `${POLICY_AGENT}: "## Models and effort" has no table`);
});

test('a second table without leading pipes is counted as a table', async () => {
  const errors = await errorsFor({}, editCore(policy.table, `${policy.table}\n\nTier | Note\n--- | ---\nLow | added only in wintermute-core`));
  assertReported(errors, `${POLICY_AGENT}: "## Models and effort" has 2 tables`);
});

test('a bold label that is only inside a code fence does not count as a label', async () => {
  const body = `${coordinatorBody({ labels: ['Follow-up jobs'] })}\n\`\`\`markdown\n- **Security review**: a sample.\n\`\`\`\n`;
  assertReported(await errorsFor({ [COORDINATOR_SKILL]: skillText(COORDINATOR_SKILL, { body }) }), 'refers to "Security review"');
});

test('a row without outer pipes right after the tier table is reported instead of being left out of the copy', async () => {
  const errors = await errorsFor({}, editCore(policy.table, `${policy.table}\nExample | fixture only | sample note`));
  assertReported(errors, `${POLICY_AGENT}: "## Models and effort" has a line right after its table`);
});

test('a heading with closing hashes counts as a second "## Models and effort" section', async () => {
  const second = `\n## Models and effort ##\n\n${changedTable()}\n\n${policy.neverUse}\n`;
  const errors = await errorsFor({}, (repo, root) => writeFileSync(path.join(root, POLICY_AGENT), `${coreText}${second}`));
  assertReported(errors, `${POLICY_AGENT}: has 2 "## Models and effort" sections`);
});
