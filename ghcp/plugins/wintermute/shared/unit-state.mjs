/**
 * It closed without merging (its PR closed, or the registry outcome is closed, with or without a PR): it stays in its
 * stage, with a badge (approved decision 5), archived or not.
 */
export const closedNotMerged = unit => Boolean(unit.closedWithoutMerge && unit.stage !== 'archived' && (unit.pr?.state === 'closed' || unit.outcome === 'closed'));

/**
 * The unit is archived: its status says so, or its timeline has the archived mark, which the engine always keeps. Its
 * status and stage show its outcome when one is known (merged, failed), so they cannot tell on their own.
 */
export const isArchived = unit => unit.status === 'archived' || Boolean(unit.timeline?.marks?.some(mark => mark.kind === 'archived'));

/** Details that end a unit's work, a stop with no outcome included. */
const FINISHED_DETAILS = new Set(['stopped', 'merged', 'completed', 'failed', 'crashed', 'cancelled']);

/**
 * The done rule: an idle unit whose latest report is complete and that has no PR still open (none, merged or closed) has
 * done its job, whether or not it wrote code. A PR whose state is not known keeps it active. It turns busy again, and
 * comes back to the grid, if it is given more work.
 */
export const isDone = unit => unit.status === 'idle' && unit.report?.status === 'complete'
  && (!unit.pr || unit.pr.state === 'merged' || unit.pr.state === 'closed');

/** A unit that goes to the Finished section, unless it has an open question or plan of its own (`asking`). */
export function isFinished(unit, asking) {
  if (asking.has(unit.id)) return false;
  return FINISHED_DETAILS.has(unit.statusDetail) || unit.status === 'merged' || unit.status === 'done' || closedNotMerged(unit) || isDone(unit);
}
