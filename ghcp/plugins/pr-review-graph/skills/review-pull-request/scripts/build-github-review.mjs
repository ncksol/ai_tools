#!/usr/bin/env node
import path from 'node:path';
import { authorComment, isChangedLine, isMain, parseFlags, readJson, severityRank, unwrapFindings, writeJson } from './lib.mjs';

export function buildGitHubReview(packet, value) {
  if (packet.provider !== 'github') throw new Error('Packet provider must be github');
  const findings = unwrapFindings(value).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  const comments = [];
  const summary = [];

  for (const finding of findings) {
    assertPublishable(finding);
    const marker = `<!-- pr-review-graph:${finding.fingerprint} -->`;
    const body = `${authorComment(finding)}\n\n${marker}`;
    const location = finding.location;
    const file = location ? packet.files.find(item => item.path === location.path) : null;
    if (location && file && isChangedLine(file, location.line, location.side)) {
      const comment = { path: location.path, line: location.line, side: location.side, body };
      if (location.startLine && location.startLine !== location.line) {
        comment.start_line = location.startLine;
        comment.start_side = location.side;
      }
      comments.push(comment);
    } else {
      summary.push({ finding, body });
    }
  }

  const bodyParts = [`PR Review Graph found ${findings.length} verified finding${findings.length === 1 ? '' : 's'}.`];
  if (summary.length) {
    bodyParts.push('', 'Findings without a stable inline position:');
    summary.forEach(({ finding, body }, index) => {
      bodyParts.push('', `${index + 1}. ${finding.location?.path ? `\`${finding.location.path}\`: ` : ''}${body}`);
    });
  }

  return {
    commit_id: packet.pullRequest.head.sha,
    event: 'COMMENT',
    body: bodyParts.join('\n'),
    comments
  };
}

function assertPublishable(finding) {
  if (!/^[a-f0-9]{64}$/.test(finding.fingerprint ?? '')) throw new Error(`Finding lacks a valid fingerprint: ${finding.title ?? 'untitled'}`);
  if (finding.deduplication?.verdict !== 'distinct') throw new Error(`Finding has not passed existing-review deduplication: ${finding.title ?? 'untitled'}`);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [packetFile, findingsFile, outputFile] = flags._;
  if (!packetFile || !findingsFile || !outputFile) {
    throw new Error('Usage: build-github-review.mjs PACKET_JSON FINAL_FINDINGS_JSON REVIEW_PAYLOAD_JSON');
  }
  const packet = await readJson(path.resolve(packetFile));
  const findings = await readJson(path.resolve(findingsFile));
  await writeJson(path.resolve(outputFile), buildGitHubReview(packet, findings));
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
