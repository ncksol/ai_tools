#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMain, readJson, writeJson } from './lib.mjs';
import { loadRawDirectory, normalize } from './normalize-context.mjs';

export const REQUIRED_AZURE_CAPABILITIES = Object.freeze([
  'identity',
  'metadata',
  'snapshot',
  'workItems',
  'policies',
  'iterations',
  'changes',
  'existingThreads',
  'diff'
]);

const RAW_FILES = Object.freeze([
  'pull-request.json',
  'work-items.json',
  'policies.json',
  'iterations.json',
  'changes.json',
  'threads.json',
  'diff.patch'
]);

function assertCapabilityData(name, data) {
  switch (name) {
    case 'identity': {
      if (!Number.isInteger(data?.pullRequestId) || data.pullRequestId <= 0)
        throw new Error('Azure capability identity needs a positive integer pullRequestId');
      if (!String(data.url ?? '').trim())
        throw new Error('Azure capability identity needs a non-empty url');
      const repo = data.repository ?? {};
      if (!String(repo.id ?? repo.name ?? '').trim())
        throw new Error('Azure capability identity needs a non-empty repository id or name');
      const project = repo.project ?? {};
      if (!String(project.id ?? project.name ?? '').trim())
        throw new Error('Azure capability identity needs a non-empty project id or name');
      break;
    }
    case 'metadata': {
      if (typeof data?.title !== 'string')
        throw new Error('Azure capability metadata needs a string title');
      if (typeof data?.description !== 'string')
        throw new Error('Azure capability metadata needs a string description');
      if (!String(data.sourceRefName ?? '').trim())
        throw new Error('Azure capability metadata needs a non-empty sourceRefName');
      if (!String(data.targetRefName ?? '').trim())
        throw new Error('Azure capability metadata needs a non-empty targetRefName');
      break;
    }
    case 'snapshot': {
      if (!String(data?.lastMergeSourceCommit?.commitId ?? '').trim())
        throw new Error('Azure capability snapshot needs lastMergeSourceCommit.commitId');
      if (!String(data?.lastMergeTargetCommit?.commitId ?? '').trim())
        throw new Error('Azure capability snapshot needs lastMergeTargetCommit.commitId');
      break;
    }
    case 'workItems':
    case 'policies':
    case 'iterations':
    case 'existingThreads': {
      if (!Array.isArray(data) && !Array.isArray(data?.value))
        throw new Error(`Azure capability ${name} needs an array or an object with a value array`);
      break;
    }
    case 'changes': {
      if (!Array.isArray(data?.changeEntries))
        throw new Error('Azure capability changes needs a changeEntries array');
      if (Number(data.nextSkip ?? 0) !== 0 || Number(data.nextTop ?? 0) !== 0)
        throw new Error('Complete Azure capability changes still has pagination');
      break;
    }
    case 'diff': {
      if (typeof data !== 'string')
        throw new Error('Azure capability diff needs a string');
      break;
    }
    // no default — unknown names are caught in validateAzureFragment
  }
}

function assertImmutableAgreement(fragments) {
  let prId = null;
  let repoId = null;
  let projectId = null;
  let headSha = null;
  let baseSha = null;

  for (const fragment of fragments) {
    const id = fragment.capabilities?.identity;
    if (id?.complete) {
      const pid = String(id.data.pullRequestId);
      if (prId === null) prId = pid;
      else if (prId !== pid) throw new Error('Conflicting Azure PR identity');
      const repo = id.data.repository ?? {};
      const rid = String(repo.id ?? repo.name ?? '');
      if (repoId === null) repoId = rid;
      else if (repoId !== rid) throw new Error('Conflicting Azure PR identity');
      const project = repo.project ?? {};
      const pgid = String(project.id ?? project.name ?? '');
      if (projectId === null) projectId = pgid;
      else if (projectId !== pgid) throw new Error('Conflicting Azure PR identity');
    }
    const snap = fragment.capabilities?.snapshot;
    if (snap?.complete) {
      const head = String(snap.data.lastMergeSourceCommit?.commitId ?? '');
      if (!head.trim()) throw new Error('Conflicting Azure head SHA');
      if (headSha === null) headSha = head;
      else if (headSha !== head) throw new Error('Conflicting Azure head SHA');
      const base = String(snap.data.lastMergeTargetCommit?.commitId ?? '');
      if (!base.trim()) throw new Error('Conflicting Azure base SHA');
      if (baseSha === null) baseSha = base;
      else if (baseSha !== base) throw new Error('Conflicting Azure base SHA');
    }
  }
}

export function validateAzureFragment(fragment) {
  if (fragment?.schemaVersion !== '1.0') throw new Error('Azure access fragment schemaVersion must be 1.0');
  for (const key of ['adapter', 'credentialContext', 'capturedAt']) {
    if (!String(fragment.source?.[key] ?? '').trim()) throw new Error(`Azure access fragment source.${key} is required`);
  }
  const names = Object.keys(fragment.capabilities ?? {});
  if (!names.length) throw new Error('Azure access fragment must declare at least one capability');
  for (const name of names) {
    if (!REQUIRED_AZURE_CAPABILITIES.includes(name)) throw new Error(`Unknown Azure capability: ${name}`);
    const capability = fragment.capabilities[name];
    if (typeof capability?.complete !== 'boolean') throw new Error(`Azure capability ${name} needs complete=true|false`);
    if (capability.complete) {
      if (!Object.hasOwn(capability, 'data')) throw new Error(`Complete Azure capability ${name} needs data`);
      assertCapabilityData(name, capability.data);
    }
    if (!capability.complete && !capability.failure?.category) throw new Error(`Incomplete Azure capability ${name} needs a failure`);
  }
  return fragment;
}

export function assembleAzureFragments(inputFragments) {
  const fragments = inputFragments.map(validateAzureFragment);
  assertImmutableAgreement(fragments);
  const selected = {};
  const attempts = [];

  for (const name of REQUIRED_AZURE_CAPABILITIES) {
    const candidates = [];
    for (const fragment of fragments) {
      const capability = fragment.capabilities[name];
      if (!capability) continue;
      attempts.push({ capability: name, source: fragment.source, complete: capability.complete, failure: capability.failure ?? null });
      if (capability.complete) candidates.push({ capability, source: fragment.source });
    }
    if (candidates.length) {
      candidates.sort((left, right) => left.source.capturedAt.localeCompare(right.source.capturedAt));
      selected[name] = candidates.at(-1);
    }
  }

  const missing = REQUIRED_AZURE_CAPABILITIES.filter(name => !selected[name]).sort();
  if (missing.length) {
    const blockers = missing.flatMap(name => {
      const failed = attempts.filter(attempt => attempt.capability === name && !attempt.complete);
      return failed.length
        ? failed.map(attempt =>
            `${name} <= ${attempt.source.adapter}/${attempt.source.credentialContext}: ${attempt.failure.category}: ${attempt.failure.message}`)
        : [`${name} <= no adapter produced a complete result`];
    });
    const error = new Error(
      `Incomplete Azure DevOps context: ${missing.join(', ')}\n${blockers.join('\n')}`
    );
    error.attempts = attempts;
    throw error;
  }

  const changeEntries = selected.changes.capability.data.changeEntries;
  if (changeEntries.length && !String(selected.diff.capability.data).trim()) {
    throw new Error('Incomplete Azure DevOps context: diff is empty for a non-empty change list');
  }

  const identity = selected.identity.capability.data;
  const raw = {
    provider: 'azure-devops',
    pullRequest: {
      ...identity,
      ...selected.metadata.capability.data,
      ...selected.snapshot.capability.data
    },
    workItems: selected.workItems.capability.data,
    policies: selected.policies.capability.data,
    iterations: selected.iterations.capability.data,
    changes: selected.changes.capability.data,
    existingThreads: selected.existingThreads.capability.data,
    diff: selected.diff.capability.data
  };
  const packet = normalize(raw);
  packet.providerData.access = {
    capabilities: Object.fromEntries(
      Object.entries(selected).map(([name, value]) => [name, value.source])
    ),
    attempts
  };
  return packet;
}

export async function fragmentFromRawDirectory(directory, source) {
  await Promise.all(RAW_FILES.map(file => access(path.join(directory, file))));
  const raw = await loadRawDirectory('azure-devops', directory);
  const pr = raw.pullRequest;
  return {
    schemaVersion: '1.0',
    source: { ...source, capturedAt: source.capturedAt ?? new Date().toISOString() },
    capabilities: {
      identity: complete({
        pullRequestId: pr.pullRequestId,
        url: pr._links?.web?.href ?? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`,
        repository: pr.repository
      }),
      metadata: complete({
        title: pr.title ?? '',
        description: pr.description ?? '',
        createdBy: pr.createdBy ?? null,
        status: pr.status ?? null,
        isDraft: Boolean(pr.isDraft),
        sourceRefName: pr.sourceRefName ?? '',
        targetRefName: pr.targetRefName ?? '',
        reviewers: pr.reviewers ?? []
      }),
      snapshot: complete({
        lastMergeSourceCommit: pr.lastMergeSourceCommit,
        lastMergeTargetCommit: pr.lastMergeTargetCommit
      }),
      workItems: complete(raw.workItems),
      policies: complete(raw.policies),
      iterations: complete(raw.iterations),
      changes: complete(raw.changes),
      existingThreads: complete(raw.existingThreads),
      diff: complete(raw.diff)
    }
  };
}

function complete(data) {
  return { complete: true, data };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);

  if (mode === 'directory') {
    const [rawDir, adapter, credentialContext, packetJson] = args;
    if (!rawDir || !adapter || !credentialContext || !packetJson) {
      throw new Error('Usage: assemble-azure-context.mjs directory <RAW_DIR> <ADAPTER> <CREDENTIAL_CONTEXT> <PACKET_JSON>');
    }
    const fragment = await fragmentFromRawDirectory(path.resolve(rawDir), { adapter, credentialContext });
    const packet = assembleAzureFragments([fragment]);
    await writeJson(path.resolve(packetJson), packet);
    console.log(`packet: ${packetJson} (source: ${adapter}/${credentialContext})`);
    return;
  }

  if (mode === 'capability') {
    const [adapter, credentialContext, capability, dataFile, fragmentJson] = args;
    if (!adapter || !credentialContext || !capability || !dataFile || !fragmentJson) {
      throw new Error('Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>');
    }
    const data = capability === 'diff'
      ? await readFile(path.resolve(dataFile), 'utf8')
      : await readJson(path.resolve(dataFile));
    const fragment = {
      schemaVersion: '1.0',
      source: { adapter, credentialContext, capturedAt: new Date().toISOString() },
      capabilities: { [capability]: complete(data) }
    };
    validateAzureFragment(fragment);
    await writeJson(path.resolve(fragmentJson), fragment);
    console.log(`fragment: ${fragmentJson} (source: ${adapter}/${credentialContext}, capability: ${capability})`);
    return;
  }

  if (mode === 'failure') {
    const [adapter, credentialContext, category, message, capabilitiesCsv, fragmentJson] = args;
    if (!adapter || !credentialContext || !category || !message || !capabilitiesCsv || !fragmentJson) {
      throw new Error('Usage: assemble-azure-context.mjs failure <ADAPTER> <CREDENTIAL_CONTEXT> <CATEGORY> <MESSAGE> <CAPABILITIES_CSV> <FRAGMENT_JSON>');
    }
    const names = capabilitiesCsv === 'all' ? [...REQUIRED_AZURE_CAPABILITIES] : capabilitiesCsv.split(',').map(s => s.trim());
    const sanitizedMessage = message.replace(/[\r\n]/g, ' ');
    const capabilities = Object.fromEntries(
      names.map(name => [name, { complete: false, failure: { category, message: sanitizedMessage } }])
    );
    const fragment = {
      schemaVersion: '1.0',
      source: { adapter, credentialContext, capturedAt: new Date().toISOString() },
      capabilities
    };
    validateAzureFragment(fragment);
    await writeJson(path.resolve(fragmentJson), fragment);
    console.log(`fragment: ${fragmentJson} (source: ${adapter}/${credentialContext}, failure: ${names.join(', ')})`);
    return;
  }

  if (mode === 'packet') {
    const [packetJson, ...fragmentPaths] = args;
    if (!packetJson || !fragmentPaths.length) {
      throw new Error('Usage: assemble-azure-context.mjs packet <PACKET_JSON> <FRAGMENT_JSON>...');
    }
    const fragments = await Promise.all(fragmentPaths.map(p => readJson(path.resolve(p))));
    const packet = assembleAzureFragments(fragments);
    await writeJson(path.resolve(packetJson), packet);
    const sources = fragments.map(f => `${f.source.adapter}/${f.source.credentialContext}`).join(', ');
    console.log(`packet: ${packetJson} (sources: ${sources})`);
    return;
  }

  throw new Error('Usage: assemble-azure-context.mjs <directory|capability|failure|packet> ...');
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
