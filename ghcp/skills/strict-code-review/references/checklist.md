# Review checklist

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies.

## Correctness and logic

Check for:

- incorrect business logic
- wrong conditions
- missing branches
- bad defaults
- off-by-one errors
- incorrect state transitions
- null or undefined handling bugs
- incorrect assumptions about data shape
- regressions against existing behaviour
- broken control flow
- swallowed errors
- incorrect feature flag behaviour

## Edge cases

Check for:

- empty input
- missing input
- malformed input
- duplicate input
- large input
- paginated data
- boundary values
- unusual ordering
- retries
- repeated requests
- partial failures
- time zones
- daylight saving time
- concurrency
- race conditions

## Security and privacy

Check for:

- missing authentication
- missing authorisation
- broken ownership checks
- broken tenancy isolation
- privilege escalation
- SQL injection
- command injection
- XSS
- template injection
- path traversal
- unsafe deserialisation
- unsafe HTML rendering
- secrets in logs
- tokens in errors
- credentials in client responses
- PII leakage
- overly broad permissions
- insecure defaults

## Data and persistence

Check for:

- unsafe migrations
- backwards-incompatible schema changes
- missing indexes for new query patterns
- N+1 queries
- unbounded queries
- missing transaction boundaries
- partial-failure data corruption
- duplicate writes
- non-idempotent webhook or job handling
- incorrect retry behaviour
- stale reads
- cache invalidation bugs
- data loss during rollback

## API and contract compatibility

Check for:

- request shape changes
- response shape changes
- backwards compatibility breaks
- wrong HTTP status codes
- inconsistent error formats
- missing validation
- server/client type mismatches
- undocumented breaking changes
- versioning issues
- changes that break existing consumers

## Resilience and operations

Check for:

- missing timeouts
- missing cancellation
- retry storms
- no fallback path
- poor failure behaviour
- connection leaks
- file handle leaks
- memory leaks
- missing resource cleanup
- insufficient logging
- unsafe logging
- missing metrics or traces for important new flows
- operational blind spots
- poor behaviour when dependencies fail

## Performance

Check for:

- hot-path inefficiencies
- unnecessary serial awaits
- blocking work
- excessive database calls
- repeated expensive computation
- memory growth
- inefficient data fetching
- excessive payload size
- excessive frontend re-renders
- cache misuse
- changes that will not scale with realistic data volume

## Frontend-specific issues

Where applicable, check for:

- invalid React hook usage
- incorrect effect dependencies
- missing effect cleanup
- redundant or inconsistent state
- unsafe rendering of user-generated or AI-generated content
- SSR/client boundary mistakes
- hydration issues
- accessibility regressions
- broken keyboard navigation
- missing focus states
- incorrect ARIA usage
- poor loading or error states
- stale client cache behaviour

## Test quality

Check for:

- missing tests for changed behaviour
- missing negative tests
- missing boundary tests
- missing regression tests
- missing error-path tests
- missing auth/authz tests
- missing migration tests
- missing concurrency or idempotency tests
- tests that only verify implementation details
- tests that would pass even if the feature were broken
- flaky tests due to timing, randomness, network, or ordering
- untested production-critical paths

## Maintainability and simplicity

Check for:

- unnecessary abstraction
- duplicate logic
- ignoring existing helper functions
- broad changes unrelated to the PR intent
- unclear ownership boundaries
- confusing control flow
- excessive coupling
- over-engineering
- hand-rolled logic where a project primitive already exists
- changes that make future bugs more likely

## Dependencies and deployment safety

Check for:

- new dependency risk
- licence risk
- supply-chain risk
- incompatible dependency versions
- config changes
- environment variable changes
- missing deployment notes
- missing rollback plan for risky changes
- feature flag concerns
- build or packaging changes
- CI/CD compatibility
- infrastructure drift
