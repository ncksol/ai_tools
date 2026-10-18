import { FEATURES, FEATURE_HEADINGS } from "./features.ts";

// The Copilot app turns a long paste into an attached file, and its threshold is not known.
// Keeping the kickoff far below 1,000 characters lets it go in as typed text.
export const KICKOFF_MAX_CHARS = 800;
export const KICKOFF_SPEC_PATH = "docs/spec-v2.md";

// Any run of this many words shared with the spec counts as embedded spec text.
const SHARED_WORDS = 8;

const FEATURE_NAMES = FEATURES.map((feature) => FEATURE_HEADINGS[feature].replace(/^## Feature: /, ""));
const COUNT_WORDS = "one|two|three|four|five|six|\\d+";
const KIT_TERMS = /acceptance|hidden|reference|suite|\bkit\b|\bevals?\b|scor(?:e|ed|ing)\b|answers\.md|results\.csv|ai_tools|orch-evals?|expense-claims\//i;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function shingles(text: string, size: number): Set<string> {
  const list = words(text);
  const out = new Set<string>();
  for (let i = 0; i + size <= list.length; i++) out.add(list.slice(i, i + size).join(" "));
  return out;
}

// Returns what is wrong with a kickoff, given the spec the run repo will hold. Empty means fine.
export function kickoffProblems(kickoff: string, spec: string): string[] {
  const problems: string[] = [];
  if (kickoff.length > KICKOFF_MAX_CHARS) problems.push(`${kickoff.length} characters, over the ${KICKOFF_MAX_CHARS} limit`);
  if (!kickoff.includes(KICKOFF_SPEC_PATH)) problems.push(`does not point at ${KICKOFF_SPEC_PATH}`);

  const specShingles = shingles(spec, SHARED_WORDS);
  const shared = [...shingles(kickoff, SHARED_WORDS)].filter((shingle) => specShingles.has(shingle));
  if (shared.length > 0) problems.push(`embeds spec text: "${shared[0]}"`);
  if (/^#{1,6} /m.test(kickoff)) problems.push("has a markdown heading");

  for (const name of FEATURE_NAMES) {
    if (new RegExp(`\\b${name}\\b`, "i").test(kickoff)) problems.push(`names the feature "${name}"`);
  }
  const count = kickoff.match(new RegExp(`\\b(?:${COUNT_WORDS})\\s+(?:\\w+\\s+)?features?\\b`, "i"));
  if (count) problems.push(`gives a feature count: "${count[0]}"`);

  const kit = kickoff.match(KIT_TERMS);
  if (kit) problems.push(`mentions the kit: "${kit[0]}"`);
  return problems;
}
