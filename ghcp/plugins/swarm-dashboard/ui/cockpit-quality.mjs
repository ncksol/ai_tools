/** How often the cockpit draws, and how much: the quality setting, the frame cap and the adaptive resolution. */
export const FPS_CAP = 30;
export const QUALITIES = Object.freeze(['high', 'balanced']);
export const STORE_KEY = 'swarm-dashboard:cockpit';
/** After the pointer moves, Balanced draws the black hole every frame for this long. */
export const POINTER_MS = 1200;
export const SCALE_MIN = 0.5;
export const SCALE_STEP = 0.1;
const CHECK_EVERY = 30;
const WARM_UP = 90;
const SAMPLES = 60;
const KEEP = 90;

/** The quality to use: a valid one in the address (for checks), else the one remembered in this browser, else High. */
export function readQuality(getStorage, param) {
  if (QUALITIES.includes(param)) return param;
  try {
    const saved = JSON.parse(getStorage().getItem(STORE_KEY) ?? 'null');
    return QUALITIES.includes(saved?.quality) ? saved.quality : 'high';
  } catch {
    return 'high';
  }
}

export function saveQuality(getStorage, quality) {
  try {
    getStorage().setItem(STORE_KEY, JSON.stringify({ quality }));
  } catch {
    // Storage can be unavailable; the choice then lasts until the page closes.
  }
}

/** Whether an animation frame is due under the cap; 2 ms early is fine, because frames land on display refreshes. */
export const frameDue = (now, last) => last === null || now - last >= 1000 / FPS_CAP - 2;

/** Whether a frame redraws the black hole; frames that do not reuse the last one, turned to the current camera. */
export const drawsHole = (quality, frame, now, pointerAt) => quality === 'high' || frame % 2 === 0 || now - pointerAt < POINTER_MS;

export const loopRuns = ({ hidden, reduced }) => !hidden && !reduced;

/** Lowers the black hole's resolution while the frame rate stays under 90% of the cap. frame() returns a new scale or null. */
export function createAdaptive({ cap = FPS_CAP } = {}) {
  let scale = 1;
  let frames = 0;
  const intervals = [];
  return {
    get scale() {
      return scale;
    },
    frame(intervalMs) {
      frames += 1;
      if (intervalMs !== null) {
        intervals.push(intervalMs);
        if (intervals.length > KEEP) intervals.shift();
      }
      if (frames % CHECK_EVERY !== 0 || frames <= WARM_UP || intervals.length < SAMPLES || scale <= SCALE_MIN) return null;
      const fps = 1000 / (intervals.reduce((sum, value) => sum + value, 0) / intervals.length);
      if (fps >= cap * 0.9) return null;
      scale = Math.max(SCALE_MIN, Math.round((scale - SCALE_STEP) * 100) / 100);
      intervals.length = 0;
      return scale;
    },
    /** After a pause, so time spent hidden does not count as slow frames. */
    reset() {
      intervals.length = 0;
    },
  };
}
