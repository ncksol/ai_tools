import { parseArgs } from "node:util";
import { ALL_FEATURES, featureSetName, parseFeatures, type Feature } from "./lib/features.ts";
import { ROBUSTNESS_TIMEOUT_MS, robustnessFiles, robustnessSha256, runSuite } from "./lib/suite.ts";

// Runs the hidden robustness suite (robustness/) against an app. It is never the gate: run it after
// scoring, for information only.
const USAGE = "Usage: node scripts/robustness.ts --app <dir> [--features <list>] [--verbose]";

let values: { app?: string; features?: string; verbose?: boolean };
try {
  ({ values } = parseArgs({
    options: {
      app: { type: "string" },
      features: { type: "string" },
      verbose: { type: "boolean", default: false },
    },
  }));
} catch (error) {
  console.error(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}

if (!values.app) {
  console.error(USAGE);
  process.exit(2);
}

let features: Feature[];
try {
  features = values.features === undefined ? ALL_FEATURES : parseFeatures(values.features);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

const files = robustnessFiles(features);
if (files.length === 0) {
  // An empty file list would make `node --test` search the kit for tests, so nothing is run.
  console.log(`No robustness tests cover ${featureSetName(features)}`);
  process.exit(0);
}

// Test-only: a shorter budget in milliseconds, as for score.
const budget = process.env.ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS;
const timeoutMs = budget === undefined ? ROBUSTNESS_TIMEOUT_MS : Number(budget);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > ROBUSTNESS_TIMEOUT_MS) {
  console.error(`ORCH_EVAL_ROBUSTNESS_TIMEOUT_MS "${budget}" must be a positive integer no greater than ${ROBUSTNESS_TIMEOUT_MS}`);
  process.exit(2);
}

// Counts are comparable only between runs with the same suite sha256.
console.log(`Robustness suite sha256: ${robustnessSha256(files, { timeoutMs })}`);
const result = await runSuite(values.app, files, { timeoutMs });
if (values.verbose) console.log(result.output);
if (result.timedOut) {
  console.log(`Robustness error: stopped after its ${Math.ceil(timeoutMs / 1000)} s budget`);
  process.exit(1);
}
for (const name of result.failures) console.log(`FAIL ${name}`);
console.log(`${result.passed}/${result.total} robustness tests passed`);
process.exit(result.ok ? 0 : 1);
