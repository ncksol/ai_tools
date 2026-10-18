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
