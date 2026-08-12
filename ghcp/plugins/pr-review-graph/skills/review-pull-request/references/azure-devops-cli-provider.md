# Azure DevOps provider through `azure-devops-cli`

Load and follow the separately installed `azure-devops-cli` skill before running Azure commands. Use its authentication and default-configuration conventions. Do not use an Azure DevOps MCP server, install extensions, or request a PAT.

## Collection

Prefer `scripts/collect-azure-devops.sh`. Its core reads are:

```bash
az repos pr show --id <PR_ID> --output json
az repos pr work-item list --id <PR_ID> --output json
az repos pr policy list --id <PR_ID> --output json
```

Use the generic REST bridge for iterations, changes, and threads:

```bash
az devops invoke \
  --area git \
  --resource pullRequestIterations \
  --route-parameters project=<PROJECT_ID> repositoryId=<REPOSITORY_ID> pullRequestId=<PR_ID> \
  --api-version 7.1 \
  --output json
```

```bash
az devops invoke \
  --area git \
  --resource pullRequestIterationChanges \
  --route-parameters project=<PROJECT_ID> repositoryId=<REPOSITORY_ID> pullRequestId=<PR_ID> iterationId=<ITERATION_ID> \
  --query-parameters '$compareTo=0' '$top=2000' \
  --api-version 7.1 \
  --output json
```

```bash
az devops invoke \
  --area git \
  --resource pullRequestThreads \
  --route-parameters project=<PROJECT_ID> repositoryId=<REPOSITORY_ID> pullRequestId=<PR_ID> \
  --api-version 7.1 \
  --output json
```

Pass every returned thread to deduplication, including active, fixed, closed, `wontFix`, `byDesign`, outdated, and general PR threads. Do not filter by author or status.

Use the current local Git repository to produce the full unified diff between the captured target and source commit SHAs. Fetch missing commit objects without checkout; never execute changed code. Stop if the repository does not correspond to the PR or the commit objects cannot be obtained.

## Line tracking

Preserve `changeTrackingId` from iteration changes. For an inline thread, include:

- `threadContext.filePath` and right-side line coordinates;
- `pullRequestThreadContext.changeTrackingId` when available;
- `iterationContext.firstComparingIteration` and `secondComparingIteration`.

Move findings without stable coordinates into a general PR thread.

## Snapshot integrity

Re-run `az repos pr show --id <PR_ID> --output json` immediately before publication and compare `lastMergeSourceCommit.commitId` with the packet head SHA. Refresh the review when they differ.

## Publication

Generate payload files with `build-azure-threads.mjs`. Publish each approved file separately:

```bash
az devops invoke \
  --area git \
  --resource pullRequestThreads \
  --route-parameters project=<PROJECT_ID> repositoryId=<REPOSITORY_ID> pullRequestId=<PR_ID> \
  --http-method POST \
  --in-file <THREAD_PAYLOAD_JSON> \
  --api-version 7.1 \
  --output json
```

Always use `--in-file` for generated Markdown. If one thread creation fails, stop and report the successfully created thread IDs before previewing any retry.

Do not run `az repos pr set-vote`, update completion settings, abandon, reactivate, or modify the source branch.
