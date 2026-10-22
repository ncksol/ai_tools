import { MINUTE, maxTime } from '../time.mjs';
import { ADO_REPO, GITHUB_REPO } from './pr-lookup.mjs';

/** The unit's code host: `workspace.yaml` host_type and repository, else the project's GitHub columns. */
export function hostOf(workspaceFile, project) {
  const repository = workspaceFile?.repository ?? null;
  if (workspaceFile?.hostType === 'ado') return { provider: 'ado', repo: repository && ADO_REPO.test(repository) ? repository : null };
  if (workspaceFile?.hostType === 'github') return { provider: 'github', repo: repository && GITHUB_REPO.test(repository) ? repository : null };
  if (project?.githubOwner && project?.githubRepo) return { provider: 'github', repo: `${project.githubOwner}/${project.githubRepo}` };
  return { provider: null, repo: null };
}

/** How many mentioned PRs, most-mentioned first, are tried before the unit is left with no PR. Each one tried can start a lookup. */
export const MENTION_CANDIDATES = 3;

const branchName = branch => (typeof branch === 'string' && branch ? branch.replace(/^refs\/heads\//, '') : null);

/**
 * A mentioned PR can be another unit's PR named as background. It is not the unit's own when its lookup shows it merged or closed
 * before the unit started. Otherwise, when the PR's source branch and the unit's branch are both known, they must be equal; a unit
 * can take over a PR opened before it started on that PR's own branch. With a branch unknown, a PR opened before the unit started is
 * not its own. With no lookup yet, it is kept.
 */
export function mentionFits(info, { startedAt = null, branch = null } = {}) {
  if (!info) return true;
  const before = time => startedAt !== null && typeof time === 'number' && time < startedAt;
  if (before(info.mergedAt) || before(info.closedAt)) return false;
  const source = branchName(info.sourceBranch);
  const own = branchName(branch);
  if (source && own) return source === own;
  return !before(info.openedAt);
}

/** Mentioned PRs in the unit's reports, most-mentioned first, for Azure DevOps hosts only (design section 12). */
function rankMentions(mentions, host) {
  if (host?.provider !== 'ado') return [];
  const totals = new Map();
  for (const mention of mentions.values()) {
    if (mention.provider !== 'ado' && mention.provider !== null) continue;
    const total = totals.get(mention.id) ?? { id: mention.id, count: 0, firstAt: mention.firstAt, lastAt: mention.lastAt };
    total.count += mention.count;
    total.firstAt = Math.min(total.firstAt, mention.firstAt);
    total.lastAt = Math.max(total.lastAt, mention.lastAt);
    totals.set(mention.id, total);
  }
  return [...totals.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .map(total => ({ provider: 'ado', id: total.id, repo: host.repo, knownAt: total.firstAt }));
}

/**
 * PR identity: registry row, latest contract status line, the app's PR columns, then the most-mentioned PR that `accepts` takes,
 * trying at most MENTION_CANDIDATES of them. Mentions are used only for a unit with no registry row (design section 11): the
 * contract fills a row's PR as soon as one exists, so a row without one means the unit has no PR.
 */
export function resolvePr({ registry = null, statusLines = [], createdPr = null, mentions = new Map(), host = null, accepts = () => true } = {}) {
  const repoFor = provider => (host?.provider === provider ? host.repo : null);
  // The earliest retained status line that names this PR, or null. Sent history is capped, so older lines may be gone:
  // this is when the PR was known by, not when it was created.
  const firstReported = (provider, id) => {
    const same = statusLines.filter(item => item.pr && item.pr.provider === provider && item.pr.id === id);
    return same.length ? Math.min(...same.map(item => item.at)) : null;
  };
  if (registry?.prProvider && registry.prId) {
    const valid = registry.prProvider === 'ado' ? ADO_REPO : registry.prProvider === 'github' ? GITHUB_REPO : null;
    const repo = valid && typeof registry.prRepo === 'string' && valid.test(registry.prRepo) ? registry.prRepo : repoFor(registry.prProvider);
    return { provider: registry.prProvider, id: registry.prId, repo, url: registry.prUrl ?? null, source: 'registry', knownAt: firstReported(registry.prProvider, registry.prId) };
  }
  const line = statusLines.find(item => item.pr);
  if (line) {
    return { provider: line.pr.provider, id: line.pr.id, repo: repoFor(line.pr.provider), url: null, source: 'status_line', knownAt: firstReported(line.pr.provider, line.pr.id) };
  }
  if (createdPr?.number) {
    return { provider: 'github', id: createdPr.number, repo: createdPr.repo ?? repoFor('github'), url: createdPr.url ?? null, source: 'app', knownAt: null };
  }
  if (registry) return null;
  for (const candidate of rankMentions(mentions, host).slice(0, MENTION_CANDIDATES)) {
    const identity = { ...candidate, url: null, source: 'heuristic' };
    if (accepts(identity)) return identity;
  }
  return null;
}

/** The app's PR record is this PR: it is the identity's own source, or a GitHub PR with the same repository and number. */
function sameAppPr(pr, createdPr) {
  if (!createdPr) return false;
  if (pr.source === 'app') return true;
  const sameRepo = typeof pr.repo === 'string' && typeof createdPr.repo === 'string' && pr.repo.toLowerCase() === createdPr.repo.toLowerCase();
  return pr.provider === 'github' && sameRepo && Number(createdPr.number) === Number(pr.id);
}

/** The lookup's PR state first; the app's PR record, which can lag, only when the lookup has none. */
export function prView(pr, info, createdPr) {
  let state = info && info.state !== 'unknown' ? info.state : null;
  let mergedAt = info?.mergedAt ?? null;
  if (!state && sameAppPr(pr, createdPr)) {
    const raw = String(createdPr.state ?? '').toLowerCase();
    state = createdPr.mergedAt || raw === 'merged' ? 'merged' : raw === 'closed' ? 'closed' : raw === 'draft' ? 'draft' : raw === 'open' ? 'open' : null;
    mergedAt = mergedAt ?? createdPr.mergedAt ?? null;
  }
  return {
    provider: pr.provider, id: pr.id, repo: pr.repo ?? null, url: info?.url ?? pr.url ?? null, title: info?.title ?? null,
    state: state ?? 'unknown', openedAt: info?.openedAt ?? null, mergedAt, closedAt: info?.closedAt ?? null,
    reviewNote: info?.reviewNote ?? null, source: pr.source, checkedAt: info?.checkedAt ?? null,
  };
}

/**
 * coding → PR open → in review → merged → archived (builder decision 4). A known outcome places a unit even once it is
 * archived (the orchestrator archives each unit when it ends): merged under merged, closed or failed in its PR stage.
 * Archived is only for archived units with no known outcome.
 */
export function deriveStage({ archivedAt = null, outcome = null, pr = null, monitorEver = false }) {
  const merged = outcome === 'merged' || pr?.state === 'merged';
  const closedWithoutMerge = !merged && (outcome === 'closed' || outcome === 'failed' || pr?.state === 'closed');
  let stage;
  if (merged) stage = 'merged';
  else if (archivedAt !== null && archivedAt !== undefined && !closedWithoutMerge) stage = 'archived';
  else if (!pr) stage = 'coding';
  else if (pr.state === 'open' || (pr.state === 'unknown' && monitorEver)) stage = 'in_review';
  else stage = 'pr_open';
  return { stage, merged, closedWithoutMerge };
}

/** Monitor state from the unit's automation rows and its wake and schedule history (builder decision 8). */
export function deriveMonitor({ stage, hasPr, closedWithoutMerge = false, automations = [], wakes = [], saves = [], prKnownAt = null, now, thresholds }) {
  const lastWake = wakes.length ? wakes[wakes.length - 1] : null;
  const row = [...automations].sort((a, b) => (b.nextRunAt ?? 0) - (a.nextRunAt ?? 0))[0] ?? null;
  const lastSave = saves.length ? saves[saves.length - 1] : null;
  const everyMinutes = row?.everyMinutes ?? (lastSave && !lastSave.clear ? lastSave.everyMinutes : null);
  const lastCheckAt = maxTime(row?.lastRunAt ?? null, lastWake);
  const view = (state, extra = {}) => ({ state, lastCheckAt, nextCheckAt: row?.nextRunAt ?? null, everyMinutes, since: null, ...extra });
  if (stage === 'merged' || stage === 'archived' || closedWithoutMerge) return view(hasPr ? 'ended' : 'none', { nextCheckAt: null });
  if (row && row.pausedAt !== null && row.pausedAt !== undefined) return view('paused', { since: row.pausedAt });
  if (row) {
    if (row.nextRunAt !== null && row.nextRunAt !== undefined && row.nextRunAt < now - thresholds.monitorGraceMs) return view('missing', { since: row.nextRunAt });
    return view('alive');
  }
  if (stage !== 'pr_open' && stage !== 'in_review') return view('none');
  const expected = (everyMinutes ?? 10) * MINUTE;
  // No wake, no cleared schedule and no time for the PR: the start is not known, so `since` stays null.
  const since = lastWake !== null ? lastWake + expected : lastSave?.clear ? lastSave.at : prKnownAt;
  return view('missing', { since: since === null ? null : Math.min(since, now) });
}
