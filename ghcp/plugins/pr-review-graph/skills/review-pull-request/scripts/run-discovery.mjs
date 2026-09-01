#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDiscoveryPrompt,
  DiscoveryPromptCapacityError
} from './build-discovery-prompt.mjs';
import { extractAgentResponse } from './extract-agent-response.mjs';
import { isMain, parseFlags, readJson } from './lib.mjs';
import {
  ingestDiscoveryResponse,
  recordDiscoveryExecutionFailure,
  recordDiscoveryTransportFailure
} from './process-discovery.mjs';

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_PROMPT_CHARS = 120_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 5_000;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPluginDirectory = path.resolve(scriptDirectory, '../../..');

class DiscoveryExecutionTimeoutError extends Error {
  constructor(attemptTimeoutMs) {
    super(`Discovery agent exceeded the attempt timeout: ${attemptTimeoutMs}ms`);
    this.name = 'DiscoveryExecutionTimeoutError';
    this.attemptTimeoutMs = attemptTimeoutMs;
  }
}

export async function runDiscovery(packet, plan, options = {}) {
  const runDirectory = path.resolve(String(options.runDirectory ?? ''));
  if (!options.runDirectory) throw new Error('runDirectory is required');
  const maxConcurrency = positiveInteger(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    'maxConcurrency'
  );
  if (maxConcurrency > DEFAULT_MAX_CONCURRENCY) {
    throw new Error(`maxConcurrency cannot exceed ${DEFAULT_MAX_CONCURRENCY}`);
  }
  const maxPromptChars = positiveInteger(
    options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS,
    'maxPromptChars'
  );
  const attemptTimeoutMs = positiveInteger(
    options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
    'attemptTimeoutMs'
  );
  const executeAgent = options.executeAgent ?? executeCopilotAgent;
  const pluginDirectory = path.resolve(options.pluginDirectory ?? defaultPluginDirectory);
  const resultsDirectory = path.join(runDirectory, 'results');
  const diagnosticsDirectory = path.join(runDirectory, 'diagnostics');
  const stagingDirectory = path.join(runDirectory, 'staging');
  await Promise.all([
    mkdir(resultsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(diagnosticsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
  ]);

  const jobs = (plan.agents ?? []).flatMap(agentPlan =>
    (agentPlan.batches ?? []).map((_, index) => ({
      agent: agentPlan.name,
      batch: index + 1
    }))
  );
  const results = new Array(jobs.length);
  let nextJob = 0;

  async function worker() {
    while (nextJob < jobs.length) {
      const index = nextJob;
      nextJob += 1;
      results[index] = await runJob(jobs[index], {
        packet,
        plan,
        runDirectory,
        resultsDirectory,
        diagnosticsDirectory,
        stagingDirectory,
        maxPromptChars,
        attemptTimeoutMs,
        pluginDirectory,
        executeAgent
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, jobs.length) }, () => worker())
  );
  return results;
}

async function runJob(job, context) {
  let retry = null;
  for (const attempt of [1, 2]) {
    let prompt;
    try {
      prompt = buildDiscoveryPrompt(context.packet, context.plan, {
        ...job,
        maxPromptChars: context.maxPromptChars,
        retry
      });
    } catch (error) {
      if (!(error instanceof DiscoveryPromptCapacityError)) throw error;
      const result = await recordDiscoveryExecutionFailure(
        context.resultsDirectory,
        context.diagnosticsDirectory,
        { ...job, attempt },
        {
          kind: 'execution-capacity',
          promptChars: error.promptChars,
          maxPromptChars: error.maxPromptChars
        }
      );
      return jobSummary(result);
    }

    let execution;
    try {
      execution = await executeWithTimeout(
        context.executeAgent,
        prompt,
        {
          ...job,
          attempt,
          pluginDirectory: context.pluginDirectory,
          cwd: process.cwd()
        },
        context.attemptTimeoutMs
      );
    } catch (error) {
      const timedOut = error instanceof DiscoveryExecutionTimeoutError;
      const result = await recordDiscoveryExecutionFailure(
        context.resultsDirectory,
        context.diagnosticsDirectory,
        { ...job, attempt },
        {
          kind: timedOut ? 'execution-timeout' : 'execution-spawn',
          promptChars: prompt.length,
          maxPromptChars: context.maxPromptChars,
          ...(timedOut
            ? { attemptTimeoutMs: error.attemptTimeoutMs }
            : { stderr: error?.message })
        }
      );
      return jobSummary(result);
    }

    if (execution.exitCode !== 0) {
      const result = await recordDiscoveryExecutionFailure(
        context.resultsDirectory,
        context.diagnosticsDirectory,
        { ...job, attempt },
        {
          kind: 'execution-exit',
          promptChars: prompt.length,
          maxPromptChars: context.maxPromptChars,
          exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : 1,
          signal: execution.signal,
          stderr: execution.stderr
        }
      );
      return jobSummary(result);
    }

    const stem = `${job.agent}-batch-${String(job.batch).padStart(3, '0')}-attempt-${attempt}`;
    const eventsFile = path.join(context.stagingDirectory, `${stem}.events.jsonl`);
    const rawFile = path.join(context.stagingDirectory, `${stem}.response.json`);
    const statusFile = path.join(context.stagingDirectory, `${stem}.transport.json`);
    await writeFile(eventsFile, execution.stdout, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });

    const transport = await extractAgentResponse(eventsFile, rawFile, statusFile);
    let result;
    if (transport.status === 'complete') {
      result = await ingestDiscoveryResponse(
        rawFile,
        context.resultsDirectory,
        context.diagnosticsDirectory,
        { ...job, attempt }
      );
      await rm(statusFile, { force: true });
    } else {
      result = await recordDiscoveryTransportFailure(
        statusFile,
        context.resultsDirectory,
        context.diagnosticsDirectory,
        { ...job, attempt }
      );
    }

    if (result.status === 'complete' || attempt === 2) return jobSummary(result);
    retry = result.failure;
  }
  throw new Error('Unreachable discovery attempt state');
}

function jobSummary(result) {
  return {
    agent: result.agent,
    batch: result.batch,
    attempt: result.attempt,
    status: result.status,
    ...(result.failure ? { failure: result.failure } : {})
  };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

async function executeWithTimeout(executeAgent, prompt, context, attemptTimeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      executeAgent(prompt, { ...context, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DiscoveryExecutionTimeoutError(attemptTimeoutMs));
        }, attemptTimeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeCopilotAgent(prompt, context) {
  const args = [
    '--plugin-dir', context.pluginDirectory,
    '--agent', `pr-review-graph:${context.agent}`,
    '--output-format', 'json',
    '--stream', 'off',
    '--silent',
    '--no-auto-update',
    '-p', prompt
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('copilot', args, {
      cwd: context.cwd,
      env: { ...process.env, COPILOT_AUTO_UPDATE: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    let forceKillTimer;
    const cleanup = () => {
      context.signal.removeEventListener('abort', abort);
      clearTimeout(forceKillTimer);
    };
    const abort = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, TERMINATION_GRACE_MS);
      forceKillTimer.unref?.();
    };
    context.signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => {
      cleanup();
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [packetFile, planFile, runDirectory] = flags._;
  if (!packetFile || !planFile || !runDirectory) {
    throw new Error(
      'Usage: run-discovery.mjs PACKET_JSON PLAN_JSON RUN_DIR [--max-concurrency N] [--max-prompt-chars N] [--attempt-timeout-ms N] [--plugin-dir DIR]'
    );
  }
  const results = await runDiscovery(
    await readJson(path.resolve(packetFile)),
    await readJson(path.resolve(planFile)),
    {
      runDirectory,
      maxConcurrency: flags['max-concurrency'],
      maxPromptChars: flags['max-prompt-chars'],
      attemptTimeoutMs: flags['attempt-timeout-ms'],
      pluginDirectory: flags['plugin-dir']
    }
  );
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some(result => result.status !== 'complete')) process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
