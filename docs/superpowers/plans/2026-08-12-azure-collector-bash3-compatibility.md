# Azure Collector Bash 3.2 Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `collect-azure-devops.sh` run on a stock macOS by replacing its two Bash 4 constructs, and guard the whole class with a test.

**Architecture:** Two surgical replacements in one shell script — `mapfile` becomes an explicit `while read` loop, and the `,,` lowercase expansion becomes `tr` — plus a lint in the existing Node test suite that fails if any `.sh` file in the plugin contains a Bash 4-only construct. The lint is written first and must fail against the unmodified script, proving it detects the real defect.

**Tech Stack:** Bash 3.2-compatible shell, Node.js ≥ 18 ES modules, `node --test`. No new dependencies.

**Design spec:** `docs/superpowers/specs/2026-08-12-azure-collector-bash3-compatibility-design.md`

## Global Constraints

- All commands run from `ghcp/plugins/pr-review-graph`. Tests: `npm test`. Validation: `npm run validate`.
- Node.js ≥ 18, ES modules only (`import`, never `require`). Node built-ins only.
- **Do not use `readdir(dir, { recursive: true })`.** That option requires Node 18.17; this project declares `>=18` and the local runtime is 18.11.0. Walk directories manually with `readdir(dir, { withFileTypes: true })`.
- Shell changes must be valid Bash 3.2. The target is the stock macOS `/bin/bash`, version 3.2.57.
- Do NOT add any dependency. `package.json` must stay dependency-free.
- Commit messages must not contain a `Co-authored-by` trailer or any AI attribution trailer.
- Work on the current branch, `nicksologoub-microsoft-add-pr-review-graph-plugin`, which has PR #3 open.
- Do not modify `collect-github.sh`. It was checked and contains no Bash 4 constructs.

---

### Task 1: Bash 3.2 compatibility and the guard test

**Files:**
- Modify: `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops.sh:28-38` (the `mapfile` call) and `:83` (the case-insensitive comparison)
- Test: `ghcp/plugins/pr-review-graph/tests/plugin.test.mjs` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks. `tests/plugin.test.mjs` already imports `assert`, `readFile` from `node:fs/promises`, `path`, and `test`, and defines `const root` as the plugin directory.
- Produces: no exports. Task 2 relies only on the suite passing.

- [ ] **Step 1: Write the failing guard test**

Append to `tests/plugin.test.mjs`. It needs one addition to the existing `node:fs/promises` import — add `readdir` to the existing named import list, keeping it alphabetical:

```javascript
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
```

Then append this test at the end of the file:

```javascript
const BASH4_ONLY = [
  { pattern: /\bmapfile\b/, name: 'mapfile (use a `while IFS= read -r` loop)' },
  { pattern: /\breadarray\b/, name: 'readarray (use a `while IFS= read -r` loop)' },
  { pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*,/, name: 'lowercase expansion ${var,} or ${var,,} (use tr)' },
  { pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*\^/, name: 'uppercase expansion ${var^} or ${var^^} (use tr)' },
  { pattern: /\b(declare|local|typeset)\s+-[A-Za-z]*A/, name: 'associative array declaration' }
];

async function shellScripts(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await shellScripts(full)));
    else if (entry.name.endsWith('.sh')) found.push(full);
  }
  return found;
}

test('shell scripts avoid Bash 4 constructs so they run on the stock macOS Bash 3.2', async () => {
  const scripts = await shellScripts(root);
  assert.ok(scripts.length >= 2, `expected to find the collector scripts, found ${scripts.length}`);

  const offences = [];
  for (const file of scripts) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { pattern, name } of BASH4_ONLY) {
        if (pattern.test(line)) {
          offences.push(`${path.relative(root, file)}:${index + 1} uses ${name}`);
        }
      }
    });
  }

  assert.deepEqual(offences, [], `macOS ships Bash 3.2, and SKILL.md invokes these scripts as plain \`bash\`, so Bash 4 syntax makes them fail at runtime:\n${offences.join('\n')}`);
});
```

- [ ] **Step 2: Run the test to verify it fails against the unmodified script**

Run: `cd ghcp/plugins/pr-review-graph && npm test`
Expected: FAIL. The new test reports exactly two offences — `skills/review-pull-request/scripts/collect-azure-devops.sh:28 uses mapfile …` and `…:83 uses lowercase expansion …`. If it reports zero offences the pattern list is wrong; if it reports offences in `collect-github.sh` a pattern is over-matching. Either case must be fixed before proceeding.

- [ ] **Step 3: Replace the `mapfile` call**

In `skills/review-pull-request/scripts/collect-azure-devops.sh`, the block currently begins:

```bash
mapfile -t pr_values < <(node -e '
```

Change only that opening line and the closing line of the block. Insert `pr_values=()` and the loop header before the node program, and close with `done`. The inline node program between them, and its `"$work_dir/pull-request.json"` argument, must not be altered. The result is:

```bash
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
```

The eight `pr_values[N]` assignments that follow are unchanged.

- [ ] **Step 4: Replace the case-insensitive repository comparison**

Replace this block:

```bash
[[ "${origin_name,,}" == "${repository_name,,}" ]] || {
  echo "Current Git repository '$origin_name' does not match Azure repository '$repository_name'" >&2
  exit 1
}
```

with:

```bash
origin_lower="$(printf '%s' "$origin_name" | tr '[:upper:]' '[:lower:]')"
repository_lower="$(printf '%s' "$repository_name" | tr '[:upper:]' '[:lower:]')"
[[ "$origin_lower" == "$repository_lower" ]] || {
  echo "Current Git repository '$origin_name' does not match Azure repository '$repository_name'" >&2
  exit 1
}
```

The error message is unchanged and still reports the original, non-lowercased names.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS. The guard test now finds zero offences, and validation prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 6: Verify the script parses under the real Bash 3.2**

Run, from `ghcp/plugins/pr-review-graph`:

```bash
/bin/bash --version | head -1
/bin/bash -n skills/review-pull-request/scripts/collect-azure-devops.sh && echo "syntax OK"
/bin/bash -n skills/review-pull-request/scripts/collect-github.sh && echo "syntax OK"
```

Expected: the version line reports 3.2.x, and both scripts report `syntax OK`. If the version is 4 or newer, this machine is not the target configuration — report that rather than claiming the verification passed.

- [ ] **Step 7: Verify the replacement constructs behave correctly under Bash 3.2**

`bash -n` cannot detect either original defect, so the constructs must actually be executed. Write this harness to `/tmp/prg-bash3-check.sh` and run it with `/bin/bash`:

```bash
#!/usr/bin/env bash
set -euo pipefail

pr_values=()
while IFS= read -r line; do
  pr_values+=("$line")
done < <(node -e 'for (const v of ["proj-1","repo-2","MyRepo","sha-a","sha-b","refs/heads/feature","","https://dev.azure.com/org"]) console.log(String(v));')

echo "count=${#pr_values[@]}"
echo "first=[${pr_values[0]}] empty_slot=[${pr_values[6]}] last=[${pr_values[7]}]"

origin_name="MyRepo"
repository_name="myrepo"
origin_lower="$(printf '%s' "$origin_name" | tr '[:upper:]' '[:lower:]')"
repository_lower="$(printf '%s' "$repository_name" | tr '[:upper:]' '[:lower:]')"
[[ "$origin_lower" == "$repository_lower" ]] && echo "case-insensitive match OK"
```

Run: `/bin/bash /tmp/prg-bash3-check.sh`
Expected output:

```
count=8
first=[proj-1] empty_slot=[] last=[https://dev.azure.com/org]
case-insensitive match OK
```

`count=8` is the load-bearing assertion: it proves the loop preserves empty values as distinct elements, exactly as `mapfile` did, so the positional `pr_values[N]` assignments still line up. A count of 7 would mean the empty `targetRefName` slot was dropped and every later index shifted.

Then confirm the harness matches the real script rather than having drifted from it:

```bash
grep -n 'pr_values=()' -A 3 skills/review-pull-request/scripts/collect-azure-devops.sh
grep -n 'tr .\[:upper:\]. .\[:lower:\].' skills/review-pull-request/scripts/collect-azure-devops.sh
```

Expected: the loop header in the script is identical to the harness's, and two `tr` lines are present. Record all output in your report, then delete the harness with `rm -f /tmp/prg-bash3-check.sh`.

- [ ] **Step 8: Commit**

```bash
git add ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops.sh \
        ghcp/plugins/pr-review-graph/tests/plugin.test.mjs
git commit -m "Make the Azure collector run on the stock macOS Bash 3.2

mapfile and the ,, lowercase expansion are both Bash 4, but macOS ships
Bash 3.2 and SKILL.md invokes the collector as plain \`bash\`, so it
aborted before normalization and Azure reviews were unavailable there.
Replaced with a read loop and tr.

The shell collectors had no test coverage at all, which is why this
shipped. A lint over every .sh file in the plugin now rejects the whole
class of Bash 4 syntax."
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

In `ghcp/plugins/pr-review-graph/plugin.json`, change `"version": "0.2.1",` to `"version": "0.2.2",`.

- [ ] **Step 2: Run the validator to verify it now fails**

Run: `cd ghcp/plugins/pr-review-graph && npm run validate`
Expected: FAIL with `marketplace version 0.2.1 must match plugin.json version 0.2.2`. This confirms the version-match assertion is live rather than vacuous.

- [ ] **Step 3: Bump the marketplace entry to match**

In the repository-root `.github/plugin/marketplace.json`, change the `version` **inside the single entry of the `plugins` array** from `"0.2.1"` to `"0.2.2"`. Leave `metadata.version` at `"1.0.0"` — it versions the marketplace, not the plugin.

- [ ] **Step 4: Run the full suite to verify everything passes**

Run: `cd ghcp/plugins/pr-review-graph && npm test && npm run validate`
Expected: PASS — every test passes and validation prints `Plugin validation passed: 9 agents, 1 skill, zero MCP and hook dependencies.`

- [ ] **Step 5: Commit**

```bash
git add ghcp/plugins/pr-review-graph/plugin.json .github/plugin/marketplace.json
git commit -m "Release pr-review-graph 0.2.2

Patch bump for Bash 3.2 compatibility in the Azure collector, kept in
step across plugin.json and the repository marketplace entry."
```
