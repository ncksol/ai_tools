export const HEADINGS = Object.freeze([
  'Decision',
  'Context and decision drivers',
  'Options considered',
  'Rationale',
  'Consequences',
  'Confidence and reconsideration',
  'References',
]);

export const METADATA = Object.freeze(['Status', 'Date', 'Decision owner']);

export function validateAdr(text) {
  const errors = [];
  const titles = [];
  const sections = [];
  const header = [];
  const metadata = new Map(METADATA.map(label => [label, []]));
  const lines = text.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  let fence;
  let comment = false;
  let current;

  for (const [index, original] of lines.entries()) {
    const location = index + 1;
    let line = original;
    let marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        fence = undefined;
      } else if (current && line.trim()) {
        current.content = true;
      }
      continue;
    }
    const visible = scanInlineSyntax(line, comment);
    line = visible.text;
    comment = visible.comment;
    marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      if (!current) header.push('content');
      fence = marker[1];
      continue;
    }
    if (/\{\{[^{}\n]+\}\}/.test(visible.prose)) errors.push(`Line ${location}: unresolved template placeholder`);
    const heading = line.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/);
    if (heading) {
      const name = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      if (heading[1].length === 1) titles.push({ name, location });
      if (!current && heading[1].length !== 2) {
        header.push(heading[1].length === 1 ? 'title' : 'content');
      }
      if (heading[1].length === 2) {
        current = { name, location, content: false };
        sections.push(current);
      }
      continue;
    }
    const field = line.match(/^- (Status|Date|Decision owner):[ \t]*(.*)$/);
    if (field && !current) {
      header.push(field[1]);
      metadata.get(field[1]).push({ value: field[2].trim(), location });
      if (titles.length !== 1) {
        errors.push(`Line ${location}: ${field[1]} metadata must follow the title and precede all sections`);
      }
    } else if (current && line.trim()) {
      current.content = true;
    } else if (line.trim()) {
      header.push('content');
    }
  }

  if (fence) errors.push('Unclosed fenced code block');
  if (comment) errors.push('Unclosed HTML comment');
  if (titles.length !== 1 || !titles[0]?.name) errors.push('Expected exactly one nonempty level-one title');
  if (header.join('\n') !== ['title', ...METADATA].join('\n')) {
    errors.push(`Header must contain only a title followed by ${METADATA.join(', ')} metadata in that order`);
  }
  if (titles[0] && sections[0] && titles[0].location > sections[0].location) {
    errors.push('The title must precede all section headings');
  }
  const names = sections.map(section => section.name);
  if (names.join('\n') !== HEADINGS.join('\n')) {
    errors.push(`Level-two headings must appear exactly once in this order: ${HEADINGS.join('; ')}. Found: ${names.join('; ') || '(none)'}`);
  }
  for (const section of sections) {
    if (!section.content) errors.push(`${section.name || '(unnamed section)'} must contain content`);
  }
  for (const label of METADATA) {
    const fields = metadata.get(label);
    if (fields.length !== 1 || !fields[0]?.value) {
      errors.push(`${label}: expected exactly one nonempty metadata value`);
      continue;
    }
    const value = fields[0].value;
    if (label === 'Status' && !['Proposed', 'Accepted', 'Superseded'].includes(value)) {
      errors.push('Status must be Proposed, Accepted, or Superseded');
    }
    if (label === 'Date' && value !== 'Not provided') {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== value) {
        errors.push('Date must be a real YYYY-MM-DD date or Not provided');
      }
    }
  }
  return errors;
}

function scanInlineSyntax(line, comment) {
  const tokens = /`+|<!--|-->/g;
  let text = '';
  let prose = '';
  let cursor = 0;
  let match;
  while ((match = tokens.exec(line))) {
    const token = match[0];
    if (!comment) {
      text += line.slice(cursor, match.index);
      prose += line.slice(cursor, match.index);
    }
    cursor = tokens.lastIndex;
    if (comment) {
      if (token === '-->') comment = false;
      continue;
    }
    const escaped = (line.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
    if (escaped) {
      const literal = token.startsWith('`') ? '`' : token;
      text += literal;
      prose += literal;
      cursor = match.index + literal.length;
      tokens.lastIndex = cursor;
      continue;
    }
    if (token === '<!--') {
      comment = true;
      continue;
    }
    if (token.startsWith('`')) {
      const runs = /`+/g;
      runs.lastIndex = cursor;
      let closing;
      while ((closing = runs.exec(line))) {
        if (closing[0].length === token.length) break;
      }
      if (closing) {
        text += line.slice(match.index, runs.lastIndex);
        // Keep literal syntax for structure checks, but not placeholder detection.
        prose += ' '.repeat(runs.lastIndex - match.index);
        cursor = runs.lastIndex;
        tokens.lastIndex = cursor;
        continue;
      }
    }
    text += token;
    prose += token;
  }
  if (!comment) {
    text += line.slice(cursor);
    prose += line.slice(cursor);
  }
  return { text, prose, comment };
}
