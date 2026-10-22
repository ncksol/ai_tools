export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** Epoch ms from an ISO 8601 string, an SQLite UTC datetime ('YYYY-MM-DD HH:MM:SS') or a number; otherwise null. */
export function parseTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const plain = SQLITE_UTC.exec(text);
  const ms = Date.parse(plain ? `${plain[1]}T${plain[2]}Z` : text);
  return Number.isFinite(ms) ? ms : null;
}

export function maxTime(...values) {
  let best = null;
  for (const value of values) if (Number.isFinite(value) && (best === null || value > best)) best = value;
  return best;
}

export function minTime(...values) {
  let best = null;
  for (const value of values) if (Number.isFinite(value) && (best === null || value < best)) best = value;
  return best;
}

export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
