#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: collect-github.sh <PR number|URL|branch> <packet.json>" >&2
  exit 2
fi

pr_ref="$1"
output_file="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v gh >/dev/null 2>&1 || { echo "gh CLI is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is required" >&2; exit 1; }
gh auth status >/dev/null

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

gh pr view "$pr_ref" \
  --json number,id,title,body,author,url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,commits,statusCheckRollup,reviewDecision,closingIssuesReferences \
  >"$work_dir/pull-request.json"

repo_full="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const m=String(x.url ?? "").match(/\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/); process.stdout.write(m ? `${m[1]}/${m[2]}` : "")' "$work_dir/pull-request.json")"
[[ -n "$repo_full" ]] || { echo "Could not determine the repository from the pull request URL" >&2; exit 1; }
pr_number="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.number))' "$work_dir/pull-request.json")"

gh repo view "$repo_full" --json nameWithOwner,url,defaultBranchRef >"$work_dir/repository.json"
gh pr diff "$pr_number" --repo "$repo_full" --patch >"$work_dir/diff.patch"
gh api --paginate --slurp "repos/$repo_full/pulls/$pr_number/files?per_page=100" >"$work_dir/files.json"
gh api --paginate --slurp "repos/$repo_full/pulls/$pr_number/comments?per_page=100" >"$work_dir/review-comments.json"
gh api --paginate --slurp "repos/$repo_full/pulls/$pr_number/reviews?per_page=100" >"$work_dir/reviews.json"
gh api --paginate --slurp "repos/$repo_full/issues/$pr_number/comments?per_page=100" >"$work_dir/issue-comments.json"

if ! gh pr checks "$pr_number" --repo "$repo_full" --json name,state,link,bucket >"$work_dir/checks.json" 2>"$work_dir/checks.err"; then
  node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify(x.statusCheckRollup ?? []))' \
    "$work_dir/pull-request.json" >"$work_dir/checks.json"
fi

mkdir -p "$(dirname "$output_file")"
node "$script_dir/normalize-context.mjs" \
  --provider github \
  --input-dir "$work_dir" \
  --output "$output_file"

echo "Captured GitHub PR $repo_full#$pr_number at $output_file"
