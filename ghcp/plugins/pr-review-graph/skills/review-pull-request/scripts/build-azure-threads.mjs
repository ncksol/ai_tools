#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { authorComment, isChangedLine, isMain, normalizePath, parseFlags, readJson, severityRank, writeJson } from './lib.mjs';

export function buildAzureThreads(packet, value) {
  if (packet.provider !== 'azure-devops') throw new Error('Packet provider must be azure-devops');
  const findings = unwrap(value).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const latestIteration = Number(packet.providerData?.latestIterationId ?? 0);

  return findings.map(finding => {
    assertPublishable(finding);
    const marker = `<!-- pr-review-graph:${finding.fingerprint} -->`;
    const payload = {
      comments: [{ parentCommentId: 0, content: `${authorComment(finding)}\n\n${marker}`, commentType: 1 }],
      status: 1
    };
    const location = finding.location;
    const file = location ? packet.files.find(item => item.path === location.path) : null;
    if (location?.side === 'RIGHT' && file && isChangedLine(file, location.line, 'RIGHT')) {
      payload.threadContext = {
        filePath: `/${normalizePath(location.path)}`,
        rightFileStart: { line: location.startLine ?? location.line, offset: 1 },
        rightFileEnd: { line: location.line, offset: 1 }
      };
      const changeTrackingId = location.changeTrackingId ?? file.changeTrackingId;
      if (changeTrackingId || latestIteration) {
        payload.pullRequestThreadContext = {};
        if (changeTrackingId) payload.pullRequestThreadContext.changeTrackingId = changeTrackingId;
        if (latestIteration) {
          payload.pullRequestThreadContext.iterationContext = {
            firstComparingIteration: Number(packet.providerData?.firstComparingIteration ?? 1),
            secondComparingIteration: latestIteration
          };
        }
      }
    }
    return { fingerprint: finding.fingerprint, inline: Boolean(payload.threadContext), payload };
  });
}

function unwrap(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  return [...(value?.inlineFindings ?? []), ...(value?.summaryFindings ?? [])];
}

function assertPublishable(finding) {
  if (!/^[a-f0-9]{64}$/.test(finding.fingerprint ?? '')) throw new Error(`Finding lacks a valid fingerprint: ${finding.title ?? 'untitled'}`);
  if (finding.deduplication?.verdict !== 'distinct') throw new Error(`Finding has not passed existing-review deduplication: ${finding.title ?? 'untitled'}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [packetFile, findingsFile, outputDirectory] = flags._;
  if (!packetFile || !findingsFile || !outputDirectory) {
    throw new Error('Usage: build-azure-threads.mjs PACKET_JSON FINAL_FINDINGS_JSON THREAD_PAYLOAD_DIR');
  }
  const packet = await readJson(path.resolve(packetFile));
  const findings = await readJson(path.resolve(findingsFile));
  const threads = buildAzureThreads(packet, findings);
  const destination = path.resolve(outputDirectory);
  await mkdir(destination, { recursive: true });
  const index = [];
  for (let indexNumber = 0; indexNumber < threads.length; indexNumber += 1) {
    const thread = threads[indexNumber];
    const fileName = `thread-${String(indexNumber + 1).padStart(3, '0')}-${thread.fingerprint.slice(0, 8)}.json`;
    await writeJson(path.join(destination, fileName), thread.payload);
    index.push({ file: fileName, fingerprint: thread.fingerprint, inline: thread.inline });
  }
  await writeJson(path.join(destination, 'index.json'), { threads: index });
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
