/**
 * Where the panels go for a window size. A console arc sits below the window: the units console straight ahead and the
 * activity and PR consoles turned out to each side, at the smallest angle that leaves an even gap. Above each side
 * console a stack of two upper panels is pushed as far out as the window allows. Everything is design px, scaled with
 * the stage; the browser check runs overlapProblems() again on the real page.
 */
import { REST, extremePoses, projectPanel, stageFor } from './cockpit-space.mjs';

export const PANELS = Object.freeze({
  'ck-clock': Object.freeze({ width: 280, height: 176 }),
  'ck-cost': Object.freeze({ width: 280, height: 236 }),
  'ck-needs': Object.freeze({ width: 280, height: 172 }),
  'ck-status': Object.freeze({ width: 280, height: 128 }),
  'ck-activity': Object.freeze({ width: 320, height: 252 }),
  'ck-units': Object.freeze({ width: 536, height: 252 }),
  'ck-prs': Object.freeze({ width: 320, height: 252 }),
});
export const MIN_WINDOW = Object.freeze({ width: 1100, height: 800 });
/**
 * Gaps in design px: between consoles, from the side consoles to the window's edges (64 covers the camera's reach, about
 * 50 px at the pointer's corner), from the upper panels to the edges, above the consoles, inside a stack, and the top line.
 */
export const SPACING = Object.freeze({ consoleGap: 32, edge: 64, upperEdge: 48, upperAbove: 24, upperGap: 16, top: 64 });
/** Window px under the flat top line and the quality switch (16 px from the top, 24 px tall, 8 px clear). */
export const TOP_BAND = 48;
const CONSOLE = Object.freeze({ r: 860, y: -236, tilt: 12 });
const SIDE = Object.freeze({ tilt: 8, turn: 0.5, rFrom: 940, rTo: 1300, rStep: 40, phiFrom: 14, phiTo: 60, phiStep: 0.5 });
const UPPER = Object.freeze({ r: 1180, turn: 0.75, phiFrom: 44, phiTo: 16, phiStep: 0.5, yFrom: -300, yTo: 700, yStep: 4 });

const overlap = (a, b, clear) => a.left < b.right + clear && b.left < a.right + clear && a.top < b.bottom + clear && b.top < a.bottom + clear;

/** Panels that leave the screen or enter the top band, then pairs closer than `clear` px. All values are window px. */
export function overlapProblems(rects, { width, height, top, edge, clear }) {
  const entries = Object.entries(rects);
  const problems = [];
  for (const [id, r] of entries) {
    if (r.left < edge || r.right > width - edge || r.bottom > height - edge || r.top < top) problems.push(`${id} leaves the screen`);
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) if (overlap(entries[i][1], entries[j][1], clear)) problems.push(`${entries[i][0]} overlaps ${entries[j][0]}`);
  }
  return problems;
}

export function fitPanels(width, height) {
  const stage = stageFor(width, height);
  if (width < MIN_WINDOW.width || height < MIN_WINDOW.height) return { stage, fits: false, reason: 'small', placements: null, rects: null, problems: [] };
  const s = stage.scale;
  const placements = {};
  const rects = {};
  const put = (id, placement) => {
    placements[id] = placement;
    rects[id] = projectPanel(placement, PANELS[id], REST, stage);
    return rects[id];
  };
  const problems = [];
  const centre = put('ck-units', { phi: 0, y: CONSOLE.y, r: CONSOLE.r, tilt: CONSOLE.tilt, extra: 0 });
  for (const [id, sign] of [['ck-activity', -1], ['ck-prs', 1]]) {
    let done = false;
    for (let r = SIDE.rFrom; r <= SIDE.rTo && !done; r += SIDE.rStep) {
      for (let phi = SIDE.phiFrom; phi <= SIDE.phiTo; phi += SIDE.phiStep) {
        const rect = put(id, { phi: sign * phi, y: CONSOLE.y, r, tilt: SIDE.tilt, extra: -SIDE.turn * sign * phi });
        const clear = sign > 0 ? rect.left >= centre.right + SPACING.consoleGap * s : rect.right <= centre.left - SPACING.consoleGap * s;
        if (!clear) continue;
        done = sign > 0 ? rect.right <= width - SPACING.edge * s : rect.left >= SPACING.edge * s;
        break;
      }
    }
    if (!done) problems.push(`${id} does not fit beside the centre console`);
  }
  for (const [ids, sign, below] of [[['ck-clock', 'ck-cost'], -1, 'ck-activity'], [['ck-needs', 'ck-status'], 1, 'ck-prs']]) {
    let phi = UPPER.phiFrom;
    let floor = rects[below].top - SPACING.upperAbove * s;
    // The lower panel first, then the one above it.
    for (let k = ids.length - 1; k >= 0; k -= 1) {
      const id = ids[k];
      for (let ph = phi; ph >= UPPER.phiTo; ph -= UPPER.phiStep) {
        const rect = put(id, { phi: sign * ph, y: 0, r: UPPER.r, tilt: 0, extra: -UPPER.turn * sign * ph });
        if (sign < 0 ? rect.left >= SPACING.upperEdge * s : rect.right <= width - SPACING.upperEdge * s) {
          phi = ph;
          break;
        }
      }
      for (let y = UPPER.yFrom; y < UPPER.yTo; y += UPPER.yStep) if (put(id, { ...placements[id], y }).bottom <= floor) break;
      floor = rects[id].top - SPACING.upperGap * s;
    }
  }
  const top = Math.max(SPACING.top * s, TOP_BAND);
  problems.push(...overlapProblems(rects, { width, height, top, edge: 8, clear: 8 * s }));
  // The camera's drift and parallax must never push a panel off the screen, into the top band or into another panel.
  for (const cam of extremePoses()) {
    const moved = Object.fromEntries(Object.entries(placements).map(([id, placement]) => [id, projectPanel(placement, PANELS[id], cam, stage)]));
    for (const problem of overlapProblems(moved, { width, height, top: TOP_BAND, edge: 0, clear: 4 * s })) problems.push(`at the camera's limit, ${problem}`);
  }
  const unique = [...new Set(problems)];
  return { stage, fits: unique.length === 0, reason: unique.length ? 'crowded' : null, placements, rects, problems: unique };
}
