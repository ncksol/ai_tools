#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: collect-azure-devops.sh <PR id> <packet.json>" >&2
  exit 2
fi

pr_id="$1"
output_file="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v az >/dev/null 2>&1 || { echo "Azure CLI is required" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is required" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

az repos pr show --id "$pr_id" --output json >"$work_dir/pull-request.json"
az repos pr work-item list --id "$pr_id" --output json >"$work_dir/work-items.json"
az repos pr policy list --id "$pr_id" --output json >"$work_dir/policies.json"

node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify(p.repository ?? {}))' \
  "$work_dir/pull-request.json" >"$work_dir/repository.json"

pr_values=()
while IFS= read -r line; do
  pr_values+=("$line")
done < <(node -e '
  const fs=require("fs");
  const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const r=p.repository ?? {}, project=r.project ?? {}, url=r.webUrl ?? p.url ?? "";
  let org="";
  let m=url.match(/https?:\/\/dev\.azure\.com\/([^/]+)/i);
  if (m) org=`https://dev.azure.com/${m[1]}`;
  m=url.match(/https?:\/\/([^.]+)\.visualstudio\.com/i);
  if (!org && m) org=`https://${m[1]}.visualstudio.com`;
  for (const value of [project.id ?? project.name ?? "", r.id ?? "", r.name ?? "", p.lastMergeSourceCommit?.commitId ?? "", p.lastMergeTargetCommit?.commitId ?? "", p.sourceRefName ?? "", p.targetRefName ?? "", org]) console.log(String(value));
' "$work_dir/pull-request.json")

project_id="${pr_values[0]}"
repository_id="${pr_values[1]}"
repository_name="${pr_values[2]}"
source_sha="${pr_values[3]}"
target_sha="${pr_values[4]}"
source_ref="${pr_values[5]}"
target_ref="${pr_values[6]}"
organization_url="${pr_values[7]}"

for required in project_id repository_id source_sha target_sha organization_url; do
  [[ -n "${!required}" ]] || { echo "Azure PR metadata is missing $required" >&2; exit 1; }
done

az devops invoke \
  --organization "$organization_url" \
  --area git \
  --resource pullRequestIterations \
  --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" \
  --api-version 7.1 \
  --output json >"$work_dir/iterations.json"

iteration_id="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const a=Array.isArray(x)?x:(x.value??[]); process.stdout.write(String(Math.max(0,...a.map(v=>Number(v.id??0)))))' "$work_dir/iterations.json")"
[[ "$iteration_id" -gt 0 ]] || { echo "No Azure DevOps PR iteration was returned" >&2; exit 1; }

az devops invoke \
  --organization "$organization_url" \
  --area git \
  --resource pullRequestIterationChanges \
  --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" iterationId="$iteration_id" \
  --query-parameters '$compareTo=0' '$top=2000' \
  --api-version 7.1 \
  --output json >"$work_dir/changes.json"

az devops invoke \
  --organization "$organization_url" \
  --area git \
  --resource pullRequestThreads \
  --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" \
  --api-version 7.1 \
  --output json >"$work_dir/threads.json"

origin_url="$(git remote get-url origin)"
origin_name="$(basename "${origin_url%.git}")"
origin_lower="$(printf '%s' "$origin_name" | tr '[:upper:]' '[:lower:]')"
repository_lower="$(printf '%s' "$repository_name" | tr '[:upper:]' '[:lower:]')"
[[ "$origin_lower" == "$repository_lower" ]] || {
  echo "Current Git repository '$origin_name' does not match Azure repository '$repository_name'" >&2
  exit 1
}

ensure_commit() {
  local sha="$1"
  local ref="$2"
  if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    return
  fi
  if ! git fetch --no-tags --no-recurse-submodules origin "$sha"; then
    git fetch --no-tags --no-recurse-submodules origin "$ref"
  fi
  git cat-file -e "${sha}^{commit}"
}

ensure_commit "$target_sha" "$target_ref"
ensure_commit "$source_sha" "$source_ref"
git diff --find-renames --no-ext-diff --no-color --unified=80 "$target_sha...$source_sha" >"$work_dir/diff.patch"

mkdir -p "$(dirname "$output_file")"
node "$script_dir/assemble-azure-context.mjs" directory \
  "$work_dir" \
  azure-cli \
  "${PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment}" \
  "$output_file"

echo "Captured Azure DevOps PR $repository_name!$pr_id at $output_file"
