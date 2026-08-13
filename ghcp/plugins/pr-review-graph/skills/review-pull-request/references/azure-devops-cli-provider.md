# Azure DevOps provider: exhaust deterministic access routes

Load and follow the separately installed `azure-devops-cli` skill when available. Use its authentication and default-configuration conventions. Use only deterministic tools: never install extensions, run `az login`, request or mint a PAT, or change a stored default configuration.

## 1. Safety and completeness

A single failed adapter is one result, not proof the PR is inaccessible. Try every available deterministic adapter — CLI, REST, optional MCP, and local Git — before concluding a capability is missing. Code-only access is insufficient, and metadata-only access is insufficient: the review requires a complete read packet covering all nine Azure DevOps capabilities before agent dispatch:

- `identity`
- `metadata`
- `snapshot`
- `workItems`
- `policies`
- `iterations`
- `changes`
- `existingThreads`
- `diff`

Never persist raw provider responses, fragments, or packets inside the project tree; keep them in the `mktemp -d` work directory from Phase 1.

## 2. CLI fast path

Run the collector once with the current environment:

```bash
bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
```

Run it a second time only when `AZURE_DEVOPS_EXT_PAT` is present and the first command failed, with the injected PAT removed so the collector falls back to a stored `az login` context:

```bash
env -u AZURE_DEVOPS_EXT_PAT \
  PRG_AZURE_CREDENTIAL_CONTEXT=stored-az-login \
  bash <SKILL_DIR>/scripts/collect-azure-devops.sh <PR_ID> <PACKET_JSON>
```

Do not print either command's raw authentication error to the user or into any persisted file.

After a failed CLI collector attempt, record a sanitized failure fragment before trying the next adapter:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli current-environment authentication \
  "Azure CLI did not produce a complete PR packet" all \
  <WORK_DIR>/cli-current-failure.json

node <SKILL_DIR>/scripts/assemble-azure-context.mjs failure \
  azure-cli stored-az-login authentication \
  "Azure CLI stored login did not produce a complete PR packet" all \
  <WORK_DIR>/cli-stored-failure.json
```

Use `tool-unavailable` instead of `authentication` when `az` or the Azure DevOps extension is absent.

## 3. REST fragments

Run each configured context independently:

```bash
node <SKILL_DIR>/scripts/collect-azure-devops-rest.mjs \
  <PR_URL> anonymous <WORK_DIR>/rest-anonymous.json

node <SKILL_DIR>/scripts/collect-azure-devops-rest.mjs \
  <PR_URL> pat <WORK_DIR>/rest-pat.json

node <SKILL_DIR>/scripts/collect-azure-devops-rest.mjs \
  <PR_URL> entra <WORK_DIR>/rest-entra.json
```

Skip `pat` when `AZURE_DEVOPS_EXT_PAT` is absent. Skip `entra` when `az account get-access-token` is unavailable. Never prompt for credentials.

## 4. Optional MCP fragments

Inspect the available Azure DevOps tool descriptions before relying on any of them; optional MCP access is a runtime capability, not a plugin dependency. For Bluebird, call `bluebird-metadata` `connection_info` when the organization/project/repository scope is unknown, then call `bluebird-code_history` `pull_request` with the explicit organization, project, repository, PR ID, and the user's original question. Record only facts the tool actually returned.

The current Bluebird PR operation can contribute identity and metadata; it does not prove exact base/target SHAs, complete threads, policies, iteration changes, or pagination. Do not mark a capability complete unless the tool contract and result together provide it. When an attempted MCP operation fails, use assembler `failure` mode with a sanitized message instead of silently omitting the attempt.

Write one Bluebird fragment, `<WORK_DIR>/bluebird.json`, holding every capability the tool actually satisfied. Replace each runtime value only with a value returned by the tool or parsed from the supplied PR URL. This is a shape example illustrating the fabricated fixture used elsewhere in this repository, not hard-coded fallback data:

```json
{
  "schemaVersion": "1.0",
  "source": {
    "adapter": "bluebird",
    "credentialContext": "configured-mcp",
    "capturedAt": "<RFC3339 capture time>"
  },
  "capabilities": {
    "identity": {
      "complete": true,
      "data": {
        "pullRequestId": 77,
        "url": "https://dev.azure.com/fabrikam/Platform/_git/widgets/pullrequest/77",
        "repository": {
          "name": "widgets",
          "webUrl": "https://dev.azure.com/fabrikam/Platform/_git/widgets",
          "project": {
            "name": "Platform"
          }
        }
      }
    },
    "metadata": {
      "complete": true,
      "data": {
        "title": "Require email address",
        "description": "<exact full description returned by Bluebird>",
        "createdBy": {
          "displayName": "Developer"
        },
        "status": "active",
        "isDraft": false,
        "sourceRefName": "refs/heads/email-required",
        "targetRefName": "refs/heads/main",
        "reviewers": [
          {
            "displayName": "Reviewer",
            "vote": 0
          }
        ]
      }
    }
  }
}
```

Omit `workItems` unless the tool returns every linked item's full fields, not just code references or IDs.

## 5. Git diff fragment

After authoritative snapshot SHAs and repository identity exist, reuse the existing collector's `ensure_commit` fetch behavior and:

```bash
git diff --find-renames --no-ext-diff --no-color --unified=80 "$target_sha...$source_sha" >"$diff_patch"
```

Fetch missing commit objects without checkout; never execute changed code. Stop if the local repository does not correspond to the PR or the commit objects cannot be obtained. The diff fragment must prove which repository and exact commits it was generated from: write the repository object already recorded in the identity fragment to `<WORK_DIR>/repository.json`, then wrap the patch together with the exact SHAs used above:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs capability \
  local-git configured-origin diff \
  <WORK_DIR>/repository.json "$target_sha" "$source_sha" \
  <WORK_DIR>/diff.patch <WORK_DIR>/git-diff.json
```

The assembler rejects this fragment before normalization if its repository, base SHA, or head SHA disagree with any other fragment's declared identity or snapshot.

## 6. Assembly

Pass every fragment that exists:

```bash
node <SKILL_DIR>/scripts/assemble-azure-context.mjs packet \
  <PACKET_JSON> \
  <WORK_DIR>/cli-current-failure.json \
  <WORK_DIR>/cli-stored-failure.json \
  <WORK_DIR>/rest-anonymous.json \
  <WORK_DIR>/rest-pat.json \
  <WORK_DIR>/rest-entra.json \
  <WORK_DIR>/bluebird.json \
  <WORK_DIR>/git-diff.json
```

Include only files that exist. For a capability more than one fragment completed, the assembler prefers `azure-cli` and `azure-rest` over hand-transcribed MCP or manual fragments regardless of capture order, and every candidate stays in the attempt ledger. A malformed capability in one fragment — for example a broken `bluebird.json` — is downgraded to an incomplete/malformed entry in that ledger rather than aborting assembly of the other fragments; a fragment too broken to sanitize at all (missing `schemaVersion` or every capability) is dropped and listed in `providerData.access.rejectedFragments`. If the `packet` command exits non-zero, `<PACKET_JSON>` itself now holds a sanitized `assembled: false` failure artifact — `missingCapabilities`, `selectedCapabilities` (sources for capabilities that did complete), the full `attempts` ledger, and `rejectedFragments` — so read that file rather than relying on the printed message alone before stopping. A complete `<PACKET_JSON>` with all nine capabilities is required; code-only access is insufficient even when the diff and changed files are complete.

## Line tracking

Preserve `changeTrackingId` from iteration changes. For an inline thread, include:

- `threadContext.filePath` and right-side line coordinates;
- `pullRequestThreadContext.changeTrackingId` when available;
- `iterationContext.firstComparingIteration` and `secondComparingIteration`.

Move findings without stable coordinates into a general PR thread.

## 7. Head recheck and publication

Use `az repos pr show --id <PR_ID> --output json` for the head recheck when that credential context works, and compare `lastMergeSourceCommit.commitId` with the packet head SHA. When only REST access works, rerun `collect-azure-devops-rest.mjs` with the successful mode and read `capabilities.snapshot.data.lastMergeSourceCommit.commitId` from the new fragment. The current Bluebird PR operation cannot perform the recheck because it does not return the exact provider source SHA.

Recheck immediately before preview and again after confirmation immediately before publication. Refresh the review when the SHAs differ.

Generate payload files with `build-azure-threads.mjs`. Publish each approved file separately, using `--in-file` for generated Markdown, when a CLI write context works:

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

If one thread creation fails, stop and report the successfully created thread IDs before previewing any retry. When no credential context can write, do not block the analysis: preview the findings and state `publication unavailable`.

Do not run `az repos pr set-vote`, update completion settings, abandon, reactivate, or modify the source branch.
