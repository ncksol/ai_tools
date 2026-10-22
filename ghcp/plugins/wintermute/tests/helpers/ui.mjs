import { readFileSync } from 'node:fs';

export const fixture = name => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const EXAMPLE = fixture('example-snapshot.json');
export const NOW = EXAMPLE.generatedAt;
export const exampleSnapshot = () => structuredClone(EXAMPLE);
export function context(snapshot, overrides = {}) {
  return { snapshot, now: NOW, phaseMs: 0, detail: null, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, ...overrides };
}

/** Freeze a value and everything in it, so any code that changes it throws (ES modules run in strict mode). */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The example with D5's PR closed without merging and D5 not archived, as the engine reports it. */
export function closedSnapshot() {
  const snapshot = exampleSnapshot();
  const unit = snapshot.units.find(item => item.label === 'D5');
  const closedAt = NOW - 20 * 60000;
  Object.assign(unit, { stage: 'pr_open', closedWithoutMerge: true, outcome: 'closed', endedAt: closedAt });
  unit.pr = { ...unit.pr, state: 'closed', closedAt };
  unit.monitor = { ...unit.monitor, state: 'ended', nextCheckAt: null, since: null };
  return snapshot;
}
