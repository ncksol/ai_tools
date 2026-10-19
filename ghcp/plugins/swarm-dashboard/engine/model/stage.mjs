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

/** Most-mentioned PR in the unit's reports, for Azure DevOps hosts only (design section 12). */
function bestMention(mentions, host) {
  if (host?.provider !== 'ado') return null;
  const totals = new Map();
  for (const mention of mentions.values()) {
    if (mention.provider !== 'ado' && mention.provider !== null) continue;
    const total = totals.get(mention.id) ?? { id: mention.id, count: 0, firstAt: mention.firstAt, lastAt: mention.lastAt };
    total.count += mention.count;
    total.firstAt = Math.min(total.firstAt, mention.firstAt);
    total.lastAt = Math.max(total.lastAt, mention.lastAt);
    totals.set(mention.id, total);
  }
  let best = null;
  for (const total of totals.values()) {
    if (!best || total.count > best.count || (total.count === best.count && total.lastAt > best.lastAt)) best = total;
  }
  return best ? { provider: 'ado', id: best.id, repo: host.repo, knownAt: best.firstAt } : null;
}

/** PR identity: registry row, latest contract status line, the app's PR columns, then the most-mentioned PR. */
export function resolvePr({ registry = null, statusLines = [], createdPr = null, mentions = new Map(), host = null } = {}) {
  const repoFor = provider => (host?.provider === provider ? host.repo : null);
  // When the unit first reported this PR on a status line, or null.
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
  const best = bestMention(mentions, host);
  return best ? { ...best, url: null, source: 'heuristic' } : null;
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
 * coding → PR open → in review → merged → archived (builder decision 4). A merged unit stays under merged once archived:
 * the orchestrator archives each unit after its PR merges. Archived is for units with no better-known stage.
 */
export function deriveStage({ archivedAt = null, outcome = null, pr = null, monitorEver = false }) {
  const merged = outcome === 'merged' || pr?.state === 'merged';
  const closedWithoutMerge = !merged && (outcome === 'closed' || outcome === 'failed' || pr?.state === 'closed');
  let stage;
  if (merged) stage = 'merged';
  else if (archivedAt !== null && archivedAt !== undefined) stage = 'archived';
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
