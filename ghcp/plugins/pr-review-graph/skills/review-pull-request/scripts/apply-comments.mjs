#!/usr/bin/env node
import path from 'node:path';
import { isMain, parseFlags, readJson, writeJson } from './lib.mjs';

export function applyComments(deduplicated, editorOutput) {
  const findings = Array.isArray(deduplicated) ? deduplicated : (deduplicated?.findings ?? []);
  const entries = Array.isArray(editorOutput) ? editorOutput : (editorOutput?.comments ?? []);
  const known = new Set(findings.map(finding => String(finding?.fingerprint ?? '')).filter(Boolean));

  const usable = new Map();
  const unknown = [];
  for (const entry of entries) {
    const fingerprint = String(entry?.fingerprint ?? '');
    if (!known.has(fingerprint)) {
      unknown.push(fingerprint || '(missing fingerprint)');
      continue;
    }
    const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
    if (comment) usable.set(fingerprint, comment);
  }
  if (unknown.length) {
    throw new Error(`Editor returned comments for unknown findings: ${unknown.join(', ')}`);
  }

  const missing = findings
    .filter(finding => !usable.has(String(finding?.fingerprint ?? '')))
    .map(finding => String(finding?.fingerprint ?? '') || '(missing fingerprint)');
  if (missing.length) {
    throw new Error(`Editor returned no usable comment for findings: ${missing.join(', ')}`);
  }

  return findings.map(finding => ({ ...finding, comment: usable.get(String(finding.fingerprint)) }));
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [dedupedFile, commentsFile, outputFile] = flags._;
  if (!dedupedFile || !commentsFile || !outputFile) {
    throw new Error('Usage: apply-comments.mjs DEDUPED_FINDINGS_JSON EDITOR_COMMENTS_JSON FINAL_FINDINGS_JSON');
  }
  const findings = applyComments(
    await readJson(path.resolve(dedupedFile)),
    await readJson(path.resolve(commentsFile))
  );
  await writeJson(path.resolve(outputFile), findings);
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
