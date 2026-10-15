import { open, stat } from 'node:fs/promises';
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
  const deliver = (chunk, start, end) => {
    let line = tail.pending.length ? Buffer.concat([...tail.pending, chunk.subarray(start, end)]) : chunk.subarray(start, end);
    freshPartial(tail);
    if (line.length && line[line.length - 1] === CARRIAGE_RETURN) line = line.subarray(0, -1);
    if (!line.length) return;
    lines += 1;
    onLine(line.toString('utf8'));
  };
  const handle = await open(tail.file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkSize, info.size - tail.offset)));
    while (tail.offset < info.size) {
      const length = Math.min(buffer.length, info.size - tail.offset);
      const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
      if (bytesRead <= 0) break;
      tail.offset += bytesRead;
      bytes += bytesRead;
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
          for (const part of tail.pending) tail.scanner.write(part, 0, part.length);
          tail.pending = [];
          tail.pendingBytes = 0;
        }
        if (tail.skipping) {
          tail.skipBytes += end - start;
          tail.scanner.write(chunk, start, end);
          if (newline !== -1) {
            skipped += 1;
            skippedBytes += tail.skipBytes + 1;
            const recovered = tail.scanner.finish();
            const lineBytes = tail.skipBytes + 1;
            freshPartial(tail);
            if (onOversized) onOversized(recovered, lineBytes);
          }
        } else if (newline === -1) {
          tail.pending.push(Buffer.from(chunk.subarray(start, end)));
          tail.pendingBytes += end - start;
        } else {
          deliver(chunk, start, end);
        }
        start = end + 1;
      }
    }
  } finally {
    await handle.close();
  }
  return skipped ? { missing: false, reset, lines, bytes, skipped, skippedBytes } : { missing: false, reset, lines, bytes };
}
