# Local-only branch adapter

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies. Quoted section names, such as "Base and head commits", are sections of `SKILL.md`.

Use this adapter when the user names a local branch or asks you to review the current branch. Use any title, description or intent that the user gives you as the PR metadata.

Start with:

```bash
git --no-optional-locks status --short
git branch --show-current
git remote -v
```

Use full ref names, such as `refs/heads/<name>` or `refs/remotes/<REMOTE>/<name>`, so that a tag with the same name is never used instead.

Set the head, `<HEAD_REF>`:

- If the user named a branch, use `refs/heads/<name>`, even when another branch is checked out. Check it with `git rev-parse --verify refs/heads/<name>`. If there is no local branch with that name, list remote-tracking branches with `git branch -r --list '*/<name>'`. If exactly one matches, use it and say so; if several match, ask which one. If none matches, check the remote with `git ls-remote --heads <REMOTE> refs/heads/<name>`; if it has the branch, refresh it (see below) and use `refs/remotes/<REMOTE>/<name>`.
- If the user asked you to review the current branch, use `HEAD`.

`<BRANCH>` is the head branch’s name. `<REMOTE>` is the remote for the repository you merge into: `upstream` in a fork workflow, otherwise usually `origin`. Set the base, `<BASE_REF>`, from the first of these that applies:

1. the base branch the user named, as `refs/heads/<name>` or `refs/remotes/<REMOTE>/<name>`, whichever exists. If both exist and point at different commits, refresh the remote one (see below), then use whichever contains the other (`git merge-base --is-ancestor <A> <B>` succeeds when `<B>` contains `<A>`). If they have diverged, ask which one to use.
2. the target branch of an open PR from `<BRANCH>`, if exactly one open PR has `<BRANCH>` as its source branch and that PR’s head commit is in the head’s history (`git merge-base --is-ancestor <PR head commit> <HEAD_REF>` succeeds). GitHub: `gh pr list --head <BRANCH> --state open --json baseRefName,headRefOid,url`. Azure DevOps: `az repos pr list --source-branch <BRANCH> --status active --org <ORG_URL> --project <PROJECT> --repository <REPO> --detect false --output json`, with the names taken from the remote URL; the PR’s head commit is `lastMergeSourceCommit.commitId`. Use the remote-tracking ref of the remote that points at the PR’s repository.
3. the default branch of `<REMOTE>`: `git ls-remote --symref <REMOTE> HEAD` prints it as `ref: refs/heads/<name>`, so use `refs/remotes/<REMOTE>/<name>`. If the remote cannot be reached, `git symbolic-ref refs/remotes/<REMOTE>/HEAD` prints the last known value as a full ref; use it as it is.
4. a local `main` or `master` branch
5. otherwise, ask the user for the base branch

The head branch’s own upstream (for example, `origin/<BRANCH>`) is not a base: a diff against it shows only unpushed commits.

If the repository has no remote, use local branches and do not fetch. Before you use a remote branch as the head or the base, refresh its remote-tracking ref with an explicit refspec. The full source name means that a tag with the same name is never fetched instead, and the destination creates the ref even in a single-branch clone:

```bash
git fetch <remote> +refs/heads/<name>:refs/remotes/<remote>/<name>
```

If the fetch fails, say so and use the ref you have.

Record the two commits:

```bash
git rev-parse <BASE_REF> <HEAD_REF>
```

It prints `<BASE_SHA>`, then `<HEAD_SHA>`. Then follow "Base and head commits". To check the commits again before you report, repeat any fetch or PR lookup you used, and run the same command.

The review covers commits only. If `<HEAD_REF>` is the checked-out branch and `git status` shows uncommitted or untracked changes, say that the review leaves them out. Review them too (`git diff HEAD` and the untracked files) only if the user asked for that. If another branch is checked out, its uncommitted changes are not part of this review.
