#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMain, parseFlags } from './lib.mjs';
import { validateFindings } from './validate-findings.mjs';

export const DISCOVERY_CATEGORIES = Object.freeze({
  'prg-contract': 'contract',
  'prg-correctness': 'correctness',
  'prg-tests': 'tests',
  'prg-security': 'security',
  'prg-data-compatibility': 'data-compatibility',
  'prg-reliability': 'reliability'
});

const SECRET_NAME = '(?:authorization|token|access[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|cookie|set-cookie|private[_-]?key)';

export function discoveryResultFileName(agent, batch, attempt) {
  return `${agent}-batch-${String(batch).padStart(3, '0')}-attempt-${attempt}.json`;
}

function diagnosticFileName(agent, batch, attempt) {
  return `${agent}-batch-${String(batch).padStart(3, '0')}-attempt-${attempt}.failure.json`;
}

export function redactDiagnosticText(value) {
  let text = String(value);
  text = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
    '<redacted-private-key>'
  );
  text = text.replace(
    /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g,
    '<redacted-token>'
  );
  text = text.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    '<redacted-jwt>'
  );
  text = text.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    '$1 <redacted>'
  );
  text = text.replace(
    new RegExp(`("\\s*${SECRET_NAME}\\s*"\\s*:\\s*")([^"]*)(")`, 'gi'),
    '$1<redacted>$3'
  );
  text = text.replace(
    new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)(["'])([\\s\\S]*?)\\2`, 'gi'),
    '$1$2<redacted>$2'
  );
  return text.replace(
    new RegExp(`(\\b${SECRET_NAME}\\b\\s*[:=]\\s*)([^\\s,;}]+)`, 'gi'),
    '$1<redacted>'
  );
}

function normalizeMetadata(options) {
  const agent = String(options.agent ?? '');
  const category = DISCOVERY_CATEGORIES[agent];
  const batch = Number(options.batch);
  const attempt = Number(options.attempt);
  if (!category) throw new Error(`Unsupported discovery agent: ${agent || '<empty>'}`);
  if (!Number.isInteger(batch) || batch < 1) throw new Error('Batch must be a positive integer');
  if (![1, 2].includes(attempt)) throw new Error('Attempt must be 1 or 2');
  return { agent, category, batch, attempt };
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}

function safeParseLocation(error) {
  const message = String(error?.message ?? '');
  const lineColumn = message.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const position = message.match(/\bposition\s+(\d+)\b/i);
  return position ? { offset: Number(position[1]) } : {};
}

async function recordFailure(raw, resultDirectory, diagnosticsDirectory, metadata, kind, details = {}) {
  const diagnostic = path.join(
    diagnosticsDirectory,
    diagnosticFileName(metadata.agent, metadata.batch, metadata.attempt)
  );
  await writePrivateJson(diagnostic, {
    schemaVersion: '1.0',
    ...metadata,
    failureKind: kind,
    response: redactDiagnosticText(raw)
  });
  try {
    const result = {
      schemaVersion: '1.0',
      ...metadata,
      status: 'invalid',
      failure: {
        kind,
        ...details,
        diagnostic
      }
    };
    await writePrivateJson(
      path.join(resultDirectory, discoveryResultFileName(metadata.agent, metadata.batch, metadata.attempt)),
      result
    );
    return result;
  } catch (error) {
    await rm(diagnostic, { force: true });
    throw error;
  }
}

export async function ingestDiscoveryResponse(
  rawFile,
  resultDirectory,
  diagnosticsDirectory,
  options
) {
  let raw = '';
  try {
    const metadata = normalizeMetadata(options);
    raw = await readFile(rawFile, 'utf8');
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-json',
        safeParseLocation(error)
      );
    }

    if (!Array.isArray(value)) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-shape',
        { problems: ['Response must be a JSON array'] }
      );
    }

    const validation = validateFindings(value, { mode: 'candidate' });
    if (!validation.valid) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-candidate',
        { problems: validation.errors }
      );
    }

    const categoryProblems = value
      .map((finding, index) => finding.category === metadata.category
        ? null
        : `finding[${index}].category must be ${metadata.category}`)
      .filter(Boolean);
    if (categoryProblems.length) {
      return recordFailure(
        raw,
        resultDirectory,
        diagnosticsDirectory,
        metadata,
        'invalid-category',
        { problems: categoryProblems }
      );
    }

    const result = {
      schemaVersion: '1.0',
      ...metadata,
      status: 'complete',
      findings: value
    };
    await writePrivateJson(
      path.join(resultDirectory, discoveryResultFileName(metadata.agent, metadata.batch, metadata.attempt)),
      result
    );
    return result;
  } finally {
    await rm(rawFile, { force: true });
  }
}

function validateAttemptEnvelope(value, expected) {
  const problems = [];
  for (const field of ['agent', 'category', 'batch', 'attempt']) {
    if (value?.[field] !== expected[field]) {
      problems.push(`${field} does not match the expected attempt`);
    }
  }
  if (!['complete', 'invalid'].includes(value?.status)) {
    problems.push('status must be complete or invalid');
  }
  if (value?.status === 'complete') {
    const validation = validateFindings(value.findings, { mode: 'candidate' });
    problems.push(...validation.errors);
    for (const [index, finding] of (value.findings ?? []).entries()) {
      if (finding.category !== expected.category) {
        problems.push(`finding[${index}].category must be ${expected.category}`);
      }
    }
  }
  if (value?.status === 'invalid') {
    if (typeof value.failure?.kind !== 'string') problems.push('invalid result needs failure.kind');
    if (typeof value.failure?.diagnostic !== 'string') problems.push('invalid result needs failure.diagnostic');
  }
  return problems;
}

async function readAttempt(resultDirectory, expected) {
  const file = path.join(
    resultDirectory,
    discoveryResultFileName(expected.agent, expected.batch, expected.attempt)
  );
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', file };
    return { state: 'corrupt', file };
  }
  const problems = validateAttemptEnvelope(value, expected);
  return problems.length
    ? { state: 'corrupt', file, problems }
    : { state: value.status, file, value };
}

async function listResultFiles(resultDirectory) {
  try {
    return (await readdir(resultDirectory)).filter(file => file.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function finalizeDiscovery(plan, resultDirectory) {
  const scopes = [];
  const failures = [];
  const partialFindings = [];
  const expectedFiles = new Set();

  for (const agentPlan of plan.agents ?? []) {
    const category = DISCOVERY_CATEGORIES[agentPlan.name];
    if (!category || !Array.isArray(agentPlan.batches)) {
      throw new Error(`Invalid discovery plan entry for ${agentPlan.name ?? '<unnamed>'}`);
    }
    let completedBatches = 0;
    let recoveredBatches = 0;
    let failedBatches = 0;

    for (let index = 0; index < agentPlan.batches.length; index += 1) {
      const batch = index + 1;
      for (const attempt of [1, 2]) {
        expectedFiles.add(discoveryResultFileName(agentPlan.name, batch, attempt));
      }
      const expected = { agent: agentPlan.name, category, batch };
      const first = await readAttempt(resultDirectory, { ...expected, attempt: 1 });
      const second = await readAttempt(resultDirectory, { ...expected, attempt: 2 });
      const secondExists = second.state !== 'missing';
      let terminal = null;

      if (first.state === 'complete' && !secondExists) {
        terminal = first.value;
      } else if (first.state === 'invalid' && second.state === 'complete') {
        terminal = second.value;
        recoveredBatches += 1;
      }

      const invalidAttempts = [first, second]
        .filter(item => item.state === 'invalid')
        .map(item => ({
          attempt: item.value.attempt,
          kind: item.value.failure.kind,
          diagnostic: item.value.failure.diagnostic
        }));

      if (terminal) {
        completedBatches += 1;
        partialFindings.push(...terminal.findings);
        if (invalidAttempts.length) {
          failures.push({ agent: agentPlan.name, batch, recovered: true, attempts: invalidAttempts });
        }
      } else {
        failedBatches += 1;
        failures.push({
          agent: agentPlan.name,
          batch,
          recovered: false,
          attempts: invalidAttempts,
          protocolStates: [first.state, second.state]
        });
      }
    }

    const expectedBatches = agentPlan.batches.length;
    const status = completedBatches === expectedBatches
      ? 'complete'
      : completedBatches === 0
        ? 'failed'
        : 'incomplete';
    scopes.push({
      agent: agentPlan.name,
      status,
      expectedBatches,
      completedBatches,
      recoveredBatches,
      failedBatches
    });
  }

  const actualFiles = await listResultFiles(resultDirectory);
  const protocolProblems = actualFiles
    .filter(file => !expectedFiles.has(file))
    .map(file => `Unexpected attempt result: ${file}`);
  const complete = scopes.every(scope => scope.status === 'complete') && !protocolProblems.length;
  const coverage = {
    schemaVersion: '1.0',
    status: complete ? 'complete' : 'failed',
    scopes,
    failures,
    protocolProblems,
    ...(complete
      ? { candidateCount: partialFindings.length }
      : { partialCandidateCount: partialFindings.length })
  };
  return { coverage, findings: complete ? partialFindings : null };
}

async function overwritePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await rm(file, { force: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [mode, ...args] = flags._;
  if (mode === 'ingest') {
    const [rawFile, resultDirectory, diagnosticsDirectory] = args;
    if (!rawFile || !resultDirectory || !diagnosticsDirectory) {
      throw new Error('Usage: process-discovery.mjs ingest RAW_RESPONSE_FILE RESULTS_DIR DIAGNOSTICS_DIR --agent NAME --batch N --attempt 1|2');
    }
    const result = await ingestDiscoveryResponse(
      path.resolve(rawFile),
      path.resolve(resultDirectory),
      path.resolve(diagnosticsDirectory),
      { agent: flags.agent, batch: flags.batch, attempt: flags.attempt }
    );
    if (result.status !== 'complete') process.exitCode = 1;
    return;
  }
  if (mode === 'finalize') {
    const [planFile, resultDirectory, candidatesFile, coverageFile] = args;
    if (!planFile || !resultDirectory || !candidatesFile || !coverageFile) {
      throw new Error('Usage: process-discovery.mjs finalize PLAN_JSON RESULTS_DIR CANDIDATES_JSON COVERAGE_JSON');
    }
    const plan = JSON.parse(await readFile(path.resolve(planFile), 'utf8'));
    const candidates = path.resolve(candidatesFile);
    const { coverage, findings } = await finalizeDiscovery(plan, path.resolve(resultDirectory));
    await rm(candidates, { force: true });
    await overwritePrivateJson(path.resolve(coverageFile), coverage);
    if (coverage.status === 'complete') {
      await overwritePrivateJson(candidates, findings);
    } else {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('First argument must be ingest or finalize');
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
