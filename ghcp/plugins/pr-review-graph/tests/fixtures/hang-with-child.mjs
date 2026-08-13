#!/usr/bin/env node
// Test fixture only: spawns a grandchild process to build a 2-level tree, writes both
// PIDs to the file named in argv[2], ignores SIGTERM, and sleeps far longer than any
// test deadline. Used to prove run-with-deadline kills the whole tree, not just the
// process it directly spawned.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
if (!pidFile) {
  console.error('Usage: hang-with-child.mjs <pid-file>');
  process.exit(2);
}

process.on('SIGTERM', () => {
  // Deliberately ignored so the test can prove SIGKILL escalation works too.
});

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore'
});

writeFileSync(pidFile, JSON.stringify({ parent: process.pid, child: child.pid }));

setInterval(() => {}, 1000);
