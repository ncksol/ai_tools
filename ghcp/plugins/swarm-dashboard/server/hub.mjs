/**
 * Live page connections (Server-Sent Events) and the engine's lifetime. The engine is created when the first page
 * connects or an API call needs it, polls only while a page is connected, and is dropped engineIdleMs after the last
 * page leaves, so an idle server holds no engine memory. Never writes to stdout.
 */
export function createHub({ createEngine, now = Date.now, intervalMs = 3000, engineIdleMs = 300000, heartbeatMs = 15000, log = () => {}, onIdle = () => {} }) {
  const clients = new Set();
  let engine = null;
  let ready = null;
  let unsubscribe = null;
  let idleTimer = null;
  let heartbeat = null;
  let polling = false;
  let swarmsKey = '';
  const warn = error => log({ level: 'warn', source: 'server', message: error?.message ?? String(error) });

  function acquire() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!engine) {
      engine = createEngine();
      unsubscribe = engine.subscribe(change => { changed(change).catch(warn); });
      ready = Promise.resolve(engine.refresh()).catch(warn);
    }
    const current = engine;
    return ready.then(() => current);
  }

  function startPolling() {
    if (polling || !engine) return;
    polling = true;
    engine.start({ intervalMs });
    heartbeat = setInterval(() => { for (const client of clients) client.res.write(': ping\n\n'); }, heartbeatMs);
    heartbeat.unref?.();
  }

  function scheduleRelease() {
    if (clients.size) return;
    if (polling) {
      engine?.stop();
      polling = false;
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (!engine || idleTimer) return;
    idleTimer = setTimeout(release, engineIdleMs);
    idleTimer.unref?.();
  }

  function release() {
    idleTimer = null;
    if (clients.size || !engine) return;
    engine.stop();
    unsubscribe?.();
    engine = null;
    ready = null;
    unsubscribe = null;
    swarmsKey = '';
    onIdle();
  }

  function send(client, event, data) {
    if (!client.closed) client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function sendSwarms(force, target) {
    if (!engine) return;
    const swarms = engine.listSwarms();
    const key = JSON.stringify(swarms.map(swarm => [swarm.id, swarm.name, swarm.lifecycle]));
    if (!force && key === swarmsKey) return;
    swarmsKey = key;
    for (const client of target ? [target] : [...clients].filter(item => item.greeted)) send(client, 'swarms', swarms);
  }

  async function push(client) {
    if (client.busy) {
      client.again = true;
      return;
    }
    client.busy = true;
    try {
      do {
        client.again = false;
        const pinned = client.pinned;
        const current = engine;
        if (!current || client.closed) return;
        const fromSession = !client.swarm && !pinned && client.session ? await current.findSwarm(client.session) : null;
        const snapshot = await current.getSnapshot(client.swarm ?? pinned ?? fromSession ?? undefined);
        if (current !== engine) {
          // An engine dropped or closed meanwhile may have reopened its read-only connections, so stop it again.
          current.stop();
          return;
        }
        if (client.closed) return;
        // Pin a page to the swarm it was first shown, so the default does not jump between swarms; changed() unpins a
        // default page whose swarm is no longer live while another is. A page opened from a session that is in no swarm
        // yet stays unpinned, and follows that session once it joins one.
        if (snapshot && !client.swarm && !pinned && !client.pinned && (fromSession || !client.session)) client.pinned = snapshot.run.id;
        const key = snapshot ? `${snapshot.run.id}#${snapshot.revision}` : 'none';
        if (key !== client.lastKey) {
          client.lastKey = key;
          send(client, 'snapshot', { serverNow: now(), snapshot });
        }
      } while (client.again && !client.closed);
    } catch (error) {
      warn(error);
    } finally {
      client.busy = false;
    }
  }

  async function changed(change) {
    sendSwarms(false);
    const live = new Set(engine ? engine.listSwarms().filter(swarm => swarm.lifecycle === 'live').map(swarm => swarm.id) : []);
    for (const client of clients) {
      // add() sends a page its swarms and snapshot after hello.
      if (!client.greeted) continue;
      // A page that asked for no swarm follows the default again once its swarm is no longer live while another is.
      if (!client.swarm && !client.session && client.pinned && live.size && !live.has(client.pinned)) client.pinned = null;
      const shown = client.swarm ?? client.pinned;
      if (!shown || change.swarmIds.includes(shown)) push(client);
    }
  }

  /** Serve one page's event stream. swarm: the swarm it asked for; session: a session whose swarm it wants. */
  async function add(req, res, { swarm = null, session = null } = {}) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const client = { res, swarm, session, pinned: null, lastKey: null, busy: false, again: false, closed: false, greeted: false };
    clients.add(client);
    req.on('close', () => {
      client.closed = true;
      clients.delete(client);
      scheduleRelease();
    });
    const current = await acquire();
    if (client.closed) return;
    send(client, 'hello', { serverNow: now(), demo: Boolean(current.isDemo) });
    client.greeted = true;
    startPolling();
    sendSwarms(true, client);
    await push(client);
  }

  /** Run fn with the engine, creating it if needed; an engine with no connected page is dropped later. */
  async function withEngine(fn) {
    const current = await acquire();
    try {
      return await fn(current);
    } finally {
      // An engine dropped or closed while fn ran may have reopened its read-only connections, so stop it again.
      if (current !== engine) current.stop();
      scheduleRelease();
    }
  }

  function close() {
    for (const client of clients) {
      client.closed = true;
      client.res.end();
    }
    clients.clear();
    clearTimeout(idleTimer);
    clearInterval(heartbeat);
    idleTimer = null;
    heartbeat = null;
    polling = false;
    if (engine) {
      engine.stop();
      unsubscribe?.();
    }
    engine = null;
    ready = null;
  }

  return { add, withEngine, close, clientCount: () => clients.size, hasEngine: () => engine !== null };
}
