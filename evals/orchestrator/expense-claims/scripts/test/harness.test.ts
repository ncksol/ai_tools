import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { pickPort, portIsFree, startAppOnPort, type Api } from "../../acceptance/helpers.ts";
import { KIT_DIR } from "../lib/suite.ts";

// The helpers read this when they start the app.
process.env.EXPENSE_APP_DIR = join(KIT_DIR, "reference");

// A listener on 127.0.0.1 only, like another process's loopback server, answering every request with 415.
function foreign(): Promise<{ server: Server; port: number }> {
  return new Promise((done, fail) => {
    const server = createServer((_req, res) => {
      res.writeHead(415, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not the app under test" }));
    });
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      done({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

test("portIsFree is false for a port another process holds on 127.0.0.1", async () => {
  const { server, port } = await foreign();
  try {
    assert.equal(await portIsFree(port), false);
  } finally {
    await close(server);
  }
  assert.equal(await portIsFree(await pickPort()), true);
});

test("the harness reaches the app under test when 127.0.0.1:<port> belongs to another listener", { timeout: 30_000 }, async () => {
  const { server, port } = await foreign();
  let api: Api | undefined;
  try {
    api = await startAppOnPort(port);
    const res = await api.request("GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  } finally {
    await api?.stop();
    await close(server);
  }
});
