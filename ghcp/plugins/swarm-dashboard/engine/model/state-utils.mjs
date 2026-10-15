import { oneLine } from '../text.mjs';

/** Caps that keep a session's state small however long its log grows. */
export const LIMITS = Object.freeze({ feed: 120, marks: 400, sent: 40, inbound: 80, taskCompletes: 20, recent: 200, spans: 5000, saves: 50, wakes: 500, subagents: 500 });

export function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/** A feed entry. `source` is the stable id of the event being applied (see eventSource in session-state.mjs). */
export function addFeed(state, at, kind, text) {
  pushBounded(state.feed, { at, kind, text: oneLine(text, 200), source: state.source ?? `${state.id}#${state.lines}` }, LIMITS.feed);
}

export function addMark(state, at, kind, text, status = null) {
  pushBounded(state.marks, { at, kind, text: oneLine(text, 160), status }, LIMITS.marks);
}
