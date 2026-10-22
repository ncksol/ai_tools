#!/usr/bin/env node
import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDashboard } from './lib/validate-dashboard.mjs';
import { validatePackage } from './lib/validate-package.mjs';
import { isStableVersion } from './lib/release.mjs';

export const PLUGIN_NAME = 'wintermute';
export const REQUIRED_FILES = [
  'LICENSE', 'plugin.json', 'package.json', 'scripts/validate-plugin.mjs', 'scripts/lib/validate-package.mjs', 'scripts/swarm-snapshot.mjs',
  'engine/schema.mjs', 'engine/fake-engine.mjs', 'engine/engine.mjs', 'engine/config.mjs', 'engine/sqlite.mjs', 'engine/time.mjs', 'engine/text.mjs',
  'engine/readers/app-db.mjs', 'engine/readers/events.mjs', 'engine/readers/ledger.mjs', 'engine/readers/process-probe.mjs', 'engine/readers/session-files.mjs',
  'engine/model/contract.mjs', 'engine/model/forest.mjs', 'engine/model/history.mjs', 'engine/model/messages.mjs', 'engine/model/pr-lookup.mjs',
  'engine/model/session-state.mjs', 'engine/model/stage.mjs', 'engine/model/state-utils.mjs', 'engine/model/status.mjs', 'engine/model/swarm.mjs',
  'tests/fixtures/example-snapshot.json', 'tests/fixtures/example-swarms.json', 'tests/fixtures/example-history.json', 'tests/fixtures/example-run-summary.json',
];
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
  if (!isStableVersion(manifest.version)) errors.push('plugin.json version must be stable SemVer X.Y.Z with no leading zeros');
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
  if (pkg.scripts?.snapshot !== 'node scripts/swarm-snapshot.mjs') errors.push('package.json must expose the snapshot command');
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
  errors.push(...await validatePackage(root, repositoryRoot, manifest));
  errors.push(...await validateDashboard(root, manifest, pkg));
  return errors;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const errors = await validatePlugin(root, path.resolve(root, '../../..'));
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
  } else {
    console.log('Plugin validation passed: manifests, root marketplace entry, packaged agents, CHANGELOG and required files.');
  }
}
