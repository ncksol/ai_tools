#!/usr/bin/env node
import path from 'node:path';
import { isMain, parseFlags, readJson, writeJson } from './lib.mjs';
import { isJsonNumberLexeme, parseLosslessJson } from './lossless-json.mjs';

const ROUTES = [
  {
    name: 'prg-security',
    reason: 'Security-sensitive boundaries or inputs changed',
    patterns: [
      /auth|oauth|saml|jwt|permission|authori[sz]|credential|secret|crypto|encrypt|decrypt|certificate|csrf|cors/i,
      /sql|query|command|shell|exec|deserialize|upload|redirect|proxy|path\.join|template|html|cookie|session/i,
      /package-lock|pnpm-lock|yarn\.lock|requirements.*\.txt|go\.sum|cargo\.lock/i
    ]
  },
  {
    name: 'prg-data-compatibility',
    reason: 'Persisted data, schema, serialization, or public contract changed',
    patterns: [
      /migration|schema|database|\.sql$|entity|model|serialize|deserialize|protobuf|openapi|swagger|graphql/i,
      /json|xml|yaml|avro|parquet|enum|nullable|default value|api\/|contracts?\//i
    ]
  },
  {
    name: 'prg-reliability',
    reason: 'Distributed, asynchronous, I/O, lifecycle, or infrastructure behaviour changed',
    patterns: [
      /async|await|promise|thread|mutex|lock|queue|retry|timeout|cancell?ation|idempoten|transaction/i,
      /http|grpc|socket|stream|filesystem|file|connection|dispose|close|resource|kubernetes|terraform|bicep|docker/i,
      /\.ya?ml$|\.tf$|\.bicep$|dockerfile|helm|pipeline/i
    ]
  }
];

export class DiscoveryUnitCapacityError extends Error {
  constructor(filePath, contentChars, maxBatchChars, detail = '') {
    super(
      `Oversized patch cannot be split safely: ${filePath} `
      + `(${contentChars} characters, limit ${maxBatchChars})`
      + (detail ? ` at ${detail}` : '')
    );
    this.name = 'DiscoveryUnitCapacityError';
    this.code = 'DISCOVERY_UNIT_CAPACITY';
    this.path = filePath;
    this.contentChars = contentChars;
    this.maxBatchChars = maxBatchChars;
  }
}

export function buildReviewPlan(packet, options = {}) {
  const maxBatchChars = Number(options.maxBatchChars ?? 60_000);
  const textFiles = packet.files.filter(file => !file.isBinary && file.patch);
  const allPaths = textFiles.map(file => file.path);
  const reviewUnits = buildReviewUnits(textFiles, maxBatchChars);
  const agents = [
    agentPlan('prg-contract', 'PR intent and externally visible behaviour require review', textFiles, reviewUnits, maxBatchChars),
    agentPlan('prg-correctness', 'Every behavioural change requires correctness review', textFiles, reviewUnits, maxBatchChars),
    agentPlan('prg-tests', 'Every behavioural change requires regression-signal review', textFiles, reviewUnits, maxBatchChars)
  ];

  for (const route of ROUTES) {
    const matching = textFiles.filter(file => route.patterns.some(pattern => pattern.test(`${file.path}\n${file.patch}`)));
    if (matching.length) agents.push(agentPlan(route.name, route.reason, matching, reviewUnits, maxBatchChars));
  }

  return {
    schemaVersion: '1.0',
    snapshot: {
      provider: packet.provider,
      repositoryId: packet.repository.id,
      pullRequestNumber: packet.pullRequest.number,
      baseSha: packet.pullRequest.base.sha,
      headSha: packet.pullRequest.head.sha
    },
    reviewUnits,
    agents,
    excludedFiles: packet.files
      .filter(file => file.isBinary || !file.patch)
      .map(file => ({ path: file.path, reason: file.isBinary ? 'binary' : 'patch-unavailable' })),
    warnings: [...(packet.limits?.warnings ?? []), ...(allPaths.length ? [] : ['No reviewable text patches were collected'])]
  };
}

function agentPlan(name, reason, files, reviewUnits, maxBatchChars) {
  const paths = new Set(files.map(file => file.path));
  const units = reviewUnits.filter(unit => paths.has(unit.path));
  return {
    name,
    reason,
    files: files.map(file => file.path),
    units: units.map(unit => unit.id),
    batches: makeBatches(units, maxBatchChars)
  };
}

function buildReviewUnits(files, maxChars) {
  return files.flatMap((file, fileIndex) => {
    const patch = String(file.patch ?? '');
    if (patch.length <= maxChars) {
      return [{
        id: reviewUnitId(fileIndex, 1),
        path: file.path,
        previousPath: file.previousPath ?? null,
        status: file.status,
        changeTrackingId: file.changeTrackingId ?? null,
        representation: 'unified-diff',
        changedLine: null,
        part: 1,
        totalParts: 1,
        content: patch
      }];
    }

    const semantic = semanticJsonDelta(file);
    if (!semantic) {
      throw new DiscoveryUnitCapacityError(file.path, patch.length, maxChars);
    }
    const chunks = chunkOperations(file.path, semantic.changedLine, semantic.operations, maxChars);
    return chunks.map((content, index) => ({
      id: reviewUnitId(fileIndex, index + 1),
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      changeTrackingId: file.changeTrackingId ?? null,
      representation: 'semantic-json-delta',
      changedLine: semantic.changedLine,
      part: index + 1,
      totalParts: chunks.length,
      content
    }));
  });
}

function reviewUnitId(fileIndex, part) {
  return `unit-${String(fileIndex + 1).padStart(4, '0')}-${String(part).padStart(4, '0')}`;
}

function semanticJsonDelta(file) {
  if (!String(file.path).toLowerCase().endsWith('.json')) return null;
  const lines = String(file.patch ?? '').split(/\r?\n/);
  const removed = [];
  const added = [];
  let changedLine = null;
  let inHunk = false;

  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      changedLine ??= Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('@@ ')) return null;
    if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
    if (line.startsWith(' ')) return null;
  }

  if (removed.length !== 1 || added.length !== 1 || !Number.isInteger(changedLine)) return null;
  let before;
  let after;
  try {
    before = parseLosslessJson(removed[0]);
    after = parseLosslessJson(added[0]);
  } catch {
    return null;
  }
  const operations = [];
  diffJson(before, after, '', operations, true, true);
  return operations.length ? { changedLine, operations } : null;
}

function diffJson(before, after, pointer, operations, beforePresent, afterPresent) {
  if (beforePresent && afterPresent && isJsonNumberLexeme(before) && isJsonNumberLexeme(after)) {
    if (before.value === after.value) return;
    operations.push({
      op: 'replace',
      path: pointer || '/',
      before,
      after
    });
    return;
  }
  if (beforePresent && afterPresent && Object.is(before, after)) return;

  if (beforePresent && afterPresent && isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      diffJson(
        before[key],
        after[key],
        `${pointer}/${escapePointer(key)}`,
        operations,
        Object.hasOwn(before, key),
        Object.hasOwn(after, key)
      );
    }
    return;
  }

  if (beforePresent && afterPresent && Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffJson(
        before[index],
        after[index],
        `${pointer}/${index}`,
        operations,
        index < before.length,
        index < after.length
      );
    }
    return;
  }

  if (!beforePresent && afterPresent && (isRecord(after) || Array.isArray(after))) {
    operations.push({
      op: 'add-container',
      path: pointer || '/',
      container: Array.isArray(after) ? 'array' : 'object'
    });
    const entries = Array.isArray(after)
      ? after.map((value, index) => [String(index), value])
      : Object.entries(after).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length) {
      for (const [key, value] of entries) {
        diffJson(undefined, value, `${pointer}/${escapePointer(key)}`, operations, false, true);
      }
      return;
    }
    return;
  }

  if (beforePresent && !afterPresent && (isRecord(before) || Array.isArray(before))) {
    operations.push({
      op: 'remove-container',
      path: pointer || '/',
      container: Array.isArray(before) ? 'array' : 'object'
    });
    const entries = Array.isArray(before)
      ? before.map((value, index) => [String(index), value])
      : Object.entries(before).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length) {
      for (const [key, value] of entries) {
        diffJson(value, undefined, `${pointer}/${escapePointer(key)}`, operations, true, false);
      }
      return;
    }
    return;
  }

  operations.push({
    op: beforePresent ? (afterPresent ? 'replace' : 'remove') : 'add',
    path: pointer || '/',
    ...(beforePresent ? { before } : {}),
    ...(afterPresent ? { after } : {})
  });
}

function isRecord(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function escapePointer(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function chunkOperations(filePath, changedLine, operations, maxChars) {
  const chunks = [];
  let current = [];

  for (const operation of operations) {
    const candidate = [...current, operation];
    const content = semanticContent(filePath, changedLine, candidate);
    if (content.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (!current.length) {
      throw new DiscoveryUnitCapacityError(
        filePath,
        content.length,
        maxChars,
        operation.path
      );
    }
    chunks.push(semanticContent(filePath, changedLine, current));
    current = [operation];
    if (semanticContent(filePath, changedLine, current).length > maxChars) {
      throw new DiscoveryUnitCapacityError(
        filePath,
        semanticContent(filePath, changedLine, current).length,
        maxChars,
        operation.path
      );
    }
  }

  if (current.length) chunks.push(semanticContent(filePath, changedLine, current));
  return chunks;
}

function semanticContent(filePath, changedLine, operations) {
  return JSON.stringify({
    representation: 'semantic-json-delta',
    path: filePath,
    changedLine,
    operations
  });
}

function makeBatches(units, maxChars) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const unit of units) {
    const size = unit.content.length;
    if (current.length && currentChars + size > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(unit.id);
    currentChars += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const input = flags._[0];
  const output = flags._[1];
  if (!input || !output) throw new Error('Usage: build-review-plan.mjs PACKET_JSON PLAN_JSON [--max-batch-chars N]');
  const packet = await readJson(path.resolve(input));
  await writeJson(path.resolve(output), buildReviewPlan(packet, { maxBatchChars: flags['max-batch-chars'] }));
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
