# Propose Store R for the transactional registry

- Status: Proposed
- Date: Not provided
- Decision owner: Not provided

## Decision

Use Store R rather than file-based metadata for the transactional registry.
Registration must write submission status and its audit event atomically.
The store choice does not select a dispatch mechanism.

## Context and decision drivers

The registry needs atomic registration and queries that join submissions with
validation outcomes. The supplied evaluation reports that Store R supports these
transactions and joins; it was not independently verified.
[Decision evidence](04-registry-brief.md#decision-packet)

## Options considered

| Option | Fit to the requirements | Responsibility added |
|---|---|---|
| Store R | Supports the required transactions and joins in the supplied evaluation | Database operations and schema migrations |
| File-based metadata | Requires application-managed cross-file consistency; join support was not evaluated in the supplied evidence | Application consistency logic |

## Rationale

Store R provides the evaluated transaction and query capabilities. File-based
metadata leaves cross-file consistency to application code. The proposal accepts
database operations and migrations for that fit, not for unmeasured cost or
performance gains.

## Consequences

- Application commands must validate results before changing submission status.
  A completed processing job is not enough to accept a submission.
- Background work must be recoverable after restart. The store choice alone does
  not satisfy this obligation or establish exactly-once processing.
- The team takes on database operations and schema migrations.

The [implementation sketch](04-registry-brief.md#implementation-sketch) describes
proposed dispatch and recovery mechanisms, not additional decisions made here.

## Confidence and reconsideration

Decision confidence and an agreed reconsideration trigger were not provided.
Cost and performance have not been measured. Dispatch by queue or SQL poller and
the rule for reopening rejected submissions versus assigning a new ID remain
undecided.

## References

- [Registry brief](04-registry-brief.md#decision-packet) - supplied requirements,
  evaluation, and tradeoffs.
- [Implementation sketch](04-registry-brief.md#implementation-sketch) - supporting
  mechanics for later design.
