/** Data derivations for the views: no HTML and no DOM. Words and orders follow the approved mockup. */
export const STATUS_ORDER = Object.freeze({ stuck: 0, question: 1, plan: 2, blocked: 3, busy: 4, idle: 5, merged: 6, archived: 7 });
export const UNIT_STAGES = Object.freeze(['coding', 'pr_open', 'in_review', 'merged', 'archived']);
export const BOARD_STAGES = Object.freeze(['planned', ...UNIT_STAGES]);
export const STAGE_NAMES = Object.freeze({ planned: 'Planned', coding: 'Coding', pr_open: 'PR open', in_review: 'In review', merged: 'Merged', archived: 'Archived' });
export const STAGE_CLASS = Object.freeze({ planned: 'planned', coding: 'coding', pr_open: 'pr', in_review: 'review', merged: 'merged', archived: 'archived' });
export const REPORT_LABELS = Object.freeze({ complete: 'complete', progress: 'progress', needs_input: 'needs input', blocked: 'blocked' });
export const REPORT_CLASS = Object.freeze({ complete: 'complete', progress: 'progress', needs_input: 'needs', blocked: 'blocked' });
export const NEED_LABELS = Object.freeze({ stalled: 'Swarm stalled', question: 'Question', plan: 'Plan to approve', pr: 'PR to approve' });
export const NEED_CLASS = Object.freeze({ stalled: 'stuck', question: 'question', plan: 'plan', pr: 'pr' });
/** Header tiles: the count bucket and the state colour of its dot. */
export const COUNT_TILES = Object.freeze([['working', 'busy'], ['stuck', 'stuck'], ['waiting', 'plan'], ['idle', 'idle'], ['done', 'merged'], ['failed', 'blocked']]);

/** Card and detail state lines by statusDetail, falling back to status. {t}: time in this state. {a}: age of the change. */
export const STATE_LINES = Object.freeze({
  busy: 'Busy · {t}',
  slow_model_call: 'Slow model call · {t}',
  silent: 'Stuck · no events {t}',
  stuck_tool: 'Stuck · no events {t}',
  stuck_model_call: 'Stuck · no model reply {t}',
  stuck_subagent: 'Stuck · sub-agent silent {t}',
  spinning: 'Spinning · {t}',
  stalled: 'Stalled · {t}',
  stuck: 'Stuck · no events {t}',
  waiting_question: 'Waiting on question · {t}',
  question: 'Waiting on question · {t}',
  waiting_plan: 'Waiting on plan · {t}',
  plan: 'Waiting on plan · {t}',
  blocked: 'Blocked · {t}',
  blocked_on_orchestrator: 'Blocked on orchestrator · {t}',
  crashed: 'Crashed · {a}',
  failed: 'Failed · {a}',
  idle: 'Idle · {t}',
  stopped: 'Stopped · {a}',
  merged: 'Merged · {a}',
  archived: 'Archived · {a}',
});
/** Shorter words from the mockup, by status: timeline summary column, plan nodes, board cards. */
export const TIMELINE_WORDS = Object.freeze({ stuck: 'stuck {t}', plan: 'waiting on plan {t}', question: 'question {t}', blocked: 'blocked {t}', idle: 'idle {t}', merged: 'merged', archived: 'archived' });
export const PLAN_WORDS = Object.freeze({ busy: 'busy', idle: 'idle', plan: 'plan waiting', question: 'question', stuck: 'stuck {t}', blocked: 'blocked' });
export const BOARD_WORDS = Object.freeze({ busy: 'busy', idle: 'idle {t}', plan: 'plan waiting {t}', question: 'question {t}', stuck: 'stuck {t}', blocked: 'blocked', merged: 'merged {a}', archived: 'archived {a}' });

/**
 * When a unit's work ended (null while it runs). The contract's endedAt already uses the outcome time; the PR fallback
 * covers engines built before that rule and goes once PR 1's engine is in (Task 20).
 */
export function unitEnd(session) {
  if (session.endedAt != null) return session.endedAt;
  if (!session.outcome) return null;
  return session.pr?.mergedAt ?? session.pr?.closedAt ?? null;
}

/** Its PR closed without merging and it is not archived: it stays in its PR stage, with a badge (approved decision 5). */
export const closedNotMerged = unit => Boolean(unit.closedWithoutMerge && unit.pr && unit.stage !== 'archived' && (unit.pr.state === 'closed' || unit.outcome === 'closed'));

export const stateLine = session => STATE_LINES[session.statusDetail] ?? STATE_LINES[session.status] ?? '{t}';

/** Units shown as cards: attention first, then creation order; archived units leave the Cards tab. */
export function cardUnits(snapshot) {
  return snapshot.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.status !== 'archived')
    .sort((a, b) => STATUS_ORDER[a.unit.status] - STATUS_ORDER[b.unit.status] || a.index - b.index)
    .map(({ unit }) => unit);
}
export const archivedUnits = snapshot => snapshot.units.filter(unit => unit.status === 'archived');
export const findUnit = (snapshot, id) => snapshot.units.find(unit => unit.id === id) ?? null;
const sameLabel = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const findByLabel = (snapshot, label) => snapshot.units.find(unit => sameLabel(unit.label, label)) ?? null;
export const findPlanned = (snapshot, label) => snapshot.planned.find(entry => sameLabel(entry.label, label)) ?? null;

export function progressPercent(session) {
  const progress = session.progress;
  return progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
}
export const sharePercent = (value, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0);

/** Needs you items: a stalled swarm first, then the engine's items, which come longest wait first. */
export function needItems(snapshot) {
  const items = snapshot.needs.map(need => ({ id: need.id, kind: need.kind, text: need.text, since: need.since, from: needFrom(snapshot, need), verb: 'waiting' }));
  const stalled = snapshot.run.stalled;
  if (stalled) items.unshift({ id: `stalled:${stalled.since}`, kind: 'stalled', text: stalled.reason, since: stalled.since, from: snapshot.run.name, verb: 'stalled' });
  return items;
}
function needFrom(snapshot, need) {
  if (!need.unitIds.length) return snapshot.run.name;
  return need.unitIds.map((id, index) => {
    const session = findUnit(snapshot, id) ?? (snapshot.orchestrator.id === id ? snapshot.orchestrator : null);
    return session ? `${session.label} ${session.name}` : need.labels[index] ?? id;
  }).join(', ');
}

/** Units and planned entries as a forest of stacked branches. A cycle or an unknown parent makes a node a root. */
export function planForest(snapshot) {
  const nodes = [
    ...snapshot.units.map(unit => ({ key: unit.label.toLowerCase(), label: unit.label, name: unit.name, stage: unit.stage, status: unit.status, dependsOn: unit.dependsOn, unit, planned: null, children: [] })),
    ...snapshot.planned.map(entry => ({ key: entry.label.toLowerCase(), label: entry.label, name: entry.name, stage: 'planned', status: 'planned', dependsOn: entry.dependsOn, unit: null, planned: entry, children: [] })),
  ];
  const byKey = new Map();
  for (const node of nodes) if (!byKey.has(node.key)) byKey.set(node.key, node);
  const parentOf = new Map();
  for (const node of nodes) {
    const parent = node.dependsOn ? byKey.get(node.dependsOn.toLowerCase()) : undefined;
    parentOf.set(node, parent && parent !== node ? parent : null);
  }
  for (const node of nodes) {
    const seen = new Set([node]);
    for (let parent = parentOf.get(node); parent; parent = parentOf.get(parent)) {
      if (parent === node) {
        parentOf.set(node, null);
        break;
      }
      if (seen.has(parent)) break;
      seen.add(parent);
    }
  }
  const roots = [];
  for (const node of nodes) {
    const parent = parentOf.get(node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Grid positions: depth is the column; leaves take rows in order and a parent sits at its children's mean row. */
export function planLayout(roots) {
  const pos = new Map();
  let leaf = 0;
  let maxDepth = 0;
  const walk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children) walk(child, depth + 1);
    const row = node.children.length ? node.children.reduce((sum, child) => sum + pos.get(child).row, 0) / node.children.length : leaf++;
    pos.set(node, { depth, row });
  };
  for (const root of roots) walk(root, 0);
  return { pos, rows: leaf, maxDepth };
}

/** Depth-first rows for the indented plan list. */
export function flattenPlan(roots) {
  const rows = [];
  const walk = (node, depth) => {
    rows.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

export function boardColumns(snapshot) {
  const nodes = [
    ...snapshot.units.map(unit => ({ stage: unit.stage, status: unit.status, unit, planned: null })),
    ...snapshot.planned.map(entry => ({ stage: 'planned', status: 'planned', unit: null, planned: entry })),
  ];
  return BOARD_STAGES.map(stage => ({
    stage,
    nodes: nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.stage === stage)
      .sort((a, b) => (STATUS_ORDER[a.node.status] ?? 9) - (STATUS_ORDER[b.node.status] ?? 9) || a.index - b.index)
      .map(({ node }) => node),
  }));
}
