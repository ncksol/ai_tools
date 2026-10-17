/**
 * Where the panels go for a window size. A console arc sits below the window: the units console straight ahead and the
 * activity and PR consoles turned out to each side, at the smallest angle that leaves the console gap. Above each side
 * console a stack of two upper panels is pushed as far out as the window's edge allows. Gaps are found by bisection, so
 * they are exact and match on both sides. Everything is design px, scaled with the stage; the browser check runs
 * overlapProblems() again on the real page.
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
 * Gaps in design px: between consoles; from every panel to the window's side edges at every camera pose (the camera
 * reaches about 50 px at the pointer's corner, more for panels turned far out); above the consoles; inside a stack; and
 * the stacks' top line.
 */
export const SPACING = Object.freeze({ consoleGap: 32, edge: 8, upperAbove: 24, upperGap: 16, top: 64 });
/** Window px under the flat top line and the quality switch (16 px from the top, 24 px tall, 8 px clear). */
export const TOP_BAND = 48;
const CONSOLE = Object.freeze({ r: 860, y: -236, tilt: 12 });
const SIDE = Object.freeze({ tilt: 8, turn: 0.5, rFrom: 940, rTo: 1300, rStep: 40, phiFrom: 14, phiTo: 60 });
const UPPER = Object.freeze({ r: 1180, turn: 0.75, phiFrom: 44, phiTo: 16, yFrom: -300, yTo: 700 });

const POSES = Object.freeze([REST, ...extremePoses()]);
const overlap = (a, b, clear) => a.left < b.right + clear && b.left < a.right + clear && a.top < b.bottom + clear && b.top < a.bottom + clear;

/** Where `ok` turns from false to true in [lo, hi] (ok is false below that point and true from it on); null if ok(hi) is false. */
function firstTrue(lo, hi, ok) {
  if (!ok(hi)) return null;
  if (ok(lo)) return lo;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
/** Where `ok` turns from true to false in [lo, hi]; null if ok(lo) is false. */
function lastTrue(lo, hi, ok) {
  const value = firstTrue(-hi, -lo, x => ok(-x));
  return value === null ? null : -value;
}

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
  /** A panel's least room to the window's side edge (the left one when sign < 0) over the camera's whole range. */
  const room = (id, placement, sign) => Math.min(...POSES.map(cam => {
    const rect = projectPanel(placement, PANELS[id], cam, stage);
    return sign < 0 ? rect.left : width - rect.right;
  }));
  const problems = [];
  const centre = put('ck-units', { phi: 0, y: CONSOLE.y, r: CONSOLE.r, tilt: CONSOLE.tilt, extra: 0 });
  for (const [id, sign] of [['ck-activity', -1], ['ck-prs', 1]]) {
    const placement = (r, phi) => ({ phi: sign * phi, y: CONSOLE.y, r, tilt: SIDE.tilt, extra: -SIDE.turn * sign * phi });
    const clear = rect => (sign > 0 ? rect.left - centre.right : centre.left - rect.right) >= SPACING.consoleGap * s;
    let done = false;
    for (let r = SIDE.rFrom; r <= SIDE.rTo && !done; r += SIDE.rStep) {
      // The smallest turn that leaves exactly the console gap; further back if the camera could then push it off the screen.
      const phi = firstTrue(SIDE.phiFrom, SIDE.phiTo, value => clear(put(id, placement(r, value))));
      if (phi !== null) {
        put(id, placement(r, phi));
        done = room(id, placement(r, phi), sign) >= SPACING.edge * s;
      }
    }
    if (!done) problems.push(`${id} does not fit beside the centre console`);
  }
  for (const [ids, sign, below] of [[['ck-clock', 'ck-cost'], -1, 'ck-activity'], [['ck-needs', 'ck-status'], 1, 'ck-prs']]) {
    let widest = UPPER.phiFrom;
    let floor = rects[below].top - SPACING.upperAbove * s;
    // The lower panel first, then the one above it.
    for (let k = ids.length - 1; k >= 0; k -= 1) {
      const id = ids[k];
      const placement = (phi, y) => ({ phi: sign * phi, y, r: UPPER.r, tilt: 0, extra: -UPPER.turn * sign * phi });
      const place = (phi, y) => put(id, placement(phi, y));
      // As far out as the camera's range allows and no further out than the panel below, then as low as leaves exactly
      // the gap to the panel below. The camera's reach depends a little on the height, so a second pass checks the turn
      // again at the height the first pass found.
      let phi = null;
      let y = 0;
      for (let pass = 0; pass < 2 && y !== null; pass += 1) {
        const at = y;
        phi = lastTrue(UPPER.phiTo, widest, value => room(id, placement(value, at), sign) >= SPACING.edge * s);
        if (phi === null) break;
        y = firstTrue(UPPER.yFrom, UPPER.yTo, value => place(phi, value).bottom <= floor);
      }
      if (phi === null) {
        problems.push(`${id} does not fit inside the window's edge`);
        break;
      }
      if (y === null) {
        problems.push(`${id} does not fit above ${below}`);
        break;
      }
      widest = phi;
      floor = place(phi, y).top - SPACING.upperGap * s;
    }
  }
  const top = Math.max(SPACING.top * s, TOP_BAND);
  problems.push(...overlapProblems(rects, { width, height, top, edge: 8, clear: 8 * s }));
  // The camera's drift and parallax must never push a panel off the screen, into the top band or into another panel.
  for (const cam of extremePoses()) {
    const moved = Object.fromEntries(Object.entries(placements).map(([id, placement]) => [id, projectPanel(placement, PANELS[id], cam, stage)]));
    for (const problem of overlapProblems(moved, { width, height, top: TOP_BAND, edge: 4 * s, clear: 4 * s })) problems.push(`at the camera's limit, ${problem}`);
  }
  const unique = [...new Set(problems)];
  return { stage, fits: unique.length === 0, reason: unique.length ? 'crowded' : null, placements, rects, problems: unique };
}
