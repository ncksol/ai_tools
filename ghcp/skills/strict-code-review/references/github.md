# GitHub PR adapter

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies. Quoted section names, such as "Base and head commits", are sections of `SKILL.md`.

For GitHub PRs, prefer GitHub CLI.

Use the PR URL directly where possible. `<OWNER>`, `<REPO>` and `<NUMBER>` come from the URL. If you have only a PR number, run `gh pr view <NUMBER> --json url` in the repository and use the URL it prints.

Gather PR metadata:

```bash
gh pr view <PR_URL> --json number,title,body,baseRefName,baseRefOid,headRefName,headRefOid,headRepository,headRepositoryOwner,files,commits,statusCheckRollup,reviews,comments,url
```

`headRefOid` is the head commit, `<HEAD_SHA>`. Review that commit and no other. Do not use `baseRefOid` as the base commit: GitHub does not update it every time the base branch moves.

Run `git --no-optional-locks status --short` and `git remote -v`, and find the remote that points at `<OWNER>/<REPO>`. In a fork workflow this is often `upstream`, not `origin`. If one matches, fetch the PR head and the base branch from it:

```bash
git fetch <REMOTE> refs/pull/<NUMBER>/head
git rev-parse FETCH_HEAD
git fetch <REMOTE> refs/heads/<baseRefName>
git rev-parse FETCH_HEAD
```

The first `git rev-parse FETCH_HEAD` must print `<HEAD_SHA>`; if it does not, the PR changed after `gh pr view`, so start again. The second prints `<BASE_SHA>`, the current tip of the base branch. Then follow "Base and head commits". `git diff --name-only <BASE_SHA>...<HEAD_SHA>` should list the same files as `gh pr diff <PR_URL> --name-only`; if it does not, say which files differ. To check the commits again before you report, run:

```bash
gh pr view <PR_URL> --json baseRefName,headRefOid
git ls-remote <REMOTE> refs/heads/<baseRefName> refs/pull/<NUMBER>/head
```

If no remote matches, the current directory is not a clone of this repository, so do not fetch into it. Review GitHub’s net diff instead. Do not use `--patch`: it prints one patch per commit, not the net change of the PR.

```bash
DIFF=$(gh pr diff <PR_URL>) && printf '%s\n' "$DIFF" | git hash-object --stdin && printf '%s\n' "$DIFF"
gh pr view <PR_URL> --json baseRefName,headRefOid
```

Run the first line as one command. It stops if `gh pr diff` fails; otherwise it prints the hash of the diff and then the diff itself, so the hash identifies exactly what you review. Do not treat a failed retrieval as an empty PR. If the second command does not print the `baseRefName` and `<HEAD_SHA>` from your first `gh pr view`, the PR changed while you fetched the diff: start again. Report `<HEAD_SHA>` and the hash; the base and merge-base commits are `unavailable`. The old side of this diff is the merge base. Read other files at the head commit:

```bash
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/<OWNER>/<REPO>/contents/<path>?ref=<HEAD_SHA>'
```

Before you report, run `DIFF=$(gh pr diff <PR_URL>) && printf '%s\n' "$DIFF" | git hash-object --stdin` and `gh pr view <PR_URL> --json baseRefName,headRefOid` again. If the hash, the base branch or the head commit changed, start again. If they change again, report the commits you reviewed and say that the PR has changed since. If either command fails, say that you could not check the PR again.

If a fetch or `git merge-base` fails, use the steps for a directory that is not a clone. If you cannot read files at the head commit either, review the checked `gh pr diff` output and list under `Not verified` the surrounding code you could not read.
