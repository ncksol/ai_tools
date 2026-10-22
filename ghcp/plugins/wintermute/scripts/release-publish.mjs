#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { validatePlugin } from './validate-plugin.mjs';
import { pluginRoot, repositoryRoot, readReleaseFiles, releaseSection, versionParts } from './lib/release.mjs';

function run(command, args, input) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', input });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--dry-run')) {
    throw new Error('Usage: npm run release:publish -- [--dry-run]');
  }
  if (run('git', ['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('Release requires a clean working tree, including untracked files.');
  }
  if (run('git', ['branch', '--show-current']) !== 'main') throw new Error('Release must run on the main branch.');
  const head = run('git', ['rev-parse', 'HEAD']);
  if (head !== run('git', ['rev-parse', 'refs/remotes/origin/main'])) throw new Error('HEAD must equal origin/main.');
  const errors = await validatePlugin(pluginRoot, repositoryRoot);
  if (errors.length) throw new Error(errors.join('\n'));
  const files = await readReleaseFiles();
  const version = files.manifest.version;
  versionParts(version);
  const notes = releaseSection(files.changelog, version);
  if (!notes || notes.includes('TODO: Describe this release.')) throw new Error(`CHANGELOG.md entry for ${version} is empty or unfinished.`);
  const tag = `wintermute-v${version}`;
  const tagRef = `refs/tags/${tag}`;
  if (run('git', ['tag', '--list', tag])) throw new Error(`Tag ${tag} already exists locally.`);
  const refs = run('git', ['ls-remote', 'origin', 'refs/heads/main', tagRef, `${tagRef}^{}`])
    .split('\n').filter(Boolean).map(line => line.split(/\s+/));
  if (refs.some(([, ref]) => ref === tagRef || ref === `${tagRef}^{}`)) throw new Error(`Tag ${tag} already exists on origin.`);
  if (!refs.some(([sha, ref]) => ref === 'refs/heads/main' && sha === head)) {
    throw new Error('HEAD must equal live origin/main; fetch and fast-forward main before publishing.');
  }
  const pushArgs = ['push', 'origin', `${tagRef}:${tagRef}`];
  const releaseArgs = ['release', 'create', tag, '--verify-tag', '--title', `Wintermute v${version}`, '--notes-file', '-'];
  if (args[0] === '--dry-run') {
    console.log(`Dry run: annotate ${tag} at ${head}, push only that tag to origin, then create its GitHub Release.\n\n${notes}`);
    return;
  }
  run('git', ['tag', '-a', tag, head, '-m', `Wintermute v${version}`]);
  try {
    run('git', pushArgs);
    run('gh', releaseArgs, `${notes}\n`);
  } catch (error) {
    throw new Error(`Publish failed after creating ${tag}. The tag is retained; inspect local and origin refs before manual recovery.\n${error.message}`);
  }
  console.log(`Published ${tag}.`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
