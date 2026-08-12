# GitHub Collector Repository Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `collect-github.sh` capturing a pull request from one repository while querying another, by making the resolved pull request the single source of identity.

**Architecture:** `gh pr view` runs first; the repository is derived from the pull request's canonical URL; every later command is scoped to that repository explicitly instead of inheriting the working directory. The bug is demonstrated against two live pull requests that share the number 3 before the fix is applied, so the silent corruption is observed rather than assumed.

**Tech Stack:** Bash 3.2-compatible shell, `gh` CLI, Node.js ≥ 18. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-github-collector-repository-resolution-design.md`

## Global Constraints

- Plugin commands run from `ghcp/plugins/pr-review-graph`. Tests: `npm test`. Validation: `npm run validate`.
- Shell changes must be valid **Bash 3.2** — the stock macOS `/bin/bash`, version 3.2.57. A lint in the test suite rejects `mapfile`, `readarray`, `${var,,}`, `${var^^}` and `declare -A`. Nothing in this plan needs them.
- Node.js ≥ 18, Node built-ins only. Do NOT add any dependency.
- Commit messages must not contain a `Co-authored-by` trailer or any AI attribution trailer.
- Do NOT modify `collect-azure-devops.sh`, `normalize-context.mjs`, `lib.mjs`, or any fixture.
- Work on the current branch, `nicksologoub-microsoft-add-pr-review-graph-plugin`, which has PR #3 open.
- The verification runs hit the live GitHub API against two **public** repositories. The ambient `gh` credentials can read both; no token juggling is needed. Do not create, modify or comment on anything — every command used is read-only.

---

### Task 1: Resolve the repository from the pull request

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-github.sh:20-34`

**Interfaces:**
- Consumes: `normalize-context.mjs`, invoked unchanged at the end of the script; it reads `repository.json`, `pull-request.json`, `diff.patch`, `files.json`, `review-comments.json`, `reviews.json`, `issue-comments.json` and `checks.json` from the work directory. The names and contents of those files do not change.
- Produces: no new interface. Task 2 depends only on the suite passing.

**Why two pull requests numbered 3:** `ncksol/ai_tools#3` has 48 changed files and `octocat/Hello-World#3` has 1. Both are public. Because the numbers collide, the unfixed script does not fail cleanly on a cross-repository URL — it succeeds and produces a packet whose metadata and diff come from Hello-World while its files, comments and reviews come from ai_tools. The file count is an unambiguous discriminator between the two.

- [ ] **Step 1: Record the pre-fix cross-repository behaviour**

Run from `ghcp/plugins/pr-review-graph`:

```bash
bash skills/review-pull-request/scripts/collect-github.sh \
  "https://github.com/octocat/Hello-World/pull/3" /tmp/prg-before-cross.json
node -e 'const p=require("/tmp/prg-before-cross.json"); console.log("repository.id:", p.repository.id); console.log("pullRequest.url:", p.pullRequest.url); console.log("files:", p.files.length);'
```

Expected, and this is the defect: the command **succeeds**. `pullRequest.url` points at
`octocat/Hello-World`, but `files` is 48 — the file list of `ncksol/ai_tools#3`. A packet describing one
pull request while carrying another's files is exactly the silent corruption being fixed. Record this
output verbatim in your report.

- [ ] **Step 2: Record the pre-fix behaviour outside a git repository**

```bash
cd /tmp && bash /Users/nicksologoub/_src_/copilot-worktrees/ai_tools/nicksologoub-microsoft-glowing-waffle/ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-github.sh \
  "https://github.com/octocat/Hello-World/pull/3" /tmp/prg-before-nogit.json; echo "exit=$?"
```

Expected: a non-zero exit. `gh repo view` with no argument has no repository to resolve outside a work
tree, so the script dies before collecting anything, even though the URL fully identifies the pull
request. Record the exact error and exit code.

- [ ] **Step 3: Move the pull request lookup ahead of the repository lookup**

In `skills/review-pull-request/scripts/collect-github.sh`, the file currently reads:

```bash
gh repo view --json nameWithOwner,url,defaultBranchRef >"$work_dir/repository.json"
gh pr view "$pr_ref" \
  --json number,id,title,body,author,url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,commits,statusCheckRollup,reviewDecision,closingIssuesReferences \
  >"$work_dir/pull-request.json"

repo_full="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(x.nameWithOwner)' "$work_dir/repository.json")"
pr_number="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.number))' "$work_dir/pull-request.json")"

gh pr diff "$pr_ref" --patch >"$work_dir/diff.patch"
```

Replace that whole span with:

```bash
gh pr view "$pr_ref" \
  --json number,id,title,body,author,url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,commits,statusCheckRollup,reviewDecision,closingIssuesReferences \
  >"$work_dir/pull-request.json"

repo_full="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const m=String(x.url ?? "").match(/\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/); process.stdout.write(m ? `${m[1]}/${m[2]}` : "")' "$work_dir/pull-request.json")"
[[ -n "$repo_full" ]] || { echo "Could not determine the repository from the pull request URL" >&2; exit 1; }
pr_number="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.number))' "$work_dir/pull-request.json")"

gh repo view "$repo_full" --json nameWithOwner,url,defaultBranchRef >"$work_dir/repository.json"
gh pr diff "$pr_number" --repo "$repo_full" --patch >"$work_dir/diff.patch"
```

Three things changed and each matters. `gh pr view` now runs first, so nothing depends on the working
directory before the pull request is known. `repo_full` comes from the pull request's own URL rather
than from `gh repo view`, and is guarded, because an empty value would otherwise build API paths like
`repos//pulls/3` whose failure would not name the real cause. `gh pr diff` takes the resolved number
scoped to the resolved repository, so it cannot resolve to a different pull request than `gh pr view`
matched — which a bare branch name with two open pull requests could otherwise do.

Do not use `headRepository` or `headRepositoryOwner` to derive the repository. For a pull request from
a fork those name the fork, not the repository the pull request was opened against, and every API path
here needs the latter.

- [ ] **Step 4: Scope the checks fallback**

Further down the same file, change:

```bash
if ! gh pr checks "$pr_ref" --json name,state,link,bucket >"$work_dir/checks.json" 2>"$work_dir/checks.err"; then
```

to:

```bash
if ! gh pr checks "$pr_number" --repo "$repo_full" --json name,state,link,bucket >"$work_dir/checks.json" 2>"$work_dir/checks.err"; then
```

Leave the fallback body, which reads `statusCheckRollup` out of the pull request JSON, exactly as it is.

The four `gh api` calls below it already interpolate `$repo_full` and `$pr_number`; they need no edit and
become correct once those two values agree.

- [ ] **Step 5: Verify the cross-repository case is fixed**

```bash
bash skills/review-pull-request/scripts/collect-github.sh \
  "https://github.com/octocat/Hello-World/pull/3" /tmp/prg-after-cross.json
node -e 'const p=require("/tmp/prg-after-cross.json"); console.log("repository.id:", p.repository.id); console.log("pullRequest.url:", p.pullRequest.url); console.log("files:", p.files.length);'
```

Expected: `repository.id` is `octocat/Hello-World`, `pullRequest.url` points at that same repository,
and `files` is 1 rather than 48. The packet is now internally consistent.

- [ ] **Step 6: Verify the collector works outside a git repository**

```bash
cd /tmp && bash /Users/nicksologoub/_src_/copilot-worktrees/ai_tools/nicksologoub-microsoft-glowing-waffle/ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-github.sh \
  "https://github.com/octocat/Hello-World/pull/3" /tmp/prg-after-nogit.json; echo "exit=$?"
node -e 'const p=require("/tmp/prg-after-nogit.json"); console.log("repository.id:", p.repository.id, "files:", p.files.length);'
```

Expected: exit 0, `repository.id` is `octocat/Hello-World`, `files` is 1.

- [ ] **Step 7: Verify the ordinary case still works**

Return to `ghcp/plugins/pr-review-graph` and collect this repository's own pull request by bare number,
which is the path that worked before the change:

```bash
bash skills/review-pull-request/scripts/collect-github.sh 3 /tmp/prg-after-local.json
node -e 'const p=require("/tmp/prg-after-local.json"); console.log("repository.id:", p.repository.id, "files:", p.files.length);'
```

Expected: `repository.id` is `ncksol/ai_tools` and `files` is 48. A bare number still resolves through
the working directory, which is correct — that is what a bare number means.

- [ ] **Step 8: Verify shell syntax and run the suite**

```bash
/bin/bash --version | head -1
/bin/bash -n skills/review-pull-request/scripts/collect-github.sh && echo "syntax OK"
npm test && npm run validate
```

Expected: Bash reports 3.2.x, the script reports `syntax OK`, all tests pass — including the lint that
rejects Bash 4 constructs — and validation prints
`Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 9: Remove the verification artefacts**

```bash
rm -f /tmp/prg-before-cross.json /tmp/prg-before-nogit.json /tmp/prg-after-cross.json /tmp/prg-after-nogit.json /tmp/prg-after-local.json
```

- [ ] **Step 10: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-github.sh
git commit -m "Resolve the GitHub collector's repository from the pull request

repo_full came from \`gh repo view\` with no argument, which resolves the
current working directory, while pr_number came from a reference that
SKILL.md documents as accepting a URL. Every API call combined the two.

A 404 was the good outcome. Verified against octocat/Hello-World#3 from
inside this repository, the bad outcome is a hit: the collector succeeded
and produced a packet whose metadata and diff described Hello-World while
its 48 files came from ai_tools#3.

The resolved pull request is now the only source of identity, and the
diff and checks calls are scoped to it. That also lets a URL be collected
from outside a git repository, which gh repo view alone prevented."
```

---

### Task 2: Version bump

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/plugin.json` (`version`)
- Modify: `.github/plugin/marketplace.json` (`plugins[0].version`)

**Interfaces:**
- Consumes: the version-match assertion in `scripts/validate-plugin.mjs`, which compares `plugin.json` `version` against the repository-root marketplace entry for the same plugin name.
- Produces: nothing. This is the final task.

- [ ] **Step 1: Bump the plugin version**

In `ghcp/plugins/pr-review-graph/plugin.json`, change `"version": "0.2.3",` to `"version": "0.2.4",`.

- [ ] **Step 2: Run the validator to verify it now fails**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: FAIL with `marketplace version 0.2.3 must match plugin.json version 0.2.4`. This confirms the
version-match assertion is live rather than vacuous.

- [ ] **Step 3: Bump the marketplace entry to match**

In the repository-root `.github/plugin/marketplace.json`, change the `version` **inside the single entry
of the `plugins` array** from `"0.2.3"` to `"0.2.4"`. Leave `metadata.version` at `"1.0.0"` — it versions
the marketplace, not the plugin.

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS — every test passes and validation prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/plugin.json .github/plugin/marketplace.json
git commit -m "Release pr-review-graph 0.2.4

Patch bump for GitHub collector repository resolution, kept in step across
plugin.json and the repository marketplace entry."
```
