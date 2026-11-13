import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { PACKAGED_AGENTS, parseAgentFrontmatter } from '../scripts/lib/validate-package.mjs';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '../../..');

function sandbox() {
  const repo = tempDir('swarm-validate-');
  const root = path.join(repo, 'ghcp/plugins/wintermute');
  mkdirSync(path.dirname(root), { recursive: true });
  cpSync(pluginRoot, root, { recursive: true });
  mkdirSync(path.join(repo, '.github/plugin'), { recursive: true });
  cpSync(path.join(repositoryRoot, '.github/plugin/marketplace.json'), path.join(repo, '.github/plugin/marketplace.json'));
  return { repo, root };
}

test('the plugin passes validation against the root marketplace', async () => {
  assert.deepEqual(await validatePlugin(pluginRoot, repositoryRoot), []);
});

test('a marketplace version that differs from plugin.json is reported', async () => {
  const { repo, root } = sandbox();
  const file = path.join(repo, '.github/plugin/marketplace.json');
  const marketplace = JSON.parse(readFileSync(file, 'utf8'));
  marketplace.plugins.find(plugin => plugin.name === 'wintermute').version = '9.9.9';
  writeFileSync(file, JSON.stringify(marketplace));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.includes('must match plugin.json version')), errors.join('\n'));
});

test('a plugin-local marketplace manifest is rejected', async () => {
  const { repo, root } = sandbox();
  writeFileSync(path.join(root, 'marketplace.json'), '{}');
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.includes('plugin-local marketplace manifests are forbidden')), errors.join('\n'));
});

test('package dependencies are rejected', async () => {
  const { repo, root } = sandbox();
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.dependencies = { 'left-pad': '1.0.0' };
  writeFileSync(file, JSON.stringify(pkg));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('the plugin must not require package dependencies'), errors.join('\n'));
});

const agentFile = (root, name) => path.join(root, 'com.github.copilot/agents', `${name}.agent.md`);
const editJson = (file, change) => {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  change(value);
  writeFileSync(file, JSON.stringify(value));
};

test('a missing or invalid Copilot logo reference is reported', async () => {
  const { repo, root } = sandbox();
  for (const logo of [undefined, '', ' ', 42]) {
    editJson(path.join(root, 'plugin.json'), manifest => { manifest.extensions['com.github.copilot'].logo = logo; });
    const errors = await validatePlugin(root, repo);
    assert.ok(errors.some(error => error.includes('logo must be a non-empty plugin-relative path')), errors.join('\n'));
  }
});

test('a wrong logo path is reported instead of accepting a missing image', async () => {
  const { repo, root } = sandbox();
  editJson(path.join(root, 'plugin.json'), manifest => { manifest.extensions['com.github.copilot'].logo = 'docs/images/missing.svg'; });
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.includes('logo file is missing')), errors.join('\n'));
});

test('a logo cannot escape the plugin directory through its path or a symlink', async () => {
  const { repo, root } = sandbox();
  const outside = path.join(repo, 'outside.svg');
  writeFileSync(outside, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  symlinkSync(outside, path.join(root, 'docs/images/linked.svg'));
  for (const logo of [outside, '../../../outside.svg', 'docs/images/linked.svg']) {
    editJson(path.join(root, 'plugin.json'), manifest => { manifest.extensions['com.github.copilot'].logo = logo; });
    const errors = await validatePlugin(root, repo);
    assert.ok(errors.some(error => error.includes('logo must resolve to a file inside the plugin directory')), `${logo}: ${errors.join('\n')}`);
  }
});

test('a logo must be an SVG or PNG file, not a directory or another image type', async () => {
  const { repo, root } = sandbox();
  writeFileSync(path.join(root, 'docs/images/logo.gif'), 'GIF89a');
  mkdirSync(path.join(root, 'docs/images/directory.svg'));
  for (const [logo, expected] of [
    ['docs/images/logo.gif', 'logo must be an SVG or PNG'],
    ['docs/images/directory.svg', 'logo must be a regular file'],
  ]) {
    editJson(path.join(root, 'plugin.json'), manifest => { manifest.extensions['com.github.copilot'].logo = logo; });
    const errors = await validatePlugin(root, repo);
    assert.ok(errors.some(error => error.includes(expected)), errors.join('\n'));
  }
});

test('logo byte limits accept the boundary and reject one byte over for each format', async () => {
  const { repo, root } = sandbox();
  for (const [extension, limit] of [['svg', 262144], ['png', 8388608]]) {
    const logo = `docs/images/limit.${extension}`;
    const file = path.join(root, logo);
    writeFileSync(file, '');
    editJson(path.join(root, 'plugin.json'), manifest => { manifest.extensions['com.github.copilot'].logo = logo; });
    truncateSync(file, limit);
    assert.deepEqual(await validatePlugin(root, repo), [], extension);
    truncateSync(file, limit + 1);
    const errors = await validatePlugin(root, repo);
    assert.ok(errors.some(error => error.includes(`logo exceeds the app's ${limit}-byte limit`)), errors.join('\n'));
  }
});

test('the plugin ships the two agents, each named after its file', () => {
  assert.deepEqual([...PACKAGED_AGENTS].sort(), ['wintermute-core', 'wintermute-peon']);
  for (const name of PACKAGED_AGENTS) {
    const { errors, fields } = parseAgentFrontmatter(readFileSync(agentFile(pluginRoot, name), 'utf8'));
    assert.deepEqual(errors, [], name);
    assert.equal(fields.name, name);
  }
});

test('an agent file the plugin does not package is reported', async () => {
  const { repo, root } = sandbox();
  cpSync(agentFile(root, 'wintermute-core'), agentFile(root, 'stray-agent'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/stray-agent.agent.md: agent is not packaged'), errors.join('\n'));
});

test('a missing packaged agent is reported', async () => {
  const { repo, root } = sandbox();
  rmSync(agentFile(root, 'wintermute-peon'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/wintermute-peon.agent.md: required agent is missing'), errors.join('\n'));
});

test('an agent whose frontmatter name differs from its file name, or whose frontmatter does not parse, is reported', async () => {
  const { repo, root } = sandbox();
  const worker = agentFile(root, 'wintermute-peon');
  writeFileSync(worker, readFileSync(worker, 'utf8').replace('name: wintermute-peon', 'name: worker').replace(/^tools: .*$/m, 'tools: [bash, view'));
  const plain = agentFile(root, 'wintermute-core');
  writeFileSync(plain, readFileSync(plain, 'utf8').replace(/^---\n/, ''));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/wintermute-peon.agent.md: frontmatter name worker must match the file name wintermute-peon'), errors.join('\n'));
  assert.ok(errors.includes('com.github.copilot/agents/wintermute-peon.agent.md: frontmatter tools must be a JSON array of non-empty strings'), errors.join('\n'));
  assert.ok(errors.includes('com.github.copilot/agents/wintermute-core.agent.md: missing or invalid frontmatter'), errors.join('\n'));
});

test('an agent that starts a worker by its bare name is reported', async () => {
  const { repo, root } = sandbox();
  const file = agentFile(root, 'wintermute-core');
  const text = readFileSync(file, 'utf8');
  const from = 'kickoff.agent: "wintermute:wintermute-peon"';
  assert.ok(text.includes(from));
  writeFileSync(file, text.replace(from, 'kickoff.agent: "wintermute-peon"'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/wintermute-core.agent.md: start wintermute-peon by its plugin ID "wintermute:wintermute-peon"'), errors.join('\n'));
});

test('a copy of a packaged agent left in ghcp/agents is reported', async () => {
  const { repo, root } = sandbox();
  mkdirSync(path.join(repo, 'ghcp/agents'), { recursive: true });
  cpSync(agentFile(root, 'wintermute-core'), path.join(repo, 'ghcp/agents/wintermute-core.agent.md'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.startsWith('ghcp/agents/wintermute-core.agent.md: the plugin ships this agent')), errors.join('\n'));
});

test('an agents field in plugin.json is reported, since Agent Plugins 1.0 ignores it', async () => {
  const { repo, root } = sandbox();
  editJson(path.join(root, 'plugin.json'), manifest => { manifest.agents = 'agents/'; });
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.startsWith('plugin.json must not declare "agents"')), errors.join('\n'));
});

test('a package.json version that differs from plugin.json is reported', async () => {
  const { repo, root } = sandbox();
  editJson(path.join(root, 'package.json'), pkg => { pkg.version = '9.9.9'; });
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('package.json version must match plugin.json version'), errors.join('\n'));
});

test('a CHANGELOG with no entry for the current version, or no CHANGELOG, is reported', async () => {
  const { repo, root } = sandbox();
  for (const file of ['plugin.json', 'package.json']) editJson(path.join(root, file), value => { value.version = '9.9.9'; });
  editJson(path.join(repo, '.github/plugin/marketplace.json'), marketplace => { marketplace.plugins.find(plugin => plugin.name === 'wintermute').version = '9.9.9'; });
  let errors = await validatePlugin(root, repo);
  assert.deepEqual(errors, ['CHANGELOG.md must have a "## 9.9.9" entry for the current version']);
  writeFileSync(path.join(root, 'CHANGELOG.md'), `${readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')}\n## [9.9.9]\n\n- A fix.\n`);
  assert.deepEqual(await validatePlugin(root, repo), []);
  rmSync(path.join(root, 'CHANGELOG.md'));
  errors = await validatePlugin(root, repo);
  assert.deepEqual(errors, ['CHANGELOG.md: required file is missing']);
});

test('agent frontmatter follows a strict flat YAML subset and decodes quoted values', async () => {
  const parse = lines => parseAgentFrontmatter(`---\n${lines.join('\n')}\n---\n\nBody.\n`);
  assert.deepEqual(parse(['name: wintermute-core', 'description: Coordinates work: dispatch and track']).errors,
    ['frontmatter description contains ": ", " #", a tab or a trailing ":"; quote it']);
  assert.deepEqual(parse(['name: wintermute-core', 'description: Plans work # and tracks it']).errors,
    ['frontmatter description contains ": ", " #", a tab or a trailing ":"; quote it']);
  assert.deepEqual(parse(['name: wintermute-core', 'description: "Plans work']).errors,
    ['frontmatter description has an unterminated or malformed double-quoted string']);
  assert.deepEqual(parse(['name: wintermute-core', "description: 'Plans work"]).errors,
    ['frontmatter description has an unterminated or malformed single-quoted string']);
  assert.deepEqual(parse(['name: wintermute-core', 'description: "Plans" work']).errors,
    ['frontmatter description has an unterminated or malformed double-quoted string']);
  assert.deepEqual(parse(['name: wintermute-core', 'description: - Plans work']).errors, ['frontmatter description starts with a YAML indicator; quote it']);
  assert.deepEqual(parse(['name: wintermute-core', 'description: >-', '  Plans work']).errors,
    ['frontmatter description starts with a YAML indicator; quote it', 'unsupported frontmatter line:   Plans work']);
  assert.deepEqual(parse(['name: wintermute-core', 'description:']).errors, ['frontmatter description has no value']);
  assert.deepEqual(parse(['name: wintermute-core', 'description: Plans', 'tools: [view, grep]']).errors,
    ['frontmatter tools must be a JSON array of non-empty strings']);
  const quoted = parse(['name: "wintermute-core"', "description: 'Coordinates work: it''s quoted'", 'tools: ["view", "grep"]', 'model: ["a", "b"]']);
  assert.deepEqual(quoted.errors, []);
  assert.deepEqual(quoted.fields, { name: 'wintermute-core', description: "Coordinates work: it's quoted", tools: ['view', 'grep'], model: ['a', 'b'] });
});

test('a quoted agent name is compared after decoding, and an invalid description is reported by the validator', async () => {
  const { repo, root } = sandbox();
  const file = agentFile(root, 'wintermute-core');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: wintermute-core\n', 'name: "wintermute-core"\n'));
  assert.deepEqual(await validatePlugin(root, repo), []);
  const worker = agentFile(root, 'wintermute-peon');
  writeFileSync(worker, readFileSync(worker, 'utf8').replace(/^description: .*$/m, 'description: Runs one unit: a branch or a job'));
  assert.deepEqual(await validatePlugin(root, repo),
    ['com.github.copilot/agents/wintermute-peon.agent.md: frontmatter description contains ": ", " #", a tab or a trailing ":"; quote it']);
});

test('validate applies the release version rule: stable SemVer with no leading zeros', async () => {
  for (const version of ['0.02.0', '01.2.0', '0.2.0-beta.1', '0.2']) {
    const { repo, root } = sandbox();
    for (const file of ['plugin.json', 'package.json']) editJson(path.join(root, file), value => { value.version = version; });
    editJson(path.join(repo, '.github/plugin/marketplace.json'), marketplace => { marketplace.plugins.find(plugin => plugin.name === 'wintermute').version = version; });
    const errors = await validatePlugin(root, repo);
    assert.deepEqual(errors, ['plugin.json version must be stable SemVer X.Y.Z with no leading zeros'], version);
  }
});
