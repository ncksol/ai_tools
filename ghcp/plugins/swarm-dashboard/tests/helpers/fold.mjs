import { applyLine, createSessionState } from '../../engine/model/session-state.mjs';

/** Fold an EventLog through the reducer, line by line, as the engine does. */
export function fold(log, id = 'cli-1', options) {
  const state = createSessionState(id, options);
  for (const line of log.lines().trim().split('\n')) applyLine(state, line);
  return state;
}
