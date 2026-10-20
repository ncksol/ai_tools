import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ALL_FEATURES, featureSetName } from "./features.ts";

export const LEGACY_RESULT_COLUMNS = [
  "date", "variant", "run", "repo", "session", "agent", "features", "calibration", "outcome",
  "minutes", "wall_minutes", "blocked_minutes", "questions", "suite_passed", "suite_total",
  "prs_merged", "main_ci", "model", "effort", "copilot_version", "note",
] as const;
export const RESULT_COLUMNS = [
  ...LEGACY_RESULT_COLUMNS,
  "agent_revision", "agent_sha256", "agent_bundle_sha256", "main_sha",
  "robustness_status", "robustness_passed", "robustness_total", "robustness_sha256",
  "cost_status", "cost_usd", "pricing_version", "cost_captured_at",
  "cost_sessions", "usage_records", "input_tokens_all_models", "cache_read_tokens_all_models", "cache_write_tokens_all_models", "output_tokens_all_models",
] as const;
export type ResultRow = Record<(typeof RESULT_COLUMNS)[number], string>;

export const CALIBRATION_LIMIT_MINUTES = 30;
const FULL_SET = featureSetName(ALL_FEATURES);

export function toCsvLine(values: string[]): string {
  return values.map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)).join(",");
}

export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readResults(path: string): ResultRow[] {
  if (!existsSync(path)) return [];
  const [header, ...rows] = parseCsvText(readFileSync(path, "utf8"));
  if (!header || ![RESULT_COLUMNS.join(","), LEGACY_RESULT_COLUMNS.join(",")].includes(header.join(","))) {
    throw new Error(`${path} does not start with the expected header: ${RESULT_COLUMNS.join(",")}`);
  }
  return rows.map((values) => Object.fromEntries(RESULT_COLUMNS.map((column) => [column, values[header.indexOf(column)] ?? ""])) as ResultRow);
}

export function appendResult(path: string, row: ResultRow): void {
  if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") writeFileSync(path, RESULT_COLUMNS.join(",") + "\n");
  else if (readFileSync(path, "utf8").split(/\r?\n/)[0] === LEGACY_RESULT_COLUMNS.join(",")) {
    const old = readResults(path);
    writeFileSync(path, [RESULT_COLUMNS.join(","), ...old.map((r) => toCsvLine(RESULT_COLUMNS.map((column) => r[column])))].join("\n") + "\n");
  }
  appendFileSync(path, toCsvLine(RESULT_COLUMNS.map((column) => row[column])) + "\n");
}

export const sameRun = (row: ResultRow, repo: string, run: string): boolean => row.repo === repo && row.run === run;

// Rewrites the file without the rows for this repo and run, then adds `row` at the end.
export function replaceResult(path: string, repo: string, run: string, row: ResultRow): void {
  const kept = readResults(path).filter((other) => !sameRun(other, repo, run));
  const lines = [RESULT_COLUMNS.join(","), ...[...kept, row].map((r) => toCsvLine(RESULT_COLUMNS.map((column) => r[column])))];
  writeFileSync(path, lines.join("\n") + "\n");
}

// A run is a calibration run when it is the first row of its variant and uses the full feature set.
export function defaultCalibration(earlier: ResultRow[], variant: string, features: string): "yes" | "no" {
  return features === FULL_SET && !earlier.some((row) => row.variant === variant) ? "yes" : "no";
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface VariantSummary {
  features: string;
  variant: string;
  runs: number;
  passed: number;
  passRate: number;
  medianMinutes: number | null;
  agentBundle: string;
}

export interface Summary {
  calibration: { runs: number; median: number | null; counted: boolean };
  pinnedCalibrations: number;
  groups: VariantSummary[];
}

// Spec "Sizing": the first full-feature-set run of each variant (calibration = yes) forms the
// calibration batch, and the batch median uses every one of them. Finished runs (passed,
// gate-failed) count with their minutes; unfinished runs (timeout, stalled) count as longer than
// any finished run. If the batch median is 30 minutes or less, the batch counts as scored runs;
// otherwise only the batch is left out, and every other row counts. The per-variant comparison
// below still uses passed runs only.
export function summarize(rows: ResultRow[]): Summary {
  const inBatch = (row: ResultRow) => row.calibration === "yes" && row.features === FULL_SET;
  const batch = rows.filter(inBatch);
  const times = batch.map((row) => (row.outcome === "passed" || row.outcome === "gate-failed" ? Number(row.minutes) : Infinity));
  const batchMedian = median(times);
  const counted = batchMedian !== null && batchMedian <= CALIBRATION_LIMIT_MINUTES;
  const scored = rows.filter((row) => !inBatch(row) || (counted && !row.agent_bundle_sha256));
  const groupKey = (row: ResultRow) => `${row.features}\u0000${row.variant}\u0000${row.agent_bundle_sha256}`;
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, []);
  }
  for (const row of scored) groups.get(groupKey(row))!.push(row);
  return {
    calibration: { runs: batch.length, median: batchMedian, counted },
    pinnedCalibrations: rows.filter((row) => inBatch(row) && row.agent_bundle_sha256).length,
    groups: [...groups.entries()].map(([key, group]) => {
      const [features, variant, agentBundle] = key.split("\u0000");
      const passed = group.filter((row) => row.outcome === "passed");
      return {
        features,
        variant,
        agentBundle,
        runs: group.length,
        passed: passed.length,
        passRate: group.length === 0 ? 0 : passed.length / group.length,
        medianMinutes: median(passed.map((row) => Number(row.minutes))),
      };
    }),
  };
}

export function formatSummary(summary: Summary): string {
  const lines: string[] = [];
  const { calibration } = summary;
  if (calibration.runs === 0) {
    lines.push("Calibration: no calibration runs yet.");
  } else {
    const shown = calibration.median === null ? "n/a" : Number.isFinite(calibration.median) ? `${calibration.median.toFixed(1)} min` : `over ${CALIBRATION_LIMIT_MINUTES} min (unfinished runs count as longest)`;
    lines.push(`Calibration: ${calibration.runs} run(s), median ${shown}.`);
    if (calibration.counted && calibration.runs > summary.pinnedCalibrations) {
      lines.push(summary.pinnedCalibrations ? "Only unpinned calibration runs count as scored runs." : "Calibration runs count as scored runs.");
    }
    else if (!calibration.counted && calibration.median !== null) {
      lines.push(`The median is over ${CALIBRATION_LIMIT_MINUTES} minutes: drop Summary. Start every scored run with --features policy,reports,import.`);
    }
  }
  if (summary.pinnedCalibrations > 0) {
    lines.push(`Pinned policy calibrations: ${summary.pinnedCalibrations} run(s), never counted as scored runs. The batch requires every pinned variant to calibrate, freezes the shared median decision before the pilot, and stops if that decision keeps Summary.`);
  }
  for (const features of new Set(summary.groups.map((group) => group.features))) {
    lines.push("", `Feature set ${features}:`, "variant                      runs  passed  pass rate  median min (passed)");
    for (const group of summary.groups.filter((g) => g.features === features)) {
      const medianText = group.medianMinutes === null ? "-" : group.medianMinutes.toFixed(1);
      lines.push(
        `${`${group.variant}${group.agentBundle ? `@${group.agentBundle.slice(0, 8)}` : ""}`.padEnd(28)} ${String(group.runs).padStart(4)}  ${String(group.passed).padStart(6)}  ${`${Math.round(group.passRate * 100)}%`.padStart(9)}  ${medianText.padStart(19)}`,
      );
    }
  }
  return lines.join("\n");
}
