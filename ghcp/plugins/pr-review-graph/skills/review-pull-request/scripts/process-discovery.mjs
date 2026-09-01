#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TRANSPORT_FAILURE_KINDS } from './extract-agent-response.mjs';
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
const TRANSPORT_FAILURE_KIND_SET = new Set(TRANSPORT_FAILURE_KINDS);
const EXECUTION_FAILURE_KIND_SET = new Set([
  'execution-capacity',
  'execution-spawn',
  'execution-exit',
  'execution-timeout'
]);
const TRANSPORT_DETAIL_KEYS = new Set(['line', 'eventIndex', 'eventType', 'count']);
const SAFE_TRANSPORT_EVENT_TYPES = new Set([
  'assistant.turn_start',
  'assistant.message',
  'assistant.turn_end',
  'result'
]);

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
  if (!category) throw new Error(`Unsupported discovery agent: ${agent || '<empty>'}`);
  // A bare CLI flag (`--batch` with no value) is parsed as the boolean `true`;
  // Number(true) === 1, so reject non-string/non-number inputs before coercion.
  if (!['string', 'number'].includes(typeof options.batch)) {
    throw new Error('Batch must be a positive integer');
  }
  if (!['string', 'number'].includes(typeof options.attempt)) {
    throw new Error('Attempt must be 1 or 2');
  }
  const batch = Number(options.batch);
  const attempt = Number(options.attempt);
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

function validateTransportStatus(value) {
  if (value?.schemaVersion !== '1.0' || value?.status !== 'invalid') {
    throw new Error('Transport status must be a version 1.0 invalid result');
  }
  const kind = value.failure?.kind;
  if (!TRANSPORT_FAILURE_KIND_SET.has(kind)) {
    throw new Error('Unsupported transport failure kind');
  }
  const entries = Object.entries(value.failure ?? {}).filter(([key]) => key !== 'kind');
  if (entries.some(([key]) => !TRANSPORT_DETAIL_KEYS.has(key))) {
    throw new Error('Transport failure contains unsupported detail keys');
  }
  const details = Object.fromEntries(entries);
  for (const key of ['eventIndex', 'count']) {
    if (key in details && (!Number.isInteger(details[key]) || details[key] < 0)) {
      throw new Error(`Transport failure ${key} must be a non-negative integer`);
    }
  }
  if ('line' in details && (!Number.isInteger(details.line) || details.line < 1)) {
    throw new Error('Transport failure line must be a positive integer');
  }
  if ('eventType' in details && !SAFE_TRANSPORT_EVENT_TYPES.has(details.eventType)) {
    throw new Error('Transport failure eventType is not structural');
  }
  return { kind, details };
}

export async function recordDiscoveryTransportFailure(
  statusFile,
  resultDirectory,
  diagnosticsDirectory,
  options
) {
  try {
    const metadata = normalizeMetadata(options);
    let status;
    try {
      status = JSON.parse(await readFile(statusFile, 'utf8'));
    } catch {
      throw new Error('Transport status must be valid JSON');
    }
    const { kind, details } = validateTransportStatus(status);
    const diagnostic = path.join(
      diagnosticsDirectory,
      diagnosticFileName(metadata.agent, metadata.batch, metadata.attempt)
    );
    await writePrivateJson(diagnostic, {
      schemaVersion: '1.0',
      ...metadata,
      failureKind: kind,
      transport: details
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
        path.join(resultDirectory, discoveryResultFileName(
          metadata.agent,
          metadata.batch,
          metadata.attempt
        )),
        result
      );
      return result;
    } catch (error) {
      await rm(diagnostic, { force: true });
      throw error;
    }
  } finally {
    await rm(statusFile, { force: true });
  }
}

export async function recordDiscoveryExecutionFailure(
  resultDirectory,
  diagnosticsDirectory,
  options,
  failure
) {
  const metadata = normalizeMetadata(options);
  const kind = String(failure?.kind ?? '');
  if (!EXECUTION_FAILURE_KIND_SET.has(kind)) {
    throw new Error('Unsupported discovery execution failure kind');
  }
  const numeric = {};
  for (const key of ['promptChars', 'maxPromptChars', 'exitCode', 'attemptTimeoutMs']) {
    if (failure?.[key] !== undefined) {
      if (!Number.isInteger(failure[key]) || failure[key] < 0) {
        throw new Error(`Discovery execution failure ${key} must be a non-negative integer`);
      }
      numeric[key] = failure[key];
    }
  }
  const signal = failure?.signal == null ? null : String(failure.signal);
  const diagnostic = path.join(
    diagnosticsDirectory,
    diagnosticFileName(metadata.agent, metadata.batch, metadata.attempt)
  );
  await writePrivateJson(diagnostic, {
    schemaVersion: '1.0',
    ...metadata,
    failureKind: kind,
    ...numeric,
    ...(signal ? { signal } : {}),
    ...(failure?.stderr ? { stderr: redactDiagnosticText(failure.stderr) } : {})
  });
  try {
    const result = {
      schemaVersion: '1.0',
      ...metadata,
      status: 'invalid',
      failure: {
        kind,
        retryable: false,
        ...numeric,
        ...(signal ? { signal } : {}),
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

const SAFE_PROTOCOL_REASONS = Object.freeze({
  complete_plus_second: 'complete-first-unexpected-retry',
  missing_first: 'missing-first-attempt',
  corrupt_envelope: 'corrupt-envelope',
  exhausted_invalid: 'exhausted-invalid-attempts'
});

function safeProtocolReason(firstState, secondState) {
  if (firstState === 'complete') return SAFE_PROTOCOL_REASONS.complete_plus_second;
  if (firstState === 'missing') return SAFE_PROTOCOL_REASONS.missing_first;
  if (firstState === 'corrupt' || secondState === 'corrupt') return SAFE_PROTOCOL_REASONS.corrupt_envelope;
  return SAFE_PROTOCOL_REASONS.exhausted_invalid;
}

function validateAttemptEnvelope(value, expected) {
  const problems = [];
  if (!expected.category || !Object.values(DISCOVERY_CATEGORIES).includes(expected.category)) {
    problems.push(`expected.category is not a recognised discovery category`);
    return problems;
  }
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
    if (Array.isArray(value.findings)) {
      for (const [index, finding] of value.findings.entries()) {
        if (finding.category !== expected.category) {
          problems.push(`finding[${index}].category must be ${expected.category}`);
        }
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

function validateAgentPlanCoverage(agentPlan, reviewUnitById) {
  const problems = [];
  const label = `Discovery plan entry for ${agentPlan.name}`;
  if (agentPlan.batches.length === 0) return problems;

  const files = agentPlan.files;
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !file.trim())) {
    problems.push(`${label}.files must contain non-empty file paths`);
  }

  const usesReviewUnits = Array.isArray(agentPlan.units);
  const declaredItems = usesReviewUnits ? agentPlan.units : files;
  const itemLabel = usesReviewUnits ? 'review unit IDs' : 'file paths';
  if (
    !Array.isArray(declaredItems)
    || !declaredItems.length
    || declaredItems.some(item => typeof item !== 'string' || !item.trim())
  ) {
    problems.push(`${label}.${usesReviewUnits ? 'units' : 'files'} must contain non-empty ${itemLabel}`);
  }

  const batchedItems = [];
  for (const [index, batch] of agentPlan.batches.entries()) {
    if (!Array.isArray(batch) || !batch.length || batch.some(item => typeof item !== 'string' || !item.trim())) {
      problems.push(`${label}.batches[${index}] must contain non-empty ${itemLabel}`);
      continue;
    }
    batchedItems.push(...batch);
  }

  if (Array.isArray(declaredItems) && declaredItems.length) {
    const declared = new Set(declaredItems);
    const covered = new Set(batchedItems);
    const exactlyCovered = declared.size === declaredItems.length
      && covered.size === batchedItems.length
      && declaredItems.length === batchedItems.length
      && declaredItems.every(item => covered.has(item));
    if (!exactlyCovered) {
      problems.push(`${label}.batches must cover every declared ${usesReviewUnits ? 'review unit' : 'file'} exactly once`);
    }
  }

  if (usesReviewUnits && Array.isArray(files) && files.length) {
    const units = agentPlan.units.map(id => reviewUnitById.get(id));
    const missingUnits = agentPlan.units.filter((id, index) => !units[index]);
    if (missingUnits.length) {
      problems.push(`${label}.units contains IDs absent from plan.reviewUnits`);
    } else {
      const declaredFiles = new Set(files);
      if (units.some(unit => !declaredFiles.has(unit.path))) {
        problems.push(`${label}.units must reference only declared files`);
      }
      if (files.some(file => !units.some(unit => unit.path === file))) {
        problems.push(`${label}.units must cover every declared file`);
      }
    }
  }
  return problems;
}

export async function finalizeDiscovery(plan, resultDirectory) {
  const scopes = [];
  const failures = [];
  const partialFindings = [];
  const expectedFiles = new Set();
  const planProblems = [];
  const reviewUnits = Array.isArray(plan?.reviewUnits) ? plan.reviewUnits : [];
  const reviewUnitById = new Map();
  for (const unit of reviewUnits) {
    if (
      typeof unit?.id !== 'string'
      || !unit.id.trim()
      || typeof unit?.path !== 'string'
      || !unit.path.trim()
      || reviewUnitById.has(unit.id)
    ) {
      planProblems.push('Discovery plan reviewUnits must have unique non-empty IDs and file paths');
      continue;
    }
    reviewUnitById.set(unit.id, unit);
  }

  // A missing or empty agents array is a malformed or wrong plan, not a
  // vacuously-complete review: `[].every(...)` would otherwise report
  // `complete` with zero coverage evidence.
  const agentPlans = Array.isArray(plan?.agents) ? plan.agents : null;
  if (!agentPlans) {
    planProblems.push('Discovery plan must include an agents array');
  } else if (agentPlans.length === 0) {
    planProblems.push('Discovery plan must include at least one routed agent');
  }

  for (const agentPlan of agentPlans ?? []) {
    const category = DISCOVERY_CATEGORIES[agentPlan?.name];
    if (!category || !Array.isArray(agentPlan.batches)) {
      planProblems.push(`Invalid discovery plan entry for ${agentPlan?.name ?? '<unnamed>'}`);
      continue;
    }
    const coverageProblems = validateAgentPlanCoverage(agentPlan, reviewUnitById);
    if (coverageProblems.length) {
      planProblems.push(...coverageProblems);
      continue;
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
          reason: safeProtocolReason(first.state, second.state),
          attempts: invalidAttempts,
          protocolStates: [first.state, second.state]
        });
      }
    }

    const expectedBatches = agentPlan.batches.length;
    // A routed agent with zero planned batches has no evidence it was ever
    // reviewed; treat it as failed rather than vacuously complete.
    if (expectedBatches === 0) {
      failures.push({ agent: agentPlan.name, batch: null, recovered: false, reason: 'zero-expected-batches' });
    }
    const status = expectedBatches === 0
      ? 'failed'
      : completedBatches === expectedBatches
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

  const totalExpectedBatches = scopes.reduce((sum, scope) => sum + scope.expectedBatches, 0);
  if (!planProblems.length && totalExpectedBatches === 0) {
    planProblems.push('Discovery plan has zero expected batches');
  }

  const actualFiles = await listResultFiles(resultDirectory);
  const protocolProblems = actualFiles
    .filter(file => !expectedFiles.has(file))
    .map(file => `Unexpected attempt result: ${file}`);
  const complete = !planProblems.length
    && scopes.length > 0
    && scopes.every(scope => scope.status === 'complete')
    && !protocolProblems.length;
  const coverage = {
    schemaVersion: '1.0',
    status: complete ? 'complete' : 'failed',
    scopes,
    failures,
    protocolProblems,
    ...(planProblems.length ? { planProblems } : {}),
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
  if (mode === 'transport-failure') {
    const [statusFile, resultDirectory, diagnosticsDirectory] = args;
    if (!statusFile || !resultDirectory || !diagnosticsDirectory) {
      throw new Error('Usage: process-discovery.mjs transport-failure TRANSPORT_STATUS_JSON RESULTS_DIR DIAGNOSTICS_DIR --agent NAME --batch N --attempt 1|2');
    }
    await recordDiscoveryTransportFailure(
      path.resolve(statusFile),
      path.resolve(resultDirectory),
      path.resolve(diagnosticsDirectory),
      { agent: flags.agent, batch: flags.batch, attempt: flags.attempt }
    );
    process.exitCode = 1;
    return;
  }
  if (mode === 'finalize') {
    const [planFile, resultDirectory, candidatesFile, coverageFile] = args;
    if (!planFile || !resultDirectory || !candidatesFile || !coverageFile) {
      throw new Error('Usage: process-discovery.mjs finalize PLAN_JSON RESULTS_DIR CANDIDATES_JSON COVERAGE_JSON');
    }
    const candidates = path.resolve(candidatesFile);
    await rm(candidates, { force: true });
    const plan = JSON.parse(await readFile(path.resolve(planFile), 'utf8'));
    const { coverage, findings } = await finalizeDiscovery(plan, path.resolve(resultDirectory));
    await overwritePrivateJson(path.resolve(coverageFile), coverage);
    if (coverage.status === 'complete') {
      await overwritePrivateJson(candidates, findings);
    } else {
      process.exitCode = 1;
    }
    return;
  }
  throw new Error('First argument must be ingest, transport-failure, or finalize');
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
