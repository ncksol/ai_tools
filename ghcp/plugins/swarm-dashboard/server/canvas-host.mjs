import { createDashboardServer } from './http.mjs';
import { listenShared, probePort } from './shared.mjs';

export const CANVAS_TITLE = 'Swarm dashboard';

/** The page address for one canvas: the swarm named in its input, else the swarm of the session it opened in. */
export function pageUrl(port, { sessionId, input } = {}) {
  const query = new URLSearchParams({ host: 'canvas' });
  const swarm = input && typeof input === 'object' && typeof input.swarm === 'string' ? input.swarm.trim() : '';
  if (swarm) query.set('swarm', swarm);
  else if (sessionId) query.set('session', sessionId);
  return `http://127.0.0.1:${port}/?${query}`;
}

/**
 * The canvas side of the shared dashboard server. Each Copilot session with the plugin enabled runs one extension
 * process, and each process keeps one canvas host. The first canvas opened on the machine binds the fixed port in its
 * own process; later canvases reuse that server once it identifies itself, and while they are open they watch it and
 * take the port over if its host goes away. A hosting process stops serving once it has no open canvas and no page is
 * connected. Nothing starts before the first open(). Never writes to stdout.
 */
export function createCanvasHost({
  port,
  version,
  createEngine,
  log = () => {},
  makeServer = ({ onIdle }) => createDashboardServer({ createEngine, port, version, log, onIdle }),
  probe = probePort,
  watchdogMs = 2000,
  jitterMs = 1000,
  graceMs = 300000,
  random = Math.random,
}) {
  const instances = new Set();
  let server = null;
  let starting = null;
  let watchdog = null;
  let graceTimer = null;
  let lastSeen = null;
  let disposed = false;
  const report = (level, message) => log({ level, source: 'canvas', message });

  function ensureServer() {
    if (server) return Promise.resolve();
    if (!starting) {
      starting = (async () => {
        const result = await listenShared({ port, makeServer: () => makeServer({ onIdle: () => { release().catch(error => report('warn', error.message)); } }), probe });
        if (result.status === 'started') {
          server = result.server;
          report('info', `serving the dashboard at http://127.0.0.1:${port}/`);
        } else if (result.status === 'running') {
          if (result.health.version !== version) report('warn', `version ${result.health.version} of the dashboard serves port ${port}, not ${version}; restart the app or reload extensions everywhere to update it`);
        } else {
          const error = new Error(`Port ${port} ${result.status === 'taken' ? 'is used by another program' : 'is in use and not answering'}. Stop that program, or set SWARM_DASHBOARD_PORT to a free port for the Copilot app and restart it.`);
          error.code = 'port_in_use';
          throw error;
        }
      })().finally(() => { starting = null; });
    }
    return starting;
  }

  /** Close the server this process hosts once no canvas here and no page anywhere uses it. */
  async function release() {
    if (!server || instances.size || server.clientCount()) return;
    const current = server;
    server = null;
    clearTimeout(graceTimer);
    graceTimer = null;
    await current.close();
    report('info', 'stopped serving the dashboard: no canvas or page uses it');
  }

  function scheduleRelease() {
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      graceTimer = null;
      release().catch(error => report('warn', error.message));
    }, graceMs);
    graceTimer.unref?.();
  }

  /** While a canvas is open here and another process hosts the server, check on it and take the port if it is free. */
  function watch() {
    if (watchdog || disposed || !instances.size) return;
    const handle = setTimeout(async () => {
      try {
        if (!server && !starting) {
          const found = await probe(port, { timeoutMs: 1500 });
          if (found.state === 'other' && lastSeen !== 'other') report('warn', `port ${port} is now used by another program; open canvases cannot reach the dashboard`);
          lastSeen = found.state;
          if (found.state === 'free' && instances.size && !disposed) await ensureServer();
        }
      } catch (error) {
        report('warn', error.message);
      } finally {
        if (watchdog === handle) {
          watchdog = null;
          watch();
        }
      }
    }, watchdogMs + random() * jitterMs);
    handle.unref?.();
    watchdog = handle;
  }

  function stopWatching() {
    clearTimeout(watchdog);
    watchdog = null;
  }

  return {
    async open(ctx = {}) {
      if (disposed) throw Object.assign(new Error('The swarm dashboard extension is shutting down.'), { code: 'unavailable' });
      await ensureServer();
      instances.add(ctx.instanceId ?? '');
      clearTimeout(graceTimer);
      graceTimer = null;
      watch();
      return { url: pageUrl(port, ctx), title: CANVAS_TITLE };
    },
    onClose(ctx = {}) {
      instances.delete(ctx.instanceId ?? '');
      if (instances.size) return;
      stopWatching();
      if (server) scheduleRelease();
    },
    async dispose() {
      disposed = true;
      instances.clear();
      stopWatching();
      clearTimeout(graceTimer);
      graceTimer = null;
      await starting?.catch(() => {});
      const current = server;
      server = null;
      await current?.close();
    },
    hosting: () => server !== null,
    instanceCount: () => instances.size,
  };
}
