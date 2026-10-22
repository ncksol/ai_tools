import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '../../..');
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const notes = '### Added\n\n- Unified agents and dashboard.\n\n### Compatibility\n\n- Restart active sessions.\n';

function git(repo, ...args) {
  const result = spawnSync(realGit, repo.endsWith('.git') ? [`--git-dir=${repo}`, ...args] : args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const dir = tempDir('wintermute-release-');
  const repo = path.join(dir, 'repo');
  const root = path.join(repo, 'ghcp/plugins/wintermute');
  mkdirSync(path.dirname(root), { recursive: true });
  cpSync(pluginRoot, root, { recursive: true });
  mkdirSync(path.join(repo, '.github/plugin'), { recursive: true });
  cpSync(path.join(repositoryRoot, '.github/plugin/marketplace.json'), path.join(repo, '.github/plugin/marketplace.json'));
  const files = {
    plugin: path.join(root, 'plugin.json'),
    package: path.join(root, 'package.json'),
    marketplace: path.join(repo, '.github/plugin/marketplace.json'),
    changelog: path.join(root, 'CHANGELOG.md'),
  };
  for (const file of [files.plugin, files.package]) {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.name = 'wintermute';
    json.version = '0.2.0';
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  writeFileSync(files.marketplace, `${JSON.stringify({
    plugins: [
      { name: 'other', version: '9.8.7', source: './other' },
      { name: 'wintermute', version: '0.2.0', source: './ghcp/plugins/wintermute' },
    ],
  }, null, 2)}\n`);
  writeFileSync(files.changelog, `# Changelog\n\nRelease policy stays here.\n\n## 0.2.0\n\n${notes}\n## 0.1.0\n\n- Old release.\n`);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Release test');
  git(repo, 'config', 'user.email', 'release-test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'fixture');
  const remote = path.join(dir, 'remote.git');
  git(dir, 'clone', '--bare', repo, remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls.jsonl');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'push') {
  appendFileSync(process.env.RELEASE_TEST_CALLS, JSON.stringify({ command: 'git', args }) + '\\n');
  process.exit(process.env.RELEASE_TEST_PUSH_FAIL ? 1 : 0);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
appendFileSync(process.env.RELEASE_TEST_CALLS, JSON.stringify({
  command: 'gh', args: process.argv.slice(2), notes: readFileSync(0, 'utf8')
}) + '\\n');
process.exit(process.env.RELEASE_TEST_GH_FAIL ? 1 : 0);
`, { mode: 0o755 });
  return {
    repo, root, remote, files,
    run(script, args = [], extraEnv = {}) {
      return spawnSync(process.execPath, [path.join(root, 'scripts', `release-${script}.mjs`), ...args], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RELEASE_TEST_CALLS: calls, ...extraEnv },
      });
    },
    calls() {
      return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    },
  };
}

function versions(f) {
  return [
    JSON.parse(readFileSync(f.files.plugin, 'utf8')).version,
    JSON.parse(readFileSync(f.files.package, 'utf8')).version,
    JSON.parse(readFileSync(f.files.marketplace, 'utf8')).plugins.find(entry => entry.name === 'wintermute').version,
  ];
}

for (const [input, expected] of [['patch', '0.2.1'], ['minor', '0.3.0'], ['major', '1.0.0'], ['1.2.3', '1.2.3']]) {
  test(`bump ${input} updates all three versions and preserves unrelated content`, () => {
    const f = fixture();
    const result = f.run('bump', [input]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(versions(f), [expected, expected, expected]);
    assert.equal(JSON.parse(readFileSync(f.files.marketplace, 'utf8')).plugins[0].version, '9.8.7');
    const changelog = readFileSync(f.files.changelog, 'utf8');
    assert.ok(changelog.includes(`## ${expected}\n`));
    assert.ok(changelog.includes('Release policy stays here.'));
    assert.ok(changelog.includes(notes));
    assert.ok(changelog.indexOf(`## ${expected}\n`) < changelog.indexOf('## 0.2.0\n'));
    assert.deepEqual(f.calls(), []);
  });
}

test('bump preserves an existing section instead of duplicating it', () => {
  const f = fixture();
  writeFileSync(f.files.changelog, `# Changelog\n\n## 0.3.0\n\n- Prepared notes.\n\n## 0.2.0\n\n${notes}`);
  const before = readFileSync(f.files.changelog, 'utf8');
  assert.equal(f.run('bump', ['minor']).status, 0);
  assert.equal(readFileSync(f.files.changelog, 'utf8'), before);
});

test('bump rejects malformed, non-increasing and unsupported versions without writes', () => {
  const f = fixture();
  const before = Object.values(f.files).map(file => readFileSync(file, 'utf8'));
  for (const args of [[], ['patch', 'extra'], ['v1.2.3'], ['01.2.3'], ['1.2'], ['1.2.3\n'], ['1.2.3-rc.1'], ['1.2.3+build'], ['0.2.0'], ['0.1.9']]) {
    const result = f.run('bump', args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.match(result.stderr, /usage|version|SemVer/i);
    assert.deepEqual(Object.values(f.files).map(file => readFileSync(file, 'utf8')), before);
  }
});

test('bump refuses a missing or duplicate marketplace entry without writes', () => {
  const f = fixture();
  for (const entries of [[], [{ name: 'wintermute', version: '0.2.0' }, { name: 'wintermute', version: '0.2.0' }]]) {
    writeFileSync(f.files.marketplace, JSON.stringify({ plugins: entries }));
    const result = f.run('bump', ['patch']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one wintermute/);
    assert.equal(JSON.parse(readFileSync(f.files.plugin, 'utf8')).version, '0.2.0');
  }
});

test('publish dry-run checks readiness without creating a tag, pushing or releasing', () => {
  const f = fixture();
  const before = git(f.repo, 'show-ref');
  const result = f.run('publish', ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wintermute-v0\.2\.0/);
  assert.match(result.stdout, /Unified agents and dashboard/);
  assert.equal(git(f.repo, 'show-ref'), before);
  assert.deepEqual(f.calls(), []);
  assert.equal(git(f.repo, 'status', '--porcelain'), '');
});

test('publish creates an annotated HEAD tag, pushes only that tag and uses only its changelog section', () => {
  const f = fixture();
  const result = f.run('publish');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.repo, 'cat-file', '-t', 'wintermute-v0.2.0'), 'tag');
  assert.equal(git(f.repo, 'rev-parse', 'wintermute-v0.2.0^{}'), git(f.repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(f.calls(), [
    { command: 'git', args: ['push', 'origin', 'refs/tags/wintermute-v0.2.0:refs/tags/wintermute-v0.2.0'] },
    { command: 'gh', args: ['release', 'create', 'wintermute-v0.2.0', '--verify-tag', '--title', 'Wintermute v0.2.0', '--notes-file', '-'], notes },
  ]);
});

for (const [scenario, reason] of [
  ['dirty', /clean|dirty/], ['staged', /clean|dirty/], ['untracked', /clean|dirty/],
  ['branch', /main branch/], ['ahead', /origin\/main/], ['stale-origin', /origin\/main|remote main/],
  ['local-tag', /tag.*exists/i], ['remote-tag', /tag.*exists/i],
  ['versions', /version must match/], ['missing-notes', /CHANGELOG/], ['stub-notes', /TODO|unfinished/],
]) {
  test(`publish refuses ${scenario} before creating a tag or calling push/gh`, () => {
    const f = fixture();
    if (scenario === 'dirty' || scenario === 'staged') {
      writeFileSync(f.files.changelog, `${readFileSync(f.files.changelog, 'utf8')}\nDirty\n`);
      if (scenario === 'staged') git(f.repo, 'add', '.');
    }
    if (scenario === 'untracked') writeFileSync(path.join(f.repo, 'untracked'), 'new');
    if (scenario === 'branch') git(f.repo, 'checkout', '-qb', 'feature');
    if (scenario === 'ahead' || scenario === 'stale-origin') {
      git(f.repo, 'commit', '--allow-empty', '-qm', 'ahead');
      if (scenario === 'stale-origin') git(f.repo, 'update-ref', 'refs/remotes/origin/main', git(f.repo, 'rev-parse', 'HEAD'));
    }
    if (scenario === 'local-tag') git(f.repo, 'tag', 'wintermute-v0.2.0');
    if (scenario === 'remote-tag') git(f.remote, 'tag', 'wintermute-v0.2.0');
    if (scenario === 'versions') {
      const pkg = JSON.parse(readFileSync(f.files.package, 'utf8'));
      pkg.version = '0.2.1';
      writeFileSync(f.files.package, JSON.stringify(pkg));
    }
    if (scenario === 'missing-notes') writeFileSync(f.files.changelog, '# Changelog\n\n## 0.1.0\n\n- Previous.\n');
    if (scenario === 'stub-notes') writeFileSync(f.files.changelog, '# Changelog\n\n## 0.2.0\n\n- TODO: Describe this release.\n');
    if (['versions', 'missing-notes', 'stub-notes'].includes(scenario)) {
      git(f.repo, 'add', '.');
      git(f.repo, 'commit', '-qm', scenario);
      const head = git(f.repo, 'rev-parse', 'HEAD');
      git(f.repo, 'update-ref', 'refs/remotes/origin/main', head);
      // Transfer objects locally, without a push or network.
      git(f.remote, 'fetch', f.repo, 'main:main');
    }
    const before = git(f.repo, 'tag', '--list');
    const result = f.run('publish', ['--dry-run']);
    assert.notEqual(result.status, 0, scenario);
    assert.match(result.stderr, reason, scenario);
    assert.equal(git(f.repo, 'tag', '--list'), before);
    assert.deepEqual(f.calls(), []);
  });
}

test('publish rejects unknown arguments before side effects', () => {
  const f = fixture();
  const result = f.run('publish', ['--force']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage/i);
  assert.equal(git(f.repo, 'tag', '--list'), '');
  assert.deepEqual(f.calls(), []);
});

for (const [env, calls] of [['RELEASE_TEST_PUSH_FAIL', 1], ['RELEASE_TEST_GH_FAIL', 2]]) {
  test(`publish reports ${env} without hiding the partial release or retrying`, () => {
    const f = fixture();
    const result = f.run('publish', [], { [env]: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wintermute-v0\.2\.0/);
    assert.match(result.stderr, /failed/i);
    assert.equal(f.calls().length, calls);
    assert.equal(git(f.repo, 'cat-file', '-t', 'wintermute-v0.2.0'), 'tag');
  });
}
