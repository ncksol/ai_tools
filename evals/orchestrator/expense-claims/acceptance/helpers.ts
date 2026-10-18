import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach } from "node:test";

export interface Res {
  status: number;
  body: any;
  contentType: string | null;
}

export interface Api {
  url: string;
  request(method: string, path: string, body?: unknown, contentType?: string): Promise<Res>;
  stop(): Promise<void>;
}

function appDir(): string {
  const dir = process.env.EXPENSE_APP_DIR;
  if (!dir) throw new Error("Set EXPENSE_APP_DIR to the directory of the app under test");
  return resolve(dir);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

// Starts `node src/server.ts` (what `npm start` runs) with PORT set, and waits for GET /health.
export async function startApp(): Promise<Api> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["src/server.ts"], {
    cwd: appDir(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The app exited with code ${child.exitCode}: ${stderr}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`The app did not answer GET /health within 10 s: ${stderr}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  return {
    url,
    async request(method, path, body, contentType) {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers = { "content-type": contentType ?? "application/json" };
      }
      const res = await fetch(url + path, init);
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { status: res.status, body: parsed, contentType: res.headers.get("content-type") };
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}

// Registers beforeEach/afterEach hooks for the calling file and returns a getter for the current app.
export function useApp(): () => Api {
  let api: Api | undefined;
  beforeEach(async () => {
    api = await startApp();
  });
  afterEach(async () => {
    await api?.stop();
    api = undefined;
  });
  return () => {
    if (!api) throw new Error("No app running");
    return api;
  };
}

export const base = { date: "2026-03-04", merchant: "Cafe Rio", category: "meals", amount: 1000, currency: "GBP" };

// Creates an expense through the v1 API and returns it.
export async function createExpense(api: Api, fields: Record<string, unknown> = {}): Promise<any> {
  const res = await api.request("POST", "/expenses", { ...base, ...fields });
  assert.equal(res.status, 201, `POST /expenses failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export function assertError(res: Res, status: number, code: string): void {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body?.error?.code, code, JSON.stringify(res.body));
  assert.equal(typeof res.body.error.message, "string");
  assert.ok(Array.isArray(res.body.error.details));
}

export function detailFields(res: Res): string[] {
  return res.body.error.details.map((detail: { field: string }) => detail.field).sort();
}
