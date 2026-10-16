import { CREDIT_USD, MAX_FINISHED_SUBAGENT_UNITS, NANO_AIU_PER_CREDIT, SCHEMA_VERSION } from '../schema.mjs';
import { clip, firstLine, oneLine } from '../text.mjs';
import { MINUTE, maxTime, minTime } from '../time.mjs';
import { UNIT_LABEL_RE, normaliseRegistry, parseQuestionTag, parseReportBody, parseStatusLine, purposeToStatus } from './contract.mjs';
import { descendants, resolveNodeId } from './forest.mjs';
import { setRunStats } from './run-stats.mjs';
import { mergeStates } from './session-state.mjs';
import { deriveMonitor, deriveStage, hostOf, prView, resolvePr } from './stage.mjs';
import { ACTIVE_DETAILS, displayOf, evaluateStatus, evaluateSubagentUnit, subagentLimitMs, swarmStalled, toolLimitMs, toolView } from './status.mjs';

const SEGMENT_GAP_MS = 2 * MINUTE;
const TASK_OVERRIDE_MS = 5 * MINUTE;
const FEED_LIMIT = 200;
const RECENT_LIMIT = 6;
const CODE_WORD = /^[A-Za-z]{1,4}\d[A-Za-z0-9.-]{0,8}$/;
const STARTABLE = new Set(['pr_open', 'in_review', 'merged', 'archived']);
const STATUS_WORDS = { complete: 'complete', progress: 'progress', needs_input: 'needs input', blocked: 'blocked' };

const credits = nanoAiu => Math.round((nanoAiu / NANO_AIU_PER_CREDIT) * 10) / 10;

export function initials(name) {
  return String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0].toUpperCase()).join('') || 'O';
}

/** First word with a letter-then-digit code that no sibling shares (b1, F2a), else initials of unique words, else U<n>. */
export function deriveLabels(names) {
  const words = names.map(name => String(name ?? '').split(/\s+/).filter(Boolean));
  const frequency = new Map();
  for (const list of words) for (const word of new Set(list.map(item => item.toLowerCase()))) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  return words.map((list, index) => {
    const unique = list.filter(word => frequency.get(word.toLowerCase()) === 1 || names.length === 1);
    const code = unique.find(word => CODE_WORD.test(word));
    if (code) return code;
    const letters = unique.slice(0, 2).map(word => word[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return letters || `U${index + 1}`;
  });
}

export function runLifecycle({ lastActivityAt, anyActive, now, thresholds }) {
  const finished = !anyActive && now - lastActivityAt >= thresholds.runFinishedAfterMs;
  return { lifecycle: finished ? 'finished' : 'live', finishedAt: finished ? lastActivityAt : null };
}

function mergeSpans(spans, gap) {
  const out = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** Non-overlapping timeline segments from start to end (or now, with an open last segment). */
export function buildSegments({ start, end = null, now, busy, waits, stuckFrom = null }) {
  const stop = end ?? now;
  if (!(stop > start)) return [];
  const clamp = value => Math.min(Math.max(value, start), stop);
  const merged = mergeSpans(busy, SEGMENT_GAP_MS);
  const points = new Set([start, stop]);
  for (const [s, e] of merged) {
    points.add(clamp(s));
    points.add(clamp(e));
  }
  for (const [s, e] of waits) {
    points.add(clamp(s));
    points.add(clamp(e));
  }
  if (stuckFrom !== null) points.add(clamp(stuckFrom));
  const sorted = [...points].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (e <= s) continue;
    const mid = s + (e - s) / 2;
    const wait = waits.find(([ws, we]) => ws <= mid && mid < we);
    const state = stuckFrom !== null && mid >= stuckFrom ? 'stuck' : wait ? wait[2] : merged.some(([bs, be]) => bs <= mid && mid < be) ? 'busy' : 'idle';
    const last = segments[segments.length - 1];
    if (last && last.state === state) last.end = e;
    else segments.push({ start: s, end: e, state });
  }
  if (end === null && segments.length) segments[segments.length - 1].end = null;
  return segments;
}

function reportFields(text) {
  const fields = parseReportBody(text);
  return {
    title: oneLine(fields.summary ?? firstLine(fields.freeText) ?? '', 160),
    summary: fields.summary, evidence: fields.evidence, blockers: fields.blockers,
    body: fields.freeText ? clip(fields.freeText, 4000) : null,
  };
}

/** A report from a message: contract status line, else the send's purpose, else a plain progress message. */
export function reportFromMessage(message, purpose, at) {
  const text = String(message ?? '');
  const line = parseStatusLine(text);
  const mapped = purposeToStatus(purpose);
  return {
    status: line?.status ?? mapped ?? 'progress',
    source: line ? 'contract' : mapped ? 'purpose' : 'message',
    at,
    ...reportFields(line ? text.split(/\r?\n/).slice(1).join('\n') : text),
    unit: line?.unit ?? null,
    commit: line?.commit ?? null,
  };
}

function reportFromTask(task) {
  return { status: task.success ? 'complete' : 'blocked', source: 'task_complete', at: task.at, ...reportFields(task.summary), unit: null, commit: null };
}

function plannedLabel(todoId) {
  return UNIT_LABEL_RE.test(todoId) ? todoId : String(todoId).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'planned';
}

function activityLabel(detail, tool, current) {
  const fixed = {
    archived: 'Archived', merged: 'Done. PR merged', stopped: 'Stopped', crashed: 'Process ended unexpectedly', failed: 'Failed',
    waiting_question: 'Waiting for an answer', waiting_plan: 'Waiting for plan approval', blocked: 'Blocked',
    blocked_on_orchestrator: 'Waiting for the orchestrator', stalled: 'Stalled after a progress report', idle: 'Idle',
  }[detail];
  if (fixed) return fixed;
  if (tool?.name === 'task') return `Waiting for its ${current?.subagents.get(tool.id)?.type ?? 'sub-agent'} (sync)`;
  return tool ? `Running ${tool.summary}` : 'Thinking';
}

function progressOf(db) {
  if (!db || !db.todos.length) return null;
  return { done: db.todos.filter(todo => todo.status === 'done').length, total: db.todos.length };
}

function subagentView(sub, nanoAiu, stuck) {
  return {
    id: sub.id, name: sub.name, type: sub.type, model: sub.model, mode: sub.mode,
    status: sub.status === 'running' && stuck ? 'stuck' : sub.status,
    startedAt: sub.startedAt ?? sub.launchedAt, endedAt: sub.endedAt, durationMs: sub.durationMs,
    credits: credits(nanoAiu), task: sub.task,
  };
}

/** Running first, then latest first. */
function sortSubagentViews(views) {
  const running = status => status === 'running' || status === 'stuck';
  return views.sort((a, b) => Number(running(b.status)) - Number(running(a.status)) || b.startedAt - a.startedAt);
}

function subagentViews(all, cost, stuckIds) {
  return sortSubagentViews([...all.subagents.values()].map(sub => subagentView(sub, cost.byParentToolCall.get(sub.id)?.nanoAiu ?? 0, stuckIds.has(sub.id))));
}

/** Run-level sub-agent totals from every session's uncapped counters; credits join the ledger through the task id. */
function runSubagentStats(contexts) {
  const types = new Map();
  let subagents = 0;
  const entryOf = type => {
    let entry = types.get(type);
    if (!entry) {
      entry = { runs: 0, durationMs: 0, nanoAiu: 0 };
      types.set(type, entry);
    }
    return entry;
  };
  for (const c of contexts.values()) {
    subagents += c.all.subagentCount;
    for (const [type, item] of c.all.subagentStats) {
      const entry = entryOf(type);
      entry.runs += item.runs;
      entry.durationMs += item.durationMs;
    }
    for (const [taskId, type] of c.all.subagentIndex) {
      const spent = c.cost.byParentToolCall.get(taskId);
      if (spent) entryOf(type).nanoAiu += spent.nanoAiu;
    }
  }
  return {
    subagents,
    types: new Map([...types].map(([type, entry]) => [type, { runs: entry.runs, durationMs: entry.durationMs, credits: credits(entry.nanoAiu) }])),
  };
}

function nodeContext(input, node) {
  const states = node.cliSessionIds.map(id => input.states.get(id)).filter(Boolean);
  const cli = node.currentCliSessionId;
  return {
    node, states, current: cli ? input.states.get(cli) ?? null : null, all: mergeStates(states),
    ids: new Set([node.id, ...node.cliSessionIds]),
    alive: cli ? input.alive.get(cli) ?? null : null,
    sessionRow: cli ? input.app.sessions.get(cli) ?? null : null,
    sessionDb: cli ? input.sessionDbs.get(cli) ?? null : null,
    workspaceFile: cli ? input.workspaceFiles?.get(cli) ?? null : null,
    cwd: cli ? input.workspaceFiles?.get(cli)?.cwd ?? null : null,
    cost: input.ledger.sumFor(node.cliSessionIds),
  };
}

function readRegistry(input, root) {
  const sets = root.cliSessionIds.map(id => input.sessionDbs.get(id)?.children).filter(Array.isArray);
  const { units, invalid } = normaliseRegistry(sets);
  const byNode = new Map();
  for (const row of units.values()) {
    const id = resolveNodeId(input.forest, row.sessionId);
    if (id && id !== root.id) byNode.set(id, row);
  }
  return { present: units.size > 0, rows: units, byNode, invalid };
}

function assignLabels(root, nodes, registry) {
  const labels = new Map([[root.id, initials(root.name)]]);
  const derived = deriveLabels(nodes.map(node => node.name));
  const used = new Set();
  const give = (node, base) => {
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n += 1) label = `${base}-${n}`;
    used.add(label.toLowerCase());
    labels.set(node.id, label);
  };
  for (const node of nodes) if (registry.byNode.has(node.id)) give(node, registry.byNode.get(node.id).unit);
  nodes.forEach((node, index) => {
    if (!registry.byNode.has(node.id)) give(node, derived[index]);
  });
  return labels;
}

function sessionView(input, c, label, evaluation, report, title, extraMarks, outcomeAt = null) {
  const { node, current, all } = c;
  const { now, thresholds } = input;
  const { status, bucket } = displayOf(evaluation.detail);
  const endedAt = outcomeAt ?? node.archivedAt ?? (c.alive === false ? all.lastEventAt : null);
  const startedAt = node.createdAt ?? all.firstEventAt ?? now;
  const openTool = current && current.openTools.size ? [...current.openTools.values()].sort((a, b) => a.startedAt - b.startedAt)[0] : null;
  const tool = evaluation.tool ?? (openTool ? toolView(openTool, toolLimitMs(openTool, thresholds)) : null);
  const openWaits = current ? [...current.waits.values()] : [];
  const clockEnd = endedAt === null ? now : Math.min(now, endedAt);
  const openEnd = start => Math.max(start, clockEnd);
  const busy = [...all.busySpans, ...(current?.turn ? [[current.turn.startedAt, openEnd(current.turn.startedAt)]] : [])];
  const waits = [...all.waitSpans, ...openWaits.map(wait => [wait.startedAt, openEnd(wait.startedAt), wait.kind])];
  return {
    id: node.id, kind: node.kind, label, name: title ?? node.name ?? '', cliSessionIds: [...node.cliSessionIds],
    branch: node.branch ?? null, model: current?.model ?? c.sessionRow?.model ?? all.model ?? null,
    status, statusDetail: evaluation.detail, bucket, since: evaluation.since, reason: evaluation.reason,
    startedAt, endedAt, lastEventAt: all.lastEventAt,
    busyMs: Math.max(0, Math.round(all.busyMs + (current?.turn ? openEnd(current.turn.startedAt) - current.turn.startedAt : 0))),
    waitingOnUserMs: Math.max(0, Math.round(all.waitingMs + openWaits.reduce((sum, wait) => sum + (openEnd(wait.startedAt) - wait.startedAt), 0))),
    alive: c.alive,
    cost: { credits: credits(c.cost.nanoAiu), calls: c.cost.calls },
    activity: { label: activityLabel(evaluation.detail, tool, current), tool, lastEventAt: all.lastEventAt },
    report,
    progress: progressOf(c.sessionDb),
    subagents: subagentViews(all, c.cost, evaluation.stuckSubagents),
    timeline: {
      segments: buildSegments({ start: startedAt, end: endedAt, now, busy, waits, stuckFrom: status === 'stuck' && endedAt === null ? evaluation.since : null }),
      subagents: [...all.subagents.values()].map(sub => ({ id: sub.id, start: sub.startedAt ?? sub.launchedAt, end: sub.endedAt ?? endedAt, type: sub.type })),
      marks: [...all.marks, ...extraMarks].sort((a, b) => a.at - b.at).slice(-400),
    },
  };
}

function buildUnit(input, node, contexts, registry, labels, project, flags, extraFeed) {
  const c = contexts.get(node.id);
  const parent = contexts.get(node.parentId);
  const row = registry.byNode.get(node.id) ?? null;
  const label = labels.get(node.id);
  const sent = c.all.sent.filter(item => !item.failed && item.target && parent.ids.has(item.target))
    .map(item => ({ item, line: parseStatusLine(item.message), view: reportFromMessage(item.message, item.purpose, item.at) }));
  const statusLines = [];
  for (const { item, line, view } of sent) {
    if (line) {
      flags.statusLines = true;
      statusLines.unshift({ at: item.at, pr: line.pr });
    }
    extraFeed.push({ id: `${node.id}:report:${item.source}`, at: item.at, unitId: node.id, label, kind: 'report', text: oneLine(`reported ${STATUS_WORDS[view.status]}: ${view.title}`, 200) });
  }
  let report = sent.length ? sent[sent.length - 1].view : null;
  // Design section 10 accepts either copy of a report: the child's sent message or the orchestrator's received one.
  const received = parent.all.inbound.filter(item => c.ids.has(item.fromSessionId) || c.ids.has(item.fromProjectSessionId));
  if (!statusLines.length) {
    for (let index = received.length - 1; index >= 0; index -= 1) {
      const line = parseStatusLine(received[index].content);
      if (!line) continue;
      flags.statusLines = true;
      statusLines.push({ at: received[index].at, pr: line.pr });
    }
  }
  if (!report) {
    const last = received[received.length - 1];
    if (last) report = reportFromMessage(last.content, null, last.at);
  }
  const lastTask = c.all.taskCompletes[c.all.taskCompletes.length - 1];
  if (lastTask && (!report || lastTask.at > report.at + TASK_OVERRIDE_MS)) report = reportFromTask(lastTask);
  let parentRepliedAt = null;
  for (const item of c.all.inbound) {
    if (parent.ids.has(item.fromSessionId) || parent.ids.has(item.fromProjectSessionId)) parentRepliedAt = maxTime(parentRepliedAt, item.at);
  }

  const host = hostOf(c.workspaceFile, (node.projectId ? input.app.projects.get(node.projectId) : null) ?? project);
  const identity = resolvePr({ registry: row, statusLines, createdPr: node.createdPr, mentions: c.all.prMentions, host });
  const pr = identity ? prView(identity, input.prInfo(identity, { cwd: c.cwd }), node.createdPr) : null;
  const automations = input.app.automations.filter(item => c.ids.has(item.sessionId));
  const monitorEver = automations.length > 0 || c.all.automation.wakes.length > 0 || c.all.automation.saves.some(save => !save.clear);
  const { stage, merged, closedWithoutMerge } = deriveStage({ archivedAt: node.archivedAt, outcome: row?.outcome ?? null, pr, monitorEver });
  const monitor = deriveMonitor({
    stage, hasPr: Boolean(pr), closedWithoutMerge, automations, wakes: c.all.automation.wakes, saves: c.all.automation.saves,
    prKnownAt: pr?.openedAt ?? identity?.knownAt ?? null, now: input.now, thresholds: input.thresholds,
  });
  const evaluation = evaluateStatus({
    state: c.current, alive: c.alive, archivedAt: node.archivedAt, merged, mergedAt: pr?.mergedAt ?? row?.endedAt ?? null,
    outcome: row?.outcome ?? null, hasRegistry: registry.present, report: report ? { status: report.status, at: report.at } : null,
    parentRepliedAt, monitorDueAt: monitor.state === 'alive' ? monitor.nextCheckAt : null, isRunningFlag: Boolean(c.sessionRow?.isRunning),
    startedAt: node.createdAt ?? c.all.firstEventAt ?? input.now, now: input.now, thresholds: input.thresholds,
  });

  const marks = sent.map(({ item, view }) => ({ at: item.at, kind: view.status === 'needs_input' ? 'question' : 'report', text: view.title || 'Report', status: view.status }));
  if (pr?.openedAt) marks.push({ at: pr.openedAt, kind: 'pr-open', text: 'PR opened', status: null });
  if (pr?.mergedAt) marks.push({ at: pr.mergedAt, kind: 'pr-merged', text: 'PR merged', status: null });
  if (node.archivedAt) marks.push({ at: node.archivedAt, kind: 'archived', text: 'Archived', status: null });
  if (evaluation.detail === 'stuck_tool' && evaluation.tool) marks.push({ at: evaluation.tool.startedAt, kind: 'tool', text: 'Tool call started, no events since', status: null });

  const outcome = row?.outcome ?? (merged ? 'merged' : closedWithoutMerge ? 'closed' : evaluation.detail === 'failed' ? 'failed' : null);
  const outcomeAt = outcome ? row?.endedAt ?? pr?.mergedAt ?? pr?.closedAt ?? null : null;
  return {
    ...sessionView(input, c, label, evaluation, report, row?.title ?? null, marks, outcomeAt),
    parentId: node.parentId, depth: node.depth, stage, closedWithoutMerge, outcome, pr, monitor, dependsOn: null, todoId: row?.todoId ?? null,
    agent: null,
  };
}

function planFromTodos(db, units, registry) {
  const todos = db?.todos ?? [];
  const todoOfUnit = new Map();
  const unitOfTodo = new Map();
  for (const unit of units) {
    if (unit.todoId && todos.some(todo => todo.id === unit.todoId)) {
      todoOfUnit.set(unit.id, unit.todoId);
      unitOfTodo.set(unit.todoId, unit);
    }
  }
  if (!registry.present) {
    for (const todo of todos) {
      if (unitOfTodo.has(todo.id)) continue;
      const text = `${todo.title}\n${todo.description}`;
      const unit = units.find(item => !todoOfUnit.has(item.id) && (text.includes(item.id) || item.cliSessionIds.some(id => text.includes(id))));
      if (unit) {
        todoOfUnit.set(unit.id, todo.id);
        unitOfTodo.set(todo.id, unit);
      }
    }
  }
  const dependsOn = new Map();
  for (const dep of db?.deps ?? []) {
    if (!dependsOn.has(dep.todoId)) dependsOn.set(dep.todoId, []);
    dependsOn.get(dep.todoId).push(dep.dependsOn);
  }
  const planned = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const todo of todos) {
      if (unitOfTodo.has(todo.id) || planned.has(todo.id) || (todo.status !== 'pending' && todo.status !== 'blocked')) continue;
      if ((dependsOn.get(todo.id) ?? []).some(id => unitOfTodo.has(id) || planned.has(id))) {
        planned.set(todo.id, todo);
        changed = true;
      }
    }
  }
  return { todoOfUnit, unitOfTodo, dependsOn, planned };
}

function firstKnownDependency(plan, todoId) {
  return (plan.dependsOn.get(todoId) ?? []).find(id => plan.unitOfTodo.has(id) || plan.planned.has(id)) ?? null;
}

function assignDependencies(units, nodes, registry, plan) {
  const byBranch = new Map(units.filter(unit => unit.branch).map(unit => [unit.branch, unit]));
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  for (const unit of units) {
    const base = registry.byNode.get(unit.id)?.baseBranch ?? nodeById.get(unit.id)?.baseBranch ?? null;
    const parentUnit = base ? byBranch.get(base) : null;
    let dependsOn = parentUnit && parentUnit !== unit ? parentUnit.label : null;
    if (!dependsOn) {
      const depId = firstKnownDependency(plan, plan.todoOfUnit.get(unit.id));
      if (depId) dependsOn = plan.unitOfTodo.get(depId)?.label ?? plannedLabel(depId);
    }
    unit.dependsOn = dependsOn;
  }
}

function plannedEntries(plan) {
  return [...plan.planned.values()].map(todo => {
    const depId = firstKnownDependency(plan, todo.id);
    const depUnit = depId ? plan.unitOfTodo.get(depId) ?? null : null;
    const dependsOn = depId ? depUnit?.label ?? plannedLabel(depId) : null;
    const canStart = Boolean(depUnit) && STARTABLE.has(depUnit.stage);
    return { label: plannedLabel(todo.id), name: todo.title, dependsOn, canStart, waitsOn: canStart ? null : dependsOn, todoId: todo.id };
  });
}

const LABEL_MAX = 32;
const safeLabel = text => String(text ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, LABEL_MAX);

/**
 * Labels for the root's one-off sub-agents, given in start order over every one of them (listed or not), so a label does not change
 * when the listed set does: the task's name made safe, else `<type>-<position>`; unique, ignoring case, against `taken` and each other.
 */
function assignSubagentLabels(subs, taken) {
  const used = new Set([...taken].map(label => label.toLowerCase()));
  const labels = new Map();
  subs.forEach((sub, index) => {
    const base = safeLabel(sub.unit.taskName ?? sub.name) || `${safeLabel(sub.type).slice(0, 28) || 'agent'}-${index + 1}`;
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n += 1) label = `${base.slice(0, LABEL_MAX - `-${n}`.length)}-${n}`;
    used.add(label.toLowerCase());
    labels.set(sub.id, label);
  });
  return labels;
}

/** What each task call in the root's ledger rows cost, with the cost of everything it started added to it and to each task above it. */
function rollupCost(byParentToolCall, nested) {
  const totals = new Map();
  for (const [taskId, spent] of byParentToolCall) {
    let id = taskId;
    for (let hops = 0; id && hops < 64; hops += 1) {
      const entry = totals.get(id) ?? { nanoAiu: 0, calls: 0 };
      entry.nanoAiu += spent.nanoAiu;
      entry.calls += spent.calls;
      totals.set(id, entry);
      id = nested.get(id)?.parent ?? null;
    }
  }
  return totals;
}

const SUBAGENT_DONE_ACTIVITY = { crashed: 'Process ended unexpectedly', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

function subagentUnitView(input, rootContext, root, sub, evaluation, label, rollup) {
  const { now, thresholds } = input;
  const { unit } = sub;
  const { status, bucket } = displayOf(evaluation.detail);
  const running = evaluation.endedAt === null;
  const startedAt = sub.startedAt ?? sub.launchedAt;
  const clockEnd = evaluation.endedAt ?? now;
  const spans = unit.runs.map(([start, end]) => [start, Math.max(start, end ?? clockEnd)]);
  const nested = rootContext.all.descendants;
  const openTool = running ? [...unit.openTools.values()].sort((a, b) => a.startedAt - b.startedAt)[0] ?? null : null;
  const tool = openTool ? toolView(openTool, toolLimitMs(openTool, thresholds)) : null;
  const activity = !running ? SUBAGENT_DONE_ACTIVITY[evaluation.detail]
    : !openTool ? 'Thinking'
      : openTool.name === 'task' ? `Waiting for its ${nested.get(openTool.id)?.sub.type ?? 'sub-agent'} (sync)` : `Running ${openTool.args.summary}`;
  const report = unit.lastMessage
    ? {
      status: running ? 'progress' : evaluation.detail === 'completed' ? 'complete' : 'blocked', source: 'message', at: unit.lastMessage.at,
      ...reportFields(unit.lastMessage.text), unit: null, commit: null,
    }
    : null;
  const stuckIds = new Set(unit.children.filter(child => child.status === 'running' && now - child.lastEventAt > subagentLimitMs(child, thresholds)).map(child => child.id));
  return {
    id: sub.id, kind: 'subagent', label, name: sub.task || sub.name, cliSessionIds: [], branch: null, model: sub.model,
    status, statusDetail: evaluation.detail, bucket, since: evaluation.since, reason: evaluation.reason,
    startedAt, endedAt: evaluation.endedAt, lastEventAt: sub.lastEventAt,
    busyMs: Math.max(0, Math.round(spans.reduce((sum, [start, end]) => sum + end - start, 0))), waitingOnUserMs: 0, alive: rootContext.alive,
    cost: { credits: credits(rollup.get(sub.id)?.nanoAiu ?? 0), calls: rollup.get(sub.id)?.calls ?? 0 },
    activity: { label: activity, tool, lastEventAt: sub.lastEventAt },
    report, progress: null,
    subagents: sortSubagentViews(unit.children.map(child => subagentView(child, rollup.get(child.id)?.nanoAiu ?? 0, stuckIds.has(child.id)))),
    timeline: {
      segments: buildSegments({ start: startedAt, end: evaluation.endedAt, now, busy: spans, waits: [], stuckFrom: evaluation.detail === 'stuck_subagent' ? evaluation.since : null }),
      subagents: unit.children.map(child => ({ id: child.id, start: child.startedAt ?? child.launchedAt, end: child.endedAt ?? evaluation.endedAt, type: child.type })),
      marks: report && !running ? [{ at: evaluation.endedAt, kind: 'report', text: report.title || 'Report', status: report.status }] : [],
    },
    parentId: root.id, depth: 1, stage: 'subagent', closedWithoutMerge: false, outcome: null, pr: null,
    monitor: { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null, since: null }, dependsOn: null, todoId: null,
    agent: { type: sub.type, mode: sub.mode, effort: sub.effort },
  };
}

/**
 * The root orchestrator's one-off sub-agents as units: every one that has not finished, plus the MAX_FINISHED_SUBAGENT_UNITS that
 * finished last, oldest start first. The others are only counted (`omitted`). Their feed items go to `extraFeed` for every one of them.
 */
function buildSubagentUnits(input, rootContext, root, takenLabels, extraFeed) {
  const all = rootContext.all;
  const subs = [...all.subagents.values()].filter(sub => sub.unit).sort((a, b) => a.launchedAt - b.launchedAt);
  const labels = assignSubagentLabels(subs, takenLabels);
  const rollup = rollupCost(rootContext.cost.byParentToolCall, all.descendants);
  const startOf = sub => sub.startedAt ?? sub.launchedAt;
  const entries = subs.map(sub => {
    const evaluation = evaluateSubagentUnit(sub, { alive: rootContext.alive, now: input.now, thresholds: input.thresholds });
    for (const item of sub.unit.feed) {
      extraFeed.push({ id: `${sub.id}:${item.kind}:${item.source}`, at: item.at, unitId: sub.id, label: labels.get(sub.id), kind: item.kind, text: item.text });
    }
    return { sub, evaluation, bucket: displayOf(evaluation.detail).bucket };
  });
  const isFinished = entry => entry.bucket === 'done' || entry.bucket === 'failed';
  const latest = entries.filter(isFinished)
    .sort((a, b) => b.evaluation.endedAt - a.evaluation.endedAt || startOf(b.sub) - startOf(a.sub) || (a.sub.id < b.sub.id ? 1 : -1))
    .slice(0, MAX_FINISHED_SUBAGENT_UNITS);
  const kept = new Set(latest.map(entry => entry.sub.id));
  const listed = entries.filter(entry => !isFinished(entry) || kept.has(entry.sub.id))
    .sort((a, b) => startOf(a.sub) - startOf(b.sub) || (a.sub.id < b.sub.id ? -1 : 1));
  // Sub-agents that left the details (so no unit) are counted from the outcome totals; the rest from the units that are not listed.
  const withStatus = status => subs.filter(sub => sub.status === status).length;
  const omitted = {
    done: Math.max(0, all.subagentOutcomes.completed - withStatus('completed')),
    failed: Math.max(0, all.subagentOutcomes.failed + all.subagentOutcomes.cancelled - withStatus('failed') - withStatus('cancelled')),
  };
  for (const entry of entries) {
    if (isFinished(entry) && !kept.has(entry.sub.id)) omitted[entry.bucket] += 1;
  }
  return {
    units: listed.map(entry => subagentUnitView(input, rootContext, root, entry.sub, entry.evaluation, labels.get(entry.sub.id), rollup)),
    omitted,
  };
}

function buildNeeds(contexts, rootId, labels, flags) {
  const labelIndex = new Map([...labels].filter(([id]) => id !== rootId).map(([id, label]) => [label.toLowerCase(), id]));
  const needs = [];
  for (const [id, c] of contexts) {
    if (c.alive === false || (c.node.archivedAt !== null && c.node.archivedAt !== undefined)) continue;
    for (const wait of c.current ? c.current.waits.values() : []) {
      const tag = wait.kind === 'question' ? parseQuestionTag(wait.text) : null;
      if (tag) flags.questionTags = true;
      let unitIds = id === rootId ? [] : [id];
      if (tag && id === rootId && !tag.units.includes('*')) {
        unitIds = [...new Set(tag.units.map(label => labelIndex.get(label.toLowerCase())).filter(Boolean))];
      }
      const kind = wait.kind === 'plan' ? 'plan' : tag?.need ?? 'question';
      needs.push({
        id: `${id}:${kind}:${c.current.id}/${wait.id}`, kind, unitIds, labels: unitIds.map(unitId => labels.get(unitId)),
        fromId: id, text: oneLine(tag ? tag.text : wait.text, 300), since: wait.startedAt, tagged: Boolean(tag),
      });
    }
  }
  return needs.sort((a, b) => a.since - b.since);
}

function buildFeed(contexts, labels, extraFeed, flags) {
  const items = [...extraFeed];
  for (const [id, c] of contexts) {
    for (const item of c.all.feed) {
      let text = item.text;
      if (item.kind === 'question' && text.startsWith('asked: ')) {
        const tag = parseQuestionTag(text.slice(7));
        if (tag) flags.questionTags = true;
        text = `asked: ${tag?.text ?? text.slice(7)}`;
      }
      items.push({ id: `${id}:${item.kind}:${item.source}`, at: item.at, unitId: id, label: labels.get(id), kind: item.kind, text });
    }
  }
  return splitFeed(items);
}

/** The swarm feed, latest first and cut to FEED_LIMIT, plus each session's latest RECENT_LIMIT items taken before the cut. */
export function splitFeed(items, { limit = FEED_LIMIT, recent = RECENT_LIMIT } = {}) {
  const sorted = [...items].sort((a, b) => b.at - a.at);
  const bySession = new Map();
  for (const item of sorted) {
    const list = bySession.get(item.unitId) ?? [];
    if (list.length < recent) list.push(item);
    bySession.set(item.unitId, list);
  }
  return { feed: sorted.slice(0, limit), recent: bySession };
}

function costSummary(ledger, cliIds, units) {
  const totals = ledger.sumFor(cliIds);
  let cumulative = 0;
  const series = [...totals.buckets].sort((a, b) => a[0] - b[0]).map(([at, nanoAiu]) => {
    cumulative += nanoAiu;
    return { at, credits: credits(cumulative) };
  });
  const total = credits(totals.nanoAiu);
  return {
    lastAt: totals.lastAt,
    summary: {
      credits: total, usd: Math.round(total * CREDIT_USD * 100) / 100,
      maxUnitCredits: units.reduce((max, unit) => Math.max(max, unit.cost.credits), 0),
      byModel: [...totals.byModel].map(([model, entry]) => ({ model, credits: credits(entry.nanoAiu), calls: entry.calls, apiMs: Math.round(entry.apiMs) }))
        .sort((a, b) => b.credits - a.credits),
      series,
    },
  };
}

export function buildSnapshot(input) {
  const { forest, rootId, app, now, thresholds } = input;
  const root = forest.nodes.get(rootId);
  const nodes = descendants(forest, rootId);
  const project = root.projectId ? app.projects.get(root.projectId) ?? null : null;
  const contexts = new Map([root, ...nodes].map(node => [node.id, nodeContext(input, node)]));
  const rootContext = contexts.get(root.id);
  const registry = readRegistry(input, root);
  const labels = assignLabels(root, nodes, registry);
  const flags = { statusLines: false, questionTags: false };
  const extraFeed = [];
  const units = nodes.map(node => buildUnit(input, node, contexts, registry, labels, project, flags, extraFeed));
  const plan = planFromTodos(rootContext.sessionDb, units, registry);
  for (const unit of units) unit.todoId = unit.todoId ?? plan.todoOfUnit.get(unit.id) ?? null;
  assignDependencies(units, nodes, registry, plan);

  const evaluation = evaluateStatus({
    state: rootContext.current, alive: rootContext.alive, archivedAt: root.archivedAt, merged: false, mergedAt: null, outcome: null,
    hasRegistry: registry.present, report: null, parentRepliedAt: null, monitorDueAt: null, isRunningFlag: Boolean(rootContext.sessionRow?.isRunning),
    startedAt: root.createdAt ?? rootContext.all.firstEventAt ?? now, now, thresholds,
  });
  const orchestrator = sessionView(input, rootContext, labels.get(root.id), evaluation, null, null, []);
  const needs = buildNeeds(contexts, root.id, labels, flags);
  const subagents = buildSubagentUnits(input, rootContext, root, labels.values(), extraFeed);
  const everyUnit = [...units, ...subagents.units];
  const { summary: cost, lastAt: lastCostAt } = costSummary(input.ledger, [root, ...nodes].flatMap(node => node.cliSessionIds), everyUnit);
  const counts = { working: 0, stuck: 0, waiting: 0, idle: 0, done: 0, failed: 0 };
  for (const unit of everyUnit) counts[unit.bucket] += 1;
  counts.done += subagents.omitted.done;
  counts.failed += subagents.omitted.failed;

  const lastActivityAt = maxTime(...[...contexts.values()].map(c => c.all.lastEventAt), lastCostAt) ?? root.createdAt ?? now;
  const anyActive = [orchestrator, ...everyUnit].some(session => ACTIVE_DETAILS.has(session.statusDetail));
  const { lifecycle, finishedAt } = runLifecycle({ lastActivityAt, anyActive, now, thresholds });
  const monitorDue = units.some(unit => unit.monitor.state === 'alive') || app.automations.some(item => rootContext.ids.has(item.sessionId)
    && item.pausedAt === null && item.nextRunAt !== null && item.nextRunAt > now - thresholds.monitorGraceMs);
  const stalled = lifecycle === 'live'
    ? swarmStalled({ orchestratorDetail: orchestrator.statusDetail, unitDetails: everyUnit.map(unit => unit.statusDetail), monitorDue, lastActivityAt })
    : null;
  const { feed, recent } = buildFeed(contexts, labels, extraFeed, flags);
  for (const view of [orchestrator, ...everyUnit]) view.recent = recent.get(view.id) ?? [];

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    revision: input.revision ?? 0,
    run: {
      id: root.id, name: root.name ?? '', project: project ? { id: project.id, name: project.name } : null,
      startedAt: root.createdAt ?? orchestrator.startedAt, firstChildAt: minTime(...nodes.map(node => node.createdAt)),
      lastActivityAt, lifecycle, finishedAt, stalled,
      contract: { registry: registry.present && registry.rows.size > 0, statusLines: flags.statusLines, questionTags: flags.questionTags },
    },
    orchestrator,
    units: everyUnit,
    planned: plannedEntries(plan),
    needs,
    feed,
    counts,
    omittedSubagents: subagents.omitted,
    cost,
    diagnostics: input.diagnostics ?? [],
  };
  setRunStats(snapshot, runSubagentStats(contexts));
  return snapshot;
}
