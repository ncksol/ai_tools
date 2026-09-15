# Fictional input: propose application-log retention

This is an original fictional example showing nonblocking missing information.

## Request

Draft ADR-0003 for a proposal to retain application diagnostic logs for 30 days.
This is not an accepted decision. Do not infer an owner or decision date.

## Supplied facts

- The intended scope is application diagnostic logs, not audit logs or customer records.
- On-call engineers want logs available for a rolling 30-day investigation window.
  This is the stated driver, not an assertion about incident statistics.
- The proposer considered 14-day retention and 30-day retention.
- The proposed choice is 30 days, because 14 days does not cover the requested
  30-day investigation window.
- Keeping the same logs for 30 rather than 14 days retains them longer. Storage volume
  and cost have not been measured; do not quantify them.
- The proposer knows that logs older than the retention period will not be available
  through this log store.
- No decision owner, proposal date, confidence level, review deadline, approval, or
  regulatory requirement was supplied.
- The proposer wants those unknowns visible. They do not block recording a Proposed
  choice with this known rationale.
- No reconsideration trigger has been agreed.

## Source

This brief is the entire source. Do not claim compliance, acceptance, cost savings,
or an agreed review obligation.
