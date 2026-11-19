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
