import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";

export interface TestResponse {
  status: number;
  body: any;
  headers: Headers;
}

export interface TestApp {
  url: string;
  request(method: string, path: string, body?: unknown): Promise<TestResponse>;
  close(): Promise<void>;
}

// Starts the app on a random port. A string body is sent as is; any other body is sent as JSON.
export async function startTestApp(): Promise<TestApp> {
  const server = createApp();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    async request(method, path, body) {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      const res = await fetch(url + path, init);
      const text = await res.text();
      return { status: res.status, body: text === "" ? undefined : JSON.parse(text), headers: res.headers };
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
