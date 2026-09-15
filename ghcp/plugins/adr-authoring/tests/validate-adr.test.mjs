import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAdr } from '../scripts/adr-contract.mjs';

const cli = fileURLToPath(new URL('../scripts/validate-adr.mjs', import.meta.url));
const valid = `# ADR-0001: Queue export jobs

- Status: Proposed
- Date: 2026-09-15
- Decision owner: Export team

## Decision

Queue export jobs.

## Context and decision drivers

Requests must not wait for export completion.

## Options considered

The team considered synchronous processing and a queue.

## Rationale

A queue separates request handling from export completion.

## Consequences

Workers must handle duplicate jobs.

## Confidence and reconsideration

Decision confidence was not provided.

## References

User-provided export brief.
`;

test('accepts the complete contract with LF or CRLF', () => {
  assert.deepEqual(validateAdr(valid), []);
  assert.deepEqual(validateAdr(valid.replaceAll('\n', '\r\n')), []);
});

test('accepts a UTF-8 BOM with LF or CRLF without rewriting the input', () => {
  assert.deepEqual(validateAdr(`\uFEFF${valid}`), []);
  assert.deepEqual(validateAdr(`\uFEFF${valid.replaceAll('\n', '\r\n')}`), []);
});

test('treats metadata-shaped body bullets as section content', () => {
  for (const bullet of [
    '- Status: Accepted (predecessor)',
    '- Date: 2026-09-01 predecessor acceptance',
    '- Decision owner: Previous team',
  ]) {
    assert.deepEqual(validateAdr(valid.replace('User-provided export brief.', bullet)), []);
  }
});

test('allows blank lines and comments between the fixed header elements', () => {
  const text = valid.replace('- Date:', '<!-- date provenance -->\n\n- Date:');
  assert.deepEqual(validateAdr(text), []);
});

test('allows honest unknown metadata and supplied lifecycle statuses', () => {
  for (const status of ['Proposed', 'Accepted', 'Superseded']) {
    const text = valid.replace('Status: Proposed', `Status: ${status}`)
      .replace('Date: 2026-09-15', 'Date: Not provided')
      .replace('Decision owner: Export team', 'Decision owner: Not provided');
    assert.deepEqual(validateAdr(text), []);
  }
});

const invalidCases = [
  ['empty document', '', /title|heading/i],
  ['missing title', valid.replace('# ADR-0001: Queue export jobs', ''), /title/i],
  ['duplicate title', `${valid}\n# Another decision\n`, /title/i],
  ['missing section', valid.replace('## Rationale\n\nA queue separates request handling from export completion.\n\n', ''), /Rationale/],
  ['reordered sections', valid.replace('## Decision', '## Rationale').replace('## Rationale\n\nA queue', '## Decision\n\nA queue'), /order/i],
  ['duplicate section', `${valid}\n## Decision\n\nAnother choice.\n`, /Decision/],
  ['unexpected section', `${valid}\n## Appendix\n\nText.\n`, /Appendix/],
  ['empty section', valid.replace('Queue export jobs.\n', ''), /Decision.*content/i],
  ['subheading without content', valid.replace('Queue export jobs.\n', '### Scope\n'), /Decision.*content/i],
  ['missing metadata', valid.replace('- Status: Proposed\n', ''), /Status/],
  ['duplicate metadata', valid.replace('- Status: Proposed', '- Status: Proposed\n- Status: Accepted'), /Status/],
  ['blank owner', valid.replace('Decision owner: Export team', 'Decision owner: '), /Decision owner/],
  ['unknown status', valid.replace('Status: Proposed', 'Status: Approved'), /Status/],
  ['impossible date', valid.replace('2026-09-15', '2026-02-29'), /Date/],
  ['non-ISO date', valid.replace('2026-09-15', '15/09/2026'), /Date/],
  ['zero year', valid.replace('2026-09-15', '0000-01-01'), /Date/],
  ['placeholder', valid.replace('Queue export jobs.', '{{DECISION}}'), /placeholder/i],
  ['metadata after first section', valid.replace('- Status: Proposed\n', '').replace('Queue export jobs.', '- Status: Proposed\nQueue export jobs.'), /Status/],
  ['metadata before title', `- Status: Accepted\n${valid}`, /metadata|Status/i],
  ['reordered metadata', valid.replace('- Status: Proposed\n- Date: 2026-09-15', '- Date: 2026-09-15\n- Status: Proposed'), /metadata.*order/i],
  ['unexpected preamble', valid.replace('- Status:', 'Unexpected preamble.\n\n- Status:'), /header/i],
  ['extra header bullet', valid.replace('- Date:', '- Review score: 10\n- Date:'), /header/i],
  ['subheading in header', valid.replace('- Date:', '### Metadata\n- Date:'), /header/i],
  ['fenced code in header', valid.replace('- Date:', '```\nextra\n```\n- Date:'), /header/i],
  ['comment-only section', valid.replace('Queue export jobs.', '<!-- write the decision here -->'), /Decision.*content/i],
  ['unclosed code fence', `${valid}\n\`\`\`md\n# Hidden\n`, /fence/i],
];

for (const [name, text, expected] of invalidCases) {
  test(`rejects ${name}`, () => {
    assert.match(validateAdr(text).join('\n'), expected);
  });
}

test('accepts leap days only in leap years', () => {
  assert.deepEqual(validateAdr(valid.replace('2026-09-15', '2024-02-29')), []);
  assert.match(validateAdr(valid.replace('2026-09-15', '1900-02-29')).join('\n'), /Date/);
});

test('ignores headings and metadata inside fenced code and comments', () => {
  const code = '\n````markdown\n# Not a title\n## Not a section\n- Status: Invalid\n```\n````\n';
  assert.deepEqual(validateAdr(valid.replace('Queue export jobs.', `Queue export jobs.\n${code}`)), []);
  assert.deepEqual(validateAdr(`${valid}\n<!--\n# Hidden title\n## Hidden heading\n-->\n`), []);
  assert.deepEqual(validateAdr(`${valid}\n~~~text\n## Hidden\n~~~\n`), []);
});

test('supports normal ATX heading indentation and closing hashes', () => {
  assert.deepEqual(validateAdr(valid.replace('## Decision', '  ## Decision ##')), []);
});

test('does not interpret HTML comment markers inside fenced code', () => {
  const text = valid.replace('Queue export jobs.', 'Queue export jobs.\n```html\n<!--\n```\n');
  assert.deepEqual(validateAdr(`${text}\n<!-- a real comment -->\n`), []);
});

test('reports original line numbers after multiline HTML comments', () => {
  const text = '<!--\ncomment\n-->\n' + valid.replace('Queue export jobs.\n', '{{DECISION}}\n');
  assert.ok(validateAdr(text).includes('Line 12: unresolved template placeholder'));
});

test('rejects an unclosed HTML comment that can hide document content', () => {
  assert.match(validateAdr(`${valid}\n<!-- hidden\n`).join('\n'), /unclosed.*comment/i);
});

test('preserves literal comments and placeholders in single-line code spans', () => {
  for (const prose of [
    'Use the literal `<!--` marker.',
    'Use the literal `{{NAME}}` token.',
    'Use ``a ` character, <!--, and {{NAME}}`` as literal syntax.',
    'Use ```a `` run and {{NAME}}``` as literal syntax.',
    'Use `{{ONE}}` and `{{TWO}}` separately.',
    '`{{NAME}}`',
    '`<!--`',
  ]) {
    assert.deepEqual(validateAdr(valid.replace('Queue export jobs.', prose)), []);
  }
});

test('preserves literal template tokens in code spans within the decision title', () => {
  const text = valid.replace('# ADR-0001: Queue export jobs', '# ADR-0001: Use `{{NAME}}`');
  assert.deepEqual(validateAdr(text), []);
});

test('still detects control syntax outside code spans', () => {
  assert.match(validateAdr(valid.replace('Queue export jobs.', 'Use `literal` then {{NAME}}.')).join('\n'), /placeholder/i);
  assert.match(validateAdr(valid.replace('Queue export jobs.', 'Use `literal` then <!-- hidden.')).join('\n'), /unclosed.*comment/i);
  assert.match(validateAdr(valid.replace('Queue export jobs.', 'Unmatched `{{NAME}}.')).join('\n'), /placeholder/i);
  assert.match(validateAdr(valid.replace('Queue export jobs.', 'Escaped \\`{{NAME}}\\`.')).join('\n'), /placeholder/i);
});

test('ignores code-span syntax inside comments', () => {
  const text = valid.replace('Queue export jobs.', 'Queue export jobs. <!-- `{{NAME}}` -->');
  assert.deepEqual(validateAdr(text), []);
});

test('respects escaped comment openers outside code', () => {
  assert.deepEqual(validateAdr(valid.replace('Queue export jobs.', 'Use \\<!-- as an escaped marker.')), []);
  assert.match(validateAdr(valid.replace('Queue export jobs.', 'Use \\\\<!-- as a real comment.')).join('\n'), /unclosed.*comment/i);
});

test('CLI reports usage and missing files without success output', () => {
  const usage = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage:/);
  const missing = spawnSync(process.execPath, [cli, '/missing-adr-authoring-test/file.md'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /file\.md.*ENOENT/);
  assert.equal(missing.stdout, '');
});

test('CLI validates multiple files, preserves input, and aggregates failure', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'adr-validator-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'valid record.md');
  const bad = path.join(dir, 'invalid.md');
  await writeFile(good, valid);
  await writeFile(bad, '# Empty\n');
  const result = spawnSync(process.execPath, [cli, good, bad], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /valid record\.md.*structure passed/);
  assert.match(result.stderr, /invalid\.md/);
  assert.equal(await readFile(good, 'utf8'), valid);
  const passing = spawnSync(process.execPath, [cli, good], { encoding: 'utf8' });
  assert.equal(passing.status, 0);
  assert.equal(passing.stderr, '');
});
