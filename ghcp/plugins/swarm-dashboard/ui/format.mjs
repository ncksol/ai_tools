/** Pure formatting helpers for the views. No DOM access: Node tests import this module. */
export const MIN = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;
/** Dollars per AI credit at list price; equal to CREDIT_USD in engine/schema.mjs. */
export const CREDIT_USD = 0.01;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NUMBER = new Intl.NumberFormat('en-US');
const ONE_DECIMAL = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const CENTS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = value => String(value).padStart(2, '0');

/** Escape text for HTML text and attribute values. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);
}

/**
 * Format a duration. 'short': 2d 4h, 3h 05m, 12m, 40s. 'clock': 1d 02h 03m 04s, 3h 05m 01s, 12m 04s.
 * 'age': just now, 12m ago, 3h ago, 1d 4h ago. 'hm': 72h 10m.
 */
export function dur(ms, format = 'short') {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (format === 'clock') return d ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s` : h ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
  if (format === 'age') return total < 45 ? 'just now' : d ? `${d}d ${h}h ago` : h ? `${h}h ago` : `${Math.max(1, m)}m ago`;
  if (format === 'hm') return `${Math.floor(total / 3600)}h ${pad(m)}m`;
  return d ? `${d}d ${h}h` : h ? `${h}h ${pad(m)}m` : m ? `${m}m` : `${s}s`;
}

/** Text of a live time: 'left' counts down to `at`; every other format measures the time since `at`. */
export function tickText(at, format, now) {
  return format === 'left' ? dur(at - now, 'short') : dur(now - at, format);
}

/** A time span that ui/main.mjs refreshes every second. */
export function liveTime(at, now, format = 'short') {
  return `<span data-t="${at}" data-f="${format}">${tickText(at, format, now)}</span>`;
}
export const elapsed = (at, now) => liveTime(at, now, 'short');
export const ago = (at, now) => liveTime(at, now, 'age');
export const countdown = (at, now) => liveTime(at, now, 'left');

export const count = value => NUMBER.format(value);
export const credits = value => `${value >= 10 || value === 0 ? NUMBER.format(Math.round(value)) : ONE_DECIMAL.format(value)} cr`;
export const usd = value => `≈$${CENTS.format(value * CREDIT_USD)}`;
export const usdRounded = value => `≈$${NUMBER.format(Math.round(value * CREDIT_USD))}`;
export const costText = value => `${credits(value)} · ${usd(value)}`;
/** Credits, then dollars in a smaller muted span; totals round the dollars to whole numbers. */
export const costHtml = (value, total = false) => `${credits(value)}<span class="usd"> · ${total ? usdRounded(value) : usd(value)}</span>`;

/** Local date and time, for example "8 Oct 09:12". */
export function dateTime(ms) {
  const date = new Date(ms);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export const dateRange = (start, end) => (end == null ? `from ${dateTime(start)}` : `${dateTime(start)} to ${dateTime(end)}`);
export const plural = (n, one, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
