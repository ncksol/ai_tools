# ADR-0002: Retain a single write region

- Status: Accepted
- Date: 2026-09-03
- Decision owner: Inventory team

## Decision

Retain one write region and recover through the existing backup and restore process.
Document the restore procedure and run a timed recovery exercise before treating
the recovery targets as demonstrated.

## Context and decision drivers

This fictional workload already uses one write region and backups. The business
accepts a recovery target of four hours of downtime and up to 24 hours of data loss
for a regional failure. The team has not designed conflict handling for active-active
writes. [Source](02-region-brief.md)

## Options considered

| Option | Work required | Recovery tradeoff |
|---|---|---|
| Retain one write region | Document and exercise the existing restore process | A regional failure can cause downtime and loss of writes since the recoverable backup |
| Introduce active-active writes | Design cross-region conflict handling | Recovery behavior was not evaluated in the supplied evidence |

## Rationale

The accepted recovery requirements do not currently justify adding conflict-handling
design work. Retaining the current topology avoids that work while the team evaluates
its existing restore process. This rationale does not establish that the recovery
targets have already been met.

## Consequences

- Regional failures remain a source of downtime and possible data loss.
- The team must document the restore procedure and run the assigned recovery exercise.
- The team defers active-active conflict-handling design.
- There is no measured recovery duration or comparative cost result in the evidence.

## Confidence and reconsideration

The team expressed medium confidence pending the recovery exercise. Reconsider if
the exercise cannot meet the targets, or if the business requires a shorter downtime
or data-loss window.

## References

- [Fictional regional recovery brief](02-region-brief.md), the sole source for this example.
