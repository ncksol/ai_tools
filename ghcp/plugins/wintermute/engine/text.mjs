/**
 * A copy of a string that keeps no larger string alive. V8 can represent a substring (from slice, split or a regex
 * match) as a view into its parent, so a short text kept from a log line could pin the whole chunk it was read from.
 * Concatenating forces a flat copy; the slice then refers to that copy only.
 */
export function ownString(value) {
  return value.length ? (' ' + value).slice(1) : value;
}

export function oneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return ownString(text.length > max ? `${text.slice(0, max - 1)}…` : text);
}

export function clip(value, max) {
  if (typeof value !== 'string') return null;
  return ownString(value.length > max ? `${value.slice(0, max - 1)}…` : value);
}

export function firstLine(value) {
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
