# Review prompts by trigger

Part of the `strict-code-review` skill. Read the sections whose trigger matches a risky or normal change. They are ideas, not a list to complete; each candidate still goes through "Checking candidates" and "Is it worth raising?".

## Outside input (request, CLI argument, file, message, webhook, model output)

- Reaches a query, command, file path, template, HTML or deserialiser without the project's escaping or validation.
- Empty, missing, duplicate, oversized, malformed or boundary values.

## Sign-in, permissions, tenants, ownership

- A new route or handler lacks the auth its neighbours have.
- The caller can name an object it doesn't own: an ID in a URL, a cache or query not keyed by tenant.
- A default grants access; a check moved, weakened or removed.

## Data that is logged, returned or stored

- Secrets, tokens or personal data in logs, errors or responses.
- A partial failure leaves bad data; a retry writes twice; a job or webhook isn't idempotent.
- A migration breaks the running version or existing rows, or can't be rolled back.
- Wrong cache keys or invalidation; stale reads.

## A changed contract (API, route, CLI flag, config key, schema, event, file format)

- Shape, defaults, status codes or error format changed for existing callers.
- Callers found with `git grep` at the head commit, and documented outside callers, still work.

## State, concurrency, retries, time, errors

- Check-then-act races; retries without backoff or idempotency; missing timeouts; leaked connections or handles.
- Ordering, pagination cursors, time zones.
- Errors swallowed, mapped to the wrong status, or leaving partial state.

## Hot paths and large data

- N+1 or unbounded queries, serial awaits, memory growth, at the realistic data size and after any limit that caps it.

## Frontend

- Effect dependencies and cleanup; user or model text rendered as HTML; hydration mismatches; keyboard access; loading and error states.

## Tests

- A test passes even if the feature is broken: it mocks the code under test, asserts nothing, or skips the path.
- A risky changed path has no test that would fail if it broke, where similar code has such tests.

## Dependencies, build, CI, deployment

- A new dependency: maintained, licence, pinned, lockfile in step.
- New required configuration or environment variables, and unsafe defaults.
- CI or packaging edits that skip or weaken checks, widen workflow permissions, or expose secrets to untrusted code (for example, `pull_request_target`).

## Agent files: skills, agent prompts, instruction files, tool configuration

- A `tools` list or permission widens what an agent can run or access.
- Outside text (PR content, issues, web pages, tool output) can steer the agent, or a safety rule is dropped.
- Rules that must stay in step (text kept the same across files, versions kept equal in several manifests, a rule with copies elsewhere) changed in one place only.
- Frontmatter no longer parses; a linked file no longer exists; the change contradicts the repository's instruction files.

## Optional at most

Logging and metrics for new flows, deployment notes, rollback plans, abstraction, duplication, naming, comments and focus styles give Optional findings at most, and only with a concrete effect.
