# Fictional input: a registry choice with excess context

## About this example

This original fictional packet contains both decision evidence and background.
Source identifiers below are not file paths or URLs. The implementation-sketch
section is the available supporting material; the paired ADR links there rather
than inventing a path to N. This paragraph describes the example, not its evidence.

## Request

Draft a Proposed ADR for the Registry team's transactional registry choice.
The audience is project-aware architecture reviewers. Include what they need to
assess the choice.

## Decision packet

- The Registry team proposes Store R rather than file-based metadata.
- Registration must write submission status and its audit event atomically.
- Relational queries must join submissions and validation outcomes.
- A job completing does not imply submission acceptance. Application commands
  validate results before status changes.
- Background work must be recoverable after restart.
- Store R supports the required transactions and joins according to the supplied
  evaluation. This result was not independently verified.
- File metadata requires application-managed cross-file consistency.
- Store R adds database operations and schema migrations.
- Cost and performance are not measured. Exactly-once processing is not established.
- Whether rejected submissions reopen or require a new ID is undecided.
- A queue or SQL poller for dispatch is not chosen.
- The decision date, decision owner, confidence, and reconsideration trigger were
  not provided. The proposing team is not necessarily the decision owner.

## Project baseline P

Tenant setup is incomplete. Development runs in Region North. Production residency
and recovery-copy permission are undecided. Bulk and repeat submissions are required;
continuous ingestion is deferred. Neither store candidate is ruled out by deployment
geography, and the registry choice does not select deployment location.

## Discovery map D

Unapproved research suggests a future dataset catalog and browsing journeys. It does
not establish delivery scope and is not a driver for the registry choice.

## Implementation sketch

Sketch I contains proposed ideas: request fingerprints, concurrency tokens, a saved
work row before dispatch, an optional outbox plus queue versus database polling,
receiver deduplication, bounded retries, and reconciliation after restore. These are
not all approved mechanisms.

Existing design note N owns these ideas. Its contents have not been separately
inspected; only this summary was supplied. No additional file is requested.
