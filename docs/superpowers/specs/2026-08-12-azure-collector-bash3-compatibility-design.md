# Azure collector Bash 3.2 compatibility

- **Date:** 2026-08-12
- **Status:** Approved (design); implementation pending
- **Target files:** `ghcp/plugins/pr-review-graph/skills/review-pull-request/scripts/collect-azure-devops.sh`, `tests/plugin.test.mjs`, version manifests
- **Origin:** Issue 2 of the review on PR #3 (`ncksol/ai_tools`), verified independently before acceptance
- **Related:** `docs/superpowers/specs/2026-08-12-prg-editor-comment-join-design.md` fixed issue 1 of the same review

## 1. Problem statement

`collect-azure-devops.sh` cannot run on a stock macOS. It uses two Bash 4 constructs while macOS
ships Bash 3.2.57, and `SKILL.md` invokes the collector as `bash <SKILL_DIR>/scripts/collect-azure-devops.sh`,
which resolves through `PATH` and therefore finds the system Bash. The script aborts before it
reaches normalization, so Azure DevOps reviews are unavailable on the platform the plugin's author
uses.

The two constructs are:

- Line 28: `mapfile -t pr_values < <(node -e '…')`. `mapfile` is a Bash 4 builtin; Bash 3.2 reports
  `mapfile: command not found`.
- Line 83: `[[ "${origin_name,,}" == "${repository_name,,}" ]]`. The `,,` lowercase expansion is Bash 4;
  Bash 3.2 reports `bad substitution`.

Both were reproduced on Bash 3.2.57. `bash -n` does not catch either, because neither is a parse-time
error at that version — the failures are only observable at runtime.

`collect-github.sh` was checked and contains no Bash 4 constructs. No other shell script exists in the
repository.

## 2. Why this went unnoticed

The plugin's test suite is `node --test tests/*.test.mjs` and covers only the `.mjs` scripts. Both
shell collectors have zero coverage. Nothing in the suite reads a `.sh` file, so no test could have
failed. The fix therefore includes a guard against the whole class, not only the two instances.

## 3. Design decisions

### 3.1 Rewrite the constructs rather than require Bash 4

Two approaches were considered.

**Require Bash 4+.** Add a `BASH_VERSINFO` guard that exits with an instruction to install a newer
Bash. Rejected: it documents the limitation instead of removing it. macOS is the author's primary
platform, and because `SKILL.md` invokes the script as plain `bash`, a Homebrew Bash would also have
to precede `/bin/bash` on `PATH` for the workaround to take effect. That is a fragile requirement to
impose in exchange for no benefit.

**Rewrite both constructs (chosen).** A one-time change with no new requirement on any user, keeping
the collector runnable on an unmodified macOS. The replacements are ordinary Bourne-compatible shell
and cost nothing in clarity.

### 3.2 `tr` rather than `shopt -s nocasematch`

Case-insensitive comparison could be obtained by enabling `nocasematch`, which Bash 3.1 supports. It
is rejected because it mutates global shell state that then has to be unset, and because its effect is
invisible at the comparison site. Lowercasing both operands with `tr` keeps the intent local and
readable. `tr` is POSIX and universally present; the script already depends on `az`, `git` and `node`.

### 3.3 Guard the class with a test, verify the behaviour once by hand

The guard test is a lint: it reads every `.sh` file in the plugin and fails if any contains a Bash
4-only construct. It runs on any platform, needs no Bash 3 present, and would have caught this defect.
Its assertion message states why the constraint exists, because that is where a future contributor
will encounter it.

A lint cannot prove the rewritten read loop behaves correctly, so the replacement constructs are also
executed under a real Bash 3.2 during implementation and their output checked. This is a one-off
verification recorded in the plan, not a permanent test. A test that executed under Bash 3 only when a
Bash 3 binary happened to be present would silently skip on Linux CI and give false comfort.

### 3.4 Out of scope

Extracting the inline `node -e` metadata program into a separately testable module is not part of this
change. The defect is in the shell transport, not in that program, so extracting it would add
structure around the part that works.

## 4. The replacements

### 4.1 Array population

`mapfile -t pr_values < <(node -e '…')` becomes:

```bash
pr_values=()
while IFS= read -r line; do
  pr_values+=("$line")
done < <(node -e '…')
```

The inline node program and its argument are unchanged. Array `+=` is Bash 3.1 and the redirect from a
process substitution keeps the loop in the current shell, so `pr_values` survives it.

Every emitted line is newline-terminated because the node program uses `console.log`, so the final
value is not lost to a partial read. Empty values remain distinct array elements: the program emits
eight lines and eight elements result, including empty ones such as an absent `sourceRefName`. This
matches `mapfile`'s behaviour exactly and was confirmed on Bash 3.2.57.

Error behaviour is also unchanged. Neither `mapfile` nor the loop propagates a failure of the process
substitution under `set -e`, and in both cases a failed node run leaves `pr_values` empty, which the
existing required-field loop already reports as missing `project_id`.

### 4.2 Case-insensitive repository comparison

```bash
origin_lower="$(printf '%s' "$origin_name" | tr '[:upper:]' '[:lower:]')"
repository_lower="$(printf '%s' "$repository_name" | tr '[:upper:]' '[:lower:]')"
[[ "$origin_lower" == "$repository_lower" ]] || {
  echo "Current Git repository '$origin_name' does not match Azure repository '$repository_name'" >&2
  exit 1
}
```

The error message is unchanged and still reports the original, non-lowercased names.

## 5. Guard test

Added to `tests/plugin.test.mjs`, in the existing style of the static checks already there.

- Discovers every `.sh` file recursively under the plugin directory rather than naming files
  individually, so a future script is covered automatically.
- Fails when a file matches any of: `mapfile`, `readarray`, `${var,,}` or `${var,}`, `${var^^}` or
  `${var^}`, `declare -A`, `local -A`.
- Reports the offending file, line number and construct.
- The set is limited to constructs plausibly reached for in this codebase. It is a guard, not an
  exhaustive Bash 4 detector.

## 6. Packaging

- `plugin.json`: version `0.2.1` → `0.2.2`.
- `.github/plugin/marketplace.json` at the repository root: matching bump of the `pr-review-graph`
  entry's `version`, leaving `metadata.version` at `1.0.0`. The validator asserts the two agree.

## 7. Acceptance criteria

1. `npm test` passes from `ghcp/plugins/pr-review-graph`, including the new guard test.
2. `npm run validate` passes from the same directory.
3. The guard test fails against the unmodified `collect-azure-devops.sh`, demonstrating it detects the
   real defect, and passes after the rewrite.
4. The rewritten array population and comparison are executed under Bash 3.2 and produce eight values,
   including empty ones, with a correct case-insensitive match.
5. `bash -n` reports no syntax error for both collector scripts. This only confirms the edit
   introduced no syntax fault; as noted in section 1, `bash -n` cannot detect either original defect.

## 8. Remaining out of scope

Two defects from the same PR review stay open and are tracked separately: repository resolution in
`collect-github.sh`, where `gh repo view` reads the current directory while `gh pr view` may resolve a
URL in another repository; and the `changeEntries` response shape in `normalizeAzure` together with its
misleading fixture. Neither is related to shell compatibility.
