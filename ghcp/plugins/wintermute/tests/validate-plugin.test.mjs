import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '../../..');

function sandbox() {
  const repo = tempDir('swarm-validate-');
  const root = path.join(repo, 'ghcp/plugins/swarm-dashboard');
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
  marketplace.plugins.find(plugin => plugin.name === 'swarm-dashboard').version = '9.9.9';
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
