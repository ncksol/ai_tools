import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as prLookupModule from '../engine/model/pr-lookup.mjs';
import { CLI_ENV, adoArgs, cliEnv, createPrLookup, githubArgs, mapAdo, mapGithub, prKey, runCommand } from '../engine/model/pr-lookup.mjs';
import { MINUTE } from '../engine/time.mjs';
import { tempDir } from './helpers/temp.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const AZ_OVERRIDES = {
  AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no', AZURE_CORE_COLLECT_TELEMETRY: 'no', AZURE_LOGGING_ENABLE_LOG_FILE: 'no',
  AZURE_CORE_SURVEY_MESSAGE: 'no', 'AZURE_AUTO-UPGRADE_ENABLE': 'no', AZURE_CORE_ERROR_RECOMMENDATION: 'off',
};
const GH_OVERRIDES = { GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GH_TELEMETRY: 'false' };
const pick = (env, names) => Object.fromEntries(names.map(name => [name, env?.[name]]));
// Tests of other behaviour say the azure-devops extension is installed, so that no test reads the real Azure config folder.
const INSTALLED = { azureExtensionInstalled: async () => true };

test('Azure DevOps PR JSON maps to a PR state and review note', () => {
  const base = { pullRequestId: 4711, title: 'Add API', creationDate: '2026-10-15T08:00:00Z', closedDate: null, repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' } };
  assert.deepEqual(mapAdo({ ...base, status: 'active', isDraft: true, reviewers: [] }), {
    state: 'draft', title: 'Add API', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'no approvals yet',
    url: 'https://dev.azure.com/org/project/_git/repo/pullrequest/4711',
  });
  assert.equal(mapAdo({ ...base, status: 'active', isDraft: false, reviewers: [{ vote: 10 }, { vote: 5 }] }).reviewNote, '2 approvals');
  assert.equal(mapAdo({ ...base, status: 'active', reviewers: [{ vote: -5 }] }).reviewNote, 'waiting for the author');
  const merged = mapAdo({ ...base, status: 'completed', closedDate: '2026-10-15T09:00:00Z', reviewers: [{ vote: -10 }] });
  assert.equal(merged.state, 'merged');
  assert.equal(merged.mergedAt, T0 + 60 * MINUTE);
  assert.equal(merged.reviewNote, 'rejected');
  assert.equal(mapAdo({ ...base, status: 'abandoned' }).state, 'closed');
});

test('GitHub PR JSON maps to a PR state and review note', () => {
  assert.deepEqual(mapGithub({ state: 'OPEN', isDraft: false, title: 'Docs', createdAt: '2026-10-15T08:00:00Z', mergedAt: null, closedAt: null, reviewDecision: 'APPROVED', url: 'https://github.com/o/r/pull/3' }), {
    state: 'open', title: 'Docs', openedAt: T0, mergedAt: null, closedAt: null, reviewNote: 'approved', url: 'https://github.com/o/r/pull/3',
  });
  assert.equal(mapGithub({ state: 'OPEN', isDraft: true }).state, 'draft');
  assert.equal(mapGithub({ state: 'MERGED', mergedAt: '2026-10-15T08:00:00Z' }).mergedAt, T0);
  assert.equal(mapGithub({ state: 'CLOSED' }).state, 'closed');
});

test('arguments are fixed read-only commands with validated values', () => {
  assert.deepEqual(adoArgs({ provider: 'ado', id: 7, repo: 'org/project/repo' }),
    ['repos', 'pr', 'show', '--id', '7', '--output', 'json', '--organization', 'https://dev.azure.com/org', '--detect', 'false']);
  assert.deepEqual(adoArgs({ provider: 'ado', id: 7, repo: null }), ['repos', 'pr', 'show', '--id', '7', '--output', 'json']);
  assert.deepEqual(githubArgs({ provider: 'github', id: 3, repo: 'o/r' }).slice(-2), ['--repo', 'o/r']);
  assert.equal(githubArgs({ provider: 'github', id: 3, repo: '--evil' }).includes('--evil'), false);
});

test('lookups are cached, refreshed after the TTL, final once merged, and failures are kept', async () => {
  let clock = T0;
  const calls = [];
  const replies = [
    JSON.stringify({ state: 'OPEN', isDraft: false, title: 'One' }),
    JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-15T09:00:00Z', title: 'One' }),
  ];
  const run = async (command, args, options) => {
    calls.push([command, args[2], options.cwd]);
    return replies.shift();
  };
  const lookup = createPrLookup({ run, now: () => clock });
  const pr = { provider: 'github', id: 1, repo: 'o/r' };
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).state, 'open');
  assert.equal(lookup.get(pr).checkedAt, T0);
  lookup.request(pr);
  await lookup.settle();
  assert.equal(calls.length, 1);
  clock += 5 * MINUTE;
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).state, 'merged');
  clock += 60 * MINUTE;
  lookup.request(pr);
  await lookup.settle();
  assert.equal(calls.length, 2);
  assert.equal(prKey(pr), 'github:o/r:1');

  const failing = createPrLookup({ run: async () => { throw new Error('gh failed: not logged in'); }, now: () => clock });
  failing.request({ provider: 'github', id: 2, repo: 'o/r' });
  await failing.settle();
  assert.equal(failing.get({ provider: 'github', id: 2, repo: 'o/r' }).state, 'unknown');
  assert.deepEqual(failing.errors(), [{ key: 'github:o/r:2', error: 'gh failed: not logged in' }]);
});

test('a PR without a repository is looked up only from an existing worktree', async () => {
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push([args[4], options.cwd]); return '{"status":"active"}'; },
    exists: dir => dir === '/synthetic/worktree', ...INSTALLED,
  });
  lookup.request({ provider: 'ado', id: 5, repo: null });
  lookup.request({ provider: 'ado', id: 6, repo: null }, { cwd: '/synthetic/worktree' });
  lookup.request({ provider: 'ado', id: 7, repo: null }, { cwd: '/synthetic/gone' });
  lookup.request({ provider: 'ado', id: 8, repo: 'org/project/repo' }, { cwd: '/synthetic/gone' });
  await lookup.settle();
  assert.deepEqual(calls, [['6', '/synthetic/worktree'], ['8', undefined]]);
  const gone = lookup.get({ provider: 'ado', id: 7, repo: null }, { cwd: '/synthetic/gone' });
  assert.equal(gone.state, 'unknown');
  assert.match(gone.error, /worktree is gone/);
});

test('a registry repository that is not organization/project/repo adds no organization and keeps the worktree fallback', async () => {
  const pr = { provider: 'ado', id: 42, repo: 'project/repo' };
  assert.deepEqual(adoArgs(pr), ['repos', 'pr', 'show', '--id', '42', '--output', 'json']);
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push([args, options.cwd]); return '{"status":"active"}'; },
    exists: () => true, ...INSTALLED,
  });
  lookup.request(pr, { cwd: '/synthetic/worktree' });
  await lookup.settle();
  assert.deepEqual(calls, [[['repos', 'pr', 'show', '--id', '42', '--output', 'json'], '/synthetic/worktree']]);
});

test('pending is true from the request until its lookup resolves or fails', async () => {
  const gates = [];
  const run = () => new Promise((resolve, reject) => gates.push({ resolve, reject }));
  const lookup = createPrLookup({ run });
  const first = { provider: 'github', id: 1, repo: 'o/r' };
  const second = { provider: 'github', id: 2, repo: 'o/r' };
  const third = { provider: 'github', id: 3, repo: 'o/r' };
  assert.equal(lookup.pending(first), false);
  for (const pr of [first, second, third]) lookup.request(pr);
  assert.deepEqual([first, second, third].map(pr => lookup.pending(pr)), [true, true, true]);
  gates[0].resolve('{"state":"OPEN"}');
  gates[1].reject(new Error('gh failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([first, second].map(pr => lookup.pending(pr)), [false, false]);
  assert.equal(lookup.pending(third), true);
  gates[2].resolve('{"state":"MERGED"}');
  await lookup.settle();
  assert.equal(lookup.pending(third), false);
  assert.equal(lookup.get(second).error, 'gh failed');
  assert.equal(lookup.pending(null), false);
});

test('az and gh run with logs, telemetry, installs, upgrades, surveys, prompts and error recommendations turned off, and the rest of the environment kept', async () => {
  process.env.SWARM_PR_LOOKUP_SENTINEL = 'kept';
  try {
    const calls = [];
    const lookup = createPrLookup({ run: async (command, args, options) => { calls.push({ command, env: options.env }); return '{}'; }, ...INSTALLED });
    lookup.request({ provider: 'ado', id: 7, repo: 'org/project/repo' });
    lookup.request({ provider: 'github', id: 3, repo: 'o/r' });
    await lookup.settle();
    const az = calls.find(call => call.command === 'az');
    const gh = calls.find(call => call.command === 'gh');
    assert.deepEqual(pick(az.env, Object.keys(AZ_OVERRIDES)), AZ_OVERRIDES);
    assert.deepEqual(pick(gh.env, Object.keys(GH_OVERRIDES)), GH_OVERRIDES);
    assert.equal(az.env.SWARM_PR_LOOKUP_SENTINEL, 'kept');
    assert.equal(gh.env.SWARM_PR_LOOKUP_SENTINEL, 'kept');
  } finally {
    delete process.env.SWARM_PR_LOOKUP_SENTINEL;
  }
});

test('runCommand hands its environment to the child process', async () => {
  const names = ['SENTINEL', 'AZURE_EXTENSION_USE_DYNAMIC_INSTALL', 'AZURE_AUTO-UPGRADE_ENABLE', 'AZURE_CORE_COLLECT_TELEMETRY', 'SWARM_PR_LOOKUP_ABSENT'];
  const script = `const names = ${JSON.stringify(names)}; process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name] ?? null]))));`;
  process.env.SWARM_PR_LOOKUP_ABSENT = 'parent only';
  try {
    const stdout = await runCommand(process.execPath, ['-e', script], { timeoutMs: 20_000, env: cliEnv('az', { PATH: process.env.PATH, SENTINEL: 'x' }) });
    assert.deepEqual(JSON.parse(stdout), {
      SENTINEL: 'x', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no', 'AZURE_AUTO-UPGRADE_ENABLE': 'no', AZURE_CORE_COLLECT_TELEMETRY: 'no', SWARM_PR_LOOKUP_ABSENT: null,
    });
  } finally {
    delete process.env.SWARM_PR_LOOKUP_ABSENT;
  }
});

test('an az that still says the command is unknown (a broken extension install) is reported as a missing extension, never installed', async () => {
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("az failed: ERROR: 'repos' is misspelled or not recognized by the system.");
    },
    ...INSTALLED,
  });
  const pr = { provider: 'ado', id: 9, repo: 'org/project/repo' };
  lookup.request(pr);
  await lookup.settle();
  assert.equal(lookup.get(pr).error, 'lookup unavailable: azure-devops extension not installed');
  assert.equal(calls.length, 1);
  assert.ok(calls.every(call => !call.some(arg => /extension|config/.test(arg))));
});

const NOT_INSTALLED = 'lookup unavailable: azure-devops extension not installed';
const ADO_PR = { provider: 'ado', id: 9, repo: 'org/project/repo' };

/** Makes `dir` (and its parents) and, when `files` is given, writes each file in it. Returns `dir`. */
function folder(dir, files = {}) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

/** An installed azure-devops extension in the extension folder `dir`, as az lays it out. */
const installExtension = dir => folder(path.join(dir, 'azure-devops', 'azure_devops-1.0.1.dist-info'), { METADATA: 'Name: azure-devops\n' });

/**
 * A synthetic Azure environment in a temp folder: its own config folder, home and an empty PATH folder, so the extension check
 * never reaches the real ~/.azure or a real az. `extra` adds to or replaces variables.
 */
function azureEnv(extra = {}) {
  const dir = tempDir('swarm-azure-');
  const env = {
    HOME: folder(path.join(dir, 'home')), AZURE_CONFIG_DIR: folder(path.join(dir, 'config')), PATH: folder(path.join(dir, 'empty-bin')), ...extra,
  };
  return { dir, env };
}

/** The number of times one ADO lookup with this base environment starts az, with the default extension check. */
async function azRuns(env) {
  let runs = 0;
  const lookup = createPrLookup({ run: async () => { runs += 1; return '{"status":"active"}'; }, env });
  lookup.request(ADO_PR);
  await lookup.settle();
  return runs;
}

test('az runs with error recommendations off, the exact value az reads, and its child process sees it', async () => {
  assert.equal(CLI_ENV.az.AZURE_CORE_ERROR_RECOMMENDATION, 'off');
  const script = 'process.stdout.write(String(process.env.AZURE_CORE_ERROR_RECOMMENDATION))';
  const stdout = await runCommand(process.execPath, ['-e', script], { timeoutMs: 20_000, env: cliEnv('az', { PATH: process.env.PATH }) });
  assert.equal(stdout, 'off');
});

test('without the azure-devops extension az is never started, and each check after the TTL looks on disk again', async () => {
  const { env } = azureEnv();
  let clock = T0;
  let checks = 0;
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push({ command, env: options.env }); return '{"status":"active"}'; },
    now: () => clock, env,
    azureExtensionInstalled: options => { checks += 1; return prLookupModule.azureExtensionInstalled(options); },
  });
  lookup.request(ADO_PR);
  await lookup.settle();
  assert.deepEqual(calls, [], 'az is not started');
  assert.equal(lookup.get(ADO_PR).error, NOT_INSTALLED);
  assert.deepEqual(lookup.errors(), [{ key: 'ado:org/project/repo:9', error: NOT_INSTALLED }]);

  clock += 5 * MINUTE;
  lookup.request(ADO_PR);
  await lookup.settle();
  assert.deepEqual(calls, [], 'az is still not started after the TTL');
  assert.equal(checks, 2, 'the disk check ran again');
  assert.equal(lookup.get(ADO_PR).error, NOT_INSTALLED);

  // Once the extension is installed, the next check after the TTL finds it, and az runs with the given environment.
  installExtension(path.join(env.AZURE_CONFIG_DIR, 'cliextensions'));
  clock += 5 * MINUTE;
  lookup.request(ADO_PR);
  await lookup.settle();
  assert.equal(checks, 3);
  assert.equal(calls.length, 1);
  assert.equal(lookup.get(ADO_PR).state, 'open');
});

test('with the azure-devops extension in the config folder, az runs once with the given environment and the overrides', async () => {
  const { env } = azureEnv({ SWARM_PR_LOOKUP_SENTINEL: 'kept' });
  installExtension(path.join(env.AZURE_CONFIG_DIR, 'cliextensions'));
  const calls = [];
  const lookup = createPrLookup({ run: async (command, args, options) => { calls.push({ command, env: options.env }); return '{"status":"active"}'; }, env });
  lookup.request(ADO_PR);
  await lookup.settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'az');
  assert.deepEqual(calls[0].env, { ...env, ...CLI_ENV.az });
  assert.equal(lookup.get(ADO_PR).error, null);
});

test('the user extension folder comes from AZURE_EXTENSION_DIR, else the config file, as az reads them', async () => {
  // The default folder has the extension, so a setting that names another folder must hide it.
  const { dir, env } = azureEnv();
  installExtension(path.join(env.AZURE_CONFIG_DIR, 'cliextensions'));
  const empty = folder(path.join(dir, 'empty-extensions'));
  const other = path.join(dir, 'other-extensions');
  installExtension(other);
  assert.equal(await azRuns(env), 1, 'the default folder <config>/cliextensions');
  assert.equal(await azRuns({ ...env, AZURE_EXTENSION_DIR: empty }), 0, 'the variable wins over the default folder');
  assert.equal(await azRuns({ ...env, AZURE_EXTENSION_DIR: other }), 1);

  folder(env.AZURE_CONFIG_DIR, { config: `[core]\noutput = json\n\n[extension]\ndir = ${empty}\n` });
  assert.equal(await azRuns(env), 0, 'the config file wins over the default folder');
  assert.equal(await azRuns({ ...env, AZURE_EXTENSION_DIR: other }), 1, 'the variable wins over the config file');
  // A leading ~ is the home folder.
  installExtension(path.join(env.HOME, 'home-extensions'));
  folder(env.AZURE_CONFIG_DIR, { config: '[extension]\ndir = ~/home-extensions\n' });
  assert.equal(await azRuns(env), 1, '~ in the config file');
});

test('the system extension folder is found next to the Python that the az launcher on PATH runs', async () => {
  for (const python of ['bin/python', 'bin/python3']) {
    const { dir, env } = azureEnv();
    // az on PATH is a link to the launcher script, as Homebrew installs it; the Linux packages' launcher names python3.
    const prefix = path.join(dir, 'cellar', 'azure-cli', 'libexec');
    const launcher = path.join(folder(path.join(dir, 'cellar', 'azure-cli', 'bin')), 'az');
    writeFileSync(launcher, `#!/usr/bin/env bash\nAZ_INSTALLER=HOMEBREW ${path.join(prefix, python)} -Im azure.cli "$@"\n`);
    chmodSync(launcher, 0o755);
    const bin = folder(path.join(dir, 'bin'));
    symlinkSync(launcher, path.join(bin, 'az'));
    const withAz = { ...env, PATH: [env.PATH, bin].join(path.delimiter) };
    assert.equal(await azRuns(withAz), 0, `${python}: nothing installed yet`);
    installExtension(path.join(prefix, 'lib', 'python3.12', 'site-packages', 'azure-cli-extensions'));
    assert.equal(await azRuns(withAz), 1, `${python}: the system folder counts`);
    assert.equal(await azRuns({ ...withAz, AZURE_EXTENSION_SYS_DIR: folder(path.join(dir, 'empty-sys')) }), 0, `${python}: AZURE_EXTENSION_SYS_DIR replaces it`);
    assert.equal(await azRuns(env), 0, `${python}: without az on PATH the system folder is not known`);
  }
});

test('an azure-devops folder without a *.*-info entry is not an installed extension', async () => {
  const { env } = azureEnv();
  const extension = path.join(env.AZURE_CONFIG_DIR, 'cliextensions', 'azure-devops');
  folder(path.join(extension, 'azext_devops'), { '__init__.py': '' });
  folder(path.join(extension, 'azure_devops-info'));
  folder(path.join(extension, '.hidden.dist-info'));
  folder(extension, { README: 'not a wheel' });
  assert.equal(await azRuns(env), 0);
  folder(path.join(extension, 'azure_devops-1.0.1.egg-info'));
  assert.equal(await azRuns(env), 1, 'an egg-info entry counts too');
});

test('GitHub lookups never check for the Azure extension', async () => {
  let checks = 0;
  const calls = [];
  const lookup = createPrLookup({
    run: async (command, args, options) => { calls.push({ command, env: options.env }); return '{"state":"OPEN"}'; },
    env: { PATH: '/synthetic/bin', SENTINEL: 'x' },
    azureExtensionInstalled: () => { checks += 1; return false; },
  });
  const pr = { provider: 'github', id: 3, repo: 'o/r' };
  lookup.request(pr);
  await lookup.settle();
  assert.equal(checks, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].env, { PATH: '/synthetic/bin', SENTINEL: 'x', ...GH_OVERRIDES });
  assert.equal(lookup.get(pr).state, 'open');
});

test('PRs without a repository are kept apart by worktree, and PRs with one share an entry', async () => {
  const cases = [
    { provider: 'ado', repo: 'org/project/repo', merged: '{"status":"completed"}', open: '{"status":"active"}' },
    { provider: 'github', repo: 'o/r', merged: '{"state":"MERGED"}', open: '{"state":"OPEN"}' },
  ];
  for (const { provider, repo, merged, open } of cases) {
    const gates = [];
    const run = (command, args, options) => new Promise(resolve => gates.push({ cwd: options.cwd, release: () => resolve(options.cwd === '/synthetic/a' ? merged : open) }));
    const lookup = createPrLookup({ run, exists: () => true, ...INSTALLED });
    const pr = { provider, id: 42, repo: null };
    const inA = { cwd: '/synthetic/a' };
    const inB = { cwd: '/synthetic/b' };
    lookup.request(pr, inA);
    assert.equal(lookup.pending(pr, inA), true, provider);
    assert.equal(lookup.pending(pr, inB), false, provider);
    lookup.request(pr, inB);
    // An ADO lookup checks for the azure-devops extension before it starts az, so the commands start a turn later.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(gates.map(gate => gate.cwd), ['/synthetic/a', '/synthetic/b'], provider);
    for (const gate of gates) gate.release();
    await lookup.settle();
    assert.equal(lookup.get(pr, inA).state, 'merged', provider);
    assert.equal(lookup.get(pr, inB).state, 'open', provider);
    assert.equal(lookup.pending(pr, inA), false, provider);

    const shared = { provider, id: 43, repo };
    lookup.request(shared, inA);
    lookup.request(shared, inB);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(gates.length, 3, provider);
    assert.equal(lookup.pending(shared, inB), true, provider);
    gates[2].release();
    await lookup.settle();
    assert.equal(lookup.get(shared, inB), lookup.get(shared, inA), provider);
    assert.equal(lookup.get(shared), lookup.get(shared, inA), provider);
  }
});

test('lookup errors name the PR without the worktree path', async () => {
  const lookup = createPrLookup({ run: async () => { throw new Error('az failed: not logged in'); }, exists: () => true, ...INSTALLED });
  lookup.request({ provider: 'ado', id: 42, repo: null }, { cwd: '/synthetic/private/worktree' });
  lookup.request({ provider: 'ado', id: 43, repo: 'org/project/repo' });
  await lookup.settle();
  const errors = lookup.errors();
  assert.deepEqual(errors, [
    { key: 'ado:worktree:42', error: 'az failed: not logged in' },
    { key: 'ado:org/project/repo:43', error: 'az failed: not logged in' },
  ]);
  assert.ok(errors.every(entry => !entry.key.includes('/synthetic')));
});

test('lookup errors show no repository value that is not a repository, such as a path', async () => {
  const lookup = createPrLookup({ run: async () => { throw new Error('gh failed: not logged in'); }, exists: () => true, ...INSTALLED });
  lookup.request({ provider: 'github', id: 7, repo: '/synthetic/private/repo' }, { cwd: '/synthetic/private/worktree' });
  lookup.request({ provider: 'ado', id: 8, repo: 'C:\\synthetic\\private\\repo' }, { cwd: '/synthetic/private/worktree' });
  await lookup.settle();
  const errors = lookup.errors();
  assert.deepEqual(errors.map(entry => entry.key), ['github:worktree:7', 'ado:worktree:8']);
  assert.ok(errors.every(entry => !entry.key.includes('/') && !entry.key.includes('\\') && !entry.key.includes('synthetic')));
});

test('a closed PR is checked again after the TTL, since it can be reopened, but a merged PR is final', async () => {
  const cases = [
    { provider: 'ado', repo: 'org/project/repo', closed: '{"status":"abandoned"}', reopened: '{"status":"active"}', merged: '{"status":"completed"}' },
    { provider: 'github', repo: 'o/r', closed: '{"state":"CLOSED"}', reopened: '{"state":"OPEN"}', merged: '{"state":"MERGED"}' },
  ];
  for (const { provider, repo, closed, reopened, merged } of cases) {
    let clock = T0;
    const replies = new Map([[1, [closed, reopened]], [2, [merged, reopened]]]);
    const calls = [];
    const run = async (command, args) => {
      const id = Number(provider === 'ado' ? args[4] : args[2]);
      calls.push(id);
      return replies.get(id).shift();
    };
    const lookup = createPrLookup({ run, now: () => clock, ...INSTALLED });
    const closedPr = { provider, id: 1, repo };
    const mergedPr = { provider, id: 2, repo };
    lookup.request(closedPr);
    lookup.request(mergedPr);
    await lookup.settle();
    assert.deepEqual([lookup.get(closedPr).state, lookup.get(mergedPr).state], ['closed', 'merged'], provider);
    clock += 5 * MINUTE - 1;
    lookup.request(closedPr);
    lookup.request(mergedPr);
    await lookup.settle();
    assert.equal(calls.length, 2, provider);
    clock += 1;
    lookup.request(closedPr);
    lookup.request(mergedPr);
    await lookup.settle();
    assert.deepEqual(calls.sort(), [1, 1, 2], provider);
    assert.equal(lookup.get(closedPr).state, 'open', provider);
    clock += 60 * MINUTE;
    lookup.request(mergedPr);
    await lookup.settle();
    assert.equal(calls.length, 3, provider);
    assert.equal(lookup.get(mergedPr).state, 'merged', provider);
  }
});
