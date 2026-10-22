#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { readReleaseFiles, releaseSection, versionParts } from './lib/release.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('Usage: npm run release:bump -- <version|patch|minor|major>');
  const files = await readReleaseFiles();
  const current = versionParts(files.manifest.version);
  const increments = { major: 0, minor: 1, patch: 2 };
  let version = args[0];
  if (Object.hasOwn(increments, version)) {
    const index = increments[version];
    version = current.map((part, i) => i < index ? part : i === index ? part + 1n : 0n).join('.');
  }
  const next = versionParts(version);
  for (const previous of [files.manifest.version, files.pkg.version, files.entry.version]) {
    const parts = versionParts(previous);
    const difference = next.findIndex((part, i) => part !== parts[i]);
    if (difference < 0 || next[difference] < parts[difference]) {
      throw new Error(`Version ${version} must increase every current version (found ${previous}).`);
    }
  }
  let changelog = files.changelog;
  if (releaseSection(changelog, version) === null) {
    const first = changelog.search(/^## /m);
    const index = first < 0 ? changelog.length : first;
    const preamble = changelog.slice(0, index).trimEnd();
    changelog = `${preamble}\n\n## ${version}\n\n- TODO: Describe this release.\n\n${changelog.slice(index)}`;
  }
  files.manifest.version = files.pkg.version = files.entry.version = version;
  const contents = [files.manifest, files.pkg, files.marketplace].map(value => `${JSON.stringify(value, null, 2)}\n`);
  contents.push(changelog);
  for (const [index, file] of files.paths.entries()) await writeFile(file, contents[index]);
  console.log(`Wintermute ${version}: updated all three versions. Finish CHANGELOG.md before publishing.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
