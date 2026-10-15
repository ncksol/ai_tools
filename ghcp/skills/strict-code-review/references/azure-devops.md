# Azure DevOps PR adapter

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies. Quoted section names, such as "Base and head commits", are sections of `SKILL.md`.

For Azure DevOps PRs, prefer Azure CLI with the Azure DevOps extension.

Extract the PR ID from the URL segment after `/pullrequest/`.

For a URL like:

```text
https://dev.azure.com/org/project/_git/repo/pullrequest/123
```

the PR ID is:

```text
123
```

Take the organisation, project and repository from the URL. Do not rely on `az devops configure` defaults or on detection from the current Git remote: PR IDs are unique only within an organisation, so another organisation can return a different PR with the same ID. If you have only a PR ID, build the URL from the remote that points at Azure DevOps (`git remote -v`).

For `dev.azure.com` URLs:

```text
https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>
```

the organisation URL, `<ORG_URL>`, is `https://dev.azure.com/<org>`. For `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>/pullrequest/<id>` URLs, it is also `https://dev.azure.com/<org>`. URL-decode `<project>` and `<repo>` (for example, `%20` becomes a space).

Start every `az` command with `AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no` (see “Running code, network and credentials”), and first check that the Azure DevOps extension is installed:

```bash
AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no az extension show --name azure-devops --output none
```

If this fails, do not install the extension. Report `Review incomplete`, list the command and its error under `Failed commands`, and say under `Needed to finish` that the review needs the Azure DevOps extension for Azure CLI (`az extension add --name azure-devops`).

Pass `--org <ORG_URL> --detect false` to every `az repos pr` command. The three commands below do not accept `--project`; do not pass it.

Gather PR metadata, linked work items and policy status:

```bash
AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no az repos pr show --id <PR_ID> --org <ORG_URL> --detect false --output json
AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no az repos pr work-item list --id <PR_ID> --org <ORG_URL> --detect false --output json
AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no az repos pr policy list --id <PR_ID> --org <ORG_URL> --detect false --output json
```

Check that `repository.name` and `repository.project.name` in the `show` result match `<repo>` and `<project>` from the URL, ignoring case. If they do not, stop, report the mismatch and use `Review incomplete`: this is not the PR the user asked for.

From `az repos pr show`, identify:

- `sourceRefName`
- `targetRefName`
- `forkSource`, if present
- PR title
- PR description
- repository
- reviewers
- status

In the report, shorten branch refs (`refs/heads/main` becomes `main`). Use the full ref names in Git commands.

Get the diff from Git, without switching the user’s branch. Do not use `az repos pr checkout`: before it checks out the branch, it asks Azure DevOps to mark the source branch as one of your favourites, which is a write to the service. `az repos` has no command that prints the PR diff.

Run `git --no-optional-locks status --short` and `git remote -v`, and find two remotes before you fetch anything:

- `<BASE_REMOTE>` points at the PR’s repository. Its URL names the same organisation, project and repository, for example `dev.azure.com/<org>/<project>/_git/<repo>`, `<org>.visualstudio.com/<project>/_git/<repo>`, or `v3/<org>/<project>/<repo>` over SSH. Names in remote URLs may be URL-encoded.
- `<HEAD_REMOTE>` is the same remote, unless `forkSource` is present. Then it must point at the fork’s repository, `forkSource.repository`.

```bash
git fetch <BASE_REMOTE> <targetRefName>
git rev-parse FETCH_HEAD
git fetch <HEAD_REMOTE> <sourceRefName>
git rev-parse FETCH_HEAD
```

The first `git rev-parse FETCH_HEAD` prints `<BASE_SHA>` and the second prints `<HEAD_SHA>`. Then follow "Base and head commits". To check the commits again before you report, run:

```bash
AZURE_EXTENSION_USE_DYNAMIC_INSTALL=no az repos pr show --id <PR_ID> --org <ORG_URL> --detect false --query "[targetRefName, sourceRefName]" --output json
git ls-remote <BASE_REMOTE> <targetRefName>
git ls-remote <HEAD_REMOTE> <sourceRefName>
```

If a remote is missing, do not add one, and do not fetch. If a remote is missing or a fetch fails, you cannot see the code, so do not review the metadata alone. Report `Review incomplete`, list the failed step under `Failed commands`, and ask for a local clone with the needed remotes, or a pasted diff.
