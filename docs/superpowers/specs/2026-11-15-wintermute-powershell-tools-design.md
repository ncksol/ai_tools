# Wintermute agents: PowerShell tools on Windows

## Intent

On Windows, Copilot CLI gives agents a PowerShell tool family (`powershell`, `read_powershell`, `write_powershell`, `stop_powershell`, `list_powershell`) instead of the bash family. Both wintermute agents have a `tools` allowlist that names only the bash tools, so on Windows a `wintermute-peon` child has no shell and `wintermute-core` can't do its quick jobs. Both agents should work as well on Windows as on macOS and Linux.

## Goals

- Add the five PowerShell tools to the `tools` lists of `wintermute-peon` and `wintermute-core`.
- Let the dashboard's stuck detection treat the PowerShell tools like their bash equivalents.
- Ship the change as patch release 1.1.1.

## Non-goals

- No change to which actions the agents may take. The prompts say "shell" without naming a tool, so they already cover PowerShell.

## Approaches

1. Add the PowerShell family next to the bash family in both allowlists (chosen). The CLI loads only the family for the host OS, so listing both is harmless. The CLI's own `explore` agent lists both in the same way.
2. Drop the allowlists. Rejected: the allowlists enforce the no-fan-out and no-MCP limits.

## Design

- Agents: add the five names after the bash tools in both `tools` lists.
- Dashboard (`engine/model/status.mjs`): `powershell` uses the `bash` time limit and limit note. `read_powershell` uses the `read_bash` limit. `read_powershell` and `list_powershell` count as polling tools.
- Tests: one `status.test.mjs` case that shows the PowerShell tools get the bash limits.
- Release: bump to 1.1.1 with `npm run release:bump`, then add a CHANGELOG entry. Update the agent list in `.github/copilot-instructions.md`.
