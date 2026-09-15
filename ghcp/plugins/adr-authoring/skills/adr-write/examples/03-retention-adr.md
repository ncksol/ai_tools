# ADR-0003: Propose 30-day application-log retention

- Status: Proposed
- Date: Not provided
- Decision owner: Not provided

## Decision

Propose retaining application diagnostic logs for 30 days. Audit logs and customer
records are outside this decision.

## Context and decision drivers

In this fictional workload, on-call engineers want logs available for a rolling
30-day investigation window. The proposal is not an approved retention policy
or a compliance determination. [Source](03-retention-brief.md)

## Options considered

| Option | Fit to the investigation window | Data retained |
|---|---|---|
| Retain for 14 days | Does not cover the requested 30-day window | Keeps the same logs for less time |
| Retain for 30 days | Covers the requested 30-day window | Keeps the same logs for longer |

## Rationale

Thirty days matches the stated investigation need more closely than 14 days.
The choice is proposed on that basis, not on an unmeasured cost or storage benefit.

## Consequences

- Logs remain available in this store for the proposed 30-day period.
- Older logs will not be available through this store.
- Compared with 14-day retention, the same logs are retained longer. Storage volume
  and cost have not been measured.
- Acceptance and a decision owner have not been supplied.

## Confidence and reconsideration

Decision confidence was not provided. No reconsideration trigger or review deadline
has been agreed. No regulatory requirement was supplied.

## References

- [Fictional retention proposal brief](03-retention-brief.md), the sole source for this example.
