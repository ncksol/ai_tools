import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const repositoryRoot = path.resolve(pluginRoot, '../../..');

export function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.includes('\n')) {
    throw new Error(`Invalid version ${JSON.stringify(version)}: expected stable SemVer X.Y.Z (no prerelease or build suffix).`);
  }
  return version.split('.').map(part => BigInt(part));
}

export async function readReleaseFiles() {
  const paths = [
    path.join(pluginRoot, 'plugin.json'),
    path.join(pluginRoot, 'package.json'),
    path.join(repositoryRoot, '.github/plugin/marketplace.json'),
    path.join(pluginRoot, 'CHANGELOG.md'),
  ];
  const texts = await Promise.all(paths.map(file => readFile(file, 'utf8')));
  const [manifest, pkg, marketplace] = texts.slice(0, 3).map(text => JSON.parse(text));
  const entries = marketplace.plugins?.filter(entry => entry?.name === 'wintermute') ?? [];
  if (entries.length !== 1) throw new Error('Root marketplace must contain exactly one wintermute entry.');
  return { paths, manifest, pkg, marketplace, entry: entries[0], changelog: texts[3] };
}

export function releaseSection(changelog, version) {
  versionParts(version);
  const escaped = version.replace(/\./g, '\\.');
  const heading = new RegExp(`^## (?:${escaped}|\\[${escaped}\\])(?:[ \\t].*)?\\r?$`, 'gm');
  const matches = [...changelog.matchAll(heading)];
  if (matches.length > 1) throw new Error(`CHANGELOG.md has multiple entries for ${version}.`);
  if (!matches.length) return null;
  const start = matches[0].index + matches[0][0].length;
  const rest = changelog.slice(start);
  const next = rest.search(/^## /m);
  return rest.slice(0, next < 0 ? undefined : next).trim();
}
