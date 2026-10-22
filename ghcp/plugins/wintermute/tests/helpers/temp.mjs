import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const created = [];
process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Create a temporary directory that is removed when the test process exits. */
export function tempDir(prefix = 'swarm-dashboard-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
