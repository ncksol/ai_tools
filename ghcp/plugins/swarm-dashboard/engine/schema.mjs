/**
 * Snapshot contract between the swarm data engine (PR 1) and the dashboard server and UI (PR 2).
 *
 * - Times are epoch milliseconds (UTC). Durations are milliseconds.
 * - Credits are AI credits: nano-AIU / 1e9. Dollars = credits × CREDIT_USD (list price).
 * - Credits are rounded to 0.1 and dollars to 0.01 wherever they appear.
 * - Free text (report bodies, questions, feed text) is for local display only. It never reaches the history store.
 * - Any breaking change bumps SCHEMA_VERSION and needs the coordinator's approval, because PR 2 depends on it.
 */
export const SCHEMA_VERSION = 1;
export const CREDIT_USD = 0.01;
export const NANO_AIU_PER_CREDIT = 1e9;

export const DISPLAY_STATES = Object.freeze(['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'archived', 'done']);
export const STATUS_DETAILS = Object.freeze([
  'busy', 'slow_model_call',
  'silent', 'stuck_model_call', 'stuck_tool', 'stuck_subagent', 'spinning', 'stalled',
  'waiting_question', 'waiting_plan',
  'blocked', 'blocked_on_orchestrator',
  'idle', 'stopped',
  'crashed', 'failed', 'completed', 'cancelled',
  'merged', 'archived',
]);
export const COUNT_BUCKETS = Object.freeze(['working', 'stuck', 'waiting', 'idle', 'done', 'failed']);
export const STAGES = Object.freeze(['planned', 'coding', 'pr_open', 'in_review', 'merged', 'archived', 'subagent']);
export const REPORT_STATUSES = Object.freeze(['complete', 'progress', 'needs_input', 'blocked']);
export const REPORT_SOURCES = Object.freeze(['contract', 'purpose', 'message', 'task_complete']);
export const NEED_KINDS = Object.freeze(['question', 'plan', 'pr']);
export const MONITOR_STATES = Object.freeze(['none', 'alive', 'missing', 'paused', 'ended']);
export const PR_PROVIDERS = Object.freeze(['ado', 'github']);
export const PR_STATES = Object.freeze(['draft', 'open', 'merged', 'closed', 'unknown']);
export const PR_SOURCES = Object.freeze(['registry', 'status_line', 'app', 'heuristic']);
export const OUTCOMES = Object.freeze(['merged', 'closed', 'failed']);
export const SEGMENT_STATES = Object.freeze(['busy', 'idle', 'plan', 'question', 'stuck']);
export const MARK_KINDS = Object.freeze(['report', 'question', 'answer', 'plan-req', 'plan-ok', 'pr-open', 'pr-comment', 'pr-merged', 'archived', 'tool', 'monitor']);
export const SUBAGENT_STATUSES = Object.freeze(['running', 'completed', 'failed', 'stuck', 'cancelled']);
export const SUBAGENT_MODES = Object.freeze(['sync', 'background']);
export const SESSION_KINDS = Object.freeze(['project', 'chat', 'subagent']);
/** How many finished sub-agent units a snapshot lists. */
export const MAX_FINISHED_SUBAGENT_UNITS = 20;
export const LIFECYCLES = Object.freeze(['live', 'finished']);
export const FEED_KINDS = Object.freeze([
  'report', 'question', 'answer', 'plan-req', 'plan-ok', 'subagent-start', 'subagent-done', 'task-complete',
  'monitor-check', 'monitor-set', 'monitor-cleared', 'pr', 'archived', 'abort', 'error', 'compaction',
]);
export const DIAGNOSTIC_LEVELS = Object.freeze(['info', 'warn']);

/**
 * @typedef {number} EpochMs
 * @typedef {{ id: string, name: string, summary: string, startedAt: EpochMs, limitMs: number|null }} ToolCallView
 *   The open tool call; `limitMs` is the stuck limit for this call, or null when no tool rule applies.
 * @typedef {{ status: 'complete'|'progress'|'needs_input'|'blocked', source: 'contract'|'purpose'|'message'|'task_complete',
 *   at: EpochMs, title: string, summary: string|null, evidence: string[], blockers: string[]|null, body: string|null,
 *   unit: string|null, commit: string|null, repliedAt: EpochMs|null }} ReportView
 *   `blockers` is null when the report has no Blockers field and [] for "Blockers: none". `body` is free text outside the fields.
 *   `repliedAt` is when the unit's parent first sent it a message after `at` (for a session, the orchestrator's reply; for a
 *   sub-agent unit, a follow-up), else null.
 * @typedef {{ id: string, name: string, type: string, model: string|null, effort: string|null, mode: 'sync'|'background',
 *   status: 'running'|'completed'|'failed'|'stuck'|'cancelled', startedAt: EpochMs, endedAt: EpochMs|null, durationMs: number|null,
 *   credits: number, task: string|null }} SubagentView
 *   `effort` is the reasoning effort the sub-agent ran with (subagent.configured), else the one its task call requested, else null.
 * @typedef {{ start: EpochMs, end: EpochMs|null, state: 'busy'|'idle'|'plan'|'question'|'stuck' }} Segment  end null = ongoing
 * @typedef {{ id: string, start: EpochMs, end: EpochMs|null, type: string }} SubagentBar
 * @typedef {{ at: EpochMs, kind: string, text: string, status: string|null }} Mark  kind is one of MARK_KINDS
 * @typedef {{ segments: Segment[], subagents: SubagentBar[], marks: Mark[] }} Timeline
 *
 * @typedef {object} SessionView  Shared by the orchestrator and every unit.
 * @property {string} id                 Node id: workspace id for project sessions, CLI session id for chats
 * @property {'project'|'chat'|'subagent'} kind
 * @property {string} label              Short label for rings (registry unit label, or derived)
 * @property {string} name
 * @property {string[]} cliSessionIds    Oldest first; the last one is current
 * @property {string|null} branch
 * @property {string|null} model
 * @property {string|null} effort        The reasoning effort it runs with; null when unknown. A session: the app's setting
 *   for it (data.db), else the latest effort in its log (session.start, session.resume, session.model_change). A
 *   sub-agent unit: the effort it ran with (subagent.configured), else the one its task call requested; the same value as
 *   agent.effort.
 * @property {string} status             One of DISPLAY_STATES (colour)
 * @property {string} statusDetail       One of STATUS_DETAILS (detector result)
 * @property {string} bucket             One of COUNT_BUCKETS (header count)
 * @property {EpochMs} since             Start of the current state (for stuck: start of the silence)
 * @property {string|null} reason        Why it is stuck, blocked, stalled or failed: the rule and its numbers
 * @property {EpochMs} startedAt
 * @property {EpochMs|null} endedAt      When the session's work ended. A unit with an outcome: the outcome time (registry ended_at, else the PR's mergedAt or closedAt). Otherwise, or with no outcome time: the archive time, else the last event once the process is gone (alive === false), else null. Timeline segments end here.
 * @property {EpochMs|null} lastEventAt
 * @property {number} busyMs             Sum of main-agent turns, including waits on the user
 * @property {number} waitingOnUserMs    Time inside open ask_user and exit_plan_mode calls
 * @property {boolean|null} alive        Process liveness; null when unknown
 * @property {{ credits: number, calls: number }} cost   Sub-agent costs are included
 * @property {{ label: string, tool: ToolCallView|null, lastEventAt: EpochMs|null }} activity
 * @property {ReportView|null} report    Latest report to its parent (always null for the orchestrator)
 * @property {{ done: number, total: number }|null} progress  Own todos; null when it keeps none
 * @property {SubagentView[]} subagents  Running first, then latest first
 * @property {Timeline} timeline
 * @property {FeedItem[]} recent           This session's latest feed items, latest first, at most 6. Taken before the swarm-wide feed is cut to 200, so quiet sessions keep theirs
 *
 * @typedef {SessionView & {
 *   parentId: string, depth: number, stage: string, closedWithoutMerge: boolean, outcome: 'merged'|'closed'|'failed'|null,
 *   pr: PrView|null, monitor: MonitorView, dependsOn: string|null, todoId: string|null,
 *   agent: { type: string, mode: 'sync'|'background', effort: string|null }|null }} UnitView
 *   `dependsOn` is the label of the unit or planned entry it stacks on.
 *   `agent` is null for session units (kind 'project' or 'chat') and set for sub-agent units (kind 'subagent').
 */

/**
 * Sub-agent units (kind 'subagent'): the root orchestrator's one-off `task` sub-agents. Field meanings:
 *   id              the task tool-call id (the same id as the orchestrator's SubagentView for it)
 *   label           the task's name, made safe (letters, digits, '.', '_', '-'; at most 32), unique in the snapshot
 *                   ('-2', '-3'...); else '<type>-<n>'
 *   name            the task's description, else its name
 *   cliSessionIds   []            branch: null                    model: the model it ran on, else the one requested
 *   effort          the effort it ran with (subagent.configured), else the one its task call requested; the same value as
 *                   agent.effort
 *   status / statusDetail / bucket:
 *                   running 'busy'/'busy'/'working'; no events for longer than the sub-agent limit
 *                   'stuck'/'stuck_subagent'/'stuck'; an open tool call past its own limit
 *                   'stuck'/'stuck_tool'/'stuck'; while a tool with its own limit is open, that limit applies instead of the
 *                   silence limit; completed 'done'/'completed'/'done'; failed 'blocked'/'failed'/'failed';
 *                   cancelled 'blocked'/'cancelled'/'failed'; the orchestrator's process ended while it ran
 *                   'blocked'/'crashed'/'failed'
 *   since           start of its current run; when stuck, its last event, or the start of the stuck tool call;
 *                   once finished, endedAt
 *   reason          stuck: the rule and its numbers; failed: the error; cancelled: when; crashed: why
 *   startedAt       when it started       endedAt: when it finished (after a follow-up: when its last turn ended, or when an
 *                                         abort or the end of the orchestrator's process stopped it);
 *                                         null while it runs
 *   busyMs          its own run time, follow-ups included      waitingOnUserMs: 0
 *   alive           the orchestrator's process liveness
 *   cost            its own ledger cost, its own sub-agents included. It is also part of the orchestrator's cost:
 *                   never add sub-agent unit costs to a total
 *   activity        its open tool call ('Running ...'), 'Thinking', or a fixed label once finished
 *   report          its latest non-empty message, source 'message': status 'progress' while it runs, 'complete'
 *                   once completed (its final answer), 'blocked' if it failed or was cancelled; null before its
 *                   first message; repliedAt: its first follow-up after that message, else null
 *   progress        null          subagents: the sub-agents it started itself
 *   timeline        busy while it runs, idle between a completion and a follow-up, stuck from when it became stuck;
 *                   bars for its own sub-agents; a 'report' mark when it finishes
 *   recent          its own feed items: started, resumed by a follow-up, finished, failed or cancelled, and its own
 *                   sub-agents
 *   parentId        the orchestrator's id   depth: 1   stage: 'subagent'   closedWithoutMerge: false   outcome: null
 *   pr              null          monitor: { state: 'none', lastCheckAt: null, nextCheckAt: null, everyMinutes: null,
 *                                 since: null }      dependsOn: null      todoId: null
 *   agent           { type, mode, effort }: its agent type, 'sync' or 'background', and its reasoning effort
 * The orchestrator's own fields do not change: its subagents, timeline.subagents and cost still include these
 * sub-agents. Feed items about one of them (started, resumed, finished) belong to its unit, not to the orchestrator.
 */

/**
 * @typedef {{ provider: 'ado'|'github', id: number, repo: string|null, url: string|null, title: string|null,
 *   state: 'draft'|'open'|'merged'|'closed'|'unknown', openedAt: EpochMs|null, mergedAt: EpochMs|null, closedAt: EpochMs|null,
 *   reviewNote: string|null, source: 'registry'|'status_line'|'app'|'heuristic', checkedAt: EpochMs|null }} PrView
 * @typedef {{ state: 'none'|'alive'|'missing'|'paused'|'ended', lastCheckAt: EpochMs|null, nextCheckAt: EpochMs|null,
 *   everyMinutes: number|null, since: EpochMs|null }} MonitorView  `since` is set for missing and paused
 * @typedef {{ label: string, name: string, dependsOn: string|null, canStart: boolean, waitsOn: string|null, todoId: string|null }} PlannedUnit
 * @typedef {{ id: string, kind: 'question'|'plan'|'pr', unitIds: string[], labels: string[], fromId: string, text: string,
 *   since: EpochMs, tagged: boolean }} NeedItem  unitIds empty = the whole swarm. id is unique within needs and stable across refreshes
 * @typedef {{ id: string, at: EpochMs, unitId: string, label: string, kind: string, text: string }} FeedItem  kind is one of FEED_KINDS. id is unique within each list (feed, and each session's recent) and stable across refreshes; the same item keeps the same id in every list it appears in. unitId can name a sub-agent unit that is not listed (see omittedSubagents)
 * @typedef {{ level: 'info'|'warn', source: string, message: string }} Diagnostic
 *
 * @typedef {object} Snapshot
 * @property {1} schemaVersion
 * @property {EpochMs} generatedAt
 * @property {number} revision           Per-swarm counter; increases whenever the content changes
 * @property {{ id: string, name: string, project: {id: string, name: string}|null, startedAt: EpochMs, firstChildAt: EpochMs|null,
 *   lastActivityAt: EpochMs, lifecycle: 'live'|'finished', finishedAt: EpochMs|null, stalled: {since: EpochMs, reason: string}|null,
 *   contract: { registry: boolean, statusLines: boolean, questionTags: boolean } }} run
 * @property {SessionView} orchestrator
 * @property {UnitView[]} units          Every descendant session, depth-first by creation time; then the root orchestrator's one-off
 *   sub-agents (kind 'subagent'), oldest start first: every one that has not finished, plus the
 *   MAX_FINISHED_SUBAGENT_UNITS most recently finished.
 * @property {PlannedUnit[]} planned
 * @property {NeedItem[]} needs          Longest wait first
 * @property {FeedItem[]} feed           Latest first, at most 200
 * @property {{ working: number, stuck: number, waiting: number, idle: number, done: number, failed: number }} counts  Every unit, sub-agent units included, plus omittedSubagents. The orchestrator is not counted.
 * @property {{ done: number, failed: number }} omittedSubagents  Finished sub-agent units left out of units, by bucket.
 * @property {{ credits: number, usd: number, maxUnitCredits: number,
 *   byModel: { model: string, credits: number, calls: number, apiMs: number }[],
 *   series: { at: EpochMs, credits: number }[] }} cost  series: cumulative credits at 5-minute bucket starts. maxUnitCredits covers sub-agent units too
 * @property {Diagnostic[]} diagnostics
 *
 * @typedef {{ id: string, name: string, project: {id: string, name: string}|null, startedAt: EpochMs, lastActivityAt: EpochMs,
 *   lifecycle: 'live'|'finished', units: number, credits: number, alive: boolean }} SwarmListItem  units: child sessions only (sub-agent units are not counted)
 * @typedef {{ id: string, name: string, project: {id: string, name: string}|null, startedAt: EpochMs, finishedAt: EpochMs|null,
 *   tookMs: number|null, busyMs: number|null, credits: number, usd: number, children: number, merged: number|null,
 *   summarized: boolean }} RunListItem  summarized false = cheap entry; getRunSummary() computes the full summary
 * @typedef {{ id: string, label: string, name: string, isOrchestrator: boolean, startedAt: EpochMs, endedAt: EpochMs|null,
 *   busyMs: number, credits: number, outcome: 'merged'|'closed'|'failed'|null, merged: boolean }} RunUnit
 * @typedef {object} RunSummary  children, units and busyMs cover the orchestrator and its child sessions only. Every sub-agent, the orchestrator's one-off sub-agents included, is counted once in subagents and subagentTypes.
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} name
 * @property {{id: string, name: string}|null} project
 * @property {EpochMs} startedAt         Creation of the root session (includes any analysis phase)
 * @property {EpochMs|null} firstChildAt
 * @property {EpochMs} finishedAt        Last activity in the run
 * @property {number} tookMs
 * @property {number} busyMs             Sum over all sessions
 * @property {number} waitingOnUserMs    Union of waits on the user across sessions
 * @property {number} credits
 * @property {number} usd
 * @property {{ total: number, merged: number, closed: number, failed: number, noOutcome: number }} children  noOutcome: still active, or ended with no PR result known
 * @property {number} subagents
 * @property {RunUnit[]} units           Orchestrator first
 * @property {{ model: string, credits: number, calls: number, apiMs: number }[]} models
 * @property {{ type: string, runs: number, durationMs: number, credits: number }[]} subagentTypes
 * @property {EpochMs} computedAt
 *
 * @typedef {object} EngineOptions
 * @property {string} [copilotHome]       Default ~/.copilot
 * @property {string} [historyDir]        Default <copilotHome>/swarm-dashboard/history
 * @property {boolean} [persistHistory]   Write summaries of finished runs. Default true
 * @property {() => number} [now]         Clock. Default Date.now
 * @property {object} [thresholds]        Overrides for DEFAULT_THRESHOLDS in engine/config.mjs
 * @property {'auto'|'node'|'cli'} [sqlite]  Default 'auto'
 * @property {'auto'|'off'|object} [prLookup]  Read-only gh/az PR lookups. Default 'auto'
 * @property {(entry: Diagnostic) => void} [log]  Never writes to stdout
 *
 * @typedef {{ revision: number, swarmIds: string[] }} SnapshotChange
 *   `revision` is an engine-wide change counter. It increases by one for each refresh (or fake push)
 *   that changed at least one snapshot. It is not `Snapshot.revision`, which counts per swarm.
 *   `swarmIds` lists the swarms whose snapshots changed.
 * @typedef {object} SwarmEngine
 * @property {() => Promise<void>} refresh                 Read new data once and rebuild tracked swarms
 * @property {(options?: { intervalMs?: number }) => void} start  Poll every intervalMs (default 3000); no timers before this
 * @property {() => void} stop
 * @property {() => SwarmListItem[]} listSwarms             Live first, then by last activity
 * @property {(swarmId?: string) => Promise<Snapshot|null>} getSnapshot  Default: the most recently active live swarm, else the most recently active swarm; null when there is none
 * @property {(sessionId: string) => Promise<string|null>} findSwarm  Root id of the swarm that contains this session: a CLI session id or a workspace id of the root or any descendant. null when the session is in no swarm
 * @property {(listener: (change: SnapshotChange) => void) => () => void} subscribe  Returns unsubscribe
 * @property {() => Promise<RunListItem[]>} listHistory
 * @property {(runId: string) => Promise<RunSummary|null>} getRunSummary
 * @property {() => Diagnostic[]} diagnostics
 */

const KIND = Symbol('kind');
const nullable = spec => ({ [KIND]: 'nullable', spec });
const arrayOf = spec => ({ [KIND]: 'array', spec });
const oneOf = values => ({ [KIND]: 'enum', values });
const literal = value => ({ [KIND]: 'literal', value });
const is = {
  text: value => typeof value === 'string',
  id: value => typeof value === 'string' && value.length > 0,
  number: value => typeof value === 'number' && Number.isFinite(value),
  count: value => Number.isInteger(value) && value >= 0,
  time: value => Number.isInteger(value) && value > 0,
  bool: value => typeof value === 'boolean',
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function preview(value) {
  try {
    return JSON.stringify(value)?.slice(0, 60) ?? String(value);
  } catch {
    return String(value);
  }
}

function check(value, spec, path, errors) {
  if (typeof spec === 'function') {
    if (!spec(value)) errors.push(`${path}: invalid value ${preview(value)}`);
    return;
  }
  switch (spec[KIND]) {
    case 'nullable':
      if (value !== null) check(value, spec.spec, path, errors);
      return;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path}: expected an array`);
      else value.forEach((item, index) => check(item, spec.spec, `${path}[${index}]`, errors));
      return;
    case 'enum':
      if (!spec.values.includes(value)) errors.push(`${path}: expected one of ${spec.values.join(', ')}, got ${preview(value)}`);
      return;
    case 'literal':
      if (value !== spec.value) errors.push(`${path}: expected ${preview(spec.value)}, got ${preview(value)}`);
      return;
    default:
      break;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  for (const key of Object.keys(spec)) {
    if (!own(value, key)) errors.push(`${path}.${key}: missing`);
    else check(value[key], spec[key], `${path}.${key}`, errors);
  }
  for (const key of Object.keys(value)) if (!own(spec, key)) errors.push(`${path}.${key}: unexpected field`);
}

const TIME = is.time;
const OPT_TIME = nullable(is.time);
const OPT_TEXT = nullable(is.text);
const PROJECT = nullable({ id: is.id, name: is.text });
const TOOL_CALL = { id: is.id, name: is.id, summary: is.text, startedAt: TIME, limitMs: nullable(is.count) };
const REPORT = {
  status: oneOf(REPORT_STATUSES), source: oneOf(REPORT_SOURCES), at: TIME, title: is.text,
  summary: OPT_TEXT, evidence: arrayOf(is.text), blockers: nullable(arrayOf(is.text)), body: OPT_TEXT,
  unit: OPT_TEXT, commit: OPT_TEXT, repliedAt: OPT_TIME,
};
const SUBAGENT = {
  id: is.id, name: is.text, type: is.text, model: OPT_TEXT, effort: OPT_TEXT, mode: oneOf(SUBAGENT_MODES), status: oneOf(SUBAGENT_STATUSES),
  startedAt: TIME, endedAt: OPT_TIME, durationMs: nullable(is.count), credits: is.number, task: OPT_TEXT,
};
const TIMELINE = {
  segments: arrayOf({ start: TIME, end: OPT_TIME, state: oneOf(SEGMENT_STATES) }),
  subagents: arrayOf({ id: is.id, start: TIME, end: OPT_TIME, type: is.text }),
  marks: arrayOf({ at: TIME, kind: oneOf(MARK_KINDS), text: is.text, status: nullable(oneOf(REPORT_STATUSES)) }),
};
const FEED_ITEM = { id: is.id, at: TIME, unitId: is.id, label: is.id, kind: oneOf(FEED_KINDS), text: is.text };
const SESSION = {
  id: is.id, kind: oneOf(SESSION_KINDS), label: is.id, name: is.text, cliSessionIds: arrayOf(is.id),
  branch: OPT_TEXT, model: OPT_TEXT, effort: OPT_TEXT,
  status: oneOf(DISPLAY_STATES), statusDetail: oneOf(STATUS_DETAILS), bucket: oneOf(COUNT_BUCKETS), since: TIME, reason: OPT_TEXT,
  startedAt: TIME, endedAt: OPT_TIME, lastEventAt: OPT_TIME, busyMs: is.count, waitingOnUserMs: is.count, alive: nullable(is.bool),
  cost: { credits: is.number, calls: is.count },
  activity: { label: is.text, tool: nullable(TOOL_CALL), lastEventAt: OPT_TIME },
  report: nullable(REPORT),
  progress: nullable({ done: is.count, total: is.count }),
  subagents: arrayOf(SUBAGENT),
  timeline: TIMELINE,
  recent: arrayOf(FEED_ITEM),
};
const PR = {
  provider: oneOf(PR_PROVIDERS), id: is.count, repo: OPT_TEXT, url: OPT_TEXT, title: OPT_TEXT, state: oneOf(PR_STATES),
  openedAt: OPT_TIME, mergedAt: OPT_TIME, closedAt: OPT_TIME, reviewNote: OPT_TEXT, source: oneOf(PR_SOURCES), checkedAt: OPT_TIME,
};
const UNIT = {
  ...SESSION,
  parentId: is.id, depth: is.count, stage: oneOf(STAGES), closedWithoutMerge: is.bool, outcome: nullable(oneOf(OUTCOMES)),
  pr: nullable(PR),
  monitor: { state: oneOf(MONITOR_STATES), lastCheckAt: OPT_TIME, nextCheckAt: OPT_TIME, everyMinutes: nullable(is.count), since: OPT_TIME },
  dependsOn: OPT_TEXT, todoId: OPT_TEXT,
  agent: nullable({ type: is.id, mode: oneOf(SUBAGENT_MODES), effort: OPT_TEXT }),
};
const MODEL_COST = { model: is.id, credits: is.number, calls: is.count, apiMs: is.count };

export const SNAPSHOT_SPEC = Object.freeze({
  schemaVersion: literal(SCHEMA_VERSION), generatedAt: TIME, revision: is.count,
  run: {
    id: is.id, name: is.text, project: PROJECT, startedAt: TIME, firstChildAt: OPT_TIME, lastActivityAt: TIME,
    lifecycle: oneOf(LIFECYCLES), finishedAt: OPT_TIME, stalled: nullable({ since: TIME, reason: is.text }),
    contract: { registry: is.bool, statusLines: is.bool, questionTags: is.bool },
  },
  orchestrator: SESSION,
  units: arrayOf(UNIT),
  planned: arrayOf({ label: is.id, name: is.text, dependsOn: OPT_TEXT, canStart: is.bool, waitsOn: OPT_TEXT, todoId: OPT_TEXT }),
  needs: arrayOf({ id: is.id, kind: oneOf(NEED_KINDS), unitIds: arrayOf(is.id), labels: arrayOf(is.id), fromId: is.id, text: is.text, since: TIME, tagged: is.bool }),
  feed: arrayOf(FEED_ITEM),
  counts: Object.fromEntries(COUNT_BUCKETS.map(bucket => [bucket, is.count])),
  omittedSubagents: { done: is.count, failed: is.count },
  cost: { credits: is.number, usd: is.number, maxUnitCredits: is.number, byModel: arrayOf(MODEL_COST), series: arrayOf({ at: TIME, credits: is.number }) },
  diagnostics: arrayOf({ level: oneOf(DIAGNOSTIC_LEVELS), source: is.id, message: is.text }),
});
export const SWARM_LIST_ITEM_SPEC = Object.freeze({
  id: is.id, name: is.text, project: PROJECT, startedAt: TIME, lastActivityAt: TIME, lifecycle: oneOf(LIFECYCLES),
  units: is.count, credits: is.number, alive: is.bool,
});
export const RUN_LIST_ITEM_SPEC = Object.freeze({
  id: is.id, name: is.text, project: PROJECT, startedAt: TIME, finishedAt: OPT_TIME, tookMs: nullable(is.count),
  busyMs: nullable(is.count), credits: is.number, usd: is.number, children: is.count, merged: nullable(is.count), summarized: is.bool,
});
export const RUN_SUMMARY_SPEC = Object.freeze({
  schemaVersion: literal(SCHEMA_VERSION), id: is.id, name: is.text, project: PROJECT,
  startedAt: TIME, firstChildAt: OPT_TIME, finishedAt: TIME, tookMs: is.count, busyMs: is.count, waitingOnUserMs: is.count,
  credits: is.number, usd: is.number,
  children: { total: is.count, merged: is.count, closed: is.count, failed: is.count, noOutcome: is.count },
  subagents: is.count,
  units: arrayOf({
    id: is.id, label: is.id, name: is.text, isOrchestrator: is.bool, startedAt: TIME, endedAt: OPT_TIME,
    busyMs: is.count, credits: is.number, outcome: nullable(oneOf(OUTCOMES)), merged: is.bool,
  }),
  models: arrayOf(MODEL_COST),
  subagentTypes: arrayOf({ type: is.id, runs: is.count, durationMs: is.count, credits: is.number }),
  computedAt: TIME,
});

const validator = (spec, root) => value => {
  const errors = [];
  check(value, spec, root, errors);
  return errors;
};
export const validateSnapshot = validator(SNAPSHOT_SPEC, 'snapshot');
export const validateSwarmListItem = validator(SWARM_LIST_ITEM_SPEC, 'swarm');
export const validateRunListItem = validator(RUN_LIST_ITEM_SPEC, 'run');
export const validateRunSummary = validator(RUN_SUMMARY_SPEC, 'summary');
