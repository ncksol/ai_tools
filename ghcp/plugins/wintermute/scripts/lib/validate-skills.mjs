import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTS_DIR, parseAgentFrontmatter } from './validate-package.mjs';

export const SKILLS_DIR = 'skills';
export const COORDINATOR_SKILL = 'wintermute-project';
export const WORKER_SKILL = 'wintermute-project-worker';
export const PROJECT_SKILLS = Object.freeze([COORDINATOR_SKILL, WORKER_SKILL]);
/** The agent whose pinned models list, tier table and "Never use these:" list the coordinator skill copies word for word. */
export const POLICY_AGENT = `${AGENTS_DIR}/wintermute-core.agent.md`;
export const POLICY_SECTION = 'Models and effort';
const NEVER_USE = 'Never use these:';
const PINNED = 'Pinned models:';
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
/** A level-two ATX heading: up to three spaces of indent, and an optional closing run of hashes, which isn't part of the name. */
const HEADING = /^ {0,3}##[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/**
 * The lines of a Markdown text, each marked fenced when it opens, closes or sits inside a code fence.
 * A fence opens with three or more backticks or tildes, and only a run of the same character, at least as long, with nothing after it closes it.
 */
function markFences(text) {
  const out = [];
  let open = null;
  for (const line of text.split(/\r?\n/)) {
    const match = FENCE.exec(line);
    if (open === null) {
      const opens = match !== null && !(match[1][0] === '`' && match[2].includes('`'));
      if (opens) open = match[1];
      out.push({ line, fenced: opens });
    } else {
      if (match && match[1][0] === open[0] && match[1].length >= open.length && match[2].trim() === '') open = null;
      out.push({ line, fenced: true });
    }
  }
  return out;
}

/** The `## ` headings of a Markdown text, outside code fences, in order. */
export function headingsOf(text) {
  return markFences(text).flatMap(({ line, fenced }) => {
    const match = fenced ? null : HEADING.exec(line);
    return match ? [match[1]] : [];
  });
}

/** The body of the first `## <name>` section, up to the next `## ` heading outside a code fence; null when there is none. */
export function sectionOf(text, name) {
  const lines = markFences(text);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].fenced ? null : HEADING.exec(lines[index].line);
    if (!match) continue;
    if (start >= 0) return lines.slice(start, index).map(entry => entry.line).join('\n');
    if (match[1] === name) start = index + 1;
  }
  return start >= 0 ? lines.slice(start).map(entry => entry.line).join('\n') : null;
}

const columns = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length;

/** A table's delimiter row, such as `|---|:--:|` or `--- | ---`, with or without outer pipes. */
function isDelimiterRow(line) {
  if (!line.includes('|')) return false;
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').every(cell => /^\s*:?-+:?\s*$/.test(cell));
}

/** The one Markdown table in a section, outside code fences: { table, error }. Every delimiter row outside a fence counts as a table. */
export function tierTable(section) {
  const runs = [];
  let delimiters = 0;
  let current = null;
  let continued = false;
  for (const { line, fenced } of markFences(section)) {
    if (!fenced && isDelimiterRow(line)) delimiters += 1;
    if (!fenced && line.startsWith('|')) {
      if (!current) runs.push(current = []);
      current.push(line);
    } else {
      if (current && line.trim() !== '') continued = true;
      current = null;
    }
  }
  const tables = Math.max(runs.length, delimiters);
  if (tables === 0) return { table: null, error: 'has no table' };
  if (tables > 1) return { table: null, error: `has ${tables} tables; the copy rule needs exactly one` };
  if (runs.length === 0) return { table: null, error: 'has a table whose rows don\'t start with "|"' };
  const [rows] = runs;
  if (rows.length < 3 || !SEPARATOR.test(rows[1])) return { table: null, error: 'has lines that start with "|" but are not a table with a header row, a separator row and body rows' };
  if (rows.some(row => columns(row) !== columns(rows[0]))) return { table: null, error: 'has a table whose rows have different numbers of columns' };
  if (continued) return { table: null, error: 'has a line right after its table, with no blank line between, that Markdown reads as another table row' };
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

/** The "Pinned models:" line and its list, up to the tier table or the end of the section, which must be list items: { pins, error }. */
export function pinList(section) {
  const lines = section.split(/\r?\n/);
  const start = lines.indexOf(PINNED);
  if (start < 0) return { pins: null, error: `has no "${PINNED}" line` };
  if (lines.indexOf(PINNED, start + 1) >= 0) return { pins: null, error: `has more than one "${PINNED}" line` };
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('|')) end += 1;
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  let items = 0;
  for (const line of lines.slice(start + 1, end)) {
    if (line.trim() === '') continue;
    if (line.startsWith('- ')) {
      items += 1;
    } else if (!(items > 0 && /^\s+\S/.test(line))) {
      return { pins: null, error: `has text after "${PINNED}" that is not a list item, so the list's end is unclear: ${JSON.stringify(line.slice(0, 60))}` };
    }
  }
  if (items === 0) return { pins: null, error: `has no list items under "${PINNED}"` };
  return { pins: lines.slice(start, end).join('\n'), error: null };
}

/** The pinned models list, the tier table and the "Never use these:" list of a file's "## Models and effort" section, with any reason they can't be read. */
export function policyBlocks(text) {
  const count = headingsOf(text).filter(heading => heading === POLICY_SECTION).length;
  if (count > 1) return { pins: null, table: null, neverUse: null, errors: [`has ${count} "## ${POLICY_SECTION}" sections; the copy rule needs exactly one`] };
  const section = sectionOf(text, POLICY_SECTION);
  if (section === null) return { pins: null, table: null, neverUse: null, errors: [`has no "## ${POLICY_SECTION}" section`] };
  const pins = pinList(section);
  const table = tierTable(section);
  const list = neverUseList(section);
  return {
    pins: pins.pins,
    table: table.table,
    neverUse: list.list,
    errors: [pins.error, table.error, list.error].filter(Boolean).map(error => `"## ${POLICY_SECTION}" ${error}`),
  };
}

/** The capitalised quoted names in a text, such as "Evidence and review": the sections and labels it refers to. */
export function quotedNames(text) {
  return [...new Set([...text.matchAll(/"([A-Z][^"\n]*)"/g)].map(match => match[1]))];
}

/** The bold labels of a Markdown text, outside code fences. */
const boldLabels = text => markFences(text).filter(entry => !entry.fenced).flatMap(({ line }) => [...line.matchAll(/\*\*([^*\n]+)\*\*/g)].map(match => match[1]));

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
  for (const [key, label] of [['pins', '"Pinned models:" list'], ['table', 'tier table'], ['neverUse', '"Never use these:" list']]) {
    if (source[key] !== null && copy[key] !== null && copy[key] !== source[key]) {
      errors.push(`${skillFile}: the ${label} differs from ${POLICY_AGENT} at its line ${firstDifferentLine(source[key], copy[key])}; copy it again word for word`);
    }
  }
  const known = new Set([...headingsOf(skillText), ...boldLabels(skillText)]);
  for (const block of [copy.pins, copy.table, copy.neverUse]) {
    if (block === null) continue;
    for (const name of quotedNames(block)) {
      if (!known.has(name)) errors.push(`${skillFile}: the copied model policy refers to "${name}", which is not a "## " heading or a bold label in the skill`);
    }
  }
  return errors;
}
