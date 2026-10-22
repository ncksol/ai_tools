import { open, stat } from 'node:fs/promises';
import { parseTime } from '../time.mjs';
import { createJsonScanner } from './json-scan.mjs';

export const MAX_LINE_BYTES = 16 * 1024 * 1024;

const NEWLINE = 10;
const CARRIAGE_RETURN = 13;

/**
 * pending: Buffer copies of the unfinished last line, with their byte count. skipping: the current line was over the
 * size limit, so its bytes are not kept (they are counted in skipBytes and fed to a JSON scanner) until the next newline.
 */
function freshPartial(tail) {
  tail.pending = [];
  tail.pendingBytes = 0;
  tail.skipping = false;
  tail.skipBytes = 0;
  tail.scanner = null;
  tail.scanError = null;
  tail.scanFailed = false;
}

export function createTail(file) {
  const tail = { file, offset: 0, ino: null };
  freshPartial(tail);
  return tail;
}

/**
 * Deliver complete lines appended since the last call, reading by byte offset in fixed-size chunks with async reads, so
 * memory stays bounded however large the log is and large logs do not block the event loop. A file that shrank or was
 * replaced restarts at byte 0 and reports reset.
 *
 * An unfinished last line is kept as Buffer copies and decoded once, when its newline arrives (a newline byte never
 * occurs inside a UTF-8 sequence). A line longer than maxLineBytes is never delivered: its bytes are dropped until the
 * next newline, and the result reports it as skipped and skippedBytes (both present only when something was skipped).
 * Each skipped line is scanned as it streams past (json-scan.mjs), and onOversized(event | null, bytes) is called once at its
 * end in place of onLine: event holds the line's type, timestamp and other depth-1 keys and its data's primitive keys, or
 * is null when none could be recovered.
 *
 * Every line is applied or counted before its chunk's bytes count as read: tail.offset and the result's bytes move past a
 * chunk only after its whole line loop has run (each read still starts at tail.offset). onLine and onOversized are called
 * inside a per-line try/catch, so a line that throws is counted as failed, once, and the lines after it in the chunk are
 * still delivered. The result reports failed (a count) and lastError (the first error of the last failed line, at most 200
 * characters), both present only when a line failed. A scanner that throws makes its oversized line unrecoverable:
 * onOversized(null, bytes), counted as failed.
 */
export async function readNewLines(tail, onLine, { chunkSize = 256 * 1024, onReset = null, onOversized = null, maxLineBytes = MAX_LINE_BYTES } = {}) {
  let info;
  try {
    info = await stat(tail.file);
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true, reset: false, lines: 0, bytes: 0 };
    throw error;
  }
  let reset = false;
  if ((tail.ino !== null && info.ino !== tail.ino) || info.size < tail.offset) {
    tail.offset = 0;
    freshPartial(tail);
    reset = true;
    if (onReset) onReset();
  }
  tail.ino = info.ino;
  if (info.size === tail.offset) return { missing: false, reset, lines: 0, bytes: 0 };
  let lines = 0;
  let bytes = 0;
  let skipped = 0;
  let skippedBytes = 0;
  let failed = 0;
  let lastError = '';
  const fail = error => {
    failed += 1;
    let message;
    try {
      message = String(error?.message ?? error);
    } catch {
      message = '';
    }
    lastError = (message || 'empty error').slice(0, 200);
  };
  const scan = (chunk, start, end) => {
    if (tail.scanFailed) return;
    try {
      tail.scanner.write(chunk, start, end);
    } catch (error) {
      tail.scanFailed = true;
      tail.scanError = error;
    }
  };
  const deliver = (chunk, start, end) => {
    let line = tail.pending.length ? Buffer.concat([...tail.pending, chunk.subarray(start, end)]) : chunk.subarray(start, end);
    freshPartial(tail);
    if (line.length && line[line.length - 1] === CARRIAGE_RETURN) line = line.subarray(0, -1);
    if (!line.length) return;
    lines += 1;
    try {
      onLine(line.toString('utf8'));
    } catch (error) {
      fail(error);
    }
  };
  const handle = await open(tail.file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkSize, info.size - tail.offset)));
    while (tail.offset < info.size) {
      const length = Math.min(buffer.length, info.size - tail.offset);
      const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline === -1 ? chunk.length : newline;
        if (!tail.skipping && tail.pendingBytes + (end - start) > maxLineBytes) {
          tail.skipping = true;
          tail.skipBytes = tail.pendingBytes;
          // Scan the whole oversized line as it streams past, starting with the bytes already held. No line bytes are kept.
          tail.scanner = createJsonScanner();
          for (const part of tail.pending) scan(part, 0, part.length);
          tail.pending = [];
          tail.pendingBytes = 0;
        }
        if (tail.skipping) {
          tail.skipBytes += end - start;
          scan(chunk, start, end);
          if (newline !== -1) {
            skipped += 1;
            skippedBytes += tail.skipBytes + 1;
            let recovered = null;
            let lineFailed = tail.scanFailed;
            let lineError = tail.scanError;
            if (!lineFailed) {
              try {
                recovered = tail.scanner.finish();
              } catch (error) {
                lineFailed = true;
                lineError = error;
              }
            }
            const lineBytes = tail.skipBytes + 1;
            freshPartial(tail);
            if (onOversized) {
              try {
                onOversized(recovered, lineBytes);
              } catch (error) {
                if (!lineFailed) {
                  lineFailed = true;
                  lineError = error;
                }
              }
            }
            // A line counts as failed once, whichever of the scanner and the handler threw. Failure is a flag, not the thrown
            // value, which may be falsy.
            if (lineFailed) fail(lineError);
          }
        } else if (newline === -1) {
          tail.pending.push(Buffer.from(chunk.subarray(start, end)));
          tail.pendingBytes += end - start;
        } else {
          deliver(chunk, start, end);
        }
        start = end + 1;
      }
      // Only now are all of the chunk's lines applied or counted, so only now does the offset move past it.
      tail.offset += bytesRead;
      bytes += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const result = { missing: false, reset, lines, bytes };
  if (skipped) Object.assign(result, { skipped, skippedBytes });
  if (failed) Object.assign(result, { failed, lastError });
  return result;
}

/**
 * Identity of a file's current contents: its device, inode, size, mtime and ctime. A file replaced by another of the same
 * size and mtime gets a new inode, and one rewritten in place a new ctime, so neither keeps the old stamp.
 */
export function fileStamp(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

/** Longest line taken for a skipped type: a longer line is taken as one that is not, without parsing it. */
const MAX_SKIPPED_LINE_BYTES = 64 * 1024;
const TIMESTAMP_KEY = '"timestamp":"';

const BLANK = Symbol('blank');

/** A log line's JSON object, BLANK for a line of only spaces, or null when the line is not a JSON object. */
function parseObject(line) {
  const text = line.toString('utf8');
  if (!text.trim()) return BLANK;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The time in a log line, by its last "timestamp" key, which follows the event's data; null when it has none. */
function lineTime(line) {
  const text = line.subarray(Math.max(0, line.length - 4096)).toString('utf8');
  const index = text.lastIndexOf(TIMESTAMP_KEY);
  if (index < 0) return null;
  const end = text.indexOf('"', index + TIMESTAMP_KEY.length);
  return end < 0 ? null : parseTime(text.slice(index + TIMESTAMP_KEY.length, end));
}

/**
 * When a session last did work, from the end of its log, reading backwards in chunks. Resolves { stamp, mtimeMs, at }, or
 * null when the log is missing; `stamp` is the fileStamp of the file that was read. `at` is the file's mtime, as before,
 * unless the log ends with lines whose top-level type is in `skipTypes` (app UI events, such as opening a canvas, that are
 * not work), in any key order; it is then the time of the last line before them, or null when every line is one of them.
 * A line that is not a JSON object, or is longer than any UI event, is work. An unfinished last line is work being
 * written, so `at` is the mtime. When more than maxBytes would have to be read, `at` is the mtime.
 */
export async function lastWorkTime(file, skipTypes, { chunkSize = 16 * 1024, maxBytes = 1024 * 1024 } = {}) {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    const mtimeMs = Math.round(info.mtimeMs);
    const size = info.size;
    const stamp = fileStamp(info);
    const result = at => ({ stamp, mtimeMs, at });
    if (!size) return result(null);
    // buffer holds the bytes [start, size); cursor is the end of the line to look at next, its newline excluded.
    let buffer = Buffer.alloc(0);
    let start = size;
    let cursor = size;
    const more = async () => {
      const length = Math.min(chunkSize, start);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start - length);
      start -= length;
      buffer = Buffer.concat([chunk.subarray(0, bytesRead), buffer]);
    };
    await more();
    if (buffer[buffer.length - 1] !== NEWLINE) return result(mtimeMs);
    cursor -= 1;
    for (;;) {
      const newline = cursor > start ? buffer.lastIndexOf(NEWLINE, cursor - start - 1) : -1;
      if (newline < 0 && start > 0) {
        if (cursor - start > MAX_SKIPPED_LINE_BYTES) return result(cursor === size - 1 ? mtimeMs : lineTime(buffer.subarray(0, cursor - start)) ?? mtimeMs);
        if (size - start >= maxBytes) return result(mtimeMs);
        await more();
        continue;
      }
      let line = buffer.subarray(newline + 1, cursor - start);
      if (line[line.length - 1] === CARRIAGE_RETURN) line = line.subarray(0, -1);
      const event = line.length <= MAX_SKIPPED_LINE_BYTES ? parseObject(line) : null;
      if (event !== BLANK && (!event || !skipTypes.has(event.type))) {
        return result(cursor === size - 1 ? mtimeMs : parseTime(event?.timestamp) ?? lineTime(line) ?? mtimeMs);
      }
      if (newline < 0) return result(null);
      cursor = start + newline;
    }
  } finally {
    await handle.close();
  }
}
