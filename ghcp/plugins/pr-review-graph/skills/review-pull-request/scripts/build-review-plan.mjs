#!/usr/bin/env node
import path from 'node:path';
import { isMain, parseFlags, readJson, writeJson } from './lib.mjs';

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

export function buildReviewPlan(packet, options = {}) {
  const maxBatchChars = Number(options.maxBatchChars ?? 60_000);
  const textFiles = packet.files.filter(file => !file.isBinary && file.patch);
  const allPaths = textFiles.map(file => file.path);
  const agents = [
    agentPlan('prg-contract', 'PR intent and externally visible behaviour require review', textFiles, maxBatchChars),
    agentPlan('prg-correctness', 'Every behavioural change requires correctness review', textFiles, maxBatchChars),
    agentPlan('prg-tests', 'Every behavioural change requires regression-signal review', textFiles, maxBatchChars)
  ];

  for (const route of ROUTES) {
    const matching = textFiles.filter(file => route.patterns.some(pattern => pattern.test(`${file.path}\n${file.patch}`)));
    if (matching.length) agents.push(agentPlan(route.name, route.reason, matching, maxBatchChars));
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
    agents,
    excludedFiles: packet.files
      .filter(file => file.isBinary || !file.patch)
      .map(file => ({ path: file.path, reason: file.isBinary ? 'binary' : 'patch-unavailable' })),
    warnings: [...(packet.limits?.warnings ?? []), ...(allPaths.length ? [] : ['No reviewable text patches were collected'])]
  };
}

function agentPlan(name, reason, files, maxBatchChars) {
  return {
    name,
    reason,
    files: files.map(file => file.path),
    batches: makeBatches(files, maxBatchChars)
  };
}

function makeBatches(files, maxChars) {
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const file of files) {
    const size = String(file.patch ?? '').length;
    if (current.length && currentChars + size > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(file.path);
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
