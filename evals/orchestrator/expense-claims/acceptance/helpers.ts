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

class PortInUse extends Error {}

// Starts `node src/server.ts` (what `npm start` runs) with PORT set, and waits for GET /health.
// The probed port can be taken before the app binds it, so EADDRINUSE gets a new port, up to 5 attempts.
export async function startApp(): Promise<Api> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch(await freePort());
    } catch (error) {
      if (!(error instanceof PortInUse) || attempt === 5) throw error;
    }
  }
}

async function launch(port: number): Promise<Api> {
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["src/server.ts"], {
    cwd: appDir(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  child.once("error", (error) => (spawnError = error));
  const exited = new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => done());
  });
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  const running = () => child.exitCode === null && child.signalCode === null && !spawnError;
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (!running()) {
        // `exit` can come before the last stderr data; `close` comes after it.
        if (!spawnError) await Promise.race([closed, sleep(1000)]);
        const message = `The app exited (${spawnError ?? child.exitCode ?? child.signalCode}): ${stderr}`;
        throw stderr.includes("EADDRINUSE") ? new PortInUse(message) : new Error(message);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`The app did not answer GET /health within 10 s: ${stderr}`);
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(Math.min(1000, left)) });
        await res.body?.cancel();
        if (res.ok) break;
      } catch {
        // not listening yet, or the probe timed out
      }
      await sleep(50);
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    url,
    async request(method, path, body, contentType) {
      // The signal also bounds reading the body.
      const init: RequestInit = { method, signal: AbortSignal.timeout(10_000) };
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
      if (!running()) return;
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      let cap: NodeJS.Timeout | undefined;
      await Promise.race([exited, new Promise((done) => (cap = setTimeout(done, 3000)))]);
      clearTimeout(force);
      clearTimeout(cap);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
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
