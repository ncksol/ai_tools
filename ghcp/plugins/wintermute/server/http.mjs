import { createServer } from 'node:http';
import { assetsFingerprint, loadAssets, withFingerprint } from './assets.mjs';
import { createHub } from './hub.mjs';
import { createPoolCheck } from './pool-check.mjs';

export const APP_ID = 'swarm-dashboard';
// No frame-ancestors or X-Frame-Options: the app's canvas panel embeds this page, and a wrong value would break the canvas. The page only reads (GET and HEAD), so there is nothing to clickjack.
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const TEXT = 'text/plain; charset=utf-8';
/** Pages with their own address, and the asset each one serves. */
const PAGES = new Map([['/', '/index.html'], ['/cockpit', '/ui/cockpit.html']]);

/** A browser request that another website started: Sec-Fetch-Site says so, or it carries a foreign Origin. */
function fromOtherSite(req, origins) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = req.headers.origin;
  return origin !== undefined && !origins.includes(origin);
}

/**
 * The dashboard's HTTP server: the page, its assets, a JSON API and the live event stream. Loopback only, GET and HEAD
 * only, and only for requests addressed to its own host and port; the API and event stream also refuse requests that
 * another website starts. Writes nothing to stdout or disk.
 *
 * While it listens, it checks that file system calls in its process still finish (see pool-check.mjs). When they stop,
 * no refresh can finish again, so it calls onBroken and closes its listener and pages, which lets another process serve
 * the port. poolCheck: false turns the check off; an object sets its probe, intervalMs and timeoutMs.
 */
export function createDashboardServer({ createEngine, host = '127.0.0.1', port = 0, version = '0.0.0', uiFingerprint = null, now = Date.now, log = () => {}, hub: hubOptions = {}, onIdle = () => {}, onBroken = () => {}, poolCheck = {}, demo = null }) {
  const assets = loadAssets();
  // The page carries the fingerprint of the files it came with; hello sends the current one, so an open page can tell it is out of date.
  const fingerprint = uiFingerprint ?? assetsFingerprint(assets);
  for (const name of ['/index.html', '/ui/cockpit.html']) {
    const shell = assets.get(name);
    assets.set(name, { ...shell, body: Buffer.from(withFingerprint(shell.body.toString('utf8'), fingerprint)) });
  }
  let pool = null;
  const hub = createHub({ createEngine, now, log, onIdle, poolPassedSince: time => !pool || pool.passedSince(time), ...hubOptions, ui: fingerprint, version });
  const startedAt = now();
  let boundPort = null;

  const reply = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...headers });
    res.end(body);
  };
  const json = (res, value) => reply(res, 200, 'application/json; charset=utf-8', JSON.stringify(value), { 'Cache-Control': 'no-store' });

  async function route(req, res) {
    for (const [name, value] of Object.entries(SECURITY)) res.setHeader(name, value);
    if (req.headers.host !== `127.0.0.1:${boundPort}` && req.headers.host !== `localhost:${boundPort}`) return reply(res, 403, TEXT, 'Forbidden');
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, TEXT, 'Method not allowed', { Allow: 'GET, HEAD' });
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const path = url.pathname;
    // The data and live-update endpoints answer only the dashboard's own pages and local tools: a request that another
    // website starts in the browser could otherwise start an engine. Tools such as curl send neither header.
    if (path.startsWith('/api/') && fromOtherSite(req, [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`])) return reply(res, 403, TEXT, 'Forbidden');
    const param = name => url.searchParams.get(name) || null;
    if (path === '/api/health') {
      const { lastRefreshAt, refreshStartedAt, progressAt, restarts } = hub.status();
      return json(res, { app: APP_ID, version, pid: process.pid, startedAt, demo, pool: pool?.state() ?? null, lastRefreshAt, refreshStartedAt, progressAt, restarts });
    }
    if (path === '/api/events') {
      // A HEAD request gets the headers only; it opens no live connection and creates no engine.
      if (req.method === 'HEAD') return reply(res, 200, 'text/event-stream; charset=utf-8', '', { 'Cache-Control': 'no-store' });
      return hub.add(req, res, { swarm: param('swarm'), session: param('session') });
    }
    if (path === '/api/swarms') return json(res, await hub.withEngine(engine => engine.listSwarms()));
    if (path === '/api/snapshot') return json(res, { serverNow: now(), snapshot: await hub.withEngine(engine => engine.getSnapshot(param('swarm') ?? undefined)) });
    if (path === '/api/history') return json(res, await hub.withEngine(engine => engine.listHistory()));
    if (path.startsWith('/api/runs/')) {
      let id;
      try {
        id = decodeURIComponent(path.slice('/api/runs/'.length));
      } catch {
        return reply(res, 400, TEXT, 'Bad run id');
      }
      const summary = await hub.withEngine(engine => engine.getRunSummary(id));
      return summary ? json(res, summary) : reply(res, 404, TEXT, 'Not found');
    }
    const asset = assets.get(PAGES.get(path) ?? path);
    if (asset) return reply(res, 200, asset.type, asset.body, { 'Cache-Control': 'no-store' });
    return reply(res, 404, TEXT, 'Not found');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      log({ level: 'warn', source: 'server', message: error.message });
      // A retriable error (see the hub's withEngine) means the read was cut short, not that it went wrong.
      if (!res.headersSent && error.retriable) reply(res, 503, TEXT, 'Try again', { 'Retry-After': '1', 'Cache-Control': 'no-store' });
      else if (!res.headersSent) reply(res, 500, TEXT, 'Internal error');
      else res.end();
    });
  });
  // Tracked so close() can end every connection, including requests still waiting on the engine, on any Node version
  // (closeAllConnections() is missing before 18.2).
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function close() {
    pool?.stop();
    hub.close();
    const closed = new Promise(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
    boundPort = null;
  }

  function broken() {
    log({ level: 'error', source: 'server', message: 'File system calls in this process have stopped finishing, so the dashboard can no longer refresh; closing the dashboard server so another process can serve it.' });
    try {
      onBroken();
    } catch (error) {
      log({ level: 'warn', source: 'server', message: error.message });
    }
    close().catch(error => log({ level: 'warn', source: 'server', message: error.message }));
  }

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        const fail = error => {
          server.off('listening', ok);
          reject(error);
        };
        const ok = () => {
          server.off('error', fail);
          resolve();
        };
        server.once('error', fail);
        server.once('listening', ok);
        server.listen(port, host);
      });
      boundPort = server.address().port;
      if (poolCheck && !pool) {
        pool = createPoolCheck({ ...poolCheck, onBroken: broken });
        pool.start();
      }
      return `http://127.0.0.1:${boundPort}/`;
    },
    get url() {
      return boundPort === null ? null : `http://127.0.0.1:${boundPort}/`;
    },
    get port() {
      return boundPort;
    },
    clientCount: () => hub.clientCount(),
    queuedBytes: () => hub.queuedBytes(),
    close,
  };
}
