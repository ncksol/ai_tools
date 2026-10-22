import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isStableVersion, releaseNotesProblem } from './release.mjs';

export const AGENTS_DIR = 'com.github.copilot/agents';
export const PACKAGED_AGENTS = Object.freeze([
  'orchestrator', 'session-orchestrator', 'hands-on-orchestrator', 'hands-on-session-orchestrator', 'orchestrator-worker', 'session-worker',
]);
const BARE_ID = new RegExp(`(?:agent_type|kickoff\\.agent):\\s*"(${PACKAGED_AGENTS.join('|')})"`, 'g');

/**
 * Agent frontmatter is checked against a strict, flat subset of YAML, so that a value this check accepts reads the same in
 * any YAML parser. Each line is `key: value`, with a lowercase kebab-case key. A value is one of:
 * - a plain scalar on one line: it must not start with a YAML indicator (`[]{},&*!|>'"%@` or a backtick, `#`, or `-`,
 *   `?` or `:` followed by a space), and must not contain `: ` or ` #` or end with `:`;
 * - a single-quoted scalar, `'...'`, where `''` stands for one quote;
 * - a double-quoted scalar, `"..."`, with JSON escapes only;
 * - a flow sequence written as a JSON array of strings, such as `tools: ["view", "grep"]`.
 * Block scalars (`|`, `>`), nested maps, comments and multi-line values are not part of the subset.
 */
const PLAIN_START = /^(?:[[\]{},&*!|>'"%@`#]|[-?:](?:\s|$))/;

function scalar(raw) {
  if (raw.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(raw)) return { error: 'has an unterminated or malformed double-quoted string' };
    try {
      return { value: JSON.parse(raw) };
    } catch {
      return { error: 'uses an escape outside JSON escapes in a double-quoted string' };
    }
  }
  if (raw.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(raw)) return { error: 'has an unterminated or malformed single-quoted string' };
    return { value: raw.slice(1, -1).replace(/''/g, "'") };
  }
  if (raw.startsWith('[')) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value) && value.every(item => typeof item === 'string' && item)) return { value };
    } catch {
      // Reported below.
    }
    return { error: 'must be a JSON array of non-empty strings' };
  }
  if (PLAIN_START.test(raw)) return { error: 'starts with a YAML indicator; quote it' };
  if (/: |:$| #|\t/.test(raw)) return { error: 'contains ": ", " #", a tab or a trailing ":"; quote it' };
  return { value: raw };
}

/** Parses an agent file's frontmatter under the subset above; `fields` holds the decoded values. */
export function parseAgentFrontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return { errors: ['missing or invalid frontmatter'], fields: {} };
  const errors = [];
  const fields = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z-]*):(?:[ ]+(.*?))?[ ]*$/);
    if (!match) {
      errors.push(`unsupported frontmatter line: ${line}`);
      continue;
    }
    const [, key, raw = ''] = match;
    if (Object.hasOwn(fields, key)) errors.push(`duplicate frontmatter key ${key}`);
    if (!raw) {
      errors.push(`frontmatter ${key} has no value`);
      fields[key] = null;
      continue;
    }
    const result = scalar(raw);
    if (result.error) errors.push(`frontmatter ${key} ${result.error}`);
    else if (key === 'tools' && !Array.isArray(result.value)) errors.push('frontmatter tools must be a JSON array of non-empty strings');
    fields[key] = result.error ? null : result.value;
  }
  for (const key of ['name', 'description']) {
    if (Object.hasOwn(fields, key) && fields[key] === null) continue;
    if (typeof fields[key] !== 'string' || !fields[key]) errors.push(`missing frontmatter ${key}`);
  }
  return { errors, fields };
}

/** The package's checks: the bundled agents, their IDs, one version everywhere and a CHANGELOG entry for it. */
export async function validatePackage(root, repositoryRoot, manifest) {
  const errors = [];
  if ('agents' in manifest) errors.push(`plugin.json must not declare "agents": Agent Plugins 1.0 plugins load agents only from ${AGENTS_DIR}/`);
  for (const name of PACKAGED_AGENTS) {
    const file = `${AGENTS_DIR}/${name}.agent.md`;
    let text;
    try {
      text = await readFile(path.join(root, file), 'utf8');
    } catch (error) {
      errors.push(error.code === 'ENOENT' ? `${file}: required agent is missing` : `${file}: ${error.message}`);
      continue;
    }
    const parsed = parseAgentFrontmatter(text);
    for (const error of parsed.errors) errors.push(`${file}: ${error}`);
    if (typeof parsed.fields.name === 'string' && parsed.fields.name !== name) errors.push(`${file}: frontmatter name ${parsed.fields.name} must match the file name ${name}`);
    for (const [, bare] of text.matchAll(BARE_ID)) errors.push(`${file}: start ${bare} by its plugin ID "${manifest.name}:${bare}"`);
    try {
      await access(path.join(repositoryRoot, 'ghcp/agents', `${name}.agent.md`));
      errors.push(`ghcp/agents/${name}.agent.md: the plugin ships this agent, so no copy may stay in ghcp/agents/`);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`ghcp/agents/${name}.agent.md: ${error.message}`);
    }
  }
  try {
    const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    // validate-plugin.mjs reports a version that breaks the version rule.
    if (isStableVersion(manifest.version)) {
      const problem = releaseNotesProblem(changelog, manifest.version);
      if (problem) errors.push(problem);
    }
  } catch (error) {
    errors.push(error.code === 'ENOENT' ? 'CHANGELOG.md: required file is missing' : `CHANGELOG.md: ${error.message}`);
  }
  return errors;
}
