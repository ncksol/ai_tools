#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: collect-azure-devops.sh <PR id> <packet.json> [fragment.json]" >&2
  exit 2
fi

pr_id="$1"
output_file="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
credential_context="${PRG_AZURE_CREDENTIAL_CONTEXT:-current-environment}"
context_slug="$(printf '%s' "$credential_context" | tr -c 'A-Za-z0-9._-' '-')"
fragment_file="${3:-$(dirname "$output_file")/azure-cli-${context_slug}.fragment.json}"

command -v node >/dev/null 2>&1 || { echo "Node.js 18 or newer is required" >&2; exit 2; }
command -v git >/dev/null 2>&1 || { echo "Git is required" >&2; exit 2; }

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT

failure_category=""
failure_message=""

# A failure record is one category line plus one sanitized message line, so the
# Bash 3.2 collector never has to quote JSON and captured provider stderr never
# leaves the work directory.
record_failure() {
  printf '%s\n%s\n' "$2" "$(printf '%s' "$3" | tr '\n\r' '  ')" >"$work_dir/$1.failure"
}

record_failures() {
  local category="$1"
  local message="$2"
  local name
  shift 2
  for name in "$@"; do
    record_failure "$name" "$category" "$message"
  done
}

classify_stderr() {
  if grep -qiE 'TF400813|TF401019|unauthorized|forbidden|not authorized|az login|401|403' "$1" 2>/dev/null; then
    printf 'authentication'
  else
    printf 'command-failed'
  fi
}

# Runs one provider operation without letting `set -e` abort the collector, so a
# later failure cannot discard the responses already collected.
run_operation() {
  local label="$1"
  local out="$2"
  local status=0
  shift 2
  "$@" >"$out" 2>"$work_dir/stderr.txt" || status=$?
  if [[ $status -eq 0 ]]; then
    return 0
  fi
  failure_category="$(classify_stderr "$work_dir/stderr.txt")"
  failure_message="$label failed with exit status $status"
  rm -f -- "$out" "$work_dir/stderr.txt"
  return 1
}

collect_diff() {
  if [[ -z "$source_sha" || -z "$target_sha" || -z "$repository_name" ]]; then
    record_failure diff dependency-unavailable "Azure PR snapshot SHAs or repository name were not collected"
    return
  fi
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    record_failure diff repository-mismatch "The working directory is not a Git repository"
    return
  fi
  local origin_url
  if ! origin_url="$(git remote get-url origin 2>/dev/null)"; then
    record_failure diff repository-mismatch "The Git repository has no origin remote"
    return
  fi
  local origin_name origin_lower repository_lower sha ref
  origin_name="$(basename "${origin_url%.git}")"
  origin_lower="$(printf '%s' "$origin_name" | tr '[:upper:]' '[:lower:]')"
  repository_lower="$(printf '%s' "$repository_name" | tr '[:upper:]' '[:lower:]')"
  if [[ "$origin_lower" != "$repository_lower" ]]; then
    record_failure diff repository-mismatch "The local Git repository is not the Azure repository for this PR"
    return
  fi
  for sha in "$target_sha" "$source_sha"; do
    ref="$target_ref"
    if [[ "$sha" == "$source_sha" ]]; then
      ref="$source_ref"
    fi
    if git cat-file -e "${sha}^{commit}" 2>/dev/null; then
      continue
    fi
    git fetch --no-tags --no-recurse-submodules origin "$sha" >/dev/null 2>&1 ||
      git fetch --no-tags --no-recurse-submodules origin "$ref" >/dev/null 2>&1 || true
    if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
      record_failure diff command-failed "Commit $sha could not be obtained from origin"
      return
    fi
  done
  if ! git diff --find-renames --no-ext-diff --no-color --unified=80 \
    "$target_sha...$source_sha" >"$work_dir/diff.patch" 2>/dev/null; then
    rm -f -- "$work_dir/diff.patch"
    record_failure diff command-failed "git diff failed for the captured PR commits"
  fi
}

if ! command -v az >/dev/null 2>&1; then
  record_failures tool-unavailable "Azure CLI is not installed" \
    identity metadata snapshot workItems policies iterations changes existingThreads diff
else
  pr_show_ok=0
  if run_operation "az repos pr show" "$work_dir/pull-request.json" \
    az repos pr show --id "$pr_id" --output json; then
    pr_show_ok=1
  else
    record_failures "$failure_category" "$failure_message" identity metadata snapshot
  fi

  if ! run_operation "az repos pr work-item list" "$work_dir/work-items.json" \
    az repos pr work-item list --id "$pr_id" --output json; then
    record_failure workItems "$failure_category" "$failure_message"
  fi

  if ! run_operation "az repos pr policy list" "$work_dir/policies.json" \
    az repos pr policy list --id "$pr_id" --output json; then
    record_failure policies "$failure_category" "$failure_message"
  fi

  project_id=""
  repository_id=""
  repository_name=""
  source_sha=""
  target_sha=""
  source_ref=""
  target_ref=""
  organization_url=""
  pr_values=()

  if [[ $pr_show_ok -eq 1 ]]; then
    if node -e '
      const fs=require("fs");
      const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const r=p.repository ?? {}, project=r.project ?? {}, url=r.webUrl ?? p.url ?? "";
      let org="";
      let m=url.match(/https?:\/\/dev\.azure\.com\/([^/]+)/i);
      if (m) org=`https://dev.azure.com/${m[1]}`;
      m=url.match(/https?:\/\/([^.]+)\.visualstudio\.com/i);
      if (!org && m) org=`https://${m[1]}.visualstudio.com`;
      for (const value of [project.id ?? project.name ?? "", r.id ?? "", r.name ?? "", p.lastMergeSourceCommit?.commitId ?? "", p.lastMergeTargetCommit?.commitId ?? "", p.sourceRefName ?? "", p.targetRefName ?? "", org]) console.log(String(value));
    ' "$work_dir/pull-request.json" >"$work_dir/pr-values.txt" 2>/dev/null; then
      while IFS= read -r line; do
        pr_values+=("$line")
      done <"$work_dir/pr-values.txt"
      project_id="${pr_values[0]:-}"
      repository_id="${pr_values[1]:-}"
      repository_name="${pr_values[2]:-}"
      source_sha="${pr_values[3]:-}"
      target_sha="${pr_values[4]:-}"
      source_ref="${pr_values[5]:-}"
      target_ref="${pr_values[6]:-}"
      organization_url="${pr_values[7]:-}"
    fi
  fi

  provider_scope_ok=1
  for required in project_id repository_id organization_url; do
    if [[ -z "${!required}" ]]; then
      provider_scope_ok=0
    fi
  done

  iterations_ok=0
  if [[ $provider_scope_ok -eq 1 ]]; then
    if run_operation "az devops invoke pullRequestIterations" "$work_dir/iterations.json" \
      az devops invoke \
        --organization "$organization_url" \
        --area git \
        --resource pullRequestIterations \
        --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" \
        --api-version 7.1 \
        --output json; then
      iterations_ok=1
    else
      record_failure iterations "$failure_category" "$failure_message"
    fi

    if ! run_operation "az devops invoke pullRequestThreads" "$work_dir/threads.json" \
      az devops invoke \
        --organization "$organization_url" \
        --area git \
        --resource pullRequestThreads \
        --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" \
        --api-version 7.1 \
        --output json; then
      record_failure existingThreads "$failure_category" "$failure_message"
    fi
  else
    record_failures dependency-unavailable "Azure PR project, repository, or organization was not collected" \
      iterations existingThreads
  fi

  iteration_id=0
  if [[ $iterations_ok -eq 1 ]]; then
    iteration_id="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const a=Array.isArray(x)?x:(x.value??[]); process.stdout.write(String(Math.max(0,...a.map(v=>Number(v.id??0)))))' "$work_dir/iterations.json" 2>/dev/null || printf '0')"
  fi

  if [[ "$iteration_id" =~ ^[0-9]+$ ]] && [[ "$iteration_id" -gt 0 ]]; then
    if ! run_operation "az devops invoke pullRequestIterationChanges" "$work_dir/changes.json" \
      az devops invoke \
        --organization "$organization_url" \
        --area git \
        --resource pullRequestIterationChanges \
        --route-parameters project="$project_id" repositoryId="$repository_id" pullRequestId="$pr_id" iterationId="$iteration_id" \
        --query-parameters '$compareTo=0' '$top=2000' \
        --api-version 7.1 \
        --output json; then
      record_failure changes "$failure_category" "$failure_message"
    fi
  else
    record_failure changes dependency-unavailable "No Azure DevOps PR iteration id was collected"
  fi

  collect_diff
fi

mkdir -p "$(dirname "$output_file")" "$(dirname "$fragment_file")"

assemble_status=0
node "$script_dir/assemble-azure-context.mjs" directory \
  "$work_dir" \
  azure-cli \
  "$credential_context" \
  "$output_file" \
  "$fragment_file" || assemble_status=$?

if [[ $assemble_status -ne 0 ]]; then
  exit "$assemble_status"
fi

echo "Captured Azure DevOps PR $pr_id at $output_file"
