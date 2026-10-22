import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('the plugin ships the six orchestrator agents, each named after its file', () => {
  assert.deepEqual([...PACKAGED_AGENTS].sort(), [
    'hands-on-orchestrator', 'hands-on-session-orchestrator', 'orchestrator', 'orchestrator-worker', 'session-orchestrator', 'session-worker',
  ]);
  for (const name of PACKAGED_AGENTS) {
    const { errors, fields } = parseAgentFrontmatter(readFileSync(agentFile(pluginRoot, name), 'utf8'));
    assert.deepEqual(errors, [], name);
    assert.equal(fields.name, name);
  }
});

test('a missing packaged agent is reported', async () => {
  const { repo, root } = sandbox();
  rmSync(agentFile(root, 'session-worker'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/session-worker.agent.md: required agent is missing'), errors.join('\n'));
});

test('an agent whose frontmatter name differs from its file name, or whose frontmatter does not parse, is reported', async () => {
  const { repo, root } = sandbox();
  const worker = agentFile(root, 'orchestrator-worker');
  writeFileSync(worker, readFileSync(worker, 'utf8').replace('name: orchestrator-worker', 'name: worker'));
  const session = agentFile(root, 'session-worker');
  writeFileSync(session, readFileSync(session, 'utf8').replace(/^tools: .*$/m, 'tools: [bash, view'));
  const plain = agentFile(root, 'orchestrator');
  writeFileSync(plain, readFileSync(plain, 'utf8').replace(/^---\n/, ''));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/orchestrator-worker.agent.md: frontmatter name worker must match the file name orchestrator-worker'), errors.join('\n'));
  assert.ok(errors.includes('com.github.copilot/agents/session-worker.agent.md: frontmatter tools must be a JSON array of non-empty strings'), errors.join('\n'));
  assert.ok(errors.includes('com.github.copilot/agents/orchestrator.agent.md: missing or invalid frontmatter'), errors.join('\n'));
});

test('an agent that starts a worker by its bare name is reported', async () => {
  const { repo, root } = sandbox();
  for (const [name, from, to] of [
    ['orchestrator', 'agent_type: "wintermute:orchestrator-worker"', 'agent_type: "orchestrator-worker"'],
    ['session-orchestrator', 'kickoff.agent: "wintermute:session-worker"', 'kickoff.agent: "session-worker"'],
  ]) {
    const file = agentFile(root, name);
    const text = readFileSync(file, 'utf8');
    assert.ok(text.includes(from), name);
    writeFileSync(file, text.replace(from, to));
  }
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.includes('com.github.copilot/agents/orchestrator.agent.md: start orchestrator-worker by its plugin ID "wintermute:orchestrator-worker"'), errors.join('\n'));
  assert.ok(errors.includes('com.github.copilot/agents/session-orchestrator.agent.md: start session-worker by its plugin ID "wintermute:session-worker"'), errors.join('\n'));
});

test('a copy of a packaged agent left in ghcp/agents is reported', async () => {
  const { repo, root } = sandbox();
  mkdirSync(path.join(repo, 'ghcp/agents'), { recursive: true });
  cpSync(agentFile(root, 'orchestrator'), path.join(repo, 'ghcp/agents/orchestrator.agent.md'));
  const errors = await validatePlugin(root, repo);
  assert.ok(errors.some(error => error.startsWith('ghcp/agents/orchestrator.agent.md: the plugin ships this agent')), errors.join('\n'));
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
  for (const file of ['plugin.json', 'package.json']) editJson(path.join(root, file), value => { value.version = '0.2.1'; });
  editJson(path.join(repo, '.github/plugin/marketplace.json'), marketplace => { marketplace.plugins.find(plugin => plugin.name === 'wintermute').version = '0.2.1'; });
  let errors = await validatePlugin(root, repo);
  assert.deepEqual(errors, ['CHANGELOG.md must have a "## 0.2.1" entry for the current version']);
  writeFileSync(path.join(root, 'CHANGELOG.md'), `${readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')}\n## [0.2.1]\n\n- A fix.\n`);
  assert.deepEqual(await validatePlugin(root, repo), []);
  rmSync(path.join(root, 'CHANGELOG.md'));
  errors = await validatePlugin(root, repo);
  assert.deepEqual(errors, ['CHANGELOG.md: required file is missing']);
});

test('agent frontmatter follows a strict flat YAML subset and decodes quoted values', async () => {
  const parse = lines => parseAgentFrontmatter(`---\n${lines.join('\n')}\n---\n\nBody.\n`);
  assert.deepEqual(parse(['name: orchestrator', 'description: Coordinates work: dispatch and track']).errors,
    ['frontmatter description contains ": ", " #", a tab or a trailing ":"; quote it']);
  assert.deepEqual(parse(['name: orchestrator', 'description: Plans work # and tracks it']).errors,
    ['frontmatter description contains ": ", " #", a tab or a trailing ":"; quote it']);
  assert.deepEqual(parse(['name: orchestrator', 'description: "Plans work']).errors,
    ['frontmatter description has an unterminated or malformed double-quoted string']);
  assert.deepEqual(parse(['name: orchestrator', "description: 'Plans work"]).errors,
    ['frontmatter description has an unterminated or malformed single-quoted string']);
  assert.deepEqual(parse(['name: orchestrator', 'description: "Plans" work']).errors,
    ['frontmatter description has an unterminated or malformed double-quoted string']);
  assert.deepEqual(parse(['name: orchestrator', 'description: - Plans work']).errors, ['frontmatter description starts with a YAML indicator; quote it']);
  assert.deepEqual(parse(['name: orchestrator', 'description: >-', '  Plans work']).errors,
    ['frontmatter description starts with a YAML indicator; quote it', 'unsupported frontmatter line:   Plans work']);
  assert.deepEqual(parse(['name: orchestrator', 'description:']).errors, ['frontmatter description has no value']);
  assert.deepEqual(parse(['name: orchestrator', 'description: Plans', 'tools: [view, grep]']).errors,
    ['frontmatter tools must be a JSON array of non-empty strings']);
  const quoted = parse(['name: "orchestrator"', "description: 'Coordinates work: it''s quoted'", 'tools: ["view", "grep"]', 'model: ["a", "b"]']);
  assert.deepEqual(quoted.errors, []);
  assert.deepEqual(quoted.fields, { name: 'orchestrator', description: "Coordinates work: it's quoted", tools: ['view', 'grep'], model: ['a', 'b'] });
});

test('a quoted agent name is compared after decoding, and an invalid description is reported by the validator', async () => {
  const { repo, root } = sandbox();
  const file = agentFile(root, 'orchestrator');
  writeFileSync(file, readFileSync(file, 'utf8').replace('name: orchestrator\n', 'name: "orchestrator"\n'));
  assert.deepEqual(await validatePlugin(root, repo), []);
  const worker = agentFile(root, 'session-worker');
  writeFileSync(worker, readFileSync(worker, 'utf8').replace(/^description: .*$/m, 'description: Runs one unit: a branch or a job'));
  assert.deepEqual(await validatePlugin(root, repo),
    ['com.github.copilot/agents/session-worker.agent.md: frontmatter description contains ": ", " #", a tab or a trailing ":"; quote it']);
});
