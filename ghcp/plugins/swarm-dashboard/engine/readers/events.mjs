import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { ownString } from '../text.mjs';

export function createTail(file) {
  return { file, offset: 0, ino: null, remainder: '', decoder: new StringDecoder('utf8') };
}

/**
 * Deliver complete lines appended since the last call, reading by byte offset in fixed-size chunks with async reads, so
 * memory stays bounded however large the log is and large logs do not block the event loop. A file that shrank or was
 * replaced restarts at byte 0 and reports reset.
 */
export async function readNewLines(tail, onLine, { chunkSize = 256 * 1024, onReset = null } = {}) {
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
    tail.remainder = '';
    tail.decoder = new StringDecoder('utf8');
    reset = true;
    if (onReset) onReset();
  }
  tail.ino = info.ino;
  if (info.size === tail.offset) return { missing: false, reset, lines: 0, bytes: 0 };
  let lines = 0;
  let bytes = 0;
  const handle = await open(tail.file, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(1, Math.min(chunkSize, info.size - tail.offset)));
    while (tail.offset < info.size) {
      const length = Math.min(buffer.length, info.size - tail.offset);
      const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
      if (bytesRead <= 0) break;
      tail.offset += bytesRead;
      bytes += bytesRead;
      const parts = (tail.remainder + tail.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      tail.remainder = ownString(parts.pop());
      for (const part of parts) {
        const line = part.endsWith('\r') ? part.slice(0, -1) : part;
        if (!line) continue;
        lines += 1;
        onLine(line);
      }
    }
  } finally {
    await handle.close();
  }
  return { missing: false, reset, lines, bytes };
}
