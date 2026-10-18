import { parseArgs } from "node:util";
import { ALL_FEATURES, FEATURES, parseFeatures, type Feature } from "./lib/features.ts";
import { runSuite, suiteFile, suiteFiles } from "./lib/suite.ts";

const { values } = parseArgs({
  options: {
    app: { type: "string" },
    features: { type: "string" },
    only: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

if (!values.app) {
  console.error("Usage: node scripts/acceptance.ts --app <dir> [--features <list>] [--only <v1|feature>] [--verbose]");
  process.exit(2);
}

let files: string[];
if (values.only) {
  // --only runs one file on its own, so it does not apply the reports-needs-policy rule.
  if (!(["v1", ...FEATURES] as string[]).includes(values.only)) {
    console.error(`Unknown suite file "${values.only}". Use v1 or one of: ${FEATURES.join(", ")}`);
    process.exit(2);
  }
  files = [suiteFile(values.only as "v1" | Feature)];
} else {
  files = suiteFiles(values.features === undefined ? ALL_FEATURES : parseFeatures(values.features));
}

const result = await runSuite(values.app, files);
if (values.verbose) console.log(result.output);
for (const name of result.failures) console.log(`FAIL ${name}`);
console.log(`${result.passed}/${result.total} acceptance tests passed`);
process.exit(result.ok ? 0 : 1);
