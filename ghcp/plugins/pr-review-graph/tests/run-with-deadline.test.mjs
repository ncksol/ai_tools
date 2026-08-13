import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runWithDeadline, TIMEOUT_EXIT_CODE } from '../skills/review-pull-request/scripts/run-with-deadline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests/fixtures/hang-with-child.mjs');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a fast command resolves before the deadline with its own exit code', async () => {
  const result = await runWithDeadline({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    deadlineMs: 5000,
    stdio: 'ignore'
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
});

test('a non-zero exit code passes through unchanged, not conflated with a timeout', async () => {
  const result = await runWithDeadline({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    deadlineMs: 5000,
    stdio: 'ignore'
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 3);
});

test('a hanging command times out and its entire process tree is terminated', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prg-deadline-'));
  const pidFile = path.join(dir, 'pids.json');
  try {
    const result = await runWithDeadline({
      command: process.execPath,
      args: [fixture, pidFile],
      deadlineMs: 200,
      graceMs: 300,
      stdio: 'ignore'
    });
    assert.equal(result.timedOut, true);

    const { parent, child } = JSON.parse(await readFile(pidFile, 'utf8'));
    // Give the OS a beat to reap both processes after SIGKILL.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(alive(parent), false, 'the directly-spawned process must not survive');
    assert.equal(alive(child), false, 'the grandchild process must not survive — proves tree cleanup, not just top-level kill');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI entry point exits 124 on timeout so callers can branch on it deterministically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prg-deadline-cli-'));
  const pidFile = path.join(dir, 'pids.json');
  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'skills/review-pull-request/scripts/run-with-deadline.mjs'),
      '--deadline-ms', '200',
      '--grace-ms', '300',
      '--',
      process.execPath, fixture, pidFile
    ], { encoding: 'utf8' });

    assert.equal(result.status, TIMEOUT_EXIT_CODE);
    assert.match(result.stderr, /deadline of 200ms exceeded/);
    const { parent, child } = JSON.parse(await readFile(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(alive(parent), false);
    assert.equal(alive(child), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the CLI entry point forwards a fast command exit code unchanged', () => {
  const result = spawnSync(process.execPath, [
    path.join(root, 'skills/review-pull-request/scripts/run-with-deadline.mjs'),
    '--deadline-ms', '5000',
    '--',
    process.execPath, '-e', 'process.exit(7)'
  ], { encoding: 'utf8' });

  assert.equal(result.status, 7);
});

test('the CLI entry point requires --deadline-ms and a -- separated command', () => {
  const missingSeparator = spawnSync(process.execPath, [
    path.join(root, 'skills/review-pull-request/scripts/run-with-deadline.mjs'),
    '--deadline-ms', '5000'
  ], { encoding: 'utf8' });
  assert.equal(missingSeparator.status, 2);

  const missingDeadline = spawnSync(process.execPath, [
    path.join(root, 'skills/review-pull-request/scripts/run-with-deadline.mjs'),
    '--',
    process.execPath, '-e', 'process.exit(0)'
  ], { encoding: 'utf8' });
  assert.equal(missingDeadline.status, 2);
});
