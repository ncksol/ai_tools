import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ALL_FEATURES, featureSetName } from "./features.ts";

export const RESULT_COLUMNS = [
  "date", "variant", "run", "repo", "session", "agent", "features", "calibration", "outcome",
  "minutes", "wall_minutes", "blocked_minutes", "questions", "suite_passed", "suite_total",
  "prs_merged", "main_ci", "model", "effort", "copilot_version", "note",
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
  if (!header || header.join(",") !== RESULT_COLUMNS.join(",")) {
    throw new Error(`${path} does not start with the expected header: ${RESULT_COLUMNS.join(",")}`);
  }
  return rows.map((values) => Object.fromEntries(RESULT_COLUMNS.map((column, i) => [column, values[i] ?? ""])) as ResultRow);
}

export function appendResult(path: string, row: ResultRow): void {
  if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") writeFileSync(path, RESULT_COLUMNS.join(",") + "\n");
  appendFileSync(path, toCsvLine(RESULT_COLUMNS.map((column) => row[column])) + "\n");
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
}

export interface Summary {
  calibration: { runs: number; median: number | null; counted: boolean };
  groups: VariantSummary[];
}

// Spec "Sizing": the first run of each variant (calibration = yes) forms the calibration batch.
// Passed runs count with their minutes, timeouts count as longer than any limit, other outcomes
// are left out. If the batch median is 30 minutes or less, calibration runs count as scored runs.
export function summarize(rows: ResultRow[]): Summary {
  const batch = rows.filter((row) => row.calibration === "yes" && row.features === FULL_SET);
  const times = batch.flatMap((row) =>
    row.outcome === "passed" ? [Number(row.minutes)] : row.outcome === "timeout" ? [Infinity] : [],
  );
  const batchMedian = median(times);
  const counted = batchMedian !== null && batchMedian <= CALIBRATION_LIMIT_MINUTES;
  const scored = rows.filter((row) => row.calibration !== "yes" || counted);
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = `${row.features}\u0000${row.variant}`;
    if (!groups.has(key)) groups.set(key, []);
  }
  for (const row of scored) groups.get(`${row.features}\u0000${row.variant}`)!.push(row);
  return {
    calibration: { runs: batch.length, median: batchMedian, counted },
    groups: [...groups.entries()].map(([key, group]) => {
      const [features, variant] = key.split("\u0000");
      const passed = group.filter((row) => row.outcome === "passed");
      return {
        features,
        variant,
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
    const shown = calibration.median === null ? "n/a" : Number.isFinite(calibration.median) ? `${calibration.median.toFixed(1)} min` : `over ${CALIBRATION_LIMIT_MINUTES} min (timeouts count as longest)`;
    lines.push(`Calibration: ${calibration.runs} run(s), median ${shown}.`);
    if (calibration.counted) lines.push("Calibration runs count as scored runs.");
    else if (calibration.median !== null) {
      lines.push(`The median is over ${CALIBRATION_LIMIT_MINUTES} minutes: drop Summary. Start every scored run with --features policy,reports,import.`);
    }
  }
  for (const features of new Set(summary.groups.map((group) => group.features))) {
    lines.push("", `Feature set ${features}:`, "variant                      runs  passed  pass rate  median min (passed)");
    for (const group of summary.groups.filter((g) => g.features === features)) {
      const medianText = group.medianMinutes === null ? "-" : group.medianMinutes.toFixed(1);
      lines.push(
        `${group.variant.padEnd(28)} ${String(group.runs).padStart(4)}  ${String(group.passed).padStart(6)}  ${`${Math.round(group.passRate * 100)}%`.padStart(9)}  ${medianText.padStart(19)}`,
      );
    }
  }
  return lines.join("\n");
}
