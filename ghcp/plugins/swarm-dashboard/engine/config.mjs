import os from 'node:os';
import path from 'node:path';
import { HOUR, MINUTE } from './time.mjs';

/** Design call 3 thresholds, calibrated on the reference run. All are configurable. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  modelCallWarnMs: 5 * MINUTE,
  modelCallStuckMs: 10 * MINUTE,
  bashExtraMs: 5 * MINUTE,
  bashDefaultMs: 10 * MINUTE,
  readBashExtraMs: 2 * MINUTE,
  readAgentExtraMs: 2 * MINUTE,
  quickToolMs: 2 * MINUTE,
  subagentSilentMs: 10 * MINUTE,
  subagentSilentHeavyMs: 15 * MINUTE,
  silentBusyMs: 10 * MINUTE,
  stalledIdleMs: 30 * MINUTE,
  spinningWindowMs: 30 * MINUTE,
  spinningFailures: 5,
  spinningRepeats: 3,
  spinningCompactions: 2,
  monitorGraceMs: 5 * MINUTE,
  runFinishedAfterMs: 2 * HOUR,
});

export function resolveThresholds(overrides = {}) {
  const result = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!(key in DEFAULT_THRESHOLDS)) throw new Error(`Unknown threshold ${key}`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Threshold ${key} must be a non-negative number`);
    result[key] = value;
  }
  return Object.freeze(result);
}

export function copilotPaths(home = path.join(os.homedir(), '.copilot')) {
  return {
    home,
    dataDb: path.join(home, 'data.db'),
    storeDb: path.join(home, 'session-store.db'),
    stateDir: path.join(home, 'session-state'),
    historyDir: path.join(home, 'swarm-dashboard', 'history'),
  };
}
