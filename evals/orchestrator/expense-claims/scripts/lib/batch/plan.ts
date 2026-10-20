// Which run comes next: the calibration rule from the README ("Calibration") and summarize() in
// results.ts, applied automatically, then alternating variants.
import { existsSync, readdirSync } from "node:fs";
import { ALL_FEATURES, featureSetName, type Feature } from "../features.ts";
import { parseRunName } from "../new-run.ts";
import { CALIBRATION_LIMIT_MINUTES, median, type ResultRow } from "../results.ts";
import type { RunState } from "./state.ts";
import { variantBundle, type VariantSet } from "../variants.ts";

export const FULL_SET = featureSetName(ALL_FEATURES);
export const WITHOUT_SUMMARY: Feature[] = ["policy", "reports", "import"];

export interface CalibrationDecision {
  // "full": keep all four features; "drop": every scored run drops Summary; "undecided": run the
  // calibration runs in `pending` first.
  state: "full" | "drop" | "undecided";
  features: Feature[];
  pending: string[];
  best: number | null;
  worst: number | null;
  reason: string;
}

const show = (value: number | null): string => (value === null ? "none" : Number.isFinite(value) ? `${value.toFixed(1)} min` : "unfinished");

// The calibration batch is every full-feature-set calibration row in results.csv plus one run for
// each batch variant with no row yet (only its first row can be a calibration row). The decision is
// fixed if it is the same when every missing run takes 0 minutes and when every missing run never
// finishes; then no calibration run is needed.
export function calibrationDecision(rows: ResultRow[], variants: string[], set?: VariantSet): CalibrationDecision {
  if (set) {
    const pending = variants.filter((variant) => !rows.some((row) =>
      row.variant === variant && row.agent_bundle_sha256 === variantBundle(set.variants[variant]) &&
      row.features === FULL_SET && row.calibration === "yes",
    ));
    return {
      state: pending.length > 0 ? "undecided" : "drop",
      features: pending.length > 0 ? ALL_FEATURES : WITHOUT_SUMMARY,
      pending, best: null, worst: null,
      reason: pending.length > 0
        ? `pinned policy variants need full-feature calibration: ${pending.join(", ")}`
        : "all pinned policy variants calibrated; this comparison drops Summary before the scored pilot",
    };
  }
  const existing = rows
    .filter((row) => row.calibration === "yes" && row.features === FULL_SET && !row.agent_bundle_sha256)
    .map((row) => (row.outcome === "passed" || row.outcome === "gate-failed" ? Number(row.minutes) : Infinity));
  const missing = variants.filter((variant) => !rows.some((row) => row.variant === variant));
  const best = median([...existing, ...missing.map(() => 0)]);
  const worst = median([...existing, ...missing.map(() => Infinity)]);
  const known = `calibration runs so far: ${existing.length} (${existing.map((value) => show(value)).join(", ") || "none"}); variants without a run: ${missing.join(", ") || "none"}`;
  if (best === null || worst === null) {
    const latest = [...rows].reverse().find((row) => variants.includes(row.variant) && row.calibration === "no");
    const features = latest && latest.features !== FULL_SET ? (latest.features.split("+") as Feature[]) : ALL_FEATURES;
    return { state: features.length === ALL_FEATURES.length ? "full" : "drop", features, pending: [], best, worst, reason: `no calibration runs and none needed; using ${featureSetName(features)} as in earlier scored runs` };
  }
  if (best > CALIBRATION_LIMIT_MINUTES) {
    return {
      state: "drop",
      features: WITHOUT_SUMMARY,
      pending: [],
      best,
      worst,
      reason: `the calibration median is over ${CALIBRATION_LIMIT_MINUTES} minutes even if every missing calibration run took 0 minutes (${show(best)}); Summary is dropped and no calibration run is needed. ${known}`,
    };
  }
  if (worst <= CALIBRATION_LIMIT_MINUTES) {
    return {
      state: "full",
      features: ALL_FEATURES,
      pending: [],
      best,
      worst,
      reason: `the calibration median is ${CALIBRATION_LIMIT_MINUTES} minutes or less even if every missing calibration run never finished (${show(worst)}); the full feature set stays. ${known}`,
    };
  }
  return {
    state: "undecided",
    features: ALL_FEATURES,
    pending: missing,
    best,
    worst,
    reason: `the calibration runs decide it (median between ${show(best)} and ${show(worst)}). ${known}`,
  };
}

export const runRowFor = (rows: ResultRow[], run: Pick<RunState, "repo" | "n">): ResultRow | undefined =>
  rows.find((row) => row.repo === run.repo && row.run === String(run.n));

// Scored runs this batch produced for a variant in the decided feature set. A full-feature
// calibration run counts only when the calibration rule counts it (the full set was kept).
export function scoredCount(runs: RunState[], rows: ResultRow[], variant: string, features: Feature[], bundle?: string): number {
  const name = featureSetName(features);
  return runs.filter((run) => run.variant === variant && runRowFor(rows, run)?.features === name &&
    (bundle === undefined || runRowFor(rows, run)?.agent_bundle_sha256 === bundle)).length;
}

export interface NextRun {
  variant: string;
  features: Feature[];
  calibration: boolean;
}

// A1, B1, A2, B2, ...: the variant with the fewest scored runs goes next, ties in the given order.
export function planNext(runs: RunState[], rows: ResultRow[], variants: string[], runsPerVariant: number, set?: VariantSet): { next: NextRun | null; decision: CalibrationDecision } {
  const decision = calibrationDecision(rows, variants, set);
  if (decision.state === "undecided") {
    return { next: { variant: decision.pending[0], features: ALL_FEATURES, calibration: true }, decision };
  }
  let best: { variant: string; count: number } | null = null;
  for (const variant of variants) {
    const count = scoredCount(runs, rows, variant, decision.features, set ? variantBundle(set.variants[variant]) : undefined);
    if (count < runsPerVariant && (!best || count < best.count)) best = { variant, count };
  }
  if (!best) return { next: null, decision };
  const calibration = decision.features.length === ALL_FEATURES.length && !rows.some((row) => row.variant === best.variant);
  return { next: { variant: best.variant, features: decision.features, calibration }, decision };
}

// One more than any run number of this variant in results.csv, the runs folder or this batch.
export function nextRunNumber(variant: string, rows: ResultRow[], runsDir: string, runs: RunState[]): number {
  let max = 0;
  for (const row of rows) if (row.variant === variant && /^\d+$/.test(row.run)) max = Math.max(max, Number(row.run));
  if (existsSync(runsDir)) {
    for (const entry of readdirSync(runsDir)) {
      const parsed = parseRunName(entry.replace(/\.kickoff\.md$/, ""));
      if (parsed?.variant === variant) max = Math.max(max, parsed.n);
    }
  }
  for (const run of runs) if (run.variant === variant) max = Math.max(max, run.n);
  return max + 1;
}

export function describePlan(variants: string[], runsPerVariant: number, decision: CalibrationDecision): string {
  const runs = variants.map((variant) => `${variant} x${runsPerVariant}`).join(", ");
  if (decision.state === "undecided") return `calibration runs first (${decision.pending.join(", ")}), then ${runs}`;
  return `${runs} on ${featureSetName(decision.features)}`;
}
