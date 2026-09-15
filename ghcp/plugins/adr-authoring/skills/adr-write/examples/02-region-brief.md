# Fictional input: retain a single write region

This is an original fictional example, not an Azure service recommendation.

## Request

Write ADR-0002 recording the accepted choice and its recovery tradeoff.

## Supplied facts

- The Inventory team accepted the decision on 2026-09-03.
- The workload currently writes in one region and uses backups for recovery.
- The business has accepted recovery targets of four hours of downtime and up to
  24 hours of data loss for a regional failure. These are targets, not observed results.
- The team considered retaining the single write region with a documented restore
  procedure, or introducing active-active regional writes.
- It chose to retain the single write region. The team has not designed conflict
  handling for active-active writes and does not want to add that work under the
  current recovery requirements.
- This choice leaves regional outages as a source of downtime and possible loss
  of writes since the recoverable backup.
- The existing backup and restore process still needs a timed recovery exercise.
  The team assigned itself that exercise; no completion date or result was supplied.
- No comparative costs, service-level guarantees, or measured recovery duration
  were supplied.
- The team expressed medium confidence pending the recovery exercise.
- It will reconsider if the exercise cannot meet the targets or if the business
  tightens the allowable downtime or data-loss window.

## Source

This brief is the entire source. Do not claim the present design meets its recovery
targets, or claim that active-active necessarily eliminates downtime or data loss.
