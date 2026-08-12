# Provider contract

Normalize all providers into `packet.schema.json`. Provider-specific commands may collect different raw fields, but review agents must not depend on those shapes.

## Required guarantees

- Bind every packet to an immutable base SHA and head SHA.
- Preserve provider URLs and stable PR identity.
- Preserve changed-file paths, rename origins, diff patches, binary status, and stable line coordinates.
- Record incomplete or truncated content in `limits`.
- Include all three GitHub feedback surfaces or all Azure DevOps PR threads so deduplication does not miss prior feedback.
- Capture current checks, policies, or build signals without treating them as proof that the patch is correct.
- Keep raw provider data in a temporary directory and remove it after the review.

## Canonical operations

| Operation | Read/write | Required behaviour |
| --- | --- | --- |
| Resolve PR | Read | Return unambiguous provider, repository, and PR ID |
| Snapshot | Read | Return base/head SHAs and changed files |
| Requirements | Read | Return explicit PR description and linked work items or issues |
| Existing feedback | Read | Return comments, paths, lines, statuses, and bodies |
| Checks | Read | Return check/policy names and states |
| Recheck head | Read | Return current head SHA immediately before publish |
| Publish | Write | Create only the explicitly approved comments |

## Incomplete data

Stop publication when:

- the head or base SHA is unknown;
- a changed text file has neither a patch nor equivalent base/head content;
- provider pagination failed;
- line positions cannot be associated with the captured head;
- authentication changed during the review.

Binary, generated, vendor, lock, or oversized files may be intentionally excluded when listed in `limits.truncatedFiles` with a reason. Include their metadata in routing so dependency and compatibility risks remain visible.

## Existing thread normalization

Normalize each existing thread with:

- provider thread/comment ID;
- status or resolution state;
- file path and line when available;
- author and body;
- stable provider URL when available;
- extracted `pr-review-graph` fingerprint marker when present.

Include resolved, closed, outdated, dismissed, active, bot-authored, and summary-level feedback. Do not reopen or resolve existing threads. Use them only for context, duplicate suppression, and preview links.
