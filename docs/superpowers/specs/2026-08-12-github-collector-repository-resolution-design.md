# GitHub collector repository resolution

- **Date:** 2026-08-12
- **Status:** Approved (design); implementation pending
- **Target files:** `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-github.sh`, version manifests
- **Origin:** Issue 4 of the review on PR #3 (`ncksol/ai_tools`), verified independently before acceptance
- **Related:** issues 1, 2 and 3 of the same review are fixed under
  `2026-08-12-prg-editor-comment-join-design.md`,
  `2026-08-12-azure-collector-bash3-compatibility-design.md`, and
  `2026-08-12-azure-iteration-changes-normalization-design.md`

## 1. Problem statement

`collect-github.sh` can capture a pull request from one repository while querying another. It resolves
the repository and the pull request from two independent sources:

```bash
gh repo view --json nameWithOwner,url,defaultBranchRef >"$work_dir/repository.json"
gh pr view "$pr_ref" --json number,… >"$work_dir/pull-request.json"
```

`gh repo view` with no argument resolves the repository of the current working directory. `gh pr view`
resolves `$pr_ref`, which SKILL.md documents as `<PR number|URL|branch>`, so a URL can name a pull
request in an entirely different repository. `repo_full` then comes from the working directory while
`pr_number` comes from the supplied reference, and every later call combines them:

```bash
gh api --paginate --slurp "repos/$repo_full/pulls/$pr_number/files?per_page=100"
```

The best outcome is a 404. The worse outcome is a hit: if the current repository happens to have a pull
request with that number, the collector silently assembles a packet from two different pull requests —
metadata and diff from one, files, comments and reviews from another. A review built on that packet
would be wrong in ways no later phase can detect.

A second, simpler failure comes from the same line. Run the collector outside a git repository, which a
URL argument otherwise makes perfectly reasonable, and `gh repo view` has nothing to resolve, so the
script exits before doing anything.

## 2. Design decisions

### 2.1 One source of truth, then explicit scoping

The resolved pull request becomes the only source of identity. `gh pr view` runs first, `repo_full` is
derived from it, and every subsequent command is scoped to that repository explicitly. After the change
no command depends on the working directory for identity.

`gh pr diff` and `gh pr checks` both accept `-R/--repo`, so they take the derived repository and the
resolved number rather than the original `$pr_ref`. This closes a narrower version of the same bug:
`gh pr diff "$pr_ref"` with a branch name could resolve to a different pull request than the one
`gh pr view` matched, if the branch has more than one open pull request.

### 2.2 Derive the repository from the pull request URL

`gh pr view --json` exposes the pull request's HTML URL, which the script already requests. Its final
path segments identify the repository the pull request lives in:

```
https://github.com/<owner>/<repo>/pull/<number>
```

The obvious-looking alternative is wrong. `headRepository` and `headRepositoryOwner` name the *head*
repository, which for a pull request from a fork is the fork rather than the repository the pull request
was opened against. Every API path in this script needs the base repository.

The match is anchored on `/<owner>/<repo>/pull/<number>` at the end of the URL rather than on a
`github.com` prefix, so a GitHub Enterprise host parses correctly.

The pattern deliberately does not accommodate suffixes such as `/files`. It is applied to the URL
`gh pr view` returns, which is always the canonical `…/pull/<number>` form, not to the `$pr_ref` a user
supplied. A user may well paste `…/pull/3/files`; `gh` resolves that and reports the canonical URL back.

### 2.3 Keep fetching repository metadata, but scope it

`repository.json` cannot simply be dropped. `normalizeGitHub` reads `nameWithOwner`, `url` and
`defaultBranchRef.name` from it. The call is therefore kept and given an explicit argument:
`gh repo view "$repo_full" …`.

### 2.4 Verification by real execution rather than a new test

The two shell collectors have no functional tests and cannot get them within this suite: exercising
this code path requires `gh`, network access and a live pull request. Rather than build a proxy for
the failure, the failure itself is executed, before and after the change:

1. this repository's pull request by number, with the working directory inside this repository — the
   case that works today, confirming no regression;
2. a pull request URL from a different repository, with the working directory still inside this
   repository — the reported bug;
3. a pull request URL with the working directory outside any git repository — the second failure.

No new unit test is added. The defect was asking the wrong command, not parsing something incorrectly,
so extracting the URL parse into a testable module would guard the part that was never broken. The
existing lint over shell scripts continues to cover the Bash-compatibility class.

## 3. The change

All edits are within `collect-github.sh`. The argument handling, tool checks, `mktemp` work directory,
trap, `normalize-context.mjs` invocation and closing message are unchanged.

### 3.1 Resolve the pull request first

`gh pr view` moves ahead of `gh repo view`, and takes `$pr_ref` unchanged:

```bash
gh pr view "$pr_ref" \
  --json number,id,title,body,author,url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,commits,statusCheckRollup,reviewDecision,closingIssuesReferences \
  >"$work_dir/pull-request.json"
```

### 3.2 Derive identity from the pull request

`pr_number` continues to come from the pull request JSON. `repo_full` now comes from the same file:

```bash
repo_full="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const m=String(x.url ?? "").match(/\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/); process.stdout.write(m ? `${m[1]}/${m[2]}` : "")' "$work_dir/pull-request.json")"
[[ -n "$repo_full" ]] || { echo "Could not determine the repository from the pull request URL" >&2; exit 1; }
```

The guard matters because an empty `repo_full` would otherwise produce API paths like `repos//pulls/7`,
whose failure would not name the real cause.

### 3.3 Scope the remaining commands

```bash
gh repo view "$repo_full" --json nameWithOwner,url,defaultBranchRef >"$work_dir/repository.json"
gh pr diff "$pr_number" --repo "$repo_full" --patch >"$work_dir/diff.patch"
```

and in the checks fallback:

```bash
if ! gh pr checks "$pr_number" --repo "$repo_full" --json name,state,link,bucket >"$work_dir/checks.json" 2>"$work_dir/checks.err"; then
```

The `gh api` calls already interpolate `$repo_full` and `$pr_number` and need no edit; they simply
become correct once those two values agree.

The shell must remain Bash 3.2-compatible. Nothing introduced here is version-sensitive, and the
existing lint enforces it.

## 4. Packaging

- `plugin.json`: version `0.2.3` → `0.2.4`.
- `.github/plugin/marketplace.json` at the repository root: matching bump of the `pr-review-graph`
  entry's `version`, leaving `metadata.version` at `1.0.0`.

## 5. Acceptance criteria

1. `npm test` and `npm run validate` pass from `ghcp/plugins/pr-review-graph`.
2. Collecting this repository's pull request by number, from inside this repository, produces a packet
   whose repository and pull request agree — unchanged behaviour.
3. Collecting a pull request URL from a different repository, with the working directory inside this
   repository, produces a packet for **that** repository. The same command is run before the change to
   record what it did previously.
4. Collecting a pull request URL with the working directory outside any git repository succeeds. The
   same command is run before the change to record the failure.
5. `/bin/bash -n` reports no syntax error, and the Bash 4 lint still passes.

## 6. Out of scope

`gh api` and `gh repo view` resolve their host from `gh`'s own configuration. Making the collector
explicitly multi-host is not part of this change; deriving the repository from the pull request URL
neither improves nor worsens that behaviour.

With this change, all four defects found in the review of the vendored plugin are addressed.
