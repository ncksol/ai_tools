import { HOUR, costHtml, costText, count, credits, dateRange, dur, esc, plural } from './format.mjs';

const pct = (value, total) => (total > 0 ? Math.max(0, Math.min(100, (value / total) * 100)) : 0).toFixed(2);
const unitName = unit => (unit.isOrchestrator ? `${unit.label} orchestrator` : `${unit.label} ${unit.name}`);

function ticksFor(hours) {
  const step = hours <= 6 ? 1 : hours <= 24 ? 4 : hours <= 96 ? 12 : hours <= 240 ? 24 : 48;
  const ticks = [];
  for (let hour = 0; hour <= hours + 1e-9; hour += step) ticks.push(hour);
  return ticks;
}

function barRows(rows) {
  const max = Math.max(0, ...rows.map(row => row.value));
  return rows.map(row => `<div class="hb-row"><span class="hb-l">${esc(row.label)}</span><span class="hb-v">${row.text}</span><span class="bar"><i style="width:${pct(row.value, max)}%"></i></span></div>`).join('');
}

export function historyHtml(runs, failed = false) {
  if (runs === null) return failed ? '<p class="none">Finished runs couldn\'t be loaded.</p>' : '<p class="none">Loading finished runs…</p>';
  if (!runs.length) return '<div class="empty"><h3>No finished runs yet</h3><p class="small muted">A run moves here once nothing has happened in it for 2 hours.</p></div>';
  const rows = runs.map(run => `<div class="h-row" data-run="${esc(run.id)}" tabindex="0" role="button" aria-label="Open the ${esc(run.name)} summary">`
    + `<span class="h-run"><span class="h-name">${esc(run.name)}</span><span class="small muted">${esc(run.project?.name ?? 'no project')}</span></span>`
    + `<span class="small muted">${dateRange(run.startedAt, run.finishedAt)}</span>`
    + `<span class="h-cell"><span class="k">Took </span>${run.tookMs == null ? '—' : dur(run.tookMs, 'hm')}</span>`
    + `<span class="h-cell"><span class="k">Busy </span>${run.busyMs == null ? '—' : dur(run.busyMs, 'hm')}</span>`
    + `<span class="h-cell">${costHtml(run.credits, true)}</span>`
    + `<span class="h-cell"><span class="k">Merged </span>${run.merged == null ? '—' : `${count(run.merged)} of ${count(run.children)}`}</span></div>`).join('');
  return `<section class="sec" aria-label="Finished runs"><div class="sec-h"><h3>Finished runs</h3><span class="small muted">${plural(runs.length, 'run')}</span></div>`
    + `<div class="h-list"><div class="h-row h-th"><span>Run</span><span>Dates</span><span>Took</span><span>Busy</span><span>Cost</span><span>Merged</span></div>${rows}</div></section>`;
}

export function runHtml(run) {
  if (run === null) return '<p class="none">Loading the run summary…</p>';
  const back = '<button type="button" class="link" data-page="history">← All runs</button>';
  if (run === false) return `<div class="run"><div class="sec">${back}<p class="small muted">This run's summary is not available.</p></div></div>`;
  const took = Math.max(run.tookMs, 1);
  const gantt = run.units.map(unit => {
    const start = unit.startedAt - run.startedAt;
    const end = (unit.endedAt ?? run.finishedAt) - run.startedAt;
    // A unit can end after the run's last activity (a PR merged later), so clip its bars to the track.
    const from = Math.min(took, Math.max(0, start));
    const to = Math.min(took, Math.max(from, end));
    const closed = !unit.isOrchestrator && (unit.outcome === 'closed' || unit.outcome === 'failed');
    const note = closed ? (unit.outcome === 'failed' ? ', failed' : ', not merged') : '';
    return `<div class="g-row"><div class="g-lab"><span>${esc(unitName(unit))}</span><span class="small muted">busy ${dur(unit.busyMs, 'hm')}${note}</span></div>`
      + `<div class="g-track"><span class="g-span${closed ? ' no' : ''}" style="left:${pct(from, took)}%;width:${pct(to - from, took)}%"></span>`
      + `<span class="g-busy" style="left:${pct(from, took)}%;width:${pct(Math.min(unit.busyMs, took - from), took)}%"></span></div>`
      + `<span class="g-num">${dur(end - start, 'hm')}</span></div>`;
  }).join('');
  const axis = `<div class="g-axis"><div></div><div>${ticksFor(took / HOUR).map(hour => `<span style="left:${pct(hour * HOUR, took)}%">${hour}h</span>`).join('')}</div><div></div></div>`;
  const units = barRows([...run.units].sort((a, b) => b.credits - a.credits).map(unit => ({ label: unitName(unit), text: costText(unit.credits), value: unit.credits })));
  const models = run.models.length
    ? barRows(run.models.map(model => ({ label: model.model, text: `${costText(model.credits)} · ${dur(model.apiMs, 'hm')}`, value: model.credits })))
    : '<p class="none">No model calls recorded.</p>';
  const total = run.subagentTypes.reduce((sum, type) => ({ runs: sum.runs + type.runs, ms: sum.ms + type.durationMs, credits: sum.credits + type.credits }), { runs: 0, ms: 0, credits: 0 });
  const types = run.subagentTypes.length
    ? barRows(run.subagentTypes.map(type => ({ label: `${type.type} · ${plural(type.runs, 'run')} · ${dur(type.durationMs, 'hm')}`, text: costText(type.credits), value: type.credits })))
    : '<p class="none">No sub-agents in this run.</p>';
  const firstChild = run.firstChildAt ? `${dur(run.firstChildAt - run.startedAt)} after the start` : 'none';
  return `<div class="run"><div class="sec">${back}`
    + `<div class="sec-h"><h3>${esc(run.name)}</h3><span class="small muted">${esc(run.project?.name ?? 'no project')} · finished</span></div>`
    + `<div class="run-answer"><div class="kv"><span class="k">Took, start to finish</span><span class="v l">${dur(run.tookMs, 'hm')}</span><span class="small muted">${dateRange(run.startedAt, run.finishedAt)}</span></div>`
    + `<div class="kv"><span class="k">Cost</span><span class="v l">${costHtml(run.credits, true)}</span><span class="small muted">orchestrator, ${plural(run.children.total, 'child', 'children')} and ${plural(run.subagents, 'sub-agent')}</span></div></div>`
    + `<div class="run-sub"><div class="kv"><span class="k">Agent busy time</span><span class="v">${dur(run.busyMs, 'hm')}</span></div>`
    + `<div class="kv"><span class="k">Waiting on you</span><span class="v">${dur(run.waitingOnUserMs, 'hm')}</span></div>`
    + `<div class="kv"><span class="k">Children</span><span class="v">${count(run.children.total)}, ${count(run.children.merged)} merged</span></div>`
    + `<div class="kv"><span class="k">Sub-agents</span><span class="v">${count(run.subagents)}</span></div>`
    + `<div class="kv"><span class="k">First child</span><span class="v">${firstChild}</span></div></div></div>`
    + `<section class="sec"><h3>Time by unit</h3><p>Light bar: start to finish. Dark line: total busy time, drawn from the start. Peach: closed without merging or failed.</p>${axis}<div class="gantt">${gantt}</div></section>`
    + `<div class="run-grid"><section class="sec"><h3>Cost by unit</h3><div class="hb">${units}</div></section>`
    + `<div class="sec"><section class="sec"><h3>Cost and time by model</h3><div class="hb">${models}</div></section>`
    + `<section class="sec"><h3>Sub-agents by type</h3><p>${plural(total.runs, 'run')}, ${dur(total.ms, 'hm')}, ${credits(total.credits)}. Already included in the unit costs.</p><div class="hb">${types}</div></section></div></div></div>`;
}
