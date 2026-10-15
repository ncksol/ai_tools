import { parseTime } from '../time.mjs';

/** Strings longer than this (in raw bytes, escapes included) are not captured at all, never in part. */
export const MAX_VALUE_BYTES = 4096;
const MAX_LITERAL_BYTES = 64;
const MAX_DEPTH = 256;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const NUMBER = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const isSpace = byte => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

function decodeString(raw) {
  try {
    return JSON.parse(`"${Buffer.from(raw).toString('utf8')}"`);
  } catch {
    return undefined;
  }
}

/**
 * An incremental JSON scanner for one log line that is too big to hold. Feed it the line's bytes in any number of pieces;
 * it keeps no line bytes, only a stack of containers (bounded by MAX_DEPTH), the string it is inside, and the values it
 * captures. It captures primitive values (strings of at most MAX_VALUE_BYTES, numbers, true, false, null) of keys at depth 1
 * (the event's own keys) and at depth 2 directly under the top-level key `data`. Keys at any other depth are ignored, so a
 * nested "type":"text" never counts. Structural characters are ASCII and never occur inside a UTF-8 sequence, so it works
 * on bytes; a captured string is decoded once, when it ends.
 *
 * finish() returns { ...depth-1 values, data: { ...data values } } when that has a string `type` and a parseable
 * `timestamp`, and null otherwise.
 */
export function createJsonScanner() {
  const stack = [];
  const event = new Map();
  const data = new Map();
  let broken = false;
  let done = false;
  let inString = false;
  let escaped = false;
  let role = 'value';
  let collect = false;
  let overflow = false;
  let raw = [];
  let literal = null;

  /** Where a primitive value at the current position is stored, or null when this position is not captured. */
  function target() {
    const frame = stack[stack.length - 1];
    if (!frame || frame.kind !== 'object' || frame.currentKey === null) return null;
    if (stack.length === 1) return event;
    if (stack.length === 2 && frame.key === 'data') return data;
    return null;
  }

  function finishLiteral() {
    if (literal === null) return;
    const bytes = literal;
    literal = null;
    if (bytes.length > MAX_LITERAL_BYTES) return;
    const map = target();
    if (!map) return;
    const text = Buffer.from(bytes).toString('latin1');
    const key = stack[stack.length - 1].currentKey;
    if (text === 'true') map.set(key, true);
    else if (text === 'false') map.set(key, false);
    else if (text === 'null') map.set(key, null);
    else if (NUMBER.test(text) && Number.isFinite(Number(text))) map.set(key, Number(text));
  }

  function startString() {
    const frame = stack[stack.length - 1];
    inString = true;
    escaped = false;
    overflow = false;
    raw = [];
    if (frame && frame.kind === 'object' && frame.expectKey) {
      role = 'key';
      collect = true;
    } else {
      role = 'value';
      collect = target() !== null;
    }
  }

  function endString() {
    inString = false;
    const frame = stack[stack.length - 1];
    if (!collect) return;
    const text = overflow ? undefined : decodeString(raw);
    raw = [];
    if (role === 'key') {
      frame.currentKey = text === undefined ? null : text;
      frame.expectKey = false;
    } else if (text !== undefined) {
      const map = target();
      if (map) map.set(frame.currentKey, text);
    }
  }

  function push(kind) {
    const parent = stack[stack.length - 1];
    if (stack.length >= MAX_DEPTH) {
      broken = true;
      return;
    }
    stack.push({ kind, key: parent && parent.kind === 'object' ? parent.currentKey : null, currentKey: null, expectKey: kind === 'object' });
  }

  return {
    /** Scan buffer[start, end). */
    write(buffer, start = 0, end = buffer.length) {
      for (let i = start; i < end && !broken && !done; i += 1) {
        const byte = buffer[i];
        if (inString) {
          const closing = byte === QUOTE && !escaped;
          if (collect && !overflow && !closing) {
            if (raw.length >= MAX_VALUE_BYTES) {
              overflow = true;
              raw = [];
            } else {
              raw.push(byte);
            }
          }
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (closing) endString();
          continue;
        }
        if (byte === QUOTE) {
          finishLiteral();
          startString();
        } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
          finishLiteral();
          push(byte === OPEN_BRACE ? 'object' : 'array');
        } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          finishLiteral();
          stack.pop();
          if (!stack.length) done = true;
        } else if (byte === COMMA) {
          finishLiteral();
          const frame = stack[stack.length - 1];
          if (frame && frame.kind === 'object') {
            frame.currentKey = null;
            frame.expectKey = true;
          }
        } else if (byte === COLON || isSpace(byte)) {
          finishLiteral();
        } else if (literal === null) {
          literal = [byte];
        } else if (literal.length <= MAX_LITERAL_BYTES) {
          literal.push(byte);
        }
      }
    },
    /** The recovered event, or null when it has no string type or no parseable timestamp. */
    finish() {
      if (broken || stack.length || inString) return null;
      const top = Object.fromEntries(event);
      if (typeof top.type !== 'string' || parseTime(top.timestamp) === null) return null;
      return { ...top, data: Object.fromEntries(data) };
    },
  };
}
