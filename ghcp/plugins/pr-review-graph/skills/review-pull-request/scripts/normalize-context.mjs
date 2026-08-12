#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  asArray,
  extractFingerprint,
  flattenPages,
  isMain,
  normalizePath,
  parseFlags,
  parseUnifiedDiff,
  readJson,
  writeJson
} from './lib.mjs';

async function optionalJson(directory, name, fallback) {
  try {
    return await readJson(path.join(directory, name));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function optionalText(directory, name, fallback = '') {
  try {
    return await readFile(path.join(directory, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function loadRawDirectory(provider, directory) {
  const common = {
    provider,
    repository: await optionalJson(directory, 'repository.json', {}),
    pullRequest: await optionalJson(directory, 'pull-request.json', {}),
    diff: await optionalText(directory, 'diff.patch'),
    files: await optionalJson(directory, 'files.json', []),
    checks: await optionalJson(directory, 'checks.json', []),
    existingThreads: await optionalJson(directory, 'threads.json', []),
    requirements: await optionalJson(directory, 'requirements.json', [])
  };
  if (provider === 'github') {
    common.reviewComments = await optionalJson(directory, 'review-comments.json', []);
    common.reviews = await optionalJson(directory, 'reviews.json', []);
    common.issueComments = await optionalJson(directory, 'issue-comments.json', []);
  } else {
    common.iterations = await optionalJson(directory, 'iterations.json', []);
    common.changes = await optionalJson(directory, 'changes.json', []);
    common.workItems = await optionalJson(directory, 'work-items.json', []);
    common.policies = await optionalJson(directory, 'policies.json', []);
  }
  return common;
}

export function normalize(raw) {
  if (raw.provider === 'github') return normalizeGitHub(raw);
  if (raw.provider === 'azure-devops') return normalizeAzure(raw);
  throw new Error(`Unsupported provider: ${raw.provider}`);
}

export function normalizeGitHub(raw) {
  const repo = raw.repository ?? {};
  const pr = raw.pullRequest ?? {};
  const apiFiles = flattenPages(raw.files);
  const parsedDiffs = parseUnifiedDiff(raw.diff);
  const diffByPath = new Map(parsedDiffs.map(file => [normalizePath(file.path), file]));
  const warnings = [];

  const files = apiFiles.map(file => {
    const filePath = normalizePath(file.filename ?? file.path);
    const parsed = diffByPath.get(filePath);
    const patch = file.patch ? `${file.patch.trimEnd()}\n` : parsed?.patch ?? null;
    const isBinary = Boolean(parsed?.isBinary);
    if (!patch && !isBinary) warnings.push(`No patch content for ${filePath}`);
    return {
      path: filePath,
      previousPath: normalizePath(file.previous_filename) || parsed?.previousPath || null,
      status: file.status ?? 'modified',
      additions: numericOrNull(file.additions),
      deletions: numericOrNull(file.deletions),
      patch,
      isBinary,
      changeTrackingId: null
    };
  });

  for (const parsed of parsedDiffs) {
    if (!files.some(file => file.path === parsed.path)) {
      files.push({
        path: parsed.path,
        previousPath: parsed.previousPath,
        status: parsed.previousPath ? 'renamed' : 'modified',
        additions: null,
        deletions: null,
        patch: parsed.patch,
        isBinary: parsed.isBinary,
        changeTrackingId: null
      });
    }
  }

  const nameWithOwner = repo.nameWithOwner ?? repositoryFromUrl(pr.url) ?? '';
  const [owner, name] = nameWithOwner.split('/');
  const reviewComments = flattenPages(raw.reviewComments).map(comment => normalizeThread('review-comment', comment));
  const reviews = flattenPages(raw.reviews)
    .filter(review => String(review.body ?? '').trim())
    .map(review => normalizeThread('review', review));
  const issueComments = flattenPages(raw.issueComments).map(comment => normalizeThread('issue-comment', comment));
  const checks = asArray(raw.checks).length ? asArray(raw.checks) : asArray(pr.statusCheckRollup);
  const requirements = [
    ...(String(pr.body ?? '').trim() ? [{ id: 'pr-description', type: 'description', title: pr.title ?? '', body: pr.body }] : []),
    ...asArray(pr.closingIssuesReferences).map(issue => ({
      id: String(issue.number ?? issue.id),
      type: 'linked-issue',
      title: issue.title ?? '',
      url: issue.url ?? null,
      body: issue.body ?? ''
    })),
    ...asArray(raw.requirements)
  ];

  return {
    schemaVersion: '1.0',
    provider: 'github',
    repository: {
      id: nameWithOwner,
      owner: owner || null,
      name: name || repo.name || nameWithOwner,
      url: repo.url ?? githubRepoUrl(pr.url),
      project: null,
      defaultBranch: repo.defaultBranchRef?.name ?? null
    },
    pullRequest: {
      id: String(pr.id ?? pr.number),
      number: Number(pr.number),
      url: pr.url ?? '',
      title: pr.title ?? '',
      description: pr.body ?? '',
      author: pr.author?.login ?? pr.author?.name ?? null,
      draft: Boolean(pr.isDraft),
      base: { ref: pr.baseRefName ?? '', sha: pr.baseRefOid ?? '' },
      head: { ref: pr.headRefName ?? '', sha: pr.headRefOid ?? '' }
    },
    files,
    existingThreads: [...reviewComments, ...reviews, ...issueComments],
    checks,
    requirements,
    limits: {
      warnings,
      truncatedFiles: files.filter(file => !file.patch && !file.isBinary).map(file => ({ path: file.path, reason: 'patch-unavailable' }))
    },
    providerData: {},
    collectedAt: new Date().toISOString()
  };
}

export function normalizeAzure(raw) {
  const pr = raw.pullRequest ?? {};
  const repo = pr.repository ?? raw.repository ?? {};
  const project = repo.project ?? {};
  const parsedDiffs = parseUnifiedDiff(raw.diff);
  const parsedByPath = new Map(parsedDiffs.map(file => [normalizePath(file.path), file]));
  const changes = asArray(raw.changes?.changeEntries ?? raw.changes);
  const changeByPath = new Map();
  for (const change of changes) {
    const filePath = normalizePath(change.item?.path ?? change.path);
    if (filePath) changeByPath.set(filePath, change);
  }

  const paths = new Set([...parsedByPath.keys(), ...changeByPath.keys()]);
  const warnings = [];
  const files = [...paths].map(filePath => {
    const parsed = parsedByPath.get(filePath);
    const change = changeByPath.get(filePath);
    if (!parsed?.patch && !parsed?.isBinary) warnings.push(`No patch content for ${filePath}`);
    return {
      path: filePath,
      previousPath: parsed?.previousPath ?? (normalizePath(change?.sourceServerItem) || null),
      status: String(change?.changeType ?? (parsed?.previousPath ? 'rename' : 'edit')).toLowerCase(),
      additions: null,
      deletions: null,
      patch: parsed?.patch ?? null,
      isBinary: Boolean(parsed?.isBinary),
      changeTrackingId: numericOrNull(change?.changeTrackingId)
    };
  });

  const iterations = asArray(raw.iterations);
  const latestIterationId = Math.max(0, ...iterations.map(item => Number(item.id ?? 0)));
  const sourceSha = pr.lastMergeSourceCommit?.commitId ?? pr.sourceCommit?.commitId ?? '';
  const targetSha = pr.lastMergeTargetCommit?.commitId ?? pr.targetCommit?.commitId ?? '';
  const prNumber = Number(pr.pullRequestId ?? pr.id);
  const webUrl = pr._links?.web?.href ?? (repo.webUrl ? `${repo.webUrl}/pullrequest/${prNumber}` : pr.url ?? '');
  const threads = asArray(raw.existingThreads).map(thread => {
    const comments = asArray(thread.comments);
    const body = comments.map(comment => comment.content ?? '').filter(Boolean).join('\n\n');
    return {
      id: String(thread.id),
      type: 'thread',
      status: thread.status ?? null,
      path: normalizePath(thread.threadContext?.filePath) || null,
      line: thread.threadContext?.rightFileStart?.line ?? thread.threadContext?.leftFileStart?.line ?? null,
      author: comments[0]?.author?.displayName ?? comments[0]?.author?.uniqueName ?? null,
      url: thread._links?.self?.href ?? (webUrl ? `${webUrl}?discussionId=${thread.id}` : null),
      body,
      fingerprint: extractFingerprint(body),
      comments
    };
  });

  const workItems = asArray(raw.workItems).map(item => ({
    id: String(item.id),
    type: 'work-item',
    title: item.fields?.['System.Title'] ?? item.title ?? '',
    url: item.url ?? null,
    body: item.fields?.['System.Description'] ?? ''
  }));
  const descriptionRequirement = String(pr.description ?? '').trim()
    ? [{ id: 'pr-description', type: 'description', title: pr.title ?? '', body: pr.description }]
    : [];

  if (!String(raw.diff ?? '').trim()) warnings.push('Unified diff is unavailable');

  return {
    schemaVersion: '1.0',
    provider: 'azure-devops',
    repository: {
      id: String(repo.id ?? repo.name ?? ''),
      owner: null,
      name: repo.name ?? '',
      url: repo.webUrl ?? repo.url ?? '',
      project: project.name ?? project.id ?? null,
      defaultBranch: repo.defaultBranch ? stripRef(repo.defaultBranch) : null
    },
    pullRequest: {
      id: String(prNumber),
      number: prNumber,
      url: webUrl,
      title: pr.title ?? '',
      description: pr.description ?? '',
      author: pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? null,
      draft: Boolean(pr.isDraft),
      base: { ref: stripRef(pr.targetRefName ?? ''), sha: targetSha },
      head: { ref: stripRef(pr.sourceRefName ?? ''), sha: sourceSha }
    },
    files,
    existingThreads: threads,
    checks: asArray(raw.policies).length ? asArray(raw.policies) : asArray(raw.checks),
    requirements: [...descriptionRequirement, ...workItems, ...asArray(raw.requirements)],
    limits: {
      warnings,
      truncatedFiles: files.filter(file => !file.patch && !file.isBinary).map(file => ({ path: file.path, reason: 'patch-unavailable' }))
    },
    providerData: {
      organization: organizationFromUrl(repo.webUrl ?? pr.url),
      projectId: String(project.id ?? project.name ?? ''),
      repositoryId: String(repo.id ?? ''),
      latestIterationId,
      firstComparingIteration: latestIterationId > 0 ? 1 : null
    },
    collectedAt: new Date().toISOString()
  };
}

function normalizeThread(type, value) {
  const body = value.body ?? '';
  return {
    id: String(value.id ?? value.node_id ?? ''),
    type,
    status: value.state ?? null,
    path: normalizePath(value.path) || null,
    line: value.line ?? value.original_line ?? null,
    author: value.user?.login ?? value.author?.login ?? null,
    url: value.html_url ?? value.url ?? null,
    body,
    fingerprint: extractFingerprint(body)
  };
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function repositoryFromUrl(value) {
  const match = String(value ?? '').match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match?.[1] ?? null;
}

function githubRepoUrl(value) {
  const match = String(value ?? '').match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)/);
  return match?.[1] ?? '';
}

function organizationFromUrl(value) {
  const text = String(value ?? '');
  const modern = text.match(/dev\.azure\.com\/([^/]+)/i);
  if (modern) return modern[1];
  const legacy = text.match(/https?:\/\/([^.]+)\.visualstudio\.com/i);
  return legacy?.[1] ?? null;
}

function stripRef(value) {
  return String(value ?? '').replace(/^refs\/heads\//, '');
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const provider = flags.provider;
  const output = flags.output ?? flags._[1];
  if (!provider || !output || (!flags['input-dir'] && !flags._[0])) {
    throw new Error('Usage: normalize-context.mjs --provider <github|azure-devops> (--input-dir DIR|RAW_JSON) --output PACKET_JSON');
  }
  const raw = flags['input-dir']
    ? await loadRawDirectory(provider, path.resolve(flags['input-dir']))
    : { ...(await readJson(flags._[0])), provider };
  await writeJson(path.resolve(output), normalize(raw));
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
