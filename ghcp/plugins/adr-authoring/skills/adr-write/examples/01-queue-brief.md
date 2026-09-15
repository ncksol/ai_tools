# Fictional input: queue export jobs

This is an original fictional example, not evidence for another workload.

## Request

Write ADR-0001 documenting the following accepted decision.

## Supplied facts

- The Export team accepted this decision on 2026-09-01.
- Users request exports from an HTTP endpoint. They do not need the finished file
  in the response; a job identifier and a way to check its status are acceptable.
- Export duration varies. The team wants request completion to be independent of
  export completion. No latency measurements or target were supplied.
- The team considered processing the export synchronously in the request handler
  and putting a job on a queue for a worker.
- The choice is a queue and worker, with job status stored separately. The queue
  product and worker hosting platform are outside this decision.
- The reason for rejecting synchronous processing is that it keeps the request
  tied to export completion, contrary to the stated driver.
- The team expects independent worker operation to add deployment, monitoring,
  retry, and duplicate-job handling responsibilities.
- The endpoint returns success only after the job has been durably queued. Failed
  enqueue requests must return an error rather than a job identifier.
- The team expressed high confidence because users already accept asynchronous
  completion. It will reconsider if exports must be returned in the initial response.

## Source

This brief is the entire source. Do not add throughput numbers, service guarantees,
cost estimates, or a claim that tests or benchmarks ran.
