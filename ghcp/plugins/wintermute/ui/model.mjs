/** Data derivations for the views: no HTML and no DOM. Words and orders follow the approved mockup. */
import { plainText } from './format.mjs';
import { closedNotMerged, isArchived, isDone, isFinished } from '../shared/unit-state.mjs';

export { closedNotMerged, isArchived, isDone, isFinished };

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

export const stateLine = session => STATE_LINES[session.statusDetail] ?? STATE_LINES[session.status] ?? '{t}';

/**
 * The state in words on a card and in the header: a stuck line names its cause ("tool call", "silent"), and a sub-agent's
 * own card says "silent" rather than "sub-agent silent". Other states use STATE_LINES, as the detail panel does.
 */
export function stateWords(session) {
  if (session.statusDetail === 'stuck_tool') return 'Stuck · tool call {t}';
  if (session.statusDetail === 'silent' || (session.statusDetail === 'stuck_subagent' && isSubagent(session))) return 'Stuck · silent {t}';
  return stateLine(session);
}

/** Details in which a session is working right now, so its now line says what it is doing. */
export const LIVE_DETAILS = Object.freeze(new Set(['busy', 'slow_model_call', 'silent', 'stuck_tool', 'stuck_model_call', 'stuck_subagent', 'spinning']));

/** Ids of the sessions with an open question or plan of their own: the ones that asked a Needs you item. */
export const askingIds = snapshot => new Set(snapshot.needs.map(need => need.fromId).filter(Boolean));

/** When a finished unit finished: its end, else its complete report under the done rule, else the start of its state. */
export const finishedAt = unit => unit.endedAt ?? (unit.statusDetail === 'idle' && isDone(unit) ? unit.report.at : unit.since);

/** How long a question or plan has waited, for the oldest-first order inside those states; 0 for other states. */
const waitStart = unit => (unit.status === 'question' || unit.status === 'plan' ? unit.since : 0);

/**
 * The Cards tab's two zones. Archived units leave the tab. Active: every other unit that has not finished, stuck first,
 * then question, plan, blocked, busy and idle; question and plan oldest wait first; then creation order. Finished: the
 * rest, latest finish first.
 */
export function cardZones(snapshot) {
  const asking = askingIds(snapshot);
  const shown = snapshot.units.map((unit, index) => ({ unit, index })).filter(({ unit }) => !isArchived(unit));
  const active = shown
    .filter(({ unit }) => !isFinished(unit, asking))
    .sort((a, b) => (STATUS_ORDER[a.unit.status] ?? 9) - (STATUS_ORDER[b.unit.status] ?? 9) || waitStart(a.unit) - waitStart(b.unit) || a.index - b.index)
    .map(({ unit }) => unit);
  const finished = shown
    .filter(({ unit }) => isFinished(unit, asking))
    .sort((a, b) => finishedAt(b.unit) - finishedAt(a.unit) || a.index - b.index)
    .map(({ unit }) => unit);
  return { active, finished };
}

const FINISHED_WORDS = Object.freeze({
  stopped: ['stopped {a}', 'off'], merged: ['merged {a}', 'ok'], completed: ['done {a}', 'ok'],
  failed: ['failed {a}', 'bad'], crashed: ['crashed {a}', 'bad'], cancelled: ['cancelled {a}', 'off'],
});
/**
 * A finished unit's outcome in words ({a}: its age) and its tone: ok (green) for merged or done, bad (red) for failed or
 * crashed, off (grey) for stopped, cancelled or closed. "closed, not merged" only for a unit that had a PR.
 */
export function finishedOutcome(unit) {
  if (closedNotMerged(unit)) return { words: unit.pr ? 'closed, not merged {a}' : 'closed {a}', tone: 'off', at: finishedAt(unit) };
  const [words, tone] = FINISHED_WORDS[unit.statusDetail] ?? (unit.status === 'merged' ? FINISHED_WORDS.merged : FINISHED_WORDS.completed);
  return { words, tone, at: finishedAt(unit) };
}

/**
 * The Needs you item a session asked itself: one that matches its waiting state (a question or a PR approval while it
 * waits on a question, a plan while it waits on a plan), else any of its own; the newest when there are several.
 */
export function ownNeed(snapshot, session) {
  const own = snapshot.needs.filter(need => need.fromId === session.id);
  const kinds = session.status === 'plan' ? ['plan'] : session.status === 'question' ? ['question', 'pr'] : [];
  return [...own].reverse().find(need => kinds.includes(need.kind)) ?? own[own.length - 1] ?? null;
}

/**
 * What a working session is doing. `at` is set when the text is a report, whose age then follows it; `muted` marks the
 * fallback. The engine's `todo`, `toolDesc` and `busySince` may be missing on older snapshots, which reads as null.
 */
export function doing(session) {
  const tool = session.activity?.tool ?? null;
  const toolText = tool ? (session.toolDesc ? plainText(session.toolDesc) : `Running ${tool.summary}`) : null;
  if (session.statusDetail === 'stuck_tool' && toolText) return { text: toolText };
  if (session.todo) return { text: plainText(session.todo) };
  if (tool?.name === 'task') return { text: session.activity.label };
  if (toolText) return { text: toolText };
  const label = session.activity?.label;
  if (label && label !== 'Thinking') return { text: label };
  // Between tool calls, a report sent during this busy period says more than "Thinking". busySince is the engine's start
  // of that period. since, the start of the current state, comes later in a stall; it is the fallback only when busySince
  // is null or missing.
  if (session.report && session.report.at >= (session.busySince ?? session.since)) return { text: reportTitle(session.report), at: session.report.at };
  return { text: 'Thinking', muted: true };
}

/** A card's now line: { text, at?, muted? }. The first rule that applies wins (issue #103, section 3). */
export function nowLine(unit, snapshot) {
  const own = ownNeed(snapshot, unit);
  if ((unit.status === 'question' || unit.status === 'plan') && own) return { text: plainText(own.text) };
  // A higher rule (the orchestrator marked it failed) can hide its open question from its state; the card still shows it.
  if (own) return { text: `Asks you: ${plainText(own.text)}` };
  if (LIVE_DETAILS.has(unit.statusDetail)) return doing(unit);
  if (unit.report) return { text: reportTitle(unit.report), at: unit.report.at };
  return { text: 'No report yet', muted: true };
}

/** A Needs you item that names this unit, when the unit is not the one asking. Its short label is for narrow footers. */
export function needMark(unit, snapshot) {
  const need = snapshot.needs.find(item => item.unitIds.includes(unit.id) && item.fromId !== unit.id);
  if (!need) return null;
  return { need, label: NEED_LABELS[need.kind] ?? 'Needs you', short: need.kind === 'question' ? 'Question' : 'Approve' };
}

/** Running and stuck sub-agents for the footer chips, stuck first. */
export const activeSubagents = session => session.subagents
  .filter(sub => sub.status === 'running' || sub.status === 'stuck')
  .sort((a, b) => Number(b.status === 'stuck') - Number(a.status === 'stuck'));

/** The PR and its state in words: "PR #418 · in review", "draft", "merged" or "closed"; the number alone when unknown. */
export function prWords(pr) {
  const word = { open: 'in review', draft: 'draft', merged: 'merged', closed: 'closed' }[pr.state];
  return word ? `PR #${pr.id} · ${word}` : `PR #${pr.id}`;
}

const capital = word => word.charAt(0).toUpperCase() + word.slice(1);
/** A short model name: "claude-opus-5.5" is "Opus 5.5", "gpt-6.1-sol" "GPT-6.1 Sol", "gemini-4-argon" "Gemini 4 Argon". */
export function shortModel(id) {
  if (!id) return null;
  const parts = String(id).replace(/^claude-/, '').split('-').filter(Boolean);
  if (parts[0] === 'gpt') return [`GPT-${parts[1] ?? ''}`.replace(/-$/, ''), ...parts.slice(2).map(capital)].join(' ');
  return parts.map(part => (/^\d/.test(part) ? part : capital(part))).join(' ');
}
/** The reasoning effort a unit runs with: its own, else its agent's (a sub-agent unit). */
export const effortOf = unit => unit.effort ?? unit.agent?.effort ?? null;

/**
 * Fold a card footer's left side until it fits, in the agreed order: the progress count hides; sub-agent chips fold from
 * the end into "+N", keeping the first; then all of them into one count chip; then the Needs you marker shortens; last,
 * the count chip hides. The marker, the model and the cost never hide. `ui` measures and changes one footer: over() says
 * whether it still overflows, progress, chips and need say what it holds, and each other method applies one step.
 * Returns the steps applied, in order.
 */
export function foldFooter(ui) {
  const steps = [];
  const step = (name, apply) => {
    apply();
    steps.push(name);
  };
  if (!ui.over()) return steps;
  if (ui.progress) step('progress', () => ui.hideProgress());
  let counted = false;
  if (ui.chips > 0 && ui.over()) {
    for (let shown = ui.chips - 1; shown >= 1 && ui.over(); shown -= 1) step(`+${ui.chips - shown}`, () => ui.showChips(shown));
    if (ui.over()) {
      step('count', () => ui.countChips());
      counted = true;
    }
  }
  if (ui.need && ui.over()) step('need', () => ui.shortenNeed());
  if (counted && ui.over()) step('no count', () => ui.hideCount());
  return steps;
}

/** What waits on you: the Needs you items plus a swarm stall, and when the oldest of them started. */
export function waitingOnYou(snapshot) {
  const since = snapshot.needs.map(need => need.since);
  if (snapshot.run.stalled) since.push(snapshot.run.stalled.since);
  return { count: since.length, oldest: since.length ? Math.min(...since) : null };
}

/**
 * Header tiles that follow the grid: active units by state, everything that waits on you, and the Finished section.
 * Units waiting on a question or plan count only under "waiting on you"; a unit can count there and in its state tile.
 */
export function countTiles(snapshot) {
  const { active, finished } = cardZones(snapshot);
  const by = status => active.filter(unit => unit.status === status).length;
  return [
    { key: 'working', state: 'busy', count: by('busy') },
    { key: 'stuck', state: 'stuck', count: by('stuck') },
    { key: 'waiting on you', state: 'question', count: waitingOnYou(snapshot).count },
    { key: 'blocked', state: 'blocked', count: by('blocked') },
    { key: 'idle', state: 'idle', count: by('idle') },
    { key: 'finished', state: 'merged', count: finished.length },
  ];
}

const counted = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/**
 * The orchestrator's state for the header: status and detail for its mark, the state in words with the time it counts
 * from, and a now line. A finished or stalled run says so instead of the orchestrator's own state; an idle orchestrator
 * says what it waits for, counted from the active units.
 */
export function orchestratorView(snapshot) {
  const { run, orchestrator } = snapshot;
  if (run.lifecycle === 'finished') {
    return { status: 'done', detail: 'completed', words: 'Swarm finished · {a}', at: run.finishedAt ?? run.lastActivityAt, text: 'Nothing left to run.', muted: true };
  }
  if (run.stalled) return { status: 'stuck', detail: 'stalled', words: 'Swarm stalled · {t}', at: run.stalled.since, text: plainText(run.stalled.reason) };
  const state = { status: orchestrator.status, detail: orchestrator.statusDetail, words: stateWords(orchestrator), at: orchestrator.since };
  if (orchestrator.status === 'question' || orchestrator.status === 'plan') {
    const need = ownNeed(snapshot, orchestrator) ?? snapshot.needs.find(item => !item.unitIds.length);
    return { ...state, text: need ? plainText(need.text) : orchestrator.activity.label };
  }
  if (LIVE_DETAILS.has(orchestrator.statusDetail)) {
    const line = doing(orchestrator);
    return { ...state, text: line.text, muted: line.muted };
  }
  const { active } = cardZones(snapshot);
  const working = active.filter(unit => unit.status === 'busy' || unit.status === 'stuck');
  const sessions = working.filter(unit => !isSubagent(unit)).length;
  const subagents = working.length - sessions;
  const asking = active.filter(unit => unit.status === 'question' || unit.status === 'plan').length;
  const parts = [sessions && counted(sessions, 'session'), subagents && counted(subagents, 'sub-agent')].filter(Boolean);
  const waits = asking ? `${counted(asking, 'unit')} waiting on you` : '';
  if (parts.length) return { ...state, text: `Waiting for ${parts.join(' and ')} to report${waits ? `; ${waits}` : ''}` };
  return waits ? { ...state, text: waits } : { ...state, text: 'Nothing is running.', muted: true };
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
