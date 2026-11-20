import { createDashboardServer } from './http.mjs';
import { listenShared, probePort, quietSince } from './shared.mjs';

export const CANVAS_TITLE = 'Wintermute';

/** The page address for one canvas: the swarm named in its input, else the swarm of the session it opened in. */
export function pageUrl(port, { sessionId, input, version } = {}) {
  const query = new URLSearchParams({ host: 'canvas' });
  const swarm = input && typeof input === 'object' && typeof input.swarm === 'string' ? input.swarm.trim() : '';
  if (swarm) query.set('swarm', swarm);
  else if (sessionId) query.set('session', sessionId);
  const plugin = typeof version === 'string' ? version.trim() : '';
  if (plugin) query.set('plugin', plugin);
  return `http://127.0.0.1:${port}/?${query}`;
}

/**
 * The canvas side of the shared dashboard server. Each Copilot session with the plugin enabled runs one extension
 * process, and each process keeps one canvas host. The first canvas opened on the machine binds the fixed port in its
 * own process; later canvases reuse that server once it identifies itself, and while they are open they watch it and
 * take the port over if its host goes away. A hosting process stops serving once it has no open canvas and no page is
 * connected. Nothing starts before the first open(). Never writes to stdout.
 *
 * A process whose file system calls stop finishing can never refresh again. Its server then closes itself (see
 * createDashboardServer), and the process stops watching and never binds the port again, so a canvas in another
 * process takes over. The Copilot runtime does not restart an extension process that exits, so a broken process stays
 * up: its open() returns the address while another process serves it, and otherwise fails with code
 * 'reload_extensions'.
 */
export function createCanvasHost({
  port,
  version,
  createEngine,
  log = () => {},
  makeServer = ({ onIdle, onBroken }) => createDashboardServer({ createEngine, port, version, log, onIdle, onBroken }),
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
  let broken = false;
  const report = (level, message) => log({ level, source: 'canvas', message });
  const unavailable = () => Object.assign(new Error('The swarm dashboard extension is shutting down.'), { code: 'unavailable' });

  /** Use the dashboard another process serves, unless it shows sample data. */
  function reuse(health) {
    if (health.demo) {
      const error = new Error(`Port ${port} serves the dashboard with sample data, started from the command line. Stop it with Ctrl+C in its terminal so the canvas can show your data.`);
      error.code = 'port_in_use';
      throw error;
    }
    if (health.version !== version) report('warn', `version ${health.version} of the dashboard serves port ${port}, not ${version}; restart the app or reload extensions everywhere to update it`);
  }

  /** The server this process hosted has closed itself: its file system calls stopped finishing. */
  function markBroken() {
    broken = true;
    server = null;
    clearTimeout(graceTimer);
    graceTimer = null;
    stopWatching();
    report('error', `file system calls in this extension process stopped finishing, so it stopped serving the dashboard on port ${port} and will not serve it again; a canvas in another session takes over, or reload extensions`);
  }

  function ensureServer() {
    if (server) return Promise.resolve();
    if (!starting) {
      starting = (async () => {
        const result = await listenShared({
          port,
          makeServer: () => makeServer({ onIdle: () => { release().catch(error => report('warn', error.message)); }, onBroken: markBroken }),
          probe,
        });
        if (result.status === 'started') {
          if (broken) return;
          server = result.server;
          report('info', `serving the dashboard at http://127.0.0.1:${port}/`);
        } else if (result.status === 'running') {
          reuse(result.health);
        } else if (result.status === 'unresponsive' && result.health) {
          // The dashboard there closes or recovers by itself; while canvases are open here, watch() takes the port once it is free.
          report('warn', result.reason === 'broken'
            ? `the dashboard serving port ${port} has stopped working; this canvas takes the port over once it closes`
            : `the dashboard serving port ${port} has made no progress on a refresh for over ${Math.round((Date.now() - quietSince(result.health)) / 1000)} s; this canvas takes the port over if it closes`);
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
    if (watchdog || disposed || broken || !instances.size) return;
    const handle = setTimeout(async () => {
      try {
        if (!server && !starting && !broken) {
          const found = await probe(port, { timeoutMs: 1500 });
          if (found.state === 'other' && lastSeen !== 'other') report('warn', `port ${port} is now used by another program; open canvases cannot reach the dashboard`);
          lastSeen = found.state;
          if (found.state === 'free' && instances.size && !disposed) {
            await ensureServer();
            // The last canvas here may have closed while this process took the port over.
            if (server && !instances.size) scheduleRelease();
          }
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
      if (disposed) throw unavailable();
      const url = { url: pageUrl(port, { ...ctx, version }), title: CANVAS_TITLE };
      if (broken) {
        const found = await probe(port, { timeoutMs: 1500 });
        if (found.state === 'ours') {
          reuse(found.health);
          return url;
        }
        const error = new Error('The swarm dashboard\'s extension process has stopped working: its file system calls no longer finish. Reload extensions: start a new session with /clear, or restart the Copilot app.');
        error.code = 'reload_extensions';
        throw error;
      }
      const id = ctx.instanceId ?? '';
      // Counting the canvas before the server starts keeps a close that arrives meanwhile.
      instances.add(id);
      clearTimeout(graceTimer);
      graceTimer = null;
      try {
        await ensureServer();
      } catch (error) {
        instances.delete(id);
        if (!instances.size) stopWatching();
        throw error;
      }
      if (disposed) throw unavailable();
      // A canvas that closed meanwhile, if it was the last one here, lets this process's server go once nothing uses it.
      if (!instances.has(id) && !instances.size && server) scheduleRelease();
      else watch();
      return url;
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
    broken: () => broken,
    instanceCount: () => instances.size,
  };
}
