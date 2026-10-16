import { costText, esc } from './format.mjs';
import {
  BOARD_WORDS, PLAN_WORDS, STAGE_CLASS, STAGE_NAMES, boardColumns, closedNotMerged, findByLabel, findPlanned, flattenPlan, planForest, planLayout,
} from './model.mjs';
import { closedBadge, fill } from './parts.mjs';

/** Plan graph geometry from the mockup: node size, column step and row step in px. */
export const NODE = Object.freeze({ width: 176, height: 62, column: 216, row: 78 });
const LEGEND = ['planned', 'coding', 'pr_open', 'in_review', 'merged', 'archived'];

export function planSize(snapshot) {
  const { rows, maxDepth } = planLayout(planForest(snapshot));
  return { width: maxDepth * NODE.column + NODE.width, height: Math.max(0, rows - 1) * NODE.row + NODE.height };
}
export const planFits = (snapshot, width) => width >= Math.max(824, planSize(snapshot).width);

function legendHtml() {
  const swatches = LEGEND.map(stage => `<span><i class="sw stg-${STAGE_CLASS[stage]}"></i>${STAGE_NAMES[stage]}</span>`).join('');
  return `<div class="legend">${swatches}<span class="note">Solid blue outline: can start now, because its parent branch has a PR open or is merged.</span></div>`;
}

function planLine(node, snapshot, now) {
  if (node.planned) {
    if (node.planned.canStart) return '<span class="s">can start now</span>';
    const label = node.planned.waitsOn ?? node.planned.dependsOn;
    if (!label) return 'planned';
    const target = findByLabel(snapshot, label) ?? (findPlanned(snapshot, label) ? { stage: 'planned' } : null);
    return `waits on ${esc(label)}${target ? ` (${STAGE_NAMES[target.stage].toLowerCase()})` : ''}`;
  }
  const unit = node.unit;
  if (closedNotMerged(unit)) return '<span class="pr-closed">PR closed, not merged</span>';
  if (unit.status === 'merged' || unit.status === 'archived') return STAGE_NAMES[unit.stage];
  const words = PLAN_WORDS[unit.status];
  return `${STAGE_NAMES[unit.stage]}${words ? ` · <span class="s">${fill(words, unit.since, now)}</span>` : ''}`;
}

const nodeClass = node => `stg-${STAGE_CLASS[node.stage]} st-${node.status}${node.planned?.canStart ? ' can' : ''}`;
const openAttrs = node => (node.unit ? ` data-open="${esc(node.unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(node.label)}"` : '');
const nameHtml = node => `<div class="pn-1"><span class="dot"></span><span class="tx">${esc(node.label)} ${esc(node.name)}</span></div>`;
const emptyPlan = () => `${legendHtml()}<p class="none">No plan yet.</p>`;

/** Units as a dependency graph of stacked branches, coloured by stage. */
export function planGraphHtml(snapshot, now) {
  const roots = planForest(snapshot);
  if (!roots.length) return emptyPlan();
  const { pos, rows, maxDepth } = planLayout(roots);
  const width = maxDepth * NODE.column + NODE.width;
  const height = Math.max(0, rows - 1) * NODE.row + NODE.height;
  const xy = node => ({ x: pos.get(node).depth * NODE.column, y: Math.round(pos.get(node).row * NODE.row) });
  let paths = '';
  for (const node of pos.keys()) {
    for (const child of node.children) {
      const a = xy(node);
      const b = xy(child);
      const mid = a.x + NODE.width + (NODE.column - NODE.width) / 2;
      paths += `<path d="M${a.x + NODE.width} ${a.y + NODE.height / 2}H${mid}V${b.y + NODE.height / 2}H${b.x}"/>`;
    }
  }
  const nodes = [...pos.keys()].map(node => {
    const { x, y } = xy(node);
    return `<div class="pn ${nodeClass(node)}" style="left:${x}px;top:${y}px;width:${NODE.width}px;height:${NODE.height}px"${openAttrs(node)}>${nameHtml(node)}<div class="pn-2">${planLine(node, snapshot, now)}</div></div>`;
  }).join('');
  return `${legendHtml()}<div class="plan-g" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" aria-hidden="true">${paths}</svg>${nodes}</div>`;
}

/** The same plan as an indented list, for narrow widths and the side panel. */
export function planListHtml(snapshot, now) {
  const rows = flattenPlan(planForest(snapshot));
  if (!rows.length) return emptyPlan();
  const items = rows.map(({ node, depth }) => `<li class="pl-row ${nodeClass(node)}" style="margin-left:${depth * 16}px"${openAttrs(node)}>${nameHtml(node)}<div class="pn-2">${planLine(node, snapshot, now)}${node.dependsOn ? ` · on ${esc(node.dependsOn)}` : ''}</div></li>`);
  return `${legendHtml()}<ol class="pl">${items.join('')}</ol>`;
}

function miniCard(node, now) {
  if (node.planned) {
    const entry = node.planned;
    const waits = entry.waitsOn ?? entry.dependsOn;
    return `<div class="mc planned st-planned${entry.canStart ? ' can' : ''}"><div class="mc-1"><span class="tx">${esc(entry.label)} ${esc(entry.name)}</span></div>`
      + `<div class="mc-2">${entry.canStart ? 'can start now' : waits ? `waits on ${esc(waits)}` : 'not started'}</div>`
      + `<div class="mc-3">${entry.dependsOn ? `stacks on ${esc(entry.dependsOn)}` : 'no parent branch'}</div></div>`;
  }
  const unit = node.unit;
  return `<div class="mc st-${unit.status}" data-open="${esc(unit.id)}" tabindex="0" role="button" aria-label="Open details for ${esc(unit.label)}">`
    + `<div class="mc-1"><span class="dot"></span><span class="tx">${esc(unit.label)} ${esc(unit.name)}</span></div>`
    + `<div class="mc-2">${closedNotMerged(unit) ? closedBadge : fill(BOARD_WORDS[unit.status] ?? unit.status, unit.since, now)}</div><div class="mc-3">${costText(unit.cost.credits)}</div></div>`;
}

/** One column per stage, including planned units. */
export function boardHtml({ snapshot, now }) {
  const columns = boardColumns(snapshot).map(({ stage, nodes }) => `<section class="bcol" aria-label="${STAGE_NAMES[stage]}"><div class="bcol-h"><i class="sw stg-${STAGE_CLASS[stage]}"></i><b>${STAGE_NAMES[stage]}</b>${nodes.length}</div>`
    + `${nodes.map(node => miniCard(node, now)).join('') || '<span class="none">None</span>'}</section>`);
  return `<div class="board">${columns.join('')}</div>`;
}
