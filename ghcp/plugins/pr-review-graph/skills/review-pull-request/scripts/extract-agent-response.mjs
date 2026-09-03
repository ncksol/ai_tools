#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMain } from './lib.mjs';

export const TRANSPORT_FAILURE_KINDS = Object.freeze([
  'transport-invalid-jsonl',
  'transport-invalid-event',
  'transport-missing-result',
  'transport-multiple-results',
  'transport-unsuccessful-result',
  'transport-missing-payload',
  'transport-multiple-payloads',
  'transport-non-terminal-payload'
]);

async function writePrivate(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600
  });
}

async function writeStatus(file, status) {
  await writePrivate(file, `${JSON.stringify(status, null, 2)}\n`);
}

function invalid(kind, details = {}) {
  return {
    schemaVersion: '1.0',
    status: 'invalid',
    failure: { kind, ...details }
  };
}

function recoverRedactionCorruptedUserMessage(line) {
  const prefix = '{"type":"user.message","data":{"content":"';
  const transformedPrefix = ',"transformedContent":"';
  const metadataPrefix = ',"messageId":';
  const corruptedSignature = 'Authorization: ******"';
  if (!line.startsWith(prefix)) return null;
  const metadataIndex = line.lastIndexOf(metadataPrefix);
  const transformedIndex = line.lastIndexOf(transformedPrefix, metadataIndex);
  if (transformedIndex < prefix.length || metadataIndex < transformedIndex) return null;
  const content = line.slice(prefix.length, transformedIndex);
  const transformedContent = line.slice(transformedIndex + transformedPrefix.length, metadataIndex);
  if (
    !content.endsWith('"')
    || !transformedContent.endsWith('"')
    || !content.includes(corruptedSignature)
    || !transformedContent.includes(corruptedSignature)
  ) {
    return null;
  }

  const repairedLine = line.replaceAll(corruptedSignature, 'Authorization: ******\\"');
  let event;
  try {
    event = JSON.parse(repairedLine);
  } catch {
    return null;
  }
  if (JSON.stringify(event) !== repairedLine) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const dataKeys = [
    'content',
    'delivery',
    'interactionId',
    'messageId',
    'parentAgentTaskId',
    'supportedNativeDocumentMimeTypes',
    'transformedContent',
    'turnId'
  ];
  const eventKeys = ['data', 'id', 'parentId', 'timestamp', 'type'];
  if (
    event?.type !== 'user.message'
    || Object.keys(event).sort().join(',') !== eventKeys.join(',')
    || Object.keys(event.data ?? {}).sort().join(',') !== dataKeys.join(',')
    || typeof event.data.content !== 'string'
    || typeof event.data.transformedContent !== 'string'
    || !uuid.test(event.data.messageId)
    || !Array.isArray(event.data.supportedNativeDocumentMimeTypes)
    || event.data.supportedNativeDocumentMimeTypes.some(type => typeof type !== 'string')
    || event.data.delivery !== 'idle'
    || !uuid.test(event.data.interactionId)
    || !/^\d+$/.test(event.data.turnId)
    || !uuid.test(event.data.parentAgentTaskId)
    || !uuid.test(event.id)
    || !timestamp.test(event.timestamp)
    || !uuid.test(event.parentId)
  ) {
    return null;
  }
  return {
    ...event,
    data: {
      content: '',
      messageId: event.data.messageId,
      supportedNativeDocumentMimeTypes: event.data.supportedNativeDocumentMimeTypes,
      delivery: event.data.delivery,
      interactionId: event.data.interactionId,
      turnId: event.data.turnId,
      parentAgentTaskId: event.data.parentAgentTaskId
    }
  };
}

function parseEvents(text) {
  const events = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (line.length === 0) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Copilot's stdout redactor can remove JSON escaping inside the echoed
      // prompt. Recover only its metadata envelope; prompt text is not trusted
      // or used to select the terminal assistant payload.
      event = recoverRedactionCorruptedUserMessage(line);
      if (!event) {
        return { status: invalid('transport-invalid-jsonl', { line: index + 1 }) };
      }
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      return { status: invalid('transport-invalid-event', { eventIndex: events.length }) };
    }
    events.push(event);
  }
  return { events };
}

function safeEventDetails(event, eventIndex) {
  const details = { eventIndex };
  if ([
    'assistant.turn_start',
    'assistant.message',
    'assistant.turn_end',
    'result'
  ].includes(event?.type)) {
    details.eventType = event.type;
  }
  return details;
}

function analyzeEvents(events) {
  for (const [eventIndex, event] of events.entries()) {
    if (event.type === 'result') {
      if (!Number.isInteger(event.exitCode)) {
        return { status: invalid('transport-invalid-event', safeEventDetails(event, eventIndex)) };
      }
      continue;
    }
    if (event.type === 'assistant.turn_start' || event.type === 'assistant.turn_end') {
      if (typeof event.data?.turnId !== 'string' || !event.data.turnId) {
        return { status: invalid('transport-invalid-event', safeEventDetails(event, eventIndex)) };
      }
      continue;
    }
    if (event.type === 'assistant.message') {
      if (
        typeof event.data?.turnId !== 'string'
        || !event.data.turnId
        || typeof event.data.content !== 'string'
        || !Array.isArray(event.data.toolRequests)
        || (event.data.content && event.data.toolRequests.length > 0)
      ) {
        return { status: invalid('transport-invalid-event', safeEventDetails(event, eventIndex)) };
      }
    }
  }

  const results = events
    .map((event, eventIndex) => ({ event, eventIndex }))
    .filter(item => item.event.type === 'result');
  if (results.length === 0) return { status: invalid('transport-missing-result') };
  if (results.length > 1) {
    return { status: invalid('transport-multiple-results', { count: results.length }) };
  }
  const [{ event: result, eventIndex: resultIndex }] = results;
  if (result.exitCode !== 0) return { status: invalid('transport-unsuccessful-result') };
  if (resultIndex !== events.length - 1) {
    return {
      status: invalid('transport-invalid-event', safeEventDetails(events[resultIndex + 1], resultIndex + 1))
    };
  }

  const messages = events
    .map((event, eventIndex) => ({ event, eventIndex }))
    .filter(item => item.event.type === 'assistant.message');
  const payloads = messages.filter(item => item.event.data.content.length > 0);
  if (payloads.length === 0) return { status: invalid('transport-missing-payload') };
  if (payloads.length > 1) {
    return { status: invalid('transport-multiple-payloads', { count: payloads.length }) };
  }

  const [payload] = payloads;
  const turnId = payload.event.data.turnId;
  const starts = events
    .map((event, eventIndex) => ({ event, eventIndex }))
    .filter(item => item.event.type === 'assistant.turn_start');
  const ends = events
    .map((event, eventIndex) => ({ event, eventIndex }))
    .filter(item => item.event.type === 'assistant.turn_end');
  const matchingStarts = starts.filter(item => item.event.data.turnId === turnId);
  const matchingEnds = ends.filter(item => item.event.data.turnId === turnId);
  if (
    matchingStarts.length !== 1
    || matchingEnds.length !== 1
    || matchingStarts[0].eventIndex >= payload.eventIndex
    || matchingEnds[0].eventIndex <= payload.eventIndex
    || matchingEnds[0].eventIndex >= resultIndex
    || starts.at(-1)?.event.data.turnId !== turnId
    || ends.at(-1)?.event.data.turnId !== turnId
    || messages.some(item => item.eventIndex > matchingEnds[0].eventIndex)
  ) {
    return {
      status: invalid('transport-non-terminal-payload', { eventIndex: payload.eventIndex })
    };
  }

  const turnCounts = new Map();
  for (const item of [...starts, ...ends]) {
    const current = turnCounts.get(item.event.data.turnId) ?? { starts: 0, ends: 0 };
    if (item.event.type === 'assistant.turn_start') current.starts += 1;
    else current.ends += 1;
    turnCounts.set(item.event.data.turnId, current);
  }
  if ([...turnCounts.values()].some(count => count.starts !== 1 || count.ends !== 1)) {
    return { status: invalid('transport-invalid-event') };
  }
  for (const message of messages) {
    const start = starts.find(item => item.event.data.turnId === message.event.data.turnId);
    const end = ends.find(item => item.event.data.turnId === message.event.data.turnId);
    if (!start || !end || start.eventIndex >= message.eventIndex || end.eventIndex <= message.eventIndex) {
      return {
        status: invalid('transport-non-terminal-payload', { eventIndex: message.eventIndex })
      };
    }
  }

  return {
    status: { schemaVersion: '1.0', status: 'complete' },
    content: payload.event.data.content
  };
}

export async function extractAgentResponse(eventsFile, responseFile, statusFile) {
  let wroteResponse = false;
  try {
    const parsed = parseEvents(await readFile(eventsFile, 'utf8'));
    const outcome = parsed.status ? parsed : analyzeEvents(parsed.events);
    if (outcome.status.status === 'complete') {
      await writePrivate(responseFile, outcome.content);
      wroteResponse = true;
    }
    try {
      await writeStatus(statusFile, outcome.status);
    } catch (error) {
      if (wroteResponse) await rm(responseFile, { force: true });
      throw error;
    }
    return outcome.status;
  } finally {
    await rm(eventsFile, { force: true });
  }
}

async function main() {
  const [eventsFile, responseFile, statusFile] = process.argv.slice(2);
  if (!eventsFile || !responseFile || !statusFile) {
    throw new Error(
      'Usage: extract-agent-response.mjs EVENTS_JSONL RAW_RESPONSE_FILE TRANSPORT_STATUS_JSON'
    );
  }
  const status = await extractAgentResponse(
    path.resolve(eventsFile),
    path.resolve(responseFile),
    path.resolve(statusFile)
  );
  if (status.status !== 'complete') process.exitCode = 1;
}

if (isMain(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
