/** Data derivations for the views: no HTML and no DOM. Words and orders follow the approved mockup. */
import { plainText } from './format.mjs';

export const STATUS_ORDER = Object.freeze({ stuck: 0, question: 1, plan: 2, blocked: 3, busy: 4, idle: 5, merged: 6, done: 6, archived: 7 });
export const UNIT_STAGES = Object.freeze(['coding', 'pr_open', 'in_review', 'merged', 'archived']);
export const BOARD_STAGES = Object.freeze(['planned', ...UNIT_STAGES, 'subagent']);
export const STAGE_NAMES = Object.freeze({ planned: 'Planned', coding: 'Coding', pr_open: 'PR open', in_review: 'In review', merged: 'Merged', archived: 'Archived', subagent: 'Sub-agent' });
/** Board column headers: a stage name, but the column of sub-agents is plural. */
export const COLUMN_NAMES = Object.freeze({ ...STAGE_NAMES, subagent: 'Sub-agents' });
export const STAGE_CLASS = Object.freeze({ planned: 'planned', coding: 'coding', pr_open: 'pr', in_review: 'review', merged: 'merged', archived: 'archived', subagent: 'subagent' });
export const REPORT_LABELS = Object.freeze({ complete: 'complete', progress: 'progress', needs_input: 'needs input', blocked: 'blocked', replied_question: 'question', replied_blocker: 'blocker' });
export const REPORT_CLASS = Object.freeze({ complete: 'complete', progress: 'progress', needs_input: 'needs', blocked: 'blocked', replied_question: 'replied', replied_blocker: 'replied' });
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
  completed: 'Done · {a}',
  cancelled: 'Cancelled · {a}',
});
/** Shorter words from the mockup, by status: timeline summary column, plan nodes, board cards. */
export const TIMELINE_WORDS = Object.freeze({ stuck: 'stuck {t}', plan: 'waiting on plan {t}', question: 'question {t}', blocked: 'blocked {t}', idle: 'idle {t}', merged: 'merged', done: 'done', archived: 'archived' });
export const PLAN_WORDS = Object.freeze({ busy: 'busy', idle: 'idle', plan: 'plan waiting', question: 'question', stuck: 'stuck {t}', blocked: 'blocked' });
export const BOARD_WORDS = Object.freeze({ busy: 'busy', idle: 'idle {t}', plan: 'plan waiting {t}', question: 'question {t}', stuck: 'stuck {t}', blocked: 'blocked', merged: 'merged {a}', done: 'done {a}', archived: 'archived {a}' });
/** Board words for finished sub-agents, by statusDetail; other states use BOARD_WORDS. */
export const SUBAGENT_BOARD_WORDS = Object.freeze({ completed: 'done {a}', failed: 'failed {a}', cancelled: 'cancelled {a}', crashed: 'crashed {a}' });
export const MODE_WORDS = Object.freeze({ background: 'Background', sync: 'Sync' });

/** One of the orchestrator's one-off sub-agents, listed as a unit. */
export const isSubagent = unit => unit.kind === 'subagent';
/** Finished sub-agents the snapshot leaves out (it lists the 20 most recent). */
export const omittedSubagents = snapshot => (snapshot.omittedSubagents?.done ?? 0) + (snapshot.omittedSubagents?.failed ?? 0);

/** When a finished run ended (null while it is live). */
export const runEnd = snapshot => (snapshot.run.lifecycle === 'finished' ? snapshot.run.finishedAt ?? snapshot.run.lastActivityAt : null);
/**
 * Where the run's clock stops: the end of a finished run, or the last activity of a live run with nothing active (the
 * engine's quietSince). Null while anything in the run is active, so the clock ticks.
 */
export const runClockEnd = snapshot => runEnd(snapshot) ?? snapshot.run.quietSince ?? null;
/**
 * When a session's work ended (null while it runs): the engine sets endedAt from the unit's outcome time. A session ends
 * at its own end, or at the run's end once the run has finished.
 */
export const unitEnd = (session, snapshot = null) => session.endedAt ?? (snapshot ? runEnd(snapshot) : null);
/** Where a session's runtime stops: its own end, else where the run's clock stops (null while it ticks). */
export const unitClockEnd = (session, snapshot) => session.endedAt ?? runClockEnd(snapshot);
/** A report title without a leading "Status: <status>" that only repeats the status badge shown beside it. */
export function withoutStatusPrefix(text, status) {
  const words = String(status ?? '').split(/[\s_-]+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return text;
  return text.replace(new RegExp(String.raw`^\s*status\s*:\s*${words.join(String.raw`[\s_-]+`)}(?![\w-])\s*[.:;,!—–-]*\s*`, 'i'), '');
}

/** A report's title as plain text, or a placeholder when it is blank. */
export const reportTitle = report => withoutStatusPrefix(plainText(report.title), report.status).trim() || 'Untitled report';

/**
 * How a report's badge reads. Once the parent has replied, a question or a blocker no longer waits on anyone, so its
 * badge turns neutral and never contradicts the unit's state. Every other report reads as its status.
 */
export function reportKind(report) {
  if (typeof report.repliedAt !== 'number') return report.status;
  if (report.status === 'needs_input') return 'replied_question';
  if (report.status === 'blocked') return 'replied_blocker';
  return report.status;
}

/** One activity item's text as plain text, without the engine's repetitions. */
export function feedText(item) {
  const match = item.kind === 'report' ? item.text.match(/^(reported ([^:]+): )([\s\S]*)$/) : null;
  if (match) {
    const rest = withoutStatusPrefix(plainText(match[3]), match[2]).trim();
    return rest ? `${match[1]}${rest}` : match[1].replace(/: $/, '');
  }
  const text = plainText(item.text);
  // A sub-agent whose name equals its type would read "explore explore finished".
  const once = item.kind === 'subagent-done' ? text.replace(/^(\S+) \1(?= )/, '$1') : text;
  // A sub-agent unit's item already starts with its label: "started explore: map-import-module" names it twice.
  const ending = `: ${item.label}`;
  return item.kind.startsWith('subagent-') && item.label && once.endsWith(ending) ? once.slice(0, -ending.length) : once;
}

/** Its PR closed without merging: it stays in its PR stage, with a badge (approved decision 5), archived or not. */
export const closedNotMerged = unit => Boolean(unit.closedWithoutMerge && unit.pr && unit.stage !== 'archived' && (unit.pr.state === 'closed' || unit.outcome === 'closed'));

export const stateLine = session => STATE_LINES[session.statusDetail] ?? STATE_LINES[session.status] ?? '{t}';

/** How long a finished sub-agent keeps its card on the Cards tab. */
export const SUBAGENT_CARD_GRACE_MS = 10 * 60 * 1000;
/** The last part of the grace period, in which the card fades out. */
export const CARD_FADE_MS = 1200;
/** A sub-agent unit that is no longer running or stuck: done, failed, cancelled or crashed. */
export const isFinishedSubagent = unit => isSubagent(unit) && unit.status !== 'busy' && unit.status !== 'stuck';
/** Milliseconds a finished sub-agent's card has left (0 or less once it has left); null for every other unit. */
export function cardTimeLeft(unit, now) {
  if (!isFinishedSubagent(unit)) return null;
  const end = unit.endedAt ?? unit.since ?? unit.lastEventAt;
  return end == null ? 0 : end + SUBAGENT_CARD_GRACE_MS - now;
}
/** Milliseconds until the Cards tab next changes by itself: a card starts to fade, or leaves. Null when nothing is due. */
export function nextCardChange(snapshot, now) {
  let next = null;
  for (const unit of snapshot.units) {
    const left = cardTimeLeft(unit, now);
    if (left === null || left <= 0) continue;
    const wait = left > CARD_FADE_MS ? left - CARD_FADE_MS : left;
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}

/** The unit is archived. Its status and stage show its outcome when one is known (merged, failed), so they cannot tell. */
export const isArchived = unit => (unit.archivedAt !== null && unit.archivedAt !== undefined) || unit.status === 'archived';

/**
 * Units shown as cards at `now`: attention first, then creation order. Archived units leave the Cards tab. Sub-agent
 * units stay on it while they run or are stuck, and a finished one for SUBAGENT_CARD_GRACE_MS after it ended; the Board
 * shows them all.
 */
export function cardUnits(snapshot, now) {
  return snapshot.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => !isArchived(unit) && (!isFinishedSubagent(unit) || cardTimeLeft(unit, now) > 0))
    .sort((a, b) => (STATUS_ORDER[a.unit.status] ?? 9) - (STATUS_ORDER[b.unit.status] ?? 9) || a.index - b.index)
    .map(({ unit }) => unit);
}
export const archivedUnits = snapshot => snapshot.units.filter(isArchived);
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

/**
 * Session units and planned entries as a forest of stacked branches. A cycle or an unknown parent makes a node a root.
 * Sub-agent units are left out: they have no todo or branch to stack on, so they would only add lone nodes.
 */
export function planForest(snapshot) {
  const nodes = [
    ...snapshot.units.filter(unit => !isSubagent(unit)).map(unit => ({ key: unit.label.toLowerCase(), label: unit.label, name: unit.name, stage: unit.stage, status: unit.status, dependsOn: unit.dependsOn, unit, planned: null, children: [] })),
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
