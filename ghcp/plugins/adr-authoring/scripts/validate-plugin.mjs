#!/usr/bin/env node
import { access, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdr } from './adr-contract.mjs';

const skillRoot = 'skills/adr-write';
const exampleNames = ['01-queue', '02-region', '03-retention'];
const resources = [
  'README.md',
  'LICENSE',
  'agents/adr-writer.agent.md',
  `${skillRoot}/SKILL.md`,
  `${skillRoot}/references/template.md`,
  `${skillRoot}/references/style-guide.md`,
  `${skillRoot}/references/review-rubric.md`,
  ...exampleNames.flatMap(name => [`${skillRoot}/examples/${name}-brief.md`, `${skillRoot}/examples/${name}-adr.md`]),
  'evaluations/README.md',
  'evaluations/cases.md',
  'scripts/adr-contract.mjs',
  'scripts/validate-adr.mjs',
  'scripts/validate-plugin.mjs',
  'tests/validate-adr.test.mjs',
  'tests/validate-plugin.test.mjs',
];

export async function validatePlugin(root, repositoryRoot) {
  root = path.resolve(root);
  const errors = [];

  async function read(file, base = root) {
    try {
      const text = await readFile(path.join(base, file), 'utf8');
      if (!text.trim()) errors.push(`${file}: required file is empty`);
      return text;
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      return null;
    }
  }

  async function json(file, base = root) {
    const text = await read(file, base);
    if (text === null) return {};
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${file}: expected a JSON object`);
        return {};
      }
      return value;
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      return {};
    }
  }

  async function list(directory) {
    try {
      return await readdir(path.join(root, directory));
    } catch (error) {
      errors.push(`${directory}: ${error.message}`);
      return [];
    }
  }

  const [manifest, pkg, marketplace] = await Promise.all([
    json('plugin.json'), json('package.json'),
    json('.github/plugin/marketplace.json', repositoryRoot),
  ]);
  if (manifest.name !== 'adr-authoring' || pkg.name !== 'adr-authoring') {
    errors.push('plugin.json and package.json name must be adr-authoring');
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push('plugin.json version must be semantic x.y.z');
  }
  if (pkg.version !== manifest.version) errors.push('package.json version must match plugin.json version');
  if (manifest.agents !== 'agents/') errors.push('plugin.json agents must be agents/');
  if (manifest.skills !== 'skills/') errors.push('plugin.json skills must be skills/');
  for (const field of ['hooks', 'mcpServers']) {
    if (field in manifest) errors.push(`plugin.json must not declare ${field}`);
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    errors.push('plugin.json requires a description');
  }
  if (manifest.license !== 'MIT') errors.push('plugin.json license must be MIT');
  if (pkg.engines?.node !== '>=18') errors.push('package.json must declare Node.js >=18');
  if (pkg.type !== 'module') errors.push('package.json type must be module');
  if (pkg.scripts?.test !== 'node --test' ||
      pkg.scripts?.validate !== 'node scripts/validate-plugin.mjs' ||
      pkg.scripts?.['validate:adr'] !== 'node scripts/validate-adr.mjs') {
    errors.push('package.json must expose the bundled test and validator commands');
  }
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
    errors.push('The plugin must not require package dependencies');
  }

  const entries = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.filter(entry => entry?.name === 'adr-authoring') : [];
  if (entries.length !== 1) errors.push('Root marketplace must contain exactly one adr-authoring entry');
  for (const entry of entries) {
    if (entry.version !== manifest.version) errors.push('Root marketplace version must match plugin.json version');
    if (typeof entry.source !== 'string' || path.resolve(repositoryRoot, entry.source) !== root) {
      errors.push('Root marketplace source must resolve to this plugin directory');
    }
  }
  for (const file of ['marketplace.json', '.github/plugin/marketplace.json']) {
    try {
      await access(path.join(root, file));
      errors.push(`${file}: plugin-local marketplace manifests are forbidden`);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${file}: ${error.message}`);
    }
  }
  const agents = (await list('agents')).filter(name => name.endsWith('.agent.md'));
  if (agents.length !== 1 || agents[0] !== 'adr-writer.agent.md') {
    errors.push('Expected exactly one agent named adr-writer.agent.md');
  }
  const skills = await list('skills');
  if (skills.length !== 1 || skills[0] !== 'adr-write') errors.push('Expected exactly one skill directory named adr-write');
  const texts = new Map(await Promise.all(resources.map(async file => [file, await read(file)])));

  function frontmatter(file, allowed) {
    const text = texts.get(file);
    if (text === null) return {};
    const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!block) {
      errors.push(`${file}: missing or invalid frontmatter`);
      return {};
    }
    const result = {};
    const lines = block[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^([a-z-]+):[ \t]*(.*)$/);
      if (!match) {
        errors.push(`${file}: unsupported frontmatter line ${lines[i]}`);
        continue;
      }
      const key = match[1];
      let value = match[2].trim();
      if (value === '>-') {
        const parts = [];
        while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) {
          parts.push(lines[++i].trim());
        }
        value = parts.join(' ');
      } else if (/^[\[\]{}&*!|>'"%@`#]|:\s|\s#/.test(value)) {
        errors.push(`${file}: ${key} must be a plain scalar or folded >- string`);
      }
      if (Object.hasOwn(result, key)) errors.push(`${file}: duplicate frontmatter key ${key}`);
      if (!allowed.includes(key)) errors.push(`${file}: unsupported frontmatter key ${key}`);
      result[key] = value;
    }
    for (const key of allowed) {
      if (!result[key]?.trim()) errors.push(`${file}: missing frontmatter ${key}`);
    }
    if (file.endsWith('/SKILL.md') && block[1].length > 1024) {
      errors.push(`${file}: frontmatter exceeds 1024 characters`);
    }
    return result;
  }

  frontmatter('agents/adr-writer.agent.md', ['description']);
  const skill = frontmatter(`${skillRoot}/SKILL.md`, ['name', 'description']);
  if (skill.name !== 'adr-write') errors.push('Skill frontmatter name must be adr-write');
  const template = texts.get(`${skillRoot}/references/template.md`);
  if (template !== null) {
    const record = template.match(/```markdown\r?\n([\s\S]*?)\r?\n```/);
    if (!record) {
      errors.push('references/template.md: missing fenced Markdown record template');
    } else {
      const filled = record[1].replaceAll('{{STATUS}}', 'Proposed')
        .replaceAll('{{DECISION_DATE}}', 'Not provided')
        .replace(/\{\{[A-Z_]+\}\}/g, 'Example content');
      errors.push(...validateAdr(filled).map(error => `references/template.md: ${error}`));
    }
  }
  for (const name of exampleNames) {
    const file = `${skillRoot}/examples/${name}-adr.md`;
    const text = texts.get(file);
    if (text !== null) errors.push(...validateAdr(text).map(error => `${file}: ${error}`));
  }
  const cases = texts.get('evaluations/cases.md');
  if (cases !== null) {
    const numbers = [...cases.matchAll(/^## Case (\d{2}): /gm)].map(match => Number(match[1]));
    if (numbers.join(',') !== '1,2,3,4,5,6,7,8,9,10') {
      errors.push('evaluations/cases.md must contain ten numbered cases (01 through 10)');
    }
  }
  for (const [file, text] of texts) {
    if (text === null || !file.endsWith('.md')) continue;
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\n]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      let local;
      try {
        local = decodeURIComponent(target.split('#')[0]);
      } catch (error) {
        errors.push(`${file}: invalid link ${target}: ${error.message}`);
        continue;
      }
      const absolute = path.resolve(root, path.dirname(file), local);
      const relative = path.relative(root, absolute);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        errors.push(`${file}: link ${target} points outside the plugin`);
        continue;
      }
      try {
        await access(absolute);
      } catch (error) {
        errors.push(`${file}: broken local link ${target}: ${error.message}`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = await validatePlugin(root, path.resolve(root, '../../..'));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('Plugin validation passed: manifests, resources, links, and example structure (not semantic quality).');
  }
}
