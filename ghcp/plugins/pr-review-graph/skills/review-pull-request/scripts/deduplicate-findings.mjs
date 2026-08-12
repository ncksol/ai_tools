#!/usr/bin/env node
import path from 'node:path';
import { isMain, parseFlags, readJson, writeJson } from './lib.mjs';

const VERDICTS = new Set(['duplicate', 'distinct', 'uncertain']);

export function prepareDeduplication(packet, value, options = {}) {
  const findings = unwrapFindings(value);
  const suppressed = Array.isArray(value?.suppressed) ? [...value.suppressed] : [];
  const maxBatchChars = Math.max(5_000, Number(options.maxBatchChars ?? 45_000));
  const threads = (packet.existingThreads ?? [])
    .filter(thread => String(thread.body ?? '').trim())
    .map(normalizeThreadForCheck);

  return {
    schemaVersion: '1.0',
    findings,
    existingThreadCount: threads.length,
    batches: batchThreads(threads, maxBatchChars).map((existingThreads, index) => ({
      batchId: `batch-${String(index + 1).padStart(3, '0')}`,
      findingFingerprints: findings.map(finding => finding.fingerprint),
      existingThreads
    })),
    suppressed
  };
}

export function applyDeduplication(prepared, value) {
  const batchResults = unwrapBatchResults(value);
  const resultByBatch = new Map(batchResults.map(result => [result.batchId, result]));
  const threadById = new Map(
    prepared.batches.flatMap(batch => batch.existingThreads).map(thread => [String(thread.id), thread])
  );
  const findings = [];
  const suppressed = [...(prepared.suppressed ?? [])];
  const held = [];

  if (!(prepared.batches ?? []).length) {
    return {
      findings: (prepared.findings ?? []).map(finding => ({
        ...finding,
        deduplication: { verdict: 'distinct', batchesChecked: 0, existingThreadsChecked: 0 }
      })),
      suppressed,
      held,
      existingThreadCount: 0
    };
  }

  for (const finding of prepared.findings ?? []) {
    const decisions = [];
    const problems = [];

    for (const batch of prepared.batches) {
      const result = resultByBatch.get(batch.batchId);
      const decision = result?.decisions?.find(item => item.fingerprint === finding.fingerprint);
      const validationError = validateDecision(decision, batch);
      if (validationError) {
        problems.push(`${batch.batchId}: ${validationError}`);
      } else {
        decisions.push({ ...decision, batchId: batch.batchId });
      }
    }

    const duplicates = decisions.filter(decision => decision.verdict === 'duplicate');
    const uncertain = decisions.filter(decision => decision.verdict === 'uncertain');

    if (duplicates.length) {
      suppressed.push({
        fingerprint: finding.fingerprint,
        reason: 'existing-review-duplicate',
        finding,
        matches: resolveMatches(duplicates, threadById),
        decisions: duplicates
      });
      continue;
    }

    if (problems.length || uncertain.length) {
      held.push({
        fingerprint: finding.fingerprint,
        reason: problems.length ? 'incomplete-deduplication' : 'possible-existing-review-duplicate',
        finding,
        matches: resolveMatches(uncertain, threadById),
        details: [...problems, ...uncertain.map(item => `${item.batchId}: ${item.reason}`)]
      });
      continue;
    }

    findings.push({
      ...finding,
      deduplication: {
        verdict: 'distinct',
        batchesChecked: prepared.batches.length,
        existingThreadsChecked: prepared.existingThreadCount
      }
    });
  }

  return { findings, suppressed, held, existingThreadCount: prepared.existingThreadCount ?? 0 };
}

function unwrapFindings(value) {
  const findings = Array.isArray(value) ? value : value?.findings;
  if (!Array.isArray(findings)) throw new Error('Findings input must be an array or contain a findings array');
  for (const finding of findings) {
    if (!/^[a-f0-9]{64}$/.test(finding.fingerprint ?? '')) {
      throw new Error(`Finding lacks a valid fingerprint: ${finding.title ?? 'untitled'}`);
    }
  }
  return findings;
}

function unwrapBatchResults(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.batches)) return value.batches;
  if (value?.batchId) return [value];
  return [];
}

function normalizeThreadForCheck(thread) {
  return {
    id: String(thread.id),
    type: thread.type ?? null,
    status: thread.status ?? null,
    path: thread.path ?? null,
    line: thread.line ?? null,
    author: thread.author ?? null,
    url: thread.url ?? null,
    body: String(thread.body ?? '')
  };
}

function batchThreads(threads, maxBatchChars) {
  if (!threads.length) return [];
  const batches = [];
  let current = [];
  let size = 0;
  for (const thread of threads) {
    const threadSize = JSON.stringify(thread).length;
    if (current.length && size + threadSize > maxBatchChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(thread);
    size += threadSize;
  }
  if (current.length) batches.push(current);
  return batches;
}

function validateDecision(decision, batch) {
  if (!decision) return 'missing decision';
  if (!VERDICTS.has(decision.verdict)) return 'invalid verdict';
  if (!Array.isArray(decision.matchedThreadIds)) return 'matchedThreadIds must be an array';
  if (typeof decision.reason !== 'string' || decision.reason.trim().length < 5) return 'reason is missing or too short';
  const allowedIds = new Set(batch.existingThreads.map(thread => String(thread.id)));
  if (decision.matchedThreadIds.some(id => !allowedIds.has(String(id)))) return 'decision references a thread outside its batch';
  if (decision.verdict === 'distinct' && decision.matchedThreadIds.length) return 'distinct decision must not reference threads';
  if (decision.verdict !== 'distinct' && !decision.matchedThreadIds.length) return `${decision.verdict} decision must reference a thread`;
  return null;
}

function resolveMatches(decisions, threadById) {
  const ids = [...new Set(decisions.flatMap(item => item.matchedThreadIds.map(String)))];
  return ids.map(id => threadById.get(id)).filter(Boolean);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [mode, ...args] = flags._;
  if (mode === 'prepare') {
    const [packetFile, findingsFile, outputFile] = args;
    if (!packetFile || !findingsFile || !outputFile) {
      throw new Error('Usage: deduplicate-findings.mjs prepare PACKET_JSON FINGERPRINTED_JSON CHECKS_JSON [--max-batch-chars N]');
    }
    const prepared = prepareDeduplication(
      await readJson(path.resolve(packetFile)),
      await readJson(path.resolve(findingsFile)),
      { maxBatchChars: flags['max-batch-chars'] }
    );
    await writeJson(path.resolve(outputFile), prepared);
    return;
  }
  if (mode === 'apply') {
    const [checksFile, decisionsFile, outputFile] = args;
    if (!checksFile || !decisionsFile || !outputFile) {
      throw new Error('Usage: deduplicate-findings.mjs apply CHECKS_JSON DECISIONS_JSON DEDUPED_JSON');
    }
    const result = applyDeduplication(
      await readJson(path.resolve(checksFile)),
      await readJson(path.resolve(decisionsFile))
    );
    await writeJson(path.resolve(outputFile), result);
    return;
  }
  throw new Error('First argument must be prepare or apply');
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
