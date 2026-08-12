#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isMain, normalizeFindingText, parseFlags, readJson, severityRank, writeJson } from './lib.mjs';

export function fingerprintFinding(packet, finding) {
  const material = [
    'pr-review-graph-v1',
    packet.provider,
    packet.repository.id,
    packet.pullRequest.number,
    finding.category,
    finding.location?.path ?? 'summary',
    normalizeFindingText(finding.title),
    normalizeFindingText(finding.trigger),
    normalizeFindingText(finding.consequence)
  ].join('\n');
  return createHash('sha256').update(material).digest('hex');
}

export function fingerprintFindings(packet, findings) {
  const seen = new Set();
  const existing = new Set((packet.existingThreads ?? []).map(thread => thread.fingerprint).filter(Boolean));
  const output = [];
  const suppressed = [];

  for (const finding of [...findings].sort(compareFindings)) {
    const fingerprint = finding.fingerprint ?? fingerprintFinding(packet, finding);
    const item = { ...finding, fingerprint };
    if (seen.has(fingerprint)) {
      suppressed.push({ fingerprint, reason: 'duplicate-finding', finding: item });
      continue;
    }
    if (existing.has(fingerprint)) {
      suppressed.push({ fingerprint, reason: 'already-commented', finding: item });
      continue;
    }
    seen.add(fingerprint);
    output.push(item);
  }
  return { findings: output, suppressed };
}

function compareFindings(a, b) {
  return severityRank(a.severity) - severityRank(b.severity)
    || Number(b.confidence) - Number(a.confidence)
    || String(a.location?.path ?? '').localeCompare(String(b.location?.path ?? ''))
    || Number(a.location?.line ?? 0) - Number(b.location?.line ?? 0);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const packetFile = flags._[0];
  const findingsFile = flags._[1];
  const outputFile = flags._[2];
  if (!packetFile || !findingsFile || !outputFile) {
    throw new Error('Usage: fingerprint-findings.mjs PACKET_JSON FINDINGS_JSON OUTPUT_JSON');
  }
  const packet = await readJson(path.resolve(packetFile));
  const value = await readJson(path.resolve(findingsFile));
  const findings = Array.isArray(value) ? value : value.findings;
  await writeJson(path.resolve(outputFile), fingerprintFindings(packet, findings));
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
