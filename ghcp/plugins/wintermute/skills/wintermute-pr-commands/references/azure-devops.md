# Azure DevOps PR commands

Commands for the `az` CLI and its `azure-devops` extension, tested with Azure CLI 2.71.0 and extension 1.0.1. The operating mode in `SKILL.md` applies: these commands grant no permission.

## Context

Set these from the PR URL, the brief or the repository's instructions:

```bash
ADO_ORG='https://dev.azure.com/<organisation>'
ADO_PROJECT='<project name or ID>'
ADO_REPO='<repository ID>'
ADO_PR='<pull request ID>'
```

R1 returns the repository and project IDs. `ADO_THREAD`, `ADO_BUILD` and `ADO_WI` come from the reads below. Pass the organisation on every command, and the project and repository where a command takes them. Don't change the CLI's global defaults for one job.

## Reads (ran)

R1. PR state, draft, source and target, head commit, IDs and votes:

```bash
az repos pr show --id "$ADO_PR" --org "$ADO_ORG" \
  --query '{id:pullRequestId,status:status,merge:mergeStatus,draft:isDraft,source:sourceRefName,target:targetRefName,head:lastMergeSourceCommit.commitId,repository:repository.id,project:repository.project.id,votes:reviewers[].{vote:vote,required:isRequired}}' \
  -o json --only-show-errors
```

R2. Title, description length and completion options:

```bash
az repos pr show --id "$ADO_PR" --org "$ADO_ORG" \
  --query '{id:pullRequestId,title:title,descriptionLength:length(description),options:completionOptions}' \
  -o json --only-show-errors
```

R3. Reviewers, their votes and whether each is required:

```bash
az repos pr reviewer list --id "$ADO_PR" --org "$ADO_ORG" \
  --query '[].{id:id,vote:vote,required:isRequired}' -o json --only-show-errors
```

R4. Policies, their status and the build and commits each one evaluated:

```bash
az repos pr policy list --id "$ADO_PR" --org "$ADO_ORG" \
  --query '[].{id:evaluationId,status:status,enabled:configuration.isEnabled,blocking:configuration.isBlocking,type:configuration.type.displayName,build:context.buildId,expired:context.isExpired,notCurrent:context.buildIsNotCurrent,source:context.lastMergeSourceCommitId,target:context.lastMergeTargetCommitId,preview:context.lastMergeCommitId}' \
  -o json --only-show-errors
```

R5. One build, such as the build a policy names:

```bash
az pipelines build show --id "$ADO_BUILD" --org "$ADO_ORG" --project "$ADO_PROJECT" \
  --query '{id:id,status:status,result:result,sourceVersion:sourceVersion,definition:definition.id}' \
  -o json --only-show-errors
```

R6. Recent builds of the PR's merge ref (discovery only):

```bash
az pipelines build list --org "$ADO_ORG" --project "$ADO_PROJECT" \
  --branch "refs/pull/$ADO_PR/merge" --top 4 \
  --query '[].{id:id,status:status,result:result,sourceVersion:sourceVersion,definition:definition.id}' \
  -o json --only-show-errors
```

R7. All threads, with status and comment count:

```bash
az devops invoke --org "$ADO_ORG" --area git --resource pullRequestThreads \
  --route-parameters project="$ADO_PROJECT" repositoryId="$ADO_REPO" pullRequestId="$ADO_PR" \
  --http-method GET --api-version 7.1 \
  --query 'value[].{id:id,status:status,deleted:isDeleted,commentCount:length(comments)}' \
  -o json --only-show-errors
```

R8. One thread, with its comments and their parent comment IDs:

```bash
az devops invoke --org "$ADO_ORG" --area git --resource pullRequestThreads \
  --route-parameters project="$ADO_PROJECT" repositoryId="$ADO_REPO" pullRequestId="$ADO_PR" threadId="$ADO_THREAD" \
  --http-method GET --api-version 7.1 \
  --query '{id:id,status:status,comments:comments[].{id:id,parent:parentCommentId,type:commentType,deleted:isDeleted,content:content}}' \
  -o json --only-show-errors
```

R9. Labels:

```bash
az devops invoke --org "$ADO_ORG" --area git --resource pullRequestLabels \
  --route-parameters project="$ADO_PROJECT" repositoryId="$ADO_REPO" pullRequestId="$ADO_PR" \
  --http-method GET --api-version 7.1 --query 'value[].name' \
  -o json --only-show-errors
```

R10. Linked work items:

```bash
az repos pr work-item list --id "$ADO_PR" --org "$ADO_ORG" \
  --query '[].{id:id}' -o json --only-show-errors
```

R11. A work item's state and type:

```bash
az boards work-item show --id "$ADO_WI" --org "$ADO_ORG" \
  --query '{id:id,state:fields."System.State",type:fields."System.WorkItemType"}' \
  -o json --only-show-errors
```

### Reading the results

- `mergeStatus` `succeeded` means only that the merge preview worked. It isn't proof that policies, votes and freshness checks pass: read R3 and R4.
- A build policy's context names its build and the source, target and preview commits it evaluated. Read that build with R5. Don't use the latest build on the branch instead: R6 is for discovery only.
- Take a policy's status from R4. A policy can be approved while its build reads `partiallySucceeded`; don't build a general rule from a raw build result.
- R7 also lists system threads, which have no status.

## Writes (verified)

- Before a write, read R1 and check that the PR, its head and its target are what your job expects.
- Make each write once, then read it back. If the result is unclear, read the state again and report it. Don't repeat the write.
- `az devops invoke` with POST works for thread comments and labels. Complete a PR with `az repos pr update`: the `pullRequests` resource of `az devops invoke` accepted only GET in tests.

W1. Reply to an open thread. Check with R8 that the thread is still active: a reply to a closed or resolved thread isn't verified. Write the payload to a file with a JSON encoder, so that quotes and line breaks are escaped: `{"content": "<reply text>", "parentCommentId": <ID of the comment you reply to>, "commentType": 1}`. Read back with R8.

```bash
az devops invoke --organization "$ADO_ORG" --area git --resource pullRequestThreadComments \
  --route-parameters project="$ADO_PROJECT" repositoryId="$ADO_REPO" pullRequestId="$ADO_PR" threadId="$ADO_THREAD" \
  --http-method POST --api-version 7.1 -o json --in-file "$REPLY_JSON"
```

W2. Replace the description. Pass the whole new text, then compare the response with what you sent. A title update isn't verified.

```bash
az repos pr update --id "$ADO_PR" --organization "$ADO_ORG" \
  --description "$DESCRIPTION" --only-show-errors --output json
```

W3. Add a label. The payload file is `{"name": "<label>"}`. Read back with R9.

```bash
az devops invoke --organization "$ADO_ORG" --area git --resource pullRequestLabels \
  --route-parameters project="$ADO_PROJECT" repositoryId="$ADO_REPO" pullRequestId="$ADO_PR" \
  --http-method POST --in-file "$LABEL_JSON" --api-version 7.1 -o json
```

W4. Complete (merge) the PR and keep the source branch:

```bash
az repos pr update --id "$ADO_PR" --organization "$ADO_ORG" \
  --status completed --squash false --delete-source-branch false \
  --transition-work-items false --bypass-policy false -o json
```

- This makes a merge commit (`noFastForward`), keeps the source branch, leaves linked work items' state alone and doesn't bypass policies. Don't change these options without a decision from the user.
- If the repository's instructions require a merge message, add `--merge-commit-message '<message>'`. That option was verified in a completion that also deleted the source branch; it wasn't run together with `--delete-source-branch false`.
- The response can still say `active` while the completion runs. Wait briefly and read back once with R1 and R2. Don't run the completion again because the first response wasn't final.
- Options set to false can read back as `null`, not `false`. Check the outcome instead: status `completed`, merge strategy `noFastForward`, the source branch still on the remote, and linked work items in the state you expect.
- The merge can change a linked work item's revision even when its state stays the same.

W5. Retarget the PR. `az repos pr update` has no option for the target branch. The tested way calls the SDK that the `azure-devops` extension bundles, with the Python that runs `az`. Don't install another SDK, and don't use `az rest` instead.

```bash
PYTHONPATH="$AZ_DEVOPS_EXTENSION_DIR" "$AZ_PYTHON" - <<'PY'
from azext_devops.dev.common.services import get_git_client
from azext_devops.devops_sdk.v5_0.git.models import GitPullRequest
client = get_git_client(organization='<organisation URL>')
change = GitPullRequest(target_ref_name='refs/heads/<new target>')
updated = client.update_pull_request(
    change, repository_id='<repository ID>', pull_request_id=<PR ID>, project='<project>'
)
print(updated.target_ref_name)
PY
```

- `AZ_PYTHON` is the Python inside the Azure CLI installation, and `AZ_DEVOPS_EXTENSION_DIR` is the extension's folder. On the tested Homebrew install they were `<Homebrew prefix>/Cellar/azure-cli/<version>/libexec/bin/python` and `~/.azure/cliextensions/azure-devops`. Find yours; they differ between machines.
- Before: read R1 and check the current target and head. After: read back with R1, then read R4 again, because policy and build results for the old target no longer count.

W6. Change a work item's state, only when your job or the repository's instructions say so. State names come from the project's process: don't assume that `Active` or `Closed` exist.

```bash
az boards work-item update --id "$ADO_WI" --state '<state>' --org "$ADO_ORG" \
  --query '{id:id,state:fields."System.State",assigned:fields."System.AssignedTo".uniqueName}' \
  -o json
```

## Not verified

These operations have no tested command. `SKILL.md` says what to do if your job needs one.

- Votes: approve, reset, reject or wait for the author.
- Re-queueing a policy build. Queueing, retrying or cancelling a pipeline run, which is a different thing from re-evaluating a PR policy.
- A reply to a closed or resolved thread, and any change to a thread's status.
- A title update.
- Adding or removing a reviewer, or changing whether a reviewer is required.
- Removing a label.
- Completing with other options: squash, rebase, fast-forward, moving work items on, or bypassing policies.
- Work-item states or reasons beyond a plain state change in the project's own process.
