import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export const AGENTS_DIR = 'com.github.copilot/agents';
export const PACKAGED_AGENTS = Object.freeze([
  'orchestrator', 'session-orchestrator', 'hands-on-orchestrator', 'hands-on-session-orchestrator', 'orchestrator-worker', 'session-worker',
]);
const BARE_ID = new RegExp(`(?:agent_type|kickoff\\.agent):\\s*"(${PACKAGED_AGENTS.join('|')})"`, 'g');

/** Parses an agent file's frontmatter: `key: value` lines, with `tools` as a JSON array of strings. */
export function parseAgentFrontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return { errors: ['missing or invalid frontmatter'], fields: {} };
  const errors = [];
  const fields = {};
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^([a-z][a-z-]*):[ \t]*(.*)$/);
    if (!match) {
      errors.push(`unsupported frontmatter line: ${line}`);
      continue;
    }
    const [, key, raw] = match;
    if (Object.hasOwn(fields, key)) errors.push(`duplicate frontmatter key ${key}`);
    let value = raw.trim();
    if (key === 'tools') {
      try {
        value = JSON.parse(value);
        if (!Array.isArray(value) || value.some(tool => typeof tool !== 'string' || !tool)) throw new Error('not a list of names');
      } catch {
        errors.push('tools must be a JSON array of tool names');
      }
    }
    fields[key] = value;
  }
  for (const key of ['name', 'description']) {
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
    const version = String(manifest.version ?? '').replace(/\./g, '\\.');
    if (!version || !new RegExp(`^## \\[?${version}\\]?(?:\\s|$)`, 'm').test(changelog)) {
      errors.push(`CHANGELOG.md must have a "## ${manifest.version}" entry for the current version`);
    }
  } catch (error) {
    errors.push(error.code === 'ENOENT' ? 'CHANGELOG.md: required file is missing' : `CHANGELOG.md: ${error.message}`);
  }
  return errors;
}
