import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { MINUTE, parseTime } from '../time.mjs';

export const GITHUB_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export const ADO_REPO = /^[A-Za-z0-9][\w.-]*\/[^/\r\n]+\/[^/\r\n]+$/;
const EMPTY_INFO = Object.freeze({ state: 'unknown', title: null, openedAt: null, mergedAt: null, closedAt: null, reviewNote: null, url: null });

// Turns off what az and gh write or send on their own: logs, telemetry, extension installs, upgrades, surveys and prompts.
// Accepted exception: the CLIs may still refresh their sign-in caches, and az may rebuild its command index after an upgrade.
export const CLI_ENV = Object.freeze({
  az: Object.freeze({
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
    AZURE_CORE_COLLECT_TELEMETRY: 'no',
    AZURE_LOGGING_ENABLE_LOG_FILE: 'no',
    AZURE_CORE_SURVEY_MESSAGE: 'no',
    'AZURE_AUTO-UPGRADE_ENABLE': 'no', // knack keeps the hyphen of the auto-upgrade section.
  }),
  gh: Object.freeze({ GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GH_TELEMETRY: 'false' }),
});

export const cliEnv = (command, base = process.env) => ({ ...base, ...CLI_ENV[command] });

// With dynamic install off, az fails like this when the azure-devops extension is missing. The dashboard never installs it.
const MISSING_EXTENSION = /not recognized by the system|requires the extension|az extension add/i;
const MISSING_EXTENSION_MESSAGE = 'Azure DevOps PR state is unavailable: the azure-devops extension for az is not installed (the dashboard never installs it).';

export function runCommand(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`${command} failed: ${String(stderr || error.message).trim().split('\n')[0].slice(0, 200)}`);
        failure.code = error.code;
        reject(failure);
        return;
      }
      resolve(String(stdout));
    });
  });
}

const adoOrg = pr => (typeof pr.repo === 'string' && ADO_REPO.test(pr.repo) ? pr.repo.split('/')[0] : null);

/** The repository a lookup can name on the command line, or null when it has to run in the unit's worktree. */
export const targetOf = pr => (pr.provider === 'ado' ? adoOrg(pr) : typeof pr.repo === 'string' && GITHUB_REPO.test(pr.repo) ? pr.repo : null);

/** Cache key. A PR without a usable repository is resolved in its worktree, so the worktree is part of its identity. */
export const prKey = (pr, cwd = null) => (targetOf(pr) ? `${pr.provider}:${pr.repo}:${pr.id}` : `${pr.provider}:@${cwd ?? ''}:${pr.id}`);

export function adoArgs(pr) {
  const args = ['repos', 'pr', 'show', '--id', String(pr.id), '--output', 'json'];
  const org = adoOrg(pr);
  if (org) args.push('--organization', `https://dev.azure.com/${org}`, '--detect', 'false');
  return args;
}

export function githubArgs(pr) {
  const args = ['pr', 'view', String(pr.id), '--json', 'state,isDraft,title,createdAt,mergedAt,closedAt,reviewDecision,url'];
  if (pr.repo && GITHUB_REPO.test(pr.repo)) args.push('--repo', pr.repo);
  return args;
}

export function mapAdo(json) {
  const status = String(json.status ?? '').toLowerCase();
  const state = status === 'completed' ? 'merged' : status === 'abandoned' ? 'closed' : status === 'active' ? (json.isDraft ? 'draft' : 'open') : 'unknown';
  const votes = Array.isArray(json.reviewers) ? json.reviewers.map(reviewer => Number(reviewer.vote) || 0) : [];
  const approvals = votes.filter(vote => vote >= 5).length;
  const reviewNote = votes.includes(-10) ? 'rejected' : votes.includes(-5) ? 'waiting for the author'
    : approvals ? `${approvals} approval${approvals === 1 ? '' : 's'}` : 'no approvals yet';
  const webUrl = json.repository?.webUrl;
  return {
    state, title: typeof json.title === 'string' ? json.title : null, openedAt: parseTime(json.creationDate),
    mergedAt: state === 'merged' ? parseTime(json.closedDate) : null, closedAt: parseTime(json.closedDate), reviewNote,
    url: typeof webUrl === 'string' && json.pullRequestId ? `${webUrl}/pullrequest/${json.pullRequestId}` : null,
  };
}

export function mapGithub(json) {
  const raw = String(json.state ?? '').toUpperCase();
  const state = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : raw === 'OPEN' ? (json.isDraft ? 'draft' : 'open') : 'unknown';
  const reviewNote = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }[json.reviewDecision] ?? null;
  return {
    state, title: typeof json.title === 'string' ? json.title : null, openedAt: parseTime(json.createdAt),
    mergedAt: parseTime(json.mergedAt), closedAt: parseTime(json.closedAt), reviewNote, url: typeof json.url === 'string' ? json.url : null,
  };
}

/**
 * Cached, read-only PR state through `az repos pr show` and `gh pr view`. Only a merged result is final. A closed or abandoned PR can
 * be reopened or reactivated, so it is checked again after the TTL like an open one.
 */
export function createPrLookup({ run = runCommand, now = Date.now, ttlMs = 5 * MINUTE, timeoutMs = 20_000, concurrency = 2, exists = existsSync } = {}) {
  const cache = new Map();
  const queue = [];
  const inflight = new Set();
  let active = 0;
  let waiters = [];
  const isFinal = info => info.state === 'merged';
  const due = key => {
    const info = cache.get(key)?.info;
    return !info || (!isFinal(info) && now() - info.checkedAt >= ttlMs);
  };

  async function lookup({ pr, key, label, cwd }) {
    const store = info => cache.set(key, { label, info });
    try {
      if (cwd && !exists(cwd)) throw new Error('its worktree is gone, so its repository is unknown');
      const ado = pr.provider === 'ado';
      const command = ado ? 'az' : 'gh';
      let stdout;
      try {
        stdout = await run(command, ado ? adoArgs(pr) : githubArgs(pr), { cwd: cwd ?? undefined, timeoutMs, env: cliEnv(command) });
      } catch (error) {
        if (ado && MISSING_EXTENSION.test(error.message)) throw new Error(MISSING_EXTENSION_MESSAGE);
        throw error;
      }
      store({ ...(ado ? mapAdo : mapGithub)(JSON.parse(stdout)), checkedAt: now(), error: null });
    } catch (error) {
      store({ ...(cache.get(key)?.info ?? EMPTY_INFO), checkedAt: now(), error: error.message });
    }
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      lookup(job).finally(() => {
        active -= 1;
        inflight.delete(job.key);
        if (queue.length) {
          pump();
        } else if (!active) {
          const list = waiters;
          waiters = [];
          for (const resolve of list) resolve();
        }
      });
    }
  }

  function request(pr, { cwd = null } = {}) {
    if (!pr || !Number.isInteger(pr.id) || pr.id <= 0 || (pr.provider !== 'ado' && pr.provider !== 'github')) return;
    const target = targetOf(pr);
    if (!target && !cwd) return;
    const key = prKey(pr, cwd);
    if (inflight.has(key) || !due(key)) return;
    inflight.add(key);
    // The label goes into diagnostics, so it never holds the worktree path.
    queue.push({ pr, key, label: `${pr.provider}:${pr.repo ?? 'worktree'}:${pr.id}`, cwd: target ? null : cwd });
    pump();
  }

  return {
    get: (pr, { cwd = null } = {}) => cache.get(prKey(pr, cwd))?.info ?? null,
    request,
    pending: (pr, { cwd = null } = {}) => Boolean(pr) && inflight.has(prKey(pr, cwd)),
    settle: () => (active || queue.length ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve()),
    errors: () => [...cache.values()].filter(({ info }) => info.error).map(({ label, info }) => ({ key: label, error: info.error })),
  };
}
