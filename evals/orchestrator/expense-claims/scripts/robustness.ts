import { parseArgs } from "node:util";
import { ALL_FEATURES, featureSetName, parseFeatures, type Feature } from "./lib/features.ts";
import { robustnessFiles, runSuite } from "./lib/suite.ts";

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

const result = await runSuite(values.app, files);
if (values.verbose) console.log(result.output);
for (const name of result.failures) console.log(`FAIL ${name}`);
console.log(`${result.passed}/${result.total} robustness tests passed`);
process.exit(result.ok ? 0 : 1);
