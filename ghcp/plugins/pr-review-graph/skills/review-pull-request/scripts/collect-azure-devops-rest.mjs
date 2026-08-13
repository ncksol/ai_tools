#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMain, writeJson } from './lib.mjs';
import { downgradeMalformedCapabilities, validateAzureFragment } from './assemble-azure-context.mjs';
import { withDeadline } from './run-with-deadline.mjs';

const execFileAsync = promisify(execFile);
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function accessError(category, message) {
  const error = new Error(message);
  error.category = category;
  return error;
}

function complete(data) {
  return { complete: true, data };
}

function incomplete(error) {
  return {
    complete: false,
    failure: {
      category: error.category ?? 'malformed',
      message: error.message
    }
  };
}

async function capture(capabilities, name, operation) {
  try {
    capabilities[name] = complete(await operation());
  } catch (error) {
    capabilities[name] = incomplete(error);
  }
}

function requireValueArray(value, context) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.value)) return value.value;
  throw accessError('malformed', `unexpected ${context} response shape`);
}

export async function pagedPolicyEvaluations(root, artifactId, get) {
  const all = [];
  let skip = 0;
  const seenPages = new Set();
  for (;;) {
    const encodedArtifactId = encodeURIComponent(artifactId);
    const url = `${root}/_apis/policy/evaluations?artifactId=${encodedArtifactId}&includeNotApplicable=true&api-version=7.1&%24top=100&%24skip=${skip}`;
    const page = await get(url, 'policy evaluations');
    const items = requireValueArray(page, 'policy evaluations page');
    all.push(...items);
    if (items.length < 100) break;
    const signature = JSON.stringify(items);
    if (seenPages.has(signature)) {
      throw accessError('malformed', 'repeated Azure policy evaluation page');
    }
    seenPages.add(signature);
    skip += items.length;
  }
  return { value: all, exhausted: true };
}

export async function pagedIterationChanges(pullRoot, iterationId, get) {
  const allEntries = [];
  let skip = 0;
  let top = 2000;
  const seenCursors = new Set();

  for (;;) {
    const url = `${pullRoot}/iterations/${iterationId}/changes?%24compareTo=0&%24top=${top}&%24skip=${skip}`;
    const page = await get(url, `iteration ${iterationId} changes`);
    if (!Array.isArray(page?.changeEntries)) {
      throw accessError('malformed', `iteration ${iterationId} changes page missing changeEntries array`);
    }
    allEntries.push(...page.changeEntries);

    if (
      !Number.isInteger(page.nextSkip) || page.nextSkip < 0 ||
      !Number.isInteger(page.nextTop)  || page.nextTop  < 0
    ) {
      throw accessError('malformed', `iteration ${iterationId} changes page has invalid pagination fields`);
    }
    const nextSkip = page.nextSkip;
    const nextTop = page.nextTop;
    if (nextSkip === 0 && nextTop === 0) {
      return { changeEntries: allEntries, nextSkip: 0, nextTop: 0 };
    }

    const cursor = `${nextSkip}:${nextTop}`;
    if (seenCursors.has(cursor)) {
      throw accessError('malformed', 'repeated Azure iteration-change cursor');
    }
    seenCursors.add(cursor);
    skip = nextSkip;
    top = nextTop;
  }
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function parseAzurePullRequestUrl(value) {
  const url = new URL(value);
  let organization;
  let segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname.toLowerCase() === 'dev.azure.com') {
    organization = segments.shift();
  } else if (url.hostname.toLowerCase().endsWith('.visualstudio.com')) {
    organization = url.hostname.split('.')[0];
  } else {
    throw new Error('Azure DevOps PR URL must use dev.azure.com or visualstudio.com');
  }
  const gitIndex = segments.findIndex(segment => segment.toLowerCase() === '_git');
  const pullIndex = segments.findIndex(segment => segment.toLowerCase() === 'pullrequest');
  if (!organization || gitIndex < 1 || pullIndex !== gitIndex + 2 || !/^\d+$/.test(segments[pullIndex + 1] ?? '')) {
    throw new Error('Azure DevOps PR URL must identify organization, project, repository, and pull request');
  }
  const project = decodeURIComponent(segments[gitIndex - 1]);
  const repository = decodeURIComponent(segments[gitIndex + 1]);
  const pullRequestId = Number(segments[pullIndex + 1]);
  return {
    organization,
    organizationUrl: `https://${url.hostname.toLowerCase() === 'dev.azure.com' ? `dev.azure.com/${organization}` : `${organization}.visualstudio.com`}`,
    project,
    repository,
    pullRequestId,
    webUrl: value
  };
}

export async function authorizationForMode(mode, {
  env = process.env,
  execFileImpl = execFileAsync
} = {}) {
  if (mode === 'anonymous') return null;
  if (mode === 'pat') {
    const token = env.AZURE_DEVOPS_EXT_PAT;
    if (!token) throw accessError('tool-unavailable', 'AZURE_DEVOPS_EXT_PAT is not configured');
    return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  }
  if (mode === 'entra') {
    const deadlineMs = Number(env.PRG_AZURE_ENTRA_TOKEN_DEADLINE_MS) || 15_000;
    let stdout;
    try {
      ({ stdout } = await withDeadline(execFileImpl('az', [
        'account',
        'get-access-token',
        '--resource',
        AZURE_DEVOPS_RESOURCE,
        '--query',
        'accessToken',
        '--output',
        'tsv'
      ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: deadlineMs }), deadlineMs));
    } catch (error) {
      if (error?.timedOut) throw accessError('transient', `Azure CLI token request timed out after ${deadlineMs}ms`);
      throw accessError('authentication', 'Azure CLI could not provide an Azure DevOps access token');
    }
    const token = stdout.trim();
    if (!token) throw accessError('authentication', 'Azure CLI returned no Azure DevOps access token');
    return ['Bearer', token].join(' ');
  }
  throw new Error(`Unsupported Azure REST credential mode: ${mode}`);
}

function backoffMilliseconds(attempt) {
  return 2 ** attempt * 1000;
}

// Retry-After counts only when the server actually sent a usable delay.
function retryAfterMilliseconds(response) {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds * 1000;
}

export async function requestJson(url, {
  authorization,
  operation,
  fetchImpl = fetch,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          accept: 'application/json',
          ...(authorization ? { authorization } : {})
        },
        signal: AbortSignal.timeout(30_000)
      });
    } catch {
      if (attempt === 2) throw accessError('transient', `${operation} failed after 3 attempts (network, TLS, or timeout error)`);
      await sleep(backoffMilliseconds(attempt));
      continue;
    }
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) {
      throw accessError('authentication', `HTTP ${response.status} from ${operation}`);
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 2) throw accessError('transient', `HTTP ${response.status} from ${operation} after 3 attempts`);
      await sleep(retryAfterMilliseconds(response) ?? backoffMilliseconds(attempt));
      continue;
    }
    throw accessError('malformed', `HTTP ${response.status} from ${operation}`);
  }
}

export async function collectAzureDevOpsRest({
  prUrl,
  credentialContext,
  authorization,
  fetchImpl = fetch,
  sleep
}) {
  const target = parseAzurePullRequestUrl(prUrl);
  const source = {
    adapter: 'azure-rest',
    credentialContext,
    capturedAt: new Date().toISOString()
  };
  const capabilities = {};
  const get = (url, operation) => requestJson(url, { authorization, operation, fetchImpl, sleep });

  let pr;
  try {
    pr = await get(
      `${target.organizationUrl}/${encodeURIComponent(target.project)}/_apis/git/pullrequests/${target.pullRequestId}?api-version=7.1`,
      'pull request'
    );
    pr.repository.webUrl ??= `${target.organizationUrl}/${encodeURIComponent(target.project)}/_git/${encodeURIComponent(pr.repository.name)}`;
    pr._links ??= {};
    pr._links.web ??= { href: prUrl };
    capabilities.identity = complete({
      pullRequestId: pr.pullRequestId,
      url: prUrl,
      repository: pr.repository
    });
    capabilities.metadata = complete({
      title: pr.title ?? '',
      description: pr.description ?? '',
      createdBy: pr.createdBy ?? null,
      status: pr.status ?? null,
      isDraft: Boolean(pr.isDraft),
      sourceRefName: pr.sourceRefName ?? '',
      targetRefName: pr.targetRefName ?? '',
      reviewers: pr.reviewers ?? []
    });
    capabilities.snapshot = complete({
      lastMergeSourceCommit: pr.lastMergeSourceCommit,
      lastMergeTargetCommit: pr.lastMergeTargetCommit
    });
  } catch (error) {
    for (const name of ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'existingThreads']) {
      capabilities[name] = incomplete(error);
    }
    return validateAzureFragment({ schemaVersion: '1.0', source, capabilities });
  }

  const project = pr.repository.project;
  const projectPath = encodeURIComponent(project.id ?? project.name);
  const repositoryPath = encodeURIComponent(pr.repository.id ?? pr.repository.name);
  const root = `${target.organizationUrl}/${projectPath}`;
  const pullRoot = `${root}/_apis/git/repositories/${repositoryPath}/pullRequests/${pr.pullRequestId}`;

  await capture(capabilities, 'workItems', async () => {
    const refs = requireValueArray(await get(`${pullRoot}/workitems?api-version=7.1`, 'linked work items'), 'linked work items');
    return Promise.all(refs.map(ref => get(
      `${root}/_apis/wit/workitems/${encodeURIComponent(ref.id)}?%24expand=All&api-version=7.1`,
      `work item ${ref.id}`
    )));
  });

  await capture(capabilities, 'policies', async () => {
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${project.id}/${pr.pullRequestId}`;
    return pagedPolicyEvaluations(root, artifactId, get);
  });

  let iterations;
  await capture(capabilities, 'iterations', async () => {
    iterations = await get(`${pullRoot}/iterations?api-version=7.1`, 'pull request iterations');
    return iterations;
  });

  if (capabilities.iterations.complete) {
    await capture(capabilities, 'changes', async () => {
      const latest = Math.max(...requireValueArray(iterations, 'iteration list').map(iteration => Number(iteration.id)));
      return pagedIterationChanges(pullRoot, latest, get);
    });
  } else {
    capabilities.changes = incomplete(accessError('incomplete', 'Iteration changes require complete iteration metadata'));
  }

  await capture(capabilities, 'existingThreads', () =>
    get(`${pullRoot}/threads?api-version=7.1`, 'pull request threads')
  );

  return validateAzureFragment({
    schemaVersion: '1.0',
    source,
    capabilities: downgradeMalformedCapabilities(capabilities)
  });
}

export function failedAzureRestFragment(credentialContext, error) {
  const failure = {
    complete: false,
    failure: {
      category: error.category ?? 'authentication',
      message: error.message
    }
  };
  return validateAzureFragment({
    schemaVersion: '1.0',
    source: {
      adapter: 'azure-rest',
      credentialContext,
      capturedAt: new Date().toISOString()
    },
    capabilities: Object.fromEntries(
      ['identity', 'metadata', 'snapshot', 'workItems', 'policies', 'iterations', 'changes', 'existingThreads']
        .map(name => [name, structuredClone(failure)])
    )
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  const [prUrl, mode, fragmentJson] = process.argv.slice(2);
  if (!prUrl || !mode || !fragmentJson) {
    process.stderr.write('Usage: collect-azure-devops-rest.mjs <PR_URL> <anonymous|pat|entra> <FRAGMENT_JSON>\n');
    process.exitCode = 2;
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = parseAzurePullRequestUrl(prUrl);
  } catch (error) {
    process.stderr.write(`Invalid PR URL: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  let authorization;
  try {
    authorization = await authorizationForMode(mode);
  } catch (error) {
    const fragment = failedAzureRestFragment(mode, error);
    try {
      await writeJson(fragmentJson, fragment);
    } catch (writeError) {
      process.stderr.write(`Failed to write fragment: ${writeError.message}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`Captured Azure REST attempt ${mode} at ${fragmentJson}`);
    return;
  }

  let fragment;
  try {
    fragment = await collectAzureDevOpsRest({
      prUrl,
      credentialContext: mode,
      authorization
    });
  } catch (error) {
    process.stderr.write(`Collection failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await writeJson(fragmentJson, fragment);
  } catch (error) {
    process.stderr.write(`Failed to write fragment: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`Captured Azure REST attempt ${mode} at ${fragmentJson}`);
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
