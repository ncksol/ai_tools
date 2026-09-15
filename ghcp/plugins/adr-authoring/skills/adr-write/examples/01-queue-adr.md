# ADR-0001: Queue export jobs

- Status: Accepted
- Date: 2026-09-01
- Decision owner: Export team

## Decision

Queue export jobs for a worker and store job status separately. Return a job
identifier only after the job has been durably queued. Queue and hosting product
selection are outside this decision.

## Context and decision drivers

In this fictional workload, users accept a job identifier and status lookup instead
of receiving the export in the initial HTTP response. Export duration varies, so
request completion must not depend on export completion. No latency measurement
or numerical target was supplied. [Source](01-queue-brief.md)

## Options considered

| Option | Fit to the request-completion requirement | Operational responsibility |
|---|---|---|
| Process synchronously in the request handler | Keeps the request tied to export completion | Export work remains in the request handler |
| Queue work for a worker | Separates request completion from export completion | Adds worker deployment, monitoring, retries, and duplicate-job handling |

## Rationale

The queue-and-worker approach matches the users' acceptance of asynchronous results.
Synchronous processing does not meet the requirement to separate the two completion
paths. This decision does not depend on an unmeasured throughput or latency benefit.

## Consequences

- Request handling and export completion are separate operations.
- The team must operate workers, monitor jobs, and handle retries and duplicate jobs.
- Users need a status lookup to track export completion.
- An enqueue failure must produce an error, not a successful response with a job ID.

## Confidence and reconsideration

The team expressed high confidence because users already accept asynchronous
completion. Reconsider this decision if the export must be returned in the initial
response.

## References

- [Fictional export decision brief](01-queue-brief.md), the sole source for this example.
