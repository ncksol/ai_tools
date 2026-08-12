#!/usr/bin/env node
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(root, '../../..');
const errors = [];

const manifest = await json('plugin.json');
const marketplace = await json('.github/plugin/marketplace.json', repositoryRoot);
if (!/^[a-z0-9-]{1,64}$/.test(manifest.name ?? '')) errors.push('plugin.json name must be kebab-case and at most 64 characters');
if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) errors.push('plugin.json version must be semantic x.y.z');
if (manifest.mcpServers !== undefined) errors.push('plugin.json must not declare MCP servers');
if (manifest.hooks !== undefined) errors.push('plugin.json must not declare hooks');
await exists(manifest.agents ?? 'agents/', 'agents path');
await exists(Array.isArray(manifest.skills) ? manifest.skills[0] : manifest.skills ?? 'skills/', 'skills path');
const marketplaceEntry = marketplace.plugins?.find(plugin => plugin.name === manifest.name);
const expectedSource = path.relative(repositoryRoot, root);
if (!marketplaceEntry) {
  errors.push(`repository marketplace must list a plugin named ${manifest.name}`);
} else {
  if (path.resolve(repositoryRoot, marketplaceEntry.source ?? '') !== root) {
    errors.push(`marketplace source for ${manifest.name} must resolve to ${expectedSource}`);
  }
  if (marketplaceEntry.version !== manifest.version) {
    errors.push(`marketplace version ${marketplaceEntry.version} must match plugin.json version ${manifest.version}`);
  }
}

const agentDirectory = path.join(root, manifest.agents ?? 'agents');
const agentFiles = (await readdir(agentDirectory)).filter(name => name.endsWith('.agent.md')).sort();
if (agentFiles.length !== 9) errors.push(`expected 9 agents, found ${agentFiles.length}`);
const agentNames = new Set();
const discoveryAgentNames = new Set([
  'prg-contract',
  'prg-correctness',
  'prg-tests',
  'prg-security',
  'prg-data-compatibility',
  'prg-reliability'
]);
for (const file of agentFiles) {
  const text = await readFile(path.join(agentDirectory, file), 'utf8');
  const frontmatter = parseFrontmatter(text, `agents/${file}`);
  if (!frontmatter.name?.startsWith('prg-')) errors.push(`agents/${file} name must start with prg-`);
  if (agentNames.has(frontmatter.name)) errors.push(`duplicate agent name ${frontmatter.name}`);
  agentNames.add(frontmatter.name);
  if (!frontmatter.description) errors.push(`agents/${file} needs a description`);
  if (frontmatter.tools !== '[]') errors.push(`agents/${file} must use tools: []`);
  if (discoveryAgentNames.has(frontmatter.name)) {
    if (!text.includes('Return exactly one JSON array')) {
      errors.push(`agents/${file} must require exactly one JSON array`);
    }
    if (!text.includes('Do not wrap the array in a Markdown code fence')) {
      errors.push(`agents/${file} must forbid Markdown code fences`);
    }
    if (!text.includes('\\u0000')) {
      errors.push(`agents/${file} must require JSON-escaped control characters`);
    }
  }
}

const skillRoot = path.join(root, 'skills/review-pull-request');
const skillText = await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8');
const githubProviderText = await readFile(path.join(skillRoot, 'references/github-gh-cli-provider.md'), 'utf8');
const azureProviderText = await readFile(path.join(skillRoot, 'references/azure-devops-cli-provider.md'), 'utf8');
const skillFrontmatter = parseFrontmatter(skillText, 'skills/review-pull-request/SKILL.md');
if (skillFrontmatter.name !== 'review-pull-request') errors.push('skill name must be review-pull-request');
if (!skillFrontmatter.description?.includes('GitHub') || !skillFrontmatter.description?.includes('Azure DevOps')) {
  errors.push('skill description must trigger for both providers');
}
if (Object.keys(skillFrontmatter).some(key => !['name', 'description'].includes(key))) {
  errors.push('SKILL.md frontmatter may contain only name and description');
}
if (skillText.split(/\r?\n/).length > 500) errors.push('SKILL.md exceeds 500 lines');
if (!skillText.includes('separately installed `gh-cli` skill')) errors.push('SKILL.md must require the gh-cli skill for GitHub');
if (!skillText.includes('separately installed `azure-devops-cli` skill')) errors.push('SKILL.md must require the azure-devops-cli skill for Azure DevOps');
if (!skillText.includes('`prg-deduplicator`')) errors.push('SKILL.md must include semantic existing-review deduplication');
if (!githubProviderText.includes('First load and follow the separately installed `gh-cli` skill')) errors.push('GitHub provider must delegate to gh-cli');
if (!azureProviderText.includes('Load and follow the separately installed `azure-devops-cli` skill')) errors.push('Azure DevOps provider must delegate to azure-devops-cli');

for (const match of skillText.matchAll(/\]\((references\/[^)]+|scripts\/[^)]+)\)/g)) {
  await exists(path.join('skills/review-pull-request', match[1]), `SKILL.md reference ${match[1]}`);
}

for (const file of ['packet.schema.json', 'finding.schema.json', 'deduplication.schema.json']) {
  await json(path.join('skills/review-pull-request/references', file));
}

const requiredScripts = [
  'normalize-context.mjs',
  'build-review-plan.mjs',
  'process-discovery.mjs',
  'validate-findings.mjs',
  'fingerprint-findings.mjs',
  'deduplicate-findings.mjs',
  'apply-comments.mjs',
  'build-github-review.mjs',
  'build-azure-threads.mjs',
  'collect-github.sh',
  'collect-azure-devops.sh'
];
for (const file of requiredScripts) await exists(path.join('skills/review-pull-request/scripts', file), `script ${file}`);

if (errors.length) {
  console.error(`Plugin validation failed with ${errors.length} error(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Plugin validation passed: ${agentFiles.length} agents, 1 skill, zero MCP and hook dependencies.`);
}

async function json(relativePath, base = root) {
  try {
    return JSON.parse(await readFile(path.join(base, relativePath), 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: ${error.message}`);
    return {};
  }
}

async function exists(relativePath, label) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    errors.push(`${label} does not exist: ${relativePath}`);
  }
}

function parseFrontmatter(text, label) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    errors.push(`${label} has invalid frontmatter`);
    return {};
  }
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) {
      errors.push(`${label} has unsupported frontmatter syntax: ${line}`);
      continue;
    }
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}
