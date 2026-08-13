import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collector = path.join(root, 'skills/review-pull-request/scripts/collect-azure-devops.sh');
const raw = JSON.parse(await readFile(path.join(root, 'tests/fixtures/azure-raw.json'), 'utf8'));

const AZ_STUB = `#!/bin/sh
op=""
case "$1 $2 $3" in
  "repos pr show") op=show ;;
  "repos pr work-item") op=work-items ;;
  "repos pr policy") op=policies ;;
esac
if [ "$1" = "devops" ]; then
  case "$*" in
    *pullRequestIterationChanges*) op=changes ;;
    *pullRequestIterations*) op=iterations ;;
    *pullRequestThreads*) op=threads ;;
  esac
fi
if [ -z "$op" ]; then
  echo "unexpected az invocation: $*" >&2
  exit 64
fi
if [ "$op" = "$PRG_STUB_FAIL_OP" ]; then
  printf '%s\\n' "$PRG_STUB_FAIL_STDERR" >&2
  exit 1
fi
cat "$PRG_STUB_RESPONSES/$op.json"
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

// A real repository with real commits keeps the diff capability honest: the
// collector must fetch nothing and produce a genuine patch.
async function scenario() {
  const base = await mkdtemp(path.join(tmpdir(), 'prg-azure-cli-'));
  const repo = path.join(base, 'widgets');
  const bin = path.join(base, 'bin');
  const responses = path.join(base, 'responses');
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(responses, { recursive: true });

  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/acme/Platform/_git/widgets.git');
  await writeFile(path.join(repo, 'schema.sql'), 'CREATE TABLE users (id INT PRIMARY KEY);\n');
  git(repo, 'add', 'schema.sql');
  git(repo, 'commit', '--quiet', '-m', 'base');
  const targetSha = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'schema.sql'), 'CREATE TABLE users (id INT PRIMARY KEY, email TEXT);\n');
  git(repo, 'add', 'schema.sql');
  git(repo, 'commit', '--quiet', '-m', 'head');
  const sourceSha = git(repo, 'rev-parse', 'HEAD');

  const pullRequest = {
    ...raw.pullRequest,
    lastMergeSourceCommit: { commitId: sourceSha },
    lastMergeTargetCommit: { commitId: targetSha }
  };
  await writeFile(path.join(responses, 'show.json'), JSON.stringify(pullRequest));
  await writeFile(path.join(responses, 'work-items.json'), JSON.stringify(raw.workItems));
  await writeFile(path.join(responses, 'policies.json'), JSON.stringify(raw.policies));
  await writeFile(path.join(responses, 'iterations.json'), JSON.stringify(raw.iterations));
  await writeFile(path.join(responses, 'changes.json'), JSON.stringify(raw.changes));
  await writeFile(path.join(responses, 'threads.json'), JSON.stringify(raw.existingThreads));

  await writeFile(path.join(bin, 'az'), AZ_STUB);
  await chmod(path.join(bin, 'az'), 0o755);

  return { base, repo, bin, responses, sourceSha, targetSha };
}

function run(context, args, env = {}) {
  return spawnSync('bash', [collector, ...args], {
    cwd: context.repo,
    encoding: 'utf8',
    env: {
      PATH: `${context.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: context.base,
      PRG_STUB_RESPONSES: context.responses,
      ...env
    }
  });
}

test('a complete CLI run writes both the fragment and the packet', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson]);

    assert.equal(result.status, 0, result.stderr);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    for (const name of Object.keys(fragment.capabilities)) {
      assert.equal(fragment.capabilities[name].complete, true, name);
    }
    const packet = JSON.parse(await readFile(packetJson, 'utf8'));
    assert.equal(packet.pullRequest.head.sha, context.sourceSha);
    assert.match(fragment.capabilities.diff.data.patch, /email TEXT/);
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('a late thread failure preserves every capability collected before it', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson], {
      PRG_STUB_FAIL_OP: 'threads',
      PRG_STUB_FAIL_STDERR: 'TF400813: user is not authorized'
    });

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'diff']) {
      assert.equal(fragment.capabilities[name].complete, true, name);
    }
    assert.equal(fragment.capabilities.existingThreads.complete, false);
    assert.equal(fragment.capabilities.existingThreads.failure.category, 'authentication');
    assert.doesNotMatch(fragment.capabilities.existingThreads.failure.message, /TF400813|not authorized/);
    assert.doesNotMatch(result.stdout + result.stderr, /TF400813|not authorized/);
    await assert.rejects(readFile(packetJson, 'utf8'));
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('a failed PR read still yields the independently collected capabilities', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson], {
      PRG_STUB_FAIL_OP: 'show',
      PRG_STUB_FAIL_STDERR: 'connection reset'
    });

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(fragment.capabilities.workItems.complete, true);
    assert.equal(fragment.capabilities.policies.complete, true);
    assert.equal(fragment.capabilities.identity.complete, false);
    assert.equal(fragment.capabilities.identity.failure.category, 'command-failed');
    assert.equal(fragment.capabilities.iterations.failure.category, 'dependency-unavailable');
    assert.equal(fragment.capabilities.changes.failure.category, 'dependency-unavailable');
    assert.equal(fragment.capabilities.diff.failure.category, 'dependency-unavailable');
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('a missing az CLI records every capability as tool-unavailable', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = spawnSync('bash', [collector, '77', packetJson, fragmentJson], {
      cwd: context.repo,
      encoding: 'utf8',
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: context.base
      }
    });

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    for (const name of Object.keys(fragment.capabilities)) {
      assert.equal(fragment.capabilities[name].complete, false, name);
      assert.equal(fragment.capabilities[name].failure.category, 'tool-unavailable', name);
    }
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('an origin that is not the Azure repository fails only the diff capability', async () => {
  const context = await scenario();
  try {
    git(context.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/acme/Platform/_git/gadgets.git');
    const packetJson = path.join(context.base, 'out/packet.json');
    const fragmentJson = path.join(context.base, 'out/fragment.json');
    const result = run(context, ['77', packetJson, fragmentJson]);

    assert.equal(result.status, 1);
    const fragment = JSON.parse(await readFile(fragmentJson, 'utf8'));
    assert.equal(fragment.capabilities.diff.complete, false);
    assert.equal(fragment.capabilities.diff.failure.category, 'repository-mismatch');
    assert.equal(fragment.capabilities.identity.complete, true);
    assert.equal(fragment.capabilities.existingThreads.complete, true);
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('the fragment path defaults beside the packet and is printed', async () => {
  const context = await scenario();
  try {
    const packetJson = path.join(context.base, 'out/packet.json');
    const result = run(context, ['77', packetJson], { PRG_AZURE_CREDENTIAL_CONTEXT: 'stored az/login' });

    assert.equal(result.status, 0, result.stderr);
    const expected = path.join(context.base, 'out/azure-cli-stored-az-login.fragment.json');
    assert.match(result.stdout, /fragment: /);
    const fragment = JSON.parse(await readFile(expected, 'utf8'));
    assert.equal(fragment.source.credentialContext, 'stored az/login');
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});

test('wrong argument counts are rejected without a fragment', async () => {
  const context = await scenario();
  try {
    const result = run(context, ['77']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: collect-azure-devops\.sh/);
  } finally {
    await rm(context.base, { recursive: true, force: true });
  }
});
