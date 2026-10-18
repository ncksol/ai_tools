import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
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

// Set to false once ::1 can't be bound at all, on a machine without IPv6 loopback.
let ipv6 = true;

function bind(port: number, host: string): Promise<Server | string> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? String(error)));
    server.listen(port, host, () => done(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}

// Binds 127.0.0.1 on `port` (0 for any), then ::1 on the same port, closes both and returns the port.
// Returns undefined when another listener holds the port on either address. A wildcard bind can't
// show this: on macOS it shares the port with another process's 127.0.0.1 listener.
async function claim(port: number): Promise<number | undefined> {
  const v4 = await bind(port, "127.0.0.1");
  if (v4 === "EADDRINUSE") return undefined;
  if (typeof v4 === "string") throw new Error(`Can't bind 127.0.0.1:${port}: ${v4}`);
  const address = v4.address();
  const claimed = typeof address === "object" && address ? address.port : 0;
  const v6 = await bind(claimed, "::1");
  await close(v4);
  if (typeof v6 !== "string") {
    await close(v6);
    return claimed;
  }
  if (v6 === "EADDRNOTAVAIL" || v6 === "EAFNOSUPPORT") {
    ipv6 = false;
    return claimed;
  }
  return undefined;
}

// True when no other listener holds `port` on 127.0.0.1 or ::1.
export async function portIsFree(port: number): Promise<boolean> {
  return (await claim(port)) !== undefined;
}

export async function pickPort(): Promise<number> {
  for (let pick = 1; pick <= 20; pick++) {
    const port = await claim(0);
    if (port !== undefined) return port;
  }
  throw new Error("Found no port free on both 127.0.0.1 and ::1 in 20 picks");
}

class PortInUse extends Error {}

const STARTUP_MS = 10_000;
const REQUEST_MS = 30_000;

// Starts `node src/server.ts` (what `npm start` runs) with PORT set, and waits for GET /health.
// Budgets: the app has 10 s from start to answer GET /health, and each later request has 30 s.
// The probed port can be taken before the app binds it, so EADDRINUSE gets a new port, up to 5 attempts.
export async function startApp(): Promise<Api> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startAppOnPort(await pickPort());
    } catch (error) {
      if (!(error instanceof PortInUse) || attempt === 5) throw error;
    }
  }
}

export async function startAppOnPort(port: number): Promise<Api> {
  // Both loopback addresses, so an app bound to either is reachable. Not localhost: it can resolve to
  // 127.0.0.1 and reach another process's listener there instead of the app's wildcard bind.
  const urls = (ipv6 ? ["127.0.0.1", "[::1]"] : ["127.0.0.1"]).map((host) => `http://${host}:${port}`);
  let url = urls[0];
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
    const deadline = Date.now() + STARTUP_MS;
    for (;;) {
      if (!running()) {
        // `exit` can come before the last stderr data; `close` comes after it.
        if (!spawnError) await Promise.race([closed, sleep(1000)]);
        const message = `The app exited (${spawnError ?? child.exitCode ?? child.signalCode}): ${stderr}`;
        throw stderr.includes("EADDRINUSE") ? new PortInUse(message) : new Error(message);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`The app did not answer GET /health within ${STARTUP_MS / 1000} s: ${stderr}`);
      const answers = await Promise.all(
        urls.map(async (base) => {
          try {
            const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(left) });
            await res.body?.cancel();
            return res.ok;
          } catch {
            return false; // not listening yet, or the probe timed out
          }
        }),
      );
      // Another process may hold the port and answer; only a still-running child counts as ready.
      // The first address that answers wins, so 127.0.0.1 when both do.
      const ready = answers.indexOf(true);
      if (ready !== -1 && running()) {
        url = urls[ready];
        break;
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
      const init: RequestInit = { method, signal: AbortSignal.timeout(REQUEST_MS) };
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

export const EXPENSE_FIELDS = ["id", "date", "merchant", "category", "amount", "currency", "description", "receipt"];

// The documented properties of `value` that it has. Responses may carry more; tests compare only these.
export function pick(value: any, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value !== null && typeof value === "object" && key in value).map((key) => [key, value[key]]));
}

// A server-returned id, encoded for use in a request path.
export const seg = (id: string): string => encodeURIComponent(id);

// An id that differs from every id the server returned, for a request that needs a missing one.
export function unknownId(...knownIds: string[]): string {
  let id = "nope";
  for (let i = 1; knownIds.includes(id); i++) id = `nope-${i}`;
  return id;
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
