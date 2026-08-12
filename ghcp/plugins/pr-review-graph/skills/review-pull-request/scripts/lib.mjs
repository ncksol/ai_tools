import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && fileURLToPath(metaUrl) === path.resolve(process.argv[1]);
}

export function parseFlags(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const [rawKey, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) {
      result[rawKey] = inline;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      result[rawKey] = argv[index + 1];
      index += 1;
    } else {
      result[rawKey] = true;
    }
  }
  return result;
}

export function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  if (value.every(Array.isArray)) return value.flat();
  return value;
}

export function unwrapFindings(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.findings)) return value.findings;
  throw new Error('Findings must be an array or an object with a findings array. Run apply-comments.mjs on the editor output first.');
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.value)) return value.value;
  return [];
}

export function normalizePath(value) {
  if (!value) return '';
  return String(value).replace(/^\.\//, '').replace(/^\//, '').replaceAll('\\', '/');
}

export function extractFingerprint(body) {
  const match = String(body ?? '').match(/<!--\s*pr-review-graph:([a-f0-9]{64})\s*-->/i);
  return match ? match[1].toLowerCase() : null;
}

export function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      if (current) files.push(finishDiff(current));
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = {
        path: normalizePath(match?.[2] ?? ''),
        previousPath: normalizePath(match?.[1] ?? '') || null,
        lines: [line],
        isBinary: false
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
    if (line.startsWith('+++ b/')) current.path = normalizePath(line.slice(6));
    if (line.startsWith('--- a/')) current.previousPath = normalizePath(line.slice(6));
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') current.isBinary = true;
  }
  if (current) files.push(finishDiff(current));
  return files.filter(file => file.path);
}

function finishDiff(file) {
  return {
    path: file.path,
    previousPath: file.previousPath === file.path ? null : file.previousPath,
    patch: `${file.lines.join('\n')}\n`,
    isBinary: file.isBinary
  };
}

export function changedLines(patch, side = 'RIGHT') {
  const result = new Set();
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(patch ?? '').split(/\r?\n/)) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (side === 'RIGHT') result.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (side === 'LEFT') result.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return result;
}

export function isChangedLine(file, line, side = 'RIGHT') {
  return Boolean(file?.patch) && changedLines(file.patch, side).has(Number(line));
}

export function severityRank(severity) {
  return { blocker: 0, high: 1, medium: 2, low: 3 }[severity] ?? 9;
}

export function normalizeFindingText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/`[^`]+`/g, ' code ')
    .replace(/\b\d+\b/g, ' number ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function authorComment(finding) {
  if (finding.comment?.trim()) return finding.comment.trim();
  const severity = finding.severity[0].toUpperCase() + finding.severity.slice(1);
  return [
    `**${severity} — ${finding.title}**`,
    '',
    sentence(finding.problem),
    `This occurs when ${lowerFirst(finding.trigger)}.`,
    `Consequence: ${sentence(finding.consequence)}`,
    `Evidence: ${sentence(finding.evidence)}`,
    `Suggested direction: ${sentence(finding.recommendation)}`
  ].join('\n');
}

function lowerFirst(value) {
  const text = String(value ?? '').trim();
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
}

function sentence(value) {
  const text = String(value ?? '').trim();
  if (!text) return text;
  const capitalized = `${text[0].toUpperCase()}${text.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}
