# Wintermute PowerShell Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give both wintermute agents the Windows PowerShell tools, and make the dashboard's stuck detection treat them like the bash tools.

**Architecture:** Add the five PowerShell tool names to both agents' `tools` allowlists. In `engine/model/status.mjs`, treat `powershell`, `read_powershell` and `list_powershell` the same as `bash`, `read_bash` and `list_bash`.

**Tech Stack:** Markdown agent files, Node 18 ESM, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-15-wintermute-powershell-tools-design.md`

## Global Constraints

- Keep the plugin compatible with Node 18 (`tests/guards.test.mjs`).
- The version must match in `plugin.json`, `package.json` and `.github/plugin/marketplace.json`. Release 1.1.1 needs a CHANGELOG section.
- Don't add `Co-authored-by` trailers to commits.

---

### Task 1: Dashboard limits for PowerShell tools

**Files:**
- Modify: `ghcp/plugins/wintermute/engine/model/status.mjs:43,61-80`
- Test: `ghcp/plugins/wintermute/tests/status.test.mjs:131-140`

- [ ] **Step 1: Write the failing test.** Add after line 133:

```js
  assert.equal(limit('powershell', { initialWait: 600 }), 15 * MINUTE);
  assert.equal(limit('powershell', {}), 10 * MINUTE);
  assert.equal(limit('read_powershell', { delay: 60 }), 3 * MINUTE);
```

- [ ] **Step 2: Run the test and check that it fails.** From `ghcp/plugins/wintermute`, run `node --test tests/status.test.mjs`. It should fail because the result is `null`.
- [ ] **Step 3: Implement the change.** Add `'read_powershell'` and `'list_powershell'` to `POLLING_TOOLS`. In `toolLimitMs`, use `case 'bash': case 'powershell':` and `case 'read_bash': case 'read_powershell':`. In `limitNote`, change the check to `(tool.name !== 'bash' && tool.name !== 'powershell')`. Update the doc comment.
- [ ] **Step 4: Run the test and check that it passes.** Run `node --test tests/status.test.mjs`. It should pass.

### Task 2: Agent allowlists and release

**Files:**
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/wintermute-peon.agent.md:4`
- Modify: `ghcp/plugins/wintermute/com.github.copilot/agents/wintermute-core.agent.md:4`
- Modify: `ghcp/plugins/wintermute/CHANGELOG.md`, the version files and `.github/copilot-instructions.md`

- [ ] **Step 1: Update both allowlists.** In both `tools` lists, insert `"powershell", "read_powershell", "write_powershell", "stop_powershell", "list_powershell"` after `"list_bash"`.
- [ ] **Step 2: Bump the version.** Run `npm run release:bump -- patch`. Replace the TODO with a `### Fixed` entry saying that both agents now get PowerShell tools on Windows, and that the dashboard applies the bash time limits to them.
- [ ] **Step 3: Update the repository instructions.** In `.github/copilot-instructions.md`, change the `wintermute-peon` description to say "shell (bash or PowerShell)".
- [ ] **Step 4: Run the checks.** Run `npm test && npm run validate`. Both should pass.
- [ ] **Step 5: Commit, then open, review and merge the PR.**
