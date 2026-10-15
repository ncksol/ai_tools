import { MINUTE, maxTime } from '../time.mjs';
import { ADO_REPO, GITHUB_REPO } from './pr-lookup.mjs';

/** The unit's code host: `workspace.yaml` host_type and repository, else the project's GitHub columns. */
export function hostOf(workspaceFile, project) {
  const repository = workspaceFile?.repository ?? null;
  if (workspaceFile?.hostType === 'ado') return { provider: 'ado', repo: repository && ADO_REPO.test(repository) ? repository : null };
  if (workspaceFile?.hostType === 'github') return { provider: 'github', repo: repository && GITHUB_REPO.test(repository) ? repository : null };
  if (project?.githubOwner && project?.githubRepo) return { provider: 'github', repo: `${project.githubOwner}/${project.githubRepo}` };
  return { provider: project ? 'ado' : null, repo: null };
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
  if (registry?.prProvider && registry.prId) {
    return { provider: registry.prProvider, id: registry.prId, repo: registry.prRepo ?? repoFor(registry.prProvider), url: registry.prUrl ?? null, source: 'registry', knownAt: null };
  }
  const line = statusLines.find(item => item.pr);
  if (line) {
    const same = statusLines.filter(item => item.pr && item.pr.provider === line.pr.provider && item.pr.id === line.pr.id);
    return { provider: line.pr.provider, id: line.pr.id, repo: repoFor(line.pr.provider), url: null, source: 'status_line', knownAt: Math.min(...same.map(item => item.at)) };
  }
  if (createdPr?.number) {
    return { provider: 'github', id: createdPr.number, repo: createdPr.repo ?? repoFor('github'), url: createdPr.url ?? null, source: 'app', knownAt: null };
  }
  const best = bestMention(mentions, host);
  return best ? { ...best, url: null, source: 'heuristic' } : null;
}

export function prView(pr, info, createdPr) {
  let state = info && info.state !== 'unknown' ? info.state : null;
  let mergedAt = info?.mergedAt ?? null;
  if (!state && pr.source === 'app' && createdPr) {
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

/** coding → PR open → in review → merged → archived (builder decision 4). */
export function deriveStage({ archivedAt = null, outcome = null, pr = null, monitorEver = false }) {
  const merged = outcome === 'merged' || pr?.state === 'merged';
  const closedWithoutMerge = !merged && (outcome === 'closed' || outcome === 'failed' || pr?.state === 'closed');
  let stage;
  if (archivedAt !== null && archivedAt !== undefined) stage = 'archived';
  else if (merged) stage = 'merged';
  else if (!pr) stage = 'coding';
  else if (pr.state === 'open' || (pr.state === 'unknown' && monitorEver)) stage = 'in_review';
  else stage = 'pr_open';
  return { stage, merged, closedWithoutMerge };
}

/** Monitor state from the unit's automation rows and its wake and schedule history (builder decision 8). */
export function deriveMonitor({ stage, hasPr, automations = [], wakes = [], saves = [], prKnownAt = null, now, thresholds }) {
  const lastWake = wakes.length ? wakes[wakes.length - 1] : null;
  const row = [...automations].sort((a, b) => (b.nextRunAt ?? 0) - (a.nextRunAt ?? 0))[0] ?? null;
  const lastSave = saves.length ? saves[saves.length - 1] : null;
  const everyMinutes = row?.everyMinutes ?? (lastSave && !lastSave.clear ? lastSave.everyMinutes : null);
  const lastCheckAt = maxTime(row?.lastRunAt ?? null, lastWake);
  const view = (state, extra = {}) => ({ state, lastCheckAt, nextCheckAt: row?.nextRunAt ?? null, everyMinutes, since: null, ...extra });
  if (stage === 'merged' || stage === 'archived') return view(hasPr ? 'ended' : 'none', { nextCheckAt: null });
  if (row && row.pausedAt !== null && row.pausedAt !== undefined) return view('paused', { since: row.pausedAt });
  if (row) {
    if (row.nextRunAt !== null && row.nextRunAt !== undefined && row.nextRunAt < now - thresholds.monitorGraceMs) return view('missing', { since: row.nextRunAt });
    return view('alive');
  }
  if (stage !== 'pr_open' && stage !== 'in_review') return view('none');
  const expected = (everyMinutes ?? 10) * MINUTE;
  const since = lastWake !== null ? lastWake + expected : lastSave?.clear ? lastSave.at : prKnownAt ?? now;
  return view('missing', { since: Math.min(since, now) });
}
