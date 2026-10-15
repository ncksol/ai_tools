#!/usr/bin/env node
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = 'swarm-dashboard';
export const REQUIRED_FILES = ['LICENSE', 'plugin.json', 'package.json', 'scripts/validate-plugin.mjs'];
const TEST_SCRIPT = 'node --test tests/*.test.mjs';
const VALIDATE_SCRIPT = 'node scripts/validate-plugin.mjs';

export async function validatePlugin(root, repositoryRoot) {
  root = path.resolve(root);
  const errors = [];

  async function json(file, base = root) {
    try {
      const value = JSON.parse(await readFile(path.join(base, file), 'utf8'));
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

  const [manifest, pkg, marketplace] = await Promise.all([
    json('plugin.json'),
    json('package.json'),
    json('.github/plugin/marketplace.json', repositoryRoot),
  ]);
  if (manifest.name !== PLUGIN_NAME || pkg.name !== PLUGIN_NAME) errors.push(`plugin.json and package.json name must be ${PLUGIN_NAME}`);
  if (!/^[a-z0-9-]{1,64}$/.test(manifest.name ?? '')) errors.push('plugin.json name must be kebab-case and at most 64 characters');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) errors.push('plugin.json version must be semantic x.y.z');
  if (pkg.version !== manifest.version) errors.push('package.json version must match plugin.json version');
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) errors.push('plugin.json requires a description');
  if (manifest.license !== 'MIT') errors.push('plugin.json license must be MIT');
  for (const field of ['mcpServers', 'hooks']) {
    if (field in manifest) errors.push(`plugin.json must not declare ${field}`);
  }
  if (pkg.private !== true) errors.push('package.json must be private');
  if (pkg.type !== 'module') errors.push('package.json type must be module');
  if (pkg.engines?.node !== '>=18') errors.push('package.json must declare Node.js >=18');
  if (pkg.scripts?.test !== TEST_SCRIPT || pkg.scripts?.validate !== VALIDATE_SCRIPT) {
    errors.push('package.json must expose the test and validate commands');
  }
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
    errors.push('the plugin must not require package dependencies');
  }

  const entries = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.filter(entry => entry?.name === PLUGIN_NAME)
    : [];
  if (entries.length !== 1) errors.push(`root marketplace must contain exactly one ${PLUGIN_NAME} entry`);
  for (const entry of entries) {
    if (entry.version !== manifest.version) {
      errors.push(`root marketplace version ${entry.version} must match plugin.json version ${manifest.version}`);
    }
    if (typeof entry.source !== 'string' || path.resolve(repositoryRoot, entry.source) !== root) {
      errors.push('root marketplace source must resolve to this plugin directory');
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
  for (const file of REQUIRED_FILES) {
    try {
      await access(path.join(root, file));
    } catch {
      errors.push(`${file}: required file is missing`);
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
    console.log('Plugin validation passed: manifests, root marketplace entry and required files.');
  }
}
