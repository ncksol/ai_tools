#!/usr/bin/env node
import path from 'node:path';
import { isChangedLine, isMain, parseFlags, readJson, writeJson } from './lib.mjs';

const CATEGORIES = new Set(['contract', 'correctness', 'tests', 'security', 'data-compatibility', 'reliability']);
const SEVERITIES = new Set(['blocker', 'high', 'medium', 'low']);
const STRING_FIELDS = ['title', 'problem', 'trigger', 'consequence', 'evidence', 'recommendation'];

export function validateFindings(value, options = {}) {
  const mode = options.mode ?? 'candidate';
  const findings = unwrap(value);
  const errors = [];
  const warnings = [];

  if (!Array.isArray(findings)) return { valid: false, errors: ['Input must be a finding array'], warnings, count: 0 };

  findings.forEach((finding, index) => {
    const prefix = `finding[${index}]`;
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!CATEGORIES.has(finding.category)) errors.push(`${prefix}.category is invalid`);
    if (!SEVERITIES.has(finding.severity)) errors.push(`${prefix}.severity is invalid`);
    if (typeof finding.confidence !== 'number' || finding.confidence < 0 || finding.confidence > 1) {
      errors.push(`${prefix}.confidence must be between 0 and 1`);
    }
    for (const field of STRING_FIELDS) {
      if (typeof finding[field] !== 'string' || finding[field].trim().length < 5) errors.push(`${prefix}.${field} is missing or too short`);
    }
    validateLocation(finding.location, prefix, errors, warnings, options.packet);

    if (mode === 'verified' || mode === 'final') {
      if (finding.verification?.verdict !== 'verified') errors.push(`${prefix}.verification.verdict must be verified`);
      const threshold = finding.category === 'security' ? 0.85 : 0.80;
      if (typeof finding.confidence === 'number' && finding.confidence < threshold) {
        errors.push(`${prefix}.confidence is below ${threshold.toFixed(2)} for verified ${finding.category} findings`);
      }
    }
    if (mode === 'final') {
      if (!/^[a-f0-9]{64}$/.test(finding.fingerprint ?? '')) errors.push(`${prefix}.fingerprint is missing or invalid`);
      if (finding.deduplication?.verdict !== 'distinct') errors.push(`${prefix}.deduplication.verdict must be distinct`);
      if (typeof finding.comment !== 'string' || !finding.comment.trim()) warnings.push(`${prefix}.comment is missing; payload builder will format it`);
    }
  });

  return { valid: errors.length === 0, errors, warnings, count: findings.length };
}

function unwrap(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  if (Array.isArray(value?.inlineFindings) || Array.isArray(value?.summaryFindings)) {
    return [...(value.inlineFindings ?? []), ...(value.summaryFindings ?? [])];
  }
  return value;
}

function validateLocation(location, prefix, errors, warnings, packet) {
  if (location === null || location === undefined) {
    warnings.push(`${prefix} has no inline location and will be summary-only`);
    return;
  }
  if (typeof location !== 'object' || Array.isArray(location)) {
    errors.push(`${prefix}.location must be an object or null`);
    return;
  }
  if (typeof location.path !== 'string' || !location.path) errors.push(`${prefix}.location.path is required`);
  if (!Number.isInteger(location.line) || location.line < 1) errors.push(`${prefix}.location.line must be a positive integer`);
  if (!['RIGHT', 'LEFT'].includes(location.side)) errors.push(`${prefix}.location.side must be RIGHT or LEFT`);
  if (packet && location.path && location.line && location.side) {
    const file = packet.files.find(item => item.path === location.path);
    if (!file) errors.push(`${prefix}.location.path is not in the PR`);
    else if (!isChangedLine(file, location.line, location.side)) warnings.push(`${prefix}.location is not a changed line and will be summary-only`);
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const input = flags._[0];
  if (!input) throw new Error('Usage: validate-findings.mjs FINDINGS_JSON [--mode candidate|verified|final] [--packet PACKET_JSON] [--output RESULT_JSON]');
  const value = await readJson(path.resolve(input));
  const packet = flags.packet ? await readJson(path.resolve(flags.packet)) : undefined;
  const result = validateFindings(value, { mode: flags.mode, packet });
  if (flags.output) await writeJson(path.resolve(flags.output), result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
