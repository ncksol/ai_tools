#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { asArray, isMain, readJson, writeJson } from './lib.mjs';
import { loadRawDirectory, normalize, organizationFromUrl } from './normalize-context.mjs';

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
    case 'iterations':
    case 'existingThreads': {
      // These endpoints return the full result set in one call — no continuation
      // parameters exist to prove or disprove, so array shape is complete evidence.
      if (!Array.isArray(data) && !Array.isArray(data?.value))
        throw new Error(`Azure capability ${name} needs an array or an object with a value array`);
      break;
    }
    case 'policies': {
      // Policy evaluations are $top/$skip paginated, so array shape alone cannot
      // distinguish a fully enumerated result from an unproven first page.
      if (!Array.isArray(data?.value))
        throw new Error('Azure capability policies needs an object with a value array');
      if (data.exhausted !== true)
        throw new Error('Azure capability policies needs exhausted=true evidence that pagination ended');
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
      if (typeof data !== 'object' || data === null || Array.isArray(data))
        throw new Error('Azure capability diff needs an object with repository, baseSha, headSha, and patch');
      if (typeof data.patch !== 'string')
        throw new Error('Azure capability diff needs a string patch');
      const repo = data.repository ?? {};
      if (!String(repo.id ?? repo.name ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty repository id or name');
      const project = repo.project ?? {};
      if (!String(project.id ?? project.name ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty project id or name');
      if (!String(data.baseSha ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty baseSha');
      if (!String(data.headSha ?? '').trim())
        throw new Error('Azure capability diff needs a non-empty headSha');
      break;
    }
    // no default — unknown names are caught in validateAzureFragment
  }
}

function assertImmutableAgreement(fragments) {
  const seen = new Map();

  // An absent key is no evidence: adapters legitimately carry GUIDs only or
  // display names only. Compare id-to-id and name-to-name, never across keys.
  const agree = (key, value, message) => {
    const text = String(value ?? '').trim();
    if (!text) return;
    const previous = seen.get(key);
    if (previous === undefined) seen.set(key, text);
    else if (previous !== text) throw new Error(message);
  };

  for (const fragment of fragments) {
    const id = fragment.capabilities?.identity;
    if (id?.complete) {
      const repo = id.data.repository ?? {};
      const project = repo.project ?? {};
      agree('pullRequestId', id.data.pullRequestId, 'Conflicting Azure PR identity');
      agree('repository.id', repo.id, 'Conflicting Azure PR identity');
      agree('repository.name', repo.name, 'Conflicting Azure PR identity');
      agree('project.id', project.id, 'Conflicting Azure PR identity');
      agree('project.name', project.name, 'Conflicting Azure PR identity');
      agree('organization', organizationFromUrl(id.data.url), 'Conflicting Azure organization');
    }
    const snap = fragment.capabilities?.snapshot;
    if (snap?.complete) {
      const head = String(snap.data.lastMergeSourceCommit?.commitId ?? '').trim();
      if (!head) throw new Error('Conflicting Azure head SHA');
      agree('head', head, 'Conflicting Azure head SHA');
      const base = String(snap.data.lastMergeTargetCommit?.commitId ?? '').trim();
      if (!base) throw new Error('Conflicting Azure base SHA');
      agree('base', base, 'Conflicting Azure base SHA');
    }
    const diff = fragment.capabilities?.diff;
    if (diff?.complete) {
      const repo = diff.data.repository ?? {};
      const project = repo.project ?? {};
      agree('repository.id', repo.id, 'Conflicting Azure PR identity');
      agree('repository.name', repo.name, 'Conflicting Azure PR identity');
      agree('project.id', project.id, 'Conflicting Azure PR identity');
      agree('project.name', project.name, 'Conflicting Azure PR identity');
      agree('head', diff.data.headSha, 'Conflicting Azure head SHA');
      agree('base', diff.data.baseSha, 'Conflicting Azure base SHA');
    }
  }
}

function assertCapabilityShape(name, capability) {
  if (!REQUIRED_AZURE_CAPABILITIES.includes(name)) throw new Error(`Unknown Azure capability: ${name}`);
  if (typeof capability?.complete !== 'boolean') throw new Error(`Azure capability ${name} needs complete=true|false`);
  if (capability.complete) {
    if (!Object.hasOwn(capability, 'data')) throw new Error(`Complete Azure capability ${name} needs data`);
    assertCapabilityData(name, capability.data);
  }
  if (!capability.complete && !capability.failure?.category) throw new Error(`Incomplete Azure capability ${name} needs a failure`);
}

// Malformed data in one capability must not discard the valid evidence an
// adapter collected for the others.
export function downgradeMalformedCapabilities(capabilities) {
  const result = {};
  for (const [name, capability] of Object.entries(capabilities)) {
    try {
      assertCapabilityShape(name, capability);
      result[name] = capability;
    } catch (error) {
      result[name] = {
        complete: false,
        failure: { category: 'malformed', message: error.message.replace(/[\r\n]/g, ' ') }
      };
    }
  }
  return result;
}

export function validateAzureFragment(fragment) {
  if (fragment?.schemaVersion !== '1.0') throw new Error('Azure access fragment schemaVersion must be 1.0');
  for (const key of ['adapter', 'credentialContext', 'capturedAt']) {
    if (!String(fragment.source?.[key] ?? '').trim()) throw new Error(`Azure access fragment source.${key} is required`);
  }
  const names = Object.keys(fragment.capabilities ?? {});
  if (!names.length) throw new Error('Azure access fragment must declare at least one capability');
  for (const name of names) assertCapabilityShape(name, fragment.capabilities[name]);
  return fragment;
}

// Directly queried provider APIs outrank hand-transcribed MCP or manual
// fragments for the same capability; capturedAt breaks ties within a rank.
const AUTHORITATIVE_ADAPTERS = Object.freeze(['azure-cli', 'azure-rest']);

function adapterAuthority(source) {
  return AUTHORITATIVE_ADAPTERS.includes(source.adapter) ? 1 : 0;
}

// A hand-transcribed optional fragment (e.g. Bluebird) can carry one broken
// capability without the whole fragment being unusable. Downgrade malformed
// capabilities the same way collectAzureDevOpsRest already self-sanitizes,
// then only reject the fragment outright if its envelope itself is broken
// (bad schemaVersion, missing source fields, or no capabilities at all) —
// never let one bad fragment abort assembly of other complete sources.
function sanitizeAzureFragment(fragment, rejectedFragments) {
  const capabilities = fragment?.capabilities;
  const safeCapabilities = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    ? capabilities
    : {};
  try {
    return validateAzureFragment({
      ...fragment,
      capabilities: downgradeMalformedCapabilities(safeCapabilities)
    });
  } catch (error) {
    rejectedFragments.push({
      source: fragment?.source ?? null,
      failure: { category: 'malformed', message: error.message.replace(/[\r\n]/g, ' ') }
    });
    return null;
  }
}

export function assembleAzureFragments(inputFragments) {
  const rejectedFragments = [];
  const fragments = inputFragments
    .map(fragment => sanitizeAzureFragment(fragment, rejectedFragments))
    .filter(fragment => fragment !== null);
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
      candidates.sort((left, right) =>
        adapterAuthority(left.source) - adapterAuthority(right.source) ||
        left.source.capturedAt.localeCompare(right.source.capturedAt));
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
  if (changeEntries.length && !String(selected.diff.capability.data.patch).trim()) {
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
    diff: selected.diff.capability.data.patch
  };
  const packet = normalize(raw);
  packet.providerData.access = {
    capabilities: Object.fromEntries(
      Object.entries(selected).map(([name, value]) => [name, value.source])
    ),
    attempts,
    ...(rejectedFragments.length ? { rejectedFragments } : {})
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
      // `az repos pr policy list` has no partial-list mode: it always returns the
      // complete evaluation set, so the CLI route can attest to exhaustion directly.
      policies: complete({ value: asArray(raw.policies), exhausted: true }),
      iterations: complete(raw.iterations),
      changes: complete(raw.changes),
      existingThreads: complete(raw.existingThreads),
      diff: complete({
        repository: pr.repository,
        baseSha: pr.lastMergeTargetCommit?.commitId ?? '',
        headSha: pr.lastMergeSourceCommit?.commitId ?? '',
        patch: raw.diff
      })
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
    const [adapter, credentialContext, capability] = args;
    if (!adapter || !credentialContext || !capability) {
      throw new Error(
        'Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>\n' +
        '       assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> diff <REPOSITORY_JSON> <BASE_SHA> <HEAD_SHA> <DIFF_PATCH> <FRAGMENT_JSON>'
      );
    }
    let data;
    let fragmentJson;
    if (capability === 'diff') {
      const [repositoryJson, baseSha, headSha, diffPatch, fragJson] = args.slice(3);
      if (!repositoryJson || !baseSha || !headSha || !diffPatch || !fragJson) {
        throw new Error('Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> diff <REPOSITORY_JSON> <BASE_SHA> <HEAD_SHA> <DIFF_PATCH> <FRAGMENT_JSON>');
      }
      const repository = await readJson(path.resolve(repositoryJson));
      const patch = await readFile(path.resolve(diffPatch), 'utf8');
      data = { repository, baseSha, headSha, patch };
      fragmentJson = fragJson;
    } else {
      const [dataFile, fragJson] = args.slice(3);
      if (!dataFile || !fragJson) {
        throw new Error('Usage: assemble-azure-context.mjs capability <ADAPTER> <CREDENTIAL_CONTEXT> <CAPABILITY> <DATA_FILE> <FRAGMENT_JSON>');
      }
      data = await readJson(path.resolve(dataFile));
      fragmentJson = fragJson;
    }
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
