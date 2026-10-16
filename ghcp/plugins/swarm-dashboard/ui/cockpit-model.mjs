/** Data for the cockpit's panels: no HTML and no DOM. Words, orders and counts follow the regular view (model.mjs). */
import { HOUR, MIN, plainText } from './format.mjs';
import { BOARD_WORDS, COUNT_TILES, NEED_CLASS, NEED_LABELS, STATUS_ORDER, feedText, findUnit, isSubagent, needItems, omittedSubagents, runEnd, stateLine } from './model.mjs';

export const ACTIVITY_ROWS = 9;
export const NEED_ROWS = 2;
export const PR_ROWS = 4;
export const MODEL_ROWS = 4;
/** Tile density by count: three-line tiles in 2 rows, two-line in 3, one-line in 4; past 16 the last slot counts the rest. */
export const DENSITIES = Object.freeze([{ name: 'full', max: 8 }, { name: 'two', max: 12 }, { name: 'one', max: 16 }]);
export const BUCKET_WORDS = Object.freeze({ working: 'Working', stuck: 'Stuck', waiting: 'Waiting', idle: 'Idle', done: 'Done', failed: 'Failed' });
const ATTENTION = new Set(['stuck', 'question', 'plan', 'blocked']);
const STATUS_WORDS = { busy: 'Busy', idle: 'Idle', plan: 'Waiting on plan', question: 'Waiting on question', stuck: 'Stuck', blocked: 'Blocked', merged: 'Merged', done: 'Done', archived: 'Archived' };
const PR_STATES = { merged: ['merged', 'Merged'], closed: ['blocked', 'Closed'], draft: ['idle', 'Draft'], unknown: ['idle', 'Not known yet'] };
const DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long' });
const pad = value => String(value).padStart(2, '0');
const oneLine = text => plainText(text).replace(/\s+/g, ' ').trim();
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

/** A session's state line without its time: "Stuck · no events {t}" reads "Stuck · no events". */
export function stateWord(session) {
  const word = stateLine(session).replace(/\s*(?:·\s*)?\{[ta]\}\s*$/, '').trim();
  return word || STATUS_WORDS[session.status] || session.status;
}

/** The Board's short word for a status, without its time: "plan waiting {t}" reads "Plan waiting". */
export const tileWord = status => capital((BOARD_WORDS[status] ?? status).replace(/\s*\{[ta]\}\s*$/, ''));

function tileUnits(snapshot) {
  return snapshot.units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => !isSubagent(unit) || unit.status === 'busy' || unit.status === 'stuck')
    .sort((a, b) => (STATUS_ORDER[a.unit.status] ?? 9) - (STATUS_ORDER[b.unit.status] ?? 9) || a.index - b.index)
    .map(({ unit }) => unit);
}

/** Tiles for Mission control (builder decision B1). */
export function tileGrid(snapshot) {
  const units = tileUnits(snapshot);
  const density = DENSITIES.find(entry => units.length <= entry.max) ?? DENSITIES[DENSITIES.length - 1];
  const overflow = units.length > density.max;
  const shown = overflow ? units.slice(0, density.max - 1) : units;
  const slots = shown.length + Number(overflow);
  const rowCount = Math.ceil(slots / 4);
  return {
    density: density.name,
    rows: Array.from({ length: rowCount }, (_, i) => Math.floor(slots / rowCount) + Number(i < slots % rowCount)),
    tiles: shown.map(unit => ({ id: unit.id, label: unit.label, name: unit.name, status: unit.status, word: tileWord(unit.status), since: unit.since, attention: ATTENTION.has(unit.status), subagent: isSubagent(unit) })),
    more: overflow ? units.length - shown.length : 0,
  };
}

export function unitCounts(snapshot) {
  const subagents = snapshot.units.filter(isSubagent);
  const running = subagents.filter(unit => unit.status === 'busy' || unit.status === 'stuck').length;
  return { sessions: snapshot.units.length - subagents.length, running, finished: subagents.length - running + omittedSubagents(snapshot) };
}

export function legend(snapshot) {
  const count = bucket => snapshot.counts[bucket] ?? 0;
  return {
    rows: COUNT_TILES.map(([bucket, state]) => ({ bucket, state, word: BUCKET_WORDS[bucket], count: count(bucket) })),
    live: count('working') + count('stuck') + count('waiting') + count('idle'),
    ended: count('done') + count('failed'),
  };
}

export function needRows(snapshot) {
  const items = needItems(snapshot);
  const byId = new Map(snapshot.needs.map(need => [need.id, need]));
  const rows = items.slice(0, NEED_ROWS).map(item => {
    const need = byId.get(item.id);
    return {
      id: item.id,
      kind: item.kind,
      state: NEED_CLASS[item.kind],
      word: NEED_LABELS[item.kind],
      who: need?.labels.length ? need.labels.join(' ') : snapshot.orchestrator.label,
      text: oneLine(item.text),
      since: item.since,
      unitId: need?.unitIds.find(id => findUnit(snapshot, id)) ?? null,
    };
  });
  return { total: items.length, rows };
}

export function activityRows(snapshot) {
  const sessions = new Map([snapshot.orchestrator, ...snapshot.units].map(session => [session.id, session]));
  return snapshot.feed.slice(0, ACTIVITY_ROWS).reverse().map(item => {
    const session = sessions.get(item.unitId) ?? null;
    return { id: item.id, at: item.at, label: item.label ?? session?.label ?? '', text: oneLine(feedText(item)), status: session?.status ?? null, unitId: session && session !== snapshot.orchestrator ? session.id : null };
  });
}

export function prRows(snapshot) {
  const units = snapshot.units.filter(unit => unit.pr);
  const ended = unit => unit.pr.state === 'merged' || unit.pr.state === 'closed';
  const at = unit => (ended(unit) ? unit.pr.mergedAt ?? unit.pr.closedAt : unit.pr.openedAt) ?? 0;
  const sorted = [...units].sort((a, b) => Number(ended(a)) - Number(ended(b)) || at(b) - at(a));
  const rows = sorted.slice(0, PR_ROWS).map(unit => {
    const [state, word] = PR_STATES[unit.pr.state] ?? ['busy', unit.stage === 'in_review' ? 'In review' : 'Open'];
    return { id: unit.pr.id, unitId: unit.id, title: oneLine(unit.pr.title || `PR #${unit.pr.id}`), who: `${unit.label} ${unit.name}`, state, word };
  });
  return { rows, opened: units.length, merged: units.filter(unit => unit.pr.state === 'merged').length };
}

/** Credits per hour over the last hour of the cost series, or over its whole span when that is shorter but at least 10 minutes. */
export function hourlyRate(series) {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const from = last.at - HOUR;
  if (series[0].at >= from) {
    const span = last.at - series[0].at;
    return span >= 10 * MIN ? ((last.credits - series[0].credits) / span) * HOUR : null;
  }
  const index = series.findIndex(point => point.at > from);
  const a = series[index - 1];
  const b = series[index];
  return last.credits - (a.credits + ((b.credits - a.credits) * (from - a.at)) / (b.at - a.at));
}

/** The series carried on flat to `now`: the engine adds a point only when credits are spent. */
function untilNow(series, credits, now) {
  const last = series[series.length - 1];
  return last && now > last.at ? [...series, { at: now, credits: Math.max(credits, last.credits) }] : series;
}

/** The swarm's cost, with the rate over the hour up to `now`. Sub-agent unit costs are inside the orchestrator's and are never added here. */
export function costView(snapshot, now = snapshot.generatedAt) {
  const { cost } = snapshot;
  const models = [...cost.byModel].sort((a, b) => b.credits - a.credits).slice(0, MODEL_ROWS);
  const max = models.length ? models[0].credits : 0;
  return {
    credits: cost.credits,
    perHour: runEnd(snapshot) === null ? hourlyRate(untilNow(cost.series ?? [], cost.credits, now)) : null,
    models: models.map(entry => ({ model: entry.model, credits: entry.credits, share: max > 0 ? entry.credits / max : 0 })),
  };
}

export function clockText(ms) {
  const date = new Date(ms);
  return { hm: `${pad(date.getHours())}:${pad(date.getMinutes())}`, s: pad(date.getSeconds()) };
}
export const dateText = ms => DATE.format(new Date(ms)).replace(',', '');
export const timeText = ms => clockText(ms).hm;

/** The soonest scheduled PR monitor check, or null. */
export function nextCheckAt(snapshot) {
  const times = snapshot.units.filter(unit => !isSubagent(unit) && unit.monitor?.state === 'alive' && unit.monitor.nextCheckAt).map(unit => unit.monitor.nextCheckAt);
  return times.length ? Math.min(...times) : null;
}

export const runLine = snapshot => `${snapshot.run.name}${snapshot.run.project ? ` · ${snapshot.run.project.name}` : ''}`;
