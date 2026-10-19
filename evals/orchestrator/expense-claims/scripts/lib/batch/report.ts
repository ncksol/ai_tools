// The morning report: outcomes, flags, sessions to archive, repos created and how to land results.
import { featureSetName } from "../features.ts";
import { formatSummary, readResults, summarize } from "../results.ts";
import type { AppDb } from "./appdb.ts";
import { runRowFor } from "./plan.ts";
import type { BatchConfig, BatchState, RunState } from "./state.ts";

export interface ReportExtras {
  branch: string | null;
  commits: string[];
  pushed: boolean | null;
}

const cell = (value: string | undefined): string => (value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function runLabel(run: RunState): string {
  return `${run.variant} #${run.n}`;
}

export function sessionsToArchive(state: BatchState, appDb: AppDb): string[] {
  const lines: string[] = [];
  for (const test of state.selftests) {
    if (test.appSessionId || test.sessionId) lines.push(`- Self-test session ${test.appSessionId ?? test.sessionId} (project at ${test.repoDir})`);
  }
  for (const run of state.runs) {
    if (!run.projectId && !run.appSessionId) continue;
    const rows = run.projectId ? appDb.workspaces(run.projectId) : null;
    if (rows) {
      const open = rows.filter((row) => !row.archivedAt);
      if (open.length === 0) continue;
      lines.push(`- ${runLabel(run)} (${run.name}): ${open.map((row) => `${row.name ?? row.id} [${row.id}${row.id === run.appSessionId ? ", the orchestrator" : ""}]`).join(", ")}`);
    } else {
      lines.push(`- ${runLabel(run)} (${run.name}): orchestrator session ${run.appSessionId ?? run.sessionId ?? "unknown"}, plus any child sessions of project ${run.name} that are still open`);
    }
  }
  return lines;
}

export function buildReport(config: BatchConfig, state: BatchState, appDb: AppDb, extras: ReportExtras): string {
  const rows = readResults(config.resultsPath);
  const out: string[] = [];
  out.push(`# Overnight eval batch ${config.id}`, "");
  out.push(`- Started ${state.startedAt}; finished ${state.finishedAt ?? "not yet"}.`);
  out.push(`- Ended because: ${state.stopReason ?? "still running"}.`);
  out.push(`- Variants: ${config.variants.join(", ") || "none (self-test only)"}; ${config.runsPerVariant} scored run(s) each; no new run after ${config.deadline}.`);
  out.push(`- Orchestrator session: ${config.model} at ${config.effort}, context ${config.contextTier}, interactive mode.`);
  out.push(`- App ${state.pins.appVersion ?? "unknown"}, CLI ${state.pins.cliVersion ?? "unknown"}. Pinned agents: ${Object.keys(state.pins.agents).join(", ") || "none"}.`);
  if (state.calibration) out.push(`- Calibration: ${state.calibration}`);
  if (config.dryRun) out.push("- DRY RUN: no GitHub repos; app steps were stubbed.");
  out.push("");

  out.push("## Runs", "");
  if (state.runs.length === 0) out.push("No runs.");
  else {
    out.push("| # | Run | Repo | Features | Outcome | Minutes | Wall | Blocked | Questions | Suite | PRs merged | Main CI | Flags |");
    out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    state.runs.forEach((run, i) => {
      const row = runRowFor(rows, run);
      const outcome = run.status === "void" ? `void: ${run.voidReason ?? ""}` : (row?.outcome ?? (run.status === "done" ? "not scored" : run.status));
      out.push(
        `| ${i + 1} | ${cell(runLabel(run))}${run.calibration ? " (calibration)" : ""} | ${cell(run.repo)} | ${cell(row?.features ?? featureSetName(run.features))} | ${cell(outcome)} | ${cell(row?.minutes)} | ${cell(row?.wall_minutes)} | ${cell(row?.blocked_minutes)} | ${cell(row?.questions)} | ${row ? `${row.suite_passed}/${row.suite_total}` : ""} | ${cell(row?.prs_merged)} | ${cell(row?.main_ci)} | ${cell(run.flags.map((flag) => flag.code).join(", "))} |`,
      );
    });
  }
  out.push("");

  const flagged = state.runs.filter((run) => run.flags.length > 0);
  out.push("## Flags", "");
  if (flagged.length === 0) out.push("No run was flagged.");
  for (const run of flagged) {
    out.push(`- ${runLabel(run)}:`);
    for (const flag of run.flags) out.push(`  - ${flag.code}: ${flag.detail}`);
  }
  out.push("", "A flag doesn't change the row in results.csv. Check each flagged run before you trust its row; to drop a row, delete its line from results.csv and commit.", "");

  out.push("## Self-test", "");
  if (state.selftests.length === 0) out.push("Not run.");
  for (const test of state.selftests) {
    out.push(`- ${test.status}${test.failure ? `: ${test.failure}` : ""}`);
    for (const check of test.checks) out.push(`  - ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  out.push("");

  out.push("## Summary of results.csv", "", "```text", formatSummary(summarize(rows)), "```", "");

  out.push("## Sessions to archive", "");
  const archive = sessionsToArchive(state, appDb);
  if (archive.length === 0) out.push("None found.");
  else out.push("The driver can't archive detached sessions. Archive these in the app:", "", ...archive);
  out.push("");

  out.push("## Repos and folders created", "");
  const made = state.runs.filter((run) => run.status !== "new");
  if (made.length === 0) out.push("None.");
  for (const run of made) {
    out.push(`- ${config.dryRun ? run.repo : `https://github.com/${run.repo}`} (local clone ${run.repoDir})`);
  }
  for (const test of state.selftests) out.push(`- Self-test scratch repo ${test.repoDir} (local only)`);
  out.push("", "Deleting run repos needs a token with the delete_repo scope, or the GitHub web UI (README \"Cleaning up\").", "");

  out.push("## Land the results", "");
  if (extras.branch) {
    out.push(`results.csv rows are committed on branch \`${extras.branch}\` of the ai_tools checkout (${extras.commits.length} commit(s) this batch)${extras.pushed === true ? ", pushed to origin" : extras.pushed === false ? ", NOT pushed" : ""}.`);
    for (const commit of extras.commits) out.push(`- ${commit}`);
    out.push("", `Open a pull request from \`${extras.branch}\` into main, or cherry-pick these commits onto a branch of your choice. Never push them to main directly.`);
  } else out.push("The results branch is unknown; check results.csv in the kit.");
  if (state.warnings.length > 0) out.push("", "Warnings:", ...state.warnings.map((warning) => `- ${warning}`));
  out.push("");

  out.push("## Morning checklist", "");
  out.push("1. Turn Copilot Memory back on at https://github.com/settings/copilot/features.");
  out.push("2. Archive the sessions listed above.");
  out.push("3. Review the flagged runs.");
  out.push("4. Land the results.csv commits.");
  out.push("5. Re-enable macOS updates if you deferred them.");
  return out.join("\n") + "\n";
}
