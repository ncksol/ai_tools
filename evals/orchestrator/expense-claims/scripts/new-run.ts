import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ALL_FEATURES, featureSetName, parseFeatures } from "./lib/features.ts";
import { newRun } from "./lib/new-run.ts";
import { run } from "./lib/proc.ts";
import { KIT_DIR } from "./lib/suite.ts";
import { liveAgent, variantLabel } from "./lib/variants.ts";

const { values } = parseArgs({
  options: {
    variant: { type: "string" },
    n: { type: "string" },
    features: { type: "string" },
    owner: { type: "string", default: "ncksol" },
    "runs-dir": { type: "string", default: join(homedir(), "orch-evals") },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.variant) {
  console.error("Usage: npm run new-run -- --variant <agent-name> [--n <k>] [--features <list>] [--owner <login>] [--runs-dir <dir>] [--dry-run]");
  process.exit(2);
}

const features = values.features === undefined ? ALL_FEATURES : parseFeatures(values.features);
const result = await newRun(
  {
    variant: values.variant,
    n: values.n === undefined ? undefined : Number(values.n),
    features,
    owner: values.owner,
    runsDir: resolve(values["runs-dir"]),
    dryRun: values["dry-run"],
  },
  { gh: (args) => run("gh", args), log: (line) => console.log(line) },
);

console.log(`
Run repo ready: ${result.repoDir} (${result.files.length} files, features ${featureSetName(features)})

Next steps:
1. In the Copilot app, add ${result.repoDir} as a project.
2. Start a new top-level session in that project with the agent "${liveAgent(variantLabel(values.variant))}" and the held-constant model and effort.
   Never start the run from another session: the orchestrator always runs as a top-level session.
3. Paste the kickoff as the first message, as typed text. To copy it: pbcopy < ${result.kickoffPath}
4. Answer any question straight away, word for word, from ${join(KIT_DIR, "answers.md")}. Send nothing else.
5. After the final report, before sending anything else, run from ${KIT_DIR}:
   npm run score -- --repo-dir ${result.repoDir}
`);
