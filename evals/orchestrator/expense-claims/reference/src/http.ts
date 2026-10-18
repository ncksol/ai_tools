import type { IncomingMessage, ServerResponse } from "node:http";

export interface ErrorDetail {
  field: string;
  message: string;
}

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown[];

  constructor(status: number, code: string, message: string, details: unknown[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validationError(details: ErrorDetail[]): HttpError {
  return new HttpError(400, "VALIDATION_ERROR", "Some fields are invalid", details);
}

export function notFound(what: string): HttpError {
  return new HttpError(404, "NOT_FOUND", `${what} not found`);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_JSON", "The request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export function errorBody(err: HttpError): unknown {
  return { error: { code: err.code, message: err.message, details: err.details } };
}
