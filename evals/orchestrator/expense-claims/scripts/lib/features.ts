export const FEATURES = ["policy", "reports", "import", "summary"] as const;
export type Feature = (typeof FEATURES)[number];
export const ALL_FEATURES: Feature[] = [...FEATURES];

export function parseFeatures(value: string): Feature[] {
  const names = value.split(",").map((name) => name.trim()).filter((name) => name !== "");
  for (const name of names) {
    if (!(FEATURES as readonly string[]).includes(name)) {
      throw new Error(`Unknown feature "${name}". Known features: ${FEATURES.join(", ")}`);
    }
  }
  const features = FEATURES.filter((feature) => names.includes(feature));
  if (features.includes("reports") && !features.includes("policy")) {
    throw new Error("The reports feature needs the policy feature");
  }
  return features;
}

export function featureSetName(features: readonly Feature[]): string {
  return features.length === 0 ? "v1" : features.join("+");
}

export const FEATURE_HEADINGS: Record<Feature, string> = {
  policy: "## Feature: Policy",
  reports: "## Feature: Reports",
  import: "## Feature: CSV import",
  summary: "## Feature: Summary",
};

// Removes each "## Feature: …" section whose feature is not in `keep`, from its heading up to the
// next level-2 heading (or the end). Headings inside fenced code blocks are ignored.
export function stripFeatures(markdown: string, keep: readonly Feature[]): string {
  const drop = new Set(FEATURES.filter((feature) => !keep.includes(feature)).map((f) => FEATURE_HEADINGS[f]));
  if (drop.size === 0) return markdown;
  const out: string[] = [];
  let inFence = false;
  let skipping = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && line.startsWith("## ")) skipping = drop.has(line.trim());
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\s+$/, "") + "\n";
}

export function detectFeatures(specMarkdown: string): Feature[] {
  const lines = new Set(specMarkdown.split("\n").map((line) => line.trim()));
  return FEATURES.filter((feature) => lines.has(FEATURE_HEADINGS[feature]));
}
